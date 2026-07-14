// Web Push subscriptions + sending.
//
//   GET  /push/public-key          -> { ok, key }   (VAPID public key for subscribe)
//   POST /push/subscribe           { subscription, ua }  store this device
//   POST /push/unsubscribe         { endpoint }          forget this device
//   POST /push/test                send a test push to my devices
//
// Subscriptions live in push_subscriptions (self-migrating). Payloads are the
// JSON the service worker expects: { title, body, url }. Phase 2 event hooks
// call sendToUser() to fire the same popups as OS notifications.

import { corsHeaders } from "../lib/http.js";
import { resolveTenantId } from "../lib/tenantdb.js";
import { sendPush } from "../lib/webpush.js";

function jr(o, h, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...h, "Content-Type": "application/json" } }); }
async function readJson(req) { try { return await req.json(); } catch { return {}; } }

async function ensureTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    tenant_id INTEGER NOT NULL DEFAULT 1,
    username TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    ua TEXT,
    created_at TEXT,
    last_ok TEXT)`).run();
}

// Send a { title, body, url } payload to every device a user has registered.
// Prunes subscriptions the push service reports as gone (404/410). Best-effort;
// returns { sent, failed, gone }. Safe to call from ctx.waitUntil().
export async function sendToUser(env, tenantId, username, payload) {
  if (!env.VAPID_PUBLIC || !env.VAPID_PRIVATE) return { sent: 0, failed: 0, gone: 0, disabled: true };
  await ensureTable(env);
  const { results } = await env.DB.prepare(
    "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE tenant_id=? AND lower(username)=lower(?)"
  ).bind(tenantId, username).all();
  const subs = results || [];
  if (!subs.length) return { sent: 0, failed: 0, gone: 0 };
  const body = JSON.stringify(payload);
  let sent = 0, failed = 0, gone = 0;
  await Promise.allSettled(subs.map(async row => {
    const sub = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
    try {
      const res = await sendPush(env, sub, body);
      if (res.status === 404 || res.status === 410) {
        gone++;
        await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint=?").bind(row.endpoint).run();
      } else if (res.ok || res.status === 201) {
        sent++;
        await env.DB.prepare("UPDATE push_subscriptions SET last_ok=? WHERE endpoint=?").bind(new Date().toISOString(), row.endpoint).run();
      } else {
        failed++;
      }
    } catch { failed++; }
  }));
  return { sent, failed, gone };
}

export async function handle(request, env, ctx, url, sess) {
  const headers = corsHeaders(env, request);
  const method = request.method.toUpperCase();
  const sub = url.pathname.replace(/^\/push(?=\/|$)/, "") || "/";

  if (!sess) return jr({ error: "Not authenticated" }, headers, 401);
  const tid = sess.tenantId != null ? sess.tenantId : await resolveTenantId(env, request);
  const me = sess.user.username;

  // Public VAPID key so the browser can subscribe (empty if not configured yet).
  if (sub === "/public-key" && method === "GET") {
    return jr({ ok: true, key: env.VAPID_PUBLIC || "", configured: !!(env.VAPID_PUBLIC && env.VAPID_PRIVATE) }, headers);
  }

  if (sub === "/subscribe" && method === "POST") {
    await ensureTable(env);
    const b = await readJson(request);
    const s = b.subscription || b;
    const endpoint = s && s.endpoint;
    const p256dh = s && s.keys && s.keys.p256dh;
    const auth = s && s.keys && s.keys.auth;
    if (!endpoint || !p256dh || !auth) return jr({ error: "Bad subscription" }, headers, 400);
    await env.DB.prepare(`INSERT INTO push_subscriptions (endpoint, tenant_id, username, p256dh, auth, ua, created_at, last_ok)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(endpoint) DO UPDATE SET username=excluded.username, p256dh=excluded.p256dh, auth=excluded.auth, ua=excluded.ua, tenant_id=excluded.tenant_id`)
      .bind(endpoint, tid, me, p256dh, auth, String(b.ua || "").slice(0, 200), new Date().toISOString(), null).run();
    return jr({ ok: true }, headers, 201);
  }

  if (sub === "/unsubscribe" && method === "POST") {
    await ensureTable(env);
    const b = await readJson(request);
    if (!b.endpoint) return jr({ error: "endpoint required" }, headers, 400);
    await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint=? AND lower(username)=lower(?)").bind(b.endpoint, me).run();
    return jr({ ok: true }, headers);
  }

  if (sub === "/test" && method === "POST") {
    if (!env.VAPID_PUBLIC || !env.VAPID_PRIVATE) return jr({ ok: false, error: "Push isn't configured on the server yet (VAPID keys missing)." }, headers, 400);
    const r = await sendToUser(env, tid, me, {
      title: "Mostlane Portal",
      body: "✅ Test notification — push is working on this device.",
      url: "/main.html"
    });
    if (!r.sent && !r.failed && !r.gone) return jr({ ok: false, error: "No devices registered on this account yet — enable notifications first." }, headers, 400);
    return jr({ ok: r.sent > 0, ...r }, headers);
  }

  return jr({ error: "Not found: " + sub }, headers, 404);
}
