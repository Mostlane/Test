// SLA / job scheduler — full port of the `mostlane-sla` Worker.
//
// CHANGES vs the original standalone Worker:
//   • Jobs: SLA_JOBS KV  -> D1 table `sla_jobs` (indexed cols + full JSON in `data`)
//   • Config: SLA_CONFIG KV -> D1 table `app_config` (key 'sla_config')
//   • Files: photos/signatures stay in the R2 bucket `JOB_FILES` (unchanged)
//   • Routes are namespaced under /sla/* to avoid colliding with other modules
//     in the single Worker, e.g.  /jobs -> /sla/jobs,  /config -> /sla/config.
//
// All business logic (status normalisation, SLA target/breach calc, export
// HTML, PDFShift, signatures) is preserved exactly.
//
// Required bindings (wrangler.toml): DB (d1), JOB_FILES (r2)
// Required secrets: PDFSHIFT_API_KEY
// Optional vars: MOSTLANE_LOGO_BASE64, R2_PUBLIC_BASE

import { corsHeaders } from "../lib/http.js";
import { tenantDB, resolveTenantId } from "../lib/tenantdb.js";
import { signedFileUrl, verifyFileSig } from "../lib/filesign.js";
import { sendToUser } from "./push.js";

export async function handle(request, env, ctx, url, sess) {
  const headers = corsHeaders(env, request);
  const method = request.method.toUpperCase();
  // Tenant is taken from the verified session, or — for the PUBLIC export
  // route, which may have no session — from the request host (Tenant 1 today).
  const tenantId = sess ? sess.tenantId : await resolveTenantId(env, request);
  const db = tenantDB(env, tenantId);
  // Strip the /sla mount prefix so the routing below mirrors the original Worker.
  const subpath = url.pathname.replace(/^\/sla(?=\/|$)/, "") || "/";
  const searchParams = url.searchParams;

  /* GET/POST /sla/config */
  if (subpath === "/config") {
    if (method === "GET")  return jsonResponse(await getConfig(env, tenantId), headers);
    if (method === "POST") return jsonResponse(await setConfig(env, tenantId, await readJson(request)), headers);
  }

  /* POST /sla/inbound — machine-to-machine job intake (the Zapier email
     parser). PUBLIC route (no portal session): guarded by the JOBS_INBOUND_TOKEN
     secret sent as "Authorization: Bearer <token>". Same create/update logic as
     the office's add-job (upserts by reference — a re-sent email updates rather
     than duplicates), with zap-friendly slack on priority/date formats. */
  if (subpath === "/inbound" && method === "POST") {
    const secret = env.JOBS_INBOUND_TOKEN || "";
    if (!secret) return jsonResponse({ ok: false, error: "Inbound jobs aren't configured (JOBS_INBOUND_TOKEN missing)" }, headers, 503);
    const tok = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    let diff = tok.length === secret.length ? 0 : 1;
    for (let i = 0; i < Math.min(tok.length, secret.length); i++) diff |= tok.charCodeAt(i) ^ secret.charCodeAt(i);
    if (diff !== 0) return jsonResponse({ ok: false, error: "Bad token" }, headers, 401);

    const b = await readJson(request);
    if (!b || (!String(b.reference || "").trim() && !String(b.description || "").trim()))
      return jsonResponse({ ok: false, error: "reference or description required" }, headers, 400);

    // Forgiving inputs: "P1" / "1" / "priority 2" → "Priority N"; only pass a
    // raisedAt the Date parser actually accepts (else it defaults to now).
    const pm = /^p(?:riority)?\s*[.:-]?\s*([1-4])$/i.exec(String(b.priority || "").trim());
    const priority = pm ? `Priority ${pm[1]}` : (PRIORITY_SET.has(b.priority) ? b.priority : undefined);
    const raisedAt = b.raisedAt && Number.isFinite(Date.parse(b.raisedAt)) ? new Date(b.raisedAt).toISOString() : undefined;

    const payload = {
      reference: String(b.reference || "").trim() || undefined,
      description: String(b.description || "").trim() || undefined,
      priority, raisedAt,
      status: b.status || undefined,
      siteCode: b.siteCode != null ? String(b.siteCode).trim() : undefined,
      siteName: b.siteName || undefined,
      address: b.address || undefined,
      postcode: b.postcode || undefined,
      telephone: b.telephone || undefined,
      storeType: b.storeType || undefined,
      originator: b.originator || "zapier",
      originatorEmail: b.originatorEmail || undefined,
      assignedTo: b.assignedTo || undefined,
      assignedEngineers: Array.isArray(b.assignedEngineers) ? b.assignedEngineers.filter(Boolean) : undefined,
      scheduledAt: b.scheduledAt && Number.isFinite(Date.parse(b.scheduledAt)) ? new Date(b.scheduledAt).toISOString() : undefined,
      durationMinutes: b.durationMinutes || undefined,
      changedBy: "zapier"
    };
    const beforeId = payload.reference;
    const before = beforeId ? await getJob(env, tenantId, beforeId) : null;
    const job = await createOrUpdateJobFromPayload(env, tenantId, payload);
    ctx?.waitUntil(notifyNewlyAssigned(env, tenantId, before, job));
    return jsonResponse({ ok: true, created: !before, id: job.id, reference: job.helpdeskRef, status: job.status, priority: job.priority, targetAt: job.targetAt }, headers, before ? 200 : 201);
  }

  /* POST /sla/jobs */
  if (subpath === "/jobs" && method === "POST") {
    const payload = await readJson(request);
    const beforeId = payload.id || payload.reference;
    const before = beforeId ? await getJob(env, tenantId, beforeId) : null;
    const job = await createOrUpdateJobFromPayload(env, tenantId, payload);
    ctx?.waitUntil(notifyNewlyAssigned(env, tenantId, before, job));
    return jsonResponse(decorateJobWithLiveSla(job), headers, 201);
  }

  /* GET /sla/jobs (with filters) */
  if (subpath === "/jobs" && method === "GET") {
    let jobs = (await listJobs(env, tenantId)).map(decorateJobWithLiveSla);
    const statusFilter = searchParams.get("status");
    const priorityFilter = searchParams.get("priority");
    const overdueFilter = searchParams.get("overdue");
    const siteCodeFilter = searchParams.get("siteCode");
    if (statusFilter) {
      const s = normalizeStatus(statusFilter).toLowerCase();
      jobs = jobs.filter(j => j.status.toLowerCase() === s);
    }
    if (priorityFilter) jobs = jobs.filter(j => j.priority === priorityFilter);
    if (siteCodeFilter) jobs = jobs.filter(j => (j.siteCode || "") === siteCodeFilter);
    if (overdueFilter === "true") jobs = jobs.filter(j => j.sla?.state === "BREACHED");
    return jsonResponse(jobs, headers);
  }

  /* GET /sla/jobs/for-engineer (must precede /jobs/{id}) */
  if (subpath === "/jobs/for-engineer" && method === "GET") {
    // Match if the engineer is ANY of the job's assigned engineers. Both sides
    // are normalised the same way so "John Thorn" matches "john.thorn".
    const engineer = normId(searchParams.get("engineer"));
    const date = searchParams.get("date");
    let jobs = (await listJobs(env, tenantId)).filter(j => assignedList(j).some(a => normId(a) === engineer));
    if (date) {
      jobs = jobs.filter(j => {
        if (!j.scheduledAt) return false;
        return new Date(j.scheduledAt).toISOString().slice(0, 10) === date;
      });
    }
    return jsonResponse(jobs.map(decorateJobWithLiveSla), headers);
  }

  /* ===== Story Mode: daily shift (clock on / off) ===== */
  if (subpath === "/shift/today" && method === "GET") {
    const engineer = searchParams.get("engineer") || "";
    const date = searchParams.get("date") || todayStr();
    return jsonResponse({ shift: await getShift(env, tenantId, engineer, date) }, headers);
  }
  if (subpath === "/shift/clock-on" && method === "POST") {
    const b = await readJson(request);
    if (!b.engineer) return jsonResponse({ error: "engineer required" }, headers, 400);
    const date = b.date || todayStr();
    await db.prepare(`
      INSERT INTO shifts (tenant_id, username, date, clock_on_at, clock_on_gps, start_mileage)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(username, date) DO UPDATE SET
        clock_on_at   = COALESCE(shifts.clock_on_at, excluded.clock_on_at),
        clock_on_gps  = COALESCE(shifts.clock_on_gps, excluded.clock_on_gps),
        start_mileage = COALESCE(shifts.start_mileage, excluded.start_mileage)
    `).bind(db.tenantId, b.engineer, date, new Date().toISOString(), b.gps || null, b.startMileage ?? null).run();
    return jsonResponse({ ok: true, shift: await getShift(env, tenantId, b.engineer, date) }, headers, 201);
  }
  if (subpath === "/shift/clock-off" && method === "POST") {
    const b = await readJson(request);
    if (!b.engineer) return jsonResponse({ error: "engineer required" }, headers, 400);
    const date = b.date || todayStr();
    await db.prepare(
      "UPDATE shifts SET clock_off_at=?, clock_off_gps=?, end_mileage=?, fuel=? WHERE tenant_id=? AND username=? AND date=?"
    ).bind(new Date().toISOString(), b.gps || null, b.endMileage ?? null, b.fuel || null, db.tenantId, b.engineer, date).run();
    return jsonResponse({ ok: true, shift: await getShift(env, tenantId, b.engineer, date) }, headers);
  }
  /* GET /sla/shifts  -> list recorded day sessions (office view), filterable */
  if (subpath === "/shifts" && method === "GET") {
    const engineer = searchParams.get("engineer");
    const from = searchParams.get("from");
    const to = searchParams.get("to");
    const conds = ["tenant_id = ?"], binds = [db.tenantId];
    if (engineer) { conds.push("username = ?"); binds.push(engineer); }
    if (from)     { conds.push("date >= ?");    binds.push(from); }
    if (to)       { conds.push("date <= ?");    binds.push(to); }
    let q = "SELECT * FROM shifts";
    q += " WHERE " + conds.join(" AND ");
    q += " ORDER BY date DESC, username ASC LIMIT 500";
    const { results } = await db.prepare(q).bind(...binds).all();
    return jsonResponse({ shifts: results || [] }, headers);
  }

  /* ===== Story Mode: weekly vehicle check ===== */
  if (subpath === "/vehicle-check" && method === "GET") {
    const engineer = searchParams.get("engineer") || "";
    const week = searchParams.get("week") || "";
    const row = (engineer && week)
      ? await db.prepare("SELECT * FROM vehicle_checks WHERE tenant_id=? AND username=? AND week=?").bind(db.tenantId, engineer, week).first()
      : null;
    return jsonResponse({ check: row || null }, headers);
  }
  if (subpath === "/vehicle-check" && method === "POST") {
    const b = await readJson(request);
    if (!b.engineer || !b.week) return jsonResponse({ error: "engineer and week required" }, headers, 400);
    await db.prepare(`
      INSERT INTO vehicle_checks (tenant_id, username, week, vehicle, checked_at, safe_to_drive, items, note)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(username, week) DO UPDATE SET
        vehicle=excluded.vehicle, checked_at=excluded.checked_at,
        safe_to_drive=excluded.safe_to_drive, items=excluded.items, note=excluded.note
    `).bind(db.tenantId, b.engineer, b.week, b.vehicle || null, new Date().toISOString(),
            b.safeToDrive ? 1 : 0, JSON.stringify(b.items || {}), b.note || null).run();
    return jsonResponse({ ok: true }, headers, 201);
  }

  /* PUT /sla/job/{id} (scheduler drag/drop) */
  if (subpath.startsWith("/job/") && method === "PUT") {
    const id = subpath.split("/").filter(Boolean)[1];
    if (!id) return jsonResponse({ error: "Missing ID" }, headers, 400);
    const body = await readJson(request);
    const patch = {
      scheduledAt: body.scheduledStart || body.scheduledAt,
      scheduledEnd: body.scheduledEnd,
      durationMinutes: body.durationMinutes,
      assignedEngineers: Array.isArray(body.assignedEngineers)
        ? body.assignedEngineers.filter(Boolean)
        : (body.assignedTo !== undefined ? (body.assignedTo ? [body.assignedTo] : []) : undefined),
      changedBy: body.changedBy || "scheduler"
    };
    const before = await getJob(env, tenantId, id);
    const updated = await patchJob(env, tenantId, id, patch);
    if (updated) ctx?.waitUntil(notifyNewlyAssigned(env, tenantId, before, updated));
    return updated
      ? jsonResponse(decorateJobWithLiveSla(updated), headers)
      : jsonResponse({ error: "Not found" }, headers, 404);
  }

  /* /sla/jobs/{id}/... */
  if (subpath.startsWith("/jobs/")) {
    const parts = subpath.split("/").filter(Boolean); // [jobs, id, sub]
    const id = parts[1];
    if (!id) return jsonResponse({ error: "Missing ID" }, headers, 400);

    // GET /sla/jobs/{id}/export  -> downloadable HTML
    if (method === "GET" && parts[2] === "export") {
      const job = await getJob(env, tenantId, id);
      if (!job) return jsonResponse({ error: "Not found" }, headers, 404);
      const decorated = decorateJobWithLiveSla(job);
      const files = await getJobFilesPublicList(env, id);
      const html = buildJobExportHtml(decorated, files, resolveLogo(env));
      const filename = `Job-${safeRef(decorated, id)}.html`;
      return new Response(html, { status: 200, headers: {
        ...headers, "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "no-store"
      }});
    }

    // GET /sla/jobs/{id}/export.pdf  -> downloadable PDF
    if (method === "GET" && parts[2] === "export.pdf") {
      const job = await getJob(env, tenantId, id);
      if (!job) return jsonResponse({ error: "Not found" }, headers, 404);
      const decorated = decorateJobWithLiveSla(job);
      const files = await getJobFilesPublicList(env, id);
      const html = buildJobExportHtml(decorated, files, resolveLogo(env));
      const filename = `Job-${safeRef(decorated, id)}.pdf`;
      if (!env.PDFSHIFT_API_KEY) return jsonResponse({ error: "Missing PDFSHIFT_API_KEY" }, headers, 500);
      const pdf = await htmlToPdf(env, html);
      if (!pdf.ok) return jsonResponse({ error: "PDF generation failed" }, headers, 500);
      return new Response(pdf.buffer, { status: 200, headers: {
        ...headers, "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "no-store"
      }});
    }

    // POST /sla/jobs/{id}/files?filename=  -> upload photo to R2
    if (parts[2] === "files" && method === "POST") {
      const filename = searchParams.get("filename");
      const form = await request.formData();
      const file = form.get("file");
      if (!filename || !file) return jsonResponse({ error: "Missing file" }, headers, 400);
      const key = `jobs/${id}/photos/${filename}`;
      await env.JOB_FILES.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
      return jsonResponse({ ok: true, publicURL: r2Url(env, key) }, headers, 201);
    }

    // GET /sla/jobs/{id}/files  -> list photos
    if (parts[2] === "files" && method === "GET") {
      const listed = await env.JOB_FILES.list({ prefix: `jobs/${id}/photos/` });
      return jsonResponse({ files: listed.objects.map(o => ({
        name: o.key.split("/").pop(), publicURL: r2Url(env, o.key)
      })) }, headers);
    }

    // POST /sla/jobs/{id}/signature  -> save signature PNG to R2 + attach to job
    if (parts[2] === "signature" && method === "POST") {
      const { signedBy, signedAt, signatureBase64 } = await readJson(request);
      if (!signedBy || !signatureBase64) return jsonResponse({ error: "Missing signature data" }, headers, 400);
      const base64 = signatureBase64.split(",")[1];
      const binary = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      const key = `jobs/${id}/signature/${Date.now()}.png`;
      await env.JOB_FILES.put(key, binary, { httpMetadata: { contentType: "image/png" } });
      const job = await getJob(env, tenantId, id);
      if (job) {
        job.signature = { signedBy, signedAt, fileKey: key };
        job.updatedAt = new Date().toISOString();
        await saveJob(env, tenantId, job);
      }
      return jsonResponse({ ok: true, key, publicURL: r2Url(env, key) }, headers, 201);
    }

    // GET /sla/jobs/{id}
    if (method === "GET") {
      const job = await getJob(env, tenantId, id);
      return job ? jsonResponse(decorateJobWithLiveSla(job), headers)
                 : jsonResponse({ error: "Not found" }, headers, 404);
    }

    // PATCH /sla/jobs/{id}  (the scheduler's assign / drag-drop path)
    if (method === "PATCH") {
      const before = await getJob(env, tenantId, id);
      const updated = await patchJob(env, tenantId, id, await readJson(request));
      if (updated) ctx?.waitUntil(notifyNewlyAssigned(env, tenantId, before, updated));
      return updated ? jsonResponse(decorateJobWithLiveSla(updated), headers)
                     : jsonResponse({ error: "Not found" }, headers, 404);
    }
  }

  /* ===== Site folder: per-site jobs, photos and documents ===== */

  // Jobs previously raised at this site (basic sheet data), newest first.
  if (subpath === "/site/jobs" && method === "GET") {
    const code = digitsOf(searchParams.get("siteCode"));
    const name = (searchParams.get("siteName") || "").trim().toLowerCase();
    const all = await listJobs(env, tenantId);
    const mine = all.filter(j => siteMatches(j, code, name)).map(siteJobSummary)
      .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    return jsonResponse({ jobs: mine }, headers);
  }

  // Every photo from every job at this site + any photos uploaded straight here.
  if (subpath === "/site/photos" && method === "GET") {
    const code = digitsOf(searchParams.get("siteCode"));
    const name = (searchParams.get("siteName") || "").trim().toLowerCase();
    const all = await listJobs(env, tenantId);
    const jobsHere = all.filter(j => siteMatches(j, code, name));
    const photos = [];
    for (const j of jobsHere) {
      const listed = await env.JOB_FILES.list({ prefix: `jobs/${j.id}/photos/` });
      for (const o of listed.objects || []) {
        photos.push({ url: await fileUrl(env, url, o.key), key: o.key, name: o.key.split("/").pop(),
          jobRef: j.helpdeskRef || j.id, jobId: j.id, at: o.uploaded ? new Date(o.uploaded).toISOString() : null, source: "job" });
      }
    }
    if (code) {
      const up = await env.JOB_FILES.list({ prefix: `sitedocs/${code}/Site Photos/`, include: ["customMetadata"] });
      for (const o of up.objects || []) {
        photos.push({ url: await fileUrl(env, url, o.key), key: o.key, name: (o.customMetadata && o.customMetadata.name) || o.key.split("/").pop(),
          at: o.uploaded ? new Date(o.uploaded).toISOString() : null, by: o.customMetadata && o.customMetadata.by, source: "upload" });
      }
    }
    photos.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
    return jsonResponse({ photos }, headers);
  }

  // Document areas (Compliance + custom) and the files in each.
  if (subpath === "/site/docs" && method === "GET") {
    const code = digitsOf(searchParams.get("siteCode"));
    if (!code) return jsonResponse({ areas: await getSiteAreas(env, tenantId), docs: {} }, headers);
    const areas = await getSiteAreas(env, tenantId);
    const docs = {};
    for (const area of areas) {
      const listed = await env.JOB_FILES.list({ prefix: `sitedocs/${code}/${area}/`, include: ["customMetadata"] });
      docs[area] = (await Promise.all((listed.objects || []).map(async o => ({
        url: await fileUrl(env, url, o.key), key: o.key,
        name: (o.customMetadata && o.customMetadata.name) || o.key.split("/").pop(),
        at: o.uploaded ? new Date(o.uploaded).toISOString() : null,
        by: o.customMetadata && o.customMetadata.by,
        size: o.size
      })))).sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
    }
    return jsonResponse({ areas, docs }, headers);
  }

  // Upload a document (or a site photo) into an area. Any signed-in user.
  if (subpath === "/site/docs" && method === "POST") {
    const code = digitsOf(searchParams.get("siteCode"));
    const area = (searchParams.get("area") || "Compliance").replace(/[\/]/g, "-").trim();
    if (!code) return jsonResponse({ error: "Missing siteCode" }, headers, 400);
    const form = await request.formData();
    const file = form.get("file");
    if (!file) return jsonResponse({ error: "Missing file" }, headers, 400);
    const safe = (file.name || "file").replace(/[^\w.\-]+/g, "_");
    const key = `sitedocs/${code}/${area}/${Date.now()}-${safe}`;
    await env.JOB_FILES.put(key, file.stream(), {
      httpMetadata: { contentType: file.type || "application/octet-stream" },
      customMetadata: { name: file.name || safe, by: (sess && sess.user && sess.user.username) || "", at: new Date().toISOString() }
    });
    return jsonResponse({ ok: true, url: r2Url(env, key), key }, headers, 201);
  }

  // Stream a site document with CORS + inline, so an in-app viewer (PDF.js /
  // <img>) can fetch it cross-origin. Public like the image routes — the R2
  // public URL already exposes these; this just adds the CORS headers a
  // fetch-based viewer needs. Keys are constrained to the sitedocs/ prefix.
  if (subpath === "/site/doc" && method === "GET") {
    const key = searchParams.get("key");
    // Only ever serve site documents / job photos (never arbitrary bucket keys).
    if (!key || !(String(key).startsWith("sitedocs/") || String(key).startsWith("jobs/")))
      return jsonResponse({ error: "Bad key" }, headers, 400);
    // Access control: a valid, unexpired signature (minted by the authenticated
    // listing) or a live session. Falls open only when no signing secret is set.
    if (!sess && !(await verifyFileSig(env, key, searchParams)))
      return jsonResponse({ error: "Link expired or invalid" }, headers, 403);
    const obj = await env.JOB_FILES.get(key);
    if (!obj) return new Response("Not found", { status: 404, headers });
    return new Response(obj.body, { status: 200, headers: {
      ...headers,
      "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
      "Content-Disposition": "inline",
      "Cache-Control": "private, max-age=3600"
    }});
  }

  // Delete a document (admins only).
  if (subpath === "/site/doc-delete" && method === "POST") {
    if (!(await isSlaAdmin(env, tenantId, sess))) return jsonResponse({ error: "Forbidden" }, headers, 403);
    const { key } = await readJson(request);
    if (!key || !String(key).startsWith("sitedocs/")) return jsonResponse({ error: "Bad key" }, headers, 400);
    await env.JOB_FILES.delete(key);
    return jsonResponse({ ok: true }, headers);
  }

  // Add a new document area (Full access only).
  if (subpath === "/site/area" && method === "POST") {
    if (!(await isFullAccess(env, tenantId, sess))) return jsonResponse({ error: "Only a Full-access user can add new folder areas." }, headers, 403);
    const { area } = await readJson(request);
    const clean = String(area || "").replace(/[\/]/g, "-").trim();
    if (!clean) return jsonResponse({ error: "Area name required" }, headers, 400);
    if (["Previous Jobs", "Site Photos"].some(r => r.toLowerCase() === clean.toLowerCase()))
      return jsonResponse({ error: "That name is reserved" }, headers, 400);
    return jsonResponse({ ok: true, areas: await addSiteArea(env, tenantId, clean) }, headers);
  }

  /* POST /sla/pdf  -> generate PDF from arbitrary HTML */
  if (subpath === "/pdf" && method === "POST") {
    const { html, filename } = await readJson(request);
    if (!html) return jsonResponse({ error: "Missing HTML" }, headers, 400);
    const pdf = await htmlToPdf(env, html);
    if (!pdf.ok) return jsonResponse({ error: "PDF generation failed" }, headers, 500);
    return new Response(pdf.buffer, { status: 200, headers: {
      ...headers, "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename || "job.pdf"}"`
    }});
  }

  return jsonResponse({ error: "Not found" }, headers, 404);
}

/* ================= HELPERS ================= */

async function readJson(r) { const t = await r.text(); return t ? JSON.parse(t) : {}; }

function jsonResponse(data, headers, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status, headers: { "Content-Type": "application/json", ...headers }
  });
}

/* ================= STATUS ================= */

const CANONICAL_STATUSES = [
  "Pending","Scheduled","Travelling","In Progress",
  "Complete","On Hold","Closed Jobs","Invoiced","Order","Quote"
];

function normalizeStatus(status) {
  if (!status) return "Pending";
  const s = status.toLowerCase().trim();
  if (s === "open" || s === "with contractor - r") return "Pending";
  if (s === "completed") return "Complete";
  if (s === "closed" || s === "cancelled") return "Closed Jobs";
  return CANONICAL_STATUSES.find(x => x.toLowerCase() === s) || "Pending";
}

/* ================= ASSIGNMENT ================= */

// Normalise an engineer identifier so "John Thorn", "john.thorn" and "JOHN.THORN"
// all compare equal.
const normId = s => (s || "").toLowerCase().replace(/\s+/g, ".").trim();

// Canonical priority strings (the inbound route accepts these verbatim).
const PRIORITY_SET = new Set(["Priority 1", "Priority 2", "Priority 3", "Priority 4"]);

// A job may have many assigned engineers (assignedEngineers[]); fall back to the
// legacy single assignedTo for older records.
function assignedList(job) {
  if (Array.isArray(job.assignedEngineers) && job.assignedEngineers.length) {
    return job.assignedEngineers.filter(Boolean);
  }
  return job.assignedTo ? [job.assignedTo] : [];
}

// Push every engineer NEWLY added to a job (added since `before`), so editing a
// job for other reasons doesn't re-notify. SLA stores engineer ids as names or
// dotted forms; resolve each to the canonical portal username the push
// subscription is keyed by. Run via ctx.waitUntil (never blocks the save).
export async function notifyNewlyAssigned(env, tid, before, after) {
  if (!after) return;
  const prior = new Set(assignedList(before || {}).map(normId));
  const added = assignedList(after).filter(a => !prior.has(normId(a)));
  if (!added.length) return;
  const map = {};
  try {
    const { results } = await env.DB.prepare("SELECT username, first_name, last_name FROM users WHERE tenant_id=?").bind(tid).all();
    for (const u of results || []) {
      map[normId(u.username)] = u.username;
      const full = ((u.first_name || "") + " " + (u.last_name || "")).trim();
      if (full) map[normId(full)] = u.username;
    }
  } catch {}
  const ref = after.helpdeskRef || after.id;
  const site = after.siteName || after.siteCode || "";
  const body = `${ref}${site ? " — " + site : ""}${after.priority ? " · " + after.priority : ""}. Tap to view.`;
  for (const eng of added) {
    const username = map[normId(eng)] || eng;
    await sendToUser(env, tid, username, {
      title: "New job assigned to you", body,
      url: "/engineer-jobs.html", tag: "sla-job:" + after.id
    });
  }
}

/* ================= STORAGE (D1) ================= */

async function getJob(env, tenantId, id) {
  const db = tenantDB(env, tenantId);
  const row = await db.prepare("SELECT data FROM sla_jobs WHERE tenant_id = ? AND id = ?").bind(tenantId, id).first();
  return row ? JSON.parse(row.data) : null;
}

function todayStr() { return new Date().toISOString().slice(0, 10); }
async function getShift(env, tenantId, username, date) {
  if (!username) return null;
  const db = tenantDB(env, tenantId);
  return (await db.prepare("SELECT * FROM shifts WHERE tenant_id=? AND username=? AND date=?").bind(tenantId, username, date).first()) || null;
}

async function listJobs(env, tenantId) {
  const db = tenantDB(env, tenantId);
  const { results } = await db.prepare("SELECT data FROM sla_jobs WHERE tenant_id = ?").bind(tenantId).all();
  return (results || []).map(r => JSON.parse(r.data));
}

// Upsert a full job object: indexed columns for filtering + full JSON in `data`.
async function saveJob(env, tenantId, job) {
  const db = tenantDB(env, tenantId);
  await db.prepare(`
    INSERT INTO sla_jobs (tenant_id, id, helpdesk_ref, description, priority, status, assigned_to,
                          site_code, raised_at, target_at, scheduled_at, created_at,
                          updated_at, closed_at, data)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      helpdesk_ref=excluded.helpdesk_ref, description=excluded.description,
      priority=excluded.priority, status=excluded.status, assigned_to=excluded.assigned_to,
      site_code=excluded.site_code, raised_at=excluded.raised_at, target_at=excluded.target_at,
      scheduled_at=excluded.scheduled_at, updated_at=excluded.updated_at,
      closed_at=excluded.closed_at, data=excluded.data
  `).bind(
    tenantId,
    job.id, job.helpdeskRef || null, job.description || null, job.priority || null,
    job.status || null, job.assignedTo || null, job.siteCode || null,
    job.raisedAt || null, job.targetAt || null, job.scheduledAt || null,
    job.createdAt || null, job.updatedAt || null, job.closedAt || null,
    JSON.stringify(job)
  ).run();
}

/* ================= CREATE / PATCH ================= */

async function createOrUpdateJobFromPayload(env, tenantId, body) {
  const cfg = await getConfig(env, tenantId);
  const id = body.id || body.reference || crypto.randomUUID();
  const existing = await getJob(env, tenantId, id);
  const now = new Date().toISOString();

  let status = normalizeStatus(body.status || existing?.status);
  const raisedAt = body.raisedAt || existing?.raisedAt || now;
  const priority = body.priority || existing?.priority || "Priority 4";
  const targetAt = computeSlaTarget(raisedAt, priority, cfg);

  const assignedEngineers = Array.isArray(body.assignedEngineers) && body.assignedEngineers.length
    ? body.assignedEngineers.filter(Boolean)
    : (body.assignedTo ? [body.assignedTo]
       : (existing?.assignedEngineers || (existing?.assignedTo ? [existing.assignedTo] : [])));

  // Assigned + still Pending = it's been sent to someone: mark it Scheduled.
  if (assignedEngineers.length && status === "Pending") status = "Scheduled";

  // Finish time: explicit end > explicit duration > keep existing > start + 1h.
  const scheduledAt = body.scheduledAt || existing?.scheduledAt || null;
  let scheduledEnd = body.scheduledEnd || existing?.scheduledEnd || null;
  if (scheduledAt) {
    const s = Date.parse(scheduledAt);
    if (body.durationMinutes && Number.isFinite(s)) {
      scheduledEnd = new Date(s + Math.max(15, Number(body.durationMinutes)) * 60000).toISOString();
    } else if ((!scheduledEnd || Date.parse(scheduledEnd) <= s) && Number.isFinite(s)) {
      scheduledEnd = new Date(s + 3600000).toISOString();
    }
  }

  const job = {
    id,
    helpdeskRef: body.reference || existing?.helpdeskRef || id,
    description: body.description || existing?.description || "",
    priority,
    raisedAt,
    targetAt,
    status,
    assignedTo: assignedEngineers[0] || "",   // legacy single field = primary engineer
    assignedEngineers,
    siteCode: body.siteCode || existing?.siteCode || "",  // carried so the siteCode filter works
    // Full site details captured at creation — shown to engineers (address,
    // phone, directions) without a lookup. Previously these were dropped.
    siteName: body.siteName || existing?.siteName || "",
    address: body.address || existing?.address || "",
    telephone: body.telephone || existing?.telephone || "",
    postcode: body.postcode || existing?.postcode || "",
    lat: body.lat ?? existing?.lat ?? null,
    lon: body.lon ?? existing?.lon ?? null,
    storeType: body.storeType || existing?.storeType || "",
    sharepointURL: body.sharepointURL || existing?.sharepointURL || "",
    scheduledAt,
    scheduledEnd,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    closedAt: status === "Closed Jobs" ? now : existing?.closedAt || null,
    // Engineer-captured packs survive an office re-save.
    quote: existing?.quote, riskAssessment: existing?.riskAssessment,
    hold: existing?.hold, order: existing?.order, signature: existing?.signature,
    travelStartMileage: existing?.travelStartMileage,
    events: existing?.events || [],
    statusHistory: existing?.statusHistory || []
  };

  job.statusHistory.push({ status, at: now, by: body.changedBy || "system" });
  await saveJob(env, tenantId, job);
  return job;
}

async function patchJob(env, tenantId, id, patch) {
  const job = await getJob(env, tenantId, id);
  if (!job) return null;
  const now = new Date().toISOString();
  job.statusHistory ||= [];
  job.events ||= [];

  const hadEngineers = assignedList(job).length > 0;

  if (patch.assignedEngineers !== undefined) {
    job.assignedEngineers = patch.assignedEngineers;
    job.assignedTo = patch.assignedEngineers[0] || "";   // keep legacy field as the primary
  } else if (patch.assignedTo !== undefined) {
    job.assignedTo = patch.assignedTo;
    job.assignedEngineers = patch.assignedTo ? [patch.assignedTo] : [];
  }
  // Every job gets a finish time. If the start moves and no explicit end came
  // with it, slide the end to keep the same duration (default 1 hour).
  if (patch.scheduledAt !== undefined) {
    const prevStart = Date.parse(job.scheduledAt);
    const prevEnd = Date.parse(job.scheduledEnd);
    const durMs = (Number.isFinite(prevStart) && Number.isFinite(prevEnd) && prevEnd > prevStart)
      ? prevEnd - prevStart : 3600000;
    job.scheduledAt = patch.scheduledAt;
    if (patch.scheduledEnd === undefined && job.scheduledAt) {
      const s = Date.parse(job.scheduledAt);
      if (Number.isFinite(s)) job.scheduledEnd = new Date(s + durMs).toISOString();
    }
  }
  if (patch.scheduledEnd !== undefined) job.scheduledEnd = patch.scheduledEnd;
  if (patch.durationMinutes !== undefined && job.scheduledAt) {
    const mins = Math.max(15, Number(patch.durationMinutes) || 60);
    const s = Date.parse(job.scheduledAt);
    if (Number.isFinite(s)) job.scheduledEnd = new Date(s + mins * 60000).toISOString();
  }
  if (patch.siteCode !== undefined) job.siteCode = patch.siteCode;
  // The site can be corrected after creation (test jobs, wrong pick at raise
  // time). All the site details travel together.
  for (const k of ["siteName", "address", "postcode", "telephone", "storeType", "sharepointURL"]) {
    if (patch[k] !== undefined) job[k] = patch[k];
  }
  if (patch.lat !== undefined) job.lat = patch.lat;
  if (patch.lon !== undefined) job.lon = patch.lon;
  if (patch.priority !== undefined && patch.priority) job.priority = patch.priority;
  if (patch.description !== undefined && patch.description) job.description = patch.description;
  if (patch.helpdeskRef !== undefined && patch.helpdeskRef) job.helpdeskRef = patch.helpdeskRef;
  if (patch.raisedAt !== undefined && patch.raisedAt) job.raisedAt = patch.raisedAt;
  // The SLA target is raised-time + priority window — recompute it whenever
  // either of those is edited, so the countdown always reflects the truth.
  if ((patch.priority !== undefined && patch.priority) || (patch.raisedAt !== undefined && patch.raisedAt)) {
    const cfg = await getConfig(env, tenantId);
    job.targetAt = computeSlaTarget(job.raisedAt || now, job.priority, cfg);
  }
  if (patch.quote !== undefined) job.quote = patch.quote;   // quote pack
  if (patch.riskAssessment !== undefined) job.riskAssessment = patch.riskAssessment;  // pre-start RA
  if (patch.hold !== undefined) job.hold = patch.hold;      // on-hold pack (reason / needs / resume)
  if (patch.order !== undefined) job.order = patch.order;   // parts-order pack
  if (patch.travelStartMileage !== undefined) job.travelStartMileage = patch.travelStartMileage;  // per-job mileage

  if (patch.status) {
    const s = normalizeStatus(patch.status);
    if (s !== job.status) {
      job.status = s;
      job.statusHistory.push({ status: s, at: now, by: patch.changedBy || "system" });
      if (s === "Closed Jobs" && !job.closedAt) job.closedAt = now;
    }
  } else if (!hadEngineers && assignedList(job).length && job.status === "Pending") {
    // Sending a job to someone IS scheduling it — flip Pending → Scheduled.
    job.status = "Scheduled";
    job.statusHistory.push({ status: "Scheduled", at: now, by: patch.changedBy || "system" });
  }
  if (patch.note) {
    job.events.push({ at: now, by: patch.changedBy || "system", type: "note", note: patch.note });
  }

  job.updatedAt = now;
  await saveJob(env, tenantId, job);
  return job;
}

/* ================= SITE FOLDER ================= */

// Site numbers arrive as "42", "0042" or "SR00042" — compare on the number.
function digitsOf(s) { const m = String(s || "").match(/(\d+)/); return m ? String(Number(m[1])) : ""; }
function siteMatches(job, code, nameLower) {
  const jc = digitsOf(job.siteCode);
  if (code && jc && jc === code) return true;
  if (!jc && nameLower && (job.siteName || "").trim().toLowerCase() === nameLower) return true;
  return false;
}
function siteJobSummary(j) {
  const events = Array.isArray(j.events) ? j.events : [];
  const lastNote = [...events].reverse().find(e => e.note);
  return {
    id: j.id, ref: j.helpdeskRef || j.id, description: j.description || "",
    status: j.status || "Pending", priority: j.priority || "",
    date: j.closedAt || j.scheduledAt || j.raisedAt || null,
    raisedAt: j.raisedAt || null, closedAt: j.closedAt || null,
    engineers: (Array.isArray(j.assignedEngineers) && j.assignedEngineers.length) ? j.assignedEngineers : (j.assignedTo ? [j.assignedTo] : []),
    lastNote: lastNote ? lastNote.note : "",
    signedBy: (j.signature && j.signature.signedBy) || ""
  };
}
async function userPerms(env, tenantId, sess) {
  const username = sess && sess.user && sess.user.username;
  if (!username) return new Set();
  const db = tenantDB(env, tenantId);
  const { results } = await db.prepare(
    "SELECT permission FROM user_permissions WHERE tenant_id = ? AND username = ? AND value = 1"
  ).bind(tenantId, username).all();
  return new Set((results || []).map(r => r.permission));
}
async function isSlaAdmin(env, tenantId, sess) {
  const set = await userPerms(env, tenantId, sess);
  return set.has("FullAccess") || set.has("SLAAdmin");
}
async function isFullAccess(env, tenantId, sess) {
  return (await userPerms(env, tenantId, sess)).has("FullAccess");
}
async function getSiteAreas(env, tenantId) {
  const db = tenantDB(env, tenantId);
  const row = await db.prepare("SELECT value FROM app_config WHERE tenant_id = ? AND key = 'site_doc_areas'").bind(tenantId).first();
  let areas = row ? JSON.parse(row.value) : null;
  if (!Array.isArray(areas) || !areas.length) areas = ["Compliance"];
  return areas;
}
async function addSiteArea(env, tenantId, area) {
  const areas = await getSiteAreas(env, tenantId);
  if (!areas.some(a => a.toLowerCase() === area.toLowerCase())) areas.push(area);
  const db = tenantDB(env, tenantId);
  await db.prepare(
    "INSERT INTO app_config (tenant_id, key, value) VALUES (?, 'site_doc_areas', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(tenantId, JSON.stringify(areas)).run();
  return areas;
}

/* ================= SLA ================= */

function computeSlaTarget(raisedAt, priority, cfg) {
  const hrs = cfg.priorities[priority]?.hours || 168;
  return new Date(new Date(raisedAt).getTime() + hrs * 3600000).toISOString();
}

function decorateJobWithLiveSla(job) {
  const target = Date.parse(job.targetAt);
  const state = (job.status === "Closed Jobs" || job.status === "Complete")
    ? "OK" : (Date.now() > target ? "BREACHED" : "OK");
  return { ...job, sla: { state, now: new Date().toISOString() } };
}

/* ================= CONFIG (D1) ================= */

const DEFAULT_CONFIG = {
  priorities: {
    "Priority 1": { hours: 4 },
    "Priority 2": { hours: 24 },
    "Priority 3": { hours: 72 },
    "Priority 4": { hours: 168 }
  }
};

async function getConfig(env, tenantId) {
  const db = tenantDB(env, tenantId);
  const row = await db.prepare("SELECT value FROM app_config WHERE tenant_id = ? AND key = 'sla_config'").bind(tenantId).first();
  return row ? JSON.parse(row.value) : DEFAULT_CONFIG;
}

async function setConfig(env, tenantId, body) {
  const merged = { ...DEFAULT_CONFIG, ...body };
  const db = tenantDB(env, tenantId);
  await db.prepare(
    "INSERT INTO app_config (tenant_id, key, value) VALUES (?, 'sla_config', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).bind(tenantId, JSON.stringify(merged)).run();
  return merged;
}

/* ================= FILES (R2) + PDF ================= */

function r2Url(env, key) {
  const base = (env.R2_PUBLIC_BASE || "https://pub-0a9aac7bfc6749bbbdbf9660503968e6.r2.dev").replace(/\/$/, "");
  return `${base}/${key}`;
}

// Access-controlled URL for a site document / photo. Routes through the worker
// (/sla/site/doc) so it carries CORS + an HMAC signature that expires — instead
// of the raw, permanent, world-readable r2.dev link. One URL works for <img>,
// PDF.js fetch, download and open-in-new-tab.
async function fileUrl(env, url, key) {
  return signedFileUrl(env, url.origin, "/sla/site/doc", key);
}

async function getJobFilesPublicList(env, id) {
  if (!env.JOB_FILES) return [];
  const listed = await env.JOB_FILES.list({ prefix: `jobs/${id}/photos/` });
  return listed.objects.map(o => ({ name: o.key.split("/").pop(), publicURL: r2Url(env, o.key) }));
}

function resolveLogo(env) {
  let logo = (env.MOSTLANE_LOGO_BASE64 || "").trim();
  if (logo && !logo.startsWith("data:image")) logo = "data:image/png;base64," + logo;
  return logo;
}

function safeRef(decorated, id) {
  const ref = (decorated.helpdeskRef || decorated.id || id || "job").toString();
  return ref.replace(/[^\w\-]+/g, "_").slice(0, 80);
}

async function htmlToPdf(env, html) {
  const res = await fetch("https://api.pdfshift.io/v3/convert/pdf", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Basic " + btoa(env.PDFSHIFT_API_KEY + ":")
    },
    body: JSON.stringify({ source: html, use_print: false })
  });
  if (!res.ok) { console.error(await res.text()); return { ok: false }; }
  return { ok: true, buffer: await res.arrayBuffer() };
}

/* ================= EXPORT HTML ================= */

function escapeHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function buildJobExportHtml(job, files, logoDataUrl) {
  const titleRef = escapeHtml(job.helpdeskRef || job.id || "");
  const desc = escapeHtml(job.description || "");
  const priority = escapeHtml(job.priority || "");
  const status = escapeHtml(job.status || "");
  const assignedTo = escapeHtml(job.assignedTo || "");
  const raisedAt = escapeHtml(job.raisedAt || "");
  const targetAt = escapeHtml(job.targetAt || "");
  const scheduledAt = escapeHtml(job.scheduledAt || "");
  const updatedAt = escapeHtml(job.updatedAt || "");
  const slaState = escapeHtml(job.sla?.state || "");

  const logoHtml = logoDataUrl
    ? `<img class="logo" src="${logoDataUrl}" alt="Mostlane"/>`
    : `<div class="logo-fallback">Mostlane</div>`;

  const filesHtml = (files && files.length)
    ? files.map(f => {
        const name = escapeHtml(f.name);
        const url = escapeHtml(f.publicURL);
        const isImg = /\.(png|jpg|jpeg|webp|gif)$/i.test(f.name || "");
        return `
          <div class="file-card">
            <div class="file-head">
              <div class="file-name">${name}</div>
              <a class="file-link" href="${url}" target="_blank" rel="noopener">Open</a>
            </div>
            ${isImg ? `<img class="photo" src="${url}" alt="${name}" />` : ``}
          </div>`;
      }).join("\n")
    : `<div class="muted">No photos/files uploaded.</div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Job ${titleRef}</title>
<style>
  :root{--ml-blue:#003366;--ml-accent:#1a73e8;--ml-ink:#27313a;--ml-bg:#f3f5f7;--card:#ffffff;--border:#e6edf3;--muted:#667085;--ok:#0c7d27;--bad:#b00020;}
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;background:var(--ml-bg);color:var(--ml-ink);padding:24px;}
  .wrap{max-width:980px;margin:0 auto}
  .header{display:flex;gap:16px;align-items:center;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px;}
  .logo{height:46px}
  .logo-fallback{width:160px;height:46px;border-radius:10px;display:flex;align-items:center;justify-content:center;background:var(--ml-blue);color:#fff;font-weight:700;letter-spacing:.3px}
  .title{flex:1;}
  .title h1{margin:0;font-size:18px}
  .title .sub{margin-top:4px;color:var(--muted);font-size:13px}
  .pill{padding:6px 10px;border-radius:999px;font-size:12px;font-weight:700;border:1px solid var(--border);background:#fff;}
  .pill.ok{color:var(--ok)}
  .pill.bad{color:var(--bad)}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px;}
  .card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px;}
  .card h2{margin:0 0 10px 0;font-size:14px;color:var(--ml-blue)}
  .row{display:flex;gap:10px;justify-content:space-between;margin:6px 0}
  .k{color:var(--muted);font-size:12px}
  .v{font-size:12px;text-align:right;max-width:60%}
  .desc{white-space:pre-wrap;font-size:13px;line-height:1.45;background:#fafbfd;border:1px solid var(--border);border-radius:10px;padding:12px;}
  .files{margin-top:14px;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px;}
  .files h2{margin:0 0 10px 0;font-size:14px;color:var(--ml-blue)}
  .muted{color:var(--muted);font-size:13px}
  .file-card{border:1px solid var(--border);border-radius:12px;padding:12px;margin:10px 0;background:#fff;}
  .file-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
  .file-name{font-size:13px;font-weight:700;word-break:break-word}
  .file-link{font-size:12px;text-decoration:none;color:var(--ml-accent);border:1px solid var(--border);padding:6px 10px;border-radius:10px;white-space:nowrap;}
  .photo{width:100%;border-radius:10px;border:1px solid var(--border);margin-top:10px;}
  @media (max-width:820px){body{padding:14px}.grid{grid-template-columns:1fr}.v{max-width:70%}}
</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    ${logoHtml}
    <div class="title">
      <h1>Job ${titleRef}</h1>
      <div class="sub">Generated: ${escapeHtml(new Date().toISOString())}</div>
    </div>
    <div class="pill ${slaState === "BREACHED" ? "bad" : "ok"}">SLA: ${slaState || "OK"}</div>
  </div>
  <div class="grid">
    <div class="card">
      <h2>Details</h2>
      <div class="row"><div class="k">Status</div><div class="v">${status}</div></div>
      <div class="row"><div class="k">Priority</div><div class="v">${priority}</div></div>
      <div class="row"><div class="k">Assigned To</div><div class="v">${assignedTo || "-"}</div></div>
      <div class="row"><div class="k">Scheduled At</div><div class="v">${scheduledAt || "-"}</div></div>
      <div class="row"><div class="k">Updated At</div><div class="v">${updatedAt || "-"}</div></div>
    </div>
    <div class="card">
      <h2>SLA</h2>
      <div class="row"><div class="k">Raised At</div><div class="v">${raisedAt || "-"}</div></div>
      <div class="row"><div class="k">Target At</div><div class="v">${targetAt || "-"}</div></div>
      <div class="row"><div class="k">State</div><div class="v">${slaState || "OK"}</div></div>
    </div>
    <div class="card" style="grid-column:1/-1">
      <h2>Description</h2>
      <div class="desc">${desc || "-"}</div>
    </div>
  </div>
  <div class="files">
    <h2>Photos / Files</h2>
    ${filesHtml}
  </div>
</div>
</body>
</html>`;
}
