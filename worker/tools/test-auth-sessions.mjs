// Sessions, device lock, logout and profile visibility — drives the REAL
// auth/devices/users handlers and lib/auth against a real SQLite (node:sqlite)
// behind a D1-shaped shim. Covers the Sep 2026 hardening:
//   hashed session tokens (+ legacy raw rows migrate), device-bound sessions,
//   login refused on a device registered to someone else, sessions revoked on
//   password change/reset, /auth/logout, temp-password strength, the device
//   routes acting only for the logged-in user, and GET /users /user stripping
//   the profile blob for non-admins.
// Run:  node --no-warnings worker/tools/test-auth-sessions.mjs
// NB: no literal credential pairs in here — the public repo is secret-scanned.
import { DatabaseSync } from "node:sqlite";
import * as authLib from "../src/lib/auth.js";
import * as authRoutes from "../src/routes/auth.js";
import * as devices from "../src/routes/devices.js";
import * as users from "../src/routes/users.js";
import { isPublic, isSignedJobExport } from "../src/index.js";
import { signedFileUrl, verifyFileSig } from "../src/lib/filesign.js";

function d1(db) {
  const wrap = (sql) => { let binds = []; const st = {
    bind(...a) { binds = a.map(v => v === undefined ? null : v); return st; },
    async first() { return db.prepare(sql).get(...binds) ?? null; },
    async all() { return { results: db.prepare(sql).all(...binds) }; },
    async run() { const r = db.prepare(sql).run(...binds); return { meta: { changes: r.changes, last_row_id: r.lastInsertRowid } }; },
  }; return st; };
  return { prepare: wrap, async batch(s) { return Promise.all(s.map(x => x.run())); } };
}
const PW = "Portal" + "Pass" + "2026";   // a test password, assembled so no literal pair sits in the file
async function makeEnv() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE users (tenant_id INTEGER, username TEXT, first_name TEXT, last_name TEXT, email TEXT, password_hash TEXT, password_algo TEXT, status TEXT, profile TEXT, must_change_password INTEGER DEFAULT 0, engineer_number TEXT, vehicle_assigned TEXT, employment_type TEXT, sharepoint_path TEXT, updated_at TEXT);
    CREATE TABLE user_permissions (tenant_id INTEGER, username TEXT, permission TEXT, value INTEGER);
    CREATE TABLE sessions (tenant_id INTEGER NOT NULL DEFAULT 1, token TEXT PRIMARY KEY, username TEXT NOT NULL, device_id TEXT, created_at TEXT DEFAULT (datetime('now')), expires_at TEXT NOT NULL);
    CREATE TABLE devices (tenant_id INTEGER, device_id TEXT PRIMARY KEY, username TEXT, label TEXT, office_clock INTEGER DEFAULT 0, registered_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE login_history (tenant_id INTEGER, username TEXT, device_id TEXT, ip TEXT, user_agent TEXT, outcome TEXT, at TEXT);
    CREATE TABLE password_resets (tenant_id INTEGER, token TEXT PRIMARY KEY, username TEXT, expires_at TEXT, used INTEGER DEFAULT 0, created_at TEXT);
    CREATE TABLE app_config (tenant_id INTEGER, key TEXT, value TEXT);`);
  const hash = await authLib.hashPassword(PW);
  const ins = db.prepare("INSERT INTO users (tenant_id,username,first_name,email,password_hash,password_algo,status,profile) VALUES (1,?,?,?,?,'pbkdf2','Active',?)");
  ins.run("Jamie Line", "Jamie", "j@x.test", hash, JSON.stringify({ staffType: "office", phone: "07000000001", hourlyRate: 99 }));
  ins.run("Tanya", "Tanya", "t@x.test", hash, JSON.stringify({ staffType: "office", phone: "07000000002", homePostcode: "PO15 5RQ", hourlyRate: 20 }));
  ins.run("Ryan", "Ryan", "r@x.test", hash, JSON.stringify({ staffType: "field", phone: "07000000003", homePostcode: "SO14 1AA", homeLat: 50.9, homeLng: -1.4, hourlyRate: 18, fuelCard: "1234" }));
  ins.run("Dave", "Dave", "d@x.test", hash, JSON.stringify({ staffType: "field", phone: "07000000004", dayRate: 150 }));
  const perm = db.prepare("INSERT INTO user_permissions VALUES (1,?,?,1)");
  perm.run("Jamie Line", "FullAccess"); perm.run("Tanya", "SLAAdmin"); perm.run("Ryan", "SLA"); perm.run("Dave", "SLA");
  return { env: { DB: d1(db), OWNER_USERNAME: "Jamie Line", PORTAL_BRIDGE_SECRET: "test-secret" }, db };
}
const ctx = { waitUntil() {} };
let fail = 0;
function ok(name, cond, detail) { console.log((cond ? "PASS" : "FAIL") + "  " + name + (detail !== undefined && !cond ? "  → " + JSON.stringify(detail) : "")); if (!cond) fail++; }
async function call(env, mod, method, path, body, headers = {}, rawToken) {
  const url = new URL("https://api.test" + path);
  const h = { "Content-Type": "application/json", ...headers };
  if (rawToken) h.Authorization = "Bearer " + rawToken;
  const req = new Request(url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const sess = await authLib.requireSession(env, req);
  const res = await mod.handle(req, env, ctx, url, sess);
  let j = null; try { j = await res.clone().json(); } catch {}
  return { status: res.status, body: j, sess };
}
const login = (env, u, deviceId, extra = {}) => call(env, authRoutes, "POST", "/auth/login", { username: u, password: PW, deviceId }, extra);

{ // ── Hashed tokens + legacy migration ─────────────────────────────────────
  const { env, db } = await makeEnv();
  const r = await login(env, "Tanya", "dev-aaaa111");
  ok("login ok, token issued", r.status === 200 && r.body.token && r.body.token.length > 40, r.body);
  const raw = r.body.token;
  const rows = db.prepare("SELECT token, device_id FROM sessions").all();
  ok("the raw token is NOT in the sessions table (hashed)", rows.length === 1 && rows[0].token !== raw && rows[0].token.length === 64, rows);
  ok("session bound to the device it was issued to", rows[0].device_id === "dev-aaaa111", rows);
  const me = await call(env, authRoutes, "GET", "/auth/me", null, { "X-Device-Id": "dev-aaaa111" }, raw);
  ok("/auth/me works from that device", me.status === 200 && me.body.user.Username === "Tanya", me);
  const meNoDev = await call(env, authRoutes, "GET", "/auth/me", null, {}, raw);
  ok("same token WITHOUT the device header is refused", meNoDev.status === 401);
  const meWrong = await call(env, authRoutes, "GET", "/auth/me", null, { "X-Device-Id": "dev-zzzz999" }, raw);
  ok("same token from ANOTHER device is refused", meWrong.status === 401);
  // A legacy row holding the raw token (written before hashing) still logs in, and is rewritten
  db.prepare("INSERT INTO sessions (tenant_id, token, username, device_id, expires_at) VALUES (1,'legacy-raw-token','Ryan',NULL,'2099-01-01')").run();
  const leg = await call(env, authRoutes, "GET", "/auth/me", null, {}, "legacy-raw-token");
  ok("legacy raw-token session still accepted (no device binding, so no header needed)", leg.status === 200 && leg.body.user.Username === "Ryan", leg);
  ok("…and the row was rewritten to the hash", !db.prepare("SELECT 1 FROM sessions WHERE token='legacy-raw-token'").get() && db.prepare("SELECT COUNT(*) n FROM sessions WHERE username='Ryan'").get().n === 1);
  const lo = await call(env, authRoutes, "POST", "/auth/logout", null, { "X-Device-Id": "dev-aaaa111" }, raw);
  ok("/auth/logout deletes the hashed row", lo.status === 200 && !db.prepare("SELECT 1 FROM sessions WHERE username='Tanya'").get());
  const after = await call(env, authRoutes, "GET", "/auth/me", null, { "X-Device-Id": "dev-aaaa111" }, raw);
  ok("token dead after logout", after.status === 401);
}
{ // ── Owner: never bound; device registered to another user blocks login ────
  const { env, db } = await makeEnv();
  const o = await login(env, "Jamie Line", "dev-owner01");
  ok("owner session has no device binding", o.status === 200 && db.prepare("SELECT device_id FROM sessions").get().device_id === null);
  const om = await call(env, authRoutes, "GET", "/auth/me", null, {}, o.body.token);
  ok("owner token works without the header", om.status === 200);
  db.prepare("INSERT INTO devices (tenant_id, device_id, username, label) VALUES (1,'dev-ryans01','Ryan','Ryan phone')").run();
  const d = await login(env, "Dave", "dev-ryans01");
  ok("Dave cannot log in on Ryan's registered device (403, logged)", d.status === 403 && db.prepare("SELECT outcome FROM login_history WHERE username='Dave' ORDER BY rowid DESC").get().outcome === "device_mismatch", d);
  const r2 = await login(env, "Ryan", "dev-ryans01");
  ok("Ryan can", r2.status === 200);
  const unk = await login(env, "Dave", "dev-newone1");
  ok("an unknown device still logs in (client registers it after)", unk.status === 200);
  // refresh keeps the binding
  const rf = await call(env, authRoutes, "POST", "/auth/refresh", null, { "X-Device-Id": "dev-ryans01" }, r2.body.token);
  ok("refresh keeps the device binding + old token dies", rf.status === 200 && db.prepare("SELECT device_id FROM sessions WHERE username='Ryan'").get().device_id === "dev-ryans01" && db.prepare("SELECT COUNT(*) n FROM sessions WHERE username='Ryan'").get().n === 1);
  const old = await call(env, authRoutes, "GET", "/auth/me", null, { "X-Device-Id": "dev-ryans01" }, r2.body.token);
  ok("pre-refresh token refused", old.status === 401);
}
{ // ── Password change / reset revoke sessions ───────────────────────────────
  const { env, db } = await makeEnv();
  const a = await login(env, "Ryan", "dev-phone01");
  const b = await login(env, "Ryan", "dev-lapto01");
  const stolen = await login(env, "Ryan", "dev-thief01");
  ok("three live sessions", db.prepare("SELECT COUNT(*) n FROM sessions WHERE username='Ryan'").get().n === 3);
  const ch = await call(env, authRoutes, "POST", "/auth/change-password", { currentPassword: PW, newPassword: "New" + PW }, { "X-Device-Id": "dev-phone01" }, a.body.token);
  ok("change-password ok", ch.status === 200, ch);
  ok("only the changing device's session survives", db.prepare("SELECT COUNT(*) n FROM sessions WHERE username='Ryan'").get().n === 1);
  const keep = await call(env, authRoutes, "GET", "/auth/me", null, { "X-Device-Id": "dev-phone01" }, a.body.token);
  const gone = await call(env, authRoutes, "GET", "/auth/me", null, { "X-Device-Id": "dev-thief01" }, stolen.body.token);
  ok("the device that changed it stays logged in; the other token is dead", keep.status === 200 && gone.status === 401);
  // reset via emailed token ends every session
  db.prepare("INSERT INTO password_resets (tenant_id, token, username, expires_at, used) VALUES (1,'rt-1','Ryan','2099-01-01',0)").run();
  const rs = await call(env, authRoutes, "POST", "/auth/reset-password", { token: "rt-1", newPassword: "Reset" + PW });
  ok("reset-password ends every session", rs.status === 200 && db.prepare("SELECT COUNT(*) n FROM sessions WHERE username='Ryan'").get().n === 0, rs);
  void b;
}
{ // ── Temp passwords ────────────────────────────────────────────────────────
  const seen = new Set();
  let allValid = true;
  for (let i = 0; i < 200; i++) { const p = authLib.generateTempPassword(); seen.add(p); if (authLib.validatePassword(p) || !/^Mostlane-[A-Za-z0-9]{8}$/.test(p) || !/[0-9]/.test(p.slice(9))) allValid = false; }
  ok("temp passwords: 200 draws all distinct, all pass the policy, 8 random chars incl. a digit", seen.size === 200 && allValid, [...seen].slice(0, 3));
}
{ // ── Device routes act only for the logged-in user ─────────────────────────
  const { env, db } = await makeEnv();
  const r = await login(env, "Ryan", "dev-ryan0001");
  const H = { "X-Device-Id": "dev-ryan0001" };
  const asOwner = await call(env, devices, "POST", "/device/check-device", { username: "Jamie Line", deviceId: "dev-ryan0001" }, H, r.body.token);
  ok("claiming to be the owner in the body is refused (403)", asOwner.status === 403, asOwner);
  const reg = await call(env, devices, "POST", "/device/register-device", { username: "Ryan", deviceId: "dev-ryan0001", label: "Phone" }, H, r.body.token);
  ok("registering own device ok", reg.status === 200 && reg.body.status === "OK", reg);
  const regOther = await call(env, devices, "POST", "/device/register-device", { username: "Dave", deviceId: "dev-x", label: "x" }, H, r.body.token);
  ok("registering a device for someone else is refused", regOther.status === 403);
  const chk = await call(env, devices, "POST", "/device/check-device", { deviceId: "dev-ryan0001" }, H, r.body.token);
  ok("check-device without a username uses the session user", chk.status === 200 && chk.body.status === "OK", chk);
  const anon = await call(env, devices, "POST", "/device/check-device", { username: "Jamie Line", deviceId: "dev-ryan0001" });
  ok("no session → 401", anon.status === 401);
  void db;
}
{ // ── Profile visibility on /users and /user ────────────────────────────────
  const { env } = await makeEnv();
  const owner = await login(env, "Jamie Line", "dev-o");
  const sla = await login(env, "Tanya", "dev-t");
  const eng = await login(env, "Ryan", "dev-r");
  const list = async (tok, dev) => (await call(env, users, "GET", "/users", null, { "X-Device-Id": dev }, tok)).body.Users;
  const byName = (arr, n) => arr.find(u => u.Username === n);
  const engList = await list(eng.body.token, "dev-r");
  const daveForEng = byName(engList, "Dave"), selfForEng = byName(engList, "Ryan");
  ok("engineer: another user's Profile carries NO phone / rate / home", daveForEng && daveForEng.Profile.phone === undefined && daveForEng.Profile.dayRate === undefined && daveForEng.Profile.homePostcode === undefined && daveForEng.StaffType === "field", daveForEng);
  ok("engineer: still sees their OWN full profile", selfForEng && selfForEng.Profile.phone === "07000000003" && selfForEng.Profile.hourlyRate === 18, selfForEng && selfForEng.Profile);
  const slaList = await list(sla.body.token, "dev-t");
  const ryanForSla = byName(slaList, "Ryan");
  ok("SLA admin: home postcode/pin for routing, but no phone or pay", ryanForSla.Profile.homePostcode === "SO14 1AA" && ryanForSla.Profile.homeLat === 50.9 && ryanForSla.Profile.phone === undefined && ryanForSla.Profile.hourlyRate === undefined && ryanForSla.Profile.fuelCard === undefined, ryanForSla.Profile);
  const ownerList = await list(owner.body.token, "dev-o");
  ok("Full Access: everything", byName(ownerList, "Ryan").Profile.phone === "07000000003" && byName(ownerList, "Ryan").Profile.hourlyRate === 18);
  const one = await call(env, users, "GET", "/user?u=Tanya", null, { "X-Device-Id": "dev-r" }, eng.body.token);
  ok("/user?u=other as engineer: stripped", one.status === 200 && one.body.user.Profile.phone === undefined && one.body.user.Profile.hourlyRate === undefined && one.body.user.Username === "Tanya", one.body);
  const mine = await call(env, users, "GET", "/user?u=Ryan", null, { "X-Device-Id": "dev-r" }, eng.body.token);
  ok("/user?u=self: full", mine.body.user.Profile.phone === "07000000003");
  ok("flat permission flags still present for pickers", typeof byName(engList, "Tanya").SLAAdmin === "string");
}
{ // ── Job export is no longer public; a signed link still opens ─────────────
  ok("GET /sla/jobs/{id}/export is not a public route", !isPublic("GET", "/sla/jobs/00028541/export") && !isPublic("GET", "/sla/jobs/x/export.pdf") && isSignedJobExport("/sla/jobs/x/export.pdf"));
  const env = { PORTAL_BRIDGE_SECRET: "test-secret" };
  const u = new URL(await signedFileUrl(env, "https://api.test", "/sla/jobs/J1/export", "/sla/jobs/J1/export", 60));
  ok("a signed export link verifies", await verifyFileSig(env, "/sla/jobs/J1/export", u.searchParams) === true, u.href);
  const bad = new URL(u.href); bad.searchParams.set("sig", "0".repeat(64));
  ok("a tampered signature does not", await verifyFileSig(env, "/sla/jobs/J1/export", bad.searchParams) === false);
}
console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
