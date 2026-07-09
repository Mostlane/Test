// SiteLog bridge — proxies the portal to the SiteLog API (api.site-log.co.uk)
// with the admin secret held server-side (env.SITELOG_ADMIN_SECRET), exactly as
// SiteLog's own integration brief recommends. The secret never reaches a browser.
//
//   ANY /sitelog/<path>  ->  https://api.site-log.co.uk/<path>  (+ x-admin-secret)
//
// Gated: portal session + FullAccess (admin data: visits, on-site, engineers…).
// Engineers don't need this — scanning deep-links to site-log.co.uk/scan.html.

import { corsHeaders, error } from "../lib/http.js";
import { requireSession, permissionsFor } from "../lib/auth.js";

const SITELOG_API = "https://api.site-log.co.uk";

export async function handle(request, env, ctx, url) {
  const sess = await requireSession(env, request);
  if (!sess) return error("Not authenticated", 401, env, request);
  const perms = await permissionsFor(env, sess.user.username);
  if (perms.FullAccess !== "Yes")
    return error("Forbidden — SiteLog admin data needs Full Access", 403, env, request);
  if (!env.SITELOG_ADMIN_SECRET)
    return error("SITELOG_ADMIN_SECRET is not configured on this worker", 500, env, request);

  const sub = url.pathname.replace(/^\/sitelog(?=\/|$)/, "") || "/";
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

  // Pass the response through with OUR CORS headers (file downloads included).
  const headers = new Headers(corsHeaders(env, request));
  const ct = res.headers.get("Content-Type");
  if (ct) headers.set("Content-Type", ct);
  const cd = res.headers.get("Content-Disposition");
  if (cd) headers.set("Content-Disposition", cd);
  return new Response(res.body, { status: res.status, headers });
}
