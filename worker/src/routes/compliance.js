// ============================================================================
// Compliance certificates (mounted at /compliance)
// ----------------------------------------------------------------------------
// The portal-native home for The Southern Co-op compliance certificates: files
// live in R2 (JOB_FILES under `compliance/<code>/<type>/<year>/…`) and are
// indexed in D1 (`compliance_files`), keyed by store CODE + compliance TYPE.
// A Graph-based extractor (run separately) streams each cert off SharePoint's
// "TSC Compliance" tree into POST /compliance/file. The compliance page joins
// these to its store rows by code so each store shows a live cert per type.
// ============================================================================

import { corsHeaders } from "../lib/http.js";
import { resolveTenantId } from "../lib/tenantdb.js";
import { permissionsFor, requireSession } from "../lib/auth.js";
import { signedFileUrl, verifyFileSig } from "../lib/filesign.js";

let READY = false;
async function ensure(env) {
  if (READY) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS compliance_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL DEFAULT 1,
    code TEXT NOT NULL,          -- store code (4 digits)
    type TEXT NOT NULL,          -- canonical: fiveYear|pat|em|pv|ev|forecourt|pump|other
    year TEXT,                   -- e.g. "2025" (if known)
    r2_key TEXT NOT NULL,
    filename TEXT,
    size INTEGER,
    doc_date TEXT,               -- certificate date (if parsed)
    source TEXT,                 -- SharePoint item id / webUrl — used to de-dupe re-runs
    uploaded_at TEXT
  )`).run();
  try { await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_compfiles_code ON compliance_files(tenant_id, code, type)").run(); } catch {}
  // One row per source item (nulls stay distinct, so manual uploads aren't blocked).
  try { await env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_compfiles_src ON compliance_files(tenant_id, source)").run(); } catch {}
  READY = true;
}

function jr(o, h, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...h, "Content-Type": "application/json" } }); }
const safeName = (s) => String(s || "file").replace(/[^\w.\-]+/g, "_").slice(0, 120);
const pad4 = (v) => String(v ?? "").replace(/\D/g, "").padStart(4, "0");

// Normalise any incoming type label (SharePoint subfolder or table key) to a
// canonical compliance type.
function canonType(t) {
  const s = String(t || "").toLowerCase();
  if (/5\s*year|five\s*year|eicr/.test(s)) return "fiveYear";
  if (/\bpat\b/.test(s)) return "pat";
  if (/emergency|\bem\b|em\s*light/.test(s)) return "em";
  if (/forecourt|\bpfs\b|petrol|fuel/.test(s)) return "forecourt";
  if (/\bpv\b|solar|photovolt/.test(s)) return "pv";
  if (/\bev\b|charge|ev\s*maint/.test(s)) return "ev";
  if (/pump|sump/.test(s)) return "pump";
  const k = s.replace(/[^a-z0-9]+/g, "");
  return k ? k.slice(0, 20) : "other";
}

async function isFull(env, tid, me) { try { const p = await permissionsFor(env, tid, me); return p.FullAccess === "Yes" || p.Compliance === "Yes"; } catch { return false; } }

// Machine-to-machine import token (for the SharePoint→R2 batch extractor, which
// can't hold a portal session). Timing-safe compare, same shape as /sla/inbound.
function importTokenOK(request, env) {
  const secret = (env.COMPLIANCE_IMPORT_TOKEN || "").trim().replace(/^Bearer\s+/i, "").trim();
  if (!secret) return false;
  const tok = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  let diff = tok.length === secret.length ? 0 : 1;
  for (let i = 0; i < Math.min(tok.length, secret.length); i++) diff |= tok.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}

export async function handle(request, env, ctx, url, sess) {
  const headers = corsHeaders(env, request);
  const method = request.method.toUpperCase();
  const sub = url.pathname.replace(/^\/compliance(?=\/|$)/, "") || "/";
  const q = url.searchParams;

  // ── Public: stream a certificate (access gated by the signed link) ──────────
  if (sub === "/file" && method === "GET" && q.get("key")) {
    const key = q.get("key");
    if (!key || !String(key).startsWith("compliance/")) return jr({ error: "Bad key" }, headers, 400);
    if (!sess && !(await verifyFileSig(env, key, q))) return jr({ error: "Link expired or invalid" }, headers, 403);
    const obj = await env.JOB_FILES.get(key);
    if (!obj) return new Response("Not found", { status: 404, headers });
    return new Response(obj.body, { status: 200, headers: {
      ...headers,
      "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
      "Content-Disposition": "inline",
      "Cache-Control": "private, max-age=3600"
    }});
  }

  // The batch extractor authenticates with COMPLIANCE_IMPORT_TOKEN instead of a
  // session — it may only touch the ingest/dedupe routes (/file POST, /has),
  // which are declared public so the token (not a session) reaches here. On
  // those public routes `sess` arrives null even for a logged-in admin, so we
  // re-resolve a real session from the Authorization header when there's no
  // import token — that keeps the admin manual-upload path working too.
  const viaToken = !sess && importTokenOK(request, env);
  if (!sess && !viaToken) { try { sess = await requireSession(env, request); } catch { sess = null; } }
  if (!sess && !viaToken) return jr({ error: "Not authenticated" }, headers, 401);
  const tid = sess ? (sess.tenantId != null ? sess.tenantId : await resolveTenantId(env, request)) : await resolveTenantId(env, request);
  const me = sess ? sess.user.username : "import-bot";
  const canWrite = viaToken || (await isFull(env, tid, me));
  await ensure(env);

  // ── Dedupe check: has this SharePoint item already been ingested? ───────────
  if (sub === "/has" && method === "GET") {
    const source = q.get("source") || "";
    if (!source) return jr({ error: "source required" }, headers, 400);
    const row = await env.DB.prepare("SELECT id FROM compliance_files WHERE tenant_id=? AND source=?").bind(tid, source).first();
    return jr({ ok: true, exists: !!row, id: row ? row.id : null }, headers);
  }

  // ── Compact index: which types each store has a cert for (for the table) ────
  if (sub === "/index" && method === "GET") {
    const { results } = await env.DB.prepare("SELECT DISTINCT code, type FROM compliance_files WHERE tenant_id=?").bind(tid).all();
    const map = {};
    for (const r of results || []) { (map[r.code] = map[r.code] || {})[r.type] = 1; }
    return jr({ ok: true, map, stores: Object.keys(map).length }, headers);
  }

  // ── One store's files (grouped by type, newest first, signed URLs) ──────────
  if (sub === "/files" && method === "GET") {
    const code = pad4(q.get("code"));
    if (!code) return jr({ error: "code required" }, headers, 400);
    const { results } = await env.DB.prepare(
      "SELECT id, type, year, r2_key, filename, size, doc_date, uploaded_at FROM compliance_files WHERE tenant_id=? AND code=? ORDER BY COALESCE(doc_date,uploaded_at) DESC"
    ).bind(tid, code).all();
    const byType = {};
    for (const r of results || []) {
      (byType[r.type] = byType[r.type] || []).push({
        id: r.id, year: r.year, filename: r.filename, size: r.size, date: r.doc_date || r.uploaded_at,
        url: await signedFileUrl(env, url.origin, "/compliance/file", r.r2_key)
      });
    }
    return jr({ ok: true, code, files: byType }, headers);
  }

  // ── Latest cert URL for a store+type (used by the 📄 links) ─────────────────
  if (sub === "/file-url" && method === "GET") {
    const code = pad4(q.get("code")), type = canonType(q.get("type"));
    const row = await env.DB.prepare(
      "SELECT r2_key FROM compliance_files WHERE tenant_id=? AND code=? AND type=? ORDER BY COALESCE(doc_date,uploaded_at) DESC LIMIT 1"
    ).bind(tid, code, type).first();
    if (!row) return jr({ error: "No file" }, headers, 404);
    return jr({ ok: true, url: await signedFileUrl(env, url.origin, "/compliance/file", row.r2_key) }, headers);
  }

  // ── Ingest a certificate (the extractor + manual upload) ────────────────────
  // multipart: file + code, type, year?, date?, filename?, source?
  if (sub === "/file" && method === "POST") {
    if (!canWrite) return jr({ error: "Compliance access required" }, headers, 403);
    let form; try { form = await request.formData(); } catch { return jr({ error: "multipart required" }, headers, 400); }
    const file = form.get("file");
    const code = pad4(form.get("code"));
    const type = canonType(form.get("type"));
    if (!file || typeof file === "string" || !code) return jr({ error: "file and code required" }, headers, 400);
    const source = String(form.get("source") || "").slice(0, 400) || null;
    if (source) {
      const dup = await env.DB.prepare("SELECT id, r2_key FROM compliance_files WHERE tenant_id=? AND source=?").bind(tid, source).first();
      if (dup) return jr({ ok: true, duplicate: true, id: dup.id }, headers);
    }
    const year = String(form.get("year") || "").replace(/[^0-9]/g, "").slice(0, 4) || null;
    const fname = safeName(form.get("filename") || file.name || (type + ".pdf"));
    const at = new Date().toISOString();
    const key = `compliance/${code}/${type}/${year || "_"}/${Date.now()}-${fname}`;
    await env.JOB_FILES.put(key, file.stream(), { httpMetadata: { contentType: file.type || "application/octet-stream" } });
    const res = await env.DB.prepare(
      "INSERT INTO compliance_files (tenant_id, code, type, year, r2_key, filename, size, doc_date, source, uploaded_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
    ).bind(tid, code, type, year, key, fname, file.size || null, String(form.get("date") || "") || null, source, at).run();
    return jr({ ok: true, id: res.meta ? res.meta.last_row_id : null, key, code, type }, headers, 201);
  }

  // ── Delete a certificate (admin) ────────────────────────────────────────────
  if (sub === "/file-delete" && method === "POST") {
    if (!canWrite) return jr({ error: "Compliance access required" }, headers, 403);
    const b = await request.json().catch(() => ({}));
    const id = parseInt(b.id, 10);
    if (!id) return jr({ error: "id required" }, headers, 400);
    const row = await env.DB.prepare("SELECT r2_key FROM compliance_files WHERE tenant_id=? AND id=?").bind(tid, id).first();
    if (row) { try { await env.JOB_FILES.delete(row.r2_key); } catch {} }
    await env.DB.prepare("DELETE FROM compliance_files WHERE tenant_id=? AND id=?").bind(tid, id).run();
    return jr({ ok: true }, headers);
  }

  // ── Summary / progress (how many certs stored, by type) ─────────────────────
  if (sub === "/summary" && method === "GET") {
    const total = (await env.DB.prepare("SELECT COUNT(*) AS n FROM compliance_files WHERE tenant_id=?").bind(tid).first())?.n || 0;
    const { results } = await env.DB.prepare("SELECT type, COUNT(*) AS n FROM compliance_files WHERE tenant_id=? GROUP BY type").bind(tid).all();
    const byType = {}; (results || []).forEach(r => { byType[r.type] = r.n; });
    const stores = (await env.DB.prepare("SELECT COUNT(DISTINCT code) AS n FROM compliance_files WHERE tenant_id=?").bind(tid).first())?.n || 0;
    return jr({ ok: true, total, stores, byType }, headers);
  }

  return jr({ error: "Not found: " + sub }, headers, 404);
}
