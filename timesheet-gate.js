/* timesheet-gate.js — blocks the WHOLE APP when a person's LAST-WEEK timesheet
   (or invoice, for self-employed) is past its deadline. Included (after
   portal-config.js) on the field-app pages route.html / engineer-jobs.html /
   inbox.html / you.html AND main.html — the same set as the van-check gate.

   Who it applies to + what it asks for is set per person on timesheets-admin →
   Settings (the "Reminder" column): off / timesheet / invoice. The server
   decides via GET /ts/outstanding, whose `due` already folds in the per-user
   mode, the global reminders switch, and whether the week is done/approved —
   so this script just mirrors it.

   The block fires ONLY once the deadline has PASSED (overdue). Before then the
   reminder is snoozeable (main.html's attention gate / the push), so the hard
   lockout only ever hits someone genuinely late — exactly like the weekly van
   check.

   The ONLY way past it is to DO the timesheet/invoice on engineer-timesheet.html
   (which deliberately does NOT load this script). If someone genuinely can't,
   the office clears it the existing ways: set their Reminder to Off, approve the
   week, or (self-employed) once the invoice is in it releases itself.

   VIEW AS: while the owner is impersonating, the block still shows (so it can be
   previewed against that person's real state) but is DISMISSIBLE — a "✕ Close
   (preview)" button so the owner is never trapped.

   SAFETY: fails OPEN. No token, an API error, a bad reply, or no positive
   confirmation => no block. */
(function () {
  "use strict";

  try { if (window.top !== window.self) return; } catch (e) { return; }

  var PREVIEW = false;
  try { PREVIEW = !!localStorage.getItem("mostlaneViewAsReal"); } catch (e) {}

  function api() { return window.MOSTLANE_API || "https://mostlane-api.jamie-def.workers.dev"; }
  function tok() { try { return localStorage.getItem("mostlaneToken") || ""; } catch (e) { return ""; } }
  function dev() { try { return localStorage.getItem("deviceID") || localStorage.getItem("mlDeviceId") || ""; } catch (e) { return ""; } }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  var dismissed = false;

  function hide() {
    var el = document.getElementById("mlTsGate");
    if (el) el.remove();
    try { document.documentElement.style.overflow = ""; document.body.style.overflow = ""; } catch (e) {}
  }

  function show(d) {
    if (document.getElementById("mlTsGate")) return;
    var invoice = d.kind === "invoice" || d.mode === "invoice";
    var week = d.week || "";
    var wk = esc(d.weekLabel || "last week");
    var emoji = invoice ? "🧾" : "⏱️";
    var title = invoice ? "Last week's invoice is overdue" : "Last week's timesheet is overdue";
    var line1 = invoice
      ? "Your invoice for <b>" + wk + "</b> hasn't been sent in and is past the deadline."
      : "Your timesheet for <b>" + wk + "</b> isn't complete and is past the deadline.";
    var btn = invoice ? "Do my invoice now →" : "Do my timesheet now →";
    var href = "engineer-timesheet.html?week=" + encodeURIComponent(week);

    var wrap = document.createElement("div");
    wrap.id = "mlTsGate";
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    wrap.style.cssText = "position:fixed;inset:0;z-index:2147483600;background:#003468;color:#fff;"
      + "display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;"
      + "padding:calc(env(safe-area-inset-top,0px) + 24px) 22px calc(env(safe-area-inset-bottom,0px) + 24px);"
      + "font-family:'Segoe UI',system-ui,-apple-system,sans-serif;overflow:auto;-webkit-overflow-scrolling:touch";
    wrap.innerHTML =
        (PREVIEW ? '<div style="position:absolute;top:calc(env(safe-area-inset-top,0px) + 10px);left:12px;right:12px;'
          + 'font-size:12px;font-weight:600;color:#cfe4ff;opacity:.85;letter-spacing:.02em">PREVIEW — you are viewing as this person</div>' : '')
      + '<div style="font-size:54px;line-height:1;margin-bottom:14px">' + emoji + '</div>'
      + '<h1 style="font-size:22px;margin:0 0 12px;font-weight:700">' + title + '</h1>'
      + '<p style="font-size:16px;max-width:460px;margin:0 0 4px;opacity:.95">' + line1 + '</p>'
      + '<p style="font-size:16px;max-width:460px;margin:0 0 24px;opacity:.95">Please complete it before you use the app.</p>'
      + '<a href="' + href + '" style="display:inline-block;background:#fff;color:#003468;font-weight:700;'
        + 'font-size:17px;text-decoration:none;padding:15px 30px;border-radius:999px">' + btn + '</a>'
      + '<p style="font-size:13px;max-width:460px;margin:24px 0 0;opacity:.72">Can\'t do it right now? Ask the office — they can sort this for you.</p>'
      + (PREVIEW ? '<button id="mlTsGateClose" type="button" style="margin-top:22px;background:transparent;border:1px solid rgba(255,255,255,.5);'
          + 'color:#fff;font-size:14px;padding:10px 20px;border-radius:999px;cursor:pointer">✕ Close (preview)</button>' : '');
    document.body.appendChild(wrap);
    try { document.documentElement.style.overflow = "hidden"; document.body.style.overflow = "hidden"; } catch (e) {}
    if (PREVIEW) {
      var b = document.getElementById("mlTsGateClose");
      if (b) b.addEventListener("click", function () { dismissed = true; hide(); });
    }
  }

  var busy = false;
  function check() {
    if (busy || (PREVIEW && dismissed)) return;
    var t = tok();
    if (!t) { hide(); return; }
    busy = true;
    var h = { "Authorization": "Bearer " + t };
    var d = dev(); if (d) h["X-Device-Id"] = d;
    fetch(api() + "/ts/outstanding?t=" + Date.now(), { headers: h, cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        busy = false;
        if (!j || !j.ok) { hide(); return; }          // fail OPEN
        if (j.due && j.overdue) show(j);               // due AND past the deadline
        else hide();                                   // done / not due / not yet overdue
      })
      .catch(function () { busy = false; hide(); });   // fail OPEN
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", check);
  else check();
  window.addEventListener("pageshow", check);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) check(); });
})();
