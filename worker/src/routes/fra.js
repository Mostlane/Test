// FRA follow-up — office disposition on completed FRA works.
// ---------------------------------------------------------------------------
// The FRA Works tracker (fra-tracker.html) lists a batch of completed jobs. The
// office then decides what happens next for each one:
//   • Quote Needed      — remedial works need pricing
//   • Quote Submitted   — a quote's gone out (optionally attach a copy)
//   • No Further Action — nothing more to do
// This is a SEPARATE layer from the job's work status (Complete/etc.) — it's the
// post-completion paperwork state, kept per job in app_config so it never
// touches the SLA job record.
//
// Store: app_config `fra:followup:<tid>` = { [jobId]: {status, quoteKey,
//   quoteName, by, at} }. Quote copies live in R2 JOB_FILES under
//   frafollowup/<tid>/<jobId>/<ts>-<name>.
//
//   GET  /fra/followup                 -> { ok, map }  (FullAccess|SLAAdmin)
//   POST /fra/followup                 -> set {id,status}, optional file (multipart)
//   POST /fra/followup/clear-quote     -> { id }  remove the attached copy
//   GET  /fra/quote?key=&exp=&sig=     -> stream the copy (PUBLIC, sig-verified)

import { corsHeaders } from "../lib/http.js";
import { requireSession, permissionsFor } from "../lib/auth.js";
import { tenantDB } from "../lib/tenantdb.js";
import { signedFileUrl, verifyFileSig } from "../lib/filesign.js";

const KEY = tid => `fra:followup:${tid}`;
const VALID = new Set(["quote_needed", "quote_submitted", "nfa", ""]);

async function loadMap(db) {
  const row = await db.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(db.tenantId, KEY(db.tenantId)).first();
  let m = {};
  try { m = row ? JSON.parse(row.value) : {}; } catch {}
  return m && typeof m === "object" ? m : {};
}
async function saveMap(db, m) {
  await db.prepare("INSERT INTO app_config (tenant_id, key, value) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(db.tenantId, KEY(db.tenantId), JSON.stringify(m)).run();
}

export async function handle(request, env, ctx, url, sess) {
  const cors = corsHeaders(env, request);
  const path = url.pathname;
  const method = request.method.toUpperCase();
  const q = url.searchParams;
  const json = (data, code = 200) =>
    new Response(JSON.stringify(data), { status: code, headers: { ...cors, "Content-Type": "application/json" } });

  // Stream an attached quote copy — PUBLIC, signature-gated (a logged-in session
  // also passes). <a>/<img> can't send an auth header.
  if (path === "/fra/quote" && method === "GET") {
    const key = q.get("key");
    if (!key || !String(key).startsWith("frafollowup/")) return json({ error: "Bad key" }, 400);
    if (!sess) sess = await requireSession(env, request);
    if (!sess && !(await verifyFileSig(env, key, q))) return new Response("Link expired or invalid", { status: 403, headers: cors });
    const obj = await env.JOB_FILES.get(key);
    if (!obj) return new Response("Not found", { status: 404, headers: cors });
    return new Response(obj.body, { status: 200, headers: {
      ...cors, "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
      "Content-Disposition": "inline", "Cache-Control": "private, max-age=3600",
    }});
  }

  // Everything else: office only (FullAccess | SLAAdmin).
  if (!sess) sess = await requireSession(env, request);
  if (!sess) return json({ ok: false, error: "Not authenticated" }, 401);
  const perms = await permissionsFor(env, sess.tenantId, sess.user.username);
  if (perms.FullAccess !== "Yes" && perms.SLAAdmin !== "Yes") return json({ ok: false, error: "Forbidden" }, 403);
  const db = tenantDB(env, sess.tenantId);

  if (path === "/fra/followup" && method === "GET") {
    const m = await loadMap(db);
    // Attach a fresh signed URL to each entry that has a copy.
    const out = {};
    for (const [id, e] of Object.entries(m)) {
      out[id] = { ...e };
      if (e && e.quoteKey) out[id].quoteUrl = await signedFileUrl(env, url.origin, "/fra/quote", e.quoteKey, 24 * 3600);
    }
    return json({ ok: true, map: out });
  }

  if (path === "/fra/followup" && method === "POST") {
    const ct = request.headers.get("Content-Type") || "";
    let id = "", status = "", file = null;
    if (ct.includes("multipart/form-data")) {
      const form = await request.formData();
      id = String(form.get("id") || "").trim();
      status = String(form.get("status") || "").trim();
      const f = form.get("file");
      if (f && typeof f === "object" && f.size) file = f;
    } else {
      const b = await request.json().catch(() => ({}));
      id = String(b.id || "").trim();
      status = String(b.status || "").trim();
    }
    if (!id) return json({ ok: false, error: "Missing job id" }, 400);
    if (!VALID.has(status)) return json({ ok: false, error: "Invalid status" }, 400);

    const m = await loadMap(db);
    const entry = m[id] || {};
    entry.status = status;
    entry.by = (sess.user && sess.user.username) || "?";
    entry.at = new Date().toISOString();

    if (file) {
      const safe = String(file.name || "quote").replace(/[^\w.\- ]+/g, "_").slice(0, 80);
      const key = `frafollowup/${sess.tenantId}/${id}/${Date.now()}-${safe}`;
      await env.JOB_FILES.put(key, file.stream(), { httpMetadata: { contentType: file.type || "application/octet-stream" } });
      // Replace any previous copy.
      if (entry.quoteKey && entry.quoteKey !== key) { try { await env.JOB_FILES.delete(entry.quoteKey); } catch {} }
      entry.quoteKey = key;
      entry.quoteName = safe;
    }

    // Clearing the disposition entirely (status "") with no file drops the row.
    if (!status && !entry.quoteKey) { delete m[id]; }
    else m[id] = entry;
    await saveMap(db, m);

    const resp = { ...entry };
    if (entry.quoteKey) resp.quoteUrl = await signedFileUrl(env, url.origin, "/fra/quote", entry.quoteKey, 24 * 3600);
    return json({ ok: true, id, entry: resp });
  }

  if (path === "/fra/followup/clear-quote" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const id = String(b.id || "").trim();
    if (!id) return json({ ok: false, error: "Missing job id" }, 400);
    const m = await loadMap(db);
    const entry = m[id];
    if (entry && entry.quoteKey) { try { await env.JOB_FILES.delete(entry.quoteKey); } catch {} delete entry.quoteKey; delete entry.quoteName; }
    if (entry && !entry.status) delete m[id]; else if (entry) m[id] = entry;
    await saveMap(db, m);
    return json({ ok: true, id });
  }

  return json({ ok: false, error: "Not found: " + path }, 404);
}
