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
  if (concerto.ensureTables && concerto.ensureTables.reset) concerto.ensureTables.reset();   // once-per-isolate migration → run again for this fresh DB
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE user_permissions (tenant_id, username, permission, value);
    CREATE TABLE users (tenant_id, username, profile);
    CREATE TABLE compliance_stores (tenant_id INTEGER, scheme TEXT, code TEXT, category TEXT, name TEXT, postcode TEXT, due TEXT, active INTEGER DEFAULT 1, meta TEXT, updated_at TEXT);
    CREATE TABLE sites (tenant_id INTEGER, client TEXT, site_number TEXT, site_name TEXT, postcode TEXT, active INTEGER, job_number TEXT, data TEXT, updated_at TEXT);
    CREATE TABLE sla_jobs (tenant_id, id TEXT, data TEXT, status TEXT, helpdesk_ref TEXT, site_code TEXT);
    CREATE TABLE app_config (tenant_id, key, value);
    CREATE TABLE sla_jobs_archive (tenant_id INTEGER, id TEXT PRIMARY KEY, ref TEXT, status TEXT, assigned_to TEXT, site_name TEXT, postcode TEXT, created_at TEXT, completed_at TEXT, search TEXT, data TEXT, site_code TEXT);
    CREATE TABLE compliance_review (tenant_id INTEGER, scheme TEXT, code TEXT, type TEXT, status TEXT, outcome TEXT, attention INTEGER, summary TEXT, flags TEXT, file_id INTEGER, doc_at TEXT, checked_at TEXT, notes TEXT, updated_by TEXT, updated_at TEXT);
    CREATE TABLE client_orders (id TEXT PRIMARY KEY, tenant_id TEXT, order_number TEXT, order_value REAL, title TEXT, description TEXT, detail TEXT, store_code TEXT, status TEXT, matched_kind TEXT, matched_job_id TEXT, created_at TEXT, notified_at TEXT);
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
// ── 5-year EICR pipeline (cases) ────────────────────────────────────────────
{
  const { env, db } = makeEnv();
  const ins = (t, cols, rows) => { const st = db.prepare(`INSERT INTO ${t} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`); for (const r of rows) st.run(...r); };
  // 0305: elec-test job complete 2026-03-02 by Connor, cert on file 2026-03-05, compliance check read it UNSATISFACTORY, works job raised (open), client order for the remedials
  ins("sla_jobs", ["tenant_id","id","data","status"], [
    [1,"E1",JSON.stringify({ id:"E1", siteCode:"0305", elecTest:true, description:"5 year test", status:"Complete", scheduledAt:"2026-03-02T08:00:00.000Z", statusHistory:[{status:"Complete",at:"2026-03-02T15:40:00Z"}], assignedEngineers:["Connor"], remedials:[{id:"r1",code:"C2",description:"x"}], remedialsWorksJobId:"W1" }),"Complete"],
    [1,"W1",JSON.stringify({ id:"W1", siteCode:"0305", description:"[C2] x", status:"Scheduled", scheduledAt:"2026-10-01T08:00:00.000Z", assignedEngineers:["Ryan Diggens"], fromRemedialsOf:"E1" }),"Scheduled"],
    // 0037: booked, not done yet
    [1,"E2",JSON.stringify({ id:"E2", siteCode:"0037", elecTest:true, description:"5 year test", status:"Scheduled", scheduledAt:"2026-10-20T08:00:00.000Z", assignedEngineers:["Daniel Walker"] }),"Scheduled"],
  ]);
  ins("compliance_files", ["tenant_id","scheme","code","type","doc_date","filename","r2_key"], [[1,"coop","0305","fiveYear","2026-03-05","0305 EICR.pdf","k5"],[1,"coop","0305","fiveYear","2021-03-01","old.pdf","k4"]]);
  const certId = db.prepare("SELECT id FROM compliance_files WHERE code='0305' AND doc_date='2026-03-05'").get().id;
  ins("compliance_review", ["tenant_id","scheme","code","type","status","outcome","attention","file_id","doc_at","checked_at"], [[1,"coop","0305","fiveYear","open","UNSATISFACTORY",1,certId,"2026-03-05T10:00:00Z","2026-03-06T09:00:00Z"]]);
  ins("client_orders", ["id","tenant_id","order_number","order_value","title","description","store_code","status","created_at"], [["o1","1.0","R30001",480,"Order R30001","EICR remedial works C2 items","0305","new","2026-03-20T10:00:00Z"],["o0","1.0","R29000",50,"Order R29000","EM remedial","0305","new","2026-03-21T10:00:00Z"]]);
  db.prepare("UPDATE client_orders SET matched_kind='em' WHERE id='o0'").run();
  const rows = [
    { uprn: "SR00364", site: "0305 - Portchester, White Hart Lane", ref: "EL-5Y", type: "5 year fixed wire", frequency: "60 Months", nextDate: "2026-11-30", status: "Live", orderNr: "PPM11642", ordered: 960 },
    { uprn: "SR00283", site: "0037 - Titchfield, The Square", ref: "EL-5Y", type: "5 year fixed wire", frequency: "60 Months", nextDate: "2026-11-12", status: "Live", orderNr: "" },
    { uprn: "SR00161", site: "0622 - The Co-operative Funeralcare - Frome", ref: "EL-5Y", type: "5 year fixed wire", frequency: "60 Months", nextDate: "2031-05-31", lastDate: "2026-05-31", status: "Live", orderNr: "" },
  ];
  await call(env, "Jamie Line", "POST", "/concerto/import", { layout: "schedule", rows, fileName: "ppm_schedule_5.xlsx" });
  let sc = await call(env, "Jamie Line", "GET", "/concerto/schedule?type=fiveYear");
  let by = Object.fromEntries(sc.body.rows.map(r => [r.storeCode, r]));
  const st = (r, k) => r.case.steps.find(s => s.key === k);
  ok("pipeline: every 5-year row carries a case; stats.pipeline present", sc.body.rows.every(r => r.case) && sc.body.stats.pipeline && Array.isArray(sc.body.stats.pipeline.steps));
  ok("0305 auto: scheduled + tested (job), reviewed (compliance check UNSATISFACTORY), ordered (client order R30001, the EM order ignored), works not yet done → next = quoted", by["0305"].case.outcome === "unsatisfactory" && by["0305"].case.outcomeSource === "review" && st(by["0305"], "scheduled").done && st(by["0305"], "tested").done && st(by["0305"], "reviewed").done && st(by["0305"], "ordered").done && /R30001/.test(st(by["0305"], "ordered").detail) && !st(by["0305"], "works_done").done && by["0305"].case.next === "quoted", JSON.stringify({ next: by["0305"].case.next, out: by["0305"].case.outcome, steps: by["0305"].case.steps.map(s => s.key + ":" + s.done) }));
  ok("0305 engineer = the test job's engineer (Connor), cert on file 2026-03-05, works job W1 linked", by["0305"].case.engineer === "Connor" && by["0305"].case.engineerSource === "job" && by["0305"].case.cert && by["0305"].case.cert.date === "2026-03-05" && by["0305"].case.worksJob && by["0305"].case.worksJob.id === "W1", JSON.stringify(by["0305"].case.cert));
  ok("0305 unsat steps applicable; stage = quoted; field user sees no order value", by["0305"].case.steps.filter(s => s.applicable).length === 12 && by["0305"].case.stage === "quoted" && (await call(env, "Ryan Diggens", "GET", "/concerto/schedule?type=fiveYear")).body.rows.find(r => r.storeCode === "0305").case.order.value === undefined);
  ok("0037: booked job → scheduled ticked, next = tested, engineer from the job, active (due within a year)", st(by["0037"], "scheduled").done && by["0037"].case.next === "tested" && by["0037"].case.engineer === "Daniel Walker" && by["0037"].case.active && by["0037"].case.stage === "tested");
  ok("0622: due 2031, nothing booked → not due yet (no pipeline noise)", by["0622"].case.stage === "not_due" && !by["0622"].case.active);
  ok("checked auto-ticks when a job exists; a site with no job waits at 'To check'", st(by["0037"], "checked").done && st(by["0037"], "checked").source === "auto" && st(by["0037"], "scheduled").todo === "To book" && by["0037"].case.nextTodo === "Test due");
  // Flag with a comment: overlay on any stage, counted, cleared; a fresh row goes To check → tick checked → To book
  const fl = await call(env, "Tanya", "POST", "/concerto/case", { ppmId: "SCH:SR00161:fiveYear", flag: "Store closing Dec — confirm with client" });
  sc = await call(env, "Jamie Line", "GET", "/concerto/schedule?type=fiveYear"); by = Object.fromEntries(sc.body.rows.map(r => [r.storeCode, r]));
  ok("flag: note + who, counted, makes a not-due row active (touched), stage unchanged (To check)", fl.status === 200 && by["0622"].case.flagged && by["0622"].case.flagNote === "Store closing Dec — confirm with client" && by["0622"].case.flaggedBy === "Tanya" && sc.body.stats.pipeline.flagged === 1 && by["0622"].case.active && by["0622"].case.stage === "checked", JSON.stringify({ stage: by["0622"].case.stage, active: by["0622"].case.active }));
  await call(env, "Tanya", "POST", "/concerto/case", { ppmId: "SCH:SR00161:fiveYear", step: "checked", done: true });
  await call(env, "Tanya", "POST", "/concerto/case", { ppmId: "SCH:SR00161:fiveYear", flag: "" });
  sc = await call(env, "Jamie Line", "GET", "/concerto/schedule?type=fiveYear"); by = Object.fromEntries(sc.body.rows.map(r => [r.storeCode, r]));
  ok("checked by hand → stage To book; flag cleared", !by["0622"].case.flagged && by["0622"].case.stage === "scheduled" && by["0622"].case.nextTodo === "To book" && sc.body.stats.pipeline.flagged === 0 && sc.body.stats.pipeline.byStage.scheduled === 1);
  ok("stats: byStage + byEngineer (Connor 1 tested, Daniel 1 scheduled; 0622 now To book after the hand tick)", sc.body.stats.pipeline.byStage.quoted === 1 && sc.body.stats.pipeline.byStage.tested === 1 && sc.body.stats.pipeline.byStage.scheduled === 1 && !sc.body.stats.pipeline.notDue && sc.body.stats.byEngineer.Connor.tested === 1 && sc.body.stats.byEngineer["Daniel Walker"].scheduled === 1, JSON.stringify(sc.body.stats.pipeline.byStage) + JSON.stringify(sc.body.stats.byEngineer));
  ok("stats: byMonth workload + due-soon-not-released", sc.body.stats.byMonth["2026-11"].total === 2 && sc.body.stats.byMonth["2026-11"].released === 1 && sc.body.stats.byMonth["2026-11"].done === 1 && sc.body.stats.byMonth["2026-11"].value === 960 && sc.body.stats.dueSoonNotReleased === 1, JSON.stringify(sc.body.stats.byMonth));
  // Manual ticks: quote sent (dated), then approve — order is free
  const t1 = await call(env, "Tanya", "POST", "/concerto/case", { ppmId: "SCH:SR00364:fiveYear", step: "quoted", done: true, at: "2026-03-10", note: "Quote Q-77 emailed" });
  const t2 = await call(env, "Tanya", "POST", "/concerto/case", { ppmId: "SCH:SR00364:fiveYear", step: "approved", done: true });
  sc = await call(env, "Jamie Line", "GET", "/concerto/schedule?type=fiveYear"); by = Object.fromEntries(sc.body.rows.map(r => [r.storeCode, r]));
  if (process.env.DUMP_SCHEDULE) { const fs = await import("node:fs"); fs.writeFileSync(process.env.DUMP_SCHEDULE, JSON.stringify(sc.body)); }   // fixture for the page smoke test
  ok("manual ticks: quoted (dated 2026-03-10, by Tanya, note kept) + approved; next = works_done; case stored; log has 3 lines", t1.status === 200 && t2.status === 200 && st(by["0305"], "quoted").done && st(by["0305"], "quoted").at === "2026-03-10" && st(by["0305"], "quoted").by === "Tanya" && st(by["0305"], "quoted").note === "Quote Q-77 emailed" && st(by["0305"], "approved").done && by["0305"].case.next === "works_done" && by["0305"].case.stored && by["0305"].case.log.length === 3, JSON.stringify({ next: by["0305"].case.next, log: by["0305"].case.log.map(l => l.text) }));
  // Untick an AUTO step: manual beats automatic; reset returns it to automatic
  await call(env, "Jamie Line", "POST", "/concerto/case", { ppmId: "SCH:SR00364:fiveYear", step: "ordered", done: false });
  sc = await call(env, "Jamie Line", "GET", "/concerto/schedule?type=fiveYear"); by = Object.fromEntries(sc.body.rows.map(r => [r.storeCode, r]));
  ok("manual untick beats the automatic order reading (source manual, next = ordered)", !st(by["0305"], "ordered").done && st(by["0305"], "ordered").source === "manual" && by["0305"].case.next === "ordered");
  await call(env, "Jamie Line", "POST", "/concerto/case", { ppmId: "SCH:SR00364:fiveYear", step: "ordered", reset: true });
  sc = await call(env, "Jamie Line", "GET", "/concerto/schedule?type=fiveYear"); by = Object.fromEntries(sc.body.rows.map(r => [r.storeCode, r]));
  ok("reset → automatic again (ordered ticked from the client order)", st(by["0305"], "ordered").done && st(by["0305"], "ordered").source === "auto");
  // Works job completes + a re-issued cert lands → works_done + cert_updated auto
  db.prepare("UPDATE sla_jobs SET status='Complete', data=? WHERE id='W1'").run(JSON.stringify({ id:"W1", siteCode:"0305", description:"[C2] x", status:"Complete", scheduledAt:"2026-10-01T08:00:00.000Z", statusHistory:[{status:"Complete",at:"2026-10-01T14:00:00Z"}], assignedEngineers:["Ryan Diggens"] }));
  ins("compliance_files", ["tenant_id","scheme","code","type","doc_date","filename","r2_key"], [[1,"coop","0305","fiveYear","2026-10-03","0305 EICR reissue.pdf","k6"]]);
  sc = await call(env, "Jamie Line", "GET", "/concerto/schedule?type=fiveYear"); by = Object.fromEntries(sc.body.rows.map(r => [r.storeCode, r]));
  ok("works job complete → works_done auto; newer cert on file → cert_updated auto; next = uploaded (approved already ticked)", st(by["0305"], "works_done").done && st(by["0305"], "works_done").source === "auto" && st(by["0305"], "cert_updated").done && by["0305"].case.certUpdated && by["0305"].case.certUpdated.date === "2026-10-03" && by["0305"].case.next === "uploaded", JSON.stringify(by["0305"].case.steps.map(s => s.key + ":" + s.done)));
  // Hold + resume, outcome + engineer overrides, close + reopen
  await call(env, "Jamie Line", "POST", "/concerto/case", { ppmId: "SCH:SR00364:fiveYear", hold: "Waiting on Concerto login" });
  sc = await call(env, "Jamie Line", "GET", "/concerto/schedule?type=fiveYear"); by = Object.fromEntries(sc.body.rows.map(r => [r.storeCode, r]));
  ok("hold: stage held with the reason + who", by["0305"].case.held && by["0305"].case.stage === "held" && by["0305"].case.holdReason === "Waiting on Concerto login" && by["0305"].case.heldBy === "Jamie Line" && sc.body.stats.pipeline.held === 1);
  await call(env, "Jamie Line", "POST", "/concerto/case", { ppmId: "SCH:SR00364:fiveYear", hold: "" , engineer: "Connor + apprentice" });
  const badO = await call(env, "Jamie Line", "POST", "/concerto/case", { ppmId: "SCH:SR00364:fiveYear", outcome: "maybe" });
  await call(env, "Jamie Line", "POST", "/concerto/case", { ppmId: "SCH:SR00283:fiveYear", outcome: "satisfactory" });
  sc = await call(env, "Jamie Line", "GET", "/concerto/schedule?type=fiveYear"); by = Object.fromEntries(sc.body.rows.map(r => [r.storeCode, r]));
  ok("resume + engineer override (manual wins); bad outcome refused; 0037 outcome set by hand → only the 6 satisfactory steps apply", !by["0305"].case.held && by["0305"].case.engineer === "Connor + apprentice" && by["0305"].case.engineerSource === "manual" && badO.status === 400 && by["0037"].case.outcome === "satisfactory" && by["0037"].case.outcomeSource === "manual" && by["0037"].case.steps.filter(s => s.applicable).length === 7);
  for (const k of ["uploaded", "invoiced", "rem_closed"]) await call(env, "Jamie Line", "POST", "/concerto/case", { ppmId: "SCH:SR00364:fiveYear", step: k, done: true });
  sc = await call(env, "Jamie Line", "GET", "/concerto/schedule?type=fiveYear"); by = Object.fromEntries(sc.body.rows.map(r => [r.storeCode, r]));
  ok("all steps done → stage complete (close is a deliberate step)", by["0305"].case.allDone && by["0305"].case.stage === "complete" && by["0305"].case.next === null);
  await call(env, "Jamie Line", "POST", "/concerto/case", { ppmId: "SCH:SR00364:fiveYear", close: true });
  sc = await call(env, "Jamie Line", "GET", "/concerto/schedule?type=fiveYear"); by = Object.fromEntries(sc.body.rows.map(r => [r.storeCode, r]));
  ok("closed: stage closed, keeps the closed case for the same cycle (no fresh virtual case)", by["0305"].case.closed && by["0305"].case.stage === "closed" && by["0305"].case.closedBy === "Jamie Line" && by["0305"].case.stored && sc.body.stats.pipeline.closed === 1);
  // Concerto moves the next date on 5 years → the closed case stays closed, a fresh (not-due) cycle starts
  await call(env, "Jamie Line", "POST", "/concerto/import", { layout: "schedule", rows: rows.map(r => r.uprn === "SR00364" ? { ...r, nextDate: "2031-11-30", lastDate: "2026-03-02", orderNr: "" } : r), fileName: "ppm_schedule_6.xlsx" });
  sc = await call(env, "Jamie Line", "GET", "/concerto/schedule?type=fiveYear"); by = Object.fromEntries(sc.body.rows.map(r => [r.storeCode, r]));
  ok("next cycle after the export moves the date: fresh virtual case, not due yet, 2026 test job outside its window", !by["0305"].case.stored && by["0305"].case.stage === "not_due" && !by["0305"].case.testJob, JSON.stringify({ stage: by["0305"].case.stage, cycle: by["0305"].case.cycleDue, stored: by["0305"].case.stored }));
  const rp = await call(env, "Jamie Line", "POST", "/concerto/case", { ppmId: "SCH:SR00364:fiveYear", reopen: true, caseId: "SCH:SR00364:fiveYear@2026-11-30" });
  sc = await call(env, "Jamie Line", "GET", "/concerto/schedule?type=fiveYear"); by = Object.fromEntries(sc.body.rows.map(r => [r.storeCode, r]));
  ok("reopen the old cycle by caseId → it is the open case again (all steps still ticked)", rp.status === 200 && by["0305"].case.stored && by["0305"].case.cycleDue === "2026-11-30" && !by["0305"].case.closed && by["0305"].case.allDone, JSON.stringify({ stage: by["0305"].case.stage, cycle: by["0305"].case.cycleDue }));
  const nf = await call(env, "Jamie Line", "POST", "/concerto/case", { ppmId: "SCH:NOPE:fiveYear", step: "approved", done: true });
  const fld = await call(env, "Nobody", "POST", "/concerto/case", { ppmId: "SCH:SR00364:fiveYear", step: "approved", done: true });
  ok("unknown row 404; non-office 403", nf.status === 404 && fld.status === 403);
}
console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
