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
      // Readability probe: a missing/renamed table or a corrupt leading row
      // surfaces here as a red probe rather than a live 500. Uses LIMIT 1 (reads
      // at most ONE row per table). A COUNT(*) here scanned the WHOLE of each
      // table every 5 min (288×/day) and was a top D1 rows_read consumer for no
      // user benefit — the live counts weren't load-bearing anywhere.
      const out = [];
      for (const t of ["users", "sla_jobs", "sites", "vehicles", "app_config"]) {
        await env.DB.prepare(`SELECT 1 FROM ${t} WHERE tenant_id = 1 LIMIT 1`).first();
        out.push(t);
      }
      return "readable: " + out.join(", ");
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

// ── Data-integrity catalogue ────────────────────────────────────────────────
// The "do all the areas actually join up?" checks. Each is a COUNT of VIOLATING
// rows against the central D1 — 0 means healthy. Written against the real schema.
// Each scans a whole table, so a few dozen rules = thousands of row-level checks.
// Runs HOURLY (not every tick) since integrity drifts slowly. A rule that errors
// (e.g. a table not yet created) is marked n/a, never counted as a pass or fail.
// ADD A CHECK: push one {id, area, label, sql} — sql returns a single column `n`,
// tenant-scoped with a single `?` bound to the tenant id.
const INTEGRITY_CHECKS = [
  // ── Fleet ──────────────────────────────────────────────────────────────────
  { id: "assign_user", area: "Fleet", label: "Van assignments point at a real user",
    sql: "SELECT COUNT(*) n FROM vehicle_assignments va WHERE va.tenant_id=? AND va.username<>'' AND NOT EXISTS(SELECT 1 FROM users u WHERE u.tenant_id=va.tenant_id AND lower(u.username)=lower(va.username))" },
  { id: "assign_veh", area: "Fleet", label: "Open van assignments point at a real vehicle",
    sql: "SELECT COUNT(*) n FROM vehicle_assignments va WHERE va.tenant_id=? AND va.end_date IS NULL AND va.reg<>'' AND NOT EXISTS(SELECT 1 FROM vehicles v WHERE v.tenant_id=va.tenant_id AND upper(replace(v.reg,' ',''))=upper(replace(va.reg,' ','')))" },
  { id: "maint_veh", area: "Fleet", label: "Maintenance records point at a real vehicle",
    sql: "SELECT COUNT(*) n FROM vehicle_maintenance m WHERE m.tenant_id=? AND m.reg<>'' AND NOT EXISTS(SELECT 1 FROM vehicles v WHERE v.tenant_id=m.tenant_id AND upper(replace(v.reg,' ',''))=upper(replace(m.reg,' ','')))" },
  { id: "odo_veh", area: "Fleet", label: "Odometer readings point at a real vehicle",
    sql: "SELECT COUNT(*) n FROM odometer_readings o WHERE o.tenant_id=? AND o.reg<>'' AND NOT EXISTS(SELECT 1 FROM vehicles v WHERE v.tenant_id=o.tenant_id AND upper(replace(v.reg,' ',''))=upper(replace(o.reg,' ','')))" },
  { id: "fuel_veh", area: "Fleet", label: "Reg-tagged fuel entries point at a real vehicle",
    sql: "SELECT COUNT(*) n FROM fuel_entries f WHERE f.tenant_id=? AND f.reg IS NOT NULL AND f.reg<>'' AND NOT EXISTS(SELECT 1 FROM vehicles v WHERE v.tenant_id=f.tenant_id AND upper(replace(v.reg,' ',''))=upper(replace(f.reg,' ','')))" },
  { id: "user_veh", area: "Fleet", label: "Each user's assigned van is a real vehicle",
    sql: "SELECT COUNT(*) n FROM users u WHERE u.tenant_id=? AND u.vehicle_assigned IS NOT NULL AND u.vehicle_assigned<>'' AND NOT EXISTS(SELECT 1 FROM vehicles v WHERE v.tenant_id=u.tenant_id AND upper(replace(v.reg,' ',''))=upper(replace(u.vehicle_assigned,' ','')))" },
  // ── SLA / jobs ───────────────────────────────────────────────────────────────
  { id: "seg_job", area: "SLA", label: "Time segments point at a real job",
    sql: "SELECT COUNT(*) n FROM job_time_segments s WHERE s.tenant_id=? AND s.job_id<>'' AND NOT EXISTS(SELECT 1 FROM sla_jobs j WHERE j.tenant_id=s.tenant_id AND j.id=s.job_id)" },
  { id: "seg_user", area: "SLA", label: "Time segments point at a real user",
    sql: "SELECT COUNT(*) n FROM job_time_segments s WHERE s.tenant_id=? AND s.username<>'' AND NOT EXISTS(SELECT 1 FROM users u WHERE u.tenant_id=s.tenant_id AND lower(u.username)=lower(s.username))" },
  { id: "job_status", area: "SLA", label: "Every job has a status",
    sql: "SELECT COUNT(*) n FROM sla_jobs WHERE tenant_id=? AND (status IS NULL OR status='')" },
  { id: "job_site", area: "SLA", label: "Jobs with a store number match a real site",
    sql: "SELECT COUNT(*) n FROM sla_jobs j WHERE j.tenant_id=? AND j.site_code GLOB '[0-9]*' AND NOT j.site_code GLOB '*[^0-9]*' AND NOT EXISTS(SELECT 1 FROM sites s WHERE s.tenant_id=j.tenant_id AND CAST(s.site_number AS INTEGER)=CAST(j.site_code AS INTEGER))" },
  { id: "seg_open", area: "SLA", label: "No time segment left open for days (runaway clock)",
    sql: "SELECT COUNT(*) n FROM job_time_segments WHERE tenant_id=? AND ended_at IS NULL AND started_at < datetime('now','-2 day')" },
  // ── People ───────────────────────────────────────────────────────────────────
  { id: "push_user", area: "People", label: "Push subscriptions point at a real user",
    sql: "SELECT COUNT(*) n FROM push_subscriptions p WHERE p.tenant_id=? AND p.username<>'' AND NOT EXISTS(SELECT 1 FROM users u WHERE u.tenant_id=p.tenant_id AND lower(u.username)=lower(p.username))" },
  { id: "device_user", area: "People", label: "Registered devices point at a real user",
    sql: "SELECT COUNT(*) n FROM devices d WHERE d.tenant_id=? AND d.username<>'' AND NOT EXISTS(SELECT 1 FROM users u WHERE u.tenant_id=d.tenant_id AND lower(u.username)=lower(d.username))" },
  { id: "ts_user", area: "People", label: "Engineer timesheets point at a real user",
    sql: "SELECT COUNT(*) n FROM eng_timesheets t WHERE t.tenant_id=? AND t.username<>'' AND NOT EXISTS(SELECT 1 FROM users u WHERE u.tenant_id=t.tenant_id AND lower(u.username)=lower(t.username))" },
  { id: "active_login", area: "People", label: "Active users can actually log in (have a password)",
    sql: "SELECT COUNT(*) n FROM users WHERE tenant_id=? AND (status IS NULL OR status='' OR status='Active') AND (password_hash IS NULL OR password_hash='')" },
  // ── Holidays ─────────────────────────────────────────────────────────────────
  { id: "hol_user", area: "Holidays", label: "Current/future holiday bookings point at a real user",
    // Only CURRENT/FUTURE bookings — a past booking for a departed employee is
    // just history (kept on purpose), not a broken link, so it shouldn't flag.
    sql: "SELECT COUNT(*) n FROM holidays h WHERE h.tenant_id=? AND h.username<>'' AND h.end_date >= date('now') AND NOT EXISTS(SELECT 1 FROM users u WHERE u.tenant_id=h.tenant_id AND lower(u.username)=lower(h.username))" },
  { id: "hol_range", area: "Holidays", label: "No holiday ends before it starts",
    sql: "SELECT COUNT(*) n FROM holidays WHERE tenant_id=? AND end_date < start_date" },
  // ── Compliance ───────────────────────────────────────────────────────────────
  { id: "comp_site", area: "Compliance", label: "Linked compliance stores resolve to a real site",
    sql: "SELECT COUNT(*) n FROM compliance_stores c WHERE c.tenant_id=? AND c.site_number IS NOT NULL AND c.site_number<>'' AND NOT EXISTS(SELECT 1 FROM sites s WHERE s.tenant_id=c.tenant_id AND s.site_number=c.site_number)" },
  { id: "comp_coop_link", area: "Compliance", label: "Every Co-op store is linked to its portal site",
    sql: "SELECT COUNT(*) n FROM compliance_stores WHERE tenant_id=? AND scheme='coop' AND (site_number IS NULL OR site_number='')" },
];

// Run the whole integrity catalogue; store a snapshot; return it.
export async function runIntegrityChecks(env, tenantId) {
  const tid = tenantId || 1;
  const checks = [];
  for (const c of INTEGRITY_CHECKS) {
    try {
      const row = await env.DB.prepare(c.sql).bind(tid).first();
      const n = (row && row.n) || 0;
      checks.push({ id: c.id, area: c.area, label: c.label, n, ok: n === 0 });
    } catch (e) {
      checks.push({ id: c.id, area: c.area, label: c.label, n: 0, ok: null, error: String(e && e.message || e).slice(0, 140) });
    }
  }
  const failed = checks.filter(c => c.ok === false);
  const na = checks.filter(c => c.ok === null);
  const snapshot = { at: new Date().toISOString(), total: checks.length, passed: checks.filter(c => c.ok === true).length, failed: failed.length, na: na.length, checks };
  try {
    await env.DB.prepare("INSERT INTO app_config (tenant_id, key, value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(tid, "health:integrity:" + tid, JSON.stringify(snapshot)).run();
  } catch (e) { console.error("integrity snapshot save:", e && e.message); }
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

// ── Routes ──────────────────────────────────────────────────────────────────
export async function handle(request, env, ctx, url, sess) {
  // Machine-to-machine owner ping (PUBLIC, token-gated) — used by the AI
  // auto-fix GitHub Action to send Jamie a phone push when it ships a fix.
  // Reuses the existing JOBS_INBOUND_TOKEN so there's no new worker secret.
  if (url.pathname === "/health/notify" && request.method.toUpperCase() === "POST") {
    const secret = (env.JOBS_INBOUND_TOKEN || "").trim().replace(/^Bearer\s+/i, "").trim();
    if (!secret) return json({ ok: false, error: "not configured" }, 503, env, request);
    const tok = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    let diff = tok.length === secret.length ? 0 : 1;
    for (let i = 0; i < Math.min(tok.length, secret.length); i++) diff |= tok.charCodeAt(i) ^ secret.charCodeAt(i);
    if (diff !== 0) return json({ ok: false, error: "bad token" }, 401, env, request);
    const b = await request.json().catch(() => ({}));
    const owner = env.OWNER_USERNAME || "Jamie Line";
    await sendToUser(env, 1, owner, {
      title: String(b.title || "Portal").slice(0, 80),
      body: String(b.body || "").slice(0, 200),
      url: String(b.url || "/health.html").slice(0, 200),
      tag: "autofix",
    });
    return json({ ok: true }, 200, env, request);
  }

  // Everything else is Full-access dashboard data.
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

  // Manual "run everything now" for the dashboard's refresh button.
  if (url.pathname === "/health/run" && method === "POST") {
    const [snap, integrity] = await Promise.all([runHealthChecks(env, tid), runIntegrityChecks(env, tid)]);
    return json({ ok: true, snapshot: snap, integrity }, 200, env, request);
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

    let lastRun = null, integrity = null;
    try {
      const row = await env.DB.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?")
        .bind(tid, "health:lastrun:" + tid).first();
      if (row) lastRun = JSON.parse(row.value);
    } catch {}
    try {
      const row = await env.DB.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?")
        .bind(tid, "health:integrity:" + tid).first();
      if (row) integrity = JSON.parse(row.value);
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
      integrity,
      slowMs: SLOW_MS,
      totals: { errors24h: (err24 && err24.n) || 0, errors7d: (err7 && err7.n) || 0, slow24h: (slow24 && slow24.n) || 0 },
      topErrors: topErr,
      topSlow: topSlow,
      recent,
    }, 200, env, request);
  }

  return json({ error: "Not found" }, 404, env, request);
}
