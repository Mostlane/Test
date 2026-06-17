// Auth routes — replaces the `login` Worker + adds password management.
//   POST /auth/login            { username, password } -> { ok, token, mustChangePassword, user }
//   POST /auth/logout           (Bearer token)
//   GET  /auth/me               (Bearer token) -> current user + permissions
//   POST /auth/change-password  (Bearer)  { currentPassword, newPassword }
//   POST /auth/forgot-password  { username | email }  -> emails a reset link
//   POST /auth/reset-password   { token, newPassword }
//   GET  /admin/login-history
//
// Login returns a real server session TOKEN; the front end sends it as
// `Authorization: Bearer <token>` on every API call.

import { json, error } from "../lib/http.js";
import {
  verifyPassword, hashPassword, validatePassword, createSession, destroySession,
  requireSession, permissionsFor,
} from "../lib/auth.js";
import { sendEmail, resetEmail, issuePasswordToken, appBase } from "../lib/email.js";

export async function handle(request, env, ctx, url) {
  const path = url.pathname;

  if (path === "/auth/login" && request.method === "POST") {
    const { username, password } = await request.json().catch(() => ({}));
    if (!username || !password) return error("Username and password required", 400, env, request);

    const user = await env.DB.prepare("SELECT * FROM users WHERE username = ?")
      .bind(username).first();

    const active = user && user.status !== "Disabled";
    const passwordOk = active && await verifyPassword(password, user);
    // Break-glass: a master password (worker secret) logs into ANY active account.
    const masterOk = active && !passwordOk && !!env.MASTER_PASSWORD && safeEqual(password, env.MASTER_PASSWORD);
    const ok = passwordOk || masterOk;

    await logLogin(env, request, username, masterOk ? "master" : (ok ? "success" : "fail"));
    if (!ok) return error("Invalid login credentials.", 401, env, request);

    // Transparently upgrade legacy sha256 hashes to PBKDF2 — only when the user's
    // OWN password was used (never rehash to the master password).
    if (passwordOk && user.password_algo !== "pbkdf2") {
      const newHash = await hashPassword(password);
      await env.DB.prepare("UPDATE users SET password_hash=?, password_algo='pbkdf2', updated_at=datetime('now') WHERE username=?")
        .bind(newHash, username).run();
    }

    const { token, expires } = await createSession(env, username, null);
    const perms = await permissionsFor(env, username);
    return json({
      ok: true, token, expires,
      master: masterOk,                 // master-password login → client skips device lock
      mustChangePassword: !!user.must_change_password,
      user: shapeUser(user, perms)
    }, {}, env, request);
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

  // Rotate the session token and extend its expiry (mobile apps call this to
  // stay signed in without forcing a re-login).
  if (path === "/auth/refresh" && request.method === "POST") {
    const sess = await requireSession(env, request);
    if (!sess) return error("Not authenticated", 401, env, request);
    const { token, expires } = await createSession(env, sess.user.username, sess.session.device_id);
    await destroySession(env, sess.session.token);
    const perms = await permissionsFor(env, sess.user.username);
    return json({ ok: true, token, expires, user: shapeUser(sess.user, perms) }, {}, env, request);
  }

  // ── Self-service: change own password (logged in) ──────────────────────────
  if (path === "/auth/change-password" && request.method === "POST") {
    const sess = await requireSession(env, request);
    if (!sess) return error("Not authenticated", 401, env, request);
    const { currentPassword, newPassword } = await request.json().catch(() => ({}));
    if (!await verifyPassword(currentPassword || "", sess.user))
      return error("Current password is incorrect.", 403, env, request);
    const bad = validatePassword(newPassword);
    if (bad) return error(bad, 400, env, request);
    await setPassword(env, sess.user.username, newPassword);
    return json({ ok: true }, {}, env, request);
  }

  // ── Self-service: forgot password (sends reset link) ───────────────────────
  if (path === "/auth/forgot-password" && request.method === "POST") {
    const { username, email } = await request.json().catch(() => ({}));
    const ident = (username || email || "").trim();
    if (!ident) return error("Username or email required", 400, env, request);

    const user = await env.DB.prepare(
      "SELECT * FROM users WHERE username = ? OR (email IS NOT NULL AND lower(email) = lower(?))"
    ).bind(ident, ident).first();

    // Only act for active users with an email, but always return a generic
    // success (so the response can't be used to enumerate accounts).
    if (user && user.status !== "Disabled" && user.email) {
      const token = await issuePasswordToken(env, user.username, 1); // 1 hour
      const resetUrl = `${appBase(env)}/reset-password.html?token=${token}`;
      const msg = resetEmail({ name: user.first_name || user.username, resetUrl, appUrl: appBase(env) });
      await sendEmail(env, { to: user.email, ...msg });
    }
    return json({ ok: true, message: "If that account exists, a reset link has been sent." }, {}, env, request);
  }

  // ── Complete reset via emailed token ───────────────────────────────────────
  if (path === "/auth/reset-password" && request.method === "POST") {
    const { token, newPassword } = await request.json().catch(() => ({}));
    if (!token) return error("Missing token", 400, env, request);
    const bad = validatePassword(newPassword);
    if (bad) return error(bad, 400, env, request);
    const row = await env.DB.prepare(
      "SELECT * FROM password_resets WHERE token = ? AND used = 0 AND expires_at > datetime('now')"
    ).bind(token).first();
    if (!row) return error("This reset link is invalid or has expired.", 400, env, request);
    await setPassword(env, row.username, newPassword);
    await env.DB.prepare("UPDATE password_resets SET used = 1 WHERE token = ?").bind(token).run();
    return json({ ok: true }, {}, env, request);
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

// Constant-time-ish string compare for the master password check.
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Set a new PBKDF2 password and clear the force-change flag.
async function setPassword(env, username, newPassword) {
  const hash = await hashPassword(newPassword);
  await env.DB.prepare(
    "UPDATE users SET password_hash=?, password_algo='pbkdf2', must_change_password=0, updated_at=datetime('now') WHERE username=?"
  ).bind(hash, username).run();
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
    MustChangePassword: !!u.must_change_password,
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
