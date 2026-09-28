// ─────────────────────────────────────────────────────────────────────────────
// FBC (Fareham Borough Council) job tracker.
//
// FBC incidents arrive as Jotform "Mostlane New Incident Form" emails and are
// auto-created as normal SLA jobs by the email intake (routes/emailtemplates.js
// `fbc-jotform` → /sla/inbound). This module is the FBC-specific LAYER over those
// jobs: what needs quoting, what it cost, which month it's invoiced under, its
// invoice status, and a log of the email conversation on each job — so nothing is
// forgotten to invoice.
//
//   Marker: an `fbc_meta` row (written by the intake) OR a job at an FBC site.
//   fbc_meta   — one row per job: quote-required, cost, PO, invoice month/status.
//   fbc_messages — the conversation log (the Jotform email + any follow-ups).
//
// Routes (mounted /fbc; office = FullAccess | SLAAdmin | Compliance):
//   GET  /fbc/list                  the tracker (rows + months seen)
//   GET  /fbc/job?id=               one job: meta + messages
//   POST /fbc/meta   {jobId, cost?, invoiceMonth?, invoiceStatus?, poNumber?,
//                     quoteStatus?, quoteAmount?, invoiceRef?}
//   POST /fbc/message {jobId, body} add a manual note to the log
//
// tenant_id is INTEGER and every bind is Number(tid) — never the string form —
// so the D1 "1.0" text-bind quirk can't make rows invisible.
// ─────────────────────────────────────────────────────────────────────────────

import { json, error } from "../lib/http.js";
import { requireSession, permissionsFor } from "../lib/auth.js";
import { resolveTenantId } from "../lib/tenantdb.js";
import { onceMigration } from "../lib/once.js";

async function ensureTables__raw(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS fbc_meta (
    tenant_id INTEGER, job_id TEXT PRIMARY KEY, reference TEXT, site_code TEXT, site_name TEXT,
    reported_by TEXT, job_title TEXT, w3w TEXT,
    quote_required INTEGER DEFAULT 0, quote_status TEXT DEFAULT '', quote_amount REAL,
    cost REAL, po_number TEXT, invoice_month TEXT, invoice_status TEXT DEFAULT '',
    invoiced_at TEXT, invoice_ref TEXT, source TEXT, created_at TEXT, updated_at TEXT
  )`).run();
  try { await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_fbc_meta_t ON fbc_meta(tenant_id)").run(); } catch {}
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS fbc_messages (
    id TEXT PRIMARY KEY, tenant_id INTEGER, job_id TEXT, at TEXT, direction TEXT,
    from_addr TEXT, subject TEXT, body TEXT, message_id TEXT, created_at TEXT
  )`).run();
  try { await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_fbc_msg_job ON fbc_messages(tenant_id, job_id)").run(); } catch {}
}
export const ensureTables = onceMigration(ensureTables__raw);

const now = () => new Date().toISOString();
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const monthOf = iso => (String(iso || "").match(/^(\d{4}-\d{2})/) || [])[1] || "";

// FBC site codes (client='fbc') — for surfacing manually-raised FBC jobs too.
async function fbcSiteCodes(env, tid) {
  try {
    const { results } = await env.DB.prepare("SELECT site_number FROM sites WHERE tenant_id=? AND client='fbc' AND site_number IS NOT NULL AND site_number<>''").bind(Number(tid)).all();
    return (results || []).map(r => String(r.site_number));
  } catch { return []; }
}

// ── Called by the email intake when an FBC Jotform job is created/updated ──────
// Writes the FBC marker + carries the incident fields, WITHOUT ever clobbering
// office-entered cost / invoice / PO / quote-status on a re-delivered email.
export async function recordFbcJob(env, tid, jobId, m = {}) {
  if (!env || !env.DB || !jobId) return;
  await ensureTables(env);
  const t = Number(tid) || 1;
  try {
    await env.DB.prepare(`INSERT INTO fbc_meta
      (tenant_id, job_id, reference, site_code, site_name, reported_by, job_title, w3w, quote_required, source, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(job_id) DO UPDATE SET
        reference=excluded.reference, site_code=excluded.site_code, site_name=excluded.site_name,
        reported_by=excluded.reported_by, job_title=excluded.job_title, w3w=excluded.w3w,
        quote_required=excluded.quote_required, updated_at=excluded.updated_at`)
      .bind(t, jobId, m.reference || "", m.siteCode || "", m.siteName || "",
        m.reportedBy || "", m.jobTitle || "", m.w3w || "", m.quoteRequired ? 1 : 0,
        m.source || "jotform", now(), now()).run();
  } catch (e) { console.log("recordFbcJob", String(e && e.message || e)); }
}

// ── Append one email/note to a job's conversation log (dedupe by message id) ──
export async function appendFbcMessage(env, tid, jobId, msg = {}) {
  if (!env || !env.DB || !jobId) return;
  await ensureTables(env);
  const t = Number(tid) || 1;
  const mid = String(msg.messageId || "").trim();
  const id = jobId + "|" + (mid || ("n-" + Math.random().toString(36).slice(2, 10)));
  try {
    await env.DB.prepare(`INSERT OR IGNORE INTO fbc_messages
      (id, tenant_id, job_id, at, direction, from_addr, subject, body, message_id, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, t, jobId, msg.at || now(), msg.direction || "in", String(msg.from || "").slice(0, 200),
        String(msg.subject || "").slice(0, 300), String(msg.body || "").slice(0, 8000), mid, now()).run();
  } catch (e) { console.log("appendFbcMessage", String(e && e.message || e)); }
}

// ── API ───────────────────────────────────────────────────────────────────────
export async function handle(request, env, ctx, url, sess) {
  if (!sess) sess = await requireSession(env, request);
  if (!sess || !sess.user) return error("Login required", 401, env, request);
  const tid = Number(await resolveTenantId(env, request)) || 1;
  const perms = await permissionsFor(env, tid, sess.user.username);
  const office = perms.FullAccess === "Yes" || perms.SLAAdmin === "Yes" || perms.Compliance === "Yes";
  if (!office) return error("FBC access needs Full Access, SLA admin or Compliance.", 403, env, request);
  await ensureTables(env);
  const method = request.method.toUpperCase();
  const sub = url.pathname.replace(/^\/fbc(?=\/|$)/, "") || "/";

  // Shape a merged row from an fbc_meta row (m) and its live sla_jobs row (j).
  const DONE = new Set(["complete", "closed", "closed jobs", "invoiced", "cancelled"]);
  const shape = (m, j, msg) => {
    const status = (j && j.status) || "";
    const finished = DONE.has(String(status).toLowerCase());
    const invStatus = (m && m.invoice_status) || "";
    // derived: invoiced (explicit) → to_invoice (finished, not invoiced) → open
    const invoiceState = invStatus === "invoiced" ? "invoiced" : (invStatus === "not_required" ? "not_required" : (finished ? "to_invoice" : "open"));
    let siteName = (m && m.site_name) || "";
    if (!siteName && j && j.data) { try { siteName = JSON.parse(j.data).siteName || ""; } catch {} }
    return {
      jobId: (m && m.job_id) || (j && j.id) || "",
      reference: (j && j.helpdesk_ref) || (m && m.reference) || "",
      siteCode: (m && m.site_code) || (j && j.site_code) || "",
      siteName: siteName || (j && j.site_code) || "",
      status, priority: (j && j.priority) || "",
      assignedTo: (j && j.assigned_to) || "",
      scheduledAt: (j && j.scheduled_at) || "",
      raisedAt: (j && j.created_at) || (m && m.created_at) || "",
      description: (j && j.description) || "",
      reportedBy: (m && m.reported_by) || "",
      jobTitle: (m && m.job_title) || "",
      w3w: (m && m.w3w) || "",
      quoteRequired: !!(m && m.quote_required),
      quoteStatus: (m && m.quote_status) || "",
      quoteAmount: m ? m.quote_amount : null,
      cost: m ? m.cost : null,
      poNumber: (m && m.po_number) || "",
      invoiceMonth: (m && m.invoice_month) || "",
      invoiceStatus: invStatus,
      invoiceState,
      invoicedAt: (m && m.invoiced_at) || "",
      invoiceRef: (m && m.invoice_ref) || "",
      source: (m && m.source) || (j ? "manual" : ""),
      messageCount: (msg && msg.n) || 0,
      lastMessageAt: (msg && msg.last) || "",
      onBoard: !!j,
    };
  };

  if (sub === "/list" && method === "GET") {
    // 1) all fbc_meta rows + their live job
    const { results: metas } = await env.DB.prepare(
      `SELECT m.*, j.id AS j_id, j.helpdesk_ref, j.status, j.priority, j.site_code AS j_site, j.assigned_to, j.scheduled_at, j.created_at AS j_created, j.description, j.data
       FROM fbc_meta m LEFT JOIN sla_jobs j ON j.id=m.job_id AND j.tenant_id=?
       WHERE m.tenant_id=?`).bind(tid, tid).all();
    // message counts
    const { results: mc } = await env.DB.prepare(
      "SELECT job_id, COUNT(*) AS n, MAX(at) AS last FROM fbc_messages WHERE tenant_id=? GROUP BY job_id").bind(tid).all();
    const msgBy = {}; for (const r of (mc || [])) msgBy[r.job_id] = { n: r.n, last: r.last };
    const seen = new Set();
    const rows = (metas || []).map(r => {
      seen.add(r.job_id);
      const j = r.j_id ? { id: r.j_id, helpdesk_ref: r.helpdesk_ref, status: r.status, priority: r.priority, site_code: r.j_site, assigned_to: r.assigned_to, scheduled_at: r.scheduled_at, created_at: r.j_created, description: r.description, data: r.data } : null;
      return shape(r, j, msgBy[r.job_id]);
    });
    // 2) jobs at FBC sites with no meta row (manually raised) — surface them too
    const codes = await fbcSiteCodes(env, tid);
    if (codes.length) {
      const ph = codes.map(() => "?").join(",");
      const { results: extra } = await env.DB.prepare(
        `SELECT id, helpdesk_ref, status, priority, site_code, assigned_to, scheduled_at, created_at, description, data
         FROM sla_jobs WHERE tenant_id=? AND site_code IN (${ph})`).bind(tid, ...codes).all();
      for (const j of (extra || [])) {
        if (seen.has(j.id)) continue;
        rows.push(shape(null, j, msgBy[j.id]));
      }
    }
    rows.sort((a, b) => String(b.raisedAt).localeCompare(String(a.raisedAt)));
    const months = [...new Set(rows.map(r => r.invoiceMonth).filter(Boolean))].sort().reverse();
    return json({ ok: true, rows, months }, {}, env, request);
  }

  if (sub === "/job" && method === "GET") {
    const jobId = url.searchParams.get("id") || "";
    if (!jobId) return error("id required", 400, env, request);
    const m = await env.DB.prepare("SELECT * FROM fbc_meta WHERE tenant_id=? AND job_id=?").bind(tid, jobId).first();
    const j = await env.DB.prepare("SELECT id, helpdesk_ref, status, priority, site_code, assigned_to, scheduled_at, created_at, description, data FROM sla_jobs WHERE tenant_id=? AND id=?").bind(tid, jobId).first();
    if (!m && !j) return error("Not found", 404, env, request);
    const { results: msgs } = await env.DB.prepare(
      "SELECT at, direction, from_addr, subject, body FROM fbc_messages WHERE tenant_id=? AND job_id=? ORDER BY at DESC").bind(tid, jobId).all();
    const mcount = { n: (msgs || []).length, last: (msgs && msgs[0] && msgs[0].at) || "" };
    return json({ ok: true, job: shape(m, j, mcount), messages: msgs || [] }, {}, env, request);
  }

  if (sub === "/meta" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const jobId = String(b.jobId || "");
    if (!jobId) return error("jobId required", 400, env, request);
    // Upsert a bare row first (covers manually-raised FBC jobs with no meta yet).
    await env.DB.prepare("INSERT OR IGNORE INTO fbc_meta (tenant_id, job_id, source, created_at, updated_at) VALUES (?,?,?,?,?)")
      .bind(tid, jobId, "manual", now(), now()).run();
    const sets = [], vals = [];
    const put = (col, v) => { sets.push(col + "=?"); vals.push(v); };
    if ("cost" in b) put("cost", num(b.cost));
    if ("quoteAmount" in b) put("quote_amount", num(b.quoteAmount));
    if ("poNumber" in b) put("po_number", String(b.poNumber || "").slice(0, 60));
    if ("invoiceMonth" in b) put("invoice_month", String(b.invoiceMonth || "").slice(0, 7));
    if ("invoiceRef" in b) put("invoice_ref", String(b.invoiceRef || "").slice(0, 60));
    if ("quoteStatus" in b) put("quote_status", ["", "needed", "sent", "approved", "declined"].includes(b.quoteStatus) ? b.quoteStatus : "");
    if ("invoiceStatus" in b) {
      const st = ["", "to_invoice", "invoiced", "not_required"].includes(b.invoiceStatus) ? b.invoiceStatus : "";
      put("invoice_status", st);
      if (st === "invoiced") { put("invoiced_at", now()); if (!("invoiceMonth" in b)) put("invoice_month", monthOf(now())); }
    }
    if (!sets.length) return json({ ok: true, unchanged: true }, {}, env, request);
    put("updated_at", now());
    vals.push(tid, jobId);
    await env.DB.prepare(`UPDATE fbc_meta SET ${sets.join(", ")} WHERE tenant_id=? AND job_id=?`).bind(...vals).run();
    return json({ ok: true }, {}, env, request);
  }

  if (sub === "/message" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const jobId = String(b.jobId || "");
    if (!jobId || !String(b.body || "").trim()) return error("jobId and body required", 400, env, request);
    await appendFbcMessage(env, tid, jobId, { direction: "note", from: sess.user.username, subject: "", body: b.body, at: now() });
    return json({ ok: true }, {}, env, request);
  }

  return error("Unknown FBC route", 404, env, request);
}
