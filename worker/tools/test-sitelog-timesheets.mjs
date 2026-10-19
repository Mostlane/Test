// SiteLog timesheet PDFs + emails. node --no-warnings worker/tools/test-sitelog-timesheets.mjs
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
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
const sl = new DatabaseSync(":memory:"), main = new DatabaseSync(":memory:");
sl.exec(`CREATE TABLE people (id TEXT PRIMARY KEY, first_name TEXT, last_name TEXT, company TEXT);
CREATE TABLE visits (id TEXT PRIMARY KEY, person_id TEXT, site_code TEXT, check_in_at TEXT, check_out_at TEXT, auto_checkout INTEGER DEFAULT 0, transferred_to TEXT, manual_entry INTEGER DEFAULT 0, provided_site_name TEXT, sign_in_verified INTEGER DEFAULT 0, sign_out_verified INTEGER DEFAULT 0, sign_in_distance_m REAL, sign_out_distance_m REAL);
INSERT INTO people VALUES ('p1','User','One','Mostlane'),('p2','User','Two','DCI'),('p3','User','Three','Storm Agency');
INSERT INTO visits VALUES
 ('v1','p1','Starbucks Jubilee Street','2026-10-12 06:55:00','2026-10-12 11:30:00',0,NULL,0,NULL,1,1,22,14),
 ('v2','p1','0125 Lee-On-Solent','2026-10-12 12:10:00','2026-10-12 15:00:00',0,NULL,0,NULL,1,0,30,NULL),
 ('v3','p2','Lake Road Surgery','2026-10-12 07:00:00','2026-10-12 15:00:00',1,NULL,0,NULL,1,0,8,NULL),
 ('v4','p3','Starbucks Jubilee Street','2026-10-12 08:00:00',NULL,0,NULL,0,NULL,1,0,40,NULL),
 ('v5','p2','Lake Road Surgery','2026-10-11 07:00:00','2026-10-11 14:00:00',0,NULL,1,NULL,0,0,NULL,NULL),
 ('v6','p1','Old visit','2026-10-05 07:00:00','2026-10-05 15:00:00',0,NULL,0,NULL,1,1,10,10);`);
main.exec(`CREATE TABLE app_config (tenant_id INTEGER, key TEXT PRIMARY KEY, value TEXT);`);
const sent = [];
globalThis.fetch = async (u, o) => { sent.push(JSON.parse(o.body)); return new Response("{}", { status: 200 }); };
const env = { SITELOG_DB: d1(sl), DB: d1(main), RESEND_API_KEY: "x" };

let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : (fail++, console.log("FAIL:", m)); };

const day = await ts.loadPeriod(env, "2026-10-12", "2026-10-12");
ok(day.length === 3, "three people on 12 Oct");
const u1 = day.find(p => p.name === "User One");
ok(u1.visits.length === 2 && u1.visits[0].inTime === "07:55", "London time (BST) shown");
ok(u1.visits[0].inOk && u1.visits[0].outOk && !u1.visits[1].outOk, "verified flags carried");
ok(day.find(p => p.name === "User Two").visits[0].state === "auto", "auto-closed = missed sign-out");
ok(day.find(p => p.name === "User Three").visits[0].state === "open", "open visit = still signed in");
const wk = await ts.loadPeriod(env, "2026-10-05", "2026-10-11");
ok(wk.length === 2 && wk.find(p => p.name === "User Two").visits[0].state === "manual", "week: manual entry flagged, other weeks excluded");

const { bytes } = await ts.buildPdf(env, "daily", "2026-10-12");
ok(bytes.length > 2000 && String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-", "daily PDF built");
writeFileSync(process.argv[2] || "/tmp/sl-day.pdf", bytes);
const w = await ts.buildPdf(env, "weekly", "2026-10-07");
ok(w.per.from === "2026-10-05" && w.per.to === "2026-10-11", "weekly period is Mon–Sun");
writeFileSync(process.argv[3] || "/tmp/sl-week.pdf", w.bytes);

// Cron: nothing without recipients
const realDate = Date;
const at = iso => { globalThis.Date = class extends realDate { constructor(...a) { a.length ? super(...a) : super(iso); } static now() { return new realDate(iso).getTime(); } }; };
at("2026-10-12T15:30:00Z"); await ts.sweepSitelogTimesheets(env, 1); ok(sent.length === 0, "no email without recipients");
main.prepare("INSERT INTO app_config VALUES (1,'sitelog:tsmail:1',?)").run(JSON.stringify({ recipients: ["office@example.com"] }));
main.prepare("INSERT INTO app_config VALUES (1,'sitelog:tsmail:sent:1',?)").run(JSON.stringify({ weekly: "2026-10-05" })); // 12 Oct is a Monday
at("2026-10-12T14:00:00Z"); await ts.sweepSitelogTimesheets(env, 1); ok(sent.length === 0, "not before 16:00");
at("2026-10-12T15:30:00Z"); await ts.sweepSitelogTimesheets(env, 1); ok(sent.length === 0, "waits while someone is still signed in");
at("2026-10-12T19:05:00Z"); await ts.sweepSitelogTimesheets(env, 1); ok(sent.length === 1 && sent[0].attachments[0].filename === "SiteLog-2026-10-12.pdf", "sent at 20:00 with someone still in");
at("2026-10-12T19:30:00Z"); await ts.sweepSitelogTimesheets(env, 1); ok(sent.length === 1, "daily sent only once");
sl.exec("UPDATE visits SET check_out_at='2026-10-13 14:00:00' WHERE id='v4'");
sl.exec("INSERT INTO visits (id,person_id,site_code,check_in_at,check_out_at,sign_in_verified,sign_out_verified) VALUES ('v7','p1','X','2026-10-13 07:00:00','2026-10-13 14:00:00',1,1)");
at("2026-10-13T15:10:00Z"); await ts.sweepSitelogTimesheets(env, 1); ok(sent.length === 2 && /Tuesday 13 October/.test(sent[1].subject), "sent at 16:00 once all signed out");
at("2026-10-19T06:10:00Z"); await ts.sweepSitelogTimesheets(env, 1); ok(sent.length === 3 && /Week 12 Oct – 18 Oct/.test(sent[2].subject), "weekly on Monday 07:00 for previous week");
at("2026-10-19T07:10:00Z"); await ts.sweepSitelogTimesheets(env, 1); ok(sent.length === 3, "weekly sent only once");
globalThis.Date = realDate;

// ── Scanned but not confirmed (scan_log fallback) — 14 Oct (BST) ──
sl.exec(`CREATE TABLE scan_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, kind TEXT, outcome TEXT, refused INTEGER DEFAULT 0, reason TEXT, device_token TEXT, person_id TEXT, site TEXT, lat REAL, lng REAL, accuracy REAL, distance_m INTEGER, nearest_site TEXT, detail TEXT);
INSERT INTO people VALUES ('p4','Scan','Four',''),('p5','Scan','Five',''),('p6','Scan','Six',''),('p7','Scan','Seven',''),('p8','Scan','Eight',''),('p9','Scan','Nine','');
INSERT INTO visits (id,person_id,site_code,check_in_at,check_out_at,auto_checkout,sign_in_verified,sign_out_verified) VALUES
 ('s4','p4','Jubilee','2026-10-14 06:25:00','2026-10-14 13:53:00',0,1,1),
 ('s5','p5','Jubilee','2026-10-14 05:29:00','2026-10-14 08:58:00',0,1,1),
 ('s6','p6','Jubilee','2026-10-14 06:00:00','2026-10-14 15:00:00',1,1,0),
 ('s9','p9','Jubilee','2026-10-14 06:10:00','2026-10-14 14:00:00',0,1,1);
INSERT INTO scan_log (at,kind,outcome,person_id,site) VALUES
 ('2026-10-14T08:00:00.000Z','scan','confirm_sign_out','p4','Jubilee'),
 ('2026-10-14T13:56:00.000Z','scan','confirm_check_in','p4','North Road'),
 ('2026-10-14T06:44:00.000Z','scan','confirm_check_in','p5','St James'),
 ('2026-10-14T12:00:00.000Z','scan','confirm_sign_out','p6','Jubilee'),
 ('2026-10-14T13:30:00.000Z','scan','confirm_sign_out','p6','Jubilee'),
 ('2026-10-14T06:30:00.000Z','scan','confirm_check_in','p7','Site A'),
 ('2026-10-14T06:31:00.000Z','scan','confirm_check_in','p7','Site A'),
 ('2026-10-14T15:00:00.000Z','scan','confirm_check_in','p7','Site A'),
 ('2026-10-14T23:30:00.000Z','scan','confirm_check_in','p8','Site A'),
 ('2026-10-14T06:00:00.000Z','scan','confirm_check_in','p9','Jubilee');`);
const sc = await ts.loadPeriod(env, "2026-10-14", "2026-10-14");
const by = n => sc.find(p => p.name === n);
const s4 = by("Scan Four");
ok(s4.visits.length === 2 && s4.visits[0].state === "ok", "confirmed sign-out wins over an earlier unconfirmed scan");
ok(s4.visits[1].state === "scanned" && s4.visits[1].scannedIn && s4.visits[1].inTime === "14:56" && s4.visits[1].mins === 0 && s4.visits[1].site === "North Road",
  "unconfirmed sign-in after leaving → flagged visit, no hours without an end");
ok(by("Scan Five").visits.length === 1, "sign-in scan while signed in elsewhere is ignored (no double count)");
const s6 = by("Scan Six").visits[0];
ok(s6.state === "scanned" && s6.scannedOut && s6.outTime === "14:30" && s6.mins === 450, "missed sign-out uses the last unconfirmed sign-out scan");
const s7 = by("Scan Seven");
ok(s7 && s7.visits.length === 1 && s7.visits[0].inTime === "07:30" && s7.visits[0].outTime === "16:00" && s7.visits[0].mins === 510,
  "scanned in + scanned again later at the same site → hours between the scans");
ok(!by("Scan Eight"), "a scan at 00:30 is not a plausible sign-in");
ok(by("Scan Nine").visits.length === 1, "the normal scan just before confirming is ignored");
const { personTotals } = await import("../src/lib/sitelogtspdf.js");
ok(personTotals(by("Scan Six")).scanned === 1 && personTotals(by("Scan Six")).missed === 0, "totals count it as scanned, not missed");
const scPdf = await ts.buildPdf(env, "daily", "2026-10-14");
ok(scPdf.bytes.length > 2000, "PDF with scanned rows builds");
writeFileSync(process.argv[4] || "/tmp/sl-scan.pdf", scPdf.bytes);
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
