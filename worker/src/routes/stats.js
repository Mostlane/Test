// Portal stats dashboard — a whole-system, Full-access-only overview.
//
// GET /stats  ->  { storage, jobs, sla, team, assets, sites, holidays,
//                   activity, database, generatedAt }
//
// Everything is server-derived from D1 (aggregate queries, all tenant-scoped)
// and R2 (object listing summed by category). Nothing here mutates state.

import { corsHeaders } from "../lib/http.js";
import { tenantDB } from "../lib/tenantdb.js";

function json(data, status, env, request) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json", ...corsHeaders(env, request) },
  });
}

export async function handle(request, env, ctx, url, sess) {
  if (url.pathname !== "/stats") return json({ error: "Not found" }, 404, env, request);
  if (!sess) return json({ error: "Not authenticated" }, 401, env, request);

  const tenantId = sess.tenantId;
  const db = tenantDB(env, tenantId);

  // Full access only.
  const permRows = await db.prepare(
    "SELECT permission FROM user_permissions WHERE tenant_id = ? AND username = ? AND value = 1"
  ).bind(db.tenantId, sess.user.username).all();
  const perms = new Set((permRows.results || []).map(r => r.permission));
  if (!perms.has("FullAccess")) return json({ error: "Full access only" }, 403, env, request);

  const now = Date.now();
  const isoMonthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const iso7 = new Date(now - 7 * 86400000).toISOString();
  const iso30 = new Date(now - 30 * 86400000).toISOString();
  const naive7 = iso7.replace("T", " ").slice(0, 19);   // login_history stores naive datetimes
  const year = new Date().getFullYear();
  const T = db.tenantId;

  const first = (sql, ...b) => db.prepare(sql).bind(...b).first();
  const all = (sql, ...b) => db.prepare(sql).bind(...b).all().then(r => r.results || []);

  const [
    jobsByStatus, jobsByPriority, jobsMonth, slaPerf, topEngineers, jobTotal,
    usersAgg, logins7,
    assetCount, assetRows, transfers,
    siteCount, customerCount,
    holPending, holApproved,
    audit7, audit30, views7, topUsers30, auditTotal,
    rowCounts,
  ] = await Promise.all([
    all("SELECT status, COUNT(*) n FROM sla_jobs WHERE tenant_id = ? GROUP BY status", T),
    all("SELECT priority, COUNT(*) n FROM sla_jobs WHERE tenant_id = ? GROUP BY priority", T),
    first("SELECT COUNT(*) n FROM sla_jobs WHERE tenant_id = ? AND raised_at >= ?", T, isoMonthStart),
    first("SELECT SUM(CASE WHEN closed_at IS NOT NULL AND target_at IS NOT NULL AND closed_at <= target_at THEN 1 ELSE 0 END) met, SUM(CASE WHEN closed_at IS NOT NULL AND target_at IS NOT NULL AND closed_at > target_at THEN 1 ELSE 0 END) late FROM sla_jobs WHERE tenant_id = ?", T),
    all("SELECT assigned_to name, COUNT(*) n FROM sla_jobs WHERE tenant_id = ? AND assigned_to IS NOT NULL AND assigned_to <> '' GROUP BY assigned_to ORDER BY n DESC LIMIT 6", T),
    first("SELECT COUNT(*) n FROM sla_jobs WHERE tenant_id = ?", T),
    first("SELECT COUNT(*) total, SUM(CASE WHEN status = 'Active' THEN 1 ELSE 0 END) active FROM users WHERE tenant_id = ?", T),
    first("SELECT COUNT(*) n FROM login_history WHERE tenant_id = ? AND outcome = 'success' AND at >= ?", T, naive7),
    first("SELECT COUNT(*) n FROM assets WHERE tenant_id = ?", T),
    all("SELECT data FROM assets WHERE tenant_id = ?", T),
    first("SELECT COUNT(*) n FROM asset_transfers WHERE tenant_id = ?", T),
    first("SELECT COUNT(*) n FROM sites WHERE tenant_id = ?", T),
    first("SELECT COUNT(*) n FROM customers WHERE tenant_id = ?", T),
    first("SELECT COUNT(*) n FROM holidays WHERE tenant_id = ? AND status = 'Pending'", T),
    first("SELECT COALESCE(SUM(days),0) d FROM holidays WHERE tenant_id = ? AND status = 'Approved' AND year = ?", T, year),
    first("SELECT COUNT(*) n FROM audit_log WHERE tenant_id = ? AND method <> 'VIEW' AND at >= ?", T, iso7),
    first("SELECT COUNT(*) n FROM audit_log WHERE tenant_id = ? AND method <> 'VIEW' AND at >= ?", T, iso30),
    first("SELECT COUNT(*) n FROM audit_log WHERE tenant_id = ? AND method = 'VIEW' AND at >= ?", T, iso7),
    all("SELECT username, COUNT(*) n FROM audit_log WHERE tenant_id = ? AND at >= ? GROUP BY username ORDER BY n DESC LIMIT 6", T, iso30),
    first("SELECT COUNT(*) n FROM audit_log WHERE tenant_id = ?", T),
    tableRowCounts(db, T),
  ]);

  // Asset value (kept in each asset's JSON) — small table, safe to parse.
  let assetValue = 0;
  for (const r of assetRows) {
    try { const v = parseFloat(String(JSON.parse(r.data).value || "0").replace(/[£,]/g, "")); if (!isNaN(v)) assetValue += v; }
    catch { /* skip bad rows */ }
  }

  // R2 storage, summed by category across both buckets.
  const [jobFiles, assetBucket] = await Promise.all([
    env.JOB_FILES ? sumBucket(env.JOB_FILES, classifyJobFiles) : emptyBucket(),
    env.ASSET_BUCKET ? sumBucket(env.ASSET_BUCKET, classifyAssetBucket) : emptyBucket(),
  ]);
  const categories = {};
  for (const b of [jobFiles, assetBucket]) for (const [k, v] of Object.entries(b.categories)) {
    categories[k] = categories[k] || { bytes: 0, files: 0 };
    categories[k].bytes += v.bytes; categories[k].files += v.files;
  }
  const totalBytes = jobFiles.bytes + assetBucket.bytes;
  const totalFiles = jobFiles.files + assetBucket.files;

  return json({
    generatedAt: new Date().toISOString(),
    storage: {
      totalBytes, totalFiles,
      freeBytes: 10 * 1024 * 1024 * 1024,           // R2 free tier: 10 GB
      truncated: jobFiles.truncated || assetBucket.truncated,
      categories: Object.entries(categories).map(([name, v]) => ({ name, bytes: v.bytes, files: v.files }))
        .sort((a, b) => b.bytes - a.bytes),
    },
    jobs: {
      total: jobsByStatus.reduce((s, r) => s + r.n, jobTotal ? 0 : 0) || (jobTotal && jobTotal.n) || 0,
      byStatus: jobsByStatus, byPriority: jobsByPriority, raisedThisMonth: jobsMonth.n || 0,
      topEngineers,
    },
    sla: { met: (slaPerf && slaPerf.met) || 0, late: (slaPerf && slaPerf.late) || 0 },
    team: { users: usersAgg.total || 0, active: usersAgg.active || 0, logins7: logins7.n || 0 },
    assets: { count: assetCount.n || 0, value: Math.round(assetValue), transfers: transfers.n || 0 },
    sites: { sites: siteCount.n || 0, customers: customerCount.n || 0 },
    holidays: { pending: holPending.n || 0, approvedDaysThisYear: Math.round((holApproved.d || 0) * 2) / 2 },
    activity: { actions7: audit7.n || 0, actions30: audit30.n || 0, pageViews7: views7.n || 0, totalLogged: auditTotal.n || 0, topUsers: topUsers30 },
    database: rowCounts,
  }, 200, env, request);
}

async function tableRowCounts(db, T) {
  const tables = ["users", "sla_jobs", "sites", "customers", "assets", "asset_transfers",
    "holidays", "audit_log", "login_history", "notify_log", "portal_keys", "devices", "sessions"];
  const out = [];
  let total = 0;
  for (const t of tables) {
    // Static-audit-safe: literal contains tenant_id.
    const row = await db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE tenant_id = ?`).bind(T).first();
    const n = (row && row.n) || 0;
    total += n; out.push({ table: t, rows: n });
  }
  return { total, tables: out };
}

function emptyBucket() { return { bytes: 0, files: 0, categories: {}, truncated: false }; }
async function sumBucket(bucket, classify) {
  const res = emptyBucket();
  let cursor, pages = 0;
  do {
    const listed = await bucket.list({ limit: 1000, cursor });
    for (const o of listed.objects || []) {
      res.bytes += o.size || 0; res.files += 1;
      const cat = classify(o.key);
      res.categories[cat] = res.categories[cat] || { bytes: 0, files: 0 };
      res.categories[cat].bytes += o.size || 0; res.categories[cat].files += 1;
    }
    cursor = listed.truncated ? listed.cursor : null;
    pages++;
    if (pages >= 40) { res.truncated = res.truncated || !!cursor; break; }  // safety cap ~40k objects
  } while (cursor);
  return res;
}
function classifyJobFiles(key) {
  if (key.startsWith("sitedocs/")) return "Site documents";
  if (key.startsWith("jobs/") && key.includes("/signature/")) return "Signatures";
  if (key.startsWith("jobs/")) return "Job photos";
  if (key.startsWith("sites/")) return "Site images";
  return "Other files";
}
function classifyAssetBucket(key) {
  if (key.startsWith("vancheck/")) return "Van check photos";
  if (key.startsWith("theme/")) return "Theme backgrounds";
  if (key.endsWith(".thumb")) return "Thumbnails";
  return "Asset photos";
}
