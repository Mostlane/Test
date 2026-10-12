// SiteLog device identity: a phone that forgot its id must never become a
// duplicate person. Real SQLite behind a D1 shim, driving sitelog-api.handle().
// Run: node --no-warnings worker/tools/test-sitelog-identity.mjs
import { DatabaseSync } from "node:sqlite";
import * as sl from "../src/routes/sitelog-api.js";

function d1(db) {
  const wrap = (sql) => { let binds = []; const st = {
    bind(...a) { binds = a.map(v => v === undefined ? null : v); return st; },
    async first() { return db.prepare(sql).get(...binds) ?? null; },
    async all() { return { results: db.prepare(sql).all(...binds) }; },
    async run() { const r = db.prepare(sql).run(...binds); return { meta: { changes: r.changes, last_row_id: r.lastInsertRowid } }; },
  }; return st; };
  return { prepare: wrap, async batch(s) { return Promise.all(s.map(x => x.run())); }, async exec(q) { db.exec(q); } };
}
const db = new DatabaseSync(":memory:");
db.exec(`
  CREATE TABLE people (id TEXT PRIMARY KEY, first_name TEXT, last_name TEXT, company TEXT, purpose TEXT, archived INTEGER DEFAULT 0, person_type TEXT, portal_username TEXT, hourly_rate REAL, travel_status TEXT, is_transfer_pending INTEGER DEFAULT 0, created_at TEXT);
  CREATE TABLE devices (device_token TEXT PRIMARY KEY, person_id TEXT, first_seen_at TEXT, last_seen TEXT);
  CREATE TABLE sites (id TEXT PRIMARY KEY, site_name TEXT, lat REAL, lng REAL, radius_m INTEGER DEFAULT 500, archived INTEGER DEFAULT 0, site_rules TEXT, category TEXT, site_rules_visitor TEXT);
  CREATE TABLE visits (id TEXT PRIMARY KEY, person_id TEXT, site_code TEXT, check_in_at TEXT, check_out_at TEXT);
  INSERT INTO people (id, first_name, last_name, company) VALUES
    ('zane','Zane','Leopold','Storm Agency'), ('js1','John','Smith','Mostlane'), ('js2','John','Smith','Mostlane'),
    ('old','Old','Timer','DCI');
  UPDATE people SET archived=1 WHERE id='old';
  INSERT INTO devices (device_token, person_id) VALUES ('zane-phone','zane'), ('old-phone','old');
`);
const env = { SITELOG_DB: d1(db) };
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };
async function call(method, path, body, cookie) {
  const headers = { "Content-Type": "application/json", Origin: "https://site-log.co.uk" };
  if (cookie) headers.Cookie = "ml_did=" + cookie;
  const req = new Request("https://api2.site-log.co.uk" + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const res = await sl.handle(req, env, { waitUntil() {} });
  return { status: res.status, body: await res.json(), cookie: res.headers.get("Set-Cookie") };
}
const people = () => db.prepare("SELECT COUNT(*) n FROM people").get().n;
const owner = t => db.prepare("SELECT person_id p FROM devices WHERE device_token=?").get(t)?.p;

// 1. /device-recover hands back the cookie's token for a live person
let r = await call("GET", "/device-recover", null, "zane-phone");
ok(r.body.deviceToken === "zane-phone", "recover returns cookie token");
r = await call("GET", "/device-recover", null);
ok(r.body.deviceToken === null, "no cookie → nothing");
r = await call("GET", "/device-recover", null, "nobody");
ok(r.body.deviceToken === null, "unknown cookie → nothing");
r = await call("GET", "/device-recover", null, "old-phone");
ok(r.body.deviceToken === null, "archived person's cookie not recovered");

// 2. /scan and /me never adopt on their own (the scanner asks /device-recover)
r = await call("GET", "/me?deviceToken=fresh-1", null, "zane-phone");
ok(r.body.registered === false && !owner("fresh-1"), "/me does not silently adopt");

// 3. /register on a fresh id with the cookie → already_registered, no new person
const before = people();
r = await call("POST", "/register", { deviceToken: "fresh-2", firstName: "Zane", lastName: "Leopold", company: "Storm Agency" }, "zane-phone");
ok(r.body.status === "already_registered" && r.body.personId === "zane", "register via cookie = existing");
ok(people() === before, "no duplicate (cookie)");

// 4. Storage AND cookie gone: name + company match relinks
r = await call("POST", "/register", { deviceToken: "fresh-3", firstName: " zane ", lastName: "LEOPOLD", company: "storm agency", purpose: "Contractor", personType: "contractor" });
ok(r.body.status === "relinked" && r.body.personId === "zane", "name match relinks");
ok(owner("fresh-3") === "zane" && people() === before, "no duplicate (name match)");
ok(/ml_did=fresh-3/.test(r.cookie || ""), "relink sets the cookie");

// 5. Same name, different company → genuinely new person
r = await call("POST", "/register", { deviceToken: "fresh-4", firstName: "Zane", lastName: "Leopold", company: "DCI" });
ok(r.body.status === "registered" && r.body.personId !== "zane", "different company = new person");

// 6. Ambiguous (two John Smiths at Mostlane) → no guess, new person
r = await call("POST", "/register", { deviceToken: "fresh-5", firstName: "John", lastName: "Smith", company: "Mostlane" });
ok(r.body.status === "registered" && !["js1","js2"].includes(r.body.personId), "ambiguous match not guessed");

// 7. Archived namesake is never revived
r = await call("POST", "/register", { deviceToken: "fresh-6", firstName: "Old", lastName: "Timer", company: "DCI" });
ok(r.body.status === "registered" && r.body.personId !== "old", "archived person not relinked");

// 8. "Not you?": cookie of Zane, but a DIFFERENT person registers → not Zane
r = await call("POST", "/register", { deviceToken: "fresh-8", firstName: "Ryan", lastName: "Diggens", company: "Mostlane" }, "zane-phone");
ok(r.body.status === "registered" && r.body.personId !== "zane", "handed-over phone never inherits previous person");
r = await call("POST", "/device-forget", {});
ok(/ml_did=;\s*Max-Age=0/.test(r.cookie || "") && /Domain=site-log\.co\.uk/.test(r.cookie || ""), "device-forget clears the cookie");

// 9. Brand-new person registers normally
r = await call("POST", "/register", { deviceToken: "fresh-7", firstName: "New", lastName: "Starter", company: "Mostlane" });
ok(r.body.status === "registered", "new person registers");

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
