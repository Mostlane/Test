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
import { tenantDB, resolveTenantId } from "../lib/tenantdb.js";
import { sendEmail, welcomeEmail, issuePasswordToken, appBase } from "../lib/email.js";
import { resolveComplianceAccess, sanitizeComplianceAccess } from "../lib/complianceaccess.js";

// How long a new user's "set your password" welcome link stays valid.
const WELCOME_TOKEN_HOURS = 72;

// Require a valid session whose user has admin rights (FullAccess or Users).
async function requireAdmin(env, request) {
  const sess = await requireSession(env, request);
  if (!sess) return { err: error("Not authenticated", 401, env, request) };
  const perms = await permissionsFor(env, sess.tenantId, sess.user.username);
  if (perms.FullAccess !== "Yes" && perms.Users !== "Yes")
    return { err: error("Forbidden", 403, env, request) };
  return { sess };
}

export async function handle(request, env, ctx, url, sess) {
  const path = url.pathname;
  const tenantId = sess ? sess.tenantId : await resolveTenantId(env, request);
  const db = tenantDB(env, tenantId);

  // POST /onboard — PUBLIC self-registration (the login page "Sign up" form).
  // Files the new starter as a Pending account for an admin to review; no
  // password is set and no permissions are granted, so the record is inert
  // until an admin activates it in Users admin. Create-only: it never touches
  // an existing account, so an anonymous caller can't hijack or overwrite one.
  if (path === "/onboard" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    const firstName = (b.firstName || "").trim();
    const lastName = (b.lastName || "").trim();
    const email = (b.email || "").trim();
    if (!firstName || !lastName || !email)
      return error("First name, last name and email are required.", 400, env, request);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      return error("Please enter a valid email address.", 400, env, request);

    // If someone with this email already exists, don't create a duplicate — and
    // don't reveal that it exists. Respond success without touching the account.
    const existingEmail = await db.prepare(
      "SELECT username FROM users WHERE tenant_id = ? AND email IS NOT NULL AND lower(email)=lower(?)"
    ).bind(db.tenantId, email).first();
    if (existingEmail) return json({ ok: true, pending: true }, {}, env, request);

    // Pick a free username: first.last, then first.last2, first.last3, …
    const base = `${firstName}.${lastName}`.replace(/\s+/g, "").toLowerCase()
      .replace(/[^a-z0-9._-]/g, "") || "user";
    let username = base;
    for (let n = 2; await db.prepare("SELECT username FROM users WHERE tenant_id = ? AND username=?")
        .bind(db.tenantId, username).first(); n++) {
      username = base + n;
    }

    const profile = {
      phone: b.mobile || "",
      jobTitle: b.jobRole || "",
      postcode: b.postcode || "",
      onboard: {
        deviceId: b.deviceId || "",
        lat: b.latitude || "",
        lng: b.longitude || "",
        submittedAt: new Date().toISOString(),
      },
    };

    await db.prepare(`
      INSERT INTO users (first_name, last_name, username, email, status, profile, tenant_id)
      VALUES (?,?,?,?, 'Pending', ?, ?)
    `).bind(firstName, lastName, username, email, JSON.stringify(profile), db.tenantId).run();

    return json({ ok: true, pending: true, username }, {}, env, request);
  }

  // GET /po-config — the logged-in user's personal PO-system link (stored on
  // their profile). Gated by the PurchaseOrders permission.
  if (path === "/po-config" && request.method === "GET") {
    const sess = await requireSession(env, request);
    if (!sess) return error("Not authenticated", 401, env, request);
    const perms = await permissionsFor(env, sess.tenantId, sess.user.username);
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
    const perms = await permissionsFor(env, sess.tenantId, sess.user.username);
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
    const user = await db.prepare("SELECT * FROM users WHERE tenant_id = ? AND username = ?")
      .bind(db.tenantId, username).first();
    if (!user) return json({ found: false }, {}, env, request);
    const perms = await permissionsFor(env, tenantId, username);
    return json({ found: true, user: shapeUser(user, perms) }, {}, env, request);
  }

  // GET /users  (list) — returned in the canonical people order (office staff
  // first, then field, each by the manual drag order set in Users admin) so
  // every page and dropdown that reads /users shows people the same way.
  if (path === "/users" && request.method === "GET") {
    // Two queries total (was 1 + one-per-user): grab the users and ALL
    // permission rows, then group the permissions in memory. The old N+1
    // pattern made this endpoint — and every page that loads it — ~3s slow.
    const [{ results }, { results: permRows }] = await Promise.all([
      db.prepare("SELECT * FROM users WHERE tenant_id = ? ORDER BY username").bind(db.tenantId).all(),
      db.prepare("SELECT username, permission, value FROM user_permissions WHERE tenant_id = ?").bind(db.tenantId).all()
    ]);
    const permMap = {};
    for (const r of permRows || []) (permMap[r.username] || (permMap[r.username] = {}))[r.permission] = r.value ? "Yes" : "No";
    // By default only ACTIVE users are returned, so a disabled account vanishes
    // from every picker/list portal-wide. Users Admin passes ?all=1 to still see
    // (and re-enable) disabled accounts. Blank/legacy status counts as active.
    const includeAll = url.searchParams.get("all") === "1" || url.searchParams.get("includeInactive") === "1";
    const rows = includeAll ? (results || []) : (results || []).filter(u => isActiveStatus(u.status));
    const out = [];
    for (const u of rows) out.push(shapeUser(u, permMap[u.username] || {}));
    out.sort(orderUsers);
    return json({ Users: out }, {}, env, request);
  }

  // POST /users/reorder  (admin) — persist staff type + manual order in one go.
  // Body: { order: [{ Username, StaffType:"office"|"field", SortOrder:int }] }.
  // Only touches staffType/sortOrder inside each profile; other keys survive.
  if (path === "/users/reorder" && request.method === "POST") {
    const gate = await requireAdmin(env, request);
    if (gate.err) return gate.err;
    const b = await request.json().catch(() => ({}));
    const list = Array.isArray(b.order) ? b.order : [];
    for (const item of list) {
      if (!item || !item.Username) continue;
      const row = await db.prepare("SELECT profile FROM users WHERE tenant_id = ? AND username=?").bind(db.tenantId, item.Username).first();
      if (!row) continue;
      let profile = {};
      try { profile = row.profile ? JSON.parse(row.profile) : {}; } catch { profile = {}; }
      profile.staffType = item.StaffType === "office" ? "office" : "field";
      profile.sortOrder = Number.isFinite(+item.SortOrder) ? +item.SortOrder : 9999;
      await db.prepare("UPDATE users SET profile=?, updated_at=datetime('now') WHERE tenant_id = ? AND username=?")
        .bind(JSON.stringify(profile), db.tenantId, item.Username).run();
    }
    return json({ ok: true, count: list.length }, {}, env, request);
  }

  // GET /users/areas-meta — the pickable "areas of responsibility" (admin).
  if (path === "/users/areas-meta" && request.method === "GET") {
    const gate = await requireAdmin(env, request);
    if (gate.err) return gate.err;
    return json({ ok: true, areas: USER_AREAS }, {}, env, request);
  }

  // POST /users/set-areas  (admin) — set one user's areas of responsibility.
  // Body: { Username, Areas:[keys] }. Merges into profile.areas only (other
  // profile keys survive), so it never wipes theme/prefs/staffType etc.
  if (path === "/users/set-areas" && request.method === "POST") {
    const gate = await requireAdmin(env, request);
    if (gate.err) return gate.err;
    const b = await request.json().catch(() => ({}));
    if (!b.Username) return error("Username required", 400, env, request);
    const valid = new Set(USER_AREAS.map(a => a.key));
    const areas = (Array.isArray(b.Areas) ? b.Areas : []).map(String).filter(k => valid.has(k));
    const row = await db.prepare("SELECT profile FROM users WHERE tenant_id = ? AND username=?").bind(db.tenantId, b.Username).first();
    if (!row) return error("User not found", 404, env, request);
    let profile = {}; try { profile = row.profile ? JSON.parse(row.profile) : {}; } catch { profile = {}; }
    profile.areas = areas;
    await db.prepare("UPDATE users SET profile=?, updated_at=datetime('now') WHERE tenant_id = ? AND username=?")
      .bind(JSON.stringify(profile), db.tenantId, b.Username).run();
    return json({ ok: true, Areas: areas }, {}, env, request);
  }

  // POST /users  (create or update — admin only)
  if (path === "/users" && request.method === "POST") {
    const gate = await requireAdmin(env, request);
    if (gate.err) return gate.err;

    const b = await request.json().catch(() => ({}));
    if (!b.Username) return error("Username required", 400, env, request);

    // Is this a brand-new account (vs. an edit)? Decides whether to send a welcome email.
    const already = await db.prepare("SELECT username FROM users WHERE tenant_id = ? AND username=?").bind(db.tenantId, b.Username).first();
    const isNewUser = !already;

    // Clean the compliance-access map before persisting (valid schemes + levels only).
    if (b.Profile && typeof b.Profile === "object" && b.Profile.complianceAccess != null) {
      b.Profile.complianceAccess = sanitizeComplianceAccess(b.Profile.complianceAccess);
    }
    const profileJson = b.Profile && typeof b.Profile === "object" ? JSON.stringify(b.Profile) : null;

    await db.prepare(`
      INSERT INTO users (engineer_number, first_name, last_name, username, email,
                         vehicle_assigned, employment_type, status, sharepoint_path, profile, tenant_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
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
      b.EmploymentType || null, b.Status || "Active", b.SharePointPath || null, profileJson, db.tenantId
    ).run();

    if (b.Password) {
      const bad = validatePassword(b.Password);
      if (bad) return error(bad, 400, env, request);
      const hash = await hashPassword(b.Password);
      // Force a change on first login unless the admin explicitly opts out.
      const force = b.ForceChange === false ? 0 : 1;
      await db.prepare("UPDATE users SET password_hash=?, password_algo='pbkdf2', must_change_password=? WHERE tenant_id = ? AND username=?")
        .bind(hash, force, db.tenantId, b.Username).run();
    }

    // Upsert permission flags supplied in the body.
    for (const key of PERMISSION_KEYS) {
      if (key in b) {
        const val = String(b[key]).toLowerCase() === "yes" ? 1 : 0;
        await db.prepare(`
          INSERT INTO user_permissions (username, permission, value, tenant_id) VALUES (?,?,?,?)
          ON CONFLICT(username, permission) DO UPDATE SET value=excluded.value
        `).bind(b.Username, key, val, db.tenantId).run();
      }
    }

    // New account with an email → send a welcome / "set your password" link so
    // onboarding needs no manual credential hand-off.
    let welcomeEmailed = false;
    // SuppressWelcome lets the guided add-user wizard skip the email (e.g. when
    // the admin set a password themselves). Default is to send it.
    if (isNewUser && b.Email && !b.SuppressWelcome) {
      const token = await issuePasswordToken(env, tenantId, b.Username, WELCOME_TOKEN_HOURS);
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

    // Saving a user as Disabled fully cuts them off: end every live session and
    // drop their device locks (a 90-day token would otherwise keep working, and
    // the PO worker also refuses a Disabled user server-side). Reversible — the
    // user + records are kept and re-enabling just restores Active.
    if (String(b.Status || "").toLowerCase() === "disabled") {
      await db.batch([
        db.prepare("DELETE FROM sessions WHERE tenant_id = ? AND username=?").bind(db.tenantId, b.Username),
        db.prepare("DELETE FROM devices WHERE tenant_id = ? AND username=?").bind(db.tenantId, b.Username),
      ]);
    }

    return json({ ok: true, isNewUser, welcomeEmailed }, {}, env, request);
  }

  // POST /users/block — one-click full block / re-enable. blocked:true sets the
  // user Disabled AND ends all sessions + device locks (cuts login, pickers and
  // PO); blocked:false restores them to Active. Vehicle assignment is left intact.
  if (path === "/users/block" && request.method === "POST") {
    const gate = await requireAdmin(env, request);
    if (gate.err) return gate.err;
    const b = await request.json().catch(() => ({}));
    if (!b.username) return error("username required", 400, env, request);
    if (b.username === gate.sess.user.username) return error("You cannot block your own account.", 400, env, request);
    const exists = await db.prepare("SELECT username FROM users WHERE tenant_id = ? AND username=?").bind(db.tenantId, b.username).first();
    if (!exists) return error("User not found", 404, env, request);
    const blocked = b.blocked !== false;   // default = block
    const status = blocked ? "Disabled" : "Active";
    await db.prepare("UPDATE users SET status=?, updated_at=datetime('now') WHERE tenant_id = ? AND username=?").bind(status, db.tenantId, b.username).run();
    if (blocked) {
      await db.batch([
        db.prepare("DELETE FROM sessions WHERE tenant_id = ? AND username=?").bind(db.tenantId, b.username),
        db.prepare("DELETE FROM devices WHERE tenant_id = ? AND username=?").bind(db.tenantId, b.username),
      ]);
    }
    return json({ ok: true, status, blocked }, {}, env, request);
  }

  // GET /users/presets — role presets (standard permission sets) an admin applies
  // when adding/editing a user. Stored per tenant in app_config; seeded with
  // named-but-empty roles the owner fills in via the preset editor.
  if (path === "/users/presets" && request.method === "GET") {
    const gate = await requireAdmin(env, request);
    if (gate.err) return gate.err;
    const row = await db.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key='user_role_presets'").bind(db.tenantId).first();
    let presets = null;
    try { presets = row && row.value ? JSON.parse(row.value) : null; } catch { presets = null; }
    if (!Array.isArray(presets) || !presets.length) presets = DEFAULT_PRESETS;
    return json({ ok: true, presets, permissionKeys: PERMISSION_KEYS }, {}, env, request);
  }

  // POST /users/presets — replace the whole preset list (admin).
  if (path === "/users/presets" && request.method === "POST") {
    const gate = await requireAdmin(env, request);
    if (gate.err) return gate.err;
    const b = await request.json().catch(() => ({}));
    const validKeys = new Set(PERMISSION_KEYS);
    const clean = (Array.isArray(b.presets) ? b.presets : []).slice(0, 30).map((p, i) => ({
      id: String(p && p.id ? p.id : ("role" + i)).replace(/[^a-z0-9_-]/gi, "").slice(0, 40) || ("role" + i),
      name: String(p && p.name ? p.name : "Role").slice(0, 60),
      staffType: (p && p.staffType === "office") ? "office" : "field",
      fullAccess: !!(p && p.fullAccess),
      perms: Array.isArray(p && p.perms) ? [...new Set(p.perms.map(String).filter((k) => validKeys.has(k)))] : [],
    }));
    await db.prepare("INSERT INTO app_config (tenant_id, key, value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(db.tenantId, "user_role_presets", JSON.stringify(clean)).run();
    return json({ ok: true, presets: clean }, {}, env, request);
  }

  // POST /users/reset-password (admin) — sets a temp password + forces change
  if (path === "/users/reset-password" && request.method === "POST") {
    const gate = await requireAdmin(env, request);
    if (gate.err) return gate.err;
    const b = await request.json().catch(() => ({}));
    if (!b.username) return error("username required", 400, env, request);
    const exists = await db.prepare("SELECT username FROM users WHERE tenant_id = ? AND username=?").bind(db.tenantId, b.username).first();
    if (!exists) return error("User not found", 404, env, request);

    const tempProvided = !!b.newPassword;
    const newPassword = b.newPassword || generateTempPassword();
    const bad = validatePassword(newPassword);
    if (bad) return error(bad, 400, env, request);

    const hash = await hashPassword(newPassword);
    await db.prepare(
      "UPDATE users SET password_hash=?, password_algo='pbkdf2', must_change_password=1, updated_at=datetime('now') WHERE tenant_id = ? AND username=?"
    ).bind(hash, db.tenantId, b.username).run();
    // Invalidate any existing sessions for that user.
    await db.prepare("DELETE FROM sessions WHERE tenant_id = ? AND username=?").bind(db.tenantId, b.username).run();

    // Return the temp password so the admin can relay it (only if we generated it).
    return json({ ok: true, tempPassword: tempProvided ? undefined : newPassword }, {}, env, request);
  }

  // POST /users/resend-welcome (admin) — re-send the "set your password" welcome email.
  if (path === "/users/resend-welcome" && request.method === "POST") {
    const gate = await requireAdmin(env, request);
    if (gate.err) return gate.err;
    const b = await request.json().catch(() => ({}));
    if (!b.username) return error("username required", 400, env, request);
    const user = await db.prepare("SELECT username, first_name, email FROM users WHERE tenant_id = ? AND username=?")
      .bind(db.tenantId, b.username).first();
    if (!user) return error("User not found", 404, env, request);
    if (!user.email) return error("That user has no email address on file.", 400, env, request);

    const token = await issuePasswordToken(env, tenantId, user.username, WELCOME_TOKEN_HOURS);
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
    await db.batch([
      db.prepare("DELETE FROM users WHERE tenant_id = ? AND username=?").bind(db.tenantId, b.username),
      db.prepare("DELETE FROM user_permissions WHERE tenant_id = ? AND username=?").bind(db.tenantId, b.username),
      db.prepare("DELETE FROM sessions WHERE tenant_id = ? AND username=?").bind(db.tenantId, b.username),
      db.prepare("DELETE FROM devices WHERE tenant_id = ? AND username=?").bind(db.tenantId, b.username),
    ]);
    return json({ ok: true }, {}, env, request);
  }

  return error("Unknown user route", 404, env, request);
}

// Seed role presets — named-but-empty (bar Full access). The owner fills in each
// role's permissions in the Users-admin preset editor; stored in app_config
// `user_role_presets` thereafter. Applying a preset sets the switches + staffType.
const DEFAULT_PRESETS = [
  { id: "field",  name: "Field engineer", staffType: "field",  fullAccess: false, perms: [] },
  { id: "office", name: "Office staff",   staffType: "office", fullAccess: false, perms: [] },
  { id: "admin",  name: "Office admin",   staffType: "office", fullAccess: false, perms: [] },
  { id: "full",   name: "Full access",    staffType: "office", fullAccess: true,  perms: [] },
];

// Areas of responsibility an admin can assign to an office user (Users Admin).
// The `key` matches the home dashboard's widget `area` domain so the home page
// can show only the areas a user owns. `perm` is the permission that area needs
// (surfaced as an access flag/grant, like tasks).
const USER_AREAS = [
  { key: "vehicles",       label: "Vehicles / van checks", perm: "Vehicles" },
  { key: "sla",            label: "SLA jobs",              perm: "SLA" },
  { key: "holidays",       label: "Holidays",              perm: "HolidayAdmin" },
  { key: "equipment",      label: "Plant & equipment",     perm: "AssetAdmin" },
  { key: "compliance",     label: "Compliance",            perm: "Compliance" },
  { key: "purchaseorders", label: "Purchase orders",       perm: "PurchaseOrders" },
  { key: "memos",          label: "Company memos",         perm: "FullAccess" },
  { key: "timesheets",     label: "Engineer timesheets",   perm: "TimesheetAdmin" },
  { key: "messages",       label: "Messages",              perm: "" },
];
const PERMISSION_KEYS = [
  "FullAccess", "Users", "DeviceAdmin", "CheckInOut", "Vehicles", "Holiday",
  "HolidayAdmin", "EngineersHoursMenu", "HoursDashboard", "PurchaseOrders",
  "Sites", "AddSite", "Assets", "MyDocuments", "Weekly", "Forms", "Compliance",
  "Projects", "ProjectsAdmin", "TimesheetAdmin", "LabourPlanning", "SLA",
  "SLAAdmin",    // office SLA management: dashboard, scheduler, add/edit jobs
  "StoryMode",   // opt-in: guided day protocol for this engineer
  "HSPlan",      // access to the H&S planning tool
  "SiteLog",       // access to SiteLog (site check-in/attendance)
  "OfficeClock",   // opt-in: desktop clock in/out timer for office staff
  "OfficeTimesheet",// view the weekly master office timesheet (all staff)
  "EngTimesheet",  // engineer weekly timesheet (times + jobs; invoices if self-employed)
  "AssetAdmin",    // plant & equipment admin: sees ALL transfer documents + All Assets
  "ThemeColour",     // personalisation: may pick a portal colour theme
  "ThemeBackground", // personalisation: may change the menu background
  "Programmes",      // job programmes: build/issue/share programmes of works
  "YardGate",        // trigger the yard gate (Tuya) + see its open/closed state
  "YardGateAnywhere",// exempt from the yard-gate geofence (operate from anywhere)
];

// A user counts as "active" (visible in pickers/lists) unless explicitly
// disabled. Blank/legacy status is treated as active so existing accounts are
// never hidden; anything else (Disabled/Inactive/Archived/Left…) is excluded.
function isActiveStatus(s) {
  const t = String(s == null ? "" : s).trim().toLowerCase();
  return t === "" || t === "active";
}

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
    // Office/field split + manual drag order (set in Users admin, stored in the
    // profile blob so no schema change is needed). Everything sorts by these.
    StaffType: profile.staffType === "office" ? "office" : "field",
    SortOrder: Number.isFinite(profile.sortOrder) ? profile.sortOrder : 9999,
    Areas: Array.isArray(profile.areas) ? profile.areas.map(String) : [],
    // Resolved per-scheme compliance access (none|view|download|edit) so the
    // Users-admin picker pre-fills each page's dropdown with the current level.
    ComplianceAccess: resolveComplianceAccess(profile, perms),
    Profile: profile,
    ...perms,
  };
}

// Canonical people order: office staff first, then field, each by their manual
// drag order, then alphabetical as a stable fallback.
function orderUsers(a, b) {
  const rank = t => (t === "office" ? 0 : 1);
  const ra = rank(a.StaffType), rb = rank(b.StaffType);
  if (ra !== rb) return ra - rb;
  const sa = Number.isFinite(a.SortOrder) ? a.SortOrder : 9999;
  const sb = Number.isFinite(b.SortOrder) ? b.SortOrder : 9999;
  if (sa !== sb) return sa - sb;
  const na = ((a.FirstName || "") + " " + (a.LastName || "")).trim().toLowerCase();
  const nb = ((b.FirstName || "") + " " + (b.LastName || "")).trim().toLowerCase();
  return na.localeCompare(nb);
}
