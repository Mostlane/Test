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
export async function listRecentWithAttachments(env, mailbox, { days = 60, top = 40 } = {}) {
  const since = new Date(Date.now() - Math.max(1, days) * 86400000).toISOString();
  // Filter on receivedDateTime only (the property we also $orderby, which Graph
  // is happy to combine) and keep only messages WITH attachments in code — this
  // sidesteps the "filter/sort too complex" error that a boolean-plus-date
  // $filter can trigger. Pull a wider page since we post-filter.
  const q = `/users/${encodeURIComponent(mailbox)}/messages`
    + `?$select=id,subject,receivedDateTime,from,hasAttachments`
    + `&$filter=${encodeURIComponent(`receivedDateTime ge ${since}`)}`
    + `&$orderby=receivedDateTime desc&$top=${Math.max(1, Math.min(200, top * 4))}`;
  const j = await graphGet(env, q);
  return ((j && j.value) || []).filter(m => m.hasAttachments).slice(0, top);
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
