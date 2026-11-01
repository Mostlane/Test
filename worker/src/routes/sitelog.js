// SiteLog bridge — two jobs:
//
//  1. GET /sitelog-launch  (session + SiteLog permission)
//     Mints a short-lived HMAC-signed identity token and returns the scan URL
//     with it in the #hash. SiteLog's /portal-link verifies it (shared secret
//     PORTAL_BRIDGE_SECRET on BOTH workers) and binds the phone to the person —
//     so portal users never register manually.
//
//  2. ANY /sitelog/<path>  (session + FullAccess)
//     Server-side proxy to https://api.site-log.co.uk with the admin secret
//     (env.SITELOG_ADMIN_SECRET) attached — the secret never reaches a browser.

import { corsHeaders, json, error } from "../lib/http.js";
import { requireSession, permissionsFor } from "../lib/auth.js";
import * as sitelogApi from "./sitelog-api.js";

const SITELOG_API = "https://api2.site-log.co.uk";
const SCAN_URL = "https://site-log.co.uk/scan.html";

export async function handle(request, env, ctx, url, sess) {
  const path = url.pathname;

  /* ── Launch: signed identity hand-off for the scanner ─────────────────── */
  if (path === "/sitelog-launch" && request.method === "GET") {
    if (!sess) sess = await requireSession(env, request);
    if (!sess) return error("Not authenticated", 401, env, request);
    const perms = await permissionsFor(env, sess.tenantId, sess.user.username);
    if (perms.SiteLog !== "Yes" && perms.SiteLogAdmin !== "Yes" && perms.FullAccess !== "Yes")
      return error("Forbidden", 403, env, request);

    // Bridge not configured yet → plain scanner link still works (manual register).
    if (!env.PORTAL_BRIDGE_SECRET)
      return json({ ok: true, url: SCAN_URL, linked: false }, {}, env, request);

    const payload = {
      u: sess.user.username,
      f: sess.user.first_name || "",
      l: sess.user.last_name || "",
      c: "Mostlane",
      exp: Date.now() + 5 * 60 * 1000   // 5 minutes to tap through
    };
    const token = await signBridgeToken(env.PORTAL_BRIDGE_SECRET, payload);
    return json({ ok: true, url: SCAN_URL + "#pt=" + token, linked: true }, {}, env, request);
  }

  /* ── Admin proxy ──────────────────────────────────────────────────────── */
  if (!sess) sess = await requireSession(env, request);
  if (!sess) return error("Not authenticated", 401, env, request);
  const perms = await permissionsFor(env, sess.tenantId, sess.user.username);
  if (perms.FullAccess !== "Yes" && perms.SiteLogAdmin !== "Yes")
    return error("Forbidden — SiteLog admin data needs the SiteLog admin permission", 403, env, request);
  if (!env.SITELOG_ADMIN_SECRET)
    return error("SITELOG_ADMIN_SECRET is not configured on this worker", 500, env, request);

  const sub = path.replace(/^\/sitelog(?=\/|$)/, "") || "/";
  const target = SITELOG_API + sub + url.search;
  // Pay rates / travel allowances are Full Access only (Jamie, 1 Nov 2026).
  const money = perms.FullAccess === "Yes";
  if (!money && MONEY_ONLY_PATHS.has(sub))
    return error("Only Full Access users can see SiteLog costs", 403, env, request);

  const init = {
    method: request.method,
    headers: { "x-admin-secret": env.SITELOG_ADMIN_SECRET },
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.headers["Content-Type"] = request.headers.get("Content-Type") || "application/json";
    init.body = await request.arrayBuffer();
    if (!money && MONEY_WRITE_PATHS.has(sub)) {
      try {
        const b = JSON.parse(new TextDecoder().decode(init.body) || "{}");
        init.body = JSON.stringify(stripMoneyFromBody(b));
        init.headers["Content-Type"] = "application/json";
      } catch (e) { return error("Bad request body", 400, env, request); }
    }
  }

  let res;
  try {
    if (env.SITELOG_DB) {
      // SiteLog now lives in this worker — run it directly against the bound DB,
      // no round-trip to api.site-log.co.uk. (Fails soft to the remote fetch
      // below if the binding isn't present yet.)
      res = await sitelogApi.handle(new Request(target, init), env, ctx);
    } else {
      res = await fetch(target, init);
    }
  } catch (e) {
    return error("SiteLog API unreachable: " + e.message, 502, env, request);
  }

  const headers = new Headers(corsHeaders(env, request));
  if (!money && MONEY_READ_PATHS.has(sub) && res.ok) {
    const data = await res.json().catch(() => null);
    headers.set("Content-Type", "application/json");
    return new Response(JSON.stringify(stripMoneyFromPeople(data)), { status: res.status, headers });
  }
  const ct = res.headers.get("Content-Type");
  if (ct) headers.set("Content-Type", ct);
  const cd = res.headers.get("Content-Disposition");
  if (cd) headers.set("Content-Disposition", cd);
  return new Response(res.body, { status: res.status, headers });
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

// Pay / travel-allowance fields on a SiteLog person. Hidden from, and not
// writable by, Site Log admins without Full Access.
export const MONEY_FIELDS = ["hourly_rate", "hourlyRate", "fuel_rate", "fuelRate", "fuel_paid", "fuelPaid",
  "travel_time_paid", "travelTimePaid", "travel_status", "travelStatus", "travel_cap_type", "travelCapType",
  "travel_cap_value", "travelCapValue"];
const MONEY_ONLY_PATHS = new Set(["/job-costing"]);
const MONEY_WRITE_PATHS = new Set(["/update-engineer", "/add-engineer"]);
const MONEY_READ_PATHS = new Set(["/engineers"]);
export function stripMoneyFromBody(b) {
  const out = { ...(b || {}) };
  for (const k of MONEY_FIELDS) delete out[k];
  return out;
}
export function stripMoneyFromPeople(data) {
  if (!data || !Array.isArray(data.engineers)) return data;
  return { ...data, money: false, engineers: data.engineers.map(stripMoneyFromBody) };
}

function b64u(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Token format: "v1.<payload b64url>.<HMAC-SHA256 b64url>" — verified by
// SiteLog's /portal-link with the same shared secret.
async function signBridgeToken(secret, payload) {
  const enc = new TextEncoder();
  const body = "v1." + b64u(enc.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return body + "." + b64u(sig);
}
