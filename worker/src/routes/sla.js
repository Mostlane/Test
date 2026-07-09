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

export async function handle(request, env, ctx, url) {
  const headers = corsHeaders(env, request);
  const method = request.method.toUpperCase();
  // Strip the /sla mount prefix so the routing below mirrors the original Worker.
  const subpath = url.pathname.replace(/^\/sla(?=\/|$)/, "") || "/";
  const searchParams = url.searchParams;

  /* GET/POST /sla/config */
  if (subpath === "/config") {
    if (method === "GET")  return jsonResponse(await getConfig(env), headers);
    if (method === "POST") return jsonResponse(await setConfig(env, await readJson(request)), headers);
  }

  /* POST /sla/jobs */
  if (subpath === "/jobs" && method === "POST") {
    const job = await createOrUpdateJobFromPayload(env, await readJson(request));
    return jsonResponse(decorateJobWithLiveSla(job), headers, 201);
  }

  /* GET /sla/jobs (with filters) */
  if (subpath === "/jobs" && method === "GET") {
    let jobs = (await listJobs(env)).map(decorateJobWithLiveSla);
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
    let jobs = (await listJobs(env)).filter(j => assignedList(j).some(a => normId(a) === engineer));
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
    return jsonResponse({ shift: await getShift(env, engineer, date) }, headers);
  }
  if (subpath === "/shift/clock-on" && method === "POST") {
    const b = await readJson(request);
    if (!b.engineer) return jsonResponse({ error: "engineer required" }, headers, 400);
    const date = b.date || todayStr();
    await env.DB.prepare(`
      INSERT INTO shifts (username, date, clock_on_at, clock_on_gps, start_mileage)
      VALUES (?,?,?,?,?)
      ON CONFLICT(username, date) DO UPDATE SET
        clock_on_at   = COALESCE(shifts.clock_on_at, excluded.clock_on_at),
        clock_on_gps  = COALESCE(shifts.clock_on_gps, excluded.clock_on_gps),
        start_mileage = COALESCE(shifts.start_mileage, excluded.start_mileage)
    `).bind(b.engineer, date, new Date().toISOString(), b.gps || null, b.startMileage ?? null).run();
    return jsonResponse({ ok: true, shift: await getShift(env, b.engineer, date) }, headers, 201);
  }
  if (subpath === "/shift/clock-off" && method === "POST") {
    const b = await readJson(request);
    if (!b.engineer) return jsonResponse({ error: "engineer required" }, headers, 400);
    const date = b.date || todayStr();
    await env.DB.prepare(
      "UPDATE shifts SET clock_off_at=?, clock_off_gps=?, end_mileage=?, fuel=? WHERE username=? AND date=?"
    ).bind(new Date().toISOString(), b.gps || null, b.endMileage ?? null, b.fuel || null, b.engineer, date).run();
    return jsonResponse({ ok: true, shift: await getShift(env, b.engineer, date) }, headers);
  }
  /* GET /sla/shifts  -> list recorded day sessions (office view), filterable */
  if (subpath === "/shifts" && method === "GET") {
    const engineer = searchParams.get("engineer");
    const from = searchParams.get("from");
    const to = searchParams.get("to");
    const conds = [], binds = [];
    if (engineer) { conds.push("username = ?"); binds.push(engineer); }
    if (from)     { conds.push("date >= ?");    binds.push(from); }
    if (to)       { conds.push("date <= ?");    binds.push(to); }
    let q = "SELECT * FROM shifts";
    if (conds.length) q += " WHERE " + conds.join(" AND ");
    q += " ORDER BY date DESC, username ASC LIMIT 500";
    const { results } = await env.DB.prepare(q).bind(...binds).all();
    return jsonResponse({ shifts: results || [] }, headers);
  }

  /* ===== Story Mode: weekly vehicle check ===== */
  if (subpath === "/vehicle-check" && method === "GET") {
    const engineer = searchParams.get("engineer") || "";
    const week = searchParams.get("week") || "";
    const row = (engineer && week)
      ? await env.DB.prepare("SELECT * FROM vehicle_checks WHERE username=? AND week=?").bind(engineer, week).first()
      : null;
    return jsonResponse({ check: row || null }, headers);
  }
  if (subpath === "/vehicle-check" && method === "POST") {
    const b = await readJson(request);
    if (!b.engineer || !b.week) return jsonResponse({ error: "engineer and week required" }, headers, 400);
    await env.DB.prepare(`
      INSERT INTO vehicle_checks (username, week, vehicle, checked_at, safe_to_drive, items, note)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(username, week) DO UPDATE SET
        vehicle=excluded.vehicle, checked_at=excluded.checked_at,
        safe_to_drive=excluded.safe_to_drive, items=excluded.items, note=excluded.note
    `).bind(b.engineer, b.week, b.vehicle || null, new Date().toISOString(),
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
      assignedEngineers: Array.isArray(body.assignedEngineers)
        ? body.assignedEngineers.filter(Boolean)
        : (body.assignedTo !== undefined ? (body.assignedTo ? [body.assignedTo] : []) : undefined),
      changedBy: body.changedBy || "scheduler"
    };
    const updated = await patchJob(env, id, patch);
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
      const job = await getJob(env, id);
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
      const job = await getJob(env, id);
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
      const job = await getJob(env, id);
      if (job) {
        job.signature = { signedBy, signedAt, fileKey: key };
        job.updatedAt = new Date().toISOString();
        await saveJob(env, job);
      }
      return jsonResponse({ ok: true, key, publicURL: r2Url(env, key) }, headers, 201);
    }

    // GET /sla/jobs/{id}
    if (method === "GET") {
      const job = await getJob(env, id);
      return job ? jsonResponse(decorateJobWithLiveSla(job), headers)
                 : jsonResponse({ error: "Not found" }, headers, 404);
    }

    // PATCH /sla/jobs/{id}
    if (method === "PATCH") {
      const updated = await patchJob(env, id, await readJson(request));
      return updated ? jsonResponse(decorateJobWithLiveSla(updated), headers)
                     : jsonResponse({ error: "Not found" }, headers, 404);
    }
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

// A job may have many assigned engineers (assignedEngineers[]); fall back to the
// legacy single assignedTo for older records.
function assignedList(job) {
  if (Array.isArray(job.assignedEngineers) && job.assignedEngineers.length) {
    return job.assignedEngineers.filter(Boolean);
  }
  return job.assignedTo ? [job.assignedTo] : [];
}

/* ================= STORAGE (D1) ================= */

async function getJob(env, id) {
  const row = await env.DB.prepare("SELECT data FROM sla_jobs WHERE id = ?").bind(id).first();
  return row ? JSON.parse(row.data) : null;
}

function todayStr() { return new Date().toISOString().slice(0, 10); }
async function getShift(env, username, date) {
  if (!username) return null;
  return (await env.DB.prepare("SELECT * FROM shifts WHERE username=? AND date=?").bind(username, date).first()) || null;
}

async function listJobs(env) {
  const { results } = await env.DB.prepare("SELECT data FROM sla_jobs").all();
  return (results || []).map(r => JSON.parse(r.data));
}

// Upsert a full job object: indexed columns for filtering + full JSON in `data`.
async function saveJob(env, job) {
  await env.DB.prepare(`
    INSERT INTO sla_jobs (id, helpdesk_ref, description, priority, status, assigned_to,
                          site_code, raised_at, target_at, scheduled_at, created_at,
                          updated_at, closed_at, data)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      helpdesk_ref=excluded.helpdesk_ref, description=excluded.description,
      priority=excluded.priority, status=excluded.status, assigned_to=excluded.assigned_to,
      site_code=excluded.site_code, raised_at=excluded.raised_at, target_at=excluded.target_at,
      scheduled_at=excluded.scheduled_at, updated_at=excluded.updated_at,
      closed_at=excluded.closed_at, data=excluded.data
  `).bind(
    job.id, job.helpdeskRef || null, job.description || null, job.priority || null,
    job.status || null, job.assignedTo || null, job.siteCode || null,
    job.raisedAt || null, job.targetAt || null, job.scheduledAt || null,
    job.createdAt || null, job.updatedAt || null, job.closedAt || null,
    JSON.stringify(job)
  ).run();
}

/* ================= CREATE / PATCH ================= */

async function createOrUpdateJobFromPayload(env, body) {
  const cfg = await getConfig(env);
  const id = body.id || body.reference || crypto.randomUUID();
  const existing = await getJob(env, id);
  const now = new Date().toISOString();

  const status = normalizeStatus(body.status || existing?.status);
  const raisedAt = body.raisedAt || existing?.raisedAt || now;
  const priority = body.priority || existing?.priority || "Priority 4";
  const targetAt = computeSlaTarget(raisedAt, priority, cfg);

  const assignedEngineers = Array.isArray(body.assignedEngineers) && body.assignedEngineers.length
    ? body.assignedEngineers.filter(Boolean)
    : (body.assignedTo ? [body.assignedTo]
       : (existing?.assignedEngineers || (existing?.assignedTo ? [existing.assignedTo] : [])));

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
    scheduledAt: body.scheduledAt || existing?.scheduledAt || null,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    closedAt: status === "Closed Jobs" ? now : existing?.closedAt || null,
    events: existing?.events || [],
    statusHistory: existing?.statusHistory || []
  };

  job.statusHistory.push({ status, at: now, by: body.changedBy || "system" });
  await saveJob(env, job);
  return job;
}

async function patchJob(env, id, patch) {
  const job = await getJob(env, id);
  if (!job) return null;
  const now = new Date().toISOString();
  job.statusHistory ||= [];
  job.events ||= [];

  if (patch.assignedEngineers !== undefined) {
    job.assignedEngineers = patch.assignedEngineers;
    job.assignedTo = patch.assignedEngineers[0] || "";   // keep legacy field as the primary
  } else if (patch.assignedTo !== undefined) {
    job.assignedTo = patch.assignedTo;
    job.assignedEngineers = patch.assignedTo ? [patch.assignedTo] : [];
  }
  if (patch.scheduledAt !== undefined) job.scheduledAt = patch.scheduledAt;
  if (patch.siteCode !== undefined) job.siteCode = patch.siteCode;
  if (patch.quote !== undefined) job.quote = patch.quote;   // Story Mode quote pack
  if (patch.riskAssessment !== undefined) job.riskAssessment = patch.riskAssessment;  // Story Mode RA
  if (patch.order !== undefined) job.order = patch.order;   // Story Mode parts-order pack
  if (patch.travelStartMileage !== undefined) job.travelStartMileage = patch.travelStartMileage;  // per-job mileage

  if (patch.status) {
    const s = normalizeStatus(patch.status);
    if (s !== job.status) {
      job.status = s;
      job.statusHistory.push({ status: s, at: now, by: patch.changedBy || "system" });
      if (s === "Closed Jobs" && !job.closedAt) job.closedAt = now;
    }
  }
  if (patch.note) {
    job.events.push({ at: now, by: patch.changedBy || "system", type: "note", note: patch.note });
  }

  job.updatedAt = now;
  await saveJob(env, job);
  return job;
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

async function getConfig(env) {
  const row = await env.DB.prepare("SELECT value FROM app_config WHERE key = 'sla_config'").first();
  return row ? JSON.parse(row.value) : DEFAULT_CONFIG;
}

async function setConfig(env, body) {
  const merged = { ...DEFAULT_CONFIG, ...body };
  await env.DB.prepare(
    "INSERT INTO app_config (key, value) VALUES ('sla_config', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).bind(JSON.stringify(merged)).run();
  return merged;
}

/* ================= FILES (R2) + PDF ================= */

function r2Url(env, key) {
  const base = (env.R2_PUBLIC_BASE || "https://pub-0a9aac7bfc6749bbbdbf9660503968e6.r2.dev").replace(/\/$/, "");
  return `${base}/${key}`;
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
