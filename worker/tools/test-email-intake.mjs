// Email → job intake (emailjob.js) — drives the real handler with a mock D1 and a
// mocked /sla/inbound. Synthetic Concerto-shaped emails only (no customer data).
// Run:  node worker/tools/test-email-intake.mjs
import * as ej from "../src/routes/emailjob.js";

const HTML = `<table><tr><td><div>Concerto</div><div>Notification sent on</div><div>Tue 08 September 2026 at 3:45 PM</div></td></tr></table>
<div><p>Hi Mostlane,</p><p><br /></p><p>You have been assigned a new job: 00099999/2</p><p>This has an SLA of Priority 1</p>
<p>With a target Response Date &amp; Time: 08/Sep/2026 19:44</p><p>With a target Completion Date &amp; Time: 09/Sep/2026 15:44</p>
<p>Site: 0000 - Test Store - Anytown, 1 , High Street, Anytown, Hampshire, AB1 2CD</p>
<p>Fault/Issue: Ceiling : Requires Attention - water dripping by the kitchen door ACCESS TIMES: 10 til 4 Monday to Friday. Branch Number 01234567890</p>
<p><a href="https://example.concerto.co.uk/">Click here to login to Concerto</a></p></div>`;
const b64 = s => Buffer.from(s, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
const rawDirect = [
  "From: noreply@concerto.co.uk", "To: enquiries@mostlane.com", "Subject: New Job Alert: 00099999/2 - Priority 1",
  "Message-ID: <test-1@concerto>", "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="MIX"', "",
  "--MIX", 'Content-Type: multipart/alternative; boundary="ALT"', "", "--ALT", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: quoted-printable", "",
  "Hi Mostlane,=0D=0AYou have been assigned a new job: 00099999/2=0D=0AThis has an SLA of Priority 1=0D=0AWith a target Response Date & Time: 08/Sep/2026 19:44=0D=0AWith a target Completion Date & Time: 09/Sep/2026 15:44=0D=0ASite: 0000 - Test Store - Anytown, 1 , High Street, Anytown, Hampshire, AB1 2CD=0D=0AFault/Issue: Ceiling : Requires Attention - water dripping by the kitchen door ACCESS TIMES: 10 til 4 Monday to Friday. Branch Number 01234567890=0D=0AClick here to login to Concerto",
  "--ALT", "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64", "", b64(HTML), "--ALT--",
  "--MIX", 'Content-Type: application/pdf; name="order.pdf"', "Content-Transfer-Encoding: base64", "", b64("%PDF-1.4 not really"), "--MIX--", ""
].join("\r\n");
// Outlook "forward as attachment": outer mail from Jamie, original as message/rfc822
const rawFwdAttach = [
  "From: jamie@example.com", "To: jobs@example.com", "Subject: FW: New Job Alert: 00099999/2 - Priority 1", "Message-ID: <test-2@outlook>",
  "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="OUT"', "", "--OUT", "Content-Type: text/plain", "", "", "--OUT", "Content-Type: message/rfc822", "", rawDirect, "--OUT--", ""
].join("\r\n");
// Inline forward: only HTML, with the From: block at the top
const rawFwdInline = [
  "From: jamie@example.com", "Subject: FW: New Job Alert: 00099999/2 - Priority 1", "Message-ID: <test-3@outlook>", "MIME-Version: 1.0",
  "Content-Type: text/html; charset=utf-8", "", "<div>From: noreply@concerto.co.uk &lt;noreply@concerto.co.uk&gt;<br>Sent: 08 September 2026 15:45<br>To: Enquiries<br>Subject: New Job Alert</div>" + HTML, ""
].join("\r\n");
const rawOrder = rawDirect.replace("Subject: New Job Alert: 00099999/2 - Priority 1", "Subject: Order number 00099999/2 from Southern Coop").replace(/You have been assigned a new job: 00099999\/2/g, "Please find the attached order sheet for order number 00099999/2").replace(/New Job Alert/g, "Order");

function makeEnv() {
  const rows = []; let cfgValue = null; const calls = [];
  const db = { prepare(sql) { let binds = []; const st = {
    bind(...a) { binds = a; return st; },
    async run() { calls.push(sql.slice(0, 60));
      if (/INSERT INTO inbound_emails/.test(sql)) rows.push({ id: rows.length + 1, tenant_id: binds[0], message_id: binds[1], received_at: binds[2], from_addr: binds[3], orig_from: binds[4], subject: binds[5], outcome: binds[6], reason: binds[7], reference: binds[8], job_id: binds[9], status_code: binds[10], fields: binds[11], text: binds[12] });
      if (/INSERT INTO app_config/.test(sql)) cfgValue = binds[2];
      return { meta: {} }; },
    async first() { calls.push(sql.slice(0, 60));
      if (/FROM app_config/.test(sql)) return cfgValue ? { value: cfgValue } : null;
      if (/FROM inbound_emails WHERE tenant_id=\? AND message_id=\?/.test(sql)) return rows.find(r => r.message_id === binds[1] && /created|updated/.test(r.outcome)) || null;
      if (/FROM inbound_emails WHERE tenant_id=\? AND id=\?/.test(sql)) return rows.find(r => r.id === binds[1]) || null;
      if (/ORDER BY id DESC LIMIT 1/.test(sql)) return rows[rows.length - 1] || null;
      if (/FROM user_permissions/.test(sql)) return null;
      return null; },
    async all() { calls.push(sql.slice(0, 60));
      if (/FROM user_permissions/.test(sql)) return { results: binds.some(b => /jamie/i.test(String(b))) ? [{ permission: "FullAccess", value: 1 }] : [] };
      if (/GROUP BY outcome/.test(sql)) { const c = {}; rows.forEach(r => c[r.outcome] = (c[r.outcome] || 0) + 1); return { results: Object.entries(c).map(([outcome, n]) => ({ outcome, n })) }; }
      if (/FROM inbound_emails/.test(sql)) return { results: rows.slice().reverse() };
      return { results: [] }; },
  }; return st; } };
  const inbound = [];
  const fetchSelf = async (req) => { const body = await req.json(); inbound.push({ auth: req.headers.get("authorization"), body });
    return new Response(JSON.stringify({ ok: true, created: inbound.length === 1, id: "JOB-" + body.reference, reference: body.reference }), { status: 200, headers: { "content-type": "application/json" } }); };
  return { env: { DB: db, JOBS_INBOUND_TOKEN: "tok" }, rows, inbound, fetchSelf, calls };
}
function msgOf(raw, from) { return { from, headers: { get: k => { const m = new RegExp("^" + k + ":\\s*(.+)$", "im").exec(raw.split(/\r?\n\r?\n/)[0]); return m ? m[1] : null; } }, raw: new Blob([raw]).stream() }; }
let fail = 0; const ok = (name, cond, extra = "") => { console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra ? "  → " + extra : "")); if (!cond) fail++; };

{ // 1. a Concerto job email straight from Concerto → job created (template path, no AI key)
  const E = makeEnv();
  await ej.handleInboundEmail(msgOf(rawDirect, "noreply@concerto.co.uk"), E.env, {}, E.fetchSelf);
  const r = E.rows[0], p = E.inbound[0] && E.inbound[0].body;
  ok("direct: job created via /sla/inbound", r && r.outcome === "created" && E.inbound.length === 1 && E.inbound[0].auth === "Bearer tok", r && r.outcome + " / " + r.reason);
  ok("direct: fields extracted", p && p.reference === "00099999/2" && p.priority === "Priority 1" && p.siteCode === "0000" && p.postcode === "AB1 2CD" && /water dripping/.test(p.description) && p.telephone === "01234567890", JSON.stringify(p));
  const f = JSON.parse(r.fields);
  ok("direct: target dates read as London time", f.respondBy === "2026-09-08T18:44:00.000Z" && f.completeBy === "2026-09-09T14:44:00.000Z", f.respondBy + " " + f.completeBy);
  ok("direct: text/plain preferred, PDF ignored", r.text.includes("Hi Mostlane") && !r.text.includes("%PDF"));
  // 2. the same message again → duplicate, no second job
  await ej.handleInboundEmail(msgOf(rawDirect, "noreply@concerto.co.uk"), E.env, {}, E.fetchSelf);
  ok("same message-id again → duplicate, not re-created", E.rows[1].outcome === "duplicate" && E.inbound.length === 1, E.rows[1].reason);
}
{ // 3. Outlook forward-as-attachment: original read from the rfc822 part
  const E = makeEnv();
  await ej.handleInboundEmail(msgOf(rawFwdAttach, "jamie@example.com"), E.env, {}, E.fetchSelf);
  const r = E.rows[0];
  ok("forward-as-attachment: job created from the wrapped original", r.outcome === "created" && E.inbound[0].body.reference === "00099999/2", r.outcome + " / " + r.reason);
}
{ // 4. Inline forward: sender recovered from the From: block, FW: stripped
  const E = makeEnv();
  await ej.handleInboundEmail(msgOf(rawFwdInline, "jamie@example.com"), E.env, {}, E.fetchSelf);
  const r = E.rows[0];
  ok("inline forward: original sender recovered + job created", r.outcome === "created" && r.orig_from === "noreply@concerto.co.uk" && E.inbound[0].body.reference === "00099999/2", r.outcome + " / " + r.orig_from + " / " + r.reason);
}
{ // 5. allow-list: a random sender is ignored (no AI spend, no job)
  const E = makeEnv();
  await ej.handleInboundEmail(msgOf(rawDirect.replace("From: noreply@concerto.co.uk", "From: spam@random.example"), "spam@random.example"), E.env, {}, E.fetchSelf);
  ok("unknown sender → ignored, nothing created", E.rows[0].outcome === "ignored" && E.inbound.length === 0, E.rows[0].reason);
}
{ // 6. a non-job Concerto email (order sheet) is dropped
  const E = makeEnv();
  await ej.handleInboundEmail(msgOf(rawOrder, "noreply@concerto.co.uk"), E.env, {}, E.fetchSelf);
  ok("order-sheet email → dropped (not a job)", E.rows[0].outcome === "dropped" && E.inbound.length === 0, E.rows[0].reason);
}
{ // 7. office API: test box dry-run + gate
  const E = makeEnv();
  const call = async (who, method, path, body) => { const url = new URL("https://api.test" + path);
    const res = await ej.handleApi(new Request(url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), E.env, {}, url, { user: { username: who } }, E.fetchSelf);
    let j = null; try { j = await res.clone().json(); } catch {} return { status: res.status, body: j }; };
  const t = await call("Jamie Line", "POST", "/email-intake/test", { subject: "New Job Alert: 00099999/2 - Priority 1", body: HTML });
  ok("test box (dry run): fields returned, nothing created", t.status === 200 && t.body.outcome === "dryrun" && t.body.fields.reference === "00099999/2" && E.inbound.length === 0, t.body && (t.body.outcome + " / " + t.body.reason));
  const c = await call("Jamie Line", "POST", "/email-intake/test", { subject: "New Job Alert: 00099999/2 - Priority 1", body: HTML, commit: true });
  ok("test box (commit): job created + logged", c.status === 200 && c.body.outcome === "created" && E.inbound.length === 1 && E.rows.length === 1);
  const s = await call("Jamie Line", "GET", "/email-intake/status");
  ok("status: last email + counts", s.status === 200 && s.body.last && s.body.counts7d.created === 1 && s.body.inboundConfigured === true, JSON.stringify(s.body && s.body.counts7d));
  const g = await call("Some Engineer", "GET", "/email-intake/log");
  ok("gate: non-admin refused", g.status === 403);
  const cfg = await call("Jamie Line", "POST", "/email-intake/config", { allowFrom: ["concerto.co.uk", "client.example"], enabled: true });
  ok("config saved", cfg.status === 200 && cfg.body.config.allowFrom.includes("client.example"));
}
console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
