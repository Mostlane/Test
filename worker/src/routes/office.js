// Office clock in/out — a desktop-only daily timer for office staff.
//   GET  /office/config?device=<id>  -> { enabled, open, todayClosedSeconds, ... }
//   POST /office/clock-in  { deviceId }   -> opens a segment (one open at a time)
//   POST /office/clock-out { deviceId }   -> closes the open segment
//   GET  /office/timesheet?week=<Mon>     -> weekly master timesheet (FullAccess)
//
// Each clock-in→clock-out pair is one row in office_shifts, so a person can
// break for lunch and back without losing the day's total (sum of segments).
// The clock only shows on devices an admin has flagged as office machines
// (devices.office_clock = 1) for a user who holds the OfficeClock permission.

import { json, error } from "../lib/http.js";
import { requireSession, permissionsFor } from "../lib/auth.js";

// Local calendar day in the UK, regardless of the server's UTC clock.
function londonDate(d = new Date()) {
  return d.toLocaleDateString("en-CA", { timeZone: "Europe/London" }); // yyyy-mm-dd
}
function secondsBetween(a, b) {
  return Math.max(0, Math.floor((Date.parse(b) - Date.parse(a)) / 1000));
}

async function hasOfficePerm(env, username) {
  const row = await env.DB.prepare(
    "SELECT value FROM user_permissions WHERE username=? AND permission='OfficeClock'"
  ).bind(username).first();
  return !!(row && Number(row.value) === 1);
}
// Is THIS device flagged as an office-clock machine for THIS user?
async function deviceEnabled(env, username, deviceId) {
  if (!deviceId) return false;
  const dev = await env.DB.prepare(
    "SELECT office_clock FROM devices WHERE device_id=? AND username=?"
  ).bind(deviceId, username).first();
  return !!(dev && Number(dev.office_clock) === 1);
}
async function openSegment(env, username) {
  return env.DB.prepare(
    "SELECT id, date, clock_in FROM office_shifts WHERE username=? AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1"
  ).bind(username).first();
}

export async function handle(request, env, ctx, url) {
  const path = url.pathname;
  const sess = await requireSession(env, request);
  if (!sess) return error("Not authenticated", 401, env, request);
  const me = sess.user.username;

  // ── GET /office/config ────────────────────────────────────────────────────
  if (path === "/office/config" && request.method === "GET") {
    const deviceId = url.searchParams.get("device") || sess.session.device_id || "";
    const perm = await hasOfficePerm(env, me);
    const enabled = perm && await deviceEnabled(env, me, deviceId);
    const today = londonDate();
    const open = await openSegment(env, me);
    const closed = await env.DB.prepare(
      "SELECT clock_in, clock_out FROM office_shifts WHERE username=? AND date=? AND clock_out IS NOT NULL"
    ).bind(me, today).all();
    let todayClosedSeconds = 0;
    for (const r of closed.results || []) todayClosedSeconds += secondsBetween(r.clock_in, r.clock_out);
    return json({
      ok: true,
      enabled: !!enabled,
      hasPermission: perm,
      today,
      open: open ? { id: open.id, date: open.date, clockIn: open.clock_in, stale: open.date !== today } : null,
      todayClosedSeconds,
    }, {}, env, request);
  }

  // ── POST /office/clock-in ─────────────────────────────────────────────────
  if (path === "/office/clock-in" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    const deviceId = b.deviceId || sess.session.device_id || "";
    if (!(await hasOfficePerm(env, me)))
      return error("Office clock isn't enabled for your account.", 403, env, request);
    if (!(await deviceEnabled(env, me, deviceId)))
      return error("This device isn't set up for the office clock.", 403, env, request);
    // Enforce a single running segment — return the existing one if already on.
    const open = await openSegment(env, me);
    if (open) return json({ ok: true, already: true, open: { id: open.id, date: open.date, clockIn: open.clock_in } }, {}, env, request);
    const now = new Date();
    const iso = now.toISOString();
    const date = londonDate(now);
    const res = await env.DB.prepare(
      "INSERT INTO office_shifts (username, date, clock_in, device_id, updated_at) VALUES (?,?,?,?,?)"
    ).bind(me, date, iso, deviceId, iso).run();
    const id = res.meta ? res.meta.last_row_id : undefined;
    return json({ ok: true, open: { id, date, clockIn: iso } }, {}, env, request);
  }

  // ── POST /office/clock-out ────────────────────────────────────────────────
  if (path === "/office/clock-out" && request.method === "POST") {
    const open = await openSegment(env, me);
    if (!open) return json({ ok: true, closed: false }, {}, env, request);
    const iso = new Date().toISOString();
    await env.DB.prepare("UPDATE office_shifts SET clock_out=?, updated_at=? WHERE id=?")
      .bind(iso, iso, open.id).run();
    return json({ ok: true, closed: true, seconds: secondsBetween(open.clock_in, iso), date: open.date }, {}, env, request);
  }

  // ── GET /office/timesheet?week=YYYY-MM-DD (Monday) — FullAccess only ───────
  if (path === "/office/timesheet" && request.method === "GET") {
    const perms = await permissionsFor(env, me);
    if (perms.FullAccess !== "Yes") return error("Forbidden", 403, env, request);
    let week = url.searchParams.get("week") || "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) week = londonDate();
    const monday = mondayOf(week);
    const days = weekDays(monday);
    const sunday = days[6];

    const { results } = await env.DB.prepare(
      "SELECT username, date, clock_in, clock_out FROM office_shifts WHERE date >= ? AND date <= ? ORDER BY username, clock_in"
    ).bind(monday, sunday).all();
    const { results: permUsers } = await env.DB.prepare(
      "SELECT username FROM user_permissions WHERE permission='OfficeClock' AND value=1"
    ).all();
    const { results: userRows } = await env.DB.prepare(
      "SELECT username, first_name, last_name FROM users"
    ).all();
    const nameOf = {};
    for (const u of userRows || []) nameOf[u.username] = `${u.first_name || ""} ${u.last_name || ""}`.trim() || u.username;

    const map = {};
    const ensure = u => (map[u] || (map[u] = { username: u, name: nameOf[u] || u, days: {}, total: 0, open: false }));
    for (const u of permUsers || []) ensure(u.username);
    for (const r of results || []) {
      const e = ensure(r.username);
      if (r.clock_out) {
        const sec = secondsBetween(r.clock_in, r.clock_out);
        e.days[r.date] = (e.days[r.date] || 0) + sec;
        e.total += sec;
      } else {
        e.open = true;                 // still clocked in — flagged, not counted
      }
    }
    const users = Object.values(map).sort((a, b) => a.name.localeCompare(b.name));
    return json({ ok: true, monday, sunday, days, users }, {}, env, request);
  }

  return error("Unknown office route", 404, env, request);
}

// Monday (yyyy-mm-dd) of the ISO week containing dateStr. Parsed at UTC noon so
// the day never slips across a timezone boundary.
function mondayOf(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7;      // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}
function weekDays(monday) {
  const base = new Date(monday + "T12:00:00Z");
  const out = [];
  for (let i = 0; i < 7; i++) {
    const x = new Date(base);
    x.setUTCDate(base.getUTCDate() + i);
    out.push(x.toISOString().slice(0, 10));
  }
  return out;
}
