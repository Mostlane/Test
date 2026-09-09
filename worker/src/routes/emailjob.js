// ─────────────────────────────────────────────────────────────────────────────
// Inbound email → job (Cloudflare Email Routing)
//
// Replaces the old Zapier "new email → parse → POST /sla/inbound" zap. A job
// email (e.g. Southern Co-op's Concerto "New Job Alert", or any other client's
// reactive-job email) is forwarded into a Cloudflare-routed address; this
// worker's email() handler runs, extracts the job fields, and creates the job
// through the SAME /sla/inbound path the zap used (via an in-process self
// request, so nothing else in sla.js changes).
//
// Extraction is AI-first (env.ANTHROPIC_API_KEY, a forced tool) so it copes with
// any format and survives template tweaks; a deterministic Concerto regex is the
// no-key / AI-error fallback. Nothing is sent to the AI except the email's text
// body (attachments are dropped during MIME parsing), capped in size.
// ─────────────────────────────────────────────────────────────────────────────

import { json, error } from "../lib/http.js";
import { permissionsFor } from "../lib/auth.js";
import { resolveTenantId } from "../lib/tenantdb.js";

/* ── Intake log + config ──────────────────────────────────────────────────────
   Every email the worker receives is logged (what came in, what we made of it,
   what happened) so the office can SEE the intake working — and re-run one.  */
const T = "inbound_emails";
async function ensureTable(env) {
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ${T} (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT, message_id TEXT, received_at TEXT,
      from_addr TEXT, orig_from TEXT, subject TEXT, outcome TEXT, reason TEXT, reference TEXT,
      job_id TEXT, status_code INTEGER, fields TEXT, text TEXT)`).run();
    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS ${T}_mid ON ${T}(tenant_id, message_id)`).run();
  } catch {}
}
const DEFAULT_CFG = { enabled: true, allowFrom: ["concerto.co.uk", "mostlane.com"] };
async function getIntakeConfig(env, tid) {
  try {
    const row = await env.DB.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(tid, "email:intake").first();
    const v = row && row.value ? JSON.parse(row.value) : {};
    return { ...DEFAULT_CFG, ...v, allowFrom: Array.isArray(v.allowFrom) && v.allowFrom.length ? v.allowFrom : DEFAULT_CFG.allowFrom };
  } catch { return { ...DEFAULT_CFG }; }
}
async function saveIntakeConfig(env, tid, cfg) {
  await env.DB.prepare("INSERT INTO app_config (tenant_id, key, value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(tid, "email:intake", JSON.stringify(cfg)).run();
}
function senderAllowed(cfg, ...addrs) {
  const list = (cfg.allowFrom || []).map(x => String(x || "").toLowerCase().trim()).filter(Boolean);
  if (!list.length) return true;
  return addrs.some(a => { const x = String(a || "").toLowerCase().trim(); if (!x) return false;
    const dom = x.split("@").pop(); return list.some(l => l === x || l === dom || (l.startsWith("@") && l.slice(1) === dom)); });
}
async function logIntake(env, tid, rec) {
  try {
    await env.DB.prepare(`INSERT INTO ${T} (tenant_id, message_id, received_at, from_addr, orig_from, subject, outcome, reason, reference, job_id, status_code, fields, text)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(tid, rec.messageId || "", rec.receivedAt || new Date().toISOString(), rec.from || "", rec.origFrom || "", (rec.subject || "").slice(0, 300),
        rec.outcome || "", (rec.reason || "").slice(0, 300), rec.reference || "", rec.jobId || "", rec.status || null,
        JSON.stringify(rec.fields || null), (rec.text || "").slice(0, 12000)).run();
  } catch (e) { console.error("email intake log:", e && e.message); }
}

/* Read the raw RFC822 message to a string. */
async function readRaw(message) {
  try { return await new Response(message.raw).text(); }
  catch { return ""; }
}

/* Minimal, dependency-free MIME text extractor. Walks multipart trees, decodes
   quoted-printable / base64, and returns the best text/plain (else stripped
   text/html). Non-text parts (PDF/image attachments) are ignored. */
function decodeQP(s) {
  return s.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
function decodeB64(s) {
  try {
    const bin = atob(s.replace(/\s+/g, ""));
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch { return ""; }
}
function stripHtml(h) {
  return String(h)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<\/(p|div|tr|br|li|h[1-6]|table)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
function splitSection(section) {
  const idx = section.search(/\r?\n\r?\n/);
  const headStr = idx < 0 ? section : section.slice(0, idx);
  let body = idx < 0 ? "" : section.slice(idx).replace(/^\r?\n\r?\n/, "");
  const headers = {};
  headStr.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/).forEach(line => {
    const c = line.indexOf(":");
    if (c > 0) headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
  });
  return { headers, body };
}
function walkMime(section, depth) {
  if (depth > 8) return [];
  const { headers, body } = splitSection(section);
  const ct = headers["content-type"] || "text/plain";
  const cte = (headers["content-transfer-encoding"] || "").toLowerCase();
  if (/^multipart\//i.test(ct)) {
    const m = /boundary="?([^";]+)"?/i.exec(ct);
    if (!m) return [];
    const parts = body.split("--" + m[1]);
    let out = [];
    for (let p of parts.slice(1)) {
      if (/^--/.test(p.replace(/^\r?\n/, ""))) break;   // closing boundary
      out = out.concat(walkMime(p.replace(/^\r?\n/, ""), depth + 1));
    }
    return out;
  }
  const type = (ct.split(";")[0] || "").trim().toLowerCase();
  // Outlook "Forward as attachment" wraps the original as message/rfc822 — read
  // the ORIGINAL email inside it (that's the one with the job).
  if (type === "message/rfc822") {
    const inner = cte === "base64" ? decodeB64(body) : body;
    const innerFrom = (splitSection(inner).headers["from"] || "").trim();
    // Surface the ORIGINAL sender as a "From:" line so unwrapForward recovers it.
    return walkMime(inner, depth + 1).map(p => ({ ...p, text: (innerFrom ? "From: " + innerFrom + "\n" : "") + p.text }));
  }
  if (!/^text\//.test(type)) return [];                  // skip attachments
  let text = body;
  if (cte === "quoted-printable") text = decodeQP(text);
  else if (cte === "base64") text = decodeB64(text);
  return [{ type, text }];
}
function extractText(raw) {
  const parts = walkMime(raw, 0);
  const plain = parts.find(p => p.type === "text/plain" && p.text.trim());
  if (plain) return plain.text;
  const html = parts.find(p => p.type === "text/html" && p.text.trim());
  if (html) return stripHtml(html.text);
  return parts.map(p => p.text).join("\n");
}

/* An INLINE forward ("FW: New Job Alert…") carries the original sender in a
   "From: …" header block at the top of the body. Recover it so the allow-list
   judges the ORIGINAL sender, and strip the FW:/Fwd: prefix. */
function unwrapForward(subject, text) {
  const subj = String(subject || "").replace(/^\s*(?:fwd?|fw)\s*:\s*/i, "").trim();
  let origFrom = "";
  const m = /^\s*(?:>?\s*)?From:\s*(.+)$/im.exec(String(text || "").slice(0, 3000));
  if (m) { const e = /<([^>]+)>/.exec(m[1]) || /([^\s"']+@[^\s"']+)/.exec(m[1]); origFrom = (e ? e[1] : "").toLowerCase().trim(); }
  return { subject: subj, origFrom };
}
/* "09/Sep/2026 15:44" (Concerto, Europe/London wall clock) → ISO UTC. */
const MON = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
function londonToIso(y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo, d, h, mi);
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", timeZoneName: "shortOffset" }).formatToParts(new Date(guess));
    const tz = (parts.find(p => p.type === "timeZoneName") || {}).value || "GMT";
    const off = /GMT([+-]\d{1,2})/.exec(tz); const hours = off ? Number(off[1]) : 0;
    return new Date(guess - hours * 3600e3).toISOString();
  } catch { return new Date(guess).toISOString(); }
}
function concertoDate(s) {
  const m = /(\d{1,2})\/([A-Za-z]{3})\/(\d{4})\s+(\d{1,2}):(\d{2})/.exec(String(s || ""));
  if (!m || MON[m[2].toLowerCase()] === undefined) return "";
  return londonToIso(+m[3], MON[m[2].toLowerCase()], +m[1], +m[4], +m[5]);
}

/* Deterministic fallback for the Concerto "New Job Alert" template (used when the
   AI key is missing or the AI call fails). Returns null if it doesn't look like
   a Concerto job. */
function concertoRegex(subject, text) {
  const t = String(text || "");
  if (!/New Job Alert|You have been assigned a new job/i.test(subject + " " + t)) return null;
  const ref = (/assigned a new job:\s*([^\s<]+)/i.exec(t) || /New Job Alert:\s*([^\s-]+)/i.exec(subject) || [])[1] || "";
  const pr = (/Priority\s*([1-4])/i.exec(subject) || /SLA of Priority\s*([1-4])/i.exec(t) || [])[1] || "";
  const siteLine = (/^\s*Site:\s*(.+)$/im.exec(t) || [])[1] || "";
  const code = (/^\s*(\d{3,5})\b/.exec(siteLine) || [])[1] || "";
  const postcode = (/\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i.exec(siteLine) || [])[1] || "";
  const fault = (/Fault\/Issue:\s*([\s\S]+?)(?:\n\s*(?:Click here to login|Please log|$))/i.exec(t) || [])[1] || "";
  const phone = (/\b(0\d{9,10}|0\d{2,4}\s?\d{3,4}\s?\d{3,4})\b/.exec(fault) || [])[1] || "";
  const respondBy = concertoDate((/target Response Date\s*&\s*Time:\s*([^\n]+)/i.exec(t) || [])[1]);
  const completeBy = concertoDate((/target Completion Date\s*&\s*Time:\s*([^\n]+)/i.exec(t) || [])[1]);
  if (!ref && !fault) return null;
  return {
    respondBy, completeBy,
    isJob: true,
    reference: ref,
    priority: pr ? "Priority " + pr : "",
    siteCode: code,
    siteName: siteLine.replace(/^\s*\d{3,5}\s*-\s*/, "").split(",").slice(0, 2).join(",").trim(),
    address: siteLine.replace(/^\s*\d{3,5}\s*-\s*/, "").trim(),
    postcode,
    telephone: phone,
    description: fault.trim(),
    raisedAt: ""
  };
}

/* AI extraction (forced tool). Returns the fields object, or null on any error. */
async function aiExtract(env, { from, subject, text }) {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const model = env.ANTHROPIC_MODEL || "claude-sonnet-5";
  const schema = {
    type: "object",
    properties: {
      isJob: { type: "boolean", description: "TRUE only if this email is a NEW reactive/maintenance job to attend. FALSE for replies, chases, quotes, invoices, purchase orders, completion/status updates, newsletters or anything not a fresh job request." },
      reference: { type: "string", description: "The job / work-order reference number if present, else ''." },
      priority: { type: "string", description: "One of 'Priority 1'..'Priority 4' if a priority/SLA is stated, else ''." },
      siteCode: { type: "string", description: "The store / site number if present (digits, e.g. '0220'), else ''." },
      siteName: { type: "string", description: "The site / store name, else ''." },
      address: { type: "string", description: "The site address (street, town, county), else ''." },
      postcode: { type: "string", description: "UK postcode of the site if present, else ''." },
      telephone: { type: "string", description: "A site contact phone number if present, else ''." },
      description: { type: "string", description: "The fault / work description, including any access times or contact notes. Plain text." },
      raisedAt: { type: "string", description: "ISO 8601 date-time the job was logged/raised IF clearly stated, else ''." },
      respondBy: { type: "string", description: "ISO 8601 target RESPONSE date-time if stated (treat stated times as Europe/London), else ''." },
      completeBy: { type: "string", description: "ISO 8601 target COMPLETION date-time if stated (Europe/London), else ''." }
    },
    required: ["isJob"]
  };
  const system = "You extract reactive-maintenance job details from a facilities-management email so it can be logged as a job. These often come from CAFM systems such as Concerto (Southern Co-op), which send a 'New Job Alert' with labelled fields (job number, SLA/Priority, Site: <code> - <name>, <address>, Fault/Issue: ...). Be conservative: if the email is not a brand-new job to attend (e.g. it is a reply, chase, quote, invoice, PO, or status update), set isJob=false. Never invent values — leave a field '' if it isn't in the email.";
  const userContent = `From: ${from}\nSubject: ${subject}\n\nBody:\n${text}`;
  let resp;
  try {
    resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model, max_tokens: 1500, system,
        tools: [{ name: "extract_job", description: "Return the job fields.", input_schema: schema }],
        tool_choice: { type: "tool", name: "extract_job" },
        messages: [{ role: "user", content: userContent }]
      })
    });
  } catch { return null; }
  if (!resp.ok) return null;
  let payload; try { payload = await resp.json(); } catch { return null; }
  const block = Array.isArray(payload.content) ? payload.content.find(c => c.type === "tool_use" && c.name === "extract_job") : null;
  return block && block.input ? block.input : null;
}

/* ── The pipeline (shared by the live email handler, the test box and re-run) ──
   Returns {outcome, reason, fields, reference, jobId, status}. outcome ∈
   created | updated | dropped (not a job) | ignored (sender not allowed / intake
   off) | duplicate (this message-id already made a job) | failed | dryrun.   */
export async function processEmail(env, ctx, fetchSelf, msg, opts = {}) {
  const tid = msg.tid || "1";
  const cfg = opts.cfg || await getIntakeConfig(env, tid);
  const { subject, origFrom } = unwrapForward(msg.subject, msg.text);
  const from = String(msg.from || "").toLowerCase();
  const text = String(msg.text || "").slice(0, 12000);
  const base = { fields: null, reference: "", jobId: "", status: null, origFrom, subject };

  if (!opts.dryRun && cfg.enabled === false) return { ...base, outcome: "ignored", reason: "Email intake is switched off" };
  if (!opts.force && !senderAllowed(cfg, origFrom, from)) return { ...base, outcome: "ignored", reason: "Sender not on the allow-list (" + (origFrom || from) + ")" };
  if (!opts.dryRun && !opts.force && msg.messageId) {
    try {
      const dup = await env.DB.prepare(`SELECT id, job_id, reference FROM ${T} WHERE tenant_id=? AND message_id=? AND outcome IN ('created','updated') LIMIT 1`).bind(tid, msg.messageId).first();
      if (dup) return { ...base, outcome: "duplicate", reason: "This email was already processed (log #" + dup.id + ")", reference: dup.reference || "", jobId: dup.job_id || "" };
    } catch {}
  }

  let fields = null, source = "ai";
  if (!opts.noAi) fields = await aiExtract(env, { from: origFrom || from, subject, text });
  if (!fields) { fields = concertoRegex(subject, text); source = "template"; }
  if (!fields || !fields.isJob) return { ...base, fields, source, outcome: "dropped", reason: fields ? "Not a new job (reply / order / quote / status update)" : "Didn't look like a job email" };
  if (!String(fields.reference || "").trim() && !String(fields.description || "").trim()) return { ...base, fields, source, outcome: "dropped", reason: "Looked like a job but had no reference or description" };

  const payload = {
    reference: fields.reference || undefined,
    description: fields.description || undefined,
    priority: fields.priority || undefined,
    siteCode: fields.siteCode || undefined,
    siteName: fields.siteName || undefined,
    address: fields.address || undefined,
    postcode: fields.postcode || undefined,
    telephone: fields.telephone || undefined,
    raisedAt: fields.raisedAt || undefined,
    originator: "email",
    originatorEmail: origFrom || from || undefined,
    changedBy: "email"
  };
  if (opts.dryRun) return { ...base, fields, source, outcome: "dryrun", reason: "Would " + (fields.reference ? "create/update job " + fields.reference : "create a job"), reference: fields.reference || "", payload };

  // Reuse /sla/inbound exactly, in-process (no network) — same dedupe-by-
  // reference, priority/date parsing and assignment push as the old zap.
  const req = new Request("https://mostlane-api.internal/sla/inbound", {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": "Bearer " + (env.JOBS_INBOUND_TOKEN || "") },
    body: JSON.stringify(payload)
  });
  try {
    const resp = await fetchSelf(req, env, ctx);
    let out = {}; try { out = await resp.clone().json(); } catch {}
    if (!resp.ok) return { ...base, fields, source, outcome: "failed", reason: (out && out.error) || ("HTTP " + resp.status), status: resp.status, reference: fields.reference || "" };
    return { ...base, fields, source, outcome: out.created ? "created" : "updated", reason: out.created ? "New job on the board" : "Existing job updated (same reference)", status: resp.status, reference: out.reference || fields.reference || "", jobId: out.id || "" };
  } catch (e) {
    return { ...base, fields, source, outcome: "failed", reason: "Couldn't reach /sla/inbound: " + String(e && e.message || e).slice(0, 120), reference: fields.reference || "" };
  }
}

/* Entry point wired from index.js's email() handler. fetchSelf is the worker's
   own fetch (so we reuse /sla/inbound verbatim). Never throws. */
export async function handleInboundEmail(message, env, ctx, fetchSelf) {
  const from = String(message.from || "").toLowerCase();
  let subject = "", messageId = "";
  try { subject = message.headers.get("subject") || ""; } catch {}
  try { messageId = (message.headers.get("message-id") || "").trim(); } catch {}
  const raw = await readRaw(message);
  const text = (extractText(raw) || "").slice(0, 12000);
  const tid = "1";
  await ensureTable(env);
  const res = await processEmail(env, ctx, fetchSelf, { tid, from, subject, text, messageId });
  await logIntake(env, tid, { messageId, from, origFrom: res.origFrom, subject, outcome: res.outcome, reason: res.reason, reference: res.reference, jobId: res.jobId, status: res.status, fields: res.fields, text });
  console.log("email intake:", res.outcome, "—", subject, "—", res.reason);
}

/* ── Office API (/email-intake/*) — FullAccess | SLAAdmin ─────────────────────
   GET  /status   → config + last email + 7-day outcome counts + what's configured
   GET  /log?limit= → recent emails (newest first)
   POST /test     {subject, body, from?, commit?} → run the pipeline on pasted text
   POST /rerun    {id} → re-run a logged email for real (force past the allow-list/dedupe)
   GET/POST /config {enabled, allowFrom[]}                                        */
export async function handleApi(request, env, ctx, url, sess, fetchSelf) {
  const method = request.method.toUpperCase();
  const sub = url.pathname.replace(/^\/email-intake(?=\/|$)/, "") || "/";
  if (!sess || !sess.user) return error("Login required", 401, env, request);
  const tid = await resolveTenantId(env, request);
  const me = sess.user.username;
  const perms = await permissionsFor(env, tid, me);
  if (!(perms.FullAccess === "Yes" || perms.SLAAdmin === "Yes")) return error("SLA admin access required", 403, env, request);
  await ensureTable(env);

  if (sub === "/status" && method === "GET") {
    const cfg = await getIntakeConfig(env, tid);
    let last = null, counts = {}; const since = new Date(Date.now() - 7 * 86400e3).toISOString();
    try { last = await env.DB.prepare(`SELECT id, received_at, subject, outcome, reference FROM ${T} WHERE tenant_id=? ORDER BY id DESC LIMIT 1`).bind(tid).first(); } catch {}
    try { const { results } = await env.DB.prepare(`SELECT outcome, COUNT(*) AS n FROM ${T} WHERE tenant_id=? AND received_at>=? GROUP BY outcome`).bind(tid, since).all(); for (const r of (results || [])) counts[r.outcome] = r.n; } catch {}
    return json({ ok: true, config: cfg, last, counts7d: counts, aiConfigured: !!env.ANTHROPIC_API_KEY, inboundConfigured: !!(env.JOBS_INBOUND_TOKEN || "").trim() }, {}, env, request);
  }
  if (sub === "/log" && method === "GET") {
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || 60));
    let rows = [];
    try { const { results } = await env.DB.prepare(`SELECT id, message_id, received_at, from_addr, orig_from, subject, outcome, reason, reference, job_id, status_code, fields FROM ${T} WHERE tenant_id=? ORDER BY id DESC LIMIT ?`).bind(tid, limit).all(); rows = results || []; } catch {}
    return json({ ok: true, rows: rows.map(r => ({ ...r, fields: (() => { try { return JSON.parse(r.fields || "null"); } catch { return null; } })() })) }, {}, env, request);
  }
  if (sub === "/test" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const subject = String(b.subject || "").slice(0, 300), body = String(b.body || "").slice(0, 20000);
    if (!subject && !body) return error("Paste the email's subject and body", 400, env, request);
    const text = /<[a-z][\s\S]*>/i.test(body) ? stripHtml(body) : body;
    const commit = b.commit === true;
    const res = await processEmail(env, ctx, fetchSelf, { tid, from: String(b.from || me + "@test").toLowerCase(), subject, text, messageId: "" }, { dryRun: !commit, force: true });
    if (commit) await logIntake(env, tid, { messageId: "", from: "test:" + me, origFrom: res.origFrom, subject, outcome: res.outcome, reason: res.reason, reference: res.reference, jobId: res.jobId, status: res.status, fields: res.fields, text });
    return json({ ok: true, ...res, text: text.slice(0, 4000) }, {}, env, request);
  }
  if (sub === "/rerun" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const row = await env.DB.prepare(`SELECT * FROM ${T} WHERE tenant_id=? AND id=?`).bind(tid, Number(b.id) || 0).first().catch(() => null);
    if (!row) return error("Log entry not found", 404, env, request);
    const res = await processEmail(env, ctx, fetchSelf, { tid, from: row.from_addr || "", subject: row.subject || "", text: row.text || "", messageId: row.message_id || "" }, { force: true });
    await logIntake(env, tid, { messageId: row.message_id, from: row.from_addr, origFrom: res.origFrom, subject: row.subject, outcome: res.outcome, reason: "Re-run by " + me + ": " + res.reason, reference: res.reference, jobId: res.jobId, status: res.status, fields: res.fields, text: row.text });
    return json({ ok: true, ...res }, {}, env, request);
  }
  if (sub === "/config") {
    if (method === "GET") return json({ ok: true, config: await getIntakeConfig(env, tid) }, {}, env, request);
    if (method === "POST") {
      const b = await request.json().catch(() => ({}));
      const cur = await getIntakeConfig(env, tid);
      const next = { ...cur };
      if (b.enabled !== undefined) next.enabled = !!b.enabled;
      if (Array.isArray(b.allowFrom)) next.allowFrom = b.allowFrom.map(x => String(x || "").toLowerCase().trim()).filter(Boolean).slice(0, 50);
      await saveIntakeConfig(env, tid, next);
      return json({ ok: true, config: next }, {}, env, request);
    }
  }
  return error("Not found", 404, env, request);
}
