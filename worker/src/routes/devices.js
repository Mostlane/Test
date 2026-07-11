// Device-lock routes — replaces the `userdevicekv` Worker.
//   POST /device/check-device     { username, deviceId } -> { status }
//   POST /device/register-device  { username, deviceId, label } -> { status }
//   GET  /device/list?u=username  -> devices for a user (admin)
//   DELETE /device/:deviceId      -> unregister (admin)
//
// status values match what device-auth.js already expects:
//   OK | NEW_DEVICE_REQUIRED | DEVICE_MISMATCH

import { json, error } from "../lib/http.js";
import { requireSession, permissionsFor } from "../lib/auth.js";

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

    // Enforce the per-user device cap (set from Device Management, stored in the
    // user's profile; default 1, or unlimited). Existing devices always re-register;
    // only a brand-new device beyond the cap is refused.
    if (!existing) {
      const s = await deviceSettings(env, username);
      if (!s.unlimited) {
        const { count } = await env.DB.prepare("SELECT COUNT(*) AS count FROM devices WHERE username=?").bind(username).first();
        if (Number(count) >= s.allowedDevices)
          return json({ status: "DEVICE_LIMIT_REACHED", allowed: s.allowedDevices }, {}, env, request);
      }
    }

    await env.DB.prepare(`
      INSERT INTO devices (device_id, username, label) VALUES (?,?,?)
      ON CONFLICT(device_id) DO UPDATE SET username=excluded.username, label=excluded.label
    `).bind(deviceId, username, label || null).run();
    return json({ status: "OK" }, {}, env, request);
  }

  // Admin: full device roster grouped by user, for Device Management.
  if (path === "/device/admin-list" && request.method === "GET") {
    const gate = await requireDeviceAdmin(env, request);
    if (gate) return gate;
    const { results: devs } = await env.DB.prepare("SELECT * FROM devices ORDER BY registered_at DESC").all();
    const { results: users } = await env.DB.prepare("SELECT username, profile FROM users").all();
    const capOf = {};
    for (const u of users || []) {
      let p = {}; try { p = u.profile ? JSON.parse(u.profile) : {}; } catch {}
      capOf[u.username] = { allowedDevices: Number.isFinite(+p.allowedDevices) ? +p.allowedDevices : 2, unlimited: !!p.deviceUnlimited };
    }
    const byUser = {};
    for (const d of devs || []) {
      (byUser[d.username] || (byUser[d.username] = [])).push({
        deviceId: d.device_id, label: d.label || "",
        firstSeen: d.registered_at, lastSeen: d.registered_at, office_clock: d.office_clock ? 1 : 0
      });
    }
    const records = Object.keys(byUser).map(username => ({
      username, devices: byUser[username], history: [],
      allowedDevices: (capOf[username] || {}).allowedDevices ?? 1,
      unlimited: (capOf[username] || {}).unlimited ?? false
    }));
    return json({ ok: true, records }, {}, env, request);
  }

  // Admin: set a user's device cap (or unlimited). Stored in their profile.
  if (path === "/device/allowed" && request.method === "POST") {
    const gate = await requireDeviceAdmin(env, request);
    if (gate) return gate;
    const { username, allowedDevices, unlimited } = await request.json().catch(() => ({}));
    if (!username) return error("username required", 400, env, request);
    const row = await env.DB.prepare("SELECT profile FROM users WHERE username=?").bind(username).first();
    if (!row) return error("Unknown user", 404, env, request);
    let p = {}; try { p = row.profile ? JSON.parse(row.profile) : {}; } catch {}
    p.deviceUnlimited = !!unlimited;
    let cap = parseInt(allowedDevices, 10); if (!Number.isFinite(cap) || cap < 1) cap = 1; if (cap > 5) cap = 5;
    p.allowedDevices = cap;
    await env.DB.prepare("UPDATE users SET profile=?, updated_at=datetime('now') WHERE username=?")
      .bind(JSON.stringify(p), username).run();
    return json({ ok: true, allowedDevices: cap, unlimited: !!unlimited }, {}, env, request);
  }

  // Admin: force-reset a user's devices (they re-register on next login).
  if (path === "/device/reset" && request.method === "POST") {
    const gate = await requireDeviceAdmin(env, request);
    if (gate) return gate;
    let username = url.searchParams.get("username");
    if (!username) { const b = await request.json().catch(() => ({})); username = b.username; }
    if (!username) return error("username required", 400, env, request);
    await env.DB.prepare("DELETE FROM devices WHERE username=?").bind(username).run();
    return json({ ok: true, username }, {}, env, request);
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

  // Admin: flag/unflag a device as an office-clock machine for its owner.
  if (path === "/device/office-clock" && request.method === "POST") {
    const sess = await requireSession(env, request);
    if (!sess) return error("Not authenticated", 401, env, request);
    const perms = await permissionsFor(env, sess.user.username);
    if (perms.FullAccess !== "Yes" && perms.Users !== "Yes" && perms.DeviceAdmin !== "Yes")
      return error("Forbidden", 403, env, request);
    const { deviceId, office } = await request.json().catch(() => ({}));
    if (!deviceId) return error("deviceId required", 400, env, request);
    await env.DB.prepare("UPDATE devices SET office_clock=? WHERE device_id=?")
      .bind(office ? 1 : 0, deviceId).run();
    return json({ ok: true, deviceId, office: office ? 1 : 0 }, {}, env, request);
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

// Admin gate for Device Management endpoints. Returns an error Response to send
// back, or null when the caller is allowed.
async function requireDeviceAdmin(env, request) {
  const sess = await requireSession(env, request);
  if (!sess) return error("Not authenticated", 401, env, request);
  const perms = await permissionsFor(env, sess.user.username);
  if (perms.FullAccess !== "Yes" && perms.Users !== "Yes" && perms.DeviceAdmin !== "Yes")
    return error("Forbidden", 403, env, request);
  return null;
}

// A user's device cap, from their profile (default 2 devices, not unlimited).
async function deviceSettings(env, username) {
  const row = await env.DB.prepare("SELECT profile FROM users WHERE username=?").bind(username).first();
  let p = {}; try { p = row && row.profile ? JSON.parse(row.profile) : {}; } catch {}
  return {
    allowedDevices: Number.isFinite(+p.allowedDevices) ? +p.allowedDevices : 2,
    unlimited: !!p.deviceUnlimited
  };
}
