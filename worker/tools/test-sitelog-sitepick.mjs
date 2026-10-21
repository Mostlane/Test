// Which site a scan belongs to when two sites sit metres apart.
// Real case: Starbucks Jubilee Street and Brighton North Road are 45 m apart, both
// 500 m radius; GPS wobble flipped Zane between them (20 Oct 2026).
// Run: node --no-warnings worker/tools/test-sitelog-sitepick.mjs
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
const db = new DatabaseSync(":memory:");
db.exec(`
  CREATE TABLE people (id TEXT PRIMARY KEY, first_name TEXT, last_name TEXT, company TEXT, archived INTEGER DEFAULT 0, person_type TEXT, portal_username TEXT, hourly_rate REAL, travel_status TEXT);
  CREATE TABLE devices (device_token TEXT PRIMARY KEY, person_id TEXT, first_seen_at TEXT, last_seen TEXT);
  CREATE TABLE sites (id TEXT PRIMARY KEY, site_name TEXT, lat REAL, lng REAL, radius_m INTEGER DEFAULT 500, archived INTEGER DEFAULT 0, site_rules TEXT, category TEXT, site_rules_visitor TEXT);
  CREATE TABLE visits (id TEXT PRIMARY KEY, person_id TEXT, site_code TEXT, check_in_at TEXT, check_out_at TEXT, hs_ack INTEGER, lat REAL, lng REAL, accuracy REAL, auto_checkout INTEGER DEFAULT 0, sign_in_confirmed INTEGER DEFAULT 0, sign_out_confirmed INTEGER DEFAULT 0, travel_in_miles REAL, travel_in_mins INTEGER, travel_out_miles REAL, travel_out_mins INTEGER, is_first_of_day INTEGER DEFAULT 0, manual_entry INTEGER DEFAULT 0, transferred_to TEXT);
  INSERT INTO people (id, first_name, company) VALUES ('z','Zane','Storm'), ('n','New','Storm');
  INSERT INTO devices (device_token, person_id) VALUES ('devZ','z'), ('devN','n');
  INSERT INTO sites (id, site_name, lat, lng, radius_m) VALUES
    ('j','Starbucks Jubilee Street',50.825362,-0.138606,500),
    ('r','Brighton North Road',50.824983,-0.138814,500),
    ('s','Brighton St James',50.8209,-0.1339,500);
`);
const env = { SITELOG_DB: d1(db) };
const J = "Starbucks Jubilee Street", N = "Brighton North Road";
const scan = async (dev, lat, lng) => {
  const res = await sl.handle(new Request("https://api2.site-log.co.uk/scan", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceToken: dev, lat, lng, accuracy: 15 }) }), env, { waitUntil() {} });
  return res.json();
};
const sqlNow = (minsAgo = 0) => new Date(Date.now() - minsAgo * 60000).toISOString().replace("T", " ").slice(0, 19);
let pass = 0, fail = 0; const ok = (c, m) => c ? pass++ : (fail++, console.log("FAIL:", m));

// 10:03 on 20 Oct: 18 m from North Road, 51 m from Jubilee — while signed in at Jubilee.
db.prepare("INSERT INTO visits (id, person_id, site_code, check_in_at) VALUES ('v1','z',?,?)").run(J, sqlNow(90));
let r = await scan("devZ", 50.8249, -0.138596);
ok(r.status === "confirm_sign_out" && r.site === J, "signed in at Jubilee, GPS nearer North Road → stays on Jubilee (sign-out offered), got " + r.status + " " + r.site);
ok(Array.isArray(r.alternatives) && r.alternatives.includes(N), "both sites listed as alternatives");

// Signed out, walking off (209 m from North Road, 253 m from Jubilee): recent site wins.
db.prepare("UPDATE visits SET check_out_at = ? WHERE id='v1'").run(sqlNow(1));
r = await scan("devZ", 50.823151, -0.139468);
ok(r.status === "confirm_check_in" && r.site === J, "near-tie after signing out → the site used recently, got " + r.site);

// Someone with no history: nearest wins (unchanged behaviour).
r = await scan("devN", 50.8249, -0.138596);
ok(r.site === N, "no history → nearest site, got " + r.site);

// Not a tie (St James 4 m away vs Jubilee ~600 m): nearest wins even with Jubilee history.
r = await scan("devZ", 50.82093, -0.13392);
ok(r.site === "Brighton St James", "clear nearest site beats history when not a near-tie, got " + r.site);

// Signed in at North Road, standing right at Jubilee's pin (inside both): stays North Road.
db.prepare("INSERT INTO visits (id, person_id, site_code, check_in_at) VALUES ('v2','z',?,?)").run(N, sqlNow(10));
r = await scan("devZ", 50.825362, -0.138606);
ok(r.status === "confirm_sign_out" && r.site === N, "open visit wins while still inside its boundary");

console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
