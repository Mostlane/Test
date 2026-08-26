// Customer communications — status-email config + the public "reschedule" flow.
//
//   Admin (FullAccess|SLAAdmin):
//     GET  /comms/status-emails            -> { cfg, defs }
//     POST /comms/status-emails            -> save cfg
//     POST /comms/status-emails/preview    -> { subject, html }  (live preview)
//     GET  /comms/reschedule-requests      -> { requests: [...] }
//     POST /comms/reschedule-requests/resolve { id }
//   Public (token-verified in-handler; listed in index.js PUBLIC_ROUTES):
//     POST /customer/job         { jobId, exp, sig } -> safe job summary
//     POST /customer/reschedule  { jobId, exp, sig, note, suggestions[] }

import { json, error } from "../lib/http.js";
import { requireSession, permissionsFor } from "../lib/auth.js";
import { resolveTenantId, tenantDB } from "../lib/tenantdb.js";
import { sendToPermission } from "./push.js";
import {
  getStatusEmailConfig, saveStatusEmailConfig, STATUS_DEFS, defaultConfig,
  renderStatusEmail, reschedURL, verifyResched, ensureReschedTable,
} from "../lib/statusemail.js";

async function jobById(env, tid, id) {
  try {
    const row = await tenantDB(env, tid).prepare("SELECT data FROM sla_jobs WHERE tenant_id=? AND id=?").bind(tid, id).first();
    return row && row.data ? JSON.parse(row.data) : null;
  } catch { return null; }
}

async function requireCommsAdmin(env, request) {
  const sess = await requireSession(env, request);
  if (!sess) return { err: error("Not authenticated", 401, env, request) };
  const perms = await permissionsFor(env, sess.tenantId, sess.user.username);
  if (perms.FullAccess !== "Yes" && perms.SLAAdmin !== "Yes")
    return { err: error("Forbidden", 403, env, request) };
  return { sess };
}

export async function handle(request, env, ctx, url, sess) {
  const path = url.pathname;
  const method = request.method.toUpperCase();
  const tid = sess ? sess.tenantId : await resolveTenantId(env, request);

  // ── Admin: config ────────────────────────────────────────────────────────
  if (path === "/comms/status-emails" && method === "GET") {
    const g = await requireCommsAdmin(env, request); if (g.err) return g.err;
    return json({ ok: true, cfg: await getStatusEmailConfig(env, tid), defs: STATUS_DEFS }, {}, env, request);
  }
  if (path === "/comms/status-emails" && method === "POST") {
    const g = await requireCommsAdmin(env, request); if (g.err) return g.err;
    const b = await request.json().catch(() => ({}));
    const saved = await saveStatusEmailConfig(env, tid, b || {});
    return json({ ok: true, cfg: saved }, {}, env, request);
  }
  if (path === "/comms/status-emails/preview" && method === "POST") {
    const g = await requireCommsAdmin(env, request); if (g.err) return g.err;
    const b = await request.json().catch(() => ({}));
    const cfg = await getStatusEmailConfig(env, tid);
    const statusKey = b.status || "Scheduled";
    const tpl = { ...(cfg.statuses[statusKey] || defaultConfig().statuses.Scheduled), companyTel: cfg.companyTel };
    const statusDef = STATUS_DEFS.find(s => s.key === statusKey) || { key: statusKey };
    // Preview against a real job if given, else a representative sample.
    const job = (b.jobId && await jobById(env, tid, b.jobId)) || {
      id: "PREVIEW", helpdeskRef: "0331 Camberley, Frimley Road", siteName: "Camberley, Frimley Road",
      address: "19 Frimley Road, Camberley", postcode: "GU15 3EN", status: statusKey,
      scheduledAt: new Date(Date.now() + 2 * 86400000).toISOString(), description: "Sample job",
    };
    let rescheduleUrl = "";
    if (tpl.reschedule && statusDef.reschedule) rescheduleUrl = await reschedURL(env, job.id === "PREVIEW" ? "PREVIEW" : job.id);
    const out = renderStatusEmail({ env, job, tpl, statusDef, rescheduleUrl });
    return json({ ok: true, subject: out.subject, html: out.html }, {}, env, request);
  }

  // ── Admin: reschedule request inbox ──────────────────────────────────────
  if (path === "/comms/reschedule-requests" && method === "GET") {
    const g = await requireCommsAdmin(env, request); if (g.err) return g.err;
    await ensureReschedTable(env);
    const status = url.searchParams.get("status") || "open";
    const db = tenantDB(env, tid);
    const q = status === "all"
      ? db.prepare("SELECT * FROM job_reschedule_requests WHERE tenant_id=? ORDER BY created_at DESC LIMIT 200").bind(tid)
      : db.prepare("SELECT * FROM job_reschedule_requests WHERE tenant_id=? AND status=? ORDER BY created_at DESC LIMIT 200").bind(tid, status);
    const { results } = await q.all();
    const requests = (results || []).map(r => ({ ...r, suggestions: safeArr(r.suggestions) }));
    return json({ ok: true, requests }, {}, env, request);
  }
  if (path === "/comms/reschedule-requests/resolve" && method === "POST") {
    const g = await requireCommsAdmin(env, request); if (g.err) return g.err;
    await ensureReschedTable(env);
    const b = await request.json().catch(() => ({}));
    if (!b.id) return error("id required", 400, env, request);
    await tenantDB(env, tid).prepare(
      "UPDATE job_reschedule_requests SET status='resolved', resolved_at=?, resolved_by=? WHERE tenant_id=? AND id=?"
    ).bind(new Date().toISOString(), g.sess.user.username, tid, b.id).run();
    return json({ ok: true }, {}, env, request);
  }

  // ── Public: customer job summary (token-verified) ────────────────────────
  if (path === "/customer/job" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const { jobId, exp, sig } = b;
    if (!jobId || !(await verifyResched(env, jobId, exp, sig)))
      return error("This link has expired or is invalid.", 403, env, request);
    const job = await jobById(env, tid, jobId);
    if (!job) return error("Job not found.", 404, env, request);
    const cfg = await getStatusEmailConfig(env, tid);
    return json({
      ok: true,
      job: {
        reference: job.helpdeskRef || job.reference || "",
        siteName: job.siteName || "",
        address: [job.address, job.postcode].filter(Boolean).join(", "),
        scheduledAt: job.scheduledAt || "",
        status: job.status || "",
      },
      company: { name: "Mostlane", tel: cfg.companyTel || "", replyTo: cfg.replyTo || "" },
    }, {}, env, request);
  }

  // ── Public: customer submits a reschedule request ────────────────────────
  if (path === "/customer/reschedule" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const { jobId, exp, sig } = b;
    if (!jobId || !(await verifyResched(env, jobId, exp, sig)))
      return error("This link has expired or is invalid.", 403, env, request);
    const job = await jobById(env, tid, jobId);
    if (!job) return error("Job not found.", 404, env, request);
    await ensureReschedTable(env);
    const note = String(b.note || "").slice(0, 2000);
    const suggestions = Array.isArray(b.suggestions) ? b.suggestions.slice(0, 6).map(s => String(s).slice(0, 120)) : [];
    if (!note && !suggestions.length) return error("Please add a note or a suggested time.", 400, env, request);
    const id = crypto.randomUUID();
    const ip = request.headers.get("CF-Connecting-IP") || "";
    const ref = job.helpdeskRef || job.reference || jobId;
    const siteName = job.siteName || "";
    await tenantDB(env, tid).prepare(
      `INSERT INTO job_reschedule_requests (id,tenant_id,job_id,job_ref,site_name,note,suggestions,created_at,status,ip)
       VALUES (?,?,?,?,?,?,?,?, 'open', ?)`
    ).bind(id, tid, jobId, ref, siteName, note, JSON.stringify(suggestions), new Date().toISOString(), ip).run();
    // Notify the office (push + notification feed), actionable until resolved.
    ctx?.waitUntil(sendToPermission(env, tid, ["FullAccess", "SLAAdmin"], {
      title: "Customer wants to rearrange",
      body: `${siteName || ref}: ${note ? note.slice(0, 80) : "suggested new times"}`,
      url: `/job-view.html?jobId=${encodeURIComponent(jobId)}`,
      tag: `resched:${id}`,
      actionable: true,
    }).catch(() => {}));
    return json({ ok: true }, {}, env, request);
  }

  return error("Not found: " + path, 404, env, request);
}

function safeArr(s) { try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch { return []; } }
