// Holidays — replaces the `mostlane-holidays` Worker (+ holiday-log/summary.json).
//   GET  /holiday?name=username   -> requests for a user (or all)
//   POST /holiday   { name, start, end, type, notes }            (book)
//   POST /holiday/decision { id, status }                        (approve/reject, admin)
//   GET  /holiday/summary?name=username                          (allowance totals)
//
// STATUS: requests CRUD done. The summary endpoint currently computes from the
// holidays table; send me mostlane-holidays if the old allowance maths
// (shutdown days, accrual, bank holidays) needs to match exactly.

import { json, error } from "../lib/http.js";
import { requireSession } from "../lib/auth.js";

export async function handle(request, env, ctx, url) {
  const path = url.pathname;

  if (path === "/holiday" && request.method === "GET") {
    const name = url.searchParams.get("name");
    const stmt = name
      ? env.DB.prepare("SELECT * FROM holidays WHERE name=? ORDER BY start DESC").bind(name)
      : env.DB.prepare("SELECT * FROM holidays ORDER BY start DESC");
    const { results } = await stmt.all();
    return json({ ok: true, holidays: results || [] }, {}, env, request);
  }

  if (path === "/holiday" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!b.name || !b.start || !b.end) return error("name, start, end required", 400, env, request);
    await env.DB.prepare(
      "INSERT INTO holidays (name, start, end, type, status, notes) VALUES (?,?,?,?,?,?)"
    ).bind(b.name, b.start, b.end, b.type || "Annual Leave", "Pending", b.notes || null).run();
    return json({ ok: true }, {}, env, request);
  }

  if (path === "/holiday/decision" && request.method === "POST") {
    const sess = await requireSession(env, request);
    if (!sess) return error("Not authenticated", 401, env, request);
    const b = await request.json().catch(() => ({}));
    if (!b.id || !b.status) return error("id and status required", 400, env, request);
    await env.DB.prepare("UPDATE holidays SET status=? WHERE id=?").bind(b.status, b.id).run();
    return json({ ok: true }, {}, env, request);
  }

  if (path === "/holiday/summary" && request.method === "GET") {
    const name = url.searchParams.get("name");
    if (!name) return error("name required", 400, env, request);
    const allow = await env.DB.prepare("SELECT * FROM holiday_allowance WHERE username=?").bind(name).first();
    const { results } = await env.DB.prepare("SELECT * FROM holidays WHERE name=?").bind(name).all();
    return json({ ok: true, allowance: allow || { available: 28 }, requests: results || [] }, {}, env, request);
  }

  return error("Unknown holiday route", 404, env, request);
}
