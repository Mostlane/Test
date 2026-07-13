// H&S documents — inductions, hot-works (and other) permits, RAMS, incident
// reports. ONE generic store serves every type: `doc_type` says which, and the
// whole form (fields + inline signature data URLs) lives in `data`. Human
// reference numbers mirror the old SiteLog style (IND-0001, HWP-<site>-<date>-n).
//
//   GET  /hs/docs[?type=]      list (lightweight) for the tenant
//   GET  /hs/doc?id=           one full document
//   POST /hs/doc               create or update  { id?, doc_type, site, data, status? }
//   POST /hs/doc/delete        { id }
//
// Gated to HSPlan or FullAccess (matches the existing H&S button). Tenant-scoped
// like everything else — so it's automatically per-company for the SaaS product.

import { json, error } from "../lib/http.js";
import { requireSession, permissionsFor } from "../lib/auth.js";
import { tenantDB, resolveTenantId } from "../lib/tenantdb.js";

const PREFIX = { induction: "IND", hotworks: "HWP", rams: "RAMS", incident: "INC" };

export async function handle(request, env, ctx, url, sess) {
  if (!sess) sess = await requireSession(env, request);
  if (!sess) return error("Not authenticated", 401, env, request);
  const perms = await permissionsFor(env, sess.tenantId, sess.user.username);
  if (perms.HSPlan !== "Yes" && perms.FullAccess !== "Yes")
    return error("This needs H&S access.", 403, env, request);

  const db = tenantDB(env, sess.tenantId);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  // ── List ───────────────────────────────────────────────────────────────────
  if (path === "/hs/docs" && method === "GET") {
    const type = url.searchParams.get("type");
    const stmt = type
      ? db.prepare("SELECT id, doc_type, ref, site, status, created_by, created_at, updated_at FROM hs_documents WHERE tenant_id=? AND doc_type=? ORDER BY created_at DESC LIMIT 500").bind(db.tenantId, type)
      : db.prepare("SELECT id, doc_type, ref, site, status, created_by, created_at, updated_at FROM hs_documents WHERE tenant_id=? ORDER BY created_at DESC LIMIT 500").bind(db.tenantId);
    const { results } = await stmt.all();
    return json({ ok: true, docs: results || [] }, {}, env, request);
  }

  // ── Get one ──────────────────────────────────────────────────────────────
  if (path === "/hs/doc" && method === "GET") {
    const id = url.searchParams.get("id");
    if (!id) return error("Missing id", 400, env, request);
    const row = await db.prepare("SELECT * FROM hs_documents WHERE tenant_id=? AND id=?").bind(db.tenantId, id).first();
    if (!row) return error("Document not found", 404, env, request);
    let data = {}; try { data = row.data ? JSON.parse(row.data) : {}; } catch {}
    return json({ ok: true, doc: { id: row.id, doc_type: row.doc_type, ref: row.ref, site: row.site, status: row.status, created_by: row.created_by, created_at: row.created_at, updated_at: row.updated_at, data } }, {}, env, request);
  }

  // ── Create / update ────────────────────────────────────────────────────────
  if (path === "/hs/doc" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const docType = String(b.doc_type || "");
    if (!PREFIX[docType]) return error("Unknown document type", 400, env, request);
    const now = new Date().toISOString();
    const site = String(b.site || "").trim();
    const status = b.status === "closed" ? "closed" : "open";
    const data = (b.data && typeof b.data === "object") ? b.data : {};

    if (b.id) {
      // Update — keep the existing ref/created fields.
      const existing = await db.prepare("SELECT id FROM hs_documents WHERE tenant_id=? AND id=?").bind(db.tenantId, b.id).first();
      if (!existing) return error("Document not found", 404, env, request);
      await db.prepare("UPDATE hs_documents SET site=?, status=?, data=?, updated_at=? WHERE tenant_id=? AND id=?")
        .bind(site, status, JSON.stringify(data), now, db.tenantId, b.id).run();
      return json({ ok: true, id: b.id }, {}, env, request);
    }

    // Create — mint an internal id and a human reference.
    const id = "HSD-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
    const ref = await mintRef(db, docType, site);
    await db.prepare("INSERT INTO hs_documents (tenant_id, id, doc_type, ref, site, status, data, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .bind(db.tenantId, id, docType, ref, site, status, JSON.stringify(data), sess.user.username, now, now).run();
    return json({ ok: true, id, ref }, {}, env, request);
  }

  // ── RAMS hazard/control library (tenant-editable overlay of the seed) ───────
  // GET is readable by any H&S user (the builder loads it); POST is admin-only.
  // Stored per-tenant in app_config under 'hs:rams:library' as { hazards, workTypes }.
  if (path === "/hs/library" && method === "GET") {
    const row = await db.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key='hs:rams:library'").bind(db.tenantId).first();
    let library = null; try { library = row ? JSON.parse(row.value) : null; } catch {}
    return json({ ok: true, library }, {}, env, request);
  }
  if (path === "/hs/library" && method === "POST") {
    if (perms.FullAccess !== "Yes") return error("Only an admin can edit the H&S library.", 403, env, request);
    const b = await request.json().catch(() => ({}));
    if (!b || typeof b.hazards !== "object" || !Array.isArray(b.workTypes))
      return error("Invalid library payload", 400, env, request);
    await db.prepare("INSERT INTO app_config (tenant_id, key, value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(db.tenantId, "hs:rams:library", JSON.stringify({ hazards: b.hazards, workTypes: b.workTypes })).run();
    return json({ ok: true }, {}, env, request);
  }

  // ── Attention: open hot-works permits past their "valid until" time ─────────
  // Drives the red badge / attention gate. Office (FullAccess) sees ALL of the
  // tenant's overdue permits (the next-morning backstop); everyone else sees
  // only the ones they raised.
  if (path === "/hs/attention" && method === "GET") {
    const { results } = await db.prepare(
      "SELECT id, ref, site, data, created_by FROM hs_documents WHERE tenant_id=? AND doc_type='hotworks' AND status='open'"
    ).bind(db.tenantId).all();
    const now = Date.now();
    const isOffice = perms.FullAccess === "Yes";
    const me = sess.user.username;
    const items = [];
    for (const r of results || []) {
      let d = {}; try { d = r.data ? JSON.parse(r.data) : {}; } catch {}
      const exp = d.expiresAt ? Date.parse(d.expiresAt) : NaN;
      if (!exp || exp > now) continue;                    // no expiry set, or not yet due
      if (!isOffice && r.created_by !== me) continue;      // non-office: only their own
      items.push({ id: r.id, ref: r.ref, site: r.site, expiresAt: d.expiresAt });
    }
    items.sort((a, b) => String(a.expiresAt).localeCompare(String(b.expiresAt)));
    return json({ ok: true, count: items.length, items }, {}, env, request);
  }

  // ── Delete ───────────────────────────────────────────────────────────────
  if (path === "/hs/doc/delete" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!b.id) return error("Missing id", 400, env, request);
    await db.prepare("DELETE FROM hs_documents WHERE tenant_id=? AND id=?").bind(db.tenantId, b.id).run();
    return json({ ok: true }, {}, env, request);
  }

  return error("Unknown H&S route", 404, env, request);
}

// Build a human reference number in the SiteLog style, per tenant.
//   induction / rams / incident : IND-0001, RAMS-0001, INC-0001 (sequential)
//   hotworks                    : HWP-<SITECODE6>-<YYYYMMDD>-<nnn>
async function mintRef(db, docType, site) {
  const prefix = PREFIX[docType];
  if (docType === "hotworks") {
    const code = (site.replace(/[^A-Za-z0-9]/g, "").toUpperCase() + "SITE").slice(0, 6);
    const d = new Date();
    const ymd = d.getUTCFullYear().toString() + String(d.getUTCMonth() + 1).padStart(2, "0") + String(d.getUTCDate()).padStart(2, "0");
    const n = String(Math.floor(100 + Math.random() * 900));
    return `${prefix}-${code}-${ymd}-${n}`;
  }
  // Sequential: next number after the highest existing ref for this tenant+type.
  const { results } = await db.prepare(
    "SELECT ref FROM hs_documents WHERE tenant_id=? AND doc_type=? AND ref IS NOT NULL"
  ).bind(db.tenantId, docType).all();
  let max = 0;
  for (const r of results || []) {
    const m = /(\d+)\s*$/.exec(String(r.ref || ""));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}-${String(max + 1).padStart(4, "0")}`;
}
