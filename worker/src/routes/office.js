// Office clock in/out — a desktop-only daily timer for office staff.
//   GET  /office/config?device=<id>  -> { enabled, open, todayClosedSeconds }
//   POST /office/clock-in  { deviceId }   -> opens a segment (one open at a time)
//   POST /office/clock-out { deviceId }   -> closes the open segment
//   GET  /office/my?week=<Mon>            -> the caller's own week (detailed)
//   GET  /office/user-week?u=&week=       -> a user's week (admin, for editing)
//   POST /office/segment                  -> edit/void/reset a segment (admin)
//   GET  /office/timesheet?week=<Mon>     -> weekly master timesheet (admin)
//
// Each clock-in→clock-out pair is one row in office_shifts, so a person can
// break for lunch and back without losing the day's total (sum of segments).
//
// Admin edits never overwrite the captured times: clock_in/clock_out stay as
// the auto-recorded originals, and edited_in/edited_out hold the admin's
// override. The "effective" time is the edit if present, else the original —
// and ALL totals use effective times. A voided segment counts as zero.

import { json, error } from "../lib/http.js";
import { requireSession, permissionsFor } from "../lib/auth.js";

// Local calendar day in the UK, regardless of the server's UTC clock.
function londonDate(d = new Date()) {
  return d.toLocaleDateString("en-CA", { timeZone: "Europe/London" }); // yyyy-mm-dd
}
function secondsBetween(a, b) {
  return Math.max(0, Math.floor((Date.parse(b) - Date.parse(a)) / 1000));
}
const isDateStr = s => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
function toIso(v) { if (!v) return null; const t = Date.parse(v); return isNaN(t) ? null : new Date(t).toISOString(); }

// ── Effective (edit-aware) helpers ──────────────────────────────────────────
function effIn(r) { return r.edited_in || r.clock_in; }
function effOut(r) { return r.edited_out || r.clock_out || null; }
function isVoided(r) { return Number(r.voided) === 1; }
function isOpenRow(r) { return !isVoided(r) && !effOut(r); }
function segSeconds(r) { if (isVoided(r)) return 0; const o = effOut(r); return o ? secondsBetween(effIn(r), o) : 0; }
function shapeSeg(r) {
  return {
    id: r.id,
    in: effIn(r), out: effOut(r),
    originalIn: r.clock_in, originalOut: r.clock_out || null,
    editedIn: r.edited_in || null, editedOut: r.edited_out || null,
    edited: !!(r.edited_in || r.edited_out),
    voided: isVoided(r),
    editedBy: r.edited_by || null, editedAt: r.edited_at || null, note: r.edit_note || null,
    seconds: segSeconds(r),
    open: isOpenRow(r),
  };
}

async function hasOfficePerm(env, username) {
  const row = await env.DB.prepare(
    "SELECT value FROM user_permissions WHERE username=? AND permission='OfficeClock'"
  ).bind(username).first();
  return !!(row && Number(row.value) === 1);
}
async function deviceEnabled(env, username, deviceId) {
  if (!deviceId) return false;
  const dev = await env.DB.prepare(
    "SELECT office_clock FROM devices WHERE device_id=? AND username=?"
  ).bind(deviceId, username).first();
  return !!(dev && Number(dev.office_clock) === 1);
}
async function isTimesheetAdmin(env, username) {
  const p = await permissionsFor(env, username);
  return p.FullAccess === "Yes" || p.OfficeTimesheet === "Yes";
}
// Most recent segment with no effective clock-out and not voided.
async function openSegmentRow(env, username) {
  return env.DB.prepare(
    "SELECT * FROM office_shifts WHERE username=? AND clock_out IS NULL AND edited_out IS NULL AND (voided IS NULL OR voided=0) ORDER BY clock_in DESC LIMIT 1"
  ).bind(username).first();
}

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

// One user's week: per-day segments (with original + effective + edit flags).
async function weekDetail(env, username, week) {
  const monday = mondayOf(isDateStr(week) ? week : londonDate());
  const days = weekDays(monday);
  const sunday = days[6];
  const { results } = await env.DB.prepare(
    "SELECT * FROM office_shifts WHERE username=? AND date>=? AND date<=? ORDER BY clock_in"
  ).bind(username, monday, sunday).all();
  const byDay = {};
  for (const d of days) byDay[d] = { date: d, seconds: 0, open: false, segments: [] };
  let weekTotal = 0;
  for (const r of results || []) {
    const day = byDay[r.date] || (byDay[r.date] = { date: r.date, seconds: 0, open: false, segments: [] });
    const seg = shapeSeg(r);
    day.segments.push(seg);
    day.seconds += seg.seconds; weekTotal += seg.seconds;
    if (seg.open) day.open = true;
  }
  return { monday, sunday, days, byDay, weekTotal };
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
    const open = await openSegmentRow(env, me);
    const { results } = await env.DB.prepare(
      "SELECT * FROM office_shifts WHERE username=? AND date=?"
    ).bind(me, today).all();
    let todayClosedSeconds = 0;
    for (const r of results || []) if (!isOpenRow(r)) todayClosedSeconds += segSeconds(r);
    return json({
      ok: true, enabled: !!enabled, hasPermission: perm, today,
      open: open ? { id: open.id, date: open.date, clockIn: effIn(open), stale: open.date !== today } : null,
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
    const open = await openSegmentRow(env, me);
    if (open) return json({ ok: true, already: true, open: { id: open.id, date: open.date, clockIn: effIn(open) } }, {}, env, request);
    const now = new Date();
    const iso = now.toISOString();
    const date = londonDate(now);
    const res = await env.DB.prepare(
      "INSERT INTO office_shifts (username, date, clock_in, device_id, updated_at) VALUES (?,?,?,?,?)"
    ).bind(me, date, iso, deviceId, iso).run();
    return json({ ok: true, open: { id: res.meta ? res.meta.last_row_id : undefined, date, clockIn: iso } }, {}, env, request);
  }

  // ── POST /office/clock-out ────────────────────────────────────────────────
  if (path === "/office/clock-out" && request.method === "POST") {
    const open = await openSegmentRow(env, me);
    if (!open) return json({ ok: true, closed: false }, {}, env, request);
    const iso = new Date().toISOString();
    await env.DB.prepare("UPDATE office_shifts SET clock_out=?, updated_at=? WHERE id=?")
      .bind(iso, iso, open.id).run();
    return json({ ok: true, closed: true, seconds: secondsBetween(effIn(open), iso), date: open.date }, {}, env, request);
  }

  // ── GET /office/my — the caller's OWN week ────────────────────────────────
  if (path === "/office/my" && request.method === "GET") {
    const detail = await weekDetail(env, me, url.searchParams.get("week") || "");
    return json({ ok: true, ...detail }, {}, env, request);
  }

  // ── GET /office/user-week?u= — a user's week (admin, for editing) ─────────
  if (path === "/office/user-week" && request.method === "GET") {
    if (!(await isTimesheetAdmin(env, me))) return error("Forbidden", 403, env, request);
    const u = url.searchParams.get("u");
    if (!u) return error("Missing ?u=", 400, env, request);
    const detail = await weekDetail(env, u, url.searchParams.get("week") || "");
    const row = await env.DB.prepare("SELECT first_name, last_name FROM users WHERE username=?").bind(u).first();
    const name = row ? (`${row.first_name || ""} ${row.last_name || ""}`.trim() || u) : u;
    return json({ ok: true, username: u, name, ...detail }, {}, env, request);
  }

  // ── POST /office/segment — edit / void / reset a segment (admin) ──────────
  if (path === "/office/segment" && request.method === "POST") {
    if (!(await isTimesheetAdmin(env, me))) return error("Forbidden", 403, env, request);
    const b = await request.json().catch(() => ({}));
    if (!b.id) return error("Segment id required", 400, env, request);
    const row = await env.DB.prepare("SELECT * FROM office_shifts WHERE id=?").bind(b.id).first();
    if (!row) return error("Segment not found", 404, env, request);
    const nowIso = new Date().toISOString();

    // Reset back to the auto-captured times.
    if (b.clear) {
      const date = londonDate(new Date(row.clock_in));
      await env.DB.prepare(
        "UPDATE office_shifts SET edited_in=NULL, edited_out=NULL, edit_note=NULL, voided=0, edited_by=?, edited_at=?, date=?, updated_at=? WHERE id=?"
      ).bind(me, nowIso, date, nowIso, b.id).run();
      const fresh = await env.DB.prepare("SELECT * FROM office_shifts WHERE id=?").bind(b.id).first();
      return json({ ok: true, segment: shapeSeg(fresh) }, {}, env, request);
    }

    let editedIn = row.edited_in, editedOut = row.edited_out, voided = isVoided(row) ? 1 : 0;
    if ("editedIn" in b) { editedIn = b.editedIn ? toIso(b.editedIn) : null; if (b.editedIn && !editedIn) return error("Invalid start time.", 400, env, request); }
    if ("editedOut" in b) { editedOut = b.editedOut ? toIso(b.editedOut) : null; if (b.editedOut && !editedOut) return error("Invalid end time.", 400, env, request); }
    if ("void" in b) voided = b.void ? 1 : 0;

    const fIn = editedIn || row.clock_in;
    const fOut = editedOut || row.clock_out;
    if (fOut && Date.parse(fOut) < Date.parse(fIn))
      return error("End time can't be before the start time.", 400, env, request);

    const date = londonDate(new Date(fIn));   // regroup by the effective start day
    await env.DB.prepare(
      "UPDATE office_shifts SET edited_in=?, edited_out=?, edit_note=?, voided=?, edited_by=?, edited_at=?, date=?, updated_at=? WHERE id=?"
    ).bind(editedIn, editedOut, b.note || null, voided, me, nowIso, date, nowIso, b.id).run();
    const fresh = await env.DB.prepare("SELECT * FROM office_shifts WHERE id=?").bind(b.id).first();
    return json({ ok: true, segment: shapeSeg(fresh) }, {}, env, request);
  }

  // ── GET /office/timesheet?week= — weekly master timesheet (admin) ─────────
  if (path === "/office/timesheet" && request.method === "GET") {
    if (!(await isTimesheetAdmin(env, me))) return error("Forbidden", 403, env, request);
    const monday = mondayOf(isDateStr(url.searchParams.get("week") || "") ? url.searchParams.get("week") : londonDate());
    const days = weekDays(monday);
    const sunday = days[6];

    const { results } = await env.DB.prepare(
      "SELECT * FROM office_shifts WHERE date >= ? AND date <= ? ORDER BY username, clock_in"
    ).bind(monday, sunday).all();
    const { results: permUsers } = await env.DB.prepare(
      "SELECT username FROM user_permissions WHERE permission='OfficeClock' AND value=1"
    ).all();
    const { results: userRows } = await env.DB.prepare("SELECT username, first_name, last_name FROM users").all();
    const nameOf = {};
    for (const u of userRows || []) nameOf[u.username] = `${u.first_name || ""} ${u.last_name || ""}`.trim() || u.username;

    const map = {};
    const ensure = u => (map[u] || (map[u] = { username: u, name: nameOf[u] || u, days: {}, total: 0, open: false }));
    for (const u of permUsers || []) ensure(u.username);
    for (const r of results || []) {
      const e = ensure(r.username);
      if (isOpenRow(r)) { e.open = true; continue; }   // running — flagged, not counted
      const sec = segSeconds(r);
      e.days[r.date] = (e.days[r.date] || 0) + sec;
      e.total += sec;
    }
    const users = Object.values(map).sort((a, b) => a.name.localeCompare(b.name));
    return json({ ok: true, monday, sunday, days, users }, {}, env, request);
  }

  return error("Unknown office route", 404, env, request);
}
