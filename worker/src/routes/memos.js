// ============================================================================
// Company memos (mounted at /memos)
// ----------------------------------------------------------------------------
// Admins (Full Access) write a memo in the classic To/From/Cc/Date/Re + body
// format, save it as a DRAFT, then SEND it company-wide. A sent memo:
//   • pushes every active user,
//   • shows as an UNAVOIDABLE, non-snoozable blocking gate (portal-config) until
//     the user reads it and draws a signature,
//   • on signing, a signed-acknowledgement PDF is filed into that user's
//     My Documents under the "Memos" category (same R2 layout as hrdocs).
// Managed from the Notification Centre.
// ============================================================================

import { corsHeaders } from "../lib/http.js";
import { resolveTenantId } from "../lib/tenantdb.js";
import { permissionsFor } from "../lib/auth.js";
import { sendToUser } from "./push.js";
import { PdfDoc, textWidth } from "../lib/pdf.js";
import { signedFileUrl } from "../lib/filesign.js";

let READY = false;
async function ensure(env) {
  if (READY) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS memos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'draft',   -- 'draft' | 'sent'
    m_to TEXT, m_from TEXT, m_cc TEXT, m_date TEXT, m_re TEXT,
    body TEXT,
    created_by TEXT, created_at TEXT, sent_at TEXT
  )`).run();
  // recipients: JSON array of usernames the memo targets; NULL/empty = everyone.
  try { await env.DB.prepare("ALTER TABLE memos ADD COLUMN recipients TEXT").run(); } catch { /* already there */ }
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS memo_acks (
    tenant_id INTEGER NOT NULL DEFAULT 1,
    memo_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    signed_at TEXT,
    doc_key TEXT,
    sig_key TEXT,
    PRIMARY KEY (tenant_id, memo_id, username)
  )`).run();
  READY = true;
}

function jr(o, h, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...h, "Content-Type": "application/json" } }); }
async function readJson(r) { try { return await r.json(); } catch { return {}; } }
const lc = (s) => String(s || "").toLowerCase();
const safeName = (s) => String(s || "memo").replace(/[^\w.\-]+/g, "_").slice(0, 60);

async function isFull(env, tid, me) {
  try { const p = await permissionsFor(env, tid, me); return p.FullAccess === "Yes"; } catch { return false; }
}

// Everyone who should receive a company memo (active accounts only).
async function activeUsers(env, tid) {
  const { results } = await env.DB.prepare(
    "SELECT username, first_name, last_name FROM users WHERE tenant_id=? AND lower(COALESCE(status,'active')) NOT IN ('inactive','archived','left','disabled','pending')"
  ).bind(tid).all();
  return results || [];
}
function fullName(u) { return ((u.first_name || "") + " " + (u.last_name || "")).trim() || u.username; }

// A memo's recipient usernames (lowercased), or null when it targets everyone.
function parseRecips(memo) {
  try { const a = JSON.parse(memo && memo.recipients ? memo.recipients : "null"); return (Array.isArray(a) && a.length) ? a.map(lc) : null; }
  catch { return null; }
}
// The active users a memo actually goes to: its targeted set (∩ active), else all.
async function recipientUsers(env, tid, memo) {
  const all = await activeUsers(env, tid);
  const set = parseRecips(memo);
  if (!set) return all;
  const want = new Set(set);
  return all.filter((u) => want.has(lc(u.username)));
}

function fmtWhen(iso) {
  try {
    const d = new Date(iso);
    const day = d.getUTCDate(), mon = ["January","February","March","April","May","June","July","August","September","October","November","December"][d.getUTCMonth()];
    const hh = String(d.getUTCHours()).padStart(2, "0"), mm = String(d.getUTCMinutes()).padStart(2, "0");
    return `${day} ${mon} ${d.getUTCFullYear()}, ${hh}:${mm}`;
  } catch { return iso; }
}

// Wrap a string to a pixel width for the PDF's Helvetica.
function wrap(str, size, maxW) {
  const words = String(str || "").split(/\s+/), lines = []; let cur = "";
  for (const w of words) {
    const t = cur ? cur + " " + w : w;
    if (textWidth(t, size) > maxW && cur) { lines.push(cur); cur = w; }
    else cur = t;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

// Build the signed-acknowledgement PDF (text-only; the drawn signature is stored
// alongside as PNG for the admin record).
function buildMemoPdf(memo, signerName, signedAtISO) {
  const doc = new PdfDoc();
  const L = 56, R = 539, W = R - L;
  let y = 70;
  doc.text(L, y, "MEMO", { size: 26, bold: true });
  y += 10; doc.hr(L, y, R, { w: 1.2 }); y += 28;
  const row = (label, val) => {
    doc.text(L, y, label, { size: 11, bold: true });
    for (const ln of wrap(val || "", 11, W - 70)) { doc.text(L + 70, y, ln, { size: 11 }); y += 16; }
    y += 3;
  };
  row("To:", memo.m_to);
  row("From:", memo.m_from);
  if (memo.m_cc) row("Cc:", memo.m_cc);
  row("Date:", memo.m_date);
  row("Re:", memo.m_re);
  y += 4; doc.hr(L, y, R, { grey: true }); y += 22;
  for (const para of String(memo.body || "").split(/\n/)) {
    if (!para.trim()) { y += 10; continue; }
    for (const ln of wrap(para, 11, W)) {
      if (y > 770) { doc.newPage(); y = 60; }
      doc.text(L, y, ln, { size: 11 }); y += 16;
    }
    y += 8;
  }
  y += 14; if (y > 740) { doc.newPage(); y = 60; }
  doc.hr(L, y, R, { grey: true }); y += 22;
  doc.text(L, y, "Acknowledgement", { size: 12, bold: true }); y += 18;
  for (const ln of wrap('I confirm that I have read and understood the content of this memo.', 11, W)) { doc.text(L, y, ln, { size: 11 }); y += 16; }
  y += 6;
  doc.text(L, y, "Signed: " + signerName, { size: 11, bold: true }); y += 16;
  doc.text(L, y, "Date: " + fmtWhen(signedAtISO), { size: 11 }); y += 16;
  doc.text(L, y, "Signed electronically via the Mostlane Portal. Drawn signature held on file.", { size: 8.5, grey: true });
  return doc.bytes();
}

export async function handle(request, env, ctx, url, sess) {
  const headers = corsHeaders(env, request);
  if (!sess) return jr({ error: "Not authenticated" }, headers, 401);
  const tid = sess.tenantId != null ? sess.tenantId : await resolveTenantId(env, request);
  const me = sess.user.username;
  const method = request.method.toUpperCase();
  const sub = url.pathname.replace(/^\/memos(?=\/|$)/, "") || "/";
  await ensure(env);
  const needFull = async () => { if (!(await isFull(env, tid, me))) { return jr({ error: "Admins only" }, headers, 403); } return null; };

  // ── Admin: save/update a DRAFT ──────────────────────────────────────────────
  if (sub === "/save" && method === "POST") {
    const bad = await needFull(); if (bad) return bad;
    const b = await readJson(request);
    const fields = [b.to, b.from, b.cc, b.date, b.re, b.body].map((v) => String(v == null ? "" : v));
    // recipients: an array of usernames = targeted; null/empty = everyone.
    const recips = (Array.isArray(b.recipients) && b.recipients.length)
      ? JSON.stringify(b.recipients.map((x) => String(x)).filter(Boolean)) : null;
    const id = parseInt(b.id, 10) || 0;
    if (id) {
      const row = await env.DB.prepare("SELECT status FROM memos WHERE tenant_id=? AND id=?").bind(tid, id).first();
      if (!row) return jr({ error: "Not found" }, headers, 404);
      if (row.status === "sent") return jr({ error: "Already sent — can't edit" }, headers, 409);
      await env.DB.prepare("UPDATE memos SET m_to=?, m_from=?, m_cc=?, m_date=?, m_re=?, body=?, recipients=? WHERE tenant_id=? AND id=?")
        .bind(...fields, recips, tid, id).run();
      return jr({ ok: true, id }, headers);
    }
    const res = await env.DB.prepare(
      "INSERT INTO memos (tenant_id, status, m_to, m_from, m_cc, m_date, m_re, body, recipients, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(tid, "draft", ...fields, recips, me, new Date().toISOString()).run();
    return jr({ ok: true, id: res.meta ? res.meta.last_row_id : null }, headers, 201);
  }

  // ── Admin: SEND a memo company-wide ─────────────────────────────────────────
  if (sub === "/send" && method === "POST") {
    const bad = await needFull(); if (bad) return bad;
    const b = await readJson(request);
    const id = parseInt(b.id, 10);
    if (!id) return jr({ error: "id required" }, headers, 400);
    const memo = await env.DB.prepare("SELECT * FROM memos WHERE tenant_id=? AND id=?").bind(tid, id).first();
    if (!memo) return jr({ error: "Not found" }, headers, 404);
    if (memo.status === "sent") return jr({ error: "Already sent" }, headers, 409);
    const at = new Date().toISOString();
    await env.DB.prepare("UPDATE memos SET status='sent', sent_at=? WHERE tenant_id=? AND id=?").bind(at, tid, id).run();
    // The author is auto-acknowledged (they wrote it) — so they aren't gated by
    // their own memo and count as "signed". No PDF/signature is filed for them.
    const author = memo.created_by || me;
    await env.DB.prepare(
      "INSERT INTO memo_acks (tenant_id, memo_id, username, signed_at, doc_key, sig_key) VALUES (?,?,?,?,?,?) " +
      "ON CONFLICT(tenant_id, memo_id, username) DO NOTHING"
    ).bind(tid, id, author, at, null, null).run();
    // Push the memo's recipients (targeted set, else everyone) — fire-and-forget.
    const users = await recipientUsers(env, tid, memo);
    users.forEach((u) => {
      if (lc(u.username) === lc(author)) return;
      ctx?.waitUntil(sendToUser(env, tid, u.username, {
        title: "📢 New company memo", body: (memo.m_re || "Please read and sign").slice(0, 120),
        url: "/memo-sign.html?id=" + id, tag: "memo:" + id
      }));
    });
    return jr({ ok: true, id, recipients: users.length }, headers);
  }

  // ── Admin: delete a memo ────────────────────────────────────────────────────
  if (sub === "/delete" && method === "POST") {
    const bad = await needFull(); if (bad) return bad;
    const b = await readJson(request);
    const id = parseInt(b.id, 10);
    if (!id) return jr({ error: "id required" }, headers, 400);
    // Purge the signed-acknowledgement PDFs + signature PNGs that were filed into
    // people's My Documents when they signed — so deleting a (test) memo cleans up
    // fully and nothing is left in anyone's account.
    try {
      const acks = (await env.DB.prepare("SELECT doc_key, sig_key FROM memo_acks WHERE tenant_id=? AND memo_id=?").bind(tid, id).all()).results || [];
      for (const a of acks) {
        if (a.doc_key) { try { await env.JOB_FILES.delete(a.doc_key); } catch { /* best effort */ } }
        if (a.sig_key) { try { await env.JOB_FILES.delete(a.sig_key); } catch { /* best effort */ } }
      }
    } catch { /* best effort */ }
    await env.DB.prepare("DELETE FROM memos WHERE tenant_id=? AND id=?").bind(tid, id).run();
    await env.DB.prepare("DELETE FROM memo_acks WHERE tenant_id=? AND memo_id=?").bind(tid, id).run();
    return jr({ ok: true }, headers);
  }

  // ── Admin: list all memos with signed/total counts ──────────────────────────
  if (sub === "/list" && method === "GET") {
    const bad = await needFull(); if (bad) return bad;
    const { results } = await env.DB.prepare("SELECT * FROM memos WHERE tenant_id=? ORDER BY id DESC").bind(tid).all();
    const allCount = (await activeUsers(env, tid)).length;
    const memos = [];
    for (const m of results || []) {
      const recips = parseRecips(m);   // null = everyone
      const total = recips ? (await recipientUsers(env, tid, m)).length : allCount;
      let signed = 0;
      if (m.status === "sent") {
        const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM memo_acks WHERE tenant_id=? AND memo_id=?").bind(tid, m.id).first();
        signed = (c && c.n) || 0;
      }
      memos.push({ id: m.id, status: m.status, to: m.m_to, from: m.m_from, cc: m.m_cc, date: m.m_date, re: m.m_re, body: m.body, recipients: recips, created_at: m.created_at, sent_at: m.sent_at, signed, total });
    }
    return jr({ ok: true, memos }, headers);
  }

  // ── Admin: who has / hasn't signed a memo ───────────────────────────────────
  if (sub === "/status" && method === "GET") {
    const bad = await needFull(); if (bad) return bad;
    const id = parseInt(url.searchParams.get("id"), 10);
    if (!id) return jr({ error: "id required" }, headers, 400);
    const memo = await env.DB.prepare("SELECT * FROM memos WHERE tenant_id=? AND id=?").bind(tid, id).first();
    if (!memo) return jr({ error: "Not found" }, headers, 404);
    const acks = (await env.DB.prepare("SELECT username, signed_at, doc_key FROM memo_acks WHERE tenant_id=? AND memo_id=?").bind(tid, id).all()).results || [];
    const ackMap = {}, docMap = {}; acks.forEach((a) => { ackMap[lc(a.username)] = a.signed_at; if (a.doc_key) docMap[lc(a.username)] = a.doc_key; });
    const users = await recipientUsers(env, tid, memo);   // only the memo's recipients
    const signed = [], unsigned = [];
    users.forEach((u) => {
      if (ackMap[lc(u.username)]) signed.push({ username: u.username, name: fullName(u), at: ackMap[lc(u.username)], docKey: docMap[lc(u.username)] || null });
      else unsigned.push({ username: u.username, name: fullName(u) });
    });
    signed.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    // A signed, expiring link so an admin can view each person's signed copy.
    for (const s of signed) { if (s.docKey) s.doc = await signedFileUrl(env, url.origin, "/staff/doc", s.docKey); delete s.docKey; }
    return jr({ ok: true, memo: { id: memo.id, re: memo.m_re, from: memo.m_from, sent_at: memo.sent_at }, signed, unsigned }, headers);
  }

  // ── Any user: my pending (sent, unsigned) memos — drives the blocking gate ──
  if (sub === "/pending" && method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT m.id, m.m_re, m.m_from, m.sent_at, m.recipients FROM memos m WHERE m.tenant_id=? AND m.status='sent' " +
      "AND NOT EXISTS (SELECT 1 FROM memo_acks a WHERE a.tenant_id=m.tenant_id AND a.memo_id=m.id AND lower(a.username)=lower(?)) " +
      "ORDER BY m.id ASC"
    ).bind(tid, me).all();
    const meLc = lc(me);
    const mine = (results || []).filter((m) => { const r = parseRecips(m); return !r || r.includes(meLc); });
    return jr({ ok: true, memos: mine.map((m) => ({ id: m.id, re: m.m_re, from: m.m_from, at: m.sent_at })) }, headers);
  }

  // ── Any user: read one memo (for the sign page) ─────────────────────────────
  if (sub === "/one" && method === "GET") {
    const id = parseInt(url.searchParams.get("id"), 10);
    if (!id) return jr({ error: "id required" }, headers, 400);
    const m = await env.DB.prepare("SELECT * FROM memos WHERE tenant_id=? AND id=? AND status='sent'").bind(tid, id).first();
    if (!m) return jr({ error: "Not found" }, headers, 404);
    const a = await env.DB.prepare("SELECT signed_at FROM memo_acks WHERE tenant_id=? AND memo_id=? AND lower(username)=lower(?)").bind(tid, id, me).first();
    return jr({ ok: true, memo: { id: m.id, to: m.m_to, from: m.m_from, cc: m.m_cc, date: m.m_date, re: m.m_re, body: m.body, sent_at: m.sent_at }, signed: !!(a && a.signed_at) }, headers);
  }

  // ── Any user: SIGN / acknowledge a memo ─────────────────────────────────────
  if (sub === "/ack" && method === "POST") {
    const b = await readJson(request);
    const id = parseInt(b.id, 10);
    if (!id) return jr({ error: "id required" }, headers, 400);
    const memo = await env.DB.prepare("SELECT * FROM memos WHERE tenant_id=? AND id=? AND status='sent'").bind(tid, id).first();
    if (!memo) return jr({ error: "Memo not found" }, headers, 404);
    const rset = parseRecips(memo);
    if (rset && !rset.includes(lc(me))) return jr({ error: "This memo wasn't sent to you" }, headers, 403);
    const existing = await env.DB.prepare("SELECT signed_at FROM memo_acks WHERE tenant_id=? AND memo_id=? AND lower(username)=lower(?)").bind(tid, id, me).first();
    if (existing && existing.signed_at) return jr({ ok: true, already: true }, headers);

    // Signer display name.
    const urow = await env.DB.prepare("SELECT first_name, last_name FROM users WHERE tenant_id=? AND lower(username)=lower(?)").bind(tid, me).first();
    const signerName = urow ? (((urow.first_name || "") + " " + (urow.last_name || "")).trim() || me) : me;
    const at = new Date().toISOString();
    const ts = Date.now();

    // Store the drawn signature PNG (admin record).
    let sigKey = null;
    try {
      const dataUrl = String(b.signature || "");
      const mm = dataUrl.match(/^data:image\/(png|jpeg);base64,(.+)$/);
      if (mm) {
        const bin = Uint8Array.from(atob(mm[2]), (c) => c.charCodeAt(0));
        sigKey = `memos/${tid}/${id}/${safeName(me)}.${mm[1] === "jpeg" ? "jpg" : "png"}`;
        await env.JOB_FILES.put(sigKey, bin, { httpMetadata: { contentType: "image/" + mm[1] } });
      }
    } catch { /* signature optional to store; PDF still filed */ }

    // Build + file the signed-acknowledgement PDF into My Documents › Memos.
    const pdf = buildMemoPdf(memo, signerName, at);
    const docKey = `staffdocs/${tid}/user/${me}/Memos/${ts}-Memo-${safeName(memo.m_re || "memo")}.pdf`;
    await env.JOB_FILES.put(docKey, pdf, {
      httpMetadata: { contentType: "application/pdf" },
      customMetadata: { name: "Memo — " + (memo.m_re || "Company memo"), by: "Signed acknowledgement" }
    });

    await env.DB.prepare(
      "INSERT INTO memo_acks (tenant_id, memo_id, username, signed_at, doc_key, sig_key) VALUES (?,?,?,?,?,?) " +
      "ON CONFLICT(tenant_id, memo_id, username) DO UPDATE SET signed_at=excluded.signed_at, doc_key=excluded.doc_key, sig_key=excluded.sig_key"
    ).bind(tid, id, me, at, docKey, sigKey).run();
    return jr({ ok: true, signed_at: at }, headers);
  }

  return jr({ error: "Not found: " + sub }, headers, 404);
}
