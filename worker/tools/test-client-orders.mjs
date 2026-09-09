// Client orders ↔ jobs (Sep 2026): the orders board API, "make the job" (link /
// clone-as-visit carrying notes + photos / fresh job), order value → job →
// costing profit, and the MONEY gate (Full Access / office staff only).
// Mock D1 + R2, synthetic data. Run: node worker/tools/test-client-orders.mjs
import * as sla from "../src/routes/sla.js";
import * as certs from "../src/routes/certs.js";
import * as costing from "../src/routes/costing.js";

// No network in the harness: costing's postcode/Google lookups must fail soft, fast.
globalThis.fetch = async () => { throw new Error("no network in test"); };

function makeEnv() {
  const jobs = {};       // id → job JSON
  const orders = {};     // id → client_orders row
  const files = {};      // R2 keys
  const users = {
    "Office Olly": { staffType: "office" },
    "Field Fred": { staffType: "field" },
    "Jamie Line": { staffType: "office" },
  };
  const perms = { "Office Olly": ["SLAAdmin"], "Field Fred": ["SLAAdmin"], "Jamie Line": ["FullAccess"] };
  const sites = { "0335": { site_name: "Test Store, High Street", postcode: "AB1 2CD", data: JSON.stringify({ address: "1 High Street" }) } };
  const seed = j => { jobs[j.id] = j; };
  seed({ id: "00099999/2", helpdeskRef: "00099999/2", status: "Pending", createdAt: "2026-09-08T10:00:00.000Z", description: "Replace the door closer", siteCode: "0335", siteName: "Test Store" });
  seed({ id: "00099998/1", helpdeskRef: "00099998/1", status: "Complete", createdAt: "2026-09-01T10:00:00.000Z", description: "Door hinge broken — made safe, quoted", siteCode: "0335", siteName: "Test Store", postcode: "AB1 2CD",
    events: [{ at: "2026-09-01T12:00:00.000Z", by: "Field Fred", type: "note", note: "Made safe, needs new closer" }],
    riskAssessment: { hazards: ["x"], name: "Field Fred" }, signature: { signedBy: "Cust", signedAt: "2026-09-01T13:00:00.000Z", fileKey: "jobs/00099998/1/signature.png" }, assignedEngineers: ["Field Fred"] });
  files["jobs/00099998/1/photo1.jpg"] = "PHOTO"; files["jobs/00099998/1/signature.png"] = "SIG";
  const rows = () => Object.values(jobs);
  const db = { prepare(sql) { let binds = []; const st = {
    bind(...a) { binds = a; return st; },
    async first() {
      if (/FROM sla_jobs WHERE tenant_id = \? AND id = \?/.test(sql)) { const j = jobs[binds[1]]; return j ? { data: JSON.stringify(j) } : null; }
      if (/FROM sla_jobs WHERE tenant_id=\? AND id=\?/.test(sql)) { const j = jobs[binds[1]]; return j ? { data: JSON.stringify(j) } : null; }
      if (/SELECT profile FROM users/.test(sql)) { const u = users[binds[1]]; return u ? { profile: JSON.stringify(u) } : null; }
      if (/FROM client_orders WHERE tenant_id=\? AND external_id=\?/.test(sql)) return Object.values(orders).find(o => o.external_id === binds[1]) || null;
      if (/FROM client_orders WHERE tenant_id=\? AND order_number=\?/.test(sql)) return Object.values(orders).filter(o => o.order_number === binds[1] && (!/status<>'dismissed'/.test(sql) || o.status !== "dismissed"))[0] || null;
      if (/FROM client_orders WHERE tenant_id=\? AND id=\?/.test(sql)) return orders[binds[1]] || null;
      if (/FROM sites WHERE/.test(sql)) { const s = sites[String(binds[1]).padStart(4, "0")]; return s || null; }
      return null; },
    async all() {
      if (/SELECT permission, value FROM user_permissions/.test(sql)) return { results: (perms[binds[1]] || []).map(p => ({ permission: p, value: 1 })) };
      if (/SELECT permission FROM user_permissions/.test(sql)) return { results: (perms[binds[1]] || []).map(p => ({ permission: p })) };
      if (/helpdesk_ref=\?/.test(sql)) return { results: rows().filter(j => j.helpdeskRef === binds[1]).map(j => ({ data: JSON.stringify(j) })) };
      if (/helpdesk_ref LIKE \?/.test(sql)) { const pre = String(binds[1]).replace(/%$/, ""); return { results: rows().filter(j => String(j.helpdeskRef || "").startsWith(pre) && j.helpdeskRef !== binds[2]).map(j => ({ data: JSON.stringify(j) })) }; }
      if (/^SELECT data FROM sla_jobs WHERE tenant_id\s*=\s*\?\s*$/.test(sql.trim())) return { results: rows().map(j => ({ data: JSON.stringify(j) })) };
      if (/FROM client_orders WHERE tenant_id=\? ORDER BY/.test(sql)) return { results: Object.values(orders) };
      return { results: [] }; },
    async run() {
      if (/INSERT INTO sla_jobs/.test(sql)) { const j = JSON.parse(binds[binds.length - 1]); jobs[j.id] = j; }
      else if (/INSERT INTO client_orders/.test(sql)) {
        const cols = /INSERT INTO client_orders\s*\(([^)]+)\)/.exec(sql)[1].split(",").map(c => c.trim());
        const row = {}; cols.forEach((c, i) => row[c] = binds[i]);
        const ex = orders[row.id];
        if (ex) { Object.assign(ex, row, { status: ["actioned", "dismissed"].includes(ex.status) ? ex.status : row.status }); } else orders[row.id] = row;
      }
      else if (/UPDATE client_orders SET/.test(sql)) {
        const o = orders[binds[binds.length - 1]]; if (!o) return { meta: {} };
        if (/matched_job_id=\?/.test(sql)) o.matched_job_id = binds[0];
        if (/matched_kind='job'/.test(sql)) o.matched_kind = "job";
        if (/ELSE 'linked'/.test(sql) && !["dismissed", "actioned"].includes(o.status)) o.status = "linked";
        if (/status='dismissed'/.test(sql)) o.status = "dismissed";
        if (/SET status=\?, actioned_at=NULL/.test(sql)) o.status = binds[0];
      }
      return { meta: {} }; },
  }; return st; }, batch(s) { return Promise.all(s.map(x => x.run())); } };
  const r2 = { async list({ prefix }) { return { objects: Object.keys(files).filter(k => k.startsWith(prefix)).map(key => ({ key })), truncated: false }; },
    async get(k) { return files[k] != null ? { body: files[k], httpMetadata: {}, customMetadata: {} } : null; }, async put(k, body) { files[k] = body; }, async delete() {} };
  return { env: { DB: db, JOB_FILES: r2, ASSET_BUCKET: r2, JOBS_INBOUND_TOKEN: "tok" }, jobs, orders, files };
}
const sessOf = u => ({ user: { username: u }, tenantId: 1 });
const J = async (mod, path, sess, opts = {}) => {
  const url = new URL("https://api.test" + path);
  const req = new Request(url, { method: opts.method || "GET", headers: { "content-type": "application/json", ...(opts.headers || {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const res = await mod.handle(req, opts.env, { waitUntil() {} }, url, sess);
  let j = null; try { j = await res.clone().json(); } catch {}
  return { status: res.status, body: j };
};
let fail = 0; const ok = (name, cond, extra = "") => { console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra ? "  → " + extra : "")); if (!cond) fail++; };

{ // 1. an order arrives for a job already on the board (New Job Alert came first) → value stamped, order linked
  const E = makeEnv();
  const r = await J(certs, "/certs/remedials/order-inbound", null, { env: E.env, method: "POST", headers: { authorization: "Bearer tok" },
    body: { orderNumber: "00099999/2", client: "Southern Co-op", priority: 3, orderValue: 439, storeCode: "0335", siteName: "Test Store", description: "Return to replace the closer", externalId: "<ord-1@concerto>" } });
  const j = E.jobs["00099999/2"], o = Object.values(E.orders)[0];
  ok("order → existing same-ref job stamped with number + value", r.status === 200 && r.body.status === "linked" && r.body.jobId === "00099999/2" && j.orderNumber === "00099999/2" && j.orderValue === 439 && j.clientOrderId === o.id, JSON.stringify(r.body));
  ok("order row linked to the job", o.status === "linked" && o.matched_kind === "job" && o.matched_job_id === "00099999/2");
  ok("job event notes the link", (j.events || []).some(e => /Client order 00099999\/2 — £439\.00 linked/.test(e.note)));

  // Money gate on the job JSON
  const f = await J(sla, "/sla/jobs/" + encodeURIComponent("00099999/2"), sessOf("Field Fred"), { env: E.env });
  const of = await J(sla, "/sla/jobs/" + encodeURIComponent("00099999/2"), sessOf("Office Olly"), { env: E.env });
  ok("field engineer (even with SLAAdmin) never receives orderValue", f.status === 200 && f.body.orderNumber === "00099999/2" && !("orderValue" in f.body), Object.keys(f.body).filter(k => /order/i.test(k)).join(","));
  ok("office staff receive orderValue", of.status === 200 && of.body.orderValue === 439);
  const lf = await J(sla, "/sla/jobs", sessOf("Field Fred"), { env: E.env });
  ok("job LIST strips orderValue for a field user", lf.status === 200 && lf.body.every(x => !("orderValue" in x)));
  const fe = await J(sla, "/sla/jobs/for-engineer?engineer=field.fred", sessOf("Field Fred"), { env: E.env });
  ok("for-engineer list carries no orderValue", fe.status === 200 && Array.isArray(fe.body) && fe.body.every(x => !("orderValue" in x)));
}
{ // 2. an order for an incident we attended (/1 Complete) → needs a job → "Make the job" clones it as a linked visit
  const E = makeEnv();
  const r = await J(certs, "/certs/remedials/order-inbound", null, { env: E.env, method: "POST", headers: { authorization: "Bearer tok" },
    body: { orderNumber: "00099998/2", client: "Southern Co-op", priority: 3, orderValue: 620.5, storeCode: "0335", siteName: "Test Store", description: "Supply and fit new door closer as quoted", externalId: "<ord-2@concerto>" } });
  ok("order with only an earlier finished visit → not auto-linked (needs a job)", r.status === 200 && r.body.status === "new" && !r.body.jobId, JSON.stringify(r.body));
  const oid = Object.values(E.orders)[0].id;
  const list = await J(certs, "/certs/orders", sessOf("Office Olly"), { env: E.env });
  const row = list.body.orders.find(o => o.id === oid);
  ok("board: stage needs_job, earlier visit listed, client list", list.status === 200 && row && row.stage === "needs_job" && row.incident === "00099998" && row.earlier.length === 1 && row.earlier[0].ref === "00099998/1" && list.body.clients.includes("Southern Co-op"), JSON.stringify(row && { stage: row.stage, earlier: row.earlier }));
  const denied = await J(certs, "/certs/orders", sessOf("Field Fred"), { env: E.env });
  ok("board refused to a field engineer (money)", denied.status === 403);
  const mk = await J(certs, "/certs/orders/make-job", sessOf("Office Olly"), { env: E.env, method: "POST", body: { id: oid } });
  const nj = E.jobs[mk.body && mk.body.jobId];
  ok("make-job → cloned from the earlier visit as a linked visit", mk.status === 200 && mk.body.how === "cloned" && mk.body.from.ref === "00099998/1" && nj && nj.helpdeskRef === "00099998/2" && nj.revisitOf === "00099998/1" && nj.visitGroupId === "00099998/1" && nj.status === "Pending", JSON.stringify(mk.body));
  ok("new job carries the order number + value + priority", nj && nj.orderNumber === "00099998/2" && nj.orderValue === 620.5 && nj.clientOrderId === oid && nj.priority === "Priority 3");
  ok("description = order text + link line + original job text", nj && /Client order 00099998\/2 \(£620\.50\) — Supply and fit/.test(nj.description) && /following our visit 00099998\/1 \(Complete\)/.test(nj.description) && /Original job —\nDoor hinge broken/.test(nj.description), nj && nj.description);
  ok("notes, RA + signature carried across", nj && (nj.events || []).some(e => /Made safe/.test(e.note)) && nj.riskAssessment && nj.riskAssessment.name === "Field Fred" && nj.signature && nj.signature.fileKey === "jobs/" + nj.id + "/signature.png");
  ok("photos copied to the new job's R2 folder", E.files["jobs/" + (nj && nj.id) + "/photo1.jpg"] === "PHOTO" && E.files["jobs/00099998/1/photo1.jpg"] === "PHOTO");
  ok("visit count stamped on both", nj && nj.visitCount === 2 && E.jobs["00099998/1"].visitCount === 2 && E.jobs["00099998/1"].visitGroupId === "00099998/1");
  ok("order now linked + the board says live", E.orders[oid].status === "linked" && E.orders[oid].matched_job_id === nj.id && (await J(certs, "/certs/orders", sessOf("Office Olly"), { env: E.env })).body.orders[0].stage === "live");
  const again = await J(certs, "/certs/orders/make-job", sessOf("Office Olly"), { env: E.env, method: "POST", body: { id: oid } });
  ok("make-job twice → links the job it already made (no duplicate)", again.status === 200 && again.body.how === "linked" && again.body.jobId === nj.id && Object.keys(E.jobs).length === 3, JSON.stringify(again.body));
  // costing: profit for the office, refused to the field
  const cost = await J(costing, "/costing/job-full-cost?jobId=" + encodeURIComponent(nj.id), sessOf("Office Olly"), { env: E.env });
  ok("job cost carries order value + profit (no labour yet → profit = value)", cost.status === 200 && cost.body.orderValue === 620.5 && cost.body.profit === 620.5 && cost.body.orderNumber === "00099998/2", JSON.stringify(cost.body && { v: cost.body.orderValue, p: cost.body.profit, t: cost.body.total }));
  const costF = await J(costing, "/costing/job-full-cost?jobId=" + encodeURIComponent(nj.id), sessOf("Field Fred"), { env: E.env });
  ok("job cost refused to a field engineer", costF.status === 403);
  const vis = await J(sla, "/sla/jobs/" + encodeURIComponent(nj.id) + "/visits", sessOf("Office Olly"), { env: E.env });
  const visF = await J(sla, "/sla/jobs/" + encodeURIComponent(nj.id) + "/visits", sessOf("Field Fred"), { env: E.env });
  ok("visits list: order value for the office, stripped for the field", vis.body.visits.some(v => v.orderValue === 620.5) && visF.body.visits.every(v => !("orderValue" in v)));
}
{ // 3. an R-order with no earlier job → a fresh job at the store
  const E = makeEnv();
  await J(certs, "/certs/remedials/order-inbound", null, { env: E.env, method: "POST", headers: { authorization: "Bearer tok" },
    body: { orderNumber: "R29051", client: "Southern Co-op", priority: 3, orderValue: 150, storeCode: "0335", siteName: "Test Store", description: "PPM order", externalId: "<ord-3@concerto>" } });
  const oid = Object.values(E.orders)[0].id;
  const mk = await J(certs, "/certs/orders/make-job", sessOf("Jamie Line"), { env: E.env, method: "POST", body: { id: oid } });
  const nj = E.jobs[mk.body && mk.body.jobId];
  ok("R-order → fresh job at the store with the site resolved", mk.status === 200 && mk.body.how === "created" && nj && nj.helpdeskRef === "R29051" && nj.siteCode === "0335" && nj.siteName === "Test Store, High Street" && nj.postcode === "AB1 2CD" && nj.orderValue === 150 && !nj.revisitOf, JSON.stringify(mk.body));
}
{ // 4. the job arrives AFTER the order (/sla/inbound) → the waiting order is stamped on it
  const E = makeEnv();
  await J(certs, "/certs/remedials/order-inbound", null, { env: E.env, method: "POST", headers: { authorization: "Bearer tok" },
    body: { orderNumber: "00099997/2", client: "Southern Co-op", priority: 2, orderValue: 99, storeCode: "0335", siteName: "Test Store", description: "x", externalId: "<ord-4@concerto>" } });
  const r = await J(sla, "/sla/inbound", null, { env: E.env, method: "POST", headers: { Authorization: "Bearer tok" }, body: { reference: "00099997/2", description: "New job alert", siteCode: "0335", priority: "Priority 2" } });
  const j = E.jobs[r.body && r.body.id];
  ok("job created later picks up the waiting order's value", r.status === 201 && j && j.orderValue === 99 && j.orderNumber === "00099997/2" && Object.values(E.orders)[0].status === "linked", JSON.stringify(r.body));
}
{ // 5. dismissed order can't be turned into a job; reopen restores it
  const E = makeEnv();
  await J(certs, "/certs/remedials/order-inbound", null, { env: E.env, method: "POST", headers: { authorization: "Bearer tok" }, body: { orderNumber: "00099996/2", client: "Southern Co-op", orderValue: 10, storeCode: "0335", externalId: "<ord-5@concerto>" } });
  const oid = Object.values(E.orders)[0].id;
  await J(certs, "/certs/remedials/order-action", sessOf("Office Olly"), { env: E.env, method: "POST", body: { id: oid, action: "dismiss" } });
  const mk = await J(certs, "/certs/orders/make-job", sessOf("Office Olly"), { env: E.env, method: "POST", body: { id: oid } });
  ok("dismissed order → make-job refused", mk.status === 400 && /dismissed/.test(mk.body.error || ""));
  const b = await J(certs, "/certs/orders", sessOf("Office Olly"), { env: E.env });
  ok("board shows it under dismissed", b.body.orders[0].stage === "dismissed");
}
console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
