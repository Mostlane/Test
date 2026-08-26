// Workever sync — bring the portal's job records in line with Workever.
// ---------------------------------------------------------------------------
// Workever (mostlane.workever.app) is where field work is actually completed,
// but the portal can't see that — jobs sit "Pending" here long after they're
// done there. This route reconciles the two. It's BROWSER-DRIVEN because
// Workever has no API key: a runner snippet (generated in SLA Settings, carrying
// the admin's portal token) runs in the logged-in Workever tab, pages every job
// from Workever's /api/v1/jobs-list, and POSTs batches here.
//
// Matching (discovered from real data):
//   • LIVE portal jobs  ↔ Workever by the CONCERTO number, the leading token of
//     both the portal helpdesk_ref ("28552/1-Beggarwood") and the Workever job
//     name ("28552/1 - Beggarwood") → "28552/1".
//   • ARCHIVE jobs      ↔ Workever by the MOS number (Workever `identifier`,
//     e.g. "MOS24356"), which is exactly the sla_jobs_archive primary key.
//
// Per job the reconcile is:
//   • matches a LIVE job AND Workever says it's done, portal isn't → update the
//     live job's status to done (+ cost, + stamp). This clears the stuck pending.
//   • matches an ARCHIVE row → update its status if it changed, else skip.
//   • no match anywhere → import it into sla_jobs_archive.
// Everything is auto-applied and written to workever_sync_log for review.
//
// Status mapping (Workever status name → portal status + done?) is configurable
// in app_config `workever:statusmap`; sensible defaults below.
//
//   GET  /sla/workever/config   -> { map, statuses, lastrun }   (SLAAdmin)
//   POST /sla/workever/config   -> save the status map           (SLAAdmin)
//   POST /sla/workever/ingest   -> reconcile a batch of jobs     (SLAAdmin)
//   POST /sla/workever/enrich   -> attach description to imports  (SLAAdmin)
//   GET  /sla/workever/log      -> the change log                 (SLAAdmin)
//   POST /sla/workever/reset    -> clear the log for a fresh run  (SLAAdmin)

import { corsHeaders } from "../lib/http.js";
import { requireSession, permissionsFor } from "../lib/auth.js";
import { tenantDB } from "../lib/tenantdb.js";

const MAP_KEY = "workever:statusmap";
const LASTRUN_KEY = "workever:lastrun";

// The sync only ever ADVANCES a live job that is still in a built-in OPEN state.
// Anything else the portal has set — Complete/Closed/Invoiced/Cancelled OR any
// custom category (e.g. "FRA Complete") — is the portal's own record and is left
// untouched, so a job you completed IN THE PORTAL is never overwritten. This is
// deliberately a whitelist, not "not-done", so unknown/custom statuses are safe.
const OPEN_PORTAL = new Set(["Pending", "Scheduled", "Travelling", "In Progress", "On Hold", "Quote", "Order"]);

// Default Workever→portal mapping (keys are lower-cased + trimmed at match time).
// Built from the live status vocabulary. `done:true` means "finished in Workever".
const DEFAULT_MAP = {
  "closed jobs":              { portal: "Closed Jobs", done: true },
  "completed":                { portal: "Complete",    done: true },
  "sc compliance complete":   { portal: "Complete",    done: true },
  "fbc complete":             { portal: "Complete",    done: true },
  "invoiced":                 { portal: "Invoiced",    done: true },
  "scheduled":                { portal: "Scheduled",   done: false },
  "pending":                  { portal: "Pending",     done: false },
  "in progress":              { portal: "In Progress", done: false },
  "on hold":                  { portal: "On Hold",     done: false },
  "travelling":               { portal: "Travelling",  done: false },
  "to quote - office":        { portal: "Quote",       done: false },
  "chaplins":                 { portal: "Pending",     done: false },
  "fra 2026":                 { portal: "FRA Works",   done: false },
};

async function ensureLog(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS workever_sync_log (
    tenant_id TEXT, run_id TEXT, at TEXT, action TEXT, mos TEXT, ref TEXT,
    portal_id TEXT, from_status TEXT, to_status TEXT, note TEXT)`).run();
}

async function loadMap(db) {
  const row = await db.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(db.tenantId, MAP_KEY).first();
  let m = null;
  try { m = row ? JSON.parse(row.value) : null; } catch {}
  return (m && typeof m === "object") ? m : { ...DEFAULT_MAP };
}
async function saveMap(db, m) {
  await db.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(db.tenantId, MAP_KEY, JSON.stringify(m)).run();
}
async function loadKV(db, key) {
  const row = await db.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(db.tenantId, key).first();
  try { return row ? JSON.parse(row.value) : null; } catch { return null; }
}
async function saveKV(db, key, obj) {
  await db.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(db.tenantId, key, JSON.stringify(obj)).run();
}

// Concerto number = the leading job-number token of a name/ref: digits with an
// optional "/N" suffix. "28552/1 - Beggarwood" → "28552/1"; "28532-Gosport" → "28532".
function leadRef(s) {
  const m = String(s || "").match(/^\s*(\d+(?:\/\d+)?)/);
  return m ? m[1] : "";
}
function normStatus(s) { return String(s || "").trim().toLowerCase(); }
function mapStatus(map, name) {
  const hit = map[normStatus(name)];
  if (hit && hit.portal) return { portal: hit.portal, done: !!hit.done };
  // Unknown status: infer done from the words, keep a safe portal value.
  const done = /complete|closed|done|invoic|finish/i.test(name || "");
  return { portal: done ? "Complete" : "Pending", done };
}

export async function handle(request, env, ctx, url, sess) {
  const cors = corsHeaders(env, request);
  const path = url.pathname;
  const method = request.method.toUpperCase();
  const json = (data, code = 200) =>
    new Response(JSON.stringify(data), { status: code, headers: { ...cors, "Content-Type": "application/json" } });

  if (!sess) sess = await requireSession(env, request);
  if (!sess) return json({ ok: false, error: "Not authenticated" }, 401);
  const perms = await permissionsFor(env, sess.tenantId, sess.user.username);
  if (perms.FullAccess !== "Yes" && perms.SLAAdmin !== "Yes") return json({ ok: false, error: "Forbidden" }, 403);
  const db = tenantDB(env, sess.tenantId);
  const tid = sess.tenantId;
  await ensureLog(db);

  if (path === "/sla/workever/config" && method === "GET") {
    return json({ ok: true, map: await loadMap(db), lastrun: await loadKV(db, LASTRUN_KEY) });
  }
  if (path === "/sla/workever/config" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!b.map || typeof b.map !== "object") return json({ ok: false, error: "map required" }, 400);
    await saveMap(db, b.map);
    return json({ ok: true, map: b.map });
  }
  if (path === "/sla/workever/log" && method === "GET") {
    const limit = Math.min(2000, parseInt(url.searchParams.get("limit"), 10) || 500);
    const runId = url.searchParams.get("runId");
    const q = runId
      ? db.prepare("SELECT * FROM workever_sync_log WHERE tenant_id=? AND run_id=? ORDER BY at DESC LIMIT ?").bind(tid, runId, limit)
      : db.prepare("SELECT * FROM workever_sync_log WHERE tenant_id=? ORDER BY at DESC LIMIT ?").bind(tid, limit);
    const { results } = await q.all();
    return json({ ok: true, log: results || [], lastrun: await loadKV(db, LASTRUN_KEY) });
  }
  if (path === "/sla/workever/reset" && method === "POST") {
    await db.prepare("DELETE FROM workever_sync_log WHERE tenant_id=?").bind(tid).run();
    await saveKV(db, LASTRUN_KEY, null);
    return json({ ok: true });
  }
  if (path === "/sla/workever/enrich" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const items = Array.isArray(b.items) ? b.items : [];
    let n = 0;
    for (const it of items) {
      const mos = String(it.mos || "").trim();
      const desc = String(it.description || "").trim();
      if (!mos || !desc) continue;
      const row = await db.prepare("SELECT data, search FROM sla_jobs_archive WHERE tenant_id=? AND id=?").bind(tid, mos).first();
      if (!row) continue;
      let data = {}; try { data = row.data ? JSON.parse(row.data) : {}; } catch {}
      data.description = desc;
      const search = ((row.search || "") + " " + desc).toLowerCase().slice(0, 4000);
      await db.prepare("UPDATE sla_jobs_archive SET data=?, search=? WHERE tenant_id=? AND id=?")
        .bind(JSON.stringify(data), search, tid, mos).run();
      n++;
    }
    return json({ ok: true, enriched: n });
  }

  // Import Workever files onto a LIVE portal job (jobs/<id>/…) so they show on
  // the job card + site — NOT the archive store (a live job has no archive row).
  // Idempotent via R2 head; streams each public S3 URL straight into R2.
  if (path === "/sla/workever/job-files" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const jobId = String(b.jobId || "").trim();
    const files = Array.isArray(b.files) ? b.files : [];
    if (!jobId || !files.length) return json({ ok: true, imported: 0, skipped: 0, failed: 0 });
    let imported = 0, skipped = 0, failed = 0, seq = 0;
    for (const f of files) {
      try {
        if (!f || !f.url) { failed++; continue; }
        const safe = (String(f.id || f.name || "").replace(/[^\w.\-]+/g, "_").slice(0, 90)) || ("f" + (seq++));
        const extRaw = (String(f.name || "").split(".").pop() || "").toLowerCase().replace(/[^a-z0-9]/g, "");
        const ext = extRaw || ((f.type || "").split("/").pop() || "jpg");
        const key = f.kind === "signature" ? `jobs/${jobId}/signature/wev-${safe}.png`
          : f.kind === "document" ? `jobs/${jobId}/docs/wev-${safe}.${ext}`
          : `jobs/${jobId}/photos/wev-${safe}.${ext}`;
        if (await env.JOB_FILES.head(key)) { skipped++; continue; }
        const resp = await fetch(f.url);
        if (!resp.ok || !resp.body) { failed++; continue; }
        const cm = f.kind === "photo" ? { stage: "After", source: "workever" } : { source: "workever" };
        await env.JOB_FILES.put(key, resp.body, { httpMetadata: { contentType: f.type || resp.headers.get("Content-Type") || "application/octet-stream" }, customMetadata: cm });
        imported++;
      } catch (e) { failed++; }
    }
    return json({ ok: true, imported, skipped, failed });
  }

  if (path === "/sla/workever/ingest" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const runId = String(b.runId || "run");
    const jobs = Array.isArray(b.jobs) ? b.jobs : [];
    if (!jobs.length) return json({ ok: true, counts: {}, needPhotos: [], needDetail: [] });
    const map = await loadMap(db);
    const nowIso = new Date().toISOString();

    // Preload all live jobs, keyed by Concerto number (there are only ~200).
    // The Concerto number lives in the job ID ("27869-Cowes, Mill Hill Road") —
    // NOT always in helpdesk_ref (which can be just the site name, and is shared
    // by every job at that site). So key on leadRef(id) first, ref as fallback.
    const liveRows = (await db.prepare("SELECT id, helpdesk_ref, status FROM sla_jobs WHERE tenant_id=?").bind(tid).all()).results || [];
    const liveByRef = {};
    for (const r of liveRows) { const k = leadRef(r.id) || leadRef(r.helpdesk_ref); if (k && !liveByRef[k]) liveByRef[k] = r; }

    // Preload existing archive statuses for this batch's MOS numbers.
    const mosList = jobs.map(j => String(j.mos || "").trim()).filter(Boolean);
    const archById = {};
    // D1 caps bound parameters at 100 per statement; 1 (tid) + 90 ids = 91.
    for (let i = 0; i < mosList.length; i += 90) {
      const chunk = mosList.slice(i, i + 90);
      const ph = chunk.map(() => "?").join(",");
      const { results } = await db.prepare(`SELECT id, status FROM sla_jobs_archive WHERE tenant_id=? AND id IN (${ph})`).bind(tid, ...chunk).all();
      for (const r of results || []) archById[r.id] = r.status;
    }

    const counts = { updatedLive: 0, importedArchive: 0, updatedArchive: 0, skipped: 0, errors: 0 };
    const needPhotos = [], needDetail = [], logRows = [];
    const addLog = (action, j, from, to, note, portalId) =>
      logRows.push([tid, runId, nowIso, action, j.mos || "", leadRef(j.name), portalId || "", from || "", to || "", note || ""]);

    for (const j of jobs) {
      try {
        const mos = String(j.mos || "").trim();
        const m = mapStatus(map, j.status);
        const ref = leadRef(j.name);
        const live = ref ? liveByRef[ref] : null;

        // 1) LIVE match — only ever advance a job that's still in an OPEN state,
        // so a job already completed/categorised in the portal is never touched.
        if (live) {
          if (m.done && OPEN_PORTAL.has(live.status)) {
            const cur = await db.prepare("SELECT data FROM sla_jobs WHERE tenant_id=? AND id=?").bind(tid, live.id).first();
            let data = {}; try { data = cur && cur.data ? JSON.parse(cur.data) : {}; } catch {}
            data.workever = { mos, uuid: j.uuid || "", cost: j.cost || 0, status: j.status, syncedAt: nowIso, runId };
            await db.prepare("UPDATE sla_jobs SET status=?, closed_at=COALESCE(closed_at,?), updated_at=?, data=? WHERE tenant_id=? AND id=?")
              .bind(m.portal, nowIso, nowIso, JSON.stringify(data), tid, live.id).run();
            counts.updatedLive++;
            addLog("update-live", j, live.status, m.portal, j.name, live.id);
            needPhotos.push({ mos, uuid: j.uuid || "", target: "live", portalId: live.id });
            live.status = m.portal; // guard against a second row for the same ref
          } else {
            counts.skipped++;
          }
          continue;
        }

        // 2) ARCHIVE match by MOS.
        if (mos && archById[mos] !== undefined) {
          if (archById[mos] !== m.portal) {
            await db.prepare("UPDATE sla_jobs_archive SET status=? WHERE tenant_id=? AND id=?").bind(m.portal, tid, mos).run();
            counts.updatedArchive++;
            addLog("update-archive", j, archById[mos], m.portal, j.name);
            archById[mos] = m.portal;
          } else {
            counts.skipped++;
          }
          continue;
        }

        // 3) NEW → import into the archive (description enriched in a 2nd pass).
        if (!mos) { counts.errors++; addLog("error", j, "", "", "no MOS identifier"); continue; }
        const siteName = String(j.siteName || j.customerName || "").trim();
        const data = {
          source: "workever", mos, uuid: j.uuid || "", name: j.name || "", description: "",
          cost: j.cost || 0, priority: j.priority || "", customerName: j.customerName || "",
          address: j.address || {}, workeverStatus: j.status || "", syncedAt: nowIso, runId,
        };
        const search = `${mos} ${j.name || ""} ${siteName} ${j.postcode || ""} ${j.customerName || ""}`.toLowerCase().slice(0, 4000);
        await db.prepare(`INSERT INTO sla_jobs_archive
          (tenant_id, id, ref, status, assigned_to, site_name, postcode, created_at, completed_at, search, data, site_code)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET status=excluded.status`)
          .bind(tid, mos, mos, m.portal, j.assignedLabel || "", siteName, j.postcode || "", null, null, search, JSON.stringify(data), String(j.siteCode || "")).run();
        counts.importedArchive++;
        addLog("import-archive", j, "", m.portal, j.name);
        needDetail.push(mos);
        needPhotos.push({ mos, uuid: j.uuid || "", target: "archive" });
      } catch (e) {
        counts.errors++;
        addLog("error", j, "", "", String(e && e.message || e));
      }
    }

    // Write the log in chunks. Each row binds 10 columns and D1 caps parameters
    // at 100 per statement, so at most 9 rows (90 vars) per insert.
    for (let i = 0; i < logRows.length; i += 9) {
      const chunk = logRows.slice(i, i + 9);
      const values = chunk.map(() => "(?,?,?,?,?,?,?,?,?,?)").join(",");
      await db.prepare(`INSERT INTO workever_sync_log
        (tenant_id, run_id, at, action, mos, ref, portal_id, from_status, to_status, note) VALUES ${values}`)
        .bind(...chunk.flat()).run();
    }
    // Prune the log to the newest 8000 rows per tenant.
    ctx?.waitUntil?.(db.prepare(
      "DELETE FROM workever_sync_log WHERE tenant_id=? AND rowid NOT IN (SELECT rowid FROM workever_sync_log WHERE tenant_id=? ORDER BY at DESC LIMIT 8000)"
    ).bind(tid, tid).run().catch(() => {}));

    // Accumulate the run summary.
    const prev = (await loadKV(db, LASTRUN_KEY)) || {};
    const acc = (prev.runId === runId && prev.counts) ? prev.counts : { updatedLive: 0, importedArchive: 0, updatedArchive: 0, skipped: 0, errors: 0 };
    for (const k of Object.keys(counts)) acc[k] = (acc[k] || 0) + counts[k];
    await saveKV(db, LASTRUN_KEY, { runId, startedAt: prev.runId === runId ? prev.startedAt : nowIso, updatedAt: nowIso, counts: acc });

    return json({ ok: true, counts, needPhotos, needDetail });
  }

  return json({ ok: false, error: "Not found: " + path }, 404);
}
