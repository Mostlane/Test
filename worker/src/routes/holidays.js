// Holidays — full port of the `mostlane-holidays` Worker.
//
// CHANGES vs the original standalone Worker:
//   • HOLIDAYS_KV `holiday:<id>`            -> D1 table `holidays`
//   • HOLIDAYS_KV `system:<...>`            -> D1 table `holiday_system_days`
//   • HOLIDAY_CONFIG_KV `allowance:<y>:<u>` -> D1 table `holiday_allowance`
//   • HOLIDAY_CONFIG_KV `config|bankholidays|shutdown:<year>` -> D1 `app_config`
//   • HOLIDAY_LOG_KV                        -> D1 table `holiday_log`
//   • USERS_KV `all_users`                  -> D1 `users` (status = 'Active')
//
// All allowance/accrual maths, validation and admin gating are preserved
// exactly. Identity still comes from X-User / X-Role headers (so the existing
// pages work unchanged); if those are absent it falls back to the verified
// session token and derives the role from permissions.
//
// NOTE: holiday-config.html is a dead/broken page (posts to a non-existent
// /holiday/config and sends the wrong role) — superseded by holiday-admin.html.
// Not reproduced here; flagged for removal.

import { corsHeaders } from "../lib/http.js";
import { requireSession, permissionsFor } from "../lib/auth.js";

export async function handle(request, env, ctx, url) {
  const headers = corsHeaders(env, request);
  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });
  const text = (msg, status = 200) => new Response(msg, { status, headers });

  const path = url.pathname;
  const method = request.method.toUpperCase();

  // ── Identity (X-User/X-Role headers, else verified session) ────────────────
  let user = request.headers.get("X-User");
  let role = request.headers.get("X-Role") || "Engineer";
  if (!user) {
    const sess = await requireSession(env, request);
    if (sess) {
      user = sess.user.username;
      const perms = await permissionsFor(env, user);
      role = (perms.FullAccess === "Yes" || perms.HolidayAdmin === "Yes") ? "Admin" : "Engineer";
    }
  }
  if (!user) return text("Unauthorised", 401);

  const year = getYear(url);
  const isAdmin = ["Admin", "Director"].includes(role);

  // ─── app_config helpers ──────────────────────────────────────────
  async function cfgGet(key) {
    const row = await env.DB.prepare("SELECT value FROM app_config WHERE key = ?").bind(key).first();
    return row ? JSON.parse(row.value) : null;
  }
  async function cfgPut(key, val) {
    await env.DB.prepare(
      "INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).bind(key, JSON.stringify(val)).run();
  }

  async function getYearConfig() { return (await cfgGet(`holiday:config:${year}`)) || { defaultAllowance: 28 }; }
  async function getDefaultAllowance() { return Number((await getYearConfig()).defaultAllowance ?? 28); }
  async function getBankHolidays() { return (await cfgGet(`holiday:bankholidays:${year}`)) || []; }
  async function getShutdownDays() { return (await cfgGet(`holiday:shutdown:${year}`)) || []; }

  async function getUserAllowance(username) {
    const row = await env.DB.prepare(
      "SELECT allowance FROM holiday_allowance WHERE year = ? AND username = ?"
    ).bind(year, username).first();
    if (row && Number.isFinite(Number(row.allowance))) return Number(row.allowance);
    return getDefaultAllowance();
  }

  async function listAllowancesMap() {
    const { results } = await env.DB.prepare(
      "SELECT username, allowance FROM holiday_allowance WHERE year = ?"
    ).bind(year).all();
    const out = {};
    for (const r of results || []) if (Number.isFinite(Number(r.allowance))) out[r.username] = Number(r.allowance);
    return out;
  }

  async function getActiveUsers() {
    const { results } = await env.DB.prepare(
      "SELECT username FROM users WHERE status = 'Active'"
    ).all();
    return (results || []).map(r => r.username).filter(Boolean);
  }

  async function logAction(requestId, action, by) {
    await env.DB.prepare(
      "INSERT INTO holiday_log (request_id, action, by_user, at) VALUES (?,?,?,?)"
    ).bind(requestId, action, by, new Date().toISOString()).run();
  }

  // Idempotently create per-user bank-holiday / shutdown rows (preserves worked state).
  async function ensureSystemDaysForUser(username) {
    const [bank, shut] = await Promise.all([getBankHolidays(), getShutdownDays()]);
    const now = new Date().toISOString();
    const eng = username.replace(".", " ");
    for (const b of bank) {
      if (!b?.date) continue;
      await env.DB.prepare(`
        INSERT INTO holiday_system_days (kind, year, date, username, id, engineer, label, days, category, worked, status, created_at)
        VALUES ('bankholiday', ?, ?, ?, ?, ?, ?, 1, 'BankHoliday', 0, 'Deducted', ?)
        ON CONFLICT(kind, year, date, username) DO NOTHING
      `).bind(year, b.date, username, `BH-${year}-${b.date}-${username}`, eng, b.label || "Bank Holiday", now).run();
    }
    for (const s of shut) {
      if (!s?.date) continue;
      await env.DB.prepare(`
        INSERT INTO holiday_system_days (kind, year, date, username, id, engineer, label, days, category, worked, status, created_at)
        VALUES ('shutdown', ?, ?, ?, ?, ?, ?, 1, 'Shutdown', 0, 'Deducted', ?)
        ON CONFLICT(kind, year, date, username) DO NOTHING
      `).bind(year, s.date, username, `SD-${year}-${s.date}-${username}`, eng, s.label || "Company Shutdown", now).run();
    }
  }

  async function listHolidayRequestsForYear() {
    const { results } = await env.DB.prepare("SELECT * FROM holidays WHERE year = ?").bind(year).all();
    return (results || []).map(reqOut);
  }
  async function getHolidayById(id) {
    const row = await env.DB.prepare("SELECT * FROM holidays WHERE id = ?").bind(id).first();
    return row ? reqOut(row) : null;
  }
  async function listSystemRecordsForYear() {
    const { results } = await env.DB.prepare("SELECT * FROM holiday_system_days WHERE year = ?").bind(year).all();
    return (results || []).map(sysOut);
  }

  // ─── Endpoints ────────────────────────────────────────────

  // POST /holiday/request
  if (path === "/holiday/request" && method === "POST") {
    const body = await request.json();
    const id = `H-${Date.now()}`;
    const start = body.start, end = body.end;
    if (!start || !end) return text("Missing start/end", 400);
    if (new Date(end) < new Date(start)) return text("End before start", 400);
    const note = String(body.notes || "").trim();
    if (!note) return text("Notes (reminder) required", 400);
    const days = countWeekdaysInclusive(start, end);
    if (days <= 0) return text("No weekdays in range", 400);
    await env.DB.prepare(`
      INSERT INTO holidays (id, engineer, username, year, start_date, end_date, days, type, notes, status, submitted_at)
      VALUES (?,?,?,?,?,?,?,?,?,'Pending',?)
    `).bind(id, user.replace(".", " "), user, year, start, end, days, body.type || null, note, new Date().toISOString()).run();
    await logAction(id, "Submitted", user);
    return json({ success: true, id });
  }

  // POST /holiday/cancel  (engineer self-cancel, Pending only)
  if (path === "/holiday/cancel" && method === "POST") {
    const { id } = await request.json();
    if (!id) return text("Missing id", 400);
    const record = await getHolidayById(id);
    if (!record) return text("Not found", 404);
    if (record.username !== user) return text("Forbidden", 403);
    if (record.status !== "Pending") return text("Only pending requests can be self-cancelled", 409);
    await env.DB.prepare(
      "UPDATE holidays SET status='Cancelled', cancelled_by=?, decision_at=? WHERE id=?"
    ).bind(user, new Date().toISOString(), id).run();
    await logAction(id, "Cancelled by engineer", user);
    return json({ success: true });
  }

  // POST /holiday/delete-own  (engineer deletes own Cancelled/Rejected)
  if (path === "/holiday/delete-own" && method === "POST") {
    const { id } = await request.json();
    if (!id) return text("Missing id", 400);
    const record = await getHolidayById(id);
    if (!record) return text("Not found", 404);
    if (record.username !== user) return text("Forbidden", 403);
    if (!["Cancelled", "Rejected"].includes(record.status)) {
      return text("Can only delete cancelled or rejected requests", 409);
    }
    await env.DB.prepare("DELETE FROM holidays WHERE id=?").bind(id).run();
    await logAction(id, "Deleted by engineer", user);
    return json({ success: true });
  }

  // POST /holiday/cancel-approved  (admin revoke of an approved holiday)
  if (path === "/holiday/cancel-approved" && method === "POST") {
    if (!isAdmin) return text("Forbidden", 403);
    const { id } = await request.json();
    if (!id) return text("Missing id", 400);
    const record = await getHolidayById(id);
    if (!record) return text("Not found", 404);
    if (record.status !== "Approved") return text("Only approved holidays can be cancelled here", 409);
    await env.DB.prepare(
      "UPDATE holidays SET status='Cancelled', cancelled_by=?, decision_at=?, cancel_note=? WHERE id=?"
    ).bind(user, new Date().toISOString(), "Cancelled by admin after approval", id).run();
    await logAction(id, "Approval cancelled by admin", user);
    return json({ success: true });
  }

  // GET /holiday/my
  if (path === "/holiday/my" && method === "GET") {
    await ensureSystemDaysForUser(user);
    const reqs = (await listHolidayRequestsForYear()).filter(h => h.username === user);
    const sys = (await listSystemRecordsForYear()).filter(s => s.username === user);
    const results = [...reqs, ...sys];
    results.sort((a, b) => {
      const da = a.date || a.start || "9999-12-31";
      const db = b.date || b.start || "9999-12-31";
      return da.localeCompare(db);
    });
    return json(results);
  }

  // GET /holiday/summary
  if (path === "/holiday/summary" && method === "GET") {
    await ensureSystemDaysForUser(user);
    const allowance = await getUserAllowance(user);
    const all = await listHolidayRequestsForYear();
    let approvedHoliday = 0;
    for (const h of all) {
      if (h.username === user && h.status === "Approved") approvedHoliday += (h.days || 0);
    }
    const sys = await listSystemRecordsForYear();
    let sysDeducted = 0, sysCredited = 0;
    for (const s of sys) {
      if (s.username !== user) continue;
      if (!isWeekdayISO(s.date)) continue;
      if (s.worked === true || s.status === "Credited") sysCredited += (s.days || 1);
      else sysDeducted += (s.days || 1);
    }
    const used = approvedHoliday + sysDeducted - sysCredited;
    return json({ allowance, used, remaining: allowance - used, breakdown: { approvedHoliday, sysDeducted, sysCredited } });
  }

  // GET /holiday/all  (admin)
  if (path === "/holiday/all" && method === "GET") {
    if (!isAdmin) return text("Forbidden", 403);
    return json(await listHolidayRequestsForYear());
  }

  // POST /holiday/approve | /holiday/reject  (admin)
  if (["/holiday/approve", "/holiday/reject"].includes(path) && method === "POST") {
    if (!isAdmin) return text("Forbidden", 403);
    const { id } = await request.json();
    if (!id) return text("Missing id", 400);
    const record = await getHolidayById(id);
    if (!record) return text("Not found", 404);
    const status = path.endsWith("approve") ? "Approved" : "Rejected";
    await env.DB.prepare(
      "UPDATE holidays SET status=?, approved_by=?, decision_at=? WHERE id=?"
    ).bind(status, user, new Date().toISOString(), id).run();
    await logAction(id, status, user);
    return json({ success: true });
  }

  // GET /holiday/config  (admin)
  if (path === "/holiday/config" && method === "GET") {
    if (!isAdmin) return text("Forbidden", 403);
    const cfg = await getYearConfig();
    const [bank, shut, allowances] = await Promise.all([getBankHolidays(), getShutdownDays(), listAllowancesMap()]);
    return json({ year, defaultAllowance: Number(cfg.defaultAllowance ?? 28), bankholidays: bank, shutdown: shut, allowances });
  }

  // POST /holiday/set-year-config  (admin)
  if (path === "/holiday/set-year-config" && method === "POST") {
    if (!isAdmin) return text("Forbidden", 403);
    const body = await request.json();
    const defaultAllowance = Number(body.defaultAllowance);
    if (!Number.isFinite(defaultAllowance)) return text("Bad payload", 400);
    await cfgPut(`holiday:config:${year}`, { defaultAllowance });
    return json({ success: true });
  }

  // POST /holiday/set-allowance  (admin)
  if (path === "/holiday/set-allowance" && method === "POST") {
    if (!isAdmin) return text("Forbidden", 403);
    const body = await request.json();
    const username = body.username;
    const allowance = Number(body.allowance);
    if (!username || !Number.isFinite(allowance)) return text("Bad payload", 400);
    await env.DB.prepare(
      "INSERT INTO holiday_allowance (year, username, allowance) VALUES (?,?,?) ON CONFLICT(year, username) DO UPDATE SET allowance=excluded.allowance"
    ).bind(year, username, allowance).run();
    return json({ success: true });
  }

  // POST /holiday/set-bankholidays  (admin)
  if (path === "/holiday/set-bankholidays" && method === "POST") {
    if (!isAdmin) return text("Forbidden", 403);
    const body = await request.json();
    const days = Array.isArray(body.days) ? body.days : null;
    if (!days) return text("Bad payload", 400);
    const oldDays = await getBankHolidays();
    const newDates = new Set(days.map(d => d.date));
    const removed = oldDays.filter(b => !newDates.has(b.date)).map(b => b.date);
    if (removed.length) await deleteSystemDays(env, "bankholiday", year, removed);
    await cfgPut(`holiday:bankholidays:${year}`, days);
    return json({ success: true });
  }

  // POST /holiday/set-shutdown  (admin)
  if (path === "/holiday/set-shutdown" && method === "POST") {
    if (!isAdmin) return text("Forbidden", 403);
    const body = await request.json();
    const days = Array.isArray(body.days) ? body.days : null;
    if (!days) return text("Bad payload", 400);
    const oldDays = await getShutdownDays();
    const newDates = new Set(days.map(d => d.date));
    const removed = oldDays.filter(s => !newDates.has(s.date)).map(s => s.date);
    if (removed.length) await deleteSystemDays(env, "shutdown", year, removed);
    await cfgPut(`holiday:shutdown:${year}`, days);
    return json({ success: true });
  }

  // POST /holiday/toggle-worked  (admin)
  if (path === "/holiday/toggle-worked" && method === "POST") {
    if (!isAdmin) return text("Forbidden", 403);
    const body = await request.json();
    const kind = body.kind, username = body.username, date = body.date, worked = !!body.worked;
    if (!["bankholiday", "shutdown"].includes(kind) || !username || !date) return text("Bad payload", 400);
    await ensureSystemDaysForUser(username);
    const row = await env.DB.prepare(
      "SELECT id FROM holiday_system_days WHERE kind=? AND year=? AND date=? AND username=?"
    ).bind(kind, year, date, username).first();
    if (!row) return text("Not found", 404);
    await env.DB.prepare(
      "UPDATE holiday_system_days SET worked=?, status=?, updated_by=?, updated_at=? WHERE kind=? AND year=? AND date=? AND username=?"
    ).bind(worked ? 1 : 0, worked ? "Credited" : "Deducted", user, new Date().toISOString(), kind, year, date, username).run();
    await logAction(row.id, worked ? "Worked (Credited)" : "Reverted (Deducted)", user);
    return json({ success: true });
  }

  // GET /holiday/admin-summary  (admin)
  if (path === "/holiday/admin-summary" && method === "GET") {
    if (!isAdmin) return text("Forbidden", 403);
    const usernames = await getActiveUsers();
    for (const u of usernames) await ensureSystemDaysForUser(u);
    const all = await listHolidayRequestsForYear();
    const sys = await listSystemRecordsForYear();
    const list = [];
    for (const u of usernames.slice().sort((a, b) => a.localeCompare(b))) {
      const allowance = await getUserAllowance(u);
      let approvedHoliday = 0;
      for (const h of all) if (h.username === u && h.status === "Approved") approvedHoliday += (h.days || 0);
      let sysDeducted = 0, sysCredited = 0;
      for (const s of sys) {
        if (s.username !== u) continue;
        if (!isWeekdayISO(s.date)) continue;
        if (s.worked === true || s.status === "Credited") sysCredited += (s.days || 1);
        else sysDeducted += (s.days || 1);
      }
      const used = approvedHoliday + sysDeducted - sysCredited;
      list.push({ username: u, name: u.replace(".", " "), allowance, used, remaining: allowance - used });
    }
    return json({ year, engineers: list });
  }

  // GET /holiday/calendar  (admin)
  if (path === "/holiday/calendar" && method === "GET") {
    if (!isAdmin) return text("Forbidden", 403);
    const month = getMonth(url);
    const monthStart = new Date(Date.UTC(year, month - 1, 1));
    const monthEnd = new Date(Date.UTC(year, month, 0));
    const daysInMonth = monthEnd.getUTCDate();
    const usernames = await getActiveUsers();
    for (const u of usernames) await ensureSystemDaysForUser(u);
    const all = await listHolidayRequestsForYear();
    const sys = await listSystemRecordsForYear();
    const engineers = [];

    for (const u of usernames.slice().sort((a, b) => a.localeCompare(b))) {
      const cells = {};
      for (const h of all) {
        if (h.username !== u || h.status !== "Approved") continue;
        const overlap = weekdayOverlapCount(h.start, h.end, monthStart, monthEnd);
        if (!overlap) continue;
        const s = new Date(h.start + "T00:00:00Z");
        const e = new Date(h.end + "T00:00:00Z");
        for (let d = new Date(s); d <= e; d.setUTCDate(d.getUTCDate() + 1)) {
          const day = d.getUTCDay();
          if (day === 0 || day === 6) continue;
          if (d < monthStart || d > monthEnd) continue;
          const di = isoDate(d);
          cells[di] = {
            kind: "holiday", type: h.type || "Annual Leave", note: h.notes || "",
            label: "Holiday", username: u, requestId: h.id,
            rangeStart: h.start, rangeEnd: h.end, days: h.days
          };
        }
      }
      for (const s of sys) {
        if (s.username !== u) continue;
        const di = s.date;
        if (!di) continue;
        const d = new Date(di + "T00:00:00Z");
        if (d < monthStart || d > monthEnd) continue;
        if (!isWeekdayISO(di)) continue;
        if (!cells[di]) {
          cells[di] = {
            kind: s.category === "Shutdown" ? "shutdown" : "bankholiday",
            type: s.category, note: "", label: s.label || s.category,
            worked: !!s.worked, username: u
          };
        }
      }
      engineers.push({ username: u, name: u.replace(".", " "), cells });
    }

    return json({ year, month, daysInMonth, monthStart: isoDate(monthStart), monthEnd: isoDate(monthEnd), engineers });
  }

  // GET /holiday/debug-users  (admin)
  if (path === "/holiday/debug-users" && method === "GET") {
    if (!isAdmin) return text("Forbidden", 403);
    const activeUsers = await getActiveUsers();
    return json({ activeUsersCount: activeUsers.length, activeUsers: activeUsers.slice(0, 10) });
  }

  return text("Not Found", 404);
}

/* ================= ROW MAPPERS ================= */

function reqOut(r) {
  return {
    id: r.id, engineer: r.engineer, username: r.username, year: r.year,
    start: r.start_date, end: r.end_date, days: r.days, type: r.type,
    notes: r.notes, status: r.status, submittedAt: r.submitted_at,
    approvedBy: r.approved_by, decisionAt: r.decision_at,
    cancelledBy: r.cancelled_by, cancelNote: r.cancel_note
  };
}

function sysOut(r) {
  return {
    id: r.id, username: r.username, engineer: r.engineer, year: r.year,
    date: r.date, label: r.label, days: r.days, category: r.category,
    worked: !!r.worked, status: r.status, createdAt: r.created_at,
    updatedBy: r.updated_by, updatedAt: r.updated_at
  };
}

async function deleteSystemDays(env, kind, year, dates) {
  const placeholders = dates.map(() => "?").join(",");
  await env.DB.prepare(
    `DELETE FROM holiday_system_days WHERE kind=? AND year=? AND date IN (${placeholders})`
  ).bind(kind, year, ...dates).run();
}

/* ================= PURE HELPERS (unchanged from original) ================= */

function getYear(url) {
  const y = url.searchParams.get("year");
  const year = y ? parseInt(y, 10) : new Date().getFullYear();
  return Number.isFinite(year) ? year : new Date().getFullYear();
}

function getMonth(url) {
  const m = url.searchParams.get("month");
  const month = m ? parseInt(m, 10) : (new Date().getMonth() + 1);
  return Number.isFinite(month) && month >= 1 && month <= 12 ? month : (new Date().getMonth() + 1);
}

function isoDate(d) { return new Date(d).toISOString().split("T")[0]; }

function countWeekdaysInclusive(startISO, endISO) {
  const s = new Date(startISO + "T00:00:00");
  const e = new Date(endISO + "T00:00:00");
  if (isNaN(s) || isNaN(e)) return 0;
  if (e < s) return 0;
  let days = 0;
  for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) days++;
  }
  return days;
}

function isWeekdayISO(dateISO) {
  const [y, m, d] = dateISO.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day !== 0 && day !== 6;
}

function weekdayOverlapCount(startISO, endISO, monthStart, monthEnd) {
  const s = new Date(startISO + "T00:00:00");
  const e = new Date(endISO + "T00:00:00");
  const a = s < monthStart ? monthStart : s;
  const b = e > monthEnd ? monthEnd : e;
  if (b < a) return 0;
  let days = 0;
  for (let d = new Date(a); d <= b; d.setDate(d.getDate() + 1)) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) days++;
  }
  return days;
}
