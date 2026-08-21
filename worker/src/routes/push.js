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
import { permissionsFor } from "../lib/auth.js";

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

// ── Notification feed (the "bell") ──────────────────────────────────────────
// A durable, per-user history of every notification (the same {title,body,url}
// a push carries). Written by recordNotification() from sendToUser() so it
// captures EVERY event — even for users who never turned push on — and read by
// the bell UI (routes/portal.js /notify/feed*). Chat messages are excluded
// (they have their own chat-widget bell).
let FEED_READY = false;
export async function ensureFeedTable(env) {
  if (FEED_READY) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS user_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL DEFAULT 1,
    username TEXT NOT NULL,
    title TEXT,
    body TEXT,
    url TEXT,
    tag TEXT,
    created_at TEXT,
    seen_at TEXT,
    read_at TEXT)`).run();
  // Facebook-style two states: seen_at = the red badge (cleared when the bell is
  // opened), read_at = the bold/blue-dot (cleared per item when it's clicked).
  // Self-migrating for a table created before seen_at existed.
  try { await env.DB.prepare("ALTER TABLE user_notifications ADD COLUMN seen_at TEXT").run(); } catch {}
  // Actionable alerts (approvals) stay OUTSTANDING until the underlying item is
  // dealt with — not merely opened. actionable=1 + resolved_at IS NULL = still
  // needs action; on resolution we stamp resolved_at and rewrite title/body to
  // the outcome ("Approved by X"). Self-migrating.
  try { await env.DB.prepare("ALTER TABLE user_notifications ADD COLUMN actionable INTEGER DEFAULT 0").run(); } catch {}
  try { await env.DB.prepare("ALTER TABLE user_notifications ADD COLUMN resolved_at TEXT").run(); } catch {}
  try { await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_usernotif ON user_notifications(tenant_id, username, id)").run(); } catch {}
  FEED_READY = true;
}

// Add one row to a user's notification feed. Best-effort (never throws into the
// caller). Skips chat pushes (tag msg:/grp:) — those live in the chat bell.
export async function recordNotification(env, tenantId, username, payload) {
  try {
    const p = payload || {};
    const tag = String(p.tag || "");
    if (/^(msg:|grp:)/.test(tag)) return;
    if (!p.title && !p.body) return;
    await ensureFeedTable(env);
    await env.DB.prepare(
      "INSERT INTO user_notifications (tenant_id, username, title, body, url, tag, created_at, actionable) VALUES (?,?,?,?,?,?,?,?)"
    ).bind(tenantId, username,
      String(p.title || "").slice(0, 200),
      String(p.body || "").slice(0, 600),
      String(p.url || "").slice(0, 300),
      tag.slice(0, 60),
      new Date().toISOString(),
      p.actionable ? 1 : 0).run();
    // Cap the history at the newest 120 per user so it never grows unbounded.
    await env.DB.prepare(
      "DELETE FROM user_notifications WHERE tenant_id=? AND username=? AND id NOT IN (SELECT id FROM user_notifications WHERE tenant_id=? AND username=? ORDER BY id DESC LIMIT 120)"
    ).bind(tenantId, username, tenantId, username).run();
  } catch { /* feed is best-effort — never break the push path */ }
}

// Resolve EVERY recipient's bell copy of a tagged actionable alert — used when a
// shared/group item is DEALT WITH (one admin approves an on-hold / a holiday, a
// recipient accepts a transfer). Stamps resolved_at, marks read+seen, and (when
// an outcome {title, body} is given) rewrites the row to say who did what
// ("Dave's holiday — ✅ Approved by Jamie"), so it drops off everyone's
// outstanding list and just sits read in each log. Best-effort; ctx.waitUntil-safe.
export async function resolveNotificationsByTag(env, tenantId, tag, outcome) {
  const t = String(tag || "").slice(0, 60);
  if (!t) return;
  try {
    await ensureFeedTable(env);
    const now = new Date().toISOString();
    const o = outcome || {};
    if (o.title || o.body) {
      await env.DB.prepare(
        "UPDATE user_notifications SET title=COALESCE(?,title), body=COALESCE(?,body), resolved_at=?, read_at=COALESCE(read_at,?), seen_at=COALESCE(seen_at,?) WHERE tenant_id=? AND tag=?"
      ).bind(o.title ? String(o.title).slice(0, 200) : null, o.body ? String(o.body).slice(0, 600) : null,
        now, now, now, tenantId, t).run();
    } else {
      await env.DB.prepare(
        "UPDATE user_notifications SET resolved_at=?, read_at=COALESCE(read_at,?), seen_at=COALESCE(seen_at,?) WHERE tenant_id=? AND tag=?"
      ).bind(now, now, now, tenantId, t).run();
    }
  } catch { /* best-effort */ }
}
// Back-compat: clear-only (no outcome text).
export async function markNotificationsReadByTag(env, tenantId, tag) {
  return resolveNotificationsByTag(env, tenantId, tag, null);
}

// Re-nudge (push only, NO new feed row) — used by the cron to chase outstanding
// approvals. The single outstanding feed row already exists; this just lands a
// fresh OS notification on the phone so it can't be forgotten.
export async function remindUser(env, tenantId, username, payload) {
  try { return await pushToUser(env, tenantId, username, payload); } catch { return { sent: 0, failed: 0, gone: 0 }; }
}
export async function remindPermission(env, tenantId, permKeys, payload, excludeUser) {
  if (!env.VAPID_PUBLIC || !env.VAPID_PRIVATE) return { sent: 0 };
  const keys = (permKeys || []).filter(Boolean);
  if (!keys.length) return { sent: 0 };
  const ph = keys.map(() => "?").join(",");
  let usernames = [];
  try {
    const { results } = await env.DB.prepare(
      `SELECT DISTINCT username FROM user_permissions WHERE tenant_id=? AND value=1 AND permission IN (${ph})`
    ).bind(tenantId, ...keys).all();
    usernames = (results || []).map(r => r.username);
  } catch { return { sent: 0 }; }
  const ex = excludeUser ? String(excludeUser).toLowerCase() : null;
  let sent = 0;
  for (const u of usernames) {
    if (ex && u.toLowerCase() === ex) continue;
    try { const r = await pushToUser(env, tenantId, u, payload); sent += r.sent || 0; } catch {}
  }
  return { sent };
}

// Send a { title, body, url } payload to every device a user has registered.
// Prunes subscriptions the push service reports as gone (404/410). Best-effort;
// returns { sent, failed, gone }. Safe to call from ctx.waitUntil().
//
// The actual push send (pushToUser) runs FIRST and is byte-for-byte the
// pre-bell code path — nothing about the bell feed can delay or affect it. The
// feed row is written strictly AFTER, as a pure best-effort add-on.
export async function sendToUser(env, tenantId, username, payload) {
  const result = await pushToUser(env, tenantId, username, payload);
  await recordNotification(env, tenantId, username, payload);
  return result;
}
async function pushToUser(env, tenantId, username, payload) {
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

// Send to every user holding any of the given permissions (value=1), e.g.
// notify holiday admins. Optionally skip one user (usually the actor).
export async function sendToPermission(env, tenantId, permKeys, payload, excludeUser) {
  if (!env.VAPID_PUBLIC || !env.VAPID_PRIVATE) return { sent: 0, failed: 0, gone: 0, disabled: true };
  const keys = (permKeys || []).filter(Boolean);
  if (!keys.length) return { sent: 0, failed: 0, gone: 0 };
  const ph = keys.map(() => "?").join(",");
  let usernames = [];
  try {
    const { results } = await env.DB.prepare(
      `SELECT DISTINCT username FROM user_permissions WHERE tenant_id=? AND value=1 AND permission IN (${ph})`
    ).bind(tenantId, ...keys).all();
    usernames = (results || []).map(r => r.username);
  } catch { return { sent: 0, failed: 0, gone: 0 }; }
  const ex = excludeUser ? String(excludeUser).toLowerCase() : null;
  const totals = { sent: 0, failed: 0, gone: 0 };
  for (const u of usernames) {
    if (ex && u.toLowerCase() === ex) continue;
    const r = await sendToUser(env, tenantId, u, payload);
    totals.sent += r.sent || 0; totals.failed += r.failed || 0; totals.gone += r.gone || 0;
  }
  return totals;
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

  // Admin: who has push turned on / off right now (device count + last successful send).
  if (sub === "/status-all" && method === "GET") {
    const perms = await permissionsFor(env, tid, me);
    if (!perms || perms.FullAccess !== "Yes") return jr({ error: "Forbidden" }, headers, 403);
    await ensureTable(env);

    // Every subscription row (one per device), grouped per user (case-insensitive).
    let rows = [];
    try {
      const r = await env.DB.prepare(
        `SELECT lower(username) uk, ua, created_at, last_ok
           FROM push_subscriptions
          WHERE tenant_id = ?
          ORDER BY created_at`
      ).bind(tid).all();
      rows = r.results || [];
    } catch { rows = []; }
    const byUser = {};
    for (const s of rows) {
      (byUser[s.uk] = byUser[s.uk] || []).push({
        device: describeDevice(s.ua),
        ua: s.ua || "",
        lastOk: s.last_ok || null,
        lastReg: s.created_at || null
      });
    }

    // Registered devices from the device-lock `devices` table (separate from push
    // subscriptions). A user can have a phone registered here yet have push OFF —
    // so the card can show "device registered · notifications off" instead of
    // implying they have no device at all.
    const byDev = {};
    try {
      const d = await env.DB.prepare(
        "SELECT lower(username) uk, label, registered_at FROM devices WHERE tenant_id = ? ORDER BY registered_at"
      ).bind(tid).all();
      for (const row of (d.results || [])) {
        (byDev[row.uk] = byDev[row.uk] || []).push({ label: row.label || "device", registeredAt: row.registered_at || null });
      }
    } catch { /* devices table absent -> no registered-device info */ }

    // All active users.
    let users = [];
    try {
      const r = await env.DB.prepare("SELECT first_name, last_name, username, status FROM users WHERE tenant_id = ? ORDER BY username").bind(tid).all();
      users = (r.results || []).filter(u => isActiveStatus(u.status));
    } catch { users = []; }

    const list = users.map(u => {
      const devs = byUser[String(u.username || "").toLowerCase()] || [];
      // newest-confirmed device first within a user
      devs.sort((a, b) => String(b.lastOk || "").localeCompare(String(a.lastOk || "")) || String(b.lastReg || "").localeCompare(String(a.lastReg || "")));
      const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || u.username;
      const lastOk = devs.reduce((m, d) => (d.lastOk && (!m || d.lastOk > m)) ? d.lastOk : m, null);
      const lastReg = devs.reduce((m, d) => (d.lastReg && (!m || d.lastReg > m)) ? d.lastReg : m, null);
      const regDevs = byDev[String(u.username || "").toLowerCase()] || [];
      return {
        username: u.username,
        name,
        on: devs.length > 0,
        devices: devs.length,
        devicesList: devs,
        // Device-lock devices — present even when push notifications are off.
        registeredDevices: regDevs.length,
        registeredList: regDevs,
        lastOk,
        lastReg
      };
    });
    // Off first, then stale (never confirmed / old), then on — most-attention-needed at the top.
    list.sort((a, b) => {
      if (a.on !== b.on) return a.on ? 1 : -1;
      return String(a.name).localeCompare(String(b.name));
    });
    const onCount = list.filter(u => u.on).length;
    return jr({ ok: true, users: list, total: list.length, on: onCount, off: list.length - onCount }, headers);
  }

  return jr({ error: "Not found: " + sub }, headers, 404);
}

function isActiveStatus(s) {
  const t = String(s == null ? "" : s).trim().toLowerCase();
  return t === "" || t === "active";
}

// Turn a raw browser user-agent into a friendly "iPhone · Safari" style label.
function describeDevice(ua) {
  const u = String(ua || "");
  if (!u) return "Unknown device";
  let os = "";
  if (/iPhone/i.test(u)) os = "iPhone";
  else if (/iPad/i.test(u)) os = "iPad";
  else if (/Android/i.test(u)) os = "Android";
  else if (/Windows/i.test(u)) os = "Windows PC";
  else if (/Macintosh|Mac OS X/i.test(u)) os = "Mac";
  else if (/CrOS/i.test(u)) os = "Chromebook";
  else if (/Linux/i.test(u)) os = "Linux";
  let br = "";
  if (/EdgA?\//i.test(u)) br = "Edge";
  else if (/OPR\/|Opera/i.test(u)) br = "Opera";
  else if (/SamsungBrowser/i.test(u)) br = "Samsung Internet";
  else if (/FxiOS|Firefox/i.test(u)) br = "Firefox";
  else if (/CriOS/i.test(u)) br = "Chrome";
  else if (/Chrome\//i.test(u)) br = "Chrome";
  else if (/Version\/.*Safari/i.test(u) || /Safari/i.test(u)) br = "Safari";
  const parts = [os, br].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Unknown device";
}
