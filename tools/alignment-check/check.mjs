#!/usr/bin/env node
// ============================================================================
// Alignment / centralisation linter — "is everything pointed at the one central
// API, and does every page talk to a real endpoint?"
// ----------------------------------------------------------------------------
// Deterministic (no AI, no cost). Scans every portal HTML/JS page and checks it
// against the worker's own route table. Runs in CI (nightly + on push + on
// demand) and opens a GitHub issue listing any drift. Report-only — it never
// edits anything.
//
// Per page it checks:
//   1. CENTRALISATION — does it hardcode a LEGACY worker host instead of the one
//      central API (window.MOSTLANE_API = mostlane-api)? Legacy hosts split into:
//        • bridged   → still works via portal-config's rewrite bridge, but should
//                      be moved onto MOSTLANE_API (drift, medium).
//        • retired   → an old worker being decommissioned; a page still calling it
//                      may be broken or about to break (high).
//   2. CONFIG VERSION — every page should load the SAME portal-config.js?v=N.
//      An outlier is running a stale shared config (this has bitten before).
//   3. STATUS-BAR CAP — a page that loads portal-config MUST set viewport-fit=cover
//      or the iOS status-bar cap can't size itself.
//   4. ENDPOINT REALITY — every /api/path the page fetches must map to a real
//      route in the worker (parsed live from worker/src/index.js). A call to an
//      unknown area = a page talking to an endpoint that doesn't exist.
//
// Each of ~120 pages × 4 checks = hundreds of individual assertions every run.
// ============================================================================

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const GH_TOKEN = process.env.GITHUB_TOKEN || "";
const REPO = process.env.GITHUB_REPOSITORY || "";
const ALWAYS_ISSUE = process.env.ALWAYS_ISSUE === "1";

// The ONE central API. Everything portal-side should resolve to this.
const CENTRAL = "mostlane-api";
// Legacy workers that portal-config's fetch bridge still rewrites onto the central
// API — so a page calling these WORKS, but it's drift worth clearing.
const BRIDGED = new Set(["login", "mostlane-users", "mostlane-holidays", "mostlane-assets", "mostlane-sla", "mostlane-sites", "userdevicekv"]);
// Hosts that are legitimately their own service (not the portal API) — ignore.
const EXTERNAL_OK = new Set(["api.site-log.co.uk", "api2.site-log.co.uk"]);
// Known transitional dependency (compliance store KV, being retired) — note, don't alarm.
const TRANSITIONAL = new Set(["mostlane-pos"]);

// ── Discover the worker's real route prefixes (so endpoint checks self-maintain)
function loadRoutePrefixes() {
  const idx = read("worker/src/index.js");
  const prefixes = new Set();
  if (idx) {
    const m = idx.match(/const ROUTES\s*=\s*\[([\s\S]*?)\n\];/);
    const block = m ? m[1] : idx;
    // Each entry: ["*", "/prefix", handler]
    for (const mm of block.matchAll(/\[\s*"[^"]*"\s*,\s*"(\/[^"]+)"/g)) prefixes.add(mm[1]);
    // Public bare paths worth treating as valid too
    for (const mm of idx.matchAll(/\["(?:GET|POST|PUT|PATCH|DELETE)"\s*,\s*"(\/[^"]+)"\]/g)) prefixes.add(mm[1]);
  }
  // The bare liveness + batch endpoints the router special-cases.
  ["/health", "/batch"].forEach(p => prefixes.add(p));
  return [...prefixes];
}

function read(rel) { try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch { return ""; } }
function listPages() {
  const out = [];
  for (const f of fs.readdirSync(ROOT)) if (f.endsWith(".html")) out.push(f);
  return out.sort();
}

// First path segment, e.g. "/sla/jobs/123" -> "/sla"
function firstSeg(p) { const m = p.match(/^\/[a-zA-Z0-9_-]+/); return m ? m[0] : p; }
function routeKnown(p, prefixes) {
  const seg = firstSeg(p);
  // Exact prefix, or the path starts with a known prefix (longest-prefix router).
  return prefixes.some(pre => seg === pre || p === pre || p.startsWith(pre + "/") || p.startsWith(pre));
}

function extractHosts(src) {
  const hosts = [];
  for (const m of src.matchAll(/([a-z0-9-]+)\.jamie-def\.workers\.dev/g)) hosts.push(m[1]);
  return hosts;
}
function extractConfigVersion(src) {
  const m = src.match(/portal-config\.js\?v=(\d+)/);
  return m ? m[1] : null;
}
function loadsPortalConfig(src) { return /portal-config\.js/.test(src); }
function hasViewportFit(src) { return /viewport-fit\s*=\s*cover/.test(src); }
function extractApiPaths(src) {
  const paths = new Set();
  // Only the central-API helpers — authFetch/apiFetch/jfetch/jget hit MOSTLANE_API,
  // so their paths MUST be real worker routes. Bare fetch(SOME_HOST + "/x") is
  // deliberately NOT scanned: when a page uses a legacy host base its paths are
  // relative to THAT host (e.g. "/jobs" really means "/sla/jobs"), which would be
  // a false "endpoint doesn't exist". Those pages are flagged by centralisation.
  const re = /(?:authFetch|apiFetch|jfetch|jget)\s*\(\s*[`'"](\/[a-zA-Z0-9_\-/]+)/g;
  for (const m of src.matchAll(re)) paths.add(m[1]);
  return [...paths];
}

function main() {
  const prefixes = loadRoutePrefixes();
  const pages = listPages();
  const findings = []; // {sev, page, kind, msg}
  const versions = {};

  for (const page of pages) {
    const src = read(page);
    if (!src) continue;

    // A page that talks to any non-central legacy host addresses its endpoints
    // relative to that host, so the endpoint-reality check can't be trusted for it
    // (it's flagged by centralisation instead). Only "clean" pages are route-checked.
    const legacyHosts = [...new Set(extractHosts(src))].filter(h => h !== CENTRAL);
    const centralOnly = legacyHosts.length === 0;

    // 1. Centralisation
    for (const host of new Set(extractHosts(src))) {
      if (host === CENTRAL) continue;
      if (BRIDGED.has(host)) findings.push({ sev: "medium", page, kind: "centralisation", msg: `points at legacy worker "${host}.jamie-def.workers.dev" (works via the config bridge, but should use MOSTLANE_API)` });
      else if (TRANSITIONAL.has(host)) findings.push({ sev: "low", page, kind: "centralisation", msg: `still calls the transitional "${host}" worker (being retired — plan to move it into the portal)` });
      else findings.push({ sev: "high", page, kind: "centralisation", msg: `points at RETIRED/unmigrated worker "${host}.jamie-def.workers.dev" instead of the central API — this page may be broken or about to break` });
    }

    // 2. Config version
    const v = extractConfigVersion(src);
    if (v) versions[v] = (versions[v] || 0) + 1;

    // 3. Status-bar cap
    if (loadsPortalConfig(src) && !hasViewportFit(src))
      findings.push({ sev: "low", page, kind: "statusbar", msg: `loads portal-config.js but is missing viewport-fit=cover (iOS status-bar cap can't size itself)` });

    // 4. Endpoint reality (only for central-only pages — see note above)
    for (const p of centralOnly ? extractApiPaths(src) : []) {
      if (/\.(html|js|css|png|jpe?g|svg|pdf|ico)$/.test(p)) continue; // a static asset, not an API call
      if (!routeKnown(p, prefixes))
        findings.push({ sev: "medium", page, kind: "endpoint", msg: `calls \`${p}\` — no matching route in the worker (renamed/removed endpoint, or a typo)` });
    }
  }

  // Config-version consistency (majority wins; outliers flagged)
  const vEntries = Object.entries(versions).sort((a, b) => b[1] - a[1]);
  if (vEntries.length > 1) {
    const majority = vEntries[0][0];
    for (const page of pages) {
      const v = extractConfigVersion(read(page));
      if (v && v !== majority)
        findings.push({ sev: "medium", page, kind: "config-version", msg: `is on portal-config.js?v=${v} while most pages are on ?v=${majority} — it's running a stale shared config` });
    }
  }

  report(findings, { pages: pages.length, routes: prefixes.length, versions: vEntries });
}

function report(findings, meta) {
  const bySev = s => findings.filter(f => f.sev === s).length;
  const line = `${bySev("high")} high · ${bySev("medium")} medium · ${bySev("low")} low across ${meta.pages} pages`;
  console.log(line);

  const groups = {};
  for (const f of findings) (groups[f.kind] ||= []).push(f);
  const KIND_TITLE = {
    centralisation: "🎯 Pages not pointed at the central API",
    endpoint: "🔌 Pages calling endpoints that don't exist",
    "config-version": "🔁 Pages on a stale portal-config version",
    statusbar: "📱 Pages missing the status-bar viewport fix",
  };
  const SEV_ICON = { high: "🔴", medium: "🟠", low: "🟡" };

  const lines = [];
  lines.push(`**Alignment check — ${line}.** Every page checked against ${meta.routes} worker routes.`, "");
  if (!findings.length) {
    lines.push("✅ Everything is aligned: every page points at the central API, uses a real endpoint, and shares the same config version.");
  } else {
    for (const kind of ["centralisation", "endpoint", "config-version", "statusbar"]) {
      const g = groups[kind]; if (!g || !g.length) continue;
      lines.push(`### ${KIND_TITLE[kind]} (${g.length})`);
      const order = { high: 0, medium: 1, low: 2 };
      g.sort((a, b) => order[a.sev] - order[b.sev] || a.page.localeCompare(b.page));
      for (const f of g) lines.push(`- ${SEV_ICON[f.sev]} \`${f.page}\` — ${f.msg}`);
      lines.push("");
    }
  }
  lines.push("---", "_Generated by [Claude Code](https://claude.ai/code) — automated alignment check. Some legacy hosts still work via the config bridge; treat 🔴 as the priority._");
  const body = lines.join("\n");

  stepSummary(`### Alignment check — ${findings.length ? line : "all aligned ✅"}\n\n${body}`);

  if (!findings.length && !ALWAYS_ISSUE) { console.log("✅ No drift — not opening an issue."); return; }
  if (!REPO || !GH_TOKEN) { console.log("\n" + body); return; }
  openIssue(`🎯 Alignment check — ${line} — ${new Date().toISOString().slice(0, 10)}`, body);
}

async function openIssue(title, body) {
  const H = { "Authorization": "Bearer " + GH_TOKEN, "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "content-type": "application/json" };
  try { await fetch(`https://api.github.com/repos/${REPO}/labels`, { method: "POST", headers: H, body: JSON.stringify({ name: "alignment-check", color: "1d76db", description: "Centralisation / endpoint alignment drift" }) }); } catch {}
  const res = await fetch(`https://api.github.com/repos/${REPO}/issues`, { method: "POST", headers: H, body: JSON.stringify({ title, body, labels: ["alignment-check"] }) });
  if (res.ok) console.log("Opened issue: " + (await res.json()).html_url);
  else console.log("Issue create failed: HTTP " + res.status);
}
function stepSummary(md) { try { if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n"); } catch {} }

main();
