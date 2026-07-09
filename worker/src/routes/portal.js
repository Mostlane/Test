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

const SETTINGS_KEY = "portal:settings";

async function requireFullAccess(env, request) {
  const sess = await requireSession(env, request);
  if (!sess) return { err: error("Not authenticated", 401, env, request) };
  const perms = await permissionsFor(env, sess.user.username);
  if (perms.FullAccess !== "Yes") return { err: error("Forbidden", 403, env, request) };
  return { sess };
}

export async function handle(request, env, ctx, url) {
  const path = url.pathname;
  const method = request.method;

  /* ── Portal settings (app_config blob) ─────────────────────────────── */
  if (path === "/settings" && method === "GET") {
    const gate = await requireFullAccess(env, request);
    if (gate.err) return gate.err;
    const row = await env.DB.prepare("SELECT value FROM app_config WHERE key=?").bind(SETTINGS_KEY).first();
    let settings = {};
    try { settings = row ? JSON.parse(row.value) : {}; } catch {}
    return json({ ok: true, settings }, {}, env, request);
  }
  if (path === "/settings" && method === "POST") {
    const gate = await requireFullAccess(env, request);
    if (gate.err) return gate.err;
    const b = await request.json().catch(() => ({}));
    await env.DB.prepare(`
      INSERT INTO app_config (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).bind(SETTINGS_KEY, JSON.stringify(b || {})).run();
    return json({ ok: true }, {}, env, request);
  }

  /* ── On-call rota ──────────────────────────────────────────────────── */
  if (path === "/oncall/current" && method === "GET") {
    const sess = await requireSession(env, request);
    if (!sess) return error("Not authenticated", 401, env, request);
    const cur = async role => await env.DB.prepare(
      "SELECT name, set_by, set_at FROM oncall_log WHERE role=? ORDER BY id DESC LIMIT 1"
    ).bind(role).first();
    return json({ ok: true, engineer: await cur("engineer"), manager: await cur("manager") }, {}, env, request);
  }
  if (path === "/oncall/set" && method === "POST") {
    const sess = await requireSession(env, request);
    if (!sess) return error("Not authenticated", 401, env, request);
    const b = await request.json().catch(() => ({}));
    const by = sess.user.username;
    const stmts = [];
    if (b.engineer) stmts.push(env.DB.prepare("INSERT INTO oncall_log (role, name, set_by) VALUES ('engineer', ?, ?)").bind(String(b.engineer), by));
    if (b.manager) stmts.push(env.DB.prepare("INSERT INTO oncall_log (role, name, set_by) VALUES ('manager', ?, ?)").bind(String(b.manager), by));
    if (!stmts.length) return error("Nothing to set — send engineer and/or manager", 400, env, request);
    await env.DB.batch(stmts);
    return json({ ok: true }, {}, env, request);
  }
  if (path === "/oncall/history" && method === "GET") {
    const sess = await requireSession(env, request);
    if (!sess) return error("Not authenticated", 401, env, request);
    const { results } = await env.DB.prepare(
      "SELECT role, name, set_by, set_at FROM oncall_log ORDER BY id DESC LIMIT 200"
    ).all();
    return json({ ok: true, history: results || [] }, {}, env, request);
  }

  /* ── Daily logs ────────────────────────────────────────────────────── */
  if (path === "/daily-logs" && method === "POST") {
    const sess = await requireSession(env, request);
    if (!sess) return error("Not authenticated", 401, env, request);
    const b = await request.json().catch(() => ({}));
    if (!b.engineer || !b.date) return error("engineer and date required", 400, env, request);
    await env.DB.prepare(`
      INSERT INTO daily_logs (engineer, date, site, standard_hours, overtime_hours, travel_time, mileage, notes, submitted_by)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).bind(
      b.engineer, b.date, b.site || null,
      num(b.standardHours), num(b.overtimeHours), num(b.travelTime), num(b.mileage),
      b.notes || null, sess.user.username
    ).run();
    return json({ ok: true }, { status: 201 }, env, request);
  }
  if (path === "/daily-logs" && method === "GET") {
    const gate = await requireFullAccess(env, request);
    if (gate.err) return gate.err;
    const q = url.searchParams;
    const conds = [], binds = [];
    if (q.get("engineer")) { conds.push("engineer = ?"); binds.push(q.get("engineer")); }
    if (q.get("from"))     { conds.push("date >= ?");    binds.push(q.get("from")); }
    if (q.get("to"))       { conds.push("date <= ?");    binds.push(q.get("to")); }
    let sql = "SELECT * FROM daily_logs";
    if (conds.length) sql += " WHERE " + conds.join(" AND ");
    sql += " ORDER BY date DESC, id DESC LIMIT 500";
    const { results } = await env.DB.prepare(sql).bind(...binds).all();
    return json({ ok: true, logs: results || [] }, {}, env, request);
  }

  return error("Unknown portal route", 404, env, request);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
