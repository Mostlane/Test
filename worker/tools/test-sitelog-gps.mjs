// GPS verification on every SiteLog sign-in / sign-out.
// Real SQLite (node:sqlite) behind a D1-shaped shim, driving sitelog-api.handle().
// Run: node --no-warnings worker/tools/test-sitelog-gps.mjs
import { DatabaseSync } from "node:sqlite";
import * as sl from "../src/routes/sitelog-api.js";

function d1(db) {
  const wrap = (sql) => { let binds = []; const st = {
    bind(...a) { binds = a.map(v => v === undefined ? null : v); return st; },
    async first() { return db.prepare(sql).get(...binds) ?? null; },
    async all() { return { results: db.prepare(sql).all(...binds) }; },
    async run() { const r = db.prepare(sql).run(...binds); return { meta: { changes: r.changes, last_row_id: r.lastInsertRowid } }; },
  }; return st; };
  return { prepare: wrap, async batch(s) { return Promise.all(s.map(x => x.run())); } };
}

function makeEnv() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE people (id TEXT PRIMARY KEY, first_name TEXT, last_name TEXT, company TEXT, archived INTEGER DEFAULT 0, person_type TEXT, portal_username TEXT, hourly_rate REAL, travel_status TEXT);
    CREATE TABLE devices (device_token TEXT PRIMARY KEY, person_id TEXT, first_seen_at TEXT, last_seen TEXT);
    CREATE TABLE sites (id TEXT PRIMARY KEY, site_name TEXT, lat REAL, lng REAL, radius_m INTEGER DEFAULT 500, archived INTEGER DEFAULT 0, site_rules TEXT, category TEXT, site_rules_visitor TEXT);
    CREATE TABLE visits (id TEXT PRIMARY KEY, person_id TEXT, site_code TEXT, check_in_at TEXT, check_out_at TEXT, hs_ack INTEGER, lat REAL, lng REAL, accuracy REAL, auto_checkout INTEGER DEFAULT 0, sign_in_confirmed INTEGER DEFAULT 0, sign_out_confirmed INTEGER DEFAULT 0, travel_in_miles REAL, travel_in_mins INTEGER, travel_out_miles REAL, travel_out_mins INTEGER, is_first_of_day INTEGER DEFAULT 0, manual_entry INTEGER DEFAULT 0);
    INSERT INTO people (id, first_name, company) VALUES ('p1','Steve','Mostlane'), ('p2','Dave','Mostlane');
    INSERT INTO devices (device_token, person_id) VALUES ('dev1','p1'), ('dev2','p2');
    INSERT INTO sites (id, site_name, lat, lng, radius_m) VALUES ('s1','Starbucks Jubilee Street',50.825362,-0.138606,500);
  `);
  return { db, env: { SITELOG_DB: d1(db) } };
}

async function call(env, path, body) {
  const req = new Request("https://api2.site-log.co.uk" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const res = await sl.handle(req, env, { waitUntil() {} });
  return { status: res.status, body: await res.json() };
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL:", m); } };

const ON = { lat: 50.8255, lng: -0.1386 };          // ~20 m from the pin
const FAR = { lat: 50.8400, lng: -0.1386 };          // ~1.6 km away
const SITE = "Starbucks Jubilee Street";

const { db, env } = makeEnv();

let r = await call(env, "/confirm-checkin", { deviceToken: "dev1", site: SITE });
ok(r.status === 400 && r.body.status === "no_location", "sign-in with no location refused");
ok(db.prepare("SELECT COUNT(*) n FROM visits").get().n === 0, "no visit recorded without location");

r = await call(env, "/confirm-checkin", { deviceToken: "dev1", site: SITE, ...FAR });
ok(r.status === 400 && r.body.status === "outside_site", "sign-in outside boundary refused");
ok(db.prepare("SELECT COUNT(*) n FROM visits").get().n === 0, "no visit recorded outside boundary");

r = await call(env, "/confirm-checkin", { deviceToken: "dev1", site: SITE, ...ON, accuracy: 12 });
ok(r.status === 200 && r.body.ok, "sign-in on site accepted");
const v = db.prepare("SELECT * FROM visits").get();
ok(v && v.sign_in_verified === 1 && v.sign_in_distance_m < 50, "sign-in stored as verified with distance");

r = await call(env, "/confirm-checkout", { visitId: v.id, deviceToken: "dev2", ...ON });
ok(r.status === 403, "another phone cannot sign the visit out");

r = await call(env, "/confirm-checkout", { visitId: v.id, deviceToken: "dev1" });
ok(r.status === 400 && r.body.status === "no_location", "sign-out with no location refused");

r = await call(env, "/confirm-checkout", { visitId: v.id, deviceToken: "dev1", ...FAR });
ok(r.status === 400 && r.body.status === "outside_site", "sign-out outside boundary refused");
ok(db.prepare("SELECT check_out_at FROM visits WHERE id=?").get(v.id).check_out_at == null, "visit still open after refused sign-outs");

r = await call(env, "/scan", { deviceToken: "dev1", ...FAR });
ok(r.body.status === "outside_site_signed_in" && r.body.distance_m > 1000, "scan away from site does not offer sign-out");

r = await call(env, "/confirm-checkout", { visitId: v.id, deviceToken: "dev1", ...ON, accuracy: 8 });
ok(r.status === 200 && r.body.ok, "sign-out on site accepted");
const v2 = db.prepare("SELECT * FROM visits WHERE id=?").get(v.id);
ok(v2.check_out_at && v2.sign_out_verified === 1 && v2.out_lat === ON.lat && v2.out_accuracy === 8, "sign-out stored as verified with location");

r = await call(env, "/checkin-unmatched", { deviceToken: "dev1", siteName: "Somewhere", ...FAR });
ok(r.status === 410, "check-in away from a set site is disabled");

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
