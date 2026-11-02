// Admin Logs view: person/site/date filters, failed scans inline, map links.
// node --no-warnings worker/tools/test-sitelog-logs.mjs
import { DatabaseSync } from "node:sqlite";
import * as ts from "../src/routes/sitelogts.js";

function d1(db) {
  const wrap = (sql) => { let b = []; const st = {
    bind(...a) { b = a.map(v => v === undefined ? null : v); return st; },
    async first() { return db.prepare(sql).get(...b) ?? null; },
    async all() { return { results: db.prepare(sql).all(...b) }; },
    async run() { const r = db.prepare(sql).run(...b); return { meta: { changes: r.changes } }; },
  }; return st; };
  return { prepare: wrap };
}
const sl = new DatabaseSync(":memory:");
sl.exec(`CREATE TABLE people (id TEXT PRIMARY KEY, first_name TEXT, last_name TEXT, company TEXT, archived INTEGER DEFAULT 0, is_transfer_pending INTEGER DEFAULT 0);
CREATE TABLE visits (id TEXT PRIMARY KEY, person_id TEXT, site_code TEXT, check_in_at TEXT, check_out_at TEXT, auto_checkout INTEGER DEFAULT 0, transferred_to TEXT, manual_entry INTEGER DEFAULT 0, provided_site_name TEXT, sign_in_verified INTEGER DEFAULT 0, sign_out_verified INTEGER DEFAULT 0, sign_in_distance_m REAL, sign_out_distance_m REAL, lat REAL, lng REAL, accuracy REAL, out_lat REAL, out_lng REAL, out_accuracy REAL, offline_synced INTEGER DEFAULT 0);
CREATE TABLE sites (site_name TEXT, lat REAL, lng REAL, radius_m INTEGER, archived INTEGER DEFAULT 0);
CREATE TABLE scan_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, kind TEXT, outcome TEXT, refused INTEGER DEFAULT 0, reason TEXT, device_token TEXT, person_id TEXT, site TEXT, lat REAL, lng REAL, accuracy REAL, distance_m INTEGER, nearest_site TEXT, detail TEXT);
INSERT INTO sites VALUES ('Site A',50.8,-1.1,500,0),('Site B',50.9,-1.2,500,0);
INSERT INTO people (id,first_name,last_name,company) VALUES ('p1','User','One','Mostlane'),('p2','User','Two','DCI'),('p3','User','Three','X');
INSERT INTO people (id,first_name,last_name,company,is_transfer_pending) VALUES ('tmp','User','One','Mostlane',1);
INSERT INTO visits (id,person_id,site_code,check_in_at,check_out_at,auto_checkout,transferred_to,manual_entry,provided_site_name,sign_in_verified,sign_out_verified,sign_in_distance_m,sign_out_distance_m,lat,lng,accuracy,out_lat,out_lng,out_accuracy) VALUES
 ('v1','p1','Site A','2026-10-12 07:00:00','2026-10-12 15:00:00',0,NULL,0,NULL,1,1,20,30,50.8,-1.1,10,50.8,-1.1,10),
 ('v2','p1','Site B','2026-10-13 07:00:00','2026-10-13 15:00:00',1,NULL,0,NULL,1,0,15,NULL,50.9,-1.2,10,NULL,NULL,NULL),
 ('v3','p2','Site A','2026-10-12 08:00:00','2026-10-12 12:00:00',0,NULL,0,NULL,1,1,10,10,50.8,-1.1,10,50.8,-1.1,10),
 ('v4','p3','Site B','2026-09-01 08:00:00','2026-09-01 12:00:00',0,NULL,0,NULL,1,1,10,10,50.9,-1.2,10,50.9,-1.2,10);
INSERT INTO scan_log (at,kind,outcome,refused,person_id,site,nearest_site,lat,lng,distance_m,device_token) VALUES
 ('2026-10-12T15:30:00.000Z','scan','outside_site',1,'p2',NULL,'Site A',50.81,-1.1,900,'d2'),
 ('2026-10-12T06:00:00.000Z','scan','phone_denied',1,'p1',NULL,NULL,NULL,NULL,NULL,'d1'),
 ('2026-10-12T09:00:00.000Z','scan','unknown_site',1,NULL,NULL,'Site A',51,-1,5000,'abcdef123456');`);
const env = { SITELOG_DB: d1(sl), DB: d1(new DatabaseSync(":memory:")), FILE_SIGNING_SECRET: "test-secret-1234567890" };
const O = "https://api.example";
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : (fail++, console.log("FAIL:", m)); };

let r = await ts.adminLogs(env, O, { from: "2026-10-12", to: "2026-10-13" });
ok(r.ok && r.people.length === 3, "everyone with a visit or a failed scan in range (incl. unregistered phone)");
const u1 = r.people.find(p => p.name === "User One");
ok(u1.visits.length === 2 && u1.visits[0].mapIn && u1.visits[0].mapOut && u1.visits[0].inOk && u1.visits[0].outOk, "verified events carry ticks + map links");
ok(u1.visits[1].state === "auto" && !u1.visits[1].mapOut && !u1.visits[1].outOk, "missed sign-out: no out pin, not verified");
ok(u1.refused.length === 1 && !u1.refused[0].mapUrl && /switched off/.test(u1.refused[0].why), "phone location-denied failure shown, no map (no location)");
ok(u1.totals.missed === 1 && u1.totals.refused === 1 && u1.totals.issues === 2, "issue counts");
const u2 = r.people.find(p => p.name === "User Two");
ok(u2.refused[0].mapUrl && u2.refused[0].mapUrl.includes("scan%3A") && u2.refused[0].distance === 900, "refused scan with location gets a focused map link");
ok(r.people.some(p => p.name === "Unregistered phone" && p.refused.length === 1), "unregistered phone's failed scan listed");
ok(r.summary.refused === 3 && r.summary.missed === 1, "summary totals");

r = await ts.adminLogs(env, O, { from: "2026-10-12", to: "2026-10-13", personId: "p1" });
ok(r.people.length === 1 && r.people[0].name === "User One", "person filter");
r = await ts.adminLogs(env, O, { from: "2026-10-12", to: "2026-10-13", site: "Site B" });
ok(r.people.length === 1 && r.people[0].visits.length === 1 && r.people[0].visits[0].site === "Site B", "site filter");
r = await ts.adminLogs(env, O, { from: "2026-10-13", to: "2026-10-12" });
ok(r.from === "2026-10-12" && r.to === "2026-10-13", "reversed dates are swapped");
r = await ts.adminLogs(env, O, { from: "2020-01-01", to: "2026-10-13" });
ok(r.from > "2026-07-01", "range capped at ~3 months");
r = await ts.adminLogs({ ...env, FILE_SIGNING_SECRET: undefined, PORTAL_BRIDGE_SECRET: undefined }, O, { from: "2026-10-12", to: "2026-10-12" });
ok(r.maps === false && !r.people.some(p => p.visits.some(v => v.mapIn)), "no signing secret = no map links");
const pk = await ts.logPickers(env);
ok(pk.people.length === 3 && !pk.people.some(p => p.id === "tmp") && pk.sites.length === 2, "pickers exclude phone-transfer temp records");
// Still on site: counts time so far (not in the hours total).
const nowL = new Date(Date.now() - 90 * 60000).toISOString().slice(0, 19).replace("T", " ");
const todayIso = new Date().toISOString().slice(0, 10);
sl.exec(`INSERT INTO visits (id,person_id,site_code,check_in_at,sign_in_verified,sign_in_distance_m,lat,lng) VALUES ('vo','p3','Site A','${nowL}',1,12,50.8,-1.1)`);
r = await ts.adminLogs(env, O, { from: todayIso, to: todayIso, personId: "p3" });
const op = r.people[0];
ok(op && op.visits[0].state === "open" && op.visits[0].soFar >= 88 && op.visits[0].soFar <= 92 && op.totals.mins === 0 && op.totals.soFar >= 88, "open visit shows ~90 min so far, not in hours");
ok(r.summary.soFar >= 88 && op.totals.unver === 0, "summary carries time so far; verified sign-in isn't 'not checked'");
// Now tab: on site with location check, plus offered-but-not-tapped scans.
const isoAgo = m => new Date(Date.now() - m * 60000).toISOString();
sl.exec(`INSERT INTO scan_log (at,kind,outcome,refused,person_id,site,lat,lng,accuracy,device_token) VALUES
 ('${isoAgo(30)}','scan','confirm_check_in',0,'p2','Site A',50.8001,-1.1,8,'d2'),
 ('${isoAgo(20)}','scan','confirm_check_in',0,'p2','Site A',50.8001,-1.1,8,'d2'),
 ('${isoAgo(25)}','scan','first_visit',0,NULL,'Site B',50.9,-1.2,7,'newphone1'),
 ('${isoAgo(100)}','scan','confirm_check_in',0,'p3','Site A',50.8,-1.1,9,'d3')`);
const nw = await ts.liveNow(env, O);
const me = nw.onSite.find(x => x.pid === "p3");
ok(me && me.verified === true && me.distance === 12 && me.mapUrl && me.soFar >= 88, "on site: verified tick, distance, map link, time so far");
ok(nw.offered.length === 2, "two soft scans: p2 (twice, merged) + new phone; p3's offer was taken up by a sign-in");
const p2o = nw.offered.find(x => x.pid === "p2");
ok(p2o && p2o.attempts === 2 && p2o.inside === true && p2o.distance <= 20 && p2o.mapUrl && p2o.kind === "offered", "soft scan: who/where/inside boundary/map, repeat scans merged");
ok(nw.offered.some(x => x.kind === "new_phone" && x.name === "Unregistered phone" && !x.mapUrl), "new phone shown, no map");
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
