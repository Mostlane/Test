// User routes — replaces the `mostlane-users` Worker.
//   GET  /user?u=<username>     -> { found, user } with flat permission flags
//   GET  /users                 -> { users: [...] }
//   POST /users                 -> create/update a user (admin)
//
// The front-end's main.html reads user.FullAccess / user.CheckInOut etc., so
// we return those flat keys by joining users + user_permissions.

import { json, error } from "../lib/http.js";
import { requireSession, permissionsFor, hashPassword } from "../lib/auth.js";

export async function handle(request, env, ctx, url) {
  const path = url.pathname;

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
    const sess = await requireSession(env, request);
    if (!sess) return error("Not authenticated", 401, env, request);
    const adminPerms = await permissionsFor(env, sess.user.username);
    if (adminPerms.FullAccess !== "Yes" && adminPerms.Users !== "Yes")
      return error("Forbidden", 403, env, request);

    const b = await request.json().catch(() => ({}));
    if (!b.Username) return error("Username required", 400, env, request);

    await env.DB.prepare(`
      INSERT INTO users (engineer_number, first_name, last_name, username, email,
                         vehicle_assigned, employment_type, status, sharepoint_path)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(username) DO UPDATE SET
        engineer_number=excluded.engineer_number, first_name=excluded.first_name,
        last_name=excluded.last_name, email=excluded.email,
        vehicle_assigned=excluded.vehicle_assigned,
        employment_type=excluded.employment_type, status=excluded.status,
        sharepoint_path=excluded.sharepoint_path, updated_at=datetime('now')
    `).bind(
      b.EngineerNumber || null, b.FirstName || null, b.LastName || null,
      b.Username, b.Email || null, b.VehicleAssigned || null,
      b.EmploymentType || null, b.Status || "Active", b.SharePointPath || null
    ).run();

    if (b.Password) {
      const hash = await hashPassword(b.Password);
      await env.DB.prepare("UPDATE users SET password_hash=?, password_algo='pbkdf2' WHERE username=?")
        .bind(hash, b.Username).run();
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

    return json({ ok: true }, {}, env, request);
  }

  return error("Unknown user route", 404, env, request);
}

const PERMISSION_KEYS = [
  "FullAccess", "Users", "DeviceAdmin", "CheckInOut", "Vehicles", "Holiday",
  "HolidayAdmin", "EngineersHoursMenu", "HoursDashboard", "PurchaseOrders",
  "Sites", "AddSite", "Assets", "MyDocuments", "Weekly", "Forms", "Compliance",
  "Projects", "ProjectsAdmin", "TimesheetAdmin", "LabourPlanning", "SLA",
];

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
