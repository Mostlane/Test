// Email → job intake (emailjob.js + emailtemplates.js) — drives the real handler
// with a mock D1, a mocked /sla/inbound and a mocked client-orders intake.
// SYNTHETIC fixtures only (shaped like the real layouts; no customer data).
// Run:  node worker/tools/test-email-intake.mjs
import * as ej from "../src/routes/emailjob.js";
import { matchTemplate, lookupSite } from "../src/routes/emailtemplates.js";

/* ── Fixtures ─────────────────────────────────────────────────────────────── */
const HTML = `<table><tr><td><div>Concerto</div><div>Notification sent on</div><div>Tue 08 September 2026 at 3:45 PM</div></td></tr></table>
<div><p>Hi Mostlane,</p><p><br /></p><p>You have been assigned a new job: 00099999/2</p><p>This has an SLA of Priority 1</p>
<p>With a target Response Date &amp; Time: 08/Sep/2026 19:44</p><p>With a target Completion Date &amp; Time: 09/Sep/2026 15:44</p>
<p>Site: 0000 - Test Store - Anytown, 1 , High Street, Anytown, Hampshire, AB1 2CD</p>
<p>Fault/Issue: Ceiling : Requires Attention - water dripping by the kitchen door ACCESS TIMES: 10 til 4 Monday to Friday. Branch Number 01234567890</p>
<p><a href="https://example.concerto.co.uk/">Click here to login to Concerto</a></p></div>`;
const b64 = s => Buffer.from(s, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
const mail = (from, subject, mid, html, plain) => [
  "From: " + from, "To: enquiries@example.com", "Subject: " + subject, "Message-ID: <" + mid + ">", "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="MIX"', "", "--MIX", 'Content-Type: multipart/alternative; boundary="ALT"', "",
  ...(plain ? ["--ALT", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: quoted-printable", "", plain] : []),
  "--ALT", "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64", "", b64(html), "--ALT--",
  "--MIX", 'Content-Type: application/pdf; name="order.pdf"', "Content-Transfer-Encoding: base64", "", b64("%PDF-1.4 not really"), "--MIX--", ""
].join("\r\n");
const rawDirect = mail("noreply@concerto.co.uk", "New Job Alert: 00099999/2 - Priority 1", "test-1@concerto", HTML,
  "Hi Mostlane,=0D=0AYou have been assigned a new job: 00099999/2=0D=0AThis has an SLA of Priority 1=0D=0AWith a target Response Date & Time: 08/Sep/2026 19:44=0D=0AWith a target Completion Date & Time: 09/Sep/2026 15:44=0D=0ASite: 0000 - Test Store - Anytown, 1 , High Street, Anytown, Hampshire, AB1 2CD=0D=0AFault/Issue: Ceiling : Requires Attention - water dripping by the kitchen door ACCESS TIMES: 10 til 4 Monday to Friday. Branch Number 01234567890=0D=0AClick here to login to Concerto");
// Outlook "forward as attachment": outer mail from the office, original as message/rfc822
const rawFwdAttach = [
  "From: office@example.com", "To: jobs@example.com", "Subject: FW: New Job Alert: 00099999/2 - Priority 1", "Message-ID: <test-2@outlook>",
  "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="OUT"', "", "--OUT", "Content-Type: text/plain", "", "", "--OUT", "Content-Type: message/rfc822", "", rawDirect, "--OUT--", ""
].join("\r\n");
// Inline forward: only HTML, with the From: block at the top
const rawFwdInline = [
  "From: office@example.com", "Subject: FW: New Job Alert: 00099999/2 - Priority 1", "Message-ID: <test-3@outlook>", "MIME-Version: 1.0",
  "Content-Type: text/html; charset=utf-8", "", "<div>From: noreply@concerto.co.uk &lt;noreply@concerto.co.uk&gt;<br>Sent: 08 September 2026 15:45<br>To: Enquiries<br>Subject: New Job Alert</div>" + HTML, ""
].join("\r\n");
// Concerto ORDER SHEET (client purchase order) — the real layout, synthetic values
const ORDER_HTML = `<table><tr><td><div>Concerto</div><div>Notification sent on</div><div>Tue 08 September 2026 at 3:27 PM</div></td></tr></table>
<div><div>Order number 00099999/2</div><div>Please find the attached order sheet for order number 00099999/2</div>
<div><b>Priority : </b>Priority 3</div><div><b>Order value : </b>£439.00</div>
<div>Return to site to replace the defective door closer.<br /><br />Labour - 150.00<br />Materials - 289.00</div>
<div><b>For : </b><div style="margin-left:20px">0000 - Test Store - Anytown, High Street SR00999</div></div></div>`;
const rawOrder = mail("noreply@concerto.co.uk", "Order number 00099999/2 from Southern Coop", "test-order@concerto", ORDER_HTML);
const rawApproved = mail("noreply@concerto.co.uk", "Helpdesk action - AM01. Approved : 00099999", "test-appr@concerto",
  `<div><b>Helpdesk reference : </b>00099999</div><div><b>Description : </b>door hinge broken</div><div><b>Site : </b>SR00999 0000 - Test Store</div><div>Contractor assigned : Mostlane.</div>`);
// Chapplins — ashley@ layout (subject = "P1 - address", body with Tenant/Name/Property…)
const CHAP_HTML = `Dear All<br /><br />A new job has been raised with the following details:<br /><br />Tenant: TEST01<br />Name: Test Tenant &amp; Partner<br />Property: 159a Fratton Road, Portsmouth, PO1 5ET<br />Home Telephone: <br />Mobile: 07700 900123<br />E-mail: tenant@example.com<br /><br />Tradesman: Mostlane<br />Job Number: 260730999<br />Date Job Entered: 08/09/2026<br />Job Description: <br />Hi All<br /><br />The shop below this flat still reports a leak, can someone please attend asap to rectify the leak and the damaged ceiling below.<br /><br />Ashley Newell<br /><br />Chapplins Lettings Limited<br />62-66 Station Road<br />Liss<br />GU33 7AA<br />01730 774200`;
const rawChap = mail("ashley@chapplins.co.uk", "P1 - 159a Fratton Road, Portsmouth, PO1 5ET.", "test-chap1@fpp.local", CHAP_HTML);
// Chapplins — support@ layout (no Tenant line, "Dear Joe", subject "New job raised: Job Number N")
const CHAP2_HTML = `Dear Joe<br /><br />A new job has been raised with the following details:<br /><br />Property: Flat 8 Badger Court, Bishopstoke, Eastleigh, Southampton, SO50 8JY<br />Tradesman: Mostlane<br />Job Number: 4999<br />Date Job Entered: 25/08/2026<br />Job Description: <br /><br />Hello,<br /><br />The tenants report the second bedroom door won't open. Can you attend today and make the repair please.<br /><br /><br />Many Thanks<br /><br />Chapplins Support <br /><br />Chapplins Residential Lettings Limited<br />62-66 Station Road`;
const rawChap2 = mail("support@chapplins.co.uk", "New job raised: Job Number 4999      --    P2", "test-chap2@fpp.local", CHAP2_HTML);
// Chapplins — an estimate request (subject "Urgent Estimate required - address")
const rawChap3 = mail("ashley@chapplins.co.uk", "Urgent Estimate required - Archers Road Communal , 32 Archers Road, Southampton, , SO15 2LT.", "test-chap3@fpp.local",
  CHAP_HTML.replace("159a Fratton Road, Portsmouth, PO1 5ET", "Archers Road Communal , 32 Archers Road, Southampton, SO15 2LT").replace("260730999", "260730998").replace(/The shop below[^<]+/, "Could we please have a quote for a replacement door entry system."));
// Chapplins — a broken one (no job number) → must be HELD, never created
const rawChapBroken = mail("ashley@chapplins.co.uk", "6 Test Road, Anytown, AB1 2CD", "test-chap4@fpp.local", CHAP_HTML.replace(/Job Number: \d+<br \/>/, ""));
// Metro Rod job card + our own drainage-zap email
const rawMetro = mail("dorset.example@metrorod.co.uk", "293999", "test-metro@metrorod", `<div>Please find attached our job card and photos following our visit. Job Number: 1572999 Metro Rod Job Card</div>`);
const rawZap = mail("office@mostlane.com", "Send 280999 to MetroRod", "test-zap@outlook", `<div>Possible MetroRod job received</div><div>Send the below to MetroRod?</div><div>Site</div><div>Test Store</div>`);
// Unknown layout from an allowed sender
const rawUnknown = mail("someone@mostlane.com", "Leak at the test site", "test-unknown@outlook", `<div>Hi, can you send someone to Test Store, there's water coming through the ceiling. Thanks</div>`);

const CHAP_SITES = [
  { site_number: "4007", site_name: "159a Fratton Road, Portsmouth, PO1 5ET", postcode: "PO1 5ET" },
  { site_number: "4012", site_name: "32A Archers Road, Southampton, SO15 2LT", postcode: "SO15 2LT" },
  { site_number: "4013", site_name: "32B Archers Road, Southampton, SO15 2LT", postcode: "SO15 2LT" },
  { site_number: "4026", site_name: "Archers Road Communal, 32 Archers Road, Southampton, SO15 2LT", postcode: "SO15 2LT" },
  { site_number: "4079", site_name: "Flat 15 Badger Court, Bishopstoke, Eastleigh, Southampton, SO50 8JY", postcode: "SO50 8JY" },
];

function makeEnv(extraEnv = {}) {
  const rows = []; let cfgValue = null; const calls = [];
  const db = { prepare(sql) { let binds = []; const st = {
    bind(...a) { binds = a; return st; },
    async run() { calls.push(sql.slice(0, 60));
      if (/INSERT INTO inbound_emails/.test(sql)) { rows.push({ id: rows.length + 1, tenant_id: binds[0], message_id: binds[1], received_at: binds[2], from_addr: binds[3], orig_from: binds[4], subject: binds[5], outcome: binds[6], reason: binds[7], reference: binds[8], job_id: binds[9], status_code: binds[10], fields: binds[11], text: binds[12] }); return { meta: { last_row_id: rows.length } }; }
      if (/UPDATE inbound_emails SET outcome='dismissed'/.test(sql)) { const r = rows.find(r => r.id === binds[2]); if (r) { r.outcome = "dismissed"; r.reason = binds[0]; } }
      else if (/UPDATE inbound_emails SET outcome=\?/.test(sql)) { const r = rows.find(r => r.id === binds[7]); if (r) { r.outcome = binds[0]; r.reason = binds[1]; r.reference = binds[2]; r.job_id = binds[3]; r.fields = binds[5]; } }
      if (/INSERT INTO app_config/.test(sql)) cfgValue = binds[2];
      return { meta: {} }; },
    async first() { calls.push(sql.slice(0, 60));
      if (/FROM app_config/.test(sql)) return cfgValue ? { value: cfgValue } : null;
      if (/FROM inbound_emails WHERE tenant_id=\? AND message_id=\?/.test(sql)) return rows.find(r => r.message_id === binds[1] && /created|updated|order/.test(r.outcome)) || null;
      if (/FROM inbound_emails WHERE tenant_id=\? AND id=\?/.test(sql)) return rows.find(r => r.id === binds[1]) || null;
      if (/COUNT\(\*\) AS n FROM inbound_emails/.test(sql)) return { n: rows.filter(r => r.outcome === "review").length };
      if (/ORDER BY id DESC LIMIT 1/.test(sql)) return rows[rows.length - 1] || null;
      return null; },
    async all() { calls.push(sql.slice(0, 60));
      if (/FROM sites WHERE/.test(sql)) { const pc = binds[2]; return { results: pc ? CHAP_SITES.filter(s => s.postcode.replace(/\s/g, "") === pc) : CHAP_SITES }; }
      if (/FROM user_permissions/.test(sql)) return { results: binds.some(b => /jamie/i.test(String(b))) ? [{ permission: "FullAccess", value: 1 }] : [] };
      if (/GROUP BY outcome/.test(sql)) { const c = {}; rows.forEach(r => c[r.outcome] = (c[r.outcome] || 0) + 1); return { results: Object.entries(c).map(([outcome, n]) => ({ outcome, n })) }; }
      if (/FROM inbound_emails/.test(sql)) return { results: rows.slice().reverse() };
      return { results: [] }; },
  }; return st; } };
  const inbound = [], orders = [];
  const fetchSelf = async (req) => { const body = await req.json(); const u = new URL(req.url);
    if (u.pathname === "/certs/remedials/order-inbound") { orders.push({ auth: req.headers.get("authorization"), body }); return new Response(JSON.stringify({ ok: true, id: "ord-1", matched: false }), { status: 200, headers: { "content-type": "application/json" } }); }
    inbound.push({ auth: req.headers.get("authorization"), body });
    return new Response(JSON.stringify({ ok: true, created: inbound.length === 1, id: "JOB-" + body.reference, reference: body.reference }), { status: 200, headers: { "content-type": "application/json" } }); };
  return { env: { DB: db, JOBS_INBOUND_TOKEN: "tok", ...extraEnv }, rows, inbound, orders, fetchSelf, calls };
}
function msgOf(raw, from) { return { from, headers: { get: k => { const m = new RegExp("^" + k + ":\\s*(.+)$", "im").exec(raw.split(/\r?\n\r?\n/)[0]); return m ? m[1] : null; } }, raw: new Blob([raw]).stream() }; }
let fail = 0; const ok = (name, cond, extra = "") => { console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra ? "  → " + extra : "")); if (!cond) fail++; };
const run = async (E, raw, from) => { await ej.handleInboundEmail(msgOf(raw, from), E.env, {}, E.fetchSelf); return E.rows[E.rows.length - 1]; };

{ // 1. Concerto job straight from Concerto → job created by the TEMPLATE (no AI key)
  const E = makeEnv();
  const r = await run(E, rawDirect, "noreply@concerto.co.uk"); const p = E.inbound[0] && E.inbound[0].body;
  ok("concerto: job created via /sla/inbound", r.outcome === "created" && E.inbound.length === 1 && E.inbound[0].auth === "Bearer tok", r.outcome + " / " + r.reason);
  ok("concerto: fields extracted", p && p.reference === "00099999/2" && p.priority === "Priority 1" && p.siteCode === "0000" && p.postcode === "AB1 2CD" && /water dripping/.test(p.description) && p.telephone === "01234567890", JSON.stringify(p));
  const f = JSON.parse(r.fields);
  ok("concerto: target dates read as London time", f.respondBy === "2026-09-08T18:44:00.000Z" && f.completeBy === "2026-09-09T14:44:00.000Z", f.respondBy + " " + f.completeBy);
  ok("concerto: text/plain preferred, PDF ignored", r.text.includes("Hi Mostlane") && !r.text.includes("%PDF"));
  const r2 = await run(E, rawDirect, "noreply@concerto.co.uk");
  ok("same message-id again → duplicate, not re-created", r2.outcome === "duplicate" && E.inbound.length === 1, r2.reason);
  ok("concerto '(CON)' priority variant", matchTemplate("noreply@concerto.co.uk", "New Job Alert: 00099998/1 - Priority 2 (CON)", "You have been assigned a new job: 00099998/1\nThis has an SLA of Priority 2 (CON)\nSite: 0427 - Test, Road, Town, AB1 2CD\nFault/Issue: thing").result.fields.priority === "Priority 2");
}
{ // 2. forwards (as attachment / inline) still resolve to the Concerto template
  const E = makeEnv();
  const a = await run(E, rawFwdAttach, "office@example.com");
  ok("forward-as-attachment: job created from the wrapped original", a.outcome === "created" && E.inbound[0].body.reference === "00099999/2", a.outcome + " / " + a.reason);
  const E2 = makeEnv();
  const b = await run(E2, rawFwdInline, "office@example.com");
  ok("inline forward: original sender recovered + job created", b.outcome === "created" && b.orig_from === "noreply@concerto.co.uk" && E2.inbound[0].body.reference === "00099999/2", b.outcome + " / " + b.orig_from + " / " + b.reason);
}
{ // 3. allow-list: a random sender is ignored (no AI spend, nothing created, nothing held)
  const E = makeEnv();
  const r = await run(E, rawDirect.replace("From: noreply@concerto.co.uk", "From: spam@random.example"), "spam@random.example");
  ok("unknown sender → ignored, nothing created", r.outcome === "ignored" && E.inbound.length === 0, r.reason);
}
{ // 4. Concerto ORDER SHEET → filed as a client order (not the job board)
  const E = makeEnv();
  const r = await run(E, rawOrder, "noreply@concerto.co.uk"); const o = E.orders[0] && E.orders[0].body;
  ok("order sheet → client-orders intake, no job", r.outcome === "order" && E.inbound.length === 0 && E.orders.length === 1 && E.orders[0].auth === "Bearer tok", r.outcome + " / " + r.reason);
  ok("order fields", o && o.orderNumber === "00099999/2" && o.priority === 3 && o.orderValue === 439 && o.storeCode === "0000" && o.srRef === "SR00999" && /door closer/.test(o.description) && o.externalId === "<test-order@concerto>", JSON.stringify(o));
  const a = await run(E, rawApproved, "noreply@concerto.co.uk");
  ok("helpdesk 'Approved' notice → dropped", a.outcome === "dropped" && /approval notice/.test(a.reason), a.reason);
}
{ // 5. Chapplins — ashley@ layout, matched to the portal site
  const E = makeEnv();
  const r = await run(E, rawChap, "ashley@chapplins.co.uk"); const p = E.inbound[0] && E.inbound[0].body;
  ok("chapplins: job created", r.outcome === "created" && E.inbound.length === 1, r.outcome + " / " + r.reason);
  ok("chapplins: fields", p && p.reference === "CHAP-260730999" && p.priority === "Priority 1" && p.siteCode === "4007" && p.postcode === "PO1 5ET" && p.storeType === "chapplins" && p.telephone === "07700 900123" && /shop below this flat/.test(p.description) && /Tenant: Test Tenant & Partner \(TEST01\) · Mobile: 07700 900123 · Email: tenant@example.com$/.test(p.description) && !/Ashley Newell|Station Road/.test(p.description) && p.raisedAt === "2026-09-08T09:00:00.000Z", JSON.stringify(p));
  // support@ layout, property NOT in the register (Flat 8 vs Flat 15) → job still lands, no site code
  const r2 = await run(E, rawChap2, "support@chapplins.co.uk"); const p2 = E.inbound[1] && E.inbound[1].body;
  ok("chapplins support@ layout: job created, unmatched property carries the address", r2.outcome === "updated" && p2.reference === "CHAP-4999" && p2.priority === "Priority 2" && !p2.siteCode && /Flat 8 Badger Court/.test(p2.siteName) && /second bedroom door/.test(p2.description) && !/Many Thanks|Chapplins Support/.test(p2.description), JSON.stringify(p2));
  // estimate request: communal site matched exactly, subject type kept in front
  const r3 = await run(E, rawChap3, "ashley@chapplins.co.uk"); const p3 = E.inbound[2] && E.inbound[2].body;
  ok("chapplins estimate: communal site matched + 'Estimate required' prefix", p3 && p3.siteCode === "4026" && /^Urgent Estimate required — /.test(p3.description) && !p3.priority, JSON.stringify(p3));
  // broken one (no job number) → HELD, never created
  const r4 = await run(E, rawChapBroken, "ashley@chapplins.co.uk");
  ok("chapplins with no job number → review (held), nothing created", r4.outcome === "review" && /job number/.test(r4.reason) && E.inbound.length === 3, r4.outcome + " / " + r4.reason);
}
{ // 6. supplier paperwork + our own zap emails → dropped by template (no AI)
  const E = makeEnv();
  const m = await run(E, rawMetro, "dorset.example@metrorod.co.uk");
  ok("metro rod job card → dropped", m.outcome === "dropped" && /Metro Rod/.test(m.reason), m.reason);
  const z = await run(E, rawZap, "office@mostlane.com");
  ok("our own 'Send N to MetroRod' → dropped", z.outcome === "dropped" && /own outbound/.test(z.reason), z.reason);
  const re = await run(E, rawChap.replace("Subject: P1 - ", "Subject: RE: P1 - ").replace("test-chap1@fpp.local", "test-re@fpp.local"), "ashley@chapplins.co.uk");
  ok("a reply ('RE:') quoting a job email → dropped", re.outcome === "dropped" && /Reply/.test(re.reason), re.reason);
  ok("nothing created from any of them", E.inbound.length === 0 && E.orders.length === 0);
}
{ // 7. unknown layout from an allowed sender → HELD for review (no AI key); approve creates it with corrections
  const E = makeEnv();
  const r = await run(E, rawUnknown, "someone@mostlane.com");
  ok("unknown layout → review, nothing created", r.outcome === "review" && E.inbound.length === 0, r.outcome + " / " + r.reason);
  const call = async (who, method, path, body) => { const url = new URL("https://api.test" + path);
    const res = await ej.handleApi(new Request(url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), E.env, {}, url, { user: { username: who } }, E.fetchSelf);
    let j = null; try { j = await res.clone().json(); } catch {} return { status: res.status, body: j }; };
  const bad = await call("Jamie Line", "POST", "/email-intake/approve", { id: r.id });
  ok("approve with no fields → refused (needs a reference or description)", bad.status === 400, String(bad.status));
  const good = await call("Jamie Line", "POST", "/email-intake/approve", { id: r.id, fields: { reference: "TEST-1", description: "Water through the ceiling at Test Store", siteName: "Test Store", priority: "Priority 2" } });
  ok("approve with typed fields → job created + log row updated", good.status === 200 && good.body.outcome === "created" && E.inbound.length === 1 && E.inbound[0].body.reference === "TEST-1" && E.rows[0].outcome === "created" && /Approved by Jamie Line/.test(E.rows[0].reason), JSON.stringify(good.body && good.body.reason));
  const r2 = await run(E, rawUnknown.replace("test-unknown@outlook", "test-unknown2@outlook"), "someone@mostlane.com");
  const d = await call("Jamie Line", "POST", "/email-intake/dismiss", { id: r2.id, note: "not ours" });
  ok("dismiss → row marked dismissed", d.status === 200 && E.rows[1].outcome === "dismissed" && /not ours/.test(E.rows[1].reason));
  const s = await call("Jamie Line", "GET", "/email-intake/status");
  ok("status: review count + template list", s.status === 200 && s.body.reviewOpen === 0 && Array.isArray(s.body.templates) && s.body.templates.length >= 6, JSON.stringify(s.body && s.body.reviewOpen));
  const g = await call("Some Engineer", "GET", "/email-intake/log");
  ok("gate: non-admin refused", g.status === 403);
  const cfg = await call("Jamie Line", "POST", "/email-intake/config", { allowFrom: ["concerto.co.uk", "client.example"], enabled: true, aiAutoCreate: true });
  ok("config saved incl. aiAutoCreate", cfg.status === 200 && cfg.body.config.allowFrom.includes("client.example") && cfg.body.config.aiAutoCreate === true);
}
{ // 8. test box: dry-run shows the template's reading; chapplins dry-run names the site match
  const E = makeEnv();
  const call = async (body) => { const url = new URL("https://api.test/email-intake/test");
    const res = await ej.handleApi(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), E.env, {}, url, { user: { username: "Jamie Line" } }, E.fetchSelf);
    return await res.json(); };
  const t = await call({ subject: "New Job Alert: 00099999/2 - Priority 1", body: HTML, from: "noreply@concerto.co.uk" });
  ok("test box (dry run): concerto template, nothing created", t.outcome === "dryrun" && t.template === "concerto-job" && t.fields.reference === "00099999/2" && E.inbound.length === 0, t.outcome + " / " + t.reason);
  const c = await call({ subject: "P1 - 159a Fratton Road, Portsmouth, PO1 5ET.", body: CHAP_HTML, from: "ashley@chapplins.co.uk" });
  ok("test box (dry run): chapplins template + site match named", c.outcome === "dryrun" && c.template === "chapplins-job" && /site 4007/.test(c.reason), c.reason);
  const o = await call({ subject: "Order number 00099999/2 from Southern Coop", body: ORDER_HTML, from: "noreply@concerto.co.uk" });
  ok("test box (dry run): order sheet says client orders", o.outcome === "dryrun" && /client order/i.test(o.reason), o.reason);
  const k = await call({ subject: "New Job Alert: 00099999/2 - Priority 1", body: HTML, from: "noreply@concerto.co.uk", commit: true });
  ok("test box (commit): job created + logged", k.outcome === "created" && E.inbound.length === 1 && E.rows.length === 1);
}
{ // 9. site lookup edge cases
  const E = makeEnv();
  const a = await lookupSite(E.env, "1", { client: "chapplins", address: "32B Archers Road, Southampton, SO15 2LT", postcode: "SO15 2LT" });
  const b = await lookupSite(E.env, "1", { client: "chapplins", address: "32 Archers Road, Southampton, SO15 2LT", postcode: "SO15 2LT" });
  const c = await lookupSite(E.env, "1", { client: "chapplins", address: "Flat 15 Badger Court, Bishopstoke, Eastleigh, Southampton, SO50 8JY", postcode: "SO50 8JY" });
  ok("lookup: exact unit match", a && a.siteCode === "4013", JSON.stringify(a));
  ok("lookup: ambiguous (no unit) → no match", b === null, JSON.stringify(b));
  ok("lookup: flat matched", c && c.siteCode === "4079", JSON.stringify(c));
}
console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
