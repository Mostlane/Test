// FBC (Fareham Borough Council) job tracker — drives routes/fbc.js against a REAL
// SQLite (node:sqlite) through a tiny D1-shaped shim: recordFbcJob writes the
// marker without clobbering office edits, appendFbcMessage dedupes by message-id,
// /fbc/list groups + derives invoiceState (incl. manually-raised FBC-site jobs),
// /fbc/meta updates cost/invoice fields, /fbc/message logs a note, and access is
// gated to office roles.
// Run:  node --no-warnings worker/tools/test-fbc.mjs
import { DatabaseSync } from "node:sqlite";
import * as fbc from "../src/routes/fbc.js";

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
  if (fbc.ensureTables && fbc.ensureTables.reset) fbc.ensureTables.reset();  // re-run the once-per-isolate migration for this fresh DB
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE user_permissions (tenant_id, username, permission, value);
    CREATE TABLE users (tenant_id, username, profile);
    CREATE TABLE sites (tenant_id INTEGER, client TEXT, site_number TEXT, site_name TEXT, postcode TEXT, active INTEGER);
    CREATE TABLE sla_jobs (tenant_id, id TEXT, data TEXT, status TEXT, helpdesk_ref TEXT, site_code TEXT, priority TEXT, assigned_to TEXT, scheduled_at TEXT, created_at TEXT, description TEXT);`);
  const ins = (t, cols, rows) => { const st = db.prepare(`INSERT INTO ${t} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`); for (const r of rows) st.run(...r); };
  ins("user_permissions", ["tenant_id","username","permission","value"], [[1,"Jamie Line","FullAccess","Yes"],[1,"Tanya","Compliance","Yes"],[1,"Nobody","SLA","Yes"]]);
  ins("users", ["tenant_id","username","profile"], [[1,"Jamie Line",'{"staffType":"office"}'],[1,"Tanya",'{"staffType":"office"}'],[1,"Nobody",'{"staffType":"field"}']]);
  // FBC sites (client='fbc') — plus one non-FBC site to prove scoping.
  ins("sites", ["tenant_id","client","site_number","site_name"], [
    [1,"fbc","3008","Control Tower"],
    [1,"fbc","3009","Ferneham Hall"],
    [1,"retail","0032","Fareham, Gudge Heath Lane"]]);
  // Two live jobs at FBC sites; one at a non-FBC site (must NOT surface).
  ins("sla_jobs", ["tenant_id","id","data","status","helpdesk_ref","site_code","priority","created_at","description"], [
    [1,"JOB-A",'{"siteName":"Control Tower"}',"Scheduled","FBC-aaa","3008","Priority 3","2026-09-20T09:00:00Z","Light out in the corridor"],
    [1,"JOB-B",'{"siteName":"Ferneham Hall"}',"Complete","FBC-bbb","3009","Priority 2","2026-09-10T09:00:00Z","Broken door closer"],
    [1,"JOB-MANUAL",'{"siteName":"Control Tower"}',"Pending","FBC-manual","3008","Priority 4","2026-09-25T09:00:00Z","Raised by hand at an FBC site"],
    [1,"JOB-RETAIL",'{"siteName":"Gudge Heath"}',"Pending","0032-1","0032","Priority 1","2026-09-26T09:00:00Z","Not FBC"]]);
  return { env: { DB: d1(db) }, db };
}

const sessFor = (who) => ({ user: { username: who, tenant_id: 1 }, tenantId: 1, session: { token: "T" } });
async function call(env, who, method, path, body) {
  const url = new URL("https://api.test" + path);
  const req = new Request(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const res = await fbc.handle(req, env, { waitUntil() {} }, url, sessFor(who));
  let j = null; try { j = await res.clone().json(); } catch {}
  return { status: res.status, body: j };
}

let fail = 0; const ok = (name, cond, extra = "") => { console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra ? "  → " + extra : "")); if (!cond) fail++; };
const rowBy = (rows, id) => (rows || []).find(r => r.jobId === id);

async function main() {
  // ── access gating ──────────────────────────────────────────────────────────
  {
    const { env } = makeEnv();
    const r = await call(env, "Nobody", "GET", "/fbc/list");
    ok("field/SLA-only user is refused (403)", r.status === 403, "status=" + r.status);
    const r2 = await call(env, "Tanya", "GET", "/fbc/list");
    ok("Compliance user allowed", r2.status === 200, "status=" + r2.status);
  }

  // ── recordFbcJob writes the marker; list surfaces it + intake fields ────────
  {
    const { env } = makeEnv();
    await fbc.recordFbcJob(env, 1, "JOB-A", { reference: "FBC-aaa", siteCode: "3008", siteName: "Control Tower", reportedBy: "A Officer", jobTitle: "Corridor light", w3w: "///one.two.three", quoteRequired: true });
    await fbc.recordFbcJob(env, 1, "JOB-B", { reference: "FBC-bbb", siteCode: "3009", siteName: "Ferneham Hall", quoteRequired: false });
    const { body } = await call(env, "Jamie Line", "GET", "/fbc/list");
    const a = rowBy(body.rows, "JOB-A"), b = rowBy(body.rows, "JOB-B");
    ok("recorded job A surfaces", !!a, JSON.stringify(a && a.reference));
    ok("A carries intake fields", a && a.reportedBy === "A Officer" && a.jobTitle === "Corridor light" && a.w3w === "///one.two.three");
    ok("A quoteRequired true", a && a.quoteRequired === true);
    ok("B quoteRequired false", b && b.quoteRequired === false);
    ok("A joins live job (status/priority/onBoard)", a && a.status === "Scheduled" && a.priority === "Priority 3" && a.onBoard === true);
    ok("A invoiceState open (not finished)", a && a.invoiceState === "open", a && a.invoiceState);
    ok("B invoiceState to_invoice (Complete, not invoiced)", b && b.invoiceState === "to_invoice", b && b.invoiceState);
  }

  // ── manually-raised FBC-site job surfaces with no meta; retail job does not ──
  {
    const { env } = makeEnv();
    await fbc.recordFbcJob(env, 1, "JOB-A", { reference: "FBC-aaa", siteCode: "3008", siteName: "Control Tower" });
    const { body } = await call(env, "Jamie Line", "GET", "/fbc/list");
    const man = rowBy(body.rows, "JOB-MANUAL");
    ok("manual FBC-site job surfaces without a meta row", !!man, man && man.source);
    ok("manual job source=manual", man && man.source === "manual");
    ok("retail (non-FBC) job never surfaces", !rowBy(body.rows, "JOB-RETAIL"));
  }

  // ── appendFbcMessage dedupes by message-id ──────────────────────────────────
  {
    const { env } = makeEnv();
    await fbc.recordFbcJob(env, 1, "JOB-A", { reference: "FBC-aaa", siteCode: "3008" });
    await fbc.appendFbcMessage(env, 1, "JOB-A", { direction: "in", from: "a@fareham.gov.uk", subject: "Incident", body: "New job", messageId: "MID-1" });
    await fbc.appendFbcMessage(env, 1, "JOB-A", { direction: "in", from: "a@fareham.gov.uk", subject: "Incident", body: "New job (redelivered)", messageId: "MID-1" });
    await fbc.appendFbcMessage(env, 1, "JOB-A", { direction: "in", from: "a@fareham.gov.uk", subject: "Follow up", body: "Any update?", messageId: "MID-2" });
    const { body } = await call(env, "Jamie Line", "GET", "/fbc/job?id=JOB-A");
    ok("job endpoint returns the job", body.job && body.job.jobId === "JOB-A");
    ok("two distinct messages (MID-1 deduped)", body.messages.length === 2, "n=" + body.messages.length);
    ok("first stored body kept (INSERT OR IGNORE)", body.messages.some(m => m.body === "New job") && !body.messages.some(m => m.body.includes("redelivered")));
    const list = await call(env, "Jamie Line", "GET", "/fbc/list");
    ok("list shows messageCount", rowBy(list.body.rows, "JOB-A").messageCount === 2);
  }

  // ── /fbc/meta updates cost/invoice WITHOUT clobbering intake fields ──────────
  {
    const { env } = makeEnv();
    await fbc.recordFbcJob(env, 1, "JOB-B", { reference: "FBC-bbb", siteCode: "3009", siteName: "Ferneham Hall", reportedBy: "S Officer", quoteRequired: true });
    let r = await call(env, "Jamie Line", "POST", "/fbc/meta", { jobId: "JOB-B", cost: 425.5, poNumber: "PO-77", quoteStatus: "sent", quoteAmount: 500 });
    ok("meta POST ok", r.status === 200 && r.body.ok);
    // intake re-delivery must NOT wipe the cost/PO/quote just entered
    await fbc.recordFbcJob(env, 1, "JOB-B", { reference: "FBC-bbb", siteCode: "3009", siteName: "Ferneham Hall", reportedBy: "S Officer", quoteRequired: true });
    let { body } = await call(env, "Jamie Line", "GET", "/fbc/job?id=JOB-B");
    ok("cost persisted", body.job.cost === 425.5, String(body.job.cost));
    ok("PO persisted", body.job.poNumber === "PO-77");
    ok("quoteStatus persisted", body.job.quoteStatus === "sent");
    ok("quoteAmount persisted", body.job.quoteAmount === 500);
    ok("intake reportedBy still present after re-delivery", body.job.reportedBy === "S Officer");

    // marking invoiced stamps month + invoiced_at + invoiceState
    r = await call(env, "Jamie Line", "POST", "/fbc/meta", { jobId: "JOB-B", invoiceStatus: "invoiced" });
    ok("invoice POST ok", r.status === 200);
    ({ body } = await call(env, "Jamie Line", "GET", "/fbc/job?id=JOB-B"));
    ok("invoiceState invoiced", body.job.invoiceState === "invoiced", body.job.invoiceState);
    ok("invoiceMonth auto-stamped", /^\d{4}-\d{2}$/.test(body.job.invoiceMonth), body.job.invoiceMonth);
    ok("invoicedAt stamped", !!body.job.invoicedAt);
    const list = await call(env, "Jamie Line", "GET", "/fbc/list");
    ok("list months includes the invoice month", list.body.months.includes(body.job.invoiceMonth));

    // explicit invoiceMonth wins
    r = await call(env, "Jamie Line", "POST", "/fbc/meta", { jobId: "JOB-B", invoiceMonth: "2026-08" });
    ({ body } = await call(env, "Jamie Line", "GET", "/fbc/job?id=JOB-B"));
    ok("explicit invoiceMonth stored", body.job.invoiceMonth === "2026-08", body.job.invoiceMonth);

    // not_required drops it out of to_invoice
    await fbc.recordFbcJob(env, 1, "JOB-A", { reference: "FBC-aaa", siteCode: "3008" });
    await call(env, "Jamie Line", "POST", "/fbc/meta", { jobId: "JOB-A", invoiceStatus: "not_required" });
    ({ body } = await call(env, "Jamie Line", "GET", "/fbc/job?id=JOB-A"));
    ok("not_required invoiceState", body.job.invoiceState === "not_required", body.job.invoiceState);
  }

  // ── /fbc/meta on a job with no prior meta creates a bare row ─────────────────
  {
    const { env } = makeEnv();
    const r = await call(env, "Jamie Line", "POST", "/fbc/meta", { jobId: "JOB-MANUAL", cost: 99 });
    ok("meta on manual job ok", r.status === 200 && r.body.ok);
    const { body } = await call(env, "Jamie Line", "GET", "/fbc/job?id=JOB-MANUAL");
    ok("manual job cost stored", body.job.cost === 99);
    ok("manual job still joins live job", body.job.status === "Pending" && body.job.onBoard === true);
  }

  // ── /fbc/message adds a note ────────────────────────────────────────────────
  {
    const { env } = makeEnv();
    await fbc.recordFbcJob(env, 1, "JOB-A", { reference: "FBC-aaa", siteCode: "3008" });
    let r = await call(env, "Jamie Line", "POST", "/fbc/message", { jobId: "JOB-A", body: "Called the officer, awaiting access" });
    ok("message POST ok", r.status === 200 && r.body.ok);
    r = await call(env, "Jamie Line", "POST", "/fbc/message", { jobId: "JOB-A", body: "" });
    ok("empty message rejected", r.status === 400);
    const { body } = await call(env, "Jamie Line", "GET", "/fbc/job?id=JOB-A");
    ok("note appears in the log", body.messages.some(m => m.direction === "note" && m.body.includes("awaiting access")));
  }

  // ── tracking-only record (no SLA job): description + raised_at + to_invoice ──
  {
    const { env } = makeEnv();
    // A back-filled historical incident: a meta row whose job_id has no sla_jobs row.
    await fbc.recordFbcJob(env, 1, "FBC-hist1", {
      reference: "FBC-hist1", siteCode: "3009", siteName: "Ferneham Hall",
      reportedBy: "Historic Officer", jobTitle: "Old incident",
      description: "Emergency light in stairwell not working — reported April 2026.",
      raisedAt: "2026-04-15T10:00:00.000Z", source: "backfill",
    });
    const { body } = await call(env, "Jamie Line", "GET", "/fbc/list");
    const h = rowBy(body.rows, "FBC-hist1");
    ok("tracking-only record surfaces", !!h);
    ok("description surfaced from meta (no job)", h && h.description.startsWith("Emergency light"), h && h.description);
    ok("raisedAt from meta.raised_at", h && h.raisedAt === "2026-04-15T10:00:00.000Z", h && h.raisedAt);
    ok("onBoard false (no SLA job)", h && h.onBoard === false);
    ok("meta-only defaults to to_invoice", h && h.invoiceState === "to_invoice", h && h.invoiceState);
    ok("row title falls back to reference", h && h.reference === "FBC-hist1");
    // office can still mark it invoiced / not required
    await call(env, "Jamie Line", "POST", "/fbc/meta", { jobId: "FBC-hist1", invoiceStatus: "not_required" });
    const { body: b2 } = await call(env, "Jamie Line", "GET", "/fbc/job?id=FBC-hist1");
    ok("tracking record can be marked not_required", b2.job.invoiceState === "not_required", b2.job.invoiceState);
    // description editable via /meta
    await call(env, "Jamie Line", "POST", "/fbc/meta", { jobId: "FBC-hist1", description: "Edited detail" });
    const { body: b3 } = await call(env, "Jamie Line", "GET", "/fbc/job?id=FBC-hist1");
    ok("description editable via /meta", b3.job.description === "Edited detail", b3.job.description);
  }

  // ── unknown job → 404 ───────────────────────────────────────────────────────
  {
    const { env } = makeEnv();
    const r = await call(env, "Jamie Line", "GET", "/fbc/job?id=NOPE");
    ok("unknown job 404", r.status === 404);
  }

  console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
  process.exit(fail ? 1 : 0);
}
main();
