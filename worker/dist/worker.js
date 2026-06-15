// src/lib/http.js
function corsHeaders(env, request) {
  const allowed = (env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim());
  const origin = request.headers.get("Origin") || "";
  const allowOrigin = allowed.includes("*") ? "*" : allowed.includes(origin) ? origin : allowed[0] || "*";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-User, X-Role",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}
function json(data, init = {}, env, request) {
  return new Response(JSON.stringify(data), {
    status: init.status || 200,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(env, request),
      ...init.headers || {}
    }
  });
}
function error(message, status = 400, env, request) {
  return json({ ok: false, error: message }, { status }, env, request);
}
function preflight(env, request) {
  return new Response(null, { status: 204, headers: corsHeaders(env, request) });
}

// src/lib/auth.js
var enc = new TextEncoder();
function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return toHex(digest);
}
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 1e5, hash: "SHA-256" },
    key,
    256
  );
  return `pbkdf2$100000$${toHex(salt)}$${toHex(bits)}`;
}
async function verifyPbkdf2(password, stored) {
  const [, iterStr, saltHex, hashHex] = stored.split("$");
  const salt = Uint8Array.from(saltHex.match(/.{2}/g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: Number(iterStr), hash: "SHA-256" },
    key,
    256
  );
  return toHex(bits) === hashHex;
}
async function verifyPassword(password, user) {
  if (user.password_algo === "pbkdf2") return verifyPbkdf2(password, user.password_hash);
  return await sha256Hex(password) === (user.password_hash || "");
}
function validatePassword(pw) {
  if (typeof pw !== "string" || pw.length < 8) return "Password must be at least 8 characters.";
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return "Password must contain a letter and a number.";
  return null;
}
function generateTempPassword() {
  return "Mostlane-" + Math.floor(1e3 + Math.random() * 9e3);
}
async function createSession(env, username, deviceId) {
  const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
  const ttlH = Number(env.SESSION_TTL_HOURS || 12);
  const expires = new Date(Date.now() + ttlH * 3600 * 1e3).toISOString();
  await env.DB.prepare(
    "INSERT INTO sessions (token, username, device_id, expires_at) VALUES (?,?,?,?)"
  ).bind(token, username, deviceId || null, expires).run();
  return { token, expires };
}
async function requireSession(env, request) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const row = await env.DB.prepare(
    "SELECT * FROM sessions WHERE token = ? AND expires_at > datetime('now')"
  ).bind(token).first();
  if (!row) return null;
  const user = await env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(row.username).first();
  if (!user) return null;
  return { session: row, user };
}
async function destroySession(env, token) {
  await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
}
async function permissionsFor(env, username) {
  const { results } = await env.DB.prepare(
    "SELECT permission, value FROM user_permissions WHERE username = ?"
  ).bind(username).all();
  const perms = {};
  for (const r of results || []) perms[r.permission] = r.value ? "Yes" : "No";
  return perms;
}

// src/lib/email.js
var BRAND = "Mostlane";
function appBase(env) {
  return (env.APP_BASE_URL || "https://mostlane-portal.com").replace(/\/$/, "");
}
async function issuePasswordToken(env, username, ttlHours = 1) {
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const expires = new Date(Date.now() + ttlHours * 3600 * 1e3).toISOString();
  await env.DB.prepare(
    "INSERT INTO password_resets (token, username, expires_at) VALUES (?,?,?)"
  ).bind(token, username, expires).run();
  return token;
}
async function sendEmail(env, { to, subject, html, text }) {
  if (!to) return { ok: false, skipped: true, reason: "no recipient" };
  const body = text || stripHtml(html);
  if (env.RESEND_API_KEY) {
    const from = env.EMAIL_FROM || `${BRAND} <no-reply@mostlane-portal.com>`;
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ from, to, subject, html, text: body })
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        console.error("Resend send failed:", res.status, errBody);
        return { ok: false, status: res.status, error: errBody };
      }
      return { ok: true, via: "resend" };
    } catch (e) {
      console.error("Resend send error:", e.message);
      return { ok: false, error: e.message };
    }
  }
  if (env.RESET_EMAIL_WEBHOOK) {
    try {
      await fetch(env.RESET_EMAIL_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, subject, html, text: body })
      });
      return { ok: true, via: "webhook" };
    } catch (e) {
      console.error("Email webhook failed:", e.message);
      return { ok: false, error: e.message };
    }
  }
  console.warn(`No email provider set (RESEND_API_KEY / RESET_EMAIL_WEBHOOK) \u2014 "${subject}" to ${to} was NOT sent.`);
  return { ok: false, skipped: true, reason: "no provider" };
}
function welcomeEmail({ name, username, setUrl, ttlHours, appUrl }) {
  return {
    subject: `Welcome to ${BRAND} \u2014 set your password`,
    html: shell(`
      <h1 style="margin:0 0 14px;font-size:21px;font-weight:700;color:#003b82;">Welcome to ${BRAND}</h1>
      <p style="margin:0 0 14px;">Hi ${esc(name)}, an account has been created for you on the ${BRAND} portal.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 20px;background:#f3f6fb;border:1px solid #e1e9f5;border-radius:10px;">
        <tr><td style="padding:12px 16px;">
          <div style="font-size:12px;color:#6b7a90;text-transform:uppercase;letter-spacing:.04em;">Your username</div>
          <div style="font-size:16px;font-weight:700;color:#0f2a52;margin-top:2px;">${esc(username)}</div>
        </td></tr>
      </table>
      <p style="margin:0 0 6px;">Set your password to get started:</p>
      ${button(setUrl, "Set your password")}
      <p style="margin:18px 0 0;color:#8a94a3;font-size:13px;">This link expires in ${ttlHours} hours. If it expires, just use
      &ldquo;Forgot password&rdquo; on the sign-in page to get a fresh one.</p>
    `, appUrl)
  };
}
function resetEmail({ name, resetUrl, appUrl }) {
  return {
    subject: `${BRAND} \u2014 password reset`,
    html: shell(`
      <h1 style="margin:0 0 14px;font-size:21px;font-weight:700;color:#003b82;">Password reset</h1>
      <p style="margin:0 0 16px;">Hi ${esc(name)}, we received a request to reset your ${BRAND} portal password. Click below to choose a new one:</p>
      ${button(resetUrl, "Reset your password")}
      <p style="margin:18px 0 0;color:#8a94a3;font-size:13px;">This link expires in 1 hour. If you didn&rsquo;t request this you can safely
      ignore this email &mdash; your password won&rsquo;t change.</p>
    `, appUrl)
  };
}
function shell(inner, appUrl) {
  const base = (appUrl || "https://mostlane-portal.com").replace(/\/$/, "");
  const logo = `${base}/mostlane-logo.jpg`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#eef1f4;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${BRAND} portal notification</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f4;padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e3e6ea;box-shadow:0 8px 24px rgba(15,23,42,0.08);">
        <tr><td style="height:6px;line-height:6px;font-size:0;background:#1e66ff;background:linear-gradient(90deg,#003b82,#1e66ff);">&nbsp;</td></tr>
        <tr><td align="center" style="padding:26px 24px 6px;">
          <img src="${logo}" alt="${BRAND}" height="46" style="height:46px;display:block;border:0;outline:none;text-decoration:none;">
        </td></tr>
        <tr><td style="padding:10px 32px 28px;color:#26303d;font-size:15px;line-height:1.6;">${inner}</td></tr>
        <tr><td style="padding:16px 32px;background:#f7f9fb;border-top:1px solid #edf0f4;color:#8a94a3;font-size:12px;line-height:1.5;">
          ${BRAND} Portal &middot; automated message.<br>If you weren&rsquo;t expecting this, you can ignore it.
        </td></tr>
      </table>
      <div style="max-width:480px;color:#aab2bd;font-size:11px;padding:12px 0;">&copy; ${BRAND}</div>
    </td></tr>
  </table>
</body></html>`;
}
function button(href, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0;"><tr>
    <td align="center" style="border-radius:8px;background:#1e66ff;">
      <a href="${href}" style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${label}</a>
    </td></tr></table>`;
}
function stripHtml(html = "") {
  return html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function esc(s = "") {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

// src/routes/auth.js
async function handle(request, env, ctx, url) {
  const path = url.pathname;
  if (path === "/auth/login" && request.method === "POST") {
    const { username, password } = await request.json().catch(() => ({}));
    if (!username || !password) return error("Username and password required", 400, env, request);
    const user = await env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(username).first();
    const ok = user && user.status !== "Disabled" && await verifyPassword(password, user);
    await logLogin(env, request, username, ok ? "success" : "fail");
    if (!ok) return error("Invalid login credentials.", 401, env, request);
    if (user.password_algo !== "pbkdf2") {
      const newHash = await hashPassword(password);
      await env.DB.prepare("UPDATE users SET password_hash=?, password_algo='pbkdf2', updated_at=datetime('now') WHERE username=?").bind(newHash, username).run();
    }
    const { token, expires } = await createSession(env, username, null);
    const perms = await permissionsFor(env, username);
    return json({
      ok: true,
      token,
      expires,
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
  if (path === "/auth/refresh" && request.method === "POST") {
    const sess = await requireSession(env, request);
    if (!sess) return error("Not authenticated", 401, env, request);
    const { token, expires } = await createSession(env, sess.user.username, sess.session.device_id);
    await destroySession(env, sess.session.token);
    const perms = await permissionsFor(env, sess.user.username);
    return json({ ok: true, token, expires, user: shapeUser(sess.user, perms) }, {}, env, request);
  }
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
  if (path === "/auth/forgot-password" && request.method === "POST") {
    const { username, email } = await request.json().catch(() => ({}));
    const ident = (username || email || "").trim();
    if (!ident) return error("Username or email required", 400, env, request);
    const user = await env.DB.prepare(
      "SELECT * FROM users WHERE username = ? OR (email IS NOT NULL AND lower(email) = lower(?))"
    ).bind(ident, ident).first();
    if (user && user.status !== "Disabled" && user.email) {
      const token = await issuePasswordToken(env, user.username, 1);
      const resetUrl = `${appBase(env)}/reset-password.html?token=${token}`;
      const msg = resetEmail({ name: user.first_name || user.username, resetUrl, appUrl: appBase(env) });
      await sendEmail(env, { to: user.email, ...msg });
    }
    return json({ ok: true, message: "If that account exists, a reset link has been sent." }, {}, env, request);
  }
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
async function loginHistory(request, env, ctx, url) {
  const sess = await requireSession(env, request);
  if (!sess) return error("Not authenticated", 401, env, request);
  const { results } = await env.DB.prepare(
    "SELECT username, device_id, ip, outcome, at FROM login_history ORDER BY at DESC LIMIT 200"
  ).all();
  return json({ ok: true, history: results || [] }, {}, env, request);
}
async function setPassword(env, username, newPassword) {
  const hash = await hashPassword(newPassword);
  await env.DB.prepare(
    "UPDATE users SET password_hash=?, password_algo='pbkdf2', must_change_password=0, updated_at=datetime('now') WHERE username=?"
  ).bind(hash, username).run();
}
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
    ...perms
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
  } catch {
  }
}

// src/routes/users.js
var WELCOME_TOKEN_HOURS = 72;
async function requireAdmin(env, request) {
  const sess = await requireSession(env, request);
  if (!sess) return { err: error("Not authenticated", 401, env, request) };
  const perms = await permissionsFor(env, sess.user.username);
  if (perms.FullAccess !== "Yes" && perms.Users !== "Yes")
    return { err: error("Forbidden", 403, env, request) };
  return { sess };
}
async function handle2(request, env, ctx, url) {
  const path = url.pathname;
  if (path === "/user" && request.method === "GET") {
    const username = url.searchParams.get("u");
    if (!username) return error("Missing ?u=", 400, env, request);
    const user = await env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(username).first();
    if (!user) return json({ found: false }, {}, env, request);
    const perms = await permissionsFor(env, username);
    return json({ found: true, user: shapeUser2(user, perms) }, {}, env, request);
  }
  if (path === "/users" && request.method === "GET") {
    const { results } = await env.DB.prepare("SELECT * FROM users ORDER BY username").all();
    const out = [];
    for (const u of results || []) out.push(shapeUser2(u, await permissionsFor(env, u.username)));
    return json({ Users: out }, {}, env, request);
  }
  if (path === "/users" && request.method === "POST") {
    const gate = await requireAdmin(env, request);
    if (gate.err) return gate.err;
    const b = await request.json().catch(() => ({}));
    if (!b.Username) return error("Username required", 400, env, request);
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
      b.EngineerNumber || null,
      b.FirstName || null,
      b.LastName || null,
      b.Username,
      b.Email || null,
      b.VehicleAssigned || null,
      b.EmploymentType || null,
      b.Status || "Active",
      b.SharePointPath || null,
      profileJson
    ).run();
    if (b.Password) {
      const bad = validatePassword(b.Password);
      if (bad) return error(bad, 400, env, request);
      const hash = await hashPassword(b.Password);
      const force = b.ForceChange === false ? 0 : 1;
      await env.DB.prepare("UPDATE users SET password_hash=?, password_algo='pbkdf2', must_change_password=? WHERE username=?").bind(hash, force, b.Username).run();
    }
    for (const key of PERMISSION_KEYS) {
      if (key in b) {
        const val = String(b[key]).toLowerCase() === "yes" ? 1 : 0;
        await env.DB.prepare(`
          INSERT INTO user_permissions (username, permission, value) VALUES (?,?,?)
          ON CONFLICT(username, permission) DO UPDATE SET value=excluded.value
        `).bind(b.Username, key, val).run();
      }
    }
    let welcomeEmailed = false;
    if (isNewUser && b.Email) {
      const token = await issuePasswordToken(env, b.Username, WELCOME_TOKEN_HOURS);
      const setUrl = `${appBase(env)}/reset-password.html?token=${token}`;
      const msg = welcomeEmail({
        name: b.FirstName || b.Username,
        username: b.Username,
        setUrl,
        ttlHours: WELCOME_TOKEN_HOURS,
        appUrl: appBase(env)
      });
      const res = await sendEmail(env, { to: b.Email, ...msg });
      welcomeEmailed = !!res.ok;
    }
    return json({ ok: true, isNewUser, welcomeEmailed }, {}, env, request);
  }
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
    await env.DB.prepare("DELETE FROM sessions WHERE username=?").bind(b.username).run();
    return json({ ok: true, tempPassword: tempProvided ? void 0 : newPassword }, {}, env, request);
  }
  if (path === "/users/resend-welcome" && request.method === "POST") {
    const gate = await requireAdmin(env, request);
    if (gate.err) return gate.err;
    const b = await request.json().catch(() => ({}));
    if (!b.username) return error("username required", 400, env, request);
    const user = await env.DB.prepare("SELECT username, first_name, email FROM users WHERE username=?").bind(b.username).first();
    if (!user) return error("User not found", 404, env, request);
    if (!user.email) return error("That user has no email address on file.", 400, env, request);
    const token = await issuePasswordToken(env, user.username, WELCOME_TOKEN_HOURS);
    const setUrl = `${appBase(env)}/reset-password.html?token=${token}`;
    const msg = welcomeEmail({
      name: user.first_name || user.username,
      username: user.username,
      setUrl,
      ttlHours: WELCOME_TOKEN_HOURS,
      appUrl: appBase(env)
    });
    const res = await sendEmail(env, { to: user.email, ...msg });
    if (!res.ok) return error("Email could not be sent \u2014 check the email configuration.", 502, env, request);
    return json({ ok: true, sent: true, email: user.email }, {}, env, request);
  }
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
      env.DB.prepare("DELETE FROM devices WHERE username=?").bind(b.username)
    ]);
    return json({ ok: true }, {}, env, request);
  }
  return error("Unknown user route", 404, env, request);
}
var PERMISSION_KEYS = [
  "FullAccess",
  "Users",
  "DeviceAdmin",
  "CheckInOut",
  "Vehicles",
  "Holiday",
  "HolidayAdmin",
  "EngineersHoursMenu",
  "HoursDashboard",
  "PurchaseOrders",
  "Sites",
  "AddSite",
  "Assets",
  "MyDocuments",
  "Weekly",
  "Forms",
  "Compliance",
  "Projects",
  "ProjectsAdmin",
  "TimesheetAdmin",
  "LabourPlanning",
  "SLA"
];
function shapeUser2(u, perms) {
  let profile = {};
  try {
    profile = u.profile ? JSON.parse(u.profile) : {};
  } catch {
    profile = {};
  }
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
    ...perms
  };
}

// src/routes/devices.js
async function handle3(request, env, ctx, url) {
  const path = url.pathname;
  if (path === "/device/check-device" && request.method === "POST") {
    const { username, deviceId } = await request.json().catch(() => ({}));
    if (!username || !deviceId) return error("username and deviceId required", 400, env, request);
    const dev = await env.DB.prepare("SELECT * FROM devices WHERE device_id = ?").bind(deviceId).first();
    if (!dev) {
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
    const existing = await env.DB.prepare("SELECT * FROM devices WHERE device_id = ?").bind(deviceId).first();
    if (existing && existing.username !== username)
      return json({ status: "DEVICE_MISMATCH" }, {}, env, request);
    await env.DB.prepare(`
      INSERT INTO devices (device_id, username, label) VALUES (?,?,?)
      ON CONFLICT(device_id) DO UPDATE SET username=excluded.username, label=excluded.label
    `).bind(deviceId, username, label || null).run();
    return json({ status: "OK" }, {}, env, request);
  }
  if (path === "/device/list" && request.method === "GET") {
    const sess = await requireSession(env, request);
    if (!sess) return error("Not authenticated", 401, env, request);
    const u = url.searchParams.get("u");
    const stmt = u ? env.DB.prepare("SELECT * FROM devices WHERE username = ? ORDER BY registered_at DESC").bind(u) : env.DB.prepare("SELECT * FROM devices ORDER BY registered_at DESC");
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

// src/routes/holidays.js
async function handle4(request, env, ctx, url) {
  const headers = corsHeaders(env, request);
  const json2 = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });
  const text = (msg, status = 200) => new Response(msg, { status, headers });
  const path = url.pathname;
  const method = request.method.toUpperCase();
  let user = request.headers.get("X-User");
  let role = request.headers.get("X-Role") || "Engineer";
  if (!user) {
    const sess = await requireSession(env, request);
    if (sess) {
      user = sess.user.username;
      const perms = await permissionsFor(env, user);
      role = perms.FullAccess === "Yes" || perms.HolidayAdmin === "Yes" ? "Admin" : "Engineer";
    }
  }
  if (!user) return text("Unauthorised", 401);
  const year = getYear(url);
  const isAdmin = ["Admin", "Director"].includes(role);
  async function cfgGet(key) {
    const row = await env.DB.prepare("SELECT value FROM app_config WHERE key = ?").bind(key).first();
    return row ? JSON.parse(row.value) : null;
  }
  async function cfgPut(key, val) {
    await env.DB.prepare(
      "INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).bind(key, JSON.stringify(val)).run();
  }
  async function getYearConfig() {
    return await cfgGet(`holiday:config:${year}`) || { defaultAllowance: 28 };
  }
  async function getDefaultAllowance() {
    return Number((await getYearConfig()).defaultAllowance ?? 28);
  }
  async function getBankHolidays() {
    return await cfgGet(`holiday:bankholidays:${year}`) || [];
  }
  async function getShutdownDays() {
    return await cfgGet(`holiday:shutdown:${year}`) || [];
  }
  async function getUserAllowance(username) {
    const row = await env.DB.prepare(
      "SELECT allowance FROM holiday_allowance WHERE year = ? AND username = ?"
    ).bind(year, username).first();
    if (row && Number.isFinite(Number(row.allowance))) return Number(row.allowance);
    return getDefaultAllowance();
  }
  async function listAllowancesMap() {
    const { results } = await env.DB.prepare(
      "SELECT username, allowance FROM holiday_allowance WHERE year = ?"
    ).bind(year).all();
    const out = {};
    for (const r of results || []) if (Number.isFinite(Number(r.allowance))) out[r.username] = Number(r.allowance);
    return out;
  }
  async function getActiveUsers() {
    const { results } = await env.DB.prepare(
      "SELECT username FROM users WHERE status = 'Active'"
    ).all();
    return (results || []).map((r) => r.username).filter(Boolean);
  }
  async function logAction(requestId, action, by) {
    await env.DB.prepare(
      "INSERT INTO holiday_log (request_id, action, by_user, at) VALUES (?,?,?,?)"
    ).bind(requestId, action, by, (/* @__PURE__ */ new Date()).toISOString()).run();
  }
  async function ensureSystemDaysForUser(username) {
    const [bank, shut] = await Promise.all([getBankHolidays(), getShutdownDays()]);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const eng = username.replace(".", " ");
    for (const b of bank) {
      if (!b?.date) continue;
      await env.DB.prepare(`
        INSERT INTO holiday_system_days (kind, year, date, username, id, engineer, label, days, category, worked, status, created_at)
        VALUES ('bankholiday', ?, ?, ?, ?, ?, ?, 1, 'BankHoliday', 0, 'Deducted', ?)
        ON CONFLICT(kind, year, date, username) DO NOTHING
      `).bind(year, b.date, username, `BH-${year}-${b.date}-${username}`, eng, b.label || "Bank Holiday", now).run();
    }
    for (const s of shut) {
      if (!s?.date) continue;
      await env.DB.prepare(`
        INSERT INTO holiday_system_days (kind, year, date, username, id, engineer, label, days, category, worked, status, created_at)
        VALUES ('shutdown', ?, ?, ?, ?, ?, ?, 1, 'Shutdown', 0, 'Deducted', ?)
        ON CONFLICT(kind, year, date, username) DO NOTHING
      `).bind(year, s.date, username, `SD-${year}-${s.date}-${username}`, eng, s.label || "Company Shutdown", now).run();
    }
  }
  async function listHolidayRequestsForYear() {
    const { results } = await env.DB.prepare("SELECT * FROM holidays WHERE year = ?").bind(year).all();
    return (results || []).map(reqOut);
  }
  async function getHolidayById(id) {
    const row = await env.DB.prepare("SELECT * FROM holidays WHERE id = ?").bind(id).first();
    return row ? reqOut(row) : null;
  }
  async function listSystemRecordsForYear() {
    const { results } = await env.DB.prepare("SELECT * FROM holiday_system_days WHERE year = ?").bind(year).all();
    return (results || []).map(sysOut);
  }
  if (path === "/holiday/request" && method === "POST") {
    const body = await request.json();
    const id = `H-${Date.now()}`;
    const start = body.start, end = body.end;
    if (!start || !end) return text("Missing start/end", 400);
    if (new Date(end) < new Date(start)) return text("End before start", 400);
    const note = String(body.notes || "").trim();
    if (!note) return text("Notes (reminder) required", 400);
    const days = countWeekdaysInclusive(start, end);
    if (days <= 0) return text("No weekdays in range", 400);
    await env.DB.prepare(`
      INSERT INTO holidays (id, engineer, username, year, start_date, end_date, days, type, notes, status, submitted_at)
      VALUES (?,?,?,?,?,?,?,?,?,'Pending',?)
    `).bind(id, user.replace(".", " "), user, year, start, end, days, body.type || null, note, (/* @__PURE__ */ new Date()).toISOString()).run();
    await logAction(id, "Submitted", user);
    return json2({ success: true, id });
  }
  if (path === "/holiday/cancel" && method === "POST") {
    const { id } = await request.json();
    if (!id) return text("Missing id", 400);
    const record = await getHolidayById(id);
    if (!record) return text("Not found", 404);
    if (record.username !== user) return text("Forbidden", 403);
    if (record.status !== "Pending") return text("Only pending requests can be self-cancelled", 409);
    await env.DB.prepare(
      "UPDATE holidays SET status='Cancelled', cancelled_by=?, decision_at=? WHERE id=?"
    ).bind(user, (/* @__PURE__ */ new Date()).toISOString(), id).run();
    await logAction(id, "Cancelled by engineer", user);
    return json2({ success: true });
  }
  if (path === "/holiday/delete-own" && method === "POST") {
    const { id } = await request.json();
    if (!id) return text("Missing id", 400);
    const record = await getHolidayById(id);
    if (!record) return text("Not found", 404);
    if (record.username !== user) return text("Forbidden", 403);
    if (!["Cancelled", "Rejected"].includes(record.status)) {
      return text("Can only delete cancelled or rejected requests", 409);
    }
    await env.DB.prepare("DELETE FROM holidays WHERE id=?").bind(id).run();
    await logAction(id, "Deleted by engineer", user);
    return json2({ success: true });
  }
  if (path === "/holiday/cancel-approved" && method === "POST") {
    if (!isAdmin) return text("Forbidden", 403);
    const { id } = await request.json();
    if (!id) return text("Missing id", 400);
    const record = await getHolidayById(id);
    if (!record) return text("Not found", 404);
    if (record.status !== "Approved") return text("Only approved holidays can be cancelled here", 409);
    await env.DB.prepare(
      "UPDATE holidays SET status='Cancelled', cancelled_by=?, decision_at=?, cancel_note=? WHERE id=?"
    ).bind(user, (/* @__PURE__ */ new Date()).toISOString(), "Cancelled by admin after approval", id).run();
    await logAction(id, "Approval cancelled by admin", user);
    return json2({ success: true });
  }
  if (path === "/holiday/my" && method === "GET") {
    await ensureSystemDaysForUser(user);
    const reqs = (await listHolidayRequestsForYear()).filter((h) => h.username === user);
    const sys = (await listSystemRecordsForYear()).filter((s) => s.username === user);
    const results = [...reqs, ...sys];
    results.sort((a, b) => {
      const da = a.date || a.start || "9999-12-31";
      const db = b.date || b.start || "9999-12-31";
      return da.localeCompare(db);
    });
    return json2(results);
  }
  if (path === "/holiday/summary" && method === "GET") {
    await ensureSystemDaysForUser(user);
    const allowance = await getUserAllowance(user);
    const all = await listHolidayRequestsForYear();
    let approvedHoliday = 0;
    for (const h of all) {
      if (h.username === user && h.status === "Approved") approvedHoliday += h.days || 0;
    }
    const sys = await listSystemRecordsForYear();
    let sysDeducted = 0, sysCredited = 0;
    for (const s of sys) {
      if (s.username !== user) continue;
      if (!isWeekdayISO(s.date)) continue;
      if (s.worked === true || s.status === "Credited") sysCredited += s.days || 1;
      else sysDeducted += s.days || 1;
    }
    const used = approvedHoliday + sysDeducted - sysCredited;
    return json2({ allowance, used, remaining: allowance - used, breakdown: { approvedHoliday, sysDeducted, sysCredited } });
  }
  if (path === "/holiday/all" && method === "GET") {
    if (!isAdmin) return text("Forbidden", 403);
    return json2(await listHolidayRequestsForYear());
  }
  if (["/holiday/approve", "/holiday/reject"].includes(path) && method === "POST") {
    if (!isAdmin) return text("Forbidden", 403);
    const { id } = await request.json();
    if (!id) return text("Missing id", 400);
    const record = await getHolidayById(id);
    if (!record) return text("Not found", 404);
    const status = path.endsWith("approve") ? "Approved" : "Rejected";
    await env.DB.prepare(
      "UPDATE holidays SET status=?, approved_by=?, decision_at=? WHERE id=?"
    ).bind(status, user, (/* @__PURE__ */ new Date()).toISOString(), id).run();
    await logAction(id, status, user);
    return json2({ success: true });
  }
  if (path === "/holiday/config" && method === "GET") {
    if (!isAdmin) return text("Forbidden", 403);
    const cfg = await getYearConfig();
    const [bank, shut, allowances] = await Promise.all([getBankHolidays(), getShutdownDays(), listAllowancesMap()]);
    return json2({ year, defaultAllowance: Number(cfg.defaultAllowance ?? 28), bankholidays: bank, shutdown: shut, allowances });
  }
  if (path === "/holiday/set-year-config" && method === "POST") {
    if (!isAdmin) return text("Forbidden", 403);
    const body = await request.json();
    const defaultAllowance = Number(body.defaultAllowance);
    if (!Number.isFinite(defaultAllowance)) return text("Bad payload", 400);
    await cfgPut(`holiday:config:${year}`, { defaultAllowance });
    return json2({ success: true });
  }
  if (path === "/holiday/set-allowance" && method === "POST") {
    if (!isAdmin) return text("Forbidden", 403);
    const body = await request.json();
    const username = body.username;
    const allowance = Number(body.allowance);
    if (!username || !Number.isFinite(allowance)) return text("Bad payload", 400);
    await env.DB.prepare(
      "INSERT INTO holiday_allowance (year, username, allowance) VALUES (?,?,?) ON CONFLICT(year, username) DO UPDATE SET allowance=excluded.allowance"
    ).bind(year, username, allowance).run();
    return json2({ success: true });
  }
  if (path === "/holiday/set-bankholidays" && method === "POST") {
    if (!isAdmin) return text("Forbidden", 403);
    const body = await request.json();
    const days = Array.isArray(body.days) ? body.days : null;
    if (!days) return text("Bad payload", 400);
    const oldDays = await getBankHolidays();
    const newDates = new Set(days.map((d) => d.date));
    const removed = oldDays.filter((b) => !newDates.has(b.date)).map((b) => b.date);
    if (removed.length) await deleteSystemDays(env, "bankholiday", year, removed);
    await cfgPut(`holiday:bankholidays:${year}`, days);
    return json2({ success: true });
  }
  if (path === "/holiday/set-shutdown" && method === "POST") {
    if (!isAdmin) return text("Forbidden", 403);
    const body = await request.json();
    const days = Array.isArray(body.days) ? body.days : null;
    if (!days) return text("Bad payload", 400);
    const oldDays = await getShutdownDays();
    const newDates = new Set(days.map((d) => d.date));
    const removed = oldDays.filter((s) => !newDates.has(s.date)).map((s) => s.date);
    if (removed.length) await deleteSystemDays(env, "shutdown", year, removed);
    await cfgPut(`holiday:shutdown:${year}`, days);
    return json2({ success: true });
  }
  if (path === "/holiday/toggle-worked" && method === "POST") {
    if (!isAdmin) return text("Forbidden", 403);
    const body = await request.json();
    const kind = body.kind, username = body.username, date = body.date, worked = !!body.worked;
    if (!["bankholiday", "shutdown"].includes(kind) || !username || !date) return text("Bad payload", 400);
    await ensureSystemDaysForUser(username);
    const row = await env.DB.prepare(
      "SELECT id FROM holiday_system_days WHERE kind=? AND year=? AND date=? AND username=?"
    ).bind(kind, year, date, username).first();
    if (!row) return text("Not found", 404);
    await env.DB.prepare(
      "UPDATE holiday_system_days SET worked=?, status=?, updated_by=?, updated_at=? WHERE kind=? AND year=? AND date=? AND username=?"
    ).bind(worked ? 1 : 0, worked ? "Credited" : "Deducted", user, (/* @__PURE__ */ new Date()).toISOString(), kind, year, date, username).run();
    await logAction(row.id, worked ? "Worked (Credited)" : "Reverted (Deducted)", user);
    return json2({ success: true });
  }
  if (path === "/holiday/admin-summary" && method === "GET") {
    if (!isAdmin) return text("Forbidden", 403);
    const usernames = await getActiveUsers();
    for (const u of usernames) await ensureSystemDaysForUser(u);
    const all = await listHolidayRequestsForYear();
    const sys = await listSystemRecordsForYear();
    const list = [];
    for (const u of usernames.slice().sort((a, b) => a.localeCompare(b))) {
      const allowance = await getUserAllowance(u);
      let approvedHoliday = 0;
      for (const h of all) if (h.username === u && h.status === "Approved") approvedHoliday += h.days || 0;
      let sysDeducted = 0, sysCredited = 0;
      for (const s of sys) {
        if (s.username !== u) continue;
        if (!isWeekdayISO(s.date)) continue;
        if (s.worked === true || s.status === "Credited") sysCredited += s.days || 1;
        else sysDeducted += s.days || 1;
      }
      const used = approvedHoliday + sysDeducted - sysCredited;
      list.push({ username: u, name: u.replace(".", " "), allowance, used, remaining: allowance - used });
    }
    return json2({ year, engineers: list });
  }
  if (path === "/holiday/calendar" && method === "GET") {
    if (!isAdmin) return text("Forbidden", 403);
    const month = getMonth(url);
    const monthStart = new Date(Date.UTC(year, month - 1, 1));
    const monthEnd = new Date(Date.UTC(year, month, 0));
    const daysInMonth = monthEnd.getUTCDate();
    const usernames = await getActiveUsers();
    for (const u of usernames) await ensureSystemDaysForUser(u);
    const all = await listHolidayRequestsForYear();
    const sys = await listSystemRecordsForYear();
    const engineers = [];
    for (const u of usernames.slice().sort((a, b) => a.localeCompare(b))) {
      const cells = {};
      for (const h of all) {
        if (h.username !== u || h.status !== "Approved") continue;
        const overlap = weekdayOverlapCount(h.start, h.end, monthStart, monthEnd);
        if (!overlap) continue;
        const s = /* @__PURE__ */ new Date(h.start + "T00:00:00Z");
        const e = /* @__PURE__ */ new Date(h.end + "T00:00:00Z");
        for (let d = new Date(s); d <= e; d.setUTCDate(d.getUTCDate() + 1)) {
          const day = d.getUTCDay();
          if (day === 0 || day === 6) continue;
          if (d < monthStart || d > monthEnd) continue;
          const di = isoDate(d);
          cells[di] = {
            kind: "holiday",
            type: h.type || "Annual Leave",
            note: h.notes || "",
            label: "Holiday",
            username: u,
            requestId: h.id,
            rangeStart: h.start,
            rangeEnd: h.end,
            days: h.days
          };
        }
      }
      for (const s of sys) {
        if (s.username !== u) continue;
        const di = s.date;
        if (!di) continue;
        const d = /* @__PURE__ */ new Date(di + "T00:00:00Z");
        if (d < monthStart || d > monthEnd) continue;
        if (!isWeekdayISO(di)) continue;
        if (!cells[di]) {
          cells[di] = {
            kind: s.category === "Shutdown" ? "shutdown" : "bankholiday",
            type: s.category,
            note: "",
            label: s.label || s.category,
            worked: !!s.worked,
            username: u
          };
        }
      }
      engineers.push({ username: u, name: u.replace(".", " "), cells });
    }
    return json2({ year, month, daysInMonth, monthStart: isoDate(monthStart), monthEnd: isoDate(monthEnd), engineers });
  }
  if (path === "/holiday/debug-users" && method === "GET") {
    if (!isAdmin) return text("Forbidden", 403);
    const activeUsers = await getActiveUsers();
    return json2({ activeUsersCount: activeUsers.length, activeUsers: activeUsers.slice(0, 10) });
  }
  return text("Not Found", 404);
}
function reqOut(r) {
  return {
    id: r.id,
    engineer: r.engineer,
    username: r.username,
    year: r.year,
    start: r.start_date,
    end: r.end_date,
    days: r.days,
    type: r.type,
    notes: r.notes,
    status: r.status,
    submittedAt: r.submitted_at,
    approvedBy: r.approved_by,
    decisionAt: r.decision_at,
    cancelledBy: r.cancelled_by,
    cancelNote: r.cancel_note
  };
}
function sysOut(r) {
  return {
    id: r.id,
    username: r.username,
    engineer: r.engineer,
    year: r.year,
    date: r.date,
    label: r.label,
    days: r.days,
    category: r.category,
    worked: !!r.worked,
    status: r.status,
    createdAt: r.created_at,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at
  };
}
async function deleteSystemDays(env, kind, year, dates) {
  const placeholders = dates.map(() => "?").join(",");
  await env.DB.prepare(
    `DELETE FROM holiday_system_days WHERE kind=? AND year=? AND date IN (${placeholders})`
  ).bind(kind, year, ...dates).run();
}
function getYear(url) {
  const y = url.searchParams.get("year");
  const year = y ? parseInt(y, 10) : (/* @__PURE__ */ new Date()).getFullYear();
  return Number.isFinite(year) ? year : (/* @__PURE__ */ new Date()).getFullYear();
}
function getMonth(url) {
  const m = url.searchParams.get("month");
  const month = m ? parseInt(m, 10) : (/* @__PURE__ */ new Date()).getMonth() + 1;
  return Number.isFinite(month) && month >= 1 && month <= 12 ? month : (/* @__PURE__ */ new Date()).getMonth() + 1;
}
function isoDate(d) {
  return new Date(d).toISOString().split("T")[0];
}
function countWeekdaysInclusive(startISO, endISO) {
  const s = /* @__PURE__ */ new Date(startISO + "T00:00:00");
  const e = /* @__PURE__ */ new Date(endISO + "T00:00:00");
  if (isNaN(s) || isNaN(e)) return 0;
  if (e < s) return 0;
  let days = 0;
  for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) days++;
  }
  return days;
}
function isWeekdayISO(dateISO) {
  const [y, m, d] = dateISO.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day !== 0 && day !== 6;
}
function weekdayOverlapCount(startISO, endISO, monthStart, monthEnd) {
  const s = /* @__PURE__ */ new Date(startISO + "T00:00:00");
  const e = /* @__PURE__ */ new Date(endISO + "T00:00:00");
  const a = s < monthStart ? monthStart : s;
  const b = e > monthEnd ? monthEnd : e;
  if (b < a) return 0;
  let days = 0;
  for (let d = new Date(a); d <= b; d.setDate(d.getDate() + 1)) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) days++;
  }
  return days;
}

// src/routes/assets.js
async function handle5(request, env, ctx, url) {
  const cors = corsHeaders(env, request);
  const { pathname, searchParams } = url;
  const method = request.method.toUpperCase();
  const json2 = (data, code = 200) => new Response(JSON.stringify(data, null, 2), { status: code, headers: { ...cors, "Content-Type": "application/json" } });
  if (method === "POST" && pathname === "/upload-asset-image") {
    try {
      const form = await request.formData();
      const file = form.get("file");
      const assetId = form.get("assetId");
      if (!file || !assetId) return json2({ ok: false, error: "Missing file or assetId" }, 400);
      const ext = file.name?.split(".").pop() || "jpg";
      const list = await env.ASSET_BUCKET.list({ prefix: `${assetId}/` });
      const nextNum = (list.objects?.length || 0) + 1;
      const filename = `${assetId}/image${nextNum}.${ext}`;
      await env.ASSET_BUCKET.put(filename, await file.arrayBuffer(), {
        httpMetadata: { contentType: file.type || "image/jpeg" }
      });
      const publicUrl = `${url.origin}/asset-image?key=${encodeURIComponent(filename)}`;
      return json2({ ok: true, url: publicUrl, key: filename });
    } catch (err) {
      return json2({ ok: false, error: err.message }, 500);
    }
  }
  if (method === "GET" && pathname === "/asset-image") {
    const key = searchParams.get("key");
    if (!key) return json2({ error: "Missing key" }, 400);
    const obj = await env.ASSET_BUCKET.get(key);
    if (!obj) return new Response("Not found", { status: 404 });
    return new Response(obj.body, {
      status: 200,
      headers: { ...cors, "Content-Type": obj.httpMetadata?.contentType || "image/jpeg", "Cache-Control": "public, max-age=3600" }
    });
  }
  if (method === "GET" && pathname === "/asset-thumb") {
    try {
      const key = searchParams.get("key");
      if (!key) return json2({ error: "Missing key" }, 400);
      const obj = await env.ASSET_BUCKET.get(key);
      if (!obj) return new Response("Not found", { status: 404 });
      return new Response(obj.body, {
        headers: { ...cors, "Content-Type": obj.httpMetadata?.contentType || "image/jpeg", "Cache-Control": "public, max-age=3600" },
        cf: { image: { width: 200, height: 200, fit: "cover", quality: 50, format: "auto" } }
      });
    } catch (err) {
      return json2({ error: "Thumbnail generation failed", details: err.message }, 500);
    }
  }
  if (method === "POST" && pathname === "/delete-asset-image") {
    try {
      const body = await request.json();
      const { assetId, key, url: imageUrl } = body;
      if (!assetId || !key && !imageUrl) return json2({ ok: false, error: "Missing assetId or url/key" }, 400);
      let r2Key = key;
      if (!r2Key && imageUrl) r2Key = decodeURIComponent((imageUrl.split("key=")[1] || "").split("&")[0]);
      if (!r2Key) return json2({ ok: false, error: "Invalid image URL or key" }, 400);
      await env.ASSET_BUCKET.delete(r2Key);
      const asset = await getAsset(env, assetId);
      if (!asset) return json2({ ok: false, error: "Asset not found" }, 404);
      const fullUrl = imageUrl || `${url.origin}/asset-image?key=${encodeURIComponent(r2Key)}`;
      asset.images = (asset.images || []).filter((u) => u !== fullUrl);
      await putAsset(env, asset);
      return json2({ ok: true, message: "Image deleted", removedKey: r2Key });
    } catch (err) {
      return json2({ ok: false, error: "Failed to delete image", details: err.message }, 500);
    }
  }
  if (method === "GET" && pathname === "/assets") {
    try {
      const user = searchParams.get("user");
      const stmt = user ? env.DB.prepare("SELECT data FROM assets WHERE assigned_to = ?").bind(user) : env.DB.prepare("SELECT data FROM assets");
      const { results } = await stmt.all();
      const assets = (results || []).map((r) => JSON.parse(r.data));
      return json2({ assets });
    } catch (err) {
      return json2({ error: "Failed to fetch assets", details: err.message }, 500);
    }
  }
  if (method === "POST" && pathname === "/asset/add") {
    try {
      const body = await request.json();
      if (!body.id) return json2({ error: "Missing ID" }, 400);
      await putAsset(env, body);
      return json2({ ok: true, message: `Asset ${body.id} added.` });
    } catch (err) {
      return json2({ error: "Failed to add asset", details: err.message }, 500);
    }
  }
  if (method === "POST" && pathname === "/asset/update") {
    try {
      const body = await request.json();
      if (!body.id) return json2({ error: "Missing ID" }, 400);
      const existing = await getAsset(env, body.id);
      const updated = { ...existing, ...body };
      await putAsset(env, updated);
      if (existing && existing.assignedTo !== body.assignedTo) {
        const log = {
          assetID: body.id,
          from: existing.assignedTo || "Unassigned",
          to: body.assignedTo,
          timestamp: (/* @__PURE__ */ new Date()).toISOString(),
          pdfURL: updated.pdfURL || null
        };
        await putTransfer(env, log);
      }
      return json2({ ok: true, message: `Asset ${body.id} updated.` });
    } catch (err) {
      return json2({ error: "Failed to update asset", details: err.message }, 500);
    }
  }
  if (method === "POST" && pathname === "/transfer") {
    try {
      const log = await request.json();
      if (!log.assetID) return json2({ error: "Missing assetID" }, 400);
      const asset = await getAsset(env, log.assetID);
      if (asset) {
        asset.assignedTo = log.to;
        asset.lastTransfer = log.timestamp || (/* @__PURE__ */ new Date()).toISOString();
        asset.pdfURL = log.pdfURL || asset.pdfURL;
        await putAsset(env, asset);
      }
      await putTransfer(env, log);
      return json2({ ok: true, message: `Transfer logged for ${log.assetID}` });
    } catch (err) {
      return json2({ error: "Failed to log transfer", details: err.message }, 500);
    }
  }
  if (method === "GET" && pathname === "/transfer-log") {
    const assetID = searchParams.get("assetID");
    if (!assetID) return json2({ error: "Missing assetID" }, 400);
    try {
      const { results } = await env.DB.prepare(
        "SELECT data FROM asset_transfers WHERE asset_id = ? ORDER BY id ASC"
      ).bind(assetID).all();
      return json2((results || []).map((r) => JSON.parse(r.data)));
    } catch (err) {
      return json2({ error: "Failed to load logs", details: err.message }, 500);
    }
  }
  if (method === "DELETE" && pathname === "/asset/delete") {
    try {
      const id = searchParams.get("id");
      if (!id) return json2({ error: "Missing ID" }, 400);
      await env.DB.prepare("DELETE FROM assets WHERE id = ?").bind(id).run();
      return json2({ ok: true, message: `Asset ${id} deleted.` });
    } catch (err) {
      return json2({ error: "Failed to delete asset", details: err.message }, 500);
    }
  }
  return json2({ error: "Not found" }, 404);
}
async function getAsset(env, id) {
  const row = await env.DB.prepare("SELECT data FROM assets WHERE id = ?").bind(id).first();
  return row ? JSON.parse(row.data) : null;
}
async function putAsset(env, asset) {
  await env.DB.prepare(`
    INSERT INTO assets (id, assigned_to, data) VALUES (?,?,?)
    ON CONFLICT(id) DO UPDATE SET assigned_to = excluded.assigned_to, data = excluded.data
  `).bind(asset.id, asset.assignedTo || null, JSON.stringify(asset)).run();
}
async function putTransfer(env, log) {
  await env.DB.prepare(
    "INSERT INTO asset_transfers (asset_id, at, data) VALUES (?,?,?)"
  ).bind(log.assetID, log.timestamp || (/* @__PURE__ */ new Date()).toISOString(), JSON.stringify(log)).run();
}

// src/routes/sla.js
async function handle6(request, env, ctx, url) {
  const headers = corsHeaders(env, request);
  const method = request.method.toUpperCase();
  const subpath = url.pathname.replace(/^\/sla(?=\/|$)/, "") || "/";
  const searchParams = url.searchParams;
  if (subpath === "/config") {
    if (method === "GET") return jsonResponse(await getConfig(env), headers);
    if (method === "POST") return jsonResponse(await setConfig(env, await readJson(request)), headers);
  }
  if (subpath === "/jobs" && method === "POST") {
    const job = await createOrUpdateJobFromPayload(env, await readJson(request));
    return jsonResponse(decorateJobWithLiveSla(job), headers, 201);
  }
  if (subpath === "/jobs" && method === "GET") {
    let jobs = (await listJobs(env)).map(decorateJobWithLiveSla);
    const statusFilter = searchParams.get("status");
    const priorityFilter = searchParams.get("priority");
    const overdueFilter = searchParams.get("overdue");
    const siteCodeFilter = searchParams.get("siteCode");
    if (statusFilter) {
      const s = normalizeStatus(statusFilter).toLowerCase();
      jobs = jobs.filter((j) => j.status.toLowerCase() === s);
    }
    if (priorityFilter) jobs = jobs.filter((j) => j.priority === priorityFilter);
    if (siteCodeFilter) jobs = jobs.filter((j) => (j.siteCode || "") === siteCodeFilter);
    if (overdueFilter === "true") jobs = jobs.filter((j) => j.sla?.state === "BREACHED");
    return jsonResponse(jobs, headers);
  }
  if (subpath === "/jobs/for-engineer" && method === "GET") {
    const normId = (s) => (s || "").toLowerCase().replace(/\s+/g, ".").trim();
    const engineer = normId(searchParams.get("engineer"));
    const date = searchParams.get("date");
    let jobs = (await listJobs(env)).filter((j) => normId(j.assignedTo) === engineer);
    if (date) {
      jobs = jobs.filter((j) => {
        if (!j.scheduledAt) return false;
        return new Date(j.scheduledAt).toISOString().slice(0, 10) === date;
      });
    }
    return jsonResponse(jobs.map(decorateJobWithLiveSla), headers);
  }
  if (subpath.startsWith("/job/") && method === "PUT") {
    const id = subpath.split("/").filter(Boolean)[1];
    if (!id) return jsonResponse({ error: "Missing ID" }, headers, 400);
    const body = await readJson(request);
    const patch = {
      scheduledAt: body.scheduledStart || body.scheduledAt,
      assignedTo: Array.isArray(body.assignedEngineers) ? body.assignedEngineers[0] || "" : body.assignedTo || "",
      changedBy: body.changedBy || "scheduler"
    };
    const updated = await patchJob(env, id, patch);
    return updated ? jsonResponse(decorateJobWithLiveSla(updated), headers) : jsonResponse({ error: "Not found" }, headers, 404);
  }
  if (subpath.startsWith("/jobs/")) {
    const parts = subpath.split("/").filter(Boolean);
    const id = parts[1];
    if (!id) return jsonResponse({ error: "Missing ID" }, headers, 400);
    if (method === "GET" && parts[2] === "export") {
      const job = await getJob(env, id);
      if (!job) return jsonResponse({ error: "Not found" }, headers, 404);
      const decorated = decorateJobWithLiveSla(job);
      const files = await getJobFilesPublicList(env, id);
      const html = buildJobExportHtml(decorated, files, resolveLogo(env));
      const filename = `Job-${safeRef(decorated, id)}.html`;
      return new Response(html, { status: 200, headers: {
        ...headers,
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store"
      } });
    }
    if (method === "GET" && parts[2] === "export.pdf") {
      const job = await getJob(env, id);
      if (!job) return jsonResponse({ error: "Not found" }, headers, 404);
      const decorated = decorateJobWithLiveSla(job);
      const files = await getJobFilesPublicList(env, id);
      const html = buildJobExportHtml(decorated, files, resolveLogo(env));
      const filename = `Job-${safeRef(decorated, id)}.pdf`;
      if (!env.PDFSHIFT_API_KEY) return jsonResponse({ error: "Missing PDFSHIFT_API_KEY" }, headers, 500);
      const pdf = await htmlToPdf(env, html);
      if (!pdf.ok) return jsonResponse({ error: "PDF generation failed" }, headers, 500);
      return new Response(pdf.buffer, { status: 200, headers: {
        ...headers,
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store"
      } });
    }
    if (parts[2] === "files" && method === "POST") {
      const filename = searchParams.get("filename");
      const form = await request.formData();
      const file = form.get("file");
      if (!filename || !file) return jsonResponse({ error: "Missing file" }, headers, 400);
      const key = `jobs/${id}/photos/${filename}`;
      await env.JOB_FILES.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
      return jsonResponse({ ok: true, publicURL: r2Url(env, key) }, headers, 201);
    }
    if (parts[2] === "files" && method === "GET") {
      const listed = await env.JOB_FILES.list({ prefix: `jobs/${id}/photos/` });
      return jsonResponse({ files: listed.objects.map((o) => ({
        name: o.key.split("/").pop(),
        publicURL: r2Url(env, o.key)
      })) }, headers);
    }
    if (parts[2] === "signature" && method === "POST") {
      const { signedBy, signedAt, signatureBase64 } = await readJson(request);
      if (!signedBy || !signatureBase64) return jsonResponse({ error: "Missing signature data" }, headers, 400);
      const base64 = signatureBase64.split(",")[1];
      const binary = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const key = `jobs/${id}/signature/${Date.now()}.png`;
      await env.JOB_FILES.put(key, binary, { httpMetadata: { contentType: "image/png" } });
      const job = await getJob(env, id);
      if (job) {
        job.signature = { signedBy, signedAt, fileKey: key };
        job.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
        await saveJob(env, job);
      }
      return jsonResponse({ ok: true, key, publicURL: r2Url(env, key) }, headers, 201);
    }
    if (method === "GET") {
      const job = await getJob(env, id);
      return job ? jsonResponse(decorateJobWithLiveSla(job), headers) : jsonResponse({ error: "Not found" }, headers, 404);
    }
    if (method === "PATCH") {
      const updated = await patchJob(env, id, await readJson(request));
      return updated ? jsonResponse(decorateJobWithLiveSla(updated), headers) : jsonResponse({ error: "Not found" }, headers, 404);
    }
  }
  if (subpath === "/pdf" && method === "POST") {
    const { html, filename } = await readJson(request);
    if (!html) return jsonResponse({ error: "Missing HTML" }, headers, 400);
    const pdf = await htmlToPdf(env, html);
    if (!pdf.ok) return jsonResponse({ error: "PDF generation failed" }, headers, 500);
    return new Response(pdf.buffer, { status: 200, headers: {
      ...headers,
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename || "job.pdf"}"`
    } });
  }
  return jsonResponse({ error: "Not found" }, headers, 404);
}
async function readJson(r) {
  const t = await r.text();
  return t ? JSON.parse(t) : {};
}
function jsonResponse(data, headers, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...headers }
  });
}
var CANONICAL_STATUSES = [
  "Pending",
  "Scheduled",
  "Travelling",
  "In Progress",
  "Complete",
  "On Hold",
  "Closed Jobs",
  "Order",
  "Quote"
];
function normalizeStatus(status) {
  if (!status) return "Pending";
  const s = status.toLowerCase().trim();
  if (s === "open" || s === "with contractor - r") return "Pending";
  if (s === "completed") return "Complete";
  if (s === "closed" || s === "cancelled") return "Closed Jobs";
  return CANONICAL_STATUSES.find((x) => x.toLowerCase() === s) || "Pending";
}
async function getJob(env, id) {
  const row = await env.DB.prepare("SELECT data FROM sla_jobs WHERE id = ?").bind(id).first();
  return row ? JSON.parse(row.data) : null;
}
async function listJobs(env) {
  const { results } = await env.DB.prepare("SELECT data FROM sla_jobs").all();
  return (results || []).map((r) => JSON.parse(r.data));
}
async function saveJob(env, job) {
  await env.DB.prepare(`
    INSERT INTO sla_jobs (id, helpdesk_ref, description, priority, status, assigned_to,
                          site_code, raised_at, target_at, scheduled_at, created_at,
                          updated_at, closed_at, data)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      helpdesk_ref=excluded.helpdesk_ref, description=excluded.description,
      priority=excluded.priority, status=excluded.status, assigned_to=excluded.assigned_to,
      site_code=excluded.site_code, raised_at=excluded.raised_at, target_at=excluded.target_at,
      scheduled_at=excluded.scheduled_at, updated_at=excluded.updated_at,
      closed_at=excluded.closed_at, data=excluded.data
  `).bind(
    job.id,
    job.helpdeskRef || null,
    job.description || null,
    job.priority || null,
    job.status || null,
    job.assignedTo || null,
    job.siteCode || null,
    job.raisedAt || null,
    job.targetAt || null,
    job.scheduledAt || null,
    job.createdAt || null,
    job.updatedAt || null,
    job.closedAt || null,
    JSON.stringify(job)
  ).run();
}
async function createOrUpdateJobFromPayload(env, body) {
  const cfg = await getConfig(env);
  const id = body.id || body.reference || crypto.randomUUID();
  const existing = await getJob(env, id);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const status = normalizeStatus(body.status || existing?.status);
  const raisedAt = body.raisedAt || existing?.raisedAt || now;
  const priority = body.priority || existing?.priority || "Priority 4";
  const targetAt = computeSlaTarget(raisedAt, priority, cfg);
  const job = {
    id,
    helpdeskRef: body.reference || existing?.helpdeskRef || id,
    description: body.description || existing?.description || "",
    priority,
    raisedAt,
    targetAt,
    status,
    assignedTo: body.assignedTo || existing?.assignedTo || "",
    siteCode: body.siteCode || existing?.siteCode || "",
    // carried so the siteCode filter works
    scheduledAt: body.scheduledAt || existing?.scheduledAt || null,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    closedAt: status === "Closed Jobs" ? now : existing?.closedAt || null,
    events: existing?.events || [],
    statusHistory: existing?.statusHistory || []
  };
  job.statusHistory.push({ status, at: now, by: body.changedBy || "system" });
  await saveJob(env, job);
  return job;
}
async function patchJob(env, id, patch) {
  const job = await getJob(env, id);
  if (!job) return null;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  job.statusHistory ||= [];
  job.events ||= [];
  if (patch.assignedTo !== void 0) job.assignedTo = patch.assignedTo;
  if (patch.scheduledAt !== void 0) job.scheduledAt = patch.scheduledAt;
  if (patch.siteCode !== void 0) job.siteCode = patch.siteCode;
  if (patch.status) {
    const s = normalizeStatus(patch.status);
    if (s !== job.status) {
      job.status = s;
      job.statusHistory.push({ status: s, at: now, by: patch.changedBy || "system" });
      if (s === "Closed Jobs" && !job.closedAt) job.closedAt = now;
    }
  }
  if (patch.note) {
    job.events.push({ at: now, by: patch.changedBy || "system", type: "note", note: patch.note });
  }
  job.updatedAt = now;
  await saveJob(env, job);
  return job;
}
function computeSlaTarget(raisedAt, priority, cfg) {
  const hrs = cfg.priorities[priority]?.hours || 168;
  return new Date(new Date(raisedAt).getTime() + hrs * 36e5).toISOString();
}
function decorateJobWithLiveSla(job) {
  const target = Date.parse(job.targetAt);
  const state = job.status === "Closed Jobs" || job.status === "Complete" ? "OK" : Date.now() > target ? "BREACHED" : "OK";
  return { ...job, sla: { state, now: (/* @__PURE__ */ new Date()).toISOString() } };
}
var DEFAULT_CONFIG = {
  priorities: {
    "Priority 1": { hours: 4 },
    "Priority 2": { hours: 24 },
    "Priority 3": { hours: 72 },
    "Priority 4": { hours: 168 }
  }
};
async function getConfig(env) {
  const row = await env.DB.prepare("SELECT value FROM app_config WHERE key = 'sla_config'").first();
  return row ? JSON.parse(row.value) : DEFAULT_CONFIG;
}
async function setConfig(env, body) {
  const merged = { ...DEFAULT_CONFIG, ...body };
  await env.DB.prepare(
    "INSERT INTO app_config (key, value) VALUES ('sla_config', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).bind(JSON.stringify(merged)).run();
  return merged;
}
function r2Url(env, key) {
  const base = (env.R2_PUBLIC_BASE || "https://pub-0a9aac7bfc6749bbbdbf9660503968e6.r2.dev").replace(/\/$/, "");
  return `${base}/${key}`;
}
async function getJobFilesPublicList(env, id) {
  if (!env.JOB_FILES) return [];
  const listed = await env.JOB_FILES.list({ prefix: `jobs/${id}/photos/` });
  return listed.objects.map((o) => ({ name: o.key.split("/").pop(), publicURL: r2Url(env, o.key) }));
}
function resolveLogo(env) {
  let logo = (env.MOSTLANE_LOGO_BASE64 || "").trim();
  if (logo && !logo.startsWith("data:image")) logo = "data:image/png;base64," + logo;
  return logo;
}
function safeRef(decorated, id) {
  const ref = (decorated.helpdeskRef || decorated.id || id || "job").toString();
  return ref.replace(/[^\w\-]+/g, "_").slice(0, 80);
}
async function htmlToPdf(env, html) {
  const res = await fetch("https://api.pdfshift.io/v3/convert/pdf", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Basic " + btoa(env.PDFSHIFT_API_KEY + ":")
    },
    body: JSON.stringify({ source: html, use_print: false })
  });
  if (!res.ok) {
    console.error(await res.text());
    return { ok: false };
  }
  return { ok: true, buffer: await res.arrayBuffer() };
}
function escapeHtml(v) {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function buildJobExportHtml(job, files, logoDataUrl) {
  const titleRef = escapeHtml(job.helpdeskRef || job.id || "");
  const desc = escapeHtml(job.description || "");
  const priority = escapeHtml(job.priority || "");
  const status = escapeHtml(job.status || "");
  const assignedTo = escapeHtml(job.assignedTo || "");
  const raisedAt = escapeHtml(job.raisedAt || "");
  const targetAt = escapeHtml(job.targetAt || "");
  const scheduledAt = escapeHtml(job.scheduledAt || "");
  const updatedAt = escapeHtml(job.updatedAt || "");
  const slaState = escapeHtml(job.sla?.state || "");
  const logoHtml = logoDataUrl ? `<img class="logo" src="${logoDataUrl}" alt="Mostlane"/>` : `<div class="logo-fallback">Mostlane</div>`;
  const filesHtml = files && files.length ? files.map((f) => {
    const name = escapeHtml(f.name);
    const url = escapeHtml(f.publicURL);
    const isImg = /\.(png|jpg|jpeg|webp|gif)$/i.test(f.name || "");
    return `
          <div class="file-card">
            <div class="file-head">
              <div class="file-name">${name}</div>
              <a class="file-link" href="${url}" target="_blank" rel="noopener">Open</a>
            </div>
            ${isImg ? `<img class="photo" src="${url}" alt="${name}" />` : ``}
          </div>`;
  }).join("\n") : `<div class="muted">No photos/files uploaded.</div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Job ${titleRef}</title>
<style>
  :root{--ml-blue:#003366;--ml-accent:#1a73e8;--ml-ink:#27313a;--ml-bg:#f3f5f7;--card:#ffffff;--border:#e6edf3;--muted:#667085;--ok:#0c7d27;--bad:#b00020;}
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;background:var(--ml-bg);color:var(--ml-ink);padding:24px;}
  .wrap{max-width:980px;margin:0 auto}
  .header{display:flex;gap:16px;align-items:center;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px;}
  .logo{height:46px}
  .logo-fallback{width:160px;height:46px;border-radius:10px;display:flex;align-items:center;justify-content:center;background:var(--ml-blue);color:#fff;font-weight:700;letter-spacing:.3px}
  .title{flex:1;}
  .title h1{margin:0;font-size:18px}
  .title .sub{margin-top:4px;color:var(--muted);font-size:13px}
  .pill{padding:6px 10px;border-radius:999px;font-size:12px;font-weight:700;border:1px solid var(--border);background:#fff;}
  .pill.ok{color:var(--ok)}
  .pill.bad{color:var(--bad)}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px;}
  .card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px;}
  .card h2{margin:0 0 10px 0;font-size:14px;color:var(--ml-blue)}
  .row{display:flex;gap:10px;justify-content:space-between;margin:6px 0}
  .k{color:var(--muted);font-size:12px}
  .v{font-size:12px;text-align:right;max-width:60%}
  .desc{white-space:pre-wrap;font-size:13px;line-height:1.45;background:#fafbfd;border:1px solid var(--border);border-radius:10px;padding:12px;}
  .files{margin-top:14px;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px;}
  .files h2{margin:0 0 10px 0;font-size:14px;color:var(--ml-blue)}
  .muted{color:var(--muted);font-size:13px}
  .file-card{border:1px solid var(--border);border-radius:12px;padding:12px;margin:10px 0;background:#fff;}
  .file-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
  .file-name{font-size:13px;font-weight:700;word-break:break-word}
  .file-link{font-size:12px;text-decoration:none;color:var(--ml-accent);border:1px solid var(--border);padding:6px 10px;border-radius:10px;white-space:nowrap;}
  .photo{width:100%;border-radius:10px;border:1px solid var(--border);margin-top:10px;}
  @media (max-width:820px){body{padding:14px}.grid{grid-template-columns:1fr}.v{max-width:70%}}
</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    ${logoHtml}
    <div class="title">
      <h1>Job ${titleRef}</h1>
      <div class="sub">Generated: ${escapeHtml((/* @__PURE__ */ new Date()).toISOString())}</div>
    </div>
    <div class="pill ${slaState === "BREACHED" ? "bad" : "ok"}">SLA: ${slaState || "OK"}</div>
  </div>
  <div class="grid">
    <div class="card">
      <h2>Details</h2>
      <div class="row"><div class="k">Status</div><div class="v">${status}</div></div>
      <div class="row"><div class="k">Priority</div><div class="v">${priority}</div></div>
      <div class="row"><div class="k">Assigned To</div><div class="v">${assignedTo || "-"}</div></div>
      <div class="row"><div class="k">Scheduled At</div><div class="v">${scheduledAt || "-"}</div></div>
      <div class="row"><div class="k">Updated At</div><div class="v">${updatedAt || "-"}</div></div>
    </div>
    <div class="card">
      <h2>SLA</h2>
      <div class="row"><div class="k">Raised At</div><div class="v">${raisedAt || "-"}</div></div>
      <div class="row"><div class="k">Target At</div><div class="v">${targetAt || "-"}</div></div>
      <div class="row"><div class="k">State</div><div class="v">${slaState || "OK"}</div></div>
    </div>
    <div class="card" style="grid-column:1/-1">
      <h2>Description</h2>
      <div class="desc">${desc || "-"}</div>
    </div>
  </div>
  <div class="files">
    <h2>Photos / Files</h2>
    ${filesHtml}
  </div>
</div>
</body>
</html>`;
}

// src/index.js
var ROUTES = [
  ["*", "/auth", handle],
  ["*", "/admin/login-history", loginHistory],
  ["*", "/user", handle2],
  // /user and /users
  ["*", "/device", handle3],
  ["*", "/holiday", handle4],
  ["*", "/asset", handle5],
  // /assets, /asset/*, /asset-image, /asset-thumb
  ["*", "/transfer", handle5],
  // /transfer, /transfer-log
  ["*", "/upload-asset-image", handle5],
  ["*", "/delete-asset-image", handle5],
  ["*", "/sla", handle6]
  // Excluded for now (separate / later systems): Purchase Orders,
  // Hours/Timesheets, Labour Planning, Check-in/out, Vehicles, Sites,
  // Compliance, Projects.
];
var index_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return preflight(env, request);
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ ok: true, service: "mostlane-portal", time: (/* @__PURE__ */ new Date()).toISOString() }, {}, env, request);
    }
    if (!isPublic(request.method, url.pathname)) {
      const sess = await requireSession(env, request);
      if (!sess) return error("Not authenticated", 401, env, request);
    }
    const match = ROUTES.filter(([, prefix]) => url.pathname === prefix || url.pathname.startsWith(prefix + "/") || url.pathname.startsWith(prefix)).sort((a, b) => b[1].length - a[1].length)[0];
    if (!match) return error("Not found: " + url.pathname, 404, env, request);
    try {
      return await match[2](request, env, ctx, url);
    } catch (err) {
      console.error("Handler error:", err);
      return error("Server error: " + err.message, 500, env, request);
    }
  }
};
var PUBLIC_ROUTES = [
  ["POST", "/auth/login"],
  ["POST", "/auth/forgot-password"],
  ["POST", "/auth/reset-password"],
  // Image bytes are loaded by <img> tags, which can't send an auth header.
  ["GET", "/asset-image"],
  ["GET", "/asset-thumb"]
];
function isPublic(method, pathname) {
  if (PUBLIC_ROUTES.some(([m, p]) => m === method && pathname === p)) return true;
  if (method === "GET" && /^\/sla\/jobs\/[^/]+\/export(\.pdf)?$/.test(pathname)) return true;
  return false;
}
export {
  index_default as default
};
