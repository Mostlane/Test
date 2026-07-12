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
//
// MULTI-TENANT: login/forgot/reset are PUBLIC (no session yet), so the tenant
// is derived from the matched user's row (login/forgot) or the reset-token row.
// Authenticated routes take the tenant from the verified session (`sess`).

import { json, error } from "../lib/http.js";
import {
  verifyPassword, hashPassword, validatePassword, createSession, destroySession,
  requireSession, permissionsFor,
} from "../lib/auth.js";
import { tenantDB } from "../lib/tenantdb.js";
import { sendEmail, resetEmail, issuePasswordToken, appBase } from "../lib/email.js";

export async function handle(request, env, ctx, url, sess) {
  const path = url.pathname;

  if (path === "/auth/login" && request.method === "POST") {
    const { username, password } = await request.json().catch(() => ({}));
    if (!username || !password) return error("Username and password required", 400, env, request);

    // Forgiving username match: exact, case-insensitive, the LEGACY dotted
    // form ("Jamie.Line" — phones still autofill it from saved passwords
    // created before the rename), or the account's email address. Everything
    // after this uses the canonical user.username from the matched row — and
    // the tenant_id from that same row.
    const user = await findUser(env, username);

    const active = user && user.status !== "Disabled";
    const passwordOk = active && await verifyPassword(password, user);
    // Break-glass: a master password (worker secret) logs into ANY active account.
    const masterOk = active && !passwordOk && !!env.MASTER_PASSWORD && safeEqual(password, env.MASTER_PASSWORD);
    const ok = passwordOk || masterOk;

    const tenantId = user ? user.tenant_id : 1;
    await logLogin(env, tenantId, request, user ? user.username : username, masterOk ? "master" : (ok ? "success" : "fail"));
    if (!ok) return error("Invalid login credentials.", 401, env, request);

    // Transparently upgrade legacy sha256 hashes to PBKDF2 — only when the user's
    // OWN password was used (never rehash to the master password).
    if (passwordOk && user.password_algo !== "pbkdf2") {
      const newHash = await hashPassword(password);
      await env.DB.prepare("UPDATE users SET password_hash=?, password_algo='pbkdf2', updated_at=datetime('now') WHERE tenant_id=? AND username=?")
        .bind(newHash, user.tenant_id, user.username).run();
    }

    const { token, expires } = await createSession(env, user.username, null, user.tenant_id);
    const perms = await permissionsFor(env, user.tenant_id, user.username);
    return json({
      ok: true, token, expires,
      master: masterOk,                 // master-password login → client skips device lock
      mustChangePassword: !!user.must_change_password,
      user: shapeUser(user, perms)
    }, {}, env, request);
  }

  // ── View As: the portal owner can open a real session as any user ─────────
  // Locked server-side to the owner account (env.OWNER_USERNAME, default
  // "Jamie Line") — permissions alone are NOT enough. Every use is written to
  // login_history (outcome 'viewas') as an audit trail. The owner can only
  // impersonate users WITHIN THEIR OWN TENANT.
  if (path === "/auth/impersonate" && request.method === "POST") {
    if (!sess) return error("Not authenticated", 401, env, request);
    const OWNER = env.OWNER_USERNAME || "Jamie Line";
    if (sess.user.username !== OWNER) return error("Not allowed", 403, env, request);
    const { username } = await request.json().catch(() => ({}));
    if (!username) return error("username required", 400, env, request);
    if (username === OWNER) return error("You are already yourself", 400, env, request);
    const db = tenantDB(env, sess.tenantId);
    const user = await db.prepare("SELECT * FROM users WHERE tenant_id = ? AND username = ?")
      .bind(db.tenantId, username).first();
    if (!user) return error("Unknown user", 404, env, request);
    await logLogin(env, sess.tenantId, request, username, "viewas");
    const { token, expires } = await createSession(env, username, null, sess.tenantId);
    const perms = await permissionsFor(env, sess.tenantId, username);
    return json({ ok: true, token, expires, user: shapeUser(user, perms) }, {}, env, request);
  }

  if (path === "/auth/logout" && request.method === "POST") {
    const auth = request.headers.get("Authorization") || "";
    if (auth.startsWith("Bearer ")) await destroySession(env, auth.slice(7));
    return json({ ok: true }, {}, env, request);
  }

  if (path === "/auth/me") {
    if (!sess) return error("Not authenticated", 401, env, request);
    const perms = await permissionsFor(env, sess.tenantId, sess.user.username);
    return json({ ok: true, user: shapeUser(sess.user, perms) }, {}, env, request);
  }

  // Rotate the session token and extend its expiry (mobile apps call this to
  // stay signed in without forcing a re-login).
  if (path === "/auth/refresh" && request.method === "POST") {
    if (!sess) return error("Not authenticated", 401, env, request);
    const { token, expires } = await createSession(env, sess.user.username, sess.session.device_id, sess.tenantId);
    await destroySession(env, sess.session.token);
    const perms = await permissionsFor(env, sess.tenantId, sess.user.username);
    return json({ ok: true, token, expires, user: shapeUser(sess.user, perms) }, {}, env, request);
  }

  // ── Self-service: change own password (logged in) ──────────────────────────
  if (path === "/auth/change-password" && request.method === "POST") {
    if (!sess) return error("Not authenticated", 401, env, request);
    const { currentPassword, newPassword } = await request.json().catch(() => ({}));
    if (!await verifyPassword(currentPassword || "", sess.user))
      return error("Current password is incorrect.", 403, env, request);
    const bad = validatePassword(newPassword);
    if (bad) return error(bad, 400, env, request);
    await setPassword(env, sess.tenantId, sess.user.username, newPassword);
    return json({ ok: true }, {}, env, request);
  }

  // ── Self-service: forgot password (sends reset link) ───────────────────────
  if (path === "/auth/forgot-password" && request.method === "POST") {
    const { username, email } = await request.json().catch(() => ({}));
    const ident = (username || email || "").trim();
    if (!ident) return error("Username or email required", 400, env, request);

    const user = await findUser(env, ident);

    // Only act for active users with an email, but always return a generic
    // success (so the response can't be used to enumerate accounts).
    if (user && user.status !== "Disabled" && user.email) {
      const token = await issuePasswordToken(env, user.tenant_id, user.username, 1); // 1 hour
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
    // The token is a global single-use secret (password_resets PK); the tenant
    // comes from the matched row.
    const row = await env.DB.prepare(
      "SELECT * FROM password_resets WHERE token = ? AND used = 0 AND expires_at > datetime('now')"
    ).bind(token).first();
    if (!row) return error("This reset link is invalid or has expired.", 400, env, request);
    await setPassword(env, row.tenant_id, row.username, newPassword);
    await env.DB.prepare("UPDATE password_resets SET used = 1 WHERE token = ?").bind(token).run();
    return json({ ok: true }, {}, env, request);
  }

  return error("Unknown auth route", 404, env, request);
}

export async function loginHistory(request, env, ctx, url, sess) {
  if (!sess) sess = await requireSession(env, request);
  if (!sess) return error("Not authenticated", 401, env, request);
  const db = tenantDB(env, sess.tenantId);
  const username = url.searchParams.get("username");
  const cols = "SELECT username, device_id, ip, user_agent, outcome, at FROM login_history WHERE tenant_id = ?";
  const stmt = username
    ? db.prepare(cols + " AND username = ? ORDER BY at DESC LIMIT 200").bind(db.tenantId, username)
    : db.prepare(cols + " ORDER BY at DESC LIMIT 200").bind(db.tenantId);
  const { results } = await stmt.all();
  // SQLite datetime('now') stamps are UTC with no timezone marker — mark them
  // so browsers don't misread them as local time (an hour off in UK summer).
  const history = (results || []).map(r => ({
    ...r,
    at: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(String(r.at || "")) ? r.at.replace(" ", "T") + "Z" : r.at,
  }));
  return json({ ok: true, history }, {}, env, request);
}

// Locate a user by whatever they typed: exact username, any capitalisation,
// the legacy dotted form ("Jamie.Line" for "Jamie Line"), or their email.
// This is the ONE place that looks across tenants — login has no tenant yet,
// and usernames are globally unique in Phase 1, so the matched row's tenant_id
// becomes the session's tenant.
async function findUser(env, ident) {
  const v = String(ident || "").trim();
  if (!v) return null;
  return env.DB.prepare(`
    SELECT * FROM users
    WHERE lower(username) = lower(?1)
       OR lower(replace(username, ' ', '.')) = lower(?1)
       OR (email IS NOT NULL AND lower(email) = lower(?1))
    LIMIT 1
  `).bind(v).first();
}

// Constant-time-ish string compare for the master password check.
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Set a new PBKDF2 password and clear the force-change flag (tenant-scoped).
async function setPassword(env, tenantId, username, newPassword) {
  const hash = await hashPassword(newPassword);
  const db = tenantDB(env, tenantId);
  await db.prepare(
    "UPDATE users SET password_hash=?, password_algo='pbkdf2', must_change_password=0, updated_at=datetime('now') WHERE tenant_id=? AND username=?"
  ).bind(hash, tenantId, username).run();
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

async function logLogin(env, tenantId, request, username, outcome) {
  try {
    await env.DB.prepare(
      "INSERT INTO login_history (username, tenant_id, ip, user_agent, outcome) VALUES (?,?,?,?,?)"
    ).bind(
      username,
      tenantId,
      request.headers.get("CF-Connecting-IP") || "",
      request.headers.get("User-Agent") || "",
      outcome
    ).run();
  } catch { /* non-fatal */ }
}
