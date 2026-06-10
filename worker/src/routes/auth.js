// Auth routes — replaces the `login` Worker.
//   POST /auth/login          { username, password } -> { ok, token, user }
//   POST /auth/logout         (Bearer token)
//   GET  /auth/me             (Bearer token) -> current user + permissions
//   GET  /admin/login-history
//
// Key upgrade vs the old portal: login now returns a real server session
// TOKEN. The front end should send it as `Authorization: Bearer <token>` on
// every API call, and the protected routes verify it server-side.

import { json, error } from "../lib/http.js";
import {
  verifyPassword, hashPassword, createSession, destroySession,
  requireSession, permissionsFor,
} from "../lib/auth.js";

export async function handle(request, env, ctx, url) {
  const path = url.pathname;

  if (path === "/auth/login" && request.method === "POST") {
    const { username, password } = await request.json().catch(() => ({}));
    if (!username || !password) return error("Username and password required", 400, env, request);

    const user = await env.DB.prepare("SELECT * FROM users WHERE username = ?")
      .bind(username).first();

    const ok = user && user.status !== "Disabled" && await verifyPassword(password, user);
    await logLogin(env, request, username, ok ? "success" : "fail");
    if (!ok) return error("Invalid login credentials.", 401, env, request);

    // Transparently upgrade legacy sha256 hashes to PBKDF2 on successful login.
    if (user.password_algo !== "pbkdf2") {
      const newHash = await hashPassword(password);
      await env.DB.prepare("UPDATE users SET password_hash=?, password_algo='pbkdf2', updated_at=datetime('now') WHERE username=?")
        .bind(newHash, username).run();
    }

    const { token, expires } = await createSession(env, username, null);
    const perms = await permissionsFor(env, username);
    return json({ ok: true, token, expires, user: shapeUser(user, perms) }, {}, env, request);
  }

  if (path === "/auth/logout" && request.method === "POST") {
    const auth = request.headers.get("Authorization") || "";
    if (auth.startsWith("Bearer ")) await destroySession(env, auth.slice(7));
    return json({ ok: true }, {}, env, request);
  }

  if (path === "/auth/me") {
    const sess = await requireSession(env, request);
    if (!sess) return error("Not authenticated", 401, env, request);
    const perms = await permissionsFor(env, sess.user.username);
    return json({ ok: true, user: shapeUser(sess.user, perms) }, {}, env, request);
  }

  return error("Unknown auth route", 404, env, request);
}

export async function loginHistory(request, env, ctx, url) {
  const sess = await requireSession(env, request);
  if (!sess) return error("Not authenticated", 401, env, request);
  const { results } = await env.DB.prepare(
    "SELECT username, device_id, ip, outcome, at FROM login_history ORDER BY at DESC LIMIT 200"
  ).all();
  return json({ ok: true, history: results || [] }, {}, env, request);
}

// Return the camel/Pascal shape the existing front-end reads (user.Username etc.)
function shapeUser(u, perms) {
  return {
    EngineerNumber: u.engineer_number,
    FirstName: u.first_name,
    LastName: u.last_name,
    Username: u.username,
    Email: u.email,
    VehicleAssigned: u.vehicle_assigned,
    EmploymentType: u.employment_type,
    Status: u.status,
    SharePointPath: u.sharepoint_path,
    ...perms,
  };
}

async function logLogin(env, request, username, outcome) {
  try {
    await env.DB.prepare(
      "INSERT INTO login_history (username, ip, user_agent, outcome) VALUES (?,?,?,?)"
    ).bind(
      username,
      request.headers.get("CF-Connecting-IP") || "",
      request.headers.get("User-Agent") || "",
      outcome
    ).run();
  } catch { /* non-fatal */ }
}
