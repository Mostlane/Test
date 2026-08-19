// ============================================================================
// Portal health watchdog — the "constantly checks itself" module.
// ----------------------------------------------------------------------------
// Two jobs, both automatic, both surfaced on health.html (FullAccess):
//
//   1. SYNTHETIC PROBES (runHealthChecks) — run on the 5-min cron. Touch the
//      things every page depends on (D1 core tables, R2 buckets, optional
//      PO_DB / SITELOG_DB) and time them. A failed or slow probe is recorded
//      and, deduped, PUSHED to the owner so Jamie hears before an engineer
//      phones.
//   2. REAL-EVENT CAPTURE (recordEvent) — index.js calls this from its
//      top-level catch (every 500 a real user hits) and from the request
//      timer (every slow response). So the dashboard shows genuine breakage
//      and the slowest endpoints, not just synthetic health.
//
// Nothing here can BREAK a request: every path is wrapped and fails soft.
// This is the runtime watchdog; the AI CODE review (bugs/inefficiency in the
// source) lives in the scheduled GitHub Action, not in the worker.
// ============================================================================

import { corsHeaders } from "../lib/http.js";
import { tenantDB } from "../lib/tenantdb.js";
import { sendToUser } from "./push.js";

function json(data, status, env, request) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json", ...corsHeaders(env, request) },
  });
}

// A response slower than this (ms) is logged as a "slow" event by index.js.
export const SLOW_MS = 2500;
// A probe slower than this is flagged (still counts as up, just sluggish).
const PROBE_SLOW_MS = 1500;
// Keep health rows this long — problems are only interesting recently.
const RETAIN_DAYS = 30;

// ── Self-migrating table ────────────────────────────────────────────────────
let TABLE_READY = false;
async function ensureTable(env) {
  if (TABLE_READY) return;
  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS health_events (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         tenant_id INTEGER,
         kind TEXT,            -- 'error' | 'slow' | 'probe'
         endpoint TEXT,
         message TEXT,
         status INTEGER,
         ms INTEGER,
         at TEXT
       )`
    ).run();
    await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_health_at ON health_events (tenant_id, at)").run();
    TABLE_READY = true;
  } catch (e) { console.error("health ensureTable:", e && e.message); }
}

// ── Record one real event (called by index.js; must never throw) ────────────
// Kept lightweight so it can sit on the hot request path via ctx.waitUntil.
export async function recordEvent(env, tenantId, { kind, endpoint, message, status, ms }) {
  try {
    await ensureTable(env);
    const res = await env.DB.prepare(
      "INSERT INTO health_events (tenant_id, kind, endpoint, message, status, ms, at) VALUES (?,?,?,?,?,?,?)"
    ).bind(
      tenantId || 1, kind || "error",
      String(endpoint || "").slice(0, 200),
      String(message || "").slice(0, 500),
      status || 0, ms || 0, new Date().toISOString()
    ).run();
    // Occasional pruning (time-based, tenant-agnostic).
    const rowId = res.meta ? res.meta.last_row_id : 0;
    if (rowId && rowId % 200 === 0) {
      const cutoff = new Date(Date.now() - RETAIN_DAYS * 86400000).toISOString();
      await env.DB.prepare("DELETE FROM health_events WHERE at < ?").bind(cutoff).run();
    }
  } catch (e) { /* watchdog logging must never break the request */ }
}

// ── Synthetic probes ────────────────────────────────────────────────────────
// Each probe is (name, description, fn). fn resolves { detail } or throws.
function probeList(env) {
  const probes = [
    ["d1", "Main database (D1)", async () => {
      const r = await env.DB.prepare("SELECT 1 AS ok").first();
      if (!r || r.ok !== 1) throw new Error("SELECT 1 returned nothing");
      return "reachable";
    }],
    ["d1_core", "Core tables readable", async () => {
      // Touch the tables the busiest pages read. A missing/renamed table or a
      // corrupt row surfaces here as a red probe rather than a live 500.
      const out = [];
      for (const t of ["users", "sla_jobs", "sites", "vehicles", "app_config"]) {
        const row = await env.DB.prepare(`SELECT COUNT(*) n FROM ${t} WHERE tenant_id = 1`).first();
        out.push(`${t} ${(row && row.n) || 0}`);
      }
      return out.join(" · ");
    }],
    ["r2_jobfiles", "Job files bucket (R2)", async () => {
      if (!env.JOB_FILES) return "not bound (skipped)";
      await env.JOB_FILES.list({ limit: 1 });
      return "reachable";
    }],
    ["r2_assets", "Asset images bucket (R2)", async () => {
      if (!env.ASSET_BUCKET) return "not bound (skipped)";
      await env.ASSET_BUCKET.list({ limit: 1 });
      return "reachable";
    }],
  ];
  if (env.PO_DB) probes.push(["po_db", "Purchase-order database", async () => {
    await env.PO_DB.prepare("SELECT 1 AS ok").first();
    return "reachable";
  }]);
  if (env.SITELOG_DB) probes.push(["sitelog_db", "SiteLog database", async () => {
    await env.SITELOG_DB.prepare("SELECT 1 AS ok").first();
    return "reachable";
  }]);
  return probes;
}

// Run every probe, time it, store a snapshot, alert on failure.
export async function runHealthChecks(env, tenantId) {
  const tid = tenantId || 1;
  await ensureTable(env);
  const checks = [];
  for (const [name, desc, fn] of probeList(env)) {
    const t0 = Date.now();
    try {
      const detail = await fn();
      const ms = Date.now() - t0;
      checks.push({ name, desc, ok: true, ms, slow: ms > PROBE_SLOW_MS, detail: String(detail || "") });
    } catch (e) {
      const ms = Date.now() - t0;
      checks.push({ name, desc, ok: false, ms, slow: false, detail: String(e && e.message || e).slice(0, 300) });
    }
  }
  const failed = checks.filter(c => !c.ok);
  const snapshot = {
    at: new Date().toISOString(),
    ok: failed.length === 0,
    checks,
    failed: failed.length,
    slowest: checks.slice().sort((a, b) => b.ms - a.ms)[0] || null,
  };
  // Persist the latest snapshot (app_config, no table churn) and log any failure.
  try {
    await env.DB.prepare(
      "INSERT INTO app_config (tenant_id, key, value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    ).bind(tid, "health:lastrun:" + tid, JSON.stringify(snapshot)).run();
  } catch (e) { console.error("health snapshot save:", e && e.message); }
  for (const c of failed) {
    await recordEvent(env, tid, { kind: "probe", endpoint: c.name, message: c.desc + ": " + c.detail, status: 0, ms: c.ms });
  }
  await maybeAlert(env, tid, snapshot);
  return snapshot;
}

// ── Deduped owner alert ─────────────────────────────────────────────────────
// Push the owner when a probe fails or errors spike — but at most once per hour
// per distinct problem signature, so a five-minute cron never becomes a siren.
async function maybeAlert(env, tid, snapshot) {
  try {
    // Count real 500s in the last 15 minutes (a spike is worth a heads-up even
    // when every probe is green — it means users are hitting live breakage).
    const since = new Date(Date.now() - 15 * 60000).toISOString();
    const spike = await env.DB.prepare(
      "SELECT COUNT(*) n FROM health_events WHERE tenant_id=? AND kind='error' AND at>=?"
    ).bind(tid, since).first();
    const errCount = (spike && spike.n) || 0;
    const ERR_SPIKE = 8;

    const problems = [];
    if (!snapshot.ok) problems.push(...snapshot.checks.filter(c => !c.ok).map(c => c.name));
    if (errCount >= ERR_SPIKE) problems.push("errspike");
    if (!problems.length) return;

    const sig = problems.sort().join(",");
    const key = "health:alerted:" + tid;
    let last = null;
    try { const row = await env.DB.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(tid, key).first(); last = row && JSON.parse(row.value); } catch {}
    // Re-alert the same signature only once an hour.
    if (last && last.sig === sig && (Date.now() - (last.at || 0)) < 3600000) return;
    await env.DB.prepare(
      "INSERT INTO app_config (tenant_id, key, value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    ).bind(tid, key, JSON.stringify({ sig, at: Date.now() })).run();

    const bits = [];
    if (!snapshot.ok) bits.push(snapshot.checks.filter(c => !c.ok).map(c => c.desc).join(", ") + " failing");
    if (errCount >= ERR_SPIKE) bits.push(errCount + " server errors in 15 min");
    const owner = env.OWNER_USERNAME || "Jamie Line";
    await sendToUser(env, tid, owner, {
      title: "⚠️ Portal health",
      body: bits.join(" · ") || "A health check failed.",
      url: "/health.html",
      tag: "health-alert",
    });
  } catch (e) { console.error("health alert:", e && e.message); }
}

// ── Routes (FullAccess) ─────────────────────────────────────────────────────
export async function handle(request, env, ctx, url, sess) {
  if (!sess) return json({ error: "Not authenticated" }, 401, env, request);
  const db = tenantDB(env, sess.tenantId);
  const permRows = await db.prepare(
    "SELECT permission FROM user_permissions WHERE tenant_id = ? AND username = ? AND value = 1"
  ).bind(db.tenantId, sess.user.username).all();
  const perms = new Set((permRows.results || []).map(r => r.permission));
  if (!perms.has("FullAccess")) return json({ error: "Full access only" }, 403, env, request);

  const tid = sess.tenantId;
  await ensureTable(env);
  const method = request.method.toUpperCase();

  // Manual "run the probes now" for the dashboard's refresh button.
  if (url.pathname === "/health/run" && method === "POST") {
    const snap = await runHealthChecks(env, tid);
    return json({ ok: true, snapshot: snap }, 200, env, request);
  }

  // Raw recent events (paged).
  if (url.pathname === "/health/events" && method === "GET") {
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 100));
    const { results } = await env.DB.prepare(
      "SELECT id, kind, endpoint, message, status, ms, at FROM health_events WHERE tenant_id=? ORDER BY id DESC LIMIT ?"
    ).bind(tid, limit).all();
    return json({ ok: true, events: results || [] }, 200, env, request);
  }

  // Dashboard payload.
  if (url.pathname === "/health/status" && method === "GET") {
    const now = Date.now();
    const iso24 = new Date(now - 24 * 3600000).toISOString();
    const iso7 = new Date(now - 7 * 86400000).toISOString();

    let lastRun = null;
    try {
      const row = await env.DB.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?")
        .bind(tid, "health:lastrun:" + tid).first();
      if (row) lastRun = JSON.parse(row.value);
    } catch {}

    const first = (sql, ...b) => env.DB.prepare(sql).bind(...b).first();
    const all = (sql, ...b) => env.DB.prepare(sql).bind(...b).all().then(r => r.results || []);

    const [err24, err7, slow24, topErr, topSlow, recent] = await Promise.all([
      first("SELECT COUNT(*) n FROM health_events WHERE tenant_id=? AND kind='error' AND at>=?", tid, iso24),
      first("SELECT COUNT(*) n FROM health_events WHERE tenant_id=? AND kind='error' AND at>=?", tid, iso7),
      first("SELECT COUNT(*) n FROM health_events WHERE tenant_id=? AND kind='slow' AND at>=?", tid, iso24),
      all("SELECT endpoint, COUNT(*) n, MAX(at) last FROM health_events WHERE tenant_id=? AND kind='error' AND at>=? GROUP BY endpoint ORDER BY n DESC LIMIT 8", tid, iso7),
      all("SELECT endpoint, COUNT(*) n, MAX(ms) worst, ROUND(AVG(ms)) avg FROM health_events WHERE tenant_id=? AND kind='slow' AND at>=? GROUP BY endpoint ORDER BY worst DESC LIMIT 8", tid, iso7),
      all("SELECT id, kind, endpoint, message, status, ms, at FROM health_events WHERE tenant_id=? ORDER BY id DESC LIMIT 40", tid),
    ]);

    return json({
      ok: true,
      generatedAt: new Date().toISOString(),
      lastRun,
      slowMs: SLOW_MS,
      totals: { errors24h: (err24 && err24.n) || 0, errors7d: (err7 && err7.n) || 0, slow24h: (slow24 && slow24.n) || 0 },
      topErrors: topErr,
      topSlow: topSlow,
      recent,
    }, 200, env, request);
  }

  return json({ error: "Not found" }, 404, env, request);
}
