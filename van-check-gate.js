/* van-check-gate.js — blocks the FIELD APP when a driver's weekly van check is
   past its deadline. Included (after portal-config.js) on the field-app pages:
   route.html / engineer-jobs.html / inbox.html / you.html.

   WHY: field engineers land on route.html -> engineer-jobs.html and never pass
   through main.html's blocking attention gate, so a missed weekly van check only
   ever showed them a dismissible banner and nothing stopped them working. This is
   the field-app equivalent: an unavoidable overlay until the check is done.

   The ONLY way past it is to DO the van check (van-check.html — which deliberately
   does NOT load this script). If a driver genuinely can't, an admin clears it for
   them the existing way (van-checks.html -> skip this week, /vancheck/skip).

   Scope: the WEEKLY assigned-van check only (one-off "requested" checks are not
   gated here). Source of truth = GET /vancheck/attention, whose mineDue already
   folds in opt-out, admin mute and "no van assigned" — so those drivers are never
   blocked. overdue = the deadline you set in van-check settings has passed.

   SAFETY: fails OPEN. No token, an API error, a bad reply, or no positive
   confirmation => no block. An engineer standing on site must never be locked out
   by a portal glitch or weak signal — the overlay appears only on a definite
   "you owe an overdue check". */
(function () {
  "use strict";

  // Never gate a reused/embedded context or while the owner is impersonating
  // (View As) — they're only looking at the field app.
  try { if (window.top !== window.self) return; } catch (e) { return; }
  try { if (localStorage.getItem("mostlaneViewAsReal")) return; } catch (e) {}

  function api() { return window.MOSTLANE_API || "https://mostlane-api.jamie-def.workers.dev"; }
  function tok() { try { return localStorage.getItem("mostlaneToken") || ""; } catch (e) { return ""; } }
  function dev() { try { return localStorage.getItem("mlDeviceId") || localStorage.getItem("deviceID") || ""; } catch (e) { return ""; } }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  function hide() {
    var el = document.getElementById("mlVcGate");
    if (el) el.remove();
    try { document.documentElement.style.overflow = ""; document.body.style.overflow = ""; } catch (e) {}
  }

  function show(reg) {
    if (document.getElementById("mlVcGate")) return;
    var wrap = document.createElement("div");
    wrap.id = "mlVcGate";
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    wrap.style.cssText = "position:fixed;inset:0;z-index:2147483600;background:#003468;color:#fff;"
      + "display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;"
      + "padding:calc(env(safe-area-inset-top,0px) + 24px) 22px calc(env(safe-area-inset-bottom,0px) + 24px);"
      + "font-family:'Segoe UI',system-ui,-apple-system,sans-serif;overflow:auto;-webkit-overflow-scrolling:touch";
    wrap.innerHTML =
        '<div style="font-size:54px;line-height:1;margin-bottom:14px">🚐</div>'
      + '<h1 style="font-size:22px;margin:0 0 12px;font-weight:700">Weekly van check overdue</h1>'
      + '<p style="font-size:16px;max-width:440px;margin:0 0 4px;opacity:.95">Your weekly van check is past its deadline'
        + (reg ? ' for <b>' + esc(reg) + '</b>' : '') + '.</p>'
      + '<p style="font-size:16px;max-width:440px;margin:0 0 24px;opacity:.95">Please complete it before you use the app.</p>'
      + '<a href="van-check.html" style="display:inline-block;background:#fff;color:#003468;font-weight:700;'
        + 'font-size:17px;text-decoration:none;padding:15px 30px;border-radius:999px">Do my van check now →</a>'
      + '<p style="font-size:13px;max-width:440px;margin:24px 0 0;opacity:.72">Can\'t do it right now? Ask the office — '
        + 'they can record the reason and clear this for you.</p>';
    document.body.appendChild(wrap);
    try { document.documentElement.style.overflow = "hidden"; document.body.style.overflow = "hidden"; } catch (e) {}
  }

  var busy = false;
  function check() {
    if (busy) return;
    var t = tok();
    if (!t) { hide(); return; }              // not logged in — auth guards own this
    busy = true;
    var h = { "Authorization": "Bearer " + t };
    var d = dev(); if (d) h["X-Device-Id"] = d;
    fetch(api() + "/vancheck/attention?t=" + Date.now(), { headers: h, cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        busy = false;
        if (!j || !j.ok) { hide(); return; }  // fail OPEN on any bad reply
        if (j.mineDue && j.overdue) show(j.vehicle || "");
        else hide();                          // done / not due / cleared -> release
      })
      .catch(function () { busy = false; hide(); });  // fail OPEN on network error
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", check);
  else check();
  // Re-evaluate when the app is resumed / brought forward (e.g. after doing the
  // check on van-check.html, or a PWA returning from background) so the block
  // clears itself and never sticks once the check is in.
  window.addEventListener("pageshow", check);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) check(); });
})();
