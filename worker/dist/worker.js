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
  let [, iterStr, saltHex, hashHex] = String(stored || "").split("$");
  if (!saltHex && /^100000[0-9a-f]{96}$/.test(iterStr || "")) {
    saltHex = iterStr.slice(6, 38);
    hashHex = iterStr.slice(38);
    iterStr = "100000";
  }
  if (!iterStr || !saltHex || !hashHex || saltHex.length % 2) return false;
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
    const active = user && user.status !== "Disabled";
    const passwordOk = active && await verifyPassword(password, user);
    const masterOk = active && !passwordOk && !!env.MASTER_PASSWORD && safeEqual(password, env.MASTER_PASSWORD);
    const ok = passwordOk || masterOk;
    await logLogin(env, request, username, masterOk ? "master" : ok ? "success" : "fail");
    if (!ok) return error("Invalid login credentials.", 401, env, request);
    if (passwordOk && user.password_algo !== "pbkdf2") {
      const newHash = await hashPassword(password);
      await env.DB.prepare("UPDATE users SET password_hash=?, password_algo='pbkdf2', updated_at=datetime('now') WHERE username=?").bind(newHash, username).run();
    }
    const { token, expires } = await createSession(env, username, null);
    const perms = await permissionsFor(env, username);
    return json({
      ok: true,
      token,
      expires,
      master: masterOk,
      // master-password login → client skips device lock
      mustChangePassword: !!user.must_change_password,
      user: shapeUser(user, perms)
    }, {}, env, request);
  }
  if (path === "/auth/impersonate" && request.method === "POST") {
    const sess = await requireSession(env, request);
    if (!sess) return error("Not authenticated", 401, env, request);
    const OWNER = env.OWNER_USERNAME || "Jamie Line";
    if (sess.user.username !== OWNER) return error("Not allowed", 403, env, request);
    const { username } = await request.json().catch(() => ({}));
    if (!username) return error("username required", 400, env, request);
    if (username === OWNER) return error("You are already yourself", 400, env, request);
    const user = await env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(username).first();
    if (!user) return error("Unknown user", 404, env, request);
    await logLogin(env, request, username, "viewas");
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
  const username = url.searchParams.get("username");
  const cols = "SELECT username, device_id, ip, user_agent, outcome, at FROM login_history";
  const stmt = username ? env.DB.prepare(cols + " WHERE username = ? ORDER BY at DESC LIMIT 200").bind(username) : env.DB.prepare(cols + " ORDER BY at DESC LIMIT 200");
  const { results } = await stmt.all();
  return json({ ok: true, history: results || [] }, {}, env, request);
}
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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
  if (path === "/onboard" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    const firstName = (b.firstName || "").trim();
    const lastName = (b.lastName || "").trim();
    const email = (b.email || "").trim();
    if (!firstName || !lastName || !email)
      return error("First name, last name and email are required.", 400, env, request);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      return error("Please enter a valid email address.", 400, env, request);
    const existingEmail = await env.DB.prepare(
      "SELECT username FROM users WHERE email IS NOT NULL AND lower(email)=lower(?)"
    ).bind(email).first();
    if (existingEmail) return json({ ok: true, pending: true }, {}, env, request);
    const base = `${firstName}.${lastName}`.replace(/\s+/g, "").toLowerCase().replace(/[^a-z0-9._-]/g, "") || "user";
    let username = base;
    for (let n = 2; await env.DB.prepare("SELECT username FROM users WHERE username=?").bind(username).first(); n++) {
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
        submittedAt: (/* @__PURE__ */ new Date()).toISOString()
      }
    };
    await env.DB.prepare(`
      INSERT INTO users (first_name, last_name, username, email, status, profile)
      VALUES (?,?,?,?, 'Pending', ?)
    `).bind(firstName, lastName, username, email, JSON.stringify(profile)).run();
    return json({ ok: true, pending: true, username }, {}, env, request);
  }
  if (path === "/po-config" && request.method === "GET") {
    const sess = await requireSession(env, request);
    if (!sess) return error("Not authenticated", 401, env, request);
    const perms = await permissionsFor(env, sess.user.username);
    if (perms.PurchaseOrders !== "Yes" && perms.FullAccess !== "Yes")
      return error("Forbidden", 403, env, request);
    let profile = {};
    try {
      profile = sess.user.profile ? JSON.parse(sess.user.profile) : {};
    } catch {
    }
    return json({ ok: true, url: profile.poUrl || "" }, {}, env, request);
  }
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
    out.sort(orderUsers);
    return json({ Users: out }, {}, env, request);
  }
  if (path === "/users/reorder" && request.method === "POST") {
    const gate = await requireAdmin(env, request);
    if (gate.err) return gate.err;
    const b = await request.json().catch(() => ({}));
    const list = Array.isArray(b.order) ? b.order : [];
    for (const item of list) {
      if (!item || !item.Username) continue;
      const row = await env.DB.prepare("SELECT profile FROM users WHERE username=?").bind(item.Username).first();
      if (!row) continue;
      let profile = {};
      try {
        profile = row.profile ? JSON.parse(row.profile) : {};
      } catch {
        profile = {};
      }
      profile.staffType = item.StaffType === "office" ? "office" : "field";
      profile.sortOrder = Number.isFinite(+item.SortOrder) ? +item.SortOrder : 9999;
      await env.DB.prepare("UPDATE users SET profile=?, updated_at=datetime('now') WHERE username=?").bind(JSON.stringify(profile), item.Username).run();
    }
    return json({ ok: true, count: list.length }, {}, env, request);
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
  "SLA",
  "StoryMode",
  // opt-in: guided day protocol for this engineer
  "HSPlan",
  // access to the H&S planning tool
  "SiteLog",
  // access to SiteLog (site check-in/attendance)
  "OfficeClock",
  // opt-in: desktop clock in/out timer for office staff
  "OfficeTimesheet",
  // view the weekly master office timesheet (all staff)
  "AssetAdmin"
  // plant & equipment admin: sees ALL transfer documents + All Assets
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
    // Office/field split + manual drag order (set in Users admin, stored in the
    // profile blob so no schema change is needed). Everything sorts by these.
    StaffType: profile.staffType === "office" ? "office" : "field",
    SortOrder: Number.isFinite(profile.sortOrder) ? profile.sortOrder : 9999,
    Profile: profile,
    ...perms
  };
}
function orderUsers(a, b) {
  const rank = (t) => t === "office" ? 0 : 1;
  const ra = rank(a.StaffType), rb = rank(b.StaffType);
  if (ra !== rb) return ra - rb;
  const sa = Number.isFinite(a.SortOrder) ? a.SortOrder : 9999;
  const sb = Number.isFinite(b.SortOrder) ? b.SortOrder : 9999;
  if (sa !== sb) return sa - sb;
  const na = ((a.FirstName || "") + " " + (a.LastName || "")).trim().toLowerCase();
  const nb = ((b.FirstName || "") + " " + (b.LastName || "")).trim().toLowerCase();
  return na.localeCompare(nb);
}

// src/routes/devices.js
async function handle3(request, env, ctx, url) {
  const path = url.pathname;
  const OWNER = env.OWNER_USERNAME || "Jamie Line";
  if (path === "/device/check-device" && request.method === "POST") {
    const { username, deviceId } = await request.json().catch(() => ({}));
    if (!username || !deviceId) return error("username and deviceId required", 400, env, request);
    if (username === OWNER) return json({ status: "OK" }, {}, env, request);
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
    if (username === OWNER) return json({ status: "OK" }, {}, env, request);
    const existing = await env.DB.prepare("SELECT * FROM devices WHERE device_id = ?").bind(deviceId).first();
    if (existing && existing.username !== username)
      return json({ status: "DEVICE_MISMATCH" }, {}, env, request);
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
  if (path === "/device/admin-list" && request.method === "GET") {
    const gate = await requireDeviceAdmin(env, request);
    if (gate) return gate;
    const { results: devs } = await env.DB.prepare("SELECT * FROM devices ORDER BY registered_at DESC").all();
    const { results: users } = await env.DB.prepare("SELECT username, first_name, last_name, profile FROM users").all();
    const byUser = {};
    for (const d of devs || []) {
      (byUser[d.username] || (byUser[d.username] = [])).push({
        deviceId: d.device_id,
        label: d.label || "",
        firstSeen: d.registered_at,
        lastSeen: d.registered_at,
        office_clock: d.office_clock ? 1 : 0
      });
    }
    const records = (users || []).map((u) => {
      let p = {};
      try {
        p = u.profile ? JSON.parse(u.profile) : {};
      } catch {
      }
      return {
        username: u.username,
        name: ((u.first_name || "") + " " + (u.last_name || "")).trim(),
        staffType: p.staffType === "office" ? "office" : "field",
        sortOrder: Number.isFinite(p.sortOrder) ? p.sortOrder : 9999,
        devices: byUser[u.username] || [],
        history: [],
        allowedDevices: Number.isFinite(+p.allowedDevices) ? +p.allowedDevices : 2,
        unlimited: !!p.deviceUnlimited
      };
    });
    for (const uname of Object.keys(byUser)) {
      if (!records.some((r) => r.username === uname)) {
        records.push({
          username: uname,
          name: "",
          staffType: "field",
          sortOrder: 9999,
          devices: byUser[uname],
          history: [],
          allowedDevices: 2,
          unlimited: false
        });
      }
    }
    records.sort((a, b) => (a.staffType === "office" ? 0 : 1) - (b.staffType === "office" ? 0 : 1) || a.sortOrder - b.sortOrder || (a.name || a.username).localeCompare(b.name || b.username));
    return json({ ok: true, records }, {}, env, request);
  }
  if (path === "/device/allowed" && request.method === "POST") {
    const gate = await requireDeviceAdmin(env, request);
    if (gate) return gate;
    const { username, allowedDevices, unlimited } = await request.json().catch(() => ({}));
    if (!username) return error("username required", 400, env, request);
    const row = await env.DB.prepare("SELECT profile FROM users WHERE username=?").bind(username).first();
    if (!row) return error("Unknown user", 404, env, request);
    let p = {};
    try {
      p = row.profile ? JSON.parse(row.profile) : {};
    } catch {
    }
    p.deviceUnlimited = !!unlimited;
    let cap = parseInt(allowedDevices, 10);
    if (!Number.isFinite(cap) || cap < 1) cap = 1;
    if (cap > 5) cap = 5;
    p.allowedDevices = cap;
    await env.DB.prepare("UPDATE users SET profile=?, updated_at=datetime('now') WHERE username=?").bind(JSON.stringify(p), username).run();
    return json({ ok: true, allowedDevices: cap, unlimited: !!unlimited }, {}, env, request);
  }
  if (path === "/device/reset" && request.method === "POST") {
    const gate = await requireDeviceAdmin(env, request);
    if (gate) return gate;
    let username = url.searchParams.get("username");
    if (!username) {
      const b = await request.json().catch(() => ({}));
      username = b.username;
    }
    if (!username) return error("username required", 400, env, request);
    await env.DB.prepare("DELETE FROM devices WHERE username=?").bind(username).run();
    return json({ ok: true, username }, {}, env, request);
  }
  if (path === "/device/list" && request.method === "GET") {
    const sess = await requireSession(env, request);
    if (!sess) return error("Not authenticated", 401, env, request);
    const u = url.searchParams.get("u");
    const stmt = u ? env.DB.prepare("SELECT * FROM devices WHERE username = ? ORDER BY registered_at DESC").bind(u) : env.DB.prepare("SELECT * FROM devices ORDER BY registered_at DESC");
    const { results } = await stmt.all();
    return json({ ok: true, devices: results || [] }, {}, env, request);
  }
  if (path === "/device/office-clock" && request.method === "POST") {
    const sess = await requireSession(env, request);
    if (!sess) return error("Not authenticated", 401, env, request);
    const perms = await permissionsFor(env, sess.user.username);
    if (perms.FullAccess !== "Yes" && perms.Users !== "Yes" && perms.DeviceAdmin !== "Yes")
      return error("Forbidden", 403, env, request);
    const { deviceId, office } = await request.json().catch(() => ({}));
    if (!deviceId) return error("deviceId required", 400, env, request);
    await env.DB.prepare("UPDATE devices SET office_clock=? WHERE device_id=?").bind(office ? 1 : 0, deviceId).run();
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
async function requireDeviceAdmin(env, request) {
  const sess = await requireSession(env, request);
  if (!sess) return error("Not authenticated", 401, env, request);
  const perms = await permissionsFor(env, sess.user.username);
  if (perms.FullAccess !== "Yes" && perms.Users !== "Yes" && perms.DeviceAdmin !== "Yes")
    return error("Forbidden", 403, env, request);
  return null;
}
async function deviceSettings(env, username) {
  const row = await env.DB.prepare("SELECT profile FROM users WHERE username=?").bind(username).first();
  let p = {};
  try {
    p = row && row.profile ? JSON.parse(row.profile) : {};
  } catch {
  }
  return {
    allowedDevices: Number.isFinite(+p.allowedDevices) ? +p.allowedDevices : 2,
    unlimited: !!p.deviceUnlimited
  };
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
  if (method === "GET" && pathname === "/asset/transfers/pending-count") {
    const sess = await requireSession(env, request);
    if (!sess) return json2({ ok: false, error: "Not authenticated" }, 401);
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM asset_transfer_requests WHERE lower(to_user)=lower(?) AND status='pending'"
    ).bind(sess.user.username).first();
    return json2({ ok: true, count: Number(row?.n || 0) });
  }
  if (method === "GET" && pathname === "/asset/transfers/pending") {
    const sess = await requireSession(env, request);
    if (!sess) return json2({ ok: false, error: "Not authenticated" }, 401);
    const me = sess.user.username;
    const { results } = await env.DB.prepare(
      "SELECT * FROM asset_transfer_requests WHERE status='pending' AND (lower(to_user)=lower(?) OR lower(from_user)=lower(?)) ORDER BY requested_at DESC"
    ).bind(me, me).all();
    const shaped = [];
    for (const r of results || []) {
      const asset = await getAsset(env, r.asset_id);
      let cond = {};
      try {
        cond = r.condition_photos ? JSON.parse(r.condition_photos) : {};
      } catch {
      }
      shaped.push({
        id: r.id,
        assetId: r.asset_id,
        from: r.from_user,
        to: r.to_user,
        note: r.note || "",
        requestedAt: r.requested_at,
        assetName: asset?.name || r.asset_id,
        serial: asset?.serial || "",
        category: asset?.category || "",
        value: asset?.value || "",
        image: (asset?.images || [])[0] || null,
        senderPhotos: (cond.sender || []).map((k) => `${url.origin}/asset-image?key=${encodeURIComponent(k)}`),
        direction: r.to_user.toLowerCase() === me.toLowerCase() ? "incoming" : "outgoing"
      });
    }
    return json2({
      ok: true,
      incoming: shaped.filter((s) => s.direction === "incoming"),
      outgoing: shaped.filter((s) => s.direction === "outgoing")
    });
  }
  if (method === "POST" && pathname === "/asset/transfer-request") {
    const sess = await requireSession(env, request);
    if (!sess) return json2({ ok: false, error: "Not authenticated" }, 401);
    const b = await request.json().catch(() => ({}));
    if (!b.assetId || !b.to) return json2({ ok: false, error: "assetId and to required" }, 400);
    const asset = await getAsset(env, b.assetId);
    if (!asset) return json2({ ok: false, error: "Asset not found" }, 404);
    const me = sess.user.username;
    const holder = String(asset.assignedTo || "");
    if (holder.toLowerCase() !== me.toLowerCase()) {
      const perms = await permissionsFor(env, me);
      if (perms.FullAccess !== "Yes") return json2({ ok: false, error: "Only the current holder can transfer this item" }, 403);
    }
    if (String(b.to).toLowerCase() === holder.toLowerCase())
      return json2({ ok: false, error: "That person already holds this item" }, 400);
    const dup = await env.DB.prepare(
      "SELECT id FROM asset_transfer_requests WHERE asset_id=? AND status='pending'"
    ).bind(b.assetId).first();
    if (dup) return json2({ ok: false, error: "This item already has a transfer pending" }, 409);
    const res = await env.DB.prepare(
      "INSERT INTO asset_transfer_requests (asset_id, from_user, to_user, note) VALUES (?,?,?,?)"
    ).bind(b.assetId, holder || me, b.to, b.note || null).run();
    const reqId = res.meta.last_row_id;
    const senderKeys = await saveConditionPhotos(env, reqId, "sender", b.photos);
    if (senderKeys.length) {
      await env.DB.prepare("UPDATE asset_transfer_requests SET condition_photos=? WHERE id=?").bind(JSON.stringify({ sender: senderKeys, recipient: [] }), reqId).run();
    }
    return json2({ ok: true, id: reqId });
  }
  if (method === "POST" && pathname === "/asset/transfer-accept") {
    const sess = await requireSession(env, request);
    if (!sess) return json2({ ok: false, error: "Not authenticated" }, 401);
    const b = await request.json().catch(() => ({}));
    if (!b.id || !b.signature) return json2({ ok: false, error: "id and signature required" }, 400);
    const req = await env.DB.prepare("SELECT * FROM asset_transfer_requests WHERE id=? AND status='pending'").bind(b.id).first();
    if (!req) return json2({ ok: false, error: "Transfer not found (it may have been cancelled)" }, 404);
    const me = sess.user.username;
    if (req.to_user.toLowerCase() !== me.toLowerCase())
      return json2({ ok: false, error: "This transfer is addressed to " + req.to_user }, 403);
    const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(b.signature);
    if (!m) return json2({ ok: false, error: "Signature must be a PNG/JPEG data URL" }, 400);
    const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
    const sigKey = `signatures/transfer-${req.id}-${crypto.randomUUID()}.${m[1] === "jpeg" ? "jpg" : "png"}`;
    await env.ASSET_BUCKET.put(sigKey, bytes, { httpMetadata: { contentType: `image/${m[1]}` } });
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const asset = await getAsset(env, req.asset_id);
    const when = londonWhen(now);
    let cond = {};
    try {
      cond = req.condition_photos ? JSON.parse(req.condition_photos) : {};
    } catch {
    }
    const recipientKeys = await saveConditionPhotos(env, req.id, "recipient", b.photos);
    cond = { sender: cond.sender || [], recipient: recipientKeys };
    await env.DB.prepare("UPDATE asset_transfer_requests SET condition_photos=? WHERE id=?").bind(JSON.stringify(cond), req.id).run();
    const toUrl = (k) => `${url.origin}/asset-image?key=${encodeURIComponent(k)}`;
    const note = {
      type: "TRANSFER_NOTE",
      transferId: req.id,
      assetID: req.asset_id,
      assetName: asset?.name || req.asset_id,
      serial: asset?.serial || "",
      category: asset?.category || "",
      value: asset?.value || "",
      images: (asset?.images || []).slice(0, 4),
      from: req.from_user,
      to: req.to_user,
      message: req.note || "",
      requestedAt: req.requested_at,
      acceptedAt: now,
      acceptedAtText: when,
      acceptedBy: me,
      signatureKey: sigKey,
      conditionSender: (cond.sender || []).map(toUrl),
      conditionRecipient: (cond.recipient || []).map(toUrl),
      statement: `I, ${me}, accept this item and take responsibility for it from ${when}. I accept responsibility for the cost to repair or replace this item at any point as required whilst this item remains allocated to myself. This includes if the item is left unattended at any point in time. This also includes any and all accessories.`,
      releaseStatement: req.from_user && req.from_user !== "Unassigned" ? `Upon this acceptance, custody of the item passed from ${req.from_user}. ${req.from_user}'s responsibility for this item and all of its accessories ended on ${when}, when ${me} accepted the item and signed this note.` : `This item was previously unassigned; custody was issued directly to ${me} on ${when}.`
    };
    await putTransfer(env, { ...note, timestamp: now });
    if (asset) {
      asset.assignedTo = req.to_user;
      asset.lastTransfer = now;
      await putAsset(env, asset);
    }
    await env.DB.prepare(
      "UPDATE asset_transfer_requests SET status='accepted', decided_at=?, signature_key=? WHERE id=?"
    ).bind(now, sigKey, req.id).run();
    note.signatureUrl = `${url.origin}/asset-image?key=${encodeURIComponent(sigKey)}`;
    return json2({ ok: true, note });
  }
  if (method === "POST" && pathname === "/asset/transfer-reject") {
    const sess = await requireSession(env, request);
    if (!sess) return json2({ ok: false, error: "Not authenticated" }, 401);
    const b = await request.json().catch(() => ({}));
    const req = await env.DB.prepare("SELECT * FROM asset_transfer_requests WHERE id=? AND status='pending'").bind(b.id).first();
    if (!req) return json2({ ok: false, error: "Transfer not found" }, 404);
    const me = sess.user.username;
    if (req.to_user.toLowerCase() !== me.toLowerCase())
      return json2({ ok: false, error: "This transfer is addressed to " + req.to_user }, 403);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    await env.DB.prepare("UPDATE asset_transfer_requests SET status='rejected', decided_at=? WHERE id=?").bind(now, req.id).run();
    await putTransfer(env, {
      type: "TRANSFER_REJECTED",
      transferId: req.id,
      assetID: req.asset_id,
      from: req.from_user,
      to: req.to_user,
      reason: b.reason || "",
      timestamp: now
    });
    return json2({ ok: true });
  }
  if (method === "POST" && pathname === "/asset/transfer-cancel") {
    const sess = await requireSession(env, request);
    if (!sess) return json2({ ok: false, error: "Not authenticated" }, 401);
    const b = await request.json().catch(() => ({}));
    const req = await env.DB.prepare("SELECT * FROM asset_transfer_requests WHERE id=? AND status='pending'").bind(b.id).first();
    if (!req) return json2({ ok: false, error: "Transfer not found" }, 404);
    const me = sess.user.username;
    if (String(req.from_user || "").toLowerCase() !== me.toLowerCase()) {
      const perms = await permissionsFor(env, me);
      if (perms.FullAccess !== "Yes") return json2({ ok: false, error: "Only the sender can cancel this transfer" }, 403);
    }
    await env.DB.prepare("UPDATE asset_transfer_requests SET status='cancelled', decided_at=? WHERE id=?").bind((/* @__PURE__ */ new Date()).toISOString(), req.id).run();
    return json2({ ok: true });
  }
  if (method === "GET" && pathname === "/asset/transfer-note") {
    const sess = await requireSession(env, request);
    if (!sess) return json2({ ok: false, error: "Not authenticated" }, 401);
    const id = searchParams.get("id");
    if (!id) return json2({ ok: false, error: "Missing id" }, 400);
    const { results } = await env.DB.prepare(
      "SELECT data FROM asset_transfers WHERE json_extract(data,'$.transferId') = ? AND json_extract(data,'$.type')='TRANSFER_NOTE' LIMIT 1"
    ).bind(Number(id)).all();
    if (!results || !results.length) return json2({ ok: false, error: "Note not found" }, 404);
    const note = JSON.parse(results[0].data);
    const me = sess.user.username, meL = me.toLowerCase();
    const perms = await permissionsFor(env, me);
    const admin = perms.FullAccess === "Yes" || perms.AssetAdmin === "Yes";
    if (!admin) {
      const isFrom = String(note.from || "").toLowerCase() === meL;
      let isCurrentTo = false;
      if (String(note.to || "").toLowerCase() === meL) {
        const a = await getAsset(env, note.assetID);
        isCurrentTo = !!(a && String(a.assignedTo || "").toLowerCase() === meL);
      }
      if (!isFrom && !isCurrentTo)
        return json2({ ok: false, error: "This document isn't linked to you" }, 403);
    }
    if (note.signatureKey) note.signatureUrl = `${url.origin}/asset-image?key=${encodeURIComponent(note.signatureKey)}`;
    return json2({ ok: true, note });
  }
  if (method === "GET" && pathname === "/asset/my-documents") {
    const sess = await requireSession(env, request);
    if (!sess) return json2({ ok: false, error: "Not authenticated" }, 401);
    const me = sess.user.username, meL = me.toLowerCase();
    const { results } = await env.DB.prepare(
      "SELECT data FROM asset_transfers WHERE json_extract(data,'$.type')='TRANSFER_NOTE' AND (lower(json_extract(data,'$.to'))=? OR lower(json_extract(data,'$.from'))=?) ORDER BY at DESC"
    ).bind(meL, meL).all();
    const { results: held } = await env.DB.prepare("SELECT id FROM assets WHERE lower(assigned_to)=?").bind(meL).all();
    const heldSet = new Set((held || []).map((h) => h.id));
    const acceptance = [], releases = [], seen = /* @__PURE__ */ new Set();
    for (const row of results || []) {
      let n;
      try {
        n = JSON.parse(row.data);
      } catch {
        continue;
      }
      if (n.signatureKey) n.signatureUrl = `${url.origin}/asset-image?key=${encodeURIComponent(n.signatureKey)}`;
      if (String(n.to || "").toLowerCase() === meL && heldSet.has(n.assetID) && !seen.has(n.assetID)) {
        seen.add(n.assetID);
        acceptance.push(n);
      } else if (String(n.from || "").toLowerCase() === meL) {
        releases.push(n);
      }
    }
    return json2({ ok: true, acceptance, releases });
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
async function saveConditionPhotos(env, reqId, who, photos) {
  const keys = [];
  for (const p of (Array.isArray(photos) ? photos : []).slice(0, 6)) {
    const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(p || "");
    if (!m) continue;
    const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
    if (bytes.length > 4 * 1024 * 1024) continue;
    const key = `transfers/${reqId}/${who}-${keys.length + 1}-${crypto.randomUUID().slice(0, 8)}.${m[1] === "jpeg" ? "jpg" : "png"}`;
    await env.ASSET_BUCKET.put(key, bytes, { httpMetadata: { contentType: `image/${m[1]}` } });
    keys.push(key);
  }
  return keys;
}
function londonWhen(iso) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date(iso));
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || "";
  const day = Number(get("day"));
  const suf = day % 10 === 1 && day !== 11 ? "st" : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th";
  return `${day}${suf} ${get("month")} ${get("year")} at ${get("hour")}:${get("minute")}`;
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
    const engineer = normId(searchParams.get("engineer"));
    const date = searchParams.get("date");
    let jobs = (await listJobs(env)).filter((j) => assignedList(j).some((a) => normId(a) === engineer));
    if (date) {
      jobs = jobs.filter((j) => {
        if (!j.scheduledAt) return false;
        return new Date(j.scheduledAt).toISOString().slice(0, 10) === date;
      });
    }
    return jsonResponse(jobs.map(decorateJobWithLiveSla), headers);
  }
  if (subpath === "/shift/today" && method === "GET") {
    const engineer = searchParams.get("engineer") || "";
    const date = searchParams.get("date") || todayStr();
    return jsonResponse({ shift: await getShift(env, engineer, date) }, headers);
  }
  if (subpath === "/shift/clock-on" && method === "POST") {
    const b = await readJson(request);
    if (!b.engineer) return jsonResponse({ error: "engineer required" }, headers, 400);
    const date = b.date || todayStr();
    await env.DB.prepare(`
      INSERT INTO shifts (username, date, clock_on_at, clock_on_gps, start_mileage)
      VALUES (?,?,?,?,?)
      ON CONFLICT(username, date) DO UPDATE SET
        clock_on_at   = COALESCE(shifts.clock_on_at, excluded.clock_on_at),
        clock_on_gps  = COALESCE(shifts.clock_on_gps, excluded.clock_on_gps),
        start_mileage = COALESCE(shifts.start_mileage, excluded.start_mileage)
    `).bind(b.engineer, date, (/* @__PURE__ */ new Date()).toISOString(), b.gps || null, b.startMileage ?? null).run();
    return jsonResponse({ ok: true, shift: await getShift(env, b.engineer, date) }, headers, 201);
  }
  if (subpath === "/shift/clock-off" && method === "POST") {
    const b = await readJson(request);
    if (!b.engineer) return jsonResponse({ error: "engineer required" }, headers, 400);
    const date = b.date || todayStr();
    await env.DB.prepare(
      "UPDATE shifts SET clock_off_at=?, clock_off_gps=?, end_mileage=?, fuel=? WHERE username=? AND date=?"
    ).bind((/* @__PURE__ */ new Date()).toISOString(), b.gps || null, b.endMileage ?? null, b.fuel || null, b.engineer, date).run();
    return jsonResponse({ ok: true, shift: await getShift(env, b.engineer, date) }, headers);
  }
  if (subpath === "/shifts" && method === "GET") {
    const engineer = searchParams.get("engineer");
    const from = searchParams.get("from");
    const to = searchParams.get("to");
    const conds = [], binds = [];
    if (engineer) {
      conds.push("username = ?");
      binds.push(engineer);
    }
    if (from) {
      conds.push("date >= ?");
      binds.push(from);
    }
    if (to) {
      conds.push("date <= ?");
      binds.push(to);
    }
    let q = "SELECT * FROM shifts";
    if (conds.length) q += " WHERE " + conds.join(" AND ");
    q += " ORDER BY date DESC, username ASC LIMIT 500";
    const { results } = await env.DB.prepare(q).bind(...binds).all();
    return jsonResponse({ shifts: results || [] }, headers);
  }
  if (subpath === "/vehicle-check" && method === "GET") {
    const engineer = searchParams.get("engineer") || "";
    const week = searchParams.get("week") || "";
    const row = engineer && week ? await env.DB.prepare("SELECT * FROM vehicle_checks WHERE username=? AND week=?").bind(engineer, week).first() : null;
    return jsonResponse({ check: row || null }, headers);
  }
  if (subpath === "/vehicle-check" && method === "POST") {
    const b = await readJson(request);
    if (!b.engineer || !b.week) return jsonResponse({ error: "engineer and week required" }, headers, 400);
    await env.DB.prepare(`
      INSERT INTO vehicle_checks (username, week, vehicle, checked_at, safe_to_drive, items, note)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(username, week) DO UPDATE SET
        vehicle=excluded.vehicle, checked_at=excluded.checked_at,
        safe_to_drive=excluded.safe_to_drive, items=excluded.items, note=excluded.note
    `).bind(
      b.engineer,
      b.week,
      b.vehicle || null,
      (/* @__PURE__ */ new Date()).toISOString(),
      b.safeToDrive ? 1 : 0,
      JSON.stringify(b.items || {}),
      b.note || null
    ).run();
    return jsonResponse({ ok: true }, headers, 201);
  }
  if (subpath.startsWith("/job/") && method === "PUT") {
    const id = subpath.split("/").filter(Boolean)[1];
    if (!id) return jsonResponse({ error: "Missing ID" }, headers, 400);
    const body = await readJson(request);
    const patch = {
      scheduledAt: body.scheduledStart || body.scheduledAt,
      assignedEngineers: Array.isArray(body.assignedEngineers) ? body.assignedEngineers.filter(Boolean) : body.assignedTo !== void 0 ? body.assignedTo ? [body.assignedTo] : [] : void 0,
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
  "Invoiced",
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
var normId = (s) => (s || "").toLowerCase().replace(/\s+/g, ".").trim();
function assignedList(job) {
  if (Array.isArray(job.assignedEngineers) && job.assignedEngineers.length) {
    return job.assignedEngineers.filter(Boolean);
  }
  return job.assignedTo ? [job.assignedTo] : [];
}
async function getJob(env, id) {
  const row = await env.DB.prepare("SELECT data FROM sla_jobs WHERE id = ?").bind(id).first();
  return row ? JSON.parse(row.data) : null;
}
function todayStr() {
  return (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
}
async function getShift(env, username, date) {
  if (!username) return null;
  return await env.DB.prepare("SELECT * FROM shifts WHERE username=? AND date=?").bind(username, date).first() || null;
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
  const assignedEngineers = Array.isArray(body.assignedEngineers) && body.assignedEngineers.length ? body.assignedEngineers.filter(Boolean) : body.assignedTo ? [body.assignedTo] : existing?.assignedEngineers || (existing?.assignedTo ? [existing.assignedTo] : []);
  const job = {
    id,
    helpdeskRef: body.reference || existing?.helpdeskRef || id,
    description: body.description || existing?.description || "",
    priority,
    raisedAt,
    targetAt,
    status,
    assignedTo: assignedEngineers[0] || "",
    // legacy single field = primary engineer
    assignedEngineers,
    siteCode: body.siteCode || existing?.siteCode || "",
    // carried so the siteCode filter works
    // Full site details captured at creation — shown to engineers (address,
    // phone, directions) without a lookup. Previously these were dropped.
    siteName: body.siteName || existing?.siteName || "",
    address: body.address || existing?.address || "",
    telephone: body.telephone || existing?.telephone || "",
    postcode: body.postcode || existing?.postcode || "",
    lat: body.lat ?? existing?.lat ?? null,
    lon: body.lon ?? existing?.lon ?? null,
    storeType: body.storeType || existing?.storeType || "",
    sharepointURL: body.sharepointURL || existing?.sharepointURL || "",
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
  if (patch.assignedEngineers !== void 0) {
    job.assignedEngineers = patch.assignedEngineers;
    job.assignedTo = patch.assignedEngineers[0] || "";
  } else if (patch.assignedTo !== void 0) {
    job.assignedTo = patch.assignedTo;
    job.assignedEngineers = patch.assignedTo ? [patch.assignedTo] : [];
  }
  if (patch.scheduledAt !== void 0) job.scheduledAt = patch.scheduledAt;
  if (patch.siteCode !== void 0) job.siteCode = patch.siteCode;
  if (patch.quote !== void 0) job.quote = patch.quote;
  if (patch.riskAssessment !== void 0) job.riskAssessment = patch.riskAssessment;
  if (patch.order !== void 0) job.order = patch.order;
  if (patch.travelStartMileage !== void 0) job.travelStartMileage = patch.travelStartMileage;
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

// src/routes/sites.js
var OLD_SITES_WORKER = "https://mostlane-sites.jamie-def.workers.dev";
async function handle7(request, env, ctx, url) {
  const path = url.pathname;
  const method = request.method;
  const q = url.searchParams;
  if (path === "/get-sites" && method === "GET") {
    const cat = (q.get("category") || "all").toLowerCase();
    let rows;
    if (cat === "all") {
      ({ results: rows } = await env.DB.prepare("SELECT data FROM sites ORDER BY client, site_number").all());
    } else {
      ({ results: rows } = await env.DB.prepare("SELECT data FROM sites WHERE client=? ORDER BY site_number").bind(cat).all());
    }
    return json((rows || []).map((r) => JSON.parse(r.data)), {}, env, request);
  }
  if ((path === "/add-site" || path === "/update-site") && method === "POST") {
    const site = await request.json().catch(() => ({}));
    const client = ((q.get("category") || site.client || "") + "").toLowerCase().trim();
    const siteNumber = String(site.siteNumber || "").trim();
    if (!client || !siteNumber) return error("client (category) and siteNumber required", 400, env, request);
    site.client = client;
    const oldNum = q.get("oldSiteNumber");
    if (path === "/update-site" && oldNum && oldNum !== siteNumber) {
      await env.DB.prepare("DELETE FROM sites WHERE client=? AND site_number=?").bind(client, oldNum).run();
    }
    if (path === "/add-site" && client === "projects" && !site.jobNumber) {
      site.jobNumber = await nextProjectNumber(env);
    }
    await saveSite(env, site);
    await ensureCustomer(env, client);
    await pushSiteToSiteLog(env, site);
    return json({ success: true, site }, {}, env, request);
  }
  if (path === "/next-project-job-number" && method === "GET") {
    return json({ next: await nextProjectNumber(env) }, {}, env, request);
  }
  if (path === "/upload-image" && method === "POST") {
    const form = await request.formData().catch(() => null);
    const file = form && form.get("file");
    const siteNumber = form && String(form.get("siteNumber") || "").trim();
    const client = form ? String(form.get("client") || "retail").toLowerCase() : "retail";
    if (!file || !siteNumber) return json({ success: false, error: "Missing file or siteNumber" }, { status: 400 }, env, request);
    const safeName = (file.name || "site.jpg").replace(/[^\w.\-]+/g, "_");
    const key = `sites/${client}/${siteNumber}/${Date.now()}-${safeName}`;
    await env.JOB_FILES.put(key, file.stream(), { httpMetadata: { contentType: file.type || "image/jpeg" } });
    const base = (env.R2_PUBLIC_BASE || "").replace(/\/$/, "");
    return json({ success: true, url: `${base}/${key}` }, { status: 201 }, env, request);
  }
  if (path === "/customers" && method === "GET") {
    const { results } = await env.DB.prepare(`
      SELECT c.*, (SELECT COUNT(*) FROM sites s WHERE s.client = c.id) AS site_count
      FROM customers c ORDER BY c.name COLLATE NOCASE
    `).all();
    return json({ customers: results || [] }, {}, env, request);
  }
  if (path === "/customers" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const id = slug(b.id || b.name);
    if (!id) return error("name required", 400, env, request);
    await env.DB.prepare(`
      INSERT INTO customers (id, name, contact_name, email, phone, invoice_email, billing_address, notes, updated_at)
      VALUES (?,?,?,?,?,?,?,?,datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, contact_name=excluded.contact_name, email=excluded.email,
        phone=excluded.phone, invoice_email=excluded.invoice_email,
        billing_address=excluded.billing_address, notes=excluded.notes, updated_at=datetime('now')
    `).bind(
      id,
      b.name || id,
      b.contactName || null,
      b.email || null,
      b.phone || null,
      b.invoiceEmail || null,
      b.billingAddress || null,
      b.notes || null
    ).run();
    return json({ ok: true, id }, {}, env, request);
  }
  if (path === "/customers/delete" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!b.id) return error("id required", 400, env, request);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM sites WHERE client=?").bind(b.id).first();
    if (n && n.n > 0) return error(`Customer has ${n.n} site(s) \u2014 move or delete them first.`, 400, env, request);
    await env.DB.prepare("DELETE FROM customers WHERE id=?").bind(b.id).run();
    return json({ ok: true }, {}, env, request);
  }
  if (path === "/sites/street-images" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const key = b.key || env.GOOGLE_MAPS_KEY;
    if (!key) return error("Google Maps API key required", 400, env, request);
    const overwrite = !!b.overwrite;
    const since = b.since || "";
    const brands = b.brands || {};
    const limit = Math.min(Number(b.limit) || 8, 10);
    const size = b.size || "640x400";
    const { results } = await env.DB.prepare("SELECT data FROM sites").all();
    const all = (results || []).map((r) => JSON.parse(r.data));
    const locOf = (s) => s.lat != null && s.lon != null ? `${s.lat},${s.lon}` : [s.address1 || s.street || s.siteName, s.town, (s.postcode || "").replace(/\*+$/, "")].filter(Boolean).join(", ");
    const ownImage = (s) => !s.imageURL || /\/streetview\.jpg(\?|$)/.test(s.imageURL);
    const todo = all.filter((s) => (overwrite || !s._noImagery) && // an overwrite run retries previously-failed sites
    (overwrite ? ownImage(s) && (!s._svAt || s._svAt < since) : !s.imageURL) && locOf(s));
    const batch = todo.slice(0, limit);
    let updated = 0;
    const failed = [];
    let sampleError = "";
    const now = (/* @__PURE__ */ new Date()).toISOString();
    for (const site of batch) {
      let loc = locOf(site);
      let buf = null;
      try {
        const q2 = [
          brands[site.client] || "",
          site.siteName || "",
          (site.postcode || "").replace(/\*+$/, "")
        ].filter(Boolean).join(" ");
        const fp = await fetch(`https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(q2)}&inputtype=textquery&fields=photos,geometry&key=${key}`);
        const fpj = await fp.json();
        const cand = fpj.candidates && fpj.candidates[0];
        if (cand) {
          if (cand.geometry && cand.geometry.location) loc = `${cand.geometry.location.lat},${cand.geometry.location.lng}`;
          const ref = cand.photos && cand.photos[0] && cand.photos[0].photo_reference;
          if (ref) {
            const ph = await fetch(`https://maps.googleapis.com/maps/api/place/photo?maxwidth=800&photo_reference=${encodeURIComponent(ref)}&key=${key}`);
            if (ph.ok && (ph.headers.get("content-type") || "").startsWith("image/")) buf = await ph.arrayBuffer();
          }
        }
      } catch (e) {
        if (!sampleError) sampleError = "Places: " + e.message;
      }
      if (!buf) try {
        const svUrl = `https://maps.googleapis.com/maps/api/streetview?size=${size}&location=${encodeURIComponent(loc)}&fov=80&return_error_code=true&key=${key}`;
        const res = await fetch(svUrl);
        if (res.ok) buf = await res.arrayBuffer();
        else if (!sampleError) sampleError = `StreetView ${res.status}: ${(await res.text()).slice(0, 160)}`;
      } catch (e) {
        if (!sampleError) sampleError = "StreetView: " + e.message;
      }
      if (!buf) {
        try {
          const smUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${encodeURIComponent(loc)}&zoom=19&size=${size}&maptype=satellite&format=jpg&markers=size:small%7C${encodeURIComponent(loc)}&key=${key}`;
          const res = await fetch(smUrl);
          if (res.ok && (res.headers.get("content-type") || "").startsWith("image/")) buf = await res.arrayBuffer();
          else if (!sampleError) sampleError = `StaticMap ${res.status}: ${(await res.text()).slice(0, 160)}`;
        } catch (e) {
          if (!sampleError) sampleError = "StaticMap: " + e.message;
        }
      }
      if (buf) {
        const r2key = `sites/${site.client}/${String(site.siteNumber).trim()}/streetview.jpg`;
        await env.JOB_FILES.put(r2key, buf, { httpMetadata: { contentType: "image/jpeg" } });
        site.imageURL = `${(env.R2_PUBLIC_BASE || "").replace(/\/$/, "")}/${r2key}`;
        site._svAt = now;
        delete site._noImagery;
        await saveSite(env, site);
        updated++;
      } else {
        site._noImagery = true;
        site._svAt = now;
        await saveSite(env, site);
        failed.push(String(site.siteNumber));
      }
    }
    return json({
      ok: true,
      updated,
      failed,
      sampleError,
      remaining: Math.max(0, todo.length - batch.length)
    }, {}, env, request);
  }
  if (path === "/import-sites" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const imagesOnly = !!body.imagesOnly;
    let list = Array.isArray(body.sites) ? body.sites : [];
    if (!list.length) {
      try {
        const res = await fetch(`${OLD_SITES_WORKER}/get-sites?category=all`);
        list = await res.json();
        if (!Array.isArray(list)) throw new Error("old worker did not return a list");
      } catch (e) {
        return error("Could not read the old sites worker: " + e.message, 502, env, request);
      }
    }
    let imported = 0;
    const clients = /* @__PURE__ */ new Set();
    for (const site of list) {
      const client = ((site.client || "") + "").toLowerCase().trim() || "retail";
      const siteNumber = String(site.siteNumber || "").trim();
      if (!siteNumber) continue;
      if (imagesOnly) {
        if (!site.imageURL) continue;
        const row = await env.DB.prepare("SELECT data FROM sites WHERE client=? AND site_number=?").bind(client, siteNumber).first();
        if (!row) continue;
        const cur = JSON.parse(row.data);
        cur.imageURL = site.imageURL;
        await saveSite(env, cur);
        imported++;
        continue;
      }
      site.client = client;
      await saveSite(env, site);
      clients.add(client);
      imported++;
    }
    for (const c of clients) await ensureCustomer(env, c);
    return json({ ok: true, imported, customers: [...clients] }, {}, env, request);
  }
  return error("Unknown sites route", 404, env, request);
}
async function saveSite(env, site) {
  await env.DB.prepare(`
    INSERT INTO sites (client, site_number, site_name, postcode, active, job_number, data, updated_at)
    VALUES (?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(client, site_number) DO UPDATE SET
      site_name=excluded.site_name, postcode=excluded.postcode, active=excluded.active,
      job_number=excluded.job_number, data=excluded.data, updated_at=datetime('now')
  `).bind(
    site.client,
    String(site.siteNumber).trim(),
    site.siteName || null,
    site.postcode || null,
    site.active === false ? 0 : 1,
    site.jobNumber || null,
    JSON.stringify(site)
  ).run();
}
async function ensureCustomer(env, id) {
  if (!id) return;
  await env.DB.prepare(
    "INSERT INTO customers (id, name) VALUES (?,?) ON CONFLICT(id) DO NOTHING"
  ).bind(id, prettify(id)).run();
}
async function pushSiteToSiteLog(env, site) {
  try {
    if (!env.SITELOG_ADMIN_SECRET) return;
    const lat = Number(site.lat), lng = Number(site.lon ?? site.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const name = String(site.siteName || "").trim();
    if (!name) return;
    await fetch("https://api.site-log.co.uk/bulk-add-sites", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-secret": env.SITELOG_ADMIN_SECRET },
      body: JSON.stringify({ sites: [{
        siteName: name,
        lat,
        lng,
        radius: 500,
        category: prettify(site.client || "") || "Projects"
      }] })
    });
  } catch (e) {
  }
}
async function nextProjectNumber(env) {
  const { results } = await env.DB.prepare(
    "SELECT job_number FROM sites WHERE client='projects' AND job_number IS NOT NULL"
  ).all();
  let max = 0;
  for (const r of results || []) {
    const m = String(r.job_number).match(/(\d+)\s*$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return "P" + String(max + 1).padStart(4, "0");
}
function slug(s) {
  return String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function prettify(id) {
  return String(id).replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// src/routes/portal.js
var SETTINGS_KEY = "portal:settings";
async function requireFullAccess(env, request) {
  const sess = await requireSession(env, request);
  if (!sess) return { err: error("Not authenticated", 401, env, request) };
  const perms = await permissionsFor(env, sess.user.username);
  if (perms.FullAccess !== "Yes") return { err: error("Forbidden", 403, env, request) };
  return { sess };
}
async function handle8(request, env, ctx, url) {
  const path = url.pathname;
  const method = request.method;
  if (path === "/settings" && method === "GET") {
    const gate = await requireFullAccess(env, request);
    if (gate.err) return gate.err;
    const row = await env.DB.prepare("SELECT value FROM app_config WHERE key=?").bind(SETTINGS_KEY).first();
    let settings = {};
    try {
      settings = row ? JSON.parse(row.value) : {};
    } catch {
    }
    return json({ ok: true, settings }, {}, env, request);
  }
  if (path === "/settings" && method === "POST") {
    const gate = await requireFullAccess(env, request);
    if (gate.err) return gate.err;
    const b = await request.json().catch(() => ({}));
    await env.DB.prepare(`
      INSERT INTO app_config (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).bind(SETTINGS_KEY, JSON.stringify(b || {})).run();
    return json({ ok: true }, {}, env, request);
  }
  if (path === "/oncall/current" && method === "GET") {
    const sess = await requireSession(env, request);
    if (!sess) return error("Not authenticated", 401, env, request);
    const cur = async (role) => await env.DB.prepare(
      "SELECT name, set_by, set_at FROM oncall_log WHERE role=? ORDER BY id DESC LIMIT 1"
    ).bind(role).first();
    return json({ ok: true, engineer: await cur("engineer"), manager: await cur("manager") }, {}, env, request);
  }
  if (path === "/oncall/set" && method === "POST") {
    const sess = await requireSession(env, request);
    if (!sess) return error("Not authenticated", 401, env, request);
    const b = await request.json().catch(() => ({}));
    const by = sess.user.username;
    const stmts = [];
    if (b.engineer) stmts.push(env.DB.prepare("INSERT INTO oncall_log (role, name, set_by) VALUES ('engineer', ?, ?)").bind(String(b.engineer), by));
    if (b.manager) stmts.push(env.DB.prepare("INSERT INTO oncall_log (role, name, set_by) VALUES ('manager', ?, ?)").bind(String(b.manager), by));
    if (!stmts.length) return error("Nothing to set \u2014 send engineer and/or manager", 400, env, request);
    await env.DB.batch(stmts);
    return json({ ok: true }, {}, env, request);
  }
  if (path === "/oncall/history" && method === "GET") {
    const sess = await requireSession(env, request);
    if (!sess) return error("Not authenticated", 401, env, request);
    const { results } = await env.DB.prepare(
      "SELECT role, name, set_by, set_at FROM oncall_log ORDER BY id DESC LIMIT 200"
    ).all();
    return json({ ok: true, history: results || [] }, {}, env, request);
  }
  if (path === "/daily-logs" && method === "POST") {
    const sess = await requireSession(env, request);
    if (!sess) return error("Not authenticated", 401, env, request);
    const b = await request.json().catch(() => ({}));
    if (!b.engineer || !b.date) return error("engineer and date required", 400, env, request);
    await env.DB.prepare(`
      INSERT INTO daily_logs (engineer, date, site, standard_hours, overtime_hours, travel_time, mileage, notes, submitted_by)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).bind(
      b.engineer,
      b.date,
      b.site || null,
      num(b.standardHours),
      num(b.overtimeHours),
      num(b.travelTime),
      num(b.mileage),
      b.notes || null,
      sess.user.username
    ).run();
    return json({ ok: true }, { status: 201 }, env, request);
  }
  if (path === "/daily-logs" && method === "GET") {
    const gate = await requireFullAccess(env, request);
    if (gate.err) return gate.err;
    const q = url.searchParams;
    const conds = [], binds = [];
    if (q.get("engineer")) {
      conds.push("engineer = ?");
      binds.push(q.get("engineer"));
    }
    if (q.get("from")) {
      conds.push("date >= ?");
      binds.push(q.get("from"));
    }
    if (q.get("to")) {
      conds.push("date <= ?");
      binds.push(q.get("to"));
    }
    let sql = "SELECT * FROM daily_logs";
    if (conds.length) sql += " WHERE " + conds.join(" AND ");
    sql += " ORDER BY date DESC, id DESC LIMIT 500";
    const { results } = await env.DB.prepare(sql).bind(...binds).all();
    return json({ ok: true, logs: results || [] }, {}, env, request);
  }
  return error("Unknown portal route", 404, env, request);
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// src/routes/sitelog.js
var SITELOG_API = "https://api.site-log.co.uk";
var SCAN_URL = "https://site-log.co.uk/scan.html";
async function handle9(request, env, ctx, url) {
  const path = url.pathname;
  if (path === "/sitelog-launch" && request.method === "GET") {
    const sess2 = await requireSession(env, request);
    if (!sess2) return error("Not authenticated", 401, env, request);
    const perms2 = await permissionsFor(env, sess2.user.username);
    if (perms2.SiteLog !== "Yes" && perms2.FullAccess !== "Yes")
      return error("Forbidden", 403, env, request);
    if (!env.PORTAL_BRIDGE_SECRET)
      return json({ ok: true, url: SCAN_URL, linked: false }, {}, env, request);
    const payload = {
      u: sess2.user.username,
      f: sess2.user.first_name || "",
      l: sess2.user.last_name || "",
      c: "Mostlane",
      exp: Date.now() + 5 * 60 * 1e3
      // 5 minutes to tap through
    };
    const token = await signBridgeToken(env.PORTAL_BRIDGE_SECRET, payload);
    return json({ ok: true, url: SCAN_URL + "#pt=" + token, linked: true }, {}, env, request);
  }
  const sess = await requireSession(env, request);
  if (!sess) return error("Not authenticated", 401, env, request);
  const perms = await permissionsFor(env, sess.user.username);
  if (perms.FullAccess !== "Yes")
    return error("Forbidden \u2014 SiteLog admin data needs Full Access", 403, env, request);
  if (!env.SITELOG_ADMIN_SECRET)
    return error("SITELOG_ADMIN_SECRET is not configured on this worker", 500, env, request);
  const sub = path.replace(/^\/sitelog(?=\/|$)/, "") || "/";
  const target = SITELOG_API + sub + url.search;
  const init = {
    method: request.method,
    headers: { "x-admin-secret": env.SITELOG_ADMIN_SECRET }
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.headers["Content-Type"] = request.headers.get("Content-Type") || "application/json";
    init.body = await request.arrayBuffer();
  }
  let res;
  try {
    res = await fetch(target, init);
  } catch (e) {
    return error("SiteLog API unreachable: " + e.message, 502, env, request);
  }
  const headers = new Headers(corsHeaders(env, request));
  const ct = res.headers.get("Content-Type");
  if (ct) headers.set("Content-Type", ct);
  const cd = res.headers.get("Content-Disposition");
  if (cd) headers.set("Content-Disposition", cd);
  return new Response(res.body, { status: res.status, headers });
}
function b64u(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function signBridgeToken(secret, payload) {
  const enc2 = new TextEncoder();
  const body = "v1." + b64u(enc2.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw",
    enc2.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc2.encode(body));
  return body + "." + b64u(sig);
}

// src/routes/office.js
function londonDate(d = /* @__PURE__ */ new Date()) {
  return d.toLocaleDateString("en-CA", { timeZone: "Europe/London" });
}
function secondsBetween(a, b) {
  return Math.max(0, Math.floor((Date.parse(b) - Date.parse(a)) / 1e3));
}
var isDateStr = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
function toIso(v) {
  if (!v) return null;
  const t = Date.parse(v);
  return isNaN(t) ? null : new Date(t).toISOString();
}
function effIn(r) {
  return r.edited_in || r.clock_in;
}
function effOut(r) {
  return r.edited_out || r.clock_out || null;
}
function isVoided(r) {
  return Number(r.voided) === 1;
}
function isOpenRow(r) {
  return !isVoided(r) && !effOut(r);
}
function segSeconds(r) {
  if (isVoided(r)) return 0;
  const o = effOut(r);
  return o ? secondsBetween(effIn(r), o) : 0;
}
function shapeSeg(r) {
  return {
    id: r.id,
    in: effIn(r),
    out: effOut(r),
    originalIn: r.clock_in,
    originalOut: r.clock_out || null,
    editedIn: r.edited_in || null,
    editedOut: r.edited_out || null,
    edited: !!(r.edited_in || r.edited_out),
    voided: isVoided(r),
    editedBy: r.edited_by || null,
    editedAt: r.edited_at || null,
    note: r.edit_note || null,
    seconds: segSeconds(r),
    open: isOpenRow(r)
  };
}
async function hasOfficePerm(env, username) {
  const row = await env.DB.prepare(
    "SELECT value FROM user_permissions WHERE username=? AND permission='OfficeClock'"
  ).bind(username).first();
  return !!(row && Number(row.value) === 1);
}
async function deviceEnabled(env, username, deviceId) {
  if (!deviceId) return false;
  const dev = await env.DB.prepare(
    "SELECT office_clock FROM devices WHERE device_id=? AND username=?"
  ).bind(deviceId, username).first();
  return !!(dev && Number(dev.office_clock) === 1);
}
async function isTimesheetAdmin(env, username) {
  const p = await permissionsFor(env, username);
  return p.FullAccess === "Yes" || p.OfficeTimesheet === "Yes";
}
async function openSegmentRow(env, username) {
  return env.DB.prepare(
    "SELECT * FROM office_shifts WHERE username=? AND clock_out IS NULL AND edited_out IS NULL AND (voided IS NULL OR voided=0) ORDER BY clock_in DESC LIMIT 1"
  ).bind(username).first();
}
function mondayOf(dateStr) {
  const d = /* @__PURE__ */ new Date(dateStr + "T12:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}
function weekDays(monday) {
  const base = /* @__PURE__ */ new Date(monday + "T12:00:00Z");
  const out = [];
  for (let i = 0; i < 7; i++) {
    const x = new Date(base);
    x.setUTCDate(base.getUTCDate() + i);
    out.push(x.toISOString().slice(0, 10));
  }
  return out;
}
async function weekDetail(env, username, week) {
  const monday = mondayOf(isDateStr(week) ? week : londonDate());
  const days = weekDays(monday);
  const sunday = days[6];
  const { results } = await env.DB.prepare(
    "SELECT * FROM office_shifts WHERE username=? AND date>=? AND date<=? ORDER BY clock_in"
  ).bind(username, monday, sunday).all();
  const byDay = {};
  for (const d of days) byDay[d] = { date: d, seconds: 0, open: false, segments: [] };
  let weekTotal = 0;
  for (const r of results || []) {
    const day = byDay[r.date] || (byDay[r.date] = { date: r.date, seconds: 0, open: false, segments: [] });
    const seg = shapeSeg(r);
    day.segments.push(seg);
    day.seconds += seg.seconds;
    weekTotal += seg.seconds;
    if (seg.open) day.open = true;
  }
  return { monday, sunday, days, byDay, weekTotal };
}
async function handle10(request, env, ctx, url) {
  const path = url.pathname;
  const sess = await requireSession(env, request);
  if (!sess) return error("Not authenticated", 401, env, request);
  const me = sess.user.username;
  if (path === "/office/config" && request.method === "GET") {
    const deviceId = url.searchParams.get("device") || sess.session.device_id || "";
    const perm = await hasOfficePerm(env, me);
    const enabled = perm && await deviceEnabled(env, me, deviceId);
    const today = londonDate();
    const open = await openSegmentRow(env, me);
    const { results } = await env.DB.prepare(
      "SELECT * FROM office_shifts WHERE username=? AND date=?"
    ).bind(me, today).all();
    let todayClosedSeconds = 0;
    for (const r of results || []) if (!isOpenRow(r)) todayClosedSeconds += segSeconds(r);
    return json({
      ok: true,
      enabled: !!enabled,
      hasPermission: perm,
      today,
      open: open ? { id: open.id, date: open.date, clockIn: effIn(open), stale: open.date !== today } : null,
      todayClosedSeconds
    }, {}, env, request);
  }
  if (path === "/office/clock-in" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    const deviceId = b.deviceId || sess.session.device_id || "";
    if (!await hasOfficePerm(env, me))
      return error("Office clock isn't enabled for your account.", 403, env, request);
    if (!await deviceEnabled(env, me, deviceId))
      return error("This device isn't set up for the office clock.", 403, env, request);
    const open = await openSegmentRow(env, me);
    if (open) return json({ ok: true, already: true, open: { id: open.id, date: open.date, clockIn: effIn(open) } }, {}, env, request);
    const now = /* @__PURE__ */ new Date();
    const iso = now.toISOString();
    const date = londonDate(now);
    const res = await env.DB.prepare(
      "INSERT INTO office_shifts (username, date, clock_in, device_id, updated_at) VALUES (?,?,?,?,?)"
    ).bind(me, date, iso, deviceId, iso).run();
    return json({ ok: true, open: { id: res.meta ? res.meta.last_row_id : void 0, date, clockIn: iso } }, {}, env, request);
  }
  if (path === "/office/clock-out" && request.method === "POST") {
    const open = await openSegmentRow(env, me);
    if (!open) return json({ ok: true, closed: false }, {}, env, request);
    const iso = (/* @__PURE__ */ new Date()).toISOString();
    await env.DB.prepare("UPDATE office_shifts SET clock_out=?, updated_at=? WHERE id=?").bind(iso, iso, open.id).run();
    return json({ ok: true, closed: true, seconds: secondsBetween(effIn(open), iso), date: open.date }, {}, env, request);
  }
  if (path === "/office/my" && request.method === "GET") {
    const detail = await weekDetail(env, me, url.searchParams.get("week") || "");
    return json({ ok: true, ...detail }, {}, env, request);
  }
  if (path === "/office/user-week" && request.method === "GET") {
    if (!await isTimesheetAdmin(env, me)) return error("Forbidden", 403, env, request);
    const u = url.searchParams.get("u");
    if (!u) return error("Missing ?u=", 400, env, request);
    const detail = await weekDetail(env, u, url.searchParams.get("week") || "");
    const row = await env.DB.prepare("SELECT first_name, last_name FROM users WHERE username=?").bind(u).first();
    const name = row ? `${row.first_name || ""} ${row.last_name || ""}`.trim() || u : u;
    return json({ ok: true, username: u, name, ...detail }, {}, env, request);
  }
  if (path === "/office/segment" && request.method === "POST") {
    if (!await isTimesheetAdmin(env, me)) return error("Forbidden", 403, env, request);
    const b = await request.json().catch(() => ({}));
    if (!b.id) return error("Segment id required", 400, env, request);
    const row = await env.DB.prepare("SELECT * FROM office_shifts WHERE id=?").bind(b.id).first();
    if (!row) return error("Segment not found", 404, env, request);
    const nowIso = (/* @__PURE__ */ new Date()).toISOString();
    if (b.clear) {
      const date2 = londonDate(new Date(row.clock_in));
      await env.DB.prepare(
        "UPDATE office_shifts SET edited_in=NULL, edited_out=NULL, edit_note=NULL, voided=0, edited_by=?, edited_at=?, date=?, updated_at=? WHERE id=?"
      ).bind(me, nowIso, date2, nowIso, b.id).run();
      const fresh2 = await env.DB.prepare("SELECT * FROM office_shifts WHERE id=?").bind(b.id).first();
      return json({ ok: true, segment: shapeSeg(fresh2) }, {}, env, request);
    }
    let editedIn = row.edited_in, editedOut = row.edited_out, voided = isVoided(row) ? 1 : 0;
    if ("editedIn" in b) {
      editedIn = b.editedIn ? toIso(b.editedIn) : null;
      if (b.editedIn && !editedIn) return error("Invalid start time.", 400, env, request);
    }
    if ("editedOut" in b) {
      editedOut = b.editedOut ? toIso(b.editedOut) : null;
      if (b.editedOut && !editedOut) return error("Invalid end time.", 400, env, request);
    }
    if ("void" in b) voided = b.void ? 1 : 0;
    const fIn = editedIn || row.clock_in;
    const fOut = editedOut || row.clock_out;
    if (fOut && Date.parse(fOut) < Date.parse(fIn))
      return error("End time can't be before the start time.", 400, env, request);
    const date = londonDate(new Date(fIn));
    await env.DB.prepare(
      "UPDATE office_shifts SET edited_in=?, edited_out=?, edit_note=?, voided=?, edited_by=?, edited_at=?, date=?, updated_at=? WHERE id=?"
    ).bind(editedIn, editedOut, b.note || null, voided, me, nowIso, date, nowIso, b.id).run();
    const fresh = await env.DB.prepare("SELECT * FROM office_shifts WHERE id=?").bind(b.id).first();
    return json({ ok: true, segment: shapeSeg(fresh) }, {}, env, request);
  }
  if (path === "/office/timesheet" && request.method === "GET") {
    if (!await isTimesheetAdmin(env, me)) return error("Forbidden", 403, env, request);
    const monday = mondayOf(isDateStr(url.searchParams.get("week") || "") ? url.searchParams.get("week") : londonDate());
    const days = weekDays(monday);
    const sunday = days[6];
    const { results } = await env.DB.prepare(
      "SELECT * FROM office_shifts WHERE date >= ? AND date <= ? ORDER BY username, clock_in"
    ).bind(monday, sunday).all();
    const { results: permUsers } = await env.DB.prepare(
      "SELECT username FROM user_permissions WHERE permission='OfficeClock' AND value=1"
    ).all();
    const { results: userRows } = await env.DB.prepare("SELECT username, first_name, last_name FROM users").all();
    const nameOf = {};
    for (const u of userRows || []) nameOf[u.username] = `${u.first_name || ""} ${u.last_name || ""}`.trim() || u.username;
    const map = {};
    const ensure = (u) => map[u] || (map[u] = { username: u, name: nameOf[u] || u, days: {}, total: 0, open: false });
    for (const u of permUsers || []) ensure(u.username);
    for (const r of results || []) {
      const e = ensure(r.username);
      if (isOpenRow(r)) {
        e.open = true;
        continue;
      }
      const sec = segSeconds(r);
      e.days[r.date] = (e.days[r.date] || 0) + sec;
      e.total += sec;
    }
    const users = Object.values(map).sort((a, b) => a.name.localeCompare(b.name));
    return json({ ok: true, monday, sunday, days, users }, {}, env, request);
  }
  return error("Unknown office route", 404, env, request);
}

// src/index.js
var ROUTES = [
  ["*", "/auth", handle],
  ["*", "/admin/login-history", loginHistory],
  ["*", "/user", handle2],
  // /user and /users
  ["*", "/onboard", handle2],
  // public self-registration (Pending)
  ["*", "/hs-plan-config", handle2],
  ["*", "/po-config", handle2],
  ["*", "/device", handle3],
  ["*", "/holiday", handle4],
  ["*", "/asset", handle5],
  // /assets, /asset/*, /asset-image, /asset-thumb
  ["*", "/transfer", handle5],
  // /transfer, /transfer-log
  ["*", "/upload-asset-image", handle5],
  ["*", "/delete-asset-image", handle5],
  ["*", "/sla", handle6],
  ["*", "/get-sites", handle7],
  ["*", "/add-site", handle7],
  ["*", "/update-site", handle7],
  ["*", "/next-project-job-number", handle7],
  ["*", "/upload-image", handle7],
  ["*", "/customers", handle7],
  ["*", "/import-sites", handle7],
  ["*", "/sites", handle7],
  // /sites/street-images (bulk imagery)
  ["*", "/settings", handle8],
  ["*", "/oncall", handle8],
  ["*", "/daily-logs", handle8],
  ["*", "/sitelog", handle9],
  ["*", "/sitelog-launch", handle9],
  ["*", "/office", handle10]
  // office clock in/out + weekly timesheet
  // Excluded for now (separate / later systems): Purchase Orders,
  // Hours/Timesheets, Labour Planning, Check-in/out, Vehicles,
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
  // Public self-registration form (login page → "Sign up").
  ["POST", "/onboard"],
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
