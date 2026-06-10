// Hours & timesheets — CONSOLIDATES FIVE Workers into one table (`timesheets`):
//   odd-water-f78a (/Hours), average-hours, labourhours, timesheet,
//   mostlane-labour-api(hours parts).
//
//   GET  /hours?engineer=&from=&to=   -> rows
//   POST /hours        { engineer, date, start, finish, lunchDeducted, travelTime, jobType, jobNumber }
//   GET  /timesheet?engineer=         -> same data, timesheet shape
//
// STATUS: storage + basic read/write done. The old workers each computed
// totals/averages differently — send me odd-water + average-hours + labourhours
// and I'll fold their calculations into one consistent endpoint.

import { json, error } from "../lib/http.js";

export async function handle(request, env, ctx, url) {
  if (request.method === "GET") {
    const eng = url.searchParams.get("engineer");
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    let sql = "SELECT * FROM timesheets WHERE 1=1";
    const binds = [];
    if (eng)  { sql += " AND engineer = ?"; binds.push(eng); }
    if (from) { sql += " AND date >= ?";    binds.push(from); }
    if (to)   { sql += " AND date <= ?";    binds.push(to); }
    sql += " ORDER BY date DESC LIMIT 1000";
    const { results } = await env.DB.prepare(sql).bind(...binds).all();
    return json({ ok: true, rows: results || [] }, {}, env, request);
  }

  if (request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!b.engineer || !b.date) return error("engineer and date required", 400, env, request);
    await env.DB.prepare(`
      INSERT INTO timesheets (engineer, date, start, finish, lunch_deducted, travel_time, job_type, job_number, source)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).bind(
      b.engineer, b.date, b.start || null, b.finish || null,
      b.lunchDeducted ? 1 : 0, b.travelTime ?? null,
      b.jobType || null, b.jobNumber || null, b.source || "portal"
    ).run();
    return json({ ok: true }, {}, env, request);
  }

  return error("Unknown hours route", 405, env, request);
}
