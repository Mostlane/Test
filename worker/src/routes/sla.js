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
import { trackJobTime } from "./timesheets.js";
import { permissionsFor } from "../lib/auth.js";
import { sendToUser, sendToPermission, resolveNotificationsByTag, remindPermission } from "./push.js";
import { firstTime } from "../lib/idempotency.js";
import { buildFirestopPdf } from "../lib/firestoppdf.js";
import { buildZip } from "../lib/zip.js";
import { logoBytes } from "../lib/logo.js";
import { pdfExtractText, certNumberFromText } from "../lib/pdftext.js";
import { onStatusTransition } from "../lib/statusemail.js";

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

  // POST /sla/speed-check — read the body, discard it, return 200 with the
  // received byte count. Used by engineer-job.html's "high-quality upload"
  // toggle: the client POSTs a ~500KB blob and times it. If it takes >4s
  // the toggle snaps back off, so a full-res photo isn't queued on a phone
  // that can't push it. Cheap: reads the stream and drops each chunk.
  if (subpath === "/speed-check" && method === "POST") {
    let bytes = 0;
    try {
      const reader = request.body && request.body.getReader ? request.body.getReader() : null;
      if (reader) { for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value ? value.length : 0; } }
      else { const ab = await request.arrayBuffer(); bytes = ab.byteLength; }
    } catch { /* truncated body → still returns the bytes we managed to read */ }
    return jsonResponse({ ok: true, bytes }, headers);
  }

  /* GET /sla/categories — custom job categories (any session, so every page can
     merge them into its status list). POST — replace the whole list (SLA admin). */
  // Does an engineer already have a PROJECT drip-series day on a given date? Used
  // by the editor to offer "fit the project after this job / skip that day" when
  // the office allocates a clashing job.
  if (subpath === "/series-clash" && method === "GET") {
    const engineer = searchParams.get("engineer") || "";
    const date = searchParams.get("date") || "";
    const excludeId = searchParams.get("excludeId") || "";
    if (!engineer || !date) return jsonResponse({ clash: null }, headers);
    const eid = normId(engineer);
    const all = await listJobs(env, tenantId);
    const hit = all.find(j => j.seriesId && !j.seriesSkipped && j.id !== excludeId
      && j.scheduledAt && new Date(j.scheduledAt).toISOString().slice(0, 10) === date
      && assignedList(j).some(a => normId(a) === eid));
    return jsonResponse({ clash: hit ? { id: hit.id, description: hit.description || "", scheduledAt: hit.scheduledAt || null, scheduledEnd: hit.scheduledEnd || null, projectId: hit.projectId || null } : null }, headers);
  }

  // Every job an engineer already has on a given day (office safeguard: warn
  // before assigning them a clashing job). Includes hidden project-series days;
  // excludes cancelled + skipped + the job being edited.
  if (subpath === "/engineer-day" && method === "GET") {
    const engineer = searchParams.get("engineer") || "";
    const date = searchParams.get("date") || "";
    const excludeId = searchParams.get("excludeId") || "";
    if (!engineer || !date) return jsonResponse({ jobs: [] }, headers);
    const eid = normId(engineer);
    const all = await listJobs(env, tenantId);
    const jobs = all.filter(j => j.id !== excludeId && j.scheduledAt
      && new Date(j.scheduledAt).toISOString().slice(0, 10) === date
      && !j.seriesSkipped
      && String(j.status || "").toLowerCase() !== "cancelled"
      && assignedList(j).some(a => normId(a) === eid))
      .map(j => ({ id: j.id, ref: j.helpdeskRef || j.id, scheduledAt: j.scheduledAt || null, status: j.status || "", series: !!j.seriesId, siteName: j.siteName || "" }))
      .sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)));
    return jsonResponse({ jobs }, headers);
  }

  // Per-engineer FALLBACK jobs — the auto "at least a job for tomorrow" safety
  // net. A cron warns the office (15:30 & 18:00) and, at 19:00, assigns each
  // still-empty field engineer their configured fallback for the next working day.
  if (subpath === "/fallbacks") {
    if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
    if (!(await isSlaAdmin(env, tenantId, sess))) return jsonResponse({ error: "Forbidden" }, headers, 403);
    if (method === "GET") {
      let projects = [];
      try {
        const { results } = await tenantDB(env, tenantId).prepare(
          "SELECT id, number, name FROM projects WHERE tenant_id IN ('1.0','1',1) AND status='live' ORDER BY name"
        ).all();
        projects = (results || []).map(p => ({ id: p.id, number: p.number, name: p.name }));
      } catch {}
      return jsonResponse({ ok: true, config: await getFallbacks(env, tenantId), projects }, headers);
    }
    if (method === "POST") return jsonResponse({ ok: true, config: await setFallbacks(env, tenantId, await readJson(request)) }, headers);
  }

  // EM certificate set-numbers (per store). GET any session (Add Job reads it);
  // POST re-extracts from the compliance certs (SLA admin).
  if (subpath === "/emsets") {
    if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
    if (method === "GET") return jsonResponse({ ok: true, sets: await getEmSets(env, tenantId) }, headers);
    if (method === "POST") {
      if (!(await isSlaAdmin(env, tenantId, sess))) return jsonResponse({ error: "Forbidden" }, headers, 403);
      return jsonResponse({ ok: true, ...(await rebuildEmSets(env, tenantId)) }, headers);
    }
  }

  if (subpath === "/categories") {
    if (method === "GET") return jsonResponse({ categories: await getCategories(env, tenantId) }, headers);
    if (method === "POST") {
      if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
      if (!(await isSlaAdmin(env, tenantId, sess))) return jsonResponse({ error: "Forbidden" }, headers, 403);
      const body = await readJson(request);
      const list = Array.isArray(body?.categories) ? body.categories : [];
      return jsonResponse({ ok: true, categories: await setCategories(env, tenantId, list) }, headers);
    }
  }

  /* Areas of work — a managed list (app_config sla_work_areas) used to match a
     job's `workArea` to engineers competent in it. GET any session; POST SLA admin. */
  if (subpath === "/work-areas") {
    if (method === "GET") return jsonResponse({ areas: await getWorkAreas(env, tenantId) }, headers);
    if (method === "POST") {
      if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
      if (!(await isSlaAdmin(env, tenantId, sess))) return jsonResponse({ error: "Forbidden" }, headers, 403);
      const body = await readJson(request);
      const list = Array.isArray(body?.areas) ? body.areas : [];
      return jsonResponse({ ok: true, areas: await setWorkAreas(env, tenantId, list) }, headers);
    }
  }

  /* Engineer skills matrix — {username:{areaId:stars 1-5}} in app_config
     sla_eng_skills. GET any session (the scheduler weights suggestions with it);
     POST SLA admin (the rock-sheet page). */
  if (subpath === "/eng-skills") {
    if (method === "GET") return jsonResponse({ skills: await getEngSkills(env, tenantId), areas: await getWorkAreas(env, tenantId) }, headers);
    if (method === "POST") {
      if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
      if (!(await isSlaAdmin(env, tenantId, sess))) return jsonResponse({ error: "Forbidden" }, headers, 403);
      const body = await readJson(request);
      return jsonResponse({ ok: true, skills: await setEngSkills(env, tenantId, body?.skills || {}) }, headers);
    }
  }

  /* AI: suggest a job's area of work from its description (office confirms).
     Cheap (~0.1p) but capped + metered. Any logged-in session may call it
     (add-job / the editor are already permission-gated pages). */
  if (subpath === "/infer-work-area" && method === "POST") {
    if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
    const b = await readJson(request);
    const cap = await aiCapCheck(env, tenantId);
    if (cap.capped) return jsonResponse({ ok: false, capped: true, error: `Daily AI limit reached (${cap.cap}). Pick the work area manually, or raise the limit in the scheduler AI-usage panel.` }, headers, 200);
    const r = await inferWorkArea(env, tenantId, b.description || "");
    if (r.ok && (r.areaId || r.name)) ctx?.waitUntil(bumpAiUsage(env, tenantId, "infer-work-area"));
    return jsonResponse(r, headers);
  }

  /* AI usage meter + soft daily cap (SLA admin). */
  if (subpath === "/ai-usage") {
    if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
    if (!(await isSlaAdmin(env, tenantId, sess))) return jsonResponse({ error: "Forbidden" }, headers, 403);
    if (method === "GET") return jsonResponse(await getAiUsage(env, tenantId), headers);
    if (method === "POST") {
      const b = await readJson(request);
      if (b.dailyCap !== undefined) {
        const n = Math.max(0, parseInt(b.dailyCap, 10) || 0);
        const db = tenantDB(env, tenantId);
        await db.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (?,'ai_daily_cap',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(tenantId, String(n)).run();
      }
      return jsonResponse(await getAiUsage(env, tenantId), headers);
    }
  }

  /* ═══════════════ Firestopping (RIA form) ═══════════════
     A firestopping job produces a "Record of Installation Activities" PDF from
     the engineer's per-seal photos + a signed declaration, bundled with the
     product spec sheets for the materials used. Only shown on jobs ticked
     "firestopping". Config + material presets live in app_config; the record
     lives on job.firestop; photos + spec docs in R2. */
  if (subpath.startsWith("/firestop")) {
    const r2Bytes = async (key) => { try { const o = await env.JOB_FILES.get(key); return o ? new Uint8Array(await o.arrayBuffer()) : null; } catch { return null; } };
    const safeName = s => String(s || "file").replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 90);
    const padRef = n => "0".repeat(Math.max(0, 5 - String(n).length)) + n;
    const padRef2 = n => String(n).padStart(2, "0");

    // Config: company / seal category / declaration / next sequential number.
    if (subpath === "/firestop/config") {
      if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
      if (method === "GET") return jsonResponse(await getFsConfig(env, tenantId), headers);
      if (method === "POST") {
        if (!(await isSlaAdmin(env, tenantId, sess))) return jsonResponse({ error: "Forbidden" }, headers, 403);
        const b = await readJson(request);
        const cfg = await getFsConfig(env, tenantId);
        if (b.company !== undefined) cfg.company = String(b.company).slice(0, 120);
        if (b.sealCategory !== undefined) cfg.sealCategory = String(b.sealCategory).slice(0, 200);
        if (b.declaration !== undefined) cfg.declaration = String(b.declaration).slice(0, 1200);
        if (b.nextRef !== undefined && b.nextRef !== "") cfg.nextRef = Math.max(1, parseInt(b.nextRef, 10) || 1);
        await saveFsConfig(env, tenantId, cfg);
        return jsonResponse({ ok: true, config: cfg }, headers);
      }
    }

    // Material presets (products) + their uploaded spec documents.
    if (subpath === "/firestop/materials") {
      if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
      if (method === "GET") {
        const mats = await getFsMaterials(env, tenantId);
        const out = await Promise.all(mats.map(async m => ({
          id: m.id, manufacturer: m.manufacturer, name: m.name, category: m.category || "",
          docs: await Promise.all((m.docs || []).map(async d => ({
            id: d.id, name: d.name,
            url: await signedFileUrl(env, url.origin, "/sla/firestop/spec-file", d.key, 86400),
          }))),
        })));
        return jsonResponse({ materials: out }, headers);
      }
      if (method === "POST") {
        if (!(await isSlaAdmin(env, tenantId, sess))) return jsonResponse({ error: "Forbidden" }, headers, 403);
        const b = await readJson(request);
        let mats = await getFsMaterials(env, tenantId);
        if (b.delete && b.id) {
          const m = mats.find(x => x.id === b.id);
          if (m) for (const d of m.docs || []) { try { await env.JOB_FILES.delete(d.key); } catch {} }
          mats = mats.filter(x => x.id !== b.id);
        } else {
          const id = b.id || ("fsm-" + crypto.randomUUID().slice(0, 8));
          const ex = mats.find(x => x.id === id);
          const fields = { manufacturer: String(b.manufacturer || "").slice(0, 120), name: String(b.name || "").slice(0, 160), category: String(b.category || "").slice(0, 120) };
          if (!fields.manufacturer && !fields.name) return jsonResponse({ error: "manufacturer or name required" }, headers, 400);
          if (ex) Object.assign(ex, fields); else mats.push({ id, ...fields, docs: [] });
        }
        await saveFsMaterials(env, tenantId, mats);
        return jsonResponse({ ok: true }, headers);
      }
    }

    if (subpath === "/firestop/material-doc" && method === "POST") {
      if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
      if (!(await isSlaAdmin(env, tenantId, sess))) return jsonResponse({ error: "Forbidden" }, headers, 403);
      const form = await request.formData();
      const file = form.get("file"); const pid = String(form.get("productId") || "");
      if (!file || !pid) return jsonResponse({ error: "file and productId required" }, headers, 400);
      const mats = await getFsMaterials(env, tenantId);
      const m = mats.find(x => x.id === pid);
      if (!m) return jsonResponse({ error: "Product not found" }, headers, 404);
      const key = `firestopspec/${tenantId}/${pid}/${Date.now()}-${safeName(file.name)}`;
      await env.JOB_FILES.put(key, file.stream(), { httpMetadata: { contentType: file.type || "application/octet-stream" } });
      m.docs = m.docs || [];
      m.docs.push({ id: "doc-" + crypto.randomUUID().slice(0, 8), name: file.name || safeName(file.name), key });
      await saveFsMaterials(env, tenantId, mats);
      return jsonResponse({ ok: true }, headers);
    }
    if (subpath === "/firestop/material-doc-delete" && method === "POST") {
      if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
      if (!(await isSlaAdmin(env, tenantId, sess))) return jsonResponse({ error: "Forbidden" }, headers, 403);
      const b = await readJson(request);
      const mats = await getFsMaterials(env, tenantId);
      const m = mats.find(x => x.id === b.productId);
      if (m) { const d = (m.docs || []).find(x => x.id === b.docId); if (d) { try { await env.JOB_FILES.delete(d.key); } catch {} m.docs = m.docs.filter(x => x.id !== b.docId); await saveFsMaterials(env, tenantId, mats); } }
      return jsonResponse({ ok: true }, headers);
    }

    // Stream a spec doc / a seal photo (session OR signed link).
    if (subpath === "/firestop/spec-file" || subpath === "/firestop/photo-file") {
      const key = searchParams.get("key") || "";
      if (!sess && !(await verifyFileSig(env, key, searchParams))) return jsonResponse({ error: "Link expired or invalid" }, headers, 403);
      const obj = await env.JOB_FILES.get(key);
      if (!obj) return new Response("Not found", { status: 404, headers });
      const h = new Headers(headers); obj.writeHttpMetadata(h); h.set("Cache-Control", "private, max-age=300");
      return new Response(obj.body, { status: 200, headers: h });
    }

    // The job's firestop record (+ header defaults + presets for the form).
    if (subpath === "/firestop/record") {
      if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
      const jobId = method === "GET" ? searchParams.get("jobId") : null;
      if (method === "GET") {
        const job = await getJob(env, tenantId, jobId);
        if (!job) return jsonResponse({ error: "Job not found" }, headers, 404);
        const cfg = await getFsConfig(env, tenantId);
        const rec = job.firestop || {};
        // Sensible header defaults the engineer can override.
        const installer = rec.installer || (job.assignedTo || (sess.user && sess.user.username) || "");
        const siteAddress = rec.siteAddress || [job.siteName, job.address, job.postcode].filter(Boolean).join(", ") || job.siteName || "";
        const now = new Date();
        const dflt = {
          company: cfg.company, sealCategory: cfg.sealCategory, declaration: cfg.declaration,
          installer, siteAddress, dateOfIssue: `${padRef2(now.getUTCDate())}/${padRef2(now.getUTCMonth() + 1)}/${now.getUTCFullYear()}`,
          nextRef: padRef(cfg.nextRef),
        };
        return jsonResponse({ record: rec, defaults: dflt, firestopping: !!job.firestopping }, headers);
      }
      if (method === "POST") {
        const b = await readJson(request);
        const job = await getJob(env, tenantId, b.jobId);
        if (!job) return jsonResponse({ error: "Job not found" }, headers, 404);
        const rec = (b.record && typeof b.record === "object") ? b.record : {};
        // Assign the next sequential RIA number on first save if none typed.
        if (!String(rec.ref || "").trim()) {
          const cfg = await getFsConfig(env, tenantId);
          rec.ref = padRef(cfg.nextRef);
          cfg.nextRef = (parseInt(cfg.nextRef, 10) || 1) + 1;
          await saveFsConfig(env, tenantId, cfg);
        }
        job.firestop = rec;
        job.updatedAt = new Date().toISOString();
        await saveJob(env, tenantId, job);
        return jsonResponse({ ok: true, record: rec }, headers);
      }
    }

    // Upload / delete a seal photo (or the signature, sealId "_sig").
    if (subpath === "/firestop/photo" && method === "POST") {
      if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
      const form = await request.formData();
      const file = form.get("file");
      const jobId = String(form.get("jobId") || ""); const sealId = String(form.get("sealId") || "s").replace(/[^\w-]/g, "");
      const stage = String(form.get("stage") || "before").replace(/[^\w-]/g, "");
      if (!file || !jobId) return jsonResponse({ error: "file and jobId required" }, headers, 400);
      const key = `firestop/${tenantId}/${jobId}/${sealId}/${stage}-${Date.now()}.jpg`;
      await env.JOB_FILES.put(key, file.stream(), { httpMetadata: { contentType: file.type || "image/jpeg" } });
      return jsonResponse({ ok: true, key, url: await signedFileUrl(env, url.origin, "/sla/firestop/photo-file", key, 86400) }, headers);
    }
    if (subpath === "/firestop/photo-delete" && method === "POST") {
      if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
      const b = await readJson(request);
      const key = String(b.key || "");
      if (key.startsWith(`firestop/${tenantId}/`)) { try { await env.JOB_FILES.delete(key); } catch {} }
      return jsonResponse({ ok: true }, headers);
    }

    // Build the completed RIA PDF (used by /pdf and inside /bundle).
    const buildJobPdf = async (job) => {
      const rec = job.firestop || {};
      const seals = await Promise.all((rec.seals || []).map(async s => ({
        sealRef: s.sealRef || rec.ref, date: s.date, by: s.by, location: s.location, aperture: s.aperture,
        frp: s.frp, manufacturer: s.manufacturer, componentName: s.componentName, comments: s.comments,
        beforePhotos: (await Promise.all((s.beforePhotos || []).map(r2Bytes))).filter(Boolean),
        afterPhotos: (await Promise.all((s.afterPhotos || []).map(r2Bytes))).filter(Boolean),
      })));
      const signature = rec.signatureKey ? await r2Bytes(rec.signatureKey) : null;
      let logo = null; try { logo = logoBytes(); } catch {}
      return buildFirestopPdf({
        ref: rec.ref, dateOfIssue: rec.dateOfIssue, company: rec.company, installer: rec.installer,
        siteAddress: rec.siteAddress, sealCategory: rec.sealCategory, declaration: rec.declaration,
        signature, seals,
      }, { logo });
    };

    if (subpath === "/firestop/pdf" && method === "GET") {
      if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
      const job = await getJob(env, tenantId, searchParams.get("jobId"));
      if (!job) return jsonResponse({ error: "Job not found" }, headers, 404);
      const pdf = await buildJobPdf(job);
      const fn = `RIA form ${(job.firestop && job.firestop.ref) || job.helpdeskRef || job.id}.pdf`;
      return new Response(pdf.buffer, { status: 200, headers: { ...headers, "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${fn.replace(/[^\w.\- ]+/g, "_")}"`, "Cache-Control": "no-store" } });
    }

    if (subpath === "/firestop/bundle" && method === "GET") {
      if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
      const job = await getJob(env, tenantId, searchParams.get("jobId"));
      if (!job) return jsonResponse({ error: "Job not found" }, headers, 404);
      const rec = job.firestop || {};
      const pdf = await buildJobPdf(job);
      const refName = (rec.ref || job.helpdeskRef || job.id);
      const files = [{ name: `RIA form ${safeName(refName)}.pdf`, data: pdf }];
      // Product specification subfolder: every preset product used on the job.
      const mats = await getFsMaterials(env, tenantId);
      const usedIds = new Set();
      (rec.seals || []).forEach(s => (s.productIds || []).forEach(id => usedIds.add(id)));
      const seen = new Set();
      for (const id of usedIds) {
        const m = mats.find(x => x.id === id); if (!m) continue;
        for (const d of m.docs || []) {
          if (seen.has(d.key)) continue; seen.add(d.key);
          const bytes = await r2Bytes(d.key); if (!bytes) continue;
          files.push({ name: `Product specification/${safeName([m.manufacturer, m.name].filter(Boolean).join(" "))} - ${safeName(d.name)}`, data: bytes });
        }
      }
      const zip = buildZip(files);
      const zn = `Firestopping ${safeName(refName)}.zip`;
      return new Response(zip.buffer, { status: 200, headers: { ...headers, "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${zn.replace(/[^\w.\- ]+/g, "_")}"`, "Cache-Control": "no-store" } });
    }

    return jsonResponse({ error: "Unknown firestop route" }, headers, 404);
  }

  /* GET /sla/sheet-config — which fields appear on the Job Sheet's Mostlane vs
     Client copies (global, not per-job). Any session may read (job-pdf.html
     needs it); SLA admin may replace it. */
  if (subpath === "/sheet-config") {
    if (method === "GET") return jsonResponse({ fields: await getSheetConfig(env, tenantId) }, headers);
    if (method === "POST") {
      if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
      if (!(await isSlaAdmin(env, tenantId, sess))) return jsonResponse({ error: "Forbidden" }, headers, 403);
      const body = await readJson(request);
      return jsonResponse({ ok: true, fields: await setSheetConfig(env, tenantId, (body && body.fields) || body) }, headers);
    }
  }

  /* POST /sla/categories/delete — remove a category. Any jobs still in it are
     first moved to `moveTo` (a built-in status or another category), so nothing
     is orphaned. {name, moveTo}. */
  if (subpath === "/categories/delete" && method === "POST") {
    if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
    if (!(await isSlaAdmin(env, tenantId, sess))) return jsonResponse({ error: "Forbidden" }, headers, 403);
    const body = await readJson(request);
    const name = String(body?.name || "").trim();
    const moveTo = String(body?.moveTo || "Pending").trim() || "Pending";
    if (!name) return jsonResponse({ error: "name required" }, headers, 400);
    const who = (sess.user && sess.user.username) || "system";
    const now = new Date().toISOString();
    const jobs = await listJobs(env, tenantId);
    let moved = 0;
    for (const job of jobs) {
      if (String(job.status || "").toLowerCase() !== name.toLowerCase()) continue;
      job.status = moveTo;
      job.statusHistory = Array.isArray(job.statusHistory) ? job.statusHistory : [];
      job.statusHistory.push({ status: moveTo, at: now, by: who });
      if (moveTo === "Closed Jobs" && !job.closedAt) job.closedAt = now;
      job.updatedAt = now;
      await saveJob(env, tenantId, job);
      moved++;
    }
    const cats = (await getCategories(env, tenantId)).filter(c => c.name.toLowerCase() !== name.toLowerCase());
    await setCategories(env, tenantId, cats);
    return jsonResponse({ ok: true, moved, categories: cats }, headers);
  }

  /* GET /sla/holds/pending — jobs an engineer has parked "On Hold" that are
     waiting for an admin to approve. Feeds the Inbox approval queue. */
  if (subpath === "/holds/pending" && method === "GET") {
    if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
    if (!(await isSlaAdmin(env, tenantId, sess))) return jsonResponse({ error: "Forbidden" }, headers, 403);
    const jobs = await listJobs(env, tenantId);
    const holds = jobs
      .filter(j => j.hold && j.hold.approval && j.hold.approval.state === "pending")
      .map(j => ({
        id: j.id, ref: j.helpdeskRef || j.id, site: j.siteName || j.siteCode || "",
        reason: (j.hold && j.hold.reason) || "", needs: (j.hold && j.hold.needs) || "",
        requestedBy: j.hold.approval.requestedBy || "", requestedAt: j.hold.approval.requestedAt || ""
      }))
      .sort((a, b) => String(a.requestedAt).localeCompare(String(b.requestedAt)));
    return jsonResponse({ ok: true, holds }, headers);
  }

  /* GET /sla/safety/open — jobs an engineer flagged "can't proceed safely",
     waiting for the office to action. Feeds the Inbox safety queue. */
  if (subpath === "/safety/open" && method === "GET") {
    if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
    if (!(await isSlaAdmin(env, tenantId, sess))) return jsonResponse({ error: "Forbidden" }, headers, 403);
    const jobs = await listJobs(env, tenantId);
    const flags = jobs
      .filter(j => j.raBlock && j.raBlock.state === "open")
      .map(j => ({
        id: j.id, ref: j.helpdeskRef || j.id, site: j.siteName || j.siteCode || "",
        reason: j.raBlock.reason || "", items: j.raBlock.items || [], by: j.raBlock.by || "", at: j.raBlock.at || ""
      }))
      .sort((a, b) => String(a.at).localeCompare(String(b.at)));
    return jsonResponse({ ok: true, flags }, headers);
  }

  /* POST /sla/inbound — machine-to-machine job intake (the Zapier email
     parser). PUBLIC route (no portal session): guarded by the JOBS_INBOUND_TOKEN
     secret sent as "Authorization: Bearer <token>". Same create/update logic as
     the office's add-job (upserts by reference — a re-sent email updates rather
     than duplicates), with zap-friendly slack on priority/date formats. */
  // GET /sla/inbound — connection self-check (no secret leaked): says whether a
  // token is configured and gives an 8-char fingerprint of it, so a mismatch
  // between the dashboard secret and the sender's token is diagnosable.
  if (subpath === "/inbound" && method === "GET") {
    const secret = (env.JOBS_INBOUND_TOKEN || "").trim().replace(/^Bearer\s+/i, "").trim();
    let fp = null;
    if (secret) {
      const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
      fp = [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 8);
    }
    return jsonResponse({ ok: true, configured: !!secret, tokenFingerprint: fp,
      use: "POST JSON with header Authorization: Bearer <token>" }, headers);
  }

  if (subpath === "/inbound" && method === "POST") {
    // Tolerate the two classic dashboard paste slips: stray whitespace/newline
    // around the secret, and the word "Bearer " pasted into the secret box.
    const secret = (env.JOBS_INBOUND_TOKEN || "").trim().replace(/^Bearer\s+/i, "").trim();
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

    // Email parsers can smuggle invisible characters (\r, tabs, zero-width
    // spaces) into the reference — and the reference becomes the job id, so
    // scrub them and collapse whitespace runs. Visible characters are kept.
    const cleanRef = String(b.reference || "")
      .replace(/[\u0000-\u001F\u007F\u00A0\u200B-\u200D\uFEFF]/g, " ")
      .replace(/\s+/g, " ").trim();
    const payload = {
      reference: cleanRef || undefined,
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
    const before = beforeId ? await d1Retry(() => getJob(env, tenantId, beforeId)) : null;
    const job = await d1Retry(() => createOrUpdateJobFromPayload(env, tenantId, payload));
    ctx?.waitUntil(reconcileRelease(env, tenantId, job).catch(() => {}));
    if (before?.releaseNotified) ctx?.waitUntil(notifyNewlyAssigned(env, tenantId, before, job));
    return jsonResponse({ ok: true, created: !before, id: job.id, reference: job.helpdeskRef, status: job.status, priority: job.priority, targetAt: job.targetAt }, headers, before ? 200 : 201);
  }

  /* POST /sla/jobs */
  if (subpath === "/jobs" && method === "POST") {
    const payload = await readJson(request);
    const beforeId = payload.id || payload.reference;
    const before = beforeId ? await d1Retry(() => getJob(env, tenantId, beforeId)) : null;
    const job = await d1Retry(() => createOrUpdateJobFromPayload(env, tenantId, payload));
    ctx?.waitUntil(reconcileRelease(env, tenantId, job).catch(() => {}));
    if (before?.releaseNotified) ctx?.waitUntil(notifyNewlyAssigned(env, tenantId, before, job));
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
      const catNames = (await getCategories(env, tenantId)).map(c => c.name);
      const s = normalizeStatus(statusFilter, catNames).toLowerCase();
      jobs = jobs.filter(j => j.status.toLowerCase() === s);
    }
    if (priorityFilter) jobs = jobs.filter(j => j.priority === priorityFilter);
    if (siteCodeFilter) jobs = jobs.filter(j => (j.siteCode || "") === siteCodeFilter);
    if (overdueFilter === "true") jobs = jobs.filter(j => j.sla?.state === "BREACHED");
    return jsonResponse(jobs, headers);
  }

  /* PUBLIC (signed) stream of an imported archive file — the <img>/links on the
     Job Archive page point here. In PUBLIC_ROUTES; sig-verified in-handler.
     MUST precede the admin `/archive` block (this path also startsWith /archive). */
  if (subpath === "/archive-file" && method === "GET") {
    const key = searchParams.get("key") || "";
    if (!key.startsWith("archivephoto/")) return jsonResponse({ error: "Bad key" }, headers, 400);
    if (!sess && !(await verifyFileSig(env, key, searchParams))) return jsonResponse({ error: "Link expired or invalid" }, headers, 403);
    // Edge-cache the bytes so repeat views (any admin) skip R2. Imported files
    // never change → immutable. Cache key is the bare key (sig-independent), so
    // every signed URL for the same file shares one cached copy.
    const cache = caches.default;
    const cacheKey = new Request(url.origin + "/sla/archive-file?key=" + encodeURIComponent(key));
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
    const obj = await env.JOB_FILES.get(key);
    if (!obj) return new Response("Not found", { status: 404, headers });
    const resp = new Response(obj.body, { status: 200, headers: {
      ...headers, "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
      "Content-Disposition": "inline", "Cache-Control": "public, max-age=31536000, immutable"
    }});
    ctx?.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  }

  /* ================= ARCHIVE (imported historical jobs) =================
     Historical jobs (e.g. the 22k Commusoft export) live in a SEPARATE table,
     sla_jobs_archive, that the live scheduler / day-view / dashboard never read
     — those paths load the whole sla_jobs table each request, so keeping the
     archive out of it means no slowdown to daily work. Self-migrating; all
     routes admin-gated (FullAccess | SLAAdmin). */
  if (subpath.startsWith("/archive")) {
    if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
    if (!(await isSlaAdmin(env, tenantId, sess))) return jsonResponse({ error: "Forbidden" }, headers, 403);
    await ensureArchive(env, tenantId);

    // POST /sla/archive/import — { jobs:[…] } upsert a batch (keyed by id).
    if (subpath === "/archive/import" && method === "POST") {
      const body = await readJson(request);
      const rows = Array.isArray(body?.jobs) ? body.jobs : [];
      if (!rows.length) return jsonResponse({ ok: false, error: "no jobs" }, headers, 400);
      const imported = await archiveImport(env, tenantId, rows);
      return jsonResponse({ ok: true, imported }, headers);
    }
    // GET /sla/archive/count
    if (subpath === "/archive/count" && method === "GET") {
      const r = await db.prepare("SELECT COUNT(*) AS n FROM sla_jobs_archive WHERE tenant_id=?").bind(tenantId).first();
      return jsonResponse({ ok: true, count: r?.n || 0 }, headers);
    }
    // POST /sla/archive/clear — wipe the archive (lets a bad import be redone).
    if (subpath === "/archive/clear" && method === "POST") {
      await db.prepare("DELETE FROM sla_jobs_archive WHERE tenant_id=?").bind(tenantId).run();
      return jsonResponse({ ok: true }, headers);
    }
    // GET /sla/archive?q=&limit=&offset= — paged text search (index-friendly LIKE).
    if (subpath === "/archive" && method === "GET") {
      const q = (searchParams.get("q") || "").trim().toLowerCase();
      const limit = Math.min(200, Math.max(1, parseInt(searchParams.get("limit") || "50", 10)));
      const offset = Math.max(0, parseInt(searchParams.get("offset") || "0", 10));
      let total, rows;
      // Space-separated terms are ANDed, so "0126 hatch" matches a job whose
      // store number and description each hold one of the words.
      const terms = q.split(/\s+/).map(t => t.replace(/[%_\\]/g, "")).filter(Boolean).slice(0, 8);
      if (terms.length) {
        const where = terms.map(() => "search LIKE ?").join(" AND ");
        const likes = terms.map(t => "%" + t + "%");
        total = (await db.prepare(`SELECT COUNT(*) AS n FROM sla_jobs_archive WHERE tenant_id=? AND ${where}`).bind(tenantId, ...likes).first())?.n || 0;
        ({ results: rows } = await db.prepare(`SELECT data FROM sla_jobs_archive WHERE tenant_id=? AND ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).bind(tenantId, ...likes, limit, offset).all());
      } else {
        total = (await db.prepare("SELECT COUNT(*) AS n FROM sla_jobs_archive WHERE tenant_id=?").bind(tenantId).first())?.n || 0;
        ({ results: rows } = await db.prepare("SELECT data FROM sla_jobs_archive WHERE tenant_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?").bind(tenantId, limit, offset).all());
      }
      return jsonResponse({ ok: true, total, limit, offset, jobs: (rows || []).map(r => JSON.parse(r.data)) }, headers);
    }

    /* ===== Imported job FILES (photos/signatures/PDFs migrated from Workever) =====
       Streamed from public S3 straight into R2 and keyed by MOS number. */
    await ensureArchiveFiles(env, tenantId);

    // POST /sla/archive/photos/import — { files:[{id,mos,name,url,type,bytes,kind,...}] }
    // Fetches each file from its (public) URL into R2 and records it. Idempotent:
    // files already present are skipped, so the caller can loop/resume freely.
    if (subpath === "/archive/photos/import" && method === "POST") {
      const body = await readJson(request);
      const files = Array.isArray(body?.files) ? body.files.filter(f => f && f.id && f.url) : [];
      if (!files.length) return jsonResponse({ ok: false, error: "no files" }, headers, 400);
      const result = await archivePhotosImport(env, tenantId, files);
      return jsonResponse({ ok: true, ...result }, headers);
    }
    // GET /sla/archive/photos/count — how many files are imported so far (+ bytes).
    if (subpath === "/archive/photos/count" && method === "GET") {
      const r = await db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS b FROM sla_archive_files WHERE tenant_id=?").bind(tenantId).first();
      return jsonResponse({ ok: true, count: r?.n || 0, bytes: r?.b || 0 }, headers);
    }
    // POST /sla/archive/backfill-sites — tag archived jobs with their store code
    // so their photos show under the matching site. Chunk-capped; loop on `remaining`.
    if (subpath === "/archive/backfill-sites" && method === "POST") {
      const r = await backfillArchiveSites(env, tenantId, 500);
      return jsonResponse({ ok: true, ...r }, headers);
    }
    // POST /sla/archive/unlink-sites — clear all site tags so linking can be redone.
    if (subpath === "/archive/unlink-sites" && method === "POST") {
      const res = await db.prepare("UPDATE sla_jobs_archive SET site_code=NULL WHERE tenant_id=?").bind(tenantId).run();
      return jsonResponse({ ok: true, cleared: res.meta?.changes || 0 }, headers);
    }
    // GET /sla/archive/site-stats[?code=32] — how the linking landed. With ?code,
    // returns that store's tagged-job + photo counts (the definitive diagnostic).
    if (subpath === "/archive/site-stats" && method === "GET") {
      const qc = searchParams.get("code");
      if (qc != null && qc !== "") {
        const code = digitsOf(qc);
        const { results: aj } = await db.prepare("SELECT id FROM sla_jobs_archive WHERE tenant_id=? AND site_code=?").bind(tenantId, code).all();
        const mos = (aj || []).map(r => r.id);
        let photos = 0;
        for (let i = 0; i < mos.length; i += 90) {
          const chunk = mos.slice(i, i + 90);
          const ph = chunk.map(() => "?").join(",");
          photos += (await db.prepare(`SELECT COUNT(*) AS n FROM sla_archive_files WHERE tenant_id=? AND kind='photo' AND mos IN (${ph})`).bind(tenantId, ...chunk).first())?.n || 0;
        }
        return jsonResponse({ ok: true, code, jobs: mos.length, photos, sampleMos: mos.slice(0, 5) }, headers);
      }
      const tagged = (await db.prepare("SELECT COUNT(*) AS n FROM sla_jobs_archive WHERE tenant_id=? AND site_code IS NOT NULL AND site_code<>'-' AND site_code<>''").bind(tenantId).first())?.n || 0;
      const stores = (await db.prepare("SELECT COUNT(DISTINCT site_code) AS n FROM sla_jobs_archive WHERE tenant_id=? AND site_code IS NOT NULL AND site_code<>'-' AND site_code<>''").bind(tenantId).first())?.n || 0;
      const untagged = (await db.prepare("SELECT COUNT(*) AS n FROM sla_jobs_archive WHERE tenant_id=? AND (site_code IS NULL OR site_code='')").bind(tenantId).first())?.n || 0;
      return jsonResponse({ ok: true, tagged, stores, untagged }, headers);
    }
    // POST /sla/archive/photos/clear — drop the file records (R2 objects are left;
    // re-import overwrites them). Lets a bad run be redone.
    if (subpath === "/archive/photos/clear" && method === "POST") {
      await db.prepare("DELETE FROM sla_archive_files WHERE tenant_id=?").bind(tenantId).run();
      return jsonResponse({ ok: true }, headers);
    }
    // GET /sla/archive/files?mos=MOS123 — a job's files with signed view URLs.
    if (subpath === "/archive/files" && method === "GET") {
      const mos = (searchParams.get("mos") || "").trim();
      if (!mos) return jsonResponse({ ok: true, files: [] }, headers);
      const { results } = await db.prepare(
        "SELECT id,r2_key,name,kind,type,bytes,taken_at,uploaded_by FROM sla_archive_files WHERE tenant_id=? AND mos=? ORDER BY kind, taken_at DESC"
      ).bind(tenantId, mos).all();
      const out = [];
      for (const r of results || []) {
        out.push({ id: r.id, name: r.name, kind: r.kind, type: r.type, bytes: r.bytes,
          takenAt: r.taken_at, by: r.uploaded_by,
          url: await signedFileUrl(env, url.origin, "/sla/archive-file", r.r2_key) });
      }
      return jsonResponse({ ok: true, mos, files: out }, headers);
    }

    return jsonResponse({ error: "Not found" }, headers, 404);
  }

  /* POST /sla/jobs/bulk-delete — remove many LIVE jobs at once (test-data
     cleanup). Admin-only. Chunk-capped per call (subrequest safety) and
     re-runnable: returns `remaining` so the caller loops until it hits 0.
     Must precede the generic /jobs/{id} matcher below. */
  if (subpath === "/jobs/bulk-delete" && method === "POST") {
    if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
    if (!(await isSlaAdmin(env, tenantId, sess))) return jsonResponse({ error: "Forbidden" }, headers, 403);
    const body = await readJson(request);
    const CAP = 300;
    let targetIds = Array.isArray(body?.ids) ? body.ids.map(String) : [];
    if (body?.all === true) {
      const { results } = await db.prepare("SELECT id FROM sla_jobs WHERE tenant_id=?").bind(tenantId).all();
      targetIds = (results || []).map(r => r.id);
    }
    const batch = targetIds.slice(0, CAP);
    let deleted = 0;
    for (const id of batch) {
      const res = await db.prepare("DELETE FROM sla_jobs WHERE tenant_id=? AND id=?").bind(tenantId, id).run();
      if (res.meta?.changes) deleted++;
      try {
        const listed = await env.JOB_FILES.list({ prefix: `jobs/${id}/` });
        for (const o of listed.objects || []) await env.JOB_FILES.delete(o.key);
      } catch {}
      await purgeUnverifiedCertsForJob(env, tenantId, id);
    }
    return jsonResponse({ ok: true, deleted, remaining: Math.max(0, targetIds.length - batch.length) }, headers);
  }

  /* POST /sla/jobs/legacy-fix — one-time cleanup of old email-intake jobs whose
     fields were mapped the wrong way round (fault text in the reference, the
     store in the description). Rewrites each matching job to the new layout:
       helpdeskRef = "Number - Street"  (e.g. "25886/1 - Gatwick Road")
       description = the fault text
       siteName    = the street,  siteCode = the number (if not already set)
     Preview-first: {apply:false} (default) returns before/after and writes
     nothing. Conservative + idempotent: only jobs that clearly match the old
     layout are touched (short store-like description + long fault-like
     reference, or the store sitting in siteName); already-clean or ambiguous
     jobs are skipped. The job id is never changed, so photos stay linked. */
  if (subpath === "/jobs/legacy-fix" && method === "POST") {
    if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
    if (!(await isSlaAdmin(env, tenantId, sess))) return jsonResponse({ error: "Forbidden" }, headers, 403);
    const body = await readJson(request);
    const apply = body?.apply === true;
    const isCleanRef = r => /^[0-9][0-9./-]*\s+-\s+\S/.test(String(r || "").trim());
    const reformat = store => {
      store = String(store || "").trim();
      let m = store.match(/^([0-9][0-9\/.\-]*)\s+(.+)$/);          // "25886/1 Gatwick Road"
      if (m) return { num: m[1], site: m[2].trim(), ref: m[1] + " - " + m[2].trim() };
      m = store.match(/^(.+?)[ ,]+([0-9][0-9\/.\-]*)$/);          // "Portsmouth, Copnor Road 331"
      if (m) { const site = m[1].trim().replace(/,+$/, ""); return { num: m[2], site, ref: m[2] + " - " + site }; }
      return { num: "", site: store, ref: store };
    };
    const jobs = await listJobs(env, tenantId);
    const changes = []; let changed = 0, skipped = 0;
    for (const job of jobs) {
      const ref = String(job.helpdeskRef || "").trim();
      const descr = String(job.description || "").trim();
      const site = String(job.siteName || "").trim();
      if (isCleanRef(ref)) { skipped++; continue; }                // already in the new layout
      let store = "";
      if (descr && descr.length <= 50 && /\d/.test(descr) && ref.length > 50) store = descr;   // store in description
      else if (site && /\d/.test(site) && ref.length > 50) store = site;                        // store in siteName
      if (!store) { skipped++; continue; }                         // ambiguous → leave it alone
      const rf = reformat(store);
      const before = { helpdeskRef: ref, description: descr, siteName: site, siteCode: job.siteCode || "" };
      const after = { helpdeskRef: rf.ref, description: ref, siteName: rf.site || site, siteCode: job.siteCode || rf.num || "" };
      changes.push({ id: job.id, before, after });
      if (apply) {
        job.helpdeskRef = after.helpdeskRef;
        job.description = after.description;
        job.siteName = after.siteName;
        if (!job.siteCode && rf.num) job.siteCode = rf.num;
        job.updatedAt = new Date().toISOString();
        await saveJob(env, tenantId, job);
        changed++;
      }
    }
    return jsonResponse({ ok: true, apply, total: jobs.length, matched: changes.length, changed, skipped, changes: changes.slice(0, 200) }, headers);
  }

  /* POST /sla/jobs/photo-flags — of the given jobs, which have photos? For the
     dashboard 📷 badge. "Has photos" = live files in R2 jobs/<id>/, OR imported
     archive photos matching the job's ref/id (a repeat visit to a historical
     job). One delimited R2 list + one indexed archive query — cheap. */
  if (subpath === "/jobs/photo-flags" && method === "POST") {
    if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
    const body = await readJson(request);
    const items = Array.isArray(body?.items) ? body.items : [];
    if (!items.length) return jsonResponse({ ok: true, ids: [] }, headers);
    // live: one delimited list yields the set of job folders that hold any file
    const live = new Set();
    try {
      let cursor;
      do {
        const r = await env.JOB_FILES.list({ prefix: "jobs/", delimiter: "/", cursor });
        for (const p of (r.delimitedPrefixes || [])) {
          const id = p.slice(5).replace(/\/$/, "");
          if (id) live.add(id);
        }
        cursor = r.truncated ? r.cursor : null;
      } while (cursor);
    } catch {}
    // archive: which of these refs have imported archive files
    await ensureArchiveFiles(env, tenantId);
    const refs = [...new Set(items.flatMap(it => [it.id, it.ref].filter(Boolean).map(String)))];
    const archHas = new Set();
    for (let i = 0; i < refs.length; i += 90) {
      const chunk = refs.slice(i, i + 90);
      const ph = chunk.map(() => "?").join(",");
      const { results } = await db.prepare(`SELECT DISTINCT mos FROM sla_archive_files WHERE tenant_id=? AND mos IN (${ph})`).bind(tenantId, ...chunk).all();
      for (const r of results || []) archHas.add(String(r.mos));
    }
    const ids = items.filter(it => live.has(String(it.id)) || archHas.has(String(it.ref)) || archHas.has(String(it.id))).map(it => it.id);
    return jsonResponse({ ok: true, ids }, headers);
  }

  /* GET /sla/jobs/for-engineer (must precede /jobs/{id}) */
  if (subpath === "/jobs/for-engineer" && method === "GET") {
    // Match if the engineer is ANY of the job's assigned engineers. Both sides
    // are normalised the same way so "John Thorn" matches "john.thorn".
    const engineer = normId(searchParams.get("engineer"));
    const date = searchParams.get("date");
    const all = await listJobs(env, tenantId);
    let jobs = all.filter(j => assignedList(j).some(a => normId(a) === engineer));
    // Hide jobs whose release time hasn't arrived / whose turn in the queue
    // hasn't come — the engineer simply doesn't see them yet.
    jobs = jobs.filter(j => releaseVisibleNow(j, all));
    if (date) {
      jobs = jobs.filter(j => {
        if (!j.scheduledAt) return false;
        return new Date(j.scheduledAt).toISOString().slice(0, 10) === date;
      });
    }
    // This endpoint is always "one engineer's own jobs", so serve THEIR status:
    // on a shared (multi-engineer) job that's their own slice, else the shared
    // status. Overwriting `status` means every list view (route, jobs, inbox,
    // my-day) shows the right thing with no page change.
    return jsonResponse(jobs.map(j => {
      const ms = effStatus(j, engineer);
      return { ...decorateJobWithLiveSla(j), status: ms, myStatus: ms };
    }), headers);
  }

  /* POST /sla/route-optimize — order ONE engineer's jobs for a day into the most
     efficient round trip (home → jobs → home). Google Distance Matrix gives real
     driving times/miles (haversine estimate is the no-key fallback); a
     nearest-neighbour + 2-opt pass finds the shortest baseline; then Claude
     re-orders to honour anomalies typed in plain English ("the Tesco job must be
     at 14:00", "do Southampton last"). Returns a PREVIEW only — the client writes
     the new times back when the office confirms. SLA-admin only. */
  if (subpath === "/route-optimize" && method === "POST") {
    if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
    if (!(await isSlaAdmin(env, tenantId, sess)))
      return jsonResponse({ error: "Only SLA admins can optimise a route." }, headers, 403);
    const roBody = await readJson(request);
    // Soft daily cap applies to the AI re-order; over the cap we still return the
    // shortest-driving (Google/estimate) order, just without the AI pass.
    const roCap = await aiCapCheck(env, tenantId);
    if (roCap.capped) roBody.useAI = false;
    const roRes = await optimiseEngineerRoute(env, tenantId, roBody);
    if (roRes.aiUsed) ctx?.waitUntil(bumpAiUsage(env, tenantId, "route-optimize"));
    if (roCap.capped) (roRes.warnings = roRes.warnings || []).push(`Daily AI limit reached (${roCap.cap}) — used shortest-driving order without the AI pass.`);
    return jsonResponse(roRes, headers);
  }

  /* POST /sla/auto-schedule — auto-build a day: assign + order loose jobs across
     one or many engineers (skill-preferred, capacity-limited). Preview only.
     Deterministic (Distance Matrix / estimate) — no Claude, so no AI cost. */
  if (subpath === "/auto-schedule" && method === "POST") {
    if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
    if (!(await isSlaAdmin(env, tenantId, sess)))
      return jsonResponse({ error: "Only SLA admins can auto-schedule a day." }, headers, 403);
    return jsonResponse(await autoScheduleDay(env, tenantId, await readJson(request)), headers);
  }

  /* POST /sla/auto-schedule/record — stash the batch of jobs the office just
     booked in from an auto-day, so it can be reverted in one tap. SLA admin. */
  if (subpath === "/auto-schedule/record" && method === "POST") {
    if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
    if (!(await isSlaAdmin(env, tenantId, sess))) return jsonResponse({ error: "SLA admins only." }, headers, 403);
    const b = await readJson(request);
    const jobIds = Array.isArray(b.jobIds) ? b.jobIds.map(String).slice(0, 500) : [];
    if (!jobIds.length) return jsonResponse({ ok: false, error: "No jobs to record." }, headers, 400);
    const rec = {
      date: String(b.date || todayStr()),
      jobIds,
      engineers: Array.isArray(b.engineers) ? b.engineers.map(String).slice(0, 40) : [],
      by: String(b.by || (sess.user && sess.user.username) || ""),
      at: new Date().toISOString(),
    };
    try { await tenantDB(env, tenantId).prepare("INSERT INTO app_config (tenant_id, key, value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(tenantId, "sla:lastautoday:" + tenantId, JSON.stringify(rec)).run(); } catch {}
    return jsonResponse({ ok: true }, headers);
  }

  /* GET /sla/auto-schedule/last — the last recorded auto-day batch (for the
     scheduler's "↩ Undo last auto-day" button). SLA admin. */
  if (subpath === "/auto-schedule/last" && method === "GET") {
    if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
    if (!(await isSlaAdmin(env, tenantId, sess))) return jsonResponse({ error: "SLA admins only." }, headers, 403);
    let rec = null;
    try { const row = await tenantDB(env, tenantId).prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(tenantId, "sla:lastautoday:" + tenantId).first(); if (row) rec = JSON.parse(row.value); } catch {}
    if (!rec || !Array.isArray(rec.jobIds) || !rec.jobIds.length) return jsonResponse({ ok: false }, headers);
    return jsonResponse({ ok: true, date: rec.date, jobIds: rec.jobIds, engineers: rec.engineers || [], by: rec.by || "", at: rec.at || "" }, headers);
  }

  /* POST /sla/auto-schedule/undo — revert the last auto-day: un-schedule +
     un-assign ONLY the jobs still exactly as the auto-day left them (status
     "Scheduled" and still on that date). A job an engineer has since started,
     or the office has moved/reassigned, is left untouched. SLA admin. */
  if (subpath === "/auto-schedule/undo" && method === "POST") {
    if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
    if (!(await isSlaAdmin(env, tenantId, sess))) return jsonResponse({ error: "SLA admins only." }, headers, 403);
    let rec = null;
    try { const row = await tenantDB(env, tenantId).prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(tenantId, "sla:lastautoday:" + tenantId).first(); if (row) rec = JSON.parse(row.value); } catch {}
    if (!rec || !Array.isArray(rec.jobIds) || !rec.jobIds.length) return jsonResponse({ ok: false, error: "Nothing to undo." }, headers, 400);
    const now = new Date().toISOString();
    let reverted = 0, skipped = 0;
    for (const id of rec.jobIds) {
      let job = null;
      try { job = await getJob(env, tenantId, id); } catch {}
      // Skip anything that's gone, moved off the recorded date, or that an
      // engineer has already started (status past "Scheduled").
      if (!job || job.status !== "Scheduled" || String(job.scheduledAt || "").slice(0, 10) !== String(rec.date).slice(0, 10)) { skipped++; continue; }
      job.scheduledAt = null;
      job.scheduledEnd = null;
      job.assignedTo = "";
      job.assignedEngineers = [];
      job.engStatus = undefined;
      job.status = "Pending";
      (job.statusHistory ||= []).push({ status: "Pending", at: now, by: "undo-auto-day" });
      job.updatedAt = now;
      try { await saveJob(env, tenantId, job); reverted++; } catch { skipped++; }
    }
    // Consume the record so a second Undo doesn't re-fire on already-reverted jobs.
    try { await tenantDB(env, tenantId).prepare("DELETE FROM app_config WHERE tenant_id=? AND key=?").bind(tenantId, "sla:lastautoday:" + tenantId).run(); } catch {}
    return jsonResponse({ ok: true, reverted, skipped }, headers);
  }

  /* GET /sla/duration-insights — the learned duration model + overruns + a
     review sample (allocated vs actual vs AI estimate). SLA admin. */
  if (subpath === "/duration-insights" && method === "GET") {
    if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
    if (!(await isSlaAdmin(env, tenantId, sess)))
      return jsonResponse({ error: "SLA admins only." }, headers, 403);
    const dur = await estimateJobDurations(env, tenantId);
    const ai = await loadAiDurCache(env, tenantId);
    const recent = (dur.recent || []).map(r => ({ ...r, ai: ai[r.id] ?? null }));
    return jsonResponse({
      ok: true,
      model: { typical: dur.typical, byPriority: dur.byPriority, sampleCount: dur.sampleCount, actualCount: dur.actualCount },
      overruns: dur.overruns, recent, aiCount: Object.keys(ai).length,
    }, headers);
  }

  /* POST /sla/duration-clear-ai — forget the cached AI estimates so they're
     recomputed on the next auto-day (e.g. after editing descriptions). SLA admin. */
  if (subpath === "/duration-clear-ai" && method === "POST") {
    if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
    if (!(await isSlaAdmin(env, tenantId, sess)))
      return jsonResponse({ error: "SLA admins only." }, headers, 403);
    try { await tenantDB(env, tenantId).prepare("DELETE FROM app_config WHERE tenant_id=? AND key=?").bind(tenantId, "sla:aidur:" + tenantId).run(); } catch {}
    return jsonResponse({ ok: true }, headers);
  }

  /* GET /sla/jobs/nearby?jobId=&engineer=&radius= — same-site + within-radius OPEN
     jobs, for the allocation-time "whilst you're here…" suggestion pop-up. */
  if (subpath === "/jobs/nearby" && method === "GET") {
    if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
    const jobId = searchParams.get("jobId");
    if (!jobId) return jsonResponse({ ok: false, error: "jobId required" }, headers, 400);
    const def = await getNearbyRadius(env, tenantId);
    const radius = Math.max(0.5, Math.min(50, Number(searchParams.get("radius")) || def));
    return jsonResponse(await nearbyForJob(env, tenantId, jobId, searchParams.get("engineer") || "", radius), headers);
  }
  /* POST /sla/jobs/nearby-radius {radius} — save the office's default radius (SLA admin). */
  if (subpath === "/jobs/nearby-radius" && method === "POST") {
    if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
    if (!(await isSlaAdmin(env, tenantId, sess))) return jsonResponse({ error: "Forbidden" }, headers, 403);
    const b = await readJson(request);
    const n = Math.max(0.5, Math.min(50, Number(b.radius) || 5));
    const db = tenantDB(env, tenantId);
    await db.prepare("INSERT INTO app_config (tenant_id, key, value) VALUES (?, 'sla:nearbyRadius', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(tenantId, String(n)).run();
    return jsonResponse({ ok: true, radius: n }, headers);
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
    // ── Day-end protection ──────────────────────────────────────────────────
    // An engineer can't finish their day while jobs are still outstanding:
    //   • any job they've actively started (Travelling / In Progress), any date;
    //   • any job booked for TODAY they haven't started (Scheduled/Pending).
    // Parked jobs (On Hold / Quote — which already required their packs to set)
    // and finished ones (Complete / Closed / done-categories) don't block.
    // An office admin can pass force:true to close a stuck day.
    const engNorm = normId(b.engineer);
    let force = false;
    if (b.force === true) {
      const p = await permissionsFor(env, tenantId, sess.user.username);
      force = p.FullAccess === "Yes" || p.SLAAdmin === "Yes";
    }
    if (!force) {
      try {
        const all = await listJobs(env, tenantId);
        const doneNames = new Set((await getCategories(env, tenantId)).filter(c => c.done).map(c => String(c.name).toLowerCase()));
        const finished = s => { const v = String(s || "").toLowerCase(); return v === "complete" || v === "closed jobs" || v === "closed" || v === "invoiced" || v === "cancelled" || doneNames.has(v); };
        const parked = s => { const v = String(s || "").toLowerCase(); return v === "on hold" || v === "quote" || v === "order"; };
        const outstanding = [];
        for (const j of all) {
          if (!assignedList(j).some(a => normId(a) === engNorm)) continue;
          if (!releaseVisibleNow(j, all)) continue;
          const st = String(effStatus(j, engNorm) || "");
          if (finished(st) || parked(st)) continue;
          const active = /^(travelling|in progress)$/i.test(st);
          const today = j.scheduledAt && new Date(j.scheduledAt).toISOString().slice(0, 10) === date;
          if (active || today) outstanding.push({ id: j.id, ref: j.helpdeskRef || j.id, status: st });
        }
        if (outstanding.length) {
          return jsonResponse({
            error: "You still have " + outstanding.length + " unfinished job" + (outstanding.length === 1 ? "" : "s") + " today — finish them before ending your day.",
            outstanding
          }, headers, 409);
        }
      } catch (e) { /* the check must never make clock-off impossible on an internal error */ }
    }
    // COALESCE keeps the first press's mileage/fuel when a resumed day is
    // ended again without re-typing them.
    await db.prepare(
      "UPDATE shifts SET clock_off_at=?, clock_off_gps=COALESCE(?, clock_off_gps), end_mileage=COALESCE(?, end_mileage), fuel=COALESCE(?, fuel) WHERE tenant_id=? AND username=? AND date=?"
    ).bind(new Date().toISOString(), b.gps || null, b.endMileage ?? null, b.fuel || null, db.tenantId, b.engineer, date).run();
    return jsonResponse({ ok: true, shift: await getShift(env, tenantId, b.engineer, date) }, headers);
  }
  /* POST /sla/shift/resume — reopen a finished day (emergency call-out after
     clocking off): clears clock_off_at so the timer runs again from the
     original start. The earlier clock-off press stays in the audit log. */
  if (subpath === "/shift/resume" && method === "POST") {
    const b = await readJson(request);
    if (!b.engineer) return jsonResponse({ error: "engineer required" }, headers, 400);
    const date = b.date || todayStr();
    const row = await getShift(env, tenantId, b.engineer, date);
    if (!row || !row.clock_on_at) return jsonResponse({ error: "No day to resume — start your day instead." }, headers, 404);
    await db.prepare(
      "UPDATE shifts SET clock_off_at=NULL WHERE tenant_id=? AND username=? AND date=?"
    ).bind(db.tenantId, b.engineer, date).run();
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

  /* GET /sla/jobs-diag?id=… — admin diagnostic: how a job id is really stored.
     Compares the exact by-id lookup with a scan of every job, showing each
     candidate id in hex so invisible characters are visible. */
  if (subpath === "/jobs-diag" && method === "GET") {
    if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
    const perms = await permissionsFor(env, tenantId, sess.user.username);
    if (perms.FullAccess !== "Yes") return jsonResponse({ error: "Forbidden" }, headers, 403);
    const q = safeDecode(searchParams.get("id") || "");
    const hexOf = s => [...String(s)].map(c => c.codePointAt(0).toString(16).padStart(2, "0")).join(" ");
    const byId = q ? await getJob(env, tenantId, q) : null;
    const needle = q.toLowerCase();
    const near = (await listJobs(env, tenantId))
      .filter(j => String(j.id).toLowerCase().includes(needle) || String(j.helpdeskRef || "").toLowerCase().includes(needle))
      .slice(0, 5)
      .map(j => ({ id: j.id, idHex: hexOf(j.id), ref: j.helpdeskRef, status: j.status, exactMatch: j.id === q }));
    return jsonResponse({ ok: true, lookedUp: q, lookedUpHex: hexOf(q), foundById: !!byId, similar: near }, headers);
  }

  /* PUT /sla/job/{id} (scheduler drag/drop) */
  if (subpath.startsWith("/job/") && method === "PUT") {
    const id = safeDecode(subpath.split("/").filter(Boolean)[1]);
    if (!id) return jsonResponse({ error: "Missing ID" }, headers, 400);
    const body = await readJson(request);
    const patch = {
      scheduledAt: body.scheduledStart || body.scheduledAt,
      scheduledEnd: body.scheduledEnd,
      durationMinutes: body.durationMinutes,
      assignedEngineers: Array.isArray(body.assignedEngineers)
        ? body.assignedEngineers.filter(Boolean)
        : (body.assignedTo !== undefined ? (body.assignedTo ? [body.assignedTo] : []) : undefined),
      release: body.release,
      changedBy: body.changedBy || "scheduler"
    };
    const before = await getJob(env, tenantId, id);
    const updated = await patchJob(env, tenantId, id, patch, ctx);
    if (updated) ctx?.waitUntil(reconcileRelease(env, tenantId, updated).catch(() => {}));
    if (updated && before?.releaseNotified) ctx?.waitUntil(notifyNewlyAssigned(env, tenantId, before, updated));
    if (updated) ctx?.waitUntil(trackJobTime(env, tenantId, sess?.user?.username, before, updated));
    return updated
      ? jsonResponse(decorateJobWithLiveSla(updated), headers)
      : jsonResponse({ error: "Not found" }, headers, 404);
  }

  /* /sla/jobs/{id}/... */
  if (subpath.startsWith("/jobs/")) {
    const parts = subpath.split("/").filter(Boolean); // [jobs, id, sub]
    // Pages send encodeURIComponent(job.id); pathname keeps it percent-encoded.
    // Decode so ids with spaces/commas/etc. (e.g. zap references) resolve.
    const id = safeDecode(parts[1]);
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
      // A truncated multipart body (an upload cut off on weak signal) makes
      // request.formData() throw "No initial boundary string". That's a BAD
      // REQUEST from a dropped connection, not a server fault — return 400 so it
      // isn't logged as a 500 error/alert; the client keeps the photo and retries.
      let form;
      try { form = await request.formData(); }
      catch { return jsonResponse({ error: "Upload was incomplete — please retry.", incomplete: true }, headers, 400); }
      const file = form.get("file");
      if (!filename || !file) return jsonResponse({ error: "Missing file" }, headers, 400);
      // Before / During / After label the engineer picks with the photo slider.
      const stageIn = searchParams.get("stage");
      const stage = PHOTO_STAGES.includes(stageIn) ? stageIn : "";
      const key = `jobs/${id}/photos/${filename}`;
      // Uploading by a stable filename makes an offline retry idempotent — the
      // same photo overwrites its own object rather than creating a duplicate.
      await env.JOB_FILES.put(key, file.stream(), {
        httpMetadata: { contentType: file.type },
        customMetadata: stage ? { stage } : undefined
      });
      // A client-shrunk thumbnail rides along → stored as <key>.thumb so the photo
      // grid loads a tiny image instead of the full-res one.
      const thumb = form.get("thumb");
      if (thumb && typeof thumb.stream === "function") {
        try { await env.JOB_FILES.put(key + ".thumb", thumb.stream(), { httpMetadata: { contentType: thumb.type || "image/jpeg" } }); } catch {}
      }
      return jsonResponse({ ok: true, publicURL: r2Url(env, key), stage }, headers, 201);
    }

    // GET /sla/jobs/{id}/files  -> list photos (with their Before/During/After tag)
    if (parts[2] === "files" && method === "GET") {
      const listed = await env.JOB_FILES.list({ prefix: `jobs/${id}/photos/`, include: ["customMetadata"] });
      // Admin recategorisations live in job.photoStages (overrides the R2 tag set at
      // upload) so a photo can be re-stamped without rewriting the R2 object.
      let overrides = {};
      try { const j = await getJob(env, tenantId, id); overrides = (j && j.photoStages) || {}; } catch {}
      // A small <key>.thumb rides alongside each photo (client-generated on upload,
      // or backfilled). The grid loads the thumb, not the full-res original, so it
      // stays fast even with many photos. Filter out the .thumb objects themselves.
      const objs = (listed.objects || []).filter(o => !o.key.endsWith(".thumb"));
      const thumbSet = new Set((listed.objects || []).filter(o => o.key.endsWith(".thumb")).map(o => o.key));
      const files = [];
      for (const o of objs) {
        const name = o.key.split("/").pop();
        files.push({
          name,
          key: o.key,
          publicURL: r2Url(env, o.key),
          thumb: await signedFileUrl(env, url.origin, "/sla/site/thumb", o.key),
          hasThumb: thumbSet.has(o.key + ".thumb"),
          stage: overrides[name] || (o.customMetadata && o.customMetadata.stage) || ""
        });
      }
      return jsonResponse({ files }, headers);
    }

    // POST /sla/jobs/{id}/audit-photo  -> attach a photo to a site-audit checklist
    // item. stage=ref (office reference/before) OR stage=done (engineer completion,
    // which marks the item complete). Multipart: file, thumb?, itemId, stage.
    if (parts[2] === "audit-photo" && method === "POST") {
      if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
      let form;
      try { form = await request.formData(); }
      catch { return jsonResponse({ error: "Upload was incomplete — please retry.", incomplete: true }, headers, 400); }
      const file = form.get("file");
      const itemId = String(form.get("itemId") || searchParams.get("itemId") || "");
      const stage = (String(form.get("stage") || searchParams.get("stage") || "done") === "ref") ? "ref" : "done";
      if (!file || !itemId) return jsonResponse({ error: "Missing file or itemId" }, headers, 400);
      const job = await getJob(env, tenantId, id);
      if (!job) return jsonResponse({ error: "Not found" }, headers, 404);
      const item = (job.auditItems || []).find(it => it && it.id === itemId);
      if (!item) return jsonResponse({ error: "Unknown audit item" }, headers, 404);
      const fn = `${stage}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
      const key = `jobs/${id}/audit/${itemId}/${fn}`;
      await env.JOB_FILES.put(key, file.stream(), { httpMetadata: { contentType: file.type || "image/jpeg" } });
      const thumb = form.get("thumb");
      if (thumb && typeof thumb.stream === "function") {
        try { await env.JOB_FILES.put(key + ".thumb", thumb.stream(), { httpMetadata: { contentType: thumb.type || "image/jpeg" } }); } catch {}
      }
      if (stage === "ref") {
        item.refPhotos = Array.isArray(item.refPhotos) ? item.refPhotos : [];
        item.refPhotos.push(key);
      } else {
        item.donePhoto = key; item.done = true;
        item.doneAt = new Date().toISOString();
        item.doneBy = (sess.user && sess.user.username) || "";
      }
      job.updatedAt = new Date().toISOString();
      await saveJob(env, tenantId, job);
      const remaining = (job.auditItems || []).filter(it => !(it.done && it.donePhoto)).length;
      return jsonResponse({ ok: true, itemId, stage, key, url: r2Url(env, key),
        thumb: r2Url(env, key + ".thumb"), done: !!item.done, remaining }, headers, 201);
    }

    // POST /sla/jobs/{id}/audit-item  -> item tweaks: undo a completion, or remove
    // a reference photo. JSON { itemId, undo?, removeRef? (key) }.
    if (parts[2] === "audit-item" && method === "POST") {
      if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
      const b = await readJson(request);
      const job = await getJob(env, tenantId, id);
      if (!job) return jsonResponse({ error: "Not found" }, headers, 404);
      const item = (job.auditItems || []).find(it => it && it.id === String(b.itemId || ""));
      if (!item) return jsonResponse({ error: "Unknown audit item" }, headers, 404);
      if (b.undo) {
        if (item.donePhoto) { try { await env.JOB_FILES.delete(item.donePhoto); await env.JOB_FILES.delete(item.donePhoto + ".thumb"); } catch {} }
        item.done = false; item.donePhoto = null; item.doneAt = null; item.doneBy = null;
      }
      if (b.removeRef) {
        item.refPhotos = (item.refPhotos || []).filter(k => k !== b.removeRef);
        try { await env.JOB_FILES.delete(b.removeRef); await env.JOB_FILES.delete(b.removeRef + ".thumb"); } catch {}
      }
      job.updatedAt = new Date().toISOString();
      await saveJob(env, tenantId, job);
      return jsonResponse({ ok: true, itemId: item.id, done: !!item.done }, headers);
    }

    // POST /sla/jobs/{id}/photo-stage  -> admin recategorises a photo's stage
    // (Before/During/After). Stored as a job.photoStages override; no R2 rewrite.
    if (parts[2] === "photo-stage" && method === "POST") {
      if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
      if (!(await isSlaAdmin(env, tenantId, sess))) return jsonResponse({ error: "Forbidden" }, headers, 403);
      const { filename, stage } = await readJson(request);
      if (!filename) return jsonResponse({ error: "filename required" }, headers, 400);
      const st = PHOTO_STAGES.includes(stage) ? stage : "";
      const job = await getJob(env, tenantId, id);
      if (!job) return jsonResponse({ error: "Not found" }, headers, 404);
      job.photoStages = job.photoStages || {};
      if (st) job.photoStages[filename] = st; else delete job.photoStages[filename];
      job.updatedAt = new Date().toISOString();
      await saveJob(env, tenantId, job);
      return jsonResponse({ ok: true, filename, stage: st }, headers);
    }

    // POST /sla/jobs/{id}/signature  -> save signature PNG to R2 + attach to job
    if (parts[2] === "signature" && method === "POST") {
      const { signedBy, signedAt, signatureBase64, opId } = await readJson(request);
      if (!signedBy || !signatureBase64) return jsonResponse({ error: "Missing signature data" }, headers, 400);
      // Offline replay guard: don't store a second signature for the same op.
      if (opId && !(await firstTime(env, tenantId, opId, "sig:" + id))) {
        const cur = await getJob(env, tenantId, id);
        return jsonResponse({ ok: true, duplicate: true, key: cur && cur.signature ? cur.signature.fileKey : null }, headers);
      }
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

    // POST /sla/jobs/{id}/hold-approve  — an admin OKs a parked job. It becomes
    // a valid end point, unblocking the engineer, who is notified.
    if (parts[2] === "hold-approve" && method === "POST") {
      if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
      if (!(await isSlaAdmin(env, tenantId, sess))) return jsonResponse({ error: "Forbidden" }, headers, 403);
      const job = await getJob(env, tenantId, id);
      if (!job) return jsonResponse({ error: "Not found" }, headers, 404);
      const now = new Date().toISOString();
      const requestedBy = (job.hold && job.hold.approval && job.hold.approval.requestedBy) || "";
      job.hold = job.hold || {};
      job.hold.approval = { state: "approved", requestedBy, by: sess.user.username, at: now };
      job.statusHistory ||= [];
      job.statusHistory.push({ status: "On Hold — approved", at: now, by: sess.user.username });
      job.updatedAt = now;
      await saveJob(env, tenantId, job);
      const eng = requestedBy || assignedList(job)[0];
      if (eng) ctx?.waitUntil(sendToUser(env, tenantId, eng, {
        title: "On-hold approved",
        body: `${job.helpdeskRef || id} was approved to stay on hold — you're clear to move on.`,
        url: "/engineer-jobs.html", tag: "hold-decided:" + id
      }));
      // Dealt with — flip the "approval needed" alert to the outcome for EVERY admin.
      ctx?.waitUntil(resolveNotificationsByTag(env, tenantId, "hold-approve:" + id, {
        title: "On-hold approved",
        body: `${job.helpdeskRef || id} — ✅ approved by ${sess.user.username}.`
      }));
      return jsonResponse(decorateJobWithLiveSla(job), headers);
    }

    // POST /sla/jobs/{id}/hold-reject  — an admin refuses the hold; the job goes
    // back to In Progress and the engineer must finish it. {reason}
    if (parts[2] === "hold-reject" && method === "POST") {
      if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
      if (!(await isSlaAdmin(env, tenantId, sess))) return jsonResponse({ error: "Forbidden" }, headers, 403);
      const body = await readJson(request);
      const job = await getJob(env, tenantId, id);
      if (!job) return jsonResponse({ error: "Not found" }, headers, 404);
      const now = new Date().toISOString();
      const requestedBy = (job.hold && job.hold.approval && job.hold.approval.requestedBy) || "";
      job.hold = job.hold || {};
      job.hold.approval = { state: "rejected", requestedBy, by: sess.user.username, at: now, reason: String(body.reason || "").slice(0, 300) };
      job.status = "In Progress";
      job.statusHistory ||= [];
      job.statusHistory.push({ status: "In Progress", at: now, by: sess.user.username });
      job.events ||= [];
      job.events.push({ at: now, by: sess.user.username, type: "note", note: "On-hold rejected" + (body.reason ? ": " + body.reason : "") });
      job.updatedAt = now;
      await saveJob(env, tenantId, job);
      const eng = requestedBy || assignedList(job)[0];
      if (eng) ctx?.waitUntil(sendToUser(env, tenantId, eng, {
        title: "On-hold not approved",
        body: `${job.helpdeskRef || id}: ${body.reason || "the office needs this finished"} — tap to continue.`,
        url: "/job-view.html?jobId=" + encodeURIComponent(id), tag: "hold-decided:" + id
      }));
      // Dealt with — flip the "approval needed" alert to the outcome for EVERY admin.
      ctx?.waitUntil(resolveNotificationsByTag(env, tenantId, "hold-approve:" + id, {
        title: "On-hold declined",
        body: `${job.helpdeskRef || id} — ❌ sent back by ${sess.user.username}.`
      }));
      return jsonResponse(decorateJobWithLiveSla(job), headers);
    }

    // POST /sla/jobs/{id}/ra-block — the engineer can't proceed safely. Flags
    // the job "Awaiting office" (a blocking, non-end-point state), alerts every
    // office/admin, and holds the engineer. The job does NOT start. {reason, items}
    if (parts[2] === "ra-block" && method === "POST") {
      if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
      const b = await readJson(request);
      const reason = String(b.reason || "").trim();
      if (!reason) return jsonResponse({ error: "reason required" }, headers, 400);
      const job = await getJob(env, tenantId, id);
      if (!job) return jsonResponse({ error: "Not found" }, headers, 404);
      const now = new Date().toISOString();
      job.raBlock = {
        state: "open", reason: reason.slice(0, 500),
        items: Array.isArray(b.items) ? b.items.slice(0, 10).map(x => String(x).slice(0, 120)) : [],
        by: sess.user.username, at: now
      };
      job.statusHistory ||= [];
      job.statusHistory.push({ status: "Awaiting office (safety)", at: now, by: sess.user.username });
      job.events ||= [];
      job.events.push({ at: now, by: sess.user.username, type: "note", note: "Can't proceed safely: " + reason });
      job.updatedAt = now;
      await saveJob(env, tenantId, job);
      ctx?.waitUntil(sendToPermission(env, tenantId, ["FullAccess", "SLAAdmin"], {
        title: "⚠ Safety flag — can't proceed",
        body: `${sess.user.username} can't proceed at ${job.helpdeskRef || id}: ${reason.slice(0, 80)}`,
        url: "/inbox.html", tag: "ra-block:" + id
      }, sess.user.username));
      return jsonResponse(decorateJobWithLiveSla(job), headers);
    }

    // POST /sla/jobs/{id}/em-timer — start / reset / clear the 3-hour EM
    // drain-down countdown. Persisted on the job so the engineer (job card +
    // list) AND the office (board) all see the same live timer. {action, durationMinutes?}
    if (parts[2] === "em-timer" && method === "POST") {
      if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
      const b = await readJson(request);
      const job = await getJob(env, tenantId, id);
      if (!job) return jsonResponse({ error: "Not found" }, headers, 404);
      const now = new Date().toISOString();
      if (String(b.action || "start") === "clear") {
        job.emTimer = null;
      } else {
        const mins = Number.isFinite(Number(b.durationMinutes)) ? Math.max(1, Math.min(600, Number(b.durationMinutes))) : 180;
        job.emTimer = { startedAt: now, durationMinutes: mins, startedBy: sess.user.username };
      }
      job.updatedAt = now;
      await saveJob(env, tenantId, job);
      return jsonResponse(decorateJobWithLiveSla(job), headers);
    }

    // POST /sla/jobs/{id}/ra-resolve — an admin clears a safety flag (controls
    // now in place / reassigned / rescheduled). Releases + notifies the engineer.
    if (parts[2] === "ra-resolve" && method === "POST") {
      if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
      if (!(await isSlaAdmin(env, tenantId, sess))) return jsonResponse({ error: "Forbidden" }, headers, 403);
      const b = await readJson(request);
      const job = await getJob(env, tenantId, id);
      if (!job) return jsonResponse({ error: "Not found" }, headers, 404);
      const now = new Date().toISOString();
      const eng = (job.raBlock && job.raBlock.by) || assignedList(job)[0];
      const note = String(b.note || "").slice(0, 300);
      job.raBlock = Object.assign({}, job.raBlock, { state: "resolved", resolvedBy: sess.user.username, resolvedAt: now, resolveNote: note });
      job.statusHistory ||= [];
      job.statusHistory.push({ status: "Safety flag resolved", at: now, by: sess.user.username });
      job.updatedAt = now;
      await saveJob(env, tenantId, job);
      if (eng) ctx?.waitUntil(sendToUser(env, tenantId, eng, {
        title: "Safety flag resolved",
        body: `${job.helpdeskRef || id}: ${note || "the office has actioned it"} — tap to continue.`,
        url: "/job-view.html?jobId=" + encodeURIComponent(id), tag: "ra-block:" + id
      }));
      return jsonResponse(decorateJobWithLiveSla(job), headers);
    }

    // GET /sla/jobs/{id}
    if (method === "GET") {
      const job = await getJob(env, tenantId, id);
      if (!job) return jsonResponse({ error: "Not found" }, headers, 404);
      const d = decorateJobWithLiveSla(job);
      if (sess) d.myStatus = effStatus(job, normId(sess.user.username));   // this viewer's own slice
      if (isAuditJob(job)) d.auditItems = decorateAuditItems(env, job.auditItems);   // add viewable photo URLs
      return jsonResponse(d, headers);
    }

    // DELETE /sla/jobs/{id} — permanently remove a job + its stored files.
    // Destructive, so gated to the SLA admins (FullAccess | SLAAdmin); the
    // audit middleware records who deleted what automatically.
    if (method === "DELETE" && !parts[2]) {
      if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
      const perms = await permissionsFor(env, tenantId, sess.user.username);
      if (perms.FullAccess !== "Yes" && perms.SLAAdmin !== "Yes")
        return jsonResponse({ error: "Only SLA admins can delete jobs" }, headers, 403);
      const job = await getJob(env, tenantId, id);
      if (!job) return jsonResponse({ error: "Not found" }, headers, 404);
      await db.prepare("DELETE FROM sla_jobs WHERE tenant_id = ? AND id = ?").bind(tenantId, id).run();
      // Purge the job's uploads (photos, signatures, files) from R2.
      try {
        const listed = await env.JOB_FILES.list({ prefix: `jobs/${id}/` });
        for (const o of listed.objects || []) await env.JOB_FILES.delete(o.key);
      } catch {}
      // Remove any unverified (draft/submitted) EM/PAT certificates this job made;
      // finalised ones stay filed on the compliance chart.
      await purgeUnverifiedCertsForJob(env, tenantId, id);
      return jsonResponse({ ok: true, deleted: id, reference: job.helpdeskRef || id }, headers);
    }

    // PATCH /sla/jobs/{id}  — status changes, packs, scheduler assign/drag-drop.
    if (method === "PATCH") {
      const before = await getJob(env, tenantId, id);
      const body = await readJson(request);

      // Offline replay guard: if this exact op already landed, return the job
      // as-is instead of re-applying (no duplicate history/notifications).
      if (body.opId && !(await firstTime(env, tenantId, body.opId, "patch:" + id))) {
        if (!before) return jsonResponse({ error: "Not found" }, headers, 404);
        const dR = decorateJobWithLiveSla(before);
        if (sess) dR.myStatus = effStatus(before, normId(sess.user.username));
        return jsonResponse(dR, headers);
      }

      // ── End-point enforcement (server is the authority) ─────────────────
      // Engineers can't fake a completion by patching the DB directly, and an
      // offline replay is re-validated here. Admins (office) can override.
      let autoStart = null;   // set below → clock the engineer on after a status change
      if (before && sess) {
        const perms = await permissionsFor(env, tenantId, sess.user.username);
        const isAdmin = perms.FullAccess === "Yes" || perms.SLAAdmin === "Yes";
        const catNames = (await getCategories(env, tenantId)).map(c => c.name);
        // On a shared (2+ engineer) job, a NON-admin engineer changes only their
        // OWN status slice — so judge everything against THEIR status, and tell
        // patchJob to route the change to their slice.
        const engNorm = normId(sess.user.username);
        const perEngineer = !isAdmin && isMultiEng(before) && assignedList(before).some(a => normId(a) === engNorm);
        const beforeStatus = perEngineer ? effStatus(before, engNorm) : before.status;
        if (perEngineer && body.status) body.__engActor = engNorm;
        const target = body.status ? normalizeStatus(body.status, catNames) : beforeStatus;

        if (!isAdmin && body.status && target !== beforeStatus) {
          let missing = [];
          if (target === "Complete")      missing = completionMissing(before, body, await jobPhotoCount(env, id, "After"));
          else if (target === "Quote")    missing = quoteMissing(before, body, await jobPhotoCount(env, id));
          else if (target === "In Progress") missing = raMissing(body, before);
          else if (target === "On Hold")  missing = holdMissing(body, before);
          if (missing.length)
            return jsonResponse({ error: `Can't set ${target} yet — still needs ${humanList(missing)}.`, missing, needs: target }, headers, 422);
        }

        // Cross-job guard: you can't start the next job until your current one
        // is at a valid end point (Complete, or Quote / approved On Hold).
        // Cross-job guard — but EM/PAT jobs are exempt (they're meant to overlap):
        // starting one is never blocked, and one mid-drain-down never blocks others.
        if (!isAdmin && body.status && (target === "Travelling" || target === "In Progress") && !(before && (before.emTest || before.pat))) {
          const blocker = await findBlockingJob(env, tenantId, sess.user.username, id);
          if (blocker)
            return jsonResponse({ error: `Finish ${blocker.ref} first — ${blocker.why}.`, blockingJob: blocker }, headers, 409);
        }

        // Auto-start the day: the engineer's first status change of the day
        // clocks them on (if they never pressed "Start my day"), recording the
        // GPS that rides the status change. Idempotent — never overwrites an
        // existing clock-on. Only for engineers acting on their own jobs.
        if (!isAdmin && body.status && target !== beforeStatus) {
          autoStart = { user: sess.user.username, gps: body.gps || null, date: body.localDate || null };
        }

        // On Hold needs approval. An engineer's hold is "pending"; an admin who
        // sets it themselves is self-approved.
        if (body.status && target === "On Hold" && beforeStatus !== "On Hold") {
          body.hold = Object.assign({}, before.hold, body.hold);
          body.hold.approval = isAdmin
            ? { state: "approved", requestedBy: sess.user.username, by: sess.user.username, at: new Date().toISOString(), auto: true }
            : { state: "pending", requestedBy: sess.user.username, requestedAt: new Date().toISOString() };
        }
      }

      const updated = await patchJob(env, tenantId, id, body, ctx);
      // Release-aware notify: announce a gated job when it first becomes visible;
      // only push "newly added engineer" for an already-announced job.
      if (updated) ctx?.waitUntil(reconcileRelease(env, tenantId, updated).catch(() => {}));
      if (updated && before?.releaseNotified) ctx?.waitUntil(notifyNewlyAssigned(env, tenantId, before, updated));
      // Stacked queue: when a job is finished, the engineer's NEXT same-day
      // "after previous" job unlocks — announce it (fires its assignment push).
      if (updated && jobIsFinished(updated) && !jobIsFinished(before || {})) {
        ctx?.waitUntil((async () => {
          const all = await listJobs(env, tenantId);
          const engs = assignedList(updated).map(normId);
          for (const o of all) {
            if (o.releaseNotified || o.release?.mode !== "afterPrev") continue;
            if (!assignedList(o).some(a => engs.includes(normId(a)))) continue;
            await reconcileRelease(env, tenantId, o, all).catch(() => {});
          }
        })());
      }
      if (updated) ctx?.waitUntil(trackJobTime(env, tenantId, sess?.user?.username, before, updated));
      if (updated && autoStart) ctx?.waitUntil(ensureClockOn(env, tenantId, autoStart.user, autoStart.gps, autoStart.date));
      // Tell every office/admin when a job has just been parked pending approval.
      if (updated && updated.hold?.approval?.state === "pending"
          && before?.hold?.approval?.state !== "pending") {
        ctx?.waitUntil(sendToPermission(env, tenantId, ["FullAccess", "SLAAdmin"], {
          title: "On-hold approval needed",
          body: `${updated.hold.approval.requestedBy} wants to hold ${updated.helpdeskRef || id}: ${String(updated.hold.reason || "").slice(0, 60)}`,
          url: "/inbox.html", tag: "hold-approve:" + id, actionable: true
        }, updated.hold.approval.requestedBy));
      }
      if (!updated) return jsonResponse({ error: "Not found" }, headers, 404);
      const dOut = decorateJobWithLiveSla(updated);
      if (sess) dOut.myStatus = effStatus(updated, normId(sess.user.username));   // actor's own slice, for the field app
      return jsonResponse(dOut, headers);
    }
  }

  /* ===== Site folder: per-site jobs, photos and documents ===== */

  // Jobs previously raised at this site (basic sheet data), newest first —
  // LIVE jobs plus the imported ARCHIVE (historical) jobs for this store code.
  if (subpath === "/site/jobs" && method === "GET") {
    const code = storeCodeOf(searchParams.get("siteCode"));
    const name = (searchParams.get("siteName") || "").trim().toLowerCase();
    // Financial info (costs, invoices, values…) is FULL-ACCESS only. For everyone
    // else (incl. SLA admins) it's stripped from the archived record on the SERVER,
    // so it never reaches the device.
    const canMoney = sess ? await isFullAccess(env, tenantId, sess) : false;
    const all = await listJobs(env, tenantId);
    const mine = all.filter(j => siteMatches(j, code, name)).map(siteJobSummary).map(s => ({ ...s, source: "live" }));
    let archived = [];
    if (code) {
      try {
        await ensureArchive(env, tenantId);
        const { results } = await db.prepare(
          "SELECT id, ref, status, created_at, completed_at, data FROM sla_jobs_archive WHERE tenant_id=? AND site_code=? ORDER BY COALESCE(completed_at,created_at) DESC LIMIT 500"
        ).bind(tenantId, code).all();
        archived = (results || []).map(r => {
          let d = {}; try { d = JSON.parse(r.data) || {}; } catch {}
          if (!canMoney) d = stripFinancial(d);
          return {
            id: r.id, ref: r.ref || r.id,
            description: d.description || d.jobName || d.name || d["Job Name"] || d.Description || "",
            status: r.status || "Archived", priority: d.priority || "",
            date: r.completed_at || r.created_at || null,
            raisedAt: r.created_at || null, closedAt: r.completed_at || null,
            engineers: [], lastNote: "", signedBy: "",
            source: "archive", data: d
          };
        });
      } catch {}
    }
    const jobs = [...mine, ...archived].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    return jsonResponse({ jobs }, headers);
  }

  // Every photo from every job at this site + any photos uploaded straight here.
  if (subpath === "/site/photos" && method === "GET") {
    const store = storeCodeOf(searchParams.get("siteCode"));
    const siteKey = siteKeyOf(searchParams.get("siteCode"));
    const name = (searchParams.get("siteName") || "").trim().toLowerCase();
    const all = await listJobs(env, tenantId);
    const jobsHere = all.filter(j => siteMatches(j, store, name));
    const photos = [];
    for (const j of jobsHere) {
      const listed = await env.JOB_FILES.list({ prefix: `jobs/${j.id}/photos/`, include: ["customMetadata"] });
      const thumbSet = new Set((listed.objects || []).filter(o => o.key.endsWith(".thumb")).map(o => o.key));
      for (const o of listed.objects || []) {
        if (o.key.endsWith(".thumb")) continue;   // the thumb rides with its photo, not a photo itself
        photos.push({ url: await fileUrl(env, url, o.key), thumb: await signedFileUrl(env, url.origin, "/sla/site/thumb", o.key), hasThumb: thumbSet.has(o.key + ".thumb"),
          key: o.key, name: o.key.split("/").pop(),
          jobRef: j.helpdeskRef || j.id, jobId: j.id, at: o.uploaded ? new Date(o.uploaded).toISOString() : null,
          by: (o.customMetadata && (o.customMetadata.by || o.customMetadata.uploadedBy)) || "", source: "job" });
      }
    }
    if (siteKey) {
      const up = await env.JOB_FILES.list({ prefix: `sitedocs/${siteKey}/Site Photos/`, include: ["customMetadata"] });
      const thumbSet = new Set((up.objects || []).filter(o => o.key.endsWith(".thumb")).map(o => o.key));
      for (const o of up.objects || []) {
        if (o.key.endsWith(".thumb")) continue;
        photos.push({ url: await fileUrl(env, url, o.key), thumb: await signedFileUrl(env, url.origin, "/sla/site/thumb", o.key), hasThumb: thumbSet.has(o.key + ".thumb"),
          key: o.key, name: (o.customMetadata && o.customMetadata.name) || o.key.split("/").pop(),
          at: o.uploaded ? new Date(o.uploaded).toISOString() : null, by: o.customMetadata && o.customMetadata.by, source: "upload" });
      }
    }
    // Imported historical photos for this STORE (Co-op archive; photos only —
    // signatures and PDFs stay on the job in the Archive). Only real store
    // numbers have archive history, so projects never get a foreign store's shots.
    if (store) {
      try {
        await ensureArchive(env, tenantId);
        await ensureArchiveFiles(env, tenantId);
        const { results: aj } = await db.prepare("SELECT id FROM sla_jobs_archive WHERE tenant_id=? AND site_code=?").bind(tenantId, store).all();
        const mos = (aj || []).map(r => r.id);
        for (let i = 0; i < mos.length && photos.length < 2000; i += 90) {
          const chunk = mos.slice(i, i + 90);
          const ph = chunk.map(() => "?").join(",");
          const { results: af } = await db.prepare(
            `SELECT r2_key, name, taken_at, mos, uploaded_by FROM sla_archive_files WHERE tenant_id=? AND kind='photo' AND mos IN (${ph}) LIMIT 2000`
          ).bind(tenantId, ...chunk).all();
          for (const f of af || []) {
            photos.push({ url: await signedFileUrl(env, url.origin, "/sla/archive-file", f.r2_key), key: f.r2_key,
              name: f.name || f.r2_key.split("/").pop(), at: f.taken_at || null, jobRef: f.mos, by: f.uploaded_by || "", source: "archive" });
          }
        }
      } catch {}
    }
    photos.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
    return jsonResponse({ photos }, headers);
  }

  // Document areas (Compliance + custom) and the files in each.
  if (subpath === "/site/docs" && method === "GET") {
    const code = siteKeyOf(searchParams.get("siteCode"));
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
    // If this site IS a portal project's site (siteCode matches its Pxxxx
    // number), inject the project's own documents as a "Project Documents"
    // area — engineers on the job and Sites both surface them here without a
    // separate lookup. Non-hidden files only.
    try {
      const raw = String(searchParams.get("siteCode") || "").trim();
      if (raw) {
        const proj = await env.DB.prepare(
          "SELECT id FROM projects WHERE tenant_id=? AND (number=? OR site_number=?) LIMIT 1"
        ).bind(tenantId, raw, raw).first();
        if (proj) {
          const { results: pfs } = await env.DB.prepare(
            "SELECT id, r2_key, title, name, uploaded_at, uploaded_by FROM project_files WHERE tenant_id=? AND project_id=? AND (hidden=0 OR hidden IS NULL) ORDER BY uploaded_at DESC"
          ).bind(tenantId, proj.id).all();
          if ((pfs || []).length) {
            const AREA = "Project Documents";
            if (!areas.includes(AREA)) areas.unshift(AREA);
            docs[AREA] = await Promise.all(pfs.map(async f => ({
              url: await signedFileUrl(env, url.origin, "/project/doc", f.r2_key, 86400),
              key: f.r2_key,
              name: f.title || f.name || f.r2_key.split("/").pop(),
              at: f.uploaded_at, by: f.uploaded_by, size: 0,
              projectDoc: true,   // marker: engineers/office see it but can't delete via /site/doc-delete
            })));
          }
        }
      }
    } catch {}
    // Compliance certificates — the same files eicr-portal / fareham chart
    // shows. Surface them here as a "Compliance Certificates" area so an
    // engineer opening Site Documents finds a store's EICR / PAT / EM etc.
    // without leaving the page. Non-destructive read; delete/upload still
    // owned by the compliance chart. Matches by site_number → compliance_stores
    // via siteKeyOf-of-the-request (portal site number OR compliance code).
    try {
      const raw = String(searchParams.get("siteCode") || "").trim();
      if (raw) {
        // Two match paths: (a) the compliance store links directly to this site's
        // number, (b) the compliance code IS the request code (Co-op stores).
        const { results: files } = await env.DB.prepare(
          `SELECT f.id, f.scheme, f.code, f.type, f.year, f.filename, f.label, f.r2_key, f.uploaded_at, f.uploaded_by
             FROM compliance_files f
             LEFT JOIN compliance_stores s
                    ON s.tenant_id = f.tenant_id AND s.scheme = f.scheme AND s.code = f.code
            WHERE f.tenant_id = ?
              AND (s.site_number = ? OR f.code = ?)
            ORDER BY f.uploaded_at DESC`
        ).bind(tenantId, raw, raw).all();
        if ((files || []).length) {
          const AREA = "Compliance Certificates";
          if (!areas.includes(AREA)) areas.unshift(AREA);
          const TYPE_LBL = { fiveYear: "5 Year", pat: "PAT", em: "Emergency Lighting", emMonthly: "EM Monthly", emYearly: "EM Yearly", pv: "PV", ev: "EV", forecourt: "EV", pump: "Pump", other: "Other" };
          docs[AREA] = await Promise.all(files.map(async f => ({
            url: await signedFileUrl(env, url.origin, "/compliance/file", f.r2_key, 86400),
            key: f.r2_key,
            name: (f.label || f.filename || f.r2_key.split("/").pop())
              + " · " + (TYPE_LBL[f.type] || f.type || "compliance"),
            at: f.uploaded_at, by: f.uploaded_by, size: 0,
            complianceDoc: true,   // marker: managed on the compliance chart
          })));
        }
      }
    } catch {}
    return jsonResponse({ areas, docs }, headers);
  }

  // Upload a document (or a site photo) into an area — ADMINS ONLY (SLAAdmin |
  // FullAccess). Engineers are read-only in site documents; they add photos
  // through their jobs, which flow into Site Photos automatically.
  if (subpath === "/site/docs" && method === "POST") {
    if (!(await isSlaAdmin(env, tenantId, sess))) return jsonResponse({ error: "Only office/admin can add site documents." }, headers, 403);
    const code = siteKeyOf(searchParams.get("siteCode"));
    const area = (searchParams.get("area") || "Compliance").replace(/[\/]/g, "-").trim();
    if (!code) return jsonResponse({ error: "Missing siteCode" }, headers, 400);
    let form;
    try { form = await request.formData(); }
    catch { return jsonResponse({ error: "Upload was incomplete — please retry.", incomplete: true }, headers, 400); }
    const file = form.get("file");
    if (!file) return jsonResponse({ error: "Missing file" }, headers, 400);
    const safe = (file.name || "file").replace(/[^\w.\-]+/g, "_");
    const key = `sitedocs/${code}/${area}/${Date.now()}-${safe}`;
    await env.JOB_FILES.put(key, file.stream(), {
      httpMetadata: { contentType: file.type || "application/octet-stream" },
      customMetadata: { name: file.name || safe, by: (sess && sess.user && sess.user.username) || "", at: new Date().toISOString() }
    });
    // A small client-generated thumbnail rides along (photos) → stored as
    // <key>.thumb so the grid loads a tiny image instead of the full-res one.
    const thumb = form.get("thumb");
    if (thumb && typeof thumb.stream === "function") {
      try { await env.JOB_FILES.put(key + ".thumb", thumb.stream(), { httpMetadata: { contentType: thumb.type || "image/jpeg" } }); } catch {}
    }
    return jsonResponse({ ok: true, url: r2Url(env, key), key }, headers, 201);
  }

  // Serve a small thumbnail for a site photo / job photo — <key>.thumb if it
  // exists, else the original (edge-cached briefly so it's replaced once a thumb
  // is backfilled). Edge-cached on the KEY (ignoring the signature) so it's fast
  // across page loads. Same key constraints + sig gate as /site/doc.
  if (subpath === "/site/thumb" && method === "GET") {
    const key = searchParams.get("key");
    if (!key || !(String(key).startsWith("sitedocs/") || String(key).startsWith("jobs/")))
      return jsonResponse({ error: "Bad key" }, headers, 400);
    if (!sess && !(await verifyFileSig(env, key, searchParams)))
      return jsonResponse({ error: "Link expired or invalid" }, headers, 403);
    const cache = caches.default;
    const cacheKey = new Request(`${url.origin}/sla/site/thumb?key=${encodeURIComponent(key)}`);
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
    let obj = await env.JOB_FILES.get(key + ".thumb");
    let cc = "public, max-age=31536000, immutable";
    if (!obj) { obj = await env.JOB_FILES.get(key); cc = "public, max-age=86400"; }   // no thumb yet → original
    if (!obj) return new Response("Not found", { status: 404, headers });
    const resp = new Response(obj.body, { status: 200, headers: {
      ...headers, "Content-Type": obj.httpMetadata?.contentType || "image/jpeg",
      "Content-Disposition": "inline", "Cache-Control": cc
    }});
    ctx?.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  }

  // Store a thumbnail for an EXISTING photo (backfill) — client generates it.
  if (subpath === "/site/thumb" && method === "POST") {
    if (!sess) return jsonResponse({ error: "Not authenticated" }, headers, 401);
    let form;
    try { form = await request.formData(); }
    catch { return jsonResponse({ error: "Upload was incomplete — please retry.", incomplete: true }, headers, 400); }
    const key = String(form.get("key") || "");
    const thumb = form.get("thumb");
    if (!key || !(key.startsWith("sitedocs/") || key.startsWith("jobs/")) || !thumb || typeof thumb.stream !== "function")
      return jsonResponse({ error: "Bad request" }, headers, 400);
    await env.JOB_FILES.put(key + ".thumb", thumb.stream(), { httpMetadata: { contentType: thumb.type || "image/jpeg" } });
    // Drop any edge-cached original for this key so the new thumb is served next.
    try { ctx?.waitUntil(caches.default.delete(new Request(`${url.origin}/sla/site/thumb?key=${encodeURIComponent(key)}`))); } catch {}
    return jsonResponse({ ok: true }, headers);
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
    try { await env.JOB_FILES.delete(key + ".thumb"); } catch {}   // its thumbnail too
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

/* ---- End-point criteria (server-side enforcement) ---- */
const PHOTO_STAGES = ["Before", "During", "After"];
const MIN_COMPLETE_NOTE = 15;

// How many photos this job already has in R2.
// Count a job's photos, optionally only those tagged with a given stage
// (Before/During/After). Completion insists on an "After" photo — the RA's
// "Before" work-area shot must not be the only picture on a finished job.
async function jobPhotoCount(env, id, stage) {
  try {
    const l = await env.JOB_FILES.list({ prefix: `jobs/${id}/photos/`, include: stage ? ["customMetadata"] : undefined });
    const objs = l.objects || [];
    if (stage) return objs.filter(o => (o.customMetadata && o.customMetadata.stage) === stage).length;
    return objs.length;
  } catch { return 0; }
}

// Join a list of missing items into readable English ("a, b and c").
function humanList(items) {
  const a = items.filter(Boolean);
  if (a.length <= 1) return a.join("");
  return a.slice(0, -1).join(", ") + " and " + a[a.length - 1];
}

// Whether a job needs a customer signature. Default OFF for projects, ON
// otherwise; an explicit stored flag wins. Mirrors the client's sigRequired().
function jobIsProject(job) {
  return /^p\d/i.test(String((job && job.siteCode) || "")) ||
         /project/i.test(String((job && (job.storeType || job.client)) || ""));
}
function signatureRequiredFor(job) {
  return (job && job.requiresSignature !== undefined) ? !!job.requiresSignature : !jobIsProject(job);
}
function photoRequiredFor(job) {
  return (job && job.requiresPhoto !== undefined) ? !!job.requiresPhoto : !jobIsProject(job);
}
function noteRequiredFor(job) {
  return (job && job.requiresNote !== undefined) ? !!job.requiresNote : !jobIsProject(job);
}

// Complete = a completion note + an (After) photo + the customer's signature —
// each demanded only when the job requires it. Projects default to NONE (they
// can complete with nothing); everything else requires all three.
function firestopMissing(job) {
  const rec = (job && job.firestop) || {};
  const seals = Array.isArray(rec.seals) ? rec.seals : [];
  const miss = [];
  if (!seals.length) miss.push("at least one seal on the firestopping record");
  else if (!seals.some(s => (s.beforePhotos || []).length && (s.afterPhotos || []).length))
    miss.push("before and after photos on a seal");
  if (!rec.signatureKey) miss.push("the signed declaration");
  return miss;
}
// Site-audit job: a single job carrying a checklist of items (job.auditItems),
// each needing ONE completion photo in the field. Completion is per-item, not the
// standard note/photo/signature.
function isAuditJob(job) { return !!(job && Array.isArray(job.auditItems) && job.auditItems.length); }
function auditMissing(job) {
  const items = (job && job.auditItems) || [];
  const outstanding = items.filter(it => !(it && it.done && it.donePhoto));
  if (!outstanding.length) return [];
  return [`a completion photo on ${outstanding.length} of ${items.length} audit item${items.length === 1 ? "" : "s"}`];
}
// Normalise a builder's audit-item list into the stored shape, PRESERVING each
// item's completion state + photos from the existing job (matched by id) so an
// office text edit never wipes an engineer's completed work.
function normAuditItems(input, existing) {
  if (!Array.isArray(input)) return existing?.auditItems;   // undefined = leave untouched
  const prev = {};
  for (const it of (existing?.auditItems || [])) if (it && it.id) prev[it.id] = it;
  const out = [];
  for (const raw of input) {
    if (!raw) continue;
    const text = String(raw.text || raw.title || "").trim();
    if (!text && !(raw.id && prev[raw.id])) continue;       // drop blank new rows
    const id = String(raw.id || "") || crypto.randomUUID();
    const was = prev[id] || {};
    out.push({
      id,
      text: (text || was.text || "").slice(0, 2000),
      refPhotos: Array.isArray(raw.refPhotos) ? raw.refPhotos.filter(Boolean).slice(0, 12)
                 : (Array.isArray(was.refPhotos) ? was.refPhotos : []),
      done: !!was.done,
      donePhoto: was.donePhoto || null,
      doneAt: was.doneAt || null,
      doneBy: was.doneBy || null,
    });
    if (out.length >= 200) break;                            // sane cap
  }
  return out;
}
function completionMissing(job, patch, afterPhotoCount) {
  // Firestopping jobs are completed by the RIA record (seals + photos +
  // signed declaration), NOT the standard note/photo/signature.
  if (job && job.firestopping) return firestopMissing(job);
  // EM / PAT jobs are completed by the portal certificate (filled + signed on the
  // job, then submitted for office review) — not the standard note/photo/signature.
  if (job && (job.emTest || job.pat)) return [];
  // Site-audit jobs complete when every checklist item has its completion photo.
  if (isAuditJob(job)) return auditMissing(job);
  // Investigate-only jobs have relaxed gates — Connor sets Quote/Complete freely.
  if (job && job.investigateOnly) return [];
  const miss = [];
  if (noteRequiredFor(job) && String(patch.note || "").trim().length < MIN_COMPLETE_NOTE) miss.push("a completion note");
  if (photoRequiredFor(job) && afterPhotoCount < 1) miss.push("a completion photo (After)");
  if (signatureRequiredFor(job) && (!job.signature || !job.signature.fileKey)) miss.push("the customer signature");
  return miss;
}

// Quote = the quote pack the office prices from + photos + signature.
function quoteMissing(job, patch, photoCount) {
  // Investigate-only jobs: relaxed — no quote pack required (findings go in the note).
  if (job && job.investigateOnly) return [];
  const q = (patch.quote && typeof patch.quote === "object") ? patch.quote : (job.quote || {});
  const miss = [];
  if (!String(q.description || "").trim()) miss.push("the works description");
  if (!String(q.reason || "").trim())      miss.push("why it needs quoting");
  if (!String(q.materials || "").trim())   miss.push("the materials");
  if (photoRequiredFor(job) && photoCount < 1) miss.push("at least one photo");
  if (signatureRequiredFor(job) && (!job.signature || !job.signature.fileKey)) miss.push("the customer signature");
  return miss;
}

// On Hold = a reason and what's needed to resume (approval is handled separately).
function holdMissing(patch, job) {
  if (job && job.investigateOnly) return [];   // relaxed gates for investigate-only jobs
  const h = (patch.hold && typeof patch.hold === "object") ? patch.hold : (job.hold || {});
  const miss = [];
  if (!String(h.reason || "").trim()) miss.push("the reason");
  if (!String(h.needs || "").trim())  miss.push("what's needed to resume");
  return miss;
}

// In Progress = the pre-start risk assessment ticked "safe to proceed".
function raMissing(patch, job) {
  const ra = (patch.riskAssessment && typeof patch.riskAssessment === "object") ? patch.riskAssessment : (job.riskAssessment || {});
  return ra.safe === true ? [] : ["the risk assessment (safe to proceed)"];
}

// The engineer's OTHER jobs that aren't yet at a valid end point — used to block
// them from starting the next one. Returns the first blocker, or null.
// Clock an engineer on for the day if they aren't already (their first job
// status change "starts their day"). COALESCE keeps any existing clock-on, so
// this never overwrites a real Start-my-day and is safe to replay.
async function ensureClockOn(env, tenantId, username, gps, localDate) {
  try {
    if (!username) return;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(localDate || "") ? localDate : new Date().toISOString().slice(0, 10);
    await env.DB.prepare(`
      INSERT INTO shifts (tenant_id, username, date, clock_on_at, clock_on_gps)
      VALUES (?,?,?,?,?)
      ON CONFLICT(username, date) DO UPDATE SET
        clock_on_at  = COALESCE(shifts.clock_on_at, excluded.clock_on_at),
        clock_on_gps = COALESCE(shifts.clock_on_gps, excluded.clock_on_gps)
    `).bind(tenantId, username, date, new Date().toISOString(), gps || null).run();
  } catch (e) { /* non-fatal */ }
}

async function findBlockingJob(env, tenantId, username, exceptId) {
  const uNorm = normId(username);
  const jobs = await listJobs(env, tenantId);
  for (const j of jobs) {
    if (String(j.id) === String(exceptId)) continue;
    if (!assignedList(j).some(a => normId(a) === uNorm)) continue;
    // EM/PAT jobs are DESIGNED to overlap — an emergency-light job sits idle for a
    // ~3h battery drain-down and a PAT runs alongside, so one in progress must never
    // block the engineer starting another job.
    if (j.emTest || j.pat) continue;
    // On a shared job, judge THIS engineer's own status — a co-worker being mid-job
    // must never block them.
    const st = effStatus(j, uNorm);
    if (j.raBlock && j.raBlock.state === "open")
      return { id: j.id, ref: j.helpdeskRef || j.id, kind: "safety", why: "it's flagged 'can't proceed safely' — waiting for the office" };
    if (st === "In Progress" || st === "Travelling")
      return { id: j.id, ref: j.helpdeskRef || j.id, kind: "active", why: `it's still ${st}` };
    if (st === "On Hold") {
      const ap = j.hold && j.hold.approval;
      if (!ap || ap.state !== "approved")
        return { id: j.id, ref: j.helpdeskRef || j.id, kind: "holdPending", why: "its on-hold is waiting for an admin to approve" };
    }
  }
  return null;
}

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

// `extra` = the tenant's custom category NAMES (strings). A job explicitly set
// to one of them (from the UI) must keep that exact status instead of collapsing
// to "Pending". Built-in aliases still map. Truly-unknown statuses (e.g. odd
// inbound values) still default to "Pending" so garbage never leaks onto the
// board.
function normalizeStatus(status, extra) {
  if (!status) return "Pending";
  const s = status.toLowerCase().trim();
  if (s === "open" || s === "with contractor - r") return "Pending";
  if (s === "completed") return "Complete";
  if (s === "closed" || s === "cancelled") return "Closed Jobs";
  const all = (Array.isArray(extra) && extra.length) ? CANONICAL_STATUSES.concat(extra) : CANONICAL_STATUSES;
  return all.find(x => x.toLowerCase() === s) || "Pending";
}

/* ================= ASSIGNMENT ================= */

// Normalise an engineer identifier so "John Thorn", "john.thorn" and "JOHN.THORN"
// all compare equal.
const normId = s => (s || "").toLowerCase().replace(/\s+/g, ".").trim();

// Canonical priority strings (the inbound route accepts these verbatim).
const PRIORITY_SET = new Set(["Priority 1", "Priority 2", "Priority 3", "Priority 4"]);

// URL-decode a path segment; a lone "%" must not crash the route.
function safeDecode(s) { try { return decodeURIComponent(s ?? ""); } catch { return s ?? ""; } }

// A job may have many assigned engineers (assignedEngineers[]); fall back to the
// legacy single assignedTo for older records.
function assignedList(job) {
  if (Array.isArray(job.assignedEngineers) && job.assignedEngineers.length) {
    return job.assignedEngineers.filter(Boolean);
  }
  return job.assignedTo ? [job.assignedTo] : [];
}

/* ===== Per-engineer status ("only status per engineer") =====
   A job worked by 2+ engineers keeps ONE shared record (RA, photos, signature,
   notes are all shared) but each engineer tracks their OWN status/day in
   engStatus[normId] = {status, at, by}. Single-engineer jobs never use this —
   they keep the plain top-level status, so the Zapier intake and every ordinary
   job are unchanged. The board's top-level `status` is a rollup of the engineers'
   statuses so filters/badges still work. */
function isMultiEng(job) { return assignedList(job).length >= 2; }
const DONE_STATES = new Set(["complete", "closed jobs", "closed", "invoiced", "cancelled"]);
// One engineer's status on a job (their own slice, else the shared status —
// which also covers legacy jobs and an engineer not yet diverged).
function effStatus(job, engNorm) {
  if (job && job.engStatus && job.engStatus[engNorm] && job.engStatus[engNorm].status) return job.engStatus[engNorm].status;
  return job ? job.status : "Pending";
}
// Roll each engineer's status up into the single board status: Complete only when
// EVERYONE is done; otherwise reflect the most-active engineer.
function rollupStatus(job) {
  const engs = assignedList(job).map(normId);
  if (!engs.length) return job.status;
  const sts = engs.map(e => effStatus(job, e));
  if (sts.every(s => DONE_STATES.has(String(s).toLowerCase()))) return "Complete";
  for (const rank of ["In Progress", "Travelling", "On Hold", "Quote", "Order", "Scheduled", "Pending"]) {
    if (sts.some(s => s === rank)) return rank;
  }
  return sts.find(s => !DONE_STATES.has(String(s).toLowerCase())) || job.status;
}
// Make sure every assigned engineer on a multi-engineer job has a status slice.
// Called whenever the roster changes: an engineer already on the job keeps the
// shared status; a newcomer starts at "Scheduled" (they haven't started yet).
function seedEngStatus(job, prevEngs, prevStatus, now) {
  if (!isMultiEng(job)) return;
  job.engStatus = job.engStatus || {};
  const prev = new Set((prevEngs || []).map(normId));
  for (const e of assignedList(job).map(normId)) {
    if (job.engStatus[e]) continue;
    job.engStatus[e] = { status: prev.has(e) ? (prevStatus || "Scheduled") : "Scheduled", at: now, by: "system" };
  }
}

/* ================= JOB RELEASE (visibility scheduling) =================
   A job can carry a `release` object controlling WHEN its assigned engineers
   first see it (and get the assignment push):
     { mode:'now' }        – default: visible immediately (same as no release)
     { mode:'at', at:ISO }  – visible from an exact instant (custom date/time)
     { mode:'dayBefore' }   – visible from 17:00 Europe/London the day before the
                              scheduled day (recomputed live so it tracks reschedules)
     { mode:'afterPrev' }   – visible once every EARLIER same-day job for that
                              engineer is finished (the "stacked / drip" queue)
   `job.releaseNotified` flips true the first time the job is both visible AND
   has an engineer, when the assignment push fires. */
function londonOffsetMs(utcMs) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/London", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(utcMs)).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  const hh = p.hour === "24" ? 0 : Number(p.hour);
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hh, Number(p.minute), Number(p.second)) - utcMs;
}
function londonInstant(y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  return guess - londonOffsetMs(guess);   // one correction is exact except across the DST second
}
function londonHourDayBefore(schedISO, hour) {
  const s = Date.parse(schedISO); if (!Number.isFinite(s)) return null;
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(s)).split("-").map(Number);
  const prev = new Date(Date.UTC(y, m - 1, d)); prev.setUTCDate(prev.getUTCDate() - 1);
  const h = Number.isFinite(Number(hour)) ? Math.max(0, Math.min(23, Number(hour))) : 17;
  return londonInstant(prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate(), h, 0);
}
// The instant a time-based release becomes visible (ms), or null for now/afterPrev.
function releaseInstant(job) {
  const r = job && job.release;
  if (!r || !r.mode || r.mode === "now") return null;
  if (r.mode === "at") { const t = Date.parse(r.at); return Number.isFinite(t) ? t : null; }
  // dayBefore: the evening before the scheduled day, at r.hour (Europe/London,
  // default 17:00) — used by the project multi-day drip feed.
  if (r.mode === "dayBefore") return job.scheduledAt ? londonHourDayBefore(job.scheduledAt, r.hour) : null;
  return null;
}
// An AUTO-generated job — a project multi-day "series" day OR a fallback day — is
// auto-SKIPPED (dropped) if the engineer picked up another REAL job that same day,
// so it never double-books. For a series job, its own same-series siblings don't
// count; for a fallback, other fallbacks don't count — anything else that day does.
function engineerHasOtherJobThatDay(job, allJobs) {
  if (!job || !job.scheduledAt) return false;
  const isSeries = !!job.seriesId, isFallback = !!job.fallback;
  if (!isSeries && !isFallback) return false;   // only auto jobs get auto-dropped
  const day = new Date(job.scheduledAt).toISOString().slice(0, 10);
  const engs = new Set(assignedList(job).map(normId));
  if (!engs.size) return false;
  return (allJobs || []).some(o => o.id !== job.id
    && !o.seriesSkipped
    && String(o.status || "").toLowerCase() !== "cancelled"
    && o.scheduledAt && new Date(o.scheduledAt).toISOString().slice(0, 10) === day
    && assignedList(o).some(a => engs.has(normId(a)))
    // Don't let an auto job be dropped by another job of its OWN auto set.
    && !(isSeries && o.seriesId === job.seriesId)
    && !(isFallback && o.fallback));
}
const RELEASE_DONE = new Set(["complete", "closed jobs", "closed", "invoiced", "cancelled"]);
function jobIsFinished(job) { return RELEASE_DONE.has(String(job.status || "").toLowerCase()); }
function sameSchedDay(a, b) {
  if (!a.scheduledAt || !b.scheduledAt) return false;
  return new Date(a.scheduledAt).toISOString().slice(0, 10) === new Date(b.scheduledAt).toISOString().slice(0, 10);
}
// afterPrev: is there an earlier same-day job for any of these engineers still open?
function hasEarlierOpenJob(job, engineers, allJobs) {
  if (!job.scheduledAt) return false;
  const engSet = new Set(engineers.map(normId));
  const myStart = Date.parse(job.scheduledAt);
  // "Open" is judged for OUR engineer on the earlier job (their own slice), so a
  // co-worker still working an earlier shared job doesn't hold this one back.
  return allJobs.some(o => o.id !== job.id && sameSchedDay(o, job)
    && Date.parse(o.scheduledAt) < myStart
    && assignedList(o).some(a => engSet.has(normId(a)) && !DONE_STATES.has(String(effStatus(o, normId(a))).toLowerCase())));
}
// Is the job visible to its engineers right now? (allJobs only needed for afterPrev)
function releaseVisibleNow(job, allJobs) {
  if (job && job.seriesSkipped) return false;   // dropped project day / fallback — never shown
  // A project series day OR a fallback day yields to any other job that day.
  if (job && (job.seriesId || job.fallback) && engineerHasOtherJobThatDay(job, allJobs || [])) return false;
  const r = job && job.release;
  if (!r || !r.mode || r.mode === "now") return true;
  if (r.mode === "at" || r.mode === "dayBefore") { const t = releaseInstant(job); return t == null || t <= Date.now(); }
  if (r.mode === "afterPrev") return !hasEarlierOpenJob(job, assignedList(job), allJobs || []);
  return true;
}
function releaseGatedNow(job) {
  const r = job && job.release;
  if (!r || !r.mode || r.mode === "now") return false;
  return true;   // any explicit non-'now' release is gated until reconcile clears it
}
function releaseLabel(job) {
  const r = job && job.release; if (!r || !r.mode || r.mode === "now") return "";
  if (r.mode === "afterPrev") return "Shown after the previous job that day is done";
  const t = releaseInstant(job);
  if (t == null) return "Scheduled release";
  const when = new Date(t).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
  return (t <= Date.now() ? "Released " : "Hidden until ") + when;
}

// Resolve SLA engineer ids (names / dotted forms) → canonical portal usernames.
async function engUsernameMap(env, tid) {
  const map = {};
  try {
    const { results } = await env.DB.prepare("SELECT username, first_name, last_name FROM users WHERE tenant_id=?").bind(tid).all();
    for (const u of results || []) {
      map[normId(u.username)] = u.username;
      const full = ((u.first_name || "") + " " + (u.last_name || "")).trim();
      if (full) map[normId(full)] = u.username;
    }
  } catch {}
  return map;
}
// A job's internal id is a UUID — never show it in a push. A helpdesk ref is
// only worth showing if it's a real reference, not that UUID.
function isUuidLike(s) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || "")); }
// Push body = the CLEAR job name (site, else the works description), with a real
// reference prefixed only when there is one. Keeps the ugly UUID out.
function jobPushBody(job) {
  const site = job.siteName || job.siteCode || "";
  const desc = (job.description || "").trim();
  const ref = job.helpdeskRef || "";
  let name = site || desc || "";
  // Prefix a real reference only if it's not the UUID and not just the site again.
  const showRef = ref && ref !== job.id && !isUuidLike(ref) && ref !== site;
  if (showRef) name = name ? `${ref} — ${name}` : ref;
  if (!name) name = "New job";
  return `${name}${job.priority ? " · " + job.priority : ""}. Tap to view.`;
}
// Fire the "new job" push to a specific set of engineer ids.
async function pushJobToEngineers(env, tid, job, engineerIds) {
  if (!engineerIds.length) return;
  const map = await engUsernameMap(env, tid);
  const body = jobPushBody(job);
  for (const eng of engineerIds) {
    const username = map[normId(eng)] || eng;
    await sendToUser(env, tid, username, {
      title: "New job assigned to you", body,
      url: "/engineer-jobs.html?job=" + encodeURIComponent(job.id), tag: "sla-job:" + job.id
    });
  }
}
// First-time announcement: if the job is visible + has engineers + hasn't been
// announced, push ALL its engineers and mark it notified (persisting the flag).
// Stop a project drip "series": remove every day that hasn't gone visible to the
// engineer yet (releaseNotified false, not already skipped). Released / past days
// are kept (the engineer already has them). Returns how many were removed.
export async function stopSeries(env, tenantId, seriesId) {
  if (!seriesId) return { removed: 0, total: 0 };
  const db = tenantDB(env, tenantId);
  const jobs = await listJobs(env, tenantId);
  const inSeries = jobs.filter(j => j.seriesId === seriesId);
  const kill = inSeries.filter(j => !j.releaseNotified && !j.seriesSkipped);
  let removed = 0;
  for (const j of kill) {
    try { await db.prepare("DELETE FROM sla_jobs WHERE tenant_id = ? AND id = ?").bind(tenantId, j.id).run(); removed++; } catch {}
  }
  return { removed, total: inSeries.length };
}

export async function reconcileRelease(env, tid, job, allJobs) {
  if (!job || job.releaseNotified) return false;
  const engs = assignedList(job);
  if (!engs.length) return false;
  if (!releaseVisibleNow(job, allJobs || await listJobs(env, tid))) return false;
  await pushJobToEngineers(env, tid, job, engs);
  job.releaseNotified = true;
  await saveJob(env, tid, job);
  return true;
}
// Cron sweep: announce any timed job whose release has now passed, and re-check
// afterPrev queues (fallback in case a completion happened while offline).
export async function sweepJobReleases(env, tid = 1) {
  const jobs = await listJobs(env, tid);
  for (const j of jobs) {
    if (j.releaseNotified || j.seriesSkipped || !assignedList(j).length) continue;
    const r = j.release; if (!r || !r.mode || r.mode === "now") continue;
    // Series / fallback safeguard: when a drip/fallback day's release time has
    // arrived but the engineer already has another job that day, permanently DROP
    // it (skip) rather than announcing it — so it never double-books.
    if ((j.seriesId || j.fallback) && engineerHasOtherJobThatDay(j, jobs)) {
      const t = releaseInstant(j);
      if (t == null || t <= Date.now()) {
        j.seriesSkipped = true;
        await saveJob(env, tid, j).catch(() => {});
      }
      continue;
    }
    await reconcileRelease(env, tid, j, jobs).catch(() => {});
  }
}

// Re-nudge SLA admins about jobs still On Hold pending approval (blocks the
// engineer, so it's chased often — every ~10 min from the cron). Push-only, so
// the single outstanding bell alert isn't duplicated.
export async function remindPendingHolds(env, tid = 1) {
  try {
    const jobs = await listJobs(env, tid);
    for (const j of jobs) {
      if (j.hold?.approval?.state !== "pending") continue;
      await remindPermission(env, tid, ["FullAccess", "SLAAdmin"], {
        title: "On-hold still waiting",
        body: `${j.hold.approval.requestedBy || "An engineer"} is waiting on ${j.helpdeskRef || j.id} — approve or send it back.`,
        url: "/inbox.html", tag: "hold-approve:" + j.id
      }, j.hold.approval.requestedBy).catch(() => {});
    }
  } catch { /* best-effort */ }
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
  const body = jobPushBody(after);
  for (const eng of added) {
    const username = map[normId(eng)] || eng;
    await sendToUser(env, tid, username, {
      title: "New job assigned to you", body,
      url: "/engineer-jobs.html?job=" + encodeURIComponent(after.id), tag: "sla-job:" + after.id
    });
  }
}

/* ================= STORAGE (D1) ================= */

async function getJob(env, tenantId, id) {
  const db = tenantDB(env, tenantId);
  const row = await db.prepare("SELECT data FROM sla_jobs WHERE tenant_id = ? AND id = ?").bind(tenantId, id).first();
  return row ? JSON.parse(row.data) : null;
}
// Deleting a job removes the DRAFT / submitted (unverified) certificates it made,
// but NEVER one the office has finalised (status='final') — those are filed on the
// compliance chart and their PDF must survive. Draft/review certs hold no separate
// R2 files (the signature is inline, the PDF is generated on demand), so removing
// the DB rows is a complete clean-up.
async function purgeUnverifiedCertsForJob(env, tenantId, jobId) {
  if (!jobId) return;
  try { await env.DB.prepare("DELETE FROM certificates WHERE tenant_id=? AND job_id=? AND status <> 'final'").bind(tenantId, String(jobId)).run(); } catch {}
}

function todayStr() { return new Date().toISOString().slice(0, 10); }
async function getShift(env, tenantId, username, date) {
  if (!username) return null;
  const db = tenantDB(env, tenantId);
  return (await db.prepare("SELECT * FROM shifts WHERE tenant_id=? AND username=? AND date=?").bind(tenantId, username, date).first()) || null;
}

export async function listJobs(env, tenantId) {
  const db = tenantDB(env, tenantId);
  const { results } = await db.prepare("SELECT data FROM sla_jobs WHERE tenant_id = ?").bind(tenantId).all();
  return (results || []).map(r => JSON.parse(r.data));
}

// Upsert a full job object: indexed columns for filtering + full JSON in `data`.
// D1 occasionally throws transient faults under load ("D1 DB storage
// operation exceeded timeout which caused object to be reset", lost network,
// internal errors). The job upsert is idempotent, so briefly retrying is
// always safe — this keeps one D1 hiccup from bouncing a Zapier job.
function isTransientD1(e) {
  return /exceeded timeout|object to be reset|Network connection lost|D1_ERROR.*(timeout|reset|storage|internal)/i
    .test(String((e && e.message) || e));
}
async function d1Retry(fn, tries = 3) {
  let err;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      err = e;
      if (!isTransientD1(e)) throw e;
      await new Promise(r => setTimeout(r, 200 * (i + 1) * (i + 1)));   // 200ms, 800ms
    }
  }
  throw err;
}

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

export async function createOrUpdateJobFromPayload(env, tenantId, body) {
  const cfg = await getConfig(env, tenantId);
  const id = body.id || body.reference || crypto.randomUUID();
  const existing = await getJob(env, tenantId, id);
  const now = new Date().toISOString();

  const catNames = (await getCategories(env, tenantId)).map(c => c.name);
  let status = normalizeStatus(body.status || existing?.status, catNames);
  const raisedAt = body.raisedAt || existing?.raisedAt || now;
  // Projects have NO priority level and NO SLA at all — for every user. Everything
  // else keeps the priority-driven SLA target.
  const isProjJob = /^p\d/i.test(String(body.siteCode || existing?.siteCode || "")) ||
    /project/i.test(String(body.storeType || existing?.storeType || body.client || ""));
  // Fleet renewal jobs (auto-made MOT/service appointments) carry NO priority and
  // NO SLA target — like projects — so a garage booking weeks out never shows an
  // SLA "breached" badge.
  const isFleetRenewal = body.fleetRenewal === true || existing?.fleetRenewal === true;
  const noSla = isProjJob || isFleetRenewal;
  const priority = noSla ? "" : (body.priority || existing?.priority || "Priority 4");
  const targetAt = noSla ? null : computeSlaTarget(raisedAt, priority, cfg);

  // Resolve the site NAME so a project job reads its real name (e.g. "Yard"),
  // not the bare P-number — even when the job was raised before the site was
  // named, or the site was renamed afterwards. Falls back to the site code.
  let siteNameResolved = String(body.siteName ?? existing?.siteName ?? "").trim();
  const siteCodeVal = String(body.siteCode || existing?.siteCode || "").trim();
  if (!siteNameResolved && siteCodeVal) {
    try {
      const srow = await tenantDB(env, tenantId).prepare("SELECT site_name FROM sites WHERE site_number=? LIMIT 1").bind(siteCodeVal).first();
      const nm = srow && String(srow.site_name || "").trim();
      if (nm && nm !== siteCodeVal) siteNameResolved = nm;
    } catch {}
  }

  // `clearEngineers:true` explicitly unassigns (an empty assignedEngineers array is
  // otherwise treated as "leave as-is" so a partial re-save can't wipe the roster).
  const assignedEngineers = body.clearEngineers ? []
    : (Array.isArray(body.assignedEngineers) && body.assignedEngineers.length
       ? body.assignedEngineers.filter(Boolean)
       : (body.assignedTo ? [body.assignedTo]
          : (existing?.assignedEngineers || (existing?.assignedTo ? [existing.assignedTo] : []))));

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
  // Expected on-site duration, persisted in its own right so an UNSCHEDULED job
  // still carries it (the finish time only exists once a job has a start). Used
  // by the route optimiser to predict a day. Preserved across re-saves.
  const durationMinutes = Number.isFinite(Number(body.durationMinutes))
    ? Math.max(15, Math.round(Number(body.durationMinutes)))
    : (existing?.durationMinutes ?? null);

  // Per-job gates: whether this job needs a Risk Assessment and a customer
  // signature. Default OFF for projects (P-numbered site / projects client), ON
  // for everything else. An explicit value from the form/editor wins; an existing
  // job's stored value is preserved when not re-specified. (isProjJob computed above.)
  // Site-audit job: completion is per-item (each checklist item needs one photo),
  // so the standard whole-job gates default OFF (an explicit value still wins).
  const isAudit = Array.isArray(body.auditItems) ? body.auditItems.length > 0 : isAuditJob(existing);
  const gateDefault = !noSla && !isAudit;
  const requiresRA = body.requiresRA !== undefined ? !!body.requiresRA
    : (existing?.requiresRA !== undefined ? !!existing.requiresRA : gateDefault);
  const requiresSignature = body.requiresSignature !== undefined ? !!body.requiresSignature
    : (existing?.requiresSignature !== undefined ? !!existing.requiresSignature : gateDefault);
  const requiresPhoto = body.requiresPhoto !== undefined ? !!body.requiresPhoto
    : (existing?.requiresPhoto !== undefined ? !!existing.requiresPhoto : gateDefault);
  const requiresNote = body.requiresNote !== undefined ? !!body.requiresNote
    : (existing?.requiresNote !== undefined ? !!existing.requiresNote : gateDefault);

  // A job's reference must never be the internal UUID — that shows up as gibberish
  // in lists and notifications. When no reference is typed, default it to a CLEAR
  // name: a project job uses its project number (site code, e.g. "P0002"); every
  // other job uses the SITE NAME (else the site code). Heal an old job whose ref
  // defaulted to the UUID the same way. An explicitly typed reference always wins.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let helpdeskRef = body.reference || existing?.helpdeskRef || id;
  if (!body.reference) {
    // The id reliably carries "<number>-<site>". If it does and the ref has lost
    // its number, restore the ref FROM the id (don't strip it to the site name —
    // the old "ref === id ⇒ placeholder" rule corrupted these on every save).
    const idIsNumSite = /^\d/.test(String(id)) && !UUID_RE.test(String(id));
    if (idIsNumSite && !/^\d/.test(String(helpdeskRef))) {
      helpdeskRef = id;
    } else if (!helpdeskRef || UUID_RE.test(String(helpdeskRef)) || (helpdeskRef === id && !idIsNumSite)) {
      // Site NAME first (else the site code) — for PROJECTS too, so a project job
      // reads "Yard", not the bare "P0007". An explicitly typed reference wins above.
      helpdeskRef = siteNameResolved || siteCodeVal || id;
    }
  }

  const job = {
    id,
    helpdeskRef,
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
    siteName: siteNameResolved || "",
    address: body.address || existing?.address || "",
    telephone: body.telephone || existing?.telephone || "",
    postcode: body.postcode || existing?.postcode || "",
    lat: body.lat ?? existing?.lat ?? null,
    lon: body.lon ?? existing?.lon ?? null,
    storeType: body.storeType || existing?.storeType || "",
    sharepointURL: body.sharepointURL || existing?.sharepointURL || "",
    requiresRA, requiresSignature, requiresPhoto, requiresNote,
    // Firestopping job: produces the RIA form + product-spec bundle instead of
    // the standard completion (photo/note/signature). Preserved across re-saves.
    firestopping: body.firestopping !== undefined ? !!body.firestopping : (existing?.firestopping || false),
    firestop: existing?.firestop,
    // Site-audit checklist: ONE job, many items, each item needing a completion
    // photo in the field. Text edits preserve completed items (matched by id).
    auditItems: normAuditItems(body.auditItems, existing),
    // Emergency-lighting + PAT test type (a combined EM+PAT job carries both).
    emTest: body.emTest !== undefined ? !!body.emTest : (existing?.emTest || false),
    pat: body.pat !== undefined ? !!body.pat : (existing?.pat || false),
    emTimer: body.emTimer !== undefined ? (body.emTimer || null) : (existing?.emTimer || null),
    // Investigate-only job: shows a big red "INVESTIGATE ONLY" banner on the
    // engineer + office job pages. Preserved across re-saves.
    investigateOnly: body.investigateOnly !== undefined ? !!body.investigateOnly : (existing?.investigateOnly || false),
    // Portal-project link: set when this job was raised from a project hub, so
    // the project can list its jobs + roll up per-engineer visits. Preserved.
    projectId: body.projectId !== undefined ? (String(body.projectId || "") || null) : (existing?.projectId || null),
    scheduledAt,
    scheduledEnd,
    durationMinutes,
    // Area of work (id from app_config sla_work_areas) — used to match jobs to
    // engineers competent in that area when suggesting/auto-scheduling. Preserved.
    workArea: body.workArea !== undefined ? (String(body.workArea || "") || null) : (existing?.workArea ?? null),
    // Visibility scheduling (carried across re-saves). A changed release re-arms
    // the announcement push; releaseNotified tracks whether it has fired.
    release: (body.release !== undefined
      ? (body.release && body.release.mode && body.release.mode !== "now"
          ? { mode: body.release.mode, at: body.release.at || undefined, hour: (body.release.hour != null ? Number(body.release.hour) : undefined) }
          : undefined)
      : existing?.release),
    releaseNotified: (body.release !== undefined && JSON.stringify(body.release || null) !== JSON.stringify(existing?.release || null))
      ? false : (existing?.releaseNotified || false),
    // Project multi-day drip "series": seriesId links the days; seriesSkipped
    // permanently drops a day (clash safeguard). Both preserved across re-saves.
    seriesId: body.seriesId !== undefined ? (String(body.seriesId || "") || null) : (existing?.seriesId ?? null),
    seriesSkipped: body.seriesSkipped !== undefined ? !!body.seriesSkipped : (existing?.seriesSkipped || false),
    // Auto-assigned fallback "at least a job for tomorrow" day (cron). Preserved.
    fallback: body.fallback !== undefined ? !!body.fallback : (existing?.fallback || false),
    // Fleet renewal appointment (auto-made MOT/service booking) — links back to the
    // vehicle so the fleet page can find/reassign/cancel it. Preserved across saves.
    fleetRenewal: body.fleetRenewal !== undefined ? !!body.fleetRenewal : (existing?.fleetRenewal || false),
    vehicleReg: body.vehicleReg !== undefined ? (String(body.vehicleReg || "") || null) : (existing?.vehicleReg ?? null),
    renewalType: body.renewalType !== undefined ? (String(body.renewalType || "") || null) : (existing?.renewalType ?? null),
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

async function patchJob(env, tenantId, id, patch, ctx) {
  const job = await getJob(env, tenantId, id);
  if (!job) return null;
  const now = new Date().toISOString();
  job.statusHistory ||= [];
  job.events ||= [];

  const hadEngineers = assignedList(job).length > 0;
  const prevEngs = assignedList(job);            // roster before this patch
  const prevStatus = job.status;

  if (patch.assignedEngineers !== undefined) {
    job.assignedEngineers = patch.assignedEngineers;
    job.assignedTo = patch.assignedEngineers[0] || "";   // keep legacy field as the primary
  } else if (patch.assignedTo !== undefined) {
    job.assignedTo = patch.assignedTo;
    job.assignedEngineers = patch.assignedTo ? [patch.assignedTo] : [];
  }
  // A job with 2+ engineers gives each their own status slice (see effStatus).
  // Seed any missing ones when the roster changes.
  if (patch.assignedEngineers !== undefined || patch.assignedTo !== undefined) {
    seedEngStatus(job, prevEngs, prevStatus, now);
  }
  // Visibility scheduling: when it becomes visible to the engineer. Changing the
  // release re-arms `releaseNotified` so the assignment push fires at the new time.
  if (patch.release !== undefined) {
    const prev = job.release ? JSON.stringify(job.release) : "";
    if (!patch.release || !patch.release.mode || patch.release.mode === "now") job.release = undefined;
    else job.release = { mode: patch.release.mode, at: patch.release.at || undefined, hour: (patch.release.hour != null ? Number(patch.release.hour) : undefined) };
    if ((job.release ? JSON.stringify(job.release) : "") !== prev) job.releaseNotified = false;
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
  if (patch.durationMinutes !== undefined) {
    const mins = Math.max(15, Number(patch.durationMinutes) || 60);
    // Persist the expected duration in its own right (survives on an unscheduled
    // job) AND slide the finish time when the job has a start.
    job.durationMinutes = mins;
    if (job.scheduledAt) {
      const s = Date.parse(job.scheduledAt);
      if (Number.isFinite(s)) job.scheduledEnd = new Date(s + mins * 60000).toISOString();
    }
  }
  if (patch.siteCode !== undefined) job.siteCode = patch.siteCode;
  if (patch.requiresRA !== undefined) job.requiresRA = !!patch.requiresRA;
  if (patch.requiresSignature !== undefined) job.requiresSignature = !!patch.requiresSignature;
  if (patch.requiresPhoto !== undefined) job.requiresPhoto = !!patch.requiresPhoto;
  if (patch.requiresNote !== undefined) job.requiresNote = !!patch.requiresNote;
  if (patch.firestopping !== undefined) job.firestopping = !!patch.firestopping;
  if (patch.auditItems !== undefined) job.auditItems = normAuditItems(patch.auditItems, job);
  if (patch.emTest !== undefined) job.emTest = !!patch.emTest;
  if (patch.pat !== undefined) job.pat = !!patch.pat;
  if (patch.emTimer !== undefined) job.emTimer = patch.emTimer || null;   // 3h drain-down countdown
  if (patch.investigateOnly !== undefined) job.investigateOnly = !!patch.investigateOnly;
  if (patch.projectId !== undefined) job.projectId = String(patch.projectId || "") || null;
  if (patch.workArea !== undefined) job.workArea = String(patch.workArea || "") || null;
  if (patch.seriesId !== undefined) job.seriesId = String(patch.seriesId || "") || null;
  if (patch.seriesSkipped !== undefined) job.seriesSkipped = !!patch.seriesSkipped;
  if (patch.fallback !== undefined) job.fallback = !!patch.fallback;
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
  // The reference should read "<ticket number> - <site>". The job id reliably
  // carries that ("28548-Bristol, Ashley Down Road"), so:
  //  • if the id is a real "<number>-<site>" and the ref has lost its number
  //    (just the site, or equals the id), restore the ref FROM the id;
  //  • else, a genuine placeholder (empty / a raw UUID / equals a UUID id) heals
  //    to a clear name (project → number, otherwise the site).
  // NB the old rule "ref === id ⇒ placeholder" was WRONG for these jobs and was
  // stripping the number off the ref on every patch.
  {
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const idStr = String(job.id || "");
    const idIsNumSite = /^\d/.test(idStr) && !uuidRe.test(idStr);
    const ref = String(job.helpdeskRef || "");
    if (idIsNumSite && !/^\d/.test(ref)) {
      job.helpdeskRef = idStr;   // restore "<number>-<site>" from the id
    } else if (!ref || uuidRe.test(ref) || (ref === idStr && !idIsNumSite)) {
      const siteNm = String(job.siteName || "").trim(), siteCd = String(job.siteCode || "").trim();
      const healed = siteNm || siteCd;   // site NAME first, for projects too
      if (healed) job.helpdeskRef = healed;
    }
  }
  if (patch.raisedAt !== undefined && patch.raisedAt) job.raisedAt = patch.raisedAt;
  // The SLA target is raised-time + priority window — recompute it whenever
  // either of those is edited, so the countdown always reflects the truth.
  if ((patch.priority !== undefined && patch.priority) || (patch.raisedAt !== undefined && patch.raisedAt)) {
    const cfg = await getConfig(env, tenantId);
    job.targetAt = computeSlaTarget(job.raisedAt || now, job.priority, cfg);
  }
  // Projects never carry a priority level or an SLA target, for any user.
  if (jobIsProject(job)) { job.priority = ""; job.targetAt = null; }
  if (patch.quote !== undefined) job.quote = patch.quote;   // quote pack
  if (patch.riskAssessment !== undefined) job.riskAssessment = patch.riskAssessment;  // pre-start RA
  if (patch.hold !== undefined) job.hold = patch.hold;      // on-hold pack (reason / needs / resume)
  if (patch.order !== undefined) job.order = patch.order;   // parts-order pack
  if (patch.travelStartMileage !== undefined) job.travelStartMileage = patch.travelStartMileage;  // per-job mileage

  if (patch.status && patch.__engActor && isMultiEng(job)) {
    // An engineer changed THEIR status on a shared (multi-engineer) job: record it
    // in their own slice and roll the board status up. Everything else stays shared.
    const catNames = (await getCategories(env, tenantId)).map(c => c.name);
    const s = normalizeStatus(patch.status, catNames);
    job.engStatus = job.engStatus || {};
    const prev = job.engStatus[patch.__engActor] && job.engStatus[patch.__engActor].status;
    if (s !== prev) {
      job.engStatus[patch.__engActor] = { status: s, at: now, by: patch.changedBy || patch.__engActor };
      const entry = { status: s, at: now, by: patch.changedBy || "system", eng: patch.__engActor };
      if (patch.gps) entry.gps = String(patch.gps).slice(0, 40);
      job.statusHistory.push(entry);
    }
    job.status = rollupStatus(job);
    if (String(job.status).toLowerCase() === "closed jobs" && !job.closedAt) job.closedAt = now;
  } else if (patch.status) {
    const catNames = (await getCategories(env, tenantId)).map(c => c.name);
    const s = normalizeStatus(patch.status, catNames);
    if (s !== job.status) {
      job.status = s;
      // Snapshot the engineer's location at the moment of every status change
      // (captured on-device, so it's present even when the change was made
      // offline and replayed later). `gps` = "lat,lon".
      const entry = { status: s, at: now, by: patch.changedBy || "system" };
      if (patch.gps) entry.gps = String(patch.gps).slice(0, 40);
      job.statusHistory.push(entry);
      if (s === "Closed Jobs" && !job.closedAt) job.closedAt = now;
    }
    // Office override on a multi-engineer job: keep every engineer's slice in step
    // so the board rollup matches what the office set.
    if (isMultiEng(job) && job.engStatus) {
      for (const e of assignedList(job).map(normId)) job.engStatus[e] = { status: job.status, at: now, by: patch.changedBy || "office" };
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
  // Customer status-change email (branded; Scheduled carries the reschedule
  // button). Fire-and-forget — never blocks or breaks the status change.
  if (job.status !== prevStatus && ctx && ctx.waitUntil) {
    try { ctx.waitUntil(onStatusTransition(env, tenantId, job, prevStatus, job.status)); } catch {}
  }
  return job;
}

/* ================= MULTI-ENGINEER SPLIT =================
   A job worked by 2+ engineers becomes one INDEPENDENT job PER engineer, so each
   runs their own day: separate status, risk assessment, photos, signature and
   completion. Siblings share a base reference with an -A/-B/… suffix and a
   `groupId`. Called ONLY from the office create / scheduler / edit paths — NEVER
   the Zapier inbound intake (which is always single-engineer). Add-only and
   idempotent: re-saving fills in engineers that don't yet have a job; it never
   deletes a sibling (an engineer is dropped by deleting their own job). */
function groupBaseRef(ref) { return String(ref || "").replace(/-[A-Z]$/, ""); }
function nextGroupLetter(used) {
  for (let i = 0; i < 26; i++) { const L = String.fromCharCode(65 + i); if (!used.has(L)) return L; }
  return "Z";
}
async function splitJobByEngineers(env, tenantId, primary, changedBy, ctx) {
  const engineers = assignedList(primary);
  if (engineers.length < 2) return primary;   // nothing to split — no-op

  const now = new Date().toISOString();
  const groupId = primary.groupId || primary.id;
  const base = groupBaseRef(primary.helpdeskRef || primary.id);

  // Existing group members (the primary + any siblings already created), so a
  // re-save only ADDS the engineers who don't yet have a job.
  const all = await listJobs(env, tenantId);
  const members = all.filter(j => (j.groupId && j.groupId === groupId) || j.id === primary.id);
  const byEng = new Map();               // normId(engineer) -> existing job
  const usedLetters = new Set();
  for (const j of members) {
    const e = assignedList(j)[0];
    if (e) byEng.set(normId(e), j);
    if (j.groupLabel) usedLetters.add(j.groupLabel);
  }

  // The primary becomes engineer[0]'s own job.
  const first = engineers[0];
  primary.assignedEngineers = [first];
  primary.assignedTo = first;
  primary.groupId = groupId;
  primary.groupRef = base;
  if (!primary.groupLabel) { primary.groupLabel = nextGroupLetter(usedLetters); usedLetters.add(primary.groupLabel); }
  primary.helpdeskRef = `${base}-${primary.groupLabel}`;
  primary.updatedAt = now;
  await saveJob(env, tenantId, primary);
  byEng.set(normId(first), primary);

  // Each additional engineer gets their own independent job (created once).
  const created = [];
  for (let i = 1; i < engineers.length; i++) {
    const eng = engineers[i];
    if (byEng.has(normId(eng))) continue;      // already has a job in this group
    const letter = nextGroupLetter(usedLetters); usedLetters.add(letter);
    const sib = {
      ...primary,
      id: crypto.randomUUID(),
      helpdeskRef: `${base}-${letter}`,
      groupId, groupRef: base, groupLabel: letter,
      assignedEngineers: [eng], assignedTo: eng,
      // Fresh per-engineer state — this engineer starts their own day.
      status: "Scheduled",
      riskAssessment: undefined, signature: undefined, quote: undefined,
      hold: undefined, order: undefined, raBlock: undefined, travelStartMileage: undefined,
      releaseNotified: false,
      events: [],
      statusHistory: [{ status: "Scheduled", at: now, by: changedBy || "system" }],
      closedAt: null,
      createdAt: now, updatedAt: now
    };
    await saveJob(env, tenantId, sib);
    byEng.set(normId(eng), sib);
    created.push(sib);
  }

  // Announce each newly-created sibling to its own engineer (respecting release).
  if (ctx && created.length) {
    for (const sib of created) ctx.waitUntil(reconcileRelease(env, tenantId, sib).catch(() => {}));
  }
  return primary;
}

/* ================= SITE FOLDER ================= */

// Site numbers arrive as "42", "0042" or "SR00042" — compare on the number.
function digitsOf(s) { const m = String(s || "").match(/(\d+)/); return m ? String(Number(m[1])) : ""; }
// A genuine STORE code (Co-op/retail store number) — used to match a site to its
// live jobs and imported Co-op archive history. ONLY a pure-numeric site number
// has one; projects ("P0002"), house-number names etc. return "" so they never
// pull an unrelated store's jobs/photos. Number()-normalised to meet
// archiveSiteCode() ("0148"->"148").
function storeCodeOf(s) { const t = String(s || "").trim(); return /^\d+$/.test(t) ? String(Number(t)) : ""; }
// A stable per-site KEY for R2 site storage (documents + uploaded site photos).
// Numeric store numbers keep their normalised key (back-compat with existing
// uploads); non-numeric sites (projects) get their OWN namespace instead of
// colliding on a stripped digit.
function siteKeyOf(s) { const t = String(s || "").trim(); return t ? (/^\d+$/.test(t) ? String(Number(t)) : t.toUpperCase().replace(/[^A-Z0-9]/g, "")) : ""; }
function siteMatches(job, code, nameLower) {
  const jc = storeCodeOf(job.siteCode);
  if (code && jc && jc === code) return true;
  if (!jc && nameLower && (job.siteName || "").trim().toLowerCase() === nameLower) return true;
  return false;
}
// Remove financial fields from an imported archive record for non-admins — by
// key (cost/price/invoice/value/…) or by any value carrying a currency symbol.
const MONEY_KEY = /(cost|price|invoic|value|total|charge|amount|labour|material|profit|margin|\bvat\b|\brate\b|paid|payable|sell|nett|\bnet\b|gross|quote|\bfee\b|balance|deposit|revenue|turnover|expense|£|\$)/i;
function stripFinancial(d) {
  const out = {};
  for (const [k, v] of Object.entries(d || {})) {
    if (MONEY_KEY.test(k)) continue;
    if (v != null && typeof v !== "object" && /[£$€]/.test(String(v))) continue;
    out[k] = v;
  }
  return out;
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

/* ═══════════════ Route optimisation (per-engineer efficient day) ═══════════════
   Maps for the facts (driving times + miles), Claude for the judgement (timed
   jobs, "do this last", priorities). The client sends the engineer's jobs for a
   day WITH resolved coordinates (it already geocodes postcodes for the map); the
   worker resolves the engineer's HOME from their profile, builds the matrix,
   solves a baseline, lets the AI re-order for anomalies, then returns a timeline
   of offsets + a day summary. Times are returned as minutes-from-start so the
   client owns the local wall-clock conversion. */
function haversineMi(a, b) {
  const R = 3958.8, toR = x => x * Math.PI / 180;
  const dLat = toR(b[0] - a[0]), dLng = toR(b[1] - a[1]);
  const la1 = toR(a[0]), la2 = toR(b[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
async function geocodePcServer(pc) {
  const clean = String(pc || "").toUpperCase().replace(/\s+/g, "").trim();
  if (!clean) return null;
  try {
    const res = await fetch("https://api.postcodes.io/postcodes/" + encodeURIComponent(clean),
      { cf: { cacheTtl: 2592000, cacheEverything: true } });
    if (!res.ok) return null;
    const d = await res.json();
    const r = d && d.result;
    if (r && isFinite(r.latitude)) return [Number(r.latitude), Number(r.longitude)];
  } catch { }
  return null;
}
/* ── Same-site + nearby OPEN jobs (allocation-time "whilst you're here" pop-up) ──
   Same-site = same normalised site code (project-safe via siteKeyOf). Nearby =
   straight-line miles from the target job's site to other open jobs' sites,
   within a radius (app_config `sla:nearbyRadius`, default 5). Coords come from a
   job's stored lat/lon else a bulk postcodes.io geocode (edge-cached). */
const NEARBY_FINISHED = new Set(["Complete", "Closed Jobs", "Invoiced", "Cancelled"]);
const isOpenJobStatus = s => !NEARBY_FINISHED.has(String(s || ""));
async function getNearbyRadius(env, tenantId) {
  try {
    const db = tenantDB(env, tenantId);
    const row = await db.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key='sla:nearbyRadius'").bind(tenantId).first();
    const n = Number(row && row.value);
    return isFinite(n) && n > 0 ? n : 5;
  } catch { return 5; }
}
async function geocodePcBulk(pcs) {
  const clean = [...new Set(pcs.map(p => String(p || "").toUpperCase().replace(/\s+/g, "").trim()).filter(Boolean))];
  const out = new Map();
  for (let i = 0; i < clean.length; i += 100) {
    const batch = clean.slice(i, i + 100);
    try {
      const res = await fetch("https://api.postcodes.io/postcodes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ postcodes: batch }), cf: { cacheTtl: 2592000, cacheEverything: true } });
      const d = await res.json();
      (d.result || []).forEach(r => { const q = String(r.query || "").toUpperCase().replace(/\s+/g, ""); if (r.result && isFinite(r.result.latitude)) out.set(q, [Number(r.result.latitude), Number(r.result.longitude)]); });
    } catch { }
  }
  return out;
}
function jobStoredCoord(j) { const lat = Number(j.lat), lng = Number(j.lon); return (isFinite(lat) && isFinite(lng) && (lat || lng)) ? [lat, lng] : null; }
async function jobCoordServer(env, job) {
  const c = jobStoredCoord(job); if (c) return c;
  const pc = String(job.postcode || "").trim();
  if (pc) { const g = await geocodePcServer(pc); if (g) return g; }
  return null;
}
const nearbyLite = j => ({ id: j.id, ref: j.helpdeskRef || j.siteName || j.siteCode || j.id, site: j.siteName || j.siteCode || "", siteCode: j.siteCode || "", status: j.status || "", priority: j.priority || "", scheduledAt: j.scheduledAt || null, assignedEngineers: assignedList(j) });
async function nearbyForJob(env, tenantId, jobId, engineer, radius) {
  const target = await getJob(env, tenantId, jobId);
  if (!target) return { ok: false, error: "job not found" };
  const eng = normId(engineer || "");
  const tKey = siteKeyOf(target.siteCode);
  const all = (await listJobs(env, tenantId)).filter(j => j.id !== jobId && isOpenJobStatus(j.status));
  const notTheirs = j => !eng || !assignedList(j).some(a => normId(a) === eng);
  const sameSite = all.filter(j => tKey && siteKeyOf(j.siteCode) === tKey && notTheirs(j)).map(nearbyLite);
  const sameIds = new Set(sameSite.map(s => s.id));
  let nearby = [];
  const tc = await jobCoordServer(env, target);
  if (tc) {
    const cand = all.filter(j => !sameIds.has(j.id) && !(tKey && siteKeyOf(j.siteCode) === tKey) && notTheirs(j));
    const map = new Map(); const needPc = [];
    for (const j of cand) { const c = jobStoredCoord(j); if (c) map.set(j.id, c); else { const pc = String(j.postcode || "").toUpperCase().replace(/\s+/g, "").trim(); if (pc) needPc.push([j.id, pc]); } }
    if (needPc.length) { const geo = await geocodePcBulk(needPc.map(x => x[1])); for (const [id, pc] of needPc) { const cc = geo.get(pc); if (cc) map.set(id, cc); } }
    for (const j of cand) { const c = map.get(j.id); if (!c) continue; const mi = haversineMi(tc, c); if (mi <= radius) nearby.push({ ...nearbyLite(j), miles: Math.round(mi * 10) / 10 }); }
    nearby.sort((a, b) => a.miles - b.miles);
    nearby = nearby.slice(0, 12);
  }
  return { ok: true, radius, targetSite: target.siteName || target.siteCode || "", hasCoords: !!tc, sameSite, nearby };
}

async function engineerHome(env, tenantId, username) {
  const db = tenantDB(env, tenantId);
  let row = null;
  try { row = await db.prepare("SELECT profile FROM users WHERE tenant_id=? AND username=?").bind(tenantId, username).first(); } catch { }
  let prof = {}; try { prof = JSON.parse(row?.profile || "{}") || {}; } catch { }
  const lat = Number(prof.homeLat), lng = Number(prof.homeLng ?? prof.homeLon);
  if (isFinite(lat) && isFinite(lng) && (lat || lng)) return { coord: [lat, lng], postcode: prof.homePostcode || "" };
  const pc = String(prof.homePostcode || "").trim();
  if (pc) { const g = await geocodePcServer(pc); if (g) return { coord: g, postcode: pc }; }
  return null;
}
// Full driving-time + distance matrix over an array of [lat,lng] points. Google
// FREE real road-time matrix via OSRM (OpenStreetMap routing — no API key, no
// cost). One request returns an N×N duration matrix. Public server allows ~100
// coordinates per request; returns null on any problem so callers fall back.
async function osrmTable(pts) {
  if (!pts || pts.length < 2 || pts.length > 100) return null;
  const coords = pts.map(p => `${p[1]},${p[0]}`).join(";");   // OSRM wants lng,lat
  try {
    const res = await fetch(`https://router.project-osrm.org/table/v1/driving/${coords}?annotations=duration`, { signal: AbortSignal.timeout(7000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.code !== "Ok" || !Array.isArray(data.durations)) return null;
    const mins = data.durations.map(row => row.map(s => (s == null ? 0 : Math.max(1, Math.round(s / 60)))));
    return { mins, source: "osrm" };
  } catch { return null; }
}
// Free real times (OSRM) when they fit one request, else a haversine estimate.
async function roadMatrix(pts) {
  const osrm = await osrmTable(pts);
  if (osrm) return osrm;
  const n = pts.length, mins = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) mins[i][j] = Math.max(1, Math.round(haversineMi(pts[i], pts[j]) * 1.25 / 30 * 60));
  return { mins, source: "estimate" };
}

// Distance Matrix (chunked to the 100-element-per-request cap); on any failure /
// no key, a haversine × 1.25 road-factor estimate at ~30 mph.
async function driveMatrix(env, pts) {
  const n = pts.length;
  const mins = Array.from({ length: n }, () => Array(n).fill(0));
  const miles = Array.from({ length: n }, () => Array(n).fill(0));
  const estPair = (i, j) => { const mi = haversineMi(pts[i], pts[j]) * 1.25; miles[i][j] = Math.round(mi * 10) / 10; mins[i][j] = Math.max(1, Math.round(mi / 30 * 60)); };
  const fallback = () => { for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) estPair(i, j); return { mins, miles, source: "estimate" }; };
  const key = env.GOOGLE_MAPS_KEY || "";
  if (!key) return fallback();
  try {
    const latlng = pts.map(p => p[0] + "," + p[1]);
    const per = Math.max(1, Math.floor(100 / n));   // origins per request so origins×dests ≤ 100
    let anyOk = false;
    for (let o = 0; o < n; o += per) {
      const originsIdx = [];
      for (let k = o; k < Math.min(o + per, n); k++) originsIdx.push(k);
      const url = "https://maps.googleapis.com/maps/api/distancematrix/json"
        + "?origins=" + encodeURIComponent(originsIdx.map(i => latlng[i]).join("|"))
        + "&destinations=" + encodeURIComponent(latlng.join("|"))
        + "&mode=driving&units=imperial&key=" + encodeURIComponent(key);
      const res = await fetch(url);
      const data = await res.json();
      if (data.status !== "OK") { for (const i of originsIdx) for (let j = 0; j < n; j++) if (i !== j) estPair(i, j); continue; }
      (data.rows || []).forEach((row, ri) => {
        const i = originsIdx[ri];
        (row.elements || []).forEach((el, j) => {
          if (i === j) return;
          if (el && el.status === "OK") { miles[i][j] = Math.round((el.distance.value / 1609.344) * 10) / 10; mins[i][j] = Math.max(1, Math.round(el.duration.value / 60)); anyOk = true; }
          else estPair(i, j);
        });
      });
    }
    return { mins, miles, source: anyOk ? "google" : "estimate" };
  } catch { return fallback(); }
}
// Nearest-neighbour then 2-opt over a driving-time matrix. Point 0 is home; the
// tour is a round trip home→…→home. Returns the job point indices (1..N) in order.
function solveRoute(cost) {
  const n = cost.length;
  const jobIdx = []; for (let i = 1; i < n; i++) jobIdx.push(i);
  if (jobIdx.length <= 1) return jobIdx;
  const unv = new Set(jobIdx); const order = []; let cur = 0;
  while (unv.size) { let best = null, bd = Infinity; for (const j of unv) if (cost[cur][j] < bd) { bd = cost[cur][j]; best = j; } order.push(best); unv.delete(best); cur = best; }
  const tourCost = seq => { let c = cost[0][seq[0]]; for (let i = 0; i < seq.length - 1; i++) c += cost[seq[i]][seq[i + 1]]; return c + cost[seq[seq.length - 1]][0]; };
  let best = order.slice(), bestC = tourCost(best), improved = true, guard = 0;
  while (improved && guard++ < 60) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) for (let k = i + 1; k < best.length; k++) {
      const cand = best.slice(0, i).concat(best.slice(i, k + 1).reverse(), best.slice(k + 1));
      const c = tourCost(cand);
      if (c + 1e-9 < bestC) { best = cand; bestC = c; improved = true; }
    }
  }
  return best;
}
async function anthropicRouteOrder(env, { jobs, matrixMins, dayStart, notes, baseSeq }) {
  const key = env.ANTHROPIC_API_KEY;
  const model = env.ANTHROPIC_MODEL || "claude-sonnet-5";
  const N = jobs.length;
  const lines = jobs.map((j, i) => `${i + 1}. ${j.ref}${j.site && j.site !== j.ref ? " (" + j.site + ")" : ""} — ${j.durationMin} min on site${j.priority ? ", " + j.priority : ""}`);
  const hdr = "    " + Array.from({ length: N + 1 }, (_, k) => (k === 0 ? "H" : String(k)).padStart(4)).join("");
  const rows = [];
  for (let i = 0; i <= N; i++) rows.push((i === 0 ? "H" : String(i)).padStart(3) + " " + Array.from({ length: N + 1 }, (_, j) => String(matrixMins[i][j]).padStart(4)).join(""));
  const schema = {
    type: "object", properties: {
      order: { type: "array", items: { type: "integer" }, description: `Every job number (1..${N}), each exactly once, in visiting order.` },
      reasoning: { type: "string", description: "One or two short sentences on the order chosen." },
      notes: { type: "string", description: "Any instruction you could NOT honour, else empty." }
    }, required: ["order"]
  };
  const system = "You are a routing assistant for a UK field-service engineer. Order the jobs to minimise total driving time for a round trip that starts and ends at the engineer's home (point H), UNLESS an office instruction requires otherwise. Strictly honour any fixed times, sequencing or priorities the office typed, even at the cost of extra driving. Return every job number exactly once.";
  const userContent =
    `Day starts at ${dayStart} from home (H).\n\nJobs:\n${lines.join("\n")}\n\n` +
    `Driving time between points (minutes; H = home, columns and rows are point numbers):\n${hdr}\n${rows.join("\n")}\n\n` +
    `Shortest-driving baseline order (job numbers): ${baseSeq.join(" → ")}\n\n` +
    (notes.trim() ? `Office instructions (these OVERRIDE pure efficiency):\n${notes.trim()}\n\n` : "") +
    `Return the visiting order as job numbers.`;
  let resp;
  try {
    resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 1500, system, tools: [{ name: "set_route", description: "Return the route.", input_schema: schema }], tool_choice: { type: "tool", name: "set_route" }, messages: [{ role: "user", content: userContent }] }),
    });
  } catch { return { ok: false, error: "Couldn't reach the AI to apply your notes — used shortest-driving order." }; }
  if (!resp.ok) {
    let detail = ""; try { const j = await resp.json(); detail = j?.error?.message || ""; } catch { }
    if (resp.status === 401 || resp.status === 403) return { ok: false, error: "The AI key was rejected — used shortest-driving order." };
    if (resp.status === 404 && /model/i.test(detail)) return { ok: false, error: `The AI model "${model}" isn't available on this key — used shortest-driving order.` };
    return { ok: false, error: "The AI service errored — used shortest-driving order." + (detail ? " (" + detail + ")" : "") };
  }
  let payload; try { payload = await resp.json(); } catch { return { ok: false, error: "AI gave an unreadable reply — used shortest-driving order." }; }
  const block = Array.isArray(payload.content) ? payload.content.find(c => c.type === "tool_use" && c.name === "set_route") : null;
  if (!block?.input?.order) return { ok: false, error: "AI didn't return an order — used shortest-driving order." };
  return { ok: true, order: block.input.order, reasoning: block.input.reasoning || "", notes: block.input.notes || "" };
}
async function optimiseEngineerRoute(env, tenantId, body) {
  const engineer = String(body.engineer || "").trim();
  const date = String(body.date || "").slice(0, 10);
  const dayStart = /^\d{1,2}:\d{2}$/.test(body.dayStart || "") ? body.dayStart : "08:00";
  const lunchMinutes = Math.max(0, Math.min(120, Math.round(Number(body.lunchMinutes)) || 0));
  const notes = String(body.notes || "").slice(0, 2000);
  const useAI = body.useAI !== false;
  const inJobs = Array.isArray(body.jobs) ? body.jobs : [];
  const warnings = [];

  if (!engineer) return { ok: false, error: "No engineer given." };
  const home = await engineerHome(env, tenantId, engineer);
  if (!home) return { ok: false, needsHome: true, error: "No home location saved for this engineer. Add a home postcode in Users Admin so the round-trip route can be worked out." };

  // Keep only jobs we can place; warn about the rest (they stay put).
  const jobs = [];
  for (const j of inJobs) {
    const lat = Number(j.lat), lng = Number(j.lng ?? j.lon);
    let coord = (isFinite(lat) && isFinite(lng) && (lat || lng)) ? [lat, lng] : null;
    if (!coord && j.postcode) { const g = await geocodePcServer(j.postcode); if (g) coord = g; }
    if (!coord) { warnings.push(`${j.ref || j.site || "A job"} has no map location — left where it is.`); continue; }
    jobs.push({
      id: String(j.id), ref: String(j.ref || j.site || j.id), site: String(j.site || ""),
      priority: String(j.priority || ""), durationMin: Math.max(15, Math.round(Number(j.durationMinutes)) || 60), coord
    });
  }
  if (jobs.length < 2) return { ok: false, error: "Need at least two locatable jobs on this day to optimise a route.", warnings };

  const pts = [home.coord, ...jobs.map(j => j.coord)];
  const M = await driveMatrix(env, pts);
  const baseSeq = solveRoute(M.mins);
  let order = baseSeq, aiUsed = false, aiReason = "";

  if (useAI && env.ANTHROPIC_API_KEY) {
    const ai = await anthropicRouteOrder(env, { jobs, matrixMins: M.mins, dayStart, notes, baseSeq });
    if (ai.ok) {
      const seq = ai.order.map(Number).filter(nn => nn >= 1 && nn <= jobs.length);
      const uniq = [...new Set(seq)];
      if (uniq.length === jobs.length) { order = uniq; aiUsed = true; aiReason = ai.reasoning || ""; if (ai.notes) warnings.push(ai.notes); }
      else warnings.push("The AI order was incomplete, so the shortest-driving order was used instead.");
    } else if (ai.error) warnings.push(ai.error);
  } else if (useAI && !env.ANTHROPIC_API_KEY) {
    warnings.push("AI ordering is off (no ANTHROPIC_API_KEY) — ordered by shortest driving only; timed-job notes weren't applied.");
  }

  // Timeline: offsets in minutes from the day start; the client converts to wall
  // clock. cur = current point (0 = home).
  const [sh, sm] = dayStart.split(":").map(Number);
  const lunchTargetOffset = Math.max(0, (13 * 60) - (sh * 60 + sm));   // aim lunch ~13:00
  const legs = [];
  let cur = 0, t = 0, driveMins = 0, driveMiles = 0, siteMins = 0;
  for (const p of order) {
    const dMin = M.mins[cur][p], dMi = M.miles[cur][p];
    driveMins += dMin; driveMiles += dMi;
    const arrival = t + dMin;
    const j = jobs[p - 1];
    legs.push({ jobId: j.id, ref: j.ref, site: j.site, priority: j.priority, driveMins: dMin, driveMiles: Math.round(dMi * 10) / 10, arrivalOffset: arrival, durationMin: j.durationMin });
    siteMins += j.durationMin;
    t = arrival + j.durationMin;
    cur = p;
  }
  const homeMin = M.mins[cur][0], homeMi = M.miles[cur][0];
  driveMins += homeMin; driveMiles += homeMi;

  // Fixed lunch allowance, inserted before the first job arriving after ~13:00
  // (else after the last job). Everything from there shifts by the break.
  let lunch = null;
  if (lunchMinutes > 0) {
    let idx = legs.findIndex(l => l.arrivalOffset >= lunchTargetOffset);
    if (idx === -1) idx = legs.length;
    const at = idx < legs.length ? legs[idx].arrivalOffset : t;
    lunch = { offset: at, minutes: lunchMinutes, beforeJobId: idx < legs.length ? legs[idx].jobId : null };
    for (let i = idx; i < legs.length; i++) legs[i].arrivalOffset += lunchMinutes;
    t += lunchMinutes;
  }

  const endOffset = t + homeMin;
  return {
    ok: true, engineer, date, dayStart, aiUsed, aiReason, matrixSource: M.source,
    home: { postcode: home.postcode }, legs, lunch,
    summary: {
      jobs: jobs.length, driveMins: Math.round(driveMins), driveMiles: Math.round(driveMiles * 10) / 10,
      siteMins: Math.round(siteMins), lunchMins: lunchMinutes, dayLengthMins: Math.round(endOffset),
      homeDriveMins: homeMin, homeDriveMiles: Math.round(homeMi * 10) / 10, source: M.source
    },
    warnings
  };
}

/* Auto-make-a-day: given a date, one-or-many engineers and a pool of loose jobs,
   assign + order each job into an efficient day, preferring an engineer competent
   in the job's work area (soft) and respecting a per-day capacity. Deterministic —
   Google Distance Matrix (or haversine estimate) only, NO Claude — so it's cheap.
   Returns a PREVIEW; the client PATCHes assignments/times on Apply. */
async function autoScheduleDay(env, tenantId, body) {
  const dayStart = /^\d{1,2}:\d{2}$/.test(body.dayStart || "") ? body.dayStart : "08:00";
  const lunch = Math.max(0, Math.min(120, Math.round(Number(body.lunchMinutes)) || 30));
  // Door-to-door day target ~9h (8-10h band). cap = travel + on-site minutes.
  const dayMinutes = Math.max(180, Math.min(720, Math.round(Number(body.dayMinutes)) || 540));
  const cap = Math.max(120, dayMinutes - lunch);            // working minutes/engineer (travel + on-site)
  const warnings = [];
  const skills = await getEngSkills(env, tenantId);
  const dur = await estimateJobDurations(env, tenantId);    // learned typical job length
  const normPrio = p => { const m = /(\d)/.exec(String(p || "")); return m ? Number(m[1]) : 5; };
  const estimateFor = p => { const m = /(\d)/.exec(String(p || "")); const key = m ? "Priority " + m[1] : ""; return (dur.byPriority && dur.byPriority[key]) || dur.typical; };
  // Postcode district (e.g. "GU15") — the unit we cluster/explain by; falls back
  // to the first word of the site name.
  const outward = pc => { const s = String(pc || "").trim().toUpperCase(); const m = s.match(/^[A-Z]{1,2}\d[A-Z\d]?/); return m ? m[0] : ""; };
  const hmm = m => { m = Math.round(m || 0); const h = Math.floor(m / 60), mm = m % 60; return h ? (h + "h" + (mm ? " " + mm + "m" : "")) : (mm + "m"); };

  const engs = [];
  for (const e of (Array.isArray(body.engineers) ? body.engineers : [])) {
    const u = String(e.username || "").trim(); if (!u) continue;
    let coord = null;
    const lat = Number(e.homeLat), lng = Number(e.homeLng ?? e.homeLon);
    if (isFinite(lat) && isFinite(lng) && (lat || lng)) coord = [lat, lng];
    if (!coord) { const h = await engineerHome(env, tenantId, u); if (h) coord = h.coord; }
    if (!coord && e.homePostcode) { const g = await geocodePcServer(e.homePostcode); if (g) coord = g; }
    if (!coord) { warnings.push(`${e.name || u} has no home location — skipped.`); continue; }
    engs.push({ username: u, name: String(e.name || u), coord, hq: !!e._hq, sk: skills[normId(u)] || {}, seq: [], load: 0 });
  }
  if (!engs.length) return { ok: false, error: "None of the chosen engineers has a home location saved (set a home postcode in Users Admin)." };

  const jobs = [];
  for (const j of (Array.isArray(body.jobs) ? body.jobs : [])) {
    let coord = null;
    const lat = Number(j.lat), lng = Number(j.lng ?? j.lon);
    if (isFinite(lat) && isFinite(lng) && (lat || lng)) coord = [lat, lng];
    if (!coord && j.postcode) { const g = await geocodePcServer(j.postcode); if (g) coord = g; }
    if (!coord) { warnings.push(`${j.ref || j.site || "A job"} has no map location — left unscheduled.`); continue; }
    // Use the job's own set length if it has one, otherwise the LEARNED estimate.
    const explicit = Number(j.durationMinutes);
    const hasExplicit = Number.isFinite(explicit) && explicit > 0;
    const durationMin = hasExplicit ? Math.max(15, Math.round(explicit)) : Math.max(15, Math.round(estimateFor(j.priority)));
    const ow = outward(j.postcode);
    jobs.push({ id: String(j.id), ref: String(j.ref || j.site || j.id), site: String(j.site || ""), priority: String(j.priority || ""), durationMin, estimated: !hasExplicit, workArea: String(j.workArea || ""), area: ow || String(j.site || "").split(/[,\s]/)[0] || "", iow: /^PO(3\d|4[01])$/.test(ow), coord });
  }
  if (!jobs.length) return { ok: false, error: "No locatable unscheduled jobs to place.", warnings };

  // AI estimates are the PRIMARY length for a job with no set duration: read its
  // description and estimate the on-site time (cached per job, so it's a one-off
  // cost). Falls back to the learned historical typical already set above.
  let aiUsed = 0, aiSource = "history";
  const needIds = jobs.filter(j => j.estimated).map(j => j.id);
  if (needIds.length && env.ANTHROPIC_API_KEY) {
    const cache = await loadAiDurCache(env, tenantId);
    const missing = needIds.filter(id => !(id in cache));
    if (missing.length) {
      const got = await aiEstimateDurations(env, await jobMetaForIds(env, tenantId, missing));
      if (Object.keys(got).length) { Object.assign(cache, got); await saveAiDurCache(env, tenantId, cache); }
    }
    for (const j of jobs) if (j.estimated && cache[j.id] != null) { j.durationMin = Math.max(15, Math.min(480, Math.round(cache[j.id]))); j.aiEstimated = true; aiUsed++; }
    if (aiUsed) aiSource = "ai";
  } else if (needIds.length && !env.ANTHROPIC_API_KEY) {
    warnings.push("AI duration estimates are off (no ANTHROPIC_API_KEY) — used the learned typical instead.");
  }

  // One matrix over all points: engineer homes first, then jobs. Cap Google use.
  const pts = [...engs.map(e => e.coord), ...jobs.map(j => j.coord)];
  const NE = engs.length;
  // Free real road times (OSRM) when the whole set fits one request; otherwise a
  // fast haversine estimate just to DECIDE the assignment — each engineer's final
  // route is then re-timed with real OSRM below (a day is only a few stops).
  let M;
  if (pts.length <= 90) M = await roadMatrix(pts);
  else {
    const n = pts.length, mins = Array.from({ length: n }, () => Array(n).fill(0));
    for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) if (i !== k) mins[i][k] = Math.max(1, Math.round(haversineMi(pts[i], pts[k]) * 1.25 / 30 * 60));
    M = { mins, source: "estimate" };
  }
  const pE = i => i, pJ = k => NE + k;

  // Ferry crossing: straight-line/road drive can't see the Solent, so add a fixed
  // penalty each way between an Isle-of-Wight job and anywhere on the mainland.
  // A Shanklin round-trip is a real ~1h30 each way (drive to terminal + ferry).
  const FERRY = 90, REMOTE = 75;
  const isIow = [...engs.map(() => false), ...jobs.map(j => !!j.iow)];
  for (let i = 0; i < pts.length; i++) for (let k2 = 0; k2 < pts.length; k2++) if (i !== k2 && isIow[i] !== isIow[k2]) M.mins[i][k2] += FERRY;

  // Cheapest place to slot job k into engineer ei's current route.
  const insertCost = (ei, k) => {
    const route = [pE(ei), ...engs[ei].seq.map(x => pJ(x)), pE(ei)], p = pJ(k);
    let bDelta = Infinity, bPos = 1;
    for (let pos = 1; pos < route.length; pos++) { const a = route[pos - 1], b = route[pos]; const delta = M.mins[a][p] + M.mins[p][b] - M.mins[a][b]; if (delta < bDelta) { bDelta = delta; bPos = pos; } }
    return { pos: bPos, delta: bDelta };
  };
  const nearestHome = k => Math.min(...engs.map((_, ei) => M.mins[pE(ei)][pJ(k)]));

  const order = jobs.map((_, k) => k).sort((a, b) => normPrio(jobs[a].priority) - normPrio(jobs[b].priority) || jobs[b].durationMin - jobs[a].durationMin);
  const unassigned = [], handled = new Set();

  // PHASE 1 — REMOTE clusters (Bristol, Isle of Wight…). A far area is a
  // dedicated one-engineer run: assign ALL of its jobs to the single cheapest
  // engineer, and DEFER any that don't fit rather than sending a second engineer
  // on the same long haul for one store. This is the "never two engineers to
  // Bristol" rule.
  const remoteByArea = {};
  for (const k of order) if (nearestHome(k) > REMOTE) (remoteByArea[jobs[k].area || ("_" + k)] ||= []).push(k);
  const remoteAreas = Object.keys(remoteByArea).sort((a, b) => Math.min(...remoteByArea[b].map(nearestHome)) - Math.min(...remoteByArea[a].map(nearestHome)));
  for (const area of remoteAreas) {
    const ks = remoteByArea[area];
    let bestE = -1, bestCost = Infinity;
    engs.forEach((_, ei) => { const c = Math.min(...ks.map(k => M.mins[pE(ei)][pJ(k)])); if (c < bestCost) { bestCost = c; bestE = ei; } });
    const oneWay = bestE >= 0 ? Math.min(...ks.map(k => M.mins[pE(bestE)][pJ(k)])) : Infinity;
    const areaSite = ks.reduce((s, k) => s + jobs[k].durationMin, 0);
    // EFFICIENCY-FIRST: only do a dedicated run when there's at least as much
    // on-site work as the round-trip driving. Otherwise the whole area is HELD for
    // a planned trip — never drag an engineer across the county for a quick job.
    const justified = bestE >= 0 && areaSite >= oneWay * 2;
    if (!justified) {
      for (const k of ks) { handled.add(k); unassigned.push({ id: jobs[k].id, ref: jobs[k].ref, priority: jobs[k].priority, reason: `held for a planned trip — ${area} is ~${hmm(oneWay === Infinity ? 0 : oneWay)} each way and today isn't worth a dedicated run (${ks.length} job${ks.length > 1 ? "s" : ""}, ${hmm(areaSite)} on site)` }); }
      continue;
    }
    const e = engs[bestE];
    for (const k of ks) {
      handled.add(k);
      const ins = insertCost(bestE, k), newLoad = e.load + ins.delta + jobs[k].durationMin;
      if (newLoad <= cap) { e.seq.splice(ins.pos - 1, 0, k); e.load = newLoad; }
      else unassigned.push({ id: jobs[k].id, ref: jobs[k].ref, priority: jobs[k].priority, reason: `${area} dedicated run (${e.name}) is full — this one won't fit today` });
    }
  }

  // PHASE 2 — the rest: skill-weighted greedy insertion with capacity + a strong
  // pull to keep a postcode area with one engineer.
  for (const k of order) {
    if (handled.has(k)) continue;
    const j = jobs[k];
    let best = null;
    engs.forEach((e, ei) => {
      const ins = insertCost(ei, k);
      const newLoad = e.load + ins.delta + j.durationMin;
      if (newLoad > cap) return;                       // no room in this engineer's day
      const stars = j.workArea ? Number(e.sk[j.workArea] || 0) : -1;
      const sameArea = j.area && e.seq.some(x => jobs[x].area === j.area);
      let eff = ins.delta;
      if (stars > 0) eff -= stars * 4;                 // soft skill preference
      if (sameArea) eff -= 25;                         // area-cohesion pull
      if (best === null || eff < best.eff) best = { ei, pos: ins.pos, newLoad, eff };
    });
    if (!best) { unassigned.push({ id: j.id, ref: j.ref, reason: "no engineer had room in the day" }); continue; }
    engs[best.ei].seq.splice(best.pos - 1, 0, k);
    engs[best.ei].load = best.newLoad;
  }

  // Build each engineer's timeline (offsets from dayStart; lunch ~13:00).
  const [sh, sm] = dayStart.split(":").map(Number);
  const lunchTarget = Math.max(0, (13 * 60) - (sh * 60 + sm));
  const plan = engs.map((e, ei) => {
    // 2-opt tidy the order.
    const sub = [pE(ei), ...e.seq.map(x => pJ(x))];
    const subCost = sub.map(a => sub.map(b => M.mins[a][b]));
    const solved = solveRoute(subCost);            // returns sub-indices 1..n in order
    const orderedK = solved.map(si => e.seq[si - 1]);
    const legs = []; let cur = pE(ei), t = 0, drive = 0, site = 0, lunchDone = lunch === 0;
    for (const k of orderedK) {
      const p = pJ(k), dMin = M.mins[cur][p]; drive += dMin;
      let arrival = t + dMin;
      if (!lunchDone && arrival >= lunchTarget) { arrival += lunch; t += lunch; lunchDone = true; }
      const j = jobs[k];
      legs.push({ jobId: j.id, ref: j.ref, site: j.site, priority: j.priority, workArea: j.workArea, area: j.area, arrivalOffset: arrival, driveMins: dMin, durationMin: j.durationMin, estimated: !!j.estimated, aiEstimated: !!j.aiEstimated, stars: j.workArea ? Number(e.sk[j.workArea] || 0) : -1 });
      site += j.durationMin; t = arrival + j.durationMin; cur = p;
    }
    const homeMin = orderedK.length ? M.mins[cur][pE(ei)] : 0; drive += homeMin;
    return { username: e.username, name: e.name, hq: !!e.hq, legs, summary: { jobs: legs.length, driveMins: Math.round(drive), siteMins: site, dayLengthMins: Math.round(t + homeMin) } };
  }).filter(p => p.legs.length);

  // REAL driving times for the SHOWN routes, FREE via OSRM. The assignment above
  // may have used a fast estimate (a full matrix over every job is too big for one
  // request), but each engineer's actual day is only a few stops — so re-time just
  // those legs with OSRM. No API key, no cost, and every time on screen is real.
  let matrixSource = M.source;
  if (M.source !== "osrm" && plan.length) {
    const coordById = new Map(jobs.map(j => [j.id, j.coord]));
    const engCoord = new Map(engs.map(e => [e.username, e.coord]));
    let allReal = true;
    for (const p of plan) {
      const home = engCoord.get(p.username);
      const pts2 = [home, ...p.legs.map(l => coordById.get(l.jobId))];
      if (!home || pts2.some(c => !c) || pts2.length < 2) { allReal = false; continue; }
      const dm = await roadMatrix(pts2);             // small: home + this day's stops
      if (dm.source !== "osrm") { allReal = false; continue; }
      let t = 0, drive = 0, site = 0, lunchDone = lunch === 0, cur = 0;
      p.legs.forEach((l, idx) => {
        const to = idx + 1, dMin = dm.mins[cur][to]; drive += dMin;
        let arrival = t + dMin;
        if (!lunchDone && arrival >= lunchTarget) { arrival += lunch; t += lunch; lunchDone = true; }
        l.driveMins = dMin; l.arrivalOffset = arrival;
        site += l.durationMin; t = arrival + l.durationMin; cur = to;
      });
      const homeMin = dm.mins[cur][0]; drive += homeMin;
      p.summary = { jobs: p.legs.length, driveMins: Math.round(drive), siteMins: site, dayLengthMins: Math.round(t + homeMin) };
    }
    matrixSource = allReal ? "osrm" : "estimate";
    if (!allReal) warnings.push("Some routes fell back to estimated driving times (the free routing service didn't answer for every one — try again in a moment).");
  }

  // Plain-English "why these jobs" per engineer + a shared-area explainer.
  const areaCounts = legs => { const m = {}; for (const l of legs) { const a = l.area || ""; if (a) m[a] = (m[a] || 0) + 1; } return Object.entries(m).sort((a, b) => b[1] - a[1]); };
  for (const p of plan) {
    const ac = areaCounts(p.legs);
    const skillN = p.legs.filter(l => l.stars > 0).length;
    const bits = [];
    if (ac.length) bits.push("clustered around " + ac.slice(0, 2).map(([a, n]) => `${a} (${n} job${n > 1 ? "s" : ""})`).join(" and ") + (ac.length > 2 ? `, plus ${ac.length - 2} other area${ac.length - 2 > 1 ? "s" : ""}` : ""));
    if (skillN) bits.push(`${skillN} match ${p.name.split(" ")[0]}'s rated skills`);
    bits.push(`fills ${hmm(p.summary.dayLengthMins)} door-to-door with ${hmm(p.summary.driveMins)} driving`);
    if (p.hq) bits.push("routed from HQ (no home postcode set)");
    p.why = bits.join(" · ") + ".";
  }
  // Where two+ engineers share a postcode area, say why (usually: too big for one day).
  const areaMap = {}, areaSite = {};
  for (const p of plan) for (const l of p.legs) { const a = l.area; if (!a) continue; (areaMap[a] ||= {}); areaMap[a][p.name] = (areaMap[a][p.name] || 0) + 1; areaSite[a] = (areaSite[a] || 0) + l.durationMin; }
  const overlaps = [];
  for (const [area, byName] of Object.entries(areaMap)) {
    const es = Object.entries(byName); if (es.length < 2) continue;
    const totalJobs = es.reduce((s, [, n]) => s + n, 0);
    const reason = (areaSite[area] || 0) > cap * 0.7
      ? `${totalJobs} jobs there — more than one engineer can fit in a ${hmm(cap)} working day, so it's shared to keep everyone finishing on time`
      : `both were already passing ${area} on efficient routes — drag a job across if you'd rather one engineer owned the whole area`;
    overlaps.push({ area, engineers: es.map(([name, count]) => ({ name, count })), reason });
  }
  overlaps.sort((a, b) => b.engineers.reduce((s, e) => s + e.count, 0) - a.engineers.reduce((s, e) => s + e.count, 0));

  return {
    ok: true, dayStart, matrixSource, plan, unassigned, warnings, overlaps,
    placed: plan.reduce((a, p) => a + p.legs.length, 0), total: jobs.length,
    durModel: { typical: dur.typical, sampleCount: dur.sampleCount, actualCount: dur.actualCount },
    estimatedCount: jobs.filter(j => j.estimated).length,
    aiUsed, aiSource,
    overruns: dur.overruns,
  };
}

// ── Learned on-site job-duration model ───────────────────────────────────────
// Estimates how long a job takes so the day-planner can allocate realistically,
// and flags jobs that ran well over — which in turn sharpen the estimate.
// Signals (combined): a job's explicitly-set durationMinutes (a human estimate)
// AND the MEASURED actual = "In Progress" → "Complete" from its statusHistory.
// Refines per priority once a bucket has ≥5 samples; else a global median.
// Bounded 30–240 min; default 90 when there's no history yet. Cached per isolate.
let _durCache = null, _durCacheAt = 0;
async function estimateJobDurations(env, tid) {
  if (_durCache && (Date.now() - _durCacheAt) < 5 * 60000) return _durCache;
  const db = tenantDB(env, tid);
  let rows = [];
  try { rows = (await db.prepare("SELECT id, helpdesk_ref, priority, data FROM sla_jobs WHERE tenant_id=?").bind(tid).all()).results || []; }
  catch { rows = []; }
  const norm = p => { const m = /(\d)/.exec(String(p || "")); return m ? "Priority " + m[1] : ""; };
  // Measured actuals are the ground truth; explicit set-durations are a weaker
  // secondary signal (often a uniform placeholder), so prefer actuals and only
  // fall back to set-durations when there's too little real history.
  const actuals = [], actualByPrio = {}, setVals = [], setByPrio = {}, overruns = [], recent = [];
  const MIN = 5;
  for (const r of rows) {
    let d; try { d = JSON.parse(r.data || "{}"); } catch { continue; }
    const prio = norm(r.priority || d.priority);
    const explicit = Number(d.durationMinutes);
    // Measured actual: last "In Progress" → the following "Complete".
    let actual = null, ip = null;
    for (const e of (Array.isArray(d.statusHistory) ? d.statusHistory : [])) {
      const st = String(e.status || "");
      if (st === "In Progress") ip = Date.parse(e.at);
      else if (st === "Complete" && ip) { const mins = Math.round((Date.parse(e.at) - ip) / 60000); if (mins >= 5 && mins <= 600) actual = mins; ip = null; }
    }
    if (Number.isFinite(explicit) && explicit > 0 && explicit <= 600) { setVals.push(explicit); if (prio) (setByPrio[prio] ||= []).push(explicit); }
    if (actual != null) {
      actuals.push(actual); if (prio) (actualByPrio[prio] ||= []).push(actual);
      recent.push({ id: r.id, ref: r.helpdesk_ref || d.helpdeskRef || r.id, priority: prio, allocated: (Number.isFinite(explicit) && explicit > 0) ? Math.round(explicit) : null, actual });
    }
    if (Number.isFinite(explicit) && explicit > 0 && actual != null && actual > Math.max(explicit * 1.5, explicit + 30))
      overruns.push({ ref: r.helpdesk_ref || d.helpdeskRef || r.id, allocated: Math.round(explicit), actual });
  }
  const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
  const clamp = v => v == null ? null : Math.max(30, Math.min(240, v));
  // Prefer measured actuals; fall back to actuals+set-durations; else a default.
  const typical = clamp(actuals.length >= MIN ? median(actuals) : median(actuals.concat(setVals))) ?? 90;
  const byPriority = {};
  const prios = new Set([...Object.keys(actualByPrio), ...Object.keys(setByPrio)]);
  for (const p of prios) {
    const a = actualByPrio[p] || [], s = setByPrio[p] || [];
    const v = clamp(a.length >= MIN ? median(a) : (a.concat(s).length >= MIN ? median(a.concat(s)) : null));
    if (v != null) byPriority[p] = v;
  }
  overruns.sort((a, b) => (b.actual - b.allocated) - (a.actual - a.allocated));
  _durCache = { typical, byPriority, sampleCount: actuals.length + setVals.length, actualCount: actuals.length, overruns: overruns.slice(0, 10), recent: recent.slice(-80).reverse() };
  _durCacheAt = Date.now();
  return _durCache;
}

// ── AI on-site duration estimates (primary; history is the fallback) ─────────
// Claude reads each job's description/trade/priority and estimates its ON-SITE
// working time. Batched (one call per ~40 jobs) so it's cheap, and PERSISTED per
// job in app_config `sla:aidur:<tid>` so a job is only ever estimated once (until
// re-estimated). Fails soft — no key / API error → returns nothing and the caller
// falls back to the learned historical typical.
async function loadAiDurCache(env, tid) {
  try { const row = await tenantDB(env, tid).prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(tid, "sla:aidur:" + tid).first(); return row ? JSON.parse(row.value) : {}; }
  catch { return {}; }
}
async function saveAiDurCache(env, tid, cache) {
  try {
    // Keep it bounded — newest 3000 ids.
    let obj = cache; const keys = Object.keys(cache);
    if (keys.length > 3000) { obj = {}; for (const k of keys.slice(-3000)) obj[k] = cache[k]; }
    await tenantDB(env, tid).prepare("INSERT INTO app_config (tenant_id, key, value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(tid, "sla:aidur:" + tid, JSON.stringify(obj)).run();
  } catch { /* cache is best-effort */ }
}
// metas: [{id, ref, description, priority, site, workArea}] → {id: minutes}
async function aiEstimateDurations(env, metas) {
  if (!env.ANTHROPIC_API_KEY || !metas.length) return {};
  const schema = {
    type: "object",
    properties: {
      estimates: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            minutes: { type: "integer", description: "On-site working minutes (exclude travel), 15–480." },
          },
          required: ["id", "minutes"],
        },
      },
    },
    required: ["estimates"],
  };
  const system = "You estimate how long a UK building-maintenance / facilities job takes ON SITE — the hands-on working time for one engineer, EXCLUDING travel — so an office can schedule the day. Use the description, trade and priority. Typical reactive repairs run 30–90 min; diagnostics/multi-part or install works run longer. Give a whole number of minutes (15–480) for every job id; for a vague description give a sensible middle estimate. Do not omit any job.";
  const chunks = [];
  for (let i = 0; i < metas.length && i < 200; i += 40) chunks.push(metas.slice(i, i + 40));
  const out = {};
  const results = await Promise.all(chunks.map(chunk => {
    const list = chunk.map(m => `- id:${m.id} | ${m.priority || "?"} | ${m.workArea || ""} | ${m.site || ""} | ${String(m.description || m.ref || "").replace(/\s+/g, " ").slice(0, 220)}`).join("\n");
    return anthropicTool(env, { system, user: `Estimate on-site minutes for each job (return every id):\n${list}`, toolName: "set_durations", schema, maxTokens: 1600 }).catch(() => ({ ok: false }));
  }));
  for (const r of results) if (r.ok) for (const e of (r.input.estimates || [])) { const m = Math.round(Number(e.minutes)); if (e.id && Number.isFinite(m)) out[String(e.id)] = Math.max(15, Math.min(480, m)); }
  return out;
}
// Look up description/priority/site for a set of job ids (for the AI prompt).
async function jobMetaForIds(env, tid, ids) {
  if (!ids.length) return [];
  const db = tenantDB(env, tid);
  const chunkIds = ids.slice(0, 200);
  const ph = chunkIds.map(() => "?").join(",");
  let rows = [];
  try { rows = (await db.prepare(`SELECT id, helpdesk_ref, priority, data FROM sla_jobs WHERE tenant_id=? AND id IN (${ph})`).bind(tid, ...chunkIds).all()).results || []; }
  catch { rows = []; }
  return rows.map(r => { let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {} return { id: r.id, ref: r.helpdesk_ref || d.helpdeskRef || "", description: d.description || "", priority: r.priority || d.priority || "", site: (d.site && (d.site.name || d.site)) || "", workArea: d.workArea || "" }; });
}

/* ===== Job archive (imported history) ===== */
let _archiveReady = false;
async function ensureArchive(env, tenantId) {
  if (_archiveReady) return;
  const db = tenantDB(env, tenantId);
  await db.prepare(`CREATE TABLE IF NOT EXISTS sla_jobs_archive (
    tenant_id   INTEGER NOT NULL DEFAULT 1,
    id          TEXT PRIMARY KEY,
    ref         TEXT,
    status      TEXT,
    assigned_to TEXT,
    site_name   TEXT,
    postcode    TEXT,
    created_at  TEXT,
    completed_at TEXT,
    search      TEXT,            -- lowercased haystack for LIKE search
    data        TEXT NOT NULL    -- full imported job JSON
  )`).run();
  try { await db.prepare("CREATE INDEX IF NOT EXISTS idx_arch_created ON sla_jobs_archive(tenant_id, created_at)").run(); } catch {}
  // site_code = the store number pulled from the customer name; links a job's
  // archive photos to its store's Site Photos. Backfilled via /archive/backfill-sites.
  try { await db.prepare("ALTER TABLE sla_jobs_archive ADD COLUMN site_code TEXT").run(); } catch {}
  try { await db.prepare("CREATE INDEX IF NOT EXISTS idx_arch_sitecode ON sla_jobs_archive(tenant_id, site_code)").run(); } catch {}
  _archiveReady = true;
}

// Compute a job's store code from the customer name. In the Commusoft export
// the store number is ALWAYS a 4-digit code at the very start of the customer
// name ("0032 Fareham Gudge Heath Lane", "4050 East Devon Crematorium",
// "9501 Bedford Place - Starbucks"). We must match EXACTLY four leading digits:
// house-number addresses like "32 Archers Road" / "32d High Street" also begin
// with a number, and the old digitsOf() (first digit-run anywhere, leading
// zeros stripped) folded those onto real store codes — e.g. "32 Archers Road"
// collided with store "0032", pulling the wrong store's photos into a gallery.
// Requiring exactly 4 digits followed by a boundary excludes 2-3 digit house
// numbers, letter-suffixed ones ("32a"), and 5+ digit account ids ("80473 …").
// Normalised with Number() so it matches digitsOf() on the lookup side
// ("0032"->"32", "4050"->"4050").
function archiveSiteCode(job) {
  const c = ((job && job.customer && job.customer.name) || "").trim();
  const m = c.match(/^(\d{4})(?=$|\D)/);
  return m ? String(Number(m[1])) : "";
}

// Backfill site_code for archived jobs that don't have one yet. Chunk-capped +
// returns `remaining` so the caller loops. No-code jobs are marked "-" so they
// aren't reprocessed.
async function backfillArchiveSites(env, tenantId, cap = 500) {
  const db = tenantDB(env, tenantId);
  const { results } = await db.prepare(
    "SELECT id, data FROM sla_jobs_archive WHERE tenant_id=? AND (site_code IS NULL OR site_code='') LIMIT ?"
  ).bind(tenantId, cap).all();
  const rows = results || [];
  const stmts = rows.map(r => {
    let code = "-";
    try { code = archiveSiteCode(JSON.parse(r.data)) || "-"; } catch {}
    return db.prepare("UPDATE sla_jobs_archive SET site_code=? WHERE tenant_id=? AND id=?").bind(code, tenantId, r.id);
  });
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  const left = (await db.prepare("SELECT COUNT(*) AS n FROM sla_jobs_archive WHERE tenant_id=? AND (site_code IS NULL OR site_code='')").bind(tenantId).first())?.n || 0;
  return { done: rows.length, remaining: left };
}

// Upsert a batch of imported jobs (keyed by id). Chunked db.batch() calls keep
// each within D1's statement limits; the whole POST is one worker invocation.
async function archiveImport(env, tenantId, rows) {
  const db = tenantDB(env, tenantId);
  const stmts = [];
  for (const j of rows) {
    if (!j || j.id == null || j.id === "") continue;
    const search = [
      j.id, j.helpdeskRef, j.jobName, j.description, j.notes, j.status,
      j.siteName, j.postcode, j.assignedTo,
      j.customer && j.customer.name, j.customer && j.customer.postcode, j.address
    ].filter(Boolean).join(" ").toLowerCase().slice(0, 2000);
    stmts.push(db.prepare(`INSERT INTO sla_jobs_archive
      (tenant_id,id,ref,status,assigned_to,site_name,postcode,created_at,completed_at,search,data)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET ref=excluded.ref, status=excluded.status,
        assigned_to=excluded.assigned_to, site_name=excluded.site_name,
        postcode=excluded.postcode, created_at=excluded.created_at,
        completed_at=excluded.completed_at, search=excluded.search, data=excluded.data`)
      .bind(tenantId, String(j.id), j.helpdeskRef || null, j.status || null,
        j.assignedTo || null, j.siteName || null, j.postcode || null,
        j.createdAt || null, j.completionDate || null, search, JSON.stringify(j)));
  }
  let done = 0;
  for (let i = 0; i < stmts.length; i += 50) {
    await db.batch(stmts.slice(i, i + 50));
    done += Math.min(50, stmts.length - i);
  }
  return done;
}

/* ===== Imported job files (photos/signatures/PDFs) ===== */
let _archiveFilesReady = false;
async function ensureArchiveFiles(env, tenantId) {
  if (_archiveFilesReady) return;
  const db = tenantDB(env, tenantId);
  await db.prepare(`CREATE TABLE IF NOT EXISTS sla_archive_files (
    tenant_id   INTEGER NOT NULL DEFAULT 1,
    id          TEXT PRIMARY KEY,   -- source file id (Workever uuid); dedupe/resume key
    mos         TEXT,               -- job MOS number (links to sla_jobs_archive)
    r2_key      TEXT,               -- object key in JOB_FILES
    name        TEXT,
    kind        TEXT,               -- photo | signature | document
    type        TEXT,               -- mime type
    bytes       INTEGER,
    taken_at    TEXT,
    uploaded_by TEXT
  )`).run();
  try { await db.prepare("CREATE INDEX IF NOT EXISTS idx_archfiles_mos ON sla_archive_files(tenant_id, mos)").run(); } catch {}
  _archiveFilesReady = true;
}

const _safeSeg = s => String(s || "").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
function _extFromName(name, type) {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(name || "");
  if (m) return "." + m[1].toLowerCase();
  if (/png/.test(type)) return ".png"; if (/pdf/.test(type)) return ".pdf";
  return ".jpg";
}

// Import a batch of files: skip any already stored, else stream each from its
// (public) URL straight into R2 and record it. Small internal concurrency keeps
// the wall-clock down; total subrequests stay well within a single invocation.
async function archivePhotosImport(env, tenantId, files) {
  const db = tenantDB(env, tenantId);
  // Which of these are already imported? One query for the whole batch.
  const ids = files.map(f => String(f.id));
  const have = new Set();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const ph = chunk.map(() => "?").join(",");
    const { results } = await db.prepare(`SELECT id FROM sla_archive_files WHERE tenant_id=? AND id IN (${ph})`).bind(tenantId, ...chunk).all();
    for (const r of results || []) have.add(r.id);
  }
  const todo = files.filter(f => !have.has(String(f.id)));
  let imported = 0, skipped = files.length - todo.length;
  const failed = [];
  const rows = [];

  // Fetch with retries + backoff: S3 throttles under load (503/429) and TCP
  // resets happen — a couple of retries turns most "failures" into successes.
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function fetchRetry(u) {
    let last = "";
    for (let a = 0; a < 4; a++) {
      try {
        const r = await fetch(u);
        if (r.ok && r.body) return r;
        last = "HTTP " + r.status;
        if (r.status && r.status < 500 && r.status !== 429) return { ok: false, status: r.status, _err: last }; // 4xx won't improve
      } catch (e) { last = String(e && e.message || e).slice(0, 80); }
      await sleep(300 * (a + 1) * (a + 1));   // 300 / 1200 / 2700 ms
    }
    return { ok: false, status: 0, _err: last || "failed" };
  }

  const CONC = 4;   // gentle on S3 (the browser also caps its lanes); big files stream, so memory stays low
  for (let i = 0; i < todo.length; i += CONC) {
    const slice = todo.slice(i, i + CONC);
    await Promise.all(slice.map(async (f) => {
      try {
        const res = await fetchRetry(f.url);
        if (!res.ok || !res.body) { failed.push({ id: f.id, error: res._err || "fetch failed" }); return; }
        const mos = _safeSeg(f.mos || "unknown");
        const key = `archivephoto/${mos}/${_safeSeg(f.id)}${_extFromName(f.name, f.type)}`;
        await env.JOB_FILES.put(key, res.body, { httpMetadata: { contentType: f.type || "application/octet-stream" } });
        rows.push({ id: String(f.id), mos: f.mos || "", key, name: f.name || "", kind: f.kind || "photo",
          type: f.type || "", bytes: +f.bytes || 0, date: f.date || "", by: f.by || "" });
      } catch (e) {
        failed.push({ id: f.id, error: String(e && e.message || e).slice(0, 120) });
      }
    }));
  }
  // Record the successful puts (batched insert; OR IGNORE guards a race/retry).
  for (let i = 0; i < rows.length; i += 50) {
    const stmts = rows.slice(i, i + 50).map(r => db.prepare(
      `INSERT OR IGNORE INTO sla_archive_files (tenant_id,id,mos,r2_key,name,kind,type,bytes,taken_at,uploaded_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).bind(tenantId, r.id, r.mos, r.key, r.name, r.kind, r.type, r.bytes, r.date, r.by));
    if (stmts.length) await db.batch(stmts);
  }
  imported = rows.length;
  return { imported, skipped, failed };
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
  // Release info for the office board (engineers never receive hidden jobs, so
  // this only surfaces on the admin views): mode, computed instant, label.
  let releaseView;
  if (job.seriesSkipped) {
    releaseView = { mode: "skipped", at: null, label: "Skipped — engineer had another job that day", series: true };
  } else if (job.release && job.release.mode && job.release.mode !== "now") {
    const t = releaseInstant(job);
    releaseView = { mode: job.release.mode, at: t ? new Date(t).toISOString() : null, label: releaseLabel(job), series: !!job.seriesId };
  }
  return { ...job, releaseView, sla: { state, now: new Date().toISOString() } };
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

/* Custom job categories (extra statuses defined by the office). Stored in
   app_config key 'sla_categories' as [{name, colour}]. They behave exactly like
   built-in statuses everywhere (chips, filters, mark-as, job-view). A custom
   name may never shadow a built-in status, and duplicates collapse. */
/* Job Sheet field visibility (routes/job-pdf.html). The canonical field list +
   sensible per-copy defaults live here; the stored app_config 'sla_sheet_config'
   only overrides the booleans, so new fields appear automatically. */
const SHEET_FIELDS = [
  { key: "jobId",         label: "Job ID / reference",     m: true,  c: true  },
  { key: "jobDate",       label: "Job date",               m: true,  c: true  },
  { key: "priority",      label: "Priority",               m: true,  c: true  },
  { key: "status",        label: "Status",                 m: true,  c: true  },
  { key: "customer",      label: "Customer",               m: true,  c: true  },
  { key: "contactPerson", label: "Site contact person",    m: true,  c: true  },
  { key: "contactPhone",  label: "Site contact telephone", m: true,  c: true  },
  { key: "contactEmail",  label: "Site contact email",     m: true,  c: true  },
  { key: "siteAddress",   label: "Site address",           m: true,  c: true  },
  { key: "jobName",       label: "Job name",               m: true,  c: true  },
  { key: "engineer",      label: "Engineer",               m: true,  c: true  },
  { key: "description",   label: "Job description",         m: true,  c: true  },
  { key: "sla",           label: "SLA status",             m: true,  c: false },
  { key: "timeSpent",     label: "Time on job (travel / on-site / total)", m: true, c: false },
  { key: "timeline",      label: "Activity timeline",      m: true,  c: false },
  { key: "notes",         label: "Engineer notes",         m: true,  c: true  },
  { key: "riskAssessment",label: "Risk assessment",        m: true,  c: false },
  { key: "photos",        label: "Photos",                 m: true,  c: true  },
  { key: "signature",     label: "Customer signature",     m: true,  c: true  },
];

async function getSheetConfig(env, tenantId) {
  const db = tenantDB(env, tenantId);
  const row = await db.prepare("SELECT value FROM app_config WHERE tenant_id = ? AND key = 'sla_sheet_config'").bind(tenantId).first();
  let saved = {};
  try { saved = row ? JSON.parse(row.value) : {}; } catch { saved = {}; }
  if (!saved || typeof saved !== "object") saved = {};
  return SHEET_FIELDS.map(f => {
    const s = saved[f.key] || {};
    return {
      key: f.key, label: f.label,
      mostlane: typeof s.mostlane === "boolean" ? s.mostlane : f.m,
      client:   typeof s.client   === "boolean" ? s.client   : f.c,
    };
  });
}

async function setSheetConfig(env, tenantId, fields) {
  const db = tenantDB(env, tenantId);
  const valid = new Set(SHEET_FIELDS.map(f => f.key));
  const arr = Array.isArray(fields)
    ? fields
    : Object.keys(fields || {}).map(k => Object.assign({ key: k }, fields[k]));
  const map = {};
  for (const f of arr) {
    if (f && valid.has(f.key)) map[f.key] = { mostlane: !!f.mostlane, client: !!f.client };
  }
  await db.prepare(
    "INSERT INTO app_config (tenant_id, key, value) VALUES (?, 'sla_sheet_config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(tenantId, JSON.stringify(map)).run();
  return getSheetConfig(env, tenantId);
}

async function getCategories(env, tenantId) {
  const db = tenantDB(env, tenantId);
  const row = await db.prepare("SELECT value FROM app_config WHERE tenant_id = ? AND key = 'sla_categories'").bind(tenantId).first();
  let cats;
  try { cats = row ? JSON.parse(row.value) : []; } catch { cats = []; }
  if (!Array.isArray(cats)) cats = [];
  const seen = new Set();
  const out = [];
  for (const c of cats) {
    const name = String((c && c.name) || "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    if (CANONICAL_STATUSES.some(s => s.toLowerCase() === key)) continue;
    seen.add(key);
    const colour = /^#[0-9a-fA-F]{6}$/.test(String((c && c.colour) || "")) ? c.colour : "#64748b";
    out.push({ name, colour, done: !!(c && c.done) });
  }
  return out;
}

async function setCategories(env, tenantId, list) {
  const seen = new Set();
  const clean = [];
  for (const c of (Array.isArray(list) ? list : [])) {
    const name = String((c && c.name) || "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    if (CANONICAL_STATUSES.some(s => s.toLowerCase() === key)) continue;   // never shadow a built-in
    seen.add(key);
    const colour = /^#[0-9a-fA-F]{6}$/.test(String((c && c.colour) || "")) ? c.colour : "#64748b";
    clean.push({ name, colour, done: !!(c && c.done) });
  }
  const db = tenantDB(env, tenantId);
  await db.prepare(
    "INSERT INTO app_config (tenant_id, key, value) VALUES (?, 'sla_categories', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).bind(tenantId, JSON.stringify(clean)).run();
  return clean;
}

/* ================= Areas of work + engineer skills =================
   sla_work_areas = [{id,name,colour}] ; sla_eng_skills = {normUsername:{areaId:1-5}}
   Used to match a job's workArea to engineers competent in it (scheduler). */
const areaSlug = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || ("area-" + crypto.randomUUID().slice(0, 6));
const DEFAULT_WORK_AREAS = [
  "Electrical", "Plumbing", "Fabric / Building", "Firestopping", "Fire alarms",
  "Heating / HVAC", "Joinery / Carpentry", "Decorating", "General maintenance",
].map(name => ({ id: areaSlug(name), name, colour: "#64748b" }));

// ── EM (emergency-lighting) certificate "set numbers" per store ─────────────
// The EM cert filename ends "<setNumber>-<YY>" (e.g. "0177-25"). The set number
// usually equals the store code but genuinely differs for renumbered sites, so
// it's extracted from the saved compliance certs (repeatable each year).
function emSetFromKey(r2key) {
  const name = String(r2key || "").split("/").pop() || "";
  const n = name.replace(/^\d+-/, "");   // strip the leading upload timestamp
  const m = n.match(/(\d{3,5})[-.](?:DEC)?(\d{2})[A-Za-z]?(?:_\d+)?_?\.pdf$/i);
  return m ? { set: m[1], year: Number(m[2]) } : null;
}
// Read the EM certificate number STRAIGHT FROM THE PDF CONTENT (authoritative).
// The filename is only a proxy — some certs were filed under the wrong store or
// carry no number at all — so where the filename disagrees with the store code
// we open the certificate itself (pdfExtractText + certNumberFromText live in
// lib/pdftext.js — pure WebCrypto/DecompressionStream, no PDF library).
async function emSetFromPdf(env, r2key) {
  try {
    if (!env.JOB_FILES) return null;
    const obj = await env.JOB_FILES.get(r2key);
    if (!obj) return null;
    const buf = await obj.arrayBuffer();
    if (!buf || buf.byteLength > 4 * 1024 * 1024) return null;   // guard huge files
    return certNumberFromText(await pdfExtractText(buf));
  } catch { return null; }
}
async function getEmSets(env, tid) {
  const db = tenantDB(env, tid);
  const row = await db.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(tid, "sla:emsets:" + tid).first();
  let m; try { m = row ? JSON.parse(row.value) : {}; } catch { m = {}; }
  return (m && typeof m === "object") ? m : {};
}
async function rebuildEmSets(env, tid) {
  const db = tenantDB(env, tid);
  let rows = [];
  try { rows = (await db.prepare("SELECT code, r2_key FROM compliance_files WHERE type='em'").all()).results || []; } catch {}
  const best = {};   // code -> {set, year, key} — keep the latest-year cert per store
  for (const r of rows) {
    const p = emSetFromKey(r.r2_key);
    const year = p ? p.year : -1;
    if (!best[r.code] || year > best[r.code].year) best[r.code] = { set: p ? p.set : null, year, key: r.r2_key };
  }
  const map = {}, mismatches = [];
  let pdfReads = 0; const MAX_PDF = 90;
  for (const code of Object.keys(best)) {
    const b = best[code];
    let set = b.set, source = "filename";
    // When the filename number is missing or disagrees with the store code, the
    // printed certificate number is authoritative — open the PDF and read it.
    if ((!set || set !== code) && pdfReads < MAX_PDF) {
      pdfReads++;
      const fromPdf = await emSetFromPdf(env, b.key);
      if (fromPdf && fromPdf.set) { set = fromPdf.set; source = "certificate"; }
    }
    if (!set) set = code;                 // last resort: assume the set == store code
    map[code] = set;
    if (set !== code) mismatches.push({ code, set, source });
  }
  await db.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(tid, "sla:emsets:" + tid, JSON.stringify(map)).run();
  return { count: Object.keys(map).length, mismatches, pdfReads };
}

// ── Per-engineer fallback jobs (config + the daily cron that assigns them) ──
const FALLBACK_KEY = tid => "sla:fallbacks:" + tid;
async function getFallbacks(env, tenantId) {
  const db = tenantDB(env, tenantId);
  const row = await db.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(tenantId, FALLBACK_KEY(tenantId)).first();
  let c; try { c = row ? JSON.parse(row.value) : null; } catch { c = null; }
  if (!c || typeof c !== "object") c = {};
  return { enabled: !!c.enabled, startHour: Number.isFinite(Number(c.startHour)) ? Number(c.startHour) : 8,
    byEngineer: (c.byEngineer && typeof c.byEngineer === "object") ? c.byEngineer : {} };
}
async function setFallbacks(env, tenantId, body) {
  const cur = await getFallbacks(env, tenantId);
  const out = { enabled: body.enabled !== undefined ? !!body.enabled : cur.enabled,
    startHour: Number.isFinite(Number(body.startHour)) ? Math.max(0, Math.min(23, Number(body.startHour))) : cur.startHour,
    byEngineer: {} };
  const src = (body.byEngineer && typeof body.byEngineer === "object") ? body.byEngineer : cur.byEngineer;
  for (const k of Object.keys(src || {})) {
    const e = src[k] || {};
    const description = String(e.description || "").trim();
    const siteName = String(e.siteName || "").trim();
    const projectId = String(e.projectId || "").trim();
    if (!description && !siteName && !projectId) continue;   // empty row → drop it
    out.byEngineer[normId(k)] = {
      siteName, postcode: String(e.postcode || "").trim(), description,
      durationMinutes: Math.max(15, Math.min(600, Number(e.durationMinutes) || 480)),
      active: e.active === false ? false : true,
      // Optional: default the engineer onto a LIVE PROJECT (the job is stamped
      // with the project + its site). projectName/Number are cached for the UI.
      projectId: String(e.projectId || "").trim() || null,
      projectName: String(e.projectName || "").trim() || null,
      projectNumber: String(e.projectNumber || "").trim() || null,
    };
  }
  const db = tenantDB(env, tenantId);
  await db.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(tenantId, FALLBACK_KEY(tenantId), JSON.stringify(out)).run();
  return out;
}
// Current Europe/London wall-clock parts.
function londonNow() {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date()).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { dow: dowMap[p.weekday], hour: Number(p.hour === "24" ? 0 : p.hour), minute: Number(p.minute), date: `${p.year}-${p.month}-${p.day}` };
}
// The next WORKING day (Mon–Fri) strictly after `dateStr` (YYYY-MM-DD, London).
function nextWorkingDay(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}
// London-local ISO instant for a date + hour (minute 0).
function londonAtHour(dateStr, hour) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(londonInstant(y, m, d, hour, 0)).toISOString();
}
// Cron: warn the office (15:30 & 18:00) about field engineers with no job for the
// next working day, and at 19:00 assign each still-empty engineer their fallback.
// Runs every 5-min tick; self-gates on London time, deduped per slot per day.
export async function sweepFallbacks(env, tid = 1) {
  const cfg = await getFallbacks(env, tid);
  if (!cfg.enabled) return;
  const now = londonNow();
  if (now.dow === 0 || now.dow === 6) return;          // Sat/Sun: nothing (Fri covered Mon)
  // Which slot are we in? Match a 5-min tick window on the half/hour.
  let slot = null;
  if (now.hour === 15 && now.minute >= 30 && now.minute < 35) slot = "warn1";
  else if (now.hour === 18 && now.minute < 5) slot = "warn2";
  else if (now.hour === 19 && now.minute < 5) slot = "assign";
  if (!slot) return;
  const target = nextWorkingDay(now.date);             // the day we're checking
  const db = tenantDB(env, tid);
  // Dedup: one run per slot per target day.
  const dedupKey = "sla:fallbackswept:" + tid;
  let swept = {}; try { const r = await db.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(tid, dedupKey).first(); if (r) swept = JSON.parse(r.value) || {}; } catch {}
  const stamp = slot + ":" + target;
  if (swept[stamp]) return;

  // Field engineers (staffType lives in the profile JSON, default "field").
  const { results: users } = await db.prepare("SELECT username, first_name, last_name, profile FROM users WHERE tenant_id=? AND (status IS NULL OR status='' OR status='Active')").bind(tid).all();
  const fieldUsers = (users || []).filter(u => { let st = "field"; try { st = (JSON.parse(u.profile || "{}").staffType) || "field"; } catch {} return st !== "office"; });
  const jobs = await listJobs(env, tid);
  const hasJobThatDay = (uname) => jobs.some(j => j.scheduledAt && !j.seriesSkipped
    && String(j.status || "").toLowerCase() !== "cancelled"
    && new Date(j.scheduledAt).toISOString().slice(0, 10) === target
    && assignedList(j).some(a => normId(a) === normId(uname)));
  // Skip anyone on approved leave that day.
  let leave = {};
  try { const { approvedLeaveInRange } = await import("./holidays.js"); leave = await approvedLeaveInRange(env, tid, target, target); } catch {}
  const onLeave = (uname) => { const m = leave[uname] || leave[normId(uname)]; return !!(m && m[target]); };

  const empties = fieldUsers.filter(u => !hasJobThatDay(u.username) && !onLeave(u.username));

  if (slot === "warn1" || slot === "warn2") {
    if (empties.length) {
      const names = empties.map(u => (`${u.first_name || ""} ${u.last_name || ""}`.trim()) || u.username);
      const dayTxt = new Date(target + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short", timeZone: "Europe/London" });
      const body = names.join(", ") + " — no job yet for " + dayTxt + ". Fallbacks auto-assign at 7pm.";
      const owner = env.OWNER_USERNAME || "";
      const payload = { title: empties.length + " engineer" + (empties.length === 1 ? "" : "s") + " with no job for " + dayTxt, body, url: "/sla-scheduler.html", tag: "fallback-warn" };
      if (owner) await sendToUser(env, tid, owner, payload).catch(() => {});
      await sendToPermission(env, tid, ["FullAccess", "SLAAdmin"], payload, owner || "").catch(() => {});
    }
  } else if (slot === "assign") {
    const scheduledAt = londonAtHour(target, cfg.startHour || 8);
    for (const u of empties) {
      const fb = cfg.byEngineer[normId(u.username)];
      if (!fb || fb.active === false || (!fb.description && !fb.siteName && !fb.projectId)) continue;
      let payload = null;
      // A PROJECT fallback: default them onto a live project — stamp projectId +
      // the project's Pxxxx site so it costs + shows like a project job.
      if (fb.projectId) {
        try {
          const proj = await db.prepare("SELECT id, number, name, data FROM projects WHERE id=? AND status='live'").bind(fb.projectId).first();
          if (proj) {
            let pdata = {}; try { pdata = JSON.parse(proj.data || "{}"); } catch {}
            let siteRow = null; try { siteRow = await env.DB.prepare("SELECT site_number, site_name, postcode, data FROM sites WHERE client='projects' AND site_number=?").bind(proj.number).first(); } catch {}
            let sdata = {}; try { if (siteRow && siteRow.data) sdata = JSON.parse(siteRow.data); } catch {}
            payload = {
              description: fb.description || ("Fallback — " + proj.name),
              projectId: proj.id, siteCode: proj.number, siteName: proj.name, storeType: "projects",
              address: (siteRow && [sdata.address1, sdata.town, sdata.county, siteRow.postcode].filter(Boolean).join(", ")) || "",
              postcode: (siteRow && siteRow.postcode) || pdata.postcode || fb.postcode || "",
              lat: pdata.lat != null ? pdata.lat : (sdata.lat != null ? sdata.lat : undefined),
              lon: pdata.lon != null ? pdata.lon : (sdata.lng != null ? sdata.lng : (sdata.lon != null ? sdata.lon : undefined)),
              assignedEngineers: [u.username], scheduledAt, durationMinutes: fb.durationMinutes || 480,
              release: { mode: "dayBefore", hour: 17 }, fallback: true,
              requiresRA: false, requiresSignature: false, requiresPhoto: false, requiresNote: false,
              changedBy: "auto-fallback",
            };
          }
        } catch (e) { console.error("fallback project lookup failed:", e && e.message); }
      }
      // Generic fallback (or the project wasn't found / no longer live).
      if (!payload) {
        if (!fb.description && !fb.siteName) continue;
        payload = {
          description: fb.description || ("Fallback — " + (fb.siteName || "standby")),
          siteName: fb.siteName || "", siteCode: "", postcode: fb.postcode || "",
          assignedEngineers: [u.username],
          scheduledAt, durationMinutes: fb.durationMinutes || 480,
          release: { mode: "dayBefore", hour: 17 }, fallback: true,
          requiresRA: false, requiresSignature: false, requiresPhoto: false, requiresNote: false,
          changedBy: "auto-fallback",
        };
      }
      try {
        const job = await createOrUpdateJobFromPayload(env, tid, payload);
        await reconcileRelease(env, tid, job).catch(() => {});
      } catch (e) { console.error("fallback assign failed for", u.username, e && e.message); }
    }
  }
  swept[stamp] = true;
  // Keep the dedup map small — only today's + target's stamps matter.
  const keep = {}; for (const k of Object.keys(swept)) if (k.endsWith(target)) keep[k] = true;
  await db.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(tid, dedupKey, JSON.stringify(keep)).run();
}

async function getWorkAreas(env, tenantId) {
  const db = tenantDB(env, tenantId);
  const row = await db.prepare("SELECT value FROM app_config WHERE tenant_id = ? AND key = 'sla_work_areas'").bind(tenantId).first();
  let a; try { a = row ? JSON.parse(row.value) : null; } catch { a = null; }
  if (!Array.isArray(a)) return DEFAULT_WORK_AREAS.slice();
  const seen = new Set(), out = [];
  for (const x of a) {
    const name = String((x && x.name) || "").trim(); if (!name) continue;
    let id = String((x && x.id) || "").trim() || areaSlug(name);
    if (seen.has(id)) id = areaSlug(name) + "-" + out.length;
    seen.add(id);
    const colour = /^#[0-9a-fA-F]{6}$/.test(String((x && x.colour) || "")) ? x.colour : "#64748b";
    out.push({ id, name, colour });
  }
  return out;
}
async function setWorkAreas(env, tenantId, list) {
  const seen = new Set(), clean = [];
  for (const x of (Array.isArray(list) ? list : [])) {
    const name = String((x && x.name) || "").trim(); if (!name) continue;
    let id = String((x && x.id) || "").trim() || areaSlug(name);
    if (seen.has(id)) id = areaSlug(name) + "-" + clean.length;
    seen.add(id);
    const colour = /^#[0-9a-fA-F]{6}$/.test(String((x && x.colour) || "")) ? x.colour : "#64748b";
    clean.push({ id, name: name.slice(0, 60), colour });
  }
  const db = tenantDB(env, tenantId);
  await db.prepare(
    "INSERT INTO app_config (tenant_id, key, value) VALUES (?, 'sla_work_areas', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).bind(tenantId, JSON.stringify(clean)).run();
  return clean;
}

async function getEngSkills(env, tenantId) {
  const db = tenantDB(env, tenantId);
  const row = await db.prepare("SELECT value FROM app_config WHERE tenant_id = ? AND key = 'sla_eng_skills'").bind(tenantId).first();
  let s; try { s = row ? JSON.parse(row.value) : null; } catch { s = null; }
  return (s && typeof s === "object") ? s : {};
}
async function setEngSkills(env, tenantId, skills) {
  const clean = {};
  for (const [user, areas] of Object.entries(skills || {})) {
    if (!user || typeof areas !== "object") continue;
    const u = normId(user);
    const row = {};
    for (const [areaId, stars] of Object.entries(areas)) {
      const n = Math.round(Number(stars) || 0);
      if (n >= 1 && n <= 5) row[String(areaId)] = n;   // 0 / invalid = not competent, dropped
    }
    if (Object.keys(row).length) clean[u] = row;
  }
  const db = tenantDB(env, tenantId);
  await db.prepare(
    "INSERT INTO app_config (tenant_id, key, value) VALUES (?, 'sla_eng_skills', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).bind(tenantId, JSON.stringify(clean)).run();
  return clean;
}

/* ================= AI usage meter + soft daily cap =================
   Every paid AI call (route optimise, work-area inference, auto-schedule,
   programme draft/edit) bumps a per-month counter so the office can see spend
   and a soft DAILY cap protects against runaway cost. Stored in app_config
   ai_usage:<yyyy-mm> = {total, days:{d:n}, kinds:{k:n}}; cap in ai_daily_cap. */
const AI_CAP_DEFAULT = 400;
export async function bumpAiUsage(env, tenantId, kind) {
  try {
    const db = tenantDB(env, tenantId);
    const mon = new Date().toISOString().slice(0, 7), day = new Date().toISOString().slice(0, 10);
    const k = "ai_usage:" + mon;
    const row = await db.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(tenantId, k).first();
    let u; try { u = row ? JSON.parse(row.value) : null; } catch { u = null; }
    if (!u || typeof u !== "object") u = { total: 0, days: {}, kinds: {} };
    u.total = (u.total || 0) + 1;
    u.days = u.days || {}; u.days[day] = (u.days[day] || 0) + 1;
    u.kinds = u.kinds || {}; u.kinds[kind || "other"] = (u.kinds[kind || "other"] || 0) + 1;
    await db.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(tenantId, k, JSON.stringify(u)).run();
    return u.days[day];
  } catch { return 0; }
}
async function aiCapLimit(env, tenantId) {
  try {
    const db = tenantDB(env, tenantId);
    const row = await db.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key='ai_daily_cap'").bind(tenantId).first();
    const n = row ? parseInt(row.value, 10) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : AI_CAP_DEFAULT;
  } catch { return AI_CAP_DEFAULT; }
}
async function aiUsageToday(env, tenantId) {
  try {
    const db = tenantDB(env, tenantId);
    const mon = new Date().toISOString().slice(0, 7), day = new Date().toISOString().slice(0, 10);
    const row = await db.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(tenantId, "ai_usage:" + mon).first();
    let u; try { u = row ? JSON.parse(row.value) : null; } catch { u = null; }
    return (u && u.days && u.days[day]) || 0;
  } catch { return 0; }
}
// Returns {capped:true,...} when today's calls would exceed the soft cap (cap 0 = off).
async function aiCapCheck(env, tenantId) {
  const cap = await aiCapLimit(env, tenantId);
  if (!cap) return { capped: false, cap: 0 };
  const today = await aiUsageToday(env, tenantId);
  return { capped: today >= cap, cap, today };
}
async function getAiUsage(env, tenantId) {
  const db = tenantDB(env, tenantId);
  const mon = new Date().toISOString().slice(0, 7), day = new Date().toISOString().slice(0, 10);
  const row = await db.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(tenantId, "ai_usage:" + mon).first();
  let u; try { u = row ? JSON.parse(row.value) : null; } catch { u = null; }
  u = (u && typeof u === "object") ? u : { total: 0, days: {}, kinds: {} };
  return { ok: true, month: mon, monthTotal: u.total || 0, today: (u.days && u.days[day]) || 0, cap: await aiCapLimit(env, tenantId), kinds: u.kinds || {} };
}

/* Generic forced-tool Anthropic call → {ok, input} (the validated tool args). */
async function anthropicTool(env, { system, user, toolName, schema, maxTokens }) {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, error: "AI isn't configured on the server (no API key)." };
  const model = env.ANTHROPIC_MODEL || "claude-sonnet-5";
  let resp;
  try {
    resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: maxTokens || 800, system, tools: [{ name: toolName, description: "Return the result.", input_schema: schema }], tool_choice: { type: "tool", name: toolName }, messages: [{ role: "user", content: user }] }),
    });
  } catch { return { ok: false, error: "Couldn't reach the AI service." }; }
  if (!resp.ok) {
    let d = ""; try { const j = await resp.json(); d = j?.error?.message || ""; } catch {}
    if (resp.status === 401 || resp.status === 403) return { ok: false, error: "The AI key was rejected." };
    if (resp.status === 404 && /model/i.test(d)) return { ok: false, error: `The AI model "${model}" isn't available on this key.` };
    return { ok: false, error: "The AI service errored." + (d ? " (" + d + ")" : "") };
  }
  let payload; try { payload = await resp.json(); } catch { return { ok: false, error: "AI gave an unreadable reply." }; }
  const block = Array.isArray(payload.content) ? payload.content.find(c => c.type === "tool_use" && c.name === toolName) : null;
  if (!block?.input) return { ok: false, error: "AI returned nothing usable." };
  return { ok: true, input: block.input };
}

/* Classify a job description into ONE work area id (or empty). */
async function inferWorkArea(env, tenantId, description) {
  const areas = await getWorkAreas(env, tenantId);
  if (!areas.length) return { ok: false, error: "No areas of work are configured yet." };
  const list = areas.map(a => `${a.id}: ${a.name}`).join("\n");
  const schema = {
    type: "object",
    properties: {
      areaId: { type: "string", description: "The id of the single best-matching area, or empty string if none fit." },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
    },
    required: ["areaId"],
  };
  const system = "You classify a UK building-maintenance / facilities job into exactly ONE area of work from the provided list. Reply with only the matching area id. If nothing clearly fits, return an empty areaId.";
  const user = `Areas (id: name):\n${list}\n\nJob description:\n"""${String(description || "").slice(0, 1500)}"""\n\nWhich single area id best fits this work?`;
  const r = await anthropicTool(env, { system, user, toolName: "set_area", schema, maxTokens: 120 });
  if (!r.ok) return r;
  const id = String(r.input.areaId || "").trim();
  const match = areas.find(a => a.id === id);
  return { ok: true, areaId: match ? match.id : "", name: match ? match.name : "", confidence: r.input.confidence || "" };
}

/* ================= FILES (R2) + PDF ================= */

function r2Url(env, key) {
  const base = (env.R2_PUBLIC_BASE || "https://pub-0a9aac7bfc6749bbbdbf9660503968e6.r2.dev").replace(/\/$/, "");
  return `${base}/${key}`;
}
// Attach public view URLs to a site-audit job's checklist items (their photos
// live in the public JOB_FILES bucket). Response-only — never stored.
function decorateAuditItems(env, items) {
  if (!Array.isArray(items)) return items;
  const ph = k => ({ key: k, url: r2Url(env, k), thumb: r2Url(env, k + ".thumb") });
  return items.map(it => ({
    ...it,
    refPhotoUrls: (it.refPhotos || []).map(ph),
    donePhotoUrl: it.donePhoto ? ph(it.donePhoto) : null,
  }));
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

/* ── Firestopping config + material presets (app_config) ──────────────────────
   Config: company name, seal category, the declaration text, and the next
   sequential RIA number. Materials: the office's usual products (manufacturer +
   name + category) each with uploaded spec documents (keys → R2). */
const FS_DEFAULT_DECL =
  "I declare that the work undertaken fully complies with the manufacturers guidance for all products installed. " +
  "All materials used are correctly installed in accordance with training and to a good standard. Local " +
  "identification labelling installed to each penetration seal.";
async function getFsConfig(env, tenantId) {
  const db = tenantDB(env, tenantId);
  const row = await db.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key='firestop_config'").bind(tenantId).first();
  let c = {}; try { c = row && row.value ? JSON.parse(row.value) : {}; } catch {}
  return {
    company: c.company || "Mostlane",
    sealCategory: c.sealCategory || "Group A: Fire stopping and fire sealing kits for Penetration Seals",
    declaration: c.declaration || FS_DEFAULT_DECL,
    nextRef: c.nextRef || 1,
  };
}
async function saveFsConfig(env, tenantId, cfg) {
  const db = tenantDB(env, tenantId);
  await db.prepare("INSERT INTO app_config (tenant_id, key, value) VALUES (?, 'firestop_config', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(tenantId, JSON.stringify(cfg)).run();
  return cfg;
}
async function getFsMaterials(env, tenantId) {
  const db = tenantDB(env, tenantId);
  const row = await db.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key='firestop_materials'").bind(tenantId).first();
  try { return row && row.value ? JSON.parse(row.value) : []; } catch { return []; }
}
async function saveFsMaterials(env, tenantId, mats) {
  const db = tenantDB(env, tenantId);
  await db.prepare("INSERT INTO app_config (tenant_id, key, value) VALUES (?, 'firestop_materials', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(tenantId, JSON.stringify(mats)).run();
  return mats;
}
