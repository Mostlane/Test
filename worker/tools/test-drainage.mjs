// Drainage → Metro Rod (replaces the drainage Zap). Mock D1 + a mocked Resend.
// Run: node --no-warnings worker/tools/test-drainage.mjs
import * as sla from "../src/routes/sla.js";

const JOBS = {
  "J-DRAIN": { id: "J-DRAIN", helpdeskRef: "00031502/1", status: "Co-op Pending", priority: "Priority 1", siteCode: "0129", siteName: "Gosport",
    address: "Palmyra Road, 66, Elson, Gosport, Hampshire, PO12 4EH", postcode: "PO12 4EH", telephone: "02392 582806",
    description: "Drain outside the toilet door is backed up and blocked.", createdAt: "2026-10-10T08:18:00.000Z" },
  "J-TAP": { id: "J-TAP", helpdeskRef: "00031474", status: "Co-op Pending", priority: "Priority 2", siteCode: "0380", description: "Hot tap leaking", createdAt: "2026-10-09T14:04:00.000Z" },
};
const PERMS = { "Office Admin": ["SLAAdmin"], "Boss": ["FullAccess"], "Field Eng": [] };

function makeEnv({ sendOk = true } = {}) {
  const saved = {}; const idem = new Set(); const sent = []; const pushes = []; const appConfig = {};
  const rows = () => Object.values({ ...JOBS, ...saved });
  const db = { prepare(sql) { let b = []; const st = {
    bind(...a) { b = a; return st; },
    async first() {
      if (/FROM sla_jobs WHERE tenant_id = \? AND id = \?/.test(sql)) { const j = rows().find(j => j.id === b[1]); return j ? { data: JSON.stringify(j) } : null; }
      if (/FROM app_config/.test(sql)) { const key = /key\s*=\s*\?/.test(sql) ? b[b.length - 1] : (sql.match(/key\s*=\s*'([^']+)'/) || [])[1]; return appConfig[key] != null ? { value: appConfig[key] } : null; }
      return null;
    },
    async all() {
      if (/FROM user_permissions/.test(sql)) return { results: (PERMS[b[1]] || []).map(p => ({ permission: p, username: b[1] })) };
      if (/helpdesk_ref=\?/.test(sql)) return { results: rows().filter(j => j.helpdeskRef === b[1]).map(j => ({ data: JSON.stringify(j) })) };
      if (/helpdesk_ref LIKE \?/.test(sql)) return { results: [] };
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
    async first() { if (/COALESCE\(MIN\(n\)/.test(sql)) return { next: 10011 + poLog.length }; return null; },
    async all() { return { results: [] }; },
    async run() {
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

// subcontractor config GET + normalisation
{ const E = makeEnv();
  const g = await call(E, "Office Admin", "/subcontractors", null, "GET");
  ok("GET /subcontractors lists Metro Rod with its OOH default + areas", g.status === 200 && g.body.list.some(s => s.key === "metrorod" && s.ooh === true) && Array.isArray(g.body.areas), JSON.stringify(g.body && g.body.list && g.body.list.find(s=>s.key==="metrorod")));
  const f = await call(E, "Field Eng", "/subcontractors", null, "GET");
  ok("a field engineer can't read the subcontractor list", f.status === 403); }

// override endpoint
{ const E = makeEnv();
  const a = await call(E, "Office Admin", "/jobs/J-TAP/drainage", { value: true });
  ok("mark a non-drainage job as drainage", a.status === 200 && a.body.drainage === true && E.saved["J-TAP"].drainage === true);
  const b = await call(E, "Office Admin", "/jobs/J-TAP/drainage", { value: null });
  ok("null → back to automatic", b.body.drainage === false && E.saved["J-TAP"].drainage === undefined); }

console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
