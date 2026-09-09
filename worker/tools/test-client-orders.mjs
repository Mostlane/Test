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
  const acks = [];       // em_remedial_acks rows (cert_id, site_code, site_name, cert_number, stage, job_id)
  const rems = [];       // em_remedials rows (id, cert_id, kind, status, fitting_no, photos, site_code, site_name, cert_number)
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
      if (/FROM em_remedial_acks WHERE tenant_id=\? AND cert_id=\?/.test(sql)) return acks.find(a => a.cert_id === binds[1]) || null;
      if (/SELECT unlinked_job_id FROM client_orders/.test(sql)) { const o = orders[binds[1]]; return o ? { unlinked_job_id: o.unlinked_job_id || null } : null; }
      if (/FROM client_orders WHERE tenant_id=\? AND external_id=\?/.test(sql)) return Object.values(orders).find(o => o.external_id === binds[1]) || null;
      if (/FROM client_orders WHERE tenant_id=\? AND order_number=\?/.test(sql)) return Object.values(orders).filter(o => o.order_number === binds[1] && (!/status<>'dismissed'/.test(sql) || o.status !== "dismissed"))[0] || null;
      if (/FROM client_orders WHERE tenant_id=\? AND id=\?/.test(sql)) return orders[binds[1]] || null;
      if (/FROM sites WHERE/.test(sql)) { const s = sites[String(binds[1]).padStart(4, "0")]; return s || null; }
      return null; },
    async all() {
      if (/SELECT permission, value FROM user_permissions/.test(sql)) return { results: (perms[binds[1]] || []).map(p => ({ permission: p, value: 1 })) };
      if (/SELECT permission FROM user_permissions/.test(sql)) return { results: (perms[binds[1]] || []).map(p => ({ permission: p })) };
      if (/helpdesk_ref=\?/.test(sql)) return { results: rows().filter(j => j.helpdeskRef === binds[1]).map(j => ({ data: JSON.stringify(j) })) };
      if (/helpdesk_ref LIKE \?/.test(sql)) { const re = new RegExp("^" + String(binds[1]).split("%").map(x => x.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&")).join(".*") + "$"); return { results: rows().filter(j => re.test(String(j.helpdeskRef || ""))).map(j => ({ data: JSON.stringify(j) })) }; }
      if (/FROM em_remedial_acks WHERE tenant_id=\? AND COALESCE\(stage/.test(sql)) return { results: acks.filter(a => ["to_quote", "quoted", "approved", "in_works"].includes(a.stage || "to_quote")) };
      if (/FROM em_remedials WHERE tenant_id=\? AND cert_id=\?/.test(sql)) return { results: rems.filter(r => r.cert_id === binds[1] && (!/status='pending'/.test(sql) || r.status === "pending")) };
      if (/FROM client_orders WHERE tenant_id=\? AND matched_cert_id=\?/.test(sql)) return { results: Object.values(orders).filter(o => o.matched_cert_id === binds[1] && ["new", "matched"].includes(o.status)) };
      if (/^SELECT data FROM sla_jobs WHERE tenant_id\s*=\s*\?\s*$/.test(sql.trim())) return { results: rows().map(j => ({ data: JSON.stringify(j) })) };
      if (/FROM client_orders WHERE tenant_id=\? ORDER BY/.test(sql)) return { results: Object.values(orders) };
      return { results: [] }; },
    async run() {
      if (/INSERT INTO sla_jobs/.test(sql)) { const j = JSON.parse(binds[binds.length - 1]); jobs[j.id] = j; }
      else if (/INSERT INTO client_orders/.test(sql)) {
        const cols = /INSERT INTO client_orders\s*\(([^)]+)\)/.exec(sql)[1].split(",").map(c => c.trim());
        const row = {}; cols.forEach((c, i) => row[c] = binds[i]);
        const ex = orders[row.id];
        // ON CONFLICT: status keeps actioned/dismissed; the email copy is COALESCEd (a re-send without it keeps the stored one)
        if (ex) { for (const k of ["email_subject", "email_from", "email_text"]) if (row[k] == null) row[k] = ex[k]; Object.assign(ex, row, { status: ["actioned", "dismissed"].includes(ex.status) ? ex.status : row.status }); } else orders[row.id] = row;
      }
      else if (/UPDATE client_orders SET/.test(sql)) {
        // Generic SET parser: col=? (binds in order) | col='lit' | col=NULL | col=CASE…END (the
        // "keep dismissed/actioned else linked" status rule).
        const o = orders[binds[binds.length - 1]]; if (!o) return { meta: {} };
        const set = /SET ([\s\S]*?) WHERE /.exec(sql)[1]; let bi = 0;
        for (const m of set.matchAll(/(\w+)=(\?|NULL|'([^']*)'|CASE[\s\S]*?END)/g)) {
          const col = m[1], v = m[2];
          if (v === "?") o[col] = binds[bi++];
          else if (v === "NULL") o[col] = null;
          else if (v.startsWith("'")) o[col] = m[3];
          else if (/ELSE 'linked'/.test(v)) { if (!["dismissed", "actioned"].includes(o.status)) o.status = "linked"; }
        }
      }
      else if (/UPDATE em_remedial_acks SET/.test(sql)) {
        const a = acks.find(x => x.cert_id === binds[binds.length - 1]); if (!a) return { meta: {} };
        if (/stage='in_works'/.test(sql)) { a.stage = "in_works"; a.job_id = binds[0] || a.job_id; }
        if (/stage='done'/.test(sql)) a.stage = "done";
      }
      return { meta: {} }; },
  }; return st; }, batch(s) { return Promise.all(s.map(x => x.run())); } };
  const r2 = { async list({ prefix }) { return { objects: Object.keys(files).filter(k => k.startsWith(prefix)).map(key => ({ key })), truncated: false }; },
    async get(k) { return files[k] != null ? { body: files[k], httpMetadata: {}, customMetadata: {} } : null; }, async put(k, body) { files[k] = body; }, async delete() {} };
  return { env: { DB: db, JOB_FILES: r2, ASSET_BUCKET: r2, JOBS_INBOUND_TOKEN: "tok" }, jobs, orders, files, acks, rems };
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
  ok("job event notes the link — WITHOUT the £ (timeline is engineer-visible)", (j.events || []).some(e => /Client order 00099999\/2 linked to this job/.test(e.note)) && !(j.events || []).some(e => /£/.test(e.note || "")));

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
  ok("description = order text + link line + original job text, NO value in it", nj && /Client order 00099998\/2 — Supply and fit/.test(nj.description) && !/£/.test(nj.description) && /following our visit 00099998\/1 \(Complete\)/.test(nj.description) && /Original job —\nDoor hinge broken/.test(nj.description), nj && nj.description);
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
const inbound = (E, body) => J(certs, "/certs/remedials/order-inbound", null, { env: E.env, method: "POST", headers: { authorization: "Bearer tok" }, body });
{ // 6. LATE EM order: the office already pressed PO received by hand (case in_works, works job exists) → links straight to the works job
  const E = makeEnv();
  E.jobs["emrem:CERT-A"] = { id: "emrem:CERT-A", helpdeskRef: "EM remedial — 0335", status: "Scheduled", createdAt: "2026-09-08T10:00:00.000Z", siteCode: "0335", siteName: "Test Store", assignedEngineers: ["Field Fred"] };
  E.acks.push({ cert_id: "CERT-A", site_code: "0335", site_name: "Test Store", cert_number: "0335-26", stage: "in_works", job_id: "emrem:CERT-A" });
  const r = await inbound(E, { orderNumber: "R29051", client: "Southern Co-op", priority: 3, orderValue: 200, storeCode: "0335", siteName: "Test Store", description: "4x failed lights", externalId: "<ord-6@concerto>" });
  const o = Object.values(E.orders)[0], j = E.jobs["emrem:CERT-A"];
  ok("late EM order → linked to the existing works job, value stamped", r.status === 200 && r.body.status === "linked" && r.body.jobId === "emrem:CERT-A" && j.orderNumber === "R29051" && j.orderValue === 200 && j.clientOrderId === o.id, JSON.stringify(r.body));
  ok("order keeps its certificate match (kind em) alongside the job link", o.matched_kind === "em" && o.matched_cert_id === "CERT-A" && o.matched_job_id === "emrem:CERT-A" && o.status === "linked", JSON.stringify({ k: o.matched_kind, c: o.matched_cert_id, j: o.matched_job_id, s: o.status }));
  const b = await J(certs, "/certs/orders", sessOf("Office Olly"), { env: E.env });
  ok("board shows it live on the works job", b.body.orders[0].stage === "live" && b.body.orders[0].job.id === "emrem:CERT-A");
}
{ // 7. order arrives while the EM case is still QUOTED → matched; approving from the order raises the works job AND stamps the value on it
  const E = makeEnv();
  E.acks.push({ cert_id: "CERT-B", site_code: "0335", site_name: "Test Store", cert_number: "0335-26", stage: "quoted", job_id: null });
  E.rems.push({ id: "CERT-B:0", cert_id: "CERT-B", kind: "light", status: "pending", fitting_no: 3, photos: "[]", site_code: "0335", site_name: "Test Store", cert_number: "0335-26" });
  const r = await inbound(E, { orderNumber: "R29052", client: "Southern Co-op", priority: 3, orderValue: 50, storeCode: "0335", siteName: "Test Store", description: "Fitting 3 - Light replacement - £50", externalId: "<ord-7@concerto>" });
  const oid = Object.values(E.orders)[0].id;
  ok("order matched to the waiting EM case (no job yet)", r.status === 200 && r.body.status === "matched" && r.body.matchedKind === "em" && !r.body.jobId, JSON.stringify(r.body));
  const ap = await J(certs, "/certs/remedials/order-action", sessOf("Office Olly"), { env: E.env, method: "POST", body: { id: oid, action: "approve" } });
  const wj = E.jobs["emrem:CERT-B"];
  ok("approve → works job raised with the order number + value on it", ap.status === 200 && ap.body.jobId === "emrem:CERT-B" && wj && wj.orderNumber === "R29052" && wj.orderValue === 50 && wj.clientOrderId === oid, JSON.stringify(ap.body));
  ok("order actioned + linked to the works job", E.orders[oid].status === "actioned" && E.orders[oid].matched_job_id === "emrem:CERT-B" && E.orders[oid].matched_kind === "em");
}
{ // 8. the office presses PO received on the TRACKER instead (order already matched, waiting) → same result
  const E = makeEnv();
  E.acks.push({ cert_id: "CERT-C", site_code: "0335", site_name: "Test Store", cert_number: "0335-26", stage: "quoted", job_id: null });
  E.rems.push({ id: "CERT-C:0", cert_id: "CERT-C", kind: "light", status: "pending", fitting_no: 1, photos: "[]", site_code: "0335", site_name: "Test Store", cert_number: "0335-26" });
  await inbound(E, { orderNumber: "R29053", client: "Southern Co-op", orderValue: 50, storeCode: "0335", siteName: "Test Store", externalId: "<ord-8@concerto>" });
  const oid = Object.values(E.orders)[0].id;
  const po = await J(certs, "/certs/remedials/po-received", sessOf("Office Olly"), { env: E.env, method: "POST", body: { certId: "CERT-C" } });
  const wj = E.jobs["emrem:CERT-C"];
  ok("PO received on the tracker → the waiting order is linked to the works job + value stamped", po.status === 200 && wj && wj.orderNumber === "R29053" && wj.orderValue === 50 && E.orders[oid].matched_job_id === "emrem:CERT-C" && E.orders[oid].status === "actioned", JSON.stringify(po.body));
}
{ // 9. a hand-made job whose reference CONTAINS the order number links; a near-miss never does
  const E = makeEnv();
  E.jobs["j-hand"] = { id: "j-hand", helpdeskRef: "R29051- EM remedial — 0335", status: "Scheduled", createdAt: "2026-09-08T10:00:00.000Z", siteCode: "0335", siteName: "Test Store" };
  const miss = await inbound(E, { orderNumber: "R2905", client: "Southern Co-op", orderValue: 1, storeCode: "0335", externalId: "<ord-9a@concerto>" });
  ok("R2905 does NOT claim the R29051 job (whole-token match)", miss.status === 200 && miss.body.status === "new" && !miss.body.jobId && E.jobs["j-hand"].orderValue == null, JSON.stringify(miss.body));
  const hit = await inbound(E, { orderNumber: "R29051", client: "Southern Co-op", orderValue: 200, storeCode: "0335", externalId: "<ord-9b@concerto>" });
  ok("R29051 links to the job whose reference contains it", hit.status === 200 && hit.body.status === "linked" && hit.body.jobId === "j-hand" && E.jobs["j-hand"].orderValue === 200 && E.jobs["j-hand"].orderNumber === "R29051", JSON.stringify(hit.body));
}
{ // 10. UNLINK: the job forgets the order, the order goes back to needs-a-job, and nothing automatic re-attaches that pair
  const E = makeEnv();
  await inbound(E, { orderNumber: "00099999/2", client: "Southern Co-op", orderValue: 439, storeCode: "0335", siteName: "Test Store", externalId: "<ord-10@concerto>" });
  const oid = Object.values(E.orders)[0].id;
  ok("setup: linked to the same-ref job", E.orders[oid].matched_job_id === "00099999/2" && E.jobs["00099999/2"].orderValue === 439);
  const denied = await J(certs, "/certs/orders/unlink", sessOf("Field Fred"), { env: E.env, method: "POST", body: { id: oid } });
  ok("unlink refused to a field engineer", denied.status === 403);
  const un = await J(certs, "/certs/orders/unlink", sessOf("Office Olly"), { env: E.env, method: "POST", body: { id: oid } });
  const j = E.jobs["00099999/2"], o = E.orders[oid];
  ok("unlink → job forgets number/value/link + notes who did it", un.status === 200 && un.body.jobId === "00099999/2" && j.orderValue == null && j.orderNumber == null && j.clientOrderId == null && (j.events || []).some(e => /unlinked from this job by Office Olly/.test(e.note)), JSON.stringify(un.body));
  ok("order back to new, job remembered as unlinked", o.status === "new" && !o.matched_job_id && !o.matched_kind && o.unlinked_job_id === "00099999/2", JSON.stringify({ s: o.status, u: o.unlinked_job_id }));
  const b = await J(certs, "/certs/orders", sessOf("Office Olly"), { env: E.env });
  ok("board: needs a job again (no visual re-attach by reference)", b.body.orders[0].stage === "needs_job" && !b.body.orders[0].job);
  const again = await inbound(E, { orderNumber: "00099999/2", client: "Southern Co-op", orderValue: 439, storeCode: "0335", siteName: "Test Store", externalId: "<ord-10@concerto>" });
  ok("the same email re-sent does NOT re-link the unlinked pair", again.status === 200 && again.body.status === "new" && !again.body.jobId && E.jobs["00099999/2"].orderValue == null, JSON.stringify(again.body));
  const r2 = await J(sla, "/sla/inbound", null, { env: E.env, method: "POST", headers: { Authorization: "Bearer tok" }, body: { reference: "00099999/2", description: "Re-sent job alert", siteCode: "0335", priority: "Priority 3" } });
  ok("the job arriving again does NOT pick the unlinked order up", r2.status === 200 && E.jobs["00099999/2"].orderValue == null && E.orders[oid].status === "new", JSON.stringify({ v: E.jobs["00099999/2"].orderValue, s: E.orders[oid].status }));
  const mk = await J(certs, "/certs/orders/make-job", sessOf("Office Olly"), { env: E.env, method: "POST", body: { id: oid } });
  ok("make-job after unlink → a different job, never the unlinked one", mk.status === 200 && mk.body.jobId !== "00099999/2" && E.jobs[mk.body.jobId] && E.jobs[mk.body.jobId].orderValue === 439, JSON.stringify(mk.body));
  const relink = await J(certs, "/certs/orders/link", sessOf("Office Olly"), { env: E.env, method: "POST", body: { id: oid, jobId: "00099999/2" } });
  ok("the office can still hand-link it back deliberately", relink.status === 200 && E.jobs["00099999/2"].orderValue === 439 && E.orders[oid].matched_job_id === "00099999/2");
}
{ // 11. a COPY of the order email travels with the order — readable by any office user, never by the field
  const E = makeEnv();
  await inbound(E, { orderNumber: "00099996/2", client: "Southern Co-op", orderValue: 10, storeCode: "0335", externalId: "<ord-11@concerto>",
    emailSubject: "Order number 00099996/2 from Southern Coop", emailFrom: "noreply@concerto.co.uk", emailText: "Concerto\nOrder number 00099996/2\nPriority : Priority 3\nOrder value : £10.00\nFix the thing\nFor :\n0335 - Test Store SR00001" });
  const oid = Object.values(E.orders)[0].id;
  const b = await J(certs, "/certs/orders", sessOf("Office Olly"), { env: E.env });
  ok("board flags the stored copy (hasEmail) without shipping the text", b.body.orders[0].hasEmail === true && !("emailText" in b.body.orders[0]) && b.body.orders[0].emailSubject === "Order number 00099996/2 from Southern Coop");
  const em = await J(certs, "/certs/orders/email?id=" + encodeURIComponent(oid), sessOf("Office Olly"), { env: E.env });
  ok("office reads the email copy", em.status === 200 && /Fix the thing/.test(em.body.text) && em.body.from === "noreply@concerto.co.uk" && em.body.subject === "Order number 00099996/2 from Southern Coop", JSON.stringify(em.body));
  const emF = await J(certs, "/certs/orders/email?id=" + encodeURIComponent(oid), sessOf("Field Fred"), { env: E.env });
  ok("email copy refused to a field engineer", emF.status === 403);
  await inbound(E, { orderNumber: "00099996/2", client: "Southern Co-op", orderValue: 10, storeCode: "0335", externalId: "<ord-11@concerto>" });
  ok("a re-send without the copy keeps the stored copy", !!E.orders[oid].email_text && /Fix the thing/.test(E.orders[oid].email_text));
}
{ // 12. an order's LABOUR / MATERIALS price lines never reach the job description (engineers see it)
  const E = makeEnv();
  const desc = "Attend site to replace the door closer.\n\nSupply and install a new LCN 4040XP closer, 1 No. 1250mm x 2050mm 6.4mm panel.\n\nPrice assumes the substrate is sound.\n\nLabour - 150.00\nMaterials 289.00\nMaterials / Specialist Equipment – £143.00\nLabour: £350.00";
  await inbound(E, { orderNumber: "R29060", client: "Southern Co-op", orderValue: 439, storeCode: "0335", siteName: "Test Store", description: desc, externalId: "<ord-12@concerto>" });
  const oid = Object.values(E.orders)[0].id;
  const mk = await J(certs, "/certs/orders/make-job", sessOf("Office Olly"), { env: E.env, method: "POST", body: { id: oid } });
  const nj = E.jobs[mk.body && mk.body.jobId];
  const d = (nj && nj.description) || "";
  ok("labour/materials lines + the value are stripped; the works text is kept", mk.status === 200 && /Client order R29060 — Attend site to replace the door closer/.test(d) && /6\.4mm panel/.test(d) && /Price assumes the substrate is sound/.test(d) && !/Labour|Materials|£|150\.00|289\.00|143\.00/.test(d) && nj.orderValue === 439, JSON.stringify(d));
  ok("the board still shows the priced text to the office", /Labour - 150\.00[\s\S]*Materials \/ Specialist Equipment – £143\.00/.test((await J(certs, "/certs/orders", sessOf("Office Olly"), { env: E.env })).body.orders[0].detail || ""));
  const rem = "Failed EM fittings at store 0335:\nFitting 16 - Light replacement (replaced on site) - £50\nFitting 22 - Light replacement - £50\nTotal: 2 fittings - £100";
  ok("per-fitting prices + the total line are stripped", sla.stripPricing(rem) === "Failed EM fittings at store 0335:\nFitting 16 - Light replacement (replaced on site)\nFitting 22 - Light replacement", JSON.stringify(sla.stripPricing(rem)));
  ok("four-figure amounts without a thousands comma are stripped too", sla.stripPricing("Supply the unit.\n\nLabour - 960.00\n\nMaterials - 1151.00\n\nPlease note this is like for like.") === "Supply the unit.\n\nPlease note this is like for like.", JSON.stringify(sla.stripPricing("Supply the unit.\n\nLabour - 960.00\n\nMaterials - 1151.00\n\nPlease note this is like for like.")));
  ok("a line that merely STARTS with a cost word but carries no amount is kept", sla.stripPricing("Materials to be supplied by the client.\nTotal of 3 doors to replace.") === "Materials to be supplied by the client.\nTotal of 3 doors to replace.");
}
console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
