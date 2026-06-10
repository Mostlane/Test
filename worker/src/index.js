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
import * as auth from "./routes/auth.js";          // DONE  (login, logout, me)
import * as users from "./routes/users.js";        // DONE  (/user, /users)
import * as devices from "./routes/devices.js";    // DONE  (device lock)
import * as checkinout from "./routes/checkinout.js"; // STUB <- ckeck-in-out
import * as hours from "./routes/hours.js";        // STUB <- odd-water/average-hours/labourhours/timesheet
import * as holidays from "./routes/holidays.js";  // STUB <- mostlane-holidays
import * as vehicles from "./routes/vehicles.js";  // STUB <- vehicles / vehicles-fuel
import * as sites from "./routes/sites.js";        // STUB <- mostlane-sites
import * as assets from "./routes/assets.js";      // STUB <- mostlane-assets
import * as sla from "./routes/sla.js";            // STUB <- mostlane-sla
import * as compliance from "./routes/compliance.js"; // STUB <- mostlane-pos /Compliance
import * as projects from "./routes/projects.js";  // STUB <- projects-ml-portal
import * as labour from "./routes/labour.js";      // STUB <- mostlane-labour-api

// ── Route table: [method, pathPrefix, handler] ──────────────────────────────
// Longest prefix wins; handlers receive (request, env, ctx, url).
const ROUTES = [
  ["*", "/auth",       auth.handle],
  ["*", "/admin/login-history", auth.loginHistory],
  ["*", "/user",       users.handle],   // /user and /users
  ["*", "/device",     devices.handle],
  ["*", "/check",      checkinout.handle],
  ["*", "/hours",      hours.handle],
  ["*", "/timesheet",  hours.handle],
  ["*", "/holiday",    holidays.handle],
  ["*", "/vehicle",    vehicles.handle],
  ["*", "/van",        vehicles.handle],
  // Purchase Orders intentionally excluded — handled by a separate system.
  ["*", "/sites",      sites.handle],
  ["*", "/site",       sites.handle],
  ["*", "/asset",      assets.handle],
  ["*", "/transfer-log", assets.transferLog],
  ["*", "/sla",        sla.handle],
  ["*", "/compliance", compliance.handle],
  ["*", "/Compliance", compliance.handle],
  ["*", "/project",    projects.handle],
  ["*", "/labour",     labour.handle],
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return preflight(env, request);

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ ok: true, service: "mostlane-portal", time: new Date().toISOString() }, {}, env, request);
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
