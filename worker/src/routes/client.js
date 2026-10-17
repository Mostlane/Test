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
import { clientUpdatesFor } from "./fbc.js";

const ORG_LABEL = { fbc: "Fareham Borough Council" };

// The urgency a client flags -> the internal SLA priority the office starts from
// (the office can always re-prioritise on the board).
const URGENCY_PRIORITY = { emergency: "Priority 1", urgent: "Priority 2", routine: "Priority 3" };
const URGENCY_LABEL = { emergency: "Emergency", urgent: "Urgent", routine: "Routine" };

// What the client sees for a LIVE job — plain progress, never our internal
// statuses or categories. Finished jobs never reach the client (current jobs only).
function clientStatus(status, scheduledAt) {
  const s = String(status || "").toLowerCase();
  if (/^(complete|closed jobs|closed|invoiced)$/.test(s)) return "Complete";
  if (s === "travelling") return "Engineer on the way";
  if (s === "in progress") return "In progress";
  if (s === "on hold") return "On hold";
  if (s === "quote" || s === "order") return "Being quoted";
  if (scheduledAt && Number.isFinite(Date.parse(scheduledAt))) {
    return "Booked " + new Date(scheduledAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" });
  }
  return "Logged";
}
// Finished = the built-in done states, Cancelled, AND the office's own "done"
// categories (e.g. "FBC Works Completed", "Compliance Complete").
async function finishedTest(env, tid) {
  const done = new Set(["complete", "closed jobs", "closed", "invoiced", "cancelled"]);
  try {
    const row = await tenantDB(env, tid).prepare("SELECT value FROM app_config WHERE tenant_id=? AND key='sla_categories'").bind(tid).first();
    for (const c of (row ? JSON.parse(row.value) : [])) if (c && c.done && c.name) done.add(String(c.name).trim().toLowerCase());
  } catch {}
  return status => done.has(String(status || "").trim().toLowerCase());
}
// The client-facing description: our engineers' text can carry office-only
// instructions (a "🚨 change status to…" line, the auto EM/PAT day plan) — strip
// those so the client reads only the work itself.
function clientDescription(d) {
  let t = String(d || "");
  t = t.replace(/[^\n]*EM\/PAT DAY PLAN \(auto\)[\s\S]*?— end of plan —\s*/g, "");
  t = t.split("\n").filter(l => !/🚨|please change status|internal only|office only/i.test(l)).join("\n");
  t = t.replace(/\*\*/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return t;
}

function clientOrgOf(sess) {
  try {
    const p = typeof sess.user.profile === "string" ? JSON.parse(sess.user.profile) : (sess.user.profile || {});
    return (p && p.staffType === "client" && p.clientOrg) ? String(p.clientOrg).toLowerCase() : "";
  } catch { return ""; }
}
// A client whose role is "compliance" may see ONLY the compliance chart (via the
// compliance endpoints), never the jobs portal — so the jobs routes below are
// refused for them even though they hold a valid client session.
// Raising jobs from the portal is OFF unless the account is switched on
// (profile.clientCanRaise) — the incident form is coming later.
function clientCanRaise(sess) {
  try {
    const p = typeof sess.user.profile === "string" ? JSON.parse(sess.user.profile) : (sess.user.profile || {});
    return !!(p && p.clientCanRaise);
  } catch { return false; }
}
function clientRoleOf(sess) {
  try {
    const p = typeof sess.user.profile === "string" ? JSON.parse(sess.user.profile) : (sess.user.profile || {});
    return (p && p.staffType === "client" && p.clientRole === "compliance") ? "compliance" : "jobs";
  } catch { return "jobs"; }
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
  // A compliance-only client may confirm its own identity (/client/me) but NEVER
  // touch the jobs portal — defence-in-depth behind the front-end routing.
  if (clientRoleOf(sess) === "compliance" && path !== "/client/me") {
    return error("This client login is compliance-only", 403, env, request);
  }
  const tid = sess.tenantId;
  const orgLabel = ORG_LABEL[org] || org.toUpperCase();
  const scheme = ORG_SCHEME[org] || "";

  // ── GET /client/me ──────────────────────────────────────────────────────────
  if (path === "/client/me" && method === "GET") {
    const sites = await orgSites(env, tid, org);
    return json({
      ok: true, org, orgLabel, scheme, role: clientRoleOf(sess), canRaise: clientCanRaise(sess),
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
    const finished = await finishedTest(env, tid);
    // CURRENT jobs only: a finished job drops off the client's list. (A "previous
    // jobs" view will come later — it would be a separate, opt-in list.)
    const mine = all.filter(j => j && !j.hiddenFromClient && !j.fallbackTemplate && !finished(j.status) &&
      (String(j.clientOrg || "").toLowerCase() === org || codes.has(String(j.siteCode || "").trim())));
    const jobs = mine.map(j => ({
      id: j.id,
      ref: j.helpdeskRef || j.id,
      site: j.siteName || nameByCode[String(j.siteCode || "").trim()] || j.siteCode || "",
      siteCode: j.siteCode || "",
      description: clientDescription(j.description).slice(0, 400),
      status: clientStatus(j.status, j.scheduledAt),
      urgency: j.clientUrgency ? (URGENCY_LABEL[j.clientUrgency] || j.clientUrgency) : "",
      byClient: !!j.raisedByClient,
      raisedAt: j.raisedAt || j.createdAt || "",
      scheduledAt: j.scheduledAt || "",
      updatedAt: j.updatedAt || "",
    }));
    // The office's "update for the client" notes — the latest one rides on the card.
    const ups = await clientUpdatesFor(env, tid, jobs.map(j => j.id));
    for (const j of jobs) {
      const u = (ups[j.id] || [])[0];
      j.latestUpdate = u ? { at: u.at, body: u.body.slice(0, 200), by: u.by } : null;
      j.updateCount = (ups[j.id] || []).length;
      if (u && (!j.updatedAt || u.at > j.updatedAt)) j.updatedAt = u.at;
    }
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
    // Current jobs only — a finished job is no longer the client's to open.
    if ((await finishedTest(env, tid))(j.status)) return error("Not found", 404, env, request);
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

    return json({
      ok: true,
      job: {
        id: j.id,
        ref: j.helpdeskRef || j.id,
        site: j.siteName || j.siteCode || "",
        siteCode: j.siteCode || "",
        postcode: j.postcode || "",
        description: clientDescription(j.description),
        status: clientStatus(j.status, j.scheduledAt),
        urgency: j.clientUrgency ? (URGENCY_LABEL[j.clientUrgency] || j.clientUrgency) : "",
        byClient: !!j.raisedByClient,
        raisedAt: j.raisedAt || j.createdAt || "",
        scheduledAt: j.scheduledAt || "",
        completedAt: "",
        completionNote: "",
        photos,
        updates: (await clientUpdatesFor(env, tid, [j.id]))[j.id] || [],
      },
    }, {}, env, request);
  }

  // ── POST /client/raise ─── the client raises a job ──────────────────────────
  if ((path === "/client/raise" || path === "/client/raise-photo") && !clientCanRaise(sess)) {
    return error("Raising jobs from the portal isn't switched on for this account.", 403, env, request);
  }
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
      ctx?.waitUntil(sendToPermission(env, tid, ["FullAccess"], {
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
