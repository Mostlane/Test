// Offline sign-out replay: a retried sign-out we already applied must not be
// logged as a lost "pending" event. node --no-warnings worker/tools/test-sitelog-offline.mjs
import { DatabaseSync } from "node:sqlite";
import * as sl from "../src/routes/sitelog-api.js";

function d1(db) {
  const wrap = (sql) => { let b = []; const st = {
    bind(...a) { b = a.map(v => v === undefined ? null : v); return st; },
    async first() { return db.prepare(sql).get(...b) ?? null; },
    async all() { return { results: db.prepare(sql).all(...b) }; },
    async run() { const r = db.prepare(sql).run(...b); return { meta: { changes: r.changes } }; },
  }; return st; };
  return { prepare: wrap, async batch(s) { return Promise.all(s.map(x => x.run())); }, async exec(q) { db.exec(q); } };
}
const db = new DatabaseSync(":memory:");
db.exec(`
  CREATE TABLE people (id TEXT PRIMARY KEY, first_name TEXT, last_name TEXT, company TEXT, archived INTEGER DEFAULT 0, person_type TEXT, portal_username TEXT, hourly_rate REAL, travel_status TEXT);
  CREATE TABLE devices (device_token TEXT PRIMARY KEY, person_id TEXT, first_seen_at TEXT, last_seen TEXT);
  CREATE TABLE sites (id TEXT PRIMARY KEY, site_name TEXT, lat REAL, lng REAL, radius_m INTEGER DEFAULT 500, archived INTEGER DEFAULT 0, site_rules TEXT, category TEXT, site_rules_visitor TEXT);
  CREATE TABLE visits (id TEXT PRIMARY KEY, person_id TEXT, site_code TEXT, check_in_at TEXT, check_out_at TEXT, hs_ack INTEGER, lat REAL, lng REAL, accuracy REAL, auto_checkout INTEGER DEFAULT 0, sign_in_confirmed INTEGER DEFAULT 0, sign_out_confirmed INTEGER DEFAULT 0, travel_in_miles REAL, travel_in_mins INTEGER, travel_out_miles REAL, travel_out_mins INTEGER, is_first_of_day INTEGER DEFAULT 0, manual_entry INTEGER DEFAULT 0);
  INSERT INTO people (id, first_name, company) VALUES ('p1','User','Mostlane');
  INSERT INTO devices (device_token, person_id) VALUES ('dev1','p1');
  INSERT INTO sites (id, site_name, lat, lng, radius_m) VALUES ('s1','Site A',50.825362,-0.138606,500);
`);
const env = { SITELOG_DB: d1(db) };
const call = async (body) => {
  const res = await sl.handle(new Request("https://api2.site-log.co.uk/sync-event", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), env, { waitUntil() {} });
  return { status: res.status, body: await res.json() };
};
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : (fail++, console.log("FAIL:", m)); };
const ON = { lat: 50.8255, lng: -0.1386 };
const inAt = new Date(Date.now() - 5 * 3600e3), outAt = new Date(Date.now() - 2 * 3600e3);
const pending = () => { try { return db.prepare("SELECT COUNT(*) n FROM pending_events").get().n; } catch (e) { return 0; } };

let r = await call({ deviceToken: "dev1", intent: "in", occurredAt: inAt.toISOString(), ...ON });
ok(r.body.status === "checked_in", "offline sign-in applied");
r = await call({ deviceToken: "dev1", intent: "out", occurredAt: outAt.toISOString(), ...ON });
ok(r.body.status === "checked_out", "offline sign-out applied");
r = await call({ deviceToken: "dev1", intent: "out", occurredAt: outAt.toISOString(), ...ON });
ok(r.body.status === "duplicate_ignored" && pending() === 0, "retried sign-out is a duplicate, not a lost event");
r = await call({ deviceToken: "dev1", intent: "out", occurredAt: new Date(Date.now() - 600e3).toISOString(), ...ON });
ok(r.body.status === "logged_pending" && pending() === 1, "a genuinely unmatched sign-out is still logged");
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
