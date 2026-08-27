// Fleet reports — save/list/open/delete generated reports, plus the persistent
// reg→driver mapping the generator page uses.
//
//   GET  /fleet/drivers                 { map: { reg: username } }  (remembered)
//   POST /fleet/drivers { map }         save the reg→driver mapping (Vehicles)
//   POST /fleet/report  (multipart)     save a generated report HTML to R2
//   GET  /fleet/reports                 list saved reports (signed open URLs)
//   GET  /fleet/report?key=&sig=        stream a saved report (public + signed)
//   POST /fleet/report-delete { key }   delete a saved report
//
// Reports are self-contained HTML, stored in R2 (JOB_FILES) under a
// tenant-prefixed key and opened via a signed, expiring URL (same protection as
// documents). Gated by the Vehicles permission (or Full access).

import { corsHeaders } from "../lib/http.js";
import { tenantDB, resolveTenantId } from "../lib/tenantdb.js";
import { permissionsFor } from "../lib/auth.js";
import { signedFileUrl, verifyFileSig } from "../lib/filesign.js";
import { sendToUser } from "./push.js";
import { evalAlerts, answerWord } from "./vancheck.js";
import { loadRegister, resolveSite } from "./costing.js";
import { createOrUpdateJobFromPayload, reconcileRelease } from "./sla.js";
import { approvedLeaveInRange } from "./holidays.js";

function jr(o, h, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...h, "Content-Type": "application/json" } }); }
async function readJson(req) { try { return await req.json(); } catch { return {}; } }
async function canFleet(env, tid, sess) {
  if (!sess) return false;
  const p = await permissionsFor(env, tid, sess.user.username);
  return p.FullAccess === "Yes" || p.Vehicles === "Yes";
}
// Money views (fuel spend, vehicle financials, running cost) are Full-Access only.
async function canMoney(env, tid, sess) {
  if (!sess) return false;
  const p = await permissionsFor(env, tid, sess.user.username);
  return p.FullAccess === "Yes";
}
const UK_GALLON = 4.54609;   // litres per imperial gallon (MPG is UK)
const DKEY = tid => `fleet:drivers:${tid}`;
const CKEY = tid => `fleet:vehcover:${tid}`;   // { REGNORM: photoKey } — chosen cover per van
const prefix = tid => `fleetreports/${tid}/`;
const regKey = reg => String(reg).replace(/[^A-Za-z0-9]/g, "").toUpperCase();
const vdocPrefix = (tid, reg) => `vehicledocs/${tid}/${regKey(reg)}/`;
const vphotoPrefix = (tid, reg) => `vehiclephotos/${tid}/${regKey(reg)}/`;
const vphotoRoot = tid => `vehiclephotos/${tid}/`;
const vmaintPrefix = (tid, reg) => `vehiclemaint/${tid}/${regKey(reg)}/`;   // maintenance-record documents

const parseJson = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

// Maintenance categories (Tyres / Service / Brakes …). A managed list per
// tenant in app_config, each with a colour for the chart; falls back to a
// sensible default set until the office customises it.
const MCATS_KEY = tid => `fleet:maintcats:${tid}`;
const DEFAULT_MAINT_CATS = [
  { name: "Service",    colour: "#2563eb" },
  { name: "MOT",        colour: "#7c3aed" },
  { name: "Tyres",      colour: "#0891b2" },
  { name: "Brakes",     colour: "#dc2626" },
  { name: "Windscreen", colour: "#0d9488" },
  { name: "Bodywork",   colour: "#ea580c" },
  { name: "Electrical", colour: "#ca8a04" },
  { name: "Battery",    colour: "#65a30d" },
  { name: "Repair",     colour: "#db2777" },
  { name: "Other",      colour: "#64748b" },
];
async function maintCats(env, tid) {
  try {
    const row = await env.DB.prepare("SELECT value FROM app_config WHERE key=?").bind(MCATS_KEY(tid)).first();
    if (row && row.value) { const a = JSON.parse(row.value); if (Array.isArray(a) && a.length) return a; }
  } catch {}
  return DEFAULT_MAINT_CATS;
}

// Username → display name map (for check/handover listings).
async function nameMap(env, tid) {
  const out = {};
  try {
    const { results } = await env.DB.prepare("SELECT username, first_name, last_name FROM users WHERE tenant_id=?").bind(tid).all();
    for (const u of results || []) out[u.username] = ((u.first_name || "") + " " + (u.last_name || "")).trim() || u.username;
  } catch {}
  return out;
}

// ── Van Handover: a detailed condition check sent to a newly-assigned driver.
// Its own template (editable via app_config, defaults below), and its own table
// vehicle_handovers. Photos + the signature go to ASSET_BUCKET under
// handover/<user>/<id>/… (served by the public /asset-image + /asset-thumb).
const HANDOVER_TPL_KEY = tid => `handover:template:${tid}`;
const DEFAULT_HANDOVER = {
  checklist: [
    { id: "exterior", label: "Exterior bodywork condition (walk all sides)" },
    { id: "glass", label: "Windscreen, windows & mirrors" },
    { id: "lights", label: "Lights & indicators" },
    { id: "tyres", label: "Tyres & wheels (tread & condition)" },
    { id: "wipers", label: "Wipers & washers" },
    { id: "oil", label: "Engine oil level" },
    { id: "coolant", label: "Coolant level" },
    { id: "screenwash", label: "Screen wash level" },
    { id: "brakes", label: "Brakes & handbrake" },
    { id: "horn", label: "Horn" },
    { id: "seatbelts", label: "Seatbelts" },
    { id: "dash", label: "Dashboard warning lights (none showing)" },
    { id: "interior", label: "Interior condition & cleanliness" },
    { id: "load", label: "Load area & racking condition" },
  ],
  equipment: [
    { id: "spare_wheel", label: "Spare wheel" },
    { id: "jack", label: "Jack" },
    { id: "tyre_tools", label: "Tyre changing tools (wheel brace)" },
    { id: "locking_nut", label: "Locking wheel-nut key" },
    { id: "warning_triangle", label: "Warning triangle" },
    { id: "hi_vis", label: "Hi-vis vest" },
    { id: "first_aid", label: "First aid kit" },
    { id: "fire_ext", label: "Fire extinguisher" },
  ],
  photoSlots: [
    { id: "front", label: "Front", required: true },
    { id: "rear", label: "Rear", required: true },
    { id: "nearside", label: "Nearside (passenger side)", required: true },
    { id: "offside", label: "Offside (driver side)", required: true },
    { id: "dashcam", label: "Dashboard & mileage", required: true },
    { id: "cab", label: "Cab interior", required: true },
    { id: "loadarea", label: "Load area", required: false },
  ],
  alertUsers: [],   // who to push when an "Alert if" answer is given
};
async function handoverTemplate(env, tid) {
  try {
    const row = await env.DB.prepare("SELECT value FROM app_config WHERE key=?").bind(HANDOVER_TPL_KEY(tid)).first();
    if (row && row.value) { const t = JSON.parse(row.value); if (t && Array.isArray(t.checklist)) return { ...DEFAULT_HANDOVER, ...t }; }
  } catch {}
  return DEFAULT_HANDOVER;
}
// Driver van-scores sent to engineers from a fleet report. One row per
// engineer+week (a re-send updates it). Engineers see their own history.
async function ensureScoresTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS driver_scores (
    tenant_id INTEGER NOT NULL DEFAULT 1,
    username TEXT NOT NULL,
    week_start TEXT NOT NULL,
    week_end TEXT,
    reg TEXT,
    score INTEGER,
    sent_by TEXT,
    sent_at TEXT,
    PRIMARY KEY (tenant_id, username, week_start)
  )`).run();
  try { await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_dscores_user ON driver_scores(tenant_id,username,week_start)").run(); } catch {}
  // Rank + fleet size at send time (1 = top). Snapshotted so the number in the
  // engineer's history reflects where they were IN THAT WEEK.
  try { await env.DB.prepare("ALTER TABLE driver_scores ADD COLUMN rank INTEGER").run(); } catch {}
  try { await env.DB.prepare("ALTER TABLE driver_scores ADD COLUMN total INTEGER").run(); } catch {}
}
async function ensureHandoverTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS vehicle_handovers (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL DEFAULT 1,
    reg TEXT NOT NULL, username TEXT NOT NULL, status TEXT DEFAULT 'pending',
    requested_by TEXT, requested_at TEXT, completed_at TEXT,
    mileage TEXT, safe_to_drive INTEGER, note TEXT, items TEXT)`).run();
  try { await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_handover_reg ON vehicle_handovers(tenant_id,reg)").run(); } catch {}
  try { await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_handover_user ON vehicle_handovers(tenant_id,username,status)").run(); } catch {}
}
// data:image/... base64 → ASSET_BUCKET key under handover/<user>/<id>/. Returns
// an already-stored key untouched (idempotent resubmit). 5 MB cap per image.
async function storeHandoverImg(env, userDir, id, tag, p, nRef) {
  if (typeof p === "string" && /^handover\//.test(p)) return p;
  const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(p || "");
  if (!m) return null;
  const bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
  if (bytes.length > 5 * 1024 * 1024) return null;
  const key = `handover/${userDir}/${id}/${tag}-${++nRef.n}-${crypto.randomUUID().slice(0, 8)}.${m[1] === "jpeg" ? "jpg" : "png"}`;
  await env.ASSET_BUCKET.put(key, bytes, { httpMetadata: { contentType: `image/${m[1]}` } });
  return key;
}

// Load the chosen-cover map ({ REGNORM: photoKey }) for a tenant.
async function coverMap(env, tid) {
  try { const row = await env.DB.prepare("SELECT value FROM app_config WHERE key=?").bind(CKEY(tid)).first(); if (row && row.value) return JSON.parse(row.value) || {}; } catch {}
  return {};
}
async function saveCoverMap(env, tid, map) {
  await env.DB.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(tid, CKEY(tid), JSON.stringify(map)).run();
}
// One R2 list for the whole fleet's photos, grouped by van (newest first).
async function photoIndex(env, tid) {
  const out = {};   // REGNORM -> [{ key, at }]  (newest first)
  try {
    const listed = await env.JOB_FILES.list({ prefix: vphotoRoot(tid), include: ["customMetadata"] });
    for (const o of listed.objects || []) {
      const parts = o.key.split("/");            // vehiclephotos/<tid>/<REG>/<file>
      const reg = parts[2]; if (!reg) continue;
      const at = (o.customMetadata && o.customMetadata.at) || (o.uploaded ? new Date(o.uploaded).toISOString() : "");
      (out[reg] = out[reg] || []).push({ key: o.key, at, name: (o.customMetadata && o.customMetadata.name) || parts.slice(-1)[0], by: (o.customMetadata && o.customMetadata.by) || "" });
    }
    for (const reg of Object.keys(out)) out[reg].sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
  } catch {}
  return out;
}

// ── Van-check photos as gallery items ──────────────────────────────────────
// Weekly van checks store their photos in ASSET_BUCKET (served by the public
// /asset-image route) and tag each to a named slot (Front / Rear / a tyre …).
// These surface in the vehicle card's Photos gallery alongside the uploaded
// vehicle photos, tagged with their slot label so they can be filtered.
const prettySlot = id => String(id || "other").replace(/[_-]+/g, " ").replace(/\b\w/g, c => c.toUpperCase()).trim() || "Other";
// slotId -> label, from the editable van-check settings (falls back to a
// prettified id for slots that were renamed/removed since a photo was taken).
async function vanCheckSlotLabels(env, tid) {
  const map = {};
  try {
    const row = await env.DB.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(tid, "vancheck:settings").first();
    if (row && row.value) {
      const s = JSON.parse(row.value) || {};
      for (const sl of (Array.isArray(s.photoSlots) ? s.photoSlots : [])) if (sl && sl.id) map[sl.id] = sl.label || prettySlot(sl.id);
    }
  } catch {}
  return map;
}
// Every van-check photo for one vehicle, newest check first, each carrying its
// slot category so the gallery can group/filter them.
async function vanCheckPhotos(env, tid, rk, names, slotLabels) {
  const out = [];
  let rows = [];
  try {
    rows = (await env.DB.prepare(
      "SELECT username, vehicle, checked_at, items FROM vehicle_checks WHERE tenant_id=? AND vehicle IS NOT NULL AND vehicle!=''"
    ).bind(tid).all()).results || [];
  } catch { return out; }
  rows.sort((a, b) => new Date(b.checked_at || 0) - new Date(a.checked_at || 0));
  for (const r of rows) {
    if (regKey(r.vehicle || "") !== rk) continue;
    let items = {}; try { items = r.items ? JSON.parse(r.items) : {}; } catch {}
    if (items.skipped) continue;
    const at = r.checked_at || "";
    const by = (names && names[r.username]) || r.username || "";
    const slot = (items.slotPhotos && typeof items.slotPhotos === "object") ? items.slotPhotos : {};
    const seen = new Set();
    for (const [slotId, key] of Object.entries(slot)) {
      if (!key || seen.has(key)) continue; seen.add(key);
      out.push({ key, source: "vancheck", categoryId: slotId, category: (slotLabels && slotLabels[slotId]) || prettySlot(slotId), by, at });
    }
    for (const key of (Array.isArray(items.photos) ? items.photos : [])) {   // extras not tied to a named slot
      if (!key || seen.has(key)) continue; seen.add(key);
      out.push({ key, source: "vancheck", categoryId: "other", category: "Other / damage", by, at });
    }
  }
  return out;
}
// Van-check photo count per vehicle (one scan) — folded into the card badge.
async function vanCheckPhotoCounts(env, tid) {
  const out = {};
  try {
    const { results } = await env.DB.prepare(
      "SELECT vehicle, items FROM vehicle_checks WHERE tenant_id=? AND vehicle IS NOT NULL AND vehicle!=''"
    ).bind(tid).all();
    for (const r of results || []) {
      let items = {}; try { items = r.items ? JSON.parse(r.items) : {}; } catch {}
      if (items.skipped) continue;
      const keys = new Set([...Object.values(items.slotPhotos || {}), ...((Array.isArray(items.photos) ? items.photos : []))].filter(Boolean));
      if (keys.size) out[regKey(r.vehicle)] = (out[regKey(r.vehicle)] || 0) + keys.size;
    }
  } catch {}
  return out;
}
// Outstanding van-check defects per vehicle. A defect stays flagged until an
// admin explicitly "marks it resolved" (a per-reg resolved-as-of timestamp in
// app_config fleet:defectsclear:<tid>) — even a later clean check does NOT clear
// it, matching Jamie's rule. "Defect" = ANY checklist answer of "defect" or
// equipment answer of "missing", OR the driver flagged the van not-safe-to-drive.
// Returns { REGNORM: { items, checks, notSafe, since, latest } }.
const DEFECTCLR_KEY = tid => `fleet:defectsclear:${tid}`;
// Acknowledged "missed van check" per vehicle: { REGNORM: { at, by } }. Valid for
// the same 7-day window as the green check, so a genuine one-off miss can be
// waved through and the red bar returns next week if it's still not done.
const VCACK_KEY = tid => `fleet:vcack:${tid}`;
const VC_WINDOW_MS = 7 * 86400000;
// Van-check bar state for a card: ok (checked ≤7d) | ack (missed but acknowledged
// ≤7d) | due (missed, needs a check or an acknowledge).
function vanCheckState(lastAt, ack) {
  if (lastAt && (Date.now() - new Date(lastAt).getTime()) <= VC_WINDOW_MS) return { state: "ok", at: lastAt, ackBy: "" };
  if (ack && ack.at && (Date.now() - new Date(ack.at).getTime()) <= VC_WINDOW_MS) return { state: "ack", at: lastAt || "", ackBy: ack.by || "" };
  return { state: "due", at: lastAt || "", ackBy: "" };
}
async function vanCheckDefects(env, tid, resolved) {
  const out = {};
  try {
    const { results } = await env.DB.prepare(
      "SELECT vehicle, username, checked_at, safe_to_drive, items FROM vehicle_checks WHERE tenant_id=? AND vehicle IS NOT NULL AND vehicle!=''"
    ).bind(tid).all();
    for (const r of results || []) {
      let items = {}; try { items = r.items ? JSON.parse(r.items) : {}; } catch {}
      if (items.skipped) continue;
      const rk = regKey(r.vehicle);
      const clearAt = (resolved && resolved[rk]) || "";
      // Skip checks completed on/before the last "resolved" mark for this van.
      if (clearAt && r.checked_at && new Date(r.checked_at) <= new Date(clearAt)) continue;
      const answers = items.answers || {};
      const defItems = (Array.isArray(items.issues) ? items.issues : Object.keys(answers).filter(k => answers[k] === "defect" || answers[k] === "missing")).length;
      const notSafe = r.safe_to_drive != null && Number(r.safe_to_drive) === 0;
      if (!defItems && !notSafe) continue;
      const cur = out[rk] || (out[rk] = { items: 0, checks: 0, notSafe: false, since: "", latest: "" });
      cur.items += defItems;
      cur.checks += 1;
      if (notSafe) cur.notSafe = true;
      const at = r.checked_at || "";
      if (at) {
        if (!cur.since || new Date(at) < new Date(cur.since)) cur.since = at;
        if (!cur.latest || new Date(at) > new Date(cur.latest)) cur.latest = at;
      }
    }
  } catch {}
  return out;
}
// ── Per-defect resolution (Aug 2026) ───────────────────────────────────────
// Each individual reported fault can now be tracked/resolved on its own, with a
// status (open | pending | resolved) and an office note (e.g. "booked 5 Sep",
// "awaiting part"). Stored in app_config fleet:defectstatus:<tid> keyed by a
// STABLE per-defect id  `${REGNORM}::${checked_at}::${itemId}`  (and `__notsafe`
// for the driver's "not safe to drive" flag). The legacy per-reg bulk-clear
// timestamp (fleet:defectsclear) still resolves everything up to its time, but
// an explicit per-defect status ALWAYS wins over it (so one fault can be
// reopened or marked pending after a bulk resolve).
const DEFECTST_KEY = tid => `fleet:defectstatus:${tid}`;
// Renewal "booked / in hand" acknowledgements (MOT, tax, service). Presence marks
// a due item as PENDING (amber, with a note) instead of screaming red. Auto-stale:
// only honoured while the item is actually due — once the date renews it's ignored.
// app_config fleet:renewalack:<tid> = { REGNORM: { mot:{note,by,at}, tax:{}, service:{} } }.
const RENEWALACK_KEY = tid => `fleet:renewalack:${tid}`;
// Managed list of garages a service/MOT can be carried out at. Some garages COLLECT
// the van from HQ (PO15 5RQ) — flagged per garage, so the job is sited at HQ.
const GARAGES_KEY = tid => `fleet:garages:${tid}`;
const HQ_POSTCODE = "PO15 5RQ";
const HQ_NAME = "Mostlane HQ";
async function geocodePostcode(pc) {
  const p = String(pc || "").trim();
  if (!p) return null;
  try {
    const r = await fetch("https://api.postcodes.io/postcodes/" + encodeURIComponent(p));
    if (!r.ok) return null;
    const j = await r.json();
    if (j && j.result && j.result.latitude != null) return { lat: j.result.latitude, lng: j.result.longitude };
  } catch {}
  return null;
}
function daysToDate(s) { if (!s) return null; const d = new Date(s); if (isNaN(d)) return null; d.setHours(0, 0, 0, 0); const t = new Date(); t.setHours(0, 0, 0, 0); return Math.round((d - t) / 86400000); }
// ── Auto-made MOT/service appointment jobs ─────────────────────────────────
const RENEWAL_LABEL = { mot: "MOT", service: "Service" };
const renewalJobId = (reg, type) => `fleetsvc:${regKey(reg)}:${type}`;
// The portal user currently assigned to drive a reg (open assignment row, else
// the legacy users.vehicle_assigned field).
async function currentDriver(env, tid, reg) {
  const rk = dnReg(reg);
  try {
    const r = await env.DB.prepare("SELECT username FROM vehicle_assignments WHERE tenant_id=? AND UPPER(REPLACE(reg,' ',''))=? AND end_date IS NULL ORDER BY start_date DESC LIMIT 1").bind(tid, rk).first();
    if (r && r.username) return r.username;
  } catch {}
  try {
    const r = await env.DB.prepare("SELECT username FROM users WHERE tenant_id=? AND UPPER(REPLACE(vehicle_assigned,' ',''))=? LIMIT 1").bind(tid, rk).first();
    if (r && r.username) return r.username;
  } catch {}
  return "";
}
async function garageById(env, tid, id) {
  if (!id) return null;
  const raw = await appConfigJson(env, GARAGES_KEY(tid));
  return (Array.isArray(raw) ? raw : []).find(g => g.id === id) || null;
}
// Create (or update, by stable id) the SLA job for a booked MOT/service.
async function makeRenewalJob(env, tid, o) {
  const { reg, type, scheduledAt, durationMinutes, garage, driver, changedBy } = o;
  const label = RENEWAL_LABEL[type] || "Service";
  const collectHQ = !!(garage && garage.collectsFromHQ);
  const siteName = collectHQ ? `${HQ_NAME} — collected by ${garage.name}` : (garage ? garage.name : label);
  const postcode = collectHQ ? HQ_POSTCODE : (garage ? (garage.postcode || "") : "");
  let lat = collectHQ ? null : (garage && garage.lat != null ? garage.lat : null);
  let lng = collectHQ ? null : (garage && garage.lng != null ? garage.lng : null);
  if (collectHQ) { const g = await geocodePostcode(HQ_POSTCODE); if (g) { lat = g.lat; lng = g.lng; } }
  const where = garage ? (collectHQ ? ` · ${garage.name} collecting from HQ` : ` at ${garage.name}`) : "";
  const payload = {
    id: renewalJobId(reg, type),
    reference: `${label} — ${reg}`,
    description: `${label} appointment — ${reg}${where}`,
    fleetRenewal: true, vehicleReg: reg, renewalType: type,
    assignedEngineers: driver ? [driver] : [],
    siteName, postcode, lat, lon: lng, storeType: "fleet",
    scheduledAt, durationMinutes: durationMinutes || (type === "mot" ? 60 : 120),
    changedBy: changedBy || "fleet",
  };
  return createOrUpdateJobFromPayload(env, tid, payload);
}
async function removeRenewalJob(env, tid, jobId) {
  if (!jobId) return;
  try { await env.DB.prepare("DELETE FROM sla_jobs WHERE tenant_id=? AND id=?").bind(tid, jobId).run(); } catch {}
}
// When a van's driver changes, move any FUTURE booked MOT/service appointment to
// the new driver (or unassign if the van now has none).
async function reassignRenewalJobs(env, tid, reg, newDriver) {
  try {
    const map = await appConfigJson(env, RENEWALACK_KEY(tid));
    const entry = map[regKey(reg)]; if (!entry) return;
    const now = Date.now();
    for (const type of ["mot", "service"]) {
      const e = entry[type];
      if (!e || !e.jobId || !e.scheduledAt) continue;
      if (Date.parse(e.scheduledAt) < now) continue;   // past appointments left alone
      await createOrUpdateJobFromPayload(env, tid, newDriver
        ? { id: e.jobId, assignedEngineers: [newDriver], fleetRenewal: true, changedBy: "driver-change" }
        : { id: e.jobId, clearEngineers: true, fleetRenewal: true, changedBy: "driver-change" }
      ).catch(() => {});
    }
  } catch {}
}
async function appConfigJson(env, key) {
  try { const row = await env.DB.prepare("SELECT value FROM app_config WHERE key=?").bind(key).first(); return row && row.value ? (JSON.parse(row.value) || {}) : {}; }
  catch { return {}; }
}
function prettyId(id) { return String(id || "").replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim().replace(/\b\w/g, c => c.toUpperCase()) || "Item"; }
function defectLabelMap(settings) {
  const m = {}; const add = arr => { (arr || []).forEach(it => { if (it && it.id) m[it.id] = it.label || it.id; }); };
  add(settings && settings.checklist); add(settings && settings.equipment); return m;
}
// Flat list of EVERY reported defect across the fleet, each with its effective
// status. Loads what it needs unless the caller pre-passes maps (the vehicles
// hot path shares its already-fetched clear/status/settings reads).
async function collectDefects(env, tid, opts = {}) {
  const statusMap = opts.statusMap || await appConfigJson(env, DEFECTST_KEY(tid));
  const clearMap = opts.clearMap || await appConfigJson(env, DEFECTCLR_KEY(tid));
  const settings = opts.settings || await appConfigJson(env, "vancheck:settings");
  const names = opts.names || null;
  const baseLbl = defectLabelMap(settings);
  const out = [];
  try {
    const { results } = await env.DB.prepare(
      "SELECT vehicle, username, checked_at, safe_to_drive, items FROM vehicle_checks WHERE tenant_id=? AND vehicle IS NOT NULL AND vehicle!=''"
    ).bind(tid).all();
    for (const r of results || []) {
      let items = {}; try { items = r.items ? JSON.parse(r.items) : {}; } catch {}
      if (items.skipped) continue;
      const rk = regKey(r.vehicle);
      const at = r.checked_at || "";
      const answers = items.answers || {};
      const meta = items.answerMeta || {};
      const notes = items.defectNotes || {};
      const custLbl = items.custom ? defectLabelMap({ checklist: items.custom.checklist, equipment: items.custom.equipment }) : null;
      const clearAt = clearMap[rk] || "";
      const eff = key => {
        const s = statusMap[key];
        if (s && s.status) return { status: s.status, note: s.note || "", by: s.by || "", at: s.at || "" };
        if (clearAt && at && new Date(at) <= new Date(clearAt)) return { status: "resolved", note: "", by: "", at: clearAt };
        return { status: "open", note: "", by: "", at: "" };
      };
      const push = (itemId, kind, label, answerWord, driverNote) => {
        const key = `${rk}::${at}::${itemId}`;
        const e = eff(key);
        out.push({
          key, reg: r.vehicle, regNorm: rk, checkedAt: at, driver: r.username,
          driverName: names ? (names[r.username] || r.username) : r.username,
          itemId, kind, label, answer: answerWord, driverNote: driverNote || "",
          status: e.status, officeNote: e.note, statusBy: e.by, statusAt: e.at,
        });
      };
      for (const id of Object.keys(answers)) {
        const v = answers[id]; const m = meta[id];
        const tone = (m && m.tone) ? m.tone : ((v === "defect" || v === "missing") ? "issue" : "ok");
        if (tone !== "issue") continue;
        const label = (m && m.itemLabel) || (custLbl && custLbl[id]) || baseLbl[id] || prettyId(id);
        const answerWord = (m && m.label) || (v === "missing" ? "Missing" : "Defect");
        push(id, v === "missing" ? "missing" : "defect", label, answerWord, notes[id]);
      }
      if (r.safe_to_drive != null && Number(r.safe_to_drive) === 0) {
        push("__notsafe", "notsafe", "Not safe to drive", "Not safe", items.notSafeNote || "");
      }
    }
  } catch {}
  return out;
}
// Per-reg summary of UNRESOLVED defects (for the vehicle cards).
function defectSummary(list) {
  const out = {};
  for (const d of list) {
    if (d.status === "resolved") continue;
    const c = out[d.regNorm] || (out[d.regNorm] = { open: 0, pending: 0, notSafe: false, since: "" });
    if (d.status === "pending") c.pending++; else c.open++;
    if (d.kind === "notsafe") c.notSafe = true;
    if (d.checkedAt && (!c.since || new Date(d.checkedAt) < new Date(c.since))) c.since = d.checkedAt;
  }
  return out;
}
// Newest van-check date per vehicle (any outcome — this is "was it checked",
// not "did it pass"). Skipped weeks don't count as a real check.
async function lastVanCheckMap(env, tid) {
  const out = {};
  try {
    const { results } = await env.DB.prepare(
      "SELECT vehicle, checked_at, items FROM vehicle_checks WHERE tenant_id=? AND vehicle IS NOT NULL AND vehicle!=''"
    ).bind(tid).all();
    for (const r of results || []) {
      let items = {}; try { items = r.items ? JSON.parse(r.items) : {}; } catch {}
      if (items.skipped) continue;
      const rk = regKey(r.vehicle); const at = r.checked_at || "";
      if (!at) continue;
      if (!out[rk] || new Date(at) > new Date(out[rk])) out[rk] = at;
    }
  } catch {}
  return out;
}
// Serving URL for a gallery photo: uploaded vehicle photos are signed
// (/fleet/vehicle-photo); van-check photos use the public /asset-image route.
function galleryPhotoUrl(env, origin, key) {
  if (String(key).startsWith("vancheck/")) return origin + "/asset-image?key=" + encodeURIComponent(key);
  return signedFileUrl(env, origin, "/fleet/vehicle-photo", key);   // returns a promise
}

export async function handle(request, env, ctx, url, sess) {
  const headers = corsHeaders(env, request);
  const method = request.method.toUpperCase();
  const tid = sess ? sess.tenantId : await resolveTenantId(env, request);
  const sub = url.pathname.replace(/^\/fleet(?=\/|$)/, "") || "/";
  const q = url.searchParams;

  // ── Open a saved report (public, but access-gated by the signature) ────────
  if (sub === "/report" && method === "GET") {
    const key = q.get("key");
    if (!key || !String(key).startsWith("fleetreports/")) return jr({ error: "Bad key" }, headers, 400);
    if (!sess && !(await verifyFileSig(env, key, q))) return jr({ error: "Link expired or invalid" }, headers, 403);
    const obj = await env.JOB_FILES.get(key);
    if (!obj) return new Response("Not found", { status: 404, headers });
    return new Response(obj.body, { status: 200, headers: {
      ...headers, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, max-age=3600"
    }});
  }

  // ── Open a vehicle document (public, but access-gated by the signature) ────
  if (sub === "/vehicle-doc" && method === "GET") {
    const key = q.get("key");
    if (!key || !String(key).startsWith("vehicledocs/")) return jr({ error: "Bad key" }, headers, 400);
    if (!sess && !(await verifyFileSig(env, key, q))) return jr({ error: "Link expired or invalid" }, headers, 403);
    const obj = await env.JOB_FILES.get(key);
    if (!obj) return new Response("Not found", { status: 404, headers });
    return new Response(obj.body, { status: 200, headers: {
      ...headers, "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
      "Content-Disposition": "inline", "Cache-Control": "private, max-age=3600"
    }});
  }

  // ── Open a maintenance-record document (public, but signature-gated) ───────
  if (sub === "/maintenance-doc" && method === "GET") {
    const key = q.get("key");
    if (!key || !String(key).startsWith("vehiclemaint/")) return jr({ error: "Bad key" }, headers, 400);
    if (!sess && !(await verifyFileSig(env, key, q))) return jr({ error: "Link expired or invalid" }, headers, 403);
    const obj = await env.JOB_FILES.get(key);
    if (!obj) return new Response("Not found", { status: 404, headers });
    return new Response(obj.body, { status: 200, headers: {
      ...headers, "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
      "Content-Disposition": "inline", "Cache-Control": "private, max-age=3600"
    }});
  }

  // ── Open a vehicle photo (public, but access-gated by the signature) ───────
  if (sub === "/vehicle-photo" && method === "GET") {
    const key = q.get("key");
    if (!key || !String(key).startsWith("vehiclephotos/")) return jr({ error: "Bad key" }, headers, 400);
    if (!sess && !(await verifyFileSig(env, key, q))) return jr({ error: "Link expired or invalid" }, headers, 403);
    const obj = await env.JOB_FILES.get(key);
    if (!obj) return new Response("Not found", { status: 404, headers });
    return new Response(obj.body, { status: 200, headers: {
      ...headers, "Content-Type": obj.httpMetadata?.contentType || "image/jpeg",
      "Content-Disposition": "inline", "Cache-Control": "private, max-age=3600"
    }});
  }

  // Engineer's OWN van scores — any logged-in user (no Vehicles permission
  // needed), returns ONLY the caller's own rows. Placed before the fleet gate.
  if ((sub === "/scores/mine" || sub === "/scores/unseen") && method === "GET") {
    if (!sess) return jr({ error: "Not authenticated" }, headers, 401);
    await ensureScoresTable(env);
    const me = sess.user.username;
    if (sub === "/scores/unseen") {
      const row = await env.DB.prepare("SELECT COUNT(*) AS n, MAX(sent_at) AS latest FROM driver_scores WHERE tenant_id=? AND username=?").bind(tid, me).first();
      return jr({ ok: true, count: (row && row.n) || 0, latest: (row && row.latest) || "" }, headers);
    }
    const { results } = await env.DB.prepare(
      "SELECT week_start, week_end, reg, score, sent_at, rank, total FROM driver_scores WHERE tenant_id=? AND username=? ORDER BY week_start DESC"
    ).bind(tid, me).all();
    const scores = (results || []).map(r => ({
      weekStart: r.week_start, weekEnd: r.week_end || "", reg: r.reg || "", score: r.score, sentAt: r.sent_at || "",
      rank: r.rank || null, total: r.total || null,
    }));
    return jr({ ok: true, scores }, headers);
  }

  // Everything else needs a fleet-permitted session.
  if (!sess) return jr({ error: "Not authenticated" }, headers, 401);
  if (!(await canFleet(env, tid, sess))) return jr({ error: "Forbidden" }, headers, 403);

  // ── Reg → driver mapping (remembered across sessions/devices) ──────────────
  if (sub === "/drivers" && method === "GET") {
    let map = {};
    try { const row = await env.DB.prepare("SELECT value FROM app_config WHERE key=?").bind(DKEY(tid)).first(); if (row && row.value) map = JSON.parse(row.value) || {}; } catch {}
    return jr({ ok: true, map }, headers);
  }
  if (sub === "/drivers" && method === "POST") {
    const b = await readJson(request);
    const map = (b && b.map && typeof b.map === "object") ? b.map : {};
    await env.DB.prepare("INSERT INTO app_config (tenant_id, key, value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(tid, DKEY(tid), JSON.stringify(map)).run();
    return jr({ ok: true, map }, headers);
  }

  // ── Save a generated report ────────────────────────────────────────────────
  if (sub === "/report" && method === "POST") {
    const form = await request.formData();
    const file = form.get("html");
    if (!file) return jr({ error: "Missing report" }, headers, 400);
    const weekStart = String(form.get("weekStart") || "");
    const weekEnd = String(form.get("weekEnd") || "");
    // Reports auto-save on generate; replace any earlier report for the SAME week
    // range so regenerating (e.g. after fixing a driver) updates it in place
    // instead of piling up duplicates.
    if (weekStart || weekEnd) {
      try {
        const listed = await env.JOB_FILES.list({ prefix: prefix(tid), include: ["customMetadata"] });
        for (const o of listed.objects || []) {
          const m = o.customMetadata || {};
          if ((m.weekStart || "") === weekStart && (m.weekEnd || "") === weekEnd) { try { await env.JOB_FILES.delete(o.key); } catch {} }
        }
      } catch {}
    }
    const key = `${prefix(tid)}${Date.now()}-${(weekStart || "report").replace(/[^0-9-]/g, "")}.html`;
    // Status: 'draft' by default (fresh save), 'approved' once the office
    // confirms via /report-approve. Kept in R2 customMetadata so no schema
    // change; the reports list surfaces it as a badge.
    const status = String(form.get("status") || "draft") === "approved" ? "approved" : "draft";
    await env.JOB_FILES.put(key, typeof file.stream === "function" ? file.stream() : file, {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
      customMetadata: {
        title: String(form.get("title") || "Fleet report").slice(0, 160),
        weekStart, weekEnd, status,
        by: sess.user.username, at: new Date().toISOString()
      }
    });
    return jr({ ok: true, key, status }, headers, 201);
  }

  // ── Flip a saved report's status → approved (or back to draft) ────────────
  // POST { key, status } — copies the R2 object with new customMetadata (R2
  // doesn't let you edit metadata in place, so re-put with the same body).
  if (sub === "/report-approve" && method === "POST") {
    const b = await readJson(request);
    const key = String(b.key || "");
    const status = String(b.status || "approved") === "draft" ? "draft" : "approved";
    if (!key || !key.startsWith(prefix(tid))) return jr({ error: "Bad key" }, headers, 400);
    const obj = await env.JOB_FILES.get(key);
    if (!obj) return jr({ error: "Not found" }, headers, 404);
    const m = obj.customMetadata || {};
    await env.JOB_FILES.put(key, obj.body, {
      httpMetadata: obj.httpMetadata,
      customMetadata: { ...m, status, approvedBy: status === "approved" ? sess.user.username : "", approvedAt: status === "approved" ? new Date().toISOString() : "" }
    });
    return jr({ ok: true, status }, headers);
  }

  // ── List saved reports ─────────────────────────────────────────────────────
  if (sub === "/reports" && method === "GET") {
    const listed = await env.JOB_FILES.list({ prefix: prefix(tid), include: ["customMetadata"] });
    const reports = [];
    for (const o of listed.objects || []) {
      const m = o.customMetadata || {};
      reports.push({
        key: o.key, title: m.title || "Fleet report", weekStart: m.weekStart || "", weekEnd: m.weekEnd || "",
        by: m.by || "", at: m.at || (o.uploaded ? new Date(o.uploaded).toISOString() : ""), size: o.size,
        status: m.status || "approved",   // legacy rows (no status metadata) treated as approved
        approvedBy: m.approvedBy || "", approvedAt: m.approvedAt || "",
        url: await signedFileUrl(env, url.origin, "/fleet/report", o.key)
      });
    }
    reports.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
    return jr({ ok: true, reports }, headers);
  }

  // ── Delete a saved report ──────────────────────────────────────────────────
  if (sub === "/report-delete" && method === "POST") {
    const { key } = await readJson(request);
    if (!key || !String(key).startsWith("fleetreports/")) return jr({ error: "Bad key" }, headers, 400);
    await env.JOB_FILES.delete(key);
    return jr({ ok: true }, headers);
  }

  // ── Central driver-assignment registry (with history) ─────────────────────
  // Source of truth for "who drives which vehicle, when". Van checks read the
  // synced users.vehicle_assigned; the Fleet Report reads /fleet/current.
  if (sub === "/current" || sub === "/assignments" || sub === "/assign") {
    await ensureAssignTable(env);
    if (method === "GET") await seedAssignments(env, tid);

    if (sub === "/current" && method === "GET") {
      const week = q.get("week");
      let rows;
      if (week && /^\d{4}-\d{2}-\d{2}$/.test(week)) {
        const d = new Date(week + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + 6);
        const wkEnd = d.toISOString().slice(0, 10);
        rows = (await env.DB.prepare(
          "SELECT reg, username FROM vehicle_assignments WHERE tenant_id=? AND start_date<=? AND (end_date IS NULL OR end_date>=?) ORDER BY start_date"
        ).bind(tid, wkEnd, week).all()).results;
      } else {
        rows = (await env.DB.prepare("SELECT reg, username FROM vehicle_assignments WHERE tenant_id=? AND end_date IS NULL").bind(tid).all()).results;
      }
      const map = {}; for (const r of rows || []) map[r.reg] = r.username;
      return jr({ ok: true, map }, headers);
    }

    if (sub === "/assignments" && method === "GET") {
      const reg = q.get("reg");
      if (reg) {
        const history = (await env.DB.prepare(
          "SELECT reg, username, start_date, end_date, assigned_by, at FROM vehicle_assignments WHERE tenant_id=? AND reg=? ORDER BY start_date DESC, id DESC"
        ).bind(tid, reg).all()).results;
        return jr({ ok: true, history: history || [] }, headers);
      }
      const current = (await env.DB.prepare("SELECT reg, username FROM vehicle_assignments WHERE tenant_id=? AND end_date IS NULL").bind(tid).all()).results;
      return jr({ ok: true, current: current || [] }, headers);
    }

    if (sub === "/assign" && method === "POST") {
      const b = await readJson(request);
      const reg = String(b.reg || "").trim();
      const username = String(b.username || "").trim();
      const from = /^\d{4}-\d{2}-\d{2}$/.test(b.fromDate || "") ? b.fromDate : new Date().toISOString().slice(0, 10);
      if (!reg) return jr({ error: "reg required" }, headers, 400);
      const now = new Date().toISOString();
      // End the vehicle's current driver, and clear that person's vehicle field.
      await env.DB.prepare("UPDATE vehicle_assignments SET end_date=? WHERE tenant_id=? AND reg=? AND end_date IS NULL").bind(from, tid, reg).run();
      await env.DB.prepare("UPDATE users SET vehicle_assigned='' WHERE tenant_id=? AND vehicle_assigned=?").bind(tid, reg).run();
      if (username) {
        // The new driver moves off any other van they currently hold.
        await env.DB.prepare("UPDATE vehicle_assignments SET end_date=? WHERE tenant_id=? AND username=? AND end_date IS NULL").bind(from, tid, username).run();
        await env.DB.prepare("INSERT INTO vehicle_assignments (tenant_id, reg, username, start_date, end_date, assigned_by, at) VALUES (?,?,?,?,?,?,?)")
          .bind(tid, reg, username, from, null, sess.user.username, now).run();
        await env.DB.prepare("UPDATE users SET vehicle_assigned=? WHERE tenant_id=? AND username=?").bind(reg, tid, username).run();
      }
      // Any FUTURE booked MOT/service appointment for this van follows the new
      // driver automatically (or unassigns if the van now has none).
      await reassignRenewalJobs(env, tid, reg, username);
      return jr({ ok: true }, headers);
    }
  }

  // ── Vehicle registry (MOT / tax / service now in the portal) ──────────────
  if (sub === "/vehicles" && method === "GET") {
    await ensureVehTable(env); await ensureAssignTable(env); await seedAssignments(env, tid);
    const { results } = await env.DB.prepare("SELECT * FROM vehicles WHERE tenant_id=?").bind(tid).all();
    const cur = (await env.DB.prepare("SELECT reg, username FROM vehicle_assignments WHERE tenant_id=? AND end_date IS NULL").bind(tid).all()).results;
    const dn = s => String(s || "").replace(/\s+/g, "").toUpperCase();
    const drv = {}; for (const r of cur || []) drv[dn(r.reg)] = r.username;
    await ensureHandoverTable(env);
    const appCfg = async key => { try { const row = await env.DB.prepare("SELECT value FROM app_config WHERE key=?").bind(key).first(); return row && row.value ? (JSON.parse(row.value) || {}) : {}; } catch { return {}; } };
    // Gather everything the cards need CONCURRENTLY — these lookups are
    // independent, so running them in parallel turns ~10 stacked round trips into
    // one, which is the main win for this page's speed.
    const [miles, photos, covers, vcCounts, lastVc, mpg, money, defResolved, vcAck, defStatus, vcSettings, renewAck, hoRes, pendVcRes] = await Promise.all([
      latestMileage(env, tid),
      photoIndex(env, tid),
      coverMap(env, tid),
      vanCheckPhotoCounts(env, tid),     // van-check photos folded into the badge
      lastVanCheckMap(env, tid),         // newest van-check date per reg (card bar)
      mpgByVehicle(env, tid),
      canMoney(env, tid, sess),
      appCfg(DEFECTCLR_KEY(tid)),        // legacy per-reg bulk "resolved as of" mark
      appCfg(VCACK_KEY(tid)),
      appCfg(DEFECTST_KEY(tid)),         // per-defect statuses (open/pending/resolved)
      appCfg("vancheck:settings"),       // item labels for the defect list
      appCfg(RENEWALACK_KEY(tid)),       // MOT/tax/service "booked / in hand" acks
      env.DB.prepare("SELECT id, reg, status, completed_at FROM vehicle_handovers WHERE tenant_id=?").bind(tid).all(),
      // Pending one-off van-check REQUESTS per reg (so the card shows "requested"
      // and can't re-request until it's done). Fails soft if the table is absent.
      env.DB.prepare("SELECT DISTINCT reg FROM custom_van_checks WHERE tenant_id IN (?, '1', '1.0') AND status='pending' AND reg IS NOT NULL AND reg!=''").bind(String(tid)).all().catch(() => ({ results: [] })),
    ]);
    const pendVc = new Set((pendVcRes.results || []).map(r => dn(r.reg)));
    const defList = await collectDefects(env, tid, { statusMap: defStatus, clearMap: defResolved, settings: vcSettings });
    const defects = defectSummary(defList);   // { REGNORM: {open,pending,notSafe,since} }
    // Handover state per reg: latest completed (card's direct link) + whether one
    // is still pending (a badge / "awaiting handover" hint).
    const hoRows = hoRes.results || [];
    const lastHo = {}, pendHo = {};
    for (const h of hoRows) {
      const k = dn(h.reg);
      if (h.status === "done") { const cur = lastHo[k]; if (!cur || new Date(h.completed_at || 0) > new Date(cur.at || 0)) lastHo[k] = { id: h.id, at: h.completed_at || "" }; }
      else if (h.status === "pending") pendHo[k] = (pendHo[k] || 0) + 1;
    }
    // Money views (Full Access only): fuel/odo spans + last-12-months maintenance.
    let fuelV = {}, odoV = {}, maint12 = {};
    if (money) {
      await ensureMaintTable(env);
      const since = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
      const [fv, ov, mRes] = await Promise.all([
        fuelByVehicle(env, tid),
        odoByVehicle(env, tid),
        env.DB.prepare("SELECT reg, allocs FROM vehicle_maintenance WHERE tenant_id=? AND date>=?").bind(tid, since).all().catch(() => ({ results: [] })),
      ]);
      fuelV = fv; odoV = ov;
      for (const m of (mRes.results || [])) {
        const sum = (parseJson(m.allocs, []) || []).reduce((s, a) => s + (Number(a.cost) || 0), 0);
        maint12[dn(m.reg)] = (maint12[dn(m.reg)] || 0) + sum;
      }
    }
    // Approved leave over the booking horizon — to flag a driver who's off on the
    // day of their van's MOT/service appointment.
    let leaveMap = {};
    try {
      const today = new Date().toISOString().slice(0, 10);
      const horizon = new Date(Date.now() + 150 * 86400000).toISOString().slice(0, 10);
      leaveMap = await approvedLeaveInRange(env, tid, today, horizon);
    } catch {}
    const vehicles = await Promise.all((results || []).map(async v => {
      const cm = miles[dn(v.reg)] || null;
      const sv = serviceView(v, cm);
      // Cover photo for the card: the manually-chosen one if it still exists,
      // else newest uploaded. A van-check photo can be the cover too (trusted —
      // van-check records are rarely deleted; a stale key just 404s the image).
      const pics = photos[dn(v.reg)] || [];
      let coverKey = covers[dn(v.reg)];
      const coverValid = coverKey && (String(coverKey).startsWith("vancheck/") || pics.some(p => p.key === coverKey));
      if (!coverValid) coverKey = pics.length ? pics[0].key : "";
      return {
        reg: v.reg, make: v.make, model: v.model, fuel: v.fuel, active: v.active !== 0,
        motDue: v.mot_due || "", taxDue: v.tax_due || "", nextServiceDate: sv.dueDate || "",
        notes: v.notes || "", driver: drv[dn(v.reg)] || "",
        svcIntervalDays: v.svc_interval_days || null, svcIntervalMiles: v.svc_interval_miles || null,
        lastServiceDate: v.last_service_date || "", lastServiceMiles: v.last_service_miles != null ? v.last_service_miles : null,
        warnDays: sv.warnDays, warnMiles: sv.warnMiles,
        serviceDueMiles: sv.dueMiles, serviceStatus: sv.status, serviceReason: sv.reason,
        currentMiles: cm ? cm.miles : null, milesAt: cm ? cm.at : "",
        specs: parseJson(v.specs, []),
        photoCount: pics.length + (vcCounts[dn(v.reg)] || 0),
        photoUrl: coverKey ? await galleryPhotoUrl(env, url.origin, coverKey) : "",
        lastHandoverId: (lastHo[dn(v.reg)] || {}).id || null,
        lastHandoverAt: (lastHo[dn(v.reg)] || {}).at || "",
        pendingHandover: pendHo[dn(v.reg)] || 0,
        currentMpg: (mpg[dn(v.reg)] || {}).mpg || null,
        // Outstanding van-check defects, now split by status (open needs sorting,
        // pending = booked in / awaiting). Resolved individually or in bulk.
        defectOpen: (defects[regKey(v.reg)] || {}).open || 0,
        defectPending: (defects[regKey(v.reg)] || {}).pending || 0,
        defectNotSafe: !!(defects[regKey(v.reg)] || {}).notSafe,
        defectSince: (defects[regKey(v.reg)] || {}).since || "",
        // Renewal "booked / in hand" acks — surfaced only while the item is still
        // due (a renewed date auto-clears the amber). Value = the note (or true).
        ...(() => {
          const a = renewAck[regKey(v.reg)] || {};
          const dm = daysToDate(v.mot_due), dt = daysToDate(v.tax_due);
          const due = { mot: dm != null && dm <= 30, tax: dt != null && dt <= 30, service: sv.status === "warn" || sv.status === "bad" };
          const driver = drv[dn(v.reg)] || "";
          const pend = k => (due[k] && a[k]) ? (a[k].note || true) : "";
          const appt = k => (due[k] && a[k] && a[k].apptDate) ? { date: a[k].apptDate, garage: a[k].garageName || "", jobId: a[k].jobId || "" } : null;
          const clash = k => { const e = due[k] ? a[k] : null; if (!e || !e.apptDate || !driver) return null; return (leaveMap[driver] && leaveMap[driver][e.apptDate]) ? { date: e.apptDate, driver } : null; };
          return {
            motPending: pend("mot"), taxPending: pend("tax"), servicePending: pend("service"),
            motAppt: appt("mot"), serviceAppt: appt("service"),
            motClash: clash("mot"), serviceClash: clash("service"),
          };
        })(),
        lastVanCheckAt: lastVc[dn(v.reg)] || "",   // newest van check date
        vanCheck: vanCheckState(lastVc[dn(v.reg)] || "", vcAck[dn(v.reg)]),   // card status bar: ok | ack | due
        vanCheckRequested: pendVc.has(dn(v.reg)),  // a one-off check is pending — hide the Request button

        // Money views — Full Access only.
        finance: money ? financeOf(v) : undefined,
        runningCost: money ? runningCost(financeOf(v), fuelV[dn(v.reg)], odoV[dn(v.reg)], maint12[dn(v.reg)] || 0) : undefined
      };
    }));
    // Apply the saved manual order (drag-to-reorder); unknown regs fall to the
    // end alphabetically so newly-added vans still appear.
    let order = [];
    try { const row = await env.DB.prepare("SELECT value FROM app_config WHERE key=?").bind(`fleet:vehorder:${tid}`).first(); if (row && row.value) order = JSON.parse(row.value) || []; } catch {}
    const oidx = {}; order.forEach((r, i) => oidx[dn(r)] = i);
    vehicles.sort((a, b) => {
      const ia = oidx[dn(a.reg)], ib = oidx[dn(b.reg)];
      if (ia == null && ib == null) return String(a.reg).localeCompare(String(b.reg));
      if (ia == null) return 1;
      if (ib == null) return -1;
      return ia - ib;
    });
    return jr({ ok: true, vehicles }, headers);
  }
  if ((sub === "/vehicle" || sub === "/vehicles-import") && method === "POST") {
    await ensureVehTable(env);
    const b = await readJson(request);
    const list = sub === "/vehicles-import" ? (b.vehicles || []) : [b];
    const num = x => { const n = parseInt(String(x == null ? "" : x).replace(/[^0-9]/g, ""), 10); return isNaN(n) ? null : n; };
    let count = 0;
    for (const v of list) {
      const reg = String(v.reg || "").trim(); if (!reg) continue;
      await env.DB.prepare(`INSERT INTO vehicles
        (tenant_id,reg,make,model,fuel,active,mot_due,tax_due,next_service,notes,
         svc_interval_days,svc_interval_miles,last_service_date,last_service_miles,warn_days,warn_miles,at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,reg) DO UPDATE SET
        make=excluded.make,model=excluded.model,fuel=excluded.fuel,active=excluded.active,
        mot_due=excluded.mot_due,tax_due=excluded.tax_due,next_service=excluded.next_service,notes=excluded.notes,
        svc_interval_days=excluded.svc_interval_days,svc_interval_miles=excluded.svc_interval_miles,
        last_service_date=excluded.last_service_date,last_service_miles=excluded.last_service_miles,
        warn_days=excluded.warn_days,warn_miles=excluded.warn_miles,at=excluded.at`)
        .bind(tid, reg, v.make || "", v.model || "", v.fuel || "", v.active === false ? 0 : 1,
          v.motDue || v.motDate || "", v.taxDue || v.taxDate || "", v.nextServiceDate || v.serviceDate || "", v.notes || "",
          num(v.svcIntervalDays), num(v.svcIntervalMiles), v.lastServiceDate || "", num(v.lastServiceMiles),
          num(v.warnDays), num(v.warnMiles), new Date().toISOString()).run();
      // Extra spec fields (AC, payload, dimensions, handsfree …) are stored as a
      // JSON array of {label,value}. Only written when supplied, so the legacy
      // import (which carries no specs) never wipes an existing vehicle's specs.
      if (v.specs !== undefined) {
        const specsStr = typeof v.specs === "string" ? v.specs : JSON.stringify(Array.isArray(v.specs) ? v.specs : []);
        await env.DB.prepare("UPDATE vehicles SET specs=? WHERE tenant_id=? AND reg=?").bind(specsStr, tid, reg).run();
      }
      count++;
    }
    return jr({ ok: true, count }, headers);
  }
  if (sub === "/vehicle-delete" && method === "POST") {
    const b = await readJson(request); const reg = String(b.reg || "").trim();
    if (!reg) return jr({ error: "reg required" }, headers, 400);
    await env.DB.prepare("DELETE FROM vehicles WHERE tenant_id=? AND reg=?").bind(tid, reg).run();
    // Tidy up: close any open assignments + delete the vehicle's uploaded documents.
    await env.DB.prepare("UPDATE vehicle_assignments SET end_date=? WHERE tenant_id=? AND reg=? AND end_date IS NULL")
      .bind(new Date().toISOString().slice(0, 10), tid, reg).run();
    try {
      const listed = await env.JOB_FILES.list({ prefix: vdocPrefix(tid, reg) });
      for (const o of listed.objects || []) await env.JOB_FILES.delete(o.key);
      const pics = await env.JOB_FILES.list({ prefix: vphotoPrefix(tid, reg) });
      for (const o of pics.objects || []) await env.JOB_FILES.delete(o.key);
      const maint = await env.JOB_FILES.list({ prefix: vmaintPrefix(tid, reg) });
      for (const o of maint.objects || []) await env.JOB_FILES.delete(o.key);
    } catch {}
    try { await ensureMaintTable(env); await env.DB.prepare("DELETE FROM vehicle_maintenance WHERE tenant_id=? AND reg=?").bind(tid, reg).run(); } catch {}
    // Handover records + their photos/signatures (keyed by driver+id in ASSET_BUCKET).
    try {
      await ensureHandoverTable(env);
      const hos = (await env.DB.prepare("SELECT id, username FROM vehicle_handovers WHERE tenant_id=? AND reg=?").bind(tid, reg).all()).results || [];
      for (const h of hos) {
        const ud = String(h.username).replace(/[^A-Za-z0-9._-]/g, "_");
        try { const l = await env.ASSET_BUCKET.list({ prefix: `handover/${ud}/${h.id}/` }); for (const o of l.objects || []) await env.ASSET_BUCKET.delete(o.key); } catch {}
      }
      await env.DB.prepare("DELETE FROM vehicle_handovers WHERE tenant_id=? AND reg=?").bind(tid, reg).run();
    } catch {}
    try { const covers = await coverMap(env, tid); if (covers[regKey(reg)]) { delete covers[regKey(reg)]; await saveCoverMap(env, tid, covers); } } catch {}
    return jr({ ok: true }, headers);
  }

  // ── Manual card order (drag-to-reorder on the Vehicles page) ──────────────
  if (sub === "/vehicle-order" && method === "GET") {
    let order = [];
    try { const row = await env.DB.prepare("SELECT value FROM app_config WHERE key=?").bind(`fleet:vehorder:${tid}`).first(); if (row && row.value) order = JSON.parse(row.value) || []; } catch {}
    return jr({ ok: true, order }, headers);
  }
  if (sub === "/vehicle-order" && method === "POST") {
    const b = await readJson(request);
    const order = Array.isArray(b.order) ? b.order.map(String) : [];
    await env.DB.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(tid, `fleet:vehorder:${tid}`, JSON.stringify(order)).run();
    return jr({ ok: true }, headers);
  }

  // ── Vehicle documents (repair invoices, receipts) ─────────────────────────
  if (sub === "/vehicle-docs" && method === "GET") {
    const reg = q.get("reg") || "";
    if (!reg) return jr({ error: "reg required" }, headers, 400);
    const listed = await env.JOB_FILES.list({ prefix: vdocPrefix(tid, reg), include: ["customMetadata"] });
    const docs = [];
    for (const o of listed.objects || []) {
      const m = o.customMetadata || {};
      docs.push({
        key: o.key, name: m.name || o.key.split("/").pop(), by: m.by || "",
        at: m.at || (o.uploaded ? new Date(o.uploaded).toISOString() : ""), size: o.size,
        url: await signedFileUrl(env, url.origin, "/fleet/vehicle-doc", o.key)
      });
    }
    docs.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
    return jr({ ok: true, docs }, headers);
  }
  if (sub === "/vehicle-doc" && method === "POST") {
    const form = await request.formData();
    const reg = String(form.get("reg") || "").trim();
    const file = form.get("file");
    if (!reg || !file) return jr({ error: "reg and file required" }, headers, 400);
    const safe = String(file.name || "document").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
    const key = `${vdocPrefix(tid, reg)}${Date.now()}-${safe}`;
    await env.JOB_FILES.put(key, file.stream(), {
      httpMetadata: { contentType: file.type || "application/octet-stream" },
      customMetadata: { name: file.name || safe, by: sess.user.username, at: new Date().toISOString() }
    });
    return jr({ ok: true, key, url: await signedFileUrl(env, url.origin, "/fleet/vehicle-doc", key) }, headers, 201);
  }
  if (sub === "/vehicle-doc-delete" && method === "POST") {
    const b = await readJson(request); const key = String(b.key || "");
    if (!key || !key.startsWith("vehicledocs/")) return jr({ error: "Bad key" }, headers, 400);
    await env.JOB_FILES.delete(key);
    return jr({ ok: true }, headers);
  }

  // ── Maintenance categories (managed list + colours for the charts) ────────
  if (sub === "/maint-categories" && method === "GET") {
    return jr({ ok: true, categories: await maintCats(env, tid) }, headers);
  }
  if (sub === "/maint-categories" && method === "POST") {
    const b = await readJson(request);
    const seen = new Set(), out = [];
    for (const c of Array.isArray(b.categories) ? b.categories : []) {
      const name = String(c && c.name || "").trim().slice(0, 40);
      if (!name) continue;
      const k = name.toLowerCase(); if (seen.has(k)) continue; seen.add(k);
      out.push({ name, colour: String(c.colour || "#64748b").slice(0, 9) });
    }
    await env.DB.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(tid, MCATS_KEY(tid), JSON.stringify(out)).run();
    return jr({ ok: true, categories: out }, headers);
  }

  // ── Maintenance records (dated work, categorised, cost-split) ─────────────
  // A record = date + description + optional document + one or more category
  // allocations [{cat,cost}]. A £450 invoice split Brakes £200 / Tyres £250 is
  // one record whose document appears under BOTH categories when filtered, and
  // whose costs sum into each category's total. Rows live in vehicle_maintenance.
  if (sub === "/maintenance" && method === "GET") {
    await ensureMaintTable(env);
    const reg = q.get("reg") || "";
    if (!reg) return jr({ error: "reg required" }, headers, 400);
    const { results } = await env.DB.prepare(
      "SELECT * FROM vehicle_maintenance WHERE tenant_id=? AND reg=? ORDER BY date DESC, id DESC"
    ).bind(tid, reg).all();
    const records = [];
    for (const r of results || []) {
      const allocs = (parseJson(r.allocs, []) || [])
        .map(a => {
          const o = { cat: String(a.cat || a.category || ""), cost: Number(a.cost) || 0 };
          const q = Number(a.qty);
          if (a.qty != null && a.qty !== "" && Number.isFinite(q) && q >= 0) o.qty = q;
          return o;
        })
        .filter(a => a.cat);
      records.push({
        id: r.id, date: r.date || "", description: r.description || "", allocs,
        total: allocs.reduce((s, a) => s + a.cost, 0),
        docKey: r.doc_key || "", docName: r.doc_name || "",
        docUrl: r.doc_key ? await signedFileUrl(env, url.origin, "/fleet/maintenance-doc", r.doc_key) : "",
        by: r.by || "", at: r.at || ""
      });
    }
    const totals = {}; let grandTotal = 0;
    for (const rec of records) for (const a of rec.allocs) { totals[a.cat] = (totals[a.cat] || 0) + a.cost; grandTotal += a.cost; }
    return jr({ ok: true, reg, records, totals, grandTotal, categories: await maintCats(env, tid) }, headers);
  }
  if (sub === "/maintenance" && method === "POST") {
    await ensureMaintTable(env);
    const form = await request.formData();
    const reg = String(form.get("reg") || "").trim();
    if (!reg) return jr({ error: "reg required" }, headers, 400);
    const id = parseInt(String(form.get("id") || ""), 10);
    const date = String(form.get("date") || "").slice(0, 10);
    const description = String(form.get("description") || "").slice(0, 500);
    const allocs = (parseJson(String(form.get("allocs") || "[]"), []) || [])
      .map(a => {
        const o = { cat: String(a.cat || a.category || "").trim().slice(0, 40), cost: Math.round((Number(a.cost) || 0) * 100) / 100 };
        const q = Math.round(Number(a.qty));
        if (a.qty != null && a.qty !== "" && Number.isFinite(q) && q >= 0) o.qty = q;   // optional item count (tyres, punctures…)
        return o;
      })
      .filter(a => a.cat);
    const file = form.get("file");
    const removeDoc = String(form.get("removeDoc") || "") === "1";
    const now = new Date().toISOString();

    const existing = (id && !isNaN(id))
      ? await env.DB.prepare("SELECT * FROM vehicle_maintenance WHERE tenant_id=? AND id=?").bind(tid, id).first()
      : null;
    let docKey = existing ? (existing.doc_key || "") : "";
    let docName = existing ? (existing.doc_name || "") : "";
    if (file && typeof file.stream === "function") {
      if (docKey) { try { await env.JOB_FILES.delete(docKey); } catch {} }   // replace old document
      const safe = String(file.name || "document").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
      docKey = `${vmaintPrefix(tid, reg)}${Date.now()}-${safe}`;
      docName = file.name || safe;
      await env.JOB_FILES.put(docKey, file.stream(), {
        httpMetadata: { contentType: file.type || "application/octet-stream" },
        customMetadata: { name: docName, reg, by: sess.user.username, at: now }
      });
    } else if (removeDoc && docKey) {
      try { await env.JOB_FILES.delete(docKey); } catch {}
      docKey = ""; docName = "";
    }

    if (existing) {
      await env.DB.prepare("UPDATE vehicle_maintenance SET date=?,description=?,allocs=?,doc_key=?,doc_name=? WHERE tenant_id=? AND id=?")
        .bind(date, description, JSON.stringify(allocs), docKey, docName, tid, id).run();
      return jr({ ok: true, id }, headers);
    }
    const res = await env.DB.prepare(
      "INSERT INTO vehicle_maintenance (tenant_id,reg,date,description,allocs,doc_key,doc_name,by,at) VALUES (?,?,?,?,?,?,?,?,?)"
    ).bind(tid, reg, date, description, JSON.stringify(allocs), docKey, docName, sess.user.username, now).run();
    return jr({ ok: true, id: res.meta ? res.meta.last_row_id : null }, headers, 201);
  }
  if (sub === "/maintenance-delete" && method === "POST") {
    await ensureMaintTable(env);
    const b = await readJson(request); const id = parseInt(String(b.id || ""), 10);
    if (!id || isNaN(id)) return jr({ error: "id required" }, headers, 400);
    const row = await env.DB.prepare("SELECT doc_key FROM vehicle_maintenance WHERE tenant_id=? AND id=?").bind(tid, id).first();
    if (row && row.doc_key) { try { await env.JOB_FILES.delete(row.doc_key); } catch {} }
    await env.DB.prepare("DELETE FROM vehicle_maintenance WHERE tenant_id=? AND id=?").bind(tid, id).run();
    return jr({ ok: true }, headers);
  }

  // ── Fleet Insights (Full Access) — spend per van, per category, + fuel ─────
  // Aggregates maintenance (per category) + fuel-card spend across the whole
  // fleet for a date range, so you can compare vans (£ each, tyres each, etc.).
  if (sub === "/insights" && method === "GET") {
    if (!(await canMoney(env, tid, sess))) return jr({ error: "Forbidden" }, headers, 403);
    await ensureVehTable(env); await ensureMaintTable(env); await ensureFuelTable(env);
    const from = q.get("from") || "", to = q.get("to") || "";      // YYYY-MM-DD inclusive
    const inRange = d => (!from || (d && d >= from)) && (!to || (d && d <= to));
    const r2 = x => Math.round((Number(x) || 0) * 100) / 100;
    const cats = await maintCats(env, tid);

    const per = {};
    const ensureV = (reg) => { const k = dnReg(reg); return per[k] || (per[k] = { reg, maint: 0, fuel: 0, litres: 0, po: 0, byCat: {} }); };
    const vrows = (await env.DB.prepare("SELECT reg FROM vehicles WHERE tenant_id=?").bind(tid).all()).results || [];
    vrows.forEach(v => { if (v.reg) ensureV(v.reg); });

    // Maintenance — sum each cost allocation into its vehicle + category. The
    // count reflects the line's QUANTITY (e.g. 4 tyres, 2 puncture repairs) when
    // one is set, else 1 per line (legacy invoices) — so "how many tyres" is a
    // real total, comparable per van.
    const { results: mrows } = await env.DB.prepare("SELECT reg, date, allocs FROM vehicle_maintenance WHERE tenant_id=?").bind(tid).all();
    for (const m of mrows || []) {
      if (!m.reg || !inRange(m.date)) continue;
      const v = ensureV(m.reg);
      for (const a of parseJson(m.allocs, []) || []) {
        const cat = a.cat || "Other", cost = Number(a.cost) || 0;
        const q = Number(a.qty);
        const n = (a.qty != null && a.qty !== "" && Number.isFinite(q) && q >= 0) ? q : 1;
        v.maint += cost;
        const c = v.byCat[cat] || (v.byCat[cat] = { cost: 0, count: 0 });
        c.cost += cost; c.count += n;
      }
    }

    // Fuel — attribute each fill-up to the vehicle the card holder drove that day.
    const { byCard } = await fuelCardMap(env, tid);
    const userCurrent = {}; for (const c of Object.values(byCard)) userCurrent[c.username] = c.vehicle;
    const intervals = await assignmentIntervals(env, tid);
    const { results: frows } = await env.DB.prepare("SELECT card, username, reg, date, litres, cost FROM fuel_entries WHERE tenant_id=?").bind(tid).all();
    for (const e of frows || []) {
      if (!inRange(e.date)) continue;
      let reg = e.reg || "";   // directly-tagged reg (import) wins
      if (!reg) {
        const user = e.username || (byCard[e.card] ? byCard[e.card].username : "");
        if (!user) continue;
        reg = regForUserOnDate(intervals, user, e.date || "") || userCurrent[user] || "";
      }
      if (!reg) continue;
      const v = ensureV(reg);
      v.fuel += Number(e.cost) || 0; v.litres += Number(e.litres) || 0;
    }

    // Purchase orders tagged to a vehicle (parts / AdBlue…). Only priced POs
    // count; degrades to nothing until the PO worker stamps vehicle_reg.
    for (const p of await vehiclePoRows(env, { from, to })) {
      const c = (p.cost_ex_vat != null && p.cost_ex_vat !== "") ? Number(p.cost_ex_vat) : 0;
      if (!isFinite(c) || !c || !p.vehicle_reg) continue;
      ensureV(p.vehicle_reg).po += c;
    }

    const vehicles = Object.values(per).map(v => {
      const byCat = {}; for (const [cat, c] of Object.entries(v.byCat)) byCat[cat] = { cost: r2(c.cost), count: c.count };
      return { reg: v.reg, maint: r2(v.maint), fuel: r2(v.fuel), po: r2(v.po), litres: Math.round(v.litres * 10) / 10, total: r2(v.maint + v.fuel + v.po), byCat };
    }).sort((a, b) => b.total - a.total);

    const fleet = { maint: 0, fuel: 0, po: 0, total: 0, byCat: {} };
    for (const v of vehicles) {
      fleet.maint += v.maint; fleet.fuel += v.fuel; fleet.po += v.po; fleet.total += v.total;
      for (const [cat, c] of Object.entries(v.byCat)) { const f = fleet.byCat[cat] || (fleet.byCat[cat] = { cost: 0, count: 0 }); f.cost = r2(f.cost + c.cost); f.count += c.count; }
    }
    fleet.maint = r2(fleet.maint); fleet.fuel = r2(fleet.fuel); fleet.po = r2(fleet.po); fleet.total = r2(fleet.total);

    return jr({ ok: true, from, to, categories: cats, vehicles, fleet }, headers);
  }

  // ── Odometer readings (build the MPG picture) ─────────────────────────────
  // Ad-hoc mileage readings for a van, separate from van checks. Fuel is
  // windowed to the reading period so MPG is a true figure. Any Vehicles user.
  if (sub === "/odometer" && method === "GET") {
    await ensureOdoTable(env);
    const reg = q.get("reg") || "";
    if (!reg) return jr({ error: "reg required" }, headers, 400);
    const { results } = await env.DB.prepare(
      "SELECT id, reg, date, miles, note, by, source FROM odometer_readings WHERE tenant_id=? AND UPPER(REPLACE(reg,' ',''))=? ORDER BY date DESC, id DESC"
    ).bind(tid, dnReg(reg)).all();
    const readings = (results || []).map(r => ({ id: r.id, date: r.date || "", miles: r.miles, note: r.note || "", by: r.by || "", source: r.source || "manual" }));
    const mpg = await mpgForReg(env, tid, reg);
    return jr({ ok: true, reg, readings, mpg }, headers);
  }
  if (sub === "/odometer" && method === "POST") {
    await ensureOdoTable(env);
    const b = await readJson(request);
    const reg = String(b.reg || "").trim();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || "") ? b.date : "";
    const milesV = parseInt(String(b.miles == null ? "" : b.miles).replace(/[^0-9]/g, ""), 10);
    if (!reg || !date || !milesV) return jr({ error: "reg, date and miles are required" }, headers, 400);
    const note = String(b.note || "").slice(0, 120);
    const id = parseInt(String(b.id || ""), 10);
    const now = new Date().toISOString();
    if (id && !isNaN(id)) {
      await env.DB.prepare("UPDATE odometer_readings SET reg=?,date=?,miles=?,note=?,source='manual' WHERE tenant_id=? AND id=?").bind(reg, date, milesV, note, tid, id).run();
      return jr({ ok: true, id }, headers);
    }
    const ex = await env.DB.prepare("SELECT id FROM odometer_readings WHERE tenant_id=? AND UPPER(REPLACE(reg,' ',''))=? AND date=?").bind(tid, dnReg(reg), date).first();
    if (ex && ex.id) { await env.DB.prepare("UPDATE odometer_readings SET miles=?,note=?,source='manual' WHERE tenant_id=? AND id=?").bind(milesV, note, tid, ex.id).run(); return jr({ ok: true, id: ex.id, updated: true }, headers); }
    const res = await env.DB.prepare("INSERT INTO odometer_readings (tenant_id,reg,date,miles,note,by,at,source) VALUES (?,?,?,?,?,?,?, 'manual')").bind(tid, reg, date, milesV, note, sess.user.username, now).run();
    return jr({ ok: true, id: res.meta ? res.meta.last_row_id : null }, headers, 201);
  }
  if (sub === "/odometer/import" && method === "POST") {
    await ensureOdoTable(env);
    const b = await readJson(request);
    const reg = String(b.reg || "").trim();
    const readings = Array.isArray(b.readings) ? b.readings : [];
    if (!reg || !readings.length) return jr({ error: "reg + readings required" }, headers, 400);
    // Imported readings default to 'fuel' (secondary); a caller can pass 'manual'.
    const source = b.source === "manual" ? "manual" : "fuel";
    const rank = ODO_RANK[source] || 1;
    const now = new Date().toISOString();
    let created = 0, updated = 0, skipped = 0;
    for (const rd of readings) {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(rd.date || "") ? rd.date : "";
      const milesV = parseInt(String(rd.miles == null ? "" : rd.miles).replace(/[^0-9]/g, ""), 10);
      if (!date || !milesV) { skipped++; continue; }
      const ex = await env.DB.prepare("SELECT id, source FROM odometer_readings WHERE tenant_id=? AND UPPER(REPLACE(reg,' ',''))=? AND date=?").bind(tid, dnReg(reg), date).first();
      if (ex && ex.id) {
        // Never let a lower-ranked source (e.g. a fuel reading) clobber a better one.
        if (rank < (ODO_RANK[ex.source || "manual"] || 1)) { skipped++; continue; }
        await env.DB.prepare("UPDATE odometer_readings SET miles=?,source=? WHERE tenant_id=? AND id=?").bind(milesV, source, tid, ex.id).run(); updated++;
      } else {
        await env.DB.prepare("INSERT INTO odometer_readings (tenant_id,reg,date,miles,note,by,at,source) VALUES (?,?,?,?,?,?,?,?)").bind(tid, reg, date, milesV, "", sess.user.username, now, source).run(); created++;
      }
    }
    return jr({ ok: true, created, updated, skipped }, headers);
  }
  if (sub === "/odometer-delete" && method === "POST") {
    await ensureOdoTable(env);
    const b = await readJson(request);
    const id = parseInt(String(b.id || ""), 10);
    if (!id || isNaN(id)) return jr({ error: "id required" }, headers, 400);
    await env.DB.prepare("DELETE FROM odometer_readings WHERE tenant_id=? AND id=?").bind(tid, id).run();
    return jr({ ok: true }, headers);
  }

  // ── Purchase orders tagged to ONE vehicle (live from PO_DB) ───────────────
  // Lists the POs raised against a van (AdBlue, parts…) so they surface in the
  // vehicle deep-dive. Any Vehicles user may SEE the list; the £ figures are
  // stripped unless they're Full Access (money), mirroring fuel/finance.
  if (sub === "/vehicle-pos" && method === "GET") {
    const reg = q.get("reg") || "";
    if (!reg) return jr({ error: "reg required" }, headers, 400);
    const money = await canMoney(env, tid, sess);
    const from = q.get("from") || "", to = q.get("to") || "";
    const rows = await vehiclePoRows(env, { reg, from, to });
    let total = 0, unpriced = 0;
    const pos = rows.map(r => {
      const raw = (r.cost_ex_vat != null && r.cost_ex_vat !== "") ? Number(r.cost_ex_vat) : null;
      const priced = raw != null && isFinite(raw);
      if (priced) total += raw; else unpriced++;
      return {
        supplier: r.supplier || "", category: r.cost_category || "", trade: r.trade || "",
        cost: money ? (priced ? Math.round(raw * 100) / 100 : null) : undefined,
        ref: r.incident_no || r.job_ref || "", by: r.engineer_name || "",
        site: r.site || "", date: r.d || ""
      };
    });
    return jr({
      ok: true, reg, poBound: !!env.PO_DB, money, count: pos.length,
      total: money ? Math.round(total * 100) / 100 : undefined, unpriced, pos
    }, headers);
  }

  // ── Fuel cards + spend entries + stats + vehicle financials ───────────────
  // Fuel (cards/entries/stats/MPG) is open to any Vehicles user; the vehicle
  // FINANCIALS (insurance/finance) + the running-cost rollup stay Full-Access.
  if (sub === "/finance" || sub === "/fuel/cards" || sub === "/fuel/entries" ||
      sub === "/fuel/entry" || sub === "/fuel/entry-delete" || sub === "/fuel/stats" ||
      sub === "/fuel/import") {

    // Save a vehicle's financials — Full Access only (money).
    if (sub === "/finance" && method === "POST") {
      if (!(await canMoney(env, tid, sess))) return jr({ error: "Forbidden" }, headers, 403);
      await ensureVehTable(env);
      const b = await readJson(request);
      const reg = String(b.reg || "").trim();
      if (!reg) return jr({ error: "reg required" }, headers, 400);
      const f = b.finance && typeof b.finance === "object" ? b.finance : {};
      const num = x => { const n = Number(x); return isFinite(n) && n !== 0 ? n : (x === 0 || x === "0" ? 0 : null); };
      const clean = {
        ownership: f.ownership === "financed" ? "financed" : "owned",
        insuranceYear: num(f.insuranceYear), roadTaxYear: num(f.roadTaxYear),
        financeMonthly: num(f.financeMonthly), financeEnd: /^\d{4}-\d{2}-\d{2}$/.test(f.financeEnd || "") ? f.financeEnd : "",
        allowedMiles: num(f.allowedMiles), excessPence: num(f.excessPence),
        note: String(f.note || "").slice(0, 300),
      };
      await env.DB.prepare("UPDATE vehicles SET finance=? WHERE tenant_id=? AND reg=?").bind(JSON.stringify(clean), tid, reg).run();
      return jr({ ok: true, finance: clean }, headers);
    }

    // Card list (card → user → current vehicle), from users.profile.fuelCard.
    if (sub === "/fuel/cards" && method === "GET") {
      const { cards } = await fuelCardMap(env, tid);
      cards.sort((a, b) => (b.active - a.active) || String(a.name).localeCompare(String(b.name)));
      return jr({ ok: true, cards }, headers);
    }

    // List spend entries (optionally for one card), newest first.
    if (sub === "/fuel/entries" && method === "GET") {
      await ensureFuelTable(env);
      const card = q.get("card") || "";
      const rows = card
        ? (await env.DB.prepare("SELECT * FROM fuel_entries WHERE tenant_id=? AND card=? ORDER BY date DESC, id DESC").bind(tid, card).all()).results
        : (await env.DB.prepare("SELECT * FROM fuel_entries WHERE tenant_id=? ORDER BY date DESC, id DESC").bind(tid).all()).results;
      const { byCard } = await fuelCardMap(env, tid);
      const entries = (rows || []).map(r => ({
        id: r.id, card: r.card, username: r.username, name: (byCard[r.card] || {}).name || r.username || "",
        date: r.date || "", litres: Number(r.litres) || 0, cost: Number(r.cost) || 0, note: r.note || "",
        ppl: (Number(r.litres) > 0) ? Math.round((Number(r.cost) / Number(r.litres)) * 100) / 100 : null,
      }));
      return jr({ ok: true, entries }, headers);
    }

    // Create / update a spend entry.
    if (sub === "/fuel/entry" && method === "POST") {
      await ensureFuelTable(env);
      const b = await readJson(request);
      const card = String(b.card || "").trim();
      if (!card) return jr({ error: "card required" }, headers, 400);
      const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || "") ? b.date : "";
      if (!date) return jr({ error: "valid date required" }, headers, 400);
      const litres = Math.round((Number(b.litres) || 0) * 100) / 100;
      const cost = Math.round((Number(b.cost) || 0) * 100) / 100;
      const note = String(b.note || "").slice(0, 200);
      const { byCard } = await fuelCardMap(env, tid);
      const username = (byCard[card] || {}).username || "";
      const id = parseInt(String(b.id || ""), 10);
      const now = new Date().toISOString();
      if (id && !isNaN(id)) {
        await env.DB.prepare("UPDATE fuel_entries SET card=?,username=?,date=?,litres=?,cost=?,note=? WHERE tenant_id=? AND id=?")
          .bind(card, username, date, litres, cost, note, tid, id).run();
        return jr({ ok: true, id }, headers);
      }
      const res = await env.DB.prepare("INSERT INTO fuel_entries (tenant_id,card,username,date,litres,cost,note,by,at) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(tid, card, username, date, litres, cost, note, sess.user.username, now).run();
      return jr({ ok: true, id: res.meta ? res.meta.last_row_id : null }, headers, 201);
    }
    if (sub === "/fuel/entry-delete" && method === "POST") {
      await ensureFuelTable(env);
      const b = await readJson(request); const id = parseInt(String(b.id || ""), 10);
      if (!id || isNaN(id)) return jr({ error: "id required" }, headers, 400);
      await env.DB.prepare("DELETE FROM fuel_entries WHERE tenant_id=? AND id=?").bind(tid, id).run();
      return jr({ ok: true }, headers);
    }

    // Bulk import fuel-card statement rows, each tagged to a vehicle by reg
    // (Full Access only — money). Deduped by `ref` (the statement's unique
    // transaction id) so re-importing the same file never double-counts:
    // an existing ref is UPDATED in place, a new one inserted. Body:
    //   { entries: [{ reg, date (YYYY-MM-DD), litres, cost, ref?, card?, note? }] }
    if (sub === "/fuel/import" && method === "POST") {
      if (!(await canMoney(env, tid, sess))) return jr({ error: "Forbidden" }, headers, 403);
      await ensureFuelTable(env);
      const b = await readJson(request);
      const entries = Array.isArray(b.entries) ? b.entries : [];
      if (!entries.length) return jr({ error: "no entries" }, headers, 400);
      if (entries.length > 2000) return jr({ error: "too many rows in one call (max 2000)" }, headers, 400);
      const now = new Date().toISOString();
      let created = 0, updated = 0, skipped = 0;
      for (const e of entries) {
        const reg = String(e.reg || "").trim();
        const date = /^\d{4}-\d{2}-\d{2}$/.test(e.date || "") ? e.date : "";
        if (!reg || !date) { skipped++; continue; }
        const litres = Math.round((Number(e.litres) || 0) * 100) / 100;
        const cost = Math.round((Number(e.cost) || 0) * 100) / 100;
        const ref = String(e.ref || "").trim().slice(0, 80);
        const card = String(e.card || "").trim().slice(0, 40);
        const note = String(e.note || "").slice(0, 200);
        if (ref) {
          const ex = await env.DB.prepare("SELECT id FROM fuel_entries WHERE tenant_id=? AND ref=?").bind(tid, ref).first();
          if (ex && ex.id) {
            await env.DB.prepare("UPDATE fuel_entries SET reg=?,card=?,date=?,litres=?,cost=?,note=? WHERE tenant_id=? AND id=?")
              .bind(reg, card, date, litres, cost, note, tid, ex.id).run();
            updated++; continue;
          }
        }
        await env.DB.prepare("INSERT INTO fuel_entries (tenant_id,card,username,reg,ref,date,litres,cost,note,by,at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
          .bind(tid, card, "", reg, ref, date, litres, cost, note, sess.user.username, now).run();
        created++;
      }
      return jr({ ok: true, created, updated, skipped, total: entries.length }, headers);
    }

    // Aggregated stats: overall + per-period (real-span averages, projections
    // flagged) + per-vehicle MPG/running cost. Optional ?card= scopes spend.
    if (sub === "/fuel/stats" && method === "GET") {
      await ensureFuelTable(env);
      const card = q.get("card") || "";
      const { byCard, cards } = await fuelCardMap(env, tid);
      const fuelV = await fuelByVehicle(env, tid);
      const odoV = await odoByVehicle(env, tid);
      const mpg = await mpgByVehicle(env, tid);

      // Spend/litres from entries (scoped to a card if given).
      const rows = (card
        ? (await env.DB.prepare("SELECT date,litres,cost,card,username FROM fuel_entries WHERE tenant_id=? AND card=?").bind(tid, card).all()).results
        : (await env.DB.prepare("SELECT date,litres,cost,card,username FROM fuel_entries WHERE tenant_id=?").bind(tid).all()).results) || [];
      let spend = 0, litres = 0, first = "", last = "";
      for (const r of rows) {
        spend += Number(r.cost) || 0; litres += Number(r.litres) || 0;
        if (r.date && (!first || r.date < first)) first = r.date;
        if (r.date && (!last || r.date > last)) last = r.date;
      }
      // Miles for the scope: the linked vehicle(s) odometer span.
      const regsInScope = new Set();
      if (card) {
        const u = (byCard[card] || {}).username;
        const ivs = await assignmentIntervals(env, tid);
        for (const e of rows) { const rg = regForUserOnDate(ivs, u, e.date) || (byCard[card] || {}).vehicle; if (rg) regsInScope.add(dnReg(rg)); }
      } else { for (const k of Object.keys(fuelV)) regsInScope.add(k); }
      let miles = 0;
      for (const k of regsInScope) if (odoV[k]) miles += odoV[k].milesDriven;

      const spanDays = (first && last) ? Math.max(1, (Date.parse(last) - Date.parse(first)) / 86400000) : 0;
      const spanWeeks = spanDays ? Math.round(spanDays / 7 * 10) / 10 : 0;
      const gallons = litres / UK_GALLON;
      const overallMpg = (miles > 0 && gallons > 0) ? Math.round((miles / gallons) * 10) / 10 : null;
      const periods = spanDays ? periodStats(spanDays, { spend, litres, miles }) : null;

      // Per-vehicle table — MPG + fuel spend for everyone; running cost (which
      // includes financials) only for Full Access.
      const money = await canMoney(env, tid, sess);
      const vrows = (await env.DB.prepare("SELECT reg, finance FROM vehicles WHERE tenant_id=?").bind(tid).all()).results || [];
      const maint12 = {};
      if (money) {
        const since = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
        try {
          await ensureMaintTable(env);
          const { results: mrows } = await env.DB.prepare("SELECT reg, allocs FROM vehicle_maintenance WHERE tenant_id=? AND date>=?").bind(tid, since).all();
          for (const m of mrows || []) maint12[dnReg(m.reg)] = (maint12[dnReg(m.reg)] || 0) + (parseJson(m.allocs, []) || []).reduce((s, a) => s + (Number(a.cost) || 0), 0);
        } catch {}
      }
      const vehicles = vrows.map(v => {
        const k = dnReg(v.reg);
        const row = { reg: v.reg, mpg: (mpg[k] || {}).mpg || null, spend: Math.round((fuelV[k] || {}).spend || 0), litres: Math.round(((fuelV[k] || {}).litres || 0) * 10) / 10 };
        if (money) row.running = runningCost(financeOf(v), fuelV[k], odoV[k], maint12[k] || 0);
        return row;
      });

      return jr({
        ok: true, card, money,
        overall: { spend: Math.round(spend * 100) / 100, litres: Math.round(litres * 10) / 10, miles, mpg: overallMpg, first, last, spanDays: Math.round(spanDays), spanWeeks, entries: rows.length },
        periods, vehicles, cards,
      }, headers);
    }
  }

  // ── Van check history for a vehicle (completed weekly checks, newest first) ─
  // Reads the shared vehicle_checks table, filtered to this reg; skips are not
  // real checks. Photos are ASSET_BUCKET keys served by /asset-image + /asset-thumb.
  if (sub === "/vehicle-checks" && method === "GET") {
    const reg = q.get("reg") || "";
    if (!reg) return jr({ error: "reg required" }, headers, 400);
    const rk = regKey(reg);
    const { results } = await env.DB.prepare(
      "SELECT username, week, vehicle, checked_at, safe_to_drive, items, note FROM vehicle_checks WHERE tenant_id=? AND vehicle IS NOT NULL AND vehicle!=''"
    ).bind(tid).all();
    const names = await nameMap(env, tid);
    const checks = [];
    for (const r of results || []) {
      if (regKey(r.vehicle) !== rk) continue;
      let items = {}; try { items = r.items ? JSON.parse(r.items) : {}; } catch {}
      if (items.skipped) continue;
      const answers = items.answers || {};
      const defects = Array.isArray(items.issues) ? items.issues : Object.keys(answers).filter(k => answers[k] === "defect" || answers[k] === "missing");
      const slot = items.slotPhotos || {};
      const photos = Array.from(new Set([...Object.values(slot), ...((items.photos) || [])]));
      checks.push({
        username: r.username, name: names[r.username] || r.username, week: r.week,
        checkedAt: r.checked_at, safeToDrive: r.safe_to_drive === null ? null : !!Number(r.safe_to_drive),
        defectCount: defects.length, note: r.note || "", mileage: items.mileage || "",
        answers, defectNotes: items.defectNotes || {}, slotPhotos: slot, photos,
        alerts: items.alerts || [], answerMeta: items.answerMeta || {},
        custom: items.custom || null,   // one-off custom check: carries its own item labels
      });
    }
    checks.sort((a, b) => new Date(b.checkedAt || 0) - new Date(a.checkedAt || 0));
    return jr({ ok: true, reg, checks }, headers);
  }

  // ── Every reported defect across the fleet (per-defect tracking) ──────────
  // GET /fleet/defects?reg=&status=&includeResolved=1  (any Vehicles user).
  // Powers the per-van defect panel and the central "all vans" defect table.
  if (sub === "/defects" && method === "GET") {
    const reg = q.get("reg") || "";
    const statusF = q.get("status") || "";     // open | pending | resolved | all
    const includeResolved = q.get("includeResolved") === "1" || statusF === "resolved" || statusF === "all";
    const names = await nameMap(env, tid);
    let list = await collectDefects(env, tid, { names });
    if (reg) { const rk = regKey(reg); list = list.filter(d => d.regNorm === rk); }
    const summary = { open: 0, pending: 0, resolved: 0 };
    for (const d of list) summary[d.status] = (summary[d.status] || 0) + 1;
    let rows = list;
    if (statusF && statusF !== "all") rows = rows.filter(d => d.status === statusF);
    else if (!includeResolved) rows = rows.filter(d => d.status !== "resolved");
    rows.sort((a, b) => new Date(b.checkedAt || 0) - new Date(a.checkedAt || 0));
    return jr({ ok: true, defects: rows, summary }, headers);
  }

  // ── Set ONE defect's status + office note ─────────────────────────────────
  // POST /fleet/defect-status {key, status?, note?}  (any Vehicles user).
  // status open|pending|resolved; an explicit status wins over any bulk clear.
  if (sub === "/defect-status" && method === "POST") {
    const b = await readJson(request);
    const key = String(b.key || "").trim();
    if (!key) return jr({ error: "key required" }, headers, 400);
    const map = await appConfigJson(env, DEFECTST_KEY(tid));
    const prev = map[key] || {};
    const status = ["open", "pending", "resolved"].includes(b.status) ? b.status : (prev.status || "open");
    const note = typeof b.note === "string" ? b.note.slice(0, 500) : (prev.note || "");
    map[key] = { status, note, by: (sess && sess.user && sess.user.username) || "", at: new Date().toISOString() };
    await env.DB.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(tid, DEFECTST_KEY(tid), JSON.stringify(map)).run();
    return jr({ ok: true, key, status, note, by: map[key].by, at: map[key].at }, headers);
  }

  // ── Mark a renewal (MOT / tax / service) as booked / in hand ──────────────
  // POST /fleet/renewal-status {reg, type, status:"pending"|"open", note}.
  // "pending" = booked/awaiting (amber, note kept); "open" clears it back to red.
  // Auto-clears itself when the underlying date renews (see /fleet/vehicles).
  if (sub === "/renewal-status" && method === "POST") {
    const b = await readJson(request);
    const reg = String(b.reg || "").trim();
    const type = String(b.type || "");
    if (!reg || !["mot", "tax", "service"].includes(type)) return jr({ error: "reg + valid type required" }, headers, 400);
    const rk = regKey(reg);
    const map = await appConfigJson(env, RENEWALACK_KEY(tid));
    const cur = map[rk] || (map[rk] = {});
    const prevJobId = cur[type] && cur[type].jobId;
    if (b.status === "pending") {
      const entry = {
        note: typeof b.note === "string" ? b.note.slice(0, 300) : "",
        by: (sess && sess.user && sess.user.username) || "", at: new Date().toISOString(),
        apptDate: /^\d{4}-\d{2}-\d{2}$/.test(b.apptDate || "") ? b.apptDate : "",
        scheduledAt: (b.scheduledAt && Number.isFinite(Date.parse(b.scheduledAt))) ? new Date(b.scheduledAt).toISOString() : "",
        durationMinutes: b.durationMinutes ? Math.max(15, Number(b.durationMinutes)) : (type === "mot" ? 60 : 120),
        garageId: String(b.garageId || "") || "",
      };
      // MOT/service WITH a date → make (or update) the appointment job on the
      // scheduler, assigned to the van's current driver.
      if ((type === "mot" || type === "service") && entry.scheduledAt) {
        const garage = await garageById(env, tid, entry.garageId);
        const driver = await currentDriver(env, tid, reg);
        const job = await makeRenewalJob(env, tid, { reg, type, scheduledAt: entry.scheduledAt, durationMinutes: entry.durationMinutes, garage, driver, changedBy: (sess && sess.user && sess.user.username) || "" });
        entry.jobId = job.id;
        entry.driver = driver || "";
        entry.garageName = garage ? garage.name : "";
        ctx?.waitUntil(reconcileRelease(env, tid, job).catch(() => {}));
      } else if (prevJobId) {
        entry.jobId = prevJobId;
        if (cur[type]) { entry.driver = cur[type].driver || ""; entry.garageName = cur[type].garageName || ""; }
      }
      cur[type] = entry;
    } else {
      if (prevJobId) await removeRenewalJob(env, tid, prevJobId);   // unbook cancels the job
      delete cur[type];
    }
    if (!Object.keys(map[rk]).length) delete map[rk];
    await env.DB.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(tid, RENEWALACK_KEY(tid), JSON.stringify(map)).run();
    return jr({ ok: true, reg, type, status: b.status === "pending" ? "pending" : "open", note: (cur[type] && cur[type].note) || "", jobId: (cur[type] && cur[type].jobId) || null }, headers);
  }

  // ── Complete a renewal (MOT / tax / service) and set the NEW date(s) ───────
  // POST /fleet/renewal-complete {reg, type, date, miles?, nextDate?}. Writes the
  // renewed date onto the vehicle (so the next one is tracked) and clears the
  // booked/in-hand ack for that type. Service also updates the last-service
  // mileage; nextDate overrides the computed next-service (else it recomputes
  // from the interval).
  if (sub === "/renewal-complete" && method === "POST") {
    const b = await readJson(request);
    const reg = String(b.reg || "").trim();
    const type = String(b.type || "");
    const date = String(b.date || "").slice(0, 10);
    if (!reg || !["mot", "tax", "service"].includes(type)) return jr({ error: "reg + valid type required" }, headers, 400);
    if (!date) return jr({ error: "date required" }, headers, 400);
    const rk = dnReg(reg);
    if (type === "mot") {
      await env.DB.prepare("UPDATE vehicles SET mot_due=? WHERE tenant_id=? AND UPPER(REPLACE(reg,' ',''))=?").bind(date, tid, rk).run();
    } else if (type === "tax") {
      await env.DB.prepare("UPDATE vehicles SET tax_due=? WHERE tenant_id=? AND UPPER(REPLACE(reg,' ',''))=?").bind(date, tid, rk).run();
    } else {
      const row = await env.DB.prepare("SELECT svc_interval_days, svc_interval_miles FROM vehicles WHERE tenant_id=? AND UPPER(REPLACE(reg,' ',''))=?").bind(tid, rk).first();
      const miles = (b.miles != null && b.miles !== "" && !isNaN(Number(b.miles))) ? Math.round(Number(b.miles)) : null;
      let next = "";
      if (b.nextDate) next = String(b.nextDate).slice(0, 10);
      else if (!(row && (row.svc_interval_days || row.svc_interval_miles))) next = date; // no interval → keep the entered next date if given, else the serviced date
      await env.DB.prepare("UPDATE vehicles SET last_service_date=?, last_service_miles=COALESCE(?, last_service_miles), next_service=? WHERE tenant_id=? AND UPPER(REPLACE(reg,' ',''))=?")
        .bind(date, miles, next, tid, rk).run();
    }
    // clear the booked ack for this type + remove its appointment job (done now).
    const map = await appConfigJson(env, RENEWALACK_KEY(tid));
    const k = map[regKey(reg)] ? regKey(reg) : (map[dnReg(reg)] ? dnReg(reg) : "");
    if (k && map[k]) {
      const jobId = map[k][type] && map[k][type].jobId;
      if (jobId) await removeRenewalJob(env, tid, jobId);
      delete map[k][type];
      if (!Object.keys(map[k]).length) delete map[k];
      await env.DB.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .bind(tid, RENEWALACK_KEY(tid), JSON.stringify(map)).run();
    }
    return jr({ ok: true, reg, type, date }, headers);
  }

  // ── Managed garages (where a service/MOT is carried out) ──────────────────
  if (sub === "/garages" && method === "GET") {
    const raw = await appConfigJson(env, GARAGES_KEY(tid));
    return jr({ ok: true, garages: Array.isArray(raw) ? raw : [], hq: { name: HQ_NAME, postcode: HQ_POSTCODE } }, headers);
  }
  if (sub === "/garage" && method === "POST") {
    const b = await readJson(request);
    const name = String(b.name || "").trim();
    if (!name) return jr({ error: "name required" }, headers, 400);
    const raw = await appConfigJson(env, GARAGES_KEY(tid));
    const list = Array.isArray(raw) ? raw : [];
    const collectsFromHQ = !!b.collectsFromHQ;
    const postcode = collectsFromHQ ? "" : String(b.postcode || "").trim().toUpperCase();
    let lat = null, lng = null;
    if (!collectsFromHQ && postcode) { const g = await geocodePostcode(postcode); if (g) { lat = g.lat; lng = g.lng; } }
    const id = String(b.id || "").trim() || ("g" + crypto.randomUUID().slice(0, 8));
    const garage = { id, name, postcode, lat, lng, collectsFromHQ };
    const i = list.findIndex(x => x.id === id);
    if (i >= 0) list[i] = garage; else list.push(garage);
    await env.DB.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(tid, GARAGES_KEY(tid), JSON.stringify(list)).run();
    return jr({ ok: true, garage, geocoded: lat != null }, headers);
  }
  if (sub === "/garage-delete" && method === "POST") {
    const b = await readJson(request);
    const id = String(b.id || "").trim();
    const raw = await appConfigJson(env, GARAGES_KEY(tid));
    const list = (Array.isArray(raw) ? raw : []).filter(x => x.id !== id);
    await env.DB.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(tid, GARAGES_KEY(tid), JSON.stringify(list)).run();
    return jr({ ok: true }, headers);
  }

  // ── Mark ALL of a van's reported defects resolved (bulk) ──────────────────
  // Stamps the legacy per-reg "resolved as of now" time AND explicitly resolves
  // each currently-outstanding defect (so nothing lingers), all in one tap.
  if (sub === "/defects-resolve" && method === "POST") {
    const b = await readJson(request);
    const reg = String(b.reg || "").trim();
    if (!reg) return jr({ error: "reg required" }, headers, 400);
    const rk = regKey(reg);
    const nowIso = new Date().toISOString();
    const who = (sess && sess.user && sess.user.username) || "";
    // 1) legacy timestamp (covers anything not individually enumerated)
    const clr = await appConfigJson(env, DEFECTCLR_KEY(tid));
    clr[rk] = nowIso;
    await env.DB.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(tid, DEFECTCLR_KEY(tid), JSON.stringify(clr)).run();
    // 2) explicitly resolve each current open/pending defect on this van
    const stMap = await appConfigJson(env, DEFECTST_KEY(tid));
    const list = await collectDefects(env, tid, { clearMap: {}, statusMap: stMap });
    let n = 0;
    for (const d of list) {
      if (d.regNorm === rk && d.status !== "resolved") {
        stMap[d.key] = { status: "resolved", note: (stMap[d.key] && stMap[d.key].note) || "", by: who, at: nowIso };
        n++;
      }
    }
    if (n) await env.DB.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(tid, DEFECTST_KEY(tid), JSON.stringify(stMap)).run();
    return jr({ ok: true, reg, resolvedAt: nowIso, resolved: n }, headers);
  }

  // ── Acknowledge a MISSED van check (waves the red bar for ~7 days) ──────────
  if (sub === "/vancheck-ack" && method === "POST") {
    const b = await readJson(request); const reg = String(b.reg || "").trim();
    if (!reg) return jr({ error: "reg required" }, headers, 400);
    const rk = regKey(reg);
    let map = {};
    try { const row = await env.DB.prepare("SELECT value FROM app_config WHERE key=?").bind(VCACK_KEY(tid)).first(); if (row && row.value) map = JSON.parse(row.value) || {}; } catch {}
    if (b.clear) delete map[rk];
    else map[rk] = { at: new Date().toISOString(), by: (sess && sess.user && sess.user.username) || "" };
    await env.DB.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(tid, VCACK_KEY(tid), JSON.stringify(map)).run();
    return jr({ ok: true, reg, ack: map[rk] || null }, headers);
  }

  // ── Send van driver scores to engineers (from a fleet report) ───────────────
  // Body { weekStart, weekEnd, scores:[{username, reg, score}] }. Stores each and
  // pushes the engineer. Any Vehicles user can send.
  if (sub === "/scores/send" && method === "POST") {
    await ensureScoresTable(env);
    const b = await readJson(request);
    const weekStart = String(b.weekStart || "").slice(0, 10);
    const weekEnd = String(b.weekEnd || "").slice(0, 10);
    const list = Array.isArray(b.scores) ? b.scores : [];
    if (!weekStart || !list.length) return jr({ error: "weekStart and scores[] required" }, headers, 400);
    const at = new Date().toISOString();
    const by = (sess && sess.user && sess.user.username) || "";
    const rangeLabel = weekEnd && weekEnd !== weekStart ? `${weekStart} → ${weekEnd}` : weekStart;
    let sent = 0;
    // Rank medal / bottom-of-fleet warning threshold. < 70 = needs work.
    const SCORE_MIN = 70;
    const medal = r => r === 1 ? "🏆" : r === 2 ? "🥈" : r === 3 ? "🥉" : "";
    const rankLabel = (r, tot) => {
      if (!r || !tot) return "";
      const suf = (n) => { const s = n % 100; return (s >= 11 && s <= 13) ? "th" : ["th","st","nd","rd","th","th","th","th","th","th"][n % 10]; };
      return `${r}${suf(r)} of ${tot}`;
    };
    for (const s of list) {
      const username = String(s.username || "").trim();
      const score = s.score == null ? null : Math.max(0, Math.min(100, Math.round(Number(s.score))));
      if (!username || score == null || !isFinite(score)) continue;
      const reg = String(s.reg || "").trim();
      const rank = s.rank != null && isFinite(Number(s.rank)) ? Math.max(1, Math.round(Number(s.rank))) : null;
      const total = s.total != null && isFinite(Number(s.total)) ? Math.max(1, Math.round(Number(s.total))) : null;
      await env.DB.prepare(
        `INSERT INTO driver_scores (tenant_id, username, week_start, week_end, reg, score, sent_by, sent_at, rank, total)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(tenant_id, username, week_start) DO UPDATE SET
           week_end=excluded.week_end, reg=excluded.reg, score=excluded.score,
           sent_by=excluded.sent_by, sent_at=excluded.sent_at,
           rank=excluded.rank, total=excluded.total`
      ).bind(tid, username, weekStart, weekEnd, reg, score, by, at, rank, total).run();
      sent++;
      // Push body: put the place in the TITLE for EVERY ranked driver — 1st,
      // 4th, 7th etc all see where they came at a glance. Medal for the top
      // three. Unranked (light-week vans) get the plain default title.
      let m = medal(rank);
      let title;
      if (!rank || !total) title = "🚐 Your van driving score";
      else if (rank === 1) title = "🏆 You topped the fleet!";
      else if (rank === total && total > 1) title = `🚐 ${rankLabel(rank, total)} in the fleet — last place`;
      else title = `${m ? m + " " : "🚐 "}${rankLabel(rank, total)} in the fleet`;
      // Body: score + a nudge. The rank is already in the title so no need to
      // repeat it in the body — keeps the notification short.
      const nudge = score < SCORE_MIN
        ? " This is not an acceptable driving standard and must be improved."
        : (rank === 1 ? " Great work — keep it up!" : "");
      if (ctx && ctx.waitUntil) ctx.waitUntil(sendToUser(env, tid, username, {
        title,
        body: `Your driving score for ${rangeLabel} is ${score}/100.${nudge} Tap to see your history.`,
        url: "/my-van-scores.html", tag: "van-score"
      }).catch(() => {}));
    }
    return jr({ ok: true, sent }, headers);
  }

  // ── Van handover: request (from assign popup) → pushes the new driver ──────
  if (sub === "/handover/request" && method === "POST") {
    await ensureHandoverTable(env);
    const b = await readJson(request);
    const reg = String(b.reg || "").trim();
    const username = String(b.username || "").trim();
    if (!reg || !username) return jr({ error: "reg and username required" }, headers, 400);
    const now = new Date().toISOString();
    await env.DB.prepare("UPDATE vehicle_handovers SET status='superseded' WHERE tenant_id=? AND reg=? AND username=? AND status='pending'").bind(tid, reg, username).run();
    const res = await env.DB.prepare(
      "INSERT INTO vehicle_handovers (tenant_id,reg,username,status,requested_by,requested_at) VALUES (?,?,?,?,?,?)"
    ).bind(tid, reg, username, "pending", sess.user.username, now).run();
    const id = res.meta ? res.meta.last_row_id : null;
    if (ctx && ctx.waitUntil) ctx.waitUntil(sendToUser(env, tid, username, {
      title: "Van handover required",
      body: `Please complete the handover check for ${reg} before using the vehicle.`,
      url: "/van-handover.html", tag: "van-handover"
    }));
    return jr({ ok: true, id }, headers, 201);
  }

  // ── Van handover: the editable template (GET any Vehicles user; POST FullAccess) ─
  if (sub === "/handover/template" && method === "GET") {
    return jr({ ok: true, template: await handoverTemplate(env, tid), defaults: DEFAULT_HANDOVER }, headers);
  }
  if (sub === "/handover/template" && method === "POST") {
    if (!(await canMoney(env, tid, sess))) return jr({ error: "Only a Full-Access admin can change the handover template." }, headers, 403);
    const b = await readJson(request);
    const slug = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
    // kind: "answer" items carry an optional Alert-if rule (failVal = its bad
    // answer); "photo" items carry required. Defaults its alertOn to failVal.
    const mkList = (arr, kind, failVal) => {
      const out = [], seen = new Set();
      for (const it of Array.isArray(arr) ? arr : []) {
        const label = String(it && it.label || "").trim().slice(0, 120); if (!label) continue;
        let id = slug(it && it.id) || slug(label) || ("item" + (out.length + 1));
        while (seen.has(id)) id = id + "_" + (out.length + 1);
        seen.add(id);
        if (kind === "photo") { out.push({ id, label, required: !(it && it.required === false) }); continue; }
        const o = { id, label };
        if (it && it.alert) {
          const on = it.alertOn;
          o.alert = true;
          o.alertOn = (on === "ok" || on === "present" || on === "defect" || on === "missing") ? on : failVal;
        }
        out.push(o);
      }
      return out;
    };
    const alertUsers = (Array.isArray(b.alertUsers) ? b.alertUsers : []).map(u => String(u || "").trim()).filter(Boolean).slice(0, 50);
    const tpl = { checklist: mkList(b.checklist, "answer", "defect"), equipment: mkList(b.equipment, "answer", "missing"), photoSlots: mkList(b.photoSlots, "photo"), alertUsers };
    if (!tpl.checklist.length && !tpl.equipment.length && !tpl.photoSlots.length)
      return jr({ error: "Add at least one item." }, headers, 400);
    await env.DB.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(tid, HANDOVER_TPL_KEY(tid), JSON.stringify(tpl)).run();
    return jr({ ok: true, template: tpl }, headers);
  }

  // ── Van handover: the driver's pending one + the template (van-handover.html) ─
  if (sub === "/handover/mine" && method === "GET") {
    await ensureHandoverTable(env);
    const row = await env.DB.prepare(
      "SELECT id, reg, requested_by, requested_at FROM vehicle_handovers WHERE tenant_id=? AND username=? AND status='pending' ORDER BY requested_at DESC, id DESC LIMIT 1"
    ).bind(tid, sess.user.username).first();
    return jr({
      ok: true,
      handover: row ? { id: row.id, reg: row.reg, requestedBy: row.requested_by, requestedAt: row.requested_at } : null,
      template: await handoverTemplate(env, tid),
    }, headers);
  }

  // ── Van handover: attention (badge/gate for the assigned driver) ──────────
  if (sub === "/handover/attention" && method === "GET") {
    await ensureHandoverTable(env);
    const row = await env.DB.prepare(
      "SELECT id, reg FROM vehicle_handovers WHERE tenant_id=? AND username=? AND status='pending' ORDER BY requested_at DESC, id DESC LIMIT 1"
    ).bind(tid, sess.user.username).first();
    return jr({ ok: true, mineDue: !!row, id: row ? row.id : null, reg: row ? row.reg : "" }, headers);
  }

  // ── Van handover: submit (the assigned driver completes it) ───────────────
  if (sub === "/handover/submit" && method === "POST") {
    await ensureHandoverTable(env);
    const b = await readJson(request);
    const id = parseInt(String(b.id || ""), 10);
    if (!id || isNaN(id)) return jr({ error: "id required" }, headers, 400);
    const row = await env.DB.prepare("SELECT * FROM vehicle_handovers WHERE tenant_id=? AND id=?").bind(tid, id).first();
    if (!row) return jr({ error: "Handover not found" }, headers, 404);
    if (row.username !== sess.user.username) {
      const p = await permissionsFor(env, tid, sess.user.username);
      if (p.FullAccess !== "Yes") return jr({ error: "This handover isn't assigned to you." }, headers, 403);
    }
    const tpl = await handoverTemplate(env, tid);
    const userDir = String(row.username).replace(/[^A-Za-z0-9._-]/g, "_");
    const nRef = { n: 0 };
    const answers = (b.answers && typeof b.answers === "object") ? b.answers : {};
    const defectNotes = (b.defectNotes && typeof b.defectNotes === "object") ? b.defectNotes : {};
    const slotIn = (b.photoSlots && typeof b.photoSlots === "object") ? b.photoSlots : {};
    const slotPhotos = {};
    for (const sl of tpl.photoSlots) { const key = await storeHandoverImg(env, userDir, id, sl.id, slotIn[sl.id], nRef); if (key) slotPhotos[sl.id] = key; }
    const missing = tpl.photoSlots.filter(sl => sl.required !== false && !slotPhotos[sl.id]);
    if (missing.length) return jr({ error: "Missing required photos: " + missing.map(m => m.label).join(", ") }, headers, 400);
    const photos = [];
    for (const p of (Array.isArray(b.photos) ? b.photos : []).slice(0, 8)) { const key = await storeHandoverImg(env, userDir, id, "extra", p, nRef); if (key) photos.push(key); }
    const damage = [];
    for (const d of (Array.isArray(b.damage) ? b.damage : []).slice(0, 20)) {
      const note = String(d && d.note || "").slice(0, 300);
      let photo = ""; if (d && d.photo) { const key = await storeHandoverImg(env, userDir, id, "damage", d.photo, nRef); if (key) photo = key; }
      if (note || photo) damage.push({ note, photo });
    }
    let signature = b.signature ? (await storeHandoverImg(env, userDir, id, "signature", b.signature, nRef) || "") : "";
    if (!signature) return jr({ error: "Signature required." }, headers, 400);
    const alerts = evalAlerts(answers, tpl);   // "Alert if" rules on the template
    const items = {
      answers, defectNotes,
      conditionInterior: String(b.conditionInterior || "").slice(0, 1000),
      conditionExterior: String(b.conditionExterior || "").slice(0, 1000),
      damage, slotPhotos, photos, signature, source: "portal", alerts,
    };
    const now = new Date().toISOString();
    await env.DB.prepare(
      "UPDATE vehicle_handovers SET status='done', completed_at=?, mileage=?, safe_to_drive=?, note=?, items=? WHERE tenant_id=? AND id=?"
    ).bind(now, String(b.mileage || "").trim(), b.safeToDrive === false ? 0 : 1, String(b.note || "").slice(0, 1000), JSON.stringify(items), tid, id).run();
    if (row.requested_by && row.requested_by !== row.username && ctx && ctx.waitUntil) ctx.waitUntil(sendToUser(env, tid, row.requested_by, {
      title: "Van handover completed", body: `${row.username} completed the handover for ${row.reg}.`,
      url: "/vehicle-checks.html?reg=" + encodeURIComponent(row.reg), tag: "van-handover"
    }));
    if (alerts.length && (tpl.alertUsers || []).length && ctx && ctx.waitUntil) {
      const body = `${row.username} — ${row.reg}: ` + alerts.map(a => `${a.label}: ${answerWord(a.answer)}`).join(", ");
      const payload = { title: "⚠ Van handover alert", body, url: "/vehicle-checks.html?reg=" + encodeURIComponent(row.reg), tag: "handover-alert" };
      ctx.waitUntil(Promise.all((tpl.alertUsers || []).map(u => sendToUser(env, tid, u, payload).catch(() => {}))));
    }
    return jr({ ok: true, id, alerts: alerts.length }, headers);
  }

  // ── Van handover: admin cancels a pending one (mistaken send) ─────────────
  if (sub === "/handover/cancel" && method === "POST") {
    await ensureHandoverTable(env);
    const b = await readJson(request); const id = parseInt(String(b.id || ""), 10);
    if (!id || isNaN(id)) return jr({ error: "id required" }, headers, 400);
    await env.DB.prepare("UPDATE vehicle_handovers SET status='cancelled' WHERE tenant_id=? AND id=? AND status='pending'").bind(tid, id).run();
    return jr({ ok: true }, headers);
  }

  // ── Van handover: full history for a vehicle (listing + detail) ───────────
  if (sub === "/handovers" && method === "GET") {
    await ensureHandoverTable(env);
    const reg = q.get("reg") || "";
    if (!reg) return jr({ error: "reg required" }, headers, 400);
    const rk = regKey(reg);
    const { results } = await env.DB.prepare(
      "SELECT * FROM vehicle_handovers WHERE tenant_id=? ORDER BY COALESCE(completed_at,requested_at) DESC, id DESC"
    ).bind(tid).all();
    const names = await nameMap(env, tid);
    const handovers = [];
    for (const r of results || []) {
      if (regKey(r.reg) !== rk) continue;
      let items = {}; try { items = r.items ? JSON.parse(r.items) : {}; } catch {}
      const answers = items.answers || {};
      const defects = Object.keys(answers).filter(k => answers[k] === "defect" || answers[k] === "missing");
      handovers.push({
        id: r.id, reg: r.reg, username: r.username, name: names[r.username] || r.username,
        status: r.status, requestedBy: r.requested_by, requestedByName: names[r.requested_by] || r.requested_by,
        requestedAt: r.requested_at, completedAt: r.completed_at,
        mileage: r.mileage || "", safeToDrive: r.safe_to_drive === null ? null : !!Number(r.safe_to_drive), note: r.note || "",
        defectCount: defects.length, alerts: items.alerts || [],
        answers, defectNotes: items.defectNotes || {},
        conditionInterior: items.conditionInterior || "", conditionExterior: items.conditionExterior || "",
        damage: items.damage || [], slotPhotos: items.slotPhotos || {}, photos: items.photos || [], signature: items.signature || "",
      });
    }
    return jr({ ok: true, reg, handovers, template: await handoverTemplate(env, tid) }, headers);
  }

  // ── Vehicle photos (gallery; one is the card cover) ───────────────────────
  if (sub === "/vehicle-photos" && method === "GET") {
    const reg = q.get("reg") || "";
    if (!reg) return jr({ error: "reg required" }, headers, 400);
    const rk = regKey(reg);
    const idx = (await photoIndex(env, tid))[rk] || [];
    const names = await nameMap(env, tid);
    const slotLabels = await vanCheckSlotLabels(env, tid);
    const vc = await vanCheckPhotos(env, tid, rk, names, slotLabels);
    const covers = await coverMap(env, tid);
    // Honour an explicitly-chosen cover (uploaded OR van-check); otherwise fall
    // back to the newest UPLOADED photo only — never auto-promote a van-check
    // close-up (a tyre/oil shot) to the card cover.
    let coverKey = covers[rk];
    const allKeys = new Set([...idx.map(p => p.key), ...vc.map(p => p.key)]);
    if (!coverKey || !allKeys.has(coverKey)) coverKey = idx.length ? idx[0].key : "";
    // Deleting a photo is Full-Access only (matches the /vehicle-photo-delete gate).
    const canDel = await canMoney(env, tid, sess);
    const photos = [];
    for (const p of idx) {
      photos.push({
        key: p.key, name: p.name, by: p.by, at: p.at, source: "upload",
        categoryId: "upload", category: "Uploaded", canDelete: canDel, cover: p.key === coverKey,
        url: await signedFileUrl(env, url.origin, "/fleet/vehicle-photo", p.key)
      });
    }
    for (const p of vc) {
      photos.push({
        key: p.key, name: "", by: p.by, at: p.at, source: "vancheck",
        categoryId: p.categoryId, category: p.category, canDelete: false, cover: p.key === coverKey,
        url: url.origin + "/asset-image?key=" + encodeURIComponent(p.key)
      });
    }
    return jr({ ok: true, photos, cover: coverKey }, headers);
  }
  if (sub === "/vehicle-photo" && method === "POST") {
    const form = await request.formData();
    const reg = String(form.get("reg") || "").trim();
    const file = form.get("file");
    if (!reg || !file) return jr({ error: "reg and file required" }, headers, 400);
    const safe = String(file.name || "photo.jpg").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
    const key = `${vphotoPrefix(tid, reg)}${Date.now()}-${safe}`;
    await env.JOB_FILES.put(key, file.stream(), {
      httpMetadata: { contentType: file.type || "image/jpeg" },
      customMetadata: { name: file.name || safe, by: sess.user.username, at: new Date().toISOString() }
    });
    // First photo for a van becomes its cover automatically.
    const rk = regKey(reg);
    const covers = await coverMap(env, tid);
    if (!covers[rk]) { covers[rk] = key; await saveCoverMap(env, tid, covers); }
    return jr({ ok: true, key, url: await signedFileUrl(env, url.origin, "/fleet/vehicle-photo", key) }, headers, 201);
  }
  if (sub === "/vehicle-photo-cover" && method === "POST") {
    const b = await readJson(request);
    const reg = String(b.reg || "").trim(); const key = String(b.key || "");
    // Cover can be an uploaded vehicle photo OR a van-check photo.
    if (!reg || !key || !(key.startsWith("vehiclephotos/") || key.startsWith("vancheck/"))) return jr({ error: "reg and key required" }, headers, 400);
    const covers = await coverMap(env, tid); covers[regKey(reg)] = key; await saveCoverMap(env, tid, covers);
    return jr({ ok: true }, headers);
  }
  if (sub === "/vehicle-photo-delete" && method === "POST") {
    // Deleting a vehicle photo is Full-Access only (any Vehicles user can view/add).
    if (!(await canMoney(env, tid, sess))) return jr({ error: "Full Access required to delete photos" }, headers, 403);
    const b = await readJson(request); const key = String(b.key || "");
    if (!key || !key.startsWith("vehiclephotos/")) return jr({ error: "Bad key" }, headers, 400);
    await env.JOB_FILES.delete(key);
    // If it was a cover, drop it — /fleet/vehicles falls back to the newest photo.
    const rk = key.split("/")[2];
    const covers = await coverMap(env, tid);
    if (rk && covers[rk] === key) { delete covers[rk]; await saveCoverMap(env, tid, covers); }
    return jr({ ok: true }, headers);
  }

  // ── Pool-vehicle trip/day allocation (which driver used a shared van) ──────
  if (sub === "/pool-alloc" && method === "GET") {
    let alloc = {};
    try { const row = await env.DB.prepare("SELECT value FROM app_config WHERE key=?").bind(`fleet:poolalloc:${tid}`).first(); if (row && row.value) alloc = JSON.parse(row.value) || {}; } catch {}
    return jr({ ok: true, alloc }, headers);
  }
  if (sub === "/pool-alloc" && method === "POST") {
    const b = await readJson(request);
    let alloc = {};
    try { const row = await env.DB.prepare("SELECT value FROM app_config WHERE key=?").bind(`fleet:poolalloc:${tid}`).first(); if (row && row.value) alloc = JSON.parse(row.value) || {}; } catch {}
    if (b.key) { if (b.username) alloc[String(b.key)] = String(b.username); else delete alloc[String(b.key)]; }
    else if (b.alloc && typeof b.alloc === "object") alloc = b.alloc;
    await env.DB.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(tid, `fleet:poolalloc:${tid}`, JSON.stringify(alloc)).run();
    return jr({ ok: true, alloc }, headers);
  }

  // ── Van driver pay settings (per-driver deductions) ───────────────────────
  if (sub === "/paycfg" && method === "GET") {
    let cfg = { defaults: { morningCap: 30, homeCap: 30, lunch: 30, thresholdH: 6 }, byUser: {} };
    try {
      const row = await env.DB.prepare("SELECT value FROM app_config WHERE key=?").bind(`fleet:paycfg:${tid}`).first();
      if (row && row.value) { const v = JSON.parse(row.value); cfg.defaults = Object.assign(cfg.defaults, v.defaults || {}); cfg.byUser = v.byUser || {}; }
    } catch {}
    return jr({ ok: true, defaults: cfg.defaults, byUser: cfg.byUser }, headers);
  }
  if (sub === "/paycfg" && method === "POST") {
    const b = await readJson(request);
    const cfg = { defaults: b.defaults || { morningCap: 30, homeCap: 30, lunch: 30, thresholdH: 6 }, byUser: b.byUser || {} };
    await env.DB.prepare("INSERT INTO app_config (tenant_id, key, value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(tid, `fleet:paycfg:${tid}`, JSON.stringify(cfg)).run();
    return jr({ ok: true }, headers);
  }

  // ── Van timesheets (per week, per driver) ─────────────────────────────────
  if (sub === "/timesheet") {
    await ensureTsTable(env);
    if (method === "GET") {
      const week = q.get("week") || "";
      const rows = (await env.DB.prepare("SELECT username, data FROM van_timesheets WHERE tenant_id=? AND week=?").bind(tid, week).all()).results;
      const out = (rows || []).map(r => { let d = {}; try { d = JSON.parse(r.data); } catch {} return { username: r.username, days: d.days || {} }; });
      return jr({ ok: true, week, rows: out }, headers);
    }
    if (method === "POST") {
      const b = await readJson(request);
      const week = String(b.week || "");
      if (!week) return jr({ error: "week required" }, headers, 400);
      for (const row of (b.rows || [])) {
        if (!row.username) continue;
        await env.DB.prepare(
          "INSERT INTO van_timesheets (tenant_id, week, username, data, at) VALUES (?,?,?,?,?) ON CONFLICT(tenant_id, week, username) DO UPDATE SET data=excluded.data, at=excluded.at"
        ).bind(tid, week, row.username, JSON.stringify({ days: row.days || {} }), new Date().toISOString()).run();
      }
      return jr({ ok: true }, headers);
    }
  }

  // ── Geocode tracker "to" texts → nearest portal site ─────────────────────
  // POST /fleet/tracker-geocode { texts: [] } → [{text, lat, lon, siteNumber,
  //   siteName, distanceM}]. Uses Google Geocoding (env.GOOGLE_MAPS_KEY) so
  //   free-text place names ("5 Woodlands Close, Sarisbury Green") resolve,
  //   not just full postcodes. Nearest portal site with saved lat/lng within
  //   800 m wins; projects win ties inside 150 m.
  if (sub === "/tracker-geocode" && method === "POST") {
    const b = await readJson(request);
    const texts = Array.isArray(b.texts) ? b.texts.slice(0, 80) : [];
    if (!texts.length) return jr({ ok: true, results: [] }, headers);
    const key = env.GOOGLE_MAPS_KEY || "";
    // Sites with coords — indexed once for the lookup.
    let sites = [];
    try {
      const { results } = await env.DB.prepare(
        "SELECT client, site_number, site_name, postcode, data FROM sites WHERE tenant_id=? AND (active=1 OR active IS NULL)"
      ).bind(tid).all();
      for (const r of results || []) {
        let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {}
        const lat = Number(d.lat), lon = Number(d.lon ?? d.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        sites.push({ num: r.site_number, name: r.site_name, postcode: r.postcode || "", lat, lon,
          isProject: r.client === "projects" || /^p\d/i.test(String(r.site_number || "")) });
      }
    } catch {}
    const R = 6371000, toR = d => d * Math.PI / 180;
    const dist = (a, bb) => { const dLat = toR(bb.lat - a.lat), dLon = toR(bb.lon - a.lon);
      const s = Math.sin(dLat/2)**2 + Math.cos(toR(a.lat)) * Math.cos(toR(bb.lat)) * Math.sin(dLon/2)**2;
      return R * 2 * Math.asin(Math.sqrt(s)); };
    const nearest = (lat, lon) => {
      let best = null, bestD = 801;
      for (const s of sites) { const d = dist({lat,lon}, s); if (d < bestD) { best = s; bestD = d; } }
      // Project bias inside 150 m — if a project sits within 150 m of the
      // best hit and the best isn't a project, project wins.
      if (best && !best.isProject) {
        for (const s of sites) {
          if (!s.isProject) continue;
          const d = dist({lat,lon}, s);
          if (d <= bestD + 150) { best = s; bestD = d; break; }
        }
      }
      return best ? { num: best.num, name: best.name, distanceM: Math.round(bestD) } : null;
    };
    const out = [];
    for (const t of texts) {
      const text = String(t || "").trim();
      if (!text) { out.push({ text: t, lat: null, lon: null, siteNumber: null }); continue; }
      let lat = null, lon = null, source = "";
      // 1) Google Geocoding — handles free text (address, street, town).
      if (key) {
        try {
          const gr = await fetch("https://maps.googleapis.com/maps/api/geocode/json?address=" + encodeURIComponent(text + ", UK") + "&region=uk&key=" + encodeURIComponent(key));
          const gj = await gr.json();
          const first = gj && Array.isArray(gj.results) && gj.results[0];
          if (first && first.geometry && first.geometry.location) {
            lat = Number(first.geometry.location.lat);
            lon = Number(first.geometry.location.lng);
            source = "google";
          }
        } catch {}
      }
      // 2) postcodes.io fallback — postcode-only, free.
      if (!Number.isFinite(lat)) {
        const pc = String(text).toUpperCase().match(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/);
        if (pc) {
          try {
            const pr = await fetch("https://api.postcodes.io/postcodes/" + encodeURIComponent(pc[0]));
            const pj = pr.ok ? await pr.json() : null;
            if (pj && pj.result) { lat = Number(pj.result.latitude); lon = Number(pj.result.longitude); source = "postcodes.io"; }
          } catch {}
        }
      }
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        out.push({ text: t, lat: null, lon: null, siteNumber: null, source: "" });
        continue;
      }
      const near = nearest(lat, lon);
      out.push({ text: t, lat, lon, source, siteNumber: near ? near.num : null, siteName: near ? near.name : null, distanceM: near ? near.distanceM : null });
    }
    return jr({ ok: true, results: out }, headers);
  }

  // ── AI resolver for unmatched tracker stops + pool-van drivers ────────────
  // Fed the trip texts the deterministic matcher missed + any pool-van days
  // with no allocated driver, plus the sites catalogue + drivers directory
  // (with home postcodes). Claude returns confident matches only; we persist
  // them (aliases + POOLALLOC) so future reports pick them up too. Applied
  // silently in the background — the office only sees what AI couldn't decide.
  if (sub === "/tracker-ai-resolve" && method === "POST") {
    const b = await readJson(request);
    const unmatched = Array.isArray(b.unmatched) ? b.unmatched.slice(0, 40) : [];
    const poolDays = Array.isArray(b.poolDays) ? b.poolDays.slice(0, 40) : [];
    if (!unmatched.length && !poolDays.length) return jr({ ok: true, applied: { aliases: 0, poolDrivers: 0 }, unresolved: { unmatched: [], poolDays: [] } }, headers);
    // Site catalogue for the prompt (compact).
    let sites = [];
    try {
      const { results } = await env.DB.prepare(
        "SELECT client, site_number, site_name, postcode, data FROM sites WHERE tenant_id=? AND (active=1 OR active IS NULL)"
      ).bind(tid).all();
      sites = (results || []).map(r => {
        let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {}
        const addr = [d.address1, d.street, d.town, d.county].filter(Boolean).join(", ");
        return { num: r.site_number, name: r.site_name, postcode: r.postcode || "", client: r.client || "", address: addr, isProject: r.client === "projects" || /^p\d/i.test(String(r.site_number || "")) };
      }).filter(s => s.num || s.name);
    } catch {}
    // Drivers with home postcodes for the pool resolver.
    let drivers = [];
    try {
      const { results } = await env.DB.prepare("SELECT username, first_name, last_name, profile FROM users WHERE tenant_id=? AND (status IS NULL OR status='Active' OR status='')").bind(tid).all();
      drivers = (results || []).map(u => {
        let p = {}; try { p = u.profile ? JSON.parse(u.profile) : {}; } catch {}
        const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username;
        return { username: u.username, name, homePostcode: p.homePostcode || "", staffType: p.staffType || "" };
      }).filter(d => d.staffType === "field" || d.homePostcode);
    } catch {}
    const key = env.ANTHROPIC_API_KEY;
    if (!key) return jr({ ok: false, error: "ANTHROPIC_API_KEY not set" }, headers, 200);
    const model = env.ANTHROPIC_MODEL || "claude-sonnet-5";
    const schema = {
      type: "object",
      properties: {
        siteAliases: {
          type: "array",
          description: "One entry per unmatched trip text you can confidently map to a portal site. Skip anything you're not sure about.",
          items: {
            type: "object",
            properties: {
              text: { type: "string", description: "The tracker 'to' text exactly as given." },
              siteNumber: { type: "string", description: "The site number you're pinning it to." },
              confidence: { type: "number", description: "0..1 — only entries >= 0.9 will be applied. Prefer to omit rather than guess." },
              reason: { type: "string" }
            },
            required: ["text", "siteNumber", "confidence"]
          }
        },
        poolDrivers: {
          type: "array",
          description: "One entry per pool-van day you can confidently attribute to a driver, by matching the first trip's origin (or last trip's destination) to a driver's home postcode / area.",
          items: {
            type: "object",
            properties: {
              vanKey: { type: "string", description: "The van|date key exactly as given." },
              username: { type: "string", description: "The driver's portal username." },
              confidence: { type: "number", description: "0..1 — only entries >= 0.9 will be applied. Prefer to omit rather than guess." },
              reason: { type: "string" }
            },
            required: ["vanKey", "username", "confidence"]
          }
        }
      },
      required: ["siteAliases", "poolDrivers"]
    };
    const system = [
      "You are helping match van tracker text to a UK field-service company's portal.",
      "ACCURACY OVER RECALL — a wrong pin is much worse than no pin. When several sites plausibly fit, DO NOT GUESS: omit.",
      "Only return an entry with confidence >= 0.9. Below that, LEAVE IT OUT.",
      "Rules for siteAliases:",
      " (a) An EXACT full-postcode match in the trip text against a site's postcode is the ONLY signal strong enough to auto-attribute alone (confidence 0.95+).",
      " (b) Address-line match (specific STREET NAME 12+ chars) with a project site is strong (0.9). With a NON-PROJECT site sharing the same town it's weak — skip.",
      " (c) A TOWN name alone (e.g. 'Whiteley', 'Titchfield', 'Sarisbury Green', 'Verwood') is NEVER enough — many sites share a town. Never pin on town alone.",
      " (d) Prefer PROJECT sites (isProject prefix P) over other clients when the tracker text is close to project territory — engineers spend weeks on a project, so a project match is usually correct.",
      " (e) NEVER pick a Southern Co-op, Chapplins, ELS, Cobra, Wenzel's site unless the tracker text unambiguously names it (site number OR full site name).",
      "Rules for poolDrivers:",
      " Match the trip origin/destination to a driver's home postcode area (e.g. 'Whiteley, PO15 7LJ' matches homePostcode PO15 7LJ or the same PO15 area). Only if a single driver's home is a clear match.",
      "When unsure — output empty."
    ].join(" ");
    const compactSites = sites.slice(0, 400).map(s => (s.isProject ? "P" : "S") + " " + s.num + " | " + s.name + (s.postcode ? " | " + s.postcode : "") + (s.address ? " | " + s.address : ""));
    const compactDrivers = drivers.slice(0, 120).map(d => d.username + " | " + d.name + (d.homePostcode ? " | " + d.homePostcode : ""));
    const compactUnmatched = unmatched.map(u => "TEXT: " + (u.text || "") + "  (" + (u.occurrences || 0) + " stops, " + (u.totalMins || 0) + " min total)");
    const compactPool = poolDays.map(p => "VAN " + p.van + " | DATE " + p.date + " | first from: " + (p.firstFrom || "?") + " | last to: " + (p.lastTo || "?"));
    const userContent =
      "SITES (prefix P=project, S=other):\n" + compactSites.join("\n") + "\n\n" +
      "DRIVERS (username | name | homePostcode):\n" + compactDrivers.join("\n") + "\n\n" +
      (compactUnmatched.length ? "UNMATCHED TRIP TEXTS TO PLACE:\n" + compactUnmatched.join("\n") + "\n\n" : "") +
      (compactPool.length ? "POOL-VAN DAYS TO ATTRIBUTE TO A DRIVER:\n" + compactPool.join("\n") + "\n" : "") +
      "Return your matches via the resolve_tracker tool.";
    let resp;
    try {
      resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model, max_tokens: 3000, system,
          tools: [{ name: "resolve_tracker", description: "Return confident matches.", input_schema: schema }],
          tool_choice: { type: "tool", name: "resolve_tracker" },
          messages: [{ role: "user", content: userContent }]
        }),
      });
    } catch (e) { return jr({ ok: false, error: "AI unreachable: " + e.message }, headers, 200); }
    if (!resp.ok) {
      let detail = ""; try { const j = await resp.json(); detail = j?.error?.message || ""; } catch {}
      return jr({ ok: false, error: "AI error " + resp.status + (detail ? " (" + detail + ")" : "") }, headers, 200);
    }
    let payload; try { payload = await resp.json(); } catch { return jr({ ok: false, error: "AI reply unreadable" }, headers, 200); }
    const block = Array.isArray(payload.content) ? payload.content.find(c => c.type === "tool_use" && c.name === "resolve_tracker") : null;
    const out = (block && block.input) || { siteAliases: [], poolDrivers: [] };
    // Apply site aliases (confidence gate + must be a real site number).
    const validNums = new Set(sites.map(s => String(s.num)));
    let appliedAliases = 0;
    if (Array.isArray(out.siteAliases)) {
      const cur = (await cfgReadWrap(env, tid, "site_aliases", {}));
      const norm = s => String(s || "").toLowerCase().replace(/['’`]/g, "").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
      for (const a of out.siteAliases) {
        if (!a || !a.text || !a.siteNumber) continue;
        if (Number(a.confidence) < 0.9) continue;
        if (!validNums.has(String(a.siteNumber))) continue;
        const site = sites.find(s => String(s.num) === String(a.siteNumber));
        cur[norm(a.text)] = { client: site && site.client || "", siteNumber: String(a.siteNumber), label: String(a.text).slice(0, 200), aiConfidence: a.confidence, aiReason: a.reason || "" };
        appliedAliases++;
      }
      await cfgWriteWrap(env, tid, "site_aliases", cur);
    }
    // Apply pool driver picks (POOLALLOC keys van|date -> username).
    const validUsers = new Set(drivers.map(d => String(d.username)));
    let appliedPool = 0;
    if (Array.isArray(out.poolDrivers)) {
      const cur = (await cfgReadWrap(env, tid, "fleet:poolalloc", {}));
      for (const p of out.poolDrivers) {
        if (!p || !p.vanKey || !p.username) continue;
        if (Number(p.confidence) < 0.9) continue;
        if (!validUsers.has(String(p.username))) continue;
        cur[p.vanKey] = p.username;
        appliedPool++;
      }
      await cfgWriteWrap(env, tid, "fleet:poolalloc", cur);
    }
    // Return what's still ambiguous so the client can surface a tiny UI for it.
    const okTexts = new Set((out.siteAliases || []).filter(a => Number(a.confidence) >= 0.9).map(a => a.text));
    const okPool = new Set((out.poolDrivers || []).filter(p => Number(p.confidence) >= 0.9).map(p => p.vanKey));
    return jr({
      ok: true,
      applied: { aliases: appliedAliases, poolDrivers: appliedPool },
      unresolved: {
        unmatched: unmatched.filter(u => !okTexts.has(u.text)),
        poolDays: poolDays.filter(p => !okPool.has(p.van + "|" + p.date)),
      }
    }, headers);
  }

  // ── Auto-cost the van tracker's on-site + travel time ─────────────────────
  // POST /fleet/tracker-reconcile  — write tracker-derived time to
  // job_time_segments so job-costing folds it in like SLA taps and SiteLog
  // scans. Doesn't need a job to be allocated — the driver was there, time
  // gets attributed to the SITE. Deduped against SiteLog for the same
  // (user, site, day); SiteLog is authoritative when both exist.
  //
  // Body: { rows: [{ username, date, siteName?, siteCode?, postcode?,
  //   startedAt, endedAt, kind: "onsite"|"travel" }] }
  //   (rows are pre-built client-side from the fleet report — one per
  //   matched site visit + one for the drive to it.)
  //
  // Every write carries a stable synthetic job_id `tracker:<username>:
  // <date>:<site>:<kind>:<seq>` so re-runs of the same report REPLACE
  // rather than duplicate.
  if (sub === "/tracker-reconcile" && method === "POST") {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS job_time_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL DEFAULT 1,
      username TEXT NOT NULL, job_id TEXT NOT NULL, job_ref TEXT, site TEXT, postcode TEXT,
      started_at TEXT NOT NULL, ended_at TEXT)`).run();
    try { await env.DB.prepare("ALTER TABLE job_time_segments ADD COLUMN kind TEXT").run(); } catch {}
    try { await env.DB.prepare("ALTER TABLE job_time_segments ADD COLUMN auto_closed INTEGER").run(); } catch {}
    const b = await readJson(request);
    const rows = Array.isArray(b.rows) ? b.rows : [];
    const dryRun = !!b.dryRun;
    if (!rows.length) return jr({ ok: true, wrote: 0, skipped: 0, skippedReason: "empty", dryRun, preview: [] }, headers);
    // Ask SiteLog what it knows for the covered days so we don't double-cost a
    // (user, site, date) that SiteLog has authoritatively captured.
    const dates = new Set(rows.map(r => String(r.date || "").slice(0, 10)).filter(Boolean));
    const users = new Set(rows.map(r => String(r.username || "").trim().toLowerCase()).filter(Boolean));
    const slCover = new Set();   // "user::siteKey::date"
    if (env.SITELOG_DB && dates.size) {
      try {
        const from = [...dates].sort()[0], to = [...dates].sort().reverse()[0];
        // fetchSitelogVisits is on costing.js but not exported — inline the query.
        const { results } = await env.SITELOG_DB.prepare(
          "SELECT portal_username, site_code, site_name, check_in_at, check_out_at FROM visits WHERE date(check_in_at) BETWEEN date(?) AND date(?)"
        ).bind(from, to).all().catch(() => ({ results: [] }));
        for (const v of results || []) {
          const u = String(v.portal_username || "").trim().toLowerCase();
          if (!users.has(u)) continue;
          const d = String(v.check_in_at || "").slice(0, 10);
          const key = u + "::" + normSite(v.site_code || v.site_name || "") + "::" + d;
          slCover.add(key);
        }
      } catch {}
    }
    // Look up each user's hourly rate so the preview can show £ before we
    // write. Real writes don't need it (costing computes £ on read); the
    // preview does so the office sees "3h × £20 = £60" per driver-site-day.
    const rates = {};
    try {
      const cfg = await env.DB.prepare("SELECT value FROM app_config WHERE key=?").bind("engts:cfg:" + tid).first();
      const parsed = cfg && cfg.value ? JSON.parse(cfg.value) : { byUser: {} };
      const byUser = parsed.byUser || {};
      const { results } = await env.DB.prepare("SELECT username, profile FROM users WHERE tenant_id=?").bind(tid).all();
      for (const u of results || []) {
        let profile = {}; try { profile = u.profile ? JSON.parse(u.profile) : {}; } catch {}
        const mine = byUser[u.username] || {};
        const rate = Number(mine.rate) || Number(profile.hourlyRate) || null;
        if (rate) rates[u.username] = rate;
      }
    } catch {}
    // Wipe our previous tracker inserts for (user, date) — idempotent replace.
    // Skipped in dryRun so a preview never touches the DB.
    if (!dryRun) {
      for (const d of dates) {
        for (const u of users) {
          try {
            await env.DB.prepare(
              "DELETE FROM job_time_segments WHERE tenant_id=? AND username=? AND job_id LIKE ? AND date(started_at)=date(?)"
            ).bind(tid, u, "tracker:%", d).run();
          } catch {}
        }
      }
    }
    // Aggregate the rows for a compact preview: one entry per (user, site, day)
    // with total on-site minutes + travel minutes + a matching £ figure.
    const bucket = new Map();   // key -> { username, siteName, siteKey, postcode, date, onsiteMins, travelMins }
    let wrote = 0, skippedSL = 0;
    let seq = 0;
    for (const r of rows) {
      const username = String(r.username || "").trim();
      const date = String(r.date || "").slice(0, 10);
      if (!username || !date || !r.startedAt || !r.endedAt) continue;
      const kind = r.kind === "travel" ? "travel" : "onsite";
      const siteName = String(r.siteName || "").trim();
      const siteKey = normSite(r.siteCode || siteName);
      const mins = Math.max(0, Math.round((Date.parse(r.endedAt) - Date.parse(r.startedAt)) / 60000));
      if (!mins) continue;
      // SiteLog dedupe — skip on-site tracker time when SiteLog already covers
      // this (user, site, day). Travel is never in SiteLog, so travel always goes in.
      let skipped = false;
      if (kind === "onsite" && siteKey) {
        const key = username.toLowerCase() + "::" + siteKey + "::" + date;
        if (slCover.has(key)) { skippedSL++; skipped = true; }
      }
      // Preview aggregate (unconditional — we want to show what SiteLog is
      // covering too so it's visible, not silent).
      const bKey = username + "|" + siteKey + "|" + date;
      let b = bucket.get(bKey);
      if (!b) { b = { username, siteName, siteKey, postcode: String(r.postcode || ""), date, onsiteMins: 0, travelMins: 0, skippedOnsiteMins: 0 }; bucket.set(bKey, b); }
      if (kind === "onsite") { if (skipped) b.skippedOnsiteMins += mins; else b.onsiteMins += mins; }
      else b.travelMins += mins;
      if (skipped || dryRun) continue;
      seq++;
      const jobId = "tracker:" + username + ":" + date + ":" + (siteKey || "unknown") + ":" + kind + ":" + seq;
      try {
        await env.DB.prepare(
          "INSERT INTO job_time_segments (tenant_id, username, job_id, job_ref, site, postcode, started_at, ended_at, kind) VALUES (?,?,?,?,?,?,?,?,?)"
        ).bind(tid, username, jobId, "van tracker", siteName, String(r.postcode || "").toUpperCase(), r.startedAt, r.endedAt, kind).run();
        wrote++;
      } catch {}
    }
    // Preview array with £ figures attached (uses each user's rate).
    const preview = Array.from(bucket.values()).map(b => {
      const rate = rates[b.username] || 0;
      const hoursCosted = (b.onsiteMins + b.travelMins) / 60;   // skipped on-site is NOT costed
      const cost = Math.round(hoursCosted * rate * 100) / 100;
      return {
        username: b.username, siteName: b.siteName, siteKey: b.siteKey, postcode: b.postcode, date: b.date,
        onsiteMins: b.onsiteMins, travelMins: b.travelMins, skippedOnsiteMins: b.skippedOnsiteMins,
        rate, cost,
      };
    }).sort((a, b) => (a.username + a.date + a.siteName).localeCompare(b.username + b.date + b.siteName));
    return jr({ ok: true, wrote, skippedSitelog: skippedSL, dryRun, preview }, headers);
  }

  return jr({ error: "Not found: " + sub }, headers, 404);
}

// Compact site key for the SiteLog dedupe (numeric store code if the value is
// pure digits, else uppercased alphanumerics — mirrors sla.siteKeyOf).
function normSite(s) {
  const t = String(s || "").trim();
  if (!t) return "";
  return /^\d+$/.test(t) ? String(Number(t)) : t.toUpperCase().replace(/[^A-Z0-9]/g, "");
}
// Small wrappers around app_config so the tracker AI resolver isn't riddled
// with SQL boilerplate. Same shape as costing.js's cfgGet/cfgSet — one key
// per tenant, JSON value.
async function cfgReadWrap(env, tid, name, fallback) {
  try {
    const row = await env.DB.prepare("SELECT value FROM app_config WHERE key=?").bind(`${name}:${tid}`).first();
    if (row && row.value) return JSON.parse(row.value);
  } catch {}
  return fallback;
}
async function cfgWriteWrap(env, tid, name, value) {
  await env.DB.prepare(
    "INSERT INTO app_config (tenant_id, key, value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).bind(tid, `${name}:${tid}`, JSON.stringify(value)).run();
}

async function ensureVehTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS vehicles (
    tenant_id INTEGER NOT NULL DEFAULT 1, reg TEXT NOT NULL, make TEXT, model TEXT, fuel TEXT,
    active INTEGER DEFAULT 1, mot_due TEXT, tax_due TEXT, next_service TEXT, notes TEXT, at TEXT,
    PRIMARY KEY (tenant_id, reg))`).run();
  // Service-interval + odometer columns added over time (ignore "already exists").
  const cols = [
    "svc_interval_days INTEGER", "svc_interval_miles INTEGER",
    "last_service_date TEXT", "last_service_miles INTEGER",
    "warn_days INTEGER", "warn_miles INTEGER",
    "specs TEXT",  // extra spec fields (AC, payload, dimensions, handsfree …) as JSON [{label,value}]
    "finance TEXT", // vehicle financials JSON {ownership,insuranceYear,roadTaxYear,financeMonthly,financeEnd,allowedMiles,excessPence}
    "pool INTEGER DEFAULT 0" // shared/pool vehicle (e.g. tippers) — any engineer may raise a PO against it
  ];
  for (const c of cols) { try { await env.DB.prepare(`ALTER TABLE vehicles ADD COLUMN ${c}`).run(); } catch {} }
}
// Maintenance records: dated, categorised work with cost-split allocations and
// an optional document per record. Self-migrating (CREATE IF NOT EXISTS).
async function ensureMaintTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS vehicle_maintenance (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL DEFAULT 1,
    reg TEXT NOT NULL, date TEXT, description TEXT, allocs TEXT,
    doc_key TEXT, doc_name TEXT, by TEXT, at TEXT)`).run();
  try { await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_vmaint_reg ON vehicle_maintenance(tenant_id,reg)").run(); } catch {}
}
// Latest odometer reading per vehicle, pulled from the weekly van checks.
async function latestMileage(env, tid) {
  const dn = s => String(s || "").replace(/\s+/g, "").toUpperCase();
  const out = {};   // reg -> { miles, at, date, rank }
  const consider = (k, mi, dateStr, at, source) => {
    if (!k || !mi || !dateStr) return;
    const rank = ODO_RANK[source] || 1;
    const cur = out[k];
    // Newest date wins; on the SAME date the more reliable source wins.
    if (!cur || dateStr > cur.date || (dateStr === cur.date && rank >= cur.rank)) out[k] = { miles: mi, at: at || dateStr, date: dateStr, rank };
  };
  try {
    const { results } = await env.DB.prepare(
      "SELECT vehicle, items, checked_at FROM vehicle_checks WHERE tenant_id=? AND vehicle IS NOT NULL AND vehicle!='' ORDER BY checked_at ASC"
    ).bind(tid).all();
    for (const r of results || []) {
      let m = ""; try { m = (JSON.parse(r.items || "{}").mileage || "").toString().replace(/[^0-9]/g, ""); } catch {}
      consider(dn(r.vehicle), parseInt(m, 10), (r.checked_at || "").slice(0, 10), r.checked_at, "vancheck");
    }
  } catch {}
  try {
    await ensureOdoTable(env);
    const { results } = await env.DB.prepare("SELECT reg, date, miles, source FROM odometer_readings WHERE tenant_id=? ORDER BY date ASC").bind(tid).all();
    for (const r of results || []) consider(dn(r.reg), parseInt(r.miles, 10), (r.date || "").slice(0, 10), r.date, r.source || "manual");
  } catch {}
  return out;
}
async function ensureOdoTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS odometer_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL DEFAULT 1,
    reg TEXT, date TEXT, miles INTEGER, note TEXT, by TEXT, at TEXT)`).run();
  try { await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_odo_reg ON odometer_readings(tenant_id,reg)").run(); } catch {}
  // source ranks reliability when a date has more than one reading:
  // manual (typed by a person) > vancheck > fuel (auto-pulled off a fuel statement).
  try { await env.DB.prepare("ALTER TABLE odometer_readings ADD COLUMN source TEXT").run(); } catch {}
}
// Reliability rank — higher wins on a same-date clash. Van-check mileage is the
// trusted primary; fuel-statement odometers are a secondary gap-filler.
const ODO_RANK = { manual: 3, vancheck: 2, fuel: 1 };

// ── Fuel / MPG / running-cost helpers ─────────────────────────────────────
const dnReg = s => String(s || "").replace(/\s+/g, "").toUpperCase();

// Purchase orders TAGGED TO A VEHICLE, read live from the PO system's own D1
// (PO_DB binding) — e.g. AdBlue / parts raised against a van. The PO worker
// stamps the van's registration onto po_log.vehicle_reg when a vehicle is
// picked in its site box. Fails soft to [] when PO_DB is unbound OR the
// vehicle_reg column doesn't exist yet (the PO worker hasn't been updated) —
// SQLite throws the whole SELECT on an unknown column, so the try/catch keeps
// the fleet views working (just no POs) until the column is live. reg is
// normalised on BOTH sides (strip spaces, upper) so "AB12 CDE" == "AB12CDE".
async function vehiclePoRows(env, { reg, from, to } = {}) {
  if (!env.PO_DB) return [];
  const where = ["(deleted IS NULL OR deleted=0)", "vehicle_reg IS NOT NULL", "TRIM(vehicle_reg)!=''"];
  const bind = [];
  if (reg) { where.push("UPPER(REPLACE(vehicle_reg,' ',''))=?"); bind.push(dnReg(reg)); }
  if (from) { where.push("substr(COALESCE(issued_at,cost_entered_at),1,10)>=?"); bind.push(from); }
  if (to) { where.push("substr(COALESCE(issued_at,cost_entered_at),1,10)<=?"); bind.push(to); }
  try {
    const { results } = await env.PO_DB.prepare(
      "SELECT vehicle_reg, engineer_name, supplier, site, cost_ex_vat, cost_category, trade, incident_no, job_ref, " +
      "substr(COALESCE(issued_at,cost_entered_at),1,10) AS d " +
      "FROM po_log WHERE " + where.join(" AND ") + " ORDER BY COALESCE(issued_at,cost_entered_at)"
    ).bind(...bind).all();
    return results || [];
  } catch { return []; }
}
async function ensureFuelTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS fuel_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL DEFAULT 1,
    card TEXT, username TEXT, date TEXT, litres REAL, cost REAL, note TEXT, by TEXT, at TEXT)`).run();
  try { await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_fuel_card ON fuel_entries(tenant_id,card)").run(); } catch {}
  // reg = a fill-up tagged DIRECTLY to a vehicle (fuel-card statement imports),
  // bypassing the card→user→assignment attribution. ref = the statement's unique
  // transaction id, for dedupe on re-import. Both self-migrating.
  try { await env.DB.prepare("ALTER TABLE fuel_entries ADD COLUMN reg TEXT").run(); } catch {}
  try { await env.DB.prepare("ALTER TABLE fuel_entries ADD COLUMN ref TEXT").run(); } catch {}
  try { await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_fuel_ref ON fuel_entries(tenant_id,ref)").run(); } catch {}
}
// card number → { username, name } from users.profile.fuelCard.
async function fuelCardMap(env, tid) {
  const byCard = {}, cards = [];
  try {
    const { results } = await env.DB.prepare("SELECT username, first_name, last_name, status, profile, vehicle_assigned FROM users WHERE tenant_id=?").bind(tid).all();
    for (const u of results || []) {
      let p = {}; try { p = u.profile ? JSON.parse(u.profile) : {}; } catch {}
      const card = String(p.fuelCard || "").trim();
      if (!card) continue;
      const name = ((u.first_name || "") + " " + (u.last_name || "")).trim() || u.username;
      byCard[card] = { username: u.username, name, vehicle: u.vehicle_assigned || "" };
      cards.push({ card, username: u.username, name, vehicle: u.vehicle_assigned || "", active: u.status === "Active" });
    }
  } catch {}
  return { byCard, cards };
}
// Assignment intervals per username (reg + [start,end]); resolves which vehicle
// a driver held on a given date (falls back to their current vehicle_assigned).
async function assignmentIntervals(env, tid) {
  const list = [];
  try {
    const { results } = await env.DB.prepare("SELECT reg, username, start_date, end_date FROM vehicle_assignments WHERE tenant_id=?").bind(tid).all();
    for (const r of results || []) list.push({ reg: r.reg, username: r.username, start: r.start_date || "", end: r.end_date || "" });
  } catch {}
  return list;
}
function regForUserOnDate(intervals, username, date) {
  let best = null;
  for (const iv of intervals) {
    if (iv.username !== username) continue;
    if (iv.start && date < iv.start) continue;
    if (iv.end && date > iv.end) continue;
    if (!best || iv.start > best.start) best = iv;
  }
  if (best) return best.reg;
  return "";   // caller falls back to the driver's current vehicle
}
// Total litres + spend attributed to each vehicle (all-time), via card→user→
// assignment-at-date. Returns { REGNORM: {litres, spend, first, last, count} }.
async function fuelByVehicle(env, tid) {
  await ensureFuelTable(env);
  const { byCard } = await fuelCardMap(env, tid);
  const userCurrent = {};
  for (const c of Object.values(byCard)) userCurrent[c.username] = c.vehicle;
  const intervals = await assignmentIntervals(env, tid);
  const out = {};
  try {
    const { results } = await env.DB.prepare("SELECT card, username, reg, date, litres, cost FROM fuel_entries WHERE tenant_id=?").bind(tid).all();
    for (const e of results || []) {
      // A directly-tagged reg (statement import) wins; else card→user→assignment.
      let reg = e.reg || "";
      if (!reg) {
        const user = e.username || (byCard[e.card] ? byCard[e.card].username : "");
        if (!user) continue;
        reg = regForUserOnDate(intervals, user, e.date || "") || userCurrent[user] || "";
      }
      if (!reg) continue;
      const k = dnReg(reg);
      const o = out[k] || (out[k] = { litres: 0, spend: 0, first: "", last: "", count: 0 });
      o.litres += Number(e.litres) || 0; o.spend += Number(e.cost) || 0; o.count++;
      if (e.date && (!o.first || e.date < o.first)) o.first = e.date;
      if (e.date && (!o.last || e.date > o.last)) o.last = e.date;
    }
  } catch {}
  return out;
}
// Odometer span per vehicle — merges van-check mileages AND manual odometer
// readings. Span is measured between the CHRONOLOGICAL endpoints (first→last by
// date), NOT raw min/max, so a single wild reading in the middle (e.g. a
// "123456" test value in a van check) can't blow up the distance. Same-date
// clashes prefer the manual reading. first/last are DATE strings (YYYY-MM-DD)
// so fuel can be windowed to the reading period.
// { REGNORM: {min,max,milesDriven,first,last,readings} }.
async function odoByVehicle(env, tid) {
  const byReg = {};   // regNorm -> { date -> {miles, rank} }
  const put = (k, mi, date, source) => {
    if (!k || !mi || !date) return;
    const rank = ODO_RANK[source] || 1;
    const m = byReg[k] || (byReg[k] = {}); const cur = m[date];
    // Higher-ranked source wins the date; within the same rank, the higher reading.
    if (!cur || rank > cur.rank || (rank === cur.rank && mi > cur.miles)) m[date] = { miles: mi, rank };
  };
  try {
    const { results } = await env.DB.prepare(
      "SELECT vehicle, items, checked_at FROM vehicle_checks WHERE tenant_id=? AND vehicle IS NOT NULL AND vehicle!=''"
    ).bind(tid).all();
    for (const r of results || []) {
      let m = ""; try { m = (JSON.parse(r.items || "{}").mileage || "").toString().replace(/[^0-9]/g, ""); } catch {}
      put(dnReg(r.vehicle), parseInt(m, 10), (r.checked_at || "").slice(0, 10), "vancheck");
    }
  } catch {}
  try {
    await ensureOdoTable(env);
    const { results } = await env.DB.prepare("SELECT reg, date, miles, source FROM odometer_readings WHERE tenant_id=?").bind(tid).all();
    for (const r of results || []) put(dnReg(r.reg), parseInt(r.miles, 10), (r.date || "").slice(0, 10), r.source || "manual");
  } catch {}
  const out = {};
  for (const k of Object.keys(byReg)) {
    const series = Object.entries(byReg[k]).map(([date, o]) => ({ date, miles: o.miles })).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    if (!series.length) continue;
    const first = series[0], last = series[series.length - 1];
    out[k] = {
      min: Math.min(...series.map(s => s.miles)), max: Math.max(...series.map(s => s.miles)),
      first: first.date, last: last.date, readings: series.length,
      milesDriven: Math.max(0, last.miles - first.miles)
    };
  }
  return out;
}
// Fuel fill-ups grouped per vehicle (same attribution as fuelByVehicle, but
// keeping each row so fuel can be windowed to a mileage period). { REGNORM: [{date,litres,cost}] }.
async function fuelRowsByVehicle(env, tid) {
  await ensureFuelTable(env);
  const { byCard } = await fuelCardMap(env, tid);
  const userCurrent = {}; for (const c of Object.values(byCard)) userCurrent[c.username] = c.vehicle;
  const intervals = await assignmentIntervals(env, tid);
  const out = {};
  try {
    const { results } = await env.DB.prepare("SELECT card, username, reg, date, litres, cost FROM fuel_entries WHERE tenant_id=?").bind(tid).all();
    for (const e of results || []) {
      let reg = e.reg || "";
      if (!reg) { const user = e.username || (byCard[e.card] ? byCard[e.card].username : ""); if (!user) continue; reg = regForUserOnDate(intervals, user, e.date || "") || userCurrent[user] || ""; }
      if (!reg) continue;
      (out[dnReg(reg)] || (out[dnReg(reg)] = [])).push({ date: e.date || "", litres: Number(e.litres) || 0, cost: Number(e.cost) || 0 });
    }
  } catch {}
  return out;
}
// MPG per vehicle — miles from the odometer span, litres = fuel bought WITHIN
// the reading window (> first date, ≤ last date), so it's a true like-for-like
// figure. Needs ≥2 readings. { REGNORM: {mpg, miles, litres, gallons, from, to} }.
async function mpgByVehicle(env, tid) {
  const rowsByReg = await fuelRowsByVehicle(env, tid);
  const odo = await odoByVehicle(env, tid);
  const out = {};
  for (const k of Object.keys(odo)) {
    const o = odo[k];
    if (!(o.milesDriven > 0) || o.readings < 2) continue;
    let litres = 0; for (const e of (rowsByReg[k] || [])) if (e.date > o.first && e.date <= o.last) litres += e.litres;
    if (!(litres > 0)) continue;
    const gallons = litres / UK_GALLON;
    out[k] = { mpg: Math.round((o.milesDriven / gallons) * 10) / 10, miles: o.milesDriven, litres: Math.round(litres * 10) / 10, gallons, from: o.first, to: o.last };
  }
  return out;
}
// Merged, de-duplicated odometer series for ONE reg (van checks + manual),
// sorted ascending by date; same-date keeps the higher reading.
async function odoSeries(env, tid, k) {
  const byDate = {};
  const put = (d, mi, source) => {
    if (!mi || !d) return;
    const rank = ODO_RANK[source] || 1, cur = byDate[d];
    if (!cur || rank > cur.rank || (rank === cur.rank && mi > cur.miles)) byDate[d] = { date: d, miles: mi, source, rank };
  };
  try {
    const { results } = await env.DB.prepare("SELECT items, checked_at FROM vehicle_checks WHERE tenant_id=? AND UPPER(REPLACE(vehicle,' ',''))=?").bind(tid, k).all();
    for (const r of results || []) {
      let m = ""; try { m = (JSON.parse(r.items || "{}").mileage || "").toString().replace(/[^0-9]/g, ""); } catch {}
      put((r.checked_at || "").slice(0, 10), parseInt(m, 10), "vancheck");
    }
  } catch {}
  try {
    await ensureOdoTable(env);
    const { results } = await env.DB.prepare("SELECT date, miles, source FROM odometer_readings WHERE tenant_id=? AND UPPER(REPLACE(reg,' ',''))=?").bind(tid, k).all();
    for (const r of results || []) put((r.date || "").slice(0, 10), parseInt(r.miles, 10), r.source || "manual");
  } catch {}
  return Object.values(byDate).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
}
// Detailed MPG for one reg: overall + a per-interval breakdown between each
// pair of readings (fuel bought in that gap), so anomalies / missing fills show.
async function mpgForReg(env, tid, reg) {
  const k = dnReg(reg);
  const series = await odoSeries(env, tid, k);
  if (series.length < 2) return { readings: series.length };
  const rows = (await fuelRowsByVehicle(env, tid))[k] || [];
  const win = (from, to) => rows.reduce((s, e) => (e.date > from && e.date <= to) ? s + (Number(e.litres) || 0) : s, 0);
  const first = series[0], last = series[series.length - 1];
  const miles = Math.max(0, last.miles - first.miles);
  const litres = win(first.date, last.date), gallons = litres / UK_GALLON;
  const intervals = [];
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1], b = series[i];
    const md = Math.max(0, b.miles - a.miles), l = win(a.date, b.date), g = l / UK_GALLON;
    intervals.push({ from: a.date, to: b.date, miles: md, litres: Math.round(l * 10) / 10, mpg: (md > 0 && g > 0) ? Math.round((md / g) * 10) / 10 : null });
  }
  return {
    readings: series.length, from: first.date, to: last.date, miles, litres: Math.round(litres * 10) / 10,
    mpg: (miles > 0 && gallons > 0) ? Math.round((miles / gallons) * 10) / 10 : null, intervals
  };
}
function financeOf(v) { return parseJson(v && v.finance, {}) || {}; }
// Annual running cost for one vehicle. Combines fixed costs (insurance, tax,
// finance) with projected fuel (from its own spend rate) + maintenance (last 12
// months) + projected excess-mileage charge. `projected` flags the estimates.
function runningCost(fin, fuelV, odoV, maint12) {
  fin = fin || {}; const num = x => { const n = Number(x); return isFinite(n) ? n : 0; };
  const insurance = num(fin.insuranceYear), roadTax = num(fin.roadTaxYear);
  const finance = (fin.ownership === "financed") ? num(fin.financeMonthly) * 12 : 0;
  // Projected annual fuel from the vehicle's own spend/day (real span).
  let fuelYear = 0, fuelProjected = false, milesYear = 0;
  if (fuelV && fuelV.spend > 0 && fuelV.first && fuelV.last) {
    const days = Math.max(1, (Date.parse(fuelV.last) - Date.parse(fuelV.first)) / 86400000);
    fuelYear = fuelV.spend / days * 365; fuelProjected = days < 365;
  }
  if (odoV && odoV.milesDriven > 0 && odoV.first && odoV.last) {
    const days = Math.max(1, (Date.parse(odoV.last) - Date.parse(odoV.first)) / 86400000);
    milesYear = odoV.milesDriven / days * 365;
  }
  const maintenance = num(maint12);   // real: last 12 months
  // Excess mileage (financed agreements with an allowance + per-mile charge).
  let excess = 0, excessProjected = false;
  const allowed = num(fin.allowedMiles), excessPence = num(fin.excessPence);
  if (fin.ownership === "financed" && allowed > 0 && excessPence > 0 && milesYear > allowed) {
    excess = (milesYear - allowed) * excessPence / 100; excessProjected = true;
  }
  const total = insurance + roadTax + finance + fuelYear + maintenance + excess;
  return {
    insurance, roadTax, finance, fuel: Math.round(fuelYear), maintenance, excess: Math.round(excess),
    milesYear: Math.round(milesYear), total: Math.round(total),
    projected: fuelProjected || excessProjected, fuelProjected, excessProjected,
  };
}
// Given a card | 'all', return spend/litres/miles totals + per-period averages.
// Every average uses the REAL data span (days); a period longer than the span
// is flagged `projected`. Miles come from the linked vehicle(s) odometer span.
function periodStats(spanDays, totals) {
  const per = (days) => {
    const v = { spend: totals.spend / spanDays * days, litres: totals.litres / spanDays * days, miles: totals.miles / spanDays * days, projected: spanDays < days };
    v.spend = Math.round(v.spend * 100) / 100; v.litres = Math.round(v.litres * 10) / 10; v.miles = Math.round(v.miles);
    return v;
  };
  return { week: per(7), month: per(30.44), quarter: per(91.31), year: per(365) };
}

// Given a vehicle row + current mileage, work out the next service and a status.
function serviceView(v, cur) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const warnDays = v.warn_days != null ? v.warn_days : 30;
  const warnMiles = v.warn_miles != null ? v.warn_miles : 1000;
  let dueDate = v.next_service || "";
  if (v.svc_interval_days && v.last_service_date) {
    const d = new Date(v.last_service_date); d.setDate(d.getDate() + v.svc_interval_days);
    dueDate = d.toISOString().slice(0, 10);
  }
  let dueMiles = null;
  if (v.svc_interval_miles && v.last_service_miles != null) dueMiles = v.last_service_miles + v.svc_interval_miles;
  let status = "none", reasons = [];
  const rank = { none: 0, ok: 1, warn: 2, bad: 3 };
  const bump = (s, why) => { if (rank[s] > rank[status]) status = s; if (why) reasons.push(why); };
  if (dueDate) {
    const dd = new Date(dueDate); dd.setHours(0, 0, 0, 0);
    const days = Math.ceil((dd - today) / 86400000);
    if (days < 0) bump("bad", "Service overdue by date");
    else if (days <= warnDays) bump("warn", `Service due in ${days} day(s)`);
    else bump("ok");
  }
  if (dueMiles != null && cur && cur.miles != null) {
    const left = dueMiles - cur.miles;
    if (left <= 0) bump("bad", "Service overdue by mileage");
    else if (left <= warnMiles) bump("warn", `Service due in ${left} mile(s)`);
    else bump("ok");
  } else if (dueMiles != null) {
    bump("ok");
  }
  return { dueDate, dueMiles, status, reason: reasons.join(" · "), warnDays, warnMiles };
}
async function ensureTsTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS van_timesheets (
    tenant_id INTEGER NOT NULL DEFAULT 1, week TEXT NOT NULL, username TEXT NOT NULL,
    data TEXT, at TEXT, PRIMARY KEY (tenant_id, week, username))`).run();
}

async function ensureAssignTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS vehicle_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL DEFAULT 1,
    reg TEXT NOT NULL, username TEXT NOT NULL, start_date TEXT NOT NULL,
    end_date TEXT, assigned_by TEXT, at TEXT)`).run();
}
// Bootstrap current assignments from the existing users.vehicle_assigned field
// the first time the registry is used, so history starts from today's reality.
async function seedAssignments(env, tid) {
  try {
    const cnt = await env.DB.prepare("SELECT COUNT(*) AS n FROM vehicle_assignments WHERE tenant_id=?").bind(tid).first();
    if (cnt && Number(cnt.n) > 0) return;
    const today = new Date().toISOString().slice(0, 10);
    const { results } = await env.DB.prepare(
      "SELECT username, vehicle_assigned FROM users WHERE tenant_id=? AND vehicle_assigned IS NOT NULL AND vehicle_assigned!=''"
    ).bind(tid).all();
    for (const u of results || []) {
      await env.DB.prepare("INSERT INTO vehicle_assignments (tenant_id, reg, username, start_date, end_date, assigned_by, at) VALUES (?,?,?,?,?,?,?)")
        .bind(tid, String(u.vehicle_assigned).trim(), u.username, today, null, "seed", new Date().toISOString()).run();
    }
  } catch { /* seeding is best-effort */ }
}
