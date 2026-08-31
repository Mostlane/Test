// routes/po.js — Purchase Orders, IN-PORTAL (migrated off the standalone
// mostlane-po worker). The PO DATA still lives in its own D1 (`mostlane-po`,
// bound as env.PO_DB) — nothing was migrated; only the code moved here so the
// system runs on the portal origin (unified PWA), auto-deploys, and is gated by
// portal login + the `PurchaseOrders` permission with full activity-log cover.
//
// Identity: the "issued by" / engineer is the LOGGED-IN portal user, stamped
// server-side from the session — there are no more personal token URLs.
// The out-of-hours rule is preserved: field engineers can only raise a PO when
// the office is closed; office staff (PurchaseOrders/FullAccess) any time.
import { json, error } from "../lib/http.js";
import { permissionsFor } from "../lib/auth.js";

// staffType lives in the user's profile JSON; default "field" (matches auth.js).
function staffTypeOf(u) {
  try { const p = JSON.parse(u.profile || "{}"); return p && p.staffType === "office" ? "office" : "field"; }
  catch { return "field"; }
}
function userName(sess) {
  const u = (sess && sess.user) || {};
  return (u.name || ((u.first_name || u.FirstName || "") + " " + (u.last_name || u.LastName || "")).trim() || u.username || "").trim();
}
function userSlug(sess) {
  const u = (sess && sess.user) || {};
  return slugify(u.username || userName(sess) || "user");
}

// Vehicles come from the PORTAL database (env.DB) directly now — no cross-worker
// PORTAL_DB hop. Returns pickable "sites" (AdBlue/parts POs tagged to a van).
let vehicleCache = { at: 0, list: [] };
async function getVehicles(env) {
  const db = env.DB;
  if (!db) return [];
  try {
    const info = await db.prepare(`PRAGMA table_info(vehicles)`).all();
    const cols = new Set((info.results || []).map(r => r.name));
    if (!cols.size) return [];
    const regCol = ["reg", "registration", "vrm", "reg_number"].find(c => cols.has(c));
    if (!regCol) return [];
    const pick = c => cols.has(c) ? c : `NULL AS ${c}`;
    const where = [];
    if (cols.has("active")) where.push(`(active IS NULL OR active = 1)`);
    if (cols.has("tenant_id")) where.push(`tenant_id = 1`);
    const sql = `SELECT ${regCol} AS reg, ${pick("make")}, ${pick("model")}, ${pick("pool")} FROM vehicles`
      + (where.length ? ` WHERE ${where.join(" AND ")}` : "") + ` ORDER BY ${regCol}`;
    const rows = await db.prepare(sql).all();
    return (rows.results || []).filter(r => r.reg && String(r.reg).trim()).map(r => {
      const reg = String(r.reg).trim().toUpperCase();
      const desc = [r.make, r.model].filter(Boolean).join(" ").trim();
      return { reg, make: r.make || null, model: r.model || null, desc, pool: !!Number(r.pool || 0), label: desc ? `${reg} — ${desc}` : reg };
    });
  } catch (e) { console.error("PO vehicle lookup failed:", e.message); return []; }
}

// Names of LIVE projects (the only sites an engineer may raise a PO against
// from the standalone form). Reads the portal projects table (env.DB). Archived
// / complete projects are excluded so a finished job can't take new spend.
async function liveProjectNames(env) {
  const db = env.DB;
  if (!db) return [];
  try {
    const rows = await db.prepare(
      `SELECT name FROM projects WHERE tenant_id IN ('1.0','1',1) AND (status='live' OR status IS NULL) ORDER BY name`
    ).all();
    return (rows.results || []).map(r => String(r.name || "").trim()).filter(Boolean);
  } catch (e) { console.error("PO live-project lookup failed:", e.message); return []; }
}
async function isLiveProjectSite(env, name) {
  const n = String(name || "").trim().toLowerCase();
  if (!n) return false;
  return (await liveProjectNames(env)).some(p => p.toLowerCase() === n);
}

// The engineer raise-PO form's option set: every LIVE project (as a pickable
// "site") + all vehicles, with the caller's own assigned van flagged `mine` so
// the front-end can surface it first. Reactive-maintenance jobs are deliberately
// NOT here — those POs are raised from the job card so they tie to a job.
async function getRaiseOptions(env, username) {
  const projects = (await liveProjectNames(env)).map(name => ({ name }));
  let mineReg = "";
  try {
    const u = await env.DB.prepare(
      `SELECT vehicle_assigned FROM users WHERE tenant_id IN ('1.0','1',1) AND lower(username)=lower(?)`
    ).bind(String(username || "")).first();
    mineReg = String(u && u.vehicle_assigned || "").trim().toUpperCase().replace(/\s+/g, "");
  } catch (e) { /* no assigned van */ }
  // Engineers pick ONLY their assigned van + shared/pool vehicles (e.g. tippers).
  const vehicles = (await getVehicles(env))
    .map(v => ({ ...v, mine: !!mineReg && v.reg.replace(/\s+/g, "") === mineReg }))
    .filter(v => v.mine || v.pool);
  return { projects, vehicles };
}

// ── Router: everything under /po/* ─────────────────────────────────────────
export async function handle(request, env, ctx, url, sess) {
  const db = env.PO_DB;
  if (!db) return error("PO database not bound (PO_DB)", 500, env, request);
  // Permissions come from the user_permissions table; office = can manage POs,
  // field engineers = may raise (out of hours) but never see the office surface.
  // A Disabled (blocked) user is cut off from PO server-side, even if a token
  // somehow survived — requireSession loads the user fresh, so status is current.
  if (sess.user && String(sess.user.status || "").toLowerCase() === "disabled") return error("Account disabled", 403, env, request);
  const perms = await permissionsFor(env, sess.tenantId, sess.user.username);
  const field = staffTypeOf(sess.user) === "field";
  // Field engineers are ALWAYS the restricted (raise-only) role, even if they
  // hold the PurchaseOrders permission — that perm just means "can use POs".
  // Only FullAccess, or PurchaseOrders on a NON-field (office) account, is office.
  const office = perms.FullAccess === "Yes" || (perms.PurchaseOrders === "Yes" && !field);
  if (!office && !field) return error("Not allowed", 403, env, request);
  const path = url.pathname.replace(/^\/po/, "") || "/";
  const method = request.method.toUpperCase();
  const q = url.searchParams;
  const jr = (d, status) => json(d, status ? { status } : {}, env, request);
  const bodyOf = async () => { try { return await request.json(); } catch { return {}; } };

  try {
    // ── Reference data (any PO user may read) ──
    if (path === "/api/status" && method === "GET") return jr(await getSystemStatus(db));
    if (path === "/api/config" && method === "GET") return jr(await getConfig(db));
    if (path === "/api/suppliers" && method === "GET") return jr(await getSuppliers(db));
    if (path === "/api/subcontractors" && method === "GET") return jr(await getSubcontractors(db));
    if (path === "/api/trades" && method === "GET") return jr(await getTrades(db));
    if (path === "/api/sites" && method === "GET") return jr(await getSites(db));
    if (path === "/api/engineers" && method === "GET") return jr(await getPortalEngineers(env, sess.tenantId));
    if (path === "/api/office-users" && method === "GET") return jr(await getOfficeUsers(db));
    if (path === "/api/vehicles" && method === "GET") return jr(await getVehicles(env));
    if (path === "/api/raise-options" && method === "GET") return jr(await getRaiseOptions(env, sess.user.username));
    if (path === "/api/closures" && method === "GET") return jr(await getClosures(db));
    if (path === "/api/jobs/search" && method === "GET") return jr(await searchJobs(db, q));

    // ── Raise a PO ──
    if (path === "/api/pos" && method === "POST") {
      const b = await bodyOf();
      // Server decides the source from the caller's role — never trust the client.
      if (office) {
        b.source = "office";
        b.office_user_slug = userSlug(sess); b.office_user_name = userName(sess);
      } else {
        b.source = "engineer";
        b.engineer_slug = userSlug(sess); b.engineer_name = userName(sess);
        b.cost_category = "materials"; // engineers never raise subcontractor POs
      }
      const res = await issuePO(db, b, env);
      return jr(res, res.error ? 400 : 200);
    }

    // A field engineer can see THEIR OWN recent POs (never the whole log).
    if (path === "/api/my-pos" && method === "GET") {
      const p = new URLSearchParams(q);
      p.set("engineer", userSlug(sess));
      p.set("hide_subcontractor", "1");
      return jr(await getPOs(db, p));
    }

    // ── Everything past here is office/admin only ──
    if (!office) return error("Not allowed", 403, env, request);

    if (path === "/api/pos" && method === "GET") return jr(await getPOs(db, q));
    if (path.startsWith("/api/pos/") && method === "PATCH") {
      const b = await bodyOf();
      b.edited_by_slug = userSlug(sess); b.edited_by_name = userName(sess);
      return jr(await updatePO(db, path.split("/").pop(), b));
    }
    if (path.startsWith("/api/pos/") && method === "DELETE") return jr(await deletePoRecord(db, path.split("/").pop()));

    if (path === "/api/dashboard" && method === "GET") return jr(await getDashboard(db));
    if (path === "/api/stats" && method === "GET") return jr(await getStats(db, q));
    if (path === "/api/summary" && method === "GET") return jr(await getSummary(db, q));
    if (path === "/api/jobcost" && method === "GET") return jr(await getJobCost(db, q));
    if (path === "/api/accounts" && method === "GET") return jr(await getAccounts(db));

    // ── Admin: reference-data management ──
    if (path === "/api/config" && method === "POST") return jr(await updateConfig(db, await bodyOf()));
    if (path === "/api/suppliers" && method === "POST") return jr(await addSupplier(db, await bodyOf()));
    if (path.startsWith("/api/suppliers/") && method === "PATCH") return jr(await updateSupplier(db, path.split("/").pop(), await bodyOf()));
    if (path.startsWith("/api/suppliers/") && method === "DELETE") return jr(await deleteSupplier(db, path.split("/").pop()));
    if (path === "/api/subcontractors" && method === "POST") return jr(await addSubcontractor(db, await bodyOf()));
    if (path.startsWith("/api/subcontractors/") && method === "DELETE") return jr(await deleteSubcontractor(db, path.split("/").pop()));
    if (path === "/api/trades" && method === "POST") return jr(await addTrade(db, await bodyOf()));
    if (path.startsWith("/api/trades/") && method === "DELETE") return jr(await deleteTrade(db, path.split("/").pop()));
    if (path === "/api/sites/usage" && method === "GET") return jr(await siteUsage(db));
    if (path === "/api/sites/merge" && method === "POST") return jr(await mergeSites(db, await bodyOf()));
    if (path === "/api/sites" && method === "POST") return jr(await addSite(db, await bodyOf()));
    if (path.startsWith("/api/sites/") && method === "DELETE") return jr(await deleteSite(db, path.split("/").pop()));
    if (path === "/api/closures" && method === "POST") return jr(await addClosure(db, await bodyOf()));
    if (path.startsWith("/api/closures/") && method === "DELETE") return jr(await deleteClosure(db, decodeURIComponent(path.split("/").pop())));

    return error("Not found: " + path, 404, env, request);
  } catch (e) {
    console.error("PO route error:", e && e.message);
    return error("PO error: " + (e && e.message || "unknown"), 500, env, request);
  }
}

// The "assign to engineer" dropdown is sourced LIVE from portal staff (field
// users), so it stays current with no dependency on the old worker's sync or the
// PO engineers table. slug = slugify(username) — matches what an engineer's own
// raise stamps (userSlug), so assignments line up.
async function getPortalEngineers(env, tenantId) {
  try {
    const { results } = await env.DB.prepare(
      "SELECT username, first_name, last_name, profile FROM users WHERE tenant_id=? AND (status IS NULL OR status='' OR LOWER(status)='active') ORDER BY first_name, last_name"
    ).bind(tenantId).all();
    return (results || []).filter(u => {
      try { const p = JSON.parse(u.profile || "{}"); return (p.staffType || "field") === "field"; } catch { return true; }
    }).map(u => ({ slug: slugify(u.username), name: ((u.first_name || "") + " " + (u.last_name || "")).trim() || u.username, active: 1 }));
  } catch (e) { console.error("PO getPortalEngineers failed:", e && e.message); return []; }
}

// ── Ported data-layer functions (from the standalone worker; db = env.PO_DB) ──
async function getConfigMap(db) {
  const rows = await db.prepare(`SELECT key, value FROM config`).all();
  const map = {};
  for (const r of rows.results) map[r.key] = r.value;
  return map;
}

async function getConfig(db) {
  return await getConfigMap(db);
}

async function updateConfig(db, body) {
  for (const [k, v] of Object.entries(body)) {
    await db.prepare(`INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?`).bind(k, String(v), String(v)).run();
  }
  return { success: true };
}

async function getSystemStatus(db) {
  const config = await getConfigMap(db);
  const now = /* @__PURE__ */ new Date();
  const ukTime = new Date(now.toLocaleString("en-US", { timeZone: "Europe/London" }));
  const dayMap = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  const today = dayMap[ukTime.getDay()];
  const todayDate = ukTime.toISOString().split("T")[0];
  const currentTime = ukTime.toTimeString().slice(0, 5);
  const closure = await db.prepare(`SELECT * FROM closures WHERE date = ?`).bind(todayDate).first();
  if (config.system_status === "disabled") return { mode: "disabled", message: "System is currently offline. Call office on " + config.office_phone };
  if (config.force_open_ooh === "1") return { mode: "ooh", message: null, forced: true };
  const officeDays = config.office_days.split(",");
  if (!officeDays.includes(today) || closure) return { mode: "ooh", message: null, reason: closure ? closure.reason : "weekend" };
  if (currentTime >= config.office_hours_start && currentTime <= config.office_hours_end) return { mode: "office_hours", message: "Please call the office on " + config.office_phone };
  return { mode: "ooh", message: null };
}

async function getEngineers(db) {
  return (await db.prepare(`SELECT * FROM engineers ORDER BY name`).all()).results;
}

async function addEngineer(db, body) {
  const slug = slugify(body.name);
  await db.prepare(`INSERT INTO engineers (slug, name, active, token) VALUES (?, ?, 1, ?) ON CONFLICT(slug) DO UPDATE SET active = 1, name = ?`).bind(slug, body.name, randomToken(), body.name).run();
  return { success: true, slug };
}

async function deleteEngineer(db, slug) {
  await db.prepare(`UPDATE engineers SET active = 0 WHERE slug = ?`).bind(slug).run();
  return { success: true };
}

async function updateEngineer(db, slug, body) {
  if (body.suspended !== void 0) {
    const susp = body.suspended ? 1 : 0;
    const reason = susp ? (body.suspend_reason || "").trim() || null : null;
    await db.prepare(`UPDATE engineers SET suspended = ?, suspend_reason = ? WHERE slug = ?`).bind(susp, reason, slug).run();
  }
  return { success: true };
}

async function rotateToken(db, table, slug) {
  const token = randomToken();
  await db.prepare(`UPDATE ${table} SET token = ? WHERE slug = ?`).bind(token, slug).run();
  return { success: true, token };
}

async function getOfficeUsers(db) {
  return (await db.prepare(`SELECT * FROM office_users ORDER BY name`).all()).results;
}

async function addOfficeUser(db, body) {
  const slug = slugify(body.name);
  await db.prepare(`INSERT INTO office_users (slug, name, active, token) VALUES (?, ?, 1, ?) ON CONFLICT(slug) DO UPDATE SET active = 1, name = ?`).bind(slug, body.name, randomToken(), body.name).run();
  return { success: true, slug };
}

async function deleteOfficeUser(db, slug) {
  await db.prepare(`UPDATE office_users SET active = 0 WHERE slug = ?`).bind(slug).run();
  return { success: true };
}

async function getSuppliers(db) {
  return (await db.prepare(`SELECT * FROM suppliers WHERE active = 1 ORDER BY name`).all()).results;
}

async function addSupplier(db, body) {
  await db.prepare(`INSERT INTO suppliers (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET active = 1`).bind(body.name).run();
  return { success: true };
}

async function deleteSupplier(db, id) {
  await db.prepare(`UPDATE suppliers SET active = 0 WHERE id = ?`).bind(id).run();
  return { success: true };
}

async function updateSupplier(db, id, body) {
  if (body.terms_days !== void 0) {
    const days = Number(body.terms_days) === 60 ? 60 : 30;
    await db.prepare(`UPDATE suppliers SET terms_days = ? WHERE id = ?`).bind(days, id).run();
  }
  return { success: true };
}

async function getSubcontractors(db) {
  return (await db.prepare(`SELECT * FROM subcontractors WHERE active = 1 ORDER BY name`).all()).results;
}

async function addSubcontractor(db, body) {
  await db.prepare(`INSERT INTO subcontractors (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET active = 1`).bind(body.name).run();
  return { success: true };
}

async function deleteSubcontractor(db, id) {
  await db.prepare(`UPDATE subcontractors SET active = 0 WHERE id = ?`).bind(id).run();
  return { success: true };
}

async function getTrades(db) {
  return (await db.prepare(`SELECT * FROM trades WHERE active = 1 ORDER BY name`).all()).results;
}

async function addTrade(db, body) {
  await db.prepare(`INSERT INTO trades (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET active = 1`).bind(body.name).run();
  return { success: true };
}

async function deleteTrade(db, id) {
  await db.prepare(`UPDATE trades SET active = 0 WHERE id = ?`).bind(id).run();
  return { success: true };
}

async function getSites(db) {
  return (await db.prepare(`SELECT * FROM sites WHERE active = 1 ORDER BY name`).all()).results;
}

async function addSite(db, body) {
  await db.prepare(`INSERT INTO sites (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET active = 1`).bind(body.name).run();
  return { success: true };
}

async function deleteSite(db, id) {
  await db.prepare(`UPDATE sites SET active = 0 WHERE id = ?`).bind(id).run();
  return { success: true };
}

// Every site NAME that actually appears on a PO, with how many POs use it and
// whether it's a known (active) site — so the merge tool can surface the
// free-text / duplicate names that need collapsing, not just the tidy list.
async function siteUsage(db) {
  const known = new Set((await db.prepare(`SELECT LOWER(name) AS n FROM sites WHERE active = 1`).all()).results.map(r => r.n));
  const rows = (await db.prepare(
    `SELECT site AS name, COUNT(*) AS pos FROM po_log
       WHERE site IS NOT NULL AND TRIM(site) <> '' GROUP BY site ORDER BY LOWER(site)`
  ).all()).results;
  // Also include known sites that carry NO POs yet (so a duplicate can be merged
  // INTO a clean site that just hasn't been used).
  const seen = new Set(rows.map(r => String(r.name).toLowerCase()));
  const empties = (await db.prepare(`SELECT name FROM sites WHERE active = 1 ORDER BY name`).all()).results
    .filter(r => !seen.has(String(r.name).toLowerCase()))
    .map(r => ({ name: r.name, pos: 0 }));
  return rows.concat(empties)
    .map(r => ({ name: r.name, pos: r.pos, known: known.has(String(r.name).toLowerCase()) }))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

// Collapse several duplicate site names onto one canonical name: rewrite every
// PO's `site` to the target (so job costing rolls up onto ONE site) and retire
// the merged-away source sites from the pickable list. The target becomes a
// known active site so it's always pickable afterwards.
async function mergeSites(db, body) {
  const into = (body && body.into || "").trim();
  const from = Array.isArray(body && body.from) ? body.from.map(s => String(s || "").trim()).filter(Boolean) : [];
  if (!into) return { error: "Pick the site to merge into" };
  const sources = from.filter(s => s.toLowerCase() !== into.toLowerCase());
  if (!sources.length) return { error: "Pick at least one different site to merge in" };
  // Make sure the target exists as a known active site.
  await db.prepare(`INSERT INTO sites (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET active = 1`).bind(into).run();
  const ph = sources.map(() => "?").join(",");
  // Repoint every PO on a source name to the target.
  const upd = await db.prepare(`UPDATE po_log SET site = ? WHERE site IN (${ph})`).bind(into, ...sources).run();
  const moved = (upd && upd.meta && upd.meta.changes) || 0;
  // Retire the merged-away sites so they can't be picked again.
  await db.prepare(`UPDATE sites SET active = 0 WHERE name IN (${ph})`).bind(...sources).run();
  return { success: true, into, merged: sources.length, posMoved: moved };
}

async function searchJobs(db, params) {
  const q = (params.get("q") || "").trim();
  if (q.length < 2) return [];
  const rows = await db.prepare(
    `SELECT name FROM sites WHERE active = 1 AND name LIKE ? ORDER BY name LIMIT 10`
  ).bind("%" + q + "%").all();
  return rows.results.map((r) => ({ job_ref: r.name, site: r.name, client: null }));
}

async function getClosures(db) {
  return (await db.prepare(`SELECT * FROM closures ORDER BY date DESC`).all()).results;
}

async function addClosure(db, body) {
  await db.prepare(`INSERT INTO closures (date, reason) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET reason = ?`).bind(body.date, body.reason || "", body.reason || "").run();
  return { success: true };
}

async function deleteClosure(db, date) {
  await db.prepare(`DELETE FROM closures WHERE date = ?`).bind(date).run();
  return { success: true };
}


async function getPOs(db, params) {
  let query = `SELECT * FROM po_log WHERE deleted = 0`;
  const binds = [];
  if (params.get("needs_review") === "1") query += ` AND needs_review = 1`;
  if (params.get("hide_subcontractor") === "1") query += ` AND COALESCE(cost_category, 'materials') != 'subcontractor'`;
  if (params.get("category")) {
    query += ` AND COALESCE(cost_category, 'materials') = ?`;
    binds.push(params.get("category"));
  }
  if (params.get("trade")) {
    query += ` AND trade = ?`;
    binds.push(params.get("trade"));
  }
  if (params.get("site")) {
    query += ` AND site = ?`;
    binds.push(params.get("site"));
  }
  if (params.get("engineer")) {
    query += ` AND engineer_slug = ?`;
    binds.push(params.get("engineer"));
  }
  if (params.get("office_user")) {
    query += ` AND office_user_slug = ?`;
    binds.push(params.get("office_user"));
  }
  if (params.get("supplier")) {
    query += ` AND supplier = ?`;
    binds.push(params.get("supplier"));
  }
  if (params.get("from")) {
    query += ` AND issued_at >= ?`;
    binds.push(params.get("from"));
  }
  if (params.get("to")) {
    query += ` AND issued_at <= ?`;
    binds.push(params.get("to") + "T23:59:59");
  }
  if (params.get("status")) {
    query += ` AND COALESCE(status, 'open') = ?`;
    binds.push(params.get("status"));
  }
  if (params.get("uncosted") === "1") query += ` AND (cost_ex_vat IS NULL)`;
  if (params.get("unmatched_site") === "1") {
    query += ` AND (site IS NOT NULL AND site NOT IN (SELECT name FROM sites WHERE active = 1))`;
  }
  if (params.get("search")) {
    const term = "%" + params.get("search").toLowerCase() + "%";
    query += ` AND (CAST(po_number AS TEXT) LIKE ? OR LOWER(engineer_name) LIKE ? OR LOWER(site) LIKE ? OR LOWER(incident_no) LIKE ? OR LOWER(supplier) LIKE ? OR LOWER(description) LIKE ? OR LOWER(flag_reason) LIKE ? OR LOWER(credit_note) LIKE ?)`;
    binds.push(term, term, term, term, term, term, term, term);
  }
  if (params.get("job_id")) {
    // Deep-link from a job card: show only the POs raised against that SLA job
    // (po_log.job_id is stamped from the job's "Raise PO" link).
    query += ` AND job_id = ?`;
    binds.push(params.get("job_id"));
  }
  query += ` ORDER BY po_number DESC LIMIT 1000`;
  return (await db.prepare(query).bind(...binds).all()).results;
}

async function getJobCost(db, params) {
  let where = `WHERE deleted = 0 AND site IS NOT NULL AND TRIM(site) != ''`;
  const binds = [];
  if (params.get("from")) {
    where += ` AND issued_at >= ?`;
    binds.push(params.get("from"));
  }
  if (params.get("to")) {
    where += ` AND issued_at <= ?`;
    binds.push(params.get("to") + "T23:59:59");
  }
  const [byJob, byTrade] = await db.batch([
    db.prepare(`SELECT site,
        COUNT(*) AS po_count,
        SUM(CASE WHEN cost_ex_vat IS NULL THEN 1 ELSE 0 END) AS uncosted,
        COALESCE(SUM(CASE WHEN COALESCE(cost_category, 'materials') = 'materials' THEN cost_ex_vat ELSE 0 END), 0) AS materials_ex,
        COALESCE(SUM(CASE WHEN cost_category = 'subcontractor' THEN cost_ex_vat ELSE 0 END), 0) AS subcontractor_ex,
        COALESCE(SUM(cost_ex_vat), 0) AS total_ex
      FROM po_log ${where} GROUP BY site`).bind(...binds),
    db.prepare(`SELECT site, COALESCE(trade, '(no trade)') AS trade,
        COUNT(*) AS count, COALESCE(SUM(cost_ex_vat), 0) AS ex
      FROM po_log ${where} AND cost_category = 'subcontractor'
      GROUP BY site, trade`).bind(...binds)
  ]);
  const tradesBySite = {};
  for (const t of byTrade.results) {
    (tradesBySite[t.site] = tradesBySite[t.site] || []).push({ trade: t.trade, count: t.count, ex: t.ex });
  }
  const jobs = byJob.results.map((j) => ({
    site: j.site,
    po_count: j.po_count,
    uncosted: j.uncosted,
    materials_ex: j.materials_ex,
    subcontractor_ex: j.subcontractor_ex,
    total_ex: j.total_ex,
    by_trade: (tradesBySite[j.site] || []).sort((a, b) => b.ex - a.ex || b.count - a.count)
  })).sort((a, b) => b.total_ex - a.total_ex || b.po_count - a.po_count);
  return {
    jobs,
    totals: {
      jobs: jobs.length,
      po_count: jobs.reduce((s, j) => s + j.po_count, 0),
      uncosted: jobs.reduce((s, j) => s + j.uncosted, 0),
      materials_ex: jobs.reduce((s, j) => s + j.materials_ex, 0),
      subcontractor_ex: jobs.reduce((s, j) => s + j.subcontractor_ex, 0),
      total_ex: jobs.reduce((s, j) => s + j.total_ex, 0)
    }
  };
}

const PO_START = 10011;   // first PO number the system allocates (from the standalone worker)
async function nextPoNumber(db) {
  const row = await db.prepare(`
    SELECT COALESCE(MIN(n), ?) AS next FROM (
      SELECT ? AS n
      UNION ALL
      SELECT po_number + 1 FROM po_log
    ) WHERE n >= ? AND n NOT IN (SELECT po_number FROM po_log)
  `).bind(PO_START, PO_START, PO_START).first();
  return row.next;
}

async function issuePO(db, body, env) {
  const status = await getSystemStatus(db);
  if (status.mode === "disabled") return { error: status.message };
  if (status.mode === "office_hours" && body.source !== "office") return { error: status.message };
  const isSubcontractor = body.cost_category === "subcontractor";
  if (isSubcontractor) {
    if (body.source !== "office") return { error: "Subcontractor POs can only be raised by the office" };
    if (!body.site || !body.site.trim()) return { error: "Site (job) is required for a subcontractor PO" };
    if (!body.supplier || !body.supplier.trim()) return { error: "Subcontractor is required" };
    if (!body.trade || !body.trade.trim()) return { error: "Trade is required for a subcontractor PO" };
    if (!body.description || !body.description.trim()) return { error: "Description is required" };
  }
  if (body.source === "engineer") {
    if (body.engineer_slug) {
      const eng = await db.prepare(`SELECT suspended FROM engineers WHERE slug = ?`).bind(body.engineer_slug).first();
      if (eng && eng.suspended) return { error: "Access to Mostlane PO system has been suspended. Please contact the office for more info." };
    }
    const hasSite = body.site && body.site.trim();
    const hasIncident = body.incident_no && body.incident_no.trim();
    if (!hasSite && !hasIncident) return { error: "Enter a site or an incident number" };
    if (!body.supplier || !body.supplier.trim()) return { error: "Supplier is required" };
    if (!body.description || !body.description.trim()) return { error: "Description is required" };
    const supplierCheck = await db.prepare(`SELECT 1 FROM suppliers WHERE name = ? AND active = 1`).bind(body.supplier).first();
    if (!supplierCheck) return { error: "Supplier must be picked from the list" };
    // Engineers raise ONLY against: a company vehicle (vehicle_reg, AdBlue/parts),
    // a reactive job via the job-card "Raise PO for this job" link (job_id ties
    // it), or a LIVE PROJECT site. A plainly-typed site (reactive or otherwise) is
    // rejected — reactive POs must come from the job card so they tie to a job and
    // job costing stays clean.
    const hasVehicle = body.vehicle_reg && String(body.vehicle_reg).trim();
    const hasJob = body.job_id && String(body.job_id).trim();
    if (hasSite && !hasVehicle && !hasJob) {
      if (!(env && await isLiveProjectSite(env, body.site.trim()))) {
        return { error: "Engineers can only raise POs against a live project or your vehicle. For a reactive job, use “Raise PO for this job” inside the job card." };
      }
    }
  }
  const issuedAt = (/* @__PURE__ */ new Date()).toISOString();
  let poNumber;
  for (let attempt = 0; attempt < 6; attempt++) {
    poNumber = await nextPoNumber(db);
    try {
      await db.prepare(`INSERT INTO po_log (po_number, engineer_slug, engineer_name, issued_at, source, site, incident_no, supplier, description, needs_review, office_user_slug, office_user_name, cost_category, trade, job_id, job_ref, vehicle_reg) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        poNumber,
        body.engineer_slug || null,
        body.engineer_name || null,
        issuedAt,
        body.source || "office",
        body.site || null,
        body.incident_no || null,
        body.supplier || null,
        body.description || null,
        body.source === "office" ? 0 : 1,
        body.office_user_slug || null,
        body.office_user_name || null,
        isSubcontractor ? "subcontractor" : "materials",
        isSubcontractor ? body.trade || null : null,
        // Blank unless the PO was raised from a portal job link
        (body.job_id || "").trim() || null,
        (body.job_ref || "").trim() || null,
        // Uppercase so the portal's UPPER(REPLACE(reg,' ','')) match always lines up
        (body.vehicle_reg || "").trim().toUpperCase() || null
      ).run();
      return { success: true, po_number: poNumber, issued_at: issuedAt };
    } catch (e) {
      if (!/UNIQUE|constraint|PRIMARY/i.test(e.message)) throw e;
    }
  }
  return { error: "Could not allocate a PO number, please try again" };
}

async function deletePoRecord(db, poNumber) {
  await db.prepare(`DELETE FROM po_log WHERE po_number = ?`).bind(poNumber).run();
  return { success: true };
}

async function updatePO(db, poNumber, body) {
  const allowed = ["site", "incident_no", "supplier", "description", "needs_review", "reviewed_by", "engineer_slug", "engineer_name", "deleted", "cost_ex_vat", "vat_rate", "status", "flag_reason", "credit_note", "cost_category", "trade", "job_id", "job_ref", "vehicle_reg"];
  const fields = [];
  const binds = [];
  for (const [k, v] of Object.entries(body)) {
    if (allowed.includes(k)) {
      fields.push(`${k} = ?`);
      binds.push(v === "" ? null : v);
    }
  }
  if (body.needs_review === 0) {
    fields.push(`reviewed_at = ?`);
    binds.push((/* @__PURE__ */ new Date()).toISOString());
  }
  if (body.cost_ex_vat !== void 0 && body.cost_ex_vat !== null && body.cost_ex_vat !== "") {
    fields.push(`cost_entered_at = ?`);
    binds.push((/* @__PURE__ */ new Date()).toISOString());
  }
  if (body.edited_by_slug && body.edited_by_name) {
    fields.push(`last_edited_by_slug = ?`);
    binds.push(body.edited_by_slug);
    fields.push(`last_edited_by_name = ?`);
    binds.push(body.edited_by_name);
    fields.push(`last_edited_at = ?`);
    binds.push((/* @__PURE__ */ new Date()).toISOString());
  }
  if (!fields.length) return { success: true };
  binds.push(poNumber);
  await db.prepare(`UPDATE po_log SET ${fields.join(", ")} WHERE po_number = ?`).bind(...binds).run();
  return { success: true };
}

async function getDashboard(db) {
  const ukTime = new Date((/* @__PURE__ */ new Date()).toLocaleString("en-US", { timeZone: "Europe/London" }));
  const todayDate = ukTime.toISOString().split("T")[0];
  const [uncosted, review, flagged, creditDue, unmatched, today] = await db.batch([
    db.prepare(`SELECT COUNT(*) c FROM po_log WHERE deleted = 0 AND cost_ex_vat IS NULL AND COALESCE(status, 'open') != 'complete'`),
    db.prepare(`SELECT COUNT(*) c FROM po_log WHERE deleted = 0 AND needs_review = 1`),
    db.prepare(`SELECT COUNT(*) c FROM po_log WHERE deleted = 0 AND COALESCE(status, 'open') = 'flagged'`),
    db.prepare(`SELECT COUNT(*) c FROM po_log WHERE deleted = 0 AND COALESCE(status, 'open') = 'credit_due'`),
    db.prepare(`SELECT COUNT(*) c FROM po_log WHERE deleted = 0 AND site IS NOT NULL AND site NOT IN (SELECT name FROM sites WHERE active = 1)`),
    db.prepare(`SELECT COUNT(*) c FROM po_log WHERE deleted = 0 AND substr(issued_at, 1, 10) = ?`).bind(todayDate)
  ]);
  return {
    uncosted: uncosted.results[0].c,
    needs_review: review.results[0].c,
    flagged: flagged.results[0].c,
    credit_due: creditDue.results[0].c,
    unmatched_site: unmatched.results[0].c,
    today: today.results[0].c
  };
}

async function getStats(db, params) {
  let where = `WHERE deleted = 0`;
  const binds = [];
  if (params.get("engineer")) {
    where += ` AND engineer_slug = ?`;
    binds.push(params.get("engineer"));
  }
  if (params.get("supplier")) {
    where += ` AND supplier = ?`;
    binds.push(params.get("supplier"));
  }
  if (params.get("from")) {
    where += ` AND issued_at >= ?`;
    binds.push(params.get("from"));
  }
  if (params.get("to")) {
    where += ` AND issued_at <= ?`;
    binds.push(params.get("to") + "T23:59:59");
  }
  if (params.get("source")) {
    where += ` AND source = ?`;
    binds.push(params.get("source"));
  }
  const [total, bySupplier, byEngineer, byOfficeUser, bySite, bySource, byDay, byMonth, needsReview, byStatus, totalSpend, uncosted] = await db.batch([
    db.prepare(`SELECT COUNT(*) as c FROM po_log ${where}`).bind(...binds),
    db.prepare(`SELECT COALESCE(supplier, '(none)') as supplier, COUNT(*) as count, COALESCE(SUM(cost_ex_vat), 0) as total_ex_vat FROM po_log ${where} GROUP BY supplier ORDER BY count DESC`).bind(...binds),
    db.prepare(`SELECT COALESCE(engineer_name, '(none)') as engineer, COUNT(*) as count, COALESCE(SUM(cost_ex_vat), 0) as total_ex_vat FROM po_log ${where} GROUP BY engineer_name ORDER BY count DESC`).bind(...binds),
    db.prepare(`SELECT COALESCE(office_user_name, '(no office user)') as office_user, COUNT(*) as count, COALESCE(SUM(cost_ex_vat), 0) as total_ex_vat FROM po_log ${where} AND office_user_name IS NOT NULL GROUP BY office_user_name ORDER BY count DESC`).bind(...binds),
    db.prepare(`SELECT COALESCE(site, '(none)') as site, COUNT(*) as count, COALESCE(SUM(cost_ex_vat), 0) as total_ex_vat FROM po_log ${where} GROUP BY site ORDER BY total_ex_vat DESC`).bind(...binds),
    db.prepare(`SELECT source, COUNT(*) as count FROM po_log ${where} GROUP BY source ORDER BY count DESC`).bind(...binds),
    db.prepare(`SELECT substr(issued_at, 1, 10) as day, COUNT(*) as count, COALESCE(SUM(cost_ex_vat), 0) as total_ex_vat FROM po_log ${where} GROUP BY day ORDER BY day DESC LIMIT 60`).bind(...binds),
    db.prepare(`SELECT substr(issued_at, 1, 7) as month, COUNT(*) as count, COALESCE(SUM(cost_ex_vat), 0) as total_ex_vat FROM po_log ${where} GROUP BY month ORDER BY month DESC LIMIT 24`).bind(...binds),
    db.prepare(`SELECT COUNT(*) as c FROM po_log ${where} AND needs_review = 1`).bind(...binds),
    db.prepare(`SELECT COALESCE(status, 'open') as status, COUNT(*) as count, COALESCE(SUM(cost_ex_vat), 0) as total_ex_vat FROM po_log ${where} GROUP BY status`).bind(...binds),
    db.prepare(`SELECT COALESCE(SUM(cost_ex_vat), 0) as total FROM po_log ${where}`).bind(...binds),
    db.prepare(`SELECT COUNT(*) as c FROM po_log ${where} AND cost_ex_vat IS NULL`).bind(...binds)
  ]);
  return {
    total: total.results[0].c,
    needs_review: needsReview.results[0].c,
    total_spend_ex_vat: totalSpend.results[0].total,
    uncosted: uncosted.results[0].c,
    by_supplier: bySupplier.results,
    by_engineer: byEngineer.results,
    by_office_user: byOfficeUser.results,
    by_site: bySite.results,
    by_source: bySource.results,
    by_day: byDay.results,
    by_month: byMonth.results,
    by_status: byStatus.results
  };
}

async function getAccounts(db) {
  const [suppliers, months] = await db.batch([
    db.prepare(`SELECT * FROM suppliers WHERE active = 1 ORDER BY name`),
    db.prepare(`SELECT supplier, substr(issued_at, 1, 7) as ym,
      SUM(CASE WHEN cost_ex_vat IS NOT NULL AND COALESCE(status, 'open') != 'complete' THEN cost_ex_vat * (1 + COALESCE(vat_rate, 20) / 100) ELSE 0 END) as unpaid_inc_vat,
      SUM(CASE WHEN cost_ex_vat IS NULL AND COALESCE(status, 'open') != 'complete' THEN 1 ELSE 0 END) as uncosted_open
      FROM po_log WHERE deleted = 0 AND supplier IS NOT NULL GROUP BY supplier, ym`)
  ]);
  return { suppliers: suppliers.results, months: months.results };
}

async function getSummaryRange(db, from, to) {
  let where = "WHERE deleted = 0";
  const binds = [];
  if (from) {
    where += " AND issued_at >= ?";
    binds.push(from);
  }
  if (to) {
    where += " AND issued_at <= ?";
    binds.push(to + "T23:59:59");
  }
  const rows = (await db.prepare(
    `SELECT po_number, issued_at, engineer_name, office_user_name, source, supplier, site, incident_no, description
     FROM po_log ${where} ORDER BY issued_at DESC`
  ).bind(...binds).all()).results;
  const groups = {};
  const supTotals = {};
  for (const r of rows) {
    const key = r.engineer_name || (r.office_user_name ? "Office \u2014 " + r.office_user_name : "(no engineer)");
    const g = groups[key] || (groups[key] = { name: key, count: 0, sup: {}, pos: [] });
    g.count++;
    const sup = r.supplier || "(none)";
    g.sup[sup] = (g.sup[sup] || 0) + 1;
    supTotals[sup] = (supTotals[sup] || 0) + 1;
    g.pos.push({ po_number: r.po_number, issued_at: r.issued_at, supplier: r.supplier, site: r.site, incident_no: r.incident_no, description: r.description });
  }
  const engineers = Object.values(groups).map((g) => ({
    name: g.name,
    count: g.count,
    suppliers: g.sup,
    by_supplier: Object.entries(g.sup).map(([supplier, count]) => ({ supplier, count })).sort((a, b) => b.count - a.count),
    pos: g.pos
  })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const by_supplier = Object.entries(supTotals).map(([supplier, count]) => ({ supplier, count })).sort((a, b) => b.count - a.count);
  return { from: from || null, to: to || null, total: rows.length, engineers, by_supplier };
}

async function getSummary(db, params) {
  return getSummaryRange(db, params.get("from"), params.get("to"));
}

function fmtDateTimeUK(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString("en-GB", { timeZone: "Europe/London", day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).replace(/\//g, "-").replace(",", "");
}

function fmtDateUK(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString("en-GB", { timeZone: "Europe/London", day: "2-digit", month: "2-digit", year: "2-digit" }).replace(/\//g, "-");
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function randomToken() {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let t = "";
  for (const b of bytes) t += alphabet[b % 62];
  return t;
}