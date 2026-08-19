#!/usr/bin/env node
// ============================================================================
// AI auto-fix (CAUTIOUS) — applies small, high-confidence fixes to WORKER code
// and ships them, with no merge button to press.
// ----------------------------------------------------------------------------
// Deliberately narrow and safe:
//   • Scope = worker/src/** only (worker logic). It never touches the HTML pages,
//     and it never touches PROTECTED files (login, permissions, sessions, core
//     routing, config) — those still come to you as review issues instead.
//   • Only fixes Claude marks confidence=high AND risk=small are applied, each as
//     an EXACT single-occurrence text replacement (ambiguous anchors are skipped).
//   • HARD GATE: after applying, every changed file is syntax-checked and the
//     worker bundle is rebuilt. If ANYTHING fails to parse/build, the whole batch
//     is thrown away (git checkout) and an issue is opened instead of shipping.
//   • You get a record + undo: an issue per run with a one-line revert command,
//     plus a phone push (via the worker's token-gated /health/notify).
//
// The git commit + push is done by the workflow AFTER this script signals success
// (it writes a JSON result the workflow reads). This script only edits + validates.
// Fails soft: no key / API error / nothing to do → exits 0, changes nothing.
// ============================================================================

import { execSync } from "node:child_process";
import fs from "node:fs";

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5";
const GH_TOKEN = process.env.GITHUB_TOKEN || "";
const REPO = process.env.GITHUB_REPOSITORY || "";
const RESULT_FILE = process.env.AUTOFIX_RESULT || "autofix-result.json";

const MAX_FILES = 20;
const MAX_BYTES = 240_000;
const MAX_FIXES = 5; // cap how many changes ship in one run

// Only worker logic is auto-fixable.
function inScope(p) { return p.startsWith("worker/src/") && /\.js$/.test(p) && !/\.min\.js$/.test(p); }

// NEVER auto-edit these — auth, permissions, sessions, core routing, config, the
// watchdog itself, secrets handling. A finding here becomes a review issue, not a fix.
const PROTECTED = [
  /worker\/src\/index\.js$/,
  /worker\/src\/lib\/auth\.js$/,
  /worker\/src\/routes\/auth\.js$/,
  /worker\/src\/routes\/devices\.js$/,
  /worker\/src\/routes\/users\.js$/,
  /worker\/src\/routes\/push\.js$/,
  /worker\/src\/routes\/health\.js$/,
  /wrangler\.toml$/,
  /\.sql$/,
];
function isProtected(p) { return PROTECTED.some(re => re.test(p)); }

function sh(cmd, opts) { return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }); }
function shSafe(cmd) { try { return sh(cmd); } catch { return ""; } }

function recentFiles() {
  const out = shSafe(`git log --since="26 hours ago" --name-only --pretty=format: HEAD`);
  const seen = new Set();
  return out.split("\n").map(s => s.trim()).filter(Boolean)
    .filter(p => { if (seen.has(p)) return false; seen.add(p); return true; })
    .filter(inScope).filter(p => !isProtected(p));
}

function readFiles(paths) {
  const picked = []; let bytes = 0;
  for (const p of paths.slice(0, MAX_FILES)) {
    let body = ""; try { body = fs.readFileSync(p, "utf8"); } catch { continue; }
    if (bytes + body.length > MAX_BYTES) break;
    bytes += body.length; picked.push({ path: p, body });
  }
  return picked;
}

const SYSTEM = `You are a careful senior engineer fixing bugs in the Mostlane portal's Cloudflare Worker. You are in CAUTIOUS auto-fix mode: your fixes ship to a live business system with no human review, so ONLY propose a fix when you are certain it is correct and safe.

Propose a fix ONLY for clear, self-contained CORRECTNESS or EFFICIENCY bugs:
- a genuine bug (wrong logic, missing null/undefined guard, missing await, off-by-one, wrong comparison, a SQL query missing its tenant_id filter, a resource leak), or
- a safe, local efficiency win (an obvious N+1 or duplicate fetch collapsed) that cannot change behaviour.

Do NOT propose:
- refactors, renames, style/formatting, or anything touching authentication, permissions, sessions, or request routing;
- anything you are less than highly confident is correct;
- large or multi-part changes.

Each fix is an EXACT text replacement. "find" MUST be a verbatim substring copied from the file that appears EXACTLY ONCE (include enough surrounding lines to be unique). "replace" is the corrected text. Keep it minimal.

Respond with ONLY this JSON, no prose, no fences:
{"summary":"one line","fixes":[{"file":"worker/src/...","find":"<exact unique snippet>","replace":"<corrected snippet>","reason":"the bug and when it bites","confidence":"high|medium|low","risk":"small|large"}]}
If nothing meets the bar, return {"summary":"nothing to fix","fixes":[]}. Silence is correct and valuable.`;

function buildPrompt(files) {
  return `Review these worker files and propose only safe, high-confidence fixes.\n\n` +
    files.map(f => `===== FILE: ${f.path} =====\n${f.body}`).join("\n\n");
}

async function callClaude(prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 12000, output_config: { effort: "high" }, system: SYSTEM, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  const data = await res.json();
  return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
}

function extractJson(text) {
  const s = text.indexOf("{"); if (s < 0) return null;
  let d = 0, inStr = false, esc = false;
  for (let i = s; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === "{") d++; else if (c === "}") { if (--d === 0) { try { return JSON.parse(text.slice(s, i + 1)); } catch { return null; } } }
  }
  return null;
}

function writeResult(obj) { try { fs.writeFileSync(RESULT_FILE, JSON.stringify(obj)); } catch {} }

async function ghIssue(title, body) {
  if (!REPO || !GH_TOKEN) { console.log(title + "\n\n" + body); return; }
  try {
    await fetch("https://api.github.com/repos/" + REPO + "/labels", { method: "POST", headers: ghHeaders(), body: JSON.stringify({ name: "ai-autofix", color: "0e8a16", description: "Automated AI fixes" }) });
  } catch {}
  const res = await fetch("https://api.github.com/repos/" + REPO + "/issues", { method: "POST", headers: ghHeaders(), body: JSON.stringify({ title, body, labels: ["ai-autofix"] }) });
  if (res.ok) console.log("Opened issue: " + (await res.json()).html_url);
  else console.log("Issue create failed: HTTP " + res.status);
}
function ghHeaders() { return { "Authorization": "Bearer " + GH_TOKEN, "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "content-type": "application/json" }; }

function nodeCheck(file) { try { sh(`node --check ${file}`); return true; } catch (e) { console.log("node --check failed on " + file + ": " + (e.stderr || e.message || "")); return false; } }
function rebuildDist() {
  try {
    sh(`npx --yes esbuild src/index.js --bundle --format=esm --outfile=dist/worker.js`, { cwd: "worker" });
    sh(`npx --yes esbuild src/index.js --bundle --format=esm --minify --outfile=dist/worker.min.js`, { cwd: "worker" });
    return true;
  } catch (e) { console.log("esbuild rebuild failed: " + (e.stderr || e.message || "")); return false; }
}

async function main() {
  writeResult({ applied: false });
  if (!ANTHROPIC_KEY) { console.log("⏭  No ANTHROPIC_API_KEY — skipping."); return; }
  const paths = recentFiles();
  if (!paths.length) { console.log("No in-scope worker files changed recently. Nothing to do."); return; }
  console.log("Considering:\n  " + paths.join("\n  "));

  let text;
  try { text = await callClaude(buildPrompt(readFiles(paths))); }
  catch (e) { console.log("⚠️  " + e.message + " — skipping."); return; }

  const parsed = extractJson(text) || { fixes: [] };
  const all = Array.isArray(parsed.fixes) ? parsed.fixes : [];
  // Cautious gate: high-confidence, small, in-scope, not protected.
  const eligible = all.filter(f => f && f.confidence === "high" && f.risk === "small" && f.file && inScope(f.file) && !isProtected(f.file)).slice(0, MAX_FIXES);
  const deferred = all.filter(f => f && !(f.confidence === "high" && f.risk === "small" && inScope(f.file || "") && !isProtected(f.file || "")));

  const applied = [];
  const changedFiles = new Set();
  for (const f of eligible) {
    let body; try { body = fs.readFileSync(f.file, "utf8"); } catch { continue; }
    const find = f.find || "";
    if (!find) continue;
    // Must match EXACTLY once, or we don't trust the anchor.
    const idx = body.indexOf(find);
    if (idx < 0 || body.indexOf(find, idx + 1) >= 0) { console.log("Skipped (anchor not unique): " + f.file + " — " + (f.reason || "")); continue; }
    fs.writeFileSync(f.file, body.slice(0, idx) + (f.replace || "") + body.slice(idx + find.length));
    changedFiles.add(f.file);
    applied.push(f);
  }

  if (!applied.length) {
    console.log("No fixes met the cautious bar.");
    if (deferred.length) await ghIssue("🤖 AI review — " + deferred.length + " item(s) to look at (not auto-fixed)", deferredBody(deferred, parsed.summary));
    return;
  }

  // HARD VALIDATION GATE — parse every changed file, then rebuild the bundle.
  let ok = true;
  for (const file of changedFiles) if (!nodeCheck(file)) { ok = false; break; }
  if (ok) ok = rebuildDist();
  if (!ok) {
    console.log("Validation failed — discarding all changes, opening an issue instead.");
    shSafe("git checkout -- worker/");
    await ghIssue("🤖 Auto-fix aborted — proposed fix didn't validate", "Claude proposed fixes but they failed syntax/build validation, so nothing was shipped. Proposed changes:\n\n" + applied.map(f => `- \`${f.file}\`: ${f.reason || ""}`).join("\n"));
    return;
  }

  // Validated — commit, push (deploys via Cloudflare Workers Builds), record, ping.
  console.log("Applied " + applied.length + " fix(es); validated + bundle rebuilt. Shipping…");
  const summary = (parsed.summary || applied[0].reason || "worker fix").replace(/\s+/g, " ").slice(0, 120);
  try {
    sh(`git config user.name "mostlane-autofix[bot]"`);
    sh(`git config user.email "41898282+github-actions[bot]@users.noreply.github.com"`);
    sh(`git add worker/`);
    const msg = `[ai-autofix] ${summary}`;
    const detail = `Applied automatically by the cautious AI auto-fixer (worker code, high-confidence only).\n` +
      applied.map(f => `- ${f.file}: ${f.reason || ""}`).join("\n") +
      `\n\nVerify, and revert in one step if wrong.`;
    sh(`git commit -m ${JSON.stringify(msg)} -m ${JSON.stringify(detail)}`);
    sh(`git push origin HEAD:main`);
  } catch (e) {
    console.log("git push failed: " + (e.stderr || e.message || ""));
    writeResult({ applied: false });
    return;
  }
  const sha = shSafe("git rev-parse HEAD").trim();
  writeResult({ applied: true, sha, summary, fixes: applied.map(f => ({ file: f.file, reason: f.reason || "" })) });

  const issueBody = `**${summary}**\n\n` +
    `I applied and shipped ${applied.length} worker fix(es) automatically (cautious mode: high-confidence, small, non-sensitive; syntax-checked and bundle rebuilt before shipping):\n\n` +
    applied.map(f => `- \`${f.file}\` — ${f.reason || ""}`).join("\n") +
    (deferred.length ? `\n\n_Also flagged but NOT auto-fixed (bigger, lower-confidence, or a protected area): ${deferred.map(f => "`" + (f.file || "?") + "`").join(", ")}._` : "") +
    `\n\n**To undo everything in this fix**, run in the repo:\n\`\`\`\ngit revert ${sha}\ngit push\n\`\`\`\n\n---\n_Generated by [Claude Code](https://claude.ai/code) — an automated fix. Verify it; revert above if it's wrong._`;
  await ghIssue("✅ Auto-fixed — " + summary, issueBody);
  await phonePing(summary);
}

// Reuses the worker's token-gated /health/notify (JOBS_INBOUND_TOKEN). Fail-soft:
// if the token isn't set as a GitHub secret, the ping is skipped — the issue above
// is still the guaranteed record.
async function phonePing(summary) {
  const token = process.env.PING_TOKEN || "";
  const base = process.env.API_BASE || "https://mostlane-api.jamie-def.workers.dev";
  if (!token) { console.log("No PING_TOKEN secret — skipping phone ping (issue is the record)."); return; }
  try {
    const res = await fetch(base + "/health/notify", {
      method: "POST",
      headers: { "Authorization": "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ title: "✅ Portal auto-fixed", body: summary, url: "/health.html" }),
    });
    console.log("Phone ping: HTTP " + res.status);
  } catch (e) { console.log("Phone ping failed (ignored): " + (e && e.message)); }
}

function deferredBody(deferred, summary) {
  return `**${summary || "Review"}**\n\nThese were flagged but NOT auto-fixed (too large, low confidence, or a protected area like login/permissions/routing). Have a look:\n\n` +
    deferred.map(f => `- \`${f.file || "?"}\` — ${f.reason || ""}`).join("\n") +
    "\n\n---\n_Generated by [Claude Code](https://claude.ai/code) — verify before acting._";
}

main().catch(e => { console.log("⚠️  Unexpected error (ignored): " + (e && e.message)); });
