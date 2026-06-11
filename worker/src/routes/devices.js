// Device-lock routes — replaces the `userdevicekv` Worker.
//   POST /device/check-device     { username, deviceId } -> { status }
//   POST /device/register-device  { username, deviceId, label } -> { status }
//   GET  /device/list?u=username  -> devices for a user (admin)
//   DELETE /device/:deviceId      -> unregister (admin)
//
// status values match what device-auth.js already expects:
//   OK | NEW_DEVICE_REQUIRED | DEVICE_MISMATCH

import { json, error } from "../lib/http.js";
import { requireSession } from "../lib/auth.js";

export async function handle(request, env, ctx, url) {
  const path = url.pathname;

  if (path === "/device/check-device" && request.method === "POST") {
    const { username, deviceId } = await request.json().catch(() => ({}));
    if (!username || !deviceId) return error("username and deviceId required", 400, env, request);

    const dev = await env.DB.prepare("SELECT * FROM devices WHERE device_id = ?")
      .bind(deviceId).first();

    if (!dev) {
      // device unknown — is this user already on another device?
      return json({ status: "NEW_DEVICE_REQUIRED" }, {}, env, request);
    }
    if (dev.username !== username) {
      return json({ status: "DEVICE_MISMATCH" }, {}, env, request);
    }
    return json({ status: "OK" }, {}, env, request);
  }

  if (path === "/device/register-device" && request.method === "POST") {
    const { username, deviceId, label } = await request.json().catch(() => ({}));
    if (!username || !deviceId) return error("username and deviceId required", 400, env, request);

    const existing = await env.DB.prepare("SELECT * FROM devices WHERE device_id = ?")
      .bind(deviceId).first();
    if (existing && existing.username !== username)
      return json({ status: "DEVICE_MISMATCH" }, {}, env, request);

    await env.DB.prepare(`
      INSERT INTO devices (device_id, username, label) VALUES (?,?,?)
      ON CONFLICT(device_id) DO UPDATE SET username=excluded.username, label=excluded.label
    `).bind(deviceId, username, label || null).run();
    return json({ status: "OK" }, {}, env, request);
  }

  // Admin: list / remove devices
  if (path === "/device/list" && request.method === "GET") {
    const sess = await requireSession(env, request);
    if (!sess) return error("Not authenticated", 401, env, request);
    const u = url.searchParams.get("u");
    const stmt = u
      ? env.DB.prepare("SELECT * FROM devices WHERE username = ? ORDER BY registered_at DESC").bind(u)
      : env.DB.prepare("SELECT * FROM devices ORDER BY registered_at DESC");
    const { results } = await stmt.all();
    return json({ ok: true, devices: results || [] }, {}, env, request);
  }

  if (path.startsWith("/device/") && request.method === "DELETE") {
    const sess = await requireSession(env, request);
    if (!sess) return error("Not authenticated", 401, env, request);
    const deviceId = path.split("/")[2];
    await env.DB.prepare("DELETE FROM devices WHERE device_id = ?").bind(deviceId).run();
    return json({ ok: true }, {}, env, request);
  }

  return error("Unknown device route", 404, env, request);
}
