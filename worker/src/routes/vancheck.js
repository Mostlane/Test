// Weekly van checks — replaces the Jotform walkaround.
//   GET  /vancheck/config             -> my vehicle, this week's check, deadline, checklist
//   POST /vancheck/submit             -> save my check (photos -> R2 ASSET_BUCKET)
//   GET  /vancheck/week?week=<Mon>    -> all drivers + status (Vehicles|FullAccess)
//   GET  /vancheck/attention          -> badge/attention data (mine + office missing)
//   GET  /vancheck/settings           -> deadline + checklist (any session)
//   POST /vancheck/settings           -> update deadline/checklist (FullAccess)
//
// Storage: the existing vehicle_checks table (PK username+week) — the Story
// Mode weekly check writes here too, so either route counts as "done".
// items JSON: { answers:{id:"ok"|"defect"}, defectNotes:{id:text}, photos:[r2Keys],
// mileage, source:"portal" }. Photos live in ASSET_BUCKET under vancheck/…,
// served by the existing public /asset-image?key= route.
// A driver = an Active user with a vehicle allocated (users.vehicle_assigned,
// set in Users Admin) — that's also what pre-fills the form.

import { json, error } from "../lib/http.js";
import { permissionsFor } from "../lib/auth.js";
import { tenantDB, resolveTenantId } from "../lib/tenantdb.js";
import { getRules, saveRules, isSuppressed } from "../lib/suppress.js";
import { sendToUser } from "./push.js";

const SETTINGS_KEY = "vancheck:settings";
const OPTOUT_KEY = "vancheck:optout";   // JSON array of usernames taken OUT of the weekly van-check cycle

// Drivers an admin has switched OFF: not required to check, no reminders, no
// blocking home-page gate, shown as "Off" on the weekly grid. Returns a Set of
// usernames. Uses env.DB so both the request handler and the cron can call it.
async function getOptedOut(env, tid) {
  try {
    const row = await env.DB.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(tid, OPTOUT_KEY).first();
    const a = row && row.value ? JSON.parse(row.value) : [];
    return new Set(Array.isArray(a) ? a.map(String) : []);
  } catch { return new Set(); }
}
// Is the whole van-check type paused for everyone (the blunt "bypass")?
function isGloballyPaused(rules) { return (rules || []).some(r => r.type === "vehicle-check" && (r.user == null || r.user === "") && (r.key == null || r.key === "")); }
const DEFAULT_CHECKLIST = [
  { id: "lights", label: "Lights & indicators working" },
  { id: "tyres", label: "Tyres & wheels (tread, pressure, damage)" },
  { id: "wipers", label: "Windscreen, wipers & washers" },
  { id: "mirrors", label: "Mirrors & glass" },
  { id: "bodywork", label: "Bodywork damage (walk all four sides)" },
  { id: "oil", label: "Engine oil level" },
  { id: "coolant", label: "Coolant level" },
  { id: "brakes", label: "Brakes & handbrake" },
  { id: "horn", label: "Horn" },
  { id: "seatbelts", label: "Seatbelts" },
  { id: "interior", label: "Cab interior & cleanliness" },
  { id: "load", label: "Load area secure & racking safe" },
  { id: "plates", label: "Number plates present & clean" },
  { id: "leaks", label: "No leaks under the vehicle" },
  { id: "firstaid", label: "First aid kit & fire extinguisher present" },
];
// Named photo slots — each one opens the camera and is required unless
// marked optional. Editable in van-checks.html settings like the checklist.
const DEFAULT_PHOTO_SLOTS = [
  { id: "front", label: "Front of van", required: true },
  { id: "rear", label: "Rear of van", required: true },
  { id: "nearside", label: "Nearside (passenger side)", required: true },
  { id: "offside", label: "Offside (driver side)", required: true },
  { id: "tyre_nsf", label: "Tyre — front nearside", required: true },
  { id: "tyre_osf", label: "Tyre — front offside", required: true },
  { id: "tyre_nsr", label: "Tyre — rear nearside", required: true },
  { id: "tyre_osr", label: "Tyre — rear offside", required: true },
  { id: "oil", label: "Oil level (dipstick)", required: true },
  { id: "cab", label: "Inside cab", required: true },
  { id: "load", label: "Load area", required: false },
];
// Equipment on board (Present/Missing) — off by default (opt-in), editable in
// van-check settings like the checklist. A missing item counts as an issue.
const DEFAULT_EQUIPMENT = [];
// reminders: admin-set list of push times [{dow 1-7, time "HH:MM"}] — empty
// means the built-in default (Monday 07:00 + a chase before the deadline).
const DEFAULT_SETTINGS = { dueDow: 5, dueTime: "17:00", checklist: DEFAULT_CHECKLIST, equipment: DEFAULT_EQUIPMENT, photoSlots: DEFAULT_PHOTO_SLOTS, reminders: [] }; // Friday 17:00 UK

function londonDate(d = new Date()) { return d.toLocaleDateString("en-CA", { timeZone: "Europe/London" }); }
function londonHM(d) { return new Date(d).toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour12: false, hour: "2-digit", minute: "2-digit" }); }
function londonToISO(dateStr, hm) {
  for (const off of ["+01:00", "+00:00"]) {
    const d = new Date(`${dateStr}T${hm}:00${off}`);
    if (!isNaN(d) && londonDate(d) === dateStr && londonHM(d) === hm) return d.toISOString();
  }
  return new Date(`${dateStr}T${hm}:00Z`).toISOString();
}
function mondayOf(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function getSettings(db) {
  const row = await db.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(db.tenantId, SETTINGS_KEY).first();
  let s = null; try { s = row ? JSON.parse(row.value) : null; } catch {}
  const out = { ...DEFAULT_SETTINGS, ...(s || {}) };
  if (!Array.isArray(out.checklist) || !out.checklist.length) out.checklist = DEFAULT_CHECKLIST;
  if (!Array.isArray(out.photoSlots) || !out.photoSlots.length) out.photoSlots = DEFAULT_PHOTO_SLOTS;
  if (!Array.isArray(out.equipment)) out.equipment = [];   // opt-in; empty = no equipment section
  if (!Array.isArray(out.alertUsers)) out.alertUsers = []; // who to push when an "Alert if" answer is given
  if (!Array.isArray(out.reminders)) out.reminders = [];   // custom reminder times; empty = default schedule
  return out;
}
// Validate a reminders list from the client: [{dow 1-7, time "HH:MM"}].
function normReminders(arr) {
  const out = [], seen = new Set();
  for (const r of Array.isArray(arr) ? arr : []) {
    const dow = Math.min(7, Math.max(1, Number(r && r.dow) || 0));
    const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(r && r.time) ? r.time : "";
    if (!dow || !time) continue;
    const key = dow + ":" + time; if (seen.has(key)) continue; seen.add(key);
    out.push({ dow, time });
  }
  return out.slice(0, 21).sort((a, b) => a.dow - b.dow || a.time.localeCompare(b.time));
}

// ── Custom van checks: saved reusable templates + one-off sends ──────────────
// Templates live in app_config; a "send" snapshots the template into a row of
// the self-migrating custom_van_checks table, one per driver (pending → done).
const CUSTOM_TPL_KEY = tid => `vancheck:customtpls:${tid}`;
const slug = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
function normSlots(arr) {
  const out = [], seen = new Set();
  for (const i of Array.isArray(arr) ? arr : []) {
    const label = String(i && i.label || "").trim(); if (!label) continue;
    let id = slug(i.id) || slug(label) || ("slot" + (out.length + 1));
    while (seen.has(id)) id = id + "_" + (out.length + 1);
    seen.add(id);
    out.push({ id, label, required: i.required !== false });
  }
  return out;
}
async function getCustomTpls(db) {
  const row = await db.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(db.tenantId, CUSTOM_TPL_KEY(db.tenantId)).first();
  try { const v = JSON.parse(row && row.value || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
async function saveCustomTpls(db, list) {
  await db.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(db.tenantId, CUSTOM_TPL_KEY(db.tenantId), JSON.stringify(list)).run();
}
// ── Manual grid override statuses (Full-Access sets these on the by-engineer
// grid so stats reflect reality — holiday, off sick, van off road…). `tone`
// decides how it counts: "done" = a completed check, "excused" = neither done
// nor missed (drops out of the missed count), "issue" = a problem. Configurable
// per tenant; "skipped" (Not required) is always the default first option.
const GRID_STATUS_KEY = tid => `vancheck:gridstatuses:${tid}`;
const DEFAULT_GRID_STATUSES = [
  { key: "skipped", label: "Not required", colour: "#a5b4fc", tone: "excused" },
  { key: "holiday", label: "On holiday", colour: "#2dd4bf", tone: "excused" },
  { key: "sick", label: "Off sick", colour: "#fb923c", tone: "excused" },
  { key: "vor", label: "Van off road", colour: "#94a3b8", tone: "excused" },
  { key: "rest", label: "Not working", colour: "#cbd5e1", tone: "excused" },
  { key: "manual", label: "Completed (paper)", colour: "#22c55e", tone: "done" },
];
function normGridStatuses(arr) {
  const out = [], seen = new Set();
  for (const i of Array.isArray(arr) ? arr : []) {
    const label = String(i && i.label || "").trim(); if (!label) continue;
    let key = slug(i.key) || slug(label) || ("s" + (out.length + 1));
    while (seen.has(key)) key = key + "_" + (out.length + 1);
    seen.add(key);
    const tone = ["done", "excused", "issue"].includes(i.tone) ? i.tone : "excused";
    const colour = /^#[0-9a-fA-F]{3,8}$/.test(i.colour || "") ? i.colour : "#a5b4fc";
    out.push({ key, label: label.slice(0, 40), colour, tone });
  }
  // Always guarantee "skipped" (Not required) exists as the default.
  if (!out.some(s => s.key === "skipped")) out.unshift({ ...DEFAULT_GRID_STATUSES[0] });
  return out;
}
async function getGridStatuses(db) {
  const row = await db.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(db.tenantId, GRID_STATUS_KEY(db.tenantId)).first();
  if (!row || !row.value) return DEFAULT_GRID_STATUSES.slice();
  try { const v = JSON.parse(row.value); return normGridStatuses(v); } catch { return DEFAULT_GRID_STATUSES.slice(); }
}
async function saveGridStatuses(db, list) {
  await db.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(db.tenantId, GRID_STATUS_KEY(db.tenantId), JSON.stringify(normGridStatuses(list))).run();
}
async function ensureCustomTable(db) {
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS custom_van_checks (
      id TEXT PRIMARY KEY, tenant_id TEXT, username TEXT, reg TEXT, tpl_id TEXT, name TEXT,
      items TEXT, status TEXT, sent_by TEXT, sent_at TEXT, submitted_at TEXT)`).run();
  } catch {}
  // due_at = chosen deadline; snooze = 1 if the driver may snooze the reminder.
  for (const c of ["due_at TEXT", "snooze INTEGER DEFAULT 1"]) {
    try { await db.prepare(`ALTER TABLE custom_van_checks ADD COLUMN ${c}`).run(); } catch {}
  }
}
async function nameMap(env, tid) {
  const out = {};
  try {
    const { results } = await env.DB.prepare("SELECT username, first_name, last_name FROM users WHERE tenant_id=?").bind(tid).all();
    for (const u of results || []) out[u.username] = ((u.first_name || "") + " " + (u.last_name || "")).trim() || u.username;
  } catch {}
  return out;
}
// Normalise a checklist/equipment item, keeping an optional "Alert if" rule.
// failVal = the answer that flags an issue for this list ("defect" / "missing").
// Default answer palettes (used when an item defines no custom options).
// tone: "ok" (pass) | "issue" (a problem — counted + alertable) | "na" (neutral).
const DEF_CHECK_OPTS = [{ value: "ok", label: "OK", tone: "ok" }, { value: "defect", label: "Defect", tone: "issue" }];
const DEF_EQUIP_OPTS = [{ value: "present", label: "Present", tone: "ok" }, { value: "missing", label: "Missing", tone: "issue" }];
const optsFor = (item, kind) => (item && Array.isArray(item.options) && item.options.length) ? item.options : (kind === "equip" ? DEF_EQUIP_OPTS : DEF_CHECK_OPTS);
// Normalise a custom answer-options list; returns null to fall back to defaults.
function normOptions(arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  const out = [], seen = new Set();
  for (const o of arr) {
    const label = String(o && o.label || "").trim(); if (!label) continue;
    let value = slug(o && o.value) || slug(label); if (!value) continue;
    while (seen.has(value)) value += "_2";
    seen.add(value);
    const tone = (o.tone === "issue" || o.tone === "na") ? o.tone : "ok";
    out.push({ value, label, tone });
  }
  return out.length ? out : null;
}
function normAlertItem(i, failVal) {
  const id = String(i.id || "").trim() || String(i.label || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 30);
  const label = String(i.label || "").trim();
  const out = { id, label };
  const options = normOptions(i && i.options);
  if (options) out.options = options;
  if (i && i.alert) {
    const on = i.alertOn;
    out.alert = true;
    // With custom options, "Alert if" fires on any issue-toned answer, so a
    // specific alertOn isn't needed; keep it for the default OK/Defect items.
    if (!options) out.alertOn = (on === "ok" || on === "present" || on === "defect" || on === "missing") ? on : failVal;
  }
  return out;
}
// The tone of a given answer for an item ("ok" | "issue" | "na").
function answerTone(item, kind, value) {
  const o = optsFor(item, kind).find(x => x.value === value);
  if (o) return o.tone;
  return (value === "defect" || value === "missing") ? "issue" : (value === "ok" || value === "present") ? "ok" : "na";
}
// Given the answers + a settings/template object, return the fired alerts.
// A tagged item alerts on any issue-toned answer; a default item on alertOn.
export function evalAlerts(answers, tpl) {
  const out = [];
  for (const [arr, kind] of [[tpl.checklist || [], "check"], [tpl.equipment || [], "equip"]]) {
    for (const it of arr) {
      if (!it || !it.alert) continue;
      const val = answers[it.id]; if (val == null) continue;
      const fired = (Array.isArray(it.options) && it.options.length) ? (answerTone(it, kind, val) === "issue") : (val === it.alertOn);
      if (fired) out.push({ id: it.id, label: it.label, answer: val });
    }
  }
  return out;
}
// Compute the per-answer meta {label,tone} + the list of issue ids, from the
// template — stored on the check so every viewer is self-describing.
function answerMetaFor(answers, tpl) {
  const defMap = {};
  (tpl.checklist || []).forEach(it => { defMap[it.id] = { item: it, kind: "check" }; });
  (tpl.equipment || []).forEach(it => { defMap[it.id] = { item: it, kind: "equip" }; });
  const answerMeta = {}, issues = [];
  for (const [id, val] of Object.entries(answers || {})) {
    const d = defMap[id];
    const tone = d ? answerTone(d.item, d.kind, val) : ((val === "defect" || val === "missing") ? "issue" : "ok");
    const opt = d ? optsFor(d.item, d.kind).find(x => x.value === val) : null;
    answerMeta[id] = { label: opt ? opt.label : answerWord(val), tone };
    if (tone === "issue") issues.push(id);
  }
  return { answerMeta, issues };
}
// Human word for an answer value (for the push body).
export function answerWord(v) {
  return v === "defect" ? "Defect" : v === "missing" ? "Missing" : v === "present" ? "Present" : v === "ok" ? "OK" : String(v || "");
}
// This week's deadline instant: Monday `week` + (dueDow-1) days at dueTime UK.
function deadlineFor(week, s) {
  const dow = Math.min(7, Math.max(1, Number(s.dueDow) || 5));
  const hm = /^([01]\d|2[0-3]):[0-5]\d$/.test(s.dueTime || "") ? s.dueTime : "17:00";
  return londonToISO(addDays(week, dow - 1), hm);
}
function shapeCheck(r) {
  if (!r) return null;
  let items = {}; try { items = r.items ? JSON.parse(r.items) : {}; } catch {}
  const answers = items.answers || {};
  // Prefer the stored issue ids (tone-aware); fall back to the legacy convention.
  const defects = Array.isArray(items.issues) ? items.issues : Object.keys(answers).filter(k => answers[k] === "defect" || answers[k] === "missing");
  return {
    username: r.username, week: r.week, vehicle: r.vehicle, checkedAt: r.checked_at,
    safeToDrive: r.safe_to_drive === null ? null : !!Number(r.safe_to_drive),
    note: r.note || "", answers, defectNotes: items.defectNotes || {},
    photos: items.photos || [], slotPhotos: items.slotPhotos || {},
    mileage: items.mileage || "", source: items.source || "story",
    defectCount: defects.length, alerts: items.alerts || [],
    answerMeta: items.answerMeta || {},
    skipped: !!items.skipped, skippedBy: items.skippedBy || "",
    // Manual Full-Access override (holiday / sick / VOR / completed-on-paper…).
    override: items.override ? { status: items.status || "skipped", label: items.label || "", tone: items.tone || "excused", colour: items.colour || "", by: items.by || items.skippedBy || "", at: items.at || items.skippedAt || "" } : null,
  };
}

export async function handle(request, env, ctx, url, sess) {
  if (!sess) return error("Not authenticated", 401, env, request);
  const tenantId = sess.tenantId;
  const db = tenantDB(env, tenantId);
  const me = sess.user.username;
  const path = url.pathname;
  const method = request.method.toUpperCase();

  const isAdmin = async () => {
    const p = await permissionsFor(env, tenantId, me);
    return p.FullAccess === "Yes";
  };
  const canViewAll = async () => {
    const p = await permissionsFor(env, tenantId, me);
    return p.FullAccess === "Yes" || p.Vehicles === "Yes";
  };

  // ── Settings ────────────────────────────────────────────────────────────────
  if (path === "/vancheck/settings" && method === "GET") {
    return json({ ok: true, settings: await getSettings(db) }, {}, env, request);
  }
  if (path === "/vancheck/settings" && method === "POST") {
    if (!(await isAdmin())) return error("Only an admin can change van-check settings.", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const s = await getSettings(db);
    if (b.dueDow !== undefined) s.dueDow = Math.min(7, Math.max(1, Number(b.dueDow) || 5));
    if (b.dueTime !== undefined && /^([01]\d|2[0-3]):[0-5]\d$/.test(b.dueTime)) s.dueTime = b.dueTime;
    if (Array.isArray(b.checklist)) {
      const list = b.checklist.map(i => normAlertItem(i, "defect")).filter(i => i.label);
      if (list.length) s.checklist = list;
    }
    if (Array.isArray(b.photoSlots)) {
      const slots = b.photoSlots
        .map(i => ({ id: String(i.id || "").trim() || String(i.label || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 30), label: String(i.label || "").trim(), required: i.required !== false }))
        .filter(i => i.label);
      if (slots.length) s.photoSlots = slots;
    }
    // Equipment on board — opt-in Present/Missing items; an empty list clears it.
    if (Array.isArray(b.equipment)) {
      s.equipment = b.equipment.map(i => normAlertItem(i, "missing")).filter(i => i.label);
    }
    // Who gets pushed when an item's "Alert if" answer is given.
    if (Array.isArray(b.alertUsers)) s.alertUsers = b.alertUsers.map(u => String(u || "").trim()).filter(Boolean).slice(0, 50);
    // Custom reminder times (empty list = default Monday 07:00 + deadline chase).
    if (Array.isArray(b.reminders)) s.reminders = normReminders(b.reminders);
    await db.prepare("INSERT INTO app_config (tenant_id, key, value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(db.tenantId, SETTINGS_KEY, JSON.stringify(s)).run();
    return json({ ok: true, settings: s }, {}, env, request);
  }

  // ── Custom van checks — saved templates (Vehicles|FullAccess) ───────────────
  if (path === "/vancheck/custom-templates" && method === "GET") {
    if (!(await canViewAll())) return error("Forbidden", 403, env, request);
    return json({ ok: true, templates: await getCustomTpls(db) }, {}, env, request);
  }
  if (path === "/vancheck/custom-templates" && method === "POST") {
    if (!(await canViewAll())) return error("Forbidden", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const name = String(b.name || "").trim();
    if (!name) return error("A template name is required.", 400, env, request);
    const checklist = (Array.isArray(b.checklist) ? b.checklist : []).map(i => normAlertItem(i, "defect")).filter(i => i.label);
    const equipment = (Array.isArray(b.equipment) ? b.equipment : []).map(i => normAlertItem(i, "missing")).filter(i => i.label);
    const photoSlots = normSlots(b.photoSlots);
    if (!checklist.length && !equipment.length && !photoSlots.length)
      return error("Add at least one checklist item, equipment item or photo.", 400, env, request);
    const list = await getCustomTpls(db);
    const id = (b.id && list.some(t => t.id === b.id)) ? b.id : ("cvt-" + crypto.randomUUID().slice(0, 8));
    const tpl = { id, name, checklist, equipment, photoSlots };
    const idx = list.findIndex(t => t.id === id);
    if (idx >= 0) list[idx] = tpl; else list.push(tpl);
    await saveCustomTpls(db, list);
    return json({ ok: true, template: tpl, templates: list }, {}, env, request);
  }
  if (path === "/vancheck/custom-templates/delete" && method === "POST") {
    if (!(await canViewAll())) return error("Forbidden", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const list = (await getCustomTpls(db)).filter(t => t.id !== String(b.id || ""));
    await saveCustomTpls(db, list);
    return json({ ok: true, templates: list }, {}, env, request);
  }
  // Send a saved template to specific drivers — one pending check each + push.
  if (path === "/vancheck/custom-send" && method === "POST") {
    if (!(await canViewAll())) return error("Forbidden", 403, env, request);
    await ensureCustomTable(db);
    const b = await request.json().catch(() => ({}));
    const tpl = (await getCustomTpls(db)).find(t => t.id === String(b.tplId || ""));
    if (!tpl) return error("Template not found.", 404, env, request);
    const usernames = [...new Set((Array.isArray(b.usernames) ? b.usernames : []).map(u => String(u || "").trim()).filter(Boolean))];
    if (!usernames.length) return error("Pick at least one driver.", 400, env, request);
    const { results: urows } = await db.prepare("SELECT username, vehicle_assigned FROM users WHERE tenant_id=?").bind(db.tenantId).all();
    const regOf = {}; for (const u of urows || []) regOf[u.username] = u.vehicle_assigned || "";
    const items = JSON.stringify({ checklist: tpl.checklist, equipment: tpl.equipment, photoSlots: tpl.photoSlots });
    const now = new Date().toISOString();
    const created = [];
    for (const un of usernames) {
      const id = "cvc-" + crypto.randomUUID().slice(0, 12);
      await db.prepare("INSERT INTO custom_van_checks (id,tenant_id,username,reg,tpl_id,name,items,status,sent_by,sent_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .bind(id, db.tenantId, un, regOf[un] || "", tpl.id, tpl.name, items, "pending", me, now).run();
      created.push({ id, username: un });
      if (ctx && ctx.waitUntil) ctx.waitUntil(sendToUser(env, db.tenantId, un, {
        title: "Van check to complete", body: `Please complete the "${tpl.name}" van check.`,
        url: "/van-check.html?custom=" + id, tag: "custom-vancheck"
      }));
    }
    return json({ ok: true, created }, {}, env, request);
  }
  // Request a (standard) van check for ONE vehicle's assigned driver — the button
  // on the vehicle card. Uses the normal checklist/equipment/photo slots, with a
  // chosen deadline and whether the driver may snooze the reminder.
  if (path === "/vancheck/request" && method === "POST") {
    if (!(await canViewAll())) return error("Forbidden", 403, env, request);
    await ensureCustomTable(db);
    const b = await request.json().catch(() => ({}));
    const reg = String(b.reg || "").trim();
    if (!reg) return error("No vehicle given.", 400, env, request);
    const norm = r => String(r || "").toUpperCase().replace(/\s+/g, "");
    const { results: urows } = await db.prepare("SELECT username, vehicle_assigned FROM users WHERE tenant_id=? AND status='Active'").bind(db.tenantId).all();
    let un;
    if (b.username) {
      // Pool/unassigned van: the office picked which engineer to request from.
      const chosen = (urows || []).find(u => String(u.username).toLowerCase() === String(b.username).toLowerCase());
      if (!chosen) return error("That engineer wasn't found.", 400, env, request);
      un = chosen.username;
    } else {
      // Assigned van: request from its driver.
      const driver = (urows || []).find(u => norm(u.vehicle_assigned) === norm(reg));
      if (!driver) return error("No active driver is assigned to " + reg + " — pick an engineer to request the check from.", 400, env, request);
      un = driver.username;
    }
    const dueAt = (b.dueAt && Number.isFinite(Date.parse(b.dueAt))) ? new Date(b.dueAt).toISOString() : deadlineFor(mondayOf(londonDate()), await getSettings(db));
    const snooze = b.snooze === false ? 0 : 1;
    const s = await getSettings(db);
    const items = JSON.stringify({ checklist: s.checklist || [], equipment: s.equipment || [], photoSlots: s.photoSlots || [] });
    const id = "cvc-" + crypto.randomUUID().slice(0, 12);
    const now = new Date().toISOString();
    await db.prepare("INSERT INTO custom_van_checks (id,tenant_id,username,reg,tpl_id,name,items,status,sent_by,sent_at,due_at,snooze) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(id, db.tenantId, un, reg, "", "Van check — " + reg, items, "pending", me, now, dueAt, snooze).run();
    if (ctx && ctx.waitUntil) ctx.waitUntil(sendToUser(env, db.tenantId, un, {
      title: "Van check requested", body: `Please complete the van check for ${reg}.`,
      url: "/van-check.html?custom=" + id, tag: "custom-vancheck", actionable: true
    }));
    return json({ ok: true, id, driver: un, reg, dueAt, snooze: !!snooze }, {}, env, request);
  }
  // Admin dashboard: every sent custom check + who's done.
  if (path === "/vancheck/custom-status" && method === "GET") {
    if (!(await canViewAll())) return error("Forbidden", 403, env, request);
    await ensureCustomTable(db);
    const names = await nameMap(env, db.tenantId);
    const { results } = await db.prepare("SELECT id, username, reg, name, status, sent_at, submitted_at FROM custom_van_checks WHERE tenant_id=? ORDER BY sent_at DESC LIMIT 300").bind(db.tenantId).all();
    const items = (results || []).map(r => ({ ...r, name_of: names[r.username] || r.username }));
    return json({ ok: true, items }, {}, env, request);
  }
  if (path === "/vancheck/custom-cancel" && method === "POST") {
    if (!(await canViewAll())) return error("Forbidden", 403, env, request);
    await ensureCustomTable(db);
    const b = await request.json().catch(() => ({}));
    await db.prepare("DELETE FROM custom_van_checks WHERE tenant_id=? AND id=? AND status='pending'").bind(db.tenantId, String(b.id || "")).run();
    return json({ ok: true }, {}, env, request);
  }
  // Driver: my pending custom checks (drives a prompt on van-check.html).
  if (path === "/vancheck/custom-mine" && method === "GET") {
    await ensureCustomTable(db);
    const { results } = await db.prepare("SELECT id, name, sent_at FROM custom_van_checks WHERE tenant_id=? AND username=? AND status='pending' ORDER BY sent_at DESC").bind(db.tenantId, me).all();
    return json({ ok: true, items: results || [] }, {}, env, request);
  }
  // Driver/admin: load a custom check in the same shape /vancheck/config uses,
  // so van-check.html renders it with the existing form.
  if (path === "/vancheck/custom-get" && method === "GET") {
    await ensureCustomTable(db);
    const id = url.searchParams.get("id");
    const row = await db.prepare("SELECT * FROM custom_van_checks WHERE tenant_id=? AND id=?").bind(db.tenantId, id).first();
    if (!row) return error("Custom check not found.", 404, env, request);
    if (row.username !== me && !(await canViewAll())) return error("This check wasn't sent to you.", 403, env, request);
    let it = {}; try { it = JSON.parse(row.items || "{}"); } catch {}
    return json({
      ok: true, custom: true, customId: row.id, name: row.name, status: row.status,
      week: row.id, vehicle: row.reg || sess.user.vehicle_assigned || "",
      deadline: { dueAt: row.due_at || new Date(Date.now() + 7 * 86400000).toISOString(), overdue: row.due_at ? Date.now() > Date.parse(row.due_at) : false },
      checklist: it.checklist || [], equipment: it.equipment || [], photoSlots: it.photoSlots || [],
      myCheck: row.status === "done" ? { source: "portal", vehicle: row.reg || "", defectCount: 0, safeToDrive: true } : null,
    }, {}, env, request);
  }

  // ── My config (drives the form + prefill) ───────────────────────────────────
  if (path === "/vancheck/config" && method === "GET") {
    const s = await getSettings(db);
    const week = mondayOf(londonDate());
    const mine = await db.prepare("SELECT * FROM vehicle_checks WHERE tenant_id=? AND username=? AND week=?")
      .bind(db.tenantId, me, week).first();
    const dueAt = deadlineFor(week, s);
    await ensureCustomTable(db);
    const { results: customChecks } = await db.prepare("SELECT id, name, sent_at FROM custom_van_checks WHERE tenant_id=? AND username=? AND status='pending' ORDER BY sent_at DESC").bind(db.tenantId, me).all();
    // Shared/pool vehicles (the tippers) an engineer may ALSO do a check on — the
    // only alternatives to their assigned van, offered as options (no free text).
    let poolVehicles = [];
    try {
      const { results: pv } = await env.DB.prepare("SELECT reg, make, model FROM vehicles WHERE (active IS NULL OR active=1) AND pool=1 AND (tenant_id=1 OR tenant_id='1')").all();
      poolVehicles = (pv || []).map(v => ({ reg: v.reg, desc: [v.make, v.model].filter(Boolean).join(" ").trim() }));
    } catch {}
    return json({
      ok: true, week, vehicle: sess.user.vehicle_assigned || "",
      deadline: { dow: s.dueDow, time: s.dueTime, dueAt, overdue: Date.now() > Date.parse(dueAt) },
      checklist: s.checklist,
      equipment: s.equipment || [],
      photoSlots: s.photoSlots,
      myCheck: shapeCheck(mine),
      customChecks: customChecks || [],   // one-off custom checks the office has sent me
      poolVehicles,                        // shared tippers the driver may also check
    }, {}, env, request);
  }

  // ── Submit my check ─────────────────────────────────────────────────────────
  if (path === "/vancheck/submit" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    // Custom (one-off) check: identified by customId. It uses its OWN snapshot of
    // items (not the weekly settings) and is stored under a distinct week key so
    // it never collides with the weekly check.
    const customId = String(b.customId || "");
    let customRow = null;
    if (customId) {
      await ensureCustomTable(db);
      customRow = await db.prepare("SELECT * FROM custom_van_checks WHERE tenant_id=? AND id=? AND username=?").bind(db.tenantId, customId, me).first();
      if (!customRow) return error("Custom check not found.", 404, env, request);
    }
    let week = customId ? customId : mondayOf(b.week && /^\d{4}-\d{2}-\d{2}$/.test(b.week) ? b.week : londonDate());
    const vehicle = String(b.vehicle || sess.user.vehicle_assigned || "").trim();
    if (!vehicle) return error("No vehicle — enter the reg or ask the office to allocate one to you.", 400, env, request);
    // A check done on a POOL vehicle (a tipper — NOT the driver's assigned van) is
    // recorded, but must NOT satisfy the weekly assigned-van requirement. Store it
    // under a distinct key so the weekly grid + mineDue keep showing the driver's
    // OWN van as outstanding until they check it (or it's skipped).
    const assignedVan = String(sess.user.vehicle_assigned || "").trim();
    const normR = r => String(r || "").toUpperCase().replace(/\s+/g, "");
    if (!customId && assignedVan && normR(vehicle) !== normR(assignedVan)) {
      week = "pool:" + week + ":" + normR(vehicle);
    }
    const answers = (b.answers && typeof b.answers === "object") ? b.answers : {};
    // Weekly checks always have a checklist; a custom check might be photos-only,
    // so only require answers when the (custom) template actually has items.
    if (!customId && !Object.keys(answers).length) return error("Complete the checklist first.", 400, env, request);
    const defectNotes = (b.defectNotes && typeof b.defectNotes === "object") ? b.defectNotes : {};

    // Photos. Named slots (oil level, each tyre, cab…) come as
    // photoSlots {slotId: dataURL|existingKey}; extras as photos[]. Each data
    // URL -> R2 (4MB cap), same serving path as assets. Required slots are
    // enforced server-side.
    // For a custom check the items come from its snapshot (no weekly settings /
    // alert users); otherwise the live weekly settings.
    let customItems = null;
    if (customRow) { try { customItems = JSON.parse(customRow.items || "{}"); } catch { customItems = {}; } }
    const s2 = customRow
      ? { checklist: customItems.checklist || [], equipment: customItems.equipment || [], photoSlots: customItems.photoSlots || [], alertUsers: [] }
      : await getSettings(db);
    // Custom check WITH checklist/equipment items still needs its answers.
    if (customRow && ((s2.checklist.length + s2.equipment.length) > 0) && !Object.keys(answers).length)
      return error("Complete the checklist first.", 400, env, request);
    const userDir = me.replace(/[^A-Za-z0-9._-]/g, "_");
    let n = 0;
    async function storeOne(p, tag) {
      if (typeof p === "string" && /^vancheck\//.test(p)) return p;   // already stored (edit/resubmit)
      const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(p || "");
      if (!m) return null;
      const bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
      if (bytes.length > 4 * 1024 * 1024) return null;
      const key = `vancheck/${userDir}/${week}/${tag}-${++n}-${crypto.randomUUID().slice(0, 8)}.${m[1] === "jpeg" ? "jpg" : "png"}`;
      await env.ASSET_BUCKET.put(key, bytes, { httpMetadata: { contentType: `image/${m[1]}` } });
      return key;
    }
    const slotIn = (b.photoSlots && typeof b.photoSlots === "object") ? b.photoSlots : {};
    const slotPhotos = {};
    for (const slot of s2.photoSlots) {
      const key = await storeOne(slotIn[slot.id], slot.id);
      if (key) slotPhotos[slot.id] = key;
    }
    const missing = s2.photoSlots.filter(sl => sl.required !== false && !slotPhotos[sl.id]);
    if (missing.length)
      return error("Missing required photos: " + missing.map(m2 => m2.label).join(", "), 400, env, request);
    const photoKeys = Object.values(slotPhotos);
    for (const p of (Array.isArray(b.photos) ? b.photos : []).slice(0, 6)) {   // extras
      const key = await storeOne(p, "extra");
      if (key) photoKeys.push(key);
    }

    // "Alert if" rules → store fired alerts on the record + push the chosen users.
    const alerts = evalAlerts(answers, s2);
    // Self-describing answer meta {label,tone} + the issue ids, so every viewer
    // can count/label answers (incl. custom-toned ones) without the template.
    const { answerMeta, issues } = answerMetaFor(answers, s2);
    // A custom check carries its own item labels so any viewer can resolve them
    // without the weekly settings, and a `custom` marker so it's tagged/badged.
    const custom = customRow
      ? { id: customRow.id, name: customRow.name, checklist: s2.checklist, equipment: s2.equipment, photoSlots: s2.photoSlots }
      : undefined;
    const items = JSON.stringify({
      answers, defectNotes, photos: photoKeys, slotPhotos,
      mileage: String(b.mileage || "").trim(), source: "portal",
      alerts, answerMeta, issues, ...(custom ? { custom } : {}),
    });
    const now = new Date().toISOString();
    await db.prepare(`
      INSERT INTO vehicle_checks (tenant_id, username, week, vehicle, checked_at, safe_to_drive, items, note)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(username, week) DO UPDATE SET
        vehicle=excluded.vehicle, checked_at=excluded.checked_at,
        safe_to_drive=excluded.safe_to_drive, items=excluded.items, note=excluded.note
    `).bind(db.tenantId, me, week, vehicle, now, b.safeToDrive === false ? 0 : 1, items, String(b.note || "").trim()).run();
    if (customRow) await db.prepare("UPDATE custom_van_checks SET status='done', submitted_at=? WHERE tenant_id=? AND id=?").bind(now, db.tenantId, customRow.id).run();
    if (alerts.length && (s2.alertUsers || []).length) {
      const who = (`${sess.user.first_name || ""} ${sess.user.last_name || ""}`.trim()) || me;
      const body = `${who} — ${vehicle}: ` + alerts.map(a => `${a.label}: ${answerWord(a.answer)}`).join(", ");
      const payload = { title: "⚠ Van check alert", body, url: "/van-checks.html", tag: "vancheck-alert" };
      ctx && ctx.waitUntil && ctx.waitUntil(Promise.all((s2.alertUsers || []).map(u => sendToUser(env, tenantId, u, payload).catch(() => {}))));
    }
    return json({ ok: true, week, photos: photoKeys.length, alerts: alerts.length }, {}, env, request);
  }

  // ── Weekly grid (office) ────────────────────────────────────────────────────
  if (path === "/vancheck/week" && method === "GET") {
    if (!(await canViewAll())) return error("Forbidden", 403, env, request);
    const wk = url.searchParams.get("week");
    const week = mondayOf(wk && /^\d{4}-\d{2}-\d{2}$/.test(wk) ? wk : londonDate());
    const s = await getSettings(db);
    const { results: drivers } = await db.prepare(
      "SELECT username, first_name, last_name, vehicle_assigned FROM users WHERE tenant_id=? AND status='Active' AND vehicle_assigned IS NOT NULL AND vehicle_assigned != ''"
    ).bind(db.tenantId).all();
    const { results: checks } = await db.prepare(
      "SELECT * FROM vehicle_checks WHERE tenant_id=? AND week=?"
    ).bind(db.tenantId, week).all();
    const byUser = {};
    for (const c of checks || []) byUser[c.username] = shapeCheck(c);
    const off = await getOptedOut(env, db.tenantId);           // drivers switched OFF
    const rows = (drivers || []).map(u => ({
      username: u.username,
      name: (`${u.first_name || ""} ${u.last_name || ""}`.trim()) || u.username,
      vehicle: u.vehicle_assigned,
      enabled: !off.has(u.username),
      check: byUser[u.username] || null,
    }));
    // Checks from people without an allocated vehicle still show (e.g. spare van).
    for (const c of checks || []) {
      if (!rows.some(r => r.username === c.username))
        rows.push({ username: c.username, name: c.username, vehicle: c.vehicle || "", enabled: !off.has(c.username), check: shapeCheck(c) });
    }
    const dueAt = deadlineFor(week, s);
    const globallyPaused = isGloballyPaused(await getRules(env, tenantId));
    // Pending one-off van-check REQUESTS (incl. pool-van requests) so the home
    // hub can count them alongside the weekly checks.
    await ensureCustomTable(db);
    const nm = await nameMap(env, db.tenantId);
    const { results: cpRows } = await db.prepare("SELECT username, reg FROM custom_van_checks WHERE tenant_id=? AND status='pending'").bind(db.tenantId).all();
    const customPending = (cpRows || []).map(c => ({ username: c.username, name: nm[c.username] || c.username, reg: c.reg || "" }));
    return json({ ok: true, week, dueAt, overdue: Date.now() > Date.parse(dueAt), settings: s, rows, globallyPaused, customPending }, {}, env, request);
  }

  // ── Compliance matrix: engineer × week (missed weeks), follows the PERSON ────
  // Returns each driver's status per week over a range, keyed by USERNAME (not
  // reg) so a driver's record stays whole even when they change vans. One query
  // over the whole range. Missed = an expected driver with no check that week.
  if (path === "/vancheck/matrix" && method === "GET") {
    if (!(await canViewAll())) return error("Forbidden", 403, env, request);
    const curWeek = mondayOf(londonDate());
    const toRaw = url.searchParams.get("to");
    const fromRaw = url.searchParams.get("from");
    const to = mondayOf(toRaw && /^\d{4}-\d{2}-\d{2}$/.test(toRaw) ? toRaw : curWeek);
    let from = mondayOf(fromRaw && /^\d{4}-\d{2}-\d{2}$/.test(fromRaw) ? fromRaw : addDays(to, -7 * 7)); // default 8 columns
    // Oldest → newest, capped so a huge range can't run away.
    const weeks = [];
    let w = from;
    while (w <= to && weeks.length < 80) { weeks.push(w); w = addDays(w, 7); }
    if (!weeks.length) weeks.push(to);
    from = weeks[0];
    const s = await getSettings(db);
    const off = await getOptedOut(env, db.tenantId);
    const names = await nameMap(env, db.tenantId);
    const { results: drivers } = await db.prepare(
      "SELECT username, first_name, last_name, vehicle_assigned FROM users WHERE tenant_id=? AND status='Active' AND vehicle_assigned IS NOT NULL AND vehicle_assigned != ''"
    ).bind(db.tenantId).all();
    const { results: checks } = await db.prepare(
      "SELECT * FROM vehicle_checks WHERE tenant_id=? AND week>=? AND week<=?"
    ).bind(db.tenantId, from, to).all();
    const rowMap = {};
    for (const u of drivers || []) {
      rowMap[u.username] = {
        username: u.username,
        name: (`${u.first_name || ""} ${u.last_name || ""}`.trim()) || u.username,
        vehicle: u.vehicle_assigned || "",
        expected: !off.has(u.username),
        cells: {},
      };
    }
    const gridStatuses = await getGridStatuses(db);
    const gsByKey = {}; for (const gs of gridStatuses) gsByKey[gs.key] = gs;
    for (const c of checks || []) {
      let r = rowMap[c.username];
      if (!r) r = rowMap[c.username] = { username: c.username, name: names[c.username] || c.username, vehicle: "", expected: false, cells: {} };
      const sc = shapeCheck(c);
      // A manual override (holiday/sick/VOR/…) wins over the raw check state.
      if (sc.override) {
        const gs = gsByKey[sc.override.status] || {};
        r.cells[c.week] = {
          status: "override", key: sc.override.status,
          label: sc.override.label || gs.label || sc.override.status,
          colour: sc.override.colour || gs.colour || "#a5b4fc",
          tone: sc.override.tone || gs.tone || "excused",
          reg: c.vehicle || sc.vehicle || "",
        };
      } else {
        r.cells[c.week] = {
          status: sc.skipped ? "skipped" : ((sc.defectCount > 0 || (sc.alerts && sc.alerts.length) || sc.safeToDrive === false) ? "issue" : "done"),
          reg: c.vehicle || sc.vehicle || "",
          issues: sc.defectCount || 0,
          safe: sc.safeToDrive,
          skipped: !!sc.skipped,
        };
      }
    }
    const rows = Object.values(rowMap).map(r => {
      const cellWeeks = Object.keys(r.cells).sort();
      const earliest = cellWeeks.length ? cellWeeks[0] : null;   // don't flag weeks before this driver's first record in range
      for (const wk of weeks) {
        if (r.cells[wk]) continue;
        r.cells[wk] = (r.expected && wk <= curWeek && (earliest === null || wk >= earliest)) ? { status: "missed" } : { status: "none" };
      }
      // Per-row tallies for the range shown (an override counts by its tone).
      let done = 0, missed = 0, issue = 0, excused = 0;
      for (const wk of weeks) {
        const cell = r.cells[wk], st = cell.status;
        const tone = st === "override" ? cell.tone : st;
        if (tone === "done") done++; else if (tone === "missed") missed++;
        else if (tone === "issue") issue++; else if (tone === "excused" || st === "skipped") excused++;
      }
      return { ...r, done, missed, issue, excused };
    });
    rows.sort((a, b) => (a.expected === b.expected ? a.name.localeCompare(b.name) : (a.expected ? -1 : 1)));
    return json({ ok: true, weeks, currentWeek: curWeek, from, to, rows, statuses: gridStatuses, dueAt: deadlineFor(curWeek, s) }, {}, env, request);
  }

  // ── Admin: fire this week's reminder to everyone still outstanding, NOW ──────
  // On-demand version of the scheduled nudge (no time-gate, no weekly dedupe).
  if (path === "/vancheck/remind-now" && method === "POST") {
    if (!(await canViewAll())) return error("Forbidden", 403, env, request);
    const week = mondayOf(londonDate());
    const r = await remindDrivers(env, tenantId, week, {
      title: "Weekly van check due",
      body: "Please complete your weekly van check — tap to start.",
      url: "/van-check.html", tag: "vehicle-check"
    });
    return json({ ok: true, week, ...r }, {}, env, request);
  }

  // ── Admin: skip a driver's van check for a week (logged in the grid) ────────
  if (path === "/vancheck/skip" && method === "POST") {
    if (!(await canViewAll())) return error("Forbidden", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const who = String(b.username || "").trim();
    if (!who) return error("username required", 400, env, request);
    const wk = mondayOf(/^\d{4}-\d{2}-\d{2}$/.test(b.week || "") ? b.week : londonDate());
    // Never overwrite a real completed check.
    const existing = await db.prepare("SELECT items FROM vehicle_checks WHERE tenant_id=? AND username=? AND week=?")
      .bind(db.tenantId, who, wk).first();
    if (existing) {
      let it = {}; try { it = existing.items ? JSON.parse(existing.items) : {}; } catch {}
      if (!it.skipped) return json({ ok: true, already: true }, {}, env, request);
    }
    const veh = await db.prepare("SELECT vehicle_assigned FROM users WHERE tenant_id=? AND username=?")
      .bind(db.tenantId, who).first();
    const now = new Date().toISOString();
    const items = JSON.stringify({ skipped: true, skippedBy: me, skippedAt: now, source: "skip" });
    await db.prepare(`
      INSERT INTO vehicle_checks (tenant_id, username, week, vehicle, checked_at, safe_to_drive, items, note)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(username, week) DO UPDATE SET checked_at=excluded.checked_at, items=excluded.items, note=excluded.note
    `).bind(db.tenantId, who, wk, (veh && veh.vehicle_assigned) || "", now, null, items, "Skipped by " + me).run();
    return json({ ok: true, week: wk, skippedBy: me }, {}, env, request);
  }

  // ── Admin: undo a skip (van check becomes due again) ────────────────────────
  if (path === "/vancheck/unskip" && method === "POST") {
    if (!(await canViewAll())) return error("Forbidden", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const who = String(b.username || "").trim();
    if (!who) return error("username required", 400, env, request);
    const wk = mondayOf(/^\d{4}-\d{2}-\d{2}$/.test(b.week || "") ? b.week : londonDate());
    const existing = await db.prepare("SELECT items FROM vehicle_checks WHERE tenant_id=? AND username=? AND week=?")
      .bind(db.tenantId, who, wk).first();
    if (!existing) return json({ ok: true, notSkipped: true }, {}, env, request);
    let it = {}; try { it = existing.items ? JSON.parse(existing.items) : {}; } catch {}
    if (!it.skipped) return json({ ok: false, error: "That is a real check, not a skip." }, {}, env, request);
    await db.prepare("DELETE FROM vehicle_checks WHERE tenant_id=? AND username=? AND week=?").bind(db.tenantId, who, wk).run();
    return json({ ok: true, week: wk }, {}, env, request);
  }

  // ── FULL-ACCESS ONLY: the configurable grid override statuses ───────────────
  if (path === "/vancheck/grid-statuses" && method === "GET") {
    if (!(await canViewAll())) return error("Forbidden", 403, env, request);
    return json({ ok: true, statuses: await getGridStatuses(db) }, {}, env, request);
  }
  if (path === "/vancheck/grid-statuses" && method === "POST") {
    if (!(await isAdmin())) return error("Full Access only.", 403, env, request);
    const b = await request.json().catch(() => ({}));
    await saveGridStatuses(db, Array.isArray(b.statuses) ? b.statuses : []);
    return json({ ok: true, statuses: await getGridStatuses(db) }, {}, env, request);
  }

  // ── FULL-ACCESS ONLY: set a grid cell from the by-engineer matrix ───────────
  // action "set" (+ status key) marks a week with a configured override
  // (Not required / holiday / sick / VOR / completed-on-paper…); "clear" removes
  // it (week becomes due again). Legacy "skip"/"unskip" still work.
  // Deliberately stricter than /vancheck/skip (which allows any Vehicles admin).
  if (path === "/vancheck/grid-set" && method === "POST") {
    if (!(await isAdmin())) return error("Full Access only.", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const who = String(b.username || "").trim();
    let action = String(b.action || "");
    if (!who) return error("username required", 400, env, request);
    const wk = mondayOf(/^\d{4}-\d{2}-\d{2}$/.test(b.week || "") ? b.week : londonDate());
    const existing = await db.prepare("SELECT items FROM vehicle_checks WHERE tenant_id=? AND username=? AND week=?")
      .bind(db.tenantId, who, wk).first();
    let it = {}; if (existing) { try { it = existing.items ? JSON.parse(existing.items) : {}; } catch {} }
    const isManual = existing ? (!!it.skipped || !!it.override) : false;
    // "skip" is the legacy alias for setting the "skipped" status.
    if (action === "skip") { action = "set"; b.status = b.status || "skipped"; }
    if (action === "unskip") action = "clear";
    if (action === "set") {
      // Never overwrite a real completed check.
      if (existing && !isManual) return json({ ok: false, error: "That week has a real check — open it instead." }, {}, env, request);
      const statuses = await getGridStatuses(db);
      const gs = statuses.find(s => s.key === String(b.status || "")) || statuses.find(s => s.key === "skipped") || DEFAULT_GRID_STATUSES[0];
      const veh = await db.prepare("SELECT vehicle_assigned FROM users WHERE tenant_id=? AND username=?").bind(db.tenantId, who).first();
      const now = new Date().toISOString();
      const items = JSON.stringify({
        override: true, status: gs.key, label: gs.label, tone: gs.tone, colour: gs.colour,
        by: me, at: now, source: "override",
        // Keep the legacy flags so old readers still treat every override as a skip.
        skipped: true, skippedBy: me, skippedAt: now,
      });
      await db.prepare(`
        INSERT INTO vehicle_checks (tenant_id, username, week, vehicle, checked_at, safe_to_drive, items, note)
        VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(username, week) DO UPDATE SET checked_at=excluded.checked_at, items=excluded.items, note=excluded.note
      `).bind(db.tenantId, who, wk, (veh && veh.vehicle_assigned) || "", now, null, items, gs.label + " (by " + me + ")").run();
      return json({ ok: true, week: wk, status: "override", key: gs.key, label: gs.label, colour: gs.colour, tone: gs.tone }, {}, env, request);
    }
    if (action === "clear") {
      if (!existing) return json({ ok: true, week: wk, status: "none" }, {}, env, request);
      if (!isManual) return json({ ok: false, error: "That is a real check, not a manual entry." }, {}, env, request);
      await db.prepare("DELETE FROM vehicle_checks WHERE tenant_id=? AND username=? AND week=?").bind(db.tenantId, who, wk).run();
      return json({ ok: true, week: wk, status: "none" }, {}, env, request);
    }
    return error("Unknown action", 400, env, request);
  }

  // ── Admin: turn a driver's weekly van check ON/OFF ──────────────────────────
  // OFF = not required, no reminders, no blocking home gate; they can still
  // submit a check if they want. Stored as an opt-out list in app_config.
  if (path === "/vancheck/driver-toggle" && method === "POST") {
    if (!(await canViewAll())) return error("Forbidden", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const who = String(b.username || "").trim();
    if (!who) return error("username required", 400, env, request);
    const off = await getOptedOut(env, db.tenantId);
    if (b.enabled === false) off.add(who); else off.delete(who);
    await db.prepare("INSERT INTO app_config (tenant_id, key, value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(db.tenantId, OPTOUT_KEY, JSON.stringify([...off])).run();
    return json({ ok: true, username: who, enabled: b.enabled !== false }, {}, env, request);
  }

  // ── Admin: pause / resume ALL van-check reminders (the blunt "bypass") ───────
  // Adds or removes the global vehicle-check suppression rule — the same one the
  // notification centre sets — surfaced here so it's controllable in one place.
  if (path === "/vancheck/pause-all" && method === "POST") {
    if (!(await canViewAll())) return error("Forbidden", 403, env, request);
    const b = await request.json().catch(() => ({}));
    let rules = await getRules(env, tenantId);
    rules = rules.filter(r => !(r.type === "vehicle-check" && (r.user == null || r.user === "") && (r.key == null || r.key === "")));
    if (b.paused === true) rules.push({ type: "vehicle-check" });   // global (no user/key)
    await saveRules(env, tenantId, rules);
    return json({ ok: true, paused: b.paused === true }, {}, env, request);
  }

  // ── Attention (badges + gate) ───────────────────────────────────────────────
  if (path === "/vancheck/attention" && method === "GET") {
    const s = await getSettings(db);
    const week = mondayOf(londonDate());
    const dueAt = deadlineFor(week, s);
    const overdue = Date.now() > Date.parse(dueAt);
    const myVehicle = sess.user.vehicle_assigned || "";
    const off = await getOptedOut(env, db.tenantId);
    let mineDue = false;
    if (myVehicle && !off.has(me)) {
      const mine = await db.prepare("SELECT week FROM vehicle_checks WHERE tenant_id=? AND username=? AND week=?")
        .bind(db.tenantId, me, week).first();
      mineDue = !mine;
    }
    // An admin can mute a person's van-check reminder (this week's key, all weeks
    // for the user, or globally) via the notification centre.
    if (mineDue) {
      const rules = await getRules(env, tenantId);
      if (isSuppressed(rules, "vehicle-check", me, week)) mineDue = false;
    }
    let missing = [];
    const p = await permissionsFor(env, tenantId, me);
    if (p.FullAccess === "Yes") {
      const { results: drivers } = await db.prepare(
        "SELECT username, first_name, last_name FROM users WHERE tenant_id=? AND status='Active' AND vehicle_assigned IS NOT NULL AND vehicle_assigned != ''"
      ).bind(db.tenantId).all();
      const { results: done } = await db.prepare(
        "SELECT username FROM vehicle_checks WHERE tenant_id=? AND week=?"
      ).bind(db.tenantId, week).all();
      const doneSet = new Set((done || []).map(r => r.username));
      missing = (drivers || []).filter(u => !doneSet.has(u.username) && !off.has(u.username))
        .map(u => (`${u.first_name || ""} ${u.last_name || ""}`.trim()) || u.username);
    }
    await ensureCustomTable(db);
    const { results: crows } = await db.prepare("SELECT id, name, reg, due_at, snooze FROM custom_van_checks WHERE tenant_id=? AND username=? AND status='pending' ORDER BY sent_at DESC").bind(db.tenantId, me).all();
    const customChecks = (crows || []).map(r => ({
      id: r.id, name: r.name || "Van check", reg: r.reg || "",
      dueAt: r.due_at || null,
      overdue: r.due_at ? Date.now() > Date.parse(r.due_at) : false,
      snooze: r.snooze == null ? true : !!Number(r.snooze),
    }));
    return json({ ok: true, week, dueAt, overdue, mineDue, vehicle: myVehicle, missing, customPending: customChecks.length, customChecks }, {}, env, request);
  }

  return error("Unknown van-check route", 404, env, request);
}

// ── Scheduled van-check reminders (called from the worker's cron handler) ─────
// Two nudges per week, each to drivers who still owe THIS week's check:
//   1. a fixed "start of week" reminder — Monday 07:00 UK;
//   2. a dynamic chase — within 2 hours BEFORE the week's deadline (the "due by"
//      day/time set in the portal), never after it (already missed by then).
// Meant to run off an HOURLY cron ("0 * * * *"); each slot self-gates on London
// time and is deduped per week, so a retried/extra cron can't double-notify.
// `now` is injectable for testing. Honours admin skips (they write a check row)
// and mute rules (notification-centre "vehicle-check" suppression).
const CHASE_LEAD_MS = 2 * 60 * 60 * 1000;   // send the chase up to 2h before the deadline

async function readVanSettings(env, tid) {
  try { const row = await env.DB.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(tid, SETTINGS_KEY).first(); return row ? (JSON.parse(row.value) || {}) : {}; }
  catch { return {}; }
}

// Push `payload` to every driver (Active + vehicle allocated) who still owes the
// given week's check — skipping those who've done it, been skipped (both write a
// vehicle_checks row) or been muted. Shared by the cron and the on-demand button.
async function remindDrivers(env, tid, week, payload) {
  const { results: drivers } = await env.DB.prepare(
    "SELECT username FROM users WHERE tenant_id=? AND status='Active' AND vehicle_assigned IS NOT NULL AND vehicle_assigned!=''"
  ).bind(tid).all();
  const { results: checks } = await env.DB.prepare(
    "SELECT username FROM vehicle_checks WHERE tenant_id=? AND week=?"
  ).bind(tid, week).all();
  const handled = new Set((checks || []).map(c => c.username));
  const off = await getOptedOut(env, tid);
  const rules = await getRules(env, tid);
  const recipients = [];
  for (const drv of drivers || []) {
    if (handled.has(drv.username)) continue;
    if (off.has(drv.username)) continue;                       // driver switched off
    if (isSuppressed(rules, "vehicle-check", drv.username, week)) continue;
    await sendToUser(env, tid, drv.username, payload);
    recipients.push(drv.username);
  }
  return { reminded: recipients.length, recipients };
}

export async function sendWeeklyReminders(env, now = new Date()) {
  const d = new Date(now);
  const nowMs = d.getTime();
  const lonDate = londonDate(d);                              // YYYY-MM-DD (London)
  const lonHour = Number(d.toLocaleString("en-GB", { timeZone: "Europe/London", hour: "2-digit", hour12: false }).replace(/\D/g, "")) || 0;
  const lonDow = d.toLocaleDateString("en-GB", { timeZone: "Europe/London", weekday: "short" }); // "Mon"…
  const week = mondayOf(lonDate);
  const isMonday7 = lonDow === "Mon" && lonHour === 7;

  let tenants = [];
  try {
    const r = await env.DB.prepare(
      "SELECT DISTINCT tenant_id FROM users WHERE status='Active' AND vehicle_assigned IS NOT NULL AND vehicle_assigned!=''"
    ).all();
    tenants = (r.results || []).map(t => t.tenant_id);
  } catch { return { ran: false, reason: "no-users" }; }

  const DOWNUM = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  const lonDowNum = DOWNUM[lonDow] || 0;
  const lonHM = londonHM(nowMs);   // "HH:MM" London

  const out = [];
  for (const tid of tenants) {
    const settings = await readVanSettings(env, tid);
    const reminders = Array.isArray(settings.reminders) ? settings.reminders : [];

    // Per-week dedupe slots.
    const mkey = `vancheck:reminded:${tid}`;
    let slots = [];
    try { const row = await env.DB.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(tid, mkey).first(); if (row && row.value) slots = JSON.parse(row.value) || []; } catch {}

    let payload = null, slotKey = "", reason = "";
    if (reminders.length) {
      // Custom schedule: fire the first configured slot that's due today and not
      // yet sent this week (fires at or after its time, at the next hourly tick).
      for (const rem of reminders) {
        if (rem.dow !== lonDowNum || lonHM < rem.time) continue;
        const key = `rem:${rem.dow}:${rem.time}:${week}`;
        if (slots.includes(key)) continue;
        slotKey = key; reason = "scheduled"; break;
      }
      if (slotKey) payload = { title: "Weekly van check due", body: "Please complete your weekly van check — tap to start.", url: "/van-check.html", tag: "vehicle-check" };
    } else {
      // Default schedule: Monday 07:00 + a chase within 2h before the deadline.
      const deadlineMs = Date.parse(deadlineFor(week, settings));
      const withinChase = nowMs < deadlineMs && (deadlineMs - nowMs) <= CHASE_LEAD_MS;
      const mondayDue = isMonday7 && !slots.includes(`mon:${week}`);
      const chaseDue = withinChase && !slots.includes(`chase:${week}`);
      if (mondayDue || chaseDue) {
        const dueBy = londonHM(deadlineMs);
        payload = chaseDue
          ? { title: "Van check due soon", body: `Last reminder — your weekly van check is due by ${dueBy} today. Tap to complete it.`, url: "/van-check.html", tag: "vehicle-check" }
          : { title: "Weekly van check due", body: "Please complete your weekly van check — tap to start.", url: "/van-check.html", tag: "vehicle-check" };
        slotKey = chaseDue ? `chase:${week}` : `mon:${week}`;
        reason = chaseDue ? "chase" : "monday";
      }
    }
    if (!payload) { out.push({ tid, skipped: true }); continue; }

    const { reminded } = await remindDrivers(env, tid, week, payload);
    slots.push(slotKey);
    slots = slots.slice(-40);
    await env.DB.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(tid, mkey, JSON.stringify(slots)).run();
    out.push({ tid, reminded, reason });
  }
  return { ran: true, week, tenants: out };
}
