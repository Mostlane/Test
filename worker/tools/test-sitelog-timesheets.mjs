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
CREATE TABLE sites (site_name TEXT, lat REAL, lng REAL, radius_m INTEGER, archived INTEGER DEFAULT 0);
INSERT INTO sites VALUES ('Starbucks Jubilee Street',50.825362,-0.138606,500,0),('Brighton North Road',50.824983,-0.138814,500,0),('Far Away',51.5,-2.5,500,0);
INSERT INTO people VALUES ('p1','User','One','Mostlane'),('p2','User','Two','DCI'),('p3','User','Three','Storm Agency');
INSERT INTO visits VALUES
 ('v1','p1','Starbucks Jubilee Street','2026-10-12 06:55:00','2026-10-12 11:30:00',0,NULL,0,NULL,1,1,22,14),
 ('v2','p1','0125 Lee-On-Solent','2026-10-12 12:10:00','2026-10-12 15:00:00',0,NULL,0,NULL,1,0,30,NULL),
 ('v3','p2','Lake Road Surgery','2026-10-12 07:00:00','2026-10-12 15:00:00',1,NULL,0,NULL,1,0,8,NULL),
 ('v4','p3','Starbucks Jubilee Street','2026-10-12 08:00:00',NULL,0,NULL,0,NULL,1,0,40,NULL),
 ('v5','p2','Lake Road Surgery','2026-10-11 07:00:00','2026-10-11 14:00:00',0,NULL,1,NULL,0,0,NULL,NULL),
 ('v6','p1','Old visit','2026-10-05 07:00:00','2026-10-05 15:00:00',0,NULL,0,NULL,1,1,10,10);`);
for (const c of ['lat','lng','accuracy','out_lat','out_lng','out_accuracy']) sl.exec(`ALTER TABLE visits ADD COLUMN ${c} REAL`);
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
sl.exec(`INSERT INTO people VALUES ('p10','Scan','Ten','');
INSERT INTO visits (id,person_id,site_code,check_in_at,check_out_at,auto_checkout,sign_in_verified,sign_out_verified) VALUES ('s10','p10','Jubilee','2026-10-14 06:00:00','2026-10-14 13:54:00',0,1,1);
INSERT INTO scan_log (at,kind,outcome,person_id,site) VALUES ('2026-10-14T14:08:00.000Z','scan','confirm_check_in','p10','North Road');`);
const sc = await ts.loadPeriod(env, "2026-10-14", "2026-10-14");
const by = n => sc.find(p => p.name === n);
const s4 = by("Scan Four");
ok(s4.visits[0].state === "ok", "confirmed sign-out wins over an earlier unconfirmed scan");
ok(s4.visits.length === 1, "a sign-in scan 3 min after signing out elsewhere is someone leaving — not a visit");
ok(by("Scan Five").visits.length === 1, "sign-in scan while signed in elsewhere is ignored (no double count)");
const s6 = by("Scan Six").visits[0];
ok(s6.state === "scanned" && s6.scannedOut && s6.outTime === "14:30" && s6.mins === 450, "missed sign-out uses the last unconfirmed sign-out scan");
const s7 = by("Scan Seven");
ok(s7 && s7.visits.length === 1 && s7.visits[0].inTime === "07:30" && s7.visits[0].outTime === "16:00" && s7.visits[0].mins === 510,
  "scanned in + scanned again later at the same site → hours between the scans");
ok(!by("Scan Eight"), "a scan at 00:30 is not a plausible sign-in");
ok(by("Scan Nine").visits.length === 1, "the normal scan just before confirming is ignored");
ok(by("Scan Ten").visits.length === 1, "a sign-in scan within 30 min after signing out (leaving) is ignored");
const { personTotals } = await import("../src/lib/sitelogtspdf.js");
ok(personTotals(by("Scan Six")).scanned === 1 && personTotals(by("Scan Six")).missed === 0, "totals count it as scanned, not missed");
const scPdf = await ts.buildPdf(env, "daily", "2026-10-14");
ok(scPdf.bytes.length > 2000, "PDF with scanned rows builds");
writeFileSync(process.argv[4] || "/tmp/sl-scan.pdf", scPdf.bytes);

// ── Location map links ──
sl.exec("UPDATE visits SET lat=50.8255, lng=-0.1385, accuracy=14, out_lat=50.8254, out_lng=-0.1386, out_accuracy=12 WHERE id='v1'");
const noSecret = await ts.addMapLinks(env, "https://api.test", await ts.loadPeriod(env, "2026-10-12", "2026-10-12"), 3600);
ok(!noSecret.find(p => p.name === "User One").visits[0].mapIn, "no signing secret → no map links");
env.PORTAL_BRIDGE_SECRET = "s3cret";
const withLinks = await ts.addMapLinks(env, "https://api.test", await ts.loadPeriod(env, "2026-10-12", "2026-10-12"), 3600);
const lv = withLinks.find(p => p.name === "User One").visits[0];
ok(lv.mapIn && lv.mapOut && lv.mapIn.startsWith("https://api.test/sitelog-map?key=p1%7C2026-10-12%7Cv1%7Cin&exp="), "signed in/out map links on a located visit");
ok(!withLinks.find(p => p.name === "User Two").visits[0].mapOut, "auto-closed sign-out has no map pin");
const page = async u => { const url = new URL(u); const r = await ts.handleMap(new Request(u), env, {}, url); return { status: r.status, text: await r.text() }; };
let pg = await page(lv.mapIn);
ok(pg.status === 200 && pg.text.includes("leaflet") && pg.text.includes("User One"), "map page opens from a signed link");
const data = JSON.parse(pg.text.match(/<script type="application\/json" id="data">([\s\S]*?)<\/script>/)[1]);
ok(data.focus === "v1:in" && data.events.some(e => e.id === "v1:in" && e.dist < 50), "focused on the sign-in, distance from the site worked out");
ok(data.sites.some(s => s.name === "Brighton North Road") && !data.sites.some(s => s.name === "Far Away"), "neighbouring site drawn, far sites not");
pg = await page(lv.mapIn.replace(/sig=[0-9a-f]+/, "sig=" + "0".repeat(64)));
ok(pg.status === 403, "tampered link refused");
pg = await page(lv.mapIn.replace("%7Cin&", "%7Cout&"));
ok(pg.status === 403, "changing the event in the link breaks the signature");
sent.length = 0;
main.prepare("UPDATE app_config SET value=? WHERE key='sitelog:tsmail:sent:1'").run("{}");
await ts.emailTimesheet(env, 1, "daily", "2026-10-12", ["office@example.com"]);
ok(sent.length === 1 && (sent[0].html.match(/sitelog-map\?key=/g) || []).length >= 2 && sent[0].html.includes("📍"), "email carries 📍 map links per event");

// A worker's own week (the app's "My hours")
const mine = await ts.personWeek(env, "p1", "2026-10-14");
ok(mine.from === "2026-10-12" && mine.to === "2026-10-18" && mine.days.length === 7, "my week runs Mon-Sun from any day in it");
const mon = mine.days.find(d => d.day === "2026-10-12");
ok(mon.visits.length === 2 && mon.visits.every(v => !("pid" in v) && !("inLat" in v)), "only my visits, no ids or coordinates");
const office = (await ts.loadPeriod(env, "2026-10-12", "2026-10-18")).find(p => p.name === "User One");
ok(Math.round(mine.totals.mins) === Math.round(office.visits.reduce((n, v) => n + (v.state === "open" ? 0 : v.mins), 0)), "same hours as the office timesheet");
ok((await ts.personWeek(env, "p2", "2026-10-12")).totals.missed === 1, "missed sign-out counted for the worker too");
ok((await ts.personWeek(env, "nobody", "2026-10-12")).days.every(d => !d.visits.length), "someone else's visits never leak");

// A worker's totals by site (the app's "Summary") — same numbers as My Hours
const r = ts.summaryRange;
ok(r("this_week","2026-10-14").from === "2026-10-12", "summary: this week starts Monday");
ok(r("last_month","2026-01-10").from === "2025-12-01" && r("last_month","2026-01-10").to === "2025-12-31", "summary: last month across a year end");
ok(r("this_month","2026-10-14").from === "2026-10-01" && r("last_14","2026-10-14").from === "2026-10-01", "summary: this month / last 14 days");
at("2026-10-14T12:00:00Z");
const sm = await ts.personSummary(env, "p1", "this_week");
const wk1 = await ts.personWeek(env, "p1", "2026-10-14");
ok(sm.totals.mins === Math.round(wk1.totals.mins), "summary hours = My Hours for the same week");
ok(sm.sites.reduce((n, x) => n + x.mins, 0) >= sm.totals.mins - sm.sites.length && sm.sites[0].mins >= sm.sites[sm.sites.length - 1].mins, "summary split by site, biggest first");
const all = await ts.personSummary(env, "p1", "all");
ok(all.from === "2026-10-05" && all.totals.visits >= sm.totals.visits, "all time starts at the first visit");
ok((await ts.personSummary(env, "p2", "all")).sites.some(x => x.missed === 1), "missed sign-out flagged per site");
ok((await ts.personSummary(env, "nobody", "all")).sites.length === 0, "summary: nobody else's visits");

// ── A "sign out?" within an hour of signing in is the app re-checking, not leaving (Oleh 28 Oct) ──
sl.exec(`INSERT INTO people VALUES ('p11','Early','Out',''),('p12','Half','Day','');
INSERT INTO visits (id,person_id,site_code,check_in_at,check_out_at,auto_checkout,sign_in_verified,sign_out_verified) VALUES
 ('e11','p11','Jubilee','2026-10-28 08:02:10','2026-10-28 16:00:00',1,1,0),
 ('e12','p12','Jubilee','2026-10-31 08:24:19','2026-10-31 16:00:00',1,1,0);
INSERT INTO scan_log (at,kind,outcome,person_id,site) VALUES
 ('2026-10-28T08:17:55.577Z','scan','confirm_sign_out','p11','Jubilee'),
 ('2026-10-28T08:17:55.584Z','scan','confirm_sign_out','p11','Jubilee'),
 ('2026-10-31T08:35:19.000Z','scan','confirm_sign_out','p12','Jubilee'),
 ('2026-10-31T12:01:55.000Z','scan','confirm_sign_out','p12','Jubilee');`);
at("2026-11-02T12:00:00Z");
const eo = await ts.loadPeriod(env, "2026-10-28", "2026-10-31");
const e11 = eo.find(p => p.id === "p11").visits[0], e12 = eo.find(p => p.id === "p12").visits[0];
ok(e11.state === "auto" && e11.outTime === "16:00" && Math.round(e11.mins) === 478, "sign-out offer 15 min after sign-in ignored → missed sign-out at 16:00");
ok(e12.state === "scanned" && e12.outTime === "12:01", "a later sign-out offer still used; the 11-min one ignored");

// ── Timesheet tab: any dates, chosen people ──
const rp = ts.rangePeriod;
ok(rp("2026-10-05","2026-10-11").label === "5 Oct – 11 Oct 2026" && rp("2026-10-05","2026-10-11").kind === "range", "range: label + kind");
ok(rp("2026-10-11","2026-10-05").from === "2026-10-05", "range: back-to-front dates are swapped");
ok(rp("2026-10-05","2026-10-05").file === "SiteLog-2026-10-05.pdf", "range: one day reads as a day");
ok(rp("2025-12-29","2026-01-04").label.includes("2025") && rp("2026-01-01","2026-12-31").to === "2026-04-04", "range: across a year shows both years; capped at 93 days");
ok(rp("bad","2026-10-05") === null, "range: bad date ignored");
at("2026-10-14T12:00:00Z");
const allP = await ts.loadPeriod(env, "2026-10-05", "2026-10-11");
ok(allP.every(p => p.id), "every person carries their id");
const one = await ts.pickPeople(env, allP, ["p1"]);
ok(one.length === 1 && one[0].id === "p1", "pick: only the chosen person");
const withEmpty = await ts.pickPeople(env, allP, ["p1", "p3"]);
ok(withEmpty.length === 2 && withEmpty.find(p => p.id === "p3") && withEmpty.find(p => p.id === "p3").visits.length === 0, "pick: chosen person with no visits still listed");
const pdf = await ts.buildPdf(env, "daily", "2026-10-14", { period: rp("2026-10-05","2026-10-11"), people: ["p1"] });
ok(pdf.people.length === 1 && pdf.bytes.length > 1000 && pdf.per.kind === "range", "pdf: chosen people + range");
globalThis.Date = realDate;
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
