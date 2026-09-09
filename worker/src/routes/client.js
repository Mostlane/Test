// Client portal API — an EXTERNAL customer login (staffType "client"), tied to one
// client org (e.g. FBC). It is deliberately WALLED: a client session can only ever
// see its own org's sites + jobs, can raise a job, and (via the existing compliance
// endpoints, which now grant a client read+download on its own scheme) view the
// compliance chart. It NEVER sees money, other clients, staff pages or the field app.
//
//   GET  /client/me                 -> { org, orgLabel, scheme, name, sites:[{code,name,postcode}] }
//   GET  /client/jobs               -> job log at the org's sites (Pending|Complete), money-free
//   GET  /client/job?id=            -> one job: description, dates, photos, completion note (no money)
//   POST /client/raise              -> raise a job at one of the org's sites (urgency->priority),
//                                      lands on the SLA board as Pending, notifies the office,
//                                      emails the client a confirmation
//   POST /client/raise-photo        -> attach a photo (multipart file+jobId) to a client job
//
// The whole surface is org-scoped server-side; the front end is client-home.html.

import { json, error } from "../lib/http.js";
import { tenantDB } from "../lib/tenantdb.js";
import { signedFileUrl } from "../lib/filesign.js";
import { ORG_SCHEME } from "../lib/complianceaccess.js";
import { listJobs, createOrUpdateJobFromPayload, reconcileRelease } from "./sla.js";
import { sendToPermission } from "./push.js";
import { sendEmail, appBase } from "../lib/email.js";

const ORG_LABEL = { fbc: "Fareham Borough Council" };

// The urgency a client flags -> the internal SLA priority the office starts from
// (the office can always re-prioritise on the board).
const URGENCY_PRIORITY = { emergency: "Priority 1", urgent: "Priority 2", routine: "Priority 3" };
const URGENCY_LABEL = { emergency: "Emergency", urgent: "Urgent", routine: "Routine" };

// A client only ever sees two states: Pending (anything not finished) or Complete.
function clientStatus(status) {
  const s = String(status || "").toLowerCase();
  if (s === "complete" || s === "closed jobs" || s === "invoiced" || s === "closed") return "Complete";
  return "Pending";   // Scheduled / Travelling / In Progress / On Hold / Quote / Pending / …
}
function isFinishedInternal(status) {
  return /^(complete|closed jobs|closed|invoiced)$/i.test(String(status || ""));
}

function clientOrgOf(sess) {
  try {
    const p = typeof sess.user.profile === "string" ? JSON.parse(sess.user.profile) : (sess.user.profile || {});
    return (p && p.staffType === "client" && p.clientOrg) ? String(p.clientOrg).toLowerCase() : "";
  } catch { return ""; }
}

// The org's sites: [{code, name, postcode}] + a fast Set of the site codes.
async function orgSites(env, tid, org) {
  const db = tenantDB(env, tid);
  let rows = [];
  try {
    const r = await db.prepare("SELECT site_number, site_name, data FROM sites WHERE tenant_id=? AND lower(client)=?")
      .bind(tid, org).all();
    rows = r.results || [];
  } catch { rows = []; }
  const sites = rows.map(r => {
    let d = {}; try { d = r.data ? JSON.parse(r.data) : {}; } catch { d = {}; }
    return {
      code: String(r.site_number || d.siteNumber || "").trim(),
      name: String(r.site_name || d.siteName || r.site_number || "").trim(),
      postcode: String(d.postcode || "").trim(),
    };
  }).filter(s => s.code);
  sites.sort((a, b) => a.name.localeCompare(b.name) || a.code.localeCompare(b.code));
  return sites;
}

export async function handle(request, env, ctx, url, sess) {
  const path = url.pathname;
  const method = request.method;
  const q = url.searchParams;
  if (!sess) return error("Not authenticated", 401, env, request);

  const org = clientOrgOf(sess);
  // Hard wall: only a client login with a recognised org may use ANY /client route.
  if (!org) return error("Not a client account", 403, env, request);
  const tid = sess.tenantId;
  const orgLabel = ORG_LABEL[org] || org.toUpperCase();
  const scheme = ORG_SCHEME[org] || "";

  // ── GET /client/me ──────────────────────────────────────────────────────────
  if (path === "/client/me" && method === "GET") {
    const sites = await orgSites(env, tid, org);
    return json({
      ok: true, org, orgLabel, scheme,
      name: [sess.user.first_name, sess.user.last_name].filter(Boolean).join(" ") || sess.user.username,
      sites,
    }, {}, env, request);
  }

  // ── GET /client/jobs ─── the job log (all jobs at the org's sites) ───────────
  if (path === "/client/jobs" && method === "GET") {
    const sites = await orgSites(env, tid, org);
    const codes = new Set(sites.map(s => s.code));
    const nameByCode = {}; sites.forEach(s => { nameByCode[s.code] = s.name; });
    const all = await listJobs(env, tid);
    const mine = all.filter(j => j && !j.hiddenFromClient && !j.fallbackTemplate &&
      (String(j.clientOrg || "").toLowerCase() === org || codes.has(String(j.siteCode || "").trim())));
    const jobs = mine.map(j => ({
      id: j.id,
      ref: j.helpdeskRef || j.id,
      site: j.siteName || nameByCode[String(j.siteCode || "").trim()] || j.siteCode || "",
      siteCode: j.siteCode || "",
      description: String(j.description || "").slice(0, 400),
      status: clientStatus(j.status),
      urgency: j.clientUrgency ? (URGENCY_LABEL[j.clientUrgency] || j.clientUrgency) : "",
      byClient: !!j.raisedByClient,
      raisedAt: j.raisedAt || j.createdAt || "",
      scheduledAt: j.scheduledAt || "",
      updatedAt: j.updatedAt || "",
    }));
    // Newest activity first.
    jobs.sort((a, b) => (Date.parse(b.updatedAt || b.raisedAt || 0) || 0) - (Date.parse(a.updatedAt || a.raisedAt || 0) || 0));
    return json({ ok: true, jobs }, {}, env, request);
  }

  // ── GET /client/job?id= ─── one job (photos + completion note, NO money) ─────
  if (path === "/client/job" && method === "GET") {
    const id = String(q.get("id") || "").trim();
    if (!id) return error("id required", 400, env, request);
    const sites = await orgSites(env, tid, org);
    const codes = new Set(sites.map(s => s.code));
    const all = await listJobs(env, tid);
    const j = all.find(x => x && x.id === id);
    if (!j || j.hiddenFromClient) return error("Not found", 404, env, request);
    // Must belong to this org (by tag or by site) — never let a client read another
    // client's job by guessing an id.
    const ownsIt = String(j.clientOrg || "").toLowerCase() === org || codes.has(String(j.siteCode || "").trim());
    if (!ownsIt) return error("Not found", 404, env, request);

    // Photos — signed thumb URLs through the public /sla/site/thumb route.
    let photos = [];
    try {
      const listed = await env.JOB_FILES.list({ prefix: `jobs/${id}/photos/` });
      const objs = (listed.objects || []).filter(o => !o.key.endsWith(".thumb"));
      photos = await Promise.all(objs.map(async o => ({
        url: await signedFileUrl(env, url.origin, "/sla/site/thumb", o.key, 86400),
      })));
    } catch { photos = []; }

    // Completion note = the most recent note event; completion date = closedAt/complete.
    let completionNote = "";
    const notes = (j.events || []).filter(e => e && (e.type === "note" || (e.note && String(e.note).trim())));
    if (notes.length) completionNote = String(notes[notes.length - 1].note || "").trim();

    return json({
      ok: true,
      job: {
        id: j.id,
        ref: j.helpdeskRef || j.id,
        site: j.siteName || j.siteCode || "",
        siteCode: j.siteCode || "",
        postcode: j.postcode || "",
        description: String(j.description || ""),
        status: clientStatus(j.status),
        urgency: j.clientUrgency ? (URGENCY_LABEL[j.clientUrgency] || j.clientUrgency) : "",
        byClient: !!j.raisedByClient,
        raisedAt: j.raisedAt || j.createdAt || "",
        scheduledAt: j.scheduledAt || "",
        completedAt: isFinishedInternal(j.status) ? (j.closedAt || j.updatedAt || "") : "",
        completionNote: isFinishedInternal(j.status) ? completionNote : "",
        photos,
      },
    }, {}, env, request);
  }

  // ── POST /client/raise ─── the client raises a job ──────────────────────────
  if (path === "/client/raise" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const siteCode = String(b.siteCode || "").trim();
    const description = String(b.description || "").trim();
    const urgency = String(b.urgency || "routine").toLowerCase();
    if (!siteCode) return error("Pick a site.", 400, env, request);
    if (description.length < 5) return error("Please describe the problem.", 400, env, request);
    const sites = await orgSites(env, tid, org);
    const site = sites.find(s => s.code === siteCode);
    if (!site) return error("That site isn't one of yours.", 403, env, request);
    const priority = URGENCY_PRIORITY[urgency] || "Priority 3";

    const raiser = [sess.user.first_name, sess.user.last_name].filter(Boolean).join(" ") || sess.user.username;
    const job = await createOrUpdateJobFromPayload(env, tid, {
      siteCode,
      siteName: site.name,
      postcode: site.postcode || undefined,
      storeType: org,
      description: description + "\n\n— Raised by " + raiser + " (" + orgLabel + ") via the client portal.",
      status: "Pending",
      priority,
      originator: "client",
      clientOrg: org,
      raisedByClient: true,
      clientUrgency: (urgency === "emergency" || urgency === "urgent") ? urgency : "routine",
      changedBy: raiser,
    });

    // Notify the office (actionable) + fire any release logic (none — it's now).
    try { ctx?.waitUntil(reconcileRelease(env, tid, job).catch(() => {})); } catch {}
    try {
      ctx?.waitUntil(sendToPermission(env, tid, ["FullAccess", "SLAAdmin"], {
        title: "New client job — " + orgLabel,
        body: (URGENCY_LABEL[urgency] || "Routine") + ": " + site.name + " — " + description.slice(0, 80),
        url: "/job-view.html?jobId=" + encodeURIComponent(job.id),
        tag: "client-job:" + job.id, actionable: true,
      }, null, true));
    } catch {}

    // Email the client a confirmation (raise only — nothing on completion).
    try {
      const to = sess.user.email;
      if (to) {
        const base = appBase(env);
        const html = `<div style="font-family:Segoe UI,Arial,sans-serif;color:#1f2937;max-width:520px">
          <h2 style="color:#003366;margin:0 0 6px">Job request received</h2>
          <p>Thanks ${escapeHtml(raiser)} — we've received your request and the office has been notified.</p>
          <table style="border-collapse:collapse;font-size:14px;margin:10px 0">
            <tr><td style="color:#667085;padding:2px 10px 2px 0">Site</td><td><b>${escapeHtml(site.name)}</b></td></tr>
            <tr><td style="color:#667085;padding:2px 10px 2px 0">Urgency</td><td>${escapeHtml(URGENCY_LABEL[urgency] || "Routine")}</td></tr>
            <tr><td style="color:#667085;padding:2px 10px 2px 0;vertical-align:top">Details</td><td>${escapeHtml(description).replace(/\n/g, "<br>")}</td></tr>
            <tr><td style="color:#667085;padding:2px 10px 2px 0">Reference</td><td>${escapeHtml(job.helpdeskRef || job.id)}</td></tr>
          </table>
          <p>You can track it any time in your portal.${base ? ' <a href="' + base + '/client-home.html">Open the portal</a>' : ""}</p>
          <p style="color:#8a97a6;font-size:12px">Mostlane Construction</p>
        </div>`;
        ctx?.waitUntil(sendEmail(env, { to, subject: "Job request received — " + site.name, html }).catch(() => {}));
      }
    } catch {}

    return json({ ok: true, id: job.id, ref: job.helpdeskRef || job.id }, {}, env, request);
  }

  // ── POST /client/raise-photo ─── attach a photo to one of the client's jobs ──
  if (path === "/client/raise-photo" && method === "POST") {
    let form;
    try { form = await request.formData(); }
    catch { return error("Upload was incomplete — please retry.", 400, env, request); }
    const jobId = String(form.get("jobId") || q.get("jobId") || "").trim();
    const file = form.get("file");
    if (!jobId || !file) return error("Missing file or jobId", 400, env, request);
    // Verify the job is this org's before storing anything.
    const sites = await orgSites(env, tid, org);
    const codes = new Set(sites.map(s => s.code));
    const all = await listJobs(env, tid);
    const j = all.find(x => x && x.id === jobId);
    if (!j) return error("Not found", 404, env, request);
    if (!(String(j.clientOrg || "").toLowerCase() === org || codes.has(String(j.siteCode || "").trim())))
      return error("Not your job", 403, env, request);
    const safe = String(file.name || "photo.jpg").replace(/[^A-Za-z0-9._-]/g, "_").slice(-60);
    const key = `jobs/${jobId}/photos/client-${Date.now()}-${safe}`;
    try {
      await env.JOB_FILES.put(key, file.stream(), {
        httpMetadata: { contentType: file.type || "image/jpeg" },
        customMetadata: { stage: "Before" },
      });
      const thumb = form.get("thumb");
      if (thumb && typeof thumb.stream === "function") {
        try { await env.JOB_FILES.put(key + ".thumb", thumb.stream(), { httpMetadata: { contentType: thumb.type || "image/jpeg" } }); } catch {}
      }
    } catch { return error("Couldn't store the photo", 500, env, request); }
    return json({ ok: true, key }, { status: 201 }, env, request);
  }

  return error("Not found: " + path, 404, env, request);
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
