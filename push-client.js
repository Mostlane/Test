// push-client.js — shared Web Push helper for the portal.
// Exposes window.MostlanePush: state()/enable()/disable()/test().
// Pages that use it must be logged in (uses the Bearer token like authFetch).
(function () {
  const API = window.MOSTLANE_API || "https://mostlane-api.jamie-def.workers.dev";
  function token() { return localStorage.getItem("mostlaneToken") || ""; }
  function aFetch(p, o = {}) {
    o.headers = Object.assign({ Authorization: "Bearer " + token() }, o.headers || {});
    if (o.body && !o.headers["Content-Type"]) o.headers["Content-Type"] = "application/json";
    return fetch(API + p, o);
  }
  const supported = ("serviceWorker" in navigator) && ("PushManager" in window) && ("Notification" in window);
  function isIOS() { return /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); }
  function isStandalone() { return window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true; }
  function urlB64ToU8(base64) {
    const pad = "=".repeat((4 - base64.length % 4) % 4);
    const b64 = (base64 + pad).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(b64); const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  async function reg() {
    try {
      if ("serviceWorker" in navigator) { try { await navigator.serviceWorker.register("/sw.js"); } catch (e) {} }
      return await navigator.serviceWorker.ready;
    } catch { return null; }
  }
  async function currentSub() { const r = await reg(); return r ? await r.pushManager.getSubscription() : null; }
  // Raw ArrayBuffer (a subscription's applicationServerKey) → base64url, so we
  // can compare the key a device subscribed with against the server's current one.
  function abToB64u(buf) {
    const b = new Uint8Array(buf); let s = "";
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function subKey(sub) { try { return sub.options && sub.options.applicationServerKey ? abToB64u(sub.options.applicationServerKey) : ""; } catch { return ""; } }
  async function serverKey() { try { const j = await (await aFetch("/push/public-key")).json(); return (j && j.key) || ""; } catch { return ""; } }

  // Auto-heal after a VAPID key rotation: if this device is already subscribed
  // but with a DIFFERENT key than the server now uses, silently re-subscribe so
  // pushes resume with no user action. Only runs when permission is already
  // granted (never prompts). Called on load by every page that includes this.
  async function syncKey() {
    try {
      if (!supported || (isIOS() && !isStandalone()) || Notification.permission !== "granted") return;
      const r = await reg(); if (!r) return;
      const sub = await r.pushManager.getSubscription(); if (!sub) return;
      const want = await serverKey(); if (!want) return;
      if (subKey(sub) === want) return;                 // already on the current key
      await sub.unsubscribe().catch(() => {});
      const fresh = await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToU8(want) });
      await aFetch("/push/subscribe", { method: "POST", body: JSON.stringify({ subscription: fresh.toJSON(), ua: navigator.userAgent }) }).catch(() => {});
    } catch (e) {}
  }

  // Returns { supported, needsInstall, denied, on }.
  async function state() {
    if (!supported) return { supported: false, needsInstall: false, denied: false, on: false };
    if (isIOS() && !isStandalone()) return { supported: true, needsInstall: true, denied: false, on: false };
    if (Notification.permission === "denied") return { supported: true, needsInstall: false, denied: true, on: false };
    const sub = await currentSub();
    return { supported: true, needsInstall: false, denied: false, on: !!sub };
  }

  async function enable() {
    if (!supported) return { ok: false, error: "unsupported" };
    if (isIOS() && !isStandalone()) return { ok: false, error: "needs-install" };
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return { ok: false, error: "not-granted" };
    const r = await reg();
    if (!r) return { ok: false, error: "no-sw" };
    let keyResp;
    try { keyResp = await (await aFetch("/push/public-key")).json(); } catch { return { ok: false, error: "no-server" }; }
    if (!keyResp || !keyResp.key) return { ok: false, error: "not-configured" };
    let sub = await r.pushManager.getSubscription();
    // If an existing subscription is bound to a different (old) key, drop it so
    // we re-subscribe with the current one — otherwise sends would keep failing.
    if (sub && subKey(sub) !== keyResp.key) { await sub.unsubscribe().catch(() => {}); sub = null; }
    if (!sub) sub = await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToU8(keyResp.key) });
    try {
      const res = await (await aFetch("/push/subscribe", { method: "POST", body: JSON.stringify({ subscription: sub.toJSON(), ua: navigator.userAgent }) })).json();
      return { ok: !!res.ok, error: res.ok ? null : (res.error || "save-failed") };
    } catch { return { ok: false, error: "save-failed" }; }
  }

  async function disable() {
    const sub = await currentSub();
    if (sub) {
      const endpoint = sub.endpoint;
      await sub.unsubscribe().catch(() => {});
      await aFetch("/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint }) }).catch(() => {});
    }
    return { ok: true };
  }

  async function test() {
    try { return await (await aFetch("/push/test", { method: "POST", body: "{}" })).json(); }
    catch { return { ok: false, error: "failed" }; }
  }

  window.MostlanePush = { supported, isIOS, isStandalone, state, enable, disable, test, syncKey };
  // Silently migrate this device to the current VAPID key if it drifted (rotation).
  try { syncKey(); } catch (e) {}
})();
