// Drainage → Metro Rod (replaces the drainage Zap). Mock D1 + a mocked Resend.
// Run: node --no-warnings worker/tools/test-drainage.mjs
import * as sla from "../src/routes/sla.js";

const JOBS = {
  "J-DRAIN": { id: "J-DRAIN", helpdeskRef: "00031502/1", status: "Co-op Pending", priority: "Priority 1", siteCode: "0129", siteName: "Gosport",
    address: "Palmyra Road, 66, Elson, Gosport, Hampshire, PO12 4EH", postcode: "PO12 4EH", telephone: "02392 582806",
    description: "Drain outside the toilet door is backed up and blocked.", createdAt: "2026-10-10T08:18:00.000Z" },
  "J-TAP": { id: "J-TAP", helpdeskRef: "00031474", status: "Co-op Pending", priority: "Priority 2", siteCode: "0380", description: "Hot tap leaking", createdAt: "2026-10-09T14:04:00.000Z" },
};
const PERMS = { "Office Admin": ["SLAAdmin"], "Boss": ["FullAccess"], "Field Eng": [], "SLA Field": ["SLAAdmin"] };
// staffType drives the office gate (canSeeMoney): office OR FullAccess may manage subcontractors, never field.
const PROFILES = { "Office Admin": { staffType: "office" }, "Boss": {}, "Field Eng": { staffType: "field" }, "SLA Field": { staffType: "field" } };

function makeEnv({ sendOk = true, pos = [] } = {}) {
  const saved = {}; const idem = new Set(); const sent = []; const pushes = []; const appConfig = {};
  const rows = () => Object.values({ ...JOBS, ...saved });
  const db = { prepare(sql) { let b = []; const st = {
    bind(...a) { b = a; return st; },
    async first() {
      if (/SELECT email FROM users/.test(sql)) return b[0] === "Office Admin" ? { email: "office@mostlane.test" } : null;
      if (/SELECT profile FROM users/.test(sql)) { const u = b[1]; return PROFILES[u] ? { profile: JSON.stringify(PROFILES[u]) } : null; }
      if (/FROM sla_jobs WHERE tenant_id = \? AND id = \?/.test(sql)) { const j = rows().find(j => j.id === b[1]); return j ? { data: JSON.stringify(j) } : null; }
      if (/FROM app_config/.test(sql)) { const key = /key\s*=\s*\?/.test(sql) ? b[b.length - 1] : (sql.match(/key\s*=\s*'([^']+)'/) || [])[1]; return appConfig[key] != null ? { value: appConfig[key] } : null; }
      return null;
    },
    async all() {
      if (/FROM user_permissions/.test(sql)) return { results: (PERMS[b[1]] || []).map(p => ({ permission: p, value: 1, username: b[1] })) };
      if (/helpdesk_ref=\?/.test(sql)) return { results: rows().filter(j => j.helpdeskRef === b[1]).map(j => ({ data: JSON.stringify(j) })) };
      if (/helpdesk_ref LIKE \?/.test(sql)) return { results: [] };
      if (/SELECT data FROM sla_jobs WHERE tenant_id = \?$/.test(sql.trim())) return { results: rows().map(j => ({ data: JSON.stringify(j) })) };
      return { results: [] };
    },
    async run() {
      if (/INSERT INTO idempotency/.test(sql)) { if (idem.has(b[1])) throw new Error("UNIQUE"); idem.add(b[1]); }
      if (/DELETE FROM idempotency/.test(sql)) idem.delete(b[0]);
      if (/INSERT INTO sla_jobs/.test(sql)) { const j = JSON.parse(b[b.length - 1]); saved[j.id] = j; }
      if (/INSERT INTO app_config/.test(sql)) appConfig[b[1]] = b[2];   // (tenant_id, key, value)
      if (/INSERT INTO user_notifications/.test(sql)) pushes.push(b[3]);
      return { meta: { changes: 1 } };
    },
  }; return st; }, batch(s) { return Promise.all(s.map(x => x.run())); } };
  // Mock PO_DB (mostlane-po) so a real subcontractor PO is allocated + recorded.
  const poLog = [];
  const poDb = { prepare(sql) { let b = []; const st = {
    bind(...a) { b = a; return st; },
    async first() { if (/COALESCE\(MIN\(n\)/.test(sql)) return { next: 10011 + poLog.length }; if (/FROM po_log WHERE po_number=\?/.test(sql)) return pos.find(p => String(p.po_number) === String(b[0])) || null; return null; },
    async all() { if (/FROM po_log/.test(sql) && /issued_at >= \?/.test(sql)) return { results: pos }; return { results: [] }; },
    async run() {
      if (/UPDATE po_log SET job_id/.test(sql)) { const p = pos.find(x => String(x.po_number) === String(b[b.length - 1])); if (!p) return { meta: { changes: 0 } }; p.job_id = b.length > 1 ? b[0] : null; p.job_ref = b.length > 1 ? b[1] : null; }
      if (/UPDATE po_log SET cost_ex_vat/.test(sql)) { const p = pos.find(x => String(x.po_number) === String(b[2])); if (!p) return { meta: { changes: 0 } }; p.cost_ex_vat = b[0]; }
      if (/INSERT INTO po_log/.test(sql)) poLog.push({ po_number: b[0], source: b[4], site: b[5], supplier: b[7], cost_category: b[12], trade: b[13], job_id: b[14] });
      return { meta: { changes: 1 } };
    },
  }; return st; } };
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("api.resend.com")) { sent.push(JSON.parse(init.body)); return new Response(sendOk ? "{}" : "boom", { status: sendOk ? 200 : 500 }); }
    return new Response("{}", { status: 200 });
  };
  return { env: { DB: db, PO_DB: poDb, JOB_FILES: null, RESEND_API_KEY: "k", JOBS_INBOUND_TOKEN: "tok" }, saved, idem, sent, pushes, poLog };
}
async function call(E, user, path, body, method = "POST") {
  const url = new URL("https://api.test/sla" + path);
  const req = new Request(url, { method, headers: { "Content-Type": "application/json", ...(user ? {} : { Authorization: "Bearer tok" }) }, body: body ? JSON.stringify(body) : undefined });
  const res = await sla.handle(req, E.env, { waitUntil() {} }, url, user ? { user: { username: user }, tenantId: 1 } : null);
  let j = null; try { j = await res.clone().json(); } catch {}
  return { status: res.status, body: j };
}
let fail = 0; const ok = (n, c, x = "") => { console.log((c ? "PASS" : "FAIL") + "  " + n + (x ? "  → " + x : "")); if (!c) fail++; };

// detection
ok("drain wording flagged", sla.isDrainageJob({ description: "Bakery sink is blocked, water not going down" }));
ok("saniflo flagged", sla.isDrainageJob({ description: "I believe its a saniflow system" }));
ok("EM drain-down NOT flagged", !sla.isDrainageJob({ description: "EM 3h drain-down test", emTest: true }) && !sla.isDrainageJob({ description: "start the drain down timer" }));
ok("leaking tap NOT flagged", !sla.isDrainageJob({ description: "Hot tap in the ISB is leaking" }));
ok("project NOT flagged", !sla.isDrainageJob({ description: "new drain run", siteCode: "P0712" }));
ok("manual override wins both ways", sla.isDrainageJob({ description: "tap", drainage: true }) && !sla.isDrainageJob({ description: "blocked drain", drainage: false }));

// PO-ref formatting (Metro Rod want a 6-digit number, leading zeros)
ok("formatPoRef pads to width", sla.formatPoRef(10011, 6) === "010011", sla.formatPoRef(10011, 6));
ok("formatPoRef no pad when already long enough", sla.formatPoRef(123456, 6) === "123456");
ok("formatPoRef no width → raw", sla.formatPoRef(10011, 0) === "10011");

// email content: the Order No is OUR padded PO number (passed in), not the incident
{ const m = sla.buildMetroRodEmail(JOBS["J-DRAIN"], 4, "010011");
  ok("subject = Mostlane - Emergency - Order <our PO> at <postcode>", m.subject === "Mostlane - Emergency - Order 010011 at PO12 4EH", m.subject);
  ok("order number in the email is the PO, not the incident", /Order No 010011/.test(m.html) && !/00031502/.test(m.html));
  ok("body carries site, phone, target, details", /0129 Gosport/.test(m.html) && /02392 582806/.test(m.html) && /Within 4 Hours/.test(m.html) && /backed up and blocked/.test(m.html));
  ok("body escapes HTML", !/<script/.test(sla.buildMetroRodEmail({ ...JOBS["J-DRAIN"], description: "<script>x</script>" }, 4, "010011").html));
  ok("no poRef → falls back to the incident ref", sla.buildMetroRodEmail(JOBS["J-DRAIN"], 4).subject === "Mostlane - Emergency - Order 00031502/1 at PO12 4EH"); }

// send: permission, one-press lock, record
{ const E = makeEnv();
  const f = await call(E, "Field Eng", "/jobs/J-DRAIN/subcontract", { to: "metrorod" });
  ok("field engineer can't send", f.status === 403);
  const a = await call(E, "Office Admin", "/jobs/J-DRAIN/subcontract", { to: "metrorod" });
  ok("office send → 200 + recorded", a.status === 200 && a.body.subcontract && a.body.subcontract.sentBy === "Office Admin" && E.saved["J-DRAIN"].subcontract, JSON.stringify(a.body && a.body.subcontract));
  ok("a real subcontractor PO was raised (Metro Rod, Drainage, tied to the job)", E.poLog.length === 1 && E.poLog[0].cost_category === "subcontractor" && E.poLog[0].supplier === "Metro Rod" && E.poLog[0].trade === "Drainage" && E.poLog[0].job_id === "J-DRAIN", JSON.stringify(E.poLog[0]));
  ok("subcontract record carries our padded PO (010011)", a.body.subcontract.poNumber === 10011 && a.body.subcontract.poRef === "010011", JSON.stringify({ n: a.body.subcontract.poNumber, r: a.body.subcontract.poRef }));
  ok("the email subject is our PO, not the incident", E.sent[0].subject === "Mostlane - Emergency - Order 010011 at PO12 4EH", E.sent[0].subject);
  ok("email went to the call centre, CC Enquiries, reply-to Jamie", E.sent.length === 1 && E.sent[0].to === "Call.Centre@metrorod.co.uk" && E.sent[0].cc.includes("Enquiries@mostlane.com") && E.sent[0].reply_to === "jamie@mostlane.com");
  const b = await call(E, "Boss", "/jobs/J-DRAIN/subcontract", { to: "metrorod" });
  ok("second press (anyone) → already, NOTHING re-sent", b.body.already && E.sent.length === 1 && b.body.subcontract.sentBy === "Office Admin");
  const v = await call(E, "Office Admin", "/jobs/J-DRAIN/drainage", { value: true });
  ok("job response carries the subcontract + drainage flag", v.body.drainage === true && v.body.subcontract && v.body.subcontract.name === "Metro Rod");
  const c1 = await call(E, "Office Admin", "/jobs/J-DRAIN/subcontract-clear", {});
  ok("clear is Full Access only", c1.status === 403);
  const c2 = await call(E, "Boss", "/jobs/J-DRAIN/subcontract-clear", {});
  ok("Full Access clears the record + releases the lock", c2.status === 200 && !E.saved["J-DRAIN"].subcontract && !E.idem.has("subcon:metrorod:J-DRAIN"));
  const again = await call(E, "Office Admin", "/jobs/J-DRAIN/subcontract", { to: "metrorod" });
  ok("after a clear it can be sent again, REUSING the same PO (no duplicate)", again.status === 200 && !again.body.already && E.sent.length === 2 && E.poLog.length === 1 && again.body.subcontract.poRef === "010011"); }

// a failed email: no "sent" record + lock released, BUT the raised PO is kept so a
// retry reuses it (never allocates a second PO for the same works)
{ const E = makeEnv({ sendOk: false });
  const a = await call(E, "Office Admin", "/jobs/J-DRAIN/subcontract", { to: "metrorod" });
  const fail1 = E.saved["J-DRAIN"] && E.saved["J-DRAIN"].subcontract;
  ok("email failure → 502, lock released, a FAILED marker recorded (no sentAt)", a.status === 502 && !E.idem.has("subcon:metrorod:J-DRAIN") && fail1 && !fail1.sentAt && fail1.failedAt, JSON.stringify(a.body));
  ok("the PO was raised + kept for retry", E.poLog.length === 1 && E.saved["J-DRAIN"] && E.saved["J-DRAIN"].subconPO && E.saved["J-DRAIN"].subconPO.poNumber === 10011);
  const b = await call(E, "Office Admin", "/jobs/J-DRAIN/subcontract", { to: "metrorod" });
  ok("retry reuses the same PO, no second PO raised", b.status === 502 && E.poLog.length === 1);
  const c = await call(E, "Office Admin", "/jobs/J-DRAIN/subcontract", { to: "metrorod" });  // signal comes back
  // (sendOk is still false here, so still fails — just confirm a failed marker never blocks a retry)
  ok("a failed marker never blocks a retry (not treated as 'already sent')", !c.body.already); }

// generic send to a CONFIGURED subcontractor (not just Metro Rod), honouring its fields
{ const E = makeEnv();
  // seed a second subcontractor into the routing list via the admin POST
  const save = await call(E, "Boss", "/subcontractors", { sub: { name: "L&B Glazing", to: "jobs@lbglaze.co.uk", trade: "Glazing", poDigits: 0, areas: ["glazing"], fields: { phone: false } } });
  ok("Full Access can add a subcontractor to the routing list", save.status === 200 && save.body.list.some(s => s.key === "lbglazing"), JSON.stringify(save.body && save.body.list && save.body.list.map(s=>s.key)));
  const la = await call(E, "Office Admin", "/jobs/J-TAP/subcontract", { to: "lbglazing" });
  ok("send to the new subcontractor → emailed to ITS address", la.status === 200 && E.sent[E.sent.length-1].to === "jobs@lbglaze.co.uk", JSON.stringify(la.body && la.body.subcontract));
  ok("subcontract record carries the right key + name", la.body.subcontract.key === "lbglazing" && la.body.subcontract.name === "L&B Glazing");
  ok("its PO used NO padding (poDigits 0)", la.body.subcontract.poRef === String(la.body.subcontract.poNumber)); }

// phone gate: Metro Rod won't accept a job with no phone — block, then accept one
{ const E = makeEnv();
  const a = await call(E, "Office Admin", "/jobs/J-TAP/subcontract", { to: "metrorod" });   // J-TAP has no telephone
  ok("no phone → 400 needPhone, NOTHING raised or sent", a.status === 400 && a.body.needPhone === true && E.poLog.length === 0 && E.sent.length === 0, JSON.stringify(a.body));
  const b = await call(E, "Office Admin", "/jobs/J-TAP/subcontract", { to: "metrorod", phone: "023 9212 3456" });
  ok("re-send WITH a phone → 200, PO raised, phone saved on the job", b.status === 200 && E.poLog.length === 1 && E.saved["J-TAP"] && E.saved["J-TAP"].telephone === "023 9212 3456", JSON.stringify({ tel: E.saved["J-TAP"] && E.saved["J-TAP"].telephone, po: E.poLog.length }));
  ok("the emailed order carries the entered phone", /023 9212 3456/.test(E.sent[0] && E.sent[0].html || "")); }

// subcontractor config GET + normalisation
{ const E = makeEnv();
  const g = await call(E, "Office Admin", "/subcontractors", null, "GET");
  ok("GET /subcontractors lists Metro Rod with its OOH default + areas", g.status === 200 && g.body.list.some(s => s.key === "metrorod" && s.ooh === true) && Array.isArray(g.body.areas), JSON.stringify(g.body && g.body.list && g.body.list.find(s=>s.key==="metrorod")));
  const f = await call(E, "Field Eng", "/subcontractors", null, "GET");
  ok("a field engineer can't read the subcontractor list", f.status === 403);
  // "all office users, no field" — an office user with no SLAAdmin grant CAN manage; a field user WITH SLAAdmin can't.
  const of = await call(E, "SLA Field", "/subcontractors", null, "GET");
  ok("a field engineer WITH an SLAAdmin grant still can't read it", of.status === 403);
  const oe = await call(E, "SLA Field", "/subcontractors", { sub: { name: "X Co", to: "x@x.com" } });
  ok("…nor edit it", oe.status === 403); }

// override endpoint
{ const E = makeEnv();
  const a = await call(E, "Office Admin", "/jobs/J-TAP/drainage", { value: true });
  ok("mark a non-drainage job as drainage", a.status === 200 && a.body.drainage === true && E.saved["J-TAP"].drainage === true);
  const b = await call(E, "Office Admin", "/jobs/J-TAP/drainage", { value: null });
  ok("null → back to automatic", b.body.drainage === false && E.saved["J-TAP"].drainage === undefined); }

// jobs with subcontractors (the list page)
{ const POS = [
    { po_number: 10630, issued_at: new Date(Date.now() - 9 * 864e5).toISOString(), site: "Gosport", supplier: "Handyman In Bristol", cost_category: "subcontractor", trade: "Plumbing", description: "Incident - 31502 leak", incident_no: "31502", job_id: null, job_ref: null, cost_ex_vat: 120, engineer_name: "", office_user_name: "Tanya" },
    { po_number: 10620, issued_at: new Date(Date.now() - 2 * 864e5).toISOString(), site: "Crookhorn", supplier: "Metrorod", cost_category: "subcontractor", trade: "Drainage", description: "blocked sink", incident_no: null, job_id: null, job_ref: null, cost_ex_vat: null, engineer_name: "", office_user_name: "Tanya" },
  ];
  const E = makeEnv({ pos: POS });
  ok("list is office only", (await call(E, "Field Eng", "/subcontracted", null, "GET")).status === 403);
  const a = await call(E, "Office Admin", "/subcontracted", null, "GET");
  const rows = (a.body && a.body.rows) || [];
  const drain = rows.find(r => r.jobId === "J-DRAIN"), poOnly = rows.find(r => r.key === "po:10620");
  ok("PO matched to its job by incident number", drain && drain.pos.length === 1 && drain.subs[0] === "Handyman In Bristol" && drain.state === "open" && drain.days === 9, JSON.stringify(drain && { subs: drain.subs, days: drain.days }));
  ok("PO with no job still listed", poOnly && !poOnly.jobId && poOnly.state === "open");
  const nm = await call(E, "SLA Field", "/subcontracted", null, "GET");
  const nmDrain = (nm.body.rows || []).find(r => r.jobId === "J-DRAIN");
  ok("no £ for a non-money SLA admin", nmDrain && nmDrain.poTotal === undefined && !("cost" in nmDrain.pos[0]));
  const m = await call(E, "Boss", "/subcontracted", null, "GET");
  const md = (m.body.rows || []).find(r => r.jobId === "J-DRAIN");
  ok("£ shown to Full Access", md && md.poTotal === 120 && md.pos[0].cost === 120);
  const h = await call(E, "Office Admin", "/jobs/J-TAP/subcontract", { name: "L&B Plumbing", note: "rang them" });
  ok("record-only hand-off, no email, no PO", h.status === 200 && E.saved["J-TAP"].subcontract.manual && E.sent.length === 0 && E.poLog.length === 0);
  const s1 = await call(E, "Office Admin", "/jobs/J-TAP/subcontract-status", { status: "done" });
  ok("mark done", s1.status === 200 && E.saved["J-TAP"].subcontract.status === "done" && E.saved["J-TAP"].subcontract.closedBy === "Office Admin");
  ok("done completes the job itself", s1.body.completed === true && E.saved["J-TAP"].status === "Complete", JSON.stringify({ c: s1.body.completed, st: E.saved["J-TAP"].status }));
  const s2 = await call(E, "Office Admin", "/jobs/J-DRAIN/subcontract-status", { status: "returned", name: "Handyman In Bristol" });
  ok("returned leaves the job status alone", E.saved["J-DRAIN"].status !== "Complete");
    ok("PO-matched job gets a record when ticked", s2.status === 200 && E.saved["J-DRAIN"].subcontract.fromPo && E.saved["J-DRAIN"].subcontract.status === "returned");
  const n = await call(E, "Office Admin", "/subcontracted?count=1", null, "GET");
  ok("open count drops", n.body.open === 1, JSON.stringify(n.body));
  ok("close a PO-only row", (await call(E, "Office Admin", "/subcontracted/po-status", { key: "po:10620", status: "done" })).status === 200);
  const n2 = await call(E, "Office Admin", "/subcontracted?count=1", null, "GET");
  ok("…and it leaves the open list", n2.body.open === 0, JSON.stringify(n2.body));
  // link a PO-only row to a job by hand, then unlink it
  const sr = await call(E, "Office Admin", "/subcontracted/job-search?q=tap", null, "GET");
  ok("job search finds jobs", sr.status === 200 && Array.isArray(sr.body.jobs), JSON.stringify(sr.body));
  const lk = await call(E, "Office Admin", "/subcontracted/link", { po: "10620", jobId: "J-TAP" });
  ok("link PO-only → job", lk.status === 200 && POS[1].job_id === "J-TAP", JSON.stringify(lk.body));
  const al = await call(E, "Boss", "/subcontracted", null, "GET");
  const tapRow = (al.body.rows || []).find(r => r.jobId === "J-TAP");
  ok("linked PO now sits on the job's row (and no PO-only row)", tapRow && tapRow.pos.some(p => p.number === 10620 && p.match === "linked") && !(al.body.rows || []).some(r => r.key === "po:10620"));
  const ul = await call(E, "Office Admin", "/subcontracted/link", { po: "10620", jobId: null });
  ok("unlink", ul.status === 200 && POS[1].job_id === null);
  const ul2 = await call(E, "Office Admin", "/subcontracted/link", { po: "10630", jobId: null });
  const al2 = await call(E, "Office Admin", "/subcontracted", null, "GET");
  ok("unlinking an incident-matched PO stops the auto match", ul2.status === 200 && (al2.body.rows || []).some(r => r.key === "po:10630"));
  ok("link refuses an unknown PO", (await call(E, "Office Admin", "/subcontracted/link", { po: "999", jobId: "J-TAP" })).status === 404);
  // costs: money users only
  ok("cost: non-money SLA admin refused", (await call(E, "SLA Field", "/subcontracted/cost", { po: "10620", cost: "50" })).status === 403);
  const c1 = await call(E, "Boss", "/subcontracted/cost", { po: "10620", cost: "£1,250.5" });
  ok("cost onto the PO", c1.status === 200 && POS[1].cost_ex_vat === 1250.5, JSON.stringify(c1.body));
  const c2 = await call(E, "Boss", "/subcontracted/cost", { jobId: "J-TAP", cost: "300" });
  ok("cost on a no-PO hand-off record", c2.status === 200 && E.saved["J-TAP"].subcontract.cost === 300);
  ok("cost hidden from a field job read", !("cost" in (sla.stripMoney(E.saved["J-TAP"]).subcontract)));
  ok("bad cost rejected", (await call(E, "Boss", "/subcontracted/cost", { po: "10620", cost: "abc" })).status === 400);
  ok("incidentKey reads 'NNNNN Site' with a space", (sla.incidentKey("30389 Brislington DTU") || {}).inc === "30389" && sla.incidentKey("0129 Gosport") === null); }

// linking / matching a PO puts the "with a subcontractor" record ON the job (SLA board tag)
{ const POS = [
    { po_number: 10630, issued_at: "2026-10-03T09:00:00.000Z", site: "Gosport", supplier: "Handyman In Bristol", cost_category: "subcontractor", trade: "Plumbing", description: "Incident - 31502 leak", incident_no: "31502", job_id: null, job_ref: null, cost_ex_vat: null },
    { po_number: 10620, issued_at: "2026-10-10T09:00:00.000Z", site: "Crookhorn", supplier: "Metrorod", cost_category: "subcontractor", trade: "Drainage", description: "blocked sink", incident_no: null, job_id: null, job_ref: null, cost_ex_vat: null },
  ];
  const E = makeEnv({ pos: POS });
  await call(E, "Office Admin", "/subcontracted", null, "GET");
  const d = E.saved["J-DRAIN"] && E.saved["J-DRAIN"].subcontract;
  ok("incident-matched PO stamps a record on its job", d && d.fromPo && d.name === "Handyman In Bristol" && d.poNumber === 10630 && d.status === "open", JSON.stringify(d));
  await call(E, "Office Admin", "/subcontracted/link", { po: "10620", jobId: "J-TAP" });
  const t = E.saved["J-TAP"] && E.saved["J-TAP"].subcontract;
  ok("hand-linked PO stamps a record on its job", t && t.fromPo && t.name === "Metrorod" && t.sentAt === "2026-10-10T09:00:00.000Z", JSON.stringify(t));
  await call(E, "Office Admin", "/subcontracted/link", { po: "10620", jobId: null });
  ok("unlink removes that record from the job", !E.saved["J-TAP"].subcontract); }

// older subcontractor POs saved as "materials" are still picked up by supplier name
{ const POS = [
    { po_number: 9001, issued_at: new Date(Date.now() - 40 * 864e5).toISOString(), site: "Gosport", supplier: "MetroRod", cost_category: "materials", description: "jetting", incident_no: null, job_id: null, job_ref: null, cost_ex_vat: 200 },
    { po_number: 9002, issued_at: new Date(Date.now() - 40 * 864e5).toISOString(), site: "Gosport", supplier: "Screwfix", cost_category: "materials", description: "screws", incident_no: null, job_id: null, job_ref: null, cost_ex_vat: 5 },
  ];
  const E = makeEnv({ pos: POS });
  const a = await call(E, "Office Admin", "/subcontracted", null, "GET");
  const keys = (a.body.rows || []).map(r => r.key);
  ok("a 'materials' PO to a known subcontractor is listed", keys.includes("po:9001"), JSON.stringify(keys));
  ok("an ordinary supplier PO is not", !keys.includes("po:9002"));
  const k = sla.subconKeysFromNames(["EPM Plumbing & Heating", "The Shower Man", "Montrose Glass", "Mr Electric"]);
  ok("name matching: EPM / Showerman / Montrose yes, merchants no",
    ["EPM", "Showerman", "Montrose"].every(n => sla.isKnownSubcon(n, k)) && !["CEF (City Electrical Factors)", "Electric Center", "Screwfix", "City Plumbing"].some(n => sla.isKnownSubcon(n, k))); }

// the email itself: postcode in the address, padded store code, portal notes stripped
{ const m = sla.buildMetroRodEmail({ siteCode: "148", siteName: "Verwood", address: "Ringwood Road, Verwood", postcode: "bh31 7al", telephone: "01202 823901", priority: "Priority 2",
    description: "Toilet blocked\n↩ Re-assigned incident — follows our earlier visit 31538 (Complete)" }, 24, "010700");
  ok("address carries the postcode", /Ringwood Road, Verwood, BH31 7AL/.test(m.html));
  ok("store code padded to 4 digits", />0148 Verwood</.test(m.html));
  ok("portal ↩ notes are not sent", !/earlier visit/.test(m.html) && m.details === "Toilet blocked");
  const e = sla.buildMetroRodEmail({ address: "1 High St, PO12 4EH", postcode: "PO12 4EH" }, 0, "1", null, { details: "Edited text" });
  ok("postcode not doubled + details override used", !/PO12 4EH, PO12 4EH/.test(e.html) && /Edited text/.test(e.html)); }

// preview before send + test copy + edited details actually sent
{ const E = makeEnv();
  const p = await call(E, "Office Admin", "/jobs/J-DRAIN/subcontract-preview", { to: "metrorod" });
  ok("preview: recipients + the NEXT PO number, nothing raised or sent", p.status === 200 && p.body.to === "Call.Centre@metrorod.co.uk" && /Order 010011 at/.test(p.body.subject) && /next number/.test(p.body.poNote) && E.poLog.length === 0 && E.sent.length === 0, JSON.stringify(p.body && { s: p.body.subject, w: p.body.warnings }));
  ok("field engineer can't preview", (await call(E, "Field Eng", "/jobs/J-DRAIN/subcontract-preview", { to: "metrorod" })).status === 403);
  const t = await call(E, "Office Admin", "/jobs/J-DRAIN/subcontract-preview", { to: "metrorod", test: true, details: "Changed" });
  ok("test copy goes to ME only, marked TEST, no PO", t.status === 200 && E.sent.length === 1 && E.sent[0].to === "office@mostlane.test" && /^\[TEST/.test(E.sent[0].subject) && /Changed/.test(E.sent[0].html) && E.poLog.length === 0, JSON.stringify(E.sent[0] && E.sent[0].to));
  const nb = await call(E, "Boss", "/jobs/J-DRAIN/subcontract-preview", { to: "metrorod", test: true });
  ok("no email on my user → clear error", nb.status === 400 && /no email address/.test(nb.body.error));
  const s = await call(E, "Office Admin", "/jobs/J-DRAIN/subcontract", { to: "metrorod", details: "Please jet the drain" });
  const last = E.sent[E.sent.length - 1];
  ok("the real send uses the number the preview showed", /Order 010011 at/.test(E.sent[E.sent.length - 1].subject));
  ok("the edited details are what Metro Rod receives", s.status === 200 && last.to === "Call.Centre@metrorod.co.uk" && /Please jet the drain/.test(last.html) && E.saved["J-DRAIN"].description !== "Please jet the drain", JSON.stringify(s.body && s.body.error)); }

// invoicing line + "we can't take this job" link (per-subcontractor setting)
{ const E = makeEnv(); E.env.PORTAL_BRIDGE_SECRET = "test-secret";
  const raw = async (href, method = "GET", form) => {
    const u = new URL(href);
    const init = { method };
    if (form) { init.body = new URLSearchParams(form).toString(); init.headers = { "Content-Type": "application/x-www-form-urlencoded" }; }
    const queued = [];
    const res = await sla.handle(new Request(u, init), E.env, { waitUntil(p) { queued.push(p); } }, u, null);
    return { status: res.status, text: await res.text(), queued: queued.length };
  };
  const off = sla.buildMetroRodEmail(JOBS["J-DRAIN"], 4, "010011");
  ok("every order email tells them invoices must quote the PO", /must quote our PO number 010011/.test(off.html));
  ok("no 'can't take' link unless the subcontractor is set up for it", !/subcon-reply/.test(off.html));
  const cfg = await call(E, "Boss", "/subcontractors", { sub: { name: "Metro Rod", to: "Call.Centre@metrorod.co.uk", cc: ["Enquiries@mostlane.com"], trade: "Drainage", poDigits: 6, requirePhone: true, declineLink: true } });
  ok("setting saves", cfg.status === 200 && cfg.body.list.find(x => x.key === "metrorod").declineLink === true, JSON.stringify(cfg.body && cfg.body.error));
  const pv = await call(E, "Office Admin", "/jobs/J-DRAIN/subcontract-preview", { to: "metrorod" });
  const testHref = (pv.body.html.match(/href="([^"]*subcon-reply[^"]*)"/) || [])[1];
  ok("preview carries the link (a TEST link)", !!testHref);
  const tp = await raw(testHref.replace(/&amp;/g, "&"), "POST", { reason: "x" });
  ok("pressing a TEST link records nothing", tp.status === 200 && /TEST email/.test(tp.text) && !(E.saved["J-DRAIN"] && E.saved["J-DRAIN"].subcontract));
  await call(E, "Office Admin", "/jobs/J-DRAIN/subcontract", { to: "metrorod" });
  const sent = E.sent[E.sent.length - 1];
  const href = ((sent.html.match(/href="([^"]*subcon-reply[^"]*)"/) || [])[1] || "").replace(/&amp;/g, "&");
  ok("real order email has the link + the invoicing line", !!href && /must quote our PO number 010011/.test(sent.html) && /accepted this job/.test(sent.html));
  const g = await raw(href);
  ok("opening the link only shows a confirm page (mail scanners can't trigger it)", g.status === 200 && /<form method="post"/.test(g.text) && !E.saved["J-DRAIN"].subcontract.declined);
  const bad = await raw(href.replace(/sig=[0-9a-f]{4}/, "sig=0000"));
  ok("tampered link refused", bad.status === 403);
  const p1 = await raw(href, "POST", { reason: "No engineer until Thursday" });
  const sc = E.saved["J-DRAIN"].subcontract;
  ok("confirming records it, back with us, office told", p1.status === 200 && sc.status === "returned" && sc.declined && sc.declined.reason === "No engineer until Thursday" && p1.queued > 0, JSON.stringify(sc));
  const p2 = await raw(href, "POST", { reason: "again" });
  ok("pressing twice says already received", /Already received/.test(p2.text) && E.saved["J-DRAIN"].subcontract.declined.reason === "No engineer until Thursday");
  const again = await call(E, "Office Admin", "/jobs/J-DRAIN/subcontract-preview", { to: "metrorod" });
  ok("office can then send the job elsewhere (not blocked as 'already sent')", again.status === 200); }

// PO with no incident: description job number links; otherwise a SUGGESTION only
{ const jobs = [
    { id: "J-W", helpdeskRef: "29339-Worle JS", siteCode: "9649", siteName: "Worle JS", address: "Sainsbury Queensway, Worle, Somerset", createdAt: "2026-09-18T09:00:00Z", status: "Co-op Pending", description: "The strip lights which run along the seating area" },
    { id: "J-E", helpdeskRef: "25617-Eastleigh, Leigh Road", siteCode: "60", siteName: "Eastleigh, Leigh Road", address: "Leigh Road, Eastleigh, Southampton", createdAt: "2026-07-23T09:00:00Z", status: "Closed Jobs", description: "Ceiling tile fell" },
  ];
  const df = sla.siteWordFreq(jobs);
  const w = sla.suggestJobsForPo({ issued_at: "2026-09-29T10:00:00Z", site: "Starbucks, Worle", description: "Attend site to fix striplights" }, jobs, df);
  ok("Worle striplights PO → suggests 29339-Worle JS", w[0] && w[0].jobId === "J-W" && /striplights/.test(w[0].why));
  const a = sla.suggestJobsForPo({ issued_at: "2026-07-21T10:00:00Z", site: "32B Archers Road, Southampton - Chapplins", description: "blocked toilet" }, jobs, df);
  ok("a town name alone is not enough", a.length === 0, JSON.stringify(a));
  const POS = [{ po_number: 10450, issued_at: new Date(Date.now() - 5 * 864e5).toISOString(), site: null, supplier: "Metrorod", cost_category: "subcontractor", description: "quoted works FOR JOB 31502/2", incident_no: "22589/2", job_id: null, job_ref: null, cost_ex_vat: null }];
  const E = makeEnv({ pos: POS });
  const r = await call(E, "Office Admin", "/subcontracted", null, "GET");
  ok("mistyped incident box but 'FOR JOB nnnnn' in the description → linked to that job", (r.body.rows || []).some(x => x.jobId === "J-DRAIN" && x.pos.some(p => p.number === 10450)), JSON.stringify((r.body.rows||[]).map(x=>x.key))); }

// "Sent to Subcontractor" status
{ const E = makeEnv();
  const cats = await call(E, "Office Admin", "/categories", null, "GET");
  const list = Array.isArray(cats.body) ? cats.body : (cats.body.categories || cats.body.list || []);
  ok("the category is always there", list.some(c => c.name === "Sent to Subcontractor" && c.system), JSON.stringify(cats.body).slice(0, 200));
  ok("…and can't be deleted", (await call(E, "Office Admin", "/categories/delete", { name: "Sent to Subcontractor" })).status === 400);
  await call(E, "Office Admin", "/jobs/J-DRAIN", { status: "Scheduled" }, "PATCH");
  await call(E, "Office Admin", "/jobs/J-DRAIN/subcontract", { to: "metrorod" });
  ok("sending moves the job into it, remembering the old status", E.saved["J-DRAIN"].status === "Sent to Subcontractor" && E.saved["J-DRAIN"].subcontract.prevStatus === "Scheduled", E.saved["J-DRAIN"].status);
  await call(E, "Office Admin", "/jobs/J-DRAIN/subcontract-status", { status: "returned" });
  ok("back with us → the old status comes back", E.saved["J-DRAIN"].status === "Scheduled", E.saved["J-DRAIN"].status);
  await call(E, "Office Admin", "/jobs/J-DRAIN/subcontract-status", { status: "open" });
  ok("reopen → Sent to Subcontractor again", E.saved["J-DRAIN"].status === "Sent to Subcontractor");
  await call(E, "Office Admin", "/jobs/J-DRAIN/subcontract-status", { status: "done" });
  ok("done by them → Complete", E.saved["J-DRAIN"].status === "Complete");
  await call(E, "Office Admin", "/jobs/J-TAP/subcontract", { name: "L&B Plumbing" });
  ok("a hand-off (no email) also moves it", E.saved["J-TAP"].status === "Sent to Subcontractor");
  await call(E, "Office Admin", "/jobs/J-TAP", { status: "Scheduled" }, "PATCH");
  await call(E, "Office Admin", "/subcontracted", null, "GET");
  ok("an office status change afterwards is never overridden", E.saved["J-TAP"].status === "Scheduled", E.saved["J-TAP"].status); }

{ // Microsoft 365 sending (as enquiries@) with fallback to the portal's mail
  const calls = []; let graphOk = true;
  globalThis.fetch = async (url, init) => {
    url = String(url); calls.push({ url, body: init && init.body });
    if (url.includes("login.microsoftonline.com")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
    if (url.includes("/sendMail")) return graphOk ? new Response(null, { status: 202 }) : new Response(JSON.stringify({ error: { code: "ErrorAccessDenied", message: "Access is denied." } }), { status: 403 });
    if (url.includes("api.resend.com")) return new Response("{}", { status: 200 });
    return new Response("{}", { status: 404 });
  };
  const appConfig = {};
  const db = { prepare(sql) { let b = []; const st = { bind(...a) { b = a; return st; },
    async first() { return /app_config/.test(sql) && appConfig[b[1]] ? { value: appConfig[b[1]] } : null; },
    async run() { if (/INSERT INTO app_config/.test(sql)) appConfig[b[1]] = b[2]; return {}; } }; return st; } };
  const env = { DB: db, GRAPH_TENANT_ID: "x", GRAPH_CLIENT_ID: "y", GRAPH_CLIENT_SECRET: "z", RESEND_API_KEY: "k" };
  let r = await sla.sendSubconMail(env, 1, { to: "a@b.c", cc: ["Enquiries@mostlane.com"], subject: "S", html: "<p>h</p>" });
  const sm = calls.find(c => c.url.includes("/sendMail"));
  ok("365: sends AS enquiries@ by default", r.ok && r.via === "m365" && sm && sm.url.includes("/users/enquiries%40mostlane.com/sendMail"), JSON.stringify(r));
  const msg = JSON.parse(sm.body);
  ok("365: saves to Sent Items, CC + reply-to carried", msg.saveToSentItems === true && msg.message.ccRecipients[0].emailAddress.address === "Enquiries@mostlane.com" && msg.message.replyTo[0].emailAddress.address === "enquiries@mostlane.com");
  ok("365: no portal (Resend) send when 365 works", !calls.some(c => c.url.includes("resend")));
  graphOk = false; calls.length = 0;
  r = await sla.sendSubconMail(env, 1, { to: "a@b.c", subject: "S", html: "h" });
  ok("365 refused → falls back to portal mail, says why", r.ok && r.via === "portal" && /403/.test(r.fallbackReason) && calls.some(c => c.url.includes("resend")), JSON.stringify(r));
  const rs = JSON.parse(calls.find(c => c.url.includes("resend")).body);
  ok("fallback keeps replies going to the mailbox", rs.reply_to === "enquiries@mostlane.com");
  r = await sla.sendSubconMail({ DB: db, RESEND_API_KEY: "k" }, 1, { to: "a@b.c", subject: "S", html: "h" });
  ok("no 365 connection → portal mail", r.ok && r.via === "portal" && /isn't set up/.test(r.fallbackReason));
  appConfig["sla:subconsender:1"] = JSON.stringify({ mailbox: "orders@mostlane.com" }); graphOk = true; calls.length = 0;
  r = await sla.sendSubconMail(env, 1, { to: "a@b.c", subject: "S", html: "h" });
  ok("the sending mailbox is configurable", r.from === "orders@mostlane.com" && calls.some(c => c.url.includes("orders%40mostlane.com")));
  appConfig["sla:subconsender:1"] = JSON.stringify({ from: "enquiries@mostlane.com", via: "jamie@mostlane.com" }); calls.length = 0;
  r = await sla.sendSubconMail(env, 1, { to: "a@b.c", subject: "S", html: "h" });
  const am = calls.find(c => c.url.includes("/sendMail"));
  ok("alias: sent through jamie@ AS enquiries@", r.ok && r.from === "enquiries@mostlane.com" && am.url.includes("jamie%40mostlane.com") && JSON.parse(am.body).message.from.emailAddress.address === "enquiries@mostlane.com");
}

console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
