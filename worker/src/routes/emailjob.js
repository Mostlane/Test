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
// Extraction is TEMPLATE-FIRST (routes/emailtemplates.js — one deterministic
// reader per known layout: Concerto job / order / notice, Chapplins job, Metro
// Rod paperwork, our own outbound). A job is only ever created automatically
// from a layout we've seen and tested. Anything else — an unknown layout, or a
// known layout with a field the template couldn't read — is HELD FOR A HUMAN
// ("review": logged, the office is pushed, one tap to create or dismiss on
// email-intake.html). The AI (env.ANTHROPIC_API_KEY) only PROPOSES fields for
// unknown layouts to save the office retyping; it never creates a job unless
// the office switches `aiAutoCreate` on. Nothing is sent to the AI except the
// email's text body (attachments are dropped during MIME parsing), capped.
// ─────────────────────────────────────────────────────────────────────────────

import { json, error } from "../lib/http.js";
import { permissionsFor } from "../lib/auth.js";
import { resolveTenantId } from "../lib/tenantdb.js";
import { matchTemplate, templateDomain, lookupSite, TEMPLATES } from "./emailtemplates.js";
import { sendToPermission, resolveNotificationsByTag } from "./push.js";
import { onceMigration } from "../lib/once.js";

/* ── Intake log + config ──────────────────────────────────────────────────────
   Every email the worker receives is logged (what came in, what we made of it,
   what happened) so the office can SEE the intake working — and re-run one.  */
const T = "inbound_emails";
async function ensureTable__raw(env) {
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ${T} (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT, message_id TEXT, received_at TEXT,
      from_addr TEXT, orig_from TEXT, subject TEXT, outcome TEXT, reason TEXT, reference TEXT,
      job_id TEXT, status_code INTEGER, fields TEXT, text TEXT)`).run();
    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS ${T}_mid ON ${T}(tenant_id, message_id)`).run();
  } catch {}
}
const ensureTable = onceMigration(ensureTable__raw); // once per isolate — see lib/once.js
const DEFAULT_CFG = { enabled: true, allowFrom: ["concerto.co.uk", "chapplins.co.uk", "mostlane.com"], aiAutoCreate: false };
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
    const r = await env.DB.prepare(`INSERT INTO ${T} (tenant_id, message_id, received_at, from_addr, orig_from, subject, outcome, reason, reference, job_id, status_code, fields, text)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(tid, rec.messageId || "", rec.receivedAt || new Date().toISOString(), rec.from || "", rec.origFrom || "", (rec.subject || "").slice(0, 300),
        rec.outcome || "", (rec.reason || "").slice(0, 300), rec.reference || "", rec.jobId || "", rec.status || null,
        JSON.stringify(rec.fields || null), (rec.text || "").slice(0, 12000)).run();
    return (r && r.meta && r.meta.last_row_id) || null;
  } catch (e) { console.error("email intake log:", e && e.message); return null; }
}
/* Ask the office to look at a held email (actionable — stays until created/dismissed). */
async function pushReview(env, tid, id, subject, reason) {
  if (!id) return;
  try {
    await sendToPermission(env, tid, ["FullAccess", "SLAAdmin"], {
      title: "📨 Email needs a look", body: (subject || "(no subject)").slice(0, 120) + " — " + (reason || "").slice(0, 160),
      url: "/email-intake.html?review=" + id, tag: "email-review:" + id, actionable: true });
  } catch {}
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

/* Build the /sla/inbound payload from a fields object (template or AI). */
function jobPayload(fields, sender) {
  return {
    reference: fields.reference || undefined,
    description: fields.description || undefined,
    priority: fields.priority || undefined,
    siteCode: fields.siteCode || undefined,
    siteName: fields.siteName || undefined,
    address: fields.address || undefined,
    postcode: fields.postcode || undefined,
    telephone: fields.telephone || undefined,
    storeType: fields.storeType || undefined,
    raisedAt: fields.raisedAt || undefined,
    originator: "email",
    originatorEmail: sender || undefined,
    changedBy: "email"
  };
}
/* Create/update the job through /sla/inbound IN-PROCESS (no network) — the same
   dedupe-by-reference, priority/date parsing and assignment push as the old zap. */
async function createJob(env, ctx, fetchSelf, fields, sender) {
  const payload = jobPayload(fields, sender);
  const req = new Request("https://mostlane-api.internal/sla/inbound", {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": "Bearer " + (env.JOBS_INBOUND_TOKEN || "") },
    body: JSON.stringify(payload)
  });
  try {
    const resp = await fetchSelf(req, env, ctx);
    let out = {}; try { out = await resp.clone().json(); } catch {}
    if (!resp.ok) return { outcome: "failed", reason: (out && out.error) || ("HTTP " + resp.status), status: resp.status, reference: fields.reference || "", payload };
    const reason = out.linkedVisit
      ? (out.visitKind === "reassigned"
        ? "Re-assigned incident — new visit on the board, linked to our earlier job " + (out.previousRef || "") + " (" + (out.previousStatus || "") + ")"
        : "Same incident sent again — new visit on the board, linked to the finished job " + (out.previousRef || "") + " (" + (out.previousStatus || "") + ")")
      : (out.created ? "New job on the board" : "Existing job updated (same reference, still open)");
    return { outcome: out.created ? "created" : "updated", reason, status: resp.status, reference: out.reference || fields.reference || "", jobId: out.id || "", payload };
  } catch (e) {
    return { outcome: "failed", reason: "Couldn't reach /sla/inbound: " + String(e && e.message || e).slice(0, 120), reference: fields.reference || "", payload };
  }
}
/* The client cancelled a job / withdrew a quote request → POST /sla/inbound
   {action:"cancel"} in-process. Outcomes: cancelled (a job marked Cancelled, or
   the cancellation NOTED on an already-finished job), review (no job on the board
   for that incident, or a quote withdrawn on a job already Scheduled/in hand —
   the office decides), failed. */
async function cancelJob(env, ctx, fetchSelf, c, msg) {
  const body = { action: "cancel", kind: c.kind || "job", reference: c.reference || undefined, incident: c.incident || undefined,
    reason: c.reason || "", by: c.by || "client", at: msg.receivedAt || undefined };
  const req = new Request("https://mostlane-api.internal/sla/inbound", {
    method: "POST", headers: { "content-type": "application/json", "authorization": "Bearer " + (env.JOBS_INBOUND_TOKEN || "") }, body: JSON.stringify(body) });
  const what = c.kind === "quote" ? "Quote request withdrawn by the client" : "Job cancelled by the client";
  const label = c.reference || c.incident || "";
  try {
    const resp = await fetchSelf(req, env, ctx);
    let out = {}; try { out = await resp.clone().json(); } catch {}
    if (resp.status === 404 || (out && out.notFound)) return { outcome: "review", reason: what + " (" + label + ") but there's NO job for that incident on the board — check whether we hold it under another reference, then dismiss", reference: label, payload: body };
    if (!resp.ok) return { outcome: "failed", reason: (out && out.error) || ("HTTP " + resp.status), status: resp.status, reference: label, payload: body };
    if (out.noted) return { outcome: "cancelled", reason: what + " — job " + (out.reference || label) + " was already " + out.status + ", so nothing changed; the cancellation is noted on the job card", status: resp.status, reference: out.reference || label, jobId: out.id || "", payload: body };
    const done = Array.isArray(out.cancelled) ? out.cancelled : [];
    const heldList = Array.isArray(out.held) ? out.held : [];
    if (!done.length && heldList.length) {
      const h = heldList[0];
      return { outcome: "review", reason: what + " but job " + h.reference + " is " + h.status + (h.engineers && h.engineers.length ? " with " + h.engineers.join(", ") : "") + " — decide whether to cancel it (open the job) or leave it, then dismiss this", status: resp.status, reference: h.reference, jobId: h.id, payload: body };
    }
    const d = done[0] || {};
    const who = d.engineers && d.engineers.length ? " — " + d.engineers.join(", ") + " told" : "";
    return { outcome: "cancelled", reason: what + " — job " + (d.reference || label) + " marked Cancelled (was " + (d.previousStatus || "?") + ")" + who + (c.reason ? " · \"" + c.reason.slice(0, 120) + "\"" : "") + (heldList.length ? " · " + heldList.length + " other visit(s) left as they are" : ""), status: resp.status, reference: d.reference || label, jobId: d.id || "", payload: body };
  } catch (e) {
    return { outcome: "failed", reason: "Couldn't reach /sla/inbound: " + String(e && e.message || e).slice(0, 120), reference: label, payload: body };
  }
}
/* File a Concerto order sheet into the client-orders intake (certs.js) — the
   office then matches/approves it against a remedial. Same in-process trick. */
async function fileOrder(env, ctx, fetchSelf, order, msg) {
  const tok = (env.ORDERS_INBOUND_TOKEN || env.TASKS_INBOUND_TOKEN || env.JOBS_INBOUND_TOKEN || "");
  // A copy of the email rides with the order so any office user can read it from
  // the board (the mailbox itself is one person's Outlook).
  const body = { ...order, externalId: msg.messageId || undefined, notifiedAt: msg.receivedAt || undefined, link: undefined,
    emailSubject: String(msg.subject || "").slice(0, 300) || undefined, emailFrom: String(msg.from || "").slice(0, 200) || undefined,
    emailText: String(msg.text || "").slice(0, 12000) || undefined };
  const req = new Request("https://mostlane-api.internal/certs/remedials/order-inbound", {
    method: "POST", headers: { "content-type": "application/json", "authorization": "Bearer " + tok }, body: JSON.stringify(body) });
  try {
    const resp = await fetchSelf(req, env, ctx);
    let out = {}; try { out = await resp.clone().json(); } catch {}
    if (!resp.ok) return { outcome: "failed", reason: "Client-orders intake refused it: " + ((out && out.error) || ("HTTP " + resp.status)), status: resp.status, reference: order.orderNumber || "" };
    return { outcome: "order", reason: "Client order " + (order.orderNumber || "") + " filed for store " + (order.storeCode || "?") + (out.matched ? " — matches a remedial awaiting approval" : ""), status: resp.status, reference: order.orderNumber || "" };
  } catch (e) {
    return { outcome: "failed", reason: "Couldn't reach the client-orders intake: " + String(e && e.message || e).slice(0, 120), reference: order.orderNumber || "" };
  }
}

/* ── The pipeline (shared by the live email handler, the test box and re-run) ──
   Returns {outcome, reason, fields, reference, jobId, status, template, source}.
   outcome ∈ created | updated | order (client order filed) | cancelled (a client
   cancellation applied/noted on the job) | review (held for a
   human) | dropped (not a job) | ignored (sender not allowed / intake off) |
   duplicate (this message-id already made a job) | failed | dryrun.            */
export async function processEmail(env, ctx, fetchSelf, msg, opts = {}) {
  const tid = msg.tid || "1";
  const cfg = opts.cfg || await getIntakeConfig(env, tid);
  const { subject, origFrom } = unwrapForward(msg.subject, msg.text);
  const from = String(msg.from || "").toLowerCase();
  const sender = origFrom || from;
  const text = String(msg.text || "").slice(0, 12000);
  const base = { fields: null, reference: "", jobId: "", status: null, origFrom, subject, template: "", source: "" };

  if (!opts.dryRun && cfg.enabled === false) return { ...base, outcome: "ignored", reason: "Email intake is switched off" };
  // A REPLY in a thread is never a new job (a quoted original would re-read as one).
  if (/^\s*(?:re|aw|antw|sv)\s*:/i.test(String(msg.subject || ""))) return { ...base, outcome: "dropped", reason: "Reply in an existing thread — not a new job", source: "template" };
  // Known layouts come from trusted senders by definition; everything else must be on the allow-list.
  const tm = matchTemplate(sender, subject, text);
  if (!opts.force && !tm && !templateDomain(sender) && !senderAllowed(cfg, origFrom, from)) return { ...base, outcome: "ignored", reason: "Sender not on the allow-list (" + sender + ")" };
  if (!opts.dryRun && !opts.force && msg.messageId) {
    try {
      const dup = await env.DB.prepare(`SELECT id, job_id, reference FROM ${T} WHERE tenant_id=? AND message_id=? AND outcome IN ('created','updated','order','cancelled') LIMIT 1`).bind(tid, msg.messageId).first();
      if (dup) return { ...base, outcome: "duplicate", reason: "This email was already processed (log #" + dup.id + ")", reference: dup.reference || "", jobId: dup.job_id || "" };
    } catch {}
  }

  if (tm) {
    const r = tm.result, out = { ...base, template: tm.tpl.id, source: "template" };
    if (r.kind === "notice") return { ...out, outcome: "dropped", reason: r.reason || "Not a job" };
    if (r.kind === "cancel") {
      const c = { ...(r.cancel || {}), action: "cancel", isJob: false };
      if (r.missing && r.missing.length) return { ...out, fields: c, outcome: "review", reason: tm.tpl.label + " — couldn't read: " + r.missing.join(", ") };
      if (opts.dryRun) return { ...out, fields: c, outcome: "dryrun", reason: "Would mark job " + (c.reference || c.incident) + " as Cancelled" + (c.kind === "quote" ? " (quote request withdrawn — only if the job is still waiting)" : "") + (c.reason ? " — \"" + c.reason.slice(0, 100) + "\"" : ""), reference: c.reference || c.incident || "" };
      return { ...out, fields: c, ...(await cancelJob(env, ctx, fetchSelf, c, msg)) };
    }
    if (r.kind === "order") {
      if (r.missing && r.missing.length) return { ...out, fields: r.order, outcome: "review", reason: tm.tpl.label + " — couldn't read: " + r.missing.join(", ") };
      if (opts.dryRun) return { ...out, fields: r.order, outcome: "dryrun", reason: "Would file client order " + r.order.orderNumber + " for store " + r.order.storeCode + " (client orders, not the job board)", reference: r.order.orderNumber };
      return { ...out, fields: r.order, ...(await fileOrder(env, ctx, fetchSelf, r.order, msg)) };
    }
    const fields = r.fields || {};
    if (r.missing && r.missing.length) return { ...out, fields, outcome: "review", reason: tm.tpl.label + " — couldn't read: " + r.missing.join(", ") };
    if (r.siteLookup) {
      const hit = await lookupSite(env, tid, r.siteLookup);
      if (hit) { fields.siteCode = hit.siteCode; fields.siteName = hit.siteName; fields.siteMatched = true; }
      else fields.siteMatched = false;
    }
    if (opts.dryRun) return { ...out, fields, outcome: "dryrun", reason: "Would " + (fields.reference ? "create/update job " + fields.reference : "create a job") + (r.siteLookup ? (fields.siteMatched ? " at site " + fields.siteCode : " (property not matched to a site — the office links it)") : ""), reference: fields.reference || "", payload: jobPayload(fields, sender) };
    return { ...out, fields, ...(await createJob(env, ctx, fetchSelf, fields, sender)) };
  }

  // No template for this layout → HOLD for a human. The AI only proposes fields.
  let fields = null;
  if (!opts.noAi) fields = await aiExtract(env, { from: sender, subject, text });
  const out = { ...base, fields, source: fields ? "ai" : "none" };
  if (fields && fields.isJob === false) return { ...out, outcome: "dropped", reason: "No template for this layout; the AI read it as not a job (reply / order / quote / status update)" };
  const usable = fields && (String(fields.reference || "").trim() || String(fields.description || "").trim());
  if (cfg.aiAutoCreate === true && usable) {
    if (opts.dryRun) return { ...out, outcome: "dryrun", reason: "No template — AI auto-create is ON, would create job " + (fields.reference || "(no reference)"), reference: fields.reference || "", payload: jobPayload(fields, sender) };
    return { ...out, ...(await createJob(env, ctx, fetchSelf, fields, sender)) };
  }
  const why = usable ? "No template for this layout — the AI's reading is attached for you to check before it becomes a job"
    : (!env.ANTHROPIC_API_KEY || opts.noAi ? "No template for this layout (and no AI key to read it) — needs a look" : "No template for this layout and the AI couldn't read it — needs a look");
  return { ...out, outcome: "review", reason: (opts.dryRun ? "Would hold for a check: " : "") + why, reference: (fields && fields.reference) || "" };
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
  const receivedAt = new Date().toISOString();
  const res = await processEmail(env, ctx, fetchSelf, { tid, from, subject, text, messageId, receivedAt });
  const id = await logIntake(env, tid, { messageId, receivedAt, from, origFrom: res.origFrom, subject, outcome: res.outcome, reason: res.reason, reference: res.reference, jobId: res.jobId, status: res.status, fields: res.fields, text });
  if (res.outcome === "review" || res.outcome === "failed") await pushReview(env, tid, id, subject, res.reason);
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
    let review = 0; try { const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${T} WHERE tenant_id=? AND outcome='review'`).bind(tid).first(); review = (r && r.n) || 0; } catch {}
    return json({ ok: true, config: cfg, last, counts7d: counts, reviewOpen: review, templates: TEMPLATES.map(t => ({ id: t.id, label: t.label, domains: t.domains })), aiConfigured: !!env.ANTHROPIC_API_KEY, inboundConfigured: !!(env.JOBS_INBOUND_TOKEN || "").trim() }, {}, env, request);
  }
  if (sub === "/log" && method === "GET") {
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || 60));
    let rows = [];
    try { const { results } = await env.DB.prepare(`SELECT id, message_id, received_at, from_addr, orig_from, subject, outcome, reason, reference, job_id, status_code, fields, substr(text,1,4000) AS text FROM ${T} WHERE tenant_id=? ORDER BY id DESC LIMIT ?`).bind(tid, limit).all(); rows = results || []; } catch {}
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
    const res = await processEmail(env, ctx, fetchSelf, { tid, from: row.from_addr || "", subject: row.subject || "", text: row.text || "", messageId: row.message_id || "", receivedAt: row.received_at || "" }, { force: true });
    await logIntake(env, tid, { messageId: row.message_id, from: row.from_addr, origFrom: res.origFrom, subject: row.subject, outcome: res.outcome, reason: "Re-run by " + me + ": " + res.reason, reference: res.reference, jobId: res.jobId, status: res.status, fields: res.fields, text: row.text });
    return json({ ok: true, ...res }, {}, env, request);
  }
  if (sub === "/templates" && method === "GET") {
    return json({ ok: true, templates: TEMPLATES.map(t => ({ id: t.id, label: t.label, domains: t.domains })) }, {}, env, request);
  }
  // Held email → the office creates the job (with any corrections) or dismisses it.
  if ((sub === "/approve" || sub === "/dismiss") && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const row = await env.DB.prepare(`SELECT * FROM ${T} WHERE tenant_id=? AND id=?`).bind(tid, Number(b.id) || 0).first().catch(() => null);
    if (!row) return error("Log entry not found", 404, env, request);
    if (sub === "/dismiss") {
      await env.DB.prepare(`UPDATE ${T} SET outcome='dismissed', reason=? WHERE tenant_id=? AND id=?`).bind(("Dismissed by " + me + (b.note ? ": " + String(b.note).slice(0, 200) : "")).slice(0, 300), tid, row.id).run();
      ctx?.waitUntil?.(resolveNotificationsByTag(env, tid, "email-review:" + row.id, { title: "📨 Email dismissed", body: (row.subject || "").slice(0, 120) + " — dismissed by " + me }).catch(() => {}));
      return json({ ok: true, outcome: "dismissed" }, {}, env, request);
    }
    let stored = {}; try { stored = JSON.parse(row.fields || "{}") || {}; } catch {}
    const fields = { ...stored, ...(b.fields && typeof b.fields === "object" ? b.fields : {}) };
    if (!String(fields.reference || "").trim() && !String(fields.description || "").trim()) return error("A reference or a description is needed to create the job", 400, env, request);
    const res = await createJob(env, ctx, fetchSelf, fields, row.orig_from || row.from_addr || "");
    if (res.outcome === "failed") return json({ ok: false, error: res.reason, ...res }, { status: 502 }, env, request);
    await env.DB.prepare(`UPDATE ${T} SET outcome=?, reason=?, reference=?, job_id=?, status_code=?, fields=? WHERE tenant_id=? AND id=?`)
      .bind(res.outcome, ("Approved by " + me + " — " + res.reason).slice(0, 300), res.reference || "", res.jobId || "", res.status || null, JSON.stringify(fields), tid, row.id).run();
    ctx?.waitUntil?.(resolveNotificationsByTag(env, tid, "email-review:" + row.id, { title: "📨 Email → job " + (res.reference || ""), body: (row.subject || "").slice(0, 120) + " — created by " + me }).catch(() => {}));
    return json({ ok: true, ...res, fields }, {}, env, request);
  }
  if (sub === "/config") {
    if (method === "GET") return json({ ok: true, config: await getIntakeConfig(env, tid) }, {}, env, request);
    if (method === "POST") {
      const b = await request.json().catch(() => ({}));
      const cur = await getIntakeConfig(env, tid);
      const next = { ...cur };
      if (b.enabled !== undefined) next.enabled = !!b.enabled;
      if (Array.isArray(b.allowFrom)) next.allowFrom = b.allowFrom.map(x => String(x || "").toLowerCase().trim()).filter(Boolean).slice(0, 50);
      if (b.aiAutoCreate !== undefined) next.aiAutoCreate = b.aiAutoCreate === true;
      await saveIntakeConfig(env, tid, next);
      return json({ ok: true, config: next }, {}, env, request);
    }
  }
  return error("Not found", 404, env, request);
}
