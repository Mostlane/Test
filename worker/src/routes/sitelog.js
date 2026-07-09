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

const SITELOG_API = "https://api.site-log.co.uk";
const SCAN_URL = "https://site-log.co.uk/scan.html";

export async function handle(request, env, ctx, url) {
  const path = url.pathname;

  /* ── Launch: signed identity hand-off for the scanner ─────────────────── */
  if (path === "/sitelog-launch" && request.method === "GET") {
    const sess = await requireSession(env, request);
    if (!sess) return error("Not authenticated", 401, env, request);
    const perms = await permissionsFor(env, sess.user.username);
    if (perms.SiteLog !== "Yes" && perms.FullAccess !== "Yes")
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
  const sess = await requireSession(env, request);
  if (!sess) return error("Not authenticated", 401, env, request);
  const perms = await permissionsFor(env, sess.user.username);
  if (perms.FullAccess !== "Yes")
    return error("Forbidden — SiteLog admin data needs Full Access", 403, env, request);
  if (!env.SITELOG_ADMIN_SECRET)
    return error("SITELOG_ADMIN_SECRET is not configured on this worker", 500, env, request);

  const sub = path.replace(/^\/sitelog(?=\/|$)/, "") || "/";
  const target = SITELOG_API + sub + url.search;

  const init = {
    method: request.method,
    headers: { "x-admin-secret": env.SITELOG_ADMIN_SECRET },
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.headers["Content-Type"] = request.headers.get("Content-Type") || "application/json";
    init.body = await request.arrayBuffer();
  }

  let res;
  try {
    res = await fetch(target, init);
  } catch (e) {
    return error("SiteLog API unreachable: " + e.message, 502, env, request);
  }

  const headers = new Headers(corsHeaders(env, request));
  const ct = res.headers.get("Content-Type");
  if (ct) headers.set("Content-Type", ct);
  const cd = res.headers.get("Content-Disposition");
  if (cd) headers.set("Content-Disposition", cd);
  return new Response(res.body, { status: res.status, headers });
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

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
