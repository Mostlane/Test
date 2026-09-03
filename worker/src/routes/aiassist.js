// AI job assistant (routes/aiassist.js, mounted /ai) — an office command box that
// turns a plain-English request into a job DRAFT (preview), following the house
// rules in app_config `ai:jobrules:<tid>`. It never executes silently: /ai/assistant
// returns a preview or a clarifying question; the office confirms via /ai/assistant/create.
//
//   GET  /ai/jobrules                 read the rulebook (office)
//   POST /ai/jobrules  {rules}        replace the rulebook (Full Access)
//   POST /ai/assistant {message,history}   → {kind:"ask"|"preview"|"reply"|"rules", …}
//   POST /ai/assistant/create {jobs}  create the confirmed job drafts (office)
//
// Two-tier chat: Full-Access users get a relaxed chat (may also tweak rules / reply
// freely); every other office user gets a task-only chat (job requests only).

import { json, error, corsHeaders } from "../lib/http.js";
import { permissionsFor } from "../lib/auth.js";
import { createOrUpdateJobFromPayload, reconcileRelease } from "./sla.js";

const RULES_KEY = tid => `ai:jobrules:${tid}`;
const HQ_POSTCODE = "PO15 5RQ";

async function getRules(env, tid) {
  try {
    const row = await env.DB.prepare("SELECT value FROM app_config WHERE key=?").bind(RULES_KEY(tid)).first();
    if (row && row.value) return JSON.parse(row.value);
  } catch {}
  return { rules: "", log: [], chatModes: "" };
}
async function saveRules(env, tid, obj) {
  await env.DB.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(tid, RULES_KEY(tid), JSON.stringify(obj)).run();
}

async function isOfficeUser(env, tid, username) {
  try {
    const u = await env.DB.prepare("SELECT profile FROM users WHERE tenant_id=? AND username=?").bind(tid, username).first();
    let p = {}; try { p = u && u.profile ? JSON.parse(u.profile) : {}; } catch {}
    return String(p.staffType || "").toLowerCase() !== "field";   // office = not a field engineer
  } catch { return false; }
}

// London date helpers.
const londonToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
function resolveDate(s) {
  const t = String(s || "").trim().toLowerCase();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const base = new Date(londonToday() + "T12:00:00Z");
  if (t === "today") return londonToday();
  if (t === "tomorrow") { base.setUTCDate(base.getUTCDate() + 1); return base.toISOString().slice(0, 10); }
  const dows = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const di = dows.findIndex(d => t.includes(d));
  if (di >= 0) { for (let i = 1; i <= 7; i++) { base.setUTCDate(base.getUTCDate() + 1); if (base.getUTCDay() === di) return base.toISOString().slice(0, 10); } }
  return null;
}
// London wall-clock (date + HH:MM) → UTC ISO. Uses the tz offset at that instant.
function londonISO(date, hhmm) {
  const [hh, mm] = String(hhmm || "09:00").split(":").map(n => parseInt(n, 10) || 0);
  const naive = Date.parse(date + "T" + String(hh).padStart(2, "0") + ":" + String(mm).padStart(2, "0") + ":00Z");
  let offMin = 0;
  try {
    const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
      .formatToParts(new Date(naive)).reduce((a, x) => (a[x.type] = x.value, a), {});
    offMin = Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - naive) / 60000);
  } catch {}
  return new Date(naive - offMin * 60000).toISOString();
}

async function resolveSite(env, tid, query) {
  const q = String(query || "").trim();
  if (!q) return { ok: false };
  const num = q.replace(/\D/g, "");
  // Prefer an exact store-number match (numeric, incl. leading-zero variants).
  try {
    if (num) {
      const cands = [num, num.padStart(4, "0"), String(Number(num))];
      for (const c of [...new Set(cands)]) {
        const r = await env.DB.prepare("SELECT site_number, site_name, postcode, client, data FROM sites WHERE tenant_id=? AND site_number=? AND active=1 LIMIT 1").bind(tid, c).first();
        if (r) return siteOut(r);
      }
    }
  } catch {}
  // Else name search.
  try {
    const like = "%" + q.replace(/[%_]/g, "") + "%";
    const { results } = await env.DB.prepare("SELECT site_number, site_name, postcode, client, data FROM sites WHERE tenant_id=? AND active=1 AND site_name LIKE ? ORDER BY length(site_name) LIMIT 6").bind(tid, like).all();
    if (results && results.length === 1) return siteOut(results[0]);
    if (results && results.length > 1) return { ok: false, ambiguous: results.map(r => `${r.site_number} ${r.site_name}`) };
  } catch {}
  return { ok: false };
}
function siteOut(r) {
  let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {}
  const addr = [d.address1 || d.street, d.town, d.county, r.postcode].filter(Boolean).join(", ");
  return { ok: true, code: r.site_number, name: r.site_name, postcode: r.postcode || d.postcode || "",
    address: addr, lat: d.lat, lon: d.lon || d.lng, telephone: d.telephone || d.phone || "", email: d.email || d.managerEmail || "",
    storeType: d.storeType || r.client || "", sharepointURL: d.sharepointURL || "" };
}

async function resolveEngineer(env, tid, name) {
  const q = String(name || "").trim().toLowerCase();
  if (!q) return { ok: false, none: true };
  try {
    const { results } = await env.DB.prepare("SELECT username, first_name, last_name FROM users WHERE tenant_id=? AND (status IS NULL OR status='' OR status='Active')").bind(tid).all();
    const norm = s => String(s || "").toLowerCase().trim();
    const matches = (results || []).filter(u => {
      const full = norm(u.first_name + " " + u.last_name), fn = norm(u.first_name), un = norm(u.username);
      return un === q || full === q || fn === q || full.startsWith(q) || (q.length >= 3 && full.includes(q));
    });
    if (matches.length === 1) return { ok: true, username: matches[0].username, name: (matches[0].first_name + " " + matches[0].last_name).trim() };
    if (matches.length > 1) return { ok: false, ambiguous: matches.map(m => (m.first_name + " " + m.last_name).trim()) };
  } catch {}
  return { ok: false };
}

// ── Anthropic (tools) ─────────────────────────────────────────────────────────
async function anthropicChat(env, { system, messages, tools, forceTool }) {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, error: "AI isn't configured on the server (no API key)." };
  const model = env.ANTHROPIC_MODEL || "claude-sonnet-5";
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 1500, system, tools, tool_choice: forceTool ? { type: "any" } : { type: "auto" }, messages }),
    });
    if (!r.ok) { let d = ""; try { d = (await r.json())?.error?.message || ""; } catch {} return { ok: false, error: "AI error" + (d ? " (" + d + ")" : "") }; }
    const p = await r.json();
    const tool = Array.isArray(p.content) ? p.content.find(c => c.type === "tool_use") : null;
    const text = Array.isArray(p.content) ? p.content.filter(c => c.type === "text").map(c => c.text).join("\n").trim() : "";
    return { ok: true, tool, text, content: Array.isArray(p.content) ? p.content : [] };
  } catch { return { ok: false, error: "Couldn't reach the AI service." }; }
}

// ── Live SLA job lookup (so the assistant can find + assign EXISTING jobs) ─────
const WORKED_RE = /in progress|complete|closed|travel|on hold|quote|order|resumed|safety/i;
function jobRow(r) {
  let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {}
  const engs = Array.isArray(d.assignedEngineers) ? d.assignedEngineers : (d.assignedTo ? [d.assignedTo] : []);
  const hist = Array.isArray(d.statusHistory) ? d.statusHistory : [];
  const last = hist.length ? hist[hist.length - 1] : null;
  return { id: r.id, ref: d.helpdeskRef || r.helpdesk_ref || r.id, siteName: d.siteName || "", siteCode: d.siteCode || r.site_code || "",
    status: d.status || r.status || "", priority: d.priority || "", scheduledAt: d.scheduledAt || r.scheduled_at || null,
    engineers: engs, durationMinutes: d.durationMinutes || null, telephone: d.telephone || d.phone || "", description: String(d.description || r.description || "").slice(0, 400),
    // Cheap activity signals (from the job JSON already loaded — no extra reads):
    visited: hist.some(h => WORKED_RE.test(String(h && h.status || ""))),
    lastActivity: last ? { status: last.status, at: last.at, by: last.by } : null,
    _histBy: hist.map(h => String(h && h.by || "").toLowerCase()).filter(Boolean),
    _dormant: !!d.fallbackTemplate };
}
const FINISHED = /^(complete|closed|closed jobs|invoiced|cancelled)$/i;
async function searchJobs(env, tid, query) {
  const q = String(query || "").trim();
  if (!q) return [];
  const like = "%" + q.replace(/[%_]/g, "") + "%";
  // A reference like "28767/1" is stored as "28767-Andover…" — match the leading
  // number run too so the slash/line-suffix the office types never misses it.
  const numRun = (q.match(/\d{3,}/) || [])[0];
  const likeNum = numRun ? "%" + numRun + "%" : like;
  try {
    const { results } = await env.DB.prepare(
      "SELECT id, helpdesk_ref, description, status, site_code, scheduled_at, updated_at, data FROM sla_jobs WHERE tenant_id=? AND (helpdesk_ref LIKE ? OR helpdesk_ref LIKE ? OR description LIKE ? OR site_code LIKE ? OR lower(status) LIKE lower(?) OR lower(data) LIKE lower(?)) ORDER BY (CASE WHEN lower(status) LIKE lower(?) THEN 0 ELSE 1 END), (CASE WHEN status IN ('Complete','Closed','Closed Jobs','Invoiced','Cancelled') THEN 1 ELSE 0 END), updated_at DESC LIMIT 60"
    ).bind(tid, like, likeNum, like, like, like, like, like).all();
    return (results || [])
      .map(jobRow)
      .filter(j => !j._dormant)   // dormant fallback templates never surface
      .slice(0, 20);
  } catch { return []; }
}
async function jobById(env, tid, id) {
  try {
    const r = await env.DB.prepare("SELECT id, helpdesk_ref, description, status, site_code, scheduled_at, data FROM sla_jobs WHERE tenant_id=? AND id=?").bind(tid, id).first();
    return r ? jobRow(r) : null;
  } catch { return null; }
}
// Resolve one assignment target: by exact job id, else by a typed reference/number.
async function resolveJobTarget(env, tid, a) {
  if (a.jobId) { const j = await jobById(env, tid, a.jobId); if (j) return { ok: true, job: j }; }
  const ref = String(a.jobRef || a.ref || a.jobId || "").trim();
  if (!ref) return { ok: false, notfound: true };
  const rows = await searchJobs(env, tid, ref);
  const norm = s => String(s || "").toLowerCase();
  const numRun = (ref.match(/\d{3,}/) || [])[0];   // the job number (ignore a "/1" line suffix)
  // Prefer a match on the reference number the office typed.
  let hits = rows.filter(r => norm(r.ref).includes(norm(ref)) || (numRun && String(r.ref).includes(numRun)));
  if (!hits.length) hits = rows;
  const open = hits.filter(r => !FINISHED.test(r.status));
  const pool = open.length ? open : hits;
  if (pool.length === 1) return { ok: true, job: pool[0] };
  if (pool.length > 1) return { ok: false, ambiguous: pool.slice(0, 6).map(r => `${r.ref} (${r.siteName || r.siteCode}${r.status ? ", " + r.status : ""})`) };
  return { ok: false, notfound: true };
}

const JOB_TYPES = {
  empat: "EM light + PAT test (combined)", reactive: "reactive / maintenance", electrical: "electrical test", firestop: "firestopping",
};

// ── Day sequencing: order + space several jobs on one engineer's day ──────────
const HQ_COORD = { lat: 50.8607, lon: -1.2610 };   // PO15 5RQ (Segensworth / HQ)
function haversineMi(a, b) {
  if (!a || !b) return null;
  const R = 3958.8, tr = Math.PI / 180;
  const dLat = (b.lat - a.lat) * tr, dLon = (b.lon - a.lon) * tr;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * tr) * Math.cos(b.lat * tr) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
const travelMin = (a, b) => { const mi = haversineMi(a, b); return mi == null ? 30 : Math.max(10, Math.round((mi * 1.25 / 30 * 60) / 5) * 5); };
const hmToMin = s => { const [h, m] = String(s || "08:00").split(":").map(n => parseInt(n, 10) || 0); return h * 60 + m; };
const minToHm = t => { t = Math.max(0, Math.min(23 * 60 + 55, Math.round(t))); return String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0"); };
const _geoCache = new Map();
async function geocodePostcode(pc) {
  const key = String(pc || "").toUpperCase().replace(/\s+/g, "");
  if (!key) return null;
  if (_geoCache.has(key)) return _geoCache.get(key);
  let c = null;
  try {
    const r = await fetch("https://api.postcodes.io/postcodes/" + encodeURIComponent(key));
    if (r.ok) { const j = await r.json(); const res = j && j.result; if (res && Number.isFinite(res.latitude) && Number.isFinite(res.longitude)) c = { lat: res.latitude, lon: res.longitude }; }
  } catch {}
  _geoCache.set(key, c); return c;
}
async function coordsForJob(env, tid, j) {
  const lat = Number(j.lat), lon = Number(j.lon != null ? j.lon : j.lng);
  if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
  let pc = j.postcode || "";
  if (j.siteCode) {
    try {
      const code = String(j.siteCode);
      const cands = [...new Set([code, code.padStart(4, "0"), String(Number(code) || "")].filter(Boolean))];
      let r = null;
      for (const c of cands) { r = await env.DB.prepare("SELECT postcode, data FROM sites WHERE tenant_id=? AND site_number=? LIMIT 1").bind(tid, c).first(); if (r) break; }
      if (r) { let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {} const la = Number(d.lat), lo = Number(d.lon != null ? d.lon : d.lng); if (Number.isFinite(la) && Number.isFinite(lo)) return { lat: la, lon: lo }; pc = pc || r.postcode || d.postcode || ""; }
    } catch {}
  }
  return pc ? await geocodePostcode(pc) : null;
}
// ── Opening hours ─────────────────────────────────────────────────────────
const DAY_KEYS = ["sundayHours", "mondayHours", "tuesdayHours", "wednesdayHours", "thursdayHours", "fridayHours", "saturdayHours"];
function parseHours(s) {
  const m = String(s || "").match(/(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})/);
  return m ? { from: (+m[1]) * 60 + (+m[2]), to: (+m[3]) * 60 + (+m[4]) } : null;
}
// Category defaults when a site has no stored hours (Jamie's norms).
function categoryWindow(client) {
  const c = String(client || "").toLowerCase();
  if (c === "els" || c === "els_private") return { from: 600, to: 900, label: "10:00–15:00 (ELS)" };
  if (c === "cobra") return { from: 420, to: 1140, label: "07:00–19:00 (Cobra)" };
  if (c === "retail") return { from: 480, to: 1080, label: "08:00–18:00 (retail)" };
  return { from: 480, to: 1020, label: "08:00–17:00" };
}
async function siteWindow(env, tid, code, dateISO, clientHint) {
  let client = clientHint || "", data = null;
  try {
    const cands = [...new Set([String(code), String(code).padStart(4, "0"), String(Number(code) || "")].filter(Boolean))];
    let r = null; for (const c of cands) { r = await env.DB.prepare("SELECT client, data FROM sites WHERE tenant_id=? AND site_number=? LIMIT 1").bind(tid, c).first(); if (r) break; }
    if (r) { client = client || r.client || ""; try { data = JSON.parse(r.data || "{}"); } catch {} }
  } catch {}
  const dow = new Date(dateISO + "T12:00:00Z").getUTCDay();
  let win = null, source = "default", closed = false;
  const raw = data ? data[DAY_KEYS[dow]] : "";
  if (raw != null && String(raw).trim() !== "") {
    if (/closed/i.test(String(raw))) closed = true; else { const p = parseHours(raw); if (p) { win = p; source = "site"; } }
  }
  // ELS/ELS Private: enforce the 10–15 norm even if a wider figure is stored.
  const cl = String(client).toLowerCase();
  if ((cl === "els" || cl === "els_private") && !closed) { const d = categoryWindow(cl); win = win ? { from: Math.max(win.from, d.from), to: Math.min(win.to, d.to) } : d; source = source === "site" ? "site+ELS" : "default"; }
  if (!win && !closed) win = categoryWindow(client);
  const label = win ? (minToHm(win.from) + "–" + minToHm(win.to) + (source.includes("ELS") || source === "default" ? "" : "")) : "";
  return { from: win ? win.from : null, to: win ? win.to : null, label, source, closed, client };
}
function fmtLondonHM(ms) { try { return new Date(ms).toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" }); } catch { return ""; } }

// Real driving-time matrix via Google Distance Matrix (env.GOOGLE_MAPS_KEY), so
// jobs cluster by ACTUAL road time between sites. pts = [{lat,lon}]; returns a
// minutes matrix. Falls back to haversine when the key/coords are unavailable.
async function driveMatrixG(env, pts) {
  const n = pts.length;
  const mins = Array.from({ length: n }, () => Array(n).fill(0));
  const est = (i, j) => { mins[i][j] = travelMin(pts[i], pts[j]); };
  const key = env.GOOGLE_MAPS_KEY || "";
  const fb = () => { for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) est(i, j); return { mins, source: "estimate" }; };
  if (!key || pts.some(p => !p)) return fb();
  try {
    const ll = pts.map(p => p.lat + "," + p.lon);
    const per = Math.max(1, Math.floor(100 / n));   // origins×dests ≤ 100 per request
    let anyOk = false;
    for (let o = 0; o < n; o += per) {
      const idx = []; for (let k = o; k < Math.min(o + per, n); k++) idx.push(k);
      const url = "https://maps.googleapis.com/maps/api/distancematrix/json?origins=" + encodeURIComponent(idx.map(i => ll[i]).join("|")) + "&destinations=" + encodeURIComponent(ll.join("|")) + "&mode=driving&units=imperial&key=" + encodeURIComponent(key);
      const res = await fetch(url); const data = await res.json();
      if (!data || data.status !== "OK") { for (const i of idx) for (let j = 0; j < n; j++) if (i !== j) est(i, j); continue; }
      (data.rows || []).forEach((row, ri) => { const i = idx[ri]; (row.elements || []).forEach((el, j) => { if (i === j) return; if (el && el.status === "OK") { mins[i][j] = Math.max(1, Math.round(el.duration.value / 60)); anyOk = true; } else est(i, j); }); });
    }
    return { mins, source: anyOk ? "google" : "estimate" };
  } catch { return fb(); }
}

// Lay out each engineer's dated jobs: nearest-neighbour order from HQ, start
// within each SITE's opening window, spaced by on-site + travel; flag anything
// that won't fit the window, and any clash with a job the engineer already has.
async function planDay(env, tid, jobs) {
  const dated = jobs.filter(j => j.date && /^\d{4}-\d{2}-\d{2}$/.test(j.date));
  for (const j of dated) { j._c = await coordsForJob(env, tid, j); j._win = await siteWindow(env, tid, j.siteCode, j.date, j.storeType || j.client); j.warn = j.warn || []; }
  const groups = {};
  for (const j of dated) { const k = j.engineer + "|" + j.date; (groups[k] = groups[k] || []).push(j); }
  for (const key of Object.keys(groups)) {
    const grp = groups[key];
    // Real drive-time matrix (Google) over [HQ, ...job coords] when 2+ jobs share
    // a day — so nearby sites cluster by ACTUAL road time, not straight-line.
    let mins = null;
    if (grp.length >= 2) { const r = await driveMatrixG(env, [HQ_COORD, ...grp.map(j => j._c || HQ_COORD)]); mins = r.mins; }
    const tv = (a, b) => mins ? mins[a][b] : travelMin(a === 0 ? HQ_COORD : grp[a - 1]._c, b === 0 ? HQ_COORD : grp[b - 1]._c);
    // nearest-neighbour route from HQ (index 0) using real drive minutes.
    const remaining = grp.map((_, i) => i + 1); const orderIdx = []; let cur0 = 0;
    while (remaining.length) {
      let bk = 0, bd = Infinity;
      for (let k = 0; k < remaining.length; k++) { const d = tv(cur0, remaining[k]); if (d < bd) { bd = d; bk = k; } }
      const nx = remaining.splice(bk, 1)[0]; orderIdx.push(nx); cur0 = nx;
    }
    let prevIdx = 0, prev = null, cur = null;
    for (let oi = 0; oi < orderIdx.length; oi++) {
      const idx = orderIdx[oi], j = grp[idx - 1], w = j._win, dur = Number(j.durationMinutes) || 60;
      let start;
      if (j._explicitTime && j.startTime) start = hmToMin(j.startTime);         // office named a time
      else if (prev) start = Math.ceil((cur + (Number(prev.durationMinutes) || 60) + tv(prevIdx, idx)) / 5) * 5;
      else start = Math.max((w && w.from != null) ? w.from : 480, 480);         // first job: at opening, but not before 08:00
      if (w && w.closed) j.warn.push("⚠ site appears CLOSED " + j.date);
      if (w && w.from != null) {
        if (start < w.from) start = w.from;
        if (start + dur > w.to) {
          if (dur > (w.to - w.from)) j.warn.push("⚠ " + (Math.round(dur / 6) / 10) + "h won't fit the site's " + w.label + " opening window");
          else j.warn.push("⚠ would finish after the site closes (" + w.label + ")");
          start = Math.max(w.from, w.to - dur);
        }
        if (!j.warn.length || j._explicitTime) j.windowNote = "within " + w.label;
        else j.windowNote = w.label;
      }
      j.startTime = minToHm(start);
      cur = start; prev = j; prevIdx = idx;
    }
  }
  await clashCheck(env, tid, dated);
  for (const j of dated) { delete j._c; delete j._win; }
}
// Flag a proposed slot that overlaps a job the engineer is already booked on
// that day, and note when the day is getting overfull.
async function clashCheck(env, tid, dated) {
  const groups = {};
  for (const j of dated) { const k = j.engineer + "|" + j.date; (groups[k] = groups[k] || []).push(j); }
  for (const key of Object.keys(groups)) {
    const [eng, date] = key.split("|");
    const grp = groups[key];
    const mine = new Set(grp.map(j => String(j.jobId || "")).filter(Boolean));
    let existing = [];
    try {
      const { results } = await env.DB.prepare("SELECT id, helpdesk_ref, scheduled_at, data FROM sla_jobs WHERE tenant_id=? AND scheduled_at LIKE ?").bind(tid, date + "%").all();
      for (const r of results || []) {
        if (mine.has(r.id)) continue;
        let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {}
        if (FINISHED.test(d.status || "")) continue;
        const engs = (Array.isArray(d.assignedEngineers) ? d.assignedEngineers : (d.assignedTo ? [d.assignedTo] : [])).map(x => String(x).toLowerCase());
        if (!engs.includes(String(eng).toLowerCase())) continue;
        const st = Date.parse(d.scheduledAt || r.scheduled_at); if (!Number.isFinite(st)) continue;
        const en = d.scheduledEnd ? Date.parse(d.scheduledEnd) : st + (Number(d.durationMinutes) || 60) * 60000;
        existing.push({ ref: d.helpdeskRef || r.id, start: st, end: en });
      }
    } catch {}
    let busy = existing.reduce((a, e) => a + (e.end - e.start), 0);
    for (const j of grp) {
      const s = Date.parse(londonISO(date, j.startTime || "09:00")), e = s + (Number(j.durationMinutes) || 60) * 60000;
      j.warn = j.warn || [];
      for (const ex of existing) if (s < ex.end && e > ex.start) j.warn.push("⚠ clashes with " + ex.ref + " at " + fmtLondonHM(ex.start));
      busy += (e - s);
    }
    if (existing.length && busy > 9 * 3600000) grp.forEach(j => j.warn.push("⚠ " + eng.split(" ")[0] + "'s day is very full (" + existing.length + " job(s) already booked) — may not fit in one day"));
  }
}

// ── EM/PAT interleave planner ────────────────────────────────────────────────
// The EM/PAT day: 1h active on site (15m flick the emergency lights on + 45m PAT),
// then a ~1h45 drain gap, then a 15m walk-round to check the lights lasted (≈2h45
// after they were switched on). While one site drains you can drive to another,
// flick its lights on and do its PAT — interleaving several sites to compress the
// day. This simulates that, using real drive times, and returns a timeline.
const EMPAT = { active: 60, checkAfter: 165, check: 15, hardLate: 180, slack: 20 };
function simEmpat(sites, m, opts) {
  const { active: A, checkAfter: DUE, check: CHK, hardLate: LATE, slack: SLACK } = EMPAT;
  const idx = i => i + 1;
  const tv = (a, b) => (m && m[a] && Number.isFinite(m[a][b])) ? m[a][b] : 30;
  // nearest-neighbour visiting order from HQ (index 0) by real drive time.
  const order = []; const rem = sites.map((_, i) => i); let cur = 0;
  while (rem.length) { let bk = 0, bd = Infinity; for (let k = 0; k < rem.length; k++) { const d = tv(cur, idx(rem[k])); if (d < bd) { bd = d; bk = k; } } const nx = rem.splice(bk, 1)[0]; order.push(nx); cur = idx(nx); }
  let dayStart = 480;   // 08:00 floor
  const opens = sites.map(s => (s.win && s.win.from != null) ? s.win.from : 480);
  dayStart = Math.max(480, Math.min(...opens));   // start when the first needed site opens
  let now = dayStart, loc = 0;
  const started = {}, per = {}, pending = [], steps = [], warnings = [];
  let ni = 0;
  while (ni < order.length || pending.length) {
    pending.sort((a, b) => started[a].due - started[b].due);
    const chk = pending.length ? pending[0] : null;
    const ns = ni < order.length ? order[ni] : null;
    let doCheck = false;
    if (chk != null) {
      if (ns == null) doCheck = true;
      else { const tNs = tv(loc, idx(ns)); const back = tv(idx(ns), idx(chk)); if (now + tNs + A + back > started[chk].due + SLACK) doCheck = true; }
    }
    if (doCheck && chk != null) {
      const t = tv(loc, idx(chk)); if (t > 0) { steps.push({ t: now, kind: "travel", mins: t }); now += t; loc = idx(chk); }
      if (now < started[chk].due) { const w = started[chk].due - now; steps.push({ t: now, kind: "wait", mins: w }); now += w; }
      steps.push({ t: now, kind: "check", site: chk, mins: CHK });
      per[chk].check = now;
      const lateBy = now - started[chk].onTime;
      if (lateBy > LATE) warnings.push(sites[chk].code + ": light check " + (lateBy - LATE) + "m past the 3-hour limit — lights may have dropped");
      const w = sites[chk].win; if (w && w.to != null && now + CHK > w.to) warnings.push(sites[chk].code + ": light check after the site closes (" + w.label + ")");
      now += CHK; pending.splice(pending.indexOf(chk), 1);
    } else if (ns != null) {
      const t = tv(loc, idx(ns)); if (t > 0) { steps.push({ t: now, kind: "travel", mins: t }); now += t; loc = idx(ns); }
      const w = sites[ns].win; if (w && w.from != null && now < w.from) { const wait = w.from - now; steps.push({ t: now, kind: "wait", mins: wait }); now += wait; }
      steps.push({ t: now, kind: "onsite", site: ns, mins: A });
      started[ns] = { onTime: now, due: now + DUE }; per[ns] = { emOn: now }; pending.push(ns);
      if (w && w.to != null && now + A > w.to) warnings.push(sites[ns].code + ": EM/PAT active runs past closing (" + w.label + ")");
      now += A; ni++;
    } else break;
  }
  const back = tv(loc, 0); if (back > 0) { steps.push({ t: now, kind: "travel", mins: back }); now += back; }
  return { steps, startMin: dayStart, endMin: now, per, warnings };
}
async function toolPlanEmpat(env, tid, caps, args) {
  if (!caps.sla) return { denied: true, message: "You need SLA access to plan jobs." };
  const date = resolveDate(args.date) || null;
  const codes = Array.isArray(args.stores) ? args.stores : String(args.stores || "").split(/[,\s]+/).filter(Boolean);
  if (!codes.length) return { message: "Give me the store numbers to plan (EM/PAT sites)." };
  const sites = [], bad = [];
  for (const code of codes.slice(0, 12)) {
    const s = await resolveSite(env, tid, code);
    if (!s.ok) { bad.push(String(code)); continue; }
    const coord = await coordsForJob(env, tid, { siteCode: s.code, lat: s.lat, lon: s.lon });
    if (!coord) { bad.push(s.code + " (no location)"); continue; }
    const win = date ? await siteWindow(env, tid, s.code, date, s.storeType) : { from: 480, to: 1080, label: "" };
    sites.push({ code: s.code, name: s.name, coord, win, telephone: s.telephone, email: s.email });
  }
  if (sites.length < 1) return { message: "Couldn't resolve any of those sites' locations.", unresolved: bad };
  const m = (await driveMatrixG(env, [HQ_COORD, ...sites.map(s => s.coord)])).mins;
  const plan = simEmpat(sites, m);
  const hm = minToHm;
  const timeline = plan.steps.map(s => {
    if (s.kind === "travel") return hm(s.t) + " · drive " + s.mins + "m";
    if (s.kind === "wait") return hm(s.t) + " · wait " + s.mins + "m (lights draining)";
    if (s.kind === "onsite") return hm(s.t) + " · " + sites[s.site].code + " " + sites[s.site].name + " — flick EM lights on + PAT (1h)";
    if (s.kind === "check") return hm(s.t) + " · " + sites[s.site].code + " " + sites[s.site].name + " — walk-round light check (15m)";
    return "";
  }).filter(Boolean);
  const dur = plan.endMin - plan.startMin;
  const sequential = sites.length * 180;   // each site done alone ≈ 3h door-to-check
  return {
    date, count: sites.length,
    dayStart: hm(plan.startMin), dayEnd: hm(plan.endMin),
    durationHrs: (dur / 60).toFixed(1), sequentialHrs: (sequential / 60).toFixed(1), savedHrs: Math.max(0, (sequential - dur) / 60).toFixed(1),
    sites: sites.map((s, i) => ({ code: s.code, name: s.name, telephone: s.telephone || "", email: s.email || "", emOn: plan.per[i] ? hm(plan.per[i].emOn) : null, check: (plan.per[i] && plan.per[i].check != null) ? hm(plan.per[i].check) : null })),
    timeline, warnings: plan.warnings, unresolved: bad,
  };
}

// ── Read tools: the assistant can look up any portal area, gated per user ─────
function dueSummary(dueJson) {
  let due = {}; try { due = JSON.parse(dueJson || "{}"); } catch {}
  const t0 = Date.parse(londonToday() + "T12:00:00Z");
  const out = [];
  for (const [type, date] of Object.entries(due || {})) {
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) continue;
    const days = Math.round((Date.parse(date + "T12:00:00Z") - t0) / 86400000);
    out.push({ type, date, daysUntil: days, state: days < 0 ? "OVERDUE" : days <= 30 ? "due soon" : "ok" });
  }
  return out;
}
async function toolFindSite(env, tid, query) {
  const q = String(query || "").trim();
  if (!q) return { count: 0, sites: [] };
  const like = "%" + q.replace(/[%_]/g, "") + "%"; const num = q.replace(/\D/g, "");
  const binds = [tid, like, like]; let sql = "SELECT client, site_number, site_name, postcode, data FROM sites WHERE tenant_id=? AND active=1 AND (site_name LIKE ? OR postcode LIKE ?";
  if (num) { sql += " OR site_number IN (?,?,?)"; binds.push(num, num.padStart(4, "0"), String(Number(num) || "")); }
  sql += ") ORDER BY length(site_name) LIMIT 10";
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  const sites = (results || []).map(r => { let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {} return { number: r.site_number, name: r.site_name, type: r.client, postcode: r.postcode || d.postcode || "", lat: d.lat, lon: d.lon != null ? d.lon : d.lng, telephone: d.telephone || d.phone || "", email: d.email || d.managerEmail || "" }; });
  return { count: sites.length, sites };
}
async function toolFindCompliance(env, tid, caps, query, scheme) {
  if (!caps.compliance) return { denied: true, message: "You don't have Compliance access." };
  const term = String(query || "").trim().toLowerCase();
  const wantDue = /overdue|expired|outstanding|due/.test(term);
  const binds = [tid]; let sql = "SELECT scheme, code, category, name, postcode, due, site_number FROM compliance_stores WHERE tenant_id=? AND active=1";
  if (scheme) { sql += " AND scheme=?"; binds.push(String(scheme).toLowerCase()); }
  const bare = term.replace(/overdue|expired|outstanding|due|for|the|at|store|site/g, "").trim();
  if (bare) {
    const like = "%" + bare.replace(/[%_]/g, "") + "%"; const num = bare.replace(/\D/g, "");
    sql += " AND (lower(code) LIKE ? OR lower(name) LIKE ?"; binds.push(like, like);
    if (num) { sql += " OR code IN (?,?,?)"; binds.push(num, num.padStart(4, "0"), String(Number(num) || "")); }
    sql += ")";
  }
  sql += " LIMIT 500";
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  const stores = [];
  for (const r of results || []) {
    const items = dueSummary(r.due);
    if (wantDue && !items.some(i => i.state !== "ok")) continue;
    let nm = r.name, tel = "", email = "";
    try {
      const s = await env.DB.prepare("SELECT site_name, data FROM sites WHERE tenant_id=? AND site_number=? LIMIT 1").bind(tid, r.site_number || r.code).first();
      if (s) { nm = nm || s.site_name; let d = {}; try { d = JSON.parse(s.data || "{}"); } catch {} tel = d.telephone || d.phone || ""; email = d.email || d.managerEmail || ""; }
    } catch {}
    stores.push({ scheme: r.scheme, code: r.code, name: nm || r.code, category: r.category || "", postcode: r.postcode || "", telephone: tel, email, due: items });
    if (stores.length >= 40) break;
  }
  return { count: stores.length, stores };
}
async function toolListEngineers(env, tid) {
  const { results } = await env.DB.prepare("SELECT username, first_name, last_name, profile FROM users WHERE tenant_id=? AND (status IS NULL OR status='' OR status='Active')").bind(tid).all();
  const engineers = (results || []).filter(u => { let p = {}; try { p = JSON.parse(u.profile || "{}"); } catch {} return String(p.staffType || "").toLowerCase() === "field"; })
    .map(u => ({ name: (u.first_name + " " + u.last_name).trim(), username: u.username }));
  return { count: engineers.length, engineers };
}
// Full detail for ONE job — full description + office/site notes + status
// history + whether photos/signature are attached, so the assistant can tell
// if a site has already been surveyed/quoted. (It can't SEE image contents,
// but it can see how many photos exist and the visit history.)
async function toolGetJob(env, tid, ref, engSet) {
  engSet = engSet || new Set();
  const jt = await resolveJobTarget(env, tid, { jobRef: ref, jobId: ref });
  if (!jt.ok) return jt.ambiguous ? { ambiguous: jt.ambiguous } : { notfound: true, message: "No job found for \"" + ref + "\"." };
  const id = jt.job.id;
  let d = {};
  try { const r = await env.DB.prepare("SELECT data FROM sla_jobs WHERE tenant_id=? AND id=?").bind(tid, id).first(); if (r) d = JSON.parse(r.data || "{}"); } catch {}
  let photoCount = 0; const stages = {}; let hasSignature = !!d.signature;
  try {
    let cursor;
    do {
      const l = await env.JOB_FILES.list({ prefix: `jobs/${id}/`, cursor, include: ["customMetadata"] });
      for (const o of l.objects || []) {
        const k = String(o.key || "");
        if (/\.thumb$/i.test(k)) continue;
        if (/signature/i.test(k)) { hasSignature = true; continue; }
        photoCount++;
        const st = (o.customMetadata && (o.customMetadata.stage || o.customMetadata.Stage)) || "";
        if (st) stages[st] = (stages[st] || 0) + 1;
      }
      cursor = l.truncated ? l.cursor : null;
    } while (cursor);
  } catch {}
  const hist = (Array.isArray(d.statusHistory) ? d.statusHistory : []).slice(-12).map(h => ({ status: h.status, at: h.at, by: h.by, byEngineer: engSet.has(String(h.by || "").toLowerCase()) }));
  const attendedByEngineer = photoCount > 0 || hist.some(h => h.byEngineer && WORKED_RE.test(String(h.status || "")));
  const visited = attendedByEngineer || hist.some(h => WORKED_RE.test(String(h.status || "")));
  return {
    id, ref: d.helpdeskRef || id, site: d.siteName || "", siteCode: d.siteCode || "", status: d.status || "",
    priority: d.priority || "", engineers: Array.isArray(d.assignedEngineers) ? d.assignedEngineers : (d.assignedTo ? [d.assignedTo] : []),
    scheduledAt: d.scheduledAt || null, durationMinutes: d.durationMinutes || null,
    description: String(d.description || "").slice(0, 1800),
    notes: String(d.notes || d.note || d.officeNote || "").slice(0, 1800),
    photoCount, photoStages: stages, hasSignature, statusHistory: hist,
    likelyVisited: visited, attendedByEngineer,
  };
}
// EM set number + previous PAT/EM certificate numbers for a store, from the
// compliance certificates (sla:emsets config + compliance_files). So the
// assistant can fill an EM/PAT job's numbers instead of asking the office.
async function toolCertNumbers(env, tid, store) {
  const digits = String(store || "").replace(/\D/g, "");
  if (!digits) return { notfound: true, message: "Give a store number." };
  const cands = [...new Set([digits.padStart(4, "0"), digits, String(Number(digits) || "")].filter(Boolean))];
  let emSet = "";
  try {
    const row = await env.DB.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(tid, "sla:emsets:" + tid).first();
    if (row) { const m = JSON.parse(row.value || "{}"); for (const c of cands) { if (m[c]) { emSet = String(m[c]); break; } } }
  } catch {}
  const lastNum = async type => {
    try {
      const ph = cands.map(() => "?").join(",");
      const { results } = await env.DB.prepare("SELECT r2_key FROM compliance_files WHERE tenant_id=? AND type=? AND code IN (" + ph + ")").bind(tid, type, ...cands).all();
      let best = "", bestY = -1;
      for (const r of results || []) {
        const name = String(r.r2_key || "").split("/").pop() || "";
        const m = name.replace(/^\d+-/, "").match(/(\d{3,5})[-.](?:DEC|JAN|NOV)?(\d{2})/i);
        if (m) { const y = Number(m[2]); if (y > bestY) { bestY = y; best = m[1]; } }
      }
      return best;
    } catch { return ""; }
  };
  const lastEm = emSet || await lastNum("em");
  const lastPat = await lastNum("pat");
  const yy = new Date().toLocaleDateString("en-GB", { timeZone: "Europe/London", year: "2-digit" });
  return {
    store: cands[0],
    emSetNumber: lastEm || "", emCertSuggested: lastEm ? (lastEm + "-" + yy) : "",
    lastPatNumber: lastPat || "", patCertSuggested: lastPat ? (lastPat + "-" + yy) : "",
    note: (lastEm || lastPat) ? "" : "No previous EM/PAT certificate on file for this store — the numbers are confirmed at cert time anyway.",
  };
}
async function toolFindVehicle(env, tid, caps, query) {
  if (!caps.vehicles) return { denied: true, message: "You don't have Vehicles access." };
  const like = "%" + String(query || "").replace(/[%_]/g, "") + "%";
  try {
    const { results } = await env.DB.prepare("SELECT * FROM vehicles WHERE tenant_id=? AND (reg LIKE ? OR make LIKE ? OR model LIKE ?) LIMIT 12").bind(tid, like, like, like).all().catch(() =>
      env.DB.prepare("SELECT * FROM vehicles WHERE tenant_id=? AND reg LIKE ? LIMIT 12").bind(tid, like).all());
    const vehicles = (results || []).map(r => ({ reg: r.reg, make: r.make, model: r.model, motDue: r.mot_due, taxDue: r.tax_due, nextService: r.next_service }));
    return { count: vehicles.length, vehicles };
  } catch { return { error: "vehicle lookup failed" }; }
}

export async function handle(request, env, ctx, url, sess) {
  const method = request.method.toUpperCase();
  const sub = url.pathname.replace(/^\/ai(?=\/|$)/, "") || "/";
  const headers = corsHeaders(env, request);
  if (!sess) return error("Not authenticated", 401, env, request);
  const tid = sess.tenantId, me = sess.user.username;
  const perms = await permissionsFor(env, tid, me);
  const fullAccess = perms.FullAccess === "Yes";
  const office = fullAccess || await isOfficeUser(env, tid, me);
  if (!office) return error("The job assistant is for office staff.", 403, env, request);
  // What this user is allowed to reach — the assistant can look up ANY area, but
  // only surfaces what the user's own permissions permit.
  const caps = {
    sla: fullAccess || perms.SLA === "Yes" || perms.SLAAdmin === "Yes",
    compliance: fullAccess || perms.Compliance === "Yes",
    vehicles: fullAccess || perms.Vehicles === "Yes",
  };

  // ── Rulebook ──────────────────────────────────────────────────────────────
  if (sub === "/jobrules" && method === "GET") {
    const g = await getRules(env, tid);
    return json({ ok: true, rules: g.rules || "", chatModes: g.chatModes || "", log: g.log || [], canEdit: fullAccess }, {}, env, request);
  }
  if (sub === "/jobrules" && method === "POST") {
    if (!fullAccess) return error("Only Full-Access users can edit the rules.", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const g = await getRules(env, tid);
    g.rules = String(b.rules || "").slice(0, 20000);
    g.updatedAt = new Date().toISOString();
    if (b.logNote) { g.log = g.log || []; g.log.push({ q: "Rule edit", a: String(b.logNote).slice(0, 300), at: g.updatedAt, by: me }); g.log = g.log.slice(-200); }
    await saveRules(env, tid, g);
    return json({ ok: true }, {}, env, request);
  }

  // ── The assistant turn ────────────────────────────────────────────────────
  if (sub === "/assistant" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const message = String(b.message || "").slice(0, 4000);
    if (!message) return error("Say what you'd like me to do.", 400, env, request);
    const g = await getRules(env, tid);
    // Field engineers (names + a lookup set for engineer-vs-office attribution).
    let engNames = []; const engSet = new Set();
    try {
      const { results } = await env.DB.prepare("SELECT username, first_name, last_name, profile FROM users WHERE tenant_id=? AND (status IS NULL OR status='' OR status='Active')").bind(tid).all();
      for (const u of results || []) {
        let p = {}; try { p = JSON.parse(u.profile || "{}"); } catch {}
        if (String(p.staffType || "").toLowerCase() !== "field") continue;
        const full = (u.first_name + " " + u.last_name).trim();
        if (full) engNames.push(full);
        [u.username, full, u.first_name].forEach(x => { const s = String(x || "").toLowerCase().trim(); if (s) engSet.add(s); });
      }
    } catch {}
    // Flag which of a job's activity signals were an ENGINEER (not the office).
    const markEngActivity = jobs => { for (const j of jobs || []) {
      j.attendedByEngineer = !!(j._histBy && j._histBy.some(b => engSet.has(b)));
      j.lastByEngineer = !!(j.lastActivity && engSet.has(String(j.lastActivity.by || "").toLowerCase()));
      delete j._histBy;
    } return jobs; };
    // Custom job categories — a job's STATUS can be one of these to mark a
    // workstream (e.g. "FRA Works"). The assistant must recognise these.
    let cats = [];
    try { const row = await env.DB.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key='sla_categories'").bind(tid).first(); if (row && row.value) cats = (JSON.parse(row.value) || []).map(c => c && c.name).filter(Boolean); } catch {}
    const tools = [
      { name: "find_jobs", description: "Search the LIVE job board for existing jobs — by reference/incident number, site name or store number, words from the description, an engineer's name, or a status/category. ALWAYS use this when the office refers to jobs that already exist. Returns matching jobs with id, ref, site, status, current engineer and scheduled time.", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
      { name: "get_job", description: "Get FULL detail for ONE job by its id (from find_jobs) or reference: the full description, office/site notes, status history (who did what, when), how many PHOTOS are attached and whether a signature exists. Use this to judge whether a job has already been surveyed/visited/quoted (photos present or an In Progress/Quote/Complete in its history = it's been attended). NB you cannot see image contents, only that they exist.", input_schema: { type: "object", properties: { job: { type: "string", description: "job id (preferred) or reference/number" } }, required: ["job"] } },
      { name: "find_site", description: "Look up a SITE / store in the register — by name, store number or postcode. Returns number, name, type/customer, postcode and coordinates. Use it to answer questions about a site or to get a site's details.", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
      { name: "find_compliance", description: "Look up COMPLIANCE certificate due dates for a store (EICR/5-year, EM, PAT, gas, etc.) or list what's overdue/due-soon. Query a store number/name, or words like 'overdue'. Optionally set scheme (coop/fareham/chapplins/projects). Returns per-type due dates with OVERDUE/due-soon flags.", input_schema: { type: "object", properties: { query: { type: "string" }, scheme: { type: "string" } }, required: ["query"] } },
      { name: "list_engineers", description: "List the field engineers (names). Use it to know who can be assigned.", input_schema: { type: "object", properties: {} } },
      { name: "find_vehicle", description: "Look up a fleet VEHICLE by registration, make or model. Returns reg, make/model and MOT/tax/service due dates.", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
      { name: "cert_numbers", description: "Get a store's EM set number and previous PAT/EM certificate numbers (from the compliance certificates on file), for raising an EM/PAT test job. Pass the store number.", input_schema: { type: "object", properties: { store: { type: "string" } }, required: ["store"] } },
      { name: "plan_empat_day", description: "Plan an INTERLEAVED EM/PAT day across several stores using real drive times. An EM/PAT visit is 1h active (flick emergency lights on + PAT), then the lights must drain ~2h45 before a 15-min walk-round light check — so while one site drains you drive to another and start it, compressing the day. Give the store numbers (and optionally the engineer + date). Returns a full timeline (who's on/checking where and when), each site's lights-on + check times, hours vs doing them one-by-one, and any warnings.", input_schema: { type: "object", properties: { stores: { type: "array", items: { type: "string" } }, engineer: { type: "string" }, date: { type: "string" } }, required: ["stores"] } },
      { name: "ask", description: "Ask the office ONE clarifying question — only when something genuinely can't be found or is truly ambiguous. Never ask for details you can look up with a find_ tool first.", input_schema: { type: "object", properties: { question: { type: "string" } }, required: ["question"] } },
      { name: "reply", description: "Answer the office in plain text — use this to ANSWER a question after looking things up (e.g. compliance due dates, a site's details, what's on the board). Also for Full-Access general chat.", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    ];
    if (caps.sla) {
      tools.push({ name: "assign_jobs", description: "Assign and/or schedule one or more EXISTING jobs to an engineer (found with find_jobs). Use for 'assign X to Y', 'give these to Z tomorrow', 'move to Thursday'.", input_schema: { type: "object", properties: {
        summary: { type: "string" },
        assignments: { type: "array", items: { type: "object", properties: {
          jobId: { type: "string", description: "the job id from find_jobs (preferred)" },
          jobRef: { type: "string", description: "the reference the office typed, if you don't have the id" },
          engineer: { type: "string", description: "engineer name" },
          date: { type: "string", description: "today / tomorrow / a weekday / YYYY-MM-DD, or empty to leave the date as-is" },
          startTime: { type: "string", description: "HH:MM 24h, or empty" },
          durationMinutes: { type: "number" },
        }, required: [] } },
      }, required: ["assignments"] } });
      tools.push({ name: "draft_jobs", description: "Propose brand-NEW jobs to create (only for work not already on the board). A preview the office confirms.", input_schema: { type: "object", properties: {
        summary: { type: "string", description: "one short sentence describing what you're proposing" },
        jobs: { type: "array", items: { type: "object", properties: {
          jobType: { type: "string", enum: Object.keys(JOB_TYPES), description: "best guess; use reactive if unsure" },
          site: { type: "string", description: "store number or site name" },
          engineer: { type: "string", description: "engineer name, or empty if not given" },
          date: { type: "string", description: "today / tomorrow / a weekday / YYYY-MM-DD, or empty" },
          startTime: { type: "string", description: "HH:MM 24h, or empty" },
          durationMinutes: { type: "number" },
          priority: { type: "string", description: "e.g. Priority 1..4, or empty" },
          title: { type: "string", description: "short reference/title, or empty to use the site" },
          description: { type: "string" },
        }, required: ["site", "description"] } },
      }, required: ["jobs"] } });
    }
    if (fullAccess) {
      tools.push({ name: "set_rules", description: "Propose a full replacement of the house rules (Full-Access only). Return the COMPLETE new rules text.", input_schema: { type: "object", properties: { rules: { type: "string" }, summary: { type: "string" } }, required: ["rules", "summary"] } });
    }
    const canDo = [];
    if (caps.sla) canDo.push("raise, assign and schedule jobs"); else canDo.push("look up jobs (read-only — you don't have permission to raise or change jobs)");
    canDo.push("look up sites");
    canDo.push(caps.compliance ? "look up compliance due dates" : "compliance is NOT available to you (no permission)");
    canDo.push(caps.vehicles ? "look up fleet vehicles" : "fleet is NOT available to you (no permission)");
    const system = "You are the Mostlane portal assistant for the office. You can look things up across the portal — jobs, the site register, compliance certificate due dates, field engineers and fleet vehicles — and, when the user is allowed, raise/assign/schedule jobs. Use the find_ tools to get real data, then either ANSWER with `reply` or propose an action. A person always confirms before anything CHANGES — never claim a job was created or assigned. "
      + "Be smart and proactive: look things up rather than asking the user to re-type details. "
      + "You CAN inspect a job's detail with get_job — its full description, office/site notes, status history and whether PHOTOS/signature are attached — so when asked whether a job has been surveyed/visited/quoted, CHECK it (photos present, or an In Progress/Quote/On Hold/Complete in its history, means it's been attended) instead of saying you can't see. You can't view image CONTENTS, only that they exist and how many. find_jobs ALREADY returns each job's description, so to FILTER jobs by what the work is (e.g. only fire-stopping / penetrations / compartmentation, not door/threshold work) just read the descriptions from find_jobs — don't call get_job for that. Reserve get_job for confirming photos/notes/history on a few specific jobs (never more than ~8 in one go). "
      + "BE PROACTIVE about activity: every find_jobs result already carries `visited`, `lastActivity` (status/when/by) and `attendedByEngineer` / `lastByEngineer` (true when a FIELD ENGINEER — not the office — moved it or added to it). Whenever you list or discuss jobs, flag on your own initiative which have already been ATTENDED BY AN ENGINEER (a likely survey/quote visit — e.g. '🔧 attended by Connor') versus UNTOUCHED, so the office doesn't send someone twice. Use get_job to confirm photos/notes on the ones that matter. Treat engineer activity as the meaningful signal; office status changes are just admin. "
      + "THIS USER'S ACCESS: " + canDo.join("; ") + ". Only surface data from areas they can access; if they ask about an area they lack permission for, say it's not available to them — never invent it. "
      + (fullAccess ? "This user is FULL ACCESS: chat freely and adjust the rules with `set_rules` when they ask. " : "This user is TASK-ONLY: keep to portal/work topics (looking things up and managing jobs). Decline unrelated chit-chat politely and steer back. Only Full-Access users can change the rules. ")
      + "Today is " + londonToday() + " (Europe/London). HQ is " + HQ_POSTCODE + ". Field engineers: " + (engNames.join(", ") || "(none listed)") + ". "
      + (cats.length ? ("Custom job categories on this board: " + cats.join(", ") + ". A job's STATUS can be one of these to mark a workstream — e.g. jobs with status \"FRA Works\" ARE the Fire Risk Assessment remedial jobs (\"the FRA tracker\" / \"FRA works\"). When the office names a workstream, find_jobs for that category name and treat jobs whose STATUS equals it as that workstream — do NOT dismiss them as unrelated text. A job is OUTSTANDING unless its status is Complete/Closed/Closed Jobs/Invoiced/Cancelled. \"Send <engineer> in\" for a workstream means SCHEDULE those outstanding jobs onto the given day via assign_jobs — keep the engineer, set the date. ") : "")
      + "For a NEW EM/PAT compliance test the description should simply read like 'Carry out 3-hour EM drain-down test and PAT testing' (duration 180). NEVER ask the office for the EM set / PAT certificate numbers — use cert_numbers to look them up from the store's previous certificates, and mention them in your preview for reference. If a number CAN'T be found, do NOT hide it: FLAG it clearly in the preview (e.g. '⚠️ No previous PAT number on file for this store — it'll be set when the cert is finalised') and still raise the job. Always show what you found AND what was missing, per type. "
      + "EM/PAT INTERLEAVING: an EM/PAT visit is 1h active (15m flick the emergency lights on + 45m PAT), then the lights drain ~2h45 before a 15m walk-round to check they lasted. That drain gap is dead time you can fill at NEARBY sites — drive to another, flick its lights on and do its PAT, then loop back for the first site's check. When the office wants to plan a day of EM/PAT tests, or asks which sites could be OVERLAPPED, call plan_empat_day with the store numbers to get a real drive-time interleaved timeline; present it clearly and say how many hours it saves vs doing them one-by-one. Suggest overlapping nearby due sites to compress the day. Then, so the office can CALL ROUND and tick each store off, present the day as a draft_jobs PREVIEW (one EM/PAT job per site, engineer set, each site's startTime = its lights-on time from the plan) — the preview cards carry the phone number and a Yes/No tick per site, and the office creates only the ones they tick. "
      + "DUE DATES: the EM & PAT due dates ARE the compliance chart's `em` and `pat` dates — use find_compliance (scheme coop) to see what's due; every EM/PAT site needs BOTH. Due within the due MONTH is fine, and up to about a WEEK into the next month is acceptable; try not to slip much beyond. Cluster geographically-close due sites into the same day. "
      + "CALL AHEAD: whenever you SUGGEST sites (from the schedule / compliance dues), ALWAYS show each site's PHONE NUMBER in your reply — the office rings the store to confirm the day works before approving the jobs. Site records also hold an email (for a booking email later). "
      + "IF A SITE DECLINES A DAY: don't scrap the whole plan. Remove ONLY that site, re-run plan_empat_day on the REMAINING sites (the route + times will shift), and — to keep the day full — offer the next-nearest still-DUE site as a replacement (find_compliance for a nearby due store, show its phone to call ahead). Keep the confirmed sites intact; present the updated plan for approval. Only start a genuinely new area if the office asks. "
      + "SCHEDULING: when you propose a dated job, a sensible start time is set automatically from the SITE'S OPENING HOURS (ELS / ELS Private ≈ 10:00–15:00; retail & Cobra use their saved trading hours), jobs for the same engineer/day are ordered into an efficient route and spaced by REAL driving time between sites (Google), so nearby sites cluster together, and any clash with a job the engineer already has — or a job that won't fit the opening window or the day — is flagged with ⚠. Do NOT invent or override these times; present the suggested time and pass on any ⚠ flags in your summary so the office sees them. "
      + "If a NEW job doesn't name an engineer, ASK who. Only ask about things you cannot resolve with a lookup. "
      + "FORMAT every reply for a NARROW PHONE CHAT: short lines and simple bullet lists using '- '. NEVER use Markdown tables (pipes) or #/## headings — they don't render here. Bold a label with **like this**. Keep it tight. "
      + "\n\nHOUSE RULES:\n" + (g.rules || "(none set yet)");
    const messages = [];
    for (const h of (Array.isArray(b.history) ? b.history : []).slice(-8)) {
      if (h && h.role && h.text) messages.push({ role: h.role === "user" ? "user" : "assistant", content: String(h.text).slice(0, 2000) });
    }
    messages.push({ role: "user", content: message });

    // Agentic loop: let the model call the find_/get_ read tools (possibly
    // several per turn, and re-search) before it concludes. Every tool_use in an
    // assistant message MUST get a matching tool_result, or the next call is
    // rejected. On the LAST round the read tools are withdrawn and a tool is
    // forced, so it always concludes with an answer/proposal from what it gathered.
    const READ = new Set(["find_jobs", "get_job", "find_site", "find_compliance", "list_engineers", "find_vehicle", "cert_numbers", "plan_empat_day"]);
    const termTools = tools.filter(x => !READ.has(x.name));
    const MAXR = 8;
    let t = null, ai = null;
    for (let round = 0; round < MAXR; round++) {
      const last = round === MAXR - 1;
      ai = await anthropicChat(env, { system, messages, tools: last ? termTools : tools, forceTool: !fullAccess || last });
      if (!ai.ok) return json({ ok: true, kind: "reply", text: "⚠️ " + ai.error }, {}, env, request);
      const uses = (ai.content || []).filter(c => c.type === "tool_use");
      // A terminal tool ends the loop immediately.
      const term = uses.find(u => !READ.has(u.name));
      if (term) { t = term; break; }
      const reads = last ? [] : uses.filter(c => READ.has(c.name));
      if (reads.length) {
        messages.push({ role: "assistant", content: ai.content });
        const out = [];
        for (const u of uses) {
          let data;
          try {
            if (u.name === "find_jobs") { const f = markEngActivity(await searchJobs(env, tid, u.input.query || "")); data = { count: f.length, jobs: f }; }
            else if (u.name === "get_job") data = await toolGetJob(env, tid, u.input.job || u.input.query || "", engSet);
            else if (u.name === "find_site") data = await toolFindSite(env, tid, u.input.query || "");
            else if (u.name === "find_compliance") data = await toolFindCompliance(env, tid, caps, u.input.query || "", u.input.scheme);
            else if (u.name === "list_engineers") data = await toolListEngineers(env, tid);
            else if (u.name === "find_vehicle") data = await toolFindVehicle(env, tid, caps, u.input.query || "");
            else if (u.name === "cert_numbers") data = await toolCertNumbers(env, tid, u.input.store || u.input.query || "");
            else if (u.name === "plan_empat_day") data = await toolPlanEmpat(env, tid, caps, u.input || {});
            else data = { note: "Use the lookup results above, then answer or propose." };
          } catch (e) { data = { error: String(e && e.message || e) }; }
          out.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(data).slice(0, 12000) });
        }
        messages.push({ role: "user", content: out });
        continue;   // let the model use the results
      }
      // No terminal tool and no reads — the model answered in PROSE. Use it.
      if (ai.text) return json({ ok: true, kind: "reply", text: ai.text }, {}, env, request);
      if (last) break;
      // Empty turn: nudge it to conclude, then loop.
      messages.push({ role: "assistant", content: (ai.content && ai.content.length) ? ai.content : [{ type: "text", text: "(thinking)" }] });
      messages.push({ role: "user", content: "Give your answer or proposal now, using the information above." });
    }
    if (!t) return json({ ok: true, kind: "reply", text: ai.text || "Sorry — I couldn't pull that together. Try rephrasing, or ask for a specific site or engineer." }, {}, env, request);
    if (t.name === "ask") return json({ ok: true, kind: "ask", question: t.input.question || "Could you clarify?" }, {}, env, request);
    if (t.name === "reply") return json({ ok: true, kind: "reply", text: t.input.text || "" }, {}, env, request);
    if (t.name === "set_rules") return json({ ok: true, kind: "rules", proposed: String(t.input.rules || "").slice(0, 20000), summary: t.input.summary || "Updated rules" }, {}, env, request);

    if (t.name === "assign_jobs") {
      const list = Array.isArray(t.input.assignments) ? t.input.assignments.slice(0, 12) : [];
      const jobs = [], problems = [];
      for (const a of list) {
        const jt = await resolveJobTarget(env, tid, a);
        if (!jt.ok) { problems.push(jt.ambiguous ? `Which job did you mean for "${a.jobRef || a.jobId}"? (${jt.ambiguous.join("; ")})` : `I couldn't find a job matching "${a.jobRef || a.jobId || "(blank)"}".`); continue; }
        const job = jt.job;
        let engUser = null, engName = "";
        if (a.engineer && String(a.engineer).trim()) {
          const en = await resolveEngineer(env, tid, a.engineer);
          if (!en.ok) { problems.push(en.ambiguous ? `Which "${a.engineer}"? (${en.ambiguous.join(", ")})` : `I couldn't find an engineer called "${a.engineer}".`); continue; }
          engUser = en.username; engName = en.name;
        } else { problems.push(`Who should ${job.ref} go to?`); continue; }
        const date = resolveDate(a.date);
        const warns = [];
        if (job.engineers && job.engineers.length && !job.engineers.map(String).map(s => s.toLowerCase()).includes(engUser.toLowerCase()))
          warns.push(`currently ${job.engineers.join(", ")}`);
        if (FINISHED.test(job.status)) warns.push(`this job is ${job.status}`);
        jobs.push({
          action: "assign", jobId: job.id, siteCode: job.siteCode, siteName: job.siteName,
          engineer: engUser, engineerName: engName, date, startTime: date ? (a.startTime || "") : "", _explicitTime: !!(date && a.startTime),
          durationMinutes: Number(a.durationMinutes) > 0 ? Math.round(Number(a.durationMinutes)) : job.durationMinutes,
          priority: job.priority, title: job.ref, description: job.description,
          currentStatus: job.status, currentEngineers: job.engineers, typeLabel: "Assign job", warn: warns,
        });
      }
      if (problems.length && !jobs.length) return json({ ok: true, kind: "ask", question: problems.join("\n") }, {}, env, request);
      await planDay(env, tid, jobs);   // opening-hours time + spacing + clash flags
      return json({ ok: true, kind: "preview", summary: t.input.summary || "", jobs, warnings: problems }, {}, env, request);
    }

    if (t.name === "draft_jobs") {
      const drafts = Array.isArray(t.input.jobs) ? t.input.jobs.slice(0, 12) : [];
      const jobs = [], problems = [];
      for (const d of drafts) {
        const site = await resolveSite(env, tid, d.site);
        if (!site.ok) { problems.push(site.ambiguous ? `Which site did you mean for "${d.site}"? (${site.ambiguous.slice(0, 5).join("; ")})` : `I couldn't find a site matching "${d.site}".`); continue; }
        const jobType = d.jobType || "reactive";
        let engUser = null, engName = "";
        if (d.engineer && String(d.engineer).trim()) {
          const en = await resolveEngineer(env, tid, d.engineer);
          if (!en.ok) { problems.push(en.ambiguous ? `Which "${d.engineer}"? (${en.ambiguous.join(", ")})` : `I couldn't find an engineer called "${d.engineer}".`); continue; }
          engUser = en.username; engName = en.name;
        } else { problems.push(`Who should do the ${JOB_TYPES[jobType] || "job"} at ${site.name}?`); continue; }
        const date = resolveDate(d.date);
        const empat = jobType === "empat";
        const dur = Number(d.durationMinutes) > 0 ? Math.round(Number(d.durationMinutes)) : (empat ? 180 : (jobType === "reactive" ? 90 : 120));
        const desc = String(d.description || (empat ? "Carry out 3-hour EM drain-down test and PAT testing." : "")).slice(0, 2000);
        jobs.push({
          action: "create", jobType, siteCode: site.code, siteName: site.name, postcode: site.postcode, address: site.address,
          lat: site.lat, lon: site.lon, storeType: site.storeType, sharepointURL: site.sharepointURL, telephone: site.telephone, email: site.email,
          engineer: engUser, engineerName: engName, date, startTime: date ? (d.startTime || "") : "", _explicitTime: !!(date && d.startTime),
          durationMinutes: dur, priority: (empat || jobType === "electrical") ? (d.priority || "Priority 4") : (d.priority || ""),
          title: d.title || site.name, description: desc,
          emTest: empat, pat: empat, electrical: jobType === "electrical", firestopping: jobType === "firestop",
          typeLabel: JOB_TYPES[jobType] || jobType,
        });
      }
      if (problems.length && !jobs.length) return json({ ok: true, kind: "ask", question: problems.join("\n") }, {}, env, request);
      await planDay(env, tid, jobs);   // opening-hours time + spacing + clash flags
      return json({ ok: true, kind: "preview", summary: t.input.summary || "", jobs, warnings: problems }, {}, env, request);
    }
    return json({ ok: true, kind: "reply", text: ai.text || "" }, {}, env, request);
  }

  // ── Create confirmed drafts ───────────────────────────────────────────────
  if (sub === "/assistant/create" && method === "POST") {
    if (!caps.sla) return error("You don't have permission to raise or change jobs.", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const jobs = Array.isArray(b.jobs) ? b.jobs.slice(0, 12) : [];
    if (!jobs.length) return error("No jobs to create.", 400, env, request);
    const today = londonToday();
    const created = [];
    for (const j of jobs) {
      if (!j || !j.engineer) continue;
      const date = j.date && /^\d{4}-\d{2}-\d{2}$/.test(j.date) ? j.date : null;
      const scheduledAt = date ? londonISO(date, j.startTime || (j.action === "assign" ? "08:00" : "09:00")) : null;
      // Same-day (or no date) → visible now; future day → drip at 17:00 the evening before.
      const release = (!date || date <= today) ? { mode: "now" } : { mode: "dayBefore", hour: 17 };
      let payload;
      if (j.action === "assign") {
        // Re-assign / re-schedule an EXISTING job — id-merge keeps everything else.
        if (!j.jobId) continue;
        payload = {
          id: String(j.jobId), assignedEngineers: [j.engineer],
          scheduledAt: scheduledAt || undefined,
          durationMinutes: Number(j.durationMinutes) || undefined,
          release, changedBy: me + " (assistant)",
        };
      } else {
        if (!j.siteCode) continue;
        payload = {
          reference: crypto.randomUUID(), helpdeskRef: String(j.title || j.siteName || j.siteCode),
          description: String(j.description || ""), siteCode: String(j.siteCode), siteName: String(j.siteName || ""),
          address: String(j.address || ""), postcode: String(j.postcode || ""), telephone: String(j.telephone || ""),
          lat: j.lat, lon: j.lon, storeType: String(j.storeType || ""), sharepointURL: String(j.sharepointURL || ""),
          assignedEngineers: [j.engineer], status: "Scheduled", priority: String(j.priority || ""),
          scheduledAt, durationMinutes: Number(j.durationMinutes) || undefined,
          emTest: !!j.emTest, pat: !!j.pat, electrical: !!j.electrical, firestopping: !!j.firestopping,
          workArea: (j.emTest || j.electrical) ? "electrical" : undefined,
          release, changedBy: me + " (assistant)",
        };
      }
      try {
        const job = await createOrUpdateJobFromPayload(env, tid, payload);
        ctx?.waitUntil(reconcileRelease(env, tid, job).catch(() => {}));
        created.push({ id: job.id, ref: job.helpdeskRef, site: job.siteName, engineer: j.engineerName || j.engineer, date, action: j.action || "create" });
      } catch (e) { created.push({ error: String(e && e.message || e), site: j.siteName || j.title }); }
    }
    const okc = created.filter(c => !c.error);
    const res = json({ ok: true, created }, {}, env, request);
    try { res.headers.set("X-Audit-Note", encodeURIComponent(`AI assistant: ` + okc.map(c => `${c.action === "assign" ? "assigned" : "created"} ${c.ref} → ${c.engineer}`).join(", "))); } catch {}
    return res;
  }

  return error("Unknown assistant route: " + sub, 404, env, request);
}
