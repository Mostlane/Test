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
  requireSession, permissionsFor, revokeUserSessions,
} from "../lib/auth.js";
import { tenantDB } from "../lib/tenantdb.js";
import { resolveComplianceAccess } from "../lib/complianceaccess.js";
import { sendEmail, resetEmail, issuePasswordToken, appBase } from "../lib/email.js";
import { sendToPermission } from "./push.js";
import { onceMigration } from "../lib/once.js";

// ── Two-step login (22 Oct 2026) ─────────────────────────────────────────────
// After a correct password, a 6-digit code is emailed when EITHER the account
// is Full Access (every login) OR this device isn't one already registered to
// the user. Everyday re-logins on your own phone need only the password.
// The break-glass MASTER_PASSWORD skips it (audited "master"). View As never
// logs in, so it's untouched. Switch off with app_config auth:twofactor:<tid>
// = {"enabled":false}.
const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_MAX_TRIES = 5;
async function sha256Hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function randomHex(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return [...a].map(b => b.toString(16).padStart(2, "0")).join(""); }
function randomCode() { const a = new Uint32Array(1); crypto.getRandomValues(a); return String(a[0] % 1000000).padStart(6, "0"); }
function maskEmail(e) {
  const [u, d] = String(e || "").split("@");
  if (!d) return "";
  return (u.length <= 2 ? u[0] + "*" : u.slice(0, 2) + "*".repeat(Math.min(6, u.length - 2))) + "@" + d;
}
async function ensureLoginCodes__raw(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS login_codes (
    id TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL DEFAULT 1, username TEXT NOT NULL,
    code_hash TEXT NOT NULL, device_id TEXT, expires_at INTEGER NOT NULL,
    tries INTEGER NOT NULL DEFAULT 0, created_at TEXT)`).run();
}
const ensureLoginCodes = onceMigration(ensureLoginCodes__raw);
async function twoFactorEnabled(env, tid) {
  try {
    const r = await env.DB.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?")
      .bind(tid, "auth:twofactor:" + tid).first();
    if (r && r.value) { const v = JSON.parse(r.value); if (v && v.enabled === false) return false; }
  } catch {}
  return true;
}
async function needsLoginCode(env, user, perms, deviceId) {
  if (!(await twoFactorEnabled(env, user.tenant_id))) return false;
  if (perms && perms.FullAccess === "Yes") return true;
  if (!deviceId) return true;
  const known = await env.DB.prepare("SELECT 1 AS k FROM devices WHERE tenant_id=? AND device_id=? AND username=?")
    .bind(user.tenant_id, deviceId, user.username).first().catch(() => null);
  return !known;
}
async function sendLoginCode(env, user, code) {
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0f2438">
    <h2 style="color:#003366;margin:0 0 12px">Your Mostlane sign-in code</h2>
    <p>Enter this code to finish signing in to the portal:</p>
    <p style="font-size:34px;letter-spacing:8px;font-weight:700;color:#003366;margin:18px 0">${code}</p>
    <p>It expires in 10 minutes.</p>
    <p style="color:#6b7a8c;font-size:13px">If you didn't just try to sign in, someone may know your password — change it and tell the office.</p></div>`;
  const subject = "Your Mostlane sign-in code: " + code;
  try {
    const { sendSubconMail } = await import("./sla.js");   // Microsoft 365 first, Resend fallback
    const r = await sendSubconMail(env, user.tenant_id, { to: user.email, subject, html });
    if (r && r.ok) return r;
  } catch {}
  return sendEmail(env, { to: user.email, subject, html });
}

export async function handle(request, env, ctx, url, sess) {
  const path = url.pathname;

  if (path === "/auth/login" && request.method === "POST") {
    const { username, password, deviceId: rawDeviceId } = await request.json().catch(() => ({}));
    if (!username || !password) return error("Username and password required", 400, env, request);
    // The browser's own device id (device-auth.js) — the new session is BOUND to
    // it (see requireSession), so the token only works from this device.
    const deviceId = typeof rawDeviceId === "string" && /^[\w.-]{4,80}$/.test(rawDeviceId) ? rawDeviceId : null;

    // Brute-force throttle: stop an IP that has piled up failed attempts in the
    // last 15 minutes. Keyed on IP, not the account, so nobody can lock a real
    // user out by hammering their username from elsewhere. Only 'fail' rows
    // count, so a genuine user who mistypes once or twice is never affected —
    // and this also caps master-password guessing.
    const loginIp = request.headers.get("CF-Connecting-IP") || "";
    if (loginIp && await tooManyRecentFails(env, loginIp)) {
      return error("Too many failed attempts. Please wait a few minutes and try again.", 429, env, request);
    }

    // Forgiving username match: exact, case-insensitive, the LEGACY dotted
    // form ("Jamie.Line" — phones still autofill it from saved passwords
    // created before the rename), or the account's email address. Everything
    // after this uses the canonical user.username from the matched row — and
    // the tenant_id from that same row.
    const user = await findUser(env, username);

    // Only a live account may log in: blank/"Active" status. A self-registered
    // "Pending" starter (or any other status) must be activated by an admin first.
    const active = user && isActiveStatus(user.status);
    const passwordOk = active && await verifyPassword(password, user);
    // Break-glass: a master password (worker secret) logs into ANY active account.
    const masterOk = active && !passwordOk && !!env.MASTER_PASSWORD && safeEqual(password, env.MASTER_PASSWORD);
    const ok = passwordOk || masterOk;

    const tenantId = user ? user.tenant_id : 1;
    // "success" is logged once the session is actually issued (finishLogin) —
    // a correct password still waiting on its emailed code isn't a sign-in yet.
    if (!ok || masterOk) await logLogin(env, tenantId, request, user ? user.username : username, masterOk ? "master" : "fail");
    if (!ok) return error("Invalid login credentials.", 401, env, request);

    // Transparently upgrade legacy sha256 hashes to PBKDF2 — only when the user's
    // OWN password was used (never rehash to the master password).
    if (passwordOk && user.password_algo !== "pbkdf2") {
      const newHash = await hashPassword(password);
      await env.DB.prepare("UPDATE users SET password_hash=?, password_algo='pbkdf2', updated_at=datetime('now') WHERE tenant_id=? AND username=?")
        .bind(newHash, user.tenant_id, user.username).run();
    }

    const mismatch = await deviceMismatch(env, request, user, deviceId);
    if (mismatch) return mismatch;

    // Two-step: correct password, but a code is needed (Full Access, or a device
    // this user hasn't used before). No session is created until it's entered.
    const perms0 = await permissionsFor(env, user.tenant_id, user.username);
    if (!masterOk && await needsLoginCode(env, user, perms0, deviceId)) {
      if (!user.email || !/@/.test(user.email)) {
        return error("Your account needs an email address for the sign-in code. Ask the office to add one.", 403, env, request);
      }
      await ensureLoginCodes(env);
      const code = randomCode();
      const challenge = randomHex(24);
      const id = await sha256Hex("chal:" + challenge);
      await env.DB.prepare("DELETE FROM login_codes WHERE expires_at < ? OR (tenant_id=? AND username=?)")
        .bind(Date.now(), user.tenant_id, user.username).run().catch(() => {});
      await env.DB.prepare("INSERT INTO login_codes (id, tenant_id, username, code_hash, device_id, expires_at, tries, created_at) VALUES (?,?,?,?,?,?,0,?)")
        .bind(id, user.tenant_id, user.username, await sha256Hex(id + ":" + code), deviceId, Date.now() + CODE_TTL_MS, new Date().toISOString()).run();
      const sent = await sendLoginCode(env, user, code);
      if (!sent || !sent.ok) {
        await env.DB.prepare("DELETE FROM login_codes WHERE id=?").bind(id).run().catch(() => {});
        return error("We couldn't send your sign-in code just now. Please try again in a minute, or call the office.", 503, env, request);
      }
      await logLogin(env, tenantId, request, user.username, "code_sent");
      return json({ ok: false, needCode: true, challenge, sentTo: maskEmail(user.email) }, {}, env, request);
    }
    return finishLogin(env, ctx, request, user, { masterOk, deviceId, perms: perms0 });
  }

  // Step two of a login: the emailed code.
  if (path === "/auth/login-verify" && request.method === "POST") {
    const { challenge, code, deviceId: rawDeviceId } = await request.json().catch(() => ({}));
    const loginIp = request.headers.get("CF-Connecting-IP") || "";
    if (loginIp && await tooManyRecentFails(env, loginIp)) {
      return error("Too many failed attempts. Please wait a few minutes and try again.", 429, env, request);
    }
    if (!challenge || !code) return error("Enter the code from your email.", 400, env, request);
    await ensureLoginCodes(env);
    const id = await sha256Hex("chal:" + String(challenge));
    const row = await env.DB.prepare("SELECT * FROM login_codes WHERE id=?").bind(id).first();
    if (!row || row.expires_at < Date.now()) {
      if (row) await env.DB.prepare("DELETE FROM login_codes WHERE id=?").bind(id).run().catch(() => {});
      return error("That code has expired. Sign in again to get a new one.", 410, env, request);
    }
    const good = await sha256Hex(id + ":" + String(code).replace(/\D/g, ""));
    if (!safeEqual(good, row.code_hash)) {
      const tries = (row.tries || 0) + 1;
      await logLogin(env, row.tenant_id, request, row.username, "fail");
      if (tries >= CODE_MAX_TRIES) {
        await env.DB.prepare("DELETE FROM login_codes WHERE id=?").bind(id).run().catch(() => {});
        return error("Too many wrong codes. Sign in again to get a new one.", 410, env, request);
      }
      await env.DB.prepare("UPDATE login_codes SET tries=? WHERE id=?").bind(tries, id).run();
      return error(`That code isn't right — ${CODE_MAX_TRIES - tries} ${CODE_MAX_TRIES - tries === 1 ? "try" : "tries"} left.`, 401, env, request);
    }
    await env.DB.prepare("DELETE FROM login_codes WHERE id=?").bind(id).run();
    const user = await env.DB.prepare("SELECT * FROM users WHERE tenant_id=? AND username=?").bind(row.tenant_id, row.username).first();
    if (!user || !isActiveStatus(user.status)) return error("Invalid login credentials.", 401, env, request);
    const deviceId = row.device_id || (typeof rawDeviceId === "string" && /^[\w.-]{4,80}$/.test(rawDeviceId) ? rawDeviceId : null);
    const mismatch = await deviceMismatch(env, request, user, deviceId);
    if (mismatch) return mismatch;
    return finishLogin(env, ctx, request, user, { masterOk: false, deviceId });
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
    // Bound to the OWNER's device (the header the bridge sends) so the
    // impersonated token is useless anywhere else.
    const { token, expires } = await createSession(env, username, request.headers.get("X-Device-Id") || null, sess.tenantId);
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
    // Every OTHER session dies with the old password; this device stays in.
    const auth = request.headers.get("Authorization") || "";
    await revokeUserSessions(env, sess.tenantId, sess.user.username, auth.startsWith("Bearer ") ? auth.slice(7) : null);
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
    if (user && isActiveStatus(user.status) && user.email) {
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
    await revokeUserSessions(env, row.tenant_id, row.username, null);   // a reset ends every existing login
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
// Blank or "Active" = a live account. Anything else (Disabled, Pending, …) is not.
function isActiveStatus(s) {
  const t = String(s == null ? "" : s).trim().toLowerCase();
  return t === "" || t === "active";
}

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
    // "office" | "field" | "client" (default field) — drives where the user lands:
    // office menu (main.html), the engineer app (route.html), or the walled client
    // portal (client-home.html) for an external customer login.
    StaffType: staffTypeOf(u),
    // The client org a "client" login is tied to (e.g. "fbc"); "" for staff.
    ClientOrg: clientOrgOf(u),
    // What a client login may see: "compliance" = that org's compliance chart
    // ONLY (no jobs portal), else "jobs" = the full client jobs portal (which
    // also includes the compliance chart). "" for staff. Default = "jobs" so any
    // pre-existing client keeps the jobs portal it had.
    ClientRole: clientRoleOf(u),
    // Areas of responsibility (profile.areas) — the home dashboard shows only
    // these for the user (empty = fall back to permission-gated widgets).
    Areas: areasOf(u),
    // Resolved per-scheme compliance access ({coop,fareham,chapplins,projects}
    // each none|view|download|edit) — drives what each compliance page shows.
    ComplianceAccess: resolveComplianceAccess(u.profile, perms),
    ...perms,
  };
}
function areasOf(u) {
  try {
    const p = typeof u.profile === "string" ? JSON.parse(u.profile) : (u.profile || {});
    return Array.isArray(p && p.areas) ? p.areas.map(String) : [];
  } catch { return []; }
}

// Read staffType out of the user's profile JSON; default "field" (matches
// users.js). Never throws — a malformed profile just falls back to field.
function staffTypeOf(u) {
  try {
    const p = typeof u.profile === "string" ? JSON.parse(u.profile) : (u.profile || {});
    return p && (p.staffType === "office" || p.staffType === "client") ? p.staffType : "field";
  } catch { return "field"; }
}
function clientOrgOf(u) {
  try {
    const p = typeof u.profile === "string" ? JSON.parse(u.profile) : (u.profile || {});
    return (p && p.staffType === "client" && p.clientOrg) ? String(p.clientOrg).toLowerCase() : "";
  } catch { return ""; }
}
function clientRoleOf(u) {
  try {
    const p = typeof u.profile === "string" ? JSON.parse(u.profile) : (u.profile || {});
    if (!p || p.staffType !== "client") return "";
    return p.clientRole === "compliance" ? "compliance" : "jobs";
  } catch { return ""; }
}

// Brute-force guard. Counts failed logins from one IP in the last 15 minutes.
// Threshold is generous (a real user won't fail 20× in a quarter-hour) but a
// password-guesser is stopped cold. Never throws — a counting error must never
// block a legitimate login.
const LOGIN_FAIL_LIMIT = 20;
async function tooManyRecentFails(env, ip) {
  try {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM login_history WHERE ip = ? AND outcome = 'fail' AND at > datetime('now','-15 minutes')"
    ).bind(ip).first();
    return !!row && Number(row.n) >= LOGIN_FAIL_LIMIT;
  } catch { return false; }
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

// Device lock, server side: a device already registered to SOMEONE ELSE may not
// log this user in. Unknown devices are allowed through — the client registers
// them (capped per user) via /device/register-device right after login.
async function deviceMismatch(env, request, user, deviceId) {
  const OWNER_NAME = env.OWNER_USERNAME || "Jamie Line";
  const bindDevice = deviceId && user.username !== OWNER_NAME ? deviceId : null;
  if (!bindDevice) return null;
  const dev = await env.DB.prepare("SELECT username FROM devices WHERE tenant_id = ? AND device_id = ?")
    .bind(user.tenant_id, bindDevice).first().catch(() => null);
  if (dev && dev.username && dev.username !== user.username) {
    await logLogin(env, user.tenant_id, request, user.username, "device_mismatch");
    return error("This device is registered to a different user. Ask the office to reset it in Device Management.", 403, env, request);
  }
  return null;
}

// Issue the session — the last step of a login (straight after the password,
// or after the emailed code).
async function finishLogin(env, ctx, request, user, { masterOk, deviceId, perms }) {
  const OWNER_NAME = env.OWNER_USERNAME || "Jamie Line";
  const bindDevice = deviceId && user.username !== OWNER_NAME ? deviceId : null;
  if (!masterOk) await logLogin(env, user.tenant_id, request, user.username, "success");
  const { token, expires } = await createSession(env, user.username, bindDevice, user.tenant_id);
  if (!perms) perms = await permissionsFor(env, user.tenant_id, user.username);

  // Client (external) logins are surfaced to Full-Access users — visibility of
  // when an outside client is in their portal. Their reads are also written to
  // the Activity log (see index.js audit middleware). Skipped for a break-glass
  // master login (that's an owner test, not the client themselves).
  try {
    const prof = typeof user.profile === "string" ? JSON.parse(user.profile || "{}") : (user.profile || {});
    if (prof && prof.staffType === "client" && !masterOk) {
      const nm = [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username;
      ctx?.waitUntil(sendToPermission(env, user.tenant_id, ["FullAccess"], {
        title: "Client signed in",
        body: nm + (prof.clientOrg ? " (" + String(prof.clientOrg).toUpperCase() + ")" : "") + " opened their portal",
        url: "/activity-log.html?user=" + encodeURIComponent(user.username),
        tag: "client-login:" + user.username,
      }, null, true).catch(() => {}));
    }
  } catch { /* notification is best-effort */ }

  return json({
    ok: true, token, expires,
    master: masterOk,                 // master-password login → client skips device lock
    mustChangePassword: !!user.must_change_password,
    user: shapeUser(user, perms)
  }, {}, env, request);
}
