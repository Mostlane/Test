// Yard gate — Tuya Cloud control + "left open" watch.
// ---------------------------------------------------------------------------
// The yard's FAAC 415L gate has a Tuya WiFi module (a dry-contact relay) that
// pulses the FAAC control board's OPEN input — exactly like a fob press. There
// is no plain webhook: Tuya devices are driven through the Tuya Cloud API with
// HMAC-SHA256-signed requests to openapi.tuya<region>.com. This route signs a
// command server-side so a portal button (🚪) opens the gate, and — because the
// FAAC board reports its own "gate open" state on a configurable output wired
// into a Tuya contact sensor — it also polls that state on the 5-min cron and
// pushes an alert if the gate is left open past a threshold.
//
// Secrets (dashboard, mostlane-api):
//   TUYA_ACCESS_ID       — Tuya IoT Cloud project Access ID / Client ID
//   TUYA_ACCESS_SECRET   — the project's Access Secret
// (nothing device-specific in secrets — the device ids + DP codes live in
//  app_config so they can be set/corrected without a redeploy.)
//
// Config (Full-Access) in app_config key `tuya:config`:
//   { region:"eu",
//     gateDeviceId, openCode:"switch_1", openValue:true,   // the OPEN pulse
//     stateDeviceId, stateCode:"doorcontact_state", stateOpenValue:true, // gate-open sensor
//     thresholdMins:10, repeatMins:30 }                    // left-open alert
// The two device ids can be the SAME device when one module both triggers and
// reports; leave the state* fields blank until a sensor exists → no watch.
//
//   GET  /tuya/config                 -> config (Full-Access; no secrets)
//   POST /tuya/config                 -> upsert config (Full-Access)
//   GET  /tuya/device-status?deviceId= -> raw DP list (Full-Access; SETUP tool)
//   GET  /tuya/devices                -> project devices, if listable (Full-Access)
//   POST /tuya/gate/open              -> pulse the OPEN command (YardGate|FullAccess)
//   GET  /tuya/gate/state             -> { open, since, mins, configured } (YardGate|FullAccess)
//
// checkGateLeftOpen(env, tid) is exported for the cron.

import { corsHeaders } from "../lib/http.js";
import { requireSession, permissionsFor } from "../lib/auth.js";
import { tenantDB } from "../lib/tenantdb.js";
import { sendToPermission } from "./push.js";

const CFG_KEY = "tuya:config";
const TOK_KEY = "tuya:token";
const WATCH_KEY = "tuya:gatewatch";

// Tuya data-centre base URLs. UK yard → Western Europe.
const REGION_BASE = {
  eu: "https://openapi.tuyaeu.com",
  us: "https://openapi.tuyaus.com",
  cn: "https://openapi.tuyacn.com",
  in: "https://openapi.tuyain.com",
};
function baseFor(cfg) { return REGION_BASE[(cfg && cfg.region) || "eu"] || REGION_BASE.eu; }

/* ------------------------------- config io ------------------------------- */
async function loadCfg(db) {
  const row = await db.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?")
    .bind(db.tenantId, CFG_KEY).first();
  let cfg = {};
  try { cfg = row ? JSON.parse(row.value) : {}; } catch {}
  return cfg && typeof cfg === "object" ? cfg : {};
}
async function saveCfg(db, cfg) {
  await db.prepare("INSERT INTO app_config (tenant_id, key, value) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(db.tenantId, CFG_KEY, JSON.stringify(cfg)).run();
}
async function loadKV(db, key) {
  const row = await db.prepare("SELECT value FROM app_config WHERE tenant_id=? AND key=?").bind(db.tenantId, key).first();
  try { return row ? JSON.parse(row.value) : null; } catch { return null; }
}
async function saveKV(db, key, obj) {
  await db.prepare("INSERT INTO app_config (tenant_id, key, value) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(db.tenantId, key, JSON.stringify(obj)).run();
}

/* ------------------------------- crypto ---------------------------------- */
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str || ""));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function hmacSha256Hex(secret, msg) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

// The Tuya v1.0 signature. For the token call `accessToken` is "" and is not
// sent as a header; for a business call it's the live token and IS sent.
// sign = HMAC-SHA256( accessId + accessToken + t + stringToSign , secret )
// stringToSign = METHOD \n SHA256(body) \n "" \n path(+query)
async function signRequest(accessId, secret, accessToken, method, path, bodyStr, t) {
  const contentHash = await sha256Hex(bodyStr || "");
  const stringToSign = method.toUpperCase() + "\n" + contentHash + "\n" + "" + "\n" + path;
  const signStr = accessId + (accessToken || "") + t + stringToSign;
  return hmacSha256Hex(secret, signStr);
}

/* ----------------------------- token cache ------------------------------- */
// Tokens last ~2h; cache in app_config and refresh a minute before expiry.
async function getToken(env, db, cfg) {
  const accessId = env.TUYA_ACCESS_ID, secret = env.TUYA_ACCESS_SECRET;
  if (!accessId || !secret) throw new Error("Tuya not configured (add TUYA_ACCESS_ID / TUYA_ACCESS_SECRET secrets)");
  const cached = await loadKV(db, TOK_KEY);
  const now = Date.now();
  if (cached && cached.access_token && cached.region === (cfg.region || "eu") && cached.expireAt - 60000 > now) {
    return cached.access_token;
  }
  const base = baseFor(cfg);
  const path = "/v1.0/token?grant_type=1";
  const t = String(now);
  const sign = await signRequest(accessId, secret, "", "GET", path, "", t);
  const resp = await fetch(base + path, {
    method: "GET",
    headers: { client_id: accessId, sign, t, sign_method: "HMAC-SHA256", "Content-Type": "application/json" },
  });
  const jr = await resp.json().catch(() => ({}));
  if (!jr.success || !jr.result || !jr.result.access_token) {
    throw new Error("Tuya token failed: " + (jr.msg || jr.code || resp.status));
  }
  const token = jr.result.access_token;
  const expireSecs = Number(jr.result.expire_time || 7200);
  await saveKV(db, TOK_KEY, { access_token: token, expireAt: now + expireSecs * 1000, region: cfg.region || "eu" });
  return token;
}

// Signed business-API call (auto-manages the token). Returns parsed JSON.
async function api(env, db, cfg, method, path, body) {
  const accessId = env.TUYA_ACCESS_ID, secret = env.TUYA_ACCESS_SECRET;
  const token = await getToken(env, db, cfg);
  const base = baseFor(cfg);
  const bodyStr = body != null ? JSON.stringify(body) : "";
  const t = String(Date.now());
  const sign = await signRequest(accessId, secret, token, method, path, bodyStr, t);
  const resp = await fetch(base + path, {
    method: method.toUpperCase(),
    headers: { client_id: accessId, access_token: token, sign, t, sign_method: "HMAC-SHA256", "Content-Type": "application/json" },
    body: bodyStr || undefined,
  });
  return resp.json().catch(() => ({ success: false, msg: "bad response " + resp.status }));
}

/* ----------------------------- device helpers ---------------------------- */
async function deviceStatus(env, db, cfg, deviceId) {
  const jr = await api(env, db, cfg, "GET", `/v1.0/devices/${encodeURIComponent(deviceId)}/status`);
  if (!jr.success) throw new Error(jr.msg || "device status failed");
  return Array.isArray(jr.result) ? jr.result : [];
}
// Read the gate-open boolean from the configured sensor DP. Returns null when
// no state device/code is configured (i.e. nothing to watch yet).
async function readGateOpen(env, db, cfg) {
  // 1) A dedicated contact sensor, if one is configured (momentary-pulse gates).
  if (cfg.stateDeviceId && cfg.stateCode) {
    const status = await deviceStatus(env, db, cfg, cfg.stateDeviceId);
    const dp = status.find(s => s.code === cfg.stateCode);
    if (!dp) return null;
    const openVal = (cfg.stateOpenValue === undefined) ? true : cfg.stateOpenValue;
    // Compare loosely so "true"/true/1 all match a configured open value.
    return String(dp.value) === String(openVal);
  }
  // 2) LATCHING relay (this gate): the OPEN switch's own value IS the state —
  //    on = open, off = closed — so no separate sensor is needed.
  if (cfg.gateDeviceId) {
    const code = cfg.openCode || "switch_1";
    const status = await deviceStatus(env, db, cfg, cfg.gateDeviceId);
    const dp = status.find(s => s.code === code);
    if (!dp) return null;
    const openVal = (cfg.openValue === undefined) ? true : cfg.openValue;
    return String(dp.value) === String(openVal);
  }
  return null;
}
// Can we read a gate open/closed state at all — via a sensor OR the latching relay?
function canReadState(cfg) {
  return !!((cfg.stateDeviceId && cfg.stateCode) || (cfg.gateDeviceId && (cfg.openCode || "switch_1")));
}

// Name whoever opened the gate, IF a portal open happened recently enough to be
// this open event (within ~8 min, covering the up-to-5-min poll lag). Returns
// null when the gate opened without the portal — i.e. the emergency keypad/fob —
// so the alert can say so honestly rather than blaming the last portal user.
async function attributeOpener(db, nowMs) {
  const lastOpen = await loadKV(db, "tuya:lastopen");
  if (!lastOpen || !lastOpen.at) return null;
  const gap = nowMs - Date.parse(lastOpen.at);
  return (gap >= 0 && gap <= 8 * 60000) ? (lastOpen.user || null) : null;
}

/* --------------------------------- handler -------------------------------- */
export async function handle(request, env, ctx, url, sess) {
  const cors = corsHeaders(env, request);
  const path = url.pathname;
  const method = request.method.toUpperCase();
  const json = (data, code = 200) =>
    new Response(JSON.stringify(data), { status: code, headers: { ...cors, "Content-Type": "application/json" } });

  if (!sess) sess = await requireSession(env, request);
  if (!sess) return json({ ok: false, error: "Not authenticated" }, 401);
  const perms = await permissionsFor(env, sess.tenantId, sess.user.username);
  const isFull = perms.FullAccess === "Yes";
  const canGate = isFull || perms.YardGate === "Yes";
  const db = tenantDB(env, sess.tenantId);

  // ---- config + setup tools: Full-Access only ----
  if (path === "/tuya/config" && method === "GET") {
    if (!isFull) return json({ ok: false, error: "Forbidden" }, 403);
    const cfg = await loadCfg(db);
    return json({ ok: true, config: cfg, hasSecrets: !!(env.TUYA_ACCESS_ID && env.TUYA_ACCESS_SECRET) });
  }

  if (path === "/tuya/config" && method === "POST") {
    if (!isFull) return json({ ok: false, error: "Forbidden" }, 403);
    const b = await request.json().catch(() => ({}));
    const cfg = await loadCfg(db);
    const set = (k, v, dflt) => { if (v !== undefined) cfg[k] = v; else if (cfg[k] === undefined && dflt !== undefined) cfg[k] = dflt; };
    if (typeof b.region === "string") cfg.region = b.region.trim().toLowerCase();
    set("gateDeviceId", b.gateDeviceId != null ? String(b.gateDeviceId).trim() : undefined, "");
    set("openCode", b.openCode != null ? String(b.openCode).trim() : undefined, "switch_1");
    if (b.openValue !== undefined) cfg.openValue = b.openValue;
    else if (cfg.openValue === undefined) cfg.openValue = true;
    // Latching gates need a CLOSE too (same channel, opposite value by default).
    set("closeCode", b.closeCode != null ? String(b.closeCode).trim() : undefined, undefined);
    if (b.closeValue !== undefined) cfg.closeValue = b.closeValue;
    set("stateDeviceId", b.stateDeviceId != null ? String(b.stateDeviceId).trim() : undefined, "");
    set("stateCode", b.stateCode != null ? String(b.stateCode).trim() : undefined, "");
    if (b.stateOpenValue !== undefined) cfg.stateOpenValue = b.stateOpenValue;
    if (b.thresholdMins !== undefined) cfg.thresholdMins = Math.max(1, parseInt(b.thresholdMins, 10) || 10);
    else if (cfg.thresholdMins === undefined) cfg.thresholdMins = 10;
    if (b.repeatMins !== undefined) cfg.repeatMins = Math.max(5, parseInt(b.repeatMins, 10) || 30);
    else if (cfg.repeatMins === undefined) cfg.repeatMins = 30;
    if (!cfg.region) cfg.region = "eu";
    await saveCfg(db, cfg);
    return json({ ok: true, config: cfg });
  }

  // Dump a device's DPs — the SETUP step: paste a device id, see exactly what
  // codes it exposes (which one is the OPEN switch, whether it reports a
  // door/contact state), then set those codes in the config.
  if (path === "/tuya/device-status" && method === "GET") {
    if (!isFull) return json({ ok: false, error: "Forbidden" }, 403);
    const deviceId = (url.searchParams.get("deviceId") || "").trim();
    if (!deviceId) return json({ ok: false, error: "Pass ?deviceId=" }, 400);
    const cfg = await loadCfg(db);
    try {
      const status = await deviceStatus(env, db, cfg, deviceId);
      // Also pull the device record for a friendly name + online flag.
      let info = null;
      try {
        const jr = await api(env, db, cfg, "GET", `/v1.0/devices/${encodeURIComponent(deviceId)}`);
        if (jr.success && jr.result) info = { name: jr.result.name, online: jr.result.online, category: jr.result.category, product_name: jr.result.product_name };
      } catch {}
      return json({ ok: true, deviceId, info, status });
    } catch (e) {
      return json({ ok: false, error: String(e && e.message || e) }, 502);
    }
  }

  // List the project's devices (works when the token's project has device
  // listing; useful to find device ids without the Tuya app).
  if (path === "/tuya/devices" && method === "GET") {
    if (!isFull) return json({ ok: false, error: "Forbidden" }, 403);
    const cfg = await loadCfg(db);
    try {
      const jr = await api(env, db, cfg, "GET", "/v1.0/users/devices");  // may be empty depending on project type
      const list = (jr.success && Array.isArray(jr.result)) ? jr.result.map(d => ({ id: d.id, name: d.name, online: d.online, category: d.category })) : [];
      return json({ ok: true, devices: list, raw: jr.success ? undefined : jr.msg });
    } catch (e) {
      return json({ ok: false, error: String(e && e.message || e) }, 502);
    }
  }

  // ---- operate: YardGate | FullAccess ----
  if (path === "/tuya/gate/open" && method === "POST") {
    if (!canGate) return json({ ok: false, error: "Forbidden" }, 403);
    const cfg = await loadCfg(db);
    if (!cfg.gateDeviceId) return json({ ok: false, error: "Gate not set up yet — add the Tuya device in Yard Gate settings." }, 400);
    if (!(env.TUYA_ACCESS_ID && env.TUYA_ACCESS_SECRET)) return json({ ok: false, error: "Tuya secrets not set on the worker." }, 400);
    const code = cfg.openCode || "switch_1";
    const value = (cfg.openValue === undefined) ? true : cfg.openValue;
    try {
      const jr = await api(env, db, cfg, "POST", `/v1.0/devices/${encodeURIComponent(cfg.gateDeviceId)}/commands`,
        { commands: [{ code, value }] });
      if (!jr.success) return json({ ok: false, error: jr.msg || "Tuya rejected the command" }, 502);
      // Access record: the portal is now the way in, so log WHO opened it. The
      // audit middleware already records the action; this dedicated log powers
      // the on-page history and lets the left-open alert name the opener.
      const nowIso = new Date().toISOString();
      const opener = (sess.user && sess.user.username) || "?";
      try {
        await saveKV(db, "tuya:lastopen", { user: opener, at: nowIso });
        const log = (await loadKV(db, "tuya:openlog")) || [];
        log.unshift({ user: opener, at: nowIso, action: "open" });
        await saveKV(db, "tuya:openlog", log.slice(0, 50));
      } catch {}
      return json({ ok: true, sent: { code, value }, by: opener });
    } catch (e) {
      return json({ ok: false, error: String(e && e.message || e) }, 502);
    }
  }

  // ---- close (latching gate): YardGate | FullAccess ----
  if (path === "/tuya/gate/close" && method === "POST") {
    if (!canGate) return json({ ok: false, error: "Forbidden" }, 403);
    const cfg = await loadCfg(db);
    if (!cfg.gateDeviceId) return json({ ok: false, error: "Gate not set up yet — add the Tuya device in Yard Gate settings." }, 400);
    if (!(env.TUYA_ACCESS_ID && env.TUYA_ACCESS_SECRET)) return json({ ok: false, error: "Tuya secrets not set on the worker." }, 400);
    const code = cfg.closeCode || cfg.openCode || "switch_1";
    const openValue = (cfg.openValue === undefined) ? true : cfg.openValue;
    const value = (cfg.closeValue !== undefined) ? cfg.closeValue : !openValue;   // opposite of open by default
    try {
      const jr = await api(env, db, cfg, "POST", `/v1.0/devices/${encodeURIComponent(cfg.gateDeviceId)}/commands`,
        { commands: [{ code, value }] });
      if (!jr.success) return json({ ok: false, error: jr.msg || "Tuya rejected the command" }, 502);
      const nowIso = new Date().toISOString();
      const closer = (sess.user && sess.user.username) || "?";
      try {
        const log = (await loadKV(db, "tuya:openlog")) || [];
        log.unshift({ user: closer, at: nowIso, action: "close" });
        await saveKV(db, "tuya:openlog", log.slice(0, 50));
      } catch {}
      return json({ ok: true, sent: { code, value }, by: closer });
    } catch (e) {
      return json({ ok: false, error: String(e && e.message || e) }, 502);
    }
  }

  if (path === "/tuya/gate/state" && method === "GET") {
    if (!canGate) return json({ ok: false, error: "Forbidden" }, 403);
    const cfg = await loadCfg(db);
    const configured = !!cfg.gateDeviceId;
    const watched = canReadState(cfg);   // sensor OR the latching relay's own switch
    if (!watched) return json({ ok: true, configured, watched: false });
    try {
      const open = await readGateOpen(env, db, cfg);
      // Reuse the watch record's `since` so the tile can show how long it's open.
      const watch = await loadKV(db, WATCH_KEY) || {};
      let since = null, mins = 0, openedBy = null;
      if (open) {
        since = watch.open && watch.since ? watch.since : new Date().toISOString();
        mins = Math.round((Date.now() - Date.parse(since)) / 60000);
        openedBy = watch.openedBy || (await attributeOpener(db, Date.now()));
      }
      return json({ ok: true, configured, watched: true, open: !!open, since, mins, openedBy });
    } catch (e) {
      return json({ ok: false, error: String(e && e.message || e) }, 502);
    }
  }

  // Recent opens — the access record (Full-Access).
  if (path === "/tuya/gate/log" && method === "GET") {
    if (!isFull) return json({ ok: false, error: "Forbidden" }, 403);
    const log = (await loadKV(db, "tuya:openlog")) || [];
    return json({ ok: true, log: log.slice(0, 50) });
  }

  return json({ ok: false, error: "Not found: " + path }, 404);
}

/* ----------------------------- cron: left open --------------------------- */
// Polls the gate-open sensor and alerts (push) if it's been open longer than
// the configured threshold, re-nudging every repeatMins. Tracks state in
// app_config `tuya:gatewatch` = { open, since, lastAlertAt }. Fully dormant
// until Tuya secrets + a state device/code are configured. Never throws.
export async function checkGateLeftOpen(env, tenantId) {
  try {
    if (!(env.TUYA_ACCESS_ID && env.TUYA_ACCESS_SECRET)) return;
    const db = tenantDB(env, tenantId);
    const cfg = await loadCfg(db);
    if (!canReadState(cfg)) return;   // nothing to watch (no sensor and no relay)

    const open = await readGateOpen(env, db, cfg);
    if (open === null) return;

    const watch = (await loadKV(db, WATCH_KEY)) || {};
    const now = Date.now();

    if (!open) {
      // Closed — reset if we were tracking an open state.
      if (watch.open) await saveKV(db, WATCH_KEY, { open: false, since: null, lastAlertAt: null });
      return;
    }

    // Open — establish/keep the "since" moment and who opened it. On the
    // transition to open, attribute it to the recent portal opener (else null =
    // opened via the emergency keypad/fob).
    let since, openedBy;
    if (watch.open && watch.since) { since = watch.since; openedBy = watch.openedBy || null; }
    else { since = new Date(now).toISOString(); openedBy = await attributeOpener(db, now); }

    const openMins = Math.round((now - Date.parse(since)) / 60000);
    const threshold = Math.max(1, parseInt(cfg.thresholdMins, 10) || 10);
    const repeat = Math.max(5, parseInt(cfg.repeatMins, 10) || 30);
    const lastAlertAt = watch.lastAlertAt ? Date.parse(watch.lastAlertAt) : 0;

    let newLastAlert = watch.lastAlertAt || null;
    if (openMins >= threshold && (!lastAlertAt || (now - lastAlertAt) >= repeat * 60000)) {
      const who = openedBy ? `${openedBy} opened the yard gate and it's still open` : `The yard gate has been open (opened without the portal — check emergency access)`;
      await sendToPermission(env, tenantId, ["FullAccess", "YardGate"], {
        title: "⚠️ Yard gate left open",
        body: `${who} — ${openMins} min.`,
        url: "/yard-gate.html",
        tag: "yardgate-open",
      }).catch(() => {});
      newLastAlert = new Date(now).toISOString();
    }
    await saveKV(db, WATCH_KEY, { open: true, since, openedBy, lastAlertAt: newLastAlert });
  } catch (e) {
    console.error("checkGateLeftOpen:", e && e.message);
  }
}
