// Authentication: password hashing + server-side sessions.
//
// Why this exists: the old portal "logged you in" by setting a localStorage
// flag in the browser, and the Workers didn't check who was calling. This
// module gives every request a real, server-verified session token and moves
// passwords off unsalted SHA-256 onto salted PBKDF2 (auto-upgraded on login).

const enc = new TextEncoder();

function toHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// ── Legacy verification: existing users.json hashes are unsalted SHA-256 ─────
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return toHex(digest);
}

// ── New password hashing: PBKDF2 (salted, 100k iterations) ───────────────────
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256
  );
  return `pbkdf2$100000$${toHex(salt)}$${toHex(bits)}`;
}

export async function verifyPbkdf2(password, stored) {
  let [, iterStr, saltHex, hashHex] = String(stored || "").split("$");
  // Repair hashes written by a corrupted historic deploy where the template's
  // "$$" separators were eaten (stored as pbkdf2$100000<salt><hash>).
  if (!saltHex && /^100000[0-9a-f]{96}$/.test(iterStr || "")) {
    saltHex = iterStr.slice(6, 38); hashHex = iterStr.slice(38); iterStr = "100000";
  }
  // Malformed hash -> fail the login cleanly instead of crashing the worker.
  if (!iterStr || !saltHex || !hashHex || saltHex.length % 2) return false;
  const salt = Uint8Array.from(saltHex.match(/.{2}/g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: Number(iterStr), hash: "SHA-256" }, key, 256
  );
  return toHex(bits) === hashHex;
}

// Verify against whichever algo the user row is using.
export async function verifyPassword(password, user) {
  if (user.password_algo === "pbkdf2") return verifyPbkdf2(password, user.password_hash);
  // legacy sha256
  return (await sha256Hex(password)) === (user.password_hash || "");
}

// ── Password policy ──────────────────────────────────────────────────────────
// Returns an error string, or null if the password is acceptable.
export function validatePassword(pw) {
  if (typeof pw !== "string" || pw.length < 8) return "Password must be at least 8 characters.";
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return "Password must contain a letter and a number.";
  return null;
}

// Short, readable temporary password for admin resets (e.g. "Mostlane-4827").
export function generateTempPassword() {
  return "Mostlane-" + Math.floor(1000 + Math.random() * 9000);
}

// ── Sessions ─────────────────────────────────────────────────────────────────
// A session is bound to the tenant its user belongs to. That tenant travels
// with every request (requireSession returns it) and is the ONLY source of
// truth for isolation — it is never read from a request body or query string.
export async function createSession(env, username, deviceId, tenantId) {
  if (tenantId === undefined || tenantId === null) {
    throw new Error("createSession: tenantId is required");
  }
  const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
  // 90 days by default — a logged-in device stays valid without re-login.
  // Admin password resets still kill sessions immediately (users.js deletes
  // them), so a compromised account can always be cut off at once.
  const ttlH = Number(env.SESSION_TTL_HOURS || 2160);
  const expires = new Date(Date.now() + ttlH * 3600 * 1000).toISOString();
  await env.DB.prepare(
    "INSERT INTO sessions (token, username, device_id, tenant_id, expires_at) VALUES (?,?,?,?,?)"
  ).bind(token, username, deviceId || null, tenantId, expires).run();
  return { token, expires };
}

// Returns { session, user, tenantId }, or null. Use to guard protected routes.
// The token is a global secret (the sessions PK), so it's looked up directly;
// the tenant then comes from the matched session row.
export async function requireSession(env, request) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const row = await env.DB.prepare(
    "SELECT * FROM sessions WHERE token = ? AND expires_at > datetime('now')"
  ).bind(token).first();
  if (!row) return null;
  const user = await env.DB.prepare("SELECT * FROM users WHERE tenant_id = ? AND username = ?")
    .bind(row.tenant_id, row.username).first();
  if (!user) return null;
  return { session: row, user, tenantId: row.tenant_id };
}

export async function destroySession(env, token) {
  await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
}

// Compose the flat permission object the existing front-end expects from /user.
// Scoped to the tenant so a username can only ever resolve permissions within
// its own company.
export async function permissionsFor(env, tenantId, username) {
  const { results } = await env.DB.prepare(
    "SELECT permission, value FROM user_permissions WHERE tenant_id = ? AND username = ?"
  ).bind(tenantId, username).all();
  const perms = {};
  for (const r of results || []) perms[r.permission] = r.value ? "Yes" : "No";
  return perms;
}
