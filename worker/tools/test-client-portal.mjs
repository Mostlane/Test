// Client portal (FBC) — CURRENT jobs only, office "done" categories honoured,
// office-only instructions stripped, raising off unless switched on, walled to
// the client's own org. Drives the real client.js against a real SQLite.
// Run:  node --no-warnings worker/tools/test-client-portal.mjs
import { DatabaseSync } from "node:sqlite";
import * as client from "../src/routes/client.js";
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
const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE sites (tenant_id INTEGER, client TEXT, site_number TEXT, site_name TEXT, postcode TEXT, active INTEGER, data TEXT);
  CREATE TABLE sla_jobs (tenant_id, id TEXT, data TEXT, status TEXT, helpdesk_ref TEXT, site_code TEXT);
  CREATE TABLE app_config (tenant_id, key TEXT, value TEXT);`);
const ins = (t, cols, rows) => { const st = db.prepare(`INSERT INTO ${t} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`); for (const r of rows) st.run(...r); };
ins("sites", ["tenant_id","client","site_number","site_name"], [[1,"fbc","3006","Broadcut Depot"],[1,"fbc","3010","Civic Offices"],[1,"retail","0125","Lee-on-Solent"]]);
ins("app_config", ["tenant_id","key","value"], [[1,"sla_categories",JSON.stringify([{name:"FBC Works Completed",done:true},{name:"Co-op Pending",done:false}])]]);
const job = (id, o) => [1, id, JSON.stringify({ id, ...o }), o.status, o.helpdeskRef || id, o.siteCode];
ins("sla_jobs", ["tenant_id","id","data","status","helpdesk_ref","site_code"], [
  job("A", { siteCode:"3006", siteName:"Broadcut Depot", status:"Scheduled", scheduledAt:"2026-10-21T08:00:00Z", description:"Replace light fitting\n🚨 **Please change status to 'TO QUOTE'**🚨" }),
  job("B", { siteCode:"3010", siteName:"Civic Offices", status:"FBC Works Completed", description:"done (custom category)" }),
  job("C", { siteCode:"3010", siteName:"Civic Offices", status:"Complete", description:"done" }),
  job("D", { siteCode:"3010", siteName:"Civic Offices", status:"In Progress", description:"Extend cable" }),
  job("E", { siteCode:"0125", siteName:"Lee-on-Solent", status:"Pending", description:"Co-op job — not FBC's" }),
  job("F", { siteCode:"3006", siteName:"Broadcut Depot", status:"Cancelled", description:"cancelled" }),
]);
const env = { DB: d1(db), JOB_FILES: { async list() { return { objects: [] }; } } };
const sess = (prof) => ({ user: { username: "Sarah", first_name: "Sarah", profile: JSON.stringify({ staffType: "client", clientOrg: "fbc", ...prof }) }, tenantId: 1 });
async function call(s, method, path, body) {
  const url = new URL("https://api.test" + path);
  const req = new Request(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const res = await client.handle(req, env, { waitUntil() {} }, url, s);
  let j = null; try { j = await res.clone().json(); } catch {}
  return { status: res.status, body: j };
}
let fail = 0; const ok = (n, c, x = "") => { console.log((c ? "PASS" : "FAIL") + "  " + n + (x ? "  → " + x : "")); if (!c) fail++; };

const jobsUser = sess({ clientRole: "jobs" });
const r = await call(jobsUser, "GET", "/client/jobs");
const ids = (r.body && r.body.jobs || []).map(j => j.id).sort();
ok("current jobs only — complete, custom-done and cancelled jobs drop off", JSON.stringify(ids) === '["A","D"]', JSON.stringify(ids));
ok("never another client's site", !ids.includes("E"));
const a = r.body.jobs.find(j => j.id === "A");
ok("office-only instruction stripped from the description", a && a.description === "Replace light fitting", a && a.description);
ok("booked job reads 'Booked 21 Oct'", a && a.status === "Booked 21 Oct", a && a.status);
ok("in-progress job reads 'In progress'", r.body.jobs.find(j => j.id === "D").status === "In progress");
ok("a finished job can't be opened by id", (await call(jobsUser, "GET", "/client/job?id=B")).status === 404);
ok("a live job can be opened", (await call(jobsUser, "GET", "/client/job?id=D")).status === 200);
const me = await call(jobsUser, "GET", "/client/me");
ok("/client/me says raising is off by default", me.body && me.body.canRaise === false && me.body.role === "jobs");
ok("raising refused unless switched on", (await call(jobsUser, "POST", "/client/raise", { siteCode: "3006", description: "test fault" })).status === 403);
ok("compliance-only login can't read jobs", (await call(sess({ clientRole: "compliance" }), "GET", "/client/jobs")).status === 403);
// Office updates for the client: only client-visible ones reach the portal.
await fbc.appendFbcMessage(env, 1, "D", { direction: "in", from: "noreply@jotform.com", subject: "Incident", body: "internal incident email", at: "2026-10-15T09:00:00Z" });
await fbc.appendFbcMessage(env, 1, "D", { direction: "note", from: "Jamie Line", body: "internal: chase supplier", at: "2026-10-16T09:00:00Z" });
await fbc.appendFbcMessage(env, 1, "D", { direction: "client", from: "Tanya Smith", body: "Parts ordered, fitting Tuesday", at: "2026-10-17T10:00:00Z", clientVisible: true });
await fbc.appendFbcMessage(env, 1, "E", { direction: "client", from: "Tanya Smith", body: "Co-op update", at: "2026-10-17T11:00:00Z", clientVisible: true });
const r2 = await call(jobsUser, "GET", "/client/jobs");
const d2 = r2.body.jobs.find(j => j.id === "D");
ok("latest client update rides on the job card", d2.latestUpdate && d2.latestUpdate.body === "Parts ordered, fitting Tuesday" && d2.updateCount === 1, JSON.stringify(d2.latestUpdate));
ok("poster shown by first name only", d2.latestUpdate.by === "Tanya");
ok("job with a fresh update sorts first", r2.body.jobs[0].id === "D");
ok("a job with no updates carries none", r2.body.jobs.find(j => j.id === "A").latestUpdate === null);
const one = await call(jobsUser, "GET", "/client/job?id=D");
const bodies = (one.body.job.updates || []).map(u => u.body);
ok("job detail lists ONLY client-visible updates (no internal note / email)", JSON.stringify(bodies) === '["Parts ordered, fitting Tuesday"]', JSON.stringify(bodies));
console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
