/* van-check-gate.js — blocks the WHOLE APP when a driver's weekly van check is
   past its deadline. Included (after portal-config.js) on the field-app pages
   route.html / engineer-jobs.html / inbox.html / you.html AND main.html.

   The block fires ONLY once the deadline has PASSED (overdue). Before then the
   reminder is snoozeable (main.html's attention gate / route.html's banner), so
   the hard lockout only ever hits a genuinely-late driver. An admin can lift the
   lockout for one driver for the week (van-checks.html -> "Lift lockout") without
   marking the check done — GET /vancheck/attention then returns lockoutWaived and
   this gate releases while the check stays outstanding.

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

   VIEW AS: while the owner is impersonating a field engineer, the block still
   shows (so it can be verified / previewed against the impersonated driver's real
   state) but is DISMISSIBLE — a "✕ Close (preview)" button so the owner is never
   trapped behind a full-screen overlay that would otherwise cover the return bar.
   A real engineer on their own login gets the hard, non-dismissible block.

   SAFETY: fails OPEN. No token, an API error, a bad reply, or no positive
   confirmation => no block. An engineer standing on site must never be locked out
   by a portal glitch or weak signal — the overlay appears only on a definite
   "you owe an overdue check". */
(function () {
  "use strict";

  // Never gate a reused/embedded context (po.html embeds portal pages).
  try { if (window.top !== window.self) return; } catch (e) { return; }

  // Owner impersonating (View As) => preview mode: show, but dismissible.
  var PREVIEW = false;
  try { PREVIEW = !!localStorage.getItem("mostlaneViewAsReal"); } catch (e) {}

  function api() { return window.MOSTLANE_API || "https://mostlane-api.jamie-def.workers.dev"; }
  function tok() { try { return localStorage.getItem("mostlaneToken") || ""; } catch (e) { return ""; } }
  // The device-bound session is keyed to `deviceID` (what login.html posts and
  // what portal-config's fetch bridge sends). Read THAT first — preferring
  // mlDeviceId sent the wrong id, 401'd the call, and the gate failed open
  // (no block) even when the driver was genuinely overdue.
  function dev() { try { return localStorage.getItem("deviceID") || localStorage.getItem("mlDeviceId") || ""; } catch (e) { return ""; } }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  var dismissed = false;   // preview only: owner closed it for this page view

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
        (PREVIEW ? '<div style="position:absolute;top:calc(env(safe-area-inset-top,0px) + 10px);left:12px;right:12px;'
          + 'font-size:12px;font-weight:600;color:#cfe4ff;opacity:.85;letter-spacing:.02em">PREVIEW — you are viewing as this engineer</div>' : '')
      + '<div style="font-size:54px;line-height:1;margin-bottom:14px">🚐</div>'
      + '<h1 style="font-size:22px;margin:0 0 12px;font-weight:700">Weekly van check overdue</h1>'
      + '<p style="font-size:16px;max-width:440px;margin:0 0 4px;opacity:.95">Your weekly van check is past its deadline'
        + (reg ? ' for <b>' + esc(reg) + '</b>' : '') + '.</p>'
      + '<p style="font-size:16px;max-width:440px;margin:0 0 24px;opacity:.95">Please complete it before you use the app.</p>'
      + '<a href="van-check.html" style="display:inline-block;background:#fff;color:#003468;font-weight:700;'
        + 'font-size:17px;text-decoration:none;padding:15px 30px;border-radius:999px">Do my van check now →</a>'
      + '<p style="font-size:13px;max-width:440px;margin:24px 0 0;opacity:.72">Can\'t do it right now? Ask the office — '
        + 'they can record the reason and clear this for you.</p>'
      + (PREVIEW ? '<button id="mlVcGateClose" type="button" style="margin-top:22px;background:transparent;border:1px solid rgba(255,255,255,.5);'
          + 'color:#fff;font-size:14px;padding:10px 20px;border-radius:999px;cursor:pointer">✕ Close (preview)</button>' : '');
    document.body.appendChild(wrap);
    try { document.documentElement.style.overflow = "hidden"; document.body.style.overflow = "hidden"; } catch (e) {}
    if (PREVIEW) {
      var b = document.getElementById("mlVcGateClose");
      if (b) b.addEventListener("click", function () { dismissed = true; hide(); });
    }
  }

  var busy = false;
  function check() {
    if (busy || (PREVIEW && dismissed)) return;
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
        // Block ONLY when the check is due AND the deadline has passed AND an admin
        // hasn't waived the lockout for this driver this week. Before the deadline
        // (overdue false) there is no hard block — the reminder is snoozeable.
        if (j.mineDue && j.overdue && !j.lockoutWaived) show(j.vehicle || "");
        else hide();                          // done / not due / not yet overdue / waived / cleared -> release
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
