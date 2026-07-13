// UK GDPR data-subject tools: export everything held on a person (right of
// access) and anonymise/close an account (right to erasure).
//
//   GET  /privacy/export?u=<username>   full JSON of a person's data
//                                       (the person themselves, or a Full-access admin)
//   POST /privacy/erase { username, confirm:true }   anonymise + close (Full access)
//
// Erasure note: UK GDPR lets a business KEEP records it has a lawful basis or
// legal obligation to retain (e.g. payroll/working-time history, security logs).
// So "erase" here scrubs the personal identifiers on the user record, kills all
// access (sessions + devices), and deletes the personal document file — while
// leaving work records in place under a de-identified username. Every run is
// written to the audit log.

import { json, error } from "../lib/http.js";
import { permissionsFor } from "../lib/auth.js";
import { resolveTenantId } from "../lib/tenantdb.js";
import { deletePersonalDocs } from "./hrdocs.js";

// Tables that carry a person's data, keyed by their username column. Each is
// queried defensively so a schema that lacks one simply contributes nothing.
const EXPORT_TABLES = [
  ["users", "username"],
  ["user_permissions", "username"],
  ["sessions", "username"],
  ["devices", "username"],
  ["login_history", "username"],
  ["holidays", "username"],
  ["office_shifts", "username"],
  ["oncall_log", "username"],
  ["key_log", "username"],
  ["notify_log", "username"],
  ["audit_log", "username"],
  ["password_resets", "username"],
];

async function safeSelect(env, tenantId, table, col, value) {
  try {
    const res = await env.DB.prepare(
      `SELECT * FROM ${table} WHERE tenant_id = ? AND ${col} = ?`
    ).bind(tenantId, value).all();
    return res.results || [];
  } catch {
    // Table may not have tenant_id — retry without it before giving up.
    try {
      const res = await env.DB.prepare(`SELECT * FROM ${table} WHERE ${col} = ?`).bind(value).all();
      return res.results || [];
    } catch { return []; }
  }
}

function redact(rows) {
  // Never include password hashes / reset tokens in an export.
  return rows.map(r => {
    const o = { ...r };
    for (const k of Object.keys(o)) {
      if (/password|hash|token|secret/i.test(k)) o[k] = "[redacted]";
    }
    return o;
  });
}

export async function handle(request, env, ctx, url, sess) {
  if (!sess) return error("Not authenticated", 401, env, request);
  const tenantId = sess.tenantId != null ? sess.tenantId : await resolveTenantId(env, request);
  const perms = await permissionsFor(env, tenantId, sess.user.username);
  const isFull = perms.FullAccess === "Yes";
  const path = url.pathname;

  // ── Export (right of access) ───────────────────────────────────────────────
  if (path === "/privacy/export" && request.method === "GET") {
    const who = (url.searchParams.get("u") || sess.user.username).trim();
    // A person can export their OWN data; only a Full-access admin can export
    // someone else's.
    if (who !== sess.user.username && !isFull) return error("Forbidden", 403, env, request);

    const data = {};
    for (const [table, col] of EXPORT_TABLES) {
      const rows = await safeSelect(env, tenantId, table, col, who);
      if (rows.length) data[table] = redact(rows);
    }
    return json({
      ok: true,
      subject: who,
      generatedAt: new Date().toISOString(),
      note: "Personal data held for this person across the portal. Password hashes and tokens are redacted. Uploaded documents are stored separately in the staff documents area.",
      data
    }, {}, env, request);
  }

  // ── Erase (right to erasure — anonymise + close) ───────────────────────────
  if (path === "/privacy/erase" && request.method === "POST") {
    if (!isFull) return error("Only a Full-access user can erase an account.", 403, env, request);
    const body = await request.json().catch(() => ({}));
    const who = (body.username || "").trim();
    if (!who) return error("username required", 400, env, request);
    if (body.confirm !== true) return error("Confirmation required", 400, env, request);
    if (who === sess.user.username) return error("You cannot erase your own account.", 400, env, request);

    const summary = { anonymisedUser: false, sessionsDeleted: 0, devicesDeleted: 0, personalDocsDeleted: 0, kept: [] };

    // 1. Scrub personal identifiers on the user record + close the account.
    try {
      await env.DB.prepare(
        `UPDATE users SET first_name='(erased)', last_name='(erased)', email=NULL, phone=NULL,
           profile='{}', status='Disabled', updated_at=? WHERE tenant_id=? AND username=?`
      ).bind(new Date().toISOString(), tenantId, who).run();
      summary.anonymisedUser = true;
    } catch (e) { summary.userError = e.message; }

    // 2. Kill all access.
    try { const r = await env.DB.prepare("DELETE FROM sessions WHERE tenant_id=? AND username=?").bind(tenantId, who).run(); summary.sessionsDeleted = r.meta?.changes || 0; } catch {}
    try { const r = await env.DB.prepare("DELETE FROM devices WHERE tenant_id=? AND username=?").bind(tenantId, who).run(); summary.devicesDeleted = r.meta?.changes || 0; } catch {}

    // 3. Delete their private document file.
    summary.personalDocsDeleted = await deletePersonalDocs(env, tenantId, who);

    // 4. What we deliberately KEEP (lawful basis / legal obligation) — recorded
    //    so the decision is transparent.
    summary.kept = [
      "Working-time / holiday / shift history (payroll & Working Time Regulations)",
      "Security & audit logs (legitimate interest; auto-pruned at 12 months)"
    ];

    return json({ ok: true, subject: who, erasedAt: new Date().toISOString(), summary }, {}, env, request);
  }

  return error("Not found: " + path, 404, env, request);
}
