/* ============================================================================
 * ml-offline.js — offline write queue for the engineer app.
 * ----------------------------------------------------------------------------
 * The engineer app must keep working with no signal. Every mutating call the
 * app makes carries a client-generated `opId` in its JSON body, and every
 * matching worker endpoint is idempotent (see worker/src/lib/idempotency.js) —
 * so a queued write can be replayed safely, even more than once.
 *
 * This wraps window.fetch transparently:
 *   - Only POST/PATCH/PUT/DELETE to the Mostlane API hosts whose JSON body
 *     carries an "opId" are eligible.
 *   - It only queues on a genuine NETWORK failure (fetch throws). HTTP error
 *     responses (e.g. the 422 completion-enforcement gate, 403) are passed
 *     straight through so the UI still sees and honours them.
 *   - When it queues, it resolves with a synthetic {ok:true,queued:true} so the
 *     engineer's flow continues; the write replays on the next `online` event
 *     or page load.
 *   - Binary photo uploads (FormData, no opId) are NOT queued — they need signal.
 *
 * Load this AFTER portal-config.js so replays still go through the legacy-host
 * bridge + bearer-token layer.
 * ========================================================================== */
(function () {
  "use strict";
  if (window.__mlOffline) return;               // idempotent include
  var KEY = "mlOfflineQueue_v1";
  var HOSTS = ["mostlane-sla.jamie-def.workers.dev", "mostlane-api.jamie-def.workers.dev", "jamie-def.workers.dev"];
  var nativeFetch = window.fetch.bind(window);  // = portal-config's bridged fetch

  function load() { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { return []; } }
  function save(q) { try { localStorage.setItem(KEY, JSON.stringify(q)); } catch (e) {} }
  function isMut(m) { m = String(m || "GET").toUpperCase(); return m === "POST" || m === "PATCH" || m === "PUT" || m === "DELETE"; }
  function hostMatch(u) { try { return HOSTS.some(function (h) { return u.indexOf(h) >= 0; }); } catch (e) { return false; } }
  function hasOpId(b) { return typeof b === "string" && /"opId"\s*:\s*"[^"]+"/.test(b); }
  function serialHeaders(h) {
    var out = {};
    try {
      if (!h) return out;
      if (typeof h.forEach === "function" && !(h instanceof Array)) { h.forEach(function (v, k) { out[k] = v; }); return out; }
      Object.keys(h).forEach(function (k) { out[k] = h[k]; });
    } catch (e) {}
    return out;
  }
  function count() { return load().length; }
  function emit() { try { window.dispatchEvent(new CustomEvent("ml-offline-change", { detail: { queued: count() } })); } catch (e) {} }

  window.fetch = function (input, init) {
    init = init || {};
    var url = typeof input === "string" ? input : (input && input.url) || "";
    var method = init.method || (typeof input !== "string" && input && input.method) || "GET";
    var body = init.body;
    var eligible = hostMatch(url) && isMut(method) && hasOpId(body);
    var p = nativeFetch(input, init);
    if (!eligible) return p;
    return p.catch(function () {
      var q = load();
      q.push({ url: url, method: String(method).toUpperCase(), headers: serialHeaders(init.headers), body: body, at: Date.now() });
      save(q); emit();
      return new Response(JSON.stringify({ ok: true, queued: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
  };

  var flushing = false;
  async function flush() {
    if (flushing) return;
    var q = load();
    if (!q.length) return;
    flushing = true;
    var remain = [];
    for (var i = 0; i < q.length; i++) {
      var it = q[i];
      try {
        var r = await nativeFetch(it.url, { method: it.method, headers: it.headers, body: it.body });
        // 2xx = applied (idempotency makes a duplicate a no-op). 4xx = the write
        // is invalid on replay (e.g. now fails enforcement) — drop it, don't loop
        // forever. 5xx / network error = keep and retry later.
        if (r.status >= 500) remain.push(it);
      } catch (e) {
        remain.push(it);
      }
    }
    save(remain); emit();
    flushing = false;
    if (remain.length && q.length !== remain.length) flush();   // made progress, keep going
  }

  window.__mlOffline = { flush: flush, count: count, KEY: KEY };
  window.addEventListener("online", function () { setTimeout(flush, 300); });
  if (document.readyState === "complete" || document.readyState === "interactive") setTimeout(flush, 1200);
  else window.addEventListener("DOMContentLoaded", function () { setTimeout(flush, 1200); });
})();
