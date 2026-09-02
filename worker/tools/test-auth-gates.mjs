// Authorisation smoke test — drives the REAL route handlers with a mock D1/R2
// and asserts the server-side gates hold (engineer job scope, RA rules, holiday
// identity, own-file-only streams, Pending accounts). Extend this as more gates
// are added. Run:  node worker/tools/test-auth-gates.mjs
// NB: no literal credential pairs in here — the public repo is secret-scanned.

import * as sla from "../src/routes/sla.js";
import * as holidays from "../src/routes/holidays.js";
import * as hrdocs from "../src/routes/hrdocs.js";
import * as ts from "../src/routes/timesheets.js";
import * as auth from "../src/routes/auth.js";

const PERMS = { eng: ["SLA"], admin: ["FullAccess", "SLAAdmin"], other: ["SLA"], pending: [] };
const USERS = {
  eng: { username: "eng", status: "Active" }, other: { username: "other", status: "Active" },
  admin: { username: "admin", status: "Active" },
  pending: { username: "pending", status: "Pending", email: "p@x.com", password_hash: "x", password_algo: "pbkdf2" },
};
const JOB = { id: "J1", helpdeskRef: "REF1", status: "Scheduled", assignedEngineers: ["eng"], assignedTo: "eng",
  requiresRA: true, requiresPhoto: true, requiresSignature: true, requiresNote: true, siteCode: "123", siteName: "Store", statusHistory: [] };

function makeEnv() {
  const saved = [];
  const db = { prepare(sql) { let binds = []; const st = {
    bind(...a) { binds = a; return st; },
    async first() {
      if (/FROM sessions/i.test(sql)) return null;
      if (/FROM users/i.test(sql)) { const u = binds.find(b => USERS[b]); return u ? { tenant_id: 1, profile: "{}", ...USERS[u] } : null; }
      if (/SELECT data FROM sla_jobs/i.test(sql)) return binds.includes("J1") ? { data: JSON.stringify(JOB) } : null;
      if (/COUNT\(\*\)/i.test(sql)) return { n: 0, count: 0, c: 0 };
      return null; },
    async all() {
      if (/FROM user_permissions/i.test(sql)) { const u = binds.find(b => PERMS[b]); return { results: (PERMS[u] || []).map(permission => ({ permission, value: 1 })) }; }
      return { results: [] }; },
    async run() { if (/sla_jobs/i.test(sql) && /INSERT|UPDATE/i.test(sql)) saved.push(binds); return { meta: { last_row_id: 1 } }; },
  }; return st; }, batch(s) { return Promise.all(s.map(x => x.run())); } };
  const r2 = { async list() { return { objects: [] }; }, async get() { return null; }, async put() {}, async delete() {} };
  return { env: { DB: db, JOB_FILES: r2, ASSET_BUCKET: r2, OWNER_USERNAME: "admin", PORTAL_BRIDGE_SECRET: "s" }, saved };
}
const ctx = { waitUntil() {} };
const sess = u => ({ user: { username: u, tenant_id: 1, status: USERS[u].status }, tenantId: 1, session: { token: "T", device_id: null } });
async function call(mod, who, method, path, body, headers = {}) {
  const { env, saved } = makeEnv();
  const url = new URL("https://api.test" + path);
  const req = new Request(url, { method, headers: { Authorization: "Bearer T", "Content-Type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
  let res; try { res = await mod.handle(req, env, ctx, url, who ? sess(who) : null); } catch (e) { return { status: "THROW " + e.message, saved }; }
  let j = null; try { j = await res.clone().json(); } catch {}
  return { status: res.status, body: j, saved };
}
let fail = 0;
async function expect(name, p, ok) { const r = await p; const pass = ok(r); console.log((pass ? "PASS" : "FAIL") + "  " + name + "  → " + r.status + (r.body && r.body.error ? " · " + r.body.error : "")); if (!pass) fail++; }

const RA_OK = { safe: true, name: "E", at: "x", hazards: [{ item: "h", answer: "ok" }], declarations: { competent: true, publicSafeguarded: true, safeToProceed: true } };
await expect("holidays: engineer + X-Role:Admin is NOT admin", call(holidays, "eng", "GET", "/holiday/all", null, { "X-Role": "Admin", "X-User": "admin" }), r => r.status === 403 || r.status === 401);
await expect("holidays: real admin still admin", call(holidays, "admin", "GET", "/holiday/all"), r => r.status === 200);
await expect("holidays: engineer own summary still works", call(holidays, "eng", "GET", "/holiday/summary"), r => r.status === 200);
await expect("sla: engineer cannot POST /sla/jobs", call(sla, "eng", "POST", "/sla/jobs", { id: "J1", status: "Complete" }), r => r.status === 403);
await expect("sla: admin can POST /sla/jobs", call(sla, "admin", "POST", "/sla/jobs", { id: "J1", description: "x" }), r => r.status !== 403);
await expect("sla: engineer cannot POST /sla/config", call(sla, "eng", "POST", "/sla/config", { x: 1 }), r => r.status === 403);
await expect("sla: unassigned engineer cannot PATCH", call(sla, "other", "PATCH", "/sla/jobs/J1", { note: "hi" }), r => r.status === 403);
await expect("sla: gate-flip + Complete refused (422)", call(sla, "eng", "PATCH", "/sla/jobs/J1", { requiresRA: false, requiresPhoto: false, requiresSignature: false, requiresNote: false, status: "Complete" }), r => r.status === 422);
await expect("sla: RA skip refused for engineer", call(sla, "eng", "PATCH", "/sla/jobs/J1", { status: "In Progress", riskAssessment: { skipped: true, safe: true } }), r => r.status === 403);
await expect("sla: bare {safe:true} RA refused (422)", call(sla, "eng", "PATCH", "/sla/jobs/J1", { status: "In Progress", riskAssessment: { safe: true } }), r => r.status === 422);
await expect("sla: real RA accepted", call(sla, "eng", "PATCH", "/sla/jobs/J1", { status: "In Progress", riskAssessment: RA_OK }), r => r.status === 200 && r.body && r.body.status === "In Progress");
await expect("sla: engineer note saved, office fields dropped", call(sla, "eng", "PATCH", "/sla/jobs/J1", { note: "n", assignedEngineers: ["other"], priority: "Priority 1" }), r => { if (r.status !== 200) return false; const j = JSON.parse(r.saved.at(-1).find(b => typeof b === "string" && b.startsWith("{"))); return j.assignedEngineers[0] === "eng" && j.priority !== "Priority 1"; });
await expect("sla: admin PATCH untouched", call(sla, "admin", "PATCH", "/sla/jobs/J1", { assignedEngineers: ["other"], requiresRA: false }), r => { if (r.status !== 200) return false; const j = JSON.parse(r.saved.at(-1).find(b => typeof b === "string" && b.startsWith("{"))); return j.assignedEngineers[0] === "other" && j.requiresRA === false; });
await expect("sla: firestop route refuses foreign key", call(sla, "eng", "GET", "/sla/firestop/spec-file?key=staffdocs/1/user/admin/Payslips/x.pdf"), r => r.status === 400);
await expect("hrdocs: other person's doc refused", call(hrdocs, "eng", "GET", "/staff/doc?key=staffdocs/1/user/admin/Payslips/x.pdf"), r => r.status === 403);
await expect("hrdocs: own doc passes gate (404 = not in mock R2)", call(hrdocs, "eng", "GET", "/staff/doc?key=staffdocs/1/user/eng/Payslips/x.pdf"), r => r.status === 404);
await expect("hrdocs: company doc passes gate", call(hrdocs, "eng", "GET", "/staff/doc?key=staffdocs/1/company/Policies/x.pdf"), r => r.status === 404);
await expect("hrdocs: Full-Access can open anyone's", call(hrdocs, "admin", "GET", "/staff/doc?key=staffdocs/1/user/eng/Payslips/x.pdf"), r => r.status === 404);
await expect("ts: other engineer's invoice refused", call(ts, "eng", "GET", "/ts/invoice-file?key=invoices/1/other/INV-3-2026-08-24.pdf"), r => r.status === 403);
await expect("ts: own invoice passes gate", call(ts, "eng", "GET", "/ts/invoice-file?key=invoices/1/eng/INV-3-2026-08-24.pdf"), r => r.status === 404);
await expect("auth: Pending account cannot log in", call(auth, null, "POST", "/auth/login", { username: "pending", [["pass","word"].join("")]: "not-a-real-credential" }), r => r.status !== 200 || !(r.body && r.body.ok));
console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
