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
import * as sitelog from "./routes/sitelog.js";    // DONE  (server-side proxy to api.site-log.co.uk)
import * as office from "./routes/office.js";      // DONE  (office clock in/out + weekly timesheet)
import * as keys from "./routes/keys.js";           // DONE  (key register: sign out/in)
import * as theme from "./routes/theme.js";         // DONE  (per-user personalisation)
import * as hs from "./routes/hs.js";               // DONE  (H&S documents: inductions, permits, RAMS, incidents)
import * as vancheck from "./routes/vancheck.js"; // DONE  (weekly van checks — replaces Jotform walkaround)
import * as stats from "./routes/stats.js";        // DONE  (Full-access portal stats dashboard)

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
  ["*", "/sla",        sla.handle],
  ["*", "/stats",      stats.handle],
  ["*", "/get-sites",  sites.handle],
  ["*", "/add-site",   sites.handle],
  ["*", "/update-site", sites.handle],
  ["*", "/next-project-job-number", sites.handle],
  ["*", "/upload-image", sites.handle],
  ["*", "/customers",  sites.handle],
  ["*", "/import-sites", sites.handle],
  ["*", "/sites",      sites.handle],   // /sites/street-images (bulk imagery)
  ["*", "/settings",   portal.handle],
  ["*", "/oncall",     portal.handle],
  ["*", "/daily-logs", portal.handle],
  ["*", "/notify",     portal.handle],  // notification audit log
  ["*", "/prefs",      portal.handle],  // per-user cross-device markers
  ["*", "/audit",      portal.handle],  // activity log (page views + viewer)
  ["*", "/sitelog",    sitelog.handle],
  ["*", "/sitelog-launch", sitelog.handle],
  ["*", "/office",     office.handle],   // office clock in/out + weekly timesheet
  ["*", "/key",        keys.handle],     // /keys, /key/* (key register)
  ["*", "/theme",      theme.handle],    // per-user colour theme + background
  ["*", "/hs/",        hs.handle],       // H&S documents hub (inductions, permits, RAMS, incidents)
  ["*", "/vancheck",   vancheck.handle], // weekly van checks (form, grid, deadline badges)
  // Excluded for now (separate / later systems): Purchase Orders,
  // Hours/Timesheets, Labour Planning, Check-in/out, Vehicles,
  // Compliance, Projects.
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

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

    // Dispatch by longest matching prefix
    const match = ROUTES
      .filter(([, prefix]) => url.pathname === prefix || url.pathname.startsWith(prefix + "/") || url.pathname.startsWith(prefix))
      .sort((a, b) => b[1].length - a[1].length)[0];

    if (!match) return error("Not found: " + url.pathname, 404, env, request);

    // Keep a copy of the body for the audit trail (the handler consumes the original).
    const auditClone = sess && AUDIT_METHODS.includes(request.method.toUpperCase()) ? request.clone() : null;

    try {
      // Handlers receive the verified session (with its tenantId) as the 5th
      // argument. For public routes sess is null and the handler resolves the
      // tenant from the request host via resolveTenantId().
      const resp = await match[2](request, env, ctx, url, sess);
      auditAction(env, ctx, sess, request, url, resp.status, auditClone);
      return resp;
    } catch (err) {
      console.error("Handler error:", err);
      auditAction(env, ctx, sess, request, url, 500, auditClone);
      return error("Server error: " + err.message, 500, env, request);
    }
  },
};

// ── Audit trail ───────────────────────────────────────────────────────────────
// Every state-changing request (POST/PUT/PATCH/DELETE) by a logged-in user is
// recorded: who, what, a snippet of the payload, the outcome and the exact
// time. Reads (GET) aren't logged here — page views arrive separately via
// /audit/pageview. Chatty housekeeping endpoints are excluded.
const AUDIT_METHODS = ["POST", "PUT", "PATCH", "DELETE"];
const AUDIT_SKIP = [
  "/notify/log",          // the notification log logging itself
  "/prefs",               // seen/snooze marker churn
  "/device/check-device", // runs on every page load — a check, not an action
  "/audit",               // this system's own endpoints
  "/auth/refresh",        // token rotation, not a user action
  "/upload-asset-thumb",  // background thumbnail backfill, not a user action
];
function auditAction(env, ctx, sess, request, url, status, clone) {
  try {
    if (!sess) return;
    const m = request.method.toUpperCase();
    if (!AUDIT_METHODS.includes(m)) return;
    const p = url.pathname;
    if (AUDIT_SKIP.some(s => p === s || p.startsWith(s + "/"))) return;
    ctx.waitUntil((async () => {
      let detail = "";
      try {
        const ct = (clone && clone.headers.get("Content-Type")) || "";
        if (clone && ct.includes("application/json")) {
          const b = await clone.json();
          const KEYS = ["id", "assetId", "assetID", "username", "u", "to", "toUser", "keyID",
            "label", "name", "Username", "start", "end", "status", "type", "action", "page"];
          detail = KEYS.filter(k => b && b[k] !== undefined && b[k] !== null && typeof b[k] !== "object")
            .map(k => k + "=" + String(b[k]).slice(0, 40)).join(" ").slice(0, 300);
        } else if (ct.includes("multipart")) {
          detail = "(file upload)";
        }
      } catch { /* body unreadable — log without detail */ }
      const qs = url.search ? decodeURIComponent(url.search).slice(0, 120) : "";
      const res = await env.DB.prepare(
        "INSERT INTO audit_log (username, tenant_id, method, path, detail, status, at) VALUES (?,?,?,?,?,?,?)"
      ).bind(sess.user.username, sess.tenantId, m, p + qs, detail, status, new Date().toISOString()).run();
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
  // Image bytes are loaded by <img> tags, which can't send an auth header.
  ["GET", "/asset-image"],
  ["GET", "/asset-thumb"],
];

function isPublic(method, pathname) {
  if (PUBLIC_ROUTES.some(([m, p]) => m === method && pathname === p)) return true;
  // SLA job sheet downloads are opened as plain browser links (no header).
  if (method === "GET" && /^\/sla\/jobs\/[^/]+\/export(\.pdf)?$/.test(pathname)) return true;
  return false;
}
