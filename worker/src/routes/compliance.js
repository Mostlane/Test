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
    label TEXT,                  -- admin-given display name (rename + named custom docs e.g. "O&M for PV")
    pinned INTEGER DEFAULT 0,    -- 1 = keep as current (link several current docs of one type together)
    size INTEGER,
    doc_date TEXT,               -- certificate date (if parsed)
    source TEXT,                 -- SharePoint item id / webUrl — used to de-dupe re-runs
    uploaded_at TEXT
  )`).run();
  // Self-migrating: add label + pinned to any existing (pre-this-change) table.
  try { await env.DB.prepare("ALTER TABLE compliance_files ADD COLUMN label TEXT").run(); } catch {}
  try { await env.DB.prepare("ALTER TABLE compliance_files ADD COLUMN pinned INTEGER DEFAULT 0").run(); } catch {}
  try { await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_compfiles_code ON compliance_files(tenant_id, code, type)").run(); } catch {}
  // One row per source item (nulls stay distinct, so manual uploads aren't blocked).
  try { await env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_compfiles_src ON compliance_files(tenant_id, source)").run(); } catch {}
  // The compliance OVERLAY on a site: one row per store CODE (= sites.site_number,
  // the one canonical site home). Holds the compliance category (Retail/ELS/…) and
  // the per-type due dates. Name/postcode are cached fallbacks — the live values are
  // resolved from the `sites` table by code so there's no duplicate site list.
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS compliance_stores (
    tenant_id  INTEGER NOT NULL DEFAULT 1,
    code       TEXT NOT NULL,          -- = sites.site_number
    category   TEXT,                   -- Retail | ELS | ELS Private | Cobra | Wenzels | …
    name       TEXT,                   -- fallback only (canonical = sites.site_name)
    postcode   TEXT,                   -- fallback only
    due        TEXT,                   -- JSON { fiveYear:"YYYY-MM-DD", pat:…, em:…, pv:…, ev:…, forecourt:…, pump:… }
    active     INTEGER DEFAULT 1,
    updated_at TEXT,
    PRIMARY KEY (tenant_id, code)
  )`).run();
  READY = true;
}

// Compliance frequencies (years). EICR/5-Year is 5-yearly; everything else annual.
const DUE_YEARS = { fiveYear: 5 };
function addYears(dateStr, n) {
  const d = new Date(dateStr); if (isNaN(d)) return null;
  d.setUTCFullYear(d.getUTCFullYear() + n);
  return d.toISOString().slice(0, 10);
}
// Advance a store's due date for a type from a freshly-uploaded cert's date. Only
// called for "current" drag-drop uploads (bump=1), never the historical backfill,
// so importing old certs can't stomp the live due dates. Creates the store row if
// the cert was dropped on a code we weren't yet tracking.
async function bumpDue(env, tid, code, type, dateStr) {
  if (!dateStr) return;
  const next = addYears(dateStr, DUE_YEARS[type] || 1); if (!next) return;
  const at = new Date().toISOString();
  const row = await env.DB.prepare("SELECT due FROM compliance_stores WHERE tenant_id=? AND code=?").bind(tid, code).first();
  let due = {}; if (row && row.due) { try { due = JSON.parse(row.due) || {}; } catch {} }
  due[type] = next;
  if (row) await env.DB.prepare("UPDATE compliance_stores SET due=?, updated_at=? WHERE tenant_id=? AND code=?").bind(JSON.stringify(due), at, tid, code).run();
  else await env.DB.prepare("INSERT INTO compliance_stores (tenant_id, code, due, active, updated_at) VALUES (?,?,?,1,?)").bind(tid, code, JSON.stringify(due), at).run();
}

function jr(o, h, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...h, "Content-Type": "application/json" } }); }
const safeName = (s) => String(s || "file").replace(/[^\w.\-]+/g, "_").slice(0, 120);
// A store's compliance code is a numeric store number (4-digit, zero-padded).
// A code carrying a LETTER (e.g. a project "P0002") is NOT a Co-op store — return
// "" so it never resolves onto a real store's certs (stripping the letter would
// turn "P0002" into "0002"). An empty/no-digit code is also "" (not "0000").
const pad4 = (v) => { const s = String(v ?? ""); if (/[a-z]/i.test(s)) return ""; const d = s.replace(/\D/g, ""); return d ? d.padStart(4, "0") : ""; };

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

// Map a compliance category label to the portal's canonical lowercase client id
// (matches how sites are already stored: retail/els/els_private/cobra/wenzels).
const CLIENT_MAP = { "retail":"retail", "els":"els", "els private":"els_private", "cobra":"cobra", "wenzel's":"wenzels", "wenzels":"wenzels" };
function complianceClient(cat) {
  const k = String(cat || "").toLowerCase().trim();
  return CLIENT_MAP[k] || k.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "general";
}

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
      "SELECT id, type, year, r2_key, filename, label, pinned, size, doc_date, uploaded_at FROM compliance_files WHERE tenant_id=? AND code=? ORDER BY COALESCE(doc_date,uploaded_at) DESC"
    ).bind(tid, code).all();
    const byType = {};
    for (const r of results || []) {
      (byType[r.type] = byType[r.type] || []).push({
        id: r.id, year: r.year, filename: r.filename, label: r.label || null, pinned: r.pinned ? 1 : 0,
        size: r.size, date: r.doc_date || r.uploaded_at,
        url: await signedFileUrl(env, url.origin, "/compliance/file", r.r2_key)
      });
    }
    // "current" set per type: if any files are pinned, ALL pinned ones are current
    // (so two linked docs — e.g. a 5-Year report split across two PDFs — both stay
    // current); otherwise the newest single file is current, the rest previous.
    for (const t of Object.keys(byType)) {
      const arr = byType[t];
      const anyPinned = arr.some(f => f.pinned);
      arr.forEach((f, i) => { f.current = anyPinned ? !!f.pinned : (i === 0); });
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
    // Optional admin display name (e.g. a named custom "O&M for PV" doc, or a
    // clearer name than the raw filename). Empty → null (falls back to filename).
    const label = String(form.get("label") || "").slice(0, 160).trim() || null;
    const at = new Date().toISOString();
    const key = `compliance/${code}/${type}/${year || "_"}/${Date.now()}-${fname}`;
    await env.JOB_FILES.put(key, file.stream(), { httpMetadata: { contentType: file.type || "application/octet-stream" } });
    const docDate = String(form.get("date") || "") || null;
    const res = await env.DB.prepare(
      "INSERT INTO compliance_files (tenant_id, code, type, year, r2_key, filename, label, size, doc_date, source, uploaded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(tid, code, type, year, key, fname, label, file.size || null, docDate, source, at).run();
    // A "current" drag-drop upload (bump=1) advances the store's due date from the
    // new cert's date; the historical backfill never sends bump, so it can't stomp
    // the live due dates.
    if (form.get("bump") && docDate) { try { await bumpDue(env, tid, code, type, docDate); } catch {} }
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

  // ── Update a document: rename (label) and/or pin it as current (link) ────────
  // Body { id, label?, pinned? }. `label` is a display name (empty clears it back
  // to the filename); `pinned` marks the doc as a current/linked one for its type.
  if (sub === "/file-update" && method === "POST") {
    if (!canWrite) return jr({ error: "Compliance access required" }, headers, 403);
    const b = await request.json().catch(() => ({}));
    const id = parseInt(b.id, 10);
    if (!id) return jr({ error: "id required" }, headers, 400);
    const sets = [], vals = [];
    if (b.label != null) { sets.push("label=?"); vals.push(String(b.label).slice(0, 160).trim() || null); }
    if (b.pinned != null) { sets.push("pinned=?"); vals.push(b.pinned ? 1 : 0); }
    if (!sets.length) return jr({ error: "nothing to update" }, headers, 400);
    vals.push(tid, id);
    await env.DB.prepare(`UPDATE compliance_files SET ${sets.join(", ")} WHERE tenant_id=? AND id=?`).bind(...vals).run();
    return jr({ ok: true }, headers);
  }

  // ── The compliance chart, single-sourced from the `sites` home ──────────────
  // Each row = a compliance store (by code) with its name/postcode resolved LIVE
  // from the sites table (fallback to the cached copy), its category + due dates,
  // and which types already have a document on file (drives the 📄 links).
  if (sub === "/stores" && method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT cs.code, cs.category, cs.name AS cname, cs.postcode AS cpost, cs.due, cs.active,
              s.site_name AS sname, s.postcode AS spost
         FROM compliance_stores cs
         LEFT JOIN sites s ON s.tenant_id = cs.tenant_id AND s.site_number = cs.code
        WHERE cs.tenant_id = ?`
    ).bind(tid).all();
    // file index: which types each store has ≥1 document for
    const idx = {};
    const fi = await env.DB.prepare("SELECT code, type, COUNT(*) AS n FROM compliance_files WHERE tenant_id=? GROUP BY code, type").bind(tid).all();
    for (const r of fi.results || []) { (idx[r.code] = idx[r.code] || {})[r.type] = r.n; }
    const stores = (results || []).map(r => {
      let due = {}; if (r.due) { try { due = JSON.parse(r.due) || {}; } catch {} }
      return {
        code: r.code,
        name: r.sname || r.cname || "",
        postcode: r.spost || r.cpost || "",
        category: r.category || "",
        hasSite: !!r.sname,
        active: r.active == null ? 1 : r.active,
        due,
        files: idx[r.code] || {},
      };
    });
    return jr({ ok: true, stores, count: stores.length }, headers);
  }

  // ── One-time migration from the old mostlane-pos store list (browser-driven) ─
  // Body { stores:[{code,name,postcode,category,due:{type:date}}], createSites:bool }.
  // Upserts the overlay and (optionally) creates any missing canonical `sites` row
  // so the chart and Sites share one home with no duplicates.
  if (sub === "/stores/import" && method === "POST") {
    if (!canWrite) return jr({ error: "Compliance access required" }, headers, 403);
    const b = await request.json().catch(() => ({}));
    const rows = Array.isArray(b.stores) ? b.stores : [];
    if (!rows.length) return jr({ error: "stores[] required" }, headers, 400);
    const createSites = !!b.createSites;
    const at = new Date().toISOString();
    let imported = 0, matched = 0, sitesCreated = 0;
    for (const r of rows) {
      const code = pad4(r.code); if (!code || code === "0000") continue;
      const due = (r.due && typeof r.due === "object") ? r.due : {};
      // keep only real dates, canonicalising the type keys
      const dueClean = {};
      for (const [k, v] of Object.entries(due)) { const t = canonType(k); const s = String(v || "").trim(); if (s) dueClean[t] = s; }
      await env.DB.prepare(
        `INSERT INTO compliance_stores (tenant_id, code, category, name, postcode, due, active, updated_at)
         VALUES (?,?,?,?,?,?,1,?)
         ON CONFLICT(tenant_id, code) DO UPDATE SET
           category=COALESCE(excluded.category, compliance_stores.category),
           name=COALESCE(excluded.name, compliance_stores.name),
           postcode=COALESCE(excluded.postcode, compliance_stores.postcode),
           due=excluded.due, updated_at=excluded.updated_at`
      ).bind(tid, code, r.category || null, r.name || null, r.postcode || null, JSON.stringify(dueClean), at).run();
      imported++;
      const site = await env.DB.prepare("SELECT site_number FROM sites WHERE tenant_id=? AND site_number=?").bind(tid, code).first();
      if (site) matched++;
      else if (createSites && r.name) {
        // `sites.client` is NOT NULL. Map the compliance category to the portal's
        // canonical lowercase client id, and — crucially — write the full site
        // object into `data`, because /get-sites (and sites.html) render ONLY from
        // that JSON blob; a columns-only row shows up blank.
        const client = complianceClient(r.category);
        const name = String(r.name).slice(0, 200);
        const postcode = String(r.postcode || "").slice(0, 20);
        const data = JSON.stringify({ client, siteNumber: code, siteName: name, postcode, active: true });
        try {
          await env.DB.prepare(
            "INSERT INTO sites (tenant_id, client, site_number, site_name, postcode, active, archived, data, updated_at) VALUES (?,?,?,?,?,1,0,?,?)"
          ).bind(tid, client, code, name, postcode, data, at).run();
          sitesCreated++;
        } catch (e) { /* skip a store we can't create a site for */ }
      }
    }
    return jr({ ok: true, imported, matched, sitesCreated }, headers);
  }

  // ── Edit one store's category / due dates (replaces the mostlane-pos update) ─
  if (sub === "/store" && method === "POST") {
    if (!canWrite) return jr({ error: "Compliance access required" }, headers, 403);
    const b = await request.json().catch(() => ({}));
    const code = pad4(b.code);
    if (!code) return jr({ error: "code required" }, headers, 400);
    const at = new Date().toISOString();
    const row = await env.DB.prepare("SELECT due, category, name, postcode FROM compliance_stores WHERE tenant_id=? AND code=?").bind(tid, code).first();
    let due = {}; if (row && row.due) { try { due = JSON.parse(row.due) || {}; } catch {} }
    if (b.due && typeof b.due === "object") {
      for (const [k, v] of Object.entries(b.due)) { const t = canonType(k); const s = String(v == null ? "" : v).trim(); if (s) due[t] = s; else delete due[t]; }
    }
    const category = b.category != null ? String(b.category).slice(0, 60) : (row ? row.category : null);
    const name = b.name != null ? String(b.name).slice(0, 200) : (row ? row.name : null);
    const postcode = b.postcode != null ? String(b.postcode).slice(0, 20) : (row ? row.postcode : null);
    await env.DB.prepare(
      `INSERT INTO compliance_stores (tenant_id, code, category, name, postcode, due, active, updated_at)
       VALUES (?,?,?,?,?,?,1,?)
       ON CONFLICT(tenant_id, code) DO UPDATE SET category=excluded.category, name=excluded.name, postcode=excluded.postcode, due=excluded.due, updated_at=excluded.updated_at`
    ).bind(tid, code, category, name, postcode, JSON.stringify(due), at).run();
    return jr({ ok: true, code, due }, headers);
  }

  // ── Remove a store from the chart (keeps its documents) ─────────────────────
  if (sub === "/store-delete" && method === "POST") {
    if (!canWrite) return jr({ error: "Compliance access required" }, headers, 403);
    const b = await request.json().catch(() => ({}));
    const code = pad4(b.code);
    if (!code) return jr({ error: "code required" }, headers, 400);
    await env.DB.prepare("DELETE FROM compliance_stores WHERE tenant_id=? AND code=?").bind(tid, code).run();
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
