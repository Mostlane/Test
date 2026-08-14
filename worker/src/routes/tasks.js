// Admin task list — recurring jobs a Full-Access user sets for staff, with a
// deadline day/time, that show as a home-page stat and (optionally) auto-tick
// when the person actually does the linked portal action.
//
//   GET  /tasks/mine                 my current tasks + status (any session)
//   GET  /tasks/attention            { outstanding, overdue, total } for me
//   POST /tasks/complete { id, undo } tick / untick my current occurrence
//   GET  /tasks/admin                all task defs + per-assignee status (FullAccess)
//   POST /tasks/save                 create / update a task def (FullAccess)
//   POST /tasks/delete { id }        remove a task def (FullAccess)
//   POST /tasks/grant { username, permission }  grant an area permission (FullAccess)
//   GET  /tasks/meta                 areas + auto-complete triggers (FullAccess)
//
// Tables (self-migrating):
//   admin_tasks       — the definitions (title, assignees JSON, recurrence, due…)
//   admin_task_done   — manual completions, keyed (task_id, username, period_key)
// Auto-completion is computed LIVE from audit_log (no stored state): if the
// assignee has a successful audit entry whose path matches the task's
// auto_match within the current period, the task counts as done.

import { json, error } from "../lib/http.js";
import { permissionsFor } from "../lib/auth.js";
import { sendToUser } from "./push.js";

// Areas a task can be linked to = a permission the assignee needs, plus the
// audit path fragment that means "they did the job" (for auto-completion).
// label is what the Full-Access user picks from the dropdown.
// key = the permission the assignee needs; auto = the audit path fragment that
// means "they did the job" (auto-complete); page = where clicking the task takes
// them to actually do it.
export const TASK_AREAS = [
  { key: "",              label: "— none (manual only) —",           auto: "",                page: "" },
  { key: "Vehicles",      label: "Vehicles / van checks",           auto: "/vancheck/submit", page: "vehicles.html" },
  { key: "HolidayAdmin",  label: "Holiday approvals",               auto: "/holiday/approve", page: "holiday-admin.html" },
  { key: "SLA",           label: "SLA jobs",                        auto: "/sla/jobs",        page: "sla-main.html" },
  { key: "SLAAdmin",      label: "SLA jobs (admin)",                auto: "/sla/jobs",        page: "sla-main.html" },
  { key: "PurchaseOrders",label: "Purchase orders",                 auto: "/po/api/pos",      page: "po-office.html" },
  { key: "Compliance",    label: "Compliance certificates",         auto: "/compliance/",     page: "compliance.html" },
  { key: "Assets",        label: "Plant & equipment",               auto: "/asset/",          page: "my-assets.html" },
  { key: "AssetAdmin",    label: "Plant & equipment (admin)",       auto: "/asset/",          page: "assets-admin.html" },
  { key: "Sites",         label: "Sites",                           auto: "/update-site",     page: "sites.html" },
  { key: "TimesheetAdmin",label: "Timesheets (admin)",              auto: "/ts/admin/save",   page: "timesheets-admin.html" },
  { key: "Users",         label: "Users admin",                     auto: "/users",           page: "users-admin.html" },
];
const AREA_BY_KEY = {}; for (const a of TASK_AREAS) AREA_BY_KEY[a.key] = a;

const RECURRENCE = ["daily", "weekly", "monthly", "quarterly", "yearly", "once"];

async function ensureTables(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS admin_tasks (
    id TEXT PRIMARY KEY, tenant_id TEXT, title TEXT, detail TEXT, assignees TEXT,
    recurrence TEXT, due_time TEXT, due_dow INTEGER, due_dom INTEGER, due_month INTEGER, due_date TEXT,
    area TEXT, auto_match TEXT, active INTEGER DEFAULT 1,
    created_by TEXT, created_at TEXT, updated_at TEXT)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS admin_task_done (
    tenant_id TEXT, task_id TEXT, username TEXT, period_key TEXT, done_at TEXT, done_by TEXT,
    PRIMARY KEY (task_id, username, period_key))`).run();
}

// ── London-time helpers (deadlines are UK wall-clock) ────────────────────────
function lonYMD(d) { return d.toLocaleDateString("en-CA", { timeZone: "Europe/London" }); }
function lonHM(d) { return d.toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour12: false, hour: "2-digit", minute: "2-digit" }); }
function lonToISO(ymd, hm) {
  for (const off of ["+01:00", "+00:00"]) {
    const dt = new Date(`${ymd}T${hm}:00${off}`);
    if (!isNaN(dt) && lonYMD(dt) === ymd && lonHM(dt) === hm) return dt.toISOString();
  }
  return new Date(`${ymd}T${hm}:00Z`).toISOString();
}
function addDaysYMD(ymd, n) { const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function mondayOf(ymd) { const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); }
const clampDom = dom => Math.min(28, Math.max(1, Number(dom) || 1));   // cap at 28 → always valid in any month

// Current occurrence for a task: its period key, deadline instant + period start.
function occurrence(task, now) {
  const today = lonYMD(now);
  const [Y, M] = today.split("-").map(Number);
  const hm = /^([01]\d|2[0-3]):[0-5]\d$/.test(task.due_time || "") ? task.due_time : "17:00";
  let periodKey, startYMD, dueYMD;
  const pad = n => String(n).padStart(2, "0");
  switch (task.recurrence) {
    case "weekly": {
      const mon = mondayOf(today); periodKey = "W:" + mon; startYMD = mon;
      const dow = Math.min(7, Math.max(1, Number(task.due_dow) || 5));
      dueYMD = addDaysYMD(mon, dow - 1); break;
    }
    case "monthly": {
      const ym = today.slice(0, 7); periodKey = "M:" + ym; startYMD = ym + "-01";
      dueYMD = ym + "-" + pad(clampDom(task.due_dom)); break;
    }
    case "quarterly": {
      const q = Math.floor((M - 1) / 3), qMonth = q * 3 + 1;
      periodKey = "Q:" + Y + "-" + (q + 1); startYMD = `${Y}-${pad(qMonth)}-01`;
      dueYMD = `${Y}-${pad(qMonth)}-${pad(clampDom(task.due_dom))}`; break;
    }
    case "yearly": {
      periodKey = "Y:" + Y; startYMD = `${Y}-01-01`;
      const mm = Math.min(12, Math.max(1, Number(task.due_month) || 1));
      dueYMD = `${Y}-${pad(mm)}-${pad(clampDom(task.due_dom))}`; break;
    }
    case "once": {
      const dd = task.due_date || today; periodKey = "once"; startYMD = (task.created_at || dd).slice(0, 10); dueYMD = dd; break;
    }
    default: { periodKey = today; startYMD = today; dueYMD = today; }   // daily
  }
  return { periodKey, dueAt: lonToISO(dueYMD, hm), startAt: lonToISO(startYMD, "00:00") };
}

function parseAssignees(t) { try { const a = JSON.parse(t.assignees || "[]"); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } }

async function autoDone(env, tid, task, user, startAt) {
  if (!task.auto_match) return false;
  try {
    const row = await env.DB.prepare(
      "SELECT 1 FROM audit_log WHERE tenant_id=? AND username=? AND path LIKE ? AND at>=? AND status<400 LIMIT 1"
    ).bind(tid, user, "%" + task.auto_match + "%", startAt).first();
    return !!row;
  } catch { return false; }
}

// Status of one task for one user in its current occurrence.
async function statusFor(env, tid, task, user, now, doneMap) {
  const occ = occurrence(task, now);
  const manual = doneMap ? doneMap[task.id + "|" + user + "|" + occ.periodKey] : await env.DB.prepare(
    "SELECT done_at FROM admin_task_done WHERE tenant_id=? AND task_id=? AND username=? AND period_key=?"
  ).bind(tid, task.id, user, occ.periodKey).first().then(r => r && r.done_at);
  let doneAt = manual || null, auto = false;
  if (!doneAt && await autoDone(env, tid, task, user, occ.startAt)) { doneAt = "auto"; auto = true; }
  const done = !!doneAt;
  return { periodKey: occ.periodKey, dueAt: occ.dueAt, done, auto, doneAt: auto ? null : doneAt, overdue: !done && Date.now() > Date.parse(occ.dueAt) };
}

function shapeTask(t) {
  return {
    id: t.id, title: t.title, detail: t.detail || "", assignees: parseAssignees(t),
    recurrence: t.recurrence, dueTime: t.due_time || "17:00", dueDow: t.due_dow || null,
    dueDom: t.due_dom || null, dueMonth: t.due_month || null, dueDate: t.due_date || "",
    area: t.area || "", autoMatch: t.auto_match || "", active: t.active !== 0,
    areaLabel: (AREA_BY_KEY[t.area || ""] || {}).label || "",
    areaPage: (AREA_BY_KEY[t.area || ""] || {}).page || "",
    createdBy: t.created_by || "",
  };
}

export async function handle(request, env, ctx, url, sess) {
  if (!sess) return error("Not authenticated", 401, env, request);
  const tid = sess.tenantId;
  const me = sess.user.username;
  const method = request.method.toUpperCase();
  const sub = url.pathname.replace(/^\/tasks(?=\/|$)/, "") || "/";
  await ensureTables(env);

  const isFull = async () => (await permissionsFor(env, tid, me)).FullAccess === "Yes";
  const activeTasks = async () => (await env.DB.prepare("SELECT * FROM admin_tasks WHERE tenant_id=? AND active=1").bind(tid).all()).results || [];

  // ── My tasks (any session) ────────────────────────────────────────────────
  if (sub === "/mine" && method === "GET") {
    const now = new Date();
    const mine = (await activeTasks()).filter(t => parseAssignees(t).includes(me));
    const out = [];
    for (const t of mine) {
      const st = await statusFor(env, tid, t, me, now);
      out.push({ ...shapeTask(t), status: st });
    }
    out.sort((a, b) => (a.status.done - b.status.done) || (new Date(a.status.dueAt) - new Date(b.status.dueAt)));
    return json({ ok: true, tasks: out }, {}, env, request);
  }

  // ── Attention counts for me (drives the hub stat + badge) ─────────────────
  if (sub === "/attention" && method === "GET") {
    const now = new Date();
    const mine = (await activeTasks()).filter(t => parseAssignees(t).includes(me));
    let outstanding = 0, overdue = 0;
    for (const t of mine) { const st = await statusFor(env, tid, t, me, now); if (!st.done) { outstanding++; if (st.overdue) overdue++; } }
    return json({ ok: true, outstanding, overdue, total: mine.length }, {}, env, request);
  }

  // ── Tick / untick my current occurrence ───────────────────────────────────
  if (sub === "/complete" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const id = String(b.id || "");
    const t = await env.DB.prepare("SELECT * FROM admin_tasks WHERE tenant_id=? AND id=?").bind(tid, id).first();
    if (!t) return error("Task not found", 404, env, request);
    if (!parseAssignees(t).includes(me)) return error("This task isn't assigned to you.", 403, env, request);
    const occ = occurrence(t, new Date());
    if (b.undo) {
      await env.DB.prepare("DELETE FROM admin_task_done WHERE tenant_id=? AND task_id=? AND username=? AND period_key=?").bind(tid, id, me, occ.periodKey).run();
    } else {
      await env.DB.prepare(
        "INSERT INTO admin_task_done (tenant_id, task_id, username, period_key, done_at, done_by) VALUES (?,?,?,?,?,?) " +
        "ON CONFLICT(task_id, username, period_key) DO UPDATE SET done_at=excluded.done_at"
      ).bind(tid, id, me, occ.periodKey, new Date().toISOString(), me).run();
    }
    return json({ ok: true }, {}, env, request);
  }

  // ── Meta: areas + recurrence options (FullAccess, for the admin page) ──────
  if (sub === "/meta" && method === "GET") {
    if (!(await isFull())) return error("Forbidden", 403, env, request);
    return json({ ok: true, areas: TASK_AREAS, recurrence: RECURRENCE }, {}, env, request);
  }

  // ── Admin: every task + per-assignee status + access flags ────────────────
  if (sub === "/admin" && method === "GET") {
    if (!(await isFull())) return error("Forbidden", 403, env, request);
    const now = new Date();
    const { results: rows } = await env.DB.prepare("SELECT * FROM admin_tasks WHERE tenant_id=? ORDER BY created_at DESC").bind(tid).all();
    // Preload permissions for every assignee once.
    const users = new Set(); for (const t of rows || []) parseAssignees(t).forEach(u => users.add(u));
    const permCache = {};
    for (const u of users) permCache[u] = await permissionsFor(env, tid, u);
    const out = [];
    for (const t of rows || []) {
      const assignees = parseAssignees(t);
      const area = t.area || "";
      const people = [];
      for (const u of assignees) {
        const st = t.active ? await statusFor(env, tid, t, u, now) : null;
        const p = permCache[u] || {};
        const hasAccess = !area || p.FullAccess === "Yes" || p[area] === "Yes";
        people.push({ username: u, status: st, hasAccess });
      }
      out.push({ ...shapeTask(t), people, areaLabel: (AREA_BY_KEY[area] || {}).label || area });
    }
    return json({ ok: true, tasks: out, areas: TASK_AREAS }, {}, env, request);
  }

  // ── Admin: create / update a task ─────────────────────────────────────────
  if (sub === "/save" && method === "POST") {
    if (!(await isFull())) return error("Forbidden", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const title = String(b.title || "").trim();
    if (!title) return error("A title is required.", 400, env, request);
    const recurrence = RECURRENCE.includes(b.recurrence) ? b.recurrence : "daily";
    const assignees = (Array.isArray(b.assignees) ? b.assignees : []).map(u => String(u || "").trim()).filter(Boolean);
    if (!assignees.length) return error("Pick at least one person.", 400, env, request);
    const area = AREA_BY_KEY[String(b.area || "")] ? String(b.area) : "";
    // auto_match: use the area's default trigger unless the caller overrides,
    // and only when auto-complete is on (default on when an area is linked).
    const autoMatch = b.autoComplete === false ? "" : (b.autoMatch != null ? String(b.autoMatch) : ((AREA_BY_KEY[area] || {}).auto || ""));
    const now = new Date().toISOString();
    const dueTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(b.dueTime || "") ? b.dueTime : "17:00";
    const id = String(b.id || "") || crypto.randomUUID();
    const existing = b.id ? await env.DB.prepare("SELECT created_at, created_by FROM admin_tasks WHERE tenant_id=? AND id=?").bind(tid, id).first() : null;
    await env.DB.prepare(`INSERT INTO admin_tasks
      (id, tenant_id, title, detail, assignees, recurrence, due_time, due_dow, due_dom, due_month, due_date, area, auto_match, active, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, detail=excluded.detail, assignees=excluded.assignees,
        recurrence=excluded.recurrence, due_time=excluded.due_time, due_dow=excluded.due_dow, due_dom=excluded.due_dom,
        due_month=excluded.due_month, due_date=excluded.due_date, area=excluded.area, auto_match=excluded.auto_match,
        active=excluded.active, updated_at=excluded.updated_at`)
      .bind(id, tid, title, String(b.detail || "").slice(0, 2000), JSON.stringify(assignees), recurrence, dueTime,
        b.dueDow != null ? Number(b.dueDow) : null, b.dueDom != null ? Number(b.dueDom) : null,
        b.dueMonth != null ? Number(b.dueMonth) : null, b.dueDate ? String(b.dueDate).slice(0, 10) : null,
        area, autoMatch, b.active === false ? 0 : 1,
        (existing && existing.created_by) || me, (existing && existing.created_at) || now, now).run();
    // Notify newly-assigned people (best effort).
    if (ctx && ctx.waitUntil) ctx.waitUntil(Promise.all(assignees.map(u =>
      sendToUser(env, tid, u, { title: "New task assigned", body: title, url: "/my-tasks.html", tag: "task" }).catch(() => {}))));
    return json({ ok: true, id }, {}, env, request);
  }

  // ── Admin: delete a task (+ its completion rows) ──────────────────────────
  if (sub === "/delete" && method === "POST") {
    if (!(await isFull())) return error("Forbidden", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const id = String(b.id || "");
    await env.DB.prepare("DELETE FROM admin_tasks WHERE tenant_id=? AND id=?").bind(tid, id).run();
    await env.DB.prepare("DELETE FROM admin_task_done WHERE tenant_id=? AND task_id=?").bind(tid, id).run();
    return json({ ok: true }, {}, env, request);
  }

  // ── Admin: grant an area permission to a user (careful — full "Yes") ──────
  if (sub === "/grant" && method === "POST") {
    if (!(await isFull())) return error("Forbidden", 403, env, request);
    const b = await request.json().catch(() => ({}));
    const username = String(b.username || "").trim();
    const permission = String(b.permission || "").trim();
    if (!username || !AREA_BY_KEY[permission] || !permission) return error("username and a valid area permission are required.", 400, env, request);
    await env.DB.prepare(
      "INSERT INTO user_permissions (username, permission, value, tenant_id) VALUES (?,?,?,?) " +
      "ON CONFLICT(username, permission) DO UPDATE SET value=excluded.value"
    ).bind(username, permission, 1, tid).run();
    return json({ ok: true, note: "Granted. The user must log out and back in for it to take effect." }, {}, env, request);
  }

  return error("Unknown tasks route", 404, env, request);
}

// ── Daily reminder push (called from the cron) ───────────────────────────────
// Once a day (~08:00 London), push each user who still has outstanding tasks.
export async function sweepTaskReminders(env, now = new Date()) {
  const lonHour = Number(now.toLocaleString("en-GB", { timeZone: "Europe/London", hour: "2-digit", hour12: false }).replace(/\D/g, "")) || 0;
  if (lonHour !== 8) return { ran: false, reason: "not-8am" };
  const today = lonYMD(now);
  let tenants = [];
  try { tenants = ((await env.DB.prepare("SELECT DISTINCT tenant_id FROM admin_tasks WHERE active=1").all()).results || []).map(r => r.tenant_id); }
  catch { return { ran: false, reason: "no-table" }; }
  const out = [];
  for (const tid of tenants) {
    const key = `tasks:reminded:${tid}`;
    let slots = [];
    try { const row = await env.DB.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(tid, key).first(); if (row && row.value) slots = JSON.parse(row.value) || []; } catch {}
    if (slots.includes(today)) { out.push({ tid, skipped: true }); continue; }
    const { results: rows } = await env.DB.prepare("SELECT * FROM admin_tasks WHERE tenant_id=? AND active=1").bind(tid).all();
    const perUser = {};
    for (const t of rows || []) {
      for (const u of parseAssignees(t)) {
        const st = await statusFor(env, tid, t, u, now);
        if (!st.done) { perUser[u] = perUser[u] || { n: 0, overdue: 0 }; perUser[u].n++; if (st.overdue) perUser[u].overdue++; }
      }
    }
    for (const [u, c] of Object.entries(perUser)) {
      const body = c.overdue ? `You have ${c.n} task${c.n === 1 ? "" : "s"} due (${c.overdue} overdue).` : `You have ${c.n} task${c.n === 1 ? "" : "s"} due today.`;
      await sendToUser(env, tid, u, { title: "Your tasks", body, url: "/my-tasks.html", tag: "tasks-daily" }).catch(() => {});
    }
    slots.push(today); slots = slots.slice(-14);
    await env.DB.prepare("INSERT INTO app_config (tenant_id,key,value) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(tid, key, JSON.stringify(slots)).run();
    out.push({ tid, reminded: Object.keys(perUser).length });
  }
  return { ran: true, tenants: out };
}
