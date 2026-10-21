// Microsoft Graph mail reader (application / client-credentials) — lets the
// worker read a shared mailbox server-side so the PO board can sweep it for
// supplier-invoice PDFs. Needs three worker secrets:
//   GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET
// and the app must hold the Graph APPLICATION permission Mail.Read (admin-
// consented). Everything here is READ-ONLY (list messages, read attachments).

const GRAPH = "https://graph.microsoft.com/v1.0";

export function graphConfigured(env) {
  return !!(env && env.GRAPH_TENANT_ID && env.GRAPH_CLIENT_ID && env.GRAPH_CLIENT_SECRET);
}

// Per-isolate token cache (tokens last ~1h; refresh a minute early).
let _tok = { value: "", exp: 0 };
async function getToken(env) {
  const now = Date.now();
  if (_tok.value && now < _tok.exp - 60000) return _tok.value;
  const url = `https://login.microsoftonline.com/${encodeURIComponent(env.GRAPH_TENANT_ID)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: env.GRAPH_CLIENT_ID,
    client_secret: env.GRAPH_CLIENT_SECRET,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    const msg = (j && (j.error_description || j.error)) || ("HTTP " + r.status);
    throw new Error("Graph sign-in failed: " + String(msg).split("\n")[0].slice(0, 200));
  }
  _tok = { value: j.access_token, exp: now + (Number(j.expires_in || 3600) * 1000) };
  return _tok.value;
}

async function graphGet(env, path, { raw } = {}) {
  const token = await getToken(env);
  const r = await fetch(GRAPH + path, { headers: { authorization: "Bearer " + token } });
  if (!r.ok) {
    let d = ""; try { d = (await r.json())?.error?.message || ""; } catch {}
    const e = new Error("Graph error " + r.status + (d ? ": " + d : ""));
    e.status = r.status; throw e;
  }
  return raw ? new Uint8Array(await r.arrayBuffer()) : r.json();
}

// Generic JSON call (GET/POST/PATCH) — used by the Co-op spreadsheet feed
// (lib/coopsheet.js), which writes rows into an Excel workbook. Needs the app
// permission Files.ReadWrite.All. Retries once with a fresh token on 401/403
// (a token minted before the permission was granted carries no write role).
export async function graphJson(env, method, path, body) {
  const call = async () => fetch(GRAPH + path, {
    method,
    headers: { authorization: "Bearer " + (await getToken(env)), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let r = await call();
  if (r.status === 401 || r.status === 403) { _tok = { value: "", exp: 0 }; r = await call(); }
  // Busy / throttled (429, 503, 504 — e.g. FileOpenHostTooManyRequests when
  // several emails land at once): wait and try again, honouring Retry-After.
  for (let i = 0; i < 4 && (r.status === 429 || r.status === 503 || r.status === 504); i++) {
    const ra = Number(r.headers.get("retry-after"));
    const wait = Math.min(10000, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1500 * 2 ** i);
    await new Promise(res => setTimeout(res, wait));
    r = await call();
  }
  let j = null; try { j = await r.json(); } catch {}
  if (!r.ok) {
    const d = j && j.error ? ((j.error.code ? j.error.code + ": " : "") + (j.error.message || "")) : "";
    const e = new Error("Microsoft 365 refused (" + r.status + ")" + (d ? " — " + d.slice(0, 220) : ""));
    e.status = r.status; throw e;
  }
  return j;
}

// JSON $batch: up to 20 sub-requests per call. sequential (default) chains
// each on the one before — workbook writes clash when run in parallel. Returns one
// {status, body} per request, in the order given. Throws only if the batch
// call itself is refused; a failed sub-request comes back with its status.
export async function graphBatch(env, reqs, { sequential = true } = {}) {
  const out = [];
  for (let i = 0; i < reqs.length; i += 20) {
    const chunk = reqs.slice(i, i + 20).map((q, k) => ({
      id: String(k + 1), method: q.method, url: q.url,
      ...(k && sequential ? { dependsOn: [String(k)] } : {}),
      ...(q.body !== undefined ? { body: q.body, headers: { "content-type": "application/json" } } : {}),
    }));
    const j = await graphJson(env, "POST", "/$batch", { requests: chunk });
    const byId = {}; for (const r of (j && j.responses) || []) byId[r.id] = r;
    chunk.forEach(c => { const r = byId[c.id] || {}; out.push({ status: Number(r.status) || 0, body: r.body }); });
  }
  return out;
}

// A quick reachability check for the sweep setup UI: can we sign in AND see the
// mailbox? Returns {ok, error?}.
export async function graphMailboxCheck(env, mailbox) {
  if (!graphConfigured(env)) return { ok: false, error: "Graph isn't configured (missing GRAPH_* secrets)." };
  try {
    await getToken(env);
    await graphGet(env, `/users/${encodeURIComponent(mailbox)}/messages?$top=1&$select=id`);
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

// List recent messages in `mailbox` that have attachments, newest first, within
// the last `days`. Returns lightweight message headers.
// Precedence for what to read: an explicit date range (from/to, "Advanced
// search") wins; then `since` (an incremental high-watermark — only emails that
// arrived AFTER the last scan); then the rolling `days` look-back.
export async function listRecentWithAttachments(env, mailbox, { days = 60, top = 40, from, to, clue, since, before } = {}) {
  // Filter on receivedDateTime only (the property we also $orderby, which Graph
  // is happy to combine) and keep only messages WITH attachments in code — this
  // sidesteps the "filter/sort too complex" error that a boolean-plus-date
  // $filter can trigger. Pull a wider page since we post-filter.
  let filter;
  const iso = (s, endOfDay) => {
    const d = new Date(String(s).length <= 10 ? s + (endOfDay ? "T23:59:59Z" : "T00:00:00Z") : s);
    return isNaN(d) ? null : d.toISOString();
  };
  const fIso = from ? iso(from, false) : null;
  const tIso = to ? iso(to, true) : null;
  const sinceIso = since ? iso(since, false) : null;
  const beforeIso = before ? iso(before, false) : null;
  const floorIso = new Date(Date.now() - Math.max(1, days) * 86400000).toISOString();
  if (fIso || tIso) {
    const parts = [];
    if (fIso) parts.push(`receivedDateTime ge ${fIso}`);
    if (tIso) parts.push(`receivedDateTime le ${tIso}`);
    filter = parts.join(" and ");
  } else if (sinceIso || beforeIso) {
    // Incremental forward read (gt: newer than the last email we read) OR the
    // backfill walk (lt: older than what we've already covered) — either way kept
    // within the look-back window so it can't run off to the start of the mailbox.
    const parts = [];
    if (sinceIso) parts.push(`receivedDateTime gt ${sinceIso}`);
    if (beforeIso) parts.push(`receivedDateTime lt ${beforeIso}`);
    parts.push(`receivedDateTime ge ${floorIso}`);
    filter = parts.join(" and ");
  } else {
    filter = `receivedDateTime ge ${floorIso}`;
  }
  const q = `/users/${encodeURIComponent(mailbox)}/messages`
    + `?$select=id,subject,receivedDateTime,from,hasAttachments`
    + `&$filter=${encodeURIComponent(filter)}`
    + `&$orderby=receivedDateTime desc&$top=${Math.max(1, Math.min(300, top * 4))}`;
  const j = await graphGet(env, q);
  let msgs = ((j && j.value) || []).filter(m => m.hasAttachments);
  // A "clue" narrows by sender or subject (case-insensitive), in code so it never
  // clashes with the $filter/$orderby Graph combination.
  const c = String(clue || "").trim().toLowerCase();
  if (c) {
    msgs = msgs.filter(m => {
      const subj = String(m.subject || "").toLowerCase();
      const ea = (m.from && m.from.emailAddress) || {};
      const frm = (String(ea.address || "") + " " + String(ea.name || "")).toLowerCase();
      return subj.includes(c) || frm.includes(c);
    });
  }
  return msgs.slice(0, top);
}

// The PDF (or PDF-shaped) file attachments on one message — metadata only.
export async function listPdfAttachments(env, mailbox, messageId) {
  const q = `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}/attachments`
    + `?$select=id,name,contentType,size`;
  const j = await graphGet(env, q);
  const items = (j && j.value) || [];
  return items.filter(a => {
    const isFile = String(a["@odata.type"] || "").includes("fileAttachment") || a.size != null;
    const name = String(a.name || "").toLowerCase();
    const ct = String(a.contentType || "").toLowerCase();
    // Many merchants tag invoice PDFs as application/octet-stream — accept those
    // when the filename ends .pdf (the reader still reads the real bytes).
    const pdfish = ct.includes("pdf") || name.endsWith(".pdf") || (ct.includes("octet-stream") && name.endsWith(".pdf"));
    return isFile && pdfish && Number(a.size || 0) < 20 * 1024 * 1024;
  });
}

// Download one attachment's raw bytes.
export async function downloadAttachment(env, mailbox, messageId, attachmentId) {
  return graphGet(env, `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/$value`, { raw: true });
}

// Send an email AS `mailbox` (a real Microsoft 365 mailbox, e.g. enquiries@)
// via Graph sendMail — it goes out from Microsoft's own servers and lands in
// that mailbox's Sent Items. Needs the APPLICATION permission Mail.Send
// (admin-consented). Returns {ok:true, via:"m365"} or {ok:false, error}.
export async function graphSendMail(env, mailbox, { to, cc, replyTo, subject, html, from } = {}) {
  if (!graphConfigured(env)) return { ok: false, error: "Microsoft 365 connection isn't set up (GRAPH_* secrets missing)" };
  const list = v => (Array.isArray(v) ? v : String(v || "").split(/[,;]/)).map(s => String(s).trim()).filter(Boolean)
    .map(address => ({ emailAddress: { address } }));
  const message = { subject: String(subject || ""), body: { contentType: "HTML", content: String(html || "") }, toRecipients: list(to) };
  if (!message.toRecipients.length) return { ok: false, error: "no recipient" };
  const ccl = list(cc); if (ccl.length) message.ccRecipients = ccl;
  const rtl = list(replyTo); if (rtl.length) message.replyTo = rtl;
  // Send AS an alias / shared address of this mailbox (e.g. enquiries@ on jamie@).
  if (from && String(from).trim().toLowerCase() !== String(mailbox).trim().toLowerCase()) message.from = { emailAddress: { address: String(from).trim() } };
  try {
    const send = async () => fetch(`${GRAPH}/users/${encodeURIComponent(mailbox)}/sendMail`, {
      method: "POST",
      headers: { authorization: "Bearer " + (await getToken(env)), "content-type": "application/json" },
      body: JSON.stringify({ message, saveToSentItems: true }),
    });
    let r = await send();
    // A cached token minted before Mail.Send was granted carries no send role —
    // drop it and sign in afresh once before giving up.
    if (r.status === 401 || r.status === 403) { _tok = { value: "", exp: 0 }; r = await send(); }
    if (r.status === 202 || r.ok) return { ok: true, via: "m365" };
    let d = ""; try { const j = await r.json(); d = (j && j.error && (j.error.code ? j.error.code + ": " : "") + (j.error.message || "")) || ""; } catch {}
    return { ok: false, status: r.status, error: "Microsoft 365 refused (" + r.status + ")" + (d ? " — " + d.slice(0, 200) : "") };
  } catch (e) { return { ok: false, error: String(e && e.message || e).slice(0, 200) }; }
}
