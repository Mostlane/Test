// ============================================================================
// Mostlane Portal — single consolidated Cloudflare Worker
// ----------------------------------------------------------------------------
// Replaces these 19 separate Workers with ONE API + ONE D1 database:
//
//   login              ckeck-in-out        odd-water-f78a (Hours)
//   mostlane-users     mostlane-sites      average-hours
//   userdevicekv       mostlane-assets     labourhours
//   mostlane-holidays  mostlane-sla        timesheet
//   vehicles           mostlane-po         mostlane-labour-api
//   vehicles-fuel      mostlane-pos        projects-ml-portal
//   mostlane-api
//
// Each domain lives in src/routes/*. Routes already wired against D1 are
// marked DONE; routes awaiting your existing Worker code are marked STUB —
// send me that Worker's source and I'll port its logic faithfully into D1.
// ============================================================================

import { preflight, error, json } from "./lib/http.js";
import { requireSession } from "./lib/auth.js";
import * as auth from "./routes/auth.js";          // DONE  (login, logout, me, refresh, passwords)
import * as users from "./routes/users.js";        // DONE  (/user, /users, admin management)
import * as devices from "./routes/devices.js";    // DONE  (device lock)
import * as holidays from "./routes/holidays.js";  // DONE  (replaces mostlane-holidays)
import * as assets from "./routes/assets.js";      // DONE  (replaces mostlane-assets)
import * as sla from "./routes/sla.js";            // DONE  (replaces mostlane-sla)
import * as sites from "./routes/sites.js";        // DONE  (replaces mostlane-sites + adds customers)
import * as portal from "./routes/portal.js";      // DONE  (settings, on-call rota, daily logs)
import * as sitelog from "./routes/sitelog.js";    // DONE  (portal↔SiteLog bridge: launch token + admin proxy → local module or remote)
import * as sitelogApi from "./routes/sitelog-api.js"; // DONE  (ported SiteLog backend: scanner API on api.site-log.co.uk + daily auto-close)
import { handleInboundEmail } from "./routes/emailjob.js"; // DONE  (Cloudflare Email Routing → job intake, replaces the Zapier email zap)
import * as office from "./routes/office.js";      // DONE  (office clock in/out + weekly timesheet)
import * as keys from "./routes/keys.js";           // DONE  (key register: sign out/in)
import * as theme from "./routes/theme.js";         // DONE  (per-user personalisation)
import * as hs from "./routes/hs.js";               // DONE  (H&S documents: inductions, permits, RAMS, incidents)
import * as vancheck from "./routes/vancheck.js"; // DONE  (weekly van checks — replaces Jotform walkaround)
import * as stats from "./routes/stats.js";        // DONE  (Full-access portal stats dashboard)
import * as hrdocs from "./routes/hrdocs.js";      // DONE  (staff personal + company documents)
import * as privacy from "./routes/privacy.js";    // DONE  (UK GDPR export + erasure)
import * as fleet from "./routes/fleet.js";        // DONE  (fleet reports: save/list/open + driver map)
import * as push from "./routes/push.js";          // DONE  (web push subscriptions + sending)
import * as timesheets from "./routes/timesheets.js"; // DONE (engineer timesheets + self-employed invoices)
import * as messages from "./routes/messages.js";  // DONE  (office ↔ engineer messages — Inbox)
import * as memos from "./routes/memos.js";        // DONE  (company memos: draft/send/sign, filed to My Documents)
import * as documents from "./routes/documents.js"; // DONE  (signable documents: library → send to chosen users → sign → filed to My Documents)
import * as costing from "./routes/costing.js";    // DONE  (site register, labour ledger, job costing, exceptions)
import * as compliance from "./routes/compliance.js"; // DONE (Southern Co-op compliance certs: R2 + D1, per store+type)
import * as chapplins from "./routes/chapplins.js";   // DONE (Chapplins customer: site tenants current/previous + directory)
import * as po from "./routes/po.js";              // DONE  (Purchase Orders — migrated in-portal; data still in PO_DB)
import * as cctv from "./routes/cctv.js";          // DONE  (CCTV Wall — DVR snapshot proxy)
import * as tasks from "./routes/tasks.js";        // DONE  (recurring admin task list + auto-complete)
import * as certs from "./routes/certs.js";        // DONE  (portal-native EM/PAT certificates: draft → office review → file to compliance)
import * as programmes from "./routes/programmes.js"; // DONE (job programmes: builder, revisions, client share links + suggestions)
import * as projects from "./routes/projects-api.js"; // DONE (projects: wizard record + project-site link + docs + costing spine)
import * as health from "./routes/health.js";      // DONE  (self-monitoring watchdog: probes, error capture, slow-endpoint tracking, alerts)
import * as tuya from "./routes/tuya.js";          // DONE  (yard gate: Tuya Cloud open command + left-open watch)
import * as fra from "./routes/fra.js";            // DONE  (FRA works tracker: office post-completion disposition + quote copy)
import * as workever from "./routes/workever.js";  // DONE  (Workever sync: reconcile portal jobs/archive to Workever, browser-driven)
import * as statuscomms from "./routes/statuscomms.js"; // DONE  (customer status-change emails + public reschedule flow)
import { sendWeeklyReminders } from "./routes/vancheck.js"; // cron: weekly van-check reminders
import { sweepTaskReminders } from "./routes/tasks.js";     // cron: daily task reminders
import { sweepTimesheetReminders } from "./routes/timesheets.js"; // cron: timesheet deadline reminder

// ── Route table: [method, pathPrefix, handler] ──────────────────────────────
// Longest prefix wins; handlers receive (request, env, ctx, url).
const ROUTES = [
  ["*", "/auth",       auth.handle],
  ["*", "/admin/login-history", auth.loginHistory],
  ["*", "/user",       users.handle],   // /user and /users
  ["*", "/onboard",    users.handle],   // public self-registration (Pending)
  ["*", "/hs-plan-config", users.handle],
  ["*", "/po-config",  users.handle],
  ["*", "/device",     devices.handle],
  ["*", "/holiday",    holidays.handle],
  ["*", "/asset",      assets.handle],   // /assets, /asset/*, /asset-image, /asset-thumb
  ["*", "/transfer",   assets.handle],   // /transfer, /transfer-log
  ["*", "/upload-asset-image", assets.handle],
  ["*", "/upload-asset-thumb", assets.handle],
  ["*", "/delete-asset-image", assets.handle],
  ["*", "/sla/workever", workever.handle], // Workever sync (longest prefix wins over /sla)
  ["*", "/sla",        sla.handle],
  ["*", "/stats",      stats.handle],
  ["*", "/staff",      hrdocs.handle],   // staff personal + company documents
  ["*", "/privacy",    privacy.handle],  // GDPR data export + erasure
  ["*", "/fleet",      fleet.handle],     // fleet reports + driver mapping
  ["*", "/push",       push.handle],      // web push subscriptions + test send
  ["*", "/messages",   messages.handle],  // office ↔ engineer messages (Inbox)
  ["*", "/memos",      memos.handle],     // company memos (draft/send/sign)
  ["*", "/documents",  documents.handle], // signable documents (library → send → sign → filed to My Documents)
  ["*", "/ts",         timesheets.handle], // engineer timesheets + invoices + mileage
  ["*", "/get-sites",  sites.handle],
  ["*", "/add-site",   sites.handle],
  ["*", "/update-site", sites.handle],
  ["*", "/delete-site", sites.handle],
  ["*", "/next-project-job-number", sites.handle],
  ["*", "/upload-image", sites.handle],
  ["*", "/customers",  sites.handle],
  ["*", "/import-sites", sites.handle],
  ["*", "/sites",      sites.handle],   // /sites/street-images (bulk imagery)
  ["*", "/sites/register", costing.handle], // master site register (longest prefix wins over /sites)
  ["*", "/ledger",     costing.handle],  // labour ledger (reconciled time)
  ["*", "/costing",    costing.handle],  // per-site labour cost roll-up
  ["*", "/exceptions", costing.handle],  // needs-a-human-eye list
  ["*", "/compliance", compliance.handle], // Southern Co-op compliance certs (R2 + D1)
  ["*", "/chapplins",  chapplins.handle], // Chapplins customer: site tenants (current/previous) + directory
  ["*", "/settings",   portal.handle],
  ["*", "/oncall",     portal.handle],
  ["*", "/daily-logs", portal.handle],
  ["*", "/notify",     portal.handle],  // notification audit log
  ["*", "/prefs",      portal.handle],  // per-user cross-device markers
  ["*", "/menu-config", portal.handle], // Full-access menu visibility (shared)
  ["*", "/audit",      portal.handle],  // activity log (page views + viewer)
  ["*", "/sitelog",    sitelog.handle],
  ["*", "/sitelog-launch", sitelog.handle],
  ["*", "/office",     office.handle],   // office clock in/out + weekly timesheet
  ["*", "/key",        keys.handle],     // /keys, /key/* (key register)
  ["*", "/theme",      theme.handle],    // per-user colour theme + background
  ["*", "/hs/",        hs.handle],       // H&S documents hub (inductions, permits, RAMS, incidents)
  ["*", "/vancheck",   vancheck.handle], // weekly van checks (form, grid, deadline badges)
  ["*", "/po",         po.handle],       // Purchase Orders (in-portal; reads/writes PO_DB). NB /po-config above wins by longest-prefix.
  ["*", "/cctv",       cctv.handle],     // CCTV Wall: DVR site config + snapshot proxy
  ["*", "/tasks",      tasks.handle],    // recurring admin task list (deadlines, auto-complete, per-user stat)
  ["*", "/certs",      certs.handle],    // portal-native EM/PAT certificates (draft → office review → file to compliance)
  ["*", "/prog",       programmes.handle], // job programmes (builder, revisions, client share links)
  ["*", "/projects",   projects.handle],   // Projects: list (longest prefix wins over /project)
  ["*", "/project",    projects.handle],   // Projects: create/get/update/link/todo/docs
  ["*", "/health/",    health.handle],     // self-monitoring watchdog (/health/status, /health/events, /health/run). NB bare /health is the liveness check above.
  ["*", "/comms",      statuscomms.handle], // customer status-email config + reschedule inbox (admin)
  ["*", "/customer",   statuscomms.handle], // public: customer reschedule flow (token-verified)
  ["*", "/tuya",       tuya.handle],        // yard gate: Tuya Cloud open command + gate-open state
  ["*", "/fra",        fra.handle],          // FRA works tracker: office follow-up disposition + quote copy
  // Excluded for now (separate / later systems):
  // Hours/Timesheets, Labour Planning, Check-in/out, Projects.
];

const worker = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ── SiteLog scanner API (host-dispatch) ────────────────────────────────
    // The ported SiteLog backend answers the scanner's own domain. Inert until
    // the api.site-log.co.uk custom domain is moved onto this worker (Stage 2);
    // before that this worker never receives that host, so it's a no-op. The
    // ported handler does its own CORS/preflight for the site-log.co.uk origins.
    // api2.site-log.co.uk is a temporary PROVE-IT host: point it at this worker
    // (custom domain) to confirm SiteLog serves correctly here before cutting the
    // live api.* domain over. Harmless to leave — nothing references it.
    if (url.hostname === "api.site-log.co.uk" || url.hostname === "api2.site-log.co.uk") {
      return sitelogApi.handle(request, env, ctx);
    }

    if (request.method === "OPTIONS") return preflight(env, request);

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ ok: true, service: "mostlane-portal", time: new Date().toISOString() }, {}, env, request);
    }

    // ── Auth gate ──────────────────────────────────────────────────────────
    // Every endpoint requires a valid session token EXCEPT the public ones
    // below. This closes the "no token needed" hole on the data APIs while
    // leaving open the routes that browsers / <img> tags / native deep-links
    // hit without an Authorization header.
    let sess = null;
    if (!isPublic(request.method, url.pathname)) {
      sess = await requireSession(env, request);
      if (!sess) return error("Not authenticated", 401, env, request);
    }

    // ── Batch: many GETs in ONE round trip (home dashboard) ────────────────
    // POST /batch { paths: ["/vancheck/week", "/sla/jobs", …] } dispatches each
    // path through the normal route table with the SAME session, so every
    // handler's own permission checks still run. GET-only, capped, fail-soft
    // per path (a failing area returns {error} without sinking the rest).
    if (url.pathname === "/batch" && request.method === "POST") {
      if (!sess) return error("Not authenticated", 401, env, request);
      const b = await request.json().catch(() => ({}));
      const paths = (Array.isArray(b.paths) ? b.paths : []).map(String).filter(p => p.startsWith("/")).slice(0, 20);
      const results = {};
      await Promise.all(paths.map(async p => {
        try {
          const subUrl = new URL(url.origin + p);
          if (subUrl.pathname === "/batch") throw new Error("no nesting");
          const m = ROUTES
            .filter(([, prefix]) => subUrl.pathname === prefix || subUrl.pathname.startsWith(prefix + "/") || subUrl.pathname.startsWith(prefix))
            .sort((a2, b2) => b2[1].length - a2[1].length)[0];
          if (!m) { results[p] = { error: "Not found" }; return; }
          const subReq = new Request(subUrl.toString(), { method: "GET", headers: request.headers });
          const resp = await m[2](subReq, env, ctx, subUrl, sess);
          results[p] = await resp.json().catch(() => ({ error: "bad response" }));
        } catch (e) { results[p] = { error: String(e && e.message || e) }; }
      }));
      return json({ ok: true, results }, {}, env, request);
    }

    // Dispatch by longest matching prefix
    const match = ROUTES
      .filter(([, prefix]) => url.pathname === prefix || url.pathname.startsWith(prefix + "/") || url.pathname.startsWith(prefix))
      .sort((a, b) => b[1].length - a[1].length)[0];

    if (!match) return error("Not found: " + url.pathname, 404, env, request);

    // Keep a copy of the body for the audit trail (the handler consumes the original).
    const auditClone = sess && AUDIT_METHODS.includes(request.method.toUpperCase()) ? request.clone() : null;

    const reqT0 = Date.now();
    try {
      // Handlers receive the verified session (with its tenantId) as the 5th
      // argument. For public routes sess is null and the handler resolves the
      // tenant from the request host via resolveTenantId().
      const resp = await match[2](request, env, ctx, url, sess);
      // A handler may attach a ready-made human "what changed" line (e.g. a
      // before → after rename) via the X-Audit-Note response header; the audit
      // trail uses it verbatim instead of the raw request body fields.
      const auditNote = (resp && resp.headers && resp.headers.get("X-Audit-Note")) || "";
      auditAction(env, ctx, sess, request, url, resp.status, auditClone, auditNote);
      // Watchdog: a response the handler completed but which was SLOW is worth
      // knowing about (efficiency). The health endpoints are excluded so the
      // dashboard's own polling can't pollute the "slowest endpoints" list.
      const dur = Date.now() - reqT0;
      if (dur > health.SLOW_MS && !url.pathname.startsWith("/health/")) {
        ctx.waitUntil(health.recordEvent(env, sess ? sess.tenantId : 1, {
          kind: "slow", endpoint: request.method + " " + url.pathname, message: "slow response", status: resp.status, ms: dur,
        }).catch(() => {}));
      }
      return resp;
    } catch (err) {
      console.error("Handler error:", err);
      auditAction(env, ctx, sess, request, url, 500, auditClone, "");
      // Watchdog: capture every 500 a real user hits — the primary "a bug is
      // live right now" signal (surfaced + alerted on health.html).
      ctx.waitUntil(health.recordEvent(env, sess ? sess.tenantId : 1, {
        kind: "error", endpoint: request.method + " " + url.pathname,
        message: String(err && err.message || err), status: 500, ms: Date.now() - reqT0,
      }).catch(() => {}));
      return error("Server error: " + err.message, 500, env, request);
    }
  },

  // ── Cron trigger: scheduled push reminders ────────────────────────────────
  // Set an HOURLY Cron Trigger on the worker (dashboard → Settings → Triggers):
  //   0 * * * *   → sendWeeklyReminders self-gates to the right moments: Monday
  //                 07:00 UK, plus a chase within 2h before the portal deadline.
  //                 (Hourly so the dynamic chase tracks whatever due-time is set;
  //                 each nudge is deduped per week — no spam.)
  async scheduled(event, env, ctx) {
    // The cron fires every 5 minutes. The release sweep runs EVERY tick so timed
    // job releases + the 5pm-day-before nudge push within ~5 min; the heavier
    // hourly work is gated to the top of the hour to keep its old cadence.
    ctx.waitUntil(sla.sweepJobReleases(env, 1).catch(e => console.error("scheduled job-release sweep:", e)));
    // Fallback jobs — self-gates on London time to warn the office (15:30 & 18:00)
    // about field engineers with no job for the next working day, then auto-assign
    // each still-empty engineer their configured fallback at 19:00 (Fri covers Mon).
    ctx.waitUntil(sla.sweepFallbacks(env, 1).catch(e => console.error("scheduled fallback sweep:", e)));
    // Watchdog probes run EVERY tick (every 5 min) — cheap D1/R2 liveness touches
    // that keep health.html fresh and push the owner (deduped) the moment a probe
    // fails or server errors spike. Fails soft; never blocks the other cron work.
    ctx.waitUntil(health.runHealthChecks(env, 1).catch(e => console.error("scheduled health probe:", e)));
    // Yard gate left-open watch — polls the gate's Tuya sensor and pushes an
    // alert if it's been open past the configured threshold. Self-gates: does
    // nothing until the Tuya secrets AND a state device/code are configured.
    ctx.waitUntil(tuya.checkGateLeftOpen(env, 1).catch(e => console.error("scheduled yard-gate watch:", e)));
    // On-hold approvals block the engineer's next job, so chase SLA admins every
    // ~10 minutes until it's dealt with (push-only — the bell alert already exists).
    if (new Date().getUTCMinutes() % 10 < 5) {
      ctx.waitUntil(sla.remindPendingHolds(env, 1).catch(e => console.error("scheduled hold reminder:", e)));
    }
    if (new Date().getUTCMinutes() < 5) {
      // Data-integrity sweep — the cross-area "does everything join up?" catalogue
      // (jobs↔sites, assignments↔users↔vehicles, compliance↔sites …). Its
      // correlated NOT-EXISTS joins are the heaviest read source in the whole
      // worker (compliance_stores × sites alone ≈ 600k row-reads), so it runs
      // ONCE WEEKLY — Sunday ~03:00 UTC, NOT hourly/daily. Integrity drifts
      // slowly, so weekly is ample and keeps D1 row-reads far inside the
      // free-tier limit. The lightweight liveness probes (runHealthChecks) still
      // run every 5 min and are what actually catch + alert on an outage. Admins
      // can run the full catalogue on demand via the health page → /health/run.
      { const d = new Date(); if (d.getUTCDay() === 0 && d.getUTCHours() === 3) {
        ctx.waitUntil(health.runIntegrityChecks(env, 1).catch(e => console.error("scheduled integrity sweep:", e)));
      } }
      // Daily chase (~08:00 London, deduped) for holiday requests + equipment
      // transfers still outstanding.
      ctx.waitUntil(remindDailyApprovals(env).catch(e => console.error("scheduled daily approvals:", e)));
      ctx.waitUntil(sendWeeklyReminders(env).catch(e => console.error("scheduled van-check reminder:", e)));
      // P4: pull recent SiteLog visits and reconcile them into SLA sessions —
      // close sessions a scan-out ended, and feed project scans into the
      // engineer timesheet. Idempotent; fails soft when SiteLog is unset/down.
      ctx.waitUntil(costing.reconcileSitelogSessions(env, 1).catch(e => console.error("scheduled sitelog reconcile:", e)));
      // Daily task reminder — self-gates to ~08:00 London, deduped per day.
      ctx.waitUntil(sweepTaskReminders(env).catch(e => console.error("scheduled task reminder:", e)));
      // Timesheet deadline reminder — self-gates to the ~3h before the deadline.
      ctx.waitUntil(sweepTimesheetReminders(env).catch(e => console.error("scheduled timesheet reminder:", e)));
      // SiteLog auto-close of open visits (was the standalone worker's daily
      // cron). Idempotent — only closes prior-day still-open visits — so it's
      // safe running hourly and safe alongside the old worker's cron until the
      // scanner is cut over. Only runs once the SiteLog DB is bound.
      if (env.SITELOG_DB) ctx.waitUntil(sitelogApi.sweepAutoClose(env).catch(e => console.error("scheduled sitelog auto-close:", e)));
    }
  },

  // ── Inbound email → job (Cloudflare Email Routing) ─────────────────────────
  // Point a routed address (e.g. jobs@<a-mostlane-domain-on-cloudflare>) at this
  // worker in the dashboard (Email → Email Workers). Forward job emails there
  // from Outlook. Each one is parsed and logged as a job via /sla/inbound. The
  // handler NEVER throws (a thrown email handler would bounce the mail).
  async email(message, env, ctx) {
    try {
      await handleInboundEmail(message, env, ctx, worker.fetch);
    } catch (e) {
      console.error("email handler:", e && e.message);
    }
  },
};

export default worker;

// Once-a-day (~08:00 London) re-nudge for outstanding holiday requests + equipment
// transfers, deduped per day so a retry can't double-send.
async function remindDailyApprovals(env) {
  const now = new Date();
  const lonHour = Number(now.toLocaleString("en-GB", { timeZone: "Europe/London", hour: "2-digit", hour12: false }).replace(/\D/g, "")) || 0;
  if (lonHour !== 8) return;
  const today = now.toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  const key = "approvals:dailyReminded:1";
  try {
    const row = await env.DB.prepare("SELECT value FROM app_config WHERE tenant_id=1 AND key=?").bind(key).first();
    if (row && row.value === today) return;   // already chased today
    await env.DB.prepare("INSERT INTO app_config (tenant_id, key, value) VALUES (1,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(key, today).run();
  } catch { /* if the marker fails we just risk a duplicate nudge — harmless */ }
  await holidays.remindPendingHolidays(env, 1).catch(() => {});
  await assets.remindPendingTransfers(env, 1).catch(() => {});
}

// ── Audit trail ───────────────────────────────────────────────────────────────
// Every state-changing request (POST/PUT/PATCH/DELETE) by a logged-in user is
// recorded: who, what, a snippet of the payload, the outcome and the exact
// time. Reads (GET) aren't logged here — page views arrive separately via
// /audit/pageview. Chatty housekeeping endpoints are excluded.
const AUDIT_METHODS = ["POST", "PUT", "PATCH", "DELETE"];
const AUDIT_SKIP = [
  "/notify/log",          // the notification log logging itself
  "/notify/feed",         // the bell feed (read markers churn on every open)
  "/prefs",               // seen/snooze marker churn
  "/device/check-device", // runs on every page load — a check, not an action
  "/audit",               // this system's own endpoints
  "/auth/refresh",        // token rotation, not a user action
  "/upload-asset-thumb",  // background thumbnail backfill, not a user action
];
// One-time migration: give audit_log a `ref` column (the page an action came
// from). Guarded so it runs at most once per isolate.
let AUDIT_MIGRATED = false;
async function ensureAuditCols(env) {
  if (AUDIT_MIGRATED) return;
  try { await env.DB.prepare("ALTER TABLE audit_log ADD COLUMN ref TEXT").run(); } catch { /* already there */ }
  AUDIT_MIGRATED = true;
}

function auditAction(env, ctx, sess, request, url, status, clone, note) {
  try {
    if (!sess) return;
    const m = request.method.toUpperCase();
    if (!AUDIT_METHODS.includes(m)) return;
    const p = url.pathname;
    if (AUDIT_SKIP.some(s => p === s || p.startsWith(s + "/"))) return;
    // Which portal page the action was fired from (so the log can say "on
    // Vehicles"). Taken from the Referer; falls back to blank for API-only calls.
    let ref = "";
    try {
      const rf = request.headers.get("Referer") || request.headers.get("Referrer") || "";
      const mfile = rf && new URL(rf).pathname.match(/[^/]+\.html$/);
      if (mfile) ref = mfile[0];
    } catch { /* no/invalid referer */ }
    ctx.waitUntil((async () => {
      await ensureAuditCols(env);
      let detail = "";
      // A handler-supplied note (a human "before → after" line) wins over the raw
      // body-field snippet — it's already the readable version.
      if (note) { try { detail = decodeURIComponent(note); } catch { detail = String(note); } detail = detail.slice(0, 400); }
      try {
        const ct = (clone && clone.headers.get("Content-Type")) || "";
        if (!detail && clone && ct.includes("application/json")) {
          const b = await clone.json();
          // Human-meaningful fields to surface ("what did they add/change") —
          // never message bodies or secrets. Longer text is trimmed.
          const KEYS = ["id", "assetId", "assetID", "username", "u", "to", "toUser", "keyID",
            "label", "name", "Username", "start", "end", "status", "type", "action", "page",
            "reg", "description", "title", "date", "amount", "cost", "price", "priority",
            "category", "cat", "site", "siteName", "week", "litres", "mileage", "miles",
            "value", "note", "reason", "role", "make", "model", "colour", "vin"];
          detail = KEYS.filter(k => b && b[k] !== undefined && b[k] !== null && typeof b[k] !== "object" && String(b[k]) !== "")
            .map(k => k + "=" + String(b[k]).slice(0, 60)).join(" · ").slice(0, 400);
        } else if (!detail && ct.includes("multipart")) {
          detail = "(file upload)";
        }
      } catch { /* body unreadable — log without detail */ }
      const qs = url.search ? decodeURIComponent(url.search).slice(0, 120) : "";
      const res = await env.DB.prepare(
        "INSERT INTO audit_log (username, tenant_id, method, path, detail, status, at, ref) VALUES (?,?,?,?,?,?,?,?)"
      ).bind(sess.user.username, sess.tenantId, m, p + qs, detail, status, new Date().toISOString(), ref).run();
      // Occasional pruning: keep 12 months (all tenants; time-based, tenant-agnostic).
      const rowId = res.meta ? res.meta.last_row_id : 0;
      if (rowId && rowId % 500 === 0) {
        const cutoff = new Date(Date.now() - 365 * 86400000).toISOString();
        await env.DB.prepare("DELETE FROM audit_log WHERE at < ?").bind(cutoff).run();
      }
    })().catch(() => {}));
  } catch { /* auditing must never break the request */ }
}

// Routes reachable WITHOUT a session token.
const PUBLIC_ROUTES = [
  ["POST", "/auth/login"],
  ["POST", "/auth/forgot-password"],
  ["POST", "/auth/reset-password"],
  // Public self-registration form (login page → "Sign up").
  ["POST", "/onboard"],
  // Owner phone-ping for the AI auto-fixer — token-gated in-handler (JOBS_INBOUND_TOKEN).
  ["POST", "/health/notify"],
  // Image bytes are loaded by <img> tags, which can't send an auth header.
  ["GET", "/asset-image"],
  ["GET", "/asset-thumb"],
  // Site documents streamed for the in-app viewer (parity with the public R2
  // URL these already have; adds CORS for fetch-based rendering).
  ["GET", "/sla/site/doc"],
  // Site/job photo thumbnails — signed URL, verified in-handler (like /site/doc).
  ["GET", "/sla/site/thumb"],
  // Staff documents streamed for the in-app viewer — access-gated by the
  // signed URL (see filesign.js), so being "public" only means "no session
  // header needed"; an unsigned/expired link is refused inside the handler.
  ["GET", "/staff/doc"],
  // Saved fleet reports opened in a new tab — signed URL, verified in-handler.
  ["GET", "/fleet/report"],
  // Vehicle repair/invoice documents opened in a new tab — signed URL.
  ["GET", "/fleet/vehicle-doc"],
  // Vehicle photos (card cover + gallery/lightbox) — signed URL.
  ["GET", "/fleet/vehicle-photo"],
  // Maintenance-record documents opened in a new tab — signed URL.
  ["GET", "/fleet/maintenance-doc"],
  // Machine-to-machine job intake (Zapier) — JOBS_INBOUND_TOKEN verified in-handler.
  ["POST", "/sla/inbound"],
  ["GET", "/sla/inbound"],   // connection self-check (fingerprint only, no secret)
  // Imported archive job files (photos/signatures/PDFs) — signed URL, verified in-handler.
  ["GET", "/sla/archive-file"],
  // Self-employed invoice PDFs opened in a new tab — signed URL, verified in-handler.
  ["GET", "/ts/invoice-file"],
  // SiteLog scan intake — HMAC-signed with PORTAL_BRIDGE_SECRET, verified in-handler.
  ["POST", "/ledger/scan"],
  // Compliance certificates streamed inline — signed URL, verified in-handler.
  ["GET", "/compliance/file"],
  // EM remedial battery photos streamed for <img> — signed URL, verified in-handler.
  ["GET", "/certs/photo"],
  // Compliance batch import (SharePoint→R2 extractor) — COMPLIANCE_IMPORT_TOKEN
  // verified in-handler. POST /compliance/file = ingest, GET /compliance/has = dedupe.
  // (The handler re-resolves a real session for logged-in admins on these too.)
  ["GET", "/compliance/has"],
  ["POST", "/compliance/file"],
  // DVR camera snapshots loaded by <img> tags — signed URL, verified in-handler.
  ["GET", "/cctv/snapshot"],
  // H&S document attachments (appended to the PDF) streamed for <img>/links —
  // signed URL, verified in-handler.
  ["GET", "/hs/attachment"],
  // Client programme share links (programme-view.html, no portal login) —
  // share token + optional access code verified in-handler; serves only
  // ISSUED revisions, never the working draft.
  ["POST", "/prog/shared/open"],
  ["POST", "/prog/shared/suggest"],
  ["POST", "/prog/shared/export"],   // client PDF download — token+code verified in-handler
  // Project documents streamed for the in-app viewer / new tab — signed URL, verified in-handler.
  ["GET", "/project/doc"],
  // FRA follow-up quote copies streamed inline — signed URL, verified in-handler.
  ["GET", "/fra/quote"],
  // Customer reschedule flow (job-reschedule.html, no login) — signed token verified in-handler.
  ["POST", "/customer/job"],
  ["POST", "/customer/reschedule"],
];

function isPublic(method, pathname) {
  if (PUBLIC_ROUTES.some(([m, p]) => m === method && pathname === p)) return true;
  // SLA job sheet downloads are opened as plain browser links (no header).
  if (method === "GET" && /^\/sla\/jobs\/[^/]+\/export(\.pdf)?$/.test(pathname)) return true;
  return false;
}
