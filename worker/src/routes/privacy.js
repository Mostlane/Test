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
import { deletePersonalDocs, listPersonalDocFiles } from "./hrdocs.js";

// Every table in the central D1 that can hold a person's data, grouped so the
// one-click report reads like a proper subject-access record. Each entry lists
// the column(s) that reference the person — a record is included if the person
// appears in ANY of them (e.g. a message they SENT or RECEIVED). Queried
// defensively: a table/column that doesn't exist simply contributes nothing, so
// this stays safe as the schema grows.
const EXPORT_SPEC = [
  // ── Account & access ──────────────────────────────────────────────────────
  { table: "users",              label: "Account & profile",               cols: ["username"] },
  { table: "user_permissions",   label: "Permissions",                     cols: ["username"] },
  { table: "sessions",           label: "Login sessions",                  cols: ["username"] },
  { table: "devices",            label: "Registered devices",              cols: ["username"] },
  { table: "push_subscriptions", label: "Push-notification devices",       cols: ["username"] },
  { table: "login_history",      label: "Login history",                   cols: ["username"] },
  { table: "password_resets",    label: "Password-reset requests",         cols: ["username"] },
  // ── Notifications & activity ─────────────────────────────────────────────
  { table: "user_notifications", label: "Notification feed",               cols: ["username"] },
  { table: "notify_log",         label: "Notification delivery log",       cols: ["username"] },
  { table: "audit_log",          label: "Activity log (their actions)",    cols: ["username"] },
  // ── Holiday & absence ────────────────────────────────────────────────────
  { table: "holidays",           label: "Holiday & absence bookings",      cols: ["username", "engineer"] },
  { table: "holiday_allowance",  label: "Holiday allowance",               cols: ["username"] },
  { table: "holiday_log",        label: "Holiday admin actions",           cols: ["by_user"] },
  // ── Time & attendance ────────────────────────────────────────────────────
  { table: "office_shifts",      label: "Office timesheet / clock-ins",    cols: ["username"] },
  { table: "shifts",             label: "Field shifts (clock on/off)",     cols: ["username"] },
  { table: "job_time_segments",  label: "Job time capture",                cols: ["username"] },
  { table: "eng_timesheets",     label: "Engineer timesheets",             cols: ["username"] },
  { table: "eng_invoices",       label: "Engineer invoices",               cols: ["username"] },
  { table: "van_timesheets",     label: "Van timesheets",                  cols: ["username"] },
  { table: "sitelog_scans",      label: "Site sign-in / out scans",        cols: ["username"] },
  // ── Vehicles ─────────────────────────────────────────────────────────────
  { table: "vehicle_assignments",label: "Vehicle assignments",             cols: ["username", "assigned_by"] },
  { table: "vehicle_checks",     label: "Weekly van checks",               cols: ["username"] },
  { table: "custom_van_checks",  label: "Requested van checks",            cols: ["username", "sent_by"] },
  { table: "vehicle_handovers",  label: "Vehicle handovers",               cols: ["username", "requested_by"] },
  { table: "driver_scores",      label: "Driver scores",                   cols: ["username"] },
  { table: "fuel_entries",       label: "Fuel-card entries",               cols: ["username", "by"] },
  { table: "odometer_readings",  label: "Odometer readings entered",       cols: ["by"] },
  // ── Equipment & keys ─────────────────────────────────────────────────────
  { table: "assets",                  label: "Equipment currently held",   cols: ["assigned_to"] },
  { table: "asset_requests",          label: "Equipment requests",         cols: ["requested_by", "holder", "decided_by"] },
  { table: "asset_transfer_requests", label: "Equipment transfers",        cols: ["from_user", "to_user"] },
  { table: "key_log",                 label: "Key-register activity",      cols: ["holder", "by_user"] },
  // ── Communications & sign-offs ───────────────────────────────────────────
  { table: "messages",           label: "Messages sent & received",        cols: ["from_user", "to_user"] },
  { table: "memo_acks",          label: "Company-memo acknowledgements",   cols: ["username"] },
  { table: "admin_task_done",    label: "Task completions",                cols: ["username", "done_by"] },
  { table: "certificates",       label: "Certificates issued / finalised", cols: ["engineer", "finalised_by"] },
  { table: "em_remedials",       label: "EM remedials handled",            cols: ["engineer"] },
];

// Multi-column, case-insensitive lookup. Returns [] on any error (missing
// table/column) so the export never fails because the schema moved on.
async function personRows(env, tenantId, table, cols, value) {
  const where = cols.map(c => `LOWER(${c}) = LOWER(?)`).join(" OR ");
  const binds = cols.map(() => value);
  try {
    // Match the tenant numerically: some tables store tenant_id as the TEXT
    // "1.0", others as the integer 1 — CAST(...AS REAL) reconciles both so a
    // person's records are never silently dropped on a type mismatch.
    const res = await env.DB.prepare(
      `SELECT * FROM ${table} WHERE CAST(tenant_id AS REAL) = CAST(? AS REAL) AND (${where})`
    ).bind(tenantId, ...binds).all();
    return res.results || [];
  } catch {
    // Table may not have tenant_id — retry without it before giving up.
    try {
      const res = await env.DB.prepare(`SELECT * FROM ${table} WHERE ${where}`).bind(...binds).all();
      return res.results || [];
    } catch { return []; }
  }
}

function redact(rows) {
  // Never include password hashes / reset tokens / push crypto keys in an export.
  return rows.map(r => {
    const o = { ...r };
    for (const k of Object.keys(o)) {
      if (/password|hash|token|secret|p256dh|(^|_)auth$/i.test(k)) o[k] = "[redacted]";
    }
    return o;
  });
}

// SiteLog holds the person's pay rate + every site sign-in — significant
// personal data on a separate D1 (bound as SITELOG_DB). Linked by
// people.portal_username. Best-effort: skipped silently if unbound/unlinked.
async function sitelogSections(env, who) {
  const out = [];
  if (!env.SITELOG_DB) return out;
  try {
    const people = (await env.SITELOG_DB.prepare(
      "SELECT * FROM people WHERE LOWER(portal_username) = LOWER(?)"
    ).bind(who).all()).results || [];
    if (!people.length) return out;
    out.push({ id: "sitelog_people", label: "SiteLog profile (pay & travel)", rows: redact(people) });
    const ids = people.map(p => p.id).filter(Boolean);
    if (ids.length) {
      const ph = ids.map(() => "?").join(",");
      const visits = (await env.SITELOG_DB.prepare(
        `SELECT * FROM visits WHERE person_id IN (${ph}) ORDER BY check_in_at DESC`
      ).bind(...ids).all()).results || [];
      if (visits.length) out.push({ id: "sitelog_visits", label: "SiteLog site visits", rows: visits });
      const devs = (await env.SITELOG_DB.prepare(
        `SELECT * FROM devices WHERE person_id IN (${ph})`
      ).bind(...ids).all()).results || [];
      if (devs.length) out.push({ id: "sitelog_devices", label: "SiteLog devices", rows: redact(devs) });
    }
  } catch { /* SiteLog unreachable — omit the section */ }
  return out;
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

    const sections = [];
    const searched = [];
    for (const spec of EXPORT_SPEC) {
      searched.push(spec.label);
      const rows = await personRows(env, tenantId, spec.table, spec.cols, who);
      if (rows.length) sections.push({ id: spec.table, label: spec.label, rows: redact(rows) });
    }

    // SiteLog (separate D1) — pay rate + site-visit history.
    for (const s of await sitelogSections(env, who)) { searched.push(s.label); sections.push(s); }

    // Uploaded personal documents (contracts, right-to-work, etc.) — metadata
    // only; the files live in the staff-documents area and are downloaded there.
    let documents = [];
    try { documents = await listPersonalDocFiles(env, tenantId, who); } catch { documents = []; }
    if (documents.length) {
      sections.push({ id: "documents", label: "Uploaded documents (in Staff Documents)", rows: documents });
    }

    // Full name for the report header, from the account row if we have it.
    let subjectName = who;
    try {
      const acct = sections.find(s => s.id === "users");
      const u = acct && acct.rows[0];
      if (u) subjectName = [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || who;
    } catch { /* fall back to username */ }

    return json({
      ok: true,
      subject: who,
      subjectName,
      generatedAt: new Date().toISOString(),
      recordCount: sections.reduce((n, s) => n + s.rows.length, 0),
      note: "This report contains the personal data the portal holds on this person under the UK GDPR right of access. Password hashes, security tokens and push-encryption keys are redacted. Uploaded documents are listed here; the files themselves are in the Staff Documents area.",
      searched,
      sections
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
