// User routes — replaces the `mostlane-users` Worker + admin user management.
//   GET  /user?u=<username>      -> { found, user } with flat permission flags
//   GET  /users                  -> { Users: [...] }
//   POST /users                  -> create/update a user (admin)
//   POST /users/reset-password   -> admin reset (temp password + force change)
//   POST /users/delete           -> remove a user (admin)
//
// The front-end's main.html reads user.FullAccess / user.CheckInOut etc., so
// we return those flat keys by joining users + user_permissions.

import { json, error } from "../lib/http.js";
import { requireSession, permissionsFor, hashPassword, validatePassword, generateTempPassword } from "../lib/auth.js";
import { sendEmail, welcomeEmail, issuePasswordToken, appBase } from "../lib/email.js";

// How long a new user's "set your password" welcome link stays valid.
const WELCOME_TOKEN_HOURS = 72;

// Require a valid session whose user has admin rights (FullAccess or Users).
async function requireAdmin(env, request) {
  const sess = await requireSession(env, request);
  if (!sess) return { err: error("Not authenticated", 401, env, request) };
  const perms = await permissionsFor(env, sess.user.username);
  if (perms.FullAccess !== "Yes" && perms.Users !== "Yes")
    return { err: error("Forbidden", 403, env, request) };
  return { sess };
}

export async function handle(request, env, ctx, url) {
  const path = url.pathname;

  // GET /po-config — the logged-in user's personal PO-system link (stored on
  // their profile). Gated by the PurchaseOrders permission.
  if (path === "/po-config" && request.method === "GET") {
    const sess = await requireSession(env, request);
    if (!sess) return error("Not authenticated", 401, env, request);
    const perms = await permissionsFor(env, sess.user.username);
    if (perms.PurchaseOrders !== "Yes" && perms.FullAccess !== "Yes")
      return error("Forbidden", 403, env, request);
    let profile = {};
    try { profile = sess.user.profile ? JSON.parse(sess.user.profile) : {}; } catch {}
    return json({ ok: true, url: profile.poUrl || "" }, {}, env, request);
  }

  // GET /hs-plan-config — launch details for the H&S planner. The app token
  // lives as a worker secret (HS_PLAN_TOKEN) and is only released to users
  // holding the HSPlan permission (or FullAccess).
  if (path === "/hs-plan-config" && request.method === "GET") {
    const sess = await requireSession(env, request);
    if (!sess) return error("Not authenticated", 401, env, request);
    const perms = await permissionsFor(env, sess.user.username);
    if (perms.HSPlan !== "Yes" && perms.FullAccess !== "Yes")
      return error("Forbidden", 403, env, request);
    return json({
      ok: true,
      worker: env.HS_PLAN_WORKER || "https://mostlane-hs-jobs.jamie-def.workers.dev",
      token: env.HS_PLAN_TOKEN || ""
    }, {}, env, request);
  }

  // GET /user?u=username
  if (path === "/user" && request.method === "GET") {
    const username = url.searchParams.get("u");
    if (!username) return error("Missing ?u=", 400, env, request);
    const user = await env.DB.prepare("SELECT * FROM users WHERE username = ?")
      .bind(username).first();
    if (!user) return json({ found: false }, {}, env, request);
    const perms = await permissionsFor(env, username);
    return json({ found: true, user: shapeUser(user, perms) }, {}, env, request);
  }

  // GET /users  (list)
  if (path === "/users" && request.method === "GET") {
    const { results } = await env.DB.prepare("SELECT * FROM users ORDER BY username").all();
    const out = [];
    for (const u of results || []) out.push(shapeUser(u, await permissionsFor(env, u.username)));
    return json({ Users: out }, {}, env, request);
  }

  // POST /users  (create or update — admin only)
  if (path === "/users" && request.method === "POST") {
    const gate = await requireAdmin(env, request);
    if (gate.err) return gate.err;

    const b = await request.json().catch(() => ({}));
    if (!b.Username) return error("Username required", 400, env, request);

    // Is this a brand-new account (vs. an edit)? Decides whether to send a welcome email.
    const already = await env.DB.prepare("SELECT username FROM users WHERE username=?").bind(b.Username).first();
    const isNewUser = !already;

    const profileJson = b.Profile && typeof b.Profile === "object" ? JSON.stringify(b.Profile) : null;

    await env.DB.prepare(`
      INSERT INTO users (engineer_number, first_name, last_name, username, email,
                         vehicle_assigned, employment_type, status, sharepoint_path, profile)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(username) DO UPDATE SET
        engineer_number=excluded.engineer_number, first_name=excluded.first_name,
        last_name=excluded.last_name, email=excluded.email,
        vehicle_assigned=excluded.vehicle_assigned,
        employment_type=excluded.employment_type, status=excluded.status,
        sharepoint_path=excluded.sharepoint_path,
        profile=COALESCE(excluded.profile, users.profile), updated_at=datetime('now')
    `).bind(
      b.EngineerNumber || null, b.FirstName || null, b.LastName || null,
      b.Username, b.Email || null, b.VehicleAssigned || null,
      b.EmploymentType || null, b.Status || "Active", b.SharePointPath || null, profileJson
    ).run();

    if (b.Password) {
      const bad = validatePassword(b.Password);
      if (bad) return error(bad, 400, env, request);
      const hash = await hashPassword(b.Password);
      // Force a change on first login unless the admin explicitly opts out.
      const force = b.ForceChange === false ? 0 : 1;
      await env.DB.prepare("UPDATE users SET password_hash=?, password_algo='pbkdf2', must_change_password=? WHERE username=?")
        .bind(hash, force, b.Username).run();
    }

    // Upsert permission flags supplied in the body.
    for (const key of PERMISSION_KEYS) {
      if (key in b) {
        const val = String(b[key]).toLowerCase() === "yes" ? 1 : 0;
        await env.DB.prepare(`
          INSERT INTO user_permissions (username, permission, value) VALUES (?,?,?)
          ON CONFLICT(username, permission) DO UPDATE SET value=excluded.value
        `).bind(b.Username, key, val).run();
      }
    }

    // New account with an email → send a welcome / "set your password" link so
    // onboarding needs no manual credential hand-off.
    let welcomeEmailed = false;
    if (isNewUser && b.Email) {
      const token = await issuePasswordToken(env, b.Username, WELCOME_TOKEN_HOURS);
      const setUrl = `${appBase(env)}/reset-password.html?token=${token}`;
      const msg = welcomeEmail({
        name: b.FirstName || b.Username,
        username: b.Username,
        setUrl,
        ttlHours: WELCOME_TOKEN_HOURS,
        appUrl: appBase(env),
      });
      const res = await sendEmail(env, { to: b.Email, ...msg });
      welcomeEmailed = !!res.ok;
    }

    return json({ ok: true, isNewUser, welcomeEmailed }, {}, env, request);
  }

  // POST /users/reset-password (admin) — sets a temp password + forces change
  if (path === "/users/reset-password" && request.method === "POST") {
    const gate = await requireAdmin(env, request);
    if (gate.err) return gate.err;
    const b = await request.json().catch(() => ({}));
    if (!b.username) return error("username required", 400, env, request);
    const exists = await env.DB.prepare("SELECT username FROM users WHERE username=?").bind(b.username).first();
    if (!exists) return error("User not found", 404, env, request);

    const tempProvided = !!b.newPassword;
    const newPassword = b.newPassword || generateTempPassword();
    const bad = validatePassword(newPassword);
    if (bad) return error(bad, 400, env, request);

    const hash = await hashPassword(newPassword);
    await env.DB.prepare(
      "UPDATE users SET password_hash=?, password_algo='pbkdf2', must_change_password=1, updated_at=datetime('now') WHERE username=?"
    ).bind(hash, b.username).run();
    // Invalidate any existing sessions for that user.
    await env.DB.prepare("DELETE FROM sessions WHERE username=?").bind(b.username).run();

    // Return the temp password so the admin can relay it (only if we generated it).
    return json({ ok: true, tempPassword: tempProvided ? undefined : newPassword }, {}, env, request);
  }

  // POST /users/resend-welcome (admin) — re-send the "set your password" welcome email.
  if (path === "/users/resend-welcome" && request.method === "POST") {
    const gate = await requireAdmin(env, request);
    if (gate.err) return gate.err;
    const b = await request.json().catch(() => ({}));
    if (!b.username) return error("username required", 400, env, request);
    const user = await env.DB.prepare("SELECT username, first_name, email FROM users WHERE username=?")
      .bind(b.username).first();
    if (!user) return error("User not found", 404, env, request);
    if (!user.email) return error("That user has no email address on file.", 400, env, request);

    const token = await issuePasswordToken(env, user.username, WELCOME_TOKEN_HOURS);
    const setUrl = `${appBase(env)}/reset-password.html?token=${token}`;
    const msg = welcomeEmail({
      name: user.first_name || user.username,
      username: user.username,
      setUrl,
      ttlHours: WELCOME_TOKEN_HOURS,
      appUrl: appBase(env),
    });
    const res = await sendEmail(env, { to: user.email, ...msg });
    if (!res.ok) return error("Email could not be sent — check the email configuration.", 502, env, request);
    return json({ ok: true, sent: true, email: user.email }, {}, env, request);
  }

  // POST /users/delete (admin)
  if (path === "/users/delete" && request.method === "POST") {
    const gate = await requireAdmin(env, request);
    if (gate.err) return gate.err;
    const b = await request.json().catch(() => ({}));
    if (!b.username) return error("username required", 400, env, request);
    if (b.username === gate.sess.user.username) return error("You cannot delete your own account.", 400, env, request);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM users WHERE username=?").bind(b.username),
      env.DB.prepare("DELETE FROM user_permissions WHERE username=?").bind(b.username),
      env.DB.prepare("DELETE FROM sessions WHERE username=?").bind(b.username),
      env.DB.prepare("DELETE FROM devices WHERE username=?").bind(b.username),
    ]);
    return json({ ok: true }, {}, env, request);
  }

  return error("Unknown user route", 404, env, request);
}

const PERMISSION_KEYS = [
  "FullAccess", "Users", "DeviceAdmin", "CheckInOut", "Vehicles", "Holiday",
  "HolidayAdmin", "EngineersHoursMenu", "HoursDashboard", "PurchaseOrders",
  "Sites", "AddSite", "Assets", "MyDocuments", "Weekly", "Forms", "Compliance",
  "Projects", "ProjectsAdmin", "TimesheetAdmin", "LabourPlanning", "SLA",
  "StoryMode",   // opt-in: guided day protocol for this engineer
  "HSPlan",      // access to the H&S planning tool
];

function shapeUser(u, perms) {
  let profile = {};
  try { profile = u.profile ? JSON.parse(u.profile) : {}; } catch { profile = {}; }
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
    Profile: profile,
    ...perms,
  };
}
