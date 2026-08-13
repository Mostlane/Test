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

import { json, error, corsHeaders } from "../lib/http.js";
import { requireSession, permissionsFor } from "../lib/auth.js";
import { tenantDB, resolveTenantId } from "../lib/tenantdb.js";
import { signedFileUrl, verifyFileSig } from "../lib/filesign.js";
import { sendToUser } from "./push.js";

const PREFIX = { induction: "IND", hotworks: "HWP", rams: "RAMS", incident: "INC" };

// Self-migrating extra columns on hs_documents: file attachments (appended to
// the PDF) and remote sign-off requests (sent to a portal user to view+sign).
// Both are kept OUT of the form's `data` blob so a form re-save never wipes them.
async function ensureHsCols(db) {
  for (const col of ["attachments TEXT", "sign_requests TEXT"]) {
    try { await db.prepare(`ALTER TABLE hs_documents ADD COLUMN ${col}`).run(); } catch {}
  }
}
const parseArr = s => { try { const v = JSON.parse(s || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };
// Sign a stored attachment so the browser <img>/link can fetch it without a token.
async function attachmentUrl(env, origin, key) {
  return signedFileUrl(env, origin, "/hs/attachment", key);
}
async function withAttachmentUrls(env, origin, atts) {
  const out = [];
  for (const a of atts) out.push({ ...a, url: await attachmentUrl(env, origin, a.key) });
  return out;
}

export async function handle(request, env, ctx, url, sess) {
  const path = url.pathname;
  const method = request.method.toUpperCase();
  const q = url.searchParams;

  // ── PUBLIC: stream an attachment (access-gated by the signed URL) ───────────
  // <img> tags and download links can't send an auth header; the signature is
  // verified in-handler (same pattern as /fleet/vehicle-doc, /staff/doc …).
  if (path === "/hs/attachment" && method === "GET") {
    const key = q.get("key");
    if (!key || !String(key).startsWith("hsdocs/")) return error("Bad key", 400, env, request);
    if (!sess && !(await verifyFileSig(env, key, q))) return error("Link expired or invalid", 403, env, request);
    const obj = await env.JOB_FILES.get(key);
    if (!obj) return new Response("Not found", { status: 404, headers: corsHeaders(env, request) });
    return new Response(obj.body, { status: 200, headers: {
      ...corsHeaders(env, request),
      "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
      "Content-Disposition": "inline", "Cache-Control": "private, max-age=3600"
    }});
  }

  if (!sess) sess = await requireSession(env, request);
  if (!sess) return error("Not authenticated", 401, env, request);
  const perms = await permissionsFor(env, sess.tenantId, sess.user.username);
  const db = tenantDB(env, sess.tenantId);
  await ensureHsCols(db);
  const me = sess.user.username;

  // ── Remote signing — allowed for a TARGETED RECIPIENT who may not otherwise
  // have H&S access (their own auth: they must be named on the doc), so these
  // sit BEFORE the H&S permission gate below. ──────────────────────────────────
  if (path === "/hs/to-sign" && method === "GET") {
    const { results } = await db.prepare(
      "SELECT id, doc_type, ref, site, sign_requests FROM hs_documents WHERE tenant_id=? AND sign_requests IS NOT NULL ORDER BY updated_at DESC LIMIT 500"
    ).bind(db.tenantId).all();
    const items = [];
    for (const r of results || []) {
      const mine = parseArr(r.sign_requests).find(s => s.username === me && s.status === "pending");
      if (mine) items.push({ id: r.id, doc_type: r.doc_type, ref: r.ref, site: r.site, requestedAt: mine.requestedAt });
    }
    return json({ ok: true, items }, {}, env, request);
  }
  if (path === "/hs/sign" && method === "GET") {
    const id = q.get("id");
    if (!id) return error("Missing id", 400, env, request);
    const row = await db.prepare("SELECT * FROM hs_documents WHERE tenant_id=? AND id=?").bind(db.tenantId, id).first();
    if (!row) return error("Document not found", 404, env, request);
    const reqs = parseArr(row.sign_requests);
    const mine = reqs.find(s => s.username === me);
    const isHS = perms.HSPlan === "Yes" || perms.FullAccess === "Yes";
    if (!mine && !isHS) return error("This document wasn't sent to you.", 403, env, request);
    let data = {}; try { data = row.data ? JSON.parse(row.data) : {}; } catch {}
    const atts = await withAttachmentUrls(env, url.origin, parseArr(row.attachments));
    return json({ ok: true, doc: {
      id: row.id, doc_type: row.doc_type, ref: row.ref, site: row.site, status: row.status,
      created_by: row.created_by, created_at: row.created_at, updated_at: row.updated_at,
      data, attachments: atts, signRequests: reqs
    }, myStatus: mine ? mine.status : null }, {}, env, request);
  }
  if (path === "/hs/sign" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const id = String(b.id || "");
    const signature = String(b.signature || "");
    if (!id) return error("Missing id", 400, env, request);
    if (!/^data:image\//.test(signature) || signature.length > 400000) return error("A signature is required.", 400, env, request);
    const row = await db.prepare("SELECT id, sign_requests, created_by FROM hs_documents WHERE tenant_id=? AND id=?").bind(db.tenantId, id).first();
    if (!row) return error("Document not found", 404, env, request);
    const reqs = parseArr(row.sign_requests);
    const mine = reqs.find(s => s.username === me);
    if (!mine) return error("This document wasn't sent to you.", 403, env, request);
    mine.status = "signed"; mine.signedAt = new Date().toISOString(); mine.signature = signature;
    await db.prepare("UPDATE hs_documents SET sign_requests=?, updated_at=? WHERE tenant_id=? AND id=?")
      .bind(JSON.stringify(reqs), mine.signedAt, db.tenantId, id).run();
    if (ctx && ctx.waitUntil && row.created_by && row.created_by !== me) ctx.waitUntil(sendToUser(env, db.tenantId, row.created_by, {
      title: "Risk assessment signed", body: `${mine.name || me} has signed ${row.ref || "a risk assessment"}.`,
      url: "/hs-docs.html", tag: "hs-signed"
    }));
    return json({ ok: true }, {}, env, request);
  }

  // ── Everything below needs H&S access ───────────────────────────────────────
  if (perms.HSPlan !== "Yes" && perms.FullAccess !== "Yes")
    return error("This needs H&S access.", 403, env, request);

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
    const atts = await withAttachmentUrls(env, url.origin, parseArr(row.attachments));
    return json({ ok: true, doc: { id: row.id, doc_type: row.doc_type, ref: row.ref, site: row.site, status: row.status, created_by: row.created_by, created_at: row.created_at, updated_at: row.updated_at, data, attachments: atts, signRequests: parseArr(row.sign_requests) } }, {}, env, request);
  }

  // ── Attachments — files/images appended to the produced PDF ─────────────────
  if (path === "/hs/doc/attach" && method === "POST") {
    const form = await request.formData();
    const id = String(form.get("id") || "");
    const file = form.get("file");
    if (!id || !file) return error("id and file required", 400, env, request);
    const row = await db.prepare("SELECT id, attachments FROM hs_documents WHERE tenant_id=? AND id=?").bind(db.tenantId, id).first();
    if (!row) return error("Document not found", 404, env, request);
    if ((file.size || 0) > 25 * 1024 * 1024) return error("File too large (max 25 MB).", 400, env, request);
    const safe = String(file.name || "file").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
    const key = `hsdocs/${db.tenantId}/${id}/${Date.now()}-${safe}`;
    await env.JOB_FILES.put(key, file.stream(), {
      httpMetadata: { contentType: file.type || "application/octet-stream" },
      customMetadata: { name: file.name || safe, by: me, at: new Date().toISOString() }
    });
    const atts = parseArr(row.attachments);
    const meta = { key, name: file.name || safe, type: file.type || "", size: file.size || 0, at: new Date().toISOString(), by: me };
    atts.push(meta);
    await db.prepare("UPDATE hs_documents SET attachments=?, updated_at=? WHERE tenant_id=? AND id=?")
      .bind(JSON.stringify(atts), new Date().toISOString(), db.tenantId, id).run();
    return json({ ok: true, attachment: { ...meta, url: await attachmentUrl(env, url.origin, key) } }, {}, env, request);
  }
  if (path === "/hs/doc/attach-delete" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const id = String(b.id || ""); const key = String(b.key || "");
    if (!id || !key) return error("id and key required", 400, env, request);
    const row = await db.prepare("SELECT id, attachments FROM hs_documents WHERE tenant_id=? AND id=?").bind(db.tenantId, id).first();
    if (!row) return error("Document not found", 404, env, request);
    const atts = parseArr(row.attachments).filter(a => a.key !== key);
    try { await env.JOB_FILES.delete(key); } catch {}
    await db.prepare("UPDATE hs_documents SET attachments=?, updated_at=? WHERE tenant_id=? AND id=?")
      .bind(JSON.stringify(atts), new Date().toISOString(), db.tenantId, id).run();
    return json({ ok: true }, {}, env, request);
  }

  // ── Send for signing — add pending recipients + push them ───────────────────
  if (path === "/hs/doc/sign-request" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const id = String(b.id || "");
    const usernames = Array.isArray(b.usernames) ? b.usernames.map(String) : (b.username ? [String(b.username)] : []);
    if (!id || !usernames.length) return error("id and at least one recipient required", 400, env, request);
    const row = await db.prepare("SELECT id, ref, sign_requests FROM hs_documents WHERE tenant_id=? AND id=?").bind(db.tenantId, id).first();
    if (!row) return error("Document not found", 404, env, request);
    const reqs = parseArr(row.sign_requests);
    // Resolve display names for the chosen users.
    const nameOf = {};
    try {
      const { results } = await db.prepare("SELECT username, first_name, last_name FROM users WHERE tenant_id=?").bind(db.tenantId).all();
      for (const u of results || []) nameOf[u.username] = ((u.first_name || "") + " " + (u.last_name || "")).trim() || u.username;
    } catch {}
    const added = [];
    for (const un of usernames) {
      if (reqs.some(s => s.username === un && s.status !== "declined")) continue;   // already pending/signed
      reqs.push({ username: un, name: nameOf[un] || un, status: "pending", requestedAt: new Date().toISOString(), requestedBy: me });
      added.push(un);
    }
    await db.prepare("UPDATE hs_documents SET sign_requests=?, updated_at=? WHERE tenant_id=? AND id=?")
      .bind(JSON.stringify(reqs), new Date().toISOString(), db.tenantId, id).run();
    for (const un of added) {
      if (ctx && ctx.waitUntil) ctx.waitUntil(sendToUser(env, db.tenantId, un, {
        title: "Risk assessment to sign", body: `Please read and sign ${row.ref || "a risk assessment"}.`,
        url: "/hs-sign.html?id=" + encodeURIComponent(id), tag: "hs-sign"
      }));
    }
    return json({ ok: true, signRequests: reqs, added }, {}, env, request);
  }
  // Cancel / remove a sign request (admin tidy-up).
  if (path === "/hs/doc/sign-cancel" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const id = String(b.id || ""); const un = String(b.username || "");
    if (!id || !un) return error("id and username required", 400, env, request);
    const row = await db.prepare("SELECT id, sign_requests FROM hs_documents WHERE tenant_id=? AND id=?").bind(db.tenantId, id).first();
    if (!row) return error("Document not found", 404, env, request);
    const reqs = parseArr(row.sign_requests).filter(s => s.username !== un);
    await db.prepare("UPDATE hs_documents SET sign_requests=?, updated_at=? WHERE tenant_id=? AND id=?")
      .bind(JSON.stringify(reqs), new Date().toISOString(), db.tenantId, id).run();
    return json({ ok: true, signRequests: reqs }, {}, env, request);
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

    // An explicitly-typed document number (from the form) overrides the
    // auto-minted one, on both create and update. Trimmed + length-capped.
    const typedRef = (typeof b.ref === "string" && b.ref.trim()) ? b.ref.trim().slice(0, 40) : "";

    if (b.id) {
      // Update — keep created fields; the ref changes only if one was typed.
      const existing = await db.prepare("SELECT id, ref FROM hs_documents WHERE tenant_id=? AND id=?").bind(db.tenantId, b.id).first();
      if (!existing) return error("Document not found", 404, env, request);
      const ref = typedRef || existing.ref;
      await db.prepare("UPDATE hs_documents SET ref=?, site=?, status=?, data=?, updated_at=? WHERE tenant_id=? AND id=?")
        .bind(ref, site, status, JSON.stringify(data), now, db.tenantId, b.id).run();
      return json({ ok: true, id: b.id, ref }, {}, env, request);
    }

    // Create — mint an internal id and a human reference.
    const id = "HSD-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
    const ref = typedRef || await mintRef(db, docType, site);
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

// Per-type sequential numbering. Risk assessments run as RA01280, RA01281 …
// (5-digit, no dash, starting at 1280 — the client's existing series); the
// others keep the SiteLog-style IND-0001 / INC-0001.
const SEQ = {
  rams:      { prefix: "RA",  sep: "", pad: 5, floor: 1280 },
  induction: { prefix: "IND", sep: "-", pad: 4, floor: 1 },
  incident:  { prefix: "INC", sep: "-", pad: 4, floor: 1 },
};
// Build a human reference number, per tenant.
//   induction / rams / incident : IND-0001, RA01280, INC-0001 (sequential)
//   hotworks                    : HWP-<SITECODE6>-<YYYYMMDD>-<nnn>
async function mintRef(db, docType, site) {
  if (docType === "hotworks") {
    const prefix = PREFIX[docType];
    const code = (site.replace(/[^A-Za-z0-9]/g, "").toUpperCase() + "SITE").slice(0, 6);
    const d = new Date();
    const ymd = d.getUTCFullYear().toString() + String(d.getUTCMonth() + 1).padStart(2, "0") + String(d.getUTCDate()).padStart(2, "0");
    const n = String(Math.floor(100 + Math.random() * 900));
    return `${prefix}-${code}-${ymd}-${n}`;
  }
  const cfg = SEQ[docType] || { prefix: PREFIX[docType] || "DOC", sep: "-", pad: 4, floor: 1 };
  // Sequential: next number after the highest existing ref for this tenant+type
  // (a manually-typed higher number feeds the sequence), floored at the start.
  const { results } = await db.prepare(
    "SELECT ref FROM hs_documents WHERE tenant_id=? AND doc_type=? AND ref IS NOT NULL"
  ).bind(db.tenantId, docType).all();
  let max = 0;
  for (const r of results || []) {
    const m = /(\d+)\s*$/.exec(String(r.ref || ""));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  const next = Math.max(max + 1, cfg.floor);
  return `${cfg.prefix}${cfg.sep}${String(next).padStart(cfg.pad, "0")}`;
}
