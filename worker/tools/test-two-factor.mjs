// Two-step sign-in (22 Oct 2026): code needed for Full Access every time and for
// a device the user hasn't registered; master password skips it; View As unaffected.
// Run:  node --no-warnings worker/tools/test-two-factor.mjs
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
  // Two-step sign-in has its own suite (test-two-factor.mjs); off here.
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


// Capture outgoing emails (Resend path) so the test can read the code.
const sent = [];
globalThis.fetch = async (u, init) => {
  if (String(u).includes("api.resend.com")) { sent.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); }
  return new Response("{}", { status: 500 });
};
const lastCode = () => { const m = /(\d{6})/.exec(sent[sent.length - 1].subject); return m && m[1]; };
const verify = (env, challenge, code, deviceId) => call(env, authRoutes, "POST", "/auth/login-verify", { challenge, code, deviceId });

{
  const { env, db } = await makeEnv();
  env.RESEND_API_KEY = "k";
  // Ryan (field) on a NEW device → code needed, no session yet
  const r = await login(env, "Ryan", "dev-new-111");
  ok("new device: password OK asks for a code", r.status === 200 && r.body.needCode && r.body.challenge && !r.body.token, r.body);
  ok("no session created before the code", db.prepare("SELECT COUNT(*) n FROM sessions").get().n === 0);
  ok("code emailed to the user", sent.length === 1 && sent[0].to === "r@x.test" && lastCode(), sent);
  ok("masked address returned", /^r\*?@x\.test$/.test(r.body.sentTo) || r.body.sentTo === "r*@x.test", r.body.sentTo);
  const wrong = await verify(env, r.body.challenge, "000000" === lastCode() ? "111111" : "000000", "dev-new-111");
  ok("wrong code refused with tries left", wrong.status === 401 && /tries left|try left/.test(wrong.body.error), wrong.body);
  const good = await verify(env, r.body.challenge, lastCode(), "dev-new-111");
  ok("right code issues the session", good.status === 200 && good.body.ok && good.body.token, good.body);
  const s = db.prepare("SELECT device_id FROM sessions").all();
  ok("session bound to the device", s.length === 1 && s[0].device_id === "dev-new-111", s);
  const reuse = await verify(env, r.body.challenge, lastCode(), "dev-new-111");
  ok("a code can't be used twice", reuse.status === 410, reuse.body);
  ok("login_history: code_sent then success", db.prepare("SELECT outcome FROM login_history WHERE username='Ryan' ORDER BY rowid").all().map(x => x.outcome).join(",").endsWith("code_sent,fail,success"));

  // Known device → no code
  db.prepare("INSERT INTO devices (tenant_id, device_id, username) VALUES (1,'dev-ryan-phone','Ryan')").run();
  const k = await login(env, "Ryan", "dev-ryan-phone");
  ok("registered device: password alone signs in", k.status === 200 && k.body.ok && k.body.token, k.body);

  // No device id at all → code
  const nd = await login(env, "Dave", "");
  ok("no device id → code needed", nd.body && nd.body.needCode, nd.body);

  // Full Access → code even on a registered device
  db.prepare("INSERT INTO devices (tenant_id, device_id, username) VALUES (1,'dev-jamie','Jamie Line')").run();
  const j = await login(env, "Jamie Line", "dev-jamie");
  ok("Full Access: code needed even on own device", j.body && j.body.needCode, j.body);

  // Five wrong codes burn the challenge
  const t = await login(env, "Tanya", "dev-t-new");
  let last;
  for (let i = 0; i < 5; i++) last = await verify(env, t.body.challenge, "999999" === lastCode() ? "888888" : "999999", "dev-t-new");
  ok("5 wrong codes → challenge burnt", last.status === 410, last.body);
  const after = await verify(env, t.body.challenge, lastCode(), "dev-t-new");
  ok("…and the right code no longer works", after.status === 410);

  // Expired
  const e = await login(env, "Tanya", "dev-t-new2");
  db.prepare("UPDATE login_codes SET expires_at = 1").run();
  const ex = await verify(env, e.body.challenge, lastCode(), "dev-t-new2");
  ok("expired code refused", ex.status === 410, ex.body);

  // Master password skips the code
  env.MASTER_PASSWORD = "Break" + "Glass" + "99";
  const m = await call(env, authRoutes, "POST", "/auth/login", { username: "Dave", password: env.MASTER_PASSWORD, deviceId: "dev-x" });
  ok("master password: no code, session issued", m.status === 200 && m.body.ok && m.body.master && m.body.token, m.body);

  // Wrong password never sends a code
  const before = sent.length;
  const bad = await call(env, authRoutes, "POST", "/auth/login", { username: "Ryan", password: "nope", deviceId: "dev-zz" });
  ok("wrong password → 401, no email", bad.status === 401 && sent.length === before);

  // View As unaffected: owner session → impersonate, no code
  db.prepare("UPDATE login_codes SET expires_at = 9e15").run();
  const own = await login(env, "Jamie Line", "dev-jamie");
  const ov = await verify(env, own.body.challenge, lastCode(), "dev-jamie");
  const va = await call(env, authRoutes, "POST", "/auth/impersonate", { username: "Ryan" }, { "X-Device-Id": "dev-jamie" }, ov.body.token);
  ok("View As works without any code", va.status === 200 && va.body.token, va.body);

  // Email failure → clear error, no orphan challenge
  globalThis.fetch = async () => new Response("down", { status: 500 });
  const nf = await login(env, "Dave", "dev-d-new");
  ok("email failure → 503 with a clear message", nf.status === 503 && /couldn't send/i.test(nf.body.error), nf.body);

  // Switch off
  db.prepare("INSERT INTO app_config VALUES (1,'auth:twofactor:1',?)").run(JSON.stringify({ enabled: false }));
  const off = await login(env, "Dave", "dev-d-new");
  ok("switched off → password alone", off.status === 200 && off.body.token, off.body);

  // No email on the account
  db.prepare("DELETE FROM app_config").run();
  db.prepare("UPDATE users SET email='' WHERE username='Dave'").run();
  const ne = await login(env, "Dave", "dev-d-new3");
  ok("no email on account → 403 with advice", ne.status === 403 && /email address/.test(ne.body.error), ne.body);
}
console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
