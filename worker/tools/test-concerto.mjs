// Concerto PPM list — drives the real concerto.js handler against a REAL SQLite
// (node:sqlite) through a tiny D1-shaped shim: import (both layouts, dedupe,
// gone-marking), the reference map, reconciliation flags vs the compliance chart,
// the reverse "overdue on the chart but not on Concerto" check, money gating.
// Run:  node --no-warnings worker/tools/test-concerto.mjs
import { DatabaseSync } from "node:sqlite";
import * as concerto from "../src/routes/concerto.js";
const { parseOrderDescription, typeOf, periodOf, toIsoDate, addMonths, reconcileRow, splitSite } = concerto;

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
  db.exec(`CREATE TABLE user_permissions (tenant_id, username, permission, value);
    CREATE TABLE users (tenant_id, username, profile);
    CREATE TABLE compliance_stores (tenant_id INTEGER, scheme TEXT, code TEXT, category TEXT, name TEXT, postcode TEXT, due TEXT, active INTEGER DEFAULT 1, meta TEXT, updated_at TEXT);
    CREATE TABLE sites (tenant_id INTEGER, client TEXT, site_number TEXT, site_name TEXT, postcode TEXT, active INTEGER, job_number TEXT, data TEXT, updated_at TEXT);
    CREATE TABLE sla_jobs (tenant_id, id TEXT, data TEXT, status TEXT, helpdesk_ref TEXT, site_code TEXT);
    CREATE TABLE app_config (tenant_id, key, value);
    CREATE TABLE sla_jobs_archive (tenant_id INTEGER, id TEXT PRIMARY KEY, ref TEXT, status TEXT, assigned_to TEXT, site_name TEXT, postcode TEXT, created_at TEXT, completed_at TEXT, search TEXT, data TEXT, site_code TEXT);
    CREATE TABLE compliance_files (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER, code TEXT, type TEXT, year TEXT, r2_key TEXT, filename TEXT, size INTEGER, doc_date TEXT, source TEXT, uploaded_at TEXT, label TEXT, pinned INTEGER, scheme TEXT);`);
  const ins = (t, cols, rows) => { const st = db.prepare(`INSERT INTO ${t} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`); for (const r of rows) st.run(...r); };
  ins("user_permissions", ["tenant_id","username","permission","value"], [[1,"Jamie Line","FullAccess",1],[1,"Tanya","Compliance",1],[1,"Ryan Diggens","SLAAdmin",1],[1,"Nobody","SLA",1]]);
  ins("users", ["tenant_id","username","profile"], [[1,"Jamie Line",'{"staffType":"office"}'],[1,"Tanya",'{"staffType":"office"}'],[1,"Ryan Diggens",'{"staffType":"field"}'],[1,"Nobody",'{}']]);
  // Chart: due dates as the live DB holds them (ISO, and one legacy dd/mm/yyyy)
  ins("compliance_stores", ["tenant_id","scheme","code","category","name","due","active"], [
    [1,"coop","0305","Retail",null,'{"em":"2026-08-20","pat":"2026-08-20"}',1],   // done Aug 2025 (chart rolled to Aug 2026)
    [1,"coop","0622","ELS",null,'{"em":"2026-07-15","pat":"2026-07-15"}',1],      // due July 2026 (Concerto July 2026 SC-EL-SR00373 style)
    [1,"coop","0032","Retail",null,'{"em":"2026-02-01","pat":"2026-02-01"}',1],   // overdue on chart vs Concerto Aug 2025 → done? lastDone 2025-02-01 < Jul 2025 → mismatch(earlier)
    [1,"coop","0037","Retail",null,'{"em":"12/11/2026","pat":"12/11/2026"}',1],   // legacy date; Concerto Aug 2025 → lastDone 2025-11-12 ≥ 2025-06-16 → done
    [1,"coop","0238","Retail","Bedminster STORE CLOSED",'{"em":"STORE CLOSED"}',0],
    [1,"coop","0999","Retail",null,'{"em":"2026-01-10","pat":"2026-12-01","fiveYear":"2026-03-01"}',1],   // overdue EM + 5-year on chart, not on Concerto → chartMissing
  ]);
  ins("sites", ["tenant_id","client","site_number","site_name"], [[1,"retail","0305","Portchester, White Hart Lane"],[1,"els","622","The Co-operative Funeralcare - Frome"],[1,"retail","0032","Fareham, Gudge Heath Lane"],[1,"retail","0037","Titchfield, The Square"],[1,"retail","0999","Test Store"]]);
  ins("sla_jobs", ["tenant_id","id","data","status"], [[1,"J1",JSON.stringify({ id:"J1", siteCode:"0622", emTest:true, pat:true, status:"Scheduled", scheduledAt:"2026-09-14T09:00:00.000Z", assignedEngineers:["Ryan Diggens"], helpdeskRef:"Frome" }),"Scheduled"],
    [1,"J5",JSON.stringify({ id:"J5", siteCode:"0305", description:"5 Year Electrical Test - certificate number 0990", status:"Complete", scheduledAt:"2026-03-02T08:00:00.000Z", statusHistory:[{status:"In Progress",at:"2026-03-02T08:10:00Z"},{status:"Complete",at:"2026-03-02T15:40:00Z"}], assignedEngineers:["Connor"] }),"Complete"]]);
  ins("sla_jobs_archive", ["tenant_id","id","ref","status","completed_at","created_at","search","data","site_code"], [[1,"MOS9800","MOS9800","Closed Jobs","2021-06-14T10:00:00Z","2021-06-01T10:00:00Z","starbucks winchester eicr carry out eicr", JSON.stringify({ id:"MOS9800", jobName:"Co-op Frome EICR", description:"Carry out EICR" }), "622"]]);
  ins("compliance_files", ["tenant_id","scheme","code","type","doc_date","filename","r2_key"], [[1,"coop","0037","fiveYear","2024-11-12","0037 EICR.pdf","k1"],[1,"coop","0037","fiveYear","2019-11-01","old.pdf","k0"]]);
  return { env: { DB: d1(db), OWNER_USERNAME: "Jamie Line" }, db };
}
const sessFor = (who) => ({ user: { username: who, tenant_id: 1 }, tenantId: 1, session: { token: "T" } });
async function call(env, who, method, path, body) {
  const url = new URL("https://api.test" + path);
  const req = new Request(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const res = await concerto.handle(req, env, { waitUntil() {} }, url, sessFor(who));
  let j = null; try { j = await res.clone().json(); } catch {}
  return { status: res.status, body: j };
}
let fail = 0; const ok = (name, cond, extra = "") => { console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra ? "  → " + extra : "")); if (!cond) fail++; };

// ── 1. Pure parsing ──────────────────────────────────────────────────────────
{
  const a = parseOrderDescription("Emergency light - August 2025 : AR005758");
  ok("parse AR ref", a.type === "em" && a.period === "2025-08" && a.ref === "AR005758" && a.srRef === "", JSON.stringify(a));
  const b = parseOrderDescription("Emergency light - July 2026 : SC-EL-SR00373");
  ok("parse SC-EL-SR ref", b.type === "em" && b.period === "2026-07" && b.ref === "SC-EL-SR00373" && b.srRef === "SR00373", JSON.stringify(b));
  const c = parseOrderDescription("PAT - August 2026 : EL-PAT-SR00161");
  ok("parse EL-PAT-SR ref", c.type === "pat" && c.period === "2026-08" && c.srRef === "SR00161");
  const d = parseOrderDescription("Pump maintenance - August 2026 : AR003825");
  ok("parse pump", d.type === "pump" && d.period === "2026-08" && d.ref === "AR003825");
  ok("parse PV", parseOrderDescription("PV - June 2026 : AR000709").type === "pv");
  ok("typeOf EL-5Y / 5 year fixed wire", typeOf("EL-5Y 5 year fixed wire") === "fiveYear" && typeOf("EL-PAT") === "pat" && typeOf("EL-EM Emergency light") === "em");
  ok("periodOf", periodOf("November 2025") === "2025-11" && periodOf("nonsense") === "");
  ok("toIsoDate serial/iso/dmy", toIsoDate(45868.76) === "2025-07-30" && toIsoDate("2026-08-20") === "2026-08-20" && toIsoDate("12/11/2026") === "2026-11-12" && toIsoDate("STORE CLOSED") === null);
  ok("addMonths clamps", addMonths("2026-03-31", -1) === "2026-02-28" && addMonths("2026-08-20", -12) === "2025-08-20");
  ok("splitSite", JSON.stringify(splitSite("0109 - Romsey, Winchester Hill (PFS)")) === JSON.stringify({ code: "0109", name: "Romsey, Winchester Hill (PFS)" }));
}
// ── 2. reconcileRow branches (fixed today) ───────────────────────────────────
{
  const T = "2026-09-09";
  const st = (due, closed) => ({ code: "0001", category: "Retail", name: "X", due, closed: !!closed });
  ok("no_store", reconcileRow({ store_code: "", ppm_type: "em", period: "2025-08" }, null, T).flag === "no_store");
  ok("not_on_chart", reconcileRow({ store_code: "0001", ppm_type: "em", period: "2025-08" }, null, T).flag === "not_on_chart");
  ok("store_closed", reconcileRow({ store_code: "0001", ppm_type: "em", period: "2025-08" }, st({}, true), T).flag === "store_closed");
  ok("no_chart_date", reconcileRow({ store_code: "0001", ppm_type: "em", period: "2025-08" }, st({ pat: "2026-01-01" }), T).flag === "no_chart_date");
  ok("done (chart rolled past the period)", reconcileRow({ store_code: "0001", ppm_type: "em", period: "2025-08" }, st({ em: "2026-08-20" }), T).flag === "done");
  ok("due (agree, future)", reconcileRow({ store_code: "0001", ppm_type: "em", period: "2026-10" }, st({ em: "2026-10-05" }), T).flag === "due");
  ok("overdue (agree, past)", reconcileRow({ store_code: "0001", ppm_type: "em", period: "2026-07" }, st({ em: "2026-07-15" }), T).flag === "overdue");
  ok("mismatch chart earlier", reconcileRow({ store_code: "0001", ppm_type: "em", period: "2025-08" }, st({ em: "2026-02-01" }), T).flag === "mismatch");
  ok("mismatch chart later", reconcileRow({ store_code: "0001", ppm_type: "em", period: "2026-08" }, st({ em: "2026-12-01" }), T).flag === "mismatch");
  ok("pump monthly done", reconcileRow({ store_code: "0001", ppm_type: "pump", period: "2026-08" }, st({ pump: "2026-09-20" }), T).flag === "done");
  ok("schedule row planned date drives it", reconcileRow({ store_code: "0001", ppm_type: "fiveYear", planned_date: "2026-06-30" }, st({ fiveYear: "2031-06-25" }), T).flag === "done");
}
// ── 3. Gate + import + dedupe + gone ─────────────────────────────────────────
const ROWS = [
  { orderNumber: "PPM0297", orderDate: 45868.7643, orderValue: 161.09, description: "Emergency light - August 2025 : AR005758", supplier: "Mostlane" },
  { orderNumber: "PPM10637", orderDate: "2026-06-12", orderValue: 161.09, description: "Emergency light - July 2026 : SC-EL-SR00373", supplier: "Mostlane" },
  { orderNumber: "PPM0208", orderDate: 45868.7638, orderValue: 266.09, description: "Emergency light - August 2025 : AR005750", supplier: "Mostlane" },
  { orderNumber: "PPM0322", orderDate: 45868.7644, orderValue: 161.09, description: "Emergency light - August 2025 : AR005767", supplier: "Mostlane" },
  { orderNumber: "PPM11557", orderDate: "2026-07-10", orderValue: 135, description: "Pump maintenance - August 2026 : AR003825", supplier: "Mostlane" },
  { orderNumber: "PPM9999", orderDate: "2026-07-10", orderValue: 161.09, description: "Emergency light - August 2026 : SC-EL-SR00238", supplier: "Mostlane" },
];
{
  const { env } = makeEnv();
  const g = await call(env, "Nobody", "GET", "/concerto/list");
  ok("403 without an office permission", g.status === 403);
  // Seed the reference map the way the live one is seeded (AR from the 2025 sheet, SR from emails)
  const seed = await call(env, "Jamie Line", "POST", "/concerto/refs/seed", { refs: [
    { ref: "AR005758", storeCode: "305", siteName: "Portchester" }, { ref: "SR00373", storeCode: "0622", siteName: "Frome" },
    { ref: "AR005750", storeCode: "32" }, { ref: "AR005767", storeCode: "37" }, { ref: "SR00238", storeCode: "0238" }, { ref: "bad", storeCode: "1" } ] });
  ok("seed learns valid refs only", seed.status === 200 && seed.body.learned === 5, JSON.stringify(seed.body));
  const im = await call(env, "Jamie Line", "POST", "/concerto/import", { layout: "orders", rows: ROWS, fileName: "Open PPM jobs overdue (completion).xlsx" });
  ok("import adds 6, 1 unresolved (AR003825)", im.status === 200 && im.body.added === 6 && im.body.updated === 0 && im.body.unresolved === 1 && im.body.gone === 0, JSON.stringify(im.body));
  const im2 = await call(env, "Jamie Line", "POST", "/concerto/import", { layout: "orders", rows: ROWS, fileName: "again.xlsx" });
  ok("re-import never duplicates", im2.body.added === 0 && im2.body.updated === 6, JSON.stringify(im2.body));
  const l = await call(env, "Jamie Line", "GET", "/concerto/list");
  const by = Object.fromEntries((l.body.rows || []).map(r => [r.id, r]));
  ok("list has 6 open rows", l.status === 200 && l.body.rows.length === 6 && l.body.counts.open === 6);
  ok("PPM0297 → 0305 done our side", by.PPM0297.storeCode === "0305" && by.PPM0297.flag === "done" && by.PPM0297.siteName === "Portchester, White Hart Lane", JSON.stringify(by.PPM0297));
  ok("PPM10637 → 0622 overdue (chart 2026-07-15) + booked job attached", by.PPM10637.storeCode === "0622" && by.PPM10637.flag === "overdue" && by.PPM10637.job && by.PPM10637.job.id === "J1", JSON.stringify(by.PPM10637));
  ok("PPM0208 → 0032 mismatch", by.PPM0208.flag === "mismatch", by.PPM0208.flagText);
  ok("PPM0322 → 0037 legacy dd/mm/yyyy chart date → done", by.PPM0322.flag === "done", by.PPM0322.flagText);
  ok("PPM11557 unmapped → no_store", by.PPM11557.flag === "no_store" && by.PPM11557.storeCode === "");
  ok("PPM9999 → closed store", by.PPM9999.flag === "store_closed");
  ok("Full Access sees order value", by.PPM0297.orderValue === 161.09);
  const cm = l.body.chartMissing;
  ok("chartMissing: 0999 EM overdue on chart with no Concerto row; PAT rows Concerto never listed also flagged; covered EM rows not", cm.some(x => x.storeCode === "0999" && x.type === "em" && x.overdue) && cm.some(x => x.storeCode === "0999" && x.type === "fiveYear" && x.overdue) && cm.some(x => x.storeCode === "0305" && x.type === "pat") && !cm.some(x => x.type === "em" && ["0305","0622","0032","0037"].includes(x.storeCode)) && !cm.some(x => x.storeCode === "0238"), JSON.stringify(cm.map(x => x.storeCode + ":" + x.type)));
  // Teach the unmapped reference → the row resolves
  const t = await call(env, "Jamie Line", "POST", "/concerto/ref", { ref: "ar003825", storeCode: "382", siteName: "Binfield" });
  const l2 = await call(env, "Jamie Line", "GET", "/concerto/list");
  const r2 = l2.body.rows.find(r => r.id === "PPM11557");
  ok("teach a ref → row resolves", t.status === 200 && r2.storeCode === "0382" && r2.flag === "not_on_chart", JSON.stringify(r2));
  // Money: an SLAAdmin FIELD user gets no values; Compliance office user does
  const lf = await call(env, "Ryan Diggens", "GET", "/concerto/list");
  ok("field SLAAdmin: no order values", lf.status === 200 && lf.body.money === false && lf.body.rows.every(r => r.orderValue === undefined));
  const lt = await call(env, "Tanya", "GET", "/concerto/list");
  ok("office Compliance user: values shown", lt.body.money === true && lt.body.rows[0].orderValue != null);
  // Dismiss → drops out of open, shows under all
  const ds = await call(env, "Jamie Line", "POST", "/concerto/status", { id: "PPM9999", status: "dismissed", note: "store closed" });
  const l3 = await call(env, "Jamie Line", "GET", "/concerto/list");
  const l3a = await call(env, "Jamie Line", "GET", "/concerto/list?status=all");
  ok("dismiss hides from open, kept under all", ds.status === 200 && l3.body.rows.length === 5 && l3a.body.rows.find(r => r.id === "PPM9999").flag === "dismissed");
  // A later full list without PPM0297 marks it gone; a list that has it again re-opens it
  const im3 = await call(env, "Jamie Line", "POST", "/concerto/import", { layout: "orders", rows: ROWS.filter(r => r.orderNumber !== "PPM0297"), fileName: "later.xlsx" });
  const l4 = await call(env, "Jamie Line", "GET", "/concerto/list?status=all");
  const gone = l4.body.rows.find(r => r.id === "PPM0297");
  ok("row missing from a later full list → gone", im3.body.gone === 1 && gone.status === "gone" && gone.flag === "gone", JSON.stringify(im3.body));
  ok("dismissed row is not touched by gone-marking", l4.body.rows.find(r => r.id === "PPM9999").status === "dismissed");
  const im4 = await call(env, "Jamie Line", "POST", "/concerto/import", { layout: "orders", rows: ROWS, fileName: "back.xlsx" });
  const l5 = await call(env, "Jamie Line", "GET", "/concerto/list");
  ok("reappearing row re-opens", l5.body.rows.find(r => r.id === "PPM0297").status === "open" && im4.body.gone === 0);
  // Schedule layout (short June export): learns SR→store from the Site column, one row per site+type
  const sch = [{ uprn: "SR00314", site: "0109 - Romsey, Winchester Hill (PFS)", block: "B01", ref: "EL-5Y", type: "5 year fixed wire", supplier: "Mostlane", lastDate: "", plannedDate: 46203, estimate: 960 },
               { uprn: "SR00373", site: "0622 - The Co-operative Funeralcare - Frome", ref: "EL-EM", type: "Emergency light", plannedDate: "2026-11-05" }];
  const is1 = await call(env, "Jamie Line", "POST", "/concerto/import", { layout: "schedule", rows: sch, fileName: "ppm_schedule.xlsx" });
  const is2 = await call(env, "Jamie Line", "POST", "/concerto/import", { layout: "schedule", rows: sch, fileName: "ppm_schedule.xlsx" });
  const refs = await call(env, "Jamie Line", "GET", "/concerto/refs");
  const l6 = await call(env, "Jamie Line", "GET", "/concerto/list?kind=schedule");
  const s1 = l6.body.rows.find(r => r.id === "SCH:SR00314:fiveYear");
  ok("schedule import adds 2, re-import updates 2", is1.body.added === 2 && is2.body.added === 0 && is2.body.updated === 2, JSON.stringify(is1.body) + " " + JSON.stringify(is2.body));
  ok("schedule row resolved from its Site column + planned serial date", s1 && s1.storeCode === "0109" && s1.nextDate === "2026-06-30" && s1.type === "fiveYear" && s1.flag === "not_on_chart", JSON.stringify(s1));
  ok("schedule import taught SR00314 → 0109", refs.body.refs.some(r => r.ref === "SR00314" && r.storeCode === "0109"));
  const s2 = l6.body.rows.find(r => r.id === "SCH:SR00373:em");
  ok("schedule EM row for Frome: chart 2026-07-15 earlier than planned Nov → mismatch", s2 && s2.flag === "mismatch", s2 && s2.flagText);
  const lo = await call(env, "Jamie Line", "GET", "/concerto/list");
  ok("orders list excludes schedule rows", lo.body.rows.every(r => r.kind === "order"));
  // Full 5-year schedule layout: next date, release (Order nr.), log + history cross-reference
  const full = [
    { uprn: "SR00364", site: "0305 - Portchester, White Hart Lane", block: "B01", ref: "EL-5Y", type: "5 year fixed wire", discipline: "Electrical", frequency: "60 Months", supplier: "Mostlane", lastDate: "", nextDate: "2026-11-30", monthMarker: "Nov: ORD01", ordered: 960, status: "Live", orderNr: "PPM11642" },
    { uprn: "SR00161", site: "0622 - The Co-operative Funeralcare - Frome", ref: "EL-5Y", type: "5 year fixed wire", frequency: "60 Months", nextDate: "2031-05-31", lastDate: "2026-05-31", status: "Live", orderNr: "" },
    { uprn: "SR00283", site: "0037 - Titchfield, The Square", ref: "EL-5Y", type: "5 year fixed wire", frequency: "60 Months", nextDate: "2029-11-12", status: "Live", orderNr: "" },
  ];
  const if1 = await call(env, "Jamie Line", "POST", "/concerto/import", { layout: "schedule", rows: full, fileName: "ppm_schedule_5.xlsx" });
  ok("full layout: 3 rows (1 existing SR00314 5-year row now gone — not in this full 5-year list), 1 released", if1.body.added === 3 && if1.body.released === 1 && if1.body.gone === 1, JSON.stringify(if1.body));
  const sc = await call(env, "Jamie Line", "GET", "/concerto/schedule?type=fiveYear");
  const by5 = Object.fromEntries((sc.body.rows || []).map(r => [r.storeCode, r]));
  ok("schedule endpoint: 3 live 5-year rows, stats", sc.status === 200 && sc.body.total === 3 && sc.body.stats.released === 1 && sc.body.stats.notReleased === 2 && sc.body.stats.releasesLogged === 1, JSON.stringify(sc.body.stats));
  ok("released row carries PPM number + value + releasedAt", by5["0305"].released && by5["0305"].orderNr === "PPM11642" && by5["0305"].orderedValue === 960 && by5["0305"].releasedAt, JSON.stringify(by5["0305"]));
  ok("history: 0305 last done = the completed live 5-year job (2026-03-02)", by5["0305"].lastDone && by5["0305"].lastDone.source === "job" && by5["0305"].lastDone.date === "2026-03-02" && by5["0305"].lastDone.id === "J5", JSON.stringify(by5["0305"].lastDone));
  ok("history: 0622 last done = archive EICR job (site_code '622' numeric match)", by5["0622"].lastDone && by5["0622"].lastDone.source === "archive" && by5["0622"].lastDone.id === "MOS9800" && by5["0622"].lastDone.date === "2021-06-14", JSON.stringify(by5["0622"].lastDone));
  ok("history: 0037 last done = newest certificate on file (2024-11-12)", by5["0037"].lastDone && by5["0037"].lastDone.source === "cert" && by5["0037"].lastDone.date === "2024-11-12" && by5["0037"].history.length === 2, JSON.stringify(by5["0037"].lastDone));
  ok("5-year reconcile: 0037 has no 5-year chart date → no_chart_date (never a false done/due)", by5["0037"].flag === "no_chart_date", by5["0037"].flagText);
  const scR = await call(env, "Jamie Line", "GET", "/concerto/schedule?type=fiveYear&released=yes");
  const scN = await call(env, "Jamie Line", "GET", "/concerto/schedule?type=fiveYear&released=no&from=2029-01-01&to=2029-12-31");
  ok("released + timeline filters", scR.body.rows.length === 1 && scR.body.rows[0].storeCode === "0305" && scN.body.rows.length === 1 && scN.body.rows[0].storeCode === "0037" && scR.body.total === 3);
  // Re-import with a new release + a moved next date → logged once each, never duplicated
  const full2 = full.map(r => r.uprn === "SR00161" ? { ...r, orderNr: "PPM12000", ordered: 960 } : r.uprn === "SR00283" ? { ...r, nextDate: "2029-12-01" } : r);
  const if2 = await call(env, "Jamie Line", "POST", "/concerto/import", { layout: "schedule", rows: full2, fileName: "ppm_schedule_5b.xlsx" });
  const if3 = await call(env, "Jamie Line", "POST", "/concerto/import", { layout: "schedule", rows: full2, fileName: "ppm_schedule_5b.xlsx" });
  const lg = await call(env, "Jamie Line", "GET", "/concerto/log");
  const rel = lg.body.events.filter(e => e.event === "released"), mv = lg.body.events.filter(e => e.event === "next_date_changed");
  ok("second release logged once; next-date change logged once; third import logs nothing new", if2.body.released === 1 && if3.body.released === 0 && rel.length === 2 && mv.length === 1 && mv[0].from === "2029-11-12" && mv[0].to === "2029-12-01", JSON.stringify({ rel: rel.length, mv }));
  const sc2 = await call(env, "Jamie Line", "GET", "/concerto/schedule?type=fiveYear");
  ok("released_at kept from first sight, PPM number stored", sc2.body.rows.find(r => r.storeCode === "0622").orderNr === "PPM12000" && sc2.body.stats.released === 2);
  const scF = await call(env, "Ryan Diggens", "GET", "/concerto/schedule?type=fiveYear");
  ok("field user: schedule shows no ordered values", scF.body.rows.every(r => r.orderedValue === undefined));
  const st = await call(env, "Jamie Line", "GET", "/concerto/stores");
  ok("stores picker lists chart stores with names + closed flag", st.body.stores.length === 6 && st.body.stores.find(s => s.code === "0238").closed === true && st.body.stores.find(s => s.code === "0622").name.includes("Frome"));
}
console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
