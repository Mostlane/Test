// SiteLog scan log: every refused scan / sign-in is recorded with its reason.
// Run: node --no-warnings worker/tools/test-sitelog-scanlog.mjs
import { DatabaseSync } from "node:sqlite";
import * as sl from "../src/routes/sitelog-api.js";
function d1(db) {
  const wrap = (sql) => { let b = []; const st = {
    bind(...a) { b = a.map(v => v === undefined ? null : v); return st; },
    async first() { return db.prepare(sql).get(...b) ?? null; },
    async all() { return { results: db.prepare(sql).all(...b) }; },
    async run() { const r = db.prepare(sql).run(...b); return { meta: { changes: r.changes } }; } }; return st; };
  return { prepare: wrap, async batch(s) { return Promise.all(s.map(x => x.run())); } };
}
const db = new DatabaseSync(":memory:");
db.exec(`
  CREATE TABLE people (id TEXT PRIMARY KEY, first_name TEXT, last_name TEXT, company TEXT, purpose TEXT, archived INTEGER DEFAULT 0, person_type TEXT, portal_username TEXT, hourly_rate REAL, travel_status TEXT, is_transfer_pending INTEGER DEFAULT 0);
  CREATE TABLE devices (device_token TEXT PRIMARY KEY, person_id TEXT, first_seen_at TEXT, last_seen TEXT);
  CREATE TABLE sites (id TEXT PRIMARY KEY, site_name TEXT, lat REAL, lng REAL, radius_m INTEGER DEFAULT 500, archived INTEGER DEFAULT 0, site_rules TEXT, category TEXT, site_rules_visitor TEXT);
  CREATE TABLE visits (id TEXT PRIMARY KEY, person_id TEXT, site_code TEXT, check_in_at TEXT, check_out_at TEXT, hs_ack INTEGER, lat REAL, lng REAL, accuracy REAL, auto_checkout INTEGER DEFAULT 0, sign_in_confirmed INTEGER DEFAULT 0, sign_out_confirmed INTEGER DEFAULT 0, travel_in_miles REAL, travel_in_mins INTEGER, travel_out_miles REAL, travel_out_mins INTEGER, is_first_of_day INTEGER DEFAULT 0, manual_entry INTEGER DEFAULT 0);
  INSERT INTO people (id, first_name, last_name, company) VALUES ('p1','Ryan','Diggens','Mostlane');
  INSERT INTO devices (device_token, person_id) VALUES ('dev1','p1');
  INSERT INTO sites (id, site_name, lat, lng, radius_m) VALUES ('s1','Starbucks Jubilee Street',50.825362,-0.138606,500);
`);
const env = { SITELOG_DB: d1(db), SITELOG_ADMIN_SECRET: "sek" };
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };
async function call(method, path, body, hdr = {}) {
  const req = new Request("https://api2.site-log.co.uk" + path, { method, headers: { "Content-Type": "application/json", ...hdr }, body: body ? JSON.stringify(body) : undefined });
  const res = await sl.handle(req, env, { waitUntil() {} });
  return { status: res.status, body: await res.json() };
}
const last = () => db.prepare("SELECT * FROM scan_log ORDER BY id DESC LIMIT 1").get();

let r = await call("POST", "/scan", { deviceToken: "dev1", lat: 50.84, lng: -0.1386 });
ok(r.body.status === "unknown_site", "scan off-site → unknown_site");
let l = last();
ok(l && l.refused === 1 && l.outcome === "unknown_site" && l.person_id === "p1" && l.nearest_site === "Starbucks Jubilee Street" && l.distance_m > 1000, "off-site scan logged as refused with nearest + distance");

r = await call("POST", "/scan", { deviceToken: "dev1", lat: 50.8255, lng: -0.1386 });
l = last();
ok(l.refused === 0 && l.outcome === "confirm_check_in", "on-site scan logged as not refused");

r = await call("POST", "/confirm-checkin", { deviceToken: "dev1", site: "Starbucks Jubilee Street" });
l = last();
ok(l.kind === "sign_in" && l.refused === 1 && l.outcome === "no_location", "sign-in without location logged");

r = await call("POST", "/confirm-checkin", { deviceToken: "dev1", site: "Starbucks Jubilee Street", lat: 50.84, lng: -0.1386 });
l = last();
ok(l.outcome === "outside_site" && l.distance_m > 500, "sign-in outside boundary logged with distance");

r = await call("POST", "/confirm-checkin", { deviceToken: "dev1", site: "Starbucks Jubilee Street", lat: 50.8255, lng: -0.1386, accuracy: 9 });
l = last();
ok(r.body.ok && l.refused === 0 && l.outcome === "checked_in", "real sign-in logged as success");

r = await call("POST", "/log-failed-scan", { deviceToken: "dev1", errorType: "denied", message: "User denied Geolocation" });
l = last();
ok(l.outcome === "phone_denied" && l.refused === 1 && /permission/i.test(l.reason) && l.person_id === "p1", "phone-side refusal recorded");

r = await call("POST", "/log-failed-scan", { errorType: "timeout" });
ok(last().outcome === "phone_timeout" && last().person_id === null, "refusal from an unknown phone still recorded");

r = await call("GET", "/scan-log?days=7&refused=1");
ok(r.status === 401 || r.status === 403, "scan-log needs admin");
r = await call("GET", "/scan-log?days=7&refused=1", null, { "x-admin-secret": "sek" });
ok(r.body.ok && r.body.rows.length === 5 && r.body.rows.every(x => x.refused === 1), "admin sees refused rows");
ok(r.body.rows.some(x => x.first_name === "Ryan"), "rows carry the person's name");

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
