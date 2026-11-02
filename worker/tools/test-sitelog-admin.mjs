// SiteLog admin proxy: pay rates are Full Access only; merge keeps the scan log.
// node --no-warnings worker/tools/test-sitelog-admin.mjs
import { DatabaseSync } from "node:sqlite";
import * as proxy from "../src/routes/sitelog.js";

function d1(db) {
  const wrap = (sql) => { let b = []; const st = {
    bind(...a) { b = a.map(v => v === undefined ? null : v); return st; },
    async first() { return db.prepare(sql).get(...b) ?? null; },
    async all() { return { results: db.prepare(sql).all(...b) }; },
    async run() { const r = db.prepare(sql).run(...b); return { meta: { changes: r.changes } }; },
  }; return st; };
  return { prepare: wrap, async batch(s) { return Promise.all(s.map(x => x.run())); }, async exec(q) { db.exec(q); } };
}
const main = new DatabaseSync(":memory:"), sl = new DatabaseSync(":memory:");
main.exec(`CREATE TABLE user_permissions (tenant_id INTEGER, username TEXT, permission TEXT, value INTEGER);
INSERT INTO user_permissions VALUES (1,'boss','FullAccess',1),(1,'office','SiteLogAdmin',1),(1,'eng','SiteLog',1);`);
sl.exec(`
  CREATE TABLE people (id TEXT PRIMARY KEY, first_name TEXT, last_name TEXT, company TEXT, purpose TEXT, archived INTEGER DEFAULT 0, hourly_rate REAL, travel_status TEXT, travel_cap_type TEXT, travel_cap_value REAL, fuel_rate REAL, is_main INTEGER DEFAULT 0, fuel_paid INTEGER, travel_time_paid INTEGER, doc_access_always INTEGER DEFAULT 0, portal_username TEXT, person_type TEXT, is_transfer_pending INTEGER DEFAULT 0, created_at TEXT);
  CREATE TABLE devices (device_token TEXT PRIMARY KEY, person_id TEXT, first_seen_at TEXT, last_seen TEXT);
  CREATE TABLE visits (id TEXT PRIMARY KEY, person_id TEXT, site_code TEXT, check_in_at TEXT, check_out_at TEXT);
  CREATE TABLE scan_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, kind TEXT, outcome TEXT, refused INTEGER, reason TEXT, device_token TEXT, person_id TEXT, site TEXT, lat REAL, lng REAL, accuracy REAL, distance_m INTEGER, nearest_site TEXT, detail TEXT);
  INSERT INTO people (id, first_name, last_name, company, hourly_rate, fuel_rate) VALUES ('p1','User','One','Mostlane',18.5,0.45),('p2','User','One','Mostlane',0,NULL);
  INSERT INTO visits VALUES ('v1','p2','Site A','2026-10-01 07:00:00','2026-10-01 15:00:00');
  INSERT INTO scan_log (at, kind, outcome, refused, person_id) VALUES ('2026-10-01T07:00:00Z','scan','outside_site',1,'p2');
`);
const env = { DB: d1(main), SITELOG_DB: d1(sl), SITELOG_ADMIN_SECRET: "s3cret-test" };
const sess = u => ({ tenantId: 1, user: { username: u } });
async function call(user, path, body) {
  const url = new URL("https://api.example" + path);
  const req = new Request(url, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  const res = await proxy.handle(req, env, { waitUntil() {} }, url, sess(user));
  return { status: res.status, body: await res.json().catch(() => null) };
}
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : (fail++, console.log("FAIL:", m)); };

let r = await call("boss", "/sitelog/engineers");
ok(r.status === 200 && r.body.engineers.find(p => p.id === "p1").hourly_rate === 18.5, "Full Access sees pay rates");
r = await call("office", "/sitelog/engineers");
const p1 = r.body.engineers.find(p => p.id === "p1");
ok(r.status === 200 && p1 && !("hourly_rate" in p1) && !("fuel_rate" in p1) && p1.first_name === "User", "Site Log admin sees people but no rates");
ok(r.body.money === false, "response says money is hidden");
r = await call("eng", "/sitelog/engineers");
ok(r.status === 403, "scanner-only users can't open the admin data");
r = await call("office", "/sitelog/job-costing");
ok(r.status === 403, "job costing is Full Access only");
r = await call("office", "/sitelog/update-engineer", { id: "p1", company: "Mostlane Ltd", hourlyRate: 99, fuelRate: 9 });
const row = sl.prepare("SELECT company, hourly_rate, fuel_rate FROM people WHERE id='p1'").get();
ok(r.status === 200 && row.company === "Mostlane Ltd" && row.hourly_rate === 18.5 && row.fuel_rate === 0.45, "Site Log admin can edit details but not rates");
r = await call("boss", "/sitelog/update-engineer", { id: "p1", hourlyRate: 20 });
ok(sl.prepare("SELECT hourly_rate FROM people WHERE id='p1'").get().hourly_rate === 20, "Full Access can change rates");
r = await call("office", "/sitelog/merge-people", { primaryId: "p1", mergeIds: ["p2"] });
ok(r.status === 200 && sl.prepare("SELECT COUNT(*) n FROM people").get().n === 1, "duplicates merged");
ok(sl.prepare("SELECT person_id FROM visits WHERE id='v1'").get().person_id === "p1", "visits follow the kept person");
ok(sl.prepare("SELECT person_id FROM scan_log").get().person_id === "p1", "scan log follows the kept person");
// On site now: no site named = everyone with an open visit, any site.
sl.exec(`INSERT INTO visits (id,person_id,site_code,check_in_at,check_out_at) VALUES ('v2','p1','Site B','2026-11-02 07:55:48',NULL),('v3','p1','Site A','2026-11-02 08:10:00','2026-11-02 09:00:00')`);
r = await call("office", "/sitelog/on-site");
ok(r.status === 200 && r.body.people.length === 1 && r.body.people[0].site === "Site B" && r.body.people[0].check_in_at === "2026-11-02T07:55:48Z", "on-site with no site lists every open visit");
r = await call("office", "/sitelog/on-site?site=Site%20B");
ok(r.status === 200 && r.body.people.length === 1, "on-site for one site still works");
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
