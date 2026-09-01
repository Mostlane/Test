// ============================================================================
// Signable Documents (mounted at /documents)
// ----------------------------------------------------------------------------
// Replaces our Jotform Sign process. An admin keeps a small LIBRARY of prepared
// documents (the Portal User Agreement, the Annual Leave policy, …), all in one
// Mostlane house style. To issue one, the admin picks it and sends it to one or
// more chosen users. On send:
//   • the admin's OWN signature (saved once) + name + the send date are applied
//     automatically — no re-signing each time;
//   • each recipient gets a pending item (pushed) and a "to sign" entry in their
//     My Documents.
// When a recipient signs, their drawn signature + the date they signed + an
// IP/device audit line are baked into the FINAL branded PDF, which is filed into
// their My Documents › Agreements (exactly like the memo flow).
//
// Reuses: lib/signdoc-pdf.js (branded renderer), the My Documents R2 layout
// (staffdocs/…), push.js, filesign.js. A generalisation of routes/memos.js.
// ============================================================================

import { corsHeaders } from "../lib/http.js";
import { resolveTenantId } from "../lib/tenantdb.js";
import { permissionsFor } from "../lib/auth.js";
import { sendToUser } from "./push.js";
import { signedFileUrl } from "../lib/filesign.js";
import { buildSignDocPdf } from "../lib/signdoc-pdf.js";

let READY = false;
async function ensure(env) {
  if (READY) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS doc_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL DEFAULT 1,
    ref TEXT, title TEXT, body TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    created_by TEXT, created_at TEXT, updated_at TEXT
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS doc_sends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL DEFAULT 1,
    template_id INTEGER NOT NULL,
    ref TEXT, username TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    issued_by TEXT, issued_at TEXT, issuer_name TEXT, issuer_sig_key TEXT,
    title_snapshot TEXT, body_snapshot TEXT,
    signed_at TEXT, signer_ip TEXT, signer_ua TEXT,
    doc_key TEXT, sig_key TEXT
  )`).run();
  try { await env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS doc_sends_unq ON doc_sends (tenant_id, template_id, username)").run(); } catch { /* ok */ }
  // Make sure "Agreements" is a My Documents category so the filed copies show.
  try {
    const key = `staff_doc_categories:1`;
    const row = await env.DB.prepare("SELECT value FROM app_config WHERE key=?").bind(key).first();
    let cats = [];
    try { cats = row && row.value ? JSON.parse(row.value) : []; } catch { cats = []; }
    if (!Array.isArray(cats) || !cats.length) cats = ["Employment Contract", "Policies", "Payslips", "Memos", "Other"];
    if (!cats.some((c) => String(c).toLowerCase() === "agreements")) {
      cats.push("Agreements");
      await env.DB.prepare("INSERT INTO app_config (tenant_id, key, value) VALUES (1,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(key, JSON.stringify(cats)).run();
    }
  } catch { /* non-fatal */ }
  READY = true;
}

function jr(o, h, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...h, "Content-Type": "application/json" } }); }
async function readJson(r) { try { return await r.json(); } catch { return {}; } }
const lc = (s) => String(s || "").toLowerCase();
const safeName = (s) => String(s || "document").replace(/[^\w.\-]+/g, "_").slice(0, 60);

async function isFull(env, tid, me) {
  try { const p = await permissionsFor(env, tid, me); return p.FullAccess === "Yes"; } catch { return false; }
}
function fullName(u) { return ((u.first_name || "") + " " + (u.last_name || "")).trim() || u.username; }

async function userRow(env, tid, username) {
  return await env.DB.prepare("SELECT username, first_name, last_name FROM users WHERE tenant_id=? AND lower(username)=lower(?)").bind(tid, username).first();
}
async function displayName(env, tid, username) {
  const u = await userRow(env, tid, username);
  return u ? fullName(u) : username;
}

// The admin's saved issuer signature: R2 key remembered in app_config.
const issuerCfgKey = (me) => `doc:issuersig:${lc(me)}`;
async function issuerSigKey(env, tid, me) {
  try { const row = await env.DB.prepare("SELECT value FROM app_config WHERE key=?").bind(issuerCfgKey(me)).first(); return row && row.value ? row.value : null; }
  catch { return null; }
}
// Parse a data:image/(jpeg|png);base64 URL into { ext, bytes, isJpeg }.
function parseDataUrl(dataUrl) {
  const m = String(dataUrl || "").match(/^data:image\/(png|jpeg);base64,(.+)$/);
  if (!m) return null;
  const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
  return { ext: m[1] === "jpeg" ? "jpg" : "png", bytes, isJpeg: m[1] === "jpeg" };
}
async function loadBytes(env, key) {
  if (!key) return null;
  try { const o = await env.JOB_FILES.get(key); if (!o) return null; return new Uint8Array(await o.arrayBuffer()); }
  catch { return null; }
}
// Only a baseline JPEG can be embedded in the PDF; a stored PNG signature falls
// back to a signed line. (The clients capture JPEG, so this is the normal path.)
function jpegOrNull(bytes, key) {
  if (!bytes) return null;
  return (key && /\.jpg$/i.test(key)) ? bytes : (bytes[0] === 0xFF && bytes[1] === 0xD8 ? bytes : null);
}

export async function handle(request, env, ctx, url, sess) {
  const headers = corsHeaders(env, request);
  if (!sess) return jr({ error: "Not authenticated" }, headers, 401);
  const tid = sess.tenantId != null ? sess.tenantId : await resolveTenantId(env, request);
  const me = sess.user.username;
  const method = request.method.toUpperCase();
  const sub = url.pathname.replace(/^\/documents(?=\/|$)/, "") || "/";
  await ensure(env);
  const needFull = async () => { if (!(await isFull(env, tid, me))) return jr({ error: "Admins only" }, headers, 403); return null; };

  // ── Admin: create / update a library document ───────────────────────────────
  if (sub === "/template" && method === "POST") {
    const bad = await needFull(); if (bad) return bad;
    const b = await readJson(request);
    const title = String(b.title || "").trim();
    const body = String(b.body || "");
    if (!title) return jr({ error: "Title required" }, headers, 400);
    const now = new Date().toISOString();
    const id = parseInt(b.id, 10) || 0;
    if (id) {
      const row = await env.DB.prepare("SELECT id FROM doc_templates WHERE tenant_id=? AND id=?").bind(tid, id).first();
      if (!row) return jr({ error: "Not found" }, headers, 404);
      await env.DB.prepare("UPDATE doc_templates SET title=?, body=?, updated_at=? WHERE tenant_id=? AND id=?").bind(title, body, now, tid, id).run();
      return jr({ ok: true, id }, headers);
    }
    const res = await env.DB.prepare("INSERT INTO doc_templates (tenant_id, title, body, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?)")
      .bind(tid, title, body, me, now, now).run();
    const newId = res.meta ? res.meta.last_row_id : 0;
    const ref = "MOS-DOC-" + String(newId).padStart(4, "0");
    await env.DB.prepare("UPDATE doc_templates SET ref=? WHERE tenant_id=? AND id=?").bind(ref, tid, newId).run();
    return jr({ ok: true, id: newId, ref }, headers, 201);
  }

  // ── Admin: list the library (with per-document sent/signed counts) ──────────
  if (sub === "/templates" && method === "GET") {
    const bad = await needFull(); if (bad) return bad;
    const { results } = await env.DB.prepare("SELECT * FROM doc_templates WHERE tenant_id=? AND archived=0 ORDER BY id DESC").bind(tid).all();
    const out = [];
    for (const t of results || []) {
      const c = await env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status='signed' THEN 1 ELSE 0 END) AS signed FROM doc_sends WHERE tenant_id=? AND template_id=?").bind(tid, t.id).first();
      out.push({ id: t.id, ref: t.ref, title: t.title, body: t.body, updated_at: t.updated_at, sent: (c && c.total) || 0, signed: (c && c.signed) || 0 });
    }
    const hasSig = !!(await issuerSigKey(env, tid, me));
    return jr({ ok: true, templates: out, hasIssuerSignature: hasSig }, headers);
  }

  // ── Admin: delete a library document (keeps already-issued/signed copies) ───
  if (sub === "/template-delete" && method === "POST") {
    const bad = await needFull(); if (bad) return bad;
    const b = await readJson(request);
    const id = parseInt(b.id, 10);
    if (!id) return jr({ error: "id required" }, headers, 400);
    await env.DB.prepare("DELETE FROM doc_templates WHERE tenant_id=? AND id=?").bind(tid, id).run();
    return jr({ ok: true }, headers);
  }

  // ── Admin: save MY issuer signature (drawn once, reused on every send) ───────
  if (sub === "/issuer-signature" && method === "POST") {
    const bad = await needFull(); if (bad) return bad;
    const b = await readJson(request);
    const p = parseDataUrl(b.signature);
    if (!p) return jr({ error: "A drawn signature is required" }, headers, 400);
    const key = `docsig/${tid}/issuer/${safeName(me)}.${p.ext}`;
    await env.JOB_FILES.put(key, p.bytes, { httpMetadata: { contentType: "image/" + (p.isJpeg ? "jpeg" : "png") } });
    await env.DB.prepare("INSERT INTO app_config (tenant_id, key, value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(tid, issuerCfgKey(me), key).run();
    return jr({ ok: true }, headers);
  }
  if (sub === "/issuer-signature" && method === "GET") {
    const bad = await needFull(); if (bad) return bad;
    return jr({ ok: true, has: !!(await issuerSigKey(env, tid, me)) }, headers);
  }

  // ── Admin: preview a document as the branded PDF (issuer signature applied) ──
  if (sub === "/preview" && method === "GET") {
    const bad = await needFull(); if (bad) return bad;
    const id = parseInt(url.searchParams.get("id"), 10);
    const t = await env.DB.prepare("SELECT * FROM doc_templates WHERE tenant_id=? AND id=?").bind(tid, id).first();
    if (!t) return jr({ error: "Not found" }, headers, 404);
    const sigKey = await issuerSigKey(env, tid, me);
    const sigBytes = jpegOrNull(await loadBytes(env, sigKey), sigKey);
    const pdf = buildSignDocPdf({ ref: t.ref, title: t.title, body: t.body }, {
      issuerName: await displayName(env, tid, me), issuerDateISO: new Date().toISOString(), issuerSigJpeg: sigBytes,
    });
    return new Response(pdf, { status: 200, headers: { ...headers, "Content-Type": "application/pdf", "Content-Disposition": "inline; filename=preview.pdf" } });
  }

  // ── Admin: SEND a document to one or more chosen users ──────────────────────
  if (sub === "/send" && method === "POST") {
    const bad = await needFull(); if (bad) return bad;
    const b = await readJson(request);
    const id = parseInt(b.id, 10);
    const recips = (Array.isArray(b.recipients) ? b.recipients : []).map((x) => String(x || "").trim()).filter(Boolean);
    if (!id) return jr({ error: "Document id required" }, headers, 400);
    if (!recips.length) return jr({ error: "Pick at least one recipient" }, headers, 400);
    const t = await env.DB.prepare("SELECT * FROM doc_templates WHERE tenant_id=? AND id=?").bind(tid, id).first();
    if (!t) return jr({ error: "Document not found" }, headers, 404);
    const sigKey = await issuerSigKey(env, tid, me);
    if (!sigKey) return jr({ error: "Set your signature first (Documents → My signature), then send." }, headers, 400);
    const at = new Date().toISOString();
    const issuerName = await displayName(env, tid, me);
    let sent = 0;
    for (const uname of recips) {
      // Resolve to the canonical username so it matches the recipient's session.
      const u = await userRow(env, tid, uname);
      const canon = u ? u.username : uname;
      await env.DB.prepare(
        "INSERT INTO doc_sends (tenant_id, template_id, ref, username, status, issued_by, issued_at, issuer_name, issuer_sig_key, title_snapshot, body_snapshot) " +
        "VALUES (?,?,?,?, 'pending', ?,?,?,?,?,?) " +
        "ON CONFLICT(tenant_id, template_id, username) DO UPDATE SET status='pending', issued_by=excluded.issued_by, issued_at=excluded.issued_at, " +
        "issuer_name=excluded.issuer_name, issuer_sig_key=excluded.issuer_sig_key, title_snapshot=excluded.title_snapshot, body_snapshot=excluded.body_snapshot, " +
        "signed_at=NULL, signer_ip=NULL, signer_ua=NULL, doc_key=NULL, sig_key=NULL"
      ).bind(tid, id, t.ref, canon, me, at, issuerName, sigKey, t.title, t.body).run();
      const send = await env.DB.prepare("SELECT id FROM doc_sends WHERE tenant_id=? AND template_id=? AND lower(username)=lower(?)").bind(tid, id, canon).first();
      if (send && send.id) {
        ctx?.waitUntil(sendToUser(env, tid, canon, {
          title: "📄 A document to sign", body: (t.title || "Please read and sign").slice(0, 120),
          url: "/document-sign.html?id=" + send.id, tag: "doc:" + send.id,
        }));
      }
      sent++;
    }
    return jr({ ok: true, sent }, headers);
  }

  // ── Admin: who has / hasn't signed a document ───────────────────────────────
  if (sub === "/status" && method === "GET") {
    const bad = await needFull(); if (bad) return bad;
    const id = parseInt(url.searchParams.get("id"), 10);
    if (!id) return jr({ error: "id required" }, headers, 400);
    const { results } = await env.DB.prepare("SELECT * FROM doc_sends WHERE tenant_id=? AND template_id=? ORDER BY status, username").bind(tid, id).all();
    const signed = [], pending = [];
    for (const s of results || []) {
      const name = await displayName(env, tid, s.username);
      if (s.status === "signed") {
        const row = { username: s.username, name, at: s.signed_at, ip: s.signer_ip || null };
        if (s.doc_key) row.doc = await signedFileUrl(env, url.origin, "/staff/doc", s.doc_key);
        signed.push(row);
      } else {
        pending.push({ username: s.username, name, issued_at: s.issued_at });
      }
    }
    signed.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return jr({ ok: true, signed, pending }, headers);
  }

  // ── Any user: my pending (unsigned) documents ───────────────────────────────
  if (sub === "/pending" && method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT id, template_id, ref, title_snapshot, issued_by, issuer_name, issued_at FROM doc_sends " +
      "WHERE tenant_id=? AND status='pending' AND lower(username)=lower(?) ORDER BY issued_at ASC"
    ).bind(tid, me).all();
    return jr({ ok: true, documents: (results || []).map((s) => ({ id: s.id, ref: s.ref, title: s.title_snapshot, issuedBy: s.issuer_name || s.issued_by, at: s.issued_at })) }, headers);
  }

  // ── Any user: read one issued document (for the sign page) ──────────────────
  if (sub === "/one" && method === "GET") {
    const id = parseInt(url.searchParams.get("id"), 10);
    if (!id) return jr({ error: "id required" }, headers, 400);
    const s = await env.DB.prepare("SELECT * FROM doc_sends WHERE tenant_id=? AND id=?").bind(tid, id).first();
    if (!s) return jr({ error: "Not found" }, headers, 404);
    if (lc(s.username) !== lc(me) && !(await isFull(env, tid, me))) return jr({ error: "This document wasn't sent to you" }, headers, 403);
    return jr({ ok: true, doc: {
      id: s.id, ref: s.ref, title: s.title_snapshot, body: s.body_snapshot,
      issuerName: s.issuer_name, issuedAt: s.issued_at,
    }, signed: s.status === "signed" }, headers);
  }

  // ── Any user: SIGN a document ───────────────────────────────────────────────
  if (sub === "/sign" && method === "POST") {
    const b = await readJson(request);
    const id = parseInt(b.id, 10);
    if (!id) return jr({ error: "id required" }, headers, 400);
    const s = await env.DB.prepare("SELECT * FROM doc_sends WHERE tenant_id=? AND id=?").bind(tid, id).first();
    if (!s) return jr({ error: "Document not found" }, headers, 404);
    if (lc(s.username) !== lc(me)) return jr({ error: "This document wasn't sent to you" }, headers, 403);
    if (s.status === "signed") return jr({ ok: true, already: true }, headers);

    const at = new Date().toISOString();
    const ts = Date.now();
    const ip = request.headers.get("CF-Connecting-IP") || (request.headers.get("X-Forwarded-For") || "").split(",")[0].trim() || "";
    const ua = request.headers.get("User-Agent") || "";
    const signerName = await displayName(env, tid, me);

    // Store the signer's drawn signature (admin record) + keep bytes to embed.
    let sigKey = null, signerJpeg = null;
    const p = parseDataUrl(b.signature);
    if (p) {
      sigKey = `docsig/${tid}/sign/${id}/${safeName(me)}.${p.ext}`;
      try {
        await env.JOB_FILES.put(sigKey, p.bytes, { httpMetadata: { contentType: "image/" + (p.isJpeg ? "jpeg" : "png") } });
        if (p.isJpeg) signerJpeg = p.bytes;
      } catch { sigKey = null; }
    }

    // Issuer signature (saved at send time).
    const issuerBytes = jpegOrNull(await loadBytes(env, s.issuer_sig_key), s.issuer_sig_key);

    // Build the final branded PDF with BOTH signatures + the audit line, and file
    // it into the signer's My Documents › Agreements.
    const pdf = buildSignDocPdf({ ref: s.ref, title: s.title_snapshot, body: s.body_snapshot }, {
      issuerName: s.issuer_name, issuerDateISO: s.issued_at, issuerSigJpeg: issuerBytes,
      signerName, signedAtISO: at, signerSigJpeg: signerJpeg, signerIp: ip, signerUa: ua,
    });
    const docKey = `staffdocs/${tid}/user/${me}/Agreements/${ts}-${safeName(s.title_snapshot || "document")}.pdf`;
    await env.JOB_FILES.put(docKey, pdf, {
      httpMetadata: { contentType: "application/pdf" },
      customMetadata: { name: (s.title_snapshot || "Document") + " — signed", by: "Signed " + at },
    });

    await env.DB.prepare(
      "UPDATE doc_sends SET status='signed', signed_at=?, signer_ip=?, signer_ua=?, doc_key=?, sig_key=? WHERE tenant_id=? AND id=?"
    ).bind(at, ip || null, ua || null, docKey, sigKey, tid, id).run();

    // Let the issuer know it's been signed (fire-and-forget).
    if (s.issued_by) {
      ctx?.waitUntil(sendToUser(env, tid, s.issued_by, {
        title: "✅ Document signed", body: `${signerName} signed “${(s.title_snapshot || "a document").slice(0, 80)}”`,
        url: "/documents-admin.html", tag: "doc-signed:" + id,
      }));
    }
    return jr({ ok: true, signed_at: at }, headers);
  }

  return jr({ error: "Not found: " + sub }, headers, 404);
}
