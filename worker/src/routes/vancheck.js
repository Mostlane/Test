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
import { getRules, isSuppressed } from "../lib/suppress.js";

const SETTINGS_KEY = "vancheck:settings";
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
const DEFAULT_SETTINGS = { dueDow: 5, dueTime: "17:00", checklist: DEFAULT_CHECKLIST, photoSlots: DEFAULT_PHOTO_SLOTS }; // Friday 17:00 UK

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
  return out;
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
  const defects = Object.keys(answers).filter(k => answers[k] === "defect");
  return {
    username: r.username, week: r.week, vehicle: r.vehicle, checkedAt: r.checked_at,
    safeToDrive: r.safe_to_drive === null ? null : !!Number(r.safe_to_drive),
    note: r.note || "", answers, defectNotes: items.defectNotes || {},
    photos: items.photos || [], slotPhotos: items.slotPhotos || {},
    mileage: items.mileage || "", source: items.source || "story",
    defectCount: defects.length,
    skipped: !!items.skipped, skippedBy: items.skippedBy || "",
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
      const list = b.checklist
        .map(i => ({ id: String(i.id || "").trim() || String(i.label || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 30), label: String(i.label || "").trim() }))
        .filter(i => i.label);
      if (list.length) s.checklist = list;
    }
    if (Array.isArray(b.photoSlots)) {
      const slots = b.photoSlots
        .map(i => ({ id: String(i.id || "").trim() || String(i.label || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 30), label: String(i.label || "").trim(), required: i.required !== false }))
        .filter(i => i.label);
      if (slots.length) s.photoSlots = slots;
    }
    await db.prepare("INSERT INTO app_config (tenant_id, key, value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(db.tenantId, SETTINGS_KEY, JSON.stringify(s)).run();
    return json({ ok: true, settings: s }, {}, env, request);
  }

  // ── My config (drives the form + prefill) ───────────────────────────────────
  if (path === "/vancheck/config" && method === "GET") {
    const s = await getSettings(db);
    const week = mondayOf(londonDate());
    const mine = await db.prepare("SELECT * FROM vehicle_checks WHERE tenant_id=? AND username=? AND week=?")
      .bind(db.tenantId, me, week).first();
    const dueAt = deadlineFor(week, s);
    return json({
      ok: true, week, vehicle: sess.user.vehicle_assigned || "",
      deadline: { dow: s.dueDow, time: s.dueTime, dueAt, overdue: Date.now() > Date.parse(dueAt) },
      checklist: s.checklist,
      photoSlots: s.photoSlots,
      myCheck: shapeCheck(mine),
    }, {}, env, request);
  }

  // ── Submit my check ─────────────────────────────────────────────────────────
  if (path === "/vancheck/submit" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const week = mondayOf(b.week && /^\d{4}-\d{2}-\d{2}$/.test(b.week) ? b.week : londonDate());
    const vehicle = String(b.vehicle || sess.user.vehicle_assigned || "").trim();
    if (!vehicle) return error("No vehicle — enter the reg or ask the office to allocate one to you.", 400, env, request);
    const answers = (b.answers && typeof b.answers === "object") ? b.answers : {};
    if (!Object.keys(answers).length) return error("Complete the checklist first.", 400, env, request);
    const defectNotes = (b.defectNotes && typeof b.defectNotes === "object") ? b.defectNotes : {};

    // Photos. Named slots (oil level, each tyre, cab…) come as
    // photoSlots {slotId: dataURL|existingKey}; extras as photos[]. Each data
    // URL -> R2 (4MB cap), same serving path as assets. Required slots are
    // enforced server-side.
    const s2 = await getSettings(db);
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

    const items = JSON.stringify({
      answers, defectNotes, photos: photoKeys, slotPhotos,
      mileage: String(b.mileage || "").trim(), source: "portal",
    });
    const now = new Date().toISOString();
    await db.prepare(`
      INSERT INTO vehicle_checks (tenant_id, username, week, vehicle, checked_at, safe_to_drive, items, note)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(username, week) DO UPDATE SET
        vehicle=excluded.vehicle, checked_at=excluded.checked_at,
        safe_to_drive=excluded.safe_to_drive, items=excluded.items, note=excluded.note
    `).bind(db.tenantId, me, week, vehicle, now, b.safeToDrive === false ? 0 : 1, items, String(b.note || "").trim()).run();
    return json({ ok: true, week, photos: photoKeys.length }, {}, env, request);
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
    const rows = (drivers || []).map(u => ({
      username: u.username,
      name: (`${u.first_name || ""} ${u.last_name || ""}`.trim()) || u.username,
      vehicle: u.vehicle_assigned,
      check: byUser[u.username] || null,
    }));
    // Checks from people without an allocated vehicle still show (e.g. spare van).
    for (const c of checks || []) {
      if (!rows.some(r => r.username === c.username))
        rows.push({ username: c.username, name: c.username, vehicle: c.vehicle || "", check: shapeCheck(c) });
    }
    const dueAt = deadlineFor(week, s);
    return json({ ok: true, week, dueAt, overdue: Date.now() > Date.parse(dueAt), settings: s, rows }, {}, env, request);
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

  // ── Attention (badges + gate) ───────────────────────────────────────────────
  if (path === "/vancheck/attention" && method === "GET") {
    const s = await getSettings(db);
    const week = mondayOf(londonDate());
    const dueAt = deadlineFor(week, s);
    const overdue = Date.now() > Date.parse(dueAt);
    const myVehicle = sess.user.vehicle_assigned || "";
    let mineDue = false;
    if (myVehicle) {
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
      missing = (drivers || []).filter(u => !doneSet.has(u.username))
        .map(u => (`${u.first_name || ""} ${u.last_name || ""}`.trim()) || u.username);
    }
    return json({ ok: true, week, dueAt, overdue, mineDue, vehicle: myVehicle, missing }, {}, env, request);
  }

  return error("Unknown van-check route", 404, env, request);
}
