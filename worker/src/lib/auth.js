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

// Temporary password for admin resets, e.g. "Mostlane-k7Q4mX2p". Eight
// characters from an unambiguous alphabet (no 0/O/1/l/I) drawn from the
// CSPRNG — ~10^13 possibilities, so the login throttle actually bites. Always
// contains a digit so it passes validatePassword. (Was Math.random() × 9000.)
export function generateTempPassword() {
  const ALPHA = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const DIGITS = "23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  let out = "";
  for (let i = 0; i < 7; i++) out += ALPHA[bytes[i] % ALPHA.length];
  const pos = bytes[7] % 8;
  out = out.slice(0, pos) + DIGITS[bytes[8] % DIGITS.length] + out.slice(pos);
  return "Mostlane-" + out;
}

// Session tokens are stored HASHED (SHA-256) so a database read never yields a
// usable token. The client keeps the raw token; every lookup hashes it first.
// Rows written before this change hold the raw token — requireSession still
// finds them (second lookup) and rewrites the row to the hash, so nobody is
// logged out by the migration.
export async function hashToken(token) {
  return sha256Hex("sess:" + String(token || ""));
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
  ).bind(await hashToken(token), username, deviceId || null, tenantId, expires).run();
  return { token, expires };
}

// Returns { session, user, tenantId }, or null. Use to guard protected routes.
// The token is a global secret (the sessions PK), so it's looked up directly;
// the tenant then comes from the matched session row.
export async function requireSession(env, request) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const hashed = await hashToken(token);
  let row = await env.DB.prepare(
    "SELECT * FROM sessions WHERE token = ? AND expires_at > datetime('now')"
  ).bind(hashed).first();
  if (!row) {
    // Legacy row written before tokens were hashed: accept it once and
    // rewrite it to the hash so the raw token no longer sits in the table.
    row = await env.DB.prepare(
      "SELECT * FROM sessions WHERE token = ? AND expires_at > datetime('now')"
    ).bind(token).first();
    if (!row) return null;
    try { await env.DB.prepare("UPDATE sessions SET token = ? WHERE token = ?").bind(hashed, token).run(); row.token = hashed; } catch {}
  }
  // Device binding (Sep 2026): a session created with a device id only works
  // from that device — the browser sends its id in X-Device-Id on every call
  // (portal-config's fetch bridge). A stolen token replayed from anywhere
  // else is refused. Sessions without a bound device (the owner, and rows
  // from before this change) are not restricted.
  if (row.device_id) {
    const dev = request.headers.get("X-Device-Id") || "";
    if (dev !== row.device_id) return null;
  }
  const user = await env.DB.prepare("SELECT * FROM users WHERE tenant_id = ? AND username = ?")
    .bind(row.tenant_id, row.username).first();
  if (!user) return null;
  return { session: row, user, tenantId: row.tenant_id };
}

// Accepts the raw token the client holds (deletes the hashed row, and any
// legacy raw row).
export async function destroySession(env, token) {
  const hashed = await hashToken(token);
  await env.DB.prepare("DELETE FROM sessions WHERE token = ? OR token = ?").bind(hashed, token).run();
}

// Revoke every session a user holds, optionally keeping the one that made the
// request (raw token). Called on password change/reset so a stolen 90-day
// token dies the moment the owner changes their password.
export async function revokeUserSessions(env, tenantId, username, keepRawToken) {
  const keep = keepRawToken ? await hashToken(keepRawToken) : null;
  await env.DB.prepare(
    "DELETE FROM sessions WHERE tenant_id = ? AND username = ? AND (? IS NULL OR (token <> ? AND token <> ?))"
  ).bind(tenantId, username, keep, keep, keepRawToken || "").run();
}

// Compose the flat permission object the existing front-end expects from /user.
// Scoped to the tenant so a username can only ever resolve permissions within
// its own company.
/* Who may see MONEY (order values, job costs, profit) — Jamie's rule (Sep 2026):
   Full Access users, or OFFICE staff (users.profile.staffType === "office").
   A field engineer never does, even with an SLAAdmin grant. Server-side gate;
   the pages mirror it for what they render. */
export async function canSeeMoney(env, tenantId, username) {
  if (!username) return false;
  try {
    const perms = await permissionsFor(env, tenantId, username);
    if (perms.FullAccess === "Yes") return true;
  } catch {}
  try {
    const row = await env.DB.prepare("SELECT profile FROM users WHERE tenant_id=? AND username=? LIMIT 1").bind(tenantId, username).first();
    if (!row) return false;
    const p = typeof row.profile === "string" ? JSON.parse(row.profile || "{}") : (row.profile || {});
    return !!p && p.staffType === "office";
  } catch { return false; }
}
export async function permissionsFor(env, tenantId, username) {
  const { results } = await env.DB.prepare(
    "SELECT permission, value FROM user_permissions WHERE tenant_id = ? AND username = ?"
  ).bind(tenantId, username).all();
  const perms = {};
  for (const r of results || []) perms[r.permission] = r.value ? "Yes" : "No";
  return perms;
}
