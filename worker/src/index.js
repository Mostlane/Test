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
  ["*", "/delete-asset-image", assets.handle],
  ["*", "/sla",        sla.handle],
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
  ["*", "/sitelog",    sitelog.handle],
  ["*", "/sitelog-launch", sitelog.handle],
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
    if (!isPublic(request.method, url.pathname)) {
      const sess = await requireSession(env, request);
      if (!sess) return error("Not authenticated", 401, env, request);
    }

    // Dispatch by longest matching prefix
    const match = ROUTES
      .filter(([, prefix]) => url.pathname === prefix || url.pathname.startsWith(prefix + "/") || url.pathname.startsWith(prefix))
      .sort((a, b) => b[1].length - a[1].length)[0];

    if (!match) return error("Not found: " + url.pathname, 404, env, request);

    try {
      return await match[2](request, env, ctx, url);
    } catch (err) {
      console.error("Handler error:", err);
      return error("Server error: " + err.message, 500, env, request);
    }
  },
};

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
