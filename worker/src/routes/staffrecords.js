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
// Subcontractors — people/companies who aren't portal users but whose records
// (insurances, qualifications…) we still track. Keyed by a normalised name so it
// lines up 1:1 with the PO system's `subcontractors` table (also name-unique).
async function ensureSubTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS staff_subcontractors (
    tenant_id INTEGER, name_key TEXT, name TEXT, trade TEXT, contact TEXT, phone TEXT, email TEXT,
    active INTEGER DEFAULT 1, created_at TEXT, updated_at TEXT,
    PRIMARY KEY (tenant_id, name_key)
  )`).run();
}
const nameKeyOf = s => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
const SUB_PREFIX = "sub:";                       // staff_records.username for a subcontractor
const isSubUser = u => String(u || "").startsWith(SUB_PREFIX);

// ── PO system link (env.PO_DB.subcontractors) — bidirectional by name ─────────
// All fail soft: a missing PO_DB binding / column never breaks the HR area.
async function poAddSubcontractor(env, name) {
  if (!env.PO_DB || !name) return;
  try { await env.PO_DB.prepare("INSERT INTO subcontractors (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET active=1").bind(name).run(); } catch {}
}
async function poSetSubcontractorActive(env, name, active) {
  if (!env.PO_DB || !name) return;
  try { await env.PO_DB.prepare("UPDATE subcontractors SET active=? WHERE name=?").bind(active ? 1 : 0, name).run(); } catch {}
}
async function poListSubcontractors(env) {
  if (!env.PO_DB) return [];
  try { const { results } = await env.PO_DB.prepare("SELECT name, active FROM subcontractors").all(); return results || []; }
  catch { return []; }
}

// Managed matrix columns per kind (app_config `staff:matrixcols:<tid>` = {kind:[names]}).
// Lets a competency column exist before any engineer holds it.
async function getMatrixCols(db, kind) {
  try {
    const row = await db.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(db.tenantId, "staff:matrixcols:" + db.tenantId).first();
    const all = row && row.value ? JSON.parse(row.value) : {};
    return Array.isArray(all[kind]) ? all[kind] : [];
  } catch { return []; }
}
// Anthropic Messages API with a forced tool → structured JSON. Local copy of the
// shared pattern (supports a base64 PDF `document` block for scanned certs).
async function anthropicTool(env, { system, userContent, schema, toolName, maxTokens }) {
  const model = env.ANTHROPIC_MODEL || "claude-sonnet-5";
  let resp;
  try {
    resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: maxTokens || 1024, system, tools: [{ name: toolName, description: "Return the result.", input_schema: schema }], tool_choice: { type: "tool", name: toolName }, messages: [{ role: "user", content: userContent }] }),
    });
  } catch { return null; }
  if (!resp.ok) return null;
  let payload; try { payload = await resp.json(); } catch { return null; }
  const block = Array.isArray(payload.content) ? payload.content.find(c => c.type === "tool_use" && c.name === toolName) : null;
  return block?.input || null;
}

async function setMatrixCols(db, kind, cols) {
  let all = {};
  try { const row = await db.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(db.tenantId, "staff:matrixcols:" + db.tenantId).first(); all = row && row.value ? JSON.parse(row.value) : {}; } catch {}
  all[kind] = cols;
  await db.prepare("INSERT INTO app_config (tenant_id, key, value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(db.tenantId, "staff:matrixcols:" + db.tenantId, JSON.stringify(all)).run();
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

// Monthly driver licence checks: each active user with a vehicle assigned should
// have a licence_check logged in the current calendar month. Returns a row per
// driver with their latest check + a done|due status (proof-of-check register).
async function computeDriverChecks(db) {
  let drivers = [];
  try {
    const { results } = await db.prepare(
      "SELECT username, first_name, last_name, status, vehicle_assigned FROM users WHERE tenant_id=? AND vehicle_assigned IS NOT NULL AND TRIM(vehicle_assigned)<>''"
    ).bind(db.tenantId).all();
    drivers = (results || []).filter(u => { const s = String(u.status || "").trim().toLowerCase(); return s === "" || s === "active"; });
  } catch { return []; }
  // Latest licence check per driver.
  const latest = {};
  try {
    const { results } = await db.prepare(
      "SELECT username, issued, expires FROM staff_records WHERE tenant_id=? AND kind='licence_check'"
    ).bind(db.tenantId).all();
    for (const r of (results || [])) {
      const cur = latest[r.username];
      if (!cur || String(r.issued || "") > String(cur.issued || "")) latest[r.username] = { issued: r.issued || "", expires: r.expires || "" };
    }
  } catch {}
  // Photocard licence expiry (field 4b) per driver — the actual DRIVING LICENCE
  // expiry, distinct from the monthly check. Latest licence record's expires.
  const lic = {};
  try {
    const { results } = await db.prepare(
      "SELECT username, expires FROM staff_records WHERE tenant_id=? AND kind='licence'"
    ).bind(db.tenantId).all();
    for (const r of (results || [])) {
      const cur = lic[r.username];
      if (!cur || String(r.expires || "") > String(cur || "")) lic[r.username] = r.expires || "";
    }
  } catch {}
  const month = todayISO().slice(0, 7);
  return drivers.map(u => {
    const name = ((u.first_name || "") + " " + (u.last_name || "")).trim() || u.username;
    const l = latest[u.username] || null;
    const doneThisMonth = !!(l && String(l.issued || "").slice(0, 7) === month);
    const nextDue = l ? (l.expires || "") : "";
    const licenceExpiry = lic[u.username] || "";
    return { username: u.username, name, reg: u.vehicle_assigned || "", lastChecked: l ? l.issued : "", nextDue, status: doneThisMonth ? "done" : "due",
             licenceExpiry, licenceStatus: statusOf(licenceExpiry) };
  }).sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : (a.status === "due" ? -1 : 1)));
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
    try { await ensureSubTable(db); const { results: subs } = await db.prepare("SELECT name_key, name FROM staff_subcontractors WHERE tenant_id=?").bind(db.tenantId).all(); for (const s of (subs || [])) nameById[SUB_PREFIX + s.name_key] = s.name; } catch {}
    const items = [];
    for (const r of (results || [])) {
      const st = statusOf(r.expires);
      if (st !== "expired" && st !== "expiring") continue;
      items.push({ id: r.id, username: r.username, name: nameById[r.username] || (isSubUser(r.username) ? r.username.slice(SUB_PREFIX.length) : r.username), subcontractor: isSubUser(r.username), kind: r.kind, title: r.title || "", expires: r.expires, status: st, daysLeft: daysUntil(r.expires) });
    }
    items.sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0));
    let driverChecksDue = 0;
    try { driverChecksDue = (await computeDriverChecks(db)).filter(d => d.status === "due").length; } catch {}
    return json({ ok: true, count: items.length + driverChecksDue, expired: items.filter(i => i.status === "expired").length, expiring: items.filter(i => i.status === "expiring").length, driverChecksDue, items }, {}, env, request);
  }

  // ── Subcontractors — list (merged with the PO system), upsert, deactivate ─────
  if (path === "/hr/subcontractors" && method === "GET") {
    if (!isAdmin) return error("This needs HR access.", 403, env, request);
    await ensureSubTable(db);
    const { results: local } = await db.prepare("SELECT * FROM staff_subcontractors WHERE tenant_id=?").bind(db.tenantId).all();
    const byKey = {};
    for (const s of (local || [])) byKey[s.name_key] = { name: s.name, nameKey: s.name_key, trade: s.trade || "", contact: s.contact || "", phone: s.phone || "", email: s.email || "", active: s.active !== 0, inPO: false, local: true, counts: { total: 0, expired: 0, expiring: 0, valid: 0, none: 0 } };
    // Merge the PO system's subcontractors (a name-only list) — anything there
    // that we don't already hold appears too (the "…and vice versa" direction).
    for (const p of await poListSubcontractors(env)) {
      const k = nameKeyOf(p.name); if (!k) continue;
      if (byKey[k]) byKey[k].inPO = true;
      else byKey[k] = { name: p.name, nameKey: k, trade: "", contact: "", phone: "", email: "", active: p.active !== 0, inPO: true, local: false, counts: { total: 0, expired: 0, expiring: 0, valid: 0, none: 0 } };
    }
    // Record counts per subcontractor.
    try {
      const { results: recs } = await db.prepare("SELECT username, expires FROM staff_records WHERE tenant_id=? AND username LIKE 'sub:%'").bind(db.tenantId).all();
      for (const r of (recs || [])) { const k = r.username.slice(SUB_PREFIX.length); if (byKey[k]) { byKey[k].counts.total++; byKey[k].counts[statusOf(r.expires)]++; } }
    } catch {}
    const rows = Object.values(byKey).sort((a, b) => a.name.localeCompare(b.name));
    return json({ ok: true, rows }, {}, env, request);
  }
  if (path === "/hr/subcontractor" && method === "POST") {
    if (!isAdmin) return error("This needs HR access.", 403, env, request);
    await ensureSubTable(db);
    const b = await request.json().catch(() => ({}));
    const name = String(b.name || "").trim().slice(0, 160);
    if (!name) return error("A subcontractor name is required.", 400, env, request);
    const key = nameKeyOf(name);
    const now = new Date().toISOString();
    const existing = await db.prepare("SELECT name_key FROM staff_subcontractors WHERE tenant_id=? AND name_key=?").bind(db.tenantId, key).first();
    const trade = String(b.trade || "").slice(0, 120), contact = String(b.contact || "").slice(0, 120), phone = String(b.phone || "").slice(0, 60), email = String(b.email || "").slice(0, 160);
    const active = b.active === false ? 0 : 1;
    if (existing) {
      await db.prepare("UPDATE staff_subcontractors SET name=?, trade=?, contact=?, phone=?, email=?, active=?, updated_at=? WHERE tenant_id=? AND name_key=?")
        .bind(name, trade, contact, phone, email, active, now, db.tenantId, key).run();
    } else {
      await db.prepare("INSERT INTO staff_subcontractors (tenant_id, name_key, name, trade, contact, phone, email, active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .bind(db.tenantId, key, name, trade, contact, phone, email, active, now, now).run();
    }
    // Bidirectional: add to the PO system's subcontractors (idempotent by name).
    if (active) ctx?.waitUntil ? ctx.waitUntil(poAddSubcontractor(env, name)) : await poAddSubcontractor(env, name);
    return json({ ok: true, nameKey: key, username: SUB_PREFIX + key }, {}, env, request);
  }
  if (path === "/hr/subcontractor/delete" && method === "POST") {
    if (!isAdmin) return error("This needs HR access.", 403, env, request);
    await ensureSubTable(db);
    const b = await request.json().catch(() => ({}));
    const name = String(b.name || "").trim();
    const key = nameKeyOf(name);
    if (!key) return error("Missing name", 400, env, request);
    await db.prepare("UPDATE staff_subcontractors SET active=0, updated_at=? WHERE tenant_id=? AND name_key=?").bind(new Date().toISOString(), db.tenantId, key).run();
    await poSetSubcontractorActive(env, name, false);      // keep in step with PO
    return json({ ok: true }, {}, env, request);
  }

  // ── Monthly driver licence checks — who's done / due this month ───────────────
  if (path === "/hr/driver-checks" && method === "GET") {
    if (!isAdmin) return error("This needs HR access.", 403, env, request);
    const rows = await computeDriverChecks(db);
    return json({ ok: true, rows, due: rows.filter(r => r.status === "due").length }, {}, env, request);
  }

  // ── Training matrix — competencies (columns) × staff (rows) ──────────────────
  // Pivots the records of one kind (default `qualification`) into a grid so the
  // office can see at a glance who holds what and when each expires. Columns are
  // the distinct record TITLES; each cell is that person's latest record of that
  // title (the one with the furthest-out expiry) + its status.
  if (path === "/hr/matrix" && method === "GET") {
    if (!isAdmin) return error("This needs HR access.", 403, env, request);
    const kind = KINDS.includes(q.get("kind")) ? q.get("kind") : "qualification";
    const fieldOnly = q.get("field") === "1";
    const { results: users } = await db.prepare(
      "SELECT username, first_name, last_name, status, profile FROM users WHERE tenant_id=?"
    ).bind(db.tenantId).all();
    const active = (users || []).filter(u => { const s = String(u.status || "").trim().toLowerCase(); return s === "" || s === "active"; });
    const staffTypeOf = u => { try { return String((JSON.parse(u.profile || "{}").staffType) || "").toLowerCase(); } catch { return ""; } };
    const people = fieldOnly ? active.filter(u => staffTypeOf(u) !== "office") : active;
    const { results: recs } = await db.prepare(
      "SELECT username, title, issued, expires, id FROM staff_records WHERE tenant_id=? AND kind=?"
    ).bind(db.tenantId, kind).all();
    const titles = new Set();
    const best = {};                                    // username -> title -> {expires, id, status}
    for (const r of (recs || [])) {
      const t = String(r.title || "").trim();
      if (!t) continue;
      titles.add(t);
      const pm = (best[r.username] = best[r.username] || {});
      const cur = pm[t];
      // keep the record that expires latest (blank expiry ranks lowest)
      if (!cur || String(r.expires || "") > String(cur.expires || "")) pm[t] = { expires: r.expires || "", id: r.id, status: statusOf(r.expires) };
    }
    // Managed columns (added via "+ Add column") appear even with no records yet.
    for (const t of await getMatrixCols(db, kind)) if (String(t || "").trim()) titles.add(String(t).trim());
    const competencies = [...titles].sort((a, b) => a.localeCompare(b));
    const rows = people.map(u => ({
      username: u.username,
      name: ((u.first_name || "") + " " + (u.last_name || "")).trim() || u.username,
      cells: best[u.username] || {},
    })).sort((a, b) => a.name.localeCompare(b.name));
    return json({ ok: true, kind, competencies, rows }, {}, env, request);
  }
  // Add / remove a managed matrix column (competency) for a kind.
  if (path === "/hr/matrix/column" && method === "POST") {
    if (!isAdmin) return error("This needs HR access.", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const kind = KINDS.includes(b.kind) ? b.kind : "qualification";
    const name = String(b.name || "").trim().slice(0, 120);
    if (!name) return error("A column name is required.", 400, env, request);
    const cols = await getMatrixCols(db, kind);
    if (!cols.some(c => c.toLowerCase() === name.toLowerCase())) { cols.push(name); await setMatrixCols(db, kind, cols); }
    return json({ ok: true, columns: cols }, {}, env, request);
  }
  if (path === "/hr/matrix/column/delete" && method === "POST") {
    if (!isAdmin) return error("This needs HR access.", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const kind = KINDS.includes(b.kind) ? b.kind : "qualification";
    const name = String(b.name || "").trim();
    const cols = (await getMatrixCols(db, kind)).filter(c => c.toLowerCase() !== name.toLowerCase());
    await setMatrixCols(db, kind, cols);
    return json({ ok: true, columns: cols }, {}, env, request);
  }

  // ── Auto-extract certificate details (title / number / issuer / dates) ───────
  // Reads the filename + the certificate's text (or a scanned PDF via OCR) and
  // returns structured fields to pre-fill the add-record form. Fails SOFT — an
  // empty result just means "fill it in yourself" (the client still applies its
  // own filename heuristic). Nothing is stored.
  if (path === "/hr/extract-cert" && method === "POST") {
    if (!isAdmin) return error("This needs HR access.", 403, env, request);
    const b = await request.json().catch(() => ({}));
    if (!env.ANTHROPIC_API_KEY) return json({ ok: true, result: {} }, {}, env, request);
    const filename = String(b.filename || "").slice(0, 300);
    const text = String(b.text || "").slice(0, 60000);
    const kind = KINDS.includes(b.kind) ? b.kind : "qualification";
    if (!filename && !text && !b.pdfBase64 && !b.imageBase64) return json({ ok: true, result: {} }, {}, env, request);
    const schema = { type: "object", properties: {
      title: { type: "string", description: "The qualification / certificate name or type (e.g. CSCS Card, SMSTS, First Aid at Work, Asbestos Awareness). For an insurance, the cover type; for a licence, the licence type." },
      number: { type: "string", description: "The certificate / card / registration / policy number, if present." },
      issuer: { type: "string", description: "The awarding body / issuing organisation / training provider / insurer." },
      issued: { type: "string", description: "Issue / completion date as YYYY-MM-DD, if present." },
      expires: { type: "string", description: "Expiry / renewal / valid-until date as YYYY-MM-DD, if present." },
    }, required: [] };
    const system = "You extract details from a UK construction worker's certificate/qualification document for a training record. Use BOTH the file name and the document text/image. Return only what the source clearly supports — leave a field blank rather than guessing. Dates must be YYYY-MM-DD.\n\n" +
      "If it is a UK PHOTOCARD DRIVING LICENCE, read the numbered fields on the front: field 4a = the licence ISSUE date (put in `issued`); field 4b = the photocard EXPIRY date (put in `expires` — this is the date the card must be renewed, NOT the entitlement/category dates in section 9/11); field 4c = the issuing authority, usually DVLA (put in `issuer`); field 5 = the driver number (put in `number`); set `title` to \"Driving Licence\". Do NOT use the holder's date of birth (field 3) or the category expiry dates as the licence expiry — only 4b.";
    const userContent = [];
    if (b.pdfBase64 && typeof b.pdfBase64 === "string" && b.pdfBase64.length < 8000000) {
      userContent.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: b.pdfBase64 } });
    }
    // A photographed certificate or driving licence — Claude reads it by vision.
    const okImg = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (b.imageBase64 && typeof b.imageBase64 === "string" && b.imageBase64.length < 8000000 && okImg.includes(b.imageType)) {
      userContent.push({ type: "image", source: { type: "base64", media_type: b.imageType, data: b.imageBase64 } });
    }
    userContent.push({ type: "text", text: "RECORD TYPE: " + kind + "\nFILE NAME: " + (filename || "(none)") + "\n\n--- DOCUMENT TEXT ---\n" + (text || "(none — read the attached file)") });
    const result = await anthropicTool(env, { system, userContent, schema, toolName: "extract_cert", maxTokens: 800 });
    return json({ ok: true, result: result || {} }, {}, env, request);
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
  let driverDue = 0;
  try { driverDue = (await computeDriverChecks(db)).filter(d => d.status === "due").length; } catch {}
  if (expired + expiring + driverDue > 0) {
    const bits = [];
    if (expired) bits.push(`${expired} expired`);
    if (expiring) bits.push(`${expiring} expiring soon`);
    if (driverDue) bits.push(`${driverDue} driver licence check${driverDue === 1 ? "" : "s"} due this month`);
    await sendToPermission(env, tid, ["FullAccess", "StaffRecords"], {
      title: expired ? "⚠️ Employee records need attention" : "Employee records / licence checks due",
      body: `${bits.join(" · ")}.`,
      url: "/employees.html", tag: "staff-records-expiry",
    });
  }
  try {
    await db.prepare("INSERT INTO app_config (tenant_id, key, value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(tid, cfgKey, dayKey).run();
  } catch {}
}
