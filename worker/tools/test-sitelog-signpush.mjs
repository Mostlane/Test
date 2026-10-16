// SiteLog sign-in/out push: owner gets a notification naming who + who's on site.
// Run: node --no-warnings worker/tools/test-sitelog-signpush.mjs
import { DatabaseSync } from "node:sqlite";
import * as sl from "../src/routes/sitelog-api.js";
function d1(db) {
  const wrap = (sql) => { let b = []; const st = {
    bind(...a) { b = a.map(v => v === undefined ? null : v); return st; },
    async first() { return db.prepare(sql).get(...b) ?? null; },
    async all() { return { results: db.prepare(sql).all(...b) }; },
    async run() { const r = db.prepare(sql).run(...b); return { meta: { changes: r.changes } }; } }; return st; };
  return { prepare: wrap, async batch(s) { return Promise.all(s.map(x => x.run())); }, async exec(q) { db.exec(q); } };
}
const sdb = new DatabaseSync(":memory:");
sdb.exec(`
  CREATE TABLE people (id TEXT PRIMARY KEY, first_name TEXT, last_name TEXT, company TEXT, purpose TEXT, archived INTEGER DEFAULT 0, person_type TEXT, portal_username TEXT, hourly_rate REAL, travel_status TEXT, is_transfer_pending INTEGER DEFAULT 0);
  CREATE TABLE devices (device_token TEXT PRIMARY KEY, person_id TEXT, first_seen_at TEXT, last_seen TEXT);
  CREATE TABLE sites (id TEXT PRIMARY KEY, site_name TEXT, lat REAL, lng REAL, radius_m INTEGER DEFAULT 500, archived INTEGER DEFAULT 0, site_rules TEXT, category TEXT, site_rules_visitor TEXT);
  CREATE TABLE visits (id TEXT PRIMARY KEY, person_id TEXT, site_code TEXT, check_in_at TEXT, check_out_at TEXT, hs_ack INTEGER, lat REAL, lng REAL, accuracy REAL, auto_checkout INTEGER DEFAULT 0, sign_in_confirmed INTEGER DEFAULT 0, sign_out_confirmed INTEGER DEFAULT 0, travel_in_miles REAL, travel_in_mins INTEGER, travel_out_miles REAL, travel_out_mins INTEGER, is_first_of_day INTEGER DEFAULT 0, manual_entry INTEGER DEFAULT 0);
  INSERT INTO people (id, first_name, last_name, company) VALUES ('p1','Ryan','Diggens','Mostlane'),('p2','Zane','Leopold','Acme');
  INSERT INTO devices (device_token, person_id) VALUES ('dev1','p1'),('dev2','p2');
  INSERT INTO sites (id, site_name, lat, lng, radius_m) VALUES ('s1','Starbucks Jubilee Street',50.825362,-0.138606,500);
  INSERT INTO visits (id, person_id, site_code, check_in_at) VALUES ('v2','p2','Starbucks Jubilee Street','2026-10-16 07:00:00');
`);
const mdb = new DatabaseSync(":memory:");
mdb.exec(`CREATE TABLE app_config (tenant_id INTEGER NOT NULL DEFAULT 1, key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
const env = { SITELOG_DB: d1(sdb), DB: d1(mdb), OWNER_USERNAME: "Jamie Line" };
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };
async function call(path, body) {
  const pend = [];
  const req = new Request("https://api2.site-log.co.uk" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const res = await sl.handle(req, env, { waitUntil(p) { pend.push(p); } });
  await Promise.all(pend);
  return await res.json();
}
const feed = () => mdb.prepare("SELECT * FROM user_notifications ORDER BY rowid").all();

ok(JSON.stringify(await sl.signPushRecipients(env)) === '["Jamie Line"]', "default recipient = owner");

let r = await call("/confirm-checkin", { deviceToken: "dev1", site: "Starbucks Jubilee Street", lat: 50.8255, lng: -0.1386 });
ok(r.status === "checked_in", "sign-in succeeds");
let f = feed();
ok(f.length === 1 && f[0].username === "Jamie Line", "one push to the owner");
ok(/Ryan Diggens signed in — Starbucks Jubilee Street/.test(f[0].title), "title names person + site: " + f[0].title);
ok(/On site now \(2\): Zane Leopold, Ryan Diggens/.test(f[0].body), "body lists who's on site: " + f[0].body);

const vid = sdb.prepare("SELECT id FROM visits WHERE person_id='p1'").get().id;
r = await call("/confirm-checkout", { deviceToken: "dev1", visitId: vid, lat: 50.8255, lng: -0.1386 });
ok(r.status === "checked_out", "sign-out succeeds");
f = feed();
ok(f.length === 2 && /Ryan Diggens signed out — Starbucks Jubilee Street/.test(f[1].title), "sign-out push: " + (f[1] && f[1].title));
ok(/On site now \(1\): Zane Leopold/.test(f[1].body), "sign-out body shows remaining: " + (f[1] && f[1].body));

// refused sign-in (off site) → no push
r = await call("/confirm-checkin", { deviceToken: "dev1", site: "Starbucks Jubilee Street", lat: 50.9, lng: -0.1386 });
ok(r.ok === false && feed().length === 2, "refused sign-in sends nothing");

// configurable recipients + off switch
mdb.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (1,'sitelog:pushnotify:1',?)").run(JSON.stringify({ recipients: ["Greg Line"] }));
ok(JSON.stringify(await sl.signPushRecipients(env)) === '["Greg Line"]', "config recipients honoured");
mdb.prepare("UPDATE app_config SET value=? WHERE key='sitelog:pushnotify:1'").run(JSON.stringify({ enabled: false }));
r = await call("/confirm-checkin", { deviceToken: "dev1", site: "Starbucks Jubilee Street", lat: 50.8255, lng: -0.1386 });
ok(r.status === "checked_in" && feed().length === 2, "disabled → no push");

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
