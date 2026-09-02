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
import { approvedLeaveInRange, bankHolidaysInRange } from "./holidays.js";
import { sendToUser } from "./push.js";

// Approved leave for a Mon–Sun week as { "YYYY-MM-DD": {type, half} } for one
// user — an approved holiday auto-shows on the timesheet without any entry.
async function holidayDaysFor(env, tid, username, monday) {
  const end = weekDays(monday)[6];
  const map = await approvedLeaveInRange(env, tid, monday, end, username);
  return map[username] || {};
}

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
  // Office approval: a locked, engineer-read-only week + an office note.
  try { await env.DB.prepare("ALTER TABLE eng_timesheets ADD COLUMN approved_at TEXT").run(); } catch {}
  try { await env.DB.prepare("ALTER TABLE eng_timesheets ADD COLUMN approved_by TEXT").run(); } catch {}
  try { await env.DB.prepare("ALTER TABLE eng_timesheets ADD COLUMN admin_note TEXT").run(); } catch {}
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
  // Ledger columns (costing.js): travel-vs-onsite split + auto-close tag.
  try { await env.DB.prepare("ALTER TABLE job_time_segments ADD COLUMN kind TEXT").run(); } catch {}
  try { await env.DB.prepare("ALTER TABLE job_time_segments ADD COLUMN auto_closed INTEGER").run(); } catch {}
  // 'timesheet' marks a segment materialised from an engineer's submitted per-job
  // hours (it replaces the status-tap capture for that engineer/job/day).
  try { await env.DB.prepare("ALTER TABLE job_time_segments ADD COLUMN source TEXT").run(); } catch {}
  // Site register archived flag (costing.js) — read by /ts/sites suggestions.
  try { await env.DB.prepare("ALTER TABLE sites ADD COLUMN archived INTEGER DEFAULT 0").run(); } catch {}
  // Google-computed drive-home minutes for the day (overwritten on each job
  // completion); used as the timesheet finish when the engineer doesn't End Day.
  try { await env.DB.prepare("ALTER TABLE shifts ADD COLUMN home_drive_mins INTEGER").run(); } catch {}
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
    const DONE = new Set(["complete", "closed", "invoiced"]);   // finished statuses
    if (TS_ACTIVE.has(as)) {
      // one clock at a time: starting this job ends any other open segment
      await env.DB.prepare(
        "UPDATE job_time_segments SET ended_at=? WHERE tenant_id=? AND username=? AND ended_at IS NULL AND job_id!=?"
      ).bind(now, tid, actor, String(after.id)).run();
      // Travelling and In Progress are separate segments (travel vs on-site
      // costing) — a status flip on the SAME job closes the old kind first.
      const kind = as === "travelling" ? "travel" : "onsite";
      const open = await env.DB.prepare(
        "SELECT id, kind FROM job_time_segments WHERE tenant_id=? AND username=? AND job_id=? AND ended_at IS NULL"
      ).bind(tid, actor, String(after.id)).first();
      if (open && (open.kind || "onsite") !== kind) {
        await env.DB.prepare("UPDATE job_time_segments SET ended_at=? WHERE id=? AND tenant_id=?")
          .bind(now, open.id, tid).run();
      }
      if (!open || (open.kind || "onsite") !== kind) await env.DB.prepare(
        "INSERT INTO job_time_segments (tenant_id, username, job_id, job_ref, site, postcode, started_at, kind) VALUES (?,?,?,?,?,?,?,?)"
      ).bind(tid, actor, String(after.id), after.helpdeskRef || String(after.id),
        after.siteName || "", String(after.postcode || "").toUpperCase(), now, kind).run();
    } else {
      const res = await env.DB.prepare(
        "UPDATE job_time_segments SET ended_at=? WHERE tenant_id=? AND username=? AND job_id=? AND ended_at IS NULL"
      ).bind(now, tid, actor, String(after.id)).run();
      const closed = !!(res && res.meta && res.meta.changes > 0);
      // COMPLETION-ONLY engineers: they "Start Day" then just mark each job
      // Complete (never tap Travelling/In Progress), so there's no open segment
      // to close. Infer this job's time as the gap since their last activity —
      // the previous job's finish, else today's shift clock-on — so their hours
      // and per-job costing still fill in. Only for genuinely finished statuses.
      if (!closed && DONE.has(as)) {
        const dayStart = now.slice(0, 10) + "T00:00:00.000Z", dayEnd = now.slice(0, 10) + "T23:59:59.999Z";
        const exists = await env.DB.prepare(
          "SELECT 1 FROM job_time_segments WHERE tenant_id=? AND username=? AND job_id=? AND started_at>=? AND started_at<=? LIMIT 1"
        ).bind(tid, actor, String(after.id), dayStart, dayEnd).first();
        if (!exists) {
          const last = await env.DB.prepare(
            "SELECT MAX(ended_at) AS e FROM job_time_segments WHERE tenant_id=? AND username=? AND ended_at IS NOT NULL AND started_at>=? AND started_at<=?"
          ).bind(tid, actor, dayStart, dayEnd).first();
          let anchor = last && last.e ? last.e : null;
          if (!anchor) {
            const sh = await env.DB.prepare("SELECT clock_on_at FROM shifts WHERE tenant_id=? AND username=? AND date=?")
              .bind(tid, actor, now.slice(0, 10)).first().catch(() => null);
            if (sh && sh.clock_on_at) anchor = sh.clock_on_at;
          }
          if (anchor) {
            const span = Date.parse(now) - Date.parse(anchor);
            if (span > 60000 && span <= MAX_SEG_MS) await env.DB.prepare(
              "INSERT INTO job_time_segments (tenant_id, username, job_id, job_ref, site, postcode, started_at, ended_at, kind, source) VALUES (?,?,?,?,?,?,?,?,?,?)"
            ).bind(tid, actor, String(after.id), after.helpdeskRef || String(after.id),
              after.siteName || "", String(after.postcode || "").toUpperCase(), anchor, now, "onsite", "shift").run();
          }
        }
      }
    }
    // On EVERY completion, (re)compute the Google drive time from this job home
    // and store it on today's shift — overwritten each job, since any completion
    // could be their last. Used as the timesheet finish when they don't End Day.
    if (DONE.has(as)) {
      const sh = await env.DB.prepare("SELECT clock_on_at, clock_off_at FROM shifts WHERE tenant_id=? AND username=? AND date=?")
        .bind(tid, actor, now.slice(0, 10)).first().catch(() => null);
      if (sh && sh.clock_on_at && !sh.clock_off_at && after.postcode) {
        const homePc = await homePostcodeFor(env, tid, actor);
        if (homePc) {
          let mins = await driveMinutesGoogle(env, after.postcode, homePc);
          if (mins == null) { try { const [a, b] = await Promise.all([lookupPostcode(after.postcode), lookupPostcode(homePc)]); if (a && b) mins = Math.round(haversineMiles(a, b) * ROAD_FACTOR / 30 * 60); } catch {} }
          if (mins != null && mins >= 0 && mins < 300)
            await env.DB.prepare("UPDATE shifts SET home_drive_mins=? WHERE tenant_id=? AND username=? AND date=?").bind(mins, tid, actor, now.slice(0, 10)).run();
        }
      }
    }
  } catch { /* time capture must never break a job update */ }
}

// The captured week for one user, folded to per-London-day windows:
// { "YYYY-MM-DD": { start, finish|null, open, jobs:[{ref,site,postcode}] } }.
// A segment left open on an earlier day is lazily closed at 19:00 that day
// (or an hour after it started, if it started later than that).
const MAX_SEG_MS = 14 * 3600e3; // a session longer than a long shift = forgotten status change → clamp
async function jobTimeAuto(env, tid, username, monday, opts = {}) {
  const endD = new Date(monday + "T12:00:00Z"); endD.setUTCDate(endD.getUTCDate() + 7);
  const end = endD.toISOString().slice(0, 10);
  const lDate = iso => { try { return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Europe/London" }); } catch { return String(iso).slice(0, 10); } };
  const lTime = iso => { try { return new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour12: false, hour: "2-digit", minute: "2-digit" }); } catch { return ""; } };
  const out = {};
  try {
    const { results } = await env.DB.prepare(
      "SELECT * FROM job_time_segments WHERE tenant_id=? AND username=? AND started_at>=? AND started_at<? AND (source IS NULL OR source!='timesheet') ORDER BY started_at"
    ).bind(tid, username, monday, end).all();
    const today = lDate(new Date().toISOString());
    for (const seg of results || []) {
      const date = lDate(seg.started_at);
      let endedAt = seg.ended_at, open = false;
      const forgotClose = () => {   // close at ~19:00 that day (or start+1h)
        const cut = new Date(seg.started_at); cut.setHours(cut.getHours() + 1);
        const sevenPm = new Date(date + "T18:00:00Z");   // ≈19:00 London summer / 18:00 winter — a fallback
        return (cut > sevenPm ? cut : sevenPm).toISOString();
      };
      if (!endedAt) {
        if (date < today) {
          endedAt = forgotClose();
          // auto_closed marks it for the exceptions list ("never finished the job")
          try { await env.DB.prepare("UPDATE job_time_segments SET ended_at=?, auto_closed=1 WHERE id=? AND tenant_id=?").bind(endedAt, seg.id, tid).run(); } catch {}
        } else { open = true; }
      } else if (Date.parse(endedAt) - Date.parse(seg.started_at) > MAX_SEG_MS) {
        // Closed only when the NEXT job was tapped days later → a forgotten
        // status change. Clamp so one stale session can't span days (would
        // otherwise show a wild finish time and inflate pay/costing).
        endedAt = forgotClose();
        try { await env.DB.prepare("UPDATE job_time_segments SET ended_at=?, auto_closed=1 WHERE id=? AND tenant_id=?").bind(endedAt, seg.id, tid).run(); } catch {}
      }
      const o = out[date] = out[date] || { s: Infinity, e: 0, open: false, jobs: [], lastPc: "" };
      o.s = Math.min(o.s, Date.parse(seg.started_at));
      if (open) { o.open = true; }
      else { const em = Date.parse(endedAt); if (em >= o.e) { o.e = em; o.lastPc = seg.postcode || ""; } }
      const ref = seg.job_ref || seg.job_id;
      if (!o.jobs.some(j => j.ref.toLowerCase() === String(ref).toLowerCase()))
        o.jobs.push({ ref, site: seg.site || "", postcode: seg.postcode || "" });
    }
  } catch {}
  // "Start Day" / "End Day" shifts are the authoritative day boundaries when set.
  const shifts = {};
  try {
    const { results } = await env.DB.prepare(
      "SELECT date, clock_on_at, clock_off_at, home_drive_mins FROM shifts WHERE tenant_id=? AND username=? AND date>=? AND date<?"
    ).bind(tid, username, monday, end).all();
    for (const s of results || []) { const dt = s.clock_on_at ? lDate(s.clock_on_at) : s.date; if (dt) shifts[dt] = s; }
  } catch {}
  const homePc = normPc(opts.homePostcode || "");
  let homeCoord;   // resolved lazily, once
  const getHome = async () => { if (homeCoord !== undefined) return homeCoord; homeCoord = homePc ? await lookupPostcode(homePc).catch(() => null) : null; return homeCoord; };

  const shaped = {};
  for (const date of new Set([...Object.keys(out), ...Object.keys(shifts)])) {
    const o = out[date], sh = shifts[date];
    let start = o ? lTime(new Date(o.s).toISOString()) : "";
    if (sh && sh.clock_on_at) { const cs = lTime(sh.clock_on_at); if (cs && (!start || cs < start)) start = cs; }   // Start Day = real start
    let finish = null, open = false, travelHome = false;
    if (sh && sh.clock_off_at) {
      finish = lTime(sh.clock_off_at);   // End Day = real finish
    } else if (o) {
      if (o.open || !o.e) open = true;
      else {
        finish = lTime(new Date(o.e).toISOString());
        // No End Day → add drive home. Prefer the Google minutes captured at the
        // last job completion (shift.home_drive_mins); else compute via Google
        // now; last resort only, a straight-line estimate.
        let mins = (sh && sh.home_drive_mins != null) ? Number(sh.home_drive_mins) : null;
        if (mins == null && o.lastPc && homePc) mins = await driveMinutesGoogle(env, o.lastPc, homePc);
        if (mins == null && o.lastPc && homePc) {
          try { const [a, b] = await Promise.all([lookupPostcode(o.lastPc), getHome()]); if (a && b) mins = Math.round(haversineMiles(a, b) * ROAD_FACTOR / 30 * 60); } catch {}
        }
        if (mins != null && mins > 0 && mins < 300) { finish = lTime(new Date(o.e + mins * 60000).toISOString()); travelHome = true; }
      }
    }
    shaped[date] = { start, finish, open, jobs: o ? o.jobs : [], travelHome };
  }
  return shaped;
}
const normKey = s => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

// Minutes captured (status-tap, closed segments — NOT timesheet ones) per
// job_id + London-day for one user, over the week. Pre-fills the hours boxes.
async function capturedMinsWeek(env, tid, username, monday) {
  const endD = new Date(monday + "T12:00:00Z"); endD.setUTCDate(endD.getUTCDate() + 8);
  const end = endD.toISOString().slice(0, 10);
  const lDate = iso => { try { return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Europe/London" }); } catch { return String(iso || "").slice(0, 10); } };
  const cap = {};
  try {
    const { results } = await env.DB.prepare(
      "SELECT job_id, started_at, ended_at FROM job_time_segments WHERE tenant_id=? AND username=? AND started_at>=? AND started_at<? AND ended_at IS NOT NULL AND (source IS NULL OR source!='timesheet')"
    ).bind(tid, username, monday, end).all();
    for (const s of results || []) {
      const mins = Math.min(MAX_SEG_MS, Math.max(0, Date.parse(s.ended_at) - Date.parse(s.started_at))) / 60000;
      const k = s.job_id + "|" + lDate(s.started_at);
      cap[k] = (cap[k] || 0) + mins;
    }
  } catch {}
  return cap;
}

// ref/site labels for every job id referenced by a week's jobHours — so a job
// the engineer ADDED (not one they were booked on) still renders on reload.
async function jobMetaFor(env, tid, days) {
  const ids = new Set();
  for (const d of Object.values(days || {})) for (const jid of Object.keys((d && d.jobHours) || {})) ids.add(jid);
  const meta = {};
  const arr = [...ids].slice(0, 200);
  if (!arr.length) return meta;
  try {
    const ph = arr.map(() => "?").join(",");
    const { results } = await env.DB.prepare(`SELECT id, helpdesk_ref, site_code, data FROM sla_jobs WHERE tenant_id=? AND id IN (${ph})`).bind(tid, ...arr).all();
    for (const r of results || []) {
      let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {}
      const ref = r.helpdesk_ref || d.helpdeskRef || r.id;
      const site = d.siteName || r.site_code || "";
      meta[r.id] = { ref, site, label: ref + (site ? " — " + site : "") };
    }
  } catch {}
  return meta;
}

// Materialise submitted per-job hours into the labour ledger. Each (day, job)
// with hours becomes a `source='timesheet'` segment; it REPLACES the status-tap
// segments for that engineer/job/day, so costing reads the engineer's figure and
// never double-counts. Idempotent: the week's timesheet segments are rebuilt.
async function materialiseTimesheet(env, tid, username, monday, days) {
  const endD = new Date(monday + "T12:00:00Z"); endD.setUTCDate(endD.getUTCDate() + 7);
  const end = endD.toISOString().slice(0, 10);
  // Clear this user's timesheet segments for the week, then rebuild from `days`.
  try { await env.DB.prepare("DELETE FROM job_time_segments WHERE tenant_id=? AND username=? AND source='timesheet' AND started_at>=? AND started_at<?").bind(tid, username, monday, end).run(); } catch {}
  for (const [date, d] of Object.entries(days || {})) {
    const jh = (d && d.jobHours && typeof d.jobHours === "object") ? d.jobHours : {};
    for (const [jobId, hrs] of Object.entries(jh)) {
      const h = Math.max(0, Math.min(24, parseFloat(hrs) || 0));
      if (!(h > 0) || !jobId) continue;
      let ref = jobId, site = "";
      try {
        const row = await env.DB.prepare("SELECT helpdesk_ref, site_code, data FROM sla_jobs WHERE tenant_id=? AND id=?").bind(tid, jobId).first();
        if (row) { ref = row.helpdesk_ref || jobId; let dd = {}; try { dd = JSON.parse(row.data || "{}"); } catch {} site = dd.siteName || row.site_code || ""; }
      } catch {}
      const startISO = date + "T09:00:00.000Z";
      const endISO = new Date(Date.parse(startISO) + Math.round(h * 60) * 60000).toISOString();
      // Replace the status-tap capture for this engineer/job/day.
      try { await env.DB.prepare("DELETE FROM job_time_segments WHERE tenant_id=? AND username=? AND job_id=? AND (source IS NULL OR source!='timesheet') AND started_at>=? AND started_at<?").bind(tid, username, jobId, date + "T00:00:00Z", date + "T23:59:59Z").run(); } catch {}
      try { await env.DB.prepare("INSERT INTO job_time_segments (tenant_id, username, job_id, job_ref, site, postcode, started_at, ended_at, kind, source) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(tid, username, jobId, ref, site, "", startISO, endISO, "onsite", "timesheet").run(); } catch {}
    }
  }
}

// ── Settings (app_config JSON, per-user overrides on shared defaults) ────────
const DEFAULTS = { commuteMins: 30, lunchMins: 30, lunchThresholdH: 6, pencePerMile: 45,
  radiusMiles: 10, overtimeThresholdH: 8, dueDow: 3, dueTime: "12:00", remindersOn: true,
  basePostcode: "PO15 5RQ", company: "Mostlane" };
// Timesheet reminders are ON unless explicitly turned off in Settings.
const remindersEnabled = cfg => !(cfg && cfg.defaults && cfg.defaults.remindersOn === false);
async function hasEngTimesheet(env, tid, username) {
  try { const p = await permissionsFor(env, tid, username); return p.EngTimesheet === "Yes"; } catch { return false; }
}
const DOW_NAME = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
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
    // Overtime: a multiplier of the normal HOURLY rate, applied to hours over the
    // daily threshold. Only for hourly staff (day-rate excluded) with a mult set.
    overtimeMult: num(mine.overtimeMult),
    overtimeThresholdH: Number(mine.overtimeThresholdH ?? cfg.defaults.overtimeThresholdH) || 8,
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
    // Per-job hours the engineer entered (drives job costing). { jobId: hours }.
    const jobHours = {};
    if (d.jobHours && typeof d.jobHours === "object") {
      for (const [jid, hrs] of Object.entries(d.jobHours)) {
        const h = Math.max(0, Math.min(24, round1(parseFloat(hrs) || 0)));
        if (h > 0 && jid) jobHours[String(jid).slice(0, 80)] = h;
      }
    }
    const hasHours = Object.keys(jobHours).length > 0;
    // Admin-entered paid hours for a leave / bank-holiday / shutdown day (so every
    // day carries a value). null when not set (blocks approval on those days).
    let leaveHours = null;
    if (d.leaveHours !== undefined && d.leaveHours !== null && d.leaveHours !== "") {
      const lh = parseFloat(d.leaveHours);
      if (isFinite(lh) && lh >= 0) leaveHours = Math.min(24, round1(lh));
    }
    const hasLeave = leaveHours !== null;
    if (start || finish || jobs || note || mileage.length || hasHours || hasLeave)
      out[date] = { start, finish, jobs, note, mileage, ...(hasHours ? { jobHours } : {}), ...(hasLeave ? { leaveHours } : {}) };
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
  const r2 = n => Math.round(n * 100) / 100;
  // Overtime: hours over the DAILY threshold, paid at rate × multiplier. Only for
  // hourly staff with a multiplier set (day-rate is excluded).
  const otOn = eff.rateType !== "day" && eff.overtimeMult > 0;
  const thrMin = (eff.overtimeThresholdH || 8) * 60;
  let paidMins = 0, otMins = 0, leaveMins = 0, miles = 0, milesClaimed = 0, daysWorked = 0;
  for (const d of Object.values(days || {})) {
    const c = dayCalc(d, eff);
    paidMins += c.paid; miles += c.miles; milesClaimed += c.milesClaimed;
    if (c.worked) daysWorked++;
    if (otOn && c.paid > thrMin) otMins += c.paid - thrMin;
    if (d && d.leaveHours != null) leaveMins += (parseFloat(d.leaveHours) || 0) * 60;   // admin-entered paid leave
  }
  const hours = r2(paidMins / 60);
  const otHours = r2(otMins / 60);
  const leaveHours = r2(leaveMins / 60);
  const normalHours = r2((paidMins - otMins) / 60);
  const otRate = otOn && eff.rate ? r2(eff.rate * eff.overtimeMult) : null;
  let labour = null, otPay = 0, normalPay = 0, leavePay = 0;
  if (eff.rate) {
    // Paid leave hours are costed at the normal hourly rate (the office enters 0
    // for anyone who isn't paid for that day, e.g. self-employed holiday).
    leavePay = eff.rateType === "day" ? 0 : leaveHours * eff.rate;
    if (eff.rateType === "day") { labour = r2(daysWorked * eff.rate); }
    else {
      normalPay = normalHours * eff.rate;
      otPay = otHours * (otRate || eff.rate);
      labour = r2(normalPay + otPay + leavePay);
    }
  }
  const mileagePay = Math.round(milesClaimed * eff.pencePerMile) / 100;
  return { paidMins, hours, normalHours, otHours, otRate, otPay: r2(otPay), normalPay: r2(normalPay),
    leaveHours, leavePay: r2(leavePay),
    miles: round1(miles), milesClaimed: round1(milesClaimed),
    milesDeducted: round1(miles - milesClaimed), daysWorked, labour, mileagePay,
    total: labour != null ? r2(labour + mileagePay) : null };
}
// Which days in a week REQUIRE an admin paid-hours entry before approval: an
// approved Holiday/Other or a Bank Holiday / Company Shutdown, UNLESS the person
// actually worked that day (then it's logged by worked hours). Unpaid leave is
// auto-0 and never blocks. Returns [{date,label}] still missing a leaveHours value.
async function missingLeaveHours(env, tid, username, monday, days) {
  const from = monday, to = weekDays(monday)[6];
  const leave = (await approvedLeaveInRange(env, tid, from, to, username))[username] || {};
  const bank = await bankHolidaysInRange(env, tid, from, to);
  const out = [];
  for (const date of weekDays(monday)) {
    const d = days[date] || {};
    const worked = toMin(d.start) != null && toMin(d.finish) != null;
    if (worked) continue;                       // a worked day is already logged
    if (d.leaveHours != null) continue;         // already entered
    const lv = leave[date];
    const bh = bank[date];
    let label = "";
    if (lv && lv.type !== "Unpaid") label = lv.type === "Other" ? "Leave" : "Holiday";
    else if (bh) label = bh.kind === "shutdown" ? "Company Shutdown" : "Bank Holiday";
    if (label) out.push({ date, label });
  }
  return out;
}
async function loadWeek(env, tid, username, monday) {
  const row = await env.DB.prepare("SELECT data, at, approved_at, approved_by, admin_note FROM eng_timesheets WHERE tenant_id=? AND week=? AND username=?")
    .bind(tid, monday, username).first();
  let days = {}; try { days = row && row.data ? (JSON.parse(row.data).days || {}) : {}; } catch {}
  return { days, savedAt: row ? row.at : null,
    approval: (row && row.approved_at) ? { at: row.approved_at, by: row.approved_by || "", note: row.admin_note || "" } : null };
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
export async function poOrderSiteNames(env) {
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

// Google-driven drive TIME (minutes) between two postcodes via Distance Matrix,
// WITH LIVE TRAFFIC (departure_time=now → duration_in_traffic). We call this at
// the moment a job is completed — i.e. when the engineer would set off home — so
// the traffic reading is real. NOT edge-cached (traffic is live). Falls back to
// the free-flow duration, then null (caller decides the last-resort estimate).
async function driveMinutesGoogle(env, fromPc, toPc) {
  const key = env && env.GOOGLE_MAPS_KEY; if (!key) return null;
  const f = normPc(fromPc), t = normPc(toPc); if (!f || !t) return null;
  try {
    const [a, b] = await Promise.all([lookupPostcode(f), lookupPostcode(t)]);
    if (!a || !b) return null;
    const u = "https://maps.googleapis.com/maps/api/distancematrix/json?mode=driving"
      + "&departure_time=now&traffic_model=best_guess"
      + "&origins=" + a.lat + "," + a.lng + "&destinations=" + b.lat + "," + b.lng
      + "&key=" + encodeURIComponent(key);
    const r = await fetch(u);   // no cf cache — a live-traffic reading must be fresh
    const j = await r.json().catch(() => null);
    const el = j && j.rows && j.rows[0] && j.rows[0].elements && j.rows[0].elements[0];
    if (el && el.status === "OK") {
      const secs = (el.duration_in_traffic && el.duration_in_traffic.value != null)
        ? el.duration_in_traffic.value
        : (el.duration && el.duration.value != null ? el.duration.value : null);
      if (secs != null) return Math.round(secs / 60);
    }
  } catch {}
  return null;
}
// The engineer's home postcode: their timesheet override first, else their profile.
async function homePostcodeFor(env, tid, username) {
  try {
    const row = await env.DB.prepare("SELECT value FROM app_config WHERE key=?").bind(CFG_KEY(tid)).first();
    if (row && row.value) { const v = JSON.parse(row.value); const mine = (v.byUser && v.byUser[username]) || {}; if (mine.homePostcode) return String(mine.homePostcode); }
  } catch {}
  try {
    const u = await env.DB.prepare("SELECT profile FROM users WHERE tenant_id=? AND username=?").bind(tid, username).first();
    if (u && u.profile) { const p = JSON.parse(u.profile); if (p.homePostcode) return String(p.homePostcode); }
  } catch {}
  return "";
}

// ── Door-to-door mileage (fuel-paid self-employed) ───────────────────────────
// Exact road miles per consecutive leg via Google Distance Matrix. points is an
// ordered [{lat,lng}]; returns [{miles,src}] for each leg points[i]→points[i+1]
// (the matrix diagonal in ONE request). Falls back to haversine×ROAD_FACTOR per
// leg when there's no GOOGLE_MAPS_KEY or the call fails, so it always returns a
// figure. Edge-cached — postcodes/roads don't move.
async function legMiles(env, points) {
  const legs = [];
  for (let i = 0; i < points.length - 1; i++)
    legs.push({ miles: round1(haversineMiles(points[i], points[i + 1]) * ROAD_FACTOR), src: "est" });
  const key = env && env.GOOGLE_MAPS_KEY;
  if (!key || points.length < 2 || points.length > 12) return legs;
  try {
    const origins = points.slice(0, -1).map(p => p.lat + "," + p.lng).join("|");
    const dests = points.slice(1).map(p => p.lat + "," + p.lng).join("|");
    const u = "https://maps.googleapis.com/maps/api/distancematrix/json?units=imperial&mode=driving"
      + "&origins=" + encodeURIComponent(origins) + "&destinations=" + encodeURIComponent(dests)
      + "&key=" + encodeURIComponent(key);
    const r = await fetch(u, { cf: { cacheTtl: 7 * 86400, cacheEverything: true } });
    const j = await r.json().catch(() => null);
    if (j && j.status === "OK" && Array.isArray(j.rows)) {
      for (let i = 0; i < legs.length; i++) {
        const el = j.rows[i] && j.rows[i].elements && j.rows[i].elements[i];
        if (el && el.status === "OK" && el.distance && el.distance.value != null)
          legs[i] = { miles: round1(el.distance.value / 1609.344), src: "google" };
      }
    }
  } catch {}
  return legs;
}

// Site/postcode/scheduled-time for every job the engineer entered hours against
// on a day (so a hand-added job can still be routed through by location).
async function jobsMetaForDay(env, tid, day) {
  const ids = Object.keys((day && day.jobHours) || {}).slice(0, 50);
  const meta = {};
  if (!ids.length) return meta;
  try {
    const ph = ids.map(() => "?").join(",");
    const { results } = await env.DB.prepare(
      `SELECT id, helpdesk_ref, site_code, scheduled_at, data FROM sla_jobs WHERE tenant_id=? AND id IN (${ph})`).bind(tid, ...ids).all();
    for (const r of results || []) {
      let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {}
      meta[r.id] = { ref: r.helpdesk_ref || d.helpdeskRef || r.id, site: d.siteName || r.site_code || "",
        pc: normPc(d.postcode || ""), sched: r.scheduled_at || "" };
    }
  } catch {}
  return meta;
}

// Ordered postcodes visited on one day, forming ONE chained route (never a
// round trip per job). Status-tap capture order first (jobTimeAuto = the real
// driving order), then any hand-entered jobHours jobs IN THE ORDER THE ENGINEER
// LISTED THEM on the timesheet (that's the order they drove them — a manually
// added job carries no scheduled time to sort by). Dupes (and consecutive
// same-site) collapsed; entries with no postcode dropped.
function visitedSequenceForDay(autoDay, day, jobsMeta) {
  const seq = [], seen = new Set();
  const push = (site, pc) => {
    pc = normPc(pc); if (!pc) return;
    if (seq.length && seq[seq.length - 1].pc === pc) return;
    if (seen.has(pc)) return;
    seq.push({ site: site || "", pc }); seen.add(pc);
  };
  const byRef = {}; for (const m of Object.values(jobsMeta || {})) if (m.ref) byRef[String(m.ref).toLowerCase()] = m;
  for (const j of (autoDay && autoDay.jobs) || []) {
    let pc = normPc(j.postcode);
    if (!pc) { const m = byRef[String(j.ref || "").toLowerCase()]; if (m) pc = m.pc; }
    push(j.site, pc);
  }
  // jobHours keys keep the engineer's entry order — that IS the route order.
  for (const jid of Object.keys((day && day.jobHours) || {})) {
    const m = jobsMeta && jobsMeta[jid];
    if (m && m.pc) push(m.site, m.pc);
  }
  return seq;
}

// The engineer's SCHEDULED jobs per London day (site + postcode, time-ordered) —
// the door-to-door FALLBACK for a worked day where nothing was status-tapped or
// logged, so an engineer who only enters start/finish still gets their mileage.
async function scheduledSitesForWeek(env, tid, username, monday) {
  const endD = new Date(monday + "T12:00:00Z"); endD.setUTCDate(endD.getUTCDate() + 7);
  const end = endD.toISOString().slice(0, 10);
  const byDate = {};
  try {
    const normId = s => String(s || "").toLowerCase().replace(/\s+/g, ".").trim();
    const norm = s => String(s || "").toLowerCase().replace(/[._]/g, " ").replace(/\s+/g, " ").trim();
    const map = {};
    const { results: users } = await env.DB.prepare("SELECT username, first_name, last_name FROM users WHERE tenant_id=?").bind(tid).all();
    for (const u of users || []) { map[normId(u.username)] = u.username; const full = ((u.first_name || "") + " " + (u.last_name || "")).trim(); if (full) map[normId(full)] = u.username; }
    const meN = norm(username);
    const isMe = e => { const r = map[normId(e)]; if (r != null) return r === username; const n = norm(e); return !!n && (n === meN || n.includes(meN) || meN.includes(n)); };
    const lDate = iso => { try { return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Europe/London" }); } catch { return String(iso).slice(0, 10); } };
    const { results } = await env.DB.prepare(
      "SELECT id, scheduled_at, data FROM sla_jobs WHERE tenant_id=? AND scheduled_at IS NOT NULL AND scheduled_at>=? AND scheduled_at<? LIMIT 500"
    ).bind(tid, monday, end).all();
    for (const r of results || []) {
      let d = {}; try { d = JSON.parse(r.data); } catch { continue; }
      const engs = (Array.isArray(d.assignedEngineers) && d.assignedEngineers.length) ? d.assignedEngineers : (d.assignedTo ? [d.assignedTo] : []);
      if (!engs.some(isMe)) continue;
      const date = lDate(r.scheduled_at);
      (byDate[date] = byDate[date] || []).push({ site: d.siteName || "", pc: normPc(d.postcode || ""), sched: r.scheduled_at });
    }
    for (const k of Object.keys(byDate)) byDate[k].sort((a, b) => String(a.sched || "").localeCompare(String(b.sched || "")));
  } catch {}
  return byDate;
}

// ── Timesheet deadline + completeness ────────────────────────────────────────
// London tz offset (minutes ahead of UTC) at a given instant.
function londonOffsetMinutes(ms) {
  try {
    const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
      .formatToParts(new Date(ms)).reduce((a, x) => (a[x.type] = x.value, a), {});
    const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    return Math.round((asUTC - ms) / 60000);
  } catch { return 0; }
}
// The completion deadline for a Mon-anchored week: the configured day-of-week +
// time in the FOLLOWING week (e.g. midday Wednesday after the week ends).
function tsDeadlineFor(monday, cfg) {
  const dow = Number((cfg.defaults && cfg.defaults.dueDow) ?? 3);           // 0 Sun..6 Sat
  const [hh, mm] = String((cfg.defaults && cfg.defaults.dueTime) || "12:00").split(":").map(n => parseInt(n, 10) || 0);
  const nextMon = new Date(monday + "T00:00:00Z"); nextMon.setUTCDate(nextMon.getUTCDate() + 7);
  const day = new Date(nextMon); day.setUTCDate(day.getUTCDate() + ((dow + 6) % 7));   // Mon=0..Sun=6
  const ds = day.toISOString().slice(0, 10);
  const naive = Date.parse(ds + "T" + String(hh).padStart(2, "0") + ":" + String(mm).padStart(2, "0") + ":00Z");
  const ms = naive - londonOffsetMinutes(naive) * 60000;
  return { ms, iso: new Date(ms).toISOString(), dow, hh, mm, label: DOW_NAME[dow] + " " + String(hh).padStart(2, "0") + ":" + String(mm).padStart(2, "0") };
}
// Jobs the engineer was scheduled on, per London day: { date: [{jobId, ref, site}] }.
async function assignedJobsByDay(env, tid, username, monday) {
  const endD = new Date(monday + "T12:00:00Z"); endD.setUTCDate(endD.getUTCDate() + 7);
  const end = endD.toISOString().slice(0, 10);
  const byDay = {};
  try {
    const normId = s => String(s || "").toLowerCase().replace(/\s+/g, ".").trim();
    const norm = s => String(s || "").toLowerCase().replace(/[._]/g, " ").replace(/\s+/g, " ").trim();
    const map = {};
    const { results: users } = await env.DB.prepare("SELECT username, first_name, last_name FROM users WHERE tenant_id=?").bind(tid).all();
    for (const u of users || []) { map[normId(u.username)] = u.username; const full = ((u.first_name || "") + " " + (u.last_name || "")).trim(); if (full) map[normId(full)] = u.username; }
    const meN = norm(username);
    const isMe = e => { const r = map[normId(e)]; if (r != null) return r === username; const n = norm(e); return !!n && (n === meN || n.includes(meN) || meN.includes(n)); };
    const lDate = iso => { try { return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Europe/London" }); } catch { return String(iso).slice(0, 10); } };
    const { results } = await env.DB.prepare(
      "SELECT id, helpdesk_ref, scheduled_at, data FROM sla_jobs WHERE tenant_id=? AND scheduled_at IS NOT NULL AND scheduled_at>=? AND scheduled_at<? LIMIT 500"
    ).bind(tid, monday, end).all();
    for (const r of results || []) {
      let d = {}; try { d = JSON.parse(r.data); } catch { continue; }
      const engs = (Array.isArray(d.assignedEngineers) && d.assignedEngineers.length) ? d.assignedEngineers : (d.assignedTo ? [d.assignedTo] : []);
      if (!engs.some(isMe)) continue;
      const date = lDate(r.scheduled_at);
      (byDay[date] = byDay[date] || []).push({ jobId: r.id, ref: r.helpdesk_ref || d.siteName || r.id, site: d.siteName || "" });
    }
  } catch {}
  return byDay;
}
// Which booked jobs still have NO hours entered for a week + the deadline state.
async function timesheetGaps(env, tid, username, monday, cfg) {
  const byDay = await assignedJobsByDay(env, tid, username, monday);
  const { days } = await loadWeek(env, tid, username, monday);
  const missing = [];
  for (const [date, jobs] of Object.entries(byDay)) {
    const jh = (days[date] && days[date].jobHours) || {};
    const seen = new Set();
    for (const j of jobs) {
      if (seen.has(j.jobId)) continue; seen.add(j.jobId);
      if (!(parseFloat(jh[j.jobId]) > 0)) missing.push({ date, ref: j.ref, jobId: j.jobId });
    }
  }
  const dl = tsDeadlineFor(monday, cfg);
  return { week: monday, missing, count: missing.length, dueAt: dl.iso, dueLabel: dl.label, overdue: Date.now() > dl.ms };
}
// Cron: push engineers with unfinished hours for last week, once, in the ~3h
// before the deadline (deduped per week in app_config ts:reminded:<tid>).
export async function sweepTimesheetReminders(env, tid = 1) {
  try {
    const cfg = await getCfg(env, tid);
    if (!remindersEnabled(cfg)) return;   // reminders switched off in Settings
    const curMon = mondayOf(new Date().toISOString().slice(0, 10));
    const pm = new Date(curMon + "T12:00:00Z"); pm.setUTCDate(pm.getUTCDate() - 7);
    const prevMon = pm.toISOString().slice(0, 10);
    const dl = tsDeadlineFor(prevMon, cfg);
    const nowMs = Date.now();
    if (nowMs < dl.ms - 3 * 3600e3 || nowMs > dl.ms) return;   // only the 3h run-up to the deadline
    const key = "ts:reminded:" + tid;
    let sent = [];
    try { const row = await env.DB.prepare("SELECT value FROM app_config WHERE key=?").bind(key).first(); if (row && row.value) sent = JSON.parse(row.value) || []; } catch {}
    if (sent.includes(prevMon)) return;
    const { results: users } = await env.DB.prepare("SELECT username FROM users WHERE tenant_id=? AND status='Active'").bind(tid).all();
    for (const u of users || []) {
      if (!(await hasEngTimesheet(env, tid, u.username))) continue;   // timesheet-permission engineers only
      const g = await timesheetGaps(env, tid, u.username, prevMon, cfg);
      if (g.count > 0) await sendToUser(env, tid, u.username, {
        title: "Timesheet due", body: g.count + " job" + (g.count === 1 ? "" : "s") + " still need hours — complete last week's timesheet by " + dl.label + ".",
        url: "/engineer-timesheet.html?week=" + prevMon, tag: "ts-due:" + prevMon
      });
    }
    sent.push(prevMon); sent = sent.slice(-8);
    await env.DB.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(tid, key, JSON.stringify(sent)).run();
  } catch {}
}

// For fuel-paid SELF-EMPLOYED engineers, replace each worked day's mileage with a
// single LOCKED door-to-door figure: office(base) → each site visited (in order)
// → home. Returns a working copy of `days` (manual mileage ignored) + a per-date
// breakdown for display. Anyone else → days unchanged, applies:false.
async function applyAutoMileage(env, tid, username, monday, days, eff, basePostcode) {
  if (!(eff.selfEmployed && eff.mileage)) return { days, auto: { applies: false } };
  const basePc = normPc(basePostcode || "PO15 5RQ");
  const homePc = normPc(eff.homePostcode || "") || basePc;
  const autoDays = await jobTimeAuto(env, tid, username, monday).catch(() => ({}));
  const sched = await scheduledSitesForWeek(env, tid, username, monday).catch(() => ({}));
  const coordCache = new Map();
  const coord = async pc => {
    pc = normPc(pc); if (!pc) return null;
    if (coordCache.has(pc)) return coordCache.get(pc);
    const c = await lookupPostcode(pc).catch(() => null);
    coordCache.set(pc, c); return c;
  };
  const out = {}, byDate = {};
  for (const [date, d] of Object.entries(days || {})) {
    out[date] = { ...d };
    const worked = toMin(d.start) != null && toMin(d.finish) != null;
    const jobsMeta = await jobsMetaForDay(env, tid, d);
    let seq = visitedSequenceForDay(autoDays[date], d, jobsMeta);
    // Fallback: nothing captured/logged but they worked → use the day's booked
    // jobs so mileage still auto-fills. Flagged so the UI/office can see why.
    let fromSchedule = false;
    if (worked && !seq.length && (sched[date] || []).length) {
      const seen = new Set();
      for (const s of sched[date]) {
        const pc = normPc(s.pc); if (!pc || seen.has(pc)) continue;
        if (seq.length && seq[seq.length - 1].pc === pc) continue;
        seq.push({ site: s.site || "", pc }); seen.add(pc);
      }
      fromSchedule = seq.length > 0;
    }
    if (!worked || !seq.length) {
      out[date].mileage = [];
      if (worked) byDate[date] = { miles: 0, legs: [], sites: seq.map(s => s.site), home: homePc, noRoute: !seq.length };
      continue;
    }
    const pts = [{ site: "Office", pc: basePc }, ...seq, { site: "Home", pc: homePc }];
    const cleanPts = [], cleanCoords = [];
    let missing = false;
    for (const p of pts) { const c = await coord(p.pc); if (c) { cleanPts.push(p); cleanCoords.push(c); } else missing = true; }
    if (cleanCoords.length < 2) {
      out[date].mileage = [];
      byDate[date] = { miles: 0, legs: [], sites: seq.map(s => s.site), home: homePc, noRoute: true };
      continue;
    }
    const lm = await legMiles(env, cleanCoords);
    let total = 0; const legs = [];
    for (let i = 0; i < lm.length; i++) {
      total += lm[i].miles;
      legs.push({ from: cleanPts[i].site || cleanPts[i].pc, to: cleanPts[i + 1].site || cleanPts[i + 1].pc, miles: lm[i].miles, src: lm[i].src });
    }
    total = round1(total);
    out[date].mileage = [{ site: "Door-to-door (auto)", postcode: "", miles: total, auto: true }];
    byDate[date] = { miles: total, legs, sites: seq.map(s => s.site), home: homePc, missing, fromSchedule };
  }
  return { days: out, auto: { applies: true, home: homePc, base: basePc, byDate } };
}

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
  } else if (totals.otHours > 0 && eff.rate) {
    // Split normal vs overtime when any overtime was worked.
    doc.text(cTot, y, "Labour: " + totals.normalHours + " h @ " + money(eff.rate) + "/h", { size: 10 });
    doc.text(cAmt, y, money(totals.normalPay), { size: 10, alignRight: true }); y += 16;
    doc.text(cTot, y, "Overtime: " + totals.otHours + " h @ " + money(totals.otRate) + "/h (" + eff.overtimeMult + "×)", { size: 10 });
    doc.text(cAmt, y, money(totals.otPay), { size: 10, alignRight: true }); y += 16;
  } else {
    doc.text(cTot, y, "Labour: " + totals.hours + " h" + (eff.rate ? " @ " + money(eff.rate) + "/h" : ""), { size: 10 });
    doc.text(cAmt, y, totals.labour != null ? money(totals.labour) : "", { size: 10, alignRight: true }); y += 16;
  }
  if (totals.leaveHours > 0 && totals.leavePay > 0 && eff.rateType !== "day") {
    doc.text(cTot, y, "Holiday / leave: " + totals.leaveHours + " h @ " + money(eff.rate) + "/h", { size: 10 });
    doc.text(cAmt, y, money(totals.leavePay), { size: 10, alignRight: true }); y += 16;
  }
  if (totals.miles > 0) {
    const ded = totals.milesDeducted > 0;
    // The radius breakdown goes on its OWN small grey line so the label can
    // never run into the right-aligned amount.
    if (ded) {
      doc.text(cTot, y, totals.miles + " mi - " + totals.milesDeducted + " mi (first/last " + eff.radiusMiles + " mi/day) = " + totals.milesClaimed + " mi", { size: 8.5, grey: true });
      y += 12;
    }
    doc.text(cTot, y, "Mileage: " + totals.milesClaimed + " mi @ " + eff.pencePerMile + "p", { size: 10 });
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

  // A TimesheetAdmin can VIEW another engineer's timesheet read-only via ?user=.
  // Only the GET reads below honour it; every write always acts as the caller.
  let _adminView = null;
  const viewUser = async () => {
    const w = q.get("user");
    if (!w || w === me) return me;
    if (_adminView === null) _adminView = await isTsAdmin(env, tid, sess);
    return _adminView ? w : me;
  };

  // ── GET /ts/me — the caller's (or a viewed engineer's) effective settings ──
  if (sub === "/me" && method === "GET") {
    const who = await viewUser();
    const u = await userRow(env, tid, who);
    if (!u) return error("User not found", 404, env, request);
    const eff = effectiveCfg(cfg, u);
    const next = await nextInvoiceNumber(env, tid, who, eff);
    const admin = await isTsAdmin(env, tid, sess);
    const invCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM eng_invoices WHERE tenant_id=? AND username=?").bind(tid, who).first();
    return json({ ok: true, name: displayName(u), ...eff, rate: eff.rate, nextInvoice: next,
      basePostcode: String(cfg.defaults.basePostcode || "PO15 5RQ").toUpperCase(),
      canSetNumber: !invCount || Number(invCount.n) === 0, admin,
      viewingUser: who !== me ? who : null }, {}, env, request);
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

  // ── GET /ts/outstanding — the caller's last completed week's missing hours ──
  // Drives the "complete your timesheet" reminder (attention gate + push).
  if (sub === "/outstanding" && method === "GET") {
    // Only engineers with the EngTimesheet permission are chased, and only when
    // reminders are switched on in Settings.
    if (!remindersEnabled(cfg) || !(await hasEngTimesheet(env, tid, me)))
      return json({ ok: true, count: 0, missing: [] }, {}, env, request);
    const curMon = mondayOf(new Date().toISOString().slice(0, 10));
    const pm = new Date(curMon + "T12:00:00Z"); pm.setUTCDate(pm.getUTCDate() - 7);
    const prevMon = pm.toISOString().slice(0, 10);
    const prev = await timesheetGaps(env, tid, me, prevMon, cfg);
    return json({ ok: true, week: prevMon, dueAt: prev.dueAt, dueLabel: prev.dueLabel,
      overdue: prev.overdue, count: prev.count, missing: prev.missing }, {}, env, request);
  }

  // ── GET /ts/my — own week (or a viewed engineer's, for an admin) ──────────
  if (sub === "/my" && method === "GET") {
    const who = await viewUser();
    const monday = mondayOf(isDateStr(q.get("week")) ? q.get("week") : new Date().toISOString().slice(0, 10));
    const u = await userRow(env, tid, who);
    const eff = effectiveCfg(cfg, u);
    const { days, savedAt, approval } = await loadWeek(env, tid, who, monday);
    const inv = await invoiceFor(env, tid, who, monday);
    const auto = await jobTimeAuto(env, tid, who, monday, { homePostcode: eff.homePostcode });
    const holidays = await holidayDaysFor(env, tid, who, monday);
    const bank = await bankHolidaysInRange(env, tid, monday, weekDays(monday)[6]);
    const jobMeta = await jobMetaFor(env, tid, days);
    const am = await applyAutoMileage(env, tid, who, monday, days, eff, cfg.defaults.basePostcode);
    const gaps = await timesheetGaps(env, tid, who, monday, cfg);
    return json({ ok: true, week: monday, days, savedAt, auto, holidays, bank, jobMeta, approval, locked: !!approval,
      viewingUser: who !== me ? who : null, remindersOn: remindersEnabled(cfg),
      due: { at: gaps.dueAt, label: gaps.dueLabel, overdue: gaps.overdue }, missingHours: gaps.missing,
      totals: weekTotals(am.days, eff), autoMileage: am.auto,
      invoice: inv ? { id: inv.id, number: inv.number, total: inv.total, at: inv.at,
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
    { const { approval } = await loadWeek(env, tid, me, monday);
      if (approval) return error("This week has been approved by the office and is locked — ask the office to re-open it if something needs changing.", 423, env, request); }
    const u = await userRow(env, tid, me);
    const eff = effectiveCfg(cfg, u);
    const days = cleanDays(monday, b.days);
    if (!eff.mileage) {
      for (const d of Object.values(days)) d.mileage = [];
    } else if (eff.selfEmployed) {
      // Door-to-door mileage is computed + locked server-side (applyAutoMileage
      // on read/invoice) — whatever the phone submits is discarded.
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
    // Push the per-job hours into the labour ledger for job costing.
    await materialiseTimesheet(env, tid, me, monday, days);
    const amSave = await applyAutoMileage(env, tid, me, monday, days, eff, cfg.defaults.basePostcode);
    return json({ ok: true, week: monday, days, totals: weekTotals(amSave.days, eff), autoMileage: amSave.auto }, {}, env, request);
  }

  // ── GET /ts/assigned?week= — the caller's scheduled SLA jobs, per day ─────
  // Feeds the "you're booked on" chips on each timesheet day. Engineer names
  // on jobs arrive in several spellings (dotted ids, case differences), so
  // matching is normalised the same way login is forgiving.
  if (sub === "/assigned" && method === "GET") {
    const who = await viewUser();
    const monday = mondayOf(isDateStr(q.get("week")) ? q.get("week") : new Date().toISOString().slice(0, 10));
    const endD = new Date(monday + "T12:00:00Z"); endD.setUTCDate(endD.getUTCDate() + 7);
    const end = endD.toISOString().slice(0, 10);
    const byDay = {};
    const debug = { me: who, matchedAs: [], candidates: [] };
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
      const meN = norm(who);
      const cap = await capturedMinsWeek(env, tid, who, monday);   // status-tap minutes per job/day → pre-fill hours
      const isMe = e => {
        const resolved = map[normId(e)];
        if (resolved != null) return resolved === who;
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
          jobId: r.id,
          ref: r.helpdesk_ref || r.id,
          label: (r.helpdesk_ref || r.id) + (d.description ? " — " + String(d.description).slice(0, 44) : ""),
          site: d.siteName || "", postcode: String(d.postcode || "").toUpperCase(),
          time: londonTime(r.scheduled_at),
          capturedMins: Math.round(cap[r.id + "|" + date] || 0)
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
    // Archived sites stay pickable but carry a flag — the picker shows an
    // amber "archived" warning instead of hiding them (late invoices on
    // finished jobs are real life; the exceptions list still catches strays).
    let results;
    try {
      ({ results } = await env.DB.prepare(
        "SELECT site_name, site_number, postcode, archived FROM sites WHERE tenant_id=? AND active=1 AND (site_name LIKE ? OR postcode LIKE ? OR site_number LIKE ?) ORDER BY archived, site_name LIMIT 15"
      ).bind(tid, like, like, like).all());
    } catch {
      ({ results } = await env.DB.prepare(
        "SELECT site_name, site_number, postcode FROM sites WHERE tenant_id=? AND active=1 AND (site_name LIKE ? OR postcode LIKE ? OR site_number LIKE ?) ORDER BY site_name LIMIT 15"
      ).bind(tid, like, like, like).all());
    }
    const sites = (results || []).map(s => ({
      name: s.site_name || ("Site " + s.site_number), code: s.site_number, postcode: (s.postcode || "").replace(/\*+$/, ""),
      ...(s.archived ? { archived: true } : {}) }));
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

  // ── GET /ts/job-search?q= — REAL SLA jobs (with ids) for the per-job hours
  // picker on the timesheet. Known jobs only — every result carries a job id so
  // the hours can be costed. No free text.
  if (sub === "/job-search" && method === "GET") {
    const term = String(q.get("q") || "").trim();
    if (term.length < 2) return json({ ok: true, jobs: [] }, {}, env, request);
    const like = "%" + term.replace(/[%_]/g, "") + "%";
    const out = [];
    try {
      const { results } = await env.DB.prepare(
        "SELECT id, helpdesk_ref, site_code, status, data FROM sla_jobs WHERE tenant_id=? AND (helpdesk_ref LIKE ? OR description LIKE ? OR site_code LIKE ? OR data LIKE ?) AND (status IS NULL OR status!='Cancelled') ORDER BY updated_at DESC LIMIT 12"
      ).bind(tid, like, like, like, like).all();
      for (const r of results || []) {
        let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {}
        const ref = r.helpdesk_ref || d.helpdeskRef || r.id;
        const site = d.siteName || r.site_code || "";
        out.push({ id: r.id, ref, site, status: r.status || "",
          label: ref + (site ? " — " + site : "") + (d.description ? " · " + String(d.description).slice(0, 40) : "") });
      }
    } catch {}
    return json({ ok: true, jobs: out }, {}, env, request);
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
      let results;
      try {
        ({ results } = await env.DB.prepare(
          "SELECT job_number, site_name, client, postcode, archived FROM sites WHERE tenant_id=? AND active=1 AND (job_number LIKE ? OR site_name LIKE ?) ORDER BY archived, site_name LIMIT 8"
        ).bind(tid, like, like).all());
      } catch {
        ({ results } = await env.DB.prepare(
          "SELECT job_number, site_name, client, postcode FROM sites WHERE tenant_id=? AND active=1 AND (job_number LIKE ? OR site_name LIKE ?) ORDER BY site_name LIMIT 8"
        ).bind(tid, like, like).all());
      }
      for (const r of results || []) {
        const hasJob = r.job_number != null && r.job_number !== "";
        const name = r.site_name || r.client || "site";
        project.push({ ref: hasJob ? String(r.job_number) : nameRef(name),
          label: (hasJob ? r.job_number + " — " : "") + name, kind: "project",
          site: name, postcode: (r.postcode || "").replace(/\*+$/, ""),
          ...(r.archived ? { archived: true } : {}) });
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
    const amInv = await applyAutoMileage(env, tid, me, monday, days, eff, cfg.defaults.basePostcode);
    const daysEff = amInv.days;
    const totals = weekTotals(daysEff, eff);
    if (!totals.daysWorked && !totals.miles) return error("Nothing on this week's timesheet yet — save your times first.", 400, env, request);
    const number = await nextInvoiceNumber(env, tid, me, eff);
    const pdf = buildInvoicePdf({ number, name: displayName(u), details: eff.details,
      company: cfg.defaults.company, monday, days: daysEff, eff, totals });
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
    const b = await request.json().catch(() => ({}));
    const row = await env.DB.prepare("SELECT * FROM eng_invoices WHERE tenant_id=? AND id=?").bind(tid, Number(b.id)).first();
    if (!row) return error("Invoice not found", 404, env, request);
    // The office can delete anyone's; a self-employed engineer can delete their
    // OWN (frees the week + the invoice number to regenerate).
    const admin = await isTsAdmin(env, tid, sess);
    if (!admin && row.username !== me) return error("You can only delete your own invoices.", 403, env, request);
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
      const { results: rows } = await env.DB.prepare("SELECT username, data, at, approved_at, approved_by, admin_note FROM eng_timesheets WHERE tenant_id=? AND week=?").bind(tid, monday).all();
      const { results: invs } = await env.DB.prepare("SELECT * FROM eng_invoices WHERE tenant_id=? AND week=?").bind(tid, monday).all();
      const dataBy = {}, apprBy = {};
      for (const r of rows || []) {
        try { dataBy[r.username] = { days: JSON.parse(r.data).days || {}, at: r.at }; } catch {}
        if (r.approved_at) apprBy[r.username] = { at: r.approved_at, by: r.approved_by || "", note: r.admin_note || "" };
      }
      const invBy = {}; for (const r of invs || []) invBy[r.username] = r;
      const leaveAll = await approvedLeaveInRange(env, tid, monday, weekDays(monday)[6]);   // approved holidays this week
      const out = [];
      for (const u of users || []) {
        const eff = effectiveCfg(cfg, u);
        const d = dataBy[u.username] || { days: {}, at: null };
        // Job-status time capture fills gaps the engineer hasn't typed over,
        // so the admin sees captured days even before the engineer opens
        // their timesheet.
        try {
          const auto = await jobTimeAuto(env, tid, u.username, monday, { homePostcode: eff.homePostcode });
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
        // Door-to-door mileage for fuel-paid self-employed staff (else unchanged).
        const am = await applyAutoMileage(env, tid, u.username, monday, d.days, eff, cfg.defaults.basePostcode);
        const daysEff = am.days;
        const perDay = {};
        for (const [date, day] of Object.entries(daysEff)) perDay[date] = { ...dayCalc(day, eff), start: day.start, finish: day.finish, jobs: day.jobs, note: day.note, jobHours: day.jobHours || {}, mileage: day.mileage || [], leaveHours: day.leaveHours != null ? day.leaveHours : null };
        const gaps = await timesheetGaps(env, tid, u.username, monday, cfg);
        out.push({ username: u.username, name: displayName(u), employment: u.employment_type || "Employed",
          selfEmployed: isSelfEmployed(u), cfg: { commute: eff.commute, lunch: eff.lunch, mileage: eff.mileage, rate: eff.rate, rateType: eff.rateType, pencePerMile: eff.pencePerMile },
          days: d.days, perDay, savedAt: d.at, totals: weekTotals(daysEff, eff), autoMileage: am.auto,
          gapCount: gaps.count, gapMissing: gaps.missing, due: { at: gaps.dueAt, label: gaps.dueLabel, overdue: gaps.overdue },
          approval: apprBy[u.username] || null,
          holidays: leaveAll[u.username] || {},
          invoice: inv ? { id: inv.id, number: inv.number, total: inv.total, at: inv.at,
            url: await signedFileUrl(env, url.origin, "/ts/invoice-file", inv.r2_key) } : null });
      }
      const bank = await bankHolidaysInRange(env, tid, monday, weekDays(monday)[6]);
      return json({ ok: true, week: monday, days: weekDays(monday), users: out, bank }, {}, env, request);
    }

    if (sub === "/admin/save" && method === "POST") {
      const b = await request.json().catch(() => ({}));
      if (!b.username || !isDateStr(b.week)) return error("username and week required", 400, env, request);
      const monday = mondayOf(b.week);
      if (await invoiceFor(env, tid, b.username, monday))
        return error("That week is invoiced — delete the invoice first if it needs correcting.", 409, env, request);
      { const cur = await loadWeek(env, tid, b.username, monday);
        if (cur.approval) return error("This week is approved & locked — re-open it before editing.", 423, env, request); }
      const days = cleanDays(monday, b.days);
      await env.DB.prepare(
        "INSERT INTO eng_timesheets (tenant_id, week, username, data, at) VALUES (?,?,?,?,?) ON CONFLICT(tenant_id, week, username) DO UPDATE SET data=excluded.data, at=excluded.at"
      ).bind(tid, monday, b.username, JSON.stringify({ days }), new Date().toISOString()).run();
      // Materialise any admin-edited per-job hours into the labour ledger too.
      await materialiseTimesheet(env, tid, b.username, monday, days);
      return json({ ok: true }, {}, env, request);
    }

    // Approve a week → lock it for the engineer + push them a notification. The
    // office makes any edits via /admin/save first, then approves.
    if (sub === "/admin/approve" && method === "POST") {
      const b = await request.json().catch(() => ({}));
      if (!b.username || !isDateStr(b.week)) return error("username and week required", 400, env, request);
      const monday = mondayOf(b.week);
      const note = String(b.note || "").slice(0, 500);
      // Every leave / bank-holiday / shutdown day must carry an admin paid-hours
      // figure before the week can be approved (so every day is fully logged).
      const cur = await loadWeek(env, tid, b.username, monday);
      const missing = await missingLeaveHours(env, tid, b.username, monday, cur.days);
      if (missing.length) return error(
        "Enter the paid hours for each leave / bank-holiday day first: " +
        missing.map(m => fmtDate(m.date) + " (" + m.label + ")").join(", "),
        400, env, request);
      const now = new Date().toISOString();
      await env.DB.prepare(
        "INSERT INTO eng_timesheets (tenant_id, week, username, data, at, approved_at, approved_by, admin_note) VALUES (?,?,?,?,?,?,?,?) " +
        "ON CONFLICT(tenant_id, week, username) DO UPDATE SET approved_at=excluded.approved_at, approved_by=excluded.approved_by, admin_note=excluded.admin_note"
      ).bind(tid, monday, b.username, JSON.stringify({ days: {} }), now, now, sess.user.username, note).run();
      ctx?.waitUntil(sendToUser(env, tid, b.username, {
        title: "Timesheet approved", body: `Your week of ${fmtDate(monday)} has been approved${note ? " — the office left a note" : ""}. Tap to view.`,
        url: "/engineer-timesheet.html?week=" + monday, tag: "ts-approved:" + monday
      }));
      return json({ ok: true, approvedAt: now, approvedBy: sess.user.username }, {}, env, request);
    }
    // Re-open an approved week so the office can correct it (engineer stays locked
    // out until it's re-approved).
    if (sub === "/admin/reopen" && method === "POST") {
      const b = await request.json().catch(() => ({}));
      if (!b.username || !isDateStr(b.week)) return error("username and week required", 400, env, request);
      const monday = mondayOf(b.week);
      await env.DB.prepare("UPDATE eng_timesheets SET approved_at=NULL, approved_by=NULL WHERE tenant_id=? AND week=? AND username=?").bind(tid, monday, b.username).run();
      ctx?.waitUntil(sendToUser(env, tid, b.username, {
        title: "Timesheet re-opened", body: `Your week of ${fmtDate(monday)} has been re-opened by the office — you can edit it again.`,
        url: "/engineer-timesheet.html?week=" + monday, tag: "ts-reopened:" + monday
      }));
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
          for (const k of ["commuteMins", "lunchMins", "lunchThresholdH", "pencePerMile", "rate", "nextNumber", "radiusMiles", "overtimeMult", "overtimeThresholdH"]) {
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
