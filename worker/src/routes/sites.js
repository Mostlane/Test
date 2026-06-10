// Sites — replaces the `mostlane-sites` Worker (+ sites.json).
//   GET  /sites  | /get-sites   -> all sites
//   POST /sites                 { jobNumber, siteName, siteType, address, lat, lon, ... }
//
// STATUS: done for basic CRUD. Send me mostlane-sites if it also does
// distance/drive-time lookups (the data has mileage + driveTime) so I can wire
// the same geocoding call.

import { json, error } from "../lib/http.js";

export async function handle(request, env, ctx, url) {
  const path = url.pathname;

  if ((path === "/sites" || path === "/site" || path === "/sites/get-sites" || path === "/get-sites") && request.method === "GET") {
    const { results } = await env.DB.prepare(`
      SELECT job_number AS jobNumber, site_name AS siteName, site_type AS siteType,
             status, address, lat, lon, mileage, drive_time AS driveTime
      FROM sites ORDER BY site_name
    `).all();
    return json(results || [], {}, env, request);
  }

  if ((path === "/sites" || path === "/site") && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!b.jobNumber) return error("jobNumber required", 400, env, request);
    await env.DB.prepare(`
      INSERT INTO sites (job_number, site_name, site_type, status, address, lat, lon, mileage, drive_time)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(job_number) DO UPDATE SET
        site_name=excluded.site_name, site_type=excluded.site_type, status=excluded.status,
        address=excluded.address, lat=excluded.lat, lon=excluded.lon,
        mileage=excluded.mileage, drive_time=excluded.drive_time
    `).bind(
      b.jobNumber, b.siteName || null, b.siteType || null, b.status || "Active",
      b.address || null, b.lat ?? null, b.lon ?? null, b.mileage ?? null, b.driveTime || null
    ).run();
    return json({ ok: true }, {}, env, request);
  }

  return error("Unknown sites route", 404, env, request);
}
