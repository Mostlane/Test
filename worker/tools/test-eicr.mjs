// EICR tracker — drives the real eicr.js handler against a REAL SQLite (node:sqlite)
// through a D1-shaped shim: due list from the chart, every test job → a case,
// C3-only → sign-off, C1/C2/FI → quote path, order pickup, works job (photos
// copied), sign-off, separate test/works invoices, manual status that holds,
// Concerto exceptions, permissions.
// Run:  node --no-warnings worker/tools/test-eicr.mjs
import { DatabaseSync } from "node:sqlite";
import * as eicr from "../src/routes/eicr.js";

function d1(db) {
  const wrap = (sql) => { let binds = []; const st = {
    bind(...a) { binds = a.map(v => v === undefined ? null : (typeof v === "boolean" ? (v ? 1 : 0) : v)); return st; },
    async first() { return db.prepare(sql).get(...binds) ?? null; },
    async all() { return { results: db.prepare(sql).all(...binds) }; },
    async run() { const r = db.prepare(sql).run(...binds); return { meta: { changes: r.changes, last_row_id: r.lastInsertRowid } }; },
  }; return st; };
  return { prepare: wrap, async batch(s) { return Promise.all(s.map(x => x.run())); }, async exec(q) { db.exec(q); } };
}
const iso = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
function makeEnv() {
  if (eicr.ensureTables.reset) eicr.ensureTables.reset();
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE user_permissions (tenant_id, username, permission, value);
    CREATE TABLE users (tenant_id, username, profile, status TEXT, email TEXT, first_name TEXT, last_name TEXT);
    CREATE TABLE compliance_stores (tenant_id INTEGER, scheme TEXT, code TEXT, category TEXT, name TEXT, postcode TEXT, due TEXT, active INTEGER DEFAULT 1, meta TEXT, updated_at TEXT, site_number TEXT);
    CREATE TABLE sites (tenant_id INTEGER, client TEXT, site_number TEXT, site_name TEXT, postcode TEXT, active INTEGER, job_number TEXT, data TEXT, updated_at TEXT, archived INTEGER);
    CREATE TABLE sla_jobs (tenant_id, id TEXT PRIMARY KEY, data TEXT, status TEXT, helpdesk_ref TEXT, site_code TEXT, description TEXT, priority TEXT, assigned_to TEXT, raised_at TEXT, target_at TEXT, scheduled_at TEXT, created_at TEXT, updated_at TEXT, closed_at TEXT);
    CREATE TABLE app_config (tenant_id, key TEXT UNIQUE, value);
    CREATE TABLE client_orders (id TEXT PRIMARY KEY, tenant_id TEXT, order_number TEXT, order_value REAL, title TEXT, description TEXT, detail TEXT, store_code TEXT, status TEXT, matched_kind TEXT, matched_job_id TEXT, created_at TEXT, notified_at TEXT);
    CREATE TABLE compliance_files (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER, code TEXT, type TEXT, year TEXT, r2_key TEXT, filename TEXT, size INTEGER, doc_date TEXT, source TEXT, uploaded_at TEXT, label TEXT, pinned INTEGER, scheme TEXT);
    CREATE TABLE concerto_ppm (id TEXT, tenant_id TEXT, ppm_type TEXT, store_code TEXT, site_name TEXT, next_date TEXT, planned_date TEXT, last_date TEXT, order_nr TEXT, status TEXT);
    CREATE TABLE concerto_cases (tenant_id TEXT, id TEXT, ppm_id TEXT, store_code TEXT, closed_at TEXT, stage12 TEXT, note TEXT, quote_ref TEXT, quote_value REAL, quote_at TEXT, works_job_id TEXT);
    CREATE TABLE five_year_remedials (id TEXT, tenant_id TEXT, store_code TEXT, stage TEXT, order_number TEXT, order_value REAL, data TEXT);`);
  const ins = (t, cols, rows) => { const st = db.prepare(`INSERT INTO ${t} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`); for (const r of rows) st.run(...r); };
  ins("user_permissions", ["tenant_id","username","permission","value"], [[1,"Jamie Line","FullAccess",1],[1,"Tanya","Compliance",1],[1,"Field","SLA",1]]);
  ins("users", ["tenant_id","username","profile"], [[1,"Jamie Line",'{"staffType":"office"}'],[1,"Tanya",'{"staffType":"office"}'],[1,"Field",'{"staffType":"field"}'],[1,"Dan",'{"staffType":"field"}']]);
  ins("app_config", ["tenant_id","key","value"], [[1,"sla_categories",'[{"name":"Jamie/Tanya","done":true},{"name":"Compliance Complete","done":true}]']]);
  ins("compliance_stores", ["tenant_id","scheme","code","category","name","due","active"], [
    [1,"coop","0100","Retail","A", `{"fiveYear":"${iso(-10)}"}`,1],   // overdue, not booked
    [1,"coop","0200","Retail","B", `{"fiveYear":"${iso(30)}"}`,1],    // test done, C3 only
    [1,"coop","0300","Retail","C", `{"fiveYear":"${iso(40)}"}`,1],    // test done, C2 → quote path
    [1,"coop","0400","Retail","D", `{"fiveYear":"${iso(900)}"}`,1],   // far off — but Concerto says due
    [1,"coop","0500","Retail","E", `{"fiveYear":"${iso(20)}"}`,1],    // due, not on Concerto
    [1,"coop","0600","Retail","Closed shop", `{"fiveYear":"${iso(5)}"}`,0],
  ]);
  ins("sites", ["tenant_id","client","site_number","site_name","postcode","data"], [[1,"retail","0100","Alpha","PO1 1AA",'{"address1":"1 High St","town":"Fareham"}'],[1,"retail","0300","Charlie","PO3 3CC","{}"]]);
  const job = (id, code, status, extra) => [1, id, JSON.stringify({ id, siteCode: code, siteName: "S" + code, elecTest: true, status, helpdeskRef: code + " test", createdAt: "2026-10-01T09:00:00Z", scheduledAt: "2026-10-02T09:00:00Z", ...extra }), status];
  ins("sla_jobs", ["tenant_id","id","data","status"], [
    job("T200", "0200", "Jamie/Tanya", { remedials: [{ id: "r1", code: "C3", description: "No RCD labels" }] }),
    job("T300", "0300", "Compliance Complete", { remedials: [{ id: "a", code: "C2", description: "Damaged socket", photos: ["jobs/T300/remedial/a/p1.jpg"] }, { id: "b", code: "C3", description: "Labels" }] }),
  ]);
  ins("client_orders", ["id","tenant_id","order_number","order_value","title","store_code","status","matched_kind","created_at"], [
    ["O1","1.0","R31000",450,"Order for 5 year remedials","0300","new","elec","2026-10-20T10:00:00Z"],
    ["O2","1.0","REM0999",50,"EM20 light failed","0300","new","em","2026-10-21T10:00:00Z"],
  ]);
  ins("concerto_ppm", ["id","tenant_id","ppm_type","store_code","next_date","order_nr","status"], [
    ["SCH:1","1","fiveYear","0100",iso(-5),"","open"], ["SCH:2","1","fiveYear","0200",iso(30),"","open"],
    ["SCH:3","1","fiveYear","0300",iso(40),"","open"], ["SCH:4","1","fiveYear","0400",iso(60),"PPM123","open"],
    ["SCH:9","1","fiveYear","0900",iso(60),"","open"],
  ]);
  const r2 = new Map([["jobs/T300/remedial/a/p1.jpg", new Uint8Array([1,2,3])]]);
  const JOB_FILES = { async get(k) { return r2.has(k) ? { arrayBuffer: async () => r2.get(k), body: r2.get(k), httpMetadata: {} } : null; }, async put(k, v) { r2.set(k, v); }, async delete(k) { r2.delete(k); }, async list() { return { objects: [] }; } };
  return { env: { DB: d1(db), JOB_FILES, OWNER_USERNAME: "Jamie Line" }, db, r2 };
}
const sess = (who) => ({ user: { username: who }, tenantId: 1 });
async function call(env, who, method, path, body) {
  const url = new URL("https://api.test" + path);
  const req = new Request(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const res = await eicr.handle(req, env, { waitUntil() {} }, url, sess(who));
  let j = null; try { j = await res.clone().json(); } catch {}
  return { status: res.status, body: j };
}
let fail = 0, pass = 0; const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.log("FAIL  " + name + (extra ? "  → " + extra : "")); } };
const row = (b, code) => b.body.rows.find(r => r.code === code);

// pure helpers
ok("C3 only → c3", eicr.testOutcome({ remedials: [{ code: "C3", description: "x" }] }) === "c3");
ok("C2 → remedials", eicr.testOutcome({ remedials: [{ code: "C2", description: "x" }] }) === "remedials");
ok("uncoded → remedials (safe side)", eicr.testOutcome({ remedials: [{ code: "", description: "x" }] }) === "remedials");
ok("no remedials → c3", eicr.testOutcome({ remedials: [] }) === "c3");
ok("manual status holds while evidence unchanged", eicr.nextStatus({ status: "to_quote", ev_status: "ordered" }, "ordered") === "to_quote");
ok("new evidence moves forward", eicr.nextStatus({ status: "to_quote", ev_status: "to_quote" }, "ordered") === "ordered");
ok("never backwards", eicr.nextStatus({ status: "ordered", ev_status: "x" }, "to_quote") === "ordered");
ok("C3 reading doesn't drag off quote path", eicr.nextStatus({ status: "quoted", ev_status: "x" }, "cert_signoff") === "quoted");
ok("working days skip weekends", eicr.workingDaysSince("2026-11-20T10:00:00Z", "2026-11-25T10:00:00Z") === 3);

{
  const { env, db, r2 } = makeEnv();
  let b = await call(env, "Tanya", "GET", "/eicr/board");
  ok("board 200", b.status === 200, JSON.stringify(b.body).slice(0, 200));
  ok("closed store hidden", !row(b, "0600"));
  ok("sorted by due (overdue first)", b.body.rows[0].code === "0100");
  ok("overdue unbooked = red", row(b, "0100").status === "due" && row(b, "0100").alert === "red");
  ok("Jamie/Tanya C3 test → sign off", row(b, "0200").status === "cert_signoff", row(b, "0200").status);
  ok("test invoice due once tested", row(b, "0200").invoices.test && !row(b, "0200").invoices.test.done);
  ok("C2 test + elec order → order received", row(b, "0300").status === "ordered", row(b, "0300").status);
  ok("order number picked up (EM order ignored)", row(b, "0300").order && row(b, "0300").order.number === "R31000");
  ok("remedial counts", row(b, "0300").remedials.C2 === 1 && row(b, "0300").remedials.C3 === 1);

  // book a test for 0100
  let r = await call(env, "Tanya", "POST", "/eicr/book", { code: "0100", engineers: ["Dan"], scheduledAt: iso(3) + "T08:00:00Z" });
  ok("book test 200", r.status === 200, JSON.stringify(r.body));
  const tj = JSON.parse(db.prepare("SELECT data FROM sla_jobs WHERE id=?").get(r.body.jobId).data);
  ok("test job is an elec test at the site", tj.elecTest && tj.siteCode === "0100" && /EICR/.test(tj.description));
  b = await call(env, "Tanya", "GET", "/eicr/board");
  ok("booked status", row(b, "0100").status === "booked" && row(b, "0100").test.engineers[0] === "Dan");
  r = await call(env, "Tanya", "POST", "/eicr/book", { code: "0100", engineers: ["Dan"] });
  ok("can't double-book", r.status === 409);

  // sign-off is Full Access only
  r = await call(env, "Tanya", "POST", "/eicr/signoff", { code: "0200" });
  ok("office can't sign off", r.status === 403);
  r = await call(env, "Jamie Line", "POST", "/eicr/signoff", { code: "0200" });
  ok("Jamie signs off", r.status === 200);
  b = await call(env, "Tanya", "GET", "/eicr/board");
  ok("signed off → done, test still to invoice", row(b, "0200").status === "done" && !row(b, "0200").invoices.test.done && !row(b, "0200").invoices.works);
  r = await call(env, "Tanya", "POST", "/eicr/invoice", { code: "0200", which: "test", ref: "INV1" });
  ok("invoiced → case closes", r.body.closed === true);
  b = await call(env, "Tanya", "GET", "/eicr/board");
  ok("closed case → store back to due on the chart", row(b, "0200").status === "due" && !row(b, "0200").caseId);

  // works job for 0300: photos copied
  const cid = row(b, "0300").caseId;
  r = await call(env, "Tanya", "POST", "/eicr/create-works", { caseId: cid, itemIds: ["a"], engineers: ["Dan"], scheduledAt: iso(5) + "T08:00:00Z" });
  ok("create works 200", r.status === 200, JSON.stringify(r.body));
  const wj = JSON.parse(db.prepare("SELECT data FROM sla_jobs WHERE id=?").get(r.body.jobId).data);
  ok("works job has the C2 item only + its photo copied", wj.auditItems.length === 1 && wj.auditItems[0].refPhotos.length === 1 && r2.has(wj.auditItems[0].refPhotos[0]));
  b = await call(env, "Tanya", "GET", "/eicr/board");
  ok("works booked", row(b, "0300").status === "works_booked");
  // engineer finishes works
  wj.status = "Complete"; db.prepare("UPDATE sla_jobs SET data=?, status='Complete' WHERE id=?").run(JSON.stringify(wj), wj.id);
  b = await call(env, "Tanya", "GET", "/eicr/board");
  ok("works complete → update the certificate", row(b, "0300").status === "cert_update");
  r = await call(env, "Jamie Line", "POST", "/eicr/signoff", { caseId: cid });
  b = await call(env, "Tanya", "GET", "/eicr/board");
  const x = row(b, "0300");
  ok("updated cert signed → done, both invoices due", x.status === "done" && x.invoices.test && x.invoices.works);
  await call(env, "Tanya", "POST", "/eicr/invoice", { caseId: cid, which: "test" });
  b = await call(env, "Tanya", "GET", "/eicr/board");
  ok("one invoice isn't enough to close", row(b, "0300").caseId === cid);
  r = await call(env, "Tanya", "POST", "/eicr/invoice", { caseId: cid, which: "works" });
  ok("both invoiced → closed", r.body.closed === true);

  // manual status + order number by hand
  r = await call(env, "Tanya", "POST", "/eicr/status", { code: "0500", status: "quoted" });
  r = await call(env, "Tanya", "POST", "/eicr/update", { code: "0500", orderNumber: "R40000" });
  b = await call(env, "Tanya", "GET", "/eicr/board");
  ok("manual order number moves quoted → order received", row(b, "0500").status === "ordered" && row(b, "0500").order.number === "R40000", row(b, "0500").status);
  r = await call(env, "Tanya", "POST", "/eicr/status", { code: "0500", status: "to_quote" });
  b = await call(env, "Tanya", "GET", "/eicr/board");
  ok("manual step back holds", row(b, "0500").status === "to_quote");

  // Concerto exceptions
  const e = await call(env, "Tanya", "GET", "/eicr/exceptions");
  const codes = (k) => e.body[k].map(z => z.code);
  ok("due on portal, not Concerto", codes("dueOnPortalNotConcerto").includes("0500") && !codes("dueOnPortalNotConcerto").includes("0100"));
  ok("due on Concerto, not portal", codes("dueOnConcertoNotPortal").includes("0400"));
  ok("Concerto store not on chart", codes("notOnChart").includes("0900"));

  // permissions
  r = await call(env, "Field", "GET", "/eicr/board");
  ok("field user refused", r.status === 403);
}
{
  // migration from the old registers
  const { env, db } = makeEnv();
  db.prepare("INSERT INTO concerto_cases (tenant_id,id,ppm_id,store_code,stage12,note) VALUES ('1.0','c1','SCH:4','0400','remedials_quoted','old note')").run();
  db.prepare("INSERT INTO five_year_remedials (id,tenant_id,store_code,stage,order_number,order_value) VALUES ('SR1','1.0','0500','ordered','R5555',300)").run();
  const r = await call(env, "Jamie Line", "POST", "/eicr/migrate", {});
  ok("migrate 200", r.status === 200 && r.body.fromSchedule === 1 && r.body.fromRegister === 1, JSON.stringify(r.body));
  const b = await call(env, "Tanya", "GET", "/eicr/board");
  ok("old schedule status carried", row(b, "0400").status === "quoted" && /old note/.test(row(b, "0400").note));
  ok("old register order carried + flagged to check", row(b, "0500").status === "ordered" && row(b, "0500").order.number === "R5555" && /check/.test(row(b, "0500").flag));
  const r2 = await call(env, "Jamie Line", "POST", "/eicr/migrate", {});
  ok("migration runs once", r2.body.skipped === true);
}
{
  // test job re-opened and used for the remedials (Forton Road)
  const dc = new Set(["jamie/tanya"]);
  const j = { status: "Jamie/Tanya", helpdeskRef: "R32814, 0127 Gosport", statusHistory: [
    { status: "Scheduled", at: "2026-10-29T08:30:00Z" }, { status: "Complete", at: "2026-10-29T13:40:00Z" },
    { status: "Pending", at: "2026-11-09T11:46:00Z" }, { status: "Scheduled", at: "2026-11-12T16:26:00Z" },
    { status: "Complete", at: "2026-11-13T12:56:00Z" }, { status: "Jamie/Tanya", at: "2026-11-13T13:04:00Z" }] };
  ok("reused test job detected", (eicr.testReusedForWorks(j, dc)||{}).at === "2026-11-13T12:56:00Z");
  ok("test date = first completion", eicr.testDoneAt(j, dc) === "2026-10-29T13:40:00Z");
  ok("plain test not reused", eicr.testReusedForWorks({ status: "Complete", statusHistory: [{ status: "In Progress" }, { status: "Complete" }] }, dc) === null);
  ok("re-completed weeks later by another engineer (no reopen)", (eicr.testReusedForWorks({ status: "Jamie/Tanya", statusHistory: [{ status: "Complete", at: "2026-10-14T10:00:00Z", by: "Daniel" }, { status: "Compliance Complete", at: "2026-10-21T10:00:00Z" }, { status: "Complete", at: "2026-11-17T10:00:00Z", by: "Lionel" }] }, dc)||{}).by === "Lionel");
  ok("quick re-complete (paperwork) not counted", eicr.testReusedForWorks({ status: "Complete", statusHistory: [{ status: "Complete", at: "2026-11-13T10:00:00Z" }, { status: "Scheduled", at: "2026-11-13T11:00:00Z" }, { status: "Complete", at: "2026-11-15T10:00:00Z" }] }, dc) === null);
  ok("re-opened but not finished again", eicr.testReusedForWorks({ status: "Scheduled", statusHistory: [{ status: "Complete" }, { status: "Scheduled" }] }, dc) === null);
  const d = eicr.deriveStatus({ test_job_id: "t", works_job_id: "w", outcome: "remedials", order_number: "R32814" },
    { jobs: new Map([["t", j], ["w", { status: "Pending" }]]), doneCats: dc });
  ok("reused test job → certificate to update", d.status === "cert_update", d.status);
  const f = eicr.certFiledForCycle;
  const cs = { cycle_due: "2026-11-14", created_at: "2026-11-25T11:32:48Z" };
  ok("no test job: cert dated this cycle counts", f({ uploadedAt: "2026-11-25T13:11:31Z", docDate: "2026-08-25" }, "", cs) === true);
  ok("no test job: old cert (2021) uploaded before case does not", f({ uploadedAt: "2026-08-14T07:40:58Z", docDate: "2021-11-14" }, "", cs) === false);
  ok("no test job: undated cert uploaded after case opened counts", f({ uploadedAt: "2026-11-25T13:10:15Z", docDate: "" }, "", cs) === true);
  ok("test job: upload before test does not count", f({ uploadedAt: "2026-10-01T09:00:00Z", docDate: "2026-11-01" }, "2026-11-01", cs) === false);
}
{
  // remedial works job raised by hand ("REM0196 Bournemouth, Belle Vue Road")
  const F = eicr.findManualWorksJob;
  const test = { id: "t", elecTest: true, siteCode: "171", createdAt: "2026-09-14T14:18:47Z" };
  const rem = { id: "w", siteCode: "171", helpdeskRef: "REM0196 Bournemouth, Belle Vue Road", status: "Closed Jobs", createdAt: "2026-10-02T14:21:16Z", description: "C2 — No main bonding" };
  const other = { id: "x", siteCode: "171", helpdeskRef: "30445-Bournemouth, Belle Vue Road", status: "Closed Jobs", createdAt: "2026-09-24T09:40:01Z", description: "water heater" };
  const c = { store_code: "0171", order_number: "REM0196" };
  ok("REM job found", (F(c, test, [test, other, rem], new Set()) || {}).id === "w");
  ok("REM ref found even when the case order is a Concerto number", (F({ store_code: "0171", order_number: "00033692/3" }, test, [test, rem], new Set()) || {}).id === "w");
  ok("order number in the ref found", (F({ store_code: "0171", order_number: "R27797" }, test, [{ ...other, id: "y", helpdeskRef: "R27797 Bournemouth", createdAt: "2026-10-05" }], new Set()) || {}).id === "y");
  ok("other store ignored", F(c, test, [{ ...rem, siteCode: "172" }], new Set()) === null);
  ok("made before the test ignored", F(c, test, [{ ...rem, createdAt: "2026-09-01" }], new Set()) === null);
  ok("EM remedial ignored", F(c, test, [{ ...rem, description: "12x light failures; 2, 6" }], new Set()) === null);
  ok("already used ignored", F(c, test, [rem], new Set(["w"])) === null);
  ok("ordinary reactive job ignored", F(c, test, [other], new Set()) === null);
  const d = eicr.deriveStatus({ test_job_id: "t", works_job_id: "w", outcome: "remedials", order_number: "REM0196" },
    { jobs: new Map([["t", { ...test, status: "Complete" }], ["w", rem]]), doneCats: new Set() });
  ok("finished REM job → certificate to update", d.status === "cert_update", d.status);
}
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
