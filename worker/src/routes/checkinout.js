// Check in/out — replaces the `ckeck-in-out` Worker (note: original had a typo).
//   POST /check        { username, type:"in"|"out", site, jobNumber, lat, lon }
//   GET  /check?u=username  -> recent events
//
// STATUS: basic event logging implemented against D1. Send me the
// `ckeck-in-out` Worker source so I can match any extra rules (e.g. geofence
// distance checks, duplicate-prevention, travel-time calc).

import { json, error } from "../lib/http.js";
import { requireSession } from "../lib/auth.js";

export async function handle(request, env, ctx, url) {
  if (url.pathname === "/check" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!b.username || !b.type) return error("username and type required", 400, env, request);
    await env.DB.prepare(
      "INSERT INTO check_events (username, type, site, job_number, lat, lon) VALUES (?,?,?,?,?,?)"
    ).bind(b.username, b.type, b.site || null, b.jobNumber || null, b.lat ?? null, b.lon ?? null).run();
    return json({ ok: true }, {}, env, request);
  }

  if (url.pathname === "/check" && request.method === "GET") {
    const u = url.searchParams.get("u");
    const stmt = u
      ? env.DB.prepare("SELECT * FROM check_events WHERE username=? ORDER BY at DESC LIMIT 100").bind(u)
      : env.DB.prepare("SELECT * FROM check_events ORDER BY at DESC LIMIT 100");
    const { results } = await stmt.all();
    return json({ ok: true, events: results || [] }, {}, env, request);
  }

  return error("Unknown check route", 404, env, request);
}
