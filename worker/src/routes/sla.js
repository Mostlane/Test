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

  /* GET /sla/categories — custom job categories (any session, so every page can
     merge them into its status list). POST — replace the whole list (SLA admin). */
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
    const updated = await patchJob(env, tenantId, id, patch);
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
      const form = await request.formData();
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
        if (!isAdmin && body.status && (target === "Travelling" || target === "In Progress")) {
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

      const updated = await patchJob(env, tenantId, id, body);
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
    const form = await request.formData();
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
    const form = await request.formData();
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
function completionMissing(job, patch, afterPhotoCount) {
  // Firestopping jobs are completed by the RIA record (seals + photos +
  // signed declaration), NOT the standard note/photo/signature.
  if (job && job.firestopping) return firestopMissing(job);
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
function londonFivePmDayBefore(schedISO) {
  const s = Date.parse(schedISO); if (!Number.isFinite(s)) return null;
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(s)).split("-").map(Number);
  const prev = new Date(Date.UTC(y, m - 1, d)); prev.setUTCDate(prev.getUTCDate() - 1);
  return londonInstant(prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate(), 17, 0);
}
// The instant a time-based release becomes visible (ms), or null for now/afterPrev.
function releaseInstant(job) {
  const r = job && job.release;
  if (!r || !r.mode || r.mode === "now") return null;
  if (r.mode === "at") { const t = Date.parse(r.at); return Number.isFinite(t) ? t : null; }
  if (r.mode === "dayBefore") return job.scheduledAt ? londonFivePmDayBefore(job.scheduledAt) : null;
  return null;
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
async function reconcileRelease(env, tid, job, allJobs) {
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
    if (j.releaseNotified || !assignedList(j).length) continue;
    const r = j.release; if (!r || !r.mode || r.mode === "now") continue;
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

async function createOrUpdateJobFromPayload(env, tenantId, body) {
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
  const priority = isProjJob ? "" : (body.priority || existing?.priority || "Priority 4");
  const targetAt = isProjJob ? null : computeSlaTarget(raisedAt, priority, cfg);

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

  // Per-job gates: whether this job needs a Risk Assessment and a customer
  // signature. Default OFF for projects (P-numbered site / projects client), ON
  // for everything else. An explicit value from the form/editor wins; an existing
  // job's stored value is preserved when not re-specified. (isProjJob computed above.)
  const requiresRA = body.requiresRA !== undefined ? !!body.requiresRA
    : (existing?.requiresRA !== undefined ? !!existing.requiresRA : !isProjJob);
  const requiresSignature = body.requiresSignature !== undefined ? !!body.requiresSignature
    : (existing?.requiresSignature !== undefined ? !!existing.requiresSignature : !isProjJob);
  const requiresPhoto = body.requiresPhoto !== undefined ? !!body.requiresPhoto
    : (existing?.requiresPhoto !== undefined ? !!existing.requiresPhoto : !isProjJob);
  const requiresNote = body.requiresNote !== undefined ? !!body.requiresNote
    : (existing?.requiresNote !== undefined ? !!existing.requiresNote : !isProjJob);

  // A job's reference must never be the internal UUID — that shows up as gibberish
  // in lists and notifications. When no reference is typed, default it to a CLEAR
  // name: a project job uses its project number (site code, e.g. "P0002"); every
  // other job uses the SITE NAME (else the site code). Heal an old job whose ref
  // defaulted to the UUID the same way. An explicitly typed reference always wins.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let helpdeskRef = body.reference || existing?.helpdeskRef || id;
  if (!body.reference && (!helpdeskRef || helpdeskRef === id || UUID_RE.test(String(helpdeskRef)))) {
    const siteNm = String(body.siteName || existing?.siteName || "").trim();
    const siteCd = String(body.siteCode || existing?.siteCode || "").trim();
    helpdeskRef = isProjJob ? (siteCd || siteNm || id) : (siteNm || siteCd || id);
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
    siteName: body.siteName || existing?.siteName || "",
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
    // Investigate-only job: shows a big red "INVESTIGATE ONLY" banner on the
    // engineer + office job pages. Preserved across re-saves.
    investigateOnly: body.investigateOnly !== undefined ? !!body.investigateOnly : (existing?.investigateOnly || false),
    scheduledAt,
    scheduledEnd,
    // Visibility scheduling (carried across re-saves). A changed release re-arms
    // the announcement push; releaseNotified tracks whether it has fired.
    release: (body.release !== undefined
      ? (body.release && body.release.mode && body.release.mode !== "now" ? { mode: body.release.mode, at: body.release.at || undefined } : undefined)
      : existing?.release),
    releaseNotified: (body.release !== undefined && JSON.stringify(body.release || null) !== JSON.stringify(existing?.release || null))
      ? false : (existing?.releaseNotified || false),
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
    else job.release = { mode: patch.release.mode, at: patch.release.at || undefined };
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
  if (patch.durationMinutes !== undefined && job.scheduledAt) {
    const mins = Math.max(15, Number(patch.durationMinutes) || 60);
    const s = Date.parse(job.scheduledAt);
    if (Number.isFinite(s)) job.scheduledEnd = new Date(s + mins * 60000).toISOString();
  }
  if (patch.siteCode !== undefined) job.siteCode = patch.siteCode;
  if (patch.requiresRA !== undefined) job.requiresRA = !!patch.requiresRA;
  if (patch.requiresSignature !== undefined) job.requiresSignature = !!patch.requiresSignature;
  if (patch.requiresPhoto !== undefined) job.requiresPhoto = !!patch.requiresPhoto;
  if (patch.requiresNote !== undefined) job.requiresNote = !!patch.requiresNote;
  if (patch.firestopping !== undefined) job.firestopping = !!patch.firestopping;
  if (patch.investigateOnly !== undefined) job.investigateOnly = !!patch.investigateOnly;
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
  // A reference must never be the internal UUID — heal a UUID default to a clear
  // name: project → project number (site code); otherwise the site name.
  {
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!job.helpdeskRef || job.helpdeskRef === job.id || uuidRe.test(String(job.helpdeskRef))) {
      const siteNm = String(job.siteName || "").trim(), siteCd = String(job.siteCode || "").trim();
      const healed = jobIsProject(job) ? (siteCd || siteNm) : (siteNm || siteCd);
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
  if (job.release && job.release.mode && job.release.mode !== "now") {
    const t = releaseInstant(job);
    releaseView = { mode: job.release.mode, at: t ? new Date(t).toISOString() : null, label: releaseLabel(job) };
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
