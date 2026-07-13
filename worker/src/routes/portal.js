// Small portal features on D1 — replaces the last Zapier/KV/static-JSON bits.
//   GET  /settings         -> { ok, settings }        (FullAccess)
//   POST /settings         -> save settings blob       (FullAccess)
//   GET  /oncall/current   -> { engineer, manager }    (any session)
//   POST /oncall/set       -> { engineer?, manager? }  (any session, stamped)
//   GET  /oncall/history   -> { history: [...] }       (any session)
//   POST /daily-logs       -> save a daily log         (any session, stamped)
//   GET  /daily-logs       -> { logs: [...] } filters: from,to,engineer (admin)

import { json, error } from "../lib/http.js";
import { requireSession, permissionsFor } from "../lib/auth.js";
import { tenantDB, resolveTenantId } from "../lib/tenantdb.js";

const SETTINGS_KEY = "portal:settings";

async function requireFullAccess(env, request) {
  const sess = await requireSession(env, request);
  if (!sess) return { err: error("Not authenticated", 401, env, request) };
  const perms = await permissionsFor(env, sess.tenantId, sess.user.username);
  if (perms.FullAccess !== "Yes") return { err: error("Forbidden", 403, env, request) };
  return { sess };
}

export async function handle(request, env, ctx, url, sess) {
  const path = url.pathname;
  const method = request.method;
  const tenantId = sess ? sess.tenantId : await resolveTenantId(env, request);
  const db = tenantDB(env, tenantId);

  /* ── Portal settings (app_config blob) ─────────────────────────────── */
  if (path === "/settings" && method === "GET") {
    const gate = await requireFullAccess(env, request);
    if (gate.err) return gate.err;
    const row = await db.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(db.tenantId, SETTINGS_KEY).first();
    let settings = {};
    try { settings = row ? JSON.parse(row.value) : {}; } catch {}
    return json({ ok: true, settings }, {}, env, request);
  }
  if (path === "/settings" && method === "POST") {
    const gate = await requireFullAccess(env, request);
    if (gate.err) return gate.err;
    const b = await request.json().catch(() => ({}));
    await db.prepare(`
      INSERT INTO app_config (tenant_id, key, value) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).bind(db.tenantId, SETTINGS_KEY, JSON.stringify(b || {})).run();
    return json({ ok: true }, {}, env, request);
  }

  /* ── Menu visibility for Full Access (one shared list) ─────────────────
     Full-access users otherwise see every tile; this lets an admin hide the
     irrelevant ones for ALL full-access users at once. GET is open to any
     session (each page filters its own menu); only Full Access can change it. */
  if (path === "/menu-config" && method === "GET") {
    const s = await requireSession(env, request);
    if (!s) return error("Not authenticated", 401, env, request);
    const row = await db.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(db.tenantId, "menu:hidden").first();
    let hidden = [];
    try { hidden = row ? JSON.parse(row.value) : []; } catch {}
    if (!Array.isArray(hidden)) hidden = [];
    return json({ ok: true, hidden }, {}, env, request);
  }
  if (path === "/menu-config" && method === "POST") {
    const gate = await requireFullAccess(env, request);
    if (gate.err) return gate.err;
    const b = await request.json().catch(() => ({}));
    const hidden = Array.isArray(b.hidden) ? b.hidden.map(String).slice(0, 200) : [];
    await db.prepare(
      "INSERT INTO app_config (tenant_id, key, value) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    ).bind(db.tenantId, "menu:hidden", JSON.stringify(hidden)).run();
    return json({ ok: true, hidden }, {}, env, request);
  }

  /* ── On-call rota ──────────────────────────────────────────────────── */
  if (path === "/oncall/current" && method === "GET") {
    const sess = await requireSession(env, request);
    if (!sess) return error("Not authenticated", 401, env, request);
    const cur = async role => await db.prepare(
      "SELECT name, set_by, set_at FROM oncall_log WHERE tenant_id=? AND role=? ORDER BY id DESC LIMIT 1"
    ).bind(db.tenantId, role).first();
    return json({ ok: true, engineer: await cur("engineer"), manager: await cur("manager") }, {}, env, request);
  }
  if (path === "/oncall/set" && method === "POST") {
    const sess = await requireSession(env, request);
    if (!sess) return error("Not authenticated", 401, env, request);
    const b = await request.json().catch(() => ({}));
    const by = sess.user.username;
    const stmts = [];
    if (b.engineer) stmts.push(db.prepare("INSERT INTO oncall_log (tenant_id, role, name, set_by) VALUES (?, 'engineer', ?, ?)").bind(db.tenantId, String(b.engineer), by));
    if (b.manager) stmts.push(db.prepare("INSERT INTO oncall_log (tenant_id, role, name, set_by) VALUES (?, 'manager', ?, ?)").bind(db.tenantId, String(b.manager), by));
    if (!stmts.length) return error("Nothing to set — send engineer and/or manager", 400, env, request);
    await db.batch(stmts);
    return json({ ok: true }, {}, env, request);
  }
  if (path === "/oncall/history" && method === "GET") {
    const sess = await requireSession(env, request);
    if (!sess) return error("Not authenticated", 401, env, request);
    const { results } = await db.prepare(
      "SELECT role, name, set_by, set_at FROM oncall_log WHERE tenant_id=? ORDER BY id DESC LIMIT 200"
    ).bind(db.tenantId).all();
    return json({ ok: true, history: results || [] }, {}, env, request);
  }

  /* ── Daily logs ────────────────────────────────────────────────────── */
  if (path === "/daily-logs" && method === "POST") {
    const sess = await requireSession(env, request);
    if (!sess) return error("Not authenticated", 401, env, request);
    const b = await request.json().catch(() => ({}));
    if (!b.engineer || !b.date) return error("engineer and date required", 400, env, request);
    await db.prepare(`
      INSERT INTO daily_logs (tenant_id, engineer, date, site, standard_hours, overtime_hours, travel_time, mileage, notes, submitted_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).bind(
      db.tenantId, b.engineer, b.date, b.site || null,
      num(b.standardHours), num(b.overtimeHours), num(b.travelTime), num(b.mileage),
      b.notes || null, sess.user.username
    ).run();
    return json({ ok: true }, { status: 201 }, env, request);
  }
  if (path === "/daily-logs" && method === "GET") {
    const gate = await requireFullAccess(env, request);
    if (gate.err) return gate.err;
    const q = url.searchParams;
    const conds = ["tenant_id = ?"], binds = [db.tenantId];
    if (q.get("engineer")) { conds.push("engineer = ?"); binds.push(q.get("engineer")); }
    if (q.get("from"))     { conds.push("date >= ?");    binds.push(q.get("from")); }
    if (q.get("to"))       { conds.push("date <= ?");    binds.push(q.get("to")); }
    let sql = "SELECT * FROM daily_logs";
    sql += " WHERE " + conds.join(" AND ");
    sql += " ORDER BY date DESC, id DESC LIMIT 500";
    const { results } = await db.prepare(sql).bind(...binds).all();
    return json({ ok: true, logs: results || [] }, {}, env, request);
  }

  /* ── Per-user cross-device preferences/markers ─────────────────────── */
  // Small JSON blob in users.profile.prefs — e.g. holSeen / holAdminSeen
  // ("I've seen these notifications", so alerts don't reappear on another
  // device) and notifySnooze (remind-me-later state). POST shallow-merges;
  // send null for a key to delete it.
  if (path === "/prefs" && method === "GET") {
    const sess = await requireSession(env, request);
    if (!sess) return error("Not authenticated", 401, env, request);
    const row = await db.prepare("SELECT profile FROM users WHERE tenant_id=? AND username=?").bind(db.tenantId, sess.user.username).first();
    let profile = {}; try { profile = row?.profile ? JSON.parse(row.profile) : {}; } catch {}
    return json({ ok: true, prefs: profile.prefs || {} }, {}, env, request);
  }
  if (path === "/prefs" && method === "POST") {
    const sess = await requireSession(env, request);
    if (!sess) return error("Not authenticated", 401, env, request);
    const b = await request.json().catch(() => null);
    if (!b || typeof b !== "object" || Array.isArray(b)) return error("Send an object of keys to merge", 400, env, request);
    const row = await db.prepare("SELECT profile FROM users WHERE tenant_id=? AND username=?").bind(db.tenantId, sess.user.username).first();
    let profile = {}; try { profile = row?.profile ? JSON.parse(row.profile) : {}; } catch {}
    const prefs = profile.prefs || {};
    for (const k of Object.keys(b)) {
      if (b[k] === null) delete prefs[k];
      else prefs[k] = b[k];
    }
    if (JSON.stringify(prefs).length > 8000) return error("Preferences too large", 400, env, request);
    profile.prefs = prefs;
    await db.prepare("UPDATE users SET profile=?, updated_at=datetime('now') WHERE tenant_id=? AND username=?")
      .bind(JSON.stringify(profile), db.tenantId, sess.user.username).run();
    return json({ ok: true, prefs }, {}, env, request);
  }

  /* ── Activity log ──────────────────────────────────────────────────── */
  // Actions are written automatically by the middleware in index.js; this
  // adds page views (posted by portal-config on every page open) and the
  // admin read endpoint for the viewer page.
  if (path === "/audit/pageview" && method === "POST") {
    const sess = await requireSession(env, request);
    if (!sess) return error("Not authenticated", 401, env, request);
    const b = await request.json().catch(() => ({}));
    const page = String(b.page || "").slice(0, 80);
    if (!/^[\w.-]+\.html$/.test(page)) return error("Bad page", 400, env, request);
    await db.prepare(
      "INSERT INTO audit_log (tenant_id, username, method, path, detail, status, at) VALUES (?,?,?,?,?,?,?)"
    ).bind(db.tenantId, sess.user.username, "VIEW", "/" + page, "", 200, new Date().toISOString()).run();
    return json({ ok: true }, {}, env, request);
  }
  if (path === "/audit/log" && method === "GET") {
    const gate = await requireFullAccess(env, request);
    if (gate.err) return gate.err;
    const q = url.searchParams;
    const days = Math.min(365, Math.max(1, Number(q.get("days")) || 7));
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const conds = ["tenant_id = ?", "at >= ?"], binds = [db.tenantId, since];
    if (q.get("user")) { conds.push("username = ?"); binds.push(q.get("user")); }
    if (q.get("type") === "view") conds.push("method = 'VIEW'");
    if (q.get("type") === "action") conds.push("method != 'VIEW'");
    const { results } = await db.prepare(
      "SELECT username, method, path, detail, status, at FROM audit_log WHERE " + conds.join(" AND ") +
      " ORDER BY id DESC LIMIT 1000"
    ).bind(...binds).all();
    return json({ ok: true, log: results || [] }, {}, env, request);
  }

  /* ── Notification audit log ────────────────────────────────────────── */
  // Every time the attention gate / desktop panel shows (or is snoozed,
  // dismissed, or an item is opened) the page reports it here, so there is
  // proof of who was shown what and when.
  if (path === "/notify/log" && method === "POST") {
    const sess = await requireSession(env, request);
    if (!sess) return error("Not authenticated", 401, env, request);
    const b = await request.json().catch(() => ({}));
    const action = String(b.action || "");
    if (["shown", "snoozed", "dismissed", "opened"].indexOf(action) === -1)
      return error("Bad action", 400, env, request);
    const surface = String(b.surface || "").slice(0, 20);
    const items = JSON.stringify(Array.isArray(b.items) ? b.items : []).slice(0, 4000);
    await db.prepare(
      "INSERT INTO notify_log (tenant_id, username, action, surface, items, at) VALUES (?,?,?,?,?,?)"
    ).bind(db.tenantId, sess.user.username, action, surface, items, new Date().toISOString()).run();
    return json({ ok: true }, {}, env, request);
  }
  if (path === "/notify/log" && method === "GET") {
    const gate = await requireFullAccess(env, request);
    if (gate.err) return gate.err;
    const q = url.searchParams;
    const days = Math.min(90, Math.max(1, Number(q.get("days")) || 14));
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const conds = ["tenant_id = ?", "at >= ?"], binds = [db.tenantId, since];
    if (q.get("user")) { conds.push("username = ?"); binds.push(q.get("user")); }
    const { results } = await db.prepare(
      "SELECT username, action, surface, items, at FROM notify_log WHERE " + conds.join(" AND ") +
      " ORDER BY id DESC LIMIT 1000"
    ).bind(...binds).all();
    return json({ ok: true, log: results || [] }, {}, env, request);
  }

  return error("Unknown portal route", 404, env, request);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
