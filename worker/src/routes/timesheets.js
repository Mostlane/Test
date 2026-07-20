// Engineer timesheets (+ self-employed invoicing and mileage) — /ts/*
//
// Engineers enter start/finish times per day and which job(s) they were on.
// Employed staff stop there. Self-employed staff can additionally claim
// mileage (site postcode → estimated road miles) and generate a sequential,
// numbered invoice PDF which is stored in R2 and retrievable by admin.
//
//   Any session (own data):
//     GET  /ts/me                      effective settings for the caller
//     POST /ts/me                      self-service bits: homePostcode, details,
//                                      rate/rateType (admin can override later)
//     GET  /ts/my?week=<Mon>           own week (days + computed pay + invoice)
//     POST /ts/my { week, days }       save own week (blocked once invoiced)
//     GET  /ts/sites?q=                site suggestions (name + postcode)
//     GET  /ts/mileage?from=&to=       postcode → postcode estimated road miles
//     GET  /ts/invoices                own invoices (signed URLs)
//     POST /ts/invoice { week, rate? } generate + store this week's invoice PDF
//     POST /ts/invoice/next { next }   set own next invoice number
//   Admin (FullAccess | TimesheetAdmin):
//     GET  /ts/admin/overview?week=    every user's week, totals, invoice state
//     POST /ts/admin/save              edit a user's week
//     GET  /ts/admin/config            defaults + per-user settings
//     POST /ts/admin/config            save settings
//     GET  /ts/invoices?u=<user|all>   anyone's invoices
//     POST /ts/invoice/delete { id }   remove a wrong invoice (frees its number)
//   Public (signature-verified in-handler — see index.js PUBLIC_ROUTES):
//     GET  /ts/invoice-file?key=&exp=&sig=   stream an invoice PDF
//
// Pay maths per day: span = finish − start (finish ≤ start rolls past midnight),
// minus commuteMins × 2 (if that user has the commute deduction), minus
// lunchMins (if that user has the lunch deduction and span ≥ lunchThresholdH).
// All the switches live in app_config engts:cfg:<tid> — no schema changes.
//
// Mileage estimate: postcodes.io lat/lng (custom domain — worker-fetchable),
// haversine × 1.25 road factor, × 2 for the round trip. Always editable by
// the engineer before saving — it's an estimate, not gospel.

import { json, error, corsHeaders } from "../lib/http.js";
import { permissionsFor } from "../lib/auth.js";
import { signedFileUrl, verifyFileSig } from "../lib/filesign.js";
import { PdfDoc, textWidth } from "../lib/pdf.js";

const CFG_KEY = tid => `engts:cfg:${tid}`;
const INV_PREFIX = tid => `invoices/${tid}/`;

const isDateStr = s => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
function mondayOf(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}
function weekDays(monday) {
  const base = new Date(monday + "T12:00:00Z");
  const out = [];
  for (let i = 0; i < 7; i++) { const x = new Date(base); x.setUTCDate(base.getUTCDate() + i); out.push(x.toISOString().slice(0, 10)); }
  return out;
}
const toMin = t => { const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(t || "").trim()); return m ? (+m[1]) * 60 + (+m[2]) : null; };
const normPc = pc => String(pc || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const round1 = n => Math.round(n * 10) / 10;
const money = n => "£" + (Math.round(n * 100) / 100).toFixed(2);

let TABLES_ENSURED = false;   // once per isolate — the tables persist in D1
async function ensureTables(env) {
  if (TABLES_ENSURED) return;
  TABLES_ENSURED = true;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS eng_timesheets (
    tenant_id INTEGER NOT NULL DEFAULT 1, week TEXT NOT NULL, username TEXT NOT NULL,
    data TEXT, at TEXT, PRIMARY KEY (tenant_id, week, username))`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS eng_invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL DEFAULT 1,
    username TEXT NOT NULL, number INTEGER NOT NULL, week TEXT NOT NULL,
    hours REAL, miles REAL, labour REAL, mileage REAL, total REAL,
    r2_key TEXT, at TEXT,
    UNIQUE (tenant_id, username, number), UNIQUE (tenant_id, username, week))`).run();
  // Known round-trip mileage per site (from the base postcode) — the register
  // the admin edits; engineer mileage rows auto-fill from it.
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS site_miles (
    tenant_id INTEGER NOT NULL DEFAULT 1, key TEXT NOT NULL,
    name TEXT, postcode TEXT, miles REAL, updated_at TEXT,
    PRIMARY KEY (tenant_id, key))`).run();
  // Job-status time capture: Travelling/In Progress opens a segment for the
  // acting engineer, any other status closes it — the timesheet auto-fills
  // from these (see trackJobTime / jobTimeAuto).
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS job_time_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL DEFAULT 1,
    username TEXT NOT NULL, job_id TEXT NOT NULL, job_ref TEXT, site TEXT, postcode TEXT,
    started_at TEXT NOT NULL, ended_at TEXT)`).run();
}

// ── Job-status time capture (called from sla.js on every status change) ─────
// "Travelling"/"In Progress" start the clock on that job for the ACTING
// engineer (closing their clock on any other job); every other status stops
// it. Only counts when the actor is actually assigned to the job, so office
// edits never start anyone's clock. Best-effort: never breaks the job save.
const TS_ACTIVE = new Set(["travelling", "in progress"]);
export async function trackJobTime(env, tid, actor, before, after) {
  try {
    if (!actor || !after) return;
    const bs = String((before && before.status) || "").toLowerCase().trim();
    const as = String((after && after.status) || "").toLowerCase().trim();
    if (bs === as) return;
    const engs = (Array.isArray(after.assignedEngineers) && after.assignedEngineers.length)
      ? after.assignedEngineers : (after.assignedTo ? [after.assignedTo] : []);
    const normId = s => String(s || "").toLowerCase().replace(/\s+/g, ".").trim();
    let mine = engs.some(e => normId(e) === normId(actor));
    if (!mine) {
      try {
        const { results } = await env.DB.prepare("SELECT username, first_name, last_name FROM users WHERE tenant_id=?").bind(tid).all();
        const map = {};
        for (const u of results || []) {
          map[normId(u.username)] = u.username;
          const full = ((u.first_name || "") + " " + (u.last_name || "")).trim();
          if (full) map[normId(full)] = u.username;
        }
        mine = engs.some(e => map[normId(e)] === actor);
      } catch {}
    }
    if (!mine) return;
    await ensureTables(env);
    const now = new Date().toISOString();
    if (TS_ACTIVE.has(as)) {
      // one clock at a time: starting this job ends any other open segment
      await env.DB.prepare(
        "UPDATE job_time_segments SET ended_at=? WHERE tenant_id=? AND username=? AND ended_at IS NULL AND job_id!=?"
      ).bind(now, tid, actor, String(after.id)).run();
      const open = await env.DB.prepare(
        "SELECT id FROM job_time_segments WHERE tenant_id=? AND username=? AND job_id=? AND ended_at IS NULL"
      ).bind(tid, actor, String(after.id)).first();
      if (!open) await env.DB.prepare(
        "INSERT INTO job_time_segments (tenant_id, username, job_id, job_ref, site, postcode, started_at) VALUES (?,?,?,?,?,?,?)"
      ).bind(tid, actor, String(after.id), after.helpdeskRef || String(after.id),
        after.siteName || "", String(after.postcode || "").toUpperCase(), now).run();
    } else {
      await env.DB.prepare(
        "UPDATE job_time_segments SET ended_at=? WHERE tenant_id=? AND username=? AND job_id=? AND ended_at IS NULL"
      ).bind(now, tid, actor, String(after.id)).run();
    }
  } catch { /* time capture must never break a job update */ }
}

// The captured week for one user, folded to per-London-day windows:
// { "YYYY-MM-DD": { start, finish|null, open, jobs:[{ref,site,postcode}] } }.
// A segment left open on an earlier day is lazily closed at 19:00 that day
// (or an hour after it started, if it started later than that).
async function jobTimeAuto(env, tid, username, monday) {
  const endD = new Date(monday + "T12:00:00Z"); endD.setUTCDate(endD.getUTCDate() + 7);
  const end = endD.toISOString().slice(0, 10);
  const lDate = iso => { try { return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Europe/London" }); } catch { return String(iso).slice(0, 10); } };
  const lTime = iso => { try { return new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour12: false, hour: "2-digit", minute: "2-digit" }); } catch { return ""; } };
  const out = {};
  try {
    const { results } = await env.DB.prepare(
      "SELECT * FROM job_time_segments WHERE tenant_id=? AND username=? AND started_at>=? AND started_at<? ORDER BY started_at"
    ).bind(tid, username, monday, end).all();
    const today = lDate(new Date().toISOString());
    for (const seg of results || []) {
      const date = lDate(seg.started_at);
      let endedAt = seg.ended_at, open = false;
      if (!endedAt) {
        if (date < today) {
          // forgot to complete — close at 19:00 that day (or start+1h)
          const cut = new Date(seg.started_at); cut.setHours(cut.getHours() + 1);
          const sevenPm = new Date(date + "T18:00:00Z");   // ≈19:00 London in summer, 18:00 in winter — close enough for a fallback
          endedAt = (cut > sevenPm ? cut : sevenPm).toISOString();
          try { await env.DB.prepare("UPDATE job_time_segments SET ended_at=? WHERE id=? AND tenant_id=?").bind(endedAt, seg.id, tid).run(); } catch {}
        } else { open = true; }
      }
      const o = out[date] = out[date] || { s: Infinity, e: 0, open: false, jobs: [] };
      o.s = Math.min(o.s, Date.parse(seg.started_at));
      if (open) { o.open = true; }
      else o.e = Math.max(o.e, Date.parse(endedAt));
      const ref = seg.job_ref || seg.job_id;
      if (!o.jobs.some(j => j.ref.toLowerCase() === String(ref).toLowerCase()))
        o.jobs.push({ ref, site: seg.site || "", postcode: seg.postcode || "" });
    }
  } catch {}
  const shaped = {};
  for (const [date, o] of Object.entries(out)) {
    shaped[date] = { start: lTime(new Date(o.s).toISOString()),
      finish: o.open || !o.e ? null : lTime(new Date(o.e).toISOString()),
      open: o.open, jobs: o.jobs };
  }
  return shaped;
}
const normKey = s => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

// ── Settings (app_config JSON, per-user overrides on shared defaults) ────────
const DEFAULTS = { commuteMins: 30, lunchMins: 30, lunchThresholdH: 6, pencePerMile: 45,
  radiusMiles: 10, basePostcode: "PO15 5RQ", company: "Mostlane" };
async function getCfg(env, tid) {
  let cfg = { defaults: { ...DEFAULTS }, byUser: {} };
  try {
    const row = await env.DB.prepare("SELECT value FROM app_config WHERE key=?").bind(CFG_KEY(tid)).first();
    if (row && row.value) { const v = JSON.parse(row.value); cfg.defaults = Object.assign(cfg.defaults, v.defaults || {}); cfg.byUser = v.byUser || {}; }
  } catch {}
  return cfg;
}
async function saveCfg(env, tid, cfg) {
  await env.DB.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(tid, CFG_KEY(tid), JSON.stringify(cfg)).run();
}
async function userRow(env, tid, username) {
  return env.DB.prepare("SELECT username, first_name, last_name, employment_type, status, profile FROM users WHERE tenant_id=? AND username=?")
    .bind(tid, username).first();
}
function displayName(u) { return u ? ((`${u.first_name || ""} ${u.last_name || ""}`).trim() || u.username) : ""; }
function isSelfEmployed(u) { return /self/i.test(String((u && u.employment_type) || "")); }

// Effective settings for one user: shared defaults + their overrides + profile rates.
function effectiveCfg(cfg, u) {
  const mine = (cfg.byUser && cfg.byUser[u.username]) || {};
  let profile = {}; try { profile = u.profile ? JSON.parse(u.profile) : {}; } catch {}
  const num = v => { const n = parseFloat(v); return isFinite(n) && n > 0 ? n : null; };
  return {
    employment: u.employment_type || "Employed",
    selfEmployed: isSelfEmployed(u),
    commute: mine.commute === true,          // 30 mins each way deducted
    lunch: mine.lunch === true,              // 30 mins lunch deducted
    mileage: mine.mileage === true,          // may claim mileage (fuel)
    radius: mine.radius === true,            // first/last N miles of a day unpaid
    radiusMiles: Number(mine.radiusMiles ?? cfg.defaults.radiusMiles) || 10,
    commuteMins: Number(mine.commuteMins ?? cfg.defaults.commuteMins) || 30,
    lunchMins: Number(mine.lunchMins ?? cfg.defaults.lunchMins) || 30,
    lunchThresholdH: Number(mine.lunchThresholdH ?? cfg.defaults.lunchThresholdH) || 6,
    pencePerMile: Number(mine.pencePerMile ?? profile.pencePerMile ?? cfg.defaults.pencePerMile) || 45,
    rateType: mine.rateType === "day" ? "day" : "hour",
    rate: num(mine.rate) ?? (mine.rateType === "day" ? num(profile.dayRate) : num(profile.hourlyRate)) ?? num(profile.hourlyRate),
    homePostcode: String(mine.homePostcode || "").toUpperCase(),
    details: Array.isArray(mine.details) ? mine.details : [],   // extra lines under their name on the invoice
    nextNumber: Number(mine.nextNumber) || null,
  };
}

// ── Week data + pay maths ────────────────────────────────────────────────────
function cleanDays(monday, days) {
  const valid = new Set(weekDays(monday));
  const out = {};
  for (const [date, d] of Object.entries(days || {})) {
    if (!valid.has(date) || !d || typeof d !== "object") continue;
    const start = toMin(d.start) != null ? String(d.start) : "";
    const finish = toMin(d.finish) != null ? String(d.finish) : "";
    const jobs = String(d.jobs || "").slice(0, 400);
    const note = String(d.note || "").slice(0, 400);
    const mileage = (Array.isArray(d.mileage) ? d.mileage : []).slice(0, 8).map(m => ({
      site: String((m && m.site) || "").slice(0, 120),
      postcode: String((m && m.postcode) || "").toUpperCase().slice(0, 10),
      miles: Math.max(0, Math.min(1000, round1(parseFloat(m && m.miles) || 0))),
    })).filter(m => m.miles > 0 || m.site || m.postcode);
    if (start || finish || jobs || note || mileage.length) out[date] = { start, finish, jobs, note, mileage };
  }
  return out;
}
// Claimed miles for a day: the raw total minus the first/last radius legs
// (2 × radiusMiles) when that user has the radius deduction ticked.
function claimedMiles(miles, eff) {
  if (!eff.radius || !(miles > 0)) return miles;
  return Math.max(0, round1(miles - 2 * eff.radiusMiles));
}
function dayCalc(d, eff) {
  const miles = dayMiles(d);
  const base = { miles, milesClaimed: claimedMiles(miles, eff) };
  const s = toMin(d.start), e0 = toMin(d.finish);
  if (s == null || e0 == null) return { span: 0, paid: 0, commute: 0, lunch: 0, worked: false, ...base };
  const e = e0 <= s ? e0 + 1440 : e0;   // finishing "past midnight" rolls to the next day
  const span = e - s;
  const commute = eff.commute ? eff.commuteMins * 2 : 0;
  const lunch = (eff.lunch && span >= eff.lunchThresholdH * 60) ? eff.lunchMins : 0;
  return { span, paid: Math.max(0, span - commute - lunch), commute, lunch, worked: true, ...base };
}
function dayMiles(d) { return round1((Array.isArray(d.mileage) ? d.mileage : []).reduce((a, m) => a + (parseFloat(m.miles) || 0), 0)); }
function weekTotals(days, eff) {
  let paidMins = 0, miles = 0, milesClaimed = 0, daysWorked = 0;
  for (const d of Object.values(days || {})) {
    const c = dayCalc(d, eff);
    paidMins += c.paid; miles += c.miles; milesClaimed += c.milesClaimed;
    if (c.worked) daysWorked++;
  }
  const hours = Math.round((paidMins / 60) * 100) / 100;
  const labour = eff.rate ? Math.round((eff.rateType === "day" ? daysWorked * eff.rate : hours * eff.rate) * 100) / 100 : null;
  const mileagePay = Math.round(milesClaimed * eff.pencePerMile) / 100;
  return { paidMins, hours, miles: round1(miles), milesClaimed: round1(milesClaimed),
    milesDeducted: round1(miles - milesClaimed), daysWorked, labour, mileagePay,
    total: labour != null ? Math.round((labour + mileagePay) * 100) / 100 : null };
}
async function loadWeek(env, tid, username, monday) {
  const row = await env.DB.prepare("SELECT data, at FROM eng_timesheets WHERE tenant_id=? AND week=? AND username=?")
    .bind(tid, monday, username).first();
  let days = {}; try { days = row && row.data ? (JSON.parse(row.data).days || {}) : {}; } catch {}
  return { days, savedAt: row ? row.at : null };
}
async function invoiceFor(env, tid, username, monday) {
  return env.DB.prepare("SELECT * FROM eng_invoices WHERE tenant_id=? AND username=? AND week=?").bind(tid, username, monday).first();
}
async function nextInvoiceNumber(env, tid, username, eff) {
  const row = await env.DB.prepare("SELECT MAX(number) AS m FROM eng_invoices WHERE tenant_id=? AND username=?").bind(tid, username).first();
  const max = row && row.m != null ? Number(row.m) : 0;
  return Math.max(max + 1, eff.nextNumber || 1);
}
async function isTsAdmin(env, tid, sess) {
  if (!sess) return false;
  const p = await permissionsFor(env, tid, sess.user.username);
  return p.FullAccess === "Yes" || p.TimesheetAdmin === "Yes";
}

// ── PO-system sites (optional PO_DB binding → D1 database "mostlane-po") ─────
// The PO worker keeps its OWN sites (portal→PO sync is add-only, so sites
// added directly in the PO system never reach the portal's sites table).
// When a PO_DB binding exists on mostlane-api we read them straight from that
// database. Its schema isn't in this repo, so we DISCOVER the table at
// runtime: list tables, inspect columns, pick the best site-shaped one
// (needs a name column plus a postcode or job-number column; table names
// containing site/store/branch score higher). The discovery is cached for the
// isolate's lifetime and everything fails soft — no binding, no match, or a
// query error just means suggestions fall back to portal sites only.
// Three storage shapes are recognised, because the PO worker grew out of KV:
//   cols — a proper table with name/postcode/job columns
//   rows — a table whose rows each hold one site as a JSON object (data/value col)
//   blob — a key/value table where ONE value is a JSON ARRAY of site objects
let PO_MAP;      // undefined = not probed yet, null = nothing usable found
let PO_MAP_AT = 0;   // a FAILED probe is retried after 2 min, success is kept
let PO_TABLES;   // [{ name, cols:[…] }] — kept for the /ts/po-status diagnostic
let PO_BLOB;     // { at, list } — parsed blob cache (blob mode only)
function poShape(o) {
  if (!o || typeof o !== "object") return null;
  const name = o.siteName ?? o.site_name ?? o.SiteName ?? o.name ?? o.site ?? o.store ?? o.branch ?? "";
  const pc = o.postcode ?? o.postCode ?? o.post_code ?? o.Postcode ?? "";
  const job = o.jobNumber ?? o.job_number ?? o.JobNumber ?? o.jobNo ?? o.job ?? o.siteNumber ?? o.site_number ?? null;
  if (!name) return null;
  return { name: String(name), pc: String(pc || ""), job: job != null && job !== "" ? String(job) : null };
}
function poSiteish(o) { const s = poShape(o); return !!(s && (s.pc || s.job)); }
let PO_PROBE = null;   // in-flight probe — concurrent requests share one sweep
async function poDiscover(env) {
  if (!env.PO_DB) return null;
  if (PO_MAP !== undefined && (PO_MAP !== null || Date.now() - PO_MAP_AT < 2 * 60 * 1000)) return PO_MAP;
  if (!PO_PROBE) PO_PROBE = probePoDb(env).finally(() => { PO_PROBE = null; });
  await PO_PROBE;
  return PO_MAP;
}
async function probePoDb(env) {
  PO_MAP_AT = Date.now();
  const tables = [];
  let map = null;
  try {
    const { results } = await env.PO_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf%' ESCAPE '\\'").all();
    let best = null;
    // Workers cap the number of queries per request, and probing EVERY table
    // (PRAGMA + row sample each) blew that cap on the real PO database — the
    // sweep died half-way and cached the failure. So: probe likely-named
    // tables first, under a hard query budget.
    const prio = n => /site|store|branch/i.test(n) ? 3 : /po|purchase|order|job/i.test(n) ? 2 : /kv|data|config|record/i.test(n) ? 1 : 0;
    const ordered = (results || []).map(t => String(t.name)).sort((a, b) => prio(b) - prio(a));
    let budget = 18;
    for (const tbl of ordered) {
      if (budget <= 0) break;
      const safe = tbl.replace(/"/g, "");
      let cols = [];
      budget--;
      try { cols = (await env.PO_DB.prepare(`PRAGMA table_info("${safe}")`).all()).results || []; } catch { continue; }
      const names = cols.map(c => String(c.name));
      tables.push({ name: tbl, cols: names });
      const lower = names.map(n => n.toLowerCase());
      const pick = (...cands) => {
        for (const c of cands) { const i = lower.indexOf(c); if (i >= 0) return names[i]; }
        for (const c of cands) { const i = lower.findIndex(n => n.includes(c)); if (i >= 0) return names[i]; }
        return null;
      };
      // Shape 1: real columns
      const nameCol = pick("site_name", "sitename", "site", "store", "branch", "name");
      const pcCol = pick("postcode", "post_code", "postal_code", "zip");
      const jobCol = pick("job_number", "jobnumber", "job_no", "jobno", "job");
      if (nameCol && (pcCol || jobCol)) {
        const score = 10 + (pcCol ? 2 : 0) + (jobCol ? 1 : 0) + (/site|store|branch/i.test(tbl) ? 3 : 0);
        if (!best || score > best.score) best = { mode: "cols", table: tbl, nameCol, pcCol, jobCol, score };
        continue;
      }
      // Shapes 2/3: JSON stored in a text column — sample some rows and look inside
      const jsonCol = pick("value", "data", "json", "body", "payload", "v");
      if (!jsonCol) continue;
      const keyCol = pick("key", "k", "id", "name");
      if (budget <= 0) break;
      budget--;
      let rows = [];
      try {
        rows = (await env.PO_DB.prepare(
          `SELECT ${keyCol ? `"${keyCol}" AS k, ` : ""}"${jsonCol}" AS v FROM "${safe}" LIMIT 40`).all()).results || [];
      } catch { continue; }
      let rowish = 0;
      for (const r of rows) {
        let v = null; try { v = JSON.parse(r.v); } catch { continue; }
        if (Array.isArray(v) && v.length && v.slice(0, 5).every(poSiteish)) {
          const bk = r.k != null ? String(r.k) : "";
          const score = 8 + (/site|store|branch/i.test(bk) ? 3 : 0) + Math.min(3, Math.floor(v.length / 50));
          if (!best || score > best.score) best = { mode: "blob", table: tbl, jsonCol, keyCol, blobKey: bk, score };
        } else if (poSiteish(v)) rowish++;
      }
      if (rowish >= Math.max(2, Math.floor(rows.length * 0.3))) {
        const score = 7 + (/site|store|branch/i.test(tbl) ? 3 : 0);
        if (!best || score > best.score) best = { mode: "rows", table: tbl, jsonCol, score };
      }
    }
    map = best;
  } catch { map = null; }
  // Commit everything in one go so no request ever sees a half-filled state.
  PO_TABLES = tables;
  PO_MAP = map;
  PO_ORD = deriveOrderMap();
}
async function poBlobList(env, m) {
  if (PO_BLOB && Date.now() - PO_BLOB.at < 5 * 60 * 1000) return PO_BLOB.list;
  let list = [];
  try {
    const safe = m.table.replace(/"/g, "");
    const row = m.keyCol
      ? await env.PO_DB.prepare(`SELECT "${m.jsonCol}" AS v FROM "${safe}" WHERE "${m.keyCol}"=?`).bind(m.blobKey).first()
      : await env.PO_DB.prepare(`SELECT "${m.jsonCol}" AS v FROM "${safe}" LIMIT 1`).first();
    const v = row ? JSON.parse(row.v) : null;
    if (Array.isArray(v)) list = v.map(poShape).filter(Boolean);
  } catch {}
  PO_BLOB = { at: Date.now(), list };
  return list;
}
// term is the RAW search text ("" = everything); returns [{ name, pc, job }].
async function poSiteRows(env, term, limit) {
  const m = await poDiscover(env);
  if (!m) return [];
  const cap = Math.max(1, Math.min(30, limit));
  const like = "%" + String(term || "").replace(/[%_]/g, "") + "%";
  const T = String(term || "").toLowerCase();
  const matches = s => !T || s.name.toLowerCase().includes(T) || s.pc.toLowerCase().includes(T) || (s.job || "").toLowerCase().includes(T);
  try {
    const safe = m.table.replace(/"/g, "");
    if (m.mode === "cols") {
      const cols = [`"${m.nameCol}" AS name`];
      if (m.pcCol) cols.push(`"${m.pcCol}" AS pc`);
      if (m.jobCol) cols.push(`CAST("${m.jobCol}" AS TEXT) AS job`);
      const where = [`"${m.nameCol}" LIKE ?1`];
      if (m.pcCol) where.push(`"${m.pcCol}" LIKE ?1`);
      if (m.jobCol) where.push(`CAST("${m.jobCol}" AS TEXT) LIKE ?1`);
      const { results } = await env.PO_DB.prepare(
        `SELECT ${cols.join(", ")} FROM "${safe}" WHERE ${where.join(" OR ")} LIMIT ${cap}`).bind(like).all();
      return (results || []).map(r => ({ name: String(r.name || ""), pc: String(r.pc || ""), job: r.job != null ? String(r.job) : null }))
        .filter(s => s.name);
    }
    if (m.mode === "rows") {
      // The LIKE runs over the raw JSON — cheap pre-filter, exact match in JS.
      const { results } = await env.PO_DB.prepare(
        `SELECT "${m.jsonCol}" AS v FROM "${safe}" WHERE "${m.jsonCol}" LIKE ?1 LIMIT 200`).bind(like).all();
      const out = [];
      for (const r of results || []) {
        let v = null; try { v = JSON.parse(r.v); } catch { continue; }
        const s = poShape(v);
        if (s && matches(s)) { out.push(s); if (out.length >= cap) break; }
      }
      return out;
    }
    if (m.mode === "blob") {
      const list = await poBlobList(env, m);
      return list.filter(matches).slice(0, cap);
    }
  } catch {}
  return [];
}

// ── Site names written on the purchase orders themselves ─────────────────────
// The PO database's sites table doesn't hold every place — plenty of sites
// exist only as text typed on a PO (e.g. "Lakeside Surgery, Verwood"). So we
// also discover the PO/orders table (name matching po/purchase/order, or any
// remaining table with a site-ish column; columnar or JSON rows) and harvest
// DISTINCT site names from the most recent rows, cached 5 min per isolate.
let PO_ORD;        // set atomically by the same probe as PO_MAP
let PO_ORD_CACHE;  // { at, list } — harvested site names
// Derived from the table list with NO extra queries — runs inside the probe
// so both discoveries land together (a race here once poisoned an isolate:
// one request read the half-filled table list and cached "nothing" forever).
function deriveOrderMap() {
  const sitesTable = PO_MAP ? PO_MAP.table : null;
  let best = null;
  for (const t of PO_TABLES || []) {
    if (t.name === sitesTable) continue;
    const lower = (t.cols || []).map(n => n.toLowerCase());
    const pick = (...cands) => {
      for (const c of cands) { const i = lower.indexOf(c); if (i >= 0) return t.cols[i]; }
      for (const c of cands) { const i = lower.findIndex(n => n.includes(c)); if (i >= 0) return t.cols[i]; }
      return null;
    };
    const isPo = /po|purchase|order/i.test(t.name);
    const siteCol = pick("site_name", "sitename", "site", "location");
    const jsonCol = pick("data", "value", "json", "body", "payload");
    if (siteCol) {
      const score = 5 + (isPo ? 5 : 0);
      if (!best || score > best.score) best = { mode: "col", table: t.name, siteCol, score };
    } else if (jsonCol && isPo) {
      const score = 6;
      if (!best || score > best.score) best = { mode: "json", table: t.name, jsonCol, score };
    }
  }
  return best;
}
async function poOrderDiscover(env) {
  await poDiscover(env);   // single-flight; fills PO_ORD too
  return PO_ORD || null;
}
async function poOrderSiteNames(env) {
  const m = await poOrderDiscover(env);
  if (!m) return [];
  if (PO_ORD_CACHE && Date.now() - PO_ORD_CACHE.at < 5 * 60 * 1000) return PO_ORD_CACHE.list;
  const names = new Map();   // lower-cased -> display text
  try {
    const safe = m.table.replace(/"/g, "");
    const add = v => { const s = String(v || "").trim(); if (s.length > 2 && !names.has(s.toLowerCase())) names.set(s.toLowerCase(), s); };
    if (m.mode === "col") {
      const { results } = await env.PO_DB.prepare(
        `SELECT DISTINCT "${m.siteCol}" AS s FROM "${safe}" ORDER BY rowid DESC LIMIT 500`).all();
      for (const r of results || []) add(r.s);
    } else {
      const { results } = await env.PO_DB.prepare(
        `SELECT "${m.jsonCol}" AS v FROM "${safe}" ORDER BY rowid DESC LIMIT 500`).all();
      for (const r of results || []) {
        let o = null; try { o = JSON.parse(r.v); } catch { continue; }
        if (o && typeof o === "object") add(o.site ?? o.siteName ?? o.site_name ?? o.Site ?? o.location ?? "");
      }
    }
  } catch {}
  PO_ORD_CACHE = { at: Date.now(), list: [...names.values()] };
  return PO_ORD_CACHE.list;
}

// ── Mileage estimate (postcodes.io + haversine × road factor) ────────────────
async function lookupPostcode(pc) {
  const r = await fetch("https://api.postcodes.io/postcodes/" + encodeURIComponent(normPc(pc)), {
    headers: { "Accept": "application/json" },
    cf: { cacheTtl: 30 * 86400, cacheEverything: true } });   // postcodes don't move — cache at the edge
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  const res = j && j.result;
  return res && res.latitude != null ? { lat: res.latitude, lng: res.longitude, pc: res.postcode } : null;
}
function haversineMiles(a, b) {
  const rad = x => x * Math.PI / 180, R = 3958.8;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const ROAD_FACTOR = 1.25;

// ── Invoice PDF ──────────────────────────────────────────────────────────────
function fmtDate(iso) { return new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }); }
function fmtHm(mins) { return Math.floor(mins / 60) + "h " + String(Math.round(mins % 60)).padStart(2, "0") + "m"; }
function buildInvoicePdf({ number, name, details, company, monday, days, eff, totals }) {
  const doc = new PdfDoc();
  const L = 48, R = 547;
  let y = 64;
  doc.text(L, y, "INVOICE", { size: 22, bold: true });
  doc.text(R, y - 8, "Invoice no. " + number, { size: 12, bold: true, alignRight: true });
  doc.text(R, y + 8, "Date: " + fmtDate(new Date().toISOString().slice(0, 10)), { size: 10, alignRight: true, grey: true });
  y += 34;
  doc.text(L, y, "From", { size: 9, grey: true }); doc.text(R, y, "To", { size: 9, grey: true, alignRight: true });
  y += 14;
  // The engineer's own "From" block replaces the portal display name entirely
  // when set (first line bold — their full/trading name, then address lines).
  const fromLines = (details && details.length ? details : [name]).slice(0, 6);
  doc.text(L, y, String(fromLines[0]).slice(0, 60), { size: 11, bold: true });
  const toLines = String(company || "Mostlane").split(/\n/).filter(Boolean);
  let ty = y;
  for (const ln of toLines) { doc.text(R, ty, ln.trim(), { size: ty === y ? 11 : 10, bold: ty === y, alignRight: true }); ty += 14; }
  for (const ln of fromLines.slice(1)) { y += 14; doc.text(L, y, String(ln).slice(0, 60), { size: 10 }); }
  y = Math.max(y, ty - 14) + 24;
  doc.text(L, y, "Week: " + fmtDate(monday) + " – " + fmtDate(weekDays(monday)[6]), { size: 10, bold: true });
  y += 16; doc.hr(L, y, R); y += 16;

  // Table header
  const cDate = L, cDesc = L + 78, cHours = 425, cAmt = R;
  doc.text(cDate, y, "Date", { size: 9, bold: true, grey: true });
  doc.text(cDesc, y, "Details", { size: 9, bold: true, grey: true });
  doc.text(cHours, y, "Hours", { size: 9, bold: true, grey: true, alignRight: true });
  doc.text(cAmt, y, "Amount", { size: 9, bold: true, grey: true, alignRight: true });
  y += 6; doc.hr(L, y, R, { grey: true }); y += 15;

  const fitDesc = (s, max) => { let t = String(s || ""); while (t && textWidth(t, 10) > max) t = t.slice(0, -1); return t; };
  const perHourAmount = mins => eff.rate && eff.rateType === "hour" ? money((mins / 60) * eff.rate) : "";
  for (const date of weekDays(monday)) {
    const d = days[date]; if (!d) continue;
    const c = dayCalc(d, eff);
    if (!c.worked && !c.miles) continue;
    if (c.worked) {
      doc.text(cDate, y, new Date(date + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }), { size: 10 });
      const dedNote = [c.commute ? "-" + c.commute + "m travel" : "", c.lunch ? "-" + c.lunch + "m lunch" : ""].filter(Boolean).join(", ");
      doc.text(cDesc, y, fitDesc((d.jobs || "Site work") + (dedNote ? "  (" + dedNote + ")" : ""), cHours - cDesc - 40), { size: 10 });
      doc.text(cHours, y, fmtHm(c.paid), { size: 10, alignRight: true });
      doc.text(cAmt, y, perHourAmount(c.paid), { size: 10, alignRight: true });
      y += 15;
    }
    for (const m of (d.mileage || [])) {
      if (!(parseFloat(m.miles) > 0)) continue;
      doc.text(cDesc, y, fitDesc("Mileage — " + (m.site || m.postcode || "site") + " (" + m.miles + " mi)", cHours - cDesc - 40), { size: 10, grey: true });
      y += 15;
    }
    if (y > 720) { doc.newPage(); y = 60; }
  }
  y += 4; doc.hr(L, y, R); y += 18;
  const cTot = 280;   // totals labels start here (left-aligned, clear of the amounts)
  if (eff.rateType === "day" && eff.rate) {
    doc.text(cTot, y, "Labour: " + totals.daysWorked + " day(s) @ " + money(eff.rate), { size: 10 });
    doc.text(cAmt, y, money(totals.labour || 0), { size: 10, alignRight: true }); y += 16;
  } else {
    doc.text(cTot, y, "Labour: " + totals.hours + " h" + (eff.rate ? " @ " + money(eff.rate) + "/h" : ""), { size: 10 });
    doc.text(cAmt, y, totals.labour != null ? money(totals.labour) : "", { size: 10, alignRight: true }); y += 16;
  }
  if (totals.miles > 0) {
    const ded = totals.milesDeducted > 0;
    doc.text(cTot, y, "Mileage: " + (ded
      ? totals.miles + " mi - " + totals.milesDeducted + " mi (first/last " + eff.radiusMiles + " mi/day) = " + totals.milesClaimed + " mi @ " + eff.pencePerMile + "p"
      : totals.milesClaimed + " mi @ " + eff.pencePerMile + "p"), { size: ded ? 9 : 10 });
    doc.text(cAmt, y, money(totals.mileagePay), { size: 10, alignRight: true }); y += 16;
  }
  y += 6;
  doc.text(cTot, y, "TOTAL", { size: 12, bold: true });
  doc.text(cAmt, y, money(totals.total || 0), { size: 12, bold: true, alignRight: true });
  y += 30;
  doc.text(L, y, "Generated via the Mostlane Portal on " + new Date().toISOString().slice(0, 10) + ".", { size: 8, grey: true });
  return doc.bytes();
}

// ── Handler ──────────────────────────────────────────────────────────────────
export async function handle(request, env, ctx, url, sess) {
  const method = request.method.toUpperCase();
  const sub = url.pathname.replace(/^\/ts(?=\/|$)/, "") || "/";
  const q = url.searchParams;
  const headers = corsHeaders(env, request);

  // ── Stream an invoice PDF (public, but access-gated by the signature) ─────
  if (sub === "/invoice-file" && method === "GET") {
    const key = q.get("key");
    if (!key || !String(key).startsWith("invoices/")) return error("Bad key", 400, env, request);
    if (!sess && !(await verifyFileSig(env, key, q))) return error("Link expired or invalid", 403, env, request);
    const obj = await env.JOB_FILES.get(key);
    if (!obj) return new Response("Not found", { status: 404, headers });
    return new Response(obj.body, { status: 200, headers: {
      ...headers, "Content-Type": "application/pdf", "Content-Disposition": "inline", "Cache-Control": "private, max-age=3600"
    }});
  }

  if (!sess) return error("Not authenticated", 401, env, request);
  const tid = sess.tenantId;
  const me = sess.user.username;
  await ensureTables(env);
  const cfg = await getCfg(env, tid);

  // ── GET /ts/me — the caller's effective settings ──────────────────────────
  if (sub === "/me" && method === "GET") {
    const u = await userRow(env, tid, me);
    if (!u) return error("User not found", 404, env, request);
    const eff = effectiveCfg(cfg, u);
    const next = await nextInvoiceNumber(env, tid, me, eff);
    const admin = await isTsAdmin(env, tid, sess);
    const invCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM eng_invoices WHERE tenant_id=? AND username=?").bind(tid, me).first();
    return json({ ok: true, name: displayName(u), ...eff, rate: eff.rate, nextInvoice: next,
      basePostcode: String(cfg.defaults.basePostcode || "PO15 5RQ").toUpperCase(),
      canSetNumber: !invCount || Number(invCount.n) === 0, admin }, {}, env, request);
  }

  // ── POST /ts/me — self-service settings (postcode, invoice details, rate) ─
  if (sub === "/me" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const mine = cfg.byUser[me] || (cfg.byUser[me] = {});
    if ("homePostcode" in b) mine.homePostcode = String(b.homePostcode || "").toUpperCase().slice(0, 10);
    if ("details" in b) mine.details = (Array.isArray(b.details) ? b.details : String(b.details || "").split(/\n/))
      .map(s => String(s).trim()).filter(Boolean).slice(0, 6);
    if ("rate" in b) { const n = parseFloat(b.rate); if (isFinite(n) && n >= 0) mine.rate = n; }
    if ("rateType" in b && (b.rateType === "hour" || b.rateType === "day")) mine.rateType = b.rateType;
    await saveCfg(env, tid, cfg);
    return json({ ok: true }, {}, env, request);
  }

  // ── GET /ts/my — own week ─────────────────────────────────────────────────
  if (sub === "/my" && method === "GET") {
    const monday = mondayOf(isDateStr(q.get("week")) ? q.get("week") : new Date().toISOString().slice(0, 10));
    const u = await userRow(env, tid, me);
    const eff = effectiveCfg(cfg, u);
    const { days, savedAt } = await loadWeek(env, tid, me, monday);
    const inv = await invoiceFor(env, tid, me, monday);
    const auto = await jobTimeAuto(env, tid, me, monday);
    return json({ ok: true, week: monday, days, savedAt, auto, totals: weekTotals(days, eff),
      invoice: inv ? { number: inv.number, total: inv.total, at: inv.at,
        url: await signedFileUrl(env, url.origin, "/ts/invoice-file", inv.r2_key) } : null }, {}, env, request);
  }

  // ── POST /ts/my — save own week ───────────────────────────────────────────
  // Mileage is PRESET-ONLY for engineers: whatever miles the client sends are
  // replaced with the office's site-mileage register figure (0 when the site
  // has none), and non-fuel users get their mileage stripped entirely — so
  // nobody can hand themselves miles, whatever their phone submits.
  if (sub === "/my" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!isDateStr(b.week)) return error("week (Monday, YYYY-MM-DD) required", 400, env, request);
    const monday = mondayOf(b.week);
    if (await invoiceFor(env, tid, me, monday))
      return error("This week has already been invoiced — ask the office to remove the invoice first.", 409, env, request);
    const u = await userRow(env, tid, me);
    const eff = effectiveCfg(cfg, u);
    const days = cleanDays(monday, b.days);
    if (!eff.mileage) {
      for (const d of Object.values(days)) d.mileage = [];
    } else {
      const names = [...new Set(Object.values(days).flatMap(d => (d.mileage || []).map(m => normKey(m.site))).filter(Boolean))];
      const preset = {};
      if (names.length) {
        try {
          const ph = names.map(() => "?").join(",");
          const { results } = await env.DB.prepare(
            `SELECT key, miles FROM site_miles WHERE tenant_id=? AND key IN (${ph})`).bind(tid, ...names).all();
          for (const r of results || []) if (r.miles != null) preset[r.key] = r.miles;
        } catch {}
      }
      for (const d of Object.values(days)) {
        d.mileage = (d.mileage || []).filter(m => m.site)
          .map(m => ({ site: m.site, postcode: m.postcode, miles: preset[normKey(m.site)] != null ? preset[normKey(m.site)] : 0 }));
      }
    }
    await env.DB.prepare(
      "INSERT INTO eng_timesheets (tenant_id, week, username, data, at) VALUES (?,?,?,?,?) ON CONFLICT(tenant_id, week, username) DO UPDATE SET data=excluded.data, at=excluded.at"
    ).bind(tid, monday, me, JSON.stringify({ days }), new Date().toISOString()).run();
    return json({ ok: true, week: monday, days, totals: weekTotals(days, eff) }, {}, env, request);
  }

  // ── GET /ts/assigned?week= — the caller's scheduled SLA jobs, per day ─────
  // Feeds the "you're booked on" chips on each timesheet day. Engineer names
  // on jobs arrive in several spellings (dotted ids, case differences), so
  // matching is normalised the same way login is forgiving.
  if (sub === "/assigned" && method === "GET") {
    const monday = mondayOf(isDateStr(q.get("week")) ? q.get("week") : new Date().toISOString().slice(0, 10));
    const endD = new Date(monday + "T12:00:00Z"); endD.setUTCDate(endD.getUTCDate() + 7);
    const end = endD.toISOString().slice(0, 10);
    const byDay = {};
    const debug = { me, matchedAs: [], candidates: [] };
    try {
      const { results } = await env.DB.prepare(
        "SELECT id, helpdesk_ref, scheduled_at, data FROM sla_jobs WHERE tenant_id=? AND scheduled_at IS NOT NULL AND scheduled_at>=? AND scheduled_at<? LIMIT 500"
      ).bind(tid, monday, end).all();
      // Resolve exactly like the (working) assignment pushes do: build a map
      // of normalised username AND "First Last" → canonical username from the
      // users table, then compare canonically. Fuzzy contains() as fallback.
      const normId = s => String(s || "").toLowerCase().replace(/\s+/g, ".").trim();
      const norm = s => String(s || "").toLowerCase().replace(/[._]/g, " ").replace(/\s+/g, " ").trim();
      const map = {};
      try {
        const { results: users } = await env.DB.prepare("SELECT username, first_name, last_name FROM users WHERE tenant_id=?").bind(tid).all();
        for (const u of users || []) {
          map[normId(u.username)] = u.username;
          const full = ((u.first_name || "") + " " + (u.last_name || "")).trim();
          if (full) map[normId(full)] = u.username;
        }
      } catch {}
      const meN = norm(me);
      const isMe = e => {
        const resolved = map[normId(e)];
        if (resolved != null) return resolved === me;
        const n = norm(e);
        return !!n && (n === meN || n.includes(meN) || meN.includes(n));
      };
      // Bucket by the LONDON date of the booking (UTC slicing puts a 00:30 BST
      // job on the wrong day).
      const londonDate = iso => { try { return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Europe/London" }); } catch { return String(iso).slice(0, 10); } };
      const londonTime = iso => { try { return new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour12: false, hour: "2-digit", minute: "2-digit" }); } catch { return ""; } };
      for (const r of results || []) {
        let d = {}; try { d = JSON.parse(r.data); } catch { continue; }
        const engs = (Array.isArray(d.assignedEngineers) && d.assignedEngineers.length)
          ? d.assignedEngineers : (d.assignedTo ? [d.assignedTo] : []);
        const mine = engs.some(isMe);
        debug.candidates.push({ ref: r.helpdesk_ref || r.id, scheduledAt: r.scheduled_at, engineers: engs,
          resolved: engs.map(e => map[normId(e)] || "(no user match: " + e + ")"), mine });
        if (!mine) continue;
        const date = londonDate(r.scheduled_at);
        (byDay[date] = byDay[date] || []).push({
          ref: r.helpdesk_ref || r.id,
          label: (r.helpdesk_ref || r.id) + (d.description ? " — " + String(d.description).slice(0, 44) : ""),
          site: d.siteName || "", postcode: String(d.postcode || "").toUpperCase(),
          time: londonTime(r.scheduled_at)
        });
      }
      for (const k of Object.keys(byDay)) byDay[k].sort((a, b) => (a.time || "").localeCompare(b.time || ""));
    } catch (e) { debug.error = String(e && e.message || e); }
    if (q.get("debug") === "1" && await isTsAdmin(env, tid, sess))
      return json({ ok: true, build: "w9", week: monday, byDay, debug }, {}, env, request);
    return json({ ok: true, week: monday, byDay }, {}, env, request);
  }

  // ── GET /ts/sites — suggestion list for the mileage site picker ───────────
  // Portal sites first, then the PO system's own sites (PO_DB binding),
  // deduped by name so shared sites don't appear twice.
  if (sub === "/sites" && method === "GET") {
    const term = String(q.get("q") || "").trim();
    const like = "%" + term.replace(/[%_]/g, "") + "%";
    const { results } = await env.DB.prepare(
      "SELECT site_name, site_number, postcode FROM sites WHERE tenant_id=? AND active=1 AND (site_name LIKE ? OR postcode LIKE ? OR site_number LIKE ?) ORDER BY site_name LIMIT 15"
    ).bind(tid, like, like, like).all();
    const sites = (results || []).map(s => ({
      name: s.site_name || ("Site " + s.site_number), code: s.site_number, postcode: (s.postcode || "").replace(/\*+$/, "") }));
    const seen = new Set(sites.map(s => s.name.trim().toLowerCase()));
    for (const r of await poSiteRows(env, term, 15)) {
      const name = String(r.name || "").trim();
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      sites.push({ name, code: r.job != null ? String(r.job) : "", postcode: String(r.pc || "").toUpperCase(), source: "po" });
      if (sites.length >= 25) break;
    }
    // Site names typed on POs (no postcode of their own — engineer enters it).
    try {
      const T = term.toLowerCase();
      for (const n of await poOrderSiteNames(env)) {
        if (sites.length >= 25) break;
        if (T && !n.toLowerCase().includes(T)) continue;
        if (seen.has(n.trim().toLowerCase())) continue;
        seen.add(n.trim().toLowerCase());
        sites.push({ name: n, code: "", postcode: "", source: "po-order" });
      }
    } catch {}
    // Attach known round-trip mileage from the site-mileage register.
    try {
      const keys = [...new Set(sites.map(s => normKey(s.name)).filter(Boolean))];
      if (keys.length) {
        const ph = keys.map(() => "?").join(",");
        const { results: mrows } = await env.DB.prepare(
          `SELECT key, miles FROM site_miles WHERE tenant_id=? AND key IN (${ph})`).bind(tid, ...keys).all();
        const mmap = {}; for (const r of mrows || []) if (r.miles != null) mmap[r.key] = r.miles;
        for (const s of sites) { const m = mmap[normKey(s.name)]; if (m != null) s.miles = m; }
      }
    } catch {}
    return json({ ok: true, sites }, {}, env, request);
  }

  // ── GET /ts/po-status — is the PO_DB binding live, what did we find? ──────
  // Full diagnostic for the admin Settings modal: binding present, which
  // table/shape was recognised, a few sample sites — and when nothing was
  // recognised, the PO database's tables + columns so the problem is visible.
  if (sub === "/po-status" && method === "GET") {
    if (!(await isTsAdmin(env, tid, sess))) return error("Forbidden", 403, env, request);
    const m = await poDiscover(env);
    const out = { ok: true, build: "w9", bound: !!env.PO_DB, discovered: null, samples: [], tables: PO_TABLES || [] };
    if (m) {
      out.discovered = { mode: m.mode, table: m.table, nameCol: m.nameCol || null, pcCol: m.pcCol || null,
        jobCol: m.jobCol || null, jsonCol: m.jsonCol || null, blobKey: m.blobKey || null };
      out.samples = (await poSiteRows(env, "", 5)).map(s => s.name + (s.pc ? " (" + s.pc + ")" : ""));
    }
    const om = await poOrderDiscover(env);
    if (om) {
      const names = await poOrderSiteNames(env);
      out.orderSites = { table: om.table, mode: om.mode, count: names.length, samples: names.slice(0, 3) };
    }
    return json(out, {}, env, request);
  }

  // ── GET /ts/jobs — suggestions for the "job(s)" box ───────────────────────
  // Two sources, both already in the portal D1: project job numbers on sites
  // (the same list the PO system mirrors), and open live SLA jobs.
  if (sub === "/jobs" && method === "GET") {
    const term = String(q.get("q") || "").trim();
    if (term.length < 2) return json({ ok: true, jobs: [] }, {}, env, request);
    const like = "%" + term.replace(/[%_]/g, "") + "%";
    // Each source gets RESERVED seats in the dropdown so a busy source can
    // never crowd another out (a bug once hid every PO suggestion behind 16
    // SLA/portal matches). Errors per source are kept for the debug view.
    const sla = [], project = [], po = [], errs = {};
    const nameRef = s => String(s || "").replace(/\s*,\s*/g, " – ").trim();
    try {
      const { results } = await env.DB.prepare(
        "SELECT helpdesk_ref, description, status FROM sla_jobs WHERE tenant_id=? AND helpdesk_ref IS NOT NULL AND helpdesk_ref!='' AND status NOT IN ('Complete','Closed') AND (helpdesk_ref LIKE ? OR description LIKE ?) ORDER BY raised_at DESC LIMIT 8"
      ).bind(tid, like, like).all();
      for (const r of results || []) sla.push({ ref: r.helpdesk_ref, label: r.helpdesk_ref + " — " + String(r.description || "").slice(0, 48), kind: "sla" });
    } catch (e) { errs.sla = String(e && e.message || e); }
    // Engineers are "on" a PLACE as often as a numbered job, so site-name
    // matches suggest too: the ref inserted is the job number when the site
    // has one, otherwise the site name itself (commas softened so the
    // comma-separated jobs box doesn't split it).
    try {
      const { results } = await env.DB.prepare(
        "SELECT job_number, site_name, client, postcode FROM sites WHERE tenant_id=? AND active=1 AND (job_number LIKE ? OR site_name LIKE ?) ORDER BY site_name LIMIT 8"
      ).bind(tid, like, like).all();
      for (const r of results || []) {
        const hasJob = r.job_number != null && r.job_number !== "";
        const name = r.site_name || r.client || "site";
        project.push({ ref: hasJob ? String(r.job_number) : nameRef(name),
          label: (hasJob ? r.job_number + " — " : "") + name, kind: "project",
          site: name, postcode: (r.postcode || "").replace(/\*+$/, "") });
      }
    } catch (e) { errs.project = String(e && e.message || e); }
    // PO-system sites (PO_DB binding) — sites table AND names typed on POs.
    const seen = new Set([...sla, ...project].map(j => String(j.ref).toLowerCase()));
    try {
      for (const r of await poSiteRows(env, term, 8)) {
        const ref = (r.job != null && r.job !== "") ? String(r.job) : nameRef(r.name);
        if (!ref || seen.has(ref.toLowerCase())) continue;
        seen.add(ref.toLowerCase());
        po.push({ ref, label: ((r.job != null && r.job !== "") ? r.job + " — " : "") + String(r.name || "PO site").slice(0, 48), kind: "po",
          site: String(r.name || ""), postcode: String(r.pc || "").toUpperCase() });
      }
    } catch (e) { errs.poSites = String(e && e.message || e); }
    try {
      const T2 = term.toLowerCase();
      for (const n of await poOrderSiteNames(env)) {
        if (po.length >= 8) break;
        if (!n.toLowerCase().includes(T2)) continue;
        const ref = nameRef(n);
        if (!ref || seen.has(ref.toLowerCase())) continue;
        seen.add(ref.toLowerCase());
        po.push({ ref, label: n.slice(0, 60), kind: "po-order", site: n });
      }
    } catch (e) { errs.poOrders = String(e && e.message || e); }
    // Reserved seats: PO 4 · SLA 3 · portal 3, spare seats shared out after.
    const jobs = [...po.slice(0, 4), ...sla.slice(0, 3), ...project.slice(0, 3)];
    const spare = [...po.slice(4), ...sla.slice(3), ...project.slice(3)];
    for (const j of spare) { if (jobs.length >= 10) break; jobs.push(j); }
    // Exact/prefix matches float to the top (stable within each source).
    const T = term.toLowerCase();
    jobs.sort((a, b) => {
      const pa = String(a.ref).toLowerCase().startsWith(T) ? 0 : 1;
      const pb = String(b.ref).toLowerCase().startsWith(T) ? 0 : 1;
      return pa - pb;
    });
    const out = jobs.slice(0, 10);
    // ?debug=1 (admin): per-source counts + any swallowed errors, so "source X
    // stopped suggesting" is diagnosable from a phone.
    if (q.get("debug") === "1" && await isTsAdmin(env, tid, sess)) {
      return json({ ok: true, build: "w6", counts: { sla: sla.length, project: project.length, po: po.length },
        errors: errs, jobs: out }, {}, env, request);
    }
    // Attach known round-trip mileage so picking a site can auto-add the claim.
    try {
      const keys = [...new Set(out.map(j => normKey(j.site)).filter(Boolean))];
      if (keys.length) {
        const ph = keys.map(() => "?").join(",");
        const { results: mrows } = await env.DB.prepare(
          `SELECT key, miles FROM site_miles WHERE tenant_id=? AND key IN (${ph})`).bind(tid, ...keys).all();
        const mmap = {}; for (const r of mrows || []) if (r.miles != null) mmap[r.key] = r.miles;
        for (const j of out) { const m = mmap[normKey(j.site)]; if (m != null) j.miles = m; }
      }
    } catch {}
    return json({ ok: true, jobs: out }, {}, env, request);
  }

  // ── Site-mileage register (known round-trip miles per site) ───────────────
  // GET  /ts/miles?name=X          any session: one site's saved miles
  // GET  /ts/miles?all=1[&q=]      admin: full merged list (portal + saved)
  // POST /ts/miles                 admin: { entries:[{name,postcode,miles}], delete:[names] }
  // POST /ts/miles/autofill        admin: estimate missing portal sites from
  //                                the base postcode, 25 per call (loops)
  if (sub === "/miles" && method === "GET") {
    const name = q.get("name");
    if (name != null) {
      const row = await env.DB.prepare("SELECT miles FROM site_miles WHERE tenant_id=? AND key=?").bind(tid, normKey(name)).first();
      return json({ ok: true, miles: row && row.miles != null ? row.miles : null }, {}, env, request);
    }
    if (!(await isTsAdmin(env, tid, sess))) return error("Forbidden", 403, env, request);
    const { results: saved } = await env.DB.prepare("SELECT key, name, postcode, miles FROM site_miles WHERE tenant_id=?").bind(tid).all();
    const byKey = {}; for (const r of saved || []) byKey[r.key] = { name: r.name || r.key, postcode: r.postcode || "", miles: r.miles, saved: true };
    const { results: portal } = await env.DB.prepare(
      "SELECT site_name, postcode FROM sites WHERE tenant_id=? AND active=1 AND site_name IS NOT NULL AND site_name!=''").bind(tid).all();
    for (const r of portal || []) {
      const k = normKey(r.site_name);
      if (!byKey[k]) byKey[k] = { name: r.site_name, postcode: (r.postcode || "").replace(/\*+$/, ""), miles: null, saved: false };
      else if (!byKey[k].postcode) byKey[k].postcode = (r.postcode || "").replace(/\*+$/, "");
    }
    let list = Object.values(byKey).sort((a, b) => a.name.localeCompare(b.name));
    const term = String(q.get("q") || "").trim().toLowerCase();
    if (term) list = list.filter(s => s.name.toLowerCase().includes(term) || (s.postcode || "").toLowerCase().includes(term));
    return json({ ok: true, sites: list, missing: list.filter(s => s.miles == null && s.postcode).length }, {}, env, request);
  }
  if (sub === "/miles" && method === "POST") {
    if (!(await isTsAdmin(env, tid, sess))) return error("Forbidden", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const now = new Date().toISOString();
    let saved = 0;
    for (const e of (Array.isArray(b.entries) ? b.entries : []).slice(0, 200)) {
      const key = normKey(e && e.name);
      if (!key) continue;
      const miles = parseFloat(e.miles);
      if (!isFinite(miles) || miles < 0 || miles > 2000) {
        await env.DB.prepare("DELETE FROM site_miles WHERE tenant_id=? AND key=?").bind(tid, key).run();
        continue;   // blank/invalid miles = remove the saved value
      }
      await env.DB.prepare(
        "INSERT INTO site_miles (tenant_id, key, name, postcode, miles, updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(tenant_id, key) DO UPDATE SET name=excluded.name, postcode=excluded.postcode, miles=excluded.miles, updated_at=excluded.updated_at"
      ).bind(tid, key, String(e.name).trim().slice(0, 120), String(e.postcode || "").toUpperCase().slice(0, 10), round1(miles), now).run();
      saved++;
    }
    for (const n of (Array.isArray(b.delete) ? b.delete : []).slice(0, 200)) {
      await env.DB.prepare("DELETE FROM site_miles WHERE tenant_id=? AND key=?").bind(tid, normKey(n)).run();
    }
    return json({ ok: true, saved }, {}, env, request);
  }
  if (sub === "/miles/autofill" && method === "POST") {
    if (!(await isTsAdmin(env, tid, sess))) return error("Forbidden", 403, env, request);
    const base = await lookupPostcode(cfg.defaults.basePostcode || "PO15 5RQ");
    if (!base) return error("Base postcode " + (cfg.defaults.basePostcode || "PO15 5RQ") + " couldn't be found.", 400, env, request);
    const { results: portal } = await env.DB.prepare(
      "SELECT site_name, postcode FROM sites WHERE tenant_id=? AND active=1 AND site_name IS NOT NULL AND site_name!='' AND postcode IS NOT NULL AND postcode!=''").bind(tid).all();
    const { results: saved } = await env.DB.prepare("SELECT key FROM site_miles WHERE tenant_id=?").bind(tid).all();
    const have = new Set((saved || []).map(r => r.key));
    const todo = (portal || []).filter(r => !have.has(normKey(r.site_name)));
    const batch = todo.slice(0, 25);   // stay well under the per-request fetch cap
    const now = new Date().toISOString();
    let done = 0, failed = 0;
    for (const r of batch) {
      const pc = String(r.postcode).replace(/\*+$/, "");
      const to = await lookupPostcode(pc).catch(() => null);
      if (!to) { failed++; have.add(normKey(r.site_name)); continue; }
      const roundTrip = round1(haversineMiles(base, to) * ROAD_FACTOR * 2);
      await env.DB.prepare(
        "INSERT INTO site_miles (tenant_id, key, name, postcode, miles, updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(tenant_id, key) DO UPDATE SET miles=excluded.miles, updated_at=excluded.updated_at"
      ).bind(tid, normKey(r.site_name), r.site_name, pc.toUpperCase(), roundTrip, now).run();
      done++;
    }
    return json({ ok: true, done, failed, remaining: Math.max(0, todo.length - batch.length) }, {}, env, request);
  }

  // ── GET /ts/mileage — estimated road miles between two postcodes ──────────
  if (sub === "/mileage" && method === "GET") {
    const from = q.get("from"), to = q.get("to");
    if (!from || !to) return error("from and to postcodes required", 400, env, request);
    const [a, b] = await Promise.all([lookupPostcode(from), lookupPostcode(to)]);
    if (!a) return error("Couldn't find postcode " + String(from).toUpperCase(), 404, env, request);
    if (!b) return error("Couldn't find postcode " + String(to).toUpperCase(), 404, env, request);
    const oneWay = round1(haversineMiles(a, b) * ROAD_FACTOR);
    return json({ ok: true, from: a.pc, to: b.pc, oneWay, roundTrip: round1(oneWay * 2) }, {}, env, request);
  }

  // ── Invoices ──────────────────────────────────────────────────────────────
  if (sub === "/invoice/next" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const next = parseInt(b.next, 10);
    if (!next || next < 1 || next > 99999999) return error("Send a whole number, e.g. { next: 100 }", 400, env, request);
    const row = await env.DB.prepare("SELECT MAX(number) AS m FROM eng_invoices WHERE tenant_id=? AND username=?").bind(tid, me).first();
    if (row && row.m != null && next <= Number(row.m))
      return error("Your invoices are already up to number " + row.m + " — the next number must be higher.", 400, env, request);
    (cfg.byUser[me] || (cfg.byUser[me] = {})).nextNumber = next;
    await saveCfg(env, tid, cfg);
    return json({ ok: true, next }, {}, env, request);
  }

  if (sub === "/invoice" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!isDateStr(b.week)) return error("week required", 400, env, request);
    const monday = mondayOf(b.week);
    const u = await userRow(env, tid, me);
    if (!isSelfEmployed(u)) return error("Invoices are only for self-employed engineers.", 403, env, request);
    const existing = await invoiceFor(env, tid, me, monday);
    if (existing) return error("Invoice " + existing.number + " already exists for this week.", 409, env, request);
    // A rate sent with the request is remembered (first-time setup).
    if (b.rate != null) { const n = parseFloat(b.rate); if (isFinite(n) && n > 0) {
      const mine = cfg.byUser[me] || (cfg.byUser[me] = {}); mine.rate = n;
      if (b.rateType === "day" || b.rateType === "hour") mine.rateType = b.rateType;
      await saveCfg(env, tid, cfg);
    }}
    const eff = effectiveCfg(cfg, u);
    if (!eff.rate) return error("No pay rate set — enter your rate first.", 400, env, request);
    const { days } = await loadWeek(env, tid, me, monday);
    const totals = weekTotals(days, eff);
    if (!totals.daysWorked && !totals.miles) return error("Nothing on this week's timesheet yet — save your times first.", 400, env, request);
    const number = await nextInvoiceNumber(env, tid, me, eff);
    const pdf = buildInvoicePdf({ number, name: displayName(u), details: eff.details,
      company: cfg.defaults.company, monday, days, eff, totals });
    const key = `${INV_PREFIX(tid)}${encodeURIComponent(me)}/INV-${number}-${monday}.pdf`;
    await env.JOB_FILES.put(key, pdf, { httpMetadata: { contentType: "application/pdf" },
      customMetadata: { by: me, number: String(number), week: monday, at: new Date().toISOString() } });
    await env.DB.prepare(
      "INSERT INTO eng_invoices (tenant_id, username, number, week, hours, miles, labour, mileage, total, r2_key, at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(tid, me, number, monday, totals.hours, totals.miles, totals.labour, totals.mileagePay, totals.total, key, new Date().toISOString()).run();
    return json({ ok: true, number, total: totals.total,
      url: await signedFileUrl(env, url.origin, "/ts/invoice-file", key) }, {}, env, request);
  }

  if (sub === "/invoices" && method === "GET") {
    const admin = await isTsAdmin(env, tid, sess);
    const who = q.get("u");
    let stmt;
    if (who && admin && who !== "all") stmt = env.DB.prepare("SELECT * FROM eng_invoices WHERE tenant_id=? AND username=? ORDER BY at DESC LIMIT 200").bind(tid, who);
    else if (who === "all" && admin) stmt = env.DB.prepare("SELECT * FROM eng_invoices WHERE tenant_id=? ORDER BY at DESC LIMIT 400").bind(tid);
    else stmt = env.DB.prepare("SELECT * FROM eng_invoices WHERE tenant_id=? AND username=? ORDER BY at DESC LIMIT 200").bind(tid, me);
    const { results } = await stmt.all();
    const invoices = [];
    for (const r of results || []) invoices.push({
      id: r.id, username: r.username, number: r.number, week: r.week, hours: r.hours, miles: r.miles,
      labour: r.labour, mileage: r.mileage, total: r.total, at: r.at,
      url: await signedFileUrl(env, url.origin, "/ts/invoice-file", r.r2_key) });
    return json({ ok: true, invoices }, {}, env, request);
  }

  if (sub === "/invoice/delete" && method === "POST") {
    if (!(await isTsAdmin(env, tid, sess))) return error("Forbidden", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const row = await env.DB.prepare("SELECT * FROM eng_invoices WHERE tenant_id=? AND id=?").bind(tid, Number(b.id)).first();
    if (!row) return error("Invoice not found", 404, env, request);
    await env.DB.prepare("DELETE FROM eng_invoices WHERE tenant_id=? AND id=?").bind(tid, row.id).run();
    try { await env.JOB_FILES.delete(row.r2_key); } catch {}
    return json({ ok: true, deleted: row.number, username: row.username }, {}, env, request);
  }

  // ── Admin ─────────────────────────────────────────────────────────────────
  if (sub.startsWith("/admin/")) {
    if (!(await isTsAdmin(env, tid, sess))) return error("Forbidden", 403, env, request);

    if (sub === "/admin/overview" && method === "GET") {
      const monday = mondayOf(isDateStr(q.get("week")) ? q.get("week") : new Date().toISOString().slice(0, 10));
      const { results: users } = await env.DB.prepare(
        "SELECT username, first_name, last_name, employment_type, profile FROM users WHERE tenant_id=? AND status='Active' ORDER BY username"
      ).bind(tid).all();
      const { results: rows } = await env.DB.prepare("SELECT username, data, at FROM eng_timesheets WHERE tenant_id=? AND week=?").bind(tid, monday).all();
      const { results: invs } = await env.DB.prepare("SELECT * FROM eng_invoices WHERE tenant_id=? AND week=?").bind(tid, monday).all();
      const dataBy = {}; for (const r of rows || []) { try { dataBy[r.username] = { days: JSON.parse(r.data).days || {}, at: r.at }; } catch {} }
      const invBy = {}; for (const r of invs || []) invBy[r.username] = r;
      const out = [];
      for (const u of users || []) {
        const eff = effectiveCfg(cfg, u);
        const d = dataBy[u.username] || { days: {}, at: null };
        // Job-status time capture fills gaps the engineer hasn't typed over,
        // so the admin sees captured days even before the engineer opens
        // their timesheet.
        try {
          const auto = await jobTimeAuto(env, tid, u.username, monday);
          for (const [date, a] of Object.entries(auto)) {
            const day = d.days[date] = d.days[date] || {};
            if (!day.start && a.start) day.start = a.start;
            if (!day.finish && a.finish) day.finish = a.finish;
            const have = String(day.jobs || "").toLowerCase();
            const extra = a.jobs.map(j => j.ref).filter(rf => !have.includes(String(rf).toLowerCase()));
            if (extra.length) day.jobs = [day.jobs, extra.join(", ")].filter(Boolean).join(", ");
          }
        } catch {}
        const inv = invBy[u.username];
        const perDay = {};
        for (const [date, day] of Object.entries(d.days)) perDay[date] = { ...dayCalc(day, eff), start: day.start, finish: day.finish, jobs: day.jobs, note: day.note, mileage: day.mileage || [] };
        out.push({ username: u.username, name: displayName(u), employment: u.employment_type || "Employed",
          selfEmployed: isSelfEmployed(u), cfg: { commute: eff.commute, lunch: eff.lunch, mileage: eff.mileage, rate: eff.rate, rateType: eff.rateType, pencePerMile: eff.pencePerMile },
          days: d.days, perDay, savedAt: d.at, totals: weekTotals(d.days, eff),
          invoice: inv ? { id: inv.id, number: inv.number, total: inv.total, at: inv.at,
            url: await signedFileUrl(env, url.origin, "/ts/invoice-file", inv.r2_key) } : null });
      }
      return json({ ok: true, week: monday, days: weekDays(monday), users: out }, {}, env, request);
    }

    if (sub === "/admin/save" && method === "POST") {
      const b = await request.json().catch(() => ({}));
      if (!b.username || !isDateStr(b.week)) return error("username and week required", 400, env, request);
      const monday = mondayOf(b.week);
      if (await invoiceFor(env, tid, b.username, monday))
        return error("That week is invoiced — delete the invoice first if it needs correcting.", 409, env, request);
      const days = cleanDays(monday, b.days);
      await env.DB.prepare(
        "INSERT INTO eng_timesheets (tenant_id, week, username, data, at) VALUES (?,?,?,?,?) ON CONFLICT(tenant_id, week, username) DO UPDATE SET data=excluded.data, at=excluded.at"
      ).bind(tid, monday, b.username, JSON.stringify({ days }), new Date().toISOString()).run();
      return json({ ok: true }, {}, env, request);
    }

    if (sub === "/admin/config" && method === "GET") {
      const { results: users } = await env.DB.prepare(
        "SELECT username, first_name, last_name, employment_type, profile FROM users WHERE tenant_id=? AND status='Active' ORDER BY username"
      ).bind(tid).all();
      return json({ ok: true, defaults: cfg.defaults, byUser: cfg.byUser,
        users: (users || []).map(u => ({ username: u.username, name: displayName(u),
          employment: u.employment_type || "Employed", selfEmployed: isSelfEmployed(u),
          effective: effectiveCfg(cfg, u) })) }, {}, env, request);
    }

    if (sub === "/admin/config" && method === "POST") {
      const b = await request.json().catch(() => ({}));
      if (b.defaults && typeof b.defaults === "object") cfg.defaults = Object.assign({ ...DEFAULTS }, cfg.defaults, b.defaults);
      if (b.byUser && typeof b.byUser === "object") {
        for (const [u, v] of Object.entries(b.byUser)) {
          if (v === null) { delete cfg.byUser[u]; continue; }
          const mine = cfg.byUser[u] || (cfg.byUser[u] = {});
          for (const k of ["commute", "lunch", "mileage", "radius"]) if (k in v) mine[k] = v[k] === true;
          for (const k of ["commuteMins", "lunchMins", "lunchThresholdH", "pencePerMile", "rate", "nextNumber", "radiusMiles"]) {
            if (k in v) { const n = parseFloat(v[k]); if (isFinite(n) && n >= 0) mine[k] = n; else delete mine[k]; }
          }
          if ("rateType" in v && (v.rateType === "hour" || v.rateType === "day")) mine.rateType = v.rateType;
          if ("homePostcode" in v) mine.homePostcode = String(v.homePostcode || "").toUpperCase().slice(0, 10);
          if ("details" in v) mine.details = (Array.isArray(v.details) ? v.details : String(v.details || "").split(/\n/))
            .map(s => String(s).trim()).filter(Boolean).slice(0, 5);
        }
      }
      await saveCfg(env, tid, cfg);
      return json({ ok: true }, {}, env, request);
    }
  }

  return error("Unknown timesheet route: " + sub, 404, env, request);
}
