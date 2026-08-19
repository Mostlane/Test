#!/usr/bin/env node
// ============================================================================
// AI code review — the "constantly check the CODE for bugs & inefficiency" job.
// ----------------------------------------------------------------------------
// Runs in GitHub Actions (see .github/workflows/ai-code-review.yml). Reviews the
// code that changed recently with Claude and, when it finds something, opens a
// GitHub issue listing the bugs / inefficiencies. Dependency-free: raw fetch to
// the Anthropic + GitHub REST APIs, so the Action needs no `npm install`.
//
// This is the CODE-level watchdog. The LIVE-runtime watchdog (broken/slow
// endpoints) is the worker's health.js module + health.html — different job.
//
// Fails SOFT everywhere: a missing key or an API hiccup logs a clear message and
// exits 0, so the review never blocks or breaks anything.
// ============================================================================

import { execSync } from "node:child_process";

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5"; // set to claude-sonnet-5 in the workflow to cut cost
const GH_TOKEN = process.env.GITHUB_TOKEN || "";
const REPO = process.env.GITHUB_REPOSITORY || ""; // "owner/repo"
const SCOPE = process.env.REVIEW_SCOPE || "recent"; // recent | diff | full
const BEFORE = process.env.REVIEW_BEFORE || ""; // push before-SHA (diff scope)
const AFTER = process.env.REVIEW_AFTER || "HEAD"; // push after-SHA (diff scope)
const ALWAYS_ISSUE = process.env.ALWAYS_ISSUE === "1"; // manual runs: open an issue even if clean

const MAX_FILES = 30;
const MAX_BYTES = 260_000; // ~65k tokens of source — keeps a nightly run cheap

// Only review real source. Skip build output, minified bundles, images, vendored libs.
function reviewable(p) {
  if (!p) return false;
  if (/(^|\/)(node_modules|dist|help-img|icons)\//.test(p)) return false;
  if (/\.min\.js$/.test(p)) return false;
  if (/worker\/dist\//.test(p)) return false;
  return /\.(js|mjs|html|css|sql)$/.test(p) || p.startsWith("worker/src/");
}

function sh(cmd) { try { return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return ""; } }

function changedFiles() {
  let out = "";
  if (SCOPE === "diff" && BEFORE && !/^0+$/.test(BEFORE)) {
    out = sh(`git diff --name-only ${BEFORE} ${AFTER}`);
  } else if (SCOPE === "full") {
    out = sh(`git ls-files`);
  } else { // recent — everything touched in the last ~26h
    out = sh(`git log --since="26 hours ago" --name-only --pretty=format: ${AFTER}`);
  }
  const seen = new Set();
  return out.split("\n").map(s => s.trim()).filter(Boolean)
    .filter(p => { if (seen.has(p)) return false; seen.add(p); return true; })
    .filter(reviewable);
}

async function readFiles(paths) {
  const fs = await import("node:fs");
  const picked = [];
  let bytes = 0, truncated = false;
  for (const p of paths.slice(0, MAX_FILES)) {
    let body = "";
    try { body = fs.readFileSync(p, "utf8"); } catch { continue; }
    if (bytes + body.length > MAX_BYTES) { truncated = true; break; }
    bytes += body.length;
    picked.push({ path: p, body });
  }
  if (paths.length > MAX_FILES) truncated = true;
  return { picked, truncated, totalPaths: paths.length };
}

const SYSTEM = `You are a meticulous senior engineer reviewing changes to the Mostlane portal — a single Cloudflare Worker (D1 + R2) plus static HTML pages. The team is one non-developer owner shipping fast, so correctness matters and regressions are expensive.

Review ONLY the files provided. Report GENUINE problems a careful reviewer would flag:
- Correctness bugs: wrong logic, unhandled null/undefined, off-by-one, wrong SQL (missing tenant_id filter, wrong column, injection via string-built SQL), await missing on a promise, unclosed resources, race conditions, incorrect date/timezone handling.
- Efficiency: N+1 database queries, work on the hot request path that could be cached/batched, unbounded loops or list()s, re-fetching the same data, blocking a first paint on a slow await.
- Safety: an auth/permission check missing on a state-changing route, a secret logged, user input trusted unsafely.

Do NOT report: style nits, naming, formatting, subjective preferences, or speculative issues you cannot point to in the code. Prefer FEW high-confidence findings over many weak ones. If the code is fine, return an empty findings array — silence is a valid, valuable result.

Respond with ONLY a JSON object, no prose, no markdown fences, exactly:
{"summary":"one-line overall read","findings":[{"severity":"high|medium|low","file":"path","line":<int or null>,"title":"short","detail":"what's wrong and when it bites","suggestion":"the concrete fix"}]}`;

function buildPrompt(files, meta) {
  const header = `Scope: ${SCOPE}. ${meta.totalPaths} file(s) changed; reviewing ${files.length}${meta.truncated ? " (truncated — some files omitted)" : ""}.\n\nFiles:\n`;
  const body = files.map(f => `\n===== FILE: ${f.path} =====\n${f.body}`).join("\n");
  return header + body;
}

async function callClaude(prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: "medium" },
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Anthropic API ${res.status}: ${t.slice(0, 400)}`);
  }
  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
  return text;
}

// Pull the first balanced {...} JSON object out of the model's reply.
function extractJson(text) {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

async function gh(path, method, body) {
  const res = await fetch("https://api.github.com/repos/" + REPO + path, {
    method: method || "GET",
    headers: {
      "Authorization": "Bearer " + GH_TOKEN,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}

async function ensureLabel() {
  try {
    await gh("/labels", "POST", { name: "ai-code-review", color: "6f42c1", description: "Findings from the nightly AI code review" });
  } catch { /* already exists or no permission — issue creation still works without it */ }
}

const SEV_ICON = { high: "🔴", medium: "🟠", low: "🟡" };

function renderBody(summary, findings, files, meta) {
  const lines = [];
  lines.push(`**${summary || "Automated code review"}**`, "");
  lines.push(`Reviewed ${files.length} file(s) (${SCOPE} scope)${meta.truncated ? " — _some files were omitted to keep the run cheap; re-run manually with full scope for everything._" : ""}.`, "");
  if (!findings.length) {
    lines.push("✅ No issues found. The reviewed code looks correct and efficient.");
  } else {
    const order = { high: 0, medium: 1, low: 2 };
    findings.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
    for (const f of findings) {
      lines.push(`### ${SEV_ICON[f.severity] || "⚪"} ${f.title || "Finding"} — \`${f.file || "?"}\`${f.line ? `:${f.line}` : ""}`);
      if (f.detail) lines.push(f.detail);
      if (f.suggestion) lines.push("", `**Fix:** ${f.suggestion}`);
      lines.push("");
    }
  }
  lines.push("", "---", "_Generated by [Claude Code](https://claude.ai/code) — automated AI code review. Verify each finding before acting; false positives are possible._");
  return lines.join("\n");
}

function summaryLine(findings) {
  const h = findings.filter(f => f.severity === "high").length;
  const m = findings.filter(f => f.severity === "medium").length;
  const l = findings.filter(f => f.severity === "low").length;
  return `${h} high · ${m} medium · ${l} low`;
}

async function stepSummary(md) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  try { (await import("node:fs")).appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n"); } catch {}
}

async function main() {
  if (!ANTHROPIC_KEY) {
    console.log("⏭  ANTHROPIC_API_KEY is not set. Add it in the repo → Settings → Secrets and variables → Actions, then re-run. Skipping (not a failure).");
    await stepSummary("### AI code review — skipped\nNo `ANTHROPIC_API_KEY` secret set. Add it in **Settings → Secrets and variables → Actions**.");
    return;
  }
  const paths = changedFiles();
  if (!paths.length) {
    console.log("No reviewable files changed. Nothing to do.");
    await stepSummary("### AI code review\nNo reviewable source files changed in this window.");
    return;
  }
  console.log(`Reviewing ${paths.length} file(s):\n  ` + paths.join("\n  "));
  const { picked, truncated, totalPaths } = await readFiles(paths);
  const meta = { truncated, totalPaths };

  let text;
  try { text = await callClaude(buildPrompt(picked, meta)); }
  catch (e) {
    console.log("⚠️  " + e.message + " — skipping (not a failure).");
    await stepSummary("### AI code review — could not run\n```\n" + e.message + "\n```\nCommon causes: the API key is wrong/rejected, or the model isn't enabled on the key.");
    return;
  }

  const parsed = extractJson(text) || { summary: "Could not parse the review output.", findings: [], raw: text };
  const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
  const body = renderBody(parsed.summary, findings, picked, meta) + (parsed.raw ? "\n\n<details><summary>Raw model output</summary>\n\n```\n" + String(parsed.raw).slice(0, 4000) + "\n```\n</details>" : "");

  await stepSummary(`### AI code review — ${findings.length ? summaryLine(findings) : "clean ✅"}\n${parsed.summary || ""}\n\n<details><summary>Details</summary>\n\n${body}\n\n</details>`);

  if (!findings.length && !ALWAYS_ISSUE) {
    console.log("✅ No findings — not opening an issue.");
    return;
  }
  if (!REPO || !GH_TOKEN) { console.log("No GITHUB_TOKEN/REPO — printed the review to the log instead of opening an issue.\n\n" + body); return; }

  await ensureLabel();
  const today = new Date().toISOString().slice(0, 10);
  const title = findings.length
    ? `🤖 AI review — ${summaryLine(findings)} — ${today}`
    : `🤖 AI review — clean — ${today}`;
  const res = await gh("/issues", "POST", { title, body, labels: ["ai-code-review"] });
  if (res.ok) { const j = await res.json(); console.log("Opened issue #" + j.number + ": " + j.html_url); }
  else { console.log("Could not open issue: HTTP " + res.status + " " + (await res.text().catch(() => "")).slice(0, 300)); }
}

main().catch(e => { console.log("⚠️  Unexpected error (ignored): " + (e && e.message)); });
