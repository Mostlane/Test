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
  if (!ref && !fault) return null;
  return {
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
      raisedAt: { type: "string", description: "ISO 8601 date-time the job was logged/raised IF clearly stated, else ''." }
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

/* Entry point wired from index.js's email() handler. fetchSelf is the worker's
   own fetch (so we reuse /sla/inbound verbatim, incl. its dedupe-by-reference,
   forgiving priority/date parsing and assignment push). */
export async function handleInboundEmail(message, env, ctx, fetchSelf) {
  const from = String(message.from || "").toLowerCase();
  let subject = "";
  try { subject = message.headers.get("subject") || ""; } catch { }
  const raw = await readRaw(message);
  const text = (extractText(raw) || "").slice(0, 12000);

  let fields = await aiExtract(env, { from, subject, text });
  if (!fields) fields = concertoRegex(subject, text);   // AI off / errored → template fallback
  if (!fields || !fields.isJob) { console.log("email: not a job —", subject); return; }
  if (!String(fields.reference || "").trim() && !String(fields.description || "").trim()) {
    console.log("email: job but no reference/description —", subject); return;
  }

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
    originatorEmail: from || undefined,
    changedBy: "email"
  };

  // Reuse /sla/inbound exactly, in-process (no network). The token header must
  // match the JOBS_INBOUND_TOKEN secret the endpoint checks.
  const req = new Request("https://mostlane-api.internal/sla/inbound", {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": "Bearer " + (env.JOBS_INBOUND_TOKEN || "") },
    body: JSON.stringify(payload)
  });
  try {
    const resp = await fetchSelf(req, env, ctx);
    let out = {}; try { out = await resp.clone().json(); } catch { }
    console.log("email→job", resp.status, out && out.reference, "—", subject);
  } catch (e) {
    console.error("email→job failed:", e && e.message, "—", subject);
  }
}
