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
import { tenantDB, resolveTenantId } from "../lib/tenantdb.js";

export async function handle(request, env, ctx, url, sess) {
  const headers = corsHeaders(env, request);
  // Tenant is always server-derived (session, or request host for the
  // not-yet-reached public case) — NEVER from the X-User header or the body.
  const tenantId = sess ? sess.tenantId : await resolveTenantId(env, request);
  const db = tenantDB(env, tenantId);
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
      const perms = await permissionsFor(env, tenantId, user);
      role = (perms.FullAccess === "Yes" || perms.HolidayAdmin === "Yes") ? "Admin" : "Engineer";
    }
  }
  if (!user) return text("Unauthorised", 401);

  const year = getYear(url);
  const isAdmin = ["Admin", "Director"].includes(role);

  // ─── app_config helpers ──────────────────────────────────────────
  async function cfgGet(key) {
    const row = await db.prepare("SELECT value FROM app_config WHERE tenant_id = ? AND key = ?").bind(db.tenantId, key).first();
    return row ? JSON.parse(row.value) : null;
  }
  async function cfgPut(key, val) {
    await db.prepare(
      "INSERT INTO app_config (tenant_id, key, value) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).bind(db.tenantId, key, JSON.stringify(val)).run();
  }

  async function getYearConfig() { return (await cfgGet(`holiday:config:${year}`)) || { defaultAllowance: 28 }; }
  async function getDefaultAllowance() { return Number((await getYearConfig()).defaultAllowance ?? 28); }
  async function getBankHolidays() { return (await cfgGet(`holiday:bankholidays:${year}`)) || []; }
  async function getShutdownDays() { return (await cfgGet(`holiday:shutdown:${year}`)) || []; }

  async function getUserAllowance(username) {
    const row = await db.prepare(
      "SELECT allowance FROM holiday_allowance WHERE tenant_id = ? AND year = ? AND username = ?"
    ).bind(db.tenantId, year, username).first();
    if (row && Number.isFinite(Number(row.allowance))) return Number(row.allowance);
    return getDefaultAllowance();
  }

  async function listAllowancesMap() {
    const { results } = await db.prepare(
      "SELECT username, allowance FROM holiday_allowance WHERE tenant_id = ? AND year = ?"
    ).bind(db.tenantId, year).all();
    const out = {};
    for (const r of results || []) if (Number.isFinite(Number(r.allowance))) out[r.username] = Number(r.allowance);
    return out;
  }

  async function getActiveUsers() {
    const { results } = await db.prepare(
      "SELECT username FROM users WHERE tenant_id = ? AND status = 'Active'"
    ).bind(db.tenantId).all();
    return (results || []).map(r => r.username).filter(Boolean);
  }

  async function logAction(requestId, action, by) {
    await db.prepare(
      "INSERT INTO holiday_log (tenant_id, request_id, action, by_user, at) VALUES (?,?,?,?,?)"
    ).bind(db.tenantId, requestId, action, by, new Date().toISOString()).run();
  }

  // Idempotently create per-user bank-holiday / shutdown rows (preserves worked
  // state). Bulk version: ONE select to find what's missing, ONE batch to insert
  // it — the old per-day-per-user awaited INSERTs made admin pages take ~30s.
  async function ensureSystemDaysBulk(usernames) {
    if (!usernames.length) return;
    const [bank, shut] = await Promise.all([getBankHolidays(), getShutdownDays()]);
    if (!bank.length && !shut.length) return;
    const { results } = await db.prepare(
      "SELECT kind, date, username FROM holiday_system_days WHERE tenant_id = ? AND year = ?"
    ).bind(db.tenantId, year).all();
    const have = new Set((results || []).map(r => `${r.kind}|${r.date}|${r.username}`));
    const now = new Date().toISOString();
    const stmts = [];
    const ins = db.prepare(`
      INSERT INTO holiday_system_days (tenant_id, kind, year, date, username, id, engineer, label, days, category, worked, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, 'Deducted', ?)
      ON CONFLICT(kind, year, date, username) DO NOTHING
    `);
    for (const u of usernames) {
      for (const b of bank) {
        if (!b?.date || have.has(`bankholiday|${b.date}|${u}`)) continue;
        stmts.push(ins.bind(db.tenantId, "bankholiday", year, b.date, u, `BH-${year}-${b.date}-${u}`, u, b.label || "Bank Holiday", "BankHoliday", now));
      }
      for (const s of shut) {
        if (!s?.date || have.has(`shutdown|${s.date}|${u}`)) continue;
        stmts.push(ins.bind(db.tenantId, "shutdown", year, s.date, u, `SD-${year}-${s.date}-${u}`, u, s.label || "Company Shutdown", "Shutdown", now));
      }
    }
    if (stmts.length) await db.batch(stmts);
  }
  async function ensureSystemDaysForUser(username) { return ensureSystemDaysBulk([username]); }

  async function listHolidayRequestsForYear() {
    const { results } = await db.prepare("SELECT * FROM holidays WHERE tenant_id = ? AND year = ?").bind(db.tenantId, year).all();
    return (results || []).map(reqOut);
  }
  async function getHolidayById(id) {
    const row = await db.prepare("SELECT * FROM holidays WHERE tenant_id = ? AND id = ?").bind(db.tenantId, id).first();
    return row ? reqOut(row) : null;
  }
  async function listSystemRecordsForYear() {
    const { results } = await db.prepare("SELECT * FROM holiday_system_days WHERE tenant_id = ? AND year = ?").bind(db.tenantId, year).all();
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
    // Half days: AM or PM, only for a single-weekday booking; counts as 0.5.
    const half = ["AM", "PM"].includes(body.half) ? body.half : null;
    if (half && start !== end) return text("Half days are for a single day", 400);
    let days = countWeekdaysInclusive(start, end);
    if (days <= 0) return text("No weekdays in range", 400);
    if (half) days = 0.5;
    await db.prepare(`
      INSERT INTO holidays (tenant_id, id, engineer, username, year, start_date, end_date, days, half, type, notes, status, submitted_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'Pending',?)
    `).bind(db.tenantId, id, user.replace(".", " "), user, year, start, end, days, half, body.type || null, note, new Date().toISOString()).run();
    await logAction(id, "Submitted", user);
    return json({ success: true, id });
  }

  // POST /holiday/cancel  (engineer self-cancel — Pending or Approved).
  // Cancelling approved leave credits the days back automatically (summary
  // only counts Approved) and surfaces to admins via the Holiday Admin badge.
  if (path === "/holiday/cancel" && method === "POST") {
    const { id } = await request.json();
    if (!id) return text("Missing id", 400);
    const record = await getHolidayById(id);
    if (!record) return text("Not found", 404);
    if (record.username !== user) return text("Forbidden", 403);
    if (!["Pending", "Approved"].includes(record.status))
      return text("Only pending or approved requests can be cancelled", 409);
    const wasApproved = record.status === "Approved";
    await db.prepare(
      "UPDATE holidays SET status='Cancelled', cancelled_by=?, decision_at=?, cancel_note=? WHERE tenant_id=? AND id=?"
    ).bind(user, new Date().toISOString(), wasApproved ? "Approved holiday cancelled by staff member" : null, db.tenantId, id).run();
    await logAction(id, wasApproved ? "Approved holiday cancelled by engineer" : "Cancelled by engineer", user);
    return json({ success: true, wasApproved });
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
    await db.prepare("DELETE FROM holidays WHERE tenant_id=? AND id=?").bind(db.tenantId, id).run();
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
    await db.prepare(
      "UPDATE holidays SET status='Cancelled', cancelled_by=?, decision_at=?, cancel_note=? WHERE tenant_id=? AND id=?"
    ).bind(user, new Date().toISOString(), "Cancelled by admin after approval", db.tenantId, id).run();
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
      // Approved "Other" leave is agreed as NOT coming off the allowance.
      // Only paid Holiday comes off the allowance — "Other" (agreed) and
      // "Unpaid" don't (matches Timetastic, which deducted 0 for unpaid).
      if (h.username === user && h.status === "Approved" && h.type !== "Other" && h.type !== "Unpaid") approvedHoliday += (h.days || 0);
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
    const cfg = await getYearConfig();
    return json({
      allowance, used, remaining: allowance - used,
      accrualMode: !!cfg.accrualMode,
      breakdown: { approvedHoliday, sysDeducted, sysCredited }
    });
  }

  // GET /holiday/all  (admin)
  if (path === "/holiday/all" && method === "GET") {
    if (!isAdmin) return text("Forbidden", 403);
    return json(await listHolidayRequestsForYear());
  }

  // POST /holiday/approve | /holiday/reject  (admin)
  // Approve accepts an optional {type} so an "Other" request can be
  // reclassified on approval: Other (not off allowance) / Holiday / Unpaid.
  if (["/holiday/approve", "/holiday/reject"].includes(path) && method === "POST") {
    if (!isAdmin) return text("Forbidden", 403);
    const body = await request.json();
    const { id } = body;
    if (!id) return text("Missing id", 400);
    const record = await getHolidayById(id);
    if (!record) return text("Not found", 404);
    const status = path.endsWith("approve") ? "Approved" : "Rejected";
    const newType = ["Holiday", "Unpaid", "Other"].includes(body.type) ? body.type : null;
    await db.prepare(
      "UPDATE holidays SET status=?, approved_by=?, decision_at=?, type=COALESCE(?, type) WHERE tenant_id=? AND id=?"
    ).bind(status, user, new Date().toISOString(), newType, db.tenantId, id).run();
    await logAction(id, status + (newType && newType !== record.type ? ` (as ${newType})` : ""), user);
    return json({ success: true });
  }

  // GET /holiday/config  (admin)
  if (path === "/holiday/config" && method === "GET") {
    if (!isAdmin) return text("Forbidden", 403);
    const cfg = await getYearConfig();
    const [bank, shut, allowances] = await Promise.all([getBankHolidays(), getShutdownDays(), listAllowancesMap()]);
    return json({ year, defaultAllowance: Number(cfg.defaultAllowance ?? 28), accrualMode: !!cfg.accrualMode, bankholidays: bank, shutdown: shut, allowances });
  }

  // POST /holiday/set-year-config  (admin)
  if (path === "/holiday/set-year-config" && method === "POST") {
    if (!isAdmin) return text("Forbidden", 403);
    const body = await request.json();
    const defaultAllowance = Number(body.defaultAllowance);
    if (!Number.isFinite(defaultAllowance)) return text("Bad payload", 400);
    const prev = await getYearConfig();
    await cfgPut(`holiday:config:${year}`, {
      defaultAllowance,
      accrualMode: "accrualMode" in body ? !!body.accrualMode : !!prev.accrualMode
    });
    return json({ success: true });
  }

  // POST /holiday/set-allowance  (admin)
  if (path === "/holiday/set-allowance" && method === "POST") {
    if (!isAdmin) return text("Forbidden", 403);
    const body = await request.json();
    const username = body.username;
    const allowance = Number(body.allowance);
    if (!username || !Number.isFinite(allowance)) return text("Bad payload", 400);
    await db.prepare(
      "INSERT INTO holiday_allowance (tenant_id, year, username, allowance) VALUES (?,?,?,?) ON CONFLICT(year, username) DO UPDATE SET allowance=excluded.allowance"
    ).bind(db.tenantId, year, username, allowance).run();
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
    if (removed.length) await deleteSystemDays(env, tenantId, "bankholiday", year, removed);
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
    if (removed.length) await deleteSystemDays(env, tenantId, "shutdown", year, removed);
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
    const row = await db.prepare(
      "SELECT id FROM holiday_system_days WHERE tenant_id=? AND kind=? AND year=? AND date=? AND username=?"
    ).bind(db.tenantId, kind, year, date, username).first();
    if (!row) return text("Not found", 404);
    await db.prepare(
      "UPDATE holiday_system_days SET worked=?, status=?, updated_by=?, updated_at=? WHERE tenant_id=? AND kind=? AND year=? AND date=? AND username=?"
    ).bind(worked ? 1 : 0, worked ? "Credited" : "Deducted", user, new Date().toISOString(), db.tenantId, kind, year, date, username).run();
    await logAction(row.id, worked ? "Worked (Credited)" : "Reverted (Deducted)", user);
    return json({ success: true });
  }

  // GET /holiday/admin-summary  (admin)
  if (path === "/holiday/admin-summary" && method === "GET") {
    if (!isAdmin) return text("Forbidden", 403);
    const usernames = await getActiveUsers();
    await ensureSystemDaysBulk(usernames);
    const [all, sys, allowMap, dflt] = await Promise.all([
      listHolidayRequestsForYear(), listSystemRecordsForYear(), listAllowancesMap(), getDefaultAllowance()
    ]);
    const list = [];
    for (const u of usernames.slice().sort((a, b) => a.localeCompare(b))) {
      const allowance = Number.isFinite(allowMap[u]) ? allowMap[u] : dflt;
      let approvedHoliday = 0;
      for (const h of all) if (h.username === u && h.status === "Approved" && h.type !== "Other" && h.type !== "Unpaid") approvedHoliday += (h.days || 0);
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
    await ensureSystemDaysBulk(usernames);
    const [all, sys] = await Promise.all([listHolidayRequestsForYear(), listSystemRecordsForYear()]);
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
            rangeStart: h.start, rangeEnd: h.end, days: h.days,
            half: h.half || (Number(h.days) === 0.5 && h.start === h.end ? "HALF" : null)
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

  // GET /holiday/uk-bank-holidays  (admin) — official GOV.UK feed, proxied
  // server-side so the browser never depends on gov.uk CORS. Cached for a day.
  if (path === "/holiday/uk-bank-holidays" && method === "GET") {
    if (!isAdmin) return text("Forbidden", 403);
    try {
      const resp = await fetch("https://www.gov.uk/bank-holidays.json", { cf: { cacheTtl: 86400, cacheEverything: true } });
      if (!resp.ok) return text("GOV.UK unavailable", 502);
      const data = await resp.json();
      const events = ((data["england-and-wales"] || {}).events || [])
        .filter(e => e.date && e.date.startsWith(String(year)))
        .map(e => ({ date: e.date, title: e.title }));
      return json({ year, events });
    } catch (e) {
      return text("GOV.UK unavailable", 502);
    }
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
    start: r.start_date, end: r.end_date, days: r.days, half: r.half || null, type: r.type,
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

async function deleteSystemDays(env, tenantId, kind, year, dates) {
  const db = tenantDB(env, tenantId);
  const placeholders = dates.map(() => "?").join(",");
  await db.prepare(
    `DELETE FROM holiday_system_days WHERE tenant_id=? AND kind=? AND year=? AND date IN (${placeholders})`
  ).bind(db.tenantId, kind, year, ...dates).run();
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
