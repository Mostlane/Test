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
const DEFAULT_SETTINGS = { dueDow: 5, dueTime: "17:00", checklist: DEFAULT_CHECKLIST }; // Friday 17:00 UK

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
    photos: items.photos || [], mileage: items.mileage || "", source: items.source || "story",
    defectCount: defects.length,
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

    // Photos: data URLs -> R2 (max 8, 4MB each), same serving path as assets.
    const photoKeys = [];
    for (const p of (Array.isArray(b.photos) ? b.photos : []).slice(0, 8)) {
      if (typeof p === "string" && /^vancheck\//.test(p)) { photoKeys.push(p); continue; }  // already-stored key (edit/resubmit)
      const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(p || "");
      if (!m) continue;
      const bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
      if (bytes.length > 4 * 1024 * 1024) continue;
      const key = `vancheck/${me.replace(/[^A-Za-z0-9._-]/g, "_")}/${week}/${photoKeys.length + 1}-${crypto.randomUUID().slice(0, 8)}.${m[1] === "jpeg" ? "jpg" : "png"}`;
      await env.ASSET_BUCKET.put(key, bytes, { httpMetadata: { contentType: `image/${m[1]}` } });
      photoKeys.push(key);
    }

    const items = JSON.stringify({
      answers, defectNotes, photos: photoKeys,
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
