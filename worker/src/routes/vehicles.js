// Vehicles — replaces the `vehicles` + `vehicles-fuel` Workers
// (+ vans.json, van-scores.json, van-users.json, van-trends.json).
//   GET  /vehicles            -> reg + driver list
//   GET  /van/scores          -> latest driver scorecards
//   POST /vehicles            { reg, driver }            (assign)
//
// STATUS: reads + basic assign done. Send me vehicles-fuel for the fuel/mpg
// and scoring logic (mileage, trips, trend) so scores are computed not stored.

import { json, error } from "../lib/http.js";

export async function handle(request, env, ctx, url) {
  const path = url.pathname;

  if ((path === "/vehicles" || path === "/vehicle") && request.method === "GET") {
    const { results } = await env.DB.prepare("SELECT reg, driver FROM vehicles ORDER BY reg").all();
    return json({ ok: true, vehicles: results || [] }, {}, env, request);
  }

  if (path === "/van/scores" && request.method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT * FROM van_scores ORDER BY score DESC"
    ).all();
    return json({ ok: true, scores: results || [] }, {}, env, request);
  }

  if ((path === "/vehicles" || path === "/vehicle") && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!b.reg) return error("reg required", 400, env, request);
    await env.DB.prepare(`
      INSERT INTO vehicles (reg, driver) VALUES (?,?)
      ON CONFLICT(reg) DO UPDATE SET driver=excluded.driver
    `).bind(b.reg, b.driver || null).run();
    return json({ ok: true }, {}, env, request);
  }

  return error("Unknown vehicle route", 404, env, request);
}
