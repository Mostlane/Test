// costing.js — Master site register, labour ledger, job costing + exceptions.
//
// The one place that answers "where did everyone's time go, and what did it
// cost?" with minimal user input. Three layers:
//
//  1. SITE REGISTER — the existing `sites` table becomes the master list.
//     Every site is Active or Archived (archived stays pickable but flagged),
//     free-typed name variants map onto a canonical site via ALIASES, and a
//     CANDIDATES harvest surfaces names seen in the wild (jobs, timesheets,
//     scans, PO/compliance pushes) that aren't in the register yet.
//       GET  /sites/register                 -> { sites, aliases, ignored }
//       POST /sites/register/update          { client, siteNumber, archived?, name?, postcode? }
//       POST /sites/register/add             { name, postcode?, client? }
//       POST /sites/register/merge           { alias, client, siteNumber }
//       POST /sites/register/unmerge         { alias }
//       POST /sites/register/ignore          { name, undo? }
//       GET  /sites/register/candidates      -> { candidates:[{name, sources, count}] }
//       POST /sites/register/push-candidates { names:[...], source }   (browser-side PO/compliance lists)
//
//  2. LABOUR LEDGER — reconciles every time source into per-day entries:
//     job_time_segments (SLA status capture, primary), SiteLog scans
//     (sitelog_scans table, fed by POST /ledger/scan), and the day window
//     (shifts). Job segments win; scan time only counts where no job segment
//     covers it (never double-counted); a scan at a DIFFERENT site than the
//     concurrent job segment flags a mismatch.
//       POST /ledger/scan          (public, HMAC x-portal-sig with PORTAL_BRIDGE_SECRET)
//       GET  /ledger/day?user=&date=YYYY-MM-DD
//
//  3. COSTING + EXCEPTIONS
//       GET /costing/summary?from=&to=[&site=]  -> per-site hours (travel/onsite/visit) + labour cost
//       GET /exceptions?from=&to=               -> everything needing a human eye
//
// All tables self-migrate. Every read tolerates rows written before a column
// existed. Nothing here may ever break a job save or timesheet save.

import { json, error } from "../lib/http.js";
import { permissionsFor } from "../lib/auth.js";
import { poOrderSiteNames } from "./timesheets.js";
import * as sitelogApi from "./sitelog-api.js";

// Fetch a SiteLog admin endpoint. When the SiteLog DB is bound into this worker
// (post-migration) run the ported backend directly — no api.site-log.co.uk
// round-trip; otherwise fall back to the custom-domain fetch. Same shape either
// way so the callers are unchanged. `pathQuery` e.g. "/job-costing?from=…&to=…".
async function sitelogAdminFetch(env, pathQuery, ms) {
  const secret = env.SITELOG_ADMIN_SECRET;
  const target = (env.SITELOG_API || "https://api.site-log.co.uk") + pathQuery;
  if (env.SITELOG_DB) {
    // Ported backend, in-process. Belt-and-braces during rollout: if it errors
    // or returns non-ok, fall through to the still-running remote worker so
    // costing can never break because of the migration.
    try {
      const res = await sitelogApi.handle(new Request(target, { headers: { "x-admin-secret": secret || "" } }), env);
      if (res && res.ok) return res;
    } catch (e) { /* fall through to remote */ }
  }
  return fetchWithTimeout(target, { headers: { "x-admin-secret": secret } }, ms || 8000);
}

const UNALLOC_MIN = 15;   // minutes of uncovered day window before we flag it
const CLAIM_GAP_MIN = 30; // claimed-vs-captured difference before we flag it
const MAX_SEG_HOURS = 14; // a single job session longer than this = forgotten status change → clamp
const MAX_SEG_MS = MAX_SEG_HOURS * 3600e3;

export async function handle(request, env, ctx, url, sess) {
  const path = url.pathname;
  const method = request.method;
  const q = url.searchParams;

  // ── Public: SiteLog scan intake (HMAC, no session) ────────────────────────
  if (path === "/ledger/scan" && method === "POST") return scanIntake(request, env);

  if (!sess) return error("Not authenticated", 401, env, request);
  const tid = sess.tenantId;
  const me = sess.user.username;
  const perms = await permissionsFor(env, tid, me);
  const admin = perms.FullAccess === "Yes" || perms.SLAAdmin === "Yes" || perms.TimesheetAdmin === "Yes";

  await ensure(env);

  /* ══ 1. SITE REGISTER ═════════════════════════════════════════════════════ */

  if (path === "/sites/register" && method === "GET") {
    const reg = await loadRegister(env, tid);
    return json({ ok: true, sites: reg.list, aliases: reg.aliases, ignored: reg.ignored }, {}, env, request);
  }

  if (path.startsWith("/sites/register/") && method === "POST") {
    if (!admin) return error("Forbidden", 403, env, request);
    const b = await request.json().catch(() => ({}));

    if (path === "/sites/register/update") {
      const client = String(b.client || "").toLowerCase().trim();
      const num = String(b.siteNumber || "").trim();
      if (!client || !num) return error("client and siteNumber required", 400, env, request);
      const row = await env.DB.prepare("SELECT data FROM sites WHERE tenant_id=? AND client=? AND site_number=?")
        .bind(tid, client, num).first();
      if (!row) return error("Site not found", 404, env, request);
      let data = {}; try { data = JSON.parse(row.data || "{}"); } catch {}
      if (b.archived !== undefined) data.archived = !!b.archived;
      if (b.name) data.siteName = String(b.name).trim();
      if (b.postcode !== undefined) data.postcode = String(b.postcode || "").toUpperCase().trim();
      const ll = parseLatLngPair(b.lat, b.lng);
      if (ll) { data.lat = ll.lat; data.lng = ll.lng; }
      await env.DB.prepare(`UPDATE sites SET archived=?, site_name=COALESCE(?, site_name),
          postcode=COALESCE(?, postcode), data=?, updated_at=datetime('now')
        WHERE tenant_id=? AND client=? AND site_number=?`)
        .bind(b.archived !== undefined ? (b.archived ? 1 : 0) : (data.archived ? 1 : 0),
              b.name ? String(b.name).trim() : null,
              b.postcode !== undefined ? String(b.postcode || "").toUpperCase().trim() : null,
              JSON.stringify(data), tid, client, num).run();
      let pushed = false;
      if (ll) pushed = await pushSiteToSiteLog(env, data.siteName || b.name || "", ll.lat, ll.lng, client);
      return json({ ok: true, sitelogPushed: pushed }, {}, env, request);
    }

    if (path === "/sites/register/add") {
      const name = String(b.name || "").trim();
      if (!name) return error("name required", 400, env, request);
      const client = String(b.client || "general").toLowerCase().trim() || "general";
      const num = slugNum(name);
      const ll = parseLatLngPair(b.lat, b.lng);
      const data = { client, siteNumber: num, siteName: name,
        postcode: String(b.postcode || "").toUpperCase().trim(), addedVia: "register" };
      if (ll) { data.lat = ll.lat; data.lng = ll.lng; }
      await env.DB.prepare(`INSERT INTO sites (tenant_id, client, site_number, site_name, postcode, active, archived, data, updated_at)
        VALUES (?,?,?,?,?,1,0,?,datetime('now'))
        ON CONFLICT(client, site_number) DO UPDATE SET site_name=excluded.site_name,
          postcode=excluded.postcode, archived=0, data=excluded.data, updated_at=datetime('now')`)
        .bind(tid, client, num, name, data.postcode || null, JSON.stringify(data)).run();
      let pushed = false;
      if (ll) pushed = await pushSiteToSiteLog(env, name, ll.lat, ll.lng, client);
      return json({ ok: true, client, siteNumber: num, sitelogPushed: pushed }, {}, env, request);
    }

    if (path === "/sites/register/merge") {
      const alias = normName(b.alias);
      if (!alias) return error("alias required", 400, env, request);
      const aliases = await cfgGet(env, tid, "site_aliases", {});
      aliases[alias] = { client: String(b.client || "").toLowerCase(), siteNumber: String(b.siteNumber || ""), label: String(b.alias || "").trim() };
      await cfgSet(env, tid, "site_aliases", aliases);
      return json({ ok: true }, {}, env, request);
    }

    if (path === "/sites/register/unmerge") {
      const aliases = await cfgGet(env, tid, "site_aliases", {});
      delete aliases[normName(b.alias)];
      await cfgSet(env, tid, "site_aliases", aliases);
      return json({ ok: true }, {}, env, request);
    }

    if (path === "/sites/register/ignore") {
      const ignored = await cfgGet(env, tid, "site_reg_ignore", {});
      const k = normName(b.name);
      if (!k) return error("name required", 400, env, request);
      if (b.undo) delete ignored[k]; else ignored[k] = String(b.name || "").trim();
      await cfgSet(env, tid, "site_reg_ignore", ignored);
      return json({ ok: true }, {}, env, request);
    }

    if (path === "/sites/register/push-candidates") {
      const names = Array.isArray(b.names) ? b.names.slice(0, 2000) : [];
      const source = String(b.source || "external").slice(0, 30);
      const ext = await cfgGet(env, tid, "site_reg_ext", {});
      for (const n of names) {
        const k = normName(n); if (!k) continue;
        const cur = ext[k] || { name: String(n).trim(), sources: [] };
        if (!cur.sources.includes(source)) cur.sources.push(source);
        ext[k] = cur;
      }
      await cfgSet(env, tid, "site_reg_ext", ext);
      return json({ ok: true, stored: Object.keys(ext).length }, {}, env, request);
    }
  }

  if (path === "/sites/register/candidates" && method === "GET") {
    if (!admin) return error("Forbidden", 403, env, request);
    const reg = await loadRegister(env, tid);
    const ignored = reg.ignored;
    const found = {};   // norm -> { name, sources:Set-ish array, count }
    const add = (name, source) => {
      const k = normName(name);
      if (!k || k.length < 3) return;
      if (reg.byNorm[k] || ignored[k]) return;
      const cur = found[k] || (found[k] = { name: String(name).trim(), sources: [], count: 0 });
      cur.count++;
      if (!cur.sources.includes(source)) cur.sources.push(source);
    };
    // Live SLA jobs' site names
    try {
      const { results } = await env.DB.prepare("SELECT data FROM sla_jobs WHERE tenant_id=?").bind(tid).all();
      for (const r of results || []) { try { const j = JSON.parse(r.data || "{}"); if (j.siteName) add(j.siteName, "jobs"); } catch {} }
    } catch {}
    // Captured time segments
    try {
      const { results } = await env.DB.prepare(
        "SELECT DISTINCT site FROM job_time_segments WHERE tenant_id=? AND site IS NOT NULL AND site!=''").bind(tid).all();
      for (const r of results || []) add(r.site, "time-capture");
    } catch {}
    // SiteLog scans
    try {
      const { results } = await env.DB.prepare(
        "SELECT DISTINCT site FROM sitelog_scans WHERE tenant_id=? AND site IS NOT NULL AND site!=''").bind(tid).all();
      for (const r of results || []) add(r.site, "sitelog");
    } catch {}
    // Timesheet mileage rows (recent 26 weeks of saved sheets)
    try {
      const { results } = await env.DB.prepare(
        "SELECT data FROM eng_timesheets WHERE tenant_id=? ORDER BY week DESC LIMIT 260").bind(tid).all();
      for (const r of results || []) {
        try {
          const days = (JSON.parse(r.data || "{}").days) || {};
          for (const d of Object.values(days))
            for (const m of (Array.isArray(d.mileage) ? d.mileage : []))
              if (m && m.site) add(m.site, "timesheets");
        } catch {}
      }
    } catch {}
    // Site names typed on PO records (PO_DB binding — fails soft when unbound)
    try { for (const n of await poOrderSiteNames(env)) add(n, "po"); } catch {}
    // Browser-pushed lists (PO worker / compliance stores)
    try {
      const ext = await cfgGet(env, tid, "site_reg_ext", {});
      for (const [k, v] of Object.entries(ext)) {
        if (reg.byNorm[k] || ignored[k]) continue;
        const cur = found[k] || (found[k] = { name: v.name, sources: [], count: 0 });
        cur.count = Math.max(cur.count, 1);
        for (const s of v.sources || []) if (!cur.sources.includes(s)) cur.sources.push(s);
      }
    } catch {}
    const candidates = Object.values(found).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 500);
    return json({ ok: true, candidates }, {}, env, request);
  }

  /* ══ 2. LABOUR LEDGER ═════════════════════════════════════════════════════ */

  if (path === "/ledger/day" && method === "GET") {
    const user = q.get("user") || me;
    if (user !== me && !admin) return error("Forbidden", 403, env, request);
    const date = q.get("date") || londonDate(new Date().toISOString());
    const reg = await loadRegister(env, tid);
    const day = await buildDay(env, tid, user, date, reg);
    return json({ ok: true, ...day }, {}, env, request);
  }

  if (path === "/ledger/scans" && method === "GET") {
    if (!admin) return error("Forbidden", 403, env, request);
    const { results } = await env.DB.prepare(
      "SELECT * FROM sitelog_scans WHERE tenant_id=? ORDER BY at DESC LIMIT 200").bind(tid).all();
    return json({ ok: true, scans: results || [] }, {}, env, request);
  }

  /* ══ 3. COSTING + EXCEPTIONS ══════════════════════════════════════════════ */

  // Manual trigger for the SiteLog→SLA session reconcile (same work the hourly
  // cron does). Handy for testing and for an on-demand "sync now" button.
  if (path === "/costing/reconcile-sitelog" && method === "POST") {
    if (!admin) return error("Forbidden", 403, env, request);
    const r = await reconcileSitelogSessions(env, tid, { days: Number(q.get("days")) || 4 });
    return json(r, {}, env, request);
  }

  // Per-view organisation of the job-costing screen (shared across admins):
  // which site cards are pinned to the top, hidden, and their manual order.
  // Keyed by the site `key` returned in /costing/summary.
  if (path === "/costing/prefs" && method === "GET") {
    if (!admin) return error("Forbidden", 403, env, request);
    const prefs = await cfgGet(env, tid, "costing_prefs", { pinned: [], hidden: [], order: [] });
    return json({ ok: true, prefs }, {}, env, request);
  }
  if (path === "/costing/prefs" && method === "POST") {
    if (!admin) return error("Forbidden", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const arr = v => Array.isArray(v) ? v.filter(x => typeof x === "string").slice(0, 2000) : [];
    const prefs = { pinned: arr(b.pinned), hidden: arr(b.hidden), order: arr(b.order) };
    await cfgSet(env, tid, "costing_prefs", prefs);
    return json({ ok: true, prefs }, {}, env, request);
  }

  // ── Per-job materials cost: the POs raised against ONE job (live from PO_DB) ──
  // Powers the "Materials (POs)" panel on job-view — true reflection of the job's
  // material spend, updating automatically as each PO is priced. Office/admin only.
  if (path === "/costing/job-pos" && method === "GET") {
    if (!admin) return error("Forbidden", 403, env, request);
    const jobId = q.get("jobId") || q.get("job") || "";
    if (!jobId) return error("jobId required", 400, env, request);
    const rows = await jobPoRows(env, jobId);
    let total = 0, unpriced = 0, materials = 0, subcontractor = 0;
    const pos = rows.map(r => {
      const v = (r.cost_ex_vat != null && r.cost_ex_vat !== "") ? Number(r.cost_ex_vat) : null;
      const priced = v != null && isFinite(v);
      if (priced) {
        total += v;
        if (String(r.cost_category || "").toLowerCase() === "subcontractor") subcontractor += v; else materials += v;
      } else unpriced++;
      return {
        poNumber: r.po_number != null ? String(r.po_number) : "",
        supplier: r.supplier || "", category: r.cost_category || "", trade: r.trade || "",
        cost: priced ? Math.round(v * 100) / 100 : null,
        incident: r.incident_no || r.job_ref || "", by: r.engineer_name || "", date: r.d || ""
      };
    });
    const round = n => Math.round(n * 100) / 100;
    return json({
      ok: true, jobId, poBound: !!env.PO_DB, count: pos.length,
      total: round(total), materials: round(materials), subcontractor: round(subcontractor),
      unpriced, pos
    }, {}, env, request);
  }

  // ── Total cost of a job to the company (office/admin only) ──────────────────
  // Labour (on-site time from status-tap segments) + travel labour (a round trip
  // HQ→site→HQ per engineer per day worked) + fuel for those round trips at a
  // fixed £0.50/mile + materials (priced POs; unpriced ones are flagged, never
  // counted as £0). Everything is derived — nothing new is stored.
  if (path === "/costing/job-full-cost" && method === "GET") {
    if (!admin) return error("Forbidden", 403, env, request);
    const jobId = q.get("jobId") || q.get("job") || "";
    if (!jobId) return error("jobId required", 400, env, request);
    const SPEED_MPH = 30, FUEL_PER_MILE = 0.5, ROAD_FACTOR = 1.25, HQ_PC = "PO15 5RQ";
    const r1 = n => Math.round(n * 10) / 10, r2 = n => Math.round(n * 100) / 100;
    const geoPc = async pc => { try {
      const r = await fetch("https://api.postcodes.io/postcodes/" + encodeURIComponent(String(pc || "").toUpperCase().replace(/\s+/g, "")), { cf: { cacheTtl: 2592000, cacheEverything: true } });
      if (!r.ok) return null; const j = await r.json(); const res = j && j.result;
      return res && res.latitude != null ? { lat: res.latitude, lng: res.longitude } : null;
    } catch { return null; } };
    const havMi = (a, b) => { const rad = x => x * Math.PI / 180, R = 3958.8; const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng); const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };

    // 1) the job (site name + postcode)
    const jrow = await env.DB.prepare("SELECT data FROM sla_jobs WHERE tenant_id=? AND id=?").bind(tid, jobId).first();
    let jd = {}; try { jd = jrow && jrow.data ? JSON.parse(jrow.data) : {}; } catch {}
    const siteName = jd.siteName || jd.siteCode || "";
    const sitePc = jd.postcode || "";

    // 2) on-site labour: closed segments for this job → per-engineer minutes + days
    const { results: segs } = await env.DB.prepare(
      "SELECT username, started_at, ended_at FROM job_time_segments WHERE tenant_id=? AND job_id=? AND ended_at IS NOT NULL"
    ).bind(tid, jobId).all();
    const byEng = {};
    for (const s of segs || []) {
      const st = new Date(String(s.started_at).replace(" ", "T") + "Z"), en = new Date(String(s.ended_at).replace(" ", "T") + "Z");
      let mins = (en - st) / 60000; if (!isFinite(mins) || mins <= 0) continue; if (mins > 14 * 60) mins = 14 * 60;
      const u = s.username || ""; if (!u) continue;
      const e = byEng[u] || (byEng[u] = { mins: 0, days: new Set() });
      e.mins += mins; e.days.add(String(s.started_at).slice(0, 10));
    }

    // 2b) Scheduled-hours fallback: an ASSIGNED engineer who worked this job but
    //    never changed status has no segment → cost the PLANNED hours instead
    //    (their own scheduled slot span, else the job's duration). Actual
    //    status-tap time ALWAYS wins — only engineers with no captured segment
    //    are filled. Skips a day still in the future (not worked yet).
    const normIdL = s => String(s || "").toLowerCase().replace(/\s+/g, ".").trim();
    const todayISO = londonDate(new Date().toISOString());
    const plannedEng = new Set();
    if (!/^cancelled$/i.test(String(jd.status || ""))) {
      const engs = Array.isArray(jd.assignedEngineers) && jd.assignedEngineers.length ? jd.assignedEngineers : (jd.assignedTo ? [jd.assignedTo] : []);
      for (const rawEng of engs) {
        if (!rawEng) continue;
        if (Object.keys(byEng).some(u => normName(u) === normName(rawEng))) continue;   // real segment exists → actual wins
        const es = (jd.engSchedule && jd.engSchedule[normIdL(rawEng)]) || {};
        const startISO = es.scheduledAt || jd.scheduledAt;
        if (!startISO) continue;
        const day = String(startISO).slice(0, 10);
        if (day > todayISO) continue;   // not worked yet
        let mins = 0;
        const endISO = es.scheduledEnd || jd.scheduledEnd;
        if (endISO) { const dmin = (Date.parse(endISO) - Date.parse(startISO)) / 60000; if (dmin >= 15 && dmin <= 24 * 60) mins = Math.round(dmin); }
        if (!mins && Number(jd.durationMinutes) > 0) mins = Math.round(Number(jd.durationMinutes));
        if (!mins) continue;
        byEng[rawEng] = { mins, days: new Set([day]) };
        plannedEng.add(rawEng);
      }
    }

    // 3) round-trip miles for the site: the admin's site_miles register first
    //    (already a round-trip figure), else a HQ→site geocode × road factor × 2.
    let rtMiles = 0, milesSource = "unknown";
    const key = String(siteName || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (key) { try { const row = await env.DB.prepare("SELECT miles FROM site_miles WHERE tenant_id=? AND key=?").bind(tid, key).first(); if (row && row.miles != null) { rtMiles = Number(row.miles) || 0; milesSource = "register"; } } catch {} }
    if (!rtMiles && sitePc) { const base = await geoPc(HQ_PC), dest = await geoPc(sitePc); if (base && dest) { rtMiles = r1(havMi(base, dest) * ROAD_FACTOR * 2); milesSource = "geocoded"; } }

    // 4) rates (hourly; a day rate → /8)
    const rates = await ratesMap(env, tid);
    const hourlyOf = u => { const r = rates[u] || rates[String(u).toLowerCase()] || {}; if (r.rate == null) return null; return r.rateType === "day" ? r.rate / 8 : r.rate; };

    let onSiteCost = 0, travelCost = 0, fuelCost = 0, onSiteMins = 0, travelMins = 0, totalMiles = 0, anyNoRate = false;
    const engineers = [];
    for (const [u, e] of Object.entries(byEng)) {
      const rate = hourlyOf(u); if (rate == null) anyNoRate = true;
      const days = e.days.size || 0;
      const engMiles = rtMiles * days;
      const tMins = rtMiles > 0 ? (rtMiles / SPEED_MPH) * 60 * days : 0;
      const oCost = rate != null ? (e.mins / 60) * rate : 0;
      const tCost = rate != null ? (tMins / 60) * rate : 0;
      const fCost = engMiles * FUEL_PER_MILE;
      onSiteMins += e.mins; travelMins += tMins; totalMiles += engMiles;
      onSiteCost += oCost; travelCost += tCost; fuelCost += fCost;
      engineers.push({ name: u, onSiteMins: Math.round(e.mins), days, roundTripMiles: r1(engMiles), travelMins: Math.round(tMins), rate, onSiteCost: r2(oCost), travelCost: r2(tCost), fuelCost: r2(fCost), noRate: rate == null, planned: plannedEng.has(u) });
    }

    // 5) materials from POs (priced total + unpriced flag)
    const poRows = await jobPoRows(env, jobId);
    let materials = 0, unpriced = 0;
    for (const r of poRows) { const v = (r.cost_ex_vat != null && r.cost_ex_vat !== "") ? Number(r.cost_ex_vat) : null; if (v != null && isFinite(v)) materials += v; else unpriced++; }

    const labourCost = onSiteCost + travelCost;
    const total = labourCost + fuelCost + materials;
    return json({
      ok: true, jobId, poBound: !!env.PO_DB, site: siteName, milesSource, roundTripMiles: r1(rtMiles),
      labour: { onSiteMinutes: Math.round(onSiteMins), onSiteCost: r2(onSiteCost), travelMinutes: Math.round(travelMins), travelCost: r2(travelCost), cost: r2(labourCost), engineers, missingRate: anyNoRate },
      fuel: { miles: r1(totalMiles), perMile: FUEL_PER_MILE, cost: r2(fuelCost) },
      materials: { cost: r2(materials), unpriced, count: poRows.length },
      total: r2(total), unpricedPOs: unpriced, hasSegments: (segs || []).length > 0,
      plannedLabour: plannedEng.size > 0
    }, {}, env, request);
  }

  // Engineer name aliases (map an alternate name → the canonical portal person),
  // so e.g. the PO system's "JT" folds into "John Thorn" everywhere in costing.
  if (path === "/costing/eng-aliases" && method === "GET") {
    if (!admin) return error("Forbidden", 403, env, request);
    return json({ ok: true, aliases: await cfgGet(env, tid, "eng_aliases", {}) }, {}, env, request);
  }
  // Distinct engineer names used on PO records (for the PO↔portal link admin).
  if (path === "/costing/po-engineers" && method === "GET") {
    if (!admin) return error("Forbidden", 403, env, request);
    const out = [];
    if (env.PO_DB) {
      try {
        const { results } = await env.PO_DB.prepare(
          "SELECT engineer_name AS name, COUNT(*) AS n FROM po_log WHERE (deleted IS NULL OR deleted=0) AND engineer_name IS NOT NULL AND TRIM(engineer_name)!='' GROUP BY engineer_name ORDER BY n DESC"
        ).all();
        for (const r of results || []) out.push({ name: r.name, count: r.n });
      } catch {}
    }
    return json({ ok: true, engineers: out, poBound: !!env.PO_DB }, {}, env, request);
  }
  if (path === "/costing/eng-alias" && method === "POST") {
    if (!admin) return error("Forbidden", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const alias = normName(b.alias), user = String(b.user || "").trim();
    if (!alias || !user) return error("alias and user required", 400, env, request);
    const aliases = await cfgGet(env, tid, "eng_aliases", {});
    aliases[alias] = user;
    await cfgSet(env, tid, "eng_aliases", aliases);
    return json({ ok: true, aliases }, {}, env, request);
  }
  if (path === "/costing/eng-alias/delete" && method === "POST") {
    if (!admin) return error("Forbidden", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const aliases = await cfgGet(env, tid, "eng_aliases", {});
    delete aliases[normName(b.alias)];
    await cfgSet(env, tid, "eng_aliases", aliases);
    return json({ ok: true, aliases }, {}, env, request);
  }

  // ── Project valuations / financials (per site, keyed by the summary `key`) ──
  // Track a project's contract value, how many valuations are planned, and each
  // valuation submitted (amount + date). /costing/summary folds in the running
  // position + a suggested next valuation. Stored in app_config `proj_fin`.
  if (path === "/costing/fin" && method === "POST") {
    if (!admin) return error("Forbidden", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const key = String(b.key || "").trim();
    if (!key) return error("key required", 400, env, request);
    const cur = await writeProjFin(env, tid, key, { value: b.value, planned: b.planned, name: b.name });
    return json({ ok: true, fin: cur }, {}, env, request);
  }
  if (path === "/costing/fin/valuation" && method === "POST") {
    if (!admin) return error("Forbidden", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const key = String(b.key || "").trim();
    const amount = Number(b.amount);
    if (!key || !Number.isFinite(amount)) return error("key and amount required", 400, env, request);
    const fin = await cfgGet(env, tid, "proj_fin", {});
    const cur = fin[key] || { value: 0, planned: 0, valuations: [] };
    cur.valuations = Array.isArray(cur.valuations) ? cur.valuations : [];
    const date = /^\d{4}-\d{2}-\d{2}/.test(String(b.date || "")) ? String(b.date).slice(0, 10) : londonDate(new Date().toISOString());
    cur.valuations.push({ id: crypto.randomUUID(), amount: Math.round(amount * 100) / 100, date, note: String(b.note || "").slice(0, 200), final: !!b.final });
    fin[key] = cur;
    await cfgSet(env, tid, "proj_fin", fin);
    return json({ ok: true, fin: cur }, {}, env, request);
  }
  if (path === "/costing/fin/valuation/delete" && method === "POST") {
    if (!admin) return error("Forbidden", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const key = String(b.key || "").trim(), id = String(b.id || "");
    const fin = await cfgGet(env, tid, "proj_fin", {});
    const cur = fin[key];
    if (cur && Array.isArray(cur.valuations)) { cur.valuations = cur.valuations.filter(v => v.id !== id); await cfgSet(env, tid, "proj_fin", fin); }
    return json({ ok: true, fin: cur || null }, {}, env, request);
  }

  if (path === "/costing/summary" && method === "GET") {
    if (!admin) return error("Forbidden", 403, env, request);
    const { from, to } = rangeOf(q);
    const reg = await loadRegister(env, tid);
    const rates = await ratesMap(env, tid);
    // Hourly-equivalent rate: an hourly rate as-is; a DAY rate ÷ 8 so it's
    // pro-rata by hours (8h scheduled = a full day, 4h = half a day). null when
    // there's no usable rate on file (labour shown as hours, flagged partial).
    const hrRate = r => (r && r.rate) ? (r.rateType === "day" ? r.rate / 8 : (r.rateType === "hour" ? r.rate : null)) : null;
    const days = await reconcileRange(env, tid, from, to, reg);
    // Engineer aliases: collapse different names for one person (e.g. the PO
    // system's "JT" → the portal's "John Thorn") so their labour + POs group.
    const eAlias = await cfgGet(env, tid, "eng_aliases", {});
    const canonEng = (n) => eAlias[normName(n)] || (n || "(unknown)");
    const projFin = await cfgGet(env, tid, "proj_fin", {});   // per-site contract value + valuations

    const bySite = {};   // norm -> aggregate
    const siteKeyOf = (resolved, name) => resolved ? resolved.norm : ("?" + normName(name || "(no site)"));
    const siteFor = (name, resolved) => {
      const key = resolved ? resolved.norm : ("?" + normName(name || "(no site)"));
      return bySite[key] || (bySite[key] = {
        site: resolved ? resolved.name : (name || "(no site)"),
        client: resolved ? resolved.client : "",
        archived: !!(resolved && resolved.archived),
        unmatched: !resolved,
        travelMins: 0, onsiteMins: 0, visitMins: 0, cost: 0, costPartial: false,
        poTotal: 0, poUnpriced: 0, jobs: {}, engineers: {},
        labD: {}, poD: {}, suppliers: {}   // per-site: labour-by-day, PO-by-day, spend-by-supplier
      });
    };
    const engFor = (s, name) => {
      // Match a PO's engineer_name to a labour engineer by normalised name so
      // one person's labour + POs sit together; else start a new engineer row.
      let key = Object.keys(s.engineers).find(k => normName(k) === normName(name)) || name || "(unknown)";
      return s.engineers[key] || (s.engineers[key] = { mins: 0, cost: null, poCost: 0, pos: [], src: null, visits: 0, days: new Set() });
    };
    const addSrc = (eng, src) => { eng.src = !eng.src ? src : (eng.src === src ? src : "mixed"); };

    // ── Per-site spend-over-time series (labour + materials) ─────────────────
    // Each site card gets its OWN trend. We accumulate £ at DAY granularity
    // (labD/poD on each site, see siteFor); the series is bucketed later over
    // each site's ACTUAL active span (so "All time" doesn't stretch an axis
    // back to year dot with everything crammed into one spike).
    const addDay = (map, day, v) => { const k = String(day || "").slice(0, 10); if (!k) return; map[k] = Math.round(((map[k] || 0) + v) * 100) / 100; };
    // Per SiteLog person (site+who) → summary cost + onsite hours, to spread that
    // cost across their actual visit dates (from /admin) for the labour line.
    const slRate = {};

    // ── Seed every live/complete PROJECT so it appears here even at £0 ───────
    // Without this a brand-new project (no labour, no PO) can't be found on the
    // costing page for the admin to set its contract value / valuations.
    // Archived projects are skipped so retired work doesn't clutter the list.
    // Matching goes through resolveSite, so once real activity lands (labour /
    // PO), it merges into this same row rather than creating a duplicate.
    const seededProjects = {};   // sKey -> { id, number }
    try {
      const { results: projRows } = await env.DB.prepare(
        "SELECT id, number, name, status, data FROM projects WHERE tenant_id=? AND (status IS NULL OR status IN ('live','complete'))"
      ).bind(tid).all();
      for (const p of projRows || []) {
        const name = String(p.name || "").trim(); if (!name) continue;
        const resolved = resolveSite(reg, name);
        const s = siteFor(name, resolved);
        const sKey = siteKeyOf(resolved, name);
        seededProjects[sKey] = { id: p.id, number: p.number };
      }
    } catch {}

    // ── SiteLog labour (authoritative per site+person) ───────────────────────
    // Pull SiteLog's own job costing and fold it in FIRST, so we know which
    // (site, person) pairs SiteLog covers and can drop the matching SLA time
    // below (no double-count). Employees (linked portal users) are costed at the
    // PORTAL rate on SiteLog's measured hours/miles; subcontractors keep
    // SiteLog's own computed cost (SiteLog holds their rate). Fails soft: when
    // SiteLog is unreachable, slSites is null and costing is SLA-only as before.
    const slSites = await fetchSitelogCosting(env, from, to);
    const slCovered = new Set();   // `${siteKey}::${normName(person)}` handled by SiteLog
    if (slSites) {
      for (const slSite of slSites) {
        const resolved = resolveSiteCode(reg, slSite.siteCode);
        const s = siteFor(resolved ? resolved.name : (slSite.siteCode || "(no site)"), resolved);
        const sKey = siteKeyOf(resolved, slSite.siteCode);
        for (const p of (slSite.people || [])) {
          if (!p.costedVisits) continue;   // only closed (costed) visits carry cost
          const portalUser = (p.portalUsername || "").trim();
          const isEmployee = !!portalUser;
          const who = canonEng(isEmployee ? portalUser : (p.name || "(unknown)"));
          slCovered.add(sKey + "::" + normName(who));
          const workMins = Math.round((p.workH || 0) * 60);
          const travMins = Math.round((p.travelH || 0) * 60);
          s.visitMins += workMins;
          s.travelMins += travMins;
          const eng = engFor(s, who);
          eng.mins += workMins + travMins;
          eng.visits += (p.costedVisits || 0) + (p.openCount || 0);   // 1 scan session = 1 visit
          addSrc(eng, "sitelog");
          // Cost: portal rate for employees (falls back to SiteLog's own figure
          // when no portal rate is on file, so £ is never lost); SiteLog's cost
          // for subcontractors.
          const r = isEmployee ? (rates[who] || rates[portalUser]) : null;
          let cost = null;
          if (r && r.rateType === "hour" && r.rate) {
            const fuel = (r.fuelPerMile != null) ? (p.miles || 0) * r.fuelPerMile : (p.fuelCost || 0);
            cost = ((p.workH || 0) + (p.travelH || 0)) * r.rate + fuel;
          } else {
            cost = (p.total != null) ? Number(p.total) : null;   // SiteLog's own cost
          }
          if (cost != null && isFinite(cost)) {
            cost = Math.round(cost * 100) / 100;
            eng.cost = Math.round(((eng.cost || 0) + cost) * 100) / 100;
            s.cost = Math.round((s.cost + cost) * 100) / 100;
            // Remember cost + onsite hours so /admin visit dates can spread it.
            const hrs = (p.workH || 0) > 0 ? p.workH : ((p.workH || 0) + (p.travelH || 0));
            if (hrs > 0) slRate[sKey + "::" + normName(who)] = { cost, hrs };
          } else {
            s.costPartial = true;
          }
        }
      }
    }

    // ── SLA labour (job_time_segments), skipping anyone SiteLog already covers
    // at that site — SiteLog is authoritative for a scanned visit.
    for (const d of days) {
      for (const e of d.entries) {
        const s = siteFor(e.site, e.resolved);
        const sKey = siteKeyOf(e.resolved, e.site);
        const cu = canonEng(e.user);
        if (slCovered.has(sKey + "::" + normName(cu))) continue;   // deduped
        const bucket = e.kind === "travel" ? "travelMins" : (e.src === "sitelog" ? "visitMins" : "onsiteMins");
        s[bucket] += e.mins;
        if (e.jobRef) s.jobs[e.jobRef] = (s.jobs[e.jobRef] || 0) + e.mins;
        const eng = engFor(s, cu);
        eng.mins += e.mins;
        eng.days.add(d.date);   // distinct on-site days = visits for tap-only people
        addSrc(eng, "sla");
        const hr = hrRate(rates[cu]);
        if (hr != null) {
          eng.cost = Math.round(((eng.cost || 0) + (e.mins / 60) * hr) * 100) / 100;
          s.cost = Math.round((s.cost + (e.mins / 60) * hr) * 100) / 100;
          addDay(s.labD, d.date, (e.mins / 60) * hr);   // dated labour for this site's trend
        } else {
          s.costPartial = true;   // no rate on file — hours shown, £ can't be computed
        }
      }
    }

    // ── Scheduled-hours fallback (planned labour) ────────────────────────────
    // A scheduled job an engineer WORKED but never status-tapped captures no
    // job_time_segments, so it would cost £0. Fall back to the HOURS PLANNED on
    // the job (the engineer's own scheduled slot span, else the job's duration)
    // so those visits are still costed. Actual status-tap time ALWAYS takes
    // priority — skip any (job, engineer) that has a captured segment — and skip
    // anyone SiteLog already covers, and any day still in the future.
    try {
      const { listJobs } = await import("./sla.js");
      const allJobs = await listJobs(env, tid);
      const segPairs = new Set();   // "<job_id>::<normName(canonEng(user))>" with real captured time
      try {
        const { results } = await env.DB.prepare(
          "SELECT DISTINCT job_id, username FROM job_time_segments WHERE tenant_id=? AND job_id IS NOT NULL"
        ).bind(tid).all();
        for (const r of results || []) segPairs.add(String(r.job_id) + "::" + normName(canonEng(r.username)));
      } catch {}
      const normIdL = s => String(s || "").toLowerCase().replace(/\s+/g, ".").trim();
      for (const j of allJobs) {
        if (!j || j.fallbackTemplate) continue;
        if (/^cancelled$/i.test(String(j.status || ""))) continue;
        const engList = (Array.isArray(j.assignedEngineers) && j.assignedEngineers.length) ? j.assignedEngineers : (j.assignedTo ? [j.assignedTo] : []);
        if (!engList.length) continue;
        const siteLabel = j.siteName || j.siteCode || "(no site)";
        const resolved = resolveSite(reg, j.siteName || j.siteCode || "");
        const sKey = siteKeyOf(resolved, j.siteName || j.siteCode);
        let s = null;   // created lazily, only if an engineer actually contributes
        for (const rawEng of engList) {
          if (!rawEng) continue;
          const es = (j.engSchedule && j.engSchedule[normIdL(rawEng)]) || {};
          const startISO = es.scheduledAt || j.scheduledAt;
          if (!startISO) continue;
          const day = String(startISO).slice(0, 10);
          if (day < from || day > to) continue;   // outside the window (incl. future)
          let mins = 0;
          const endISO = es.scheduledEnd || j.scheduledEnd;
          if (endISO) { const dmin = (Date.parse(endISO) - Date.parse(startISO)) / 60000; if (dmin >= 15 && dmin <= 24 * 60) mins = Math.round(dmin); }
          if (!mins && Number(j.durationMinutes) > 0) mins = Math.round(Number(j.durationMinutes));
          if (!mins) continue;
          const who = canonEng(rawEng);
          const whoNorm = normName(who);
          if (slCovered.has(sKey + "::" + whoNorm)) continue;         // SiteLog authoritative
          if (segPairs.has(String(j.id) + "::" + whoNorm)) continue;  // actual segment wins
          if (!s) s = siteFor(siteLabel, resolved);
          s.onsiteMins += mins;
          if (j.helpdeskRef) s.jobs[j.helpdeskRef] = (s.jobs[j.helpdeskRef] || 0) + mins;
          const eng = engFor(s, who);
          eng.mins += mins;
          eng.days.add(day);
          addSrc(eng, "sla");
          eng.planned = true;
          const hr = hrRate(rates[who]);
          if (hr != null) {
            eng.cost = Math.round(((eng.cost || 0) + (mins / 60) * hr) * 100) / 100;
            s.cost = Math.round((s.cost + (mins / 60) * hr) * 100) / 100;
            addDay(s.labD, day, (mins / 60) * hr);
          } else {
            s.costPartial = true;   // no rate on file — hours shown, £ can't be computed
          }
        }
      }
    } catch {}

    // PO spend (ex VAT) from the PO system's D1 — folded in per site + per
    // engineer. Fails soft when PO_DB isn't bound. Unpriced POs (no cost yet)
    // are counted separately so pending spend is visible, not hidden.
    for (const p of await poRows(env, from, to)) {
      const resolved = resolveSite(reg, p.site);
      const s = siteFor(p.site, resolved);
      const val = p.cost_ex_vat != null && p.cost_ex_vat !== "" ? Number(p.cost_ex_vat) : null;
      if (val != null && isFinite(val)) { s.poTotal = Math.round((s.poTotal + val) * 100) / 100; addDay(s.poD, p.d || to, val); }
      else s.poUnpriced++;
      const eng = engFor(s, canonEng(p.engineer_name || "(unknown)"));
      if (val != null && isFinite(val)) eng.poCost = Math.round(((eng.poCost || 0) + val) * 100) / 100;
      eng.pos = eng.pos || [];
      eng.pos.push({ supplier: p.supplier || "", cost: (val != null && isFinite(val)) ? val : null,
        incident: p.incident_no || "", date: p.d || "", category: p.cost_category || "" });
      // Spend per supplier, per site (grouped for the "by supplier" breakdown).
      const supName = (p.supplier || "").trim() || "(no supplier)";
      const sup = s.suppliers[supName] || (s.suppliers[supName] = { supplier: supName, total: 0, count: 0, unpriced: 0 });
      sup.count++;
      if (val != null && isFinite(val)) sup.total = Math.round((sup.total + val) * 100) / 100;
      else sup.unpriced++;
    }

    // Spread each SiteLog person's cost across the dates they actually scanned
    // (from /admin) so the labour line is dated. Sums back to their site total.
    if (slSites && Object.keys(slRate).length) {
      const visits = await fetchSitelogVisits(env, from, to);
      for (const v of (visits || [])) {
        if (!v.check_in_at || !v.check_out_at) continue;
        const who = canonEng(String(v.portal_username || "").trim() || jcNameLike(v));
        const resolved = resolveSiteCode(reg, v.site_code);
        const sKey = siteKeyOf(resolved, v.site_code);
        const rt = slRate[sKey + "::" + normName(who)];
        if (!rt) continue;
        const site = bySite[sKey];
        if (!site) continue;
        const hrs = Math.max(0, (Date.parse(v.check_out_at) - Date.parse(v.check_in_at)) / 3600e3);
        if (hrs > 0) addDay(site.labD, londonDate(v.check_in_at), hrs * (rt.cost / rt.hrs));
      }
    }

    // ── Manual costs entered on the project hub (labour shifts + materials)
    // Folded per project's site key: labour into cost + per-engineer; materials
    // into poTotal (grouped as a supplier "Manual entry"). Kept as separate
    // manualLabour/manualMaterials totals for the P&L split on the hub.
    try {
      const projKeyById = {};   // projectId -> site key
      for (const [k, m] of Object.entries(seededProjects)) projKeyById[m.id] = k;
      const projIds = Object.keys(projKeyById);
      if (projIds.length) {
        for (const pid of projIds) {
          const { results } = await env.DB.prepare(
            "SELECT kind, username, hours, amount, supplier, description, date FROM project_costs WHERE tenant_id=? AND project_id=?"
          ).bind(tid, pid).all();
          const sKey = projKeyById[pid];
          const s = bySite[sKey]; if (!s) continue;
          for (const r of results || []) {
            const amt = Number(r.amount) || 0;
            if (r.kind === "labour") {
              s.cost = Math.round((s.cost + amt) * 100) / 100;
              s.manualLabour = Math.round(((s.manualLabour || 0) + amt) * 100) / 100;
              addDay(s.labD, r.date, amt);
              const who = canonEng(r.username || "(manual)");
              const eng = engFor(s, who);
              eng.cost = Math.round(((eng.cost || 0) + amt) * 100) / 100;
              const mins = r.hours ? Math.round(Number(r.hours) * 60) : 0;
              if (mins) { s.onsiteMins += mins; eng.mins += mins; if (!eng.days) eng.days = new Set(); eng.days.add(r.date); }
              addSrc(eng, "sla");
            } else {
              s.poTotal = Math.round((s.poTotal + amt) * 100) / 100;
              s.manualMaterials = Math.round(((s.manualMaterials || 0) + amt) * 100) / 100;
              addDay(s.poD, r.date, amt);
              const supName = (r.supplier || "").trim() || "Manual entry";
              const sup = s.suppliers[supName] || (s.suppliers[supName] = { supplier: supName, total: 0, count: 0, unpriced: 0 });
              sup.count++;
              sup.total = Math.round((sup.total + amt) * 100) / 100;
            }
          }
        }
      }
    } catch {}

    let sites = Object.entries(bySite).map(([key, s]) => {
      const laborCost = s.cost || 0, poTotal = s.poTotal || 0;
      return {
        ...s,
        key,   // stable per-site id the front-end pins/hides/orders against
        project: seededProjects[key] || null,   // { id, number } when this site IS a portal project
        manualLabour: s.manualLabour || 0, manualMaterials: s.manualMaterials || 0,
        totalMins: s.travelMins + s.onsiteMins + s.visitMins,
        laborCost, poTotal, poUnpriced: s.poUnpriced || 0,
        grandTotal: Math.round((laborCost + poTotal) * 100) / 100,
        fin: computeFin(projFin[key], Math.round((laborCost + poTotal) * 100) / 100, mergeDayMaps(s.labD, s.poD)),
        jobs: Object.entries(s.jobs).map(([ref, mins]) => ({ ref, mins })).sort((a, b) => b.mins - a.mins),
        engineers: Object.entries(s.engineers).map(([u, v]) => ({
          user: u, mins: v.mins || 0, cost: v.cost, poCost: v.poCost || 0, src: v.src || null,
          visits: (v.visits || 0) + (v.days ? v.days.size : 0),   // on-site visits/days
          pos: (v.pos || []).sort((a, b) => (b.cost || 0) - (a.cost || 0))
        })).sort((a, b) => ((b.cost || 0) + (b.poCost || 0)) - ((a.cost || 0) + (a.poCost || 0)) || b.mins - a.mins),
        // Per-site trend (labour + materials over its own active span) + supplier spend.
        series: buildSiteSeries(s.labD, s.poD),
        suppliers: Object.values(s.suppliers)
          .sort((a, b) => (b.total - a.total) || (b.count - a.count))
      };
    }).sort((a, b) => (b.grandTotal - a.grandTotal) || (b.totalMins - a.totalMins));
    const only = normName(q.get("site") || "");
    if (only) sites = sites.filter(s => normName(s.site) === only);
    // sitelog: true = SiteLog costing folded in; false = SiteLog unreachable or
    // SITELOG_ADMIN_SECRET unset, so labour is SLA-only (front-end shows a note).
    return json({ ok: true, from, to, sites, sitelog: slSites != null, sitelogReason: slSites != null ? "" : _slDiag }, {}, env, request);
  }

  if (path === "/exceptions" && method === "GET") {
    if (!admin) return error("Forbidden", 403, env, request);
    const { from, to } = rangeOf(q);
    const reg = await loadRegister(env, tid);
    const days = await reconcileRange(env, tid, from, to, reg);
    const ex = [];

    for (const d of days) {
      for (const e of d.entries) {
        if (e.flags.includes("auto-closed"))
          ex.push({ date: d.date, user: d.user, type: "auto-closed", site: e.site,
            detail: `${e.jobRef || e.site || "segment"} was never finished — closed automatically (${fmtMins(e.mins)} recorded)` });
        if (e.flags.includes("mismatch"))
          ex.push({ date: d.date, user: d.user, type: "site-mismatch", site: e.site,
            detail: `SiteLog scan at "${e.scanSite}" while working job ${e.jobRef || "?"} at "${e.site}"` });
        if (e.resolved && e.resolved.archived)
          ex.push({ date: d.date, user: d.user, type: "archived-site", site: e.resolved.name,
            detail: `${fmtMins(e.mins)} recorded against ARCHIVED site "${e.resolved.name}"${e.jobRef ? " (job " + e.jobRef + ")" : ""}` });
        if (!e.resolved && e.site)
          ex.push({ date: d.date, user: d.user, type: "unmatched-site", site: e.site,
            detail: `"${e.site}" isn't in the site register (${fmtMins(e.mins)}) — add or merge it` });
      }
      if (d.unallocMins > UNALLOC_MIN)
        ex.push({ date: d.date, user: d.user, type: "unallocated",
          detail: `${fmtMins(d.unallocMins)} of the working day not covered by any job, scan or overhead` });
    }

    // POs raised against an archived or unregistered site — so PO spend can't
    // land on a dead/unknown site undetected.
    for (const p of await poRows(env, from, to)) {
      const resolved = resolveSite(reg, p.site);
      const money = p.cost_ex_vat != null && p.cost_ex_vat !== "" ? "£" + Number(p.cost_ex_vat).toFixed(2) : "unpriced";
      if (resolved && resolved.archived)
        ex.push({ date: p.d || to, user: p.engineer_name || "", type: "archived-site", site: resolved.name,
          detail: `PO (${money}, ${p.supplier || "supplier"}) raised against ARCHIVED site "${resolved.name}"` });
      else if (!resolved && p.site)
        ex.push({ date: p.d || to, user: p.engineer_name || "", type: "unmatched-site", site: p.site,
          detail: `PO (${money}, ${p.supplier || "supplier"}) on "${p.site}" — not in the site register; add or merge it` });
    }

    // SiteLog labour landing on a site the register doesn't know (so it can't be
    // costed against the right project) or on an archived one.
    const slSites = await fetchSitelogCosting(env, from, to);
    for (const slSite of (slSites || [])) {
      const resolved = resolveSiteCode(reg, slSite.siteCode);
      const hrs = (slSite.workH || 0) + (slSite.travelH || 0);
      if (resolved && resolved.archived)
        ex.push({ date: to, user: "", type: "archived-site", site: resolved.name,
          detail: `SiteLog labour (${hrs.toFixed(1)}h) recorded against ARCHIVED site "${resolved.name}"` });
      else if (!resolved && slSite.siteCode)
        ex.push({ date: to, user: "", type: "unmatched-site", site: String(slSite.siteCode),
          detail: `SiteLog labour (${hrs.toFixed(1)}h) at store "${slSite.siteCode}" — not matched to the site register; add or merge it` });
    }

    // Claimed (timesheet span) vs captured (ledger) per user-day
    try {
      const capByKey = {};
      for (const d of days) capByKey[d.user + "|" + d.date] = d.entries.reduce((a, e) => a + e.mins, 0);
      const { results } = await env.DB.prepare(
        "SELECT username, week, data FROM eng_timesheets WHERE tenant_id=? AND week>=? AND week<=?")
        .bind(tid, mondayOf(from), to).all();
      for (const r of results || []) {
        let daysObj = {}; try { daysObj = (JSON.parse(r.data || "{}").days) || {}; } catch {}
        for (const [date, d] of Object.entries(daysObj)) {
          if (date < from || date > to || !d || !d.start || !d.finish) continue;
          const span = spanMins(d.start, d.finish);
          if (span == null) continue;
          const captured = capByKey[r.username + "|" + date] || 0;
          const diff = span - captured;
          if (Math.abs(diff) > CLAIM_GAP_MIN && captured > 0)
            ex.push({ date, user: r.username, type: diff > 0 ? "claimed-over-captured" : "captured-over-claimed",
              detail: `Timesheet says ${fmtMins(span)}, system captured ${fmtMins(captured)} (${diff > 0 ? "+" : ""}${fmtMins(Math.abs(diff))} difference)` });
        }
      }
    } catch {}

    ex.sort((a, b) => b.date.localeCompare(a.date) || a.user.localeCompare(b.user));
    return json({ ok: true, from, to, exceptions: ex.slice(0, 500) }, {}, env, request);
  }

  return error("Unknown costing route", 404, env, request);
}

/* ══ SiteLog scan intake ═════════════════════════════════════════════════════
   POST /ledger/scan  { username, site, direction: "in"|"out", at? }
   Header x-portal-sig = base64url(HMAC-SHA256(rawBody, PORTAL_BRIDGE_SECRET)).
   Called by the SiteLog worker once its patcher lands; sig means no session. */
async function scanIntake(request, env) {
  try {
    const raw = await request.text();
    const sig = request.headers.get("x-portal-sig") || "";
    if (!env.PORTAL_BRIDGE_SECRET) return new Response(JSON.stringify({ ok: false, error: "bridge secret unset" }), { status: 500, headers: { "Content-Type": "application/json" } });
    const want = await hmacB64u(env.PORTAL_BRIDGE_SECRET, raw);
    if (!timingSafeEq(sig, want)) return new Response(JSON.stringify({ ok: false, error: "bad signature" }), { status: 403, headers: { "Content-Type": "application/json" } });
    const b = JSON.parse(raw || "{}");
    const username = String(b.username || "").trim();
    const site = String(b.site || b.siteName || "").trim();
    const dir = b.direction === "out" ? "out" : "in";
    if (!username || !site) return new Response(JSON.stringify({ ok: false, error: "username and site required" }), { status: 400, headers: { "Content-Type": "application/json" } });
    await ensure(env);
    await env.DB.prepare(
      "INSERT INTO sitelog_scans (tenant_id, username, site, direction, at, source) VALUES (?,?,?,?,?,?)")
      .bind(Number(b.tenantId) || 1, username, site, dir,
            b.at ? new Date(b.at).toISOString() : new Date().toISOString(), "sitelog").run();
    return new Response(JSON.stringify({ ok: true }), { status: 201, headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}

/* ══ Reconciliation core ════════════════════════════════════════════════════ */

// One user-day: job segments are primary; scan intervals contribute only the
// time no job segment covers (clipped — never double-counted); the shift
// window gives the unallocated remainder.
async function buildDay(env, tid, user, date, reg) {
  const entries = [];
  const dayStart = Date.parse(date + "T00:00:00Z") - 2 * 3600e3;   // London slack
  const dayEnd = dayStart + 30 * 3600e3;

  // Job segments
  const segs = [];
  try {
    const { results } = await env.DB.prepare(
      "SELECT * FROM job_time_segments WHERE tenant_id=? AND username=? AND started_at>=? AND started_at<? ORDER BY started_at")
      .bind(tid, user, new Date(dayStart).toISOString(), new Date(dayEnd).toISOString()).all();
    for (const s of results || []) if (londonDate(s.started_at) === date) segs.push(s);
  } catch {}

  const nowIso = new Date().toISOString();
  const today = londonDate(nowIso);
  for (const s of segs) {
    let end = s.ended_at, flags = [];
    if (s.auto_closed) flags.push("auto-closed");
    if (!end) {
      if (date < today) { end = lazyCloseAt(s.started_at, date); flags.push("auto-closed"); }
      else { end = nowIso; flags.push("open"); }
    }
    // Guard a forgotten status change: a real session can't run for days. If a
    // segment — even one "closed" only when the next job was tapped much later —
    // spans more than a long shift, clamp it to a forgot-to-finish close on its
    // start day and flag it. Without this, one stale "In Progress" job inflates
    // costing by thousands (e.g. an 11-day Verwood session = 262h ≈ £5k).
    if (Date.parse(end) - Date.parse(s.started_at) > MAX_SEG_MS) {
      end = lazyCloseAt(s.started_at, date);
      if (!flags.includes("auto-closed")) flags.push("auto-closed");
    }
    const mins = Math.max(0, Math.round((Date.parse(end) - Date.parse(s.started_at)) / 60000));
    if (!mins) continue;
    entries.push({
      user, src: "job", kind: s.kind === "travel" ? "travel" : "onsite",
      site: s.site || "", jobRef: s.job_ref || s.job_id, start: s.started_at, end,
      mins, flags, resolved: resolveSite(reg, s.site)
    });
  }

  // SiteLog scans → visit intervals, clipped to time not already covered.
  // Primary source is the local `sitelog_scans` mirror (fed by the HMAC bridge
  // from the old standalone SiteLog worker). When the mirror is empty for the
  // day but SITELOG_DB is bound (in-process SiteLog), fall back to live
  // visits from that DB — so exceptions/mismatch still work even if the
  // bridge is dark, keeping /costing/summary £ figures and this day view in step.
  try {
    const { results } = await env.DB.prepare(
      "SELECT * FROM sitelog_scans WHERE tenant_id=? AND username=? AND at>=? AND at<? ORDER BY at")
      .bind(tid, user, new Date(dayStart).toISOString(), new Date(dayEnd).toISOString()).all();
    let scans = (results || []).filter(s => londonDate(s.at) === date);
    if (!scans.length && env.SITELOG_DB) {
      const from = new Date(dayStart).toISOString().slice(0, 10);
      const to = new Date(dayEnd).toISOString().slice(0, 10);
      try {
        const visits = await fetchSitelogVisits(env, from, to);
        const nameLike = jcNameLike;
        // Turn visits (check_in_at/check_out_at) into scan-in/scan-out rows so
        // the reconstruction below is unchanged.
        for (const v of (visits || [])) {
          const who = String(v.portal_username || "").trim() || nameLike(v);
          if (String(who).toLowerCase() !== String(user).toLowerCase()) continue;
          if (v.check_in_at && londonDate(v.check_in_at) === date) {
            scans.push({ at: v.check_in_at, direction: "in", site: v.site_code || v.site_name || "" });
          }
          if (v.check_out_at && londonDate(v.check_out_at) === date) {
            scans.push({ at: v.check_out_at, direction: "out", site: v.site_code || v.site_name || "" });
          }
        }
        scans.sort((a, b) => String(a.at).localeCompare(String(b.at)));
      } catch {}
    }
    const open = {};   // site -> inAt
    const visits = [];
    for (const s of scans) {
      const k = normName(s.site);
      if (s.direction === "in") { if (!open[k]) open[k] = { at: s.at, site: s.site }; }
      else if (open[k]) { visits.push({ site: open[k].site, start: open[k].at, end: s.at, flags: [] }); delete open[k]; }
    }
    for (const k of Object.keys(open)) {   // scanned in, never out
      const v = open[k];
      visits.push({ site: v.site, start: v.at, end: lazyCloseAt(v.at, date), flags: ["auto-closed"] });
    }
    const jobIv = entries.map(e => [Date.parse(e.start), Date.parse(e.end), e]);
    for (const v of visits) {
      let ivs = [[Date.parse(v.start), Date.parse(v.end)]];
      const vNorm = normName(v.site);
      for (const [js, je, e] of jobIv) {
        const next = [];
        for (const [vs, ve] of ivs) {
          if (je <= vs || js >= ve) { next.push([vs, ve]); continue; }
          // overlap — mismatch when the concurrent job is at a DIFFERENT site
          if (normName(e.site) !== vNorm && !e.flags.includes("mismatch")) {
            e.flags.push("mismatch"); e.scanSite = v.site;
          }
          if (vs < js) next.push([vs, js]);
          if (ve > je) next.push([je, ve]);
        }
        ivs = next;
      }
      for (const [vs, ve] of ivs) {
        const mins = Math.round((ve - vs) / 60000);
        if (mins < 3) continue;
        entries.push({ user, src: "sitelog", kind: "onsite", site: v.site, jobRef: "",
          start: new Date(vs).toISOString(), end: new Date(ve).toISOString(),
          mins, flags: v.flags.slice(), resolved: resolveSite(reg, v.site) });
      }
    }
  } catch {}

  // Day window → unallocated remainder
  let shift = null, unallocMins = 0;
  try {
    shift = await env.DB.prepare("SELECT * FROM shifts WHERE tenant_id=? AND username=? AND date=?")
      .bind(tid, user, date).first();
  } catch {}
  if (shift && shift.clock_on_at) {
    const on = Date.parse(shift.clock_on_at);
    const off = shift.clock_off_at ? Date.parse(shift.clock_off_at) : (date < today ? Date.parse(lazyCloseAt(shift.clock_on_at, date)) : Date.now());
    let covered = mergeIntervals(entries.map(e => [Math.max(on, Date.parse(e.start)), Math.min(off, Date.parse(e.end))]).filter(([a, b]) => b > a));
    const total = Math.max(0, off - on);
    const cov = covered.reduce((a, [s, e]) => a + (e - s), 0);
    unallocMins = Math.max(0, Math.round((total - cov) / 60000));
  }

  entries.sort((a, b) => a.start.localeCompare(b.start));
  return { user, date, entries, unallocMins,
    shift: shift ? { on: shift.clock_on_at || "", off: shift.clock_off_at || "" } : null,
    totals: {
      travelMins: entries.filter(e => e.kind === "travel").reduce((a, e) => a + e.mins, 0),
      onsiteMins: entries.filter(e => e.kind !== "travel" && e.src === "job").reduce((a, e) => a + e.mins, 0),
      visitMins: entries.filter(e => e.src === "sitelog").reduce((a, e) => a + e.mins, 0),
      unallocMins
    } };
}

// Every user-day in a range that has ANY activity (segments, scans or a shift).
async function reconcileRange(env, tid, from, to, reg) {
  const users = new Set();
  const dates = {};   // user -> Set of dates
  const seen = (u, d) => { users.add(u); (dates[u] = dates[u] || new Set()).add(d); };
  const lo = from + "T00:00:00Z", hi = to + "T23:59:59Z";
  try {
    const { results } = await env.DB.prepare(
      "SELECT username, started_at FROM job_time_segments WHERE tenant_id=? AND started_at>=? AND started_at<=?")
      .bind(tid, lo, hi).all();
    for (const r of results || []) { const d = londonDate(r.started_at); if (d >= from && d <= to) seen(r.username, d); }
  } catch {}
  try {
    const { results } = await env.DB.prepare(
      "SELECT username, at FROM sitelog_scans WHERE tenant_id=? AND at>=? AND at<=?").bind(tid, lo, hi).all();
    for (const r of results || []) { const d = londonDate(r.at); if (d >= from && d <= to) seen(r.username, d); }
  } catch {}
  try {
    const { results } = await env.DB.prepare(
      "SELECT username, date FROM shifts WHERE tenant_id=? AND date>=? AND date<=?").bind(tid, from, to).all();
    for (const r of results || []) seen(r.username, r.date);
  } catch {}
  const out = [];
  for (const u of users) for (const d of dates[u]) out.push(await buildDay(env, tid, u, d, reg));
  return out;
}

/* ══ Register loading + resolution ══════════════════════════════════════════ */

export async function loadRegister(env, tid) {
  const list = [];
  const byNorm = {};
  try {
    const { results } = await env.DB.prepare(
      "SELECT client, site_number, site_name, postcode, active, archived, job_number, data FROM sites WHERE tenant_id=? ORDER BY site_name COLLATE NOCASE")
      .bind(tid).all();
    for (const r of results || []) {
      let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {}
      const lat = Number(d.lat), lng = Number(d.lng ?? d.lon);
      const entry = { client: r.client, siteNumber: r.site_number,
        name: r.site_name || ("Site " + r.site_number), postcode: (r.postcode || "").replace(/\*+$/, ""),
        active: r.active !== 0, archived: !!r.archived, jobNumber: r.job_number || "",
        lat: Number.isFinite(lat) ? lat : null, lng: Number.isFinite(lng) ? lng : null,
        norm: normName(r.site_name || r.site_number) };
      list.push(entry);
      if (entry.norm && !byNorm[entry.norm]) byNorm[entry.norm] = entry;
    }
  } catch {}
  const aliases = await cfgGet(env, tid, "site_aliases", {});
  for (const [norm, tgt] of Object.entries(aliases)) {
    const target = list.find(s => s.client === tgt.client && s.siteNumber === tgt.siteNumber);
    if (target && !byNorm[norm]) byNorm[norm] = target;
  }
  // byCode: SiteLog scans/costing key sites by a numeric store code
  // (digitsOf(name), same convention the portal uses when it pushes geofences).
  // Map those back to a register entry so SiteLog labour lands on the right site.
  const byCode = {};
  for (const e of list) {
    for (const code of [String(e.siteNumber || ""), digitsOf(e.name), digitsOf(e.siteNumber)]) {
      if (code && !byCode[code]) byCode[code] = e;
    }
  }
  const ignored = await cfgGet(env, tid, "site_reg_ignore", {});
  return { list, byNorm, byCode, aliases, ignored };
}

export function resolveSite(reg, name) {
  const k = normName(name);
  return (k && reg.byNorm[k]) || null;
}
// Resolve a SiteLog site_code (numeric store code, or a name) to a register
// entry: by code first, then by name/alias (so a code OR a name both land).
function resolveSiteCode(reg, code) {
  const c = String(code || "").trim();
  if (!c) return null;
  const d = digitsOf(c);
  return (d && reg.byCode && reg.byCode[d]) || (reg.byCode && reg.byCode[c]) || resolveSite(reg, c) || null;
}
function digitsOf(s) { return String(s || "").replace(/\D+/g, ""); }

// Parse a lat/lng pair; returns {lat,lng} only when both are valid UK-ish coords.
function parseLatLngPair(latIn, lngIn) {
  const lat = Number(latIn), lng = Number(lngIn);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

// Push a portal site to SiteLog as a geofence (same shape as sites.js), so a
// site added/located in the portal is recognised on-site by the scanner.
// Custom domain is fetchable server-side; best-effort, never blocks the save.
async function pushSiteToSiteLog(env, name, lat, lng, client) {
  try {
    if (!env.SITELOG_ADMIN_SECRET || !String(name || "").trim()) return false;
    const target = (env.SITELOG_API || "https://api.site-log.co.uk") + "/bulk-add-sites";
    const category = String(client || "").replace(/[-_]+/g, " ").replace(/\b\w/g, c => c.toUpperCase()).trim() || "Projects";
    const init = {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-secret": env.SITELOG_ADMIN_SECRET },
      body: JSON.stringify({ sites: [{ siteName: String(name).trim(), lat, lng, radius: 500, category }] })
    };
    let res;
    if (env.SITELOG_DB) {
      try { res = await sitelogApi.handle(new Request(target, init), env); } catch (e) { res = null; }
      if (!res || !res.ok) res = await fetch(target, init);   // safety net during rollout
    } else {
      res = await fetch(target, init);
    }
    return res.ok;
  } catch { return false; }
}

// Pull SiteLog's own job-costing (per-site → per-person labour, computed with
// SiteLog's rates). Custom domain, so server-side fetch works (mostlane-api is
// on *.workers.dev and CANNOT be fetched back — the flow is always portal→
// SiteLog). Fails soft to null so costing degrades to SLA-only when SiteLog is
// unreachable or SITELOG_ADMIN_SECRET isn't set. Sets _slDiag with WHY it failed
// (surfaced by /costing/summary as `sitelogReason`) so a persistent failure is
// diagnosable — e.g. "secret-unset" after a worker reset vs a genuine timeout.
let _slDiag = "";
// A fetch that can't hang forever — a slow SiteLog would otherwise stall the whole
// costing request and show the "unreachable" banner. 8s cap, retried once.
async function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}
async function fetchSitelogCosting(env, from, to) {
  _slDiag = "";
  const secret = env.SITELOG_ADMIN_SECRET;
  if (!secret) { _slDiag = "secret-unset"; return null; }
  const pathQuery = "/job-costing?from=" + encodeURIComponent(from) + "&to=" + encodeURIComponent(to);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await sitelogAdminFetch(env, pathQuery, 8000);
      if (!res.ok) { _slDiag = "http-" + res.status; continue; }   // transient 5xx → retry once
      const j = await res.json();
      if (j && j.ok && Array.isArray(j.sites)) { _slDiag = ""; return j.sites; }
      _slDiag = "bad-response"; return null;
    } catch (e) { _slDiag = (e && e.name === "AbortError") ? "timeout" : "unreachable"; }
  }
  return null;
}

// Raw SiteLog visits (for the reconcile + the labour trend — needs check-in/out
// dates, not just aggregates). Pages back by check_in_at so a wide range isn't
// capped at /admin's 500. Same portal→SiteLog custom-domain fetch; soft-null.
async function fetchSitelogVisits(env, from, to) {
  const secret = env.SITELOG_ADMIN_SECRET;
  if (!secret) return null;
  const seen = new Set();
  const out = [];
  let before = null, got = false;
  try {
    for (let page = 0; page < 30; page++) {   // ≤15k visits
      let pq = "/admin?from=" + encodeURIComponent(from) + "&to=" + encodeURIComponent(to);
      if (before) pq += "&before=" + encodeURIComponent(before);
      const res = await sitelogAdminFetch(env, pq, 8000);
      if (!res.ok) return got ? out : null;
      const j = await res.json();
      const rows = Array.isArray(j.visits) ? j.visits : [];
      got = true;
      if (!rows.length) break;
      let added = 0, oldest = null;
      for (const r of rows) {
        const id = r.visit_id != null ? r.visit_id : (r.person_id + "|" + r.check_in_at);
        if (!seen.has(id)) { seen.add(id); out.push(r); added++; }
        if (oldest == null || (r.check_in_at && r.check_in_at < oldest)) oldest = r.check_in_at;
      }
      if (rows.length < 500 || !oldest || added === 0) break;
      before = oldest;
    }
    return out;
  } catch { return got ? out : null; }
}
function jcNameLike(v) { return ((v.first_name || "") + " " + (v.last_name || "")).trim() || "(unknown)"; }

// Project financials for one site: contract value, valuations submitted, and
// how the job is looking + a suggested next valuation. Returns null when the
// project hasn't been set up (so only real projects show it). `cost` is the
// job's grand total (labour + PO) so far.
function mergeDayMaps(a, b) {
  const out = {};
  for (const [d, v] of Object.entries(a || {})) out[d] = (out[d] || 0) + v;
  for (const [d, v] of Object.entries(b || {})) out[d] = (out[d] || 0) + v;
  return out;
}
function computeFin(f, cost, costByDay) {
  if (!f || (!(Number(f.value) > 0) && !(f.valuations && f.valuations.length) && !(Number(f.planned) > 0))) return null;
  const r = (x) => Math.round((Number(x) || 0) * 100) / 100;
  const value = r(f.value);
  const planned = Math.max(0, Math.round(Number(f.planned) || 0));
  const valuations = (Array.isArray(f.valuations) ? f.valuations : [])
    .map((v) => ({ id: v.id || "", amount: r(v.amount), date: v.date || "", note: v.note || "", final: !!v.final }))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  // Split each valuation into cost-covered vs profit "at the time": the cost
  // dated up to that valuation, minus the cost already covered by earlier ones.
  const costDays = Object.keys(costByDay || {}).sort();
  const cumCostUpTo = (date) => { let c = 0; for (const d of costDays) { if (d <= date) c += costByDay[d]; else break; } return c; };
  let prevCumCost = 0, runVal = 0;
  for (const v of valuations) {
    runVal += v.amount;
    const cumCost = cumCostUpTo(v.date);
    const costPortion = Math.max(0, r(cumCost - prevCumCost));   // cost incurred in this valuation's window
    v.costAtTime = costPortion;
    v.profitAtTime = r(v.amount - costPortion);                  // profit taken in this valuation (− if it didn't cover cost)
    v.profitToDate = r(runVal - cumCost);                        // running profit after this valuation
    prevCumCost = cumCost;
  }
  // Cost incurred AFTER the last valuation — not yet claimed. This is why the
  // last valuation's "running profit" won't match the current position.
  const costSinceLastVal = valuations.length ? Math.max(0, r(cost - prevCumCost)) : r(cost);
  const valued = r(valuations.reduce((a, v) => a + v.amount, 0));
  const remainingValue = r(value - valued);
  const remainingVals = Math.max(0, planned - valuations.length);
  const position = r(valued - cost);                       // profit so far (+ = value earned ahead of cost)
  const marginPct = value > 0 ? r((value - cost) / value * 100) : null;   // projected margin on full value
  const breakEven = Math.max(0, r(cost - valued));         // next valuation to be ≥ cost (stay positive)
  const evenShare = remainingVals > 0 ? r(remainingValue / remainingVals) : Math.max(0, remainingValue);
  // Suggest: at least break even, at least your even share, never more than what's left to claim.
  let suggestedNext = Math.max(breakEven, evenShare);
  suggestedNext = r(Math.max(0, Math.min(suggestedNext, Math.max(0, remainingValue))));

  // ── Retention ──────────────────────────────────────────────────────────
  // Every interim valuation retains 5% of the cumulative value. At the final
  // account all 5% held to date is released and a new retention of 2.5% of the
  // project value is held instead (the other half, released after defects).
  const RET = 0.05, FINAL_RET = 0.025;
  const retBase = value > 0 ? value : valued;
  const isFinal = valuations.some((v) => v.final);
  const retentionRate = isFinal ? FINAL_RET : RET;
  const retentionHeld = r(retentionRate * (isFinal ? retBase : valued));
  const cashReceived = r(valued - retentionHeld);          // cash in after retention
  const nextIsFinal = !isFinal && remainingValue > 0.005 && remainingVals <= 1;   // last valuation = final account
  const retentionIfFinal = r(FINAL_RET * retBase);         // what would be held after the final account
  const retentionCurrent = r(RET * valued);                // interim retention held right now

  return {
    value, planned, valuations, valued, cost: r(cost), position, marginPct,
    remainingValue, remainingVals, breakEven: r(breakEven), evenShare: r(evenShare),
    suggestedNext, overCommitted: breakEven > remainingValue + 0.005,
    positionAfterSuggested: r(valued + suggestedNext - cost),
    retentionRate: retentionRate * 100, retentionHeld, cashReceived, isFinal,
    nextIsFinal, retentionIfFinal, retentionCurrent, costSinceLastVal,
  };
}

// Build a site's trend from its day-level labour/PO maps: span only the site's
// ACTIVE dates (first→last with any spend) and pick the granularity from that
// span (day ≤45d, week ≤~6mo, else month), so the line is spread across when
// work/POs actually happened — never one spike on a year-long empty axis.
function buildSiteSeries(labD, poD) {
  const days = Object.keys(labD).concat(Object.keys(poD)).filter(Boolean).sort();
  if (!days.length) return [];
  const min = days[0], max = days[days.length - 1];
  const span = Math.max(1, Math.round((Date.parse(max + "T12:00:00Z") - Date.parse(min + "T12:00:00Z")) / 864e5) + 1);
  const mode = span <= 45 ? "day" : span <= 186 ? "week" : "month";
  const bk = (d) => mode === "day" ? d : mode === "week" ? mondayOf(d) : d.slice(0, 7);
  const labB = {}, poB = {};
  const roll = (src, dst) => { for (const [d, v] of Object.entries(src)) { const k = bk(d); dst[k] = Math.round(((dst[k] || 0) + v) * 100) / 100; } };
  roll(labD, labB); roll(poD, poB);
  return buildSeriesBuckets(min, max, mode, labB, poB);
}
// Turn the per-bucket labour/PO maps into an ordered, zero-filled series across
// the given from→to so the front-end line chart has no gaps.
function buildSeriesBuckets(from, to, mode, labourByB, poByB) {
  const keys = [];
  if (mode === "day") {
    let d = new Date(from + "T12:00:00Z"); const end = new Date(to + "T12:00:00Z");
    while (d <= end) { keys.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  } else if (mode === "week") {
    let d = new Date(mondayOf(from) + "T12:00:00Z"); const end = new Date(to + "T12:00:00Z");
    while (d <= end) { keys.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 7); }
  } else {
    let d = new Date(from.slice(0, 7) + "-01T12:00:00Z"); const end = new Date(to.slice(0, 7) + "-01T12:00:00Z");
    while (d <= end) { keys.push(d.toISOString().slice(0, 7)); d.setUTCMonth(d.getUTCMonth() + 1); }
  }
  return keys.map(k => {
    const labour = Math.round((labourByB[k] || 0) * 100) / 100;
    const po = Math.round((poByB[k] || 0) * 100) / 100;
    return { label: k, mode, labour, po, total: Math.round((labour + po) * 100) / 100 };
  });
}

/* ══ P4: SiteLog → SLA session reconcile ════════════════════════════════════
   mostlane-api can't be called from SiteLog (1042), so instead of SiteLog
   pushing "scan-out" events, the portal PULLS recent visits and reconciles:
   for each LINKED employee's completed visit, (a) close any SLA job-status
   session still open at scan-out — "the scan ends the session"; (b) if no SLA
   segment already covers that visit, materialise one from the scan so the
   engineer's timesheet autofill + job costing see it. Idempotent (segments
   carry the SiteLog visit id); subcontractors are skipped (no portal
   timesheet — job costing already reads their cost from SiteLog directly).
   Runs on the hourly cron over a rolling window; safe to run repeatedly. */
export async function reconcileSitelogSessions(env, tid, opts) {
  const o = opts || {};
  if (!env.SITELOG_ADMIN_SECRET) return { ok: false, reason: "SITELOG_ADMIN_SECRET unset" };
  await ensure(env);
  const now = o.now ? new Date(o.now) : new Date();
  const to = londonDate(now.toISOString());
  const fromD = new Date(now.getTime() - (o.days || 4) * 864e5);
  const from = londonDate(fromD.toISOString());
  const visits = await fetchSitelogVisits(env, from, to);
  if (!visits) return { ok: false, reason: "SiteLog unreachable" };
  const reg = await loadRegister(env, tid);
  let closed = 0, created = 0, skipped = 0;
  for (const v of visits) {
    const user = String(v.portal_username || "").trim();
    if (!user) { skipped++; continue; }               // subcontractor → costing only
    if (!v.check_in_at || !v.check_out_at) { skipped++; continue; }   // open visit → leave it
    const inMs = Date.parse(v.check_in_at), outMs = Date.parse(v.check_out_at);
    if (!(outMs > inMs)) { skipped++; continue; }
    const resolved = resolveSiteCode(reg, v.site_code);
    const siteName = resolved ? resolved.name : (v.provided_site_name || String(v.site_code || "").trim());
    const dayKey = londonDate(v.check_out_at);
    const dayStartMs = Date.parse(dayKey + "T00:00:00Z") - 2 * 3600e3;

    // (a) Close SLA sessions left open at scan-out that day (the scan ends them).
    try {
      const { results } = await env.DB.prepare(
        "SELECT id, started_at FROM job_time_segments WHERE tenant_id=? AND username=? AND ended_at IS NULL")
        .bind(tid, user).all();
      for (const seg of results || []) {
        const sMs = Date.parse(seg.started_at);
        if (sMs <= outMs && sMs >= dayStartMs) {
          await env.DB.prepare(
            "UPDATE job_time_segments SET ended_at=?, auto_closed=1 WHERE id=? AND tenant_id=?")
            .bind(new Date(outMs).toISOString(), seg.id, tid).run();
          closed++;
        }
      }
    } catch {}

    // (b) Materialise a segment from the scan — unless we already did (idempotent
    // by sitelog_visit_id) or an SLA segment already overlaps this visit.
    const vid = "sl:" + (v.visit_id != null ? v.visit_id : (user + "|" + v.check_in_at));
    let exists = false, overlaps = false;
    try {
      const dup = await env.DB.prepare(
        "SELECT 1 FROM job_time_segments WHERE tenant_id=? AND sitelog_visit_id=? LIMIT 1").bind(tid, vid).first();
      exists = !!dup;
    } catch {}
    if (!exists) {
      try {
        const { results } = await env.DB.prepare(
          "SELECT started_at, ended_at FROM job_time_segments WHERE tenant_id=? AND username=? AND started_at>=? AND started_at<=? AND sitelog_visit_id IS NULL")
          .bind(tid, user, new Date(dayStartMs).toISOString(), new Date(outMs + 3600e3).toISOString()).all();
        for (const seg of results || []) {
          const sMs = Date.parse(seg.started_at), eMs = seg.ended_at ? Date.parse(seg.ended_at) : outMs;
          if (eMs > inMs && sMs < outMs) { overlaps = true; break; }   // SLA already covers it
        }
      } catch {}
      if (!overlaps) {
        try {
          await env.DB.prepare(
            "INSERT INTO job_time_segments (tenant_id, username, job_id, job_ref, site, postcode, started_at, ended_at, kind, sitelog_visit_id) VALUES (?,?,?,?,?,?,?,?,?,?)")
            .bind(tid, user, vid, "", siteName, resolved ? resolved.postcode : "",
              new Date(inMs).toISOString(), new Date(outMs).toISOString(), "onsite", vid).run();
          created++;
        } catch {}
      } else { skipped++; }
    }
  }
  return { ok: true, from, to, closed, created, skipped, visits: visits.length };
}

// PO spend from the PO system's own D1 (PO_DB binding). Fails soft to [] when
// the binding is absent or the schema differs. cost_ex_vat is the job-costing
// figure (VAT is reclaimed); NULL = raised-but-not-priced-yet.
async function poRows(env, from, to) {
  if (!env.PO_DB) return [];
  // Only columns guaranteed to exist on po_log — the site rollup never needs
  // job_id/job_ref, and referencing a not-yet-added column throws the WHOLE query
  // (SQLite has no partial resolve), which would silently zero all PO spend.
  try {
    const { results } = await env.PO_DB.prepare(
      "SELECT engineer_name, site, supplier, cost_ex_vat, incident_no, cost_category, trade, substr(issued_at,1,10) AS d " +
      "FROM po_log WHERE (deleted IS NULL OR deleted=0) AND substr(issued_at,1,10) BETWEEN ? AND ?"
    ).bind(from, to).all();
    return results || [];
  } catch { return []; }
}

// Every PO raised against a specific job (all dates), for per-job materials cost.
// job_id is the stable key the PO worker stamps from the job's "Raise PO" link.
async function jobPoRows(env, jobId) {
  if (!env.PO_DB || !jobId) return [];
  try {
    const { results } = await env.PO_DB.prepare(
      "SELECT po_number, engineer_name, supplier, site, cost_ex_vat, cost_category, trade, incident_no, job_ref, " +
      "substr(COALESCE(issued_at,cost_entered_at),1,10) AS d " +
      "FROM po_log WHERE (deleted IS NULL OR deleted=0) AND job_id=? ORDER BY issued_at"
    ).bind(String(jobId)).all();
    return results || [];
  } catch { return []; }
}

/* ══ Rates (mirrors timesheets.js effectiveCfg, read-only subset) ═══════════ */

export async function ratesMap(env, tid) {
  const out = {};
  let cfg = { byUser: {} };
  try {
    const row = await env.DB.prepare("SELECT value FROM app_config WHERE key=?").bind(`engts:cfg:${tid}`).first();
    if (row && row.value) cfg = Object.assign(cfg, JSON.parse(row.value));
  } catch {}
  try {
    const { results } = await env.DB.prepare("SELECT username, profile FROM users WHERE tenant_id=?").bind(tid).all();
    const num = v => { const n = parseFloat(v); return isFinite(n) && n > 0 ? n : null; };
    const defs = cfg.defaults || {};
    const defPence = num(defs.pencePerMile);
    for (const u of results || []) {
      let profile = {}; try { profile = u.profile ? JSON.parse(u.profile) : {}; } catch {}
      const mine = (cfg.byUser && cfg.byUser[u.username]) || {};
      const rateType = mine.rateType === "day" ? "day" : "hour";
      const rate = num(mine.rate) ?? (rateType === "day" ? num(profile.dayRate) : num(profile.hourlyRate)) ?? num(profile.hourlyRate);
      // Fuel: portal pence-per-mile (per-user override → default). £/mile for costing.
      const pence = num(mine.pencePerMile) ?? defPence;
      const fuelPerMile = pence != null ? pence / 100 : null;
      out[u.username] = { rate, rateType, fuelPerMile };
    }
  } catch {}
  return out;
}

/* ══ Tables + small helpers ═════════════════════════════════════════════════ */

async function ensure(env) {
  // Register flag on sites (created elsewhere; column added here).
  try { await env.DB.prepare("ALTER TABLE sites ADD COLUMN archived INTEGER DEFAULT 0").run(); } catch {}
  // Segment table may not exist yet on a fresh DB (normally created by
  // timesheets.js) — create-if-missing, then add our columns.
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS job_time_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL DEFAULT 1,
      username TEXT NOT NULL, job_id TEXT NOT NULL, job_ref TEXT, site TEXT, postcode TEXT,
      started_at TEXT NOT NULL, ended_at TEXT)`).run();
  } catch {}
  try { await env.DB.prepare("ALTER TABLE job_time_segments ADD COLUMN kind TEXT").run(); } catch {}
  try { await env.DB.prepare("ALTER TABLE job_time_segments ADD COLUMN auto_closed INTEGER").run(); } catch {}
  // P4: links a segment materialised from a SiteLog visit back to that visit, so
  // the reconcile is idempotent (never creates the same session twice).
  try { await env.DB.prepare("ALTER TABLE job_time_segments ADD COLUMN sitelog_visit_id TEXT").run(); } catch {}
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS sitelog_scans (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL DEFAULT 1,
      username TEXT NOT NULL, site TEXT NOT NULL, direction TEXT NOT NULL,
      at TEXT NOT NULL, source TEXT)`).run();
  } catch {}
}

// Single writer for `proj_fin` — used by both /costing/fin and projects-api.js
// so contract-value edits on either page share one canonical helper. Pass
// value:null (or 0) to clear the row entirely.
export async function writeProjFin(env, tid, costingKey, { value, planned, name } = {}) {
  if (!costingKey) return null;
  const fin = await cfgGet(env, tid, "proj_fin", {}) || {};
  const cur = fin[costingKey] || { value: 0, planned: 0, valuations: [] };
  if (value !== undefined) cur.value = value === null ? 0 : Math.max(0, Number(value) || 0);
  if (planned !== undefined) cur.planned = Math.max(0, Math.round(Number(planned) || 0));
  if (name !== undefined) cur.name = String(name || "").slice(0, 120);
  if (!Array.isArray(cur.valuations)) cur.valuations = [];
  // Empty out: no value + no valuations means the project's fin row is dead.
  if ((!cur.value || cur.value === 0) && !cur.valuations.length && !cur.planned) {
    delete fin[costingKey];
  } else {
    fin[costingKey] = cur;
  }
  await cfgSet(env, tid, "proj_fin", fin);
  return fin[costingKey] || null;
}
// Rename a project's fin row when the project (and its normalised key) changes.
export async function renameProjFinKey(env, tid, oldKey, newKey) {
  if (!oldKey || !newKey || oldKey === newKey) return false;
  const fin = await cfgGet(env, tid, "proj_fin", {}) || {};
  if (!fin[oldKey]) return false;
  fin[newKey] = fin[oldKey]; delete fin[oldKey];
  await cfgSet(env, tid, "proj_fin", fin);
  return true;
}
export async function deleteProjFinKey(env, tid, costingKey) {
  const fin = await cfgGet(env, tid, "proj_fin", {}) || {};
  if (!fin[costingKey]) return false;
  delete fin[costingKey];
  await cfgSet(env, tid, "proj_fin", fin);
  return true;
}

async function cfgGet(env, tid, name, fallback) {
  try {
    const row = await env.DB.prepare("SELECT value FROM app_config WHERE key=?").bind(`${name}:${tid}`).first();
    if (row && row.value) return JSON.parse(row.value);
  } catch {}
  return fallback;
}
async function cfgSet(env, tid, name, value) {
  await env.DB.prepare(
    "INSERT INTO app_config (tenant_id, key, value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(tid, `${name}:${tid}`, JSON.stringify(value)).run();
}

function normName(s) {
  return String(s || "").toLowerCase()
    .replace(/[’'`"]/g, "").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}
function slugNum(name) {
  const s = normName(name).replace(/ /g, "-").slice(0, 40);
  return s || ("site-" + Math.abs(hashCode(String(name))));
}
function hashCode(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } return h; }

function londonDate(iso) {
  try { return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Europe/London" }); }
  catch { return String(iso).slice(0, 10); }
}
// Forgot-to-finish close: 19:00-ish that day, or an hour after it started.
function lazyCloseAt(startedIso, date) {
  const cut = new Date(startedIso); cut.setHours(cut.getHours() + 1);
  const evening = new Date(date + "T18:00:00Z");
  return (cut > evening ? cut : evening).toISOString();
}
function mergeIntervals(ivs) {
  const s = ivs.slice().sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const iv of s) {
    if (out.length && iv[0] <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], iv[1]);
    else out.push(iv.slice());
  }
  return out;
}
function rangeOf(q) {
  const today = londonDate(new Date().toISOString());
  let from = q.get("from") || "", to = q.get("to") || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) to = today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) { const d = new Date(to + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() - 27); from = d.toISOString().slice(0, 10); }
  return { from, to };
}
function mondayOf(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}
function spanMins(start, finish) {
  const m = s => { const x = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim()); return x ? (+x[1]) * 60 + (+x[2]) : null; };
  const a = m(start), b = m(finish);
  if (a == null || b == null) return null;
  return b >= a ? b - a : (b + 1440 - a);
}
function fmtMins(m) { return Math.floor(m / 60) + "h " + (m % 60) + "m"; }

async function hmacB64u(secret, body) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function timingSafeEq(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
