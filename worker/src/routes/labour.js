// Labour planning / tracker — replaces the `mostlane-labour-api` Worker
// (+ labour-planning.html / labour-tracker.html data).
//   GET  /labour?engineer=&date=   -> plan rows
//   POST /labour                   { engineer, date, site, jobNumber, hours, ...rest }
//
// STATUS: STUB. Send me mostlane-labour-api — labour planning overlaps with
// hours/timesheets, so I want to confirm whether it should share the
// `timesheets` table or stay separate before finalising.

import { json, error } from "../lib/http.js";

export async function handle(request, env, ctx, url) {
  if (request.method === "GET") {
    const eng = url.searchParams.get("engineer");
    const date = url.searchParams.get("date");
    let sql = "SELECT * FROM labour_plan WHERE 1=1"; const b = [];
    if (eng)  { sql += " AND engineer=?"; b.push(eng); }
    if (date) { sql += " AND date=?";     b.push(date); }
    sql += " ORDER BY date DESC LIMIT 1000";
    const { results } = await env.DB.prepare(sql).bind(...b).all();
    return json({ ok: true, rows: results || [] }, {}, env, request);
  }
  if (request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    await env.DB.prepare(
      "INSERT INTO labour_plan (engineer, date, site, job_number, hours, payload) VALUES (?,?,?,?,?,?)"
    ).bind(b.engineer || null, b.date || null, b.site || null,
           b.jobNumber || null, b.hours ?? null, JSON.stringify(b)).run();
    return json({ ok: true }, {}, env, request);
  }
  return error("Unknown labour route", 405, env, request);
}
