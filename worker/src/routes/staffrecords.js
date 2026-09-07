// Employee records — HR store for each person's qualifications / tickets,
// insurances, driving licences and licence (DVLA) checks, WITH expiry tracking
// and reminders.
//
// One generic table serves every kind (`kind` says which); kind-specific extras
// ride in the `data` JSON so no schema churn as fields grow. A single optional
// document (the certificate / scan) is attached per record, stored in R2 and
// served through a signed, expiring link (same protection as staff docs).
//
//   GET  /hr/records?user=<u>     one person's records (own if not admin)
//   GET  /hr/overview             admin: per-person summary (counts) for the list
//   GET  /hr/attention            admin: expiring/expired items (home hub + cron)
//   POST /hr/record               create/update (multipart; admin)  — file optional
//   POST /hr/record/delete        { id }  (admin) — purges the R2 doc
//   GET  /hr/record-file?key=…    stream the attached document (signed; public)
//
// Manage = FullAccess | StaffRecords. Any logged-in user may read their OWN
// records (read-only self-view).

import { json, error, corsHeaders } from "../lib/http.js";
import { requireSession, permissionsFor } from "../lib/auth.js";
import { tenantDB } from "../lib/tenantdb.js";
import { signedFileUrl, verifyFileSig } from "../lib/filesign.js";
import { sendToPermission } from "./push.js";

export const KINDS = ["qualification", "insurance", "licence", "licence_check"];
const EXPIRING_DAYS = 30;                     // "expiring soon" window
const safeName = s => String(s || "file").replace(/[^\w.\-]+/g, "_").slice(0, 90);

async function ensureTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS staff_records (
    tenant_id INTEGER, id TEXT PRIMARY KEY, username TEXT, kind TEXT,
    title TEXT, number TEXT, issuer TEXT, issued TEXT, expires TEXT,
    data TEXT, doc_key TEXT, doc_name TEXT,
    created_by TEXT, created_at TEXT, updated_at TEXT
  )`).run();
  try { await db.prepare("CREATE INDEX IF NOT EXISTS idx_staffrec_user ON staff_records(tenant_id, username)").run(); } catch {}
}

const todayISO = () => new Date().toISOString().slice(0, 10);
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const d = new Date(String(dateStr).slice(0, 10) + "T00:00:00Z");
  if (isNaN(d)) return null;
  return Math.round((d - new Date(todayISO() + "T00:00:00Z")) / 86400000);
}
// status: expired | expiring | valid | none (no expiry set)
function statusOf(expires) {
  const n = daysUntil(expires);
  if (n === null) return "none";
  if (n < 0) return "expired";
  if (n <= EXPIRING_DAYS) return "expiring";
  return "valid";
}
function parseData(s) { try { const v = JSON.parse(s || "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; } }

async function shape(env, origin, r) {
  const rec = {
    id: r.id, username: r.username, kind: r.kind, title: r.title || "", number: r.number || "",
    issuer: r.issuer || "", issued: r.issued || "", expires: r.expires || "",
    data: parseData(r.data), docName: r.doc_name || "",
    createdBy: r.created_by || "", createdAt: r.created_at || "", updatedAt: r.updated_at || "",
    status: statusOf(r.expires), daysLeft: daysUntil(r.expires),
  };
  if (r.doc_key) rec.docUrl = await signedFileUrl(env, origin, "/hr/record-file", r.doc_key);
  return rec;
}

export async function handle(request, env, ctx, url, sess) {
  const path = url.pathname;
  const method = request.method.toUpperCase();
  const q = url.searchParams;

  // ── PUBLIC: stream an attached document (access-gated by the signed URL) ──────
  if (path === "/hr/record-file" && method === "GET") {
    const key = q.get("key");
    if (!key || !String(key).startsWith("staffrec/")) return error("Bad key", 400, env, request);
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
  const isAdmin = perms.FullAccess === "Yes" || perms.StaffRecords === "Yes";
  const db = tenantDB(env, sess.tenantId);
  await ensureTable(db);
  const me = sess.user.username;

  // ── One person's records (own for non-admins) ────────────────────────────────
  if (path === "/hr/records" && method === "GET") {
    let user = q.get("user") || me;
    if (!isAdmin) user = me;                                    // self-view only
    const { results } = await db.prepare(
      "SELECT * FROM staff_records WHERE tenant_id=? AND username=? ORDER BY kind, expires IS NULL, expires"
    ).bind(db.tenantId, user).all();
    const records = [];
    for (const r of (results || [])) records.push(await shape(env, url.origin, r));
    return json({ ok: true, user, canManage: isAdmin, records }, {}, env, request);
  }

  // ── Everything below is admin (FullAccess | StaffRecords) ────────────────────
  if (path === "/hr/overview" && method === "GET") {
    if (!isAdmin) return error("This needs HR access.", 403, env, request);
    // Active staff + their record counts by status.
    const { results: users } = await db.prepare(
      "SELECT username, first_name, last_name, status, employment_type FROM users WHERE tenant_id=?"
    ).bind(db.tenantId).all();
    const active = (users || []).filter(u => { const s = String(u.status || "").trim().toLowerCase(); return s === "" || s === "active"; });
    const { results: recs } = await db.prepare(
      "SELECT username, kind, expires FROM staff_records WHERE tenant_id=?"
    ).bind(db.tenantId).all();
    const byUser = {};
    for (const r of (recs || [])) {
      const k = (byUser[r.username] = byUser[r.username] || { total: 0, expired: 0, expiring: 0, valid: 0, none: 0 });
      k.total++; k[statusOf(r.expires)]++;
    }
    const rows = active.map(u => {
      const name = ((u.first_name || "") + " " + (u.last_name || "")).trim() || u.username;
      const c = byUser[u.username] || { total: 0, expired: 0, expiring: 0, valid: 0, none: 0 };
      return { username: u.username, name, employmentType: u.employment_type || "", counts: c };
    }).sort((a, b) => a.name.localeCompare(b.name));
    return json({ ok: true, rows }, {}, env, request);
  }

  // ── Expiring / expired across everyone (home hub + cron) ─────────────────────
  if (path === "/hr/attention" && method === "GET") {
    if (!isAdmin) return json({ ok: true, count: 0, items: [] }, {}, env, request);
    const { results } = await db.prepare(
      "SELECT id, username, kind, title, expires FROM staff_records WHERE tenant_id=? AND expires IS NOT NULL AND expires<>''"
    ).bind(db.tenantId).all();
    const nameById = {};
    try {
      const { results: us } = await db.prepare("SELECT username, first_name, last_name FROM users WHERE tenant_id=?").bind(db.tenantId).all();
      for (const u of (us || [])) nameById[u.username] = ((u.first_name || "") + " " + (u.last_name || "")).trim() || u.username;
    } catch {}
    const items = [];
    for (const r of (results || [])) {
      const st = statusOf(r.expires);
      if (st !== "expired" && st !== "expiring") continue;
      items.push({ id: r.id, username: r.username, name: nameById[r.username] || r.username, kind: r.kind, title: r.title || "", expires: r.expires, status: st, daysLeft: daysUntil(r.expires) });
    }
    items.sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0));
    return json({ ok: true, count: items.length, expired: items.filter(i => i.status === "expired").length, expiring: items.filter(i => i.status === "expiring").length, items }, {}, env, request);
  }

  // ── Create / update (multipart; file optional) ───────────────────────────────
  if (path === "/hr/record" && method === "POST") {
    if (!isAdmin) return error("This needs HR access.", 403, env, request);
    const form = await request.formData();
    const id = String(form.get("id") || "").trim();
    const username = String(form.get("username") || "").trim();
    const kind = String(form.get("kind") || "").trim();
    if (!username) return error("Employee is required", 400, env, request);
    if (!KINDS.includes(kind)) return error("Unknown record type", 400, env, request);
    const title = String(form.get("title") || "").trim().slice(0, 200);
    const number = String(form.get("number") || "").trim().slice(0, 120);
    const issuer = String(form.get("issuer") || "").trim().slice(0, 160);
    const issued = String(form.get("issued") || "").trim().slice(0, 10);
    const expires = String(form.get("expires") || "").trim().slice(0, 10);
    let data = {}; try { data = JSON.parse(String(form.get("data") || "{}")); } catch {}
    const now = new Date().toISOString();

    let existing = null;
    if (id) existing = await db.prepare("SELECT * FROM staff_records WHERE tenant_id=? AND id=?").bind(db.tenantId, id).first();
    const recId = existing ? existing.id : ("SR-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7));

    // Document handling: new file replaces the old; removeDoc clears it.
    let docKey = existing ? (existing.doc_key || "") : "";
    let docName = existing ? (existing.doc_name || "") : "";
    const file = form.get("file");
    if (file && typeof file === "object" && file.size) {
      if (file.size > 25 * 1024 * 1024) return error("File too large (max 25 MB).", 400, env, request);
      const key = `staffrec/${db.tenantId}/${username}/${recId}/${Date.now()}-${safeName(file.name)}`;
      await env.JOB_FILES.put(key, file.stream(), { httpMetadata: { contentType: file.type || "application/octet-stream" }, customMetadata: { by: me, at: now } });
      if (docKey && docKey !== key) { try { await env.JOB_FILES.delete(docKey); } catch {} }
      docKey = key; docName = file.name || safeName(file.name);
    } else if (String(form.get("removeDoc") || "") === "1" && docKey) {
      try { await env.JOB_FILES.delete(docKey); } catch {}
      docKey = ""; docName = "";
    }

    if (existing) {
      await db.prepare(`UPDATE staff_records SET username=?, kind=?, title=?, number=?, issuer=?, issued=?, expires=?, data=?, doc_key=?, doc_name=?, updated_at=? WHERE tenant_id=? AND id=?`)
        .bind(username, kind, title, number, issuer, issued, expires, JSON.stringify(data), docKey, docName, now, db.tenantId, recId).run();
    } else {
      await db.prepare(`INSERT INTO staff_records (tenant_id, id, username, kind, title, number, issuer, issued, expires, data, doc_key, doc_name, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(db.tenantId, recId, username, kind, title, number, issuer, issued, expires, JSON.stringify(data), docKey, docName, me, now, now).run();
    }
    const row = await db.prepare("SELECT * FROM staff_records WHERE tenant_id=? AND id=?").bind(db.tenantId, recId).first();
    return json({ ok: true, record: await shape(env, url.origin, row) }, {}, env, request);
  }

  // ── Delete ───────────────────────────────────────────────────────────────────
  if (path === "/hr/record/delete" && method === "POST") {
    if (!isAdmin) return error("This needs HR access.", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const id = String(b.id || "");
    if (!id) return error("Missing id", 400, env, request);
    const row = await db.prepare("SELECT doc_key FROM staff_records WHERE tenant_id=? AND id=?").bind(db.tenantId, id).first();
    if (row && row.doc_key) { try { await env.JOB_FILES.delete(row.doc_key); } catch {} }
    await db.prepare("DELETE FROM staff_records WHERE tenant_id=? AND id=?").bind(db.tenantId, id).run();
    return json({ ok: true }, {}, env, request);
  }

  return error("Unknown HR route", 404, env, request);
}

// ── Cron: chase expiring/expired records ~08:00 London, once per day ───────────
// Pushes HR admins a single glanceable summary. Deduped per tenant per day via
// app_config. Mirrors the other daily reminder sweeps.
export async function sweepStaffRecordReminders(env) {
  const tid = 1;
  // Only chase from ~08:00 London onward; the per-day dedup below then makes it
  // fire once, on the first tick at/after 8am.
  let londonHour = 8;
  try { londonHour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hour12: false }).format(new Date())); } catch {}
  if (londonHour < 8) return;
  const db = tenantDB(env, tid);
  try { await ensureTable(db); } catch { return; }
  const dayKey = todayISO();
  const cfgKey = `staffrec:reminded:${tid}`;
  try {
    const row = await db.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(tid, cfgKey).first();
    if (row && row.value === dayKey) return;                    // already chased today
  } catch {}
  const { results } = await db.prepare(
    "SELECT username, kind, title, expires FROM staff_records WHERE tenant_id=? AND expires IS NOT NULL AND expires<>''"
  ).bind(tid).all().catch(() => ({ results: [] }));
  let expired = 0, expiring = 0;
  for (const r of (results || [])) {
    const st = statusOf(r.expires);
    if (st === "expired") expired++; else if (st === "expiring") expiring++;
  }
  if (expired + expiring > 0) {
    const bits = [];
    if (expired) bits.push(`${expired} expired`);
    if (expiring) bits.push(`${expiring} expiring soon`);
    await sendToPermission(env, tid, ["FullAccess", "StaffRecords"], {
      title: expired ? "⚠️ Employee records need attention" : "Employee records expiring soon",
      body: `${bits.join(" · ")} — qualifications / licences / insurances.`,
      url: "/employees.html", tag: "staff-records-expiry",
    });
  }
  try {
    await db.prepare("INSERT INTO app_config (tenant_id, key, value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(tid, cfgKey, dayKey).run();
  } catch {}
}
