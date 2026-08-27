/* ============================================================================
 * portal-config.js — Mostlane Portal: single API config + legacy bridge.
 * ----------------------------------------------------------------------------
 * Include this FIRST on every page (before auth.js or any fetch):
 *     <script src="/portal-config.js"></script>
 *
 * What it does:
 *   1. Defines the ONE base URL for the consolidated `mostlane-portal` worker.
 *   2. Transparently rewrites calls aimed at the OLD per-feature workers to the
 *      new one — so existing pages keep working without editing their fetch()s.
 *   3. Attaches the logged-in session token (Authorization: Bearer) to API calls.
 *
 * 🔒 SAFETY: until you set MOSTLANE_API to your real deployed URL (i.e. while it
 * still contains "REPLACE-ME"), this script does NOTHING and pages keep calling
 * the existing workers. You flip the entire portal over to the new worker by
 * editing the ONE line below.
 * ==========================================================================*/
(function () {
  // ⬇️ The deployed API worker (separate from the site worker).
  window.MOSTLANE_API = "https://mostlane-api.jamie-def.workers.dev";

  // ── Mostlane embossed logo watermark, on every page ──────────────────────
  // One fixed layer behind all content (html::before) rather than touching each
  // page's body background — so it works everywhere without fighting per-page
  // themes (e.g. the personalised main.html menu background) and every page
  // keeps its own base colour. Pages that used to set the emboss on <body>
  // themselves have had it removed, so there is no doubling.
  (function embossBackground() {
    var css =
      'html::before{content:"";position:fixed;top:0;left:0;right:0;bottom:0;' +
      'z-index:-1;pointer-events:none;' +
      "background:url('/Mostlane_Embossed.png') no-repeat center center;" +
      'background-size:cover;opacity:.9;}';
    function inject() {
      if (document.getElementById("mlEmbossCss")) return;
      var st = document.createElement("style");
      st.id = "mlEmbossCss";
      st.textContent = css;
      (document.head || document.documentElement).appendChild(st);
    }
    inject();
    document.addEventListener("DOMContentLoaded", inject);
  })();

  // ── Canonical people order, shared by every page/dropdown ────────────────
  // Office staff first, then field, each by the manual drag order set in Users
  // admin (StaffType + SortOrder from /users), name as a fallback. Pages that
  // build a user/engineer dropdown should sort with mlUserCmp (or mlOrderUsers)
  // instead of an alphabetical compare, so the whole portal lists people alike.
  window.mlUserCmp = function (a, b) {
    var ra = (a && a.StaffType === "office") ? 0 : 1;
    var rb = (b && b.StaffType === "office") ? 0 : 1;
    if (ra !== rb) return ra - rb;
    var sa = (a && isFinite(a.SortOrder)) ? Number(a.SortOrder) : 9999;
    var sb = (b && isFinite(b.SortOrder)) ? Number(b.SortOrder) : 9999;
    if (sa !== sb) return sa - sb;
    var na = (((a && a.FirstName) || "") + " " + ((a && a.LastName) || "")).trim().toLowerCase();
    var nb = (((b && b.FirstName) || "") + " " + ((b && b.LastName) || "")).trim().toLowerCase();
    return na.localeCompare(nb);
  };
  window.mlOrderUsers = function (list) {
    return (Array.isArray(list) ? list.slice() : []).sort(window.mlUserCmp);
  };

  // ── Per-user personalisation (colour theme + menu background) ────────────
  // Preferences are stored server-side (users.profile.theme, gated by the
  // ThemeColour / ThemeBackground permissions) and cached in localStorage so
  // every page paints instantly with the user's colours. theme.html edits them.
  (function themeEngine() {
    var ACCENTS = {
      blue:     null,   // the default look — no overrides at all
      teal:     { c1: "#0E7C7B", c2: "#074B4E", a: "#0A9396" },
      green:    { c1: "#2E7D32", c2: "#124D1B", a: "#2F9E44" },
      purple:   { c1: "#5E35B1", c2: "#2E1065", a: "#7048E8" },
      burgundy: { c1: "#9C2542", c2: "#5C0E23", a: "#C2334F" },
      orange:   { c1: "#D9750B", c2: "#8A4503", a: "#E8890C" },
      slate:    { c1: "#546A7B", c2: "#26333E", a: "#5B7186" },
      midnight: { c1: "#2B3467", c2: "#121737", a: "#3E4C9A" }
    };
    var BG_COLOURS = {
      sky: "#dfe9f5", sand: "#f0e9dc", sage: "#e4ecdf",
      blush: "#f3e4e4", lavender: "#e9e4f2", steel: "#dde2e8"
    };
    window.ML_ACCENTS = ACCENTS;
    window.ML_BG_COLOURS = BG_COLOURS;

    function apply(theme) {
      theme = theme || {};
      var css = "";
      var acc = ACCENTS[theme.accent];
      if (acc) {
        css += "header.page{background:linear-gradient(180deg," + acc.c1 + "," + acc.c2 + ")!important;}"
          + "#pnav{background:linear-gradient(185deg," + acc.c1 + " 0%," + acc.c2 + " 100%)!important;}"
          + ".menu-grid a.button{background:linear-gradient(180deg," + acc.c1 + " 0%," + acc.c2 + " 100%)!important;}"
          + ".btn:not(.grey):not(.red):not(.green){background:" + acc.a + "!important;}"
          + "#mlNotify .mln-head{background:linear-gradient(180deg," + acc.c1 + "," + acc.c2 + ")!important;}";
      }
      // The background choice applies to the main menu page (where the
      // embossed Mostlane picture lives).
      var page = (location.pathname.split("/").pop() || "").toLowerCase();
      if (page === "main.html" && theme.bg && theme.bg.type) {
        if (theme.bg.type === "colour" && BG_COLOURS[theme.bg.value]) {
          css += "body{background:" + BG_COLOURS[theme.bg.value] + "!important;}";
        } else if (theme.bg.type === "image" && /^theme\//.test(String(theme.bg.value || ""))) {
          css += "body{background:#3a4149 url('" + window.MOSTLANE_API + "/asset-image?key="
            + encodeURIComponent(theme.bg.value) + "') no-repeat center center!important;background-size:cover!important;}";
        }
      }
      var st = document.getElementById("mlThemeCss");
      if (!st) {
        st = document.createElement("style");
        st.id = "mlThemeCss";
        (document.head || document.documentElement).appendChild(st);
      }
      st.textContent = css;
    }
    window.mlApplyTheme = apply;   // theme.html uses this for live preview

    // 1) Instant paint from the cached copy.
    var cached = null;
    try { cached = JSON.parse(localStorage.getItem("mostlaneTheme") || "null"); } catch (e) {}
    if (cached) apply(cached);

    // Re-apply when iOS restores a page from the back/forward cache — the
    // theme may have been changed on the page the user is coming back from.
    window.addEventListener("pageshow", function (e) {
      if (!e.persisted) return;
      var t = null;
      try { t = JSON.parse(localStorage.getItem("mostlaneTheme") || "null"); } catch (err) {}
      apply(t || {});
    });

    // 2) Background refresh from the server — the server strips anything the
    // user is no longer allowed (permission changes win over stale caches).
    var tok = localStorage.getItem("mostlaneToken");
    if (tok) {
      fetch(window.MOSTLANE_API + "/theme", { headers: { "Authorization": "Bearer " + tok } })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d || !d.ok) return;
          try {
            localStorage.setItem("mostlaneTheme", JSON.stringify(d.theme || {}));
            localStorage.setItem("mostlaneThemeCan", JSON.stringify(d.can || {}));
          } catch (e) {}
          if (JSON.stringify(d.theme || {}) !== JSON.stringify(cached || {})) apply(d.theme || {});
        }).catch(function () {});
    }
  })();

  // ── Activity log: page views ──────────────────────────────────────────────
  // One tiny beacon per page open (logged-in users only). Actions themselves
  // are recorded server-side by the API, so this just adds "who opened what,
  // when" to the activity log in Users admin.
  (function pageView() {
    try {
      var tok = localStorage.getItem("mostlaneToken");
      if (!tok) return;
      var page = (location.pathname.split("/").pop() || "index.html").toLowerCase();
      if (["login.html", "onboard.html", "forgot-password.html", "reset-password.html", "confirmation.html"].indexOf(page) !== -1) return;
      fetch(window.MOSTLANE_API + "/audit/pageview", {
        method: "POST", keepalive: true,
        headers: { "Authorization": "Bearer " + tok, "Content-Type": "application/json" },
        body: JSON.stringify({ page: page })
      }).catch(function () {});
    } catch (e) {}
  })();

  const API = window.MOSTLANE_API.replace(/\/$/, "");
  const CONFIGURED = !/REPLACE-ME/.test(API);

  // Old worker host  ->  how to map its requests onto the new worker.
  // Only FULLY-migrated features are listed here; anything not listed keeps
  // hitting its existing worker until it's ported. Add a line as each is ported.
  const ROUTES = [
    { host: "login.jamie-def.workers.dev" },                        // /auth/*, /admin/login-history
    { host: "mostlane-users.jamie-def.workers.dev" },               // /user, /users
    { host: "mostlane-holidays.jamie-def.workers.dev" },            // /holiday/*
    { host: "mostlane-assets.jamie-def.workers.dev" },              // /assets, /asset/*, images
    { host: "mostlane-sla.jamie-def.workers.dev", prefix: "/sla" }, // /jobs -> /sla/jobs, etc.
    { host: "mostlane-sites.jamie-def.workers.dev" },               // /get-sites, /add-site, /update-site, /upload-image
    { host: "userdevicekv.jamie-def.workers.dev",                   // device lock
      rewrite: p => p.replace(/^\/auth\//, "/device/") },
  ];

  if (!CONFIGURED) {
    console.warn("[portal-config] MOSTLANE_API not set — still using legacy workers. Edit portal-config.js after deploy.");
    return; // no-op until configured
  }

  const TOKEN_KEY = "mostlaneToken";
  const nativeFetch = window.fetch.bind(window);

  // Request coalescing: the menu and the sidebar both ask for the same badge /
  // attention data on load. For a short list of idempotent GET endpoints we
  // merge truly-CONCURRENT identical requests into one network call. It only
  // shares a request that's still in flight — once it resolves the entry is
  // cleared, so there's zero staleness (a later fetch always hits the network).
  let apiHost = "";
  try { apiHost = new URL(API).host; } catch (e) {}
  const inflight = {};
  const COALESCE = /^\/(theme|prefs|auth\/me|po-config|vancheck\/attention|holiday\/(my|all)|asset\/(transfers\/pending-count|requests\/attention))/;
  function doFetch(finalUrl, init) {
    const method = ((init && init.method) || "GET").toUpperCase();
    let ok = false;
    if (method === "GET") {
      try { const uu = new URL(finalUrl, location.href); ok = uu.host === apiHost && COALESCE.test(uu.pathname); } catch (e) {}
    }
    if (!ok) return nativeFetch(finalUrl, init);
    if (inflight[finalUrl]) return inflight[finalUrl].then(r => r.clone());
    const p = nativeFetch(finalUrl, init);
    inflight[finalUrl] = p;
    const clear = () => { delete inflight[finalUrl]; };
    p.then(clear, clear);
    return p.then(r => r.clone());
  }

  window.fetch = function (input, init) {
    try {
      const urlStr = (typeof input === "string") ? input : (input && input.url);
      if (urlStr) {
        const u = new URL(urlStr, location.href);
        const route = ROUTES.find(r => u.host === r.host);
        if (route) {
          let path = u.pathname;
          if (route.rewrite) path = route.rewrite(path);
          const newUrl = API + (route.prefix || "") + path + u.search;

          init = Object.assign({}, init);
          const headers = new Headers(
            (init && init.headers) ||
            (typeof input !== "string" && input ? input.headers : undefined)
          );
          const token = localStorage.getItem(TOKEN_KEY);
          if (token && !headers.has("Authorization")) {
            headers.set("Authorization", "Bearer " + token);
          }
          init.headers = headers;
          return doFetch(newUrl, init);
        }
        // Direct calls to the API host (badges/attention) coalesce too.
        if (typeof input === "string") return doFetch(input, init);
      }
    } catch (e) {
      console.error("[portal-config] fetch bridge error:", e);
    }
    return nativeFetch(input, init);
  };

  // Convenience for new code: apiFetch("/user?u=...") hits the new worker directly.
  window.apiFetch = function (path, init) { return window.fetch(API + path, init); };

  // ── Story Mode: floating "back to My Day" button on every portal page ──────
  // The guided day is a Story Mode engineer's home screen; wherever they wander
  // in the portal, one tap brings them straight back.
  try {
    var smPerms = {};
    try { smPerms = JSON.parse(sessionStorage.getItem("mostlanePermissions") || localStorage.getItem("mostlanePermissions") || "{}"); } catch (e) {}
    var smPage = (location.pathname.split("/").pop() || "").toLowerCase();
    var smSkip = ["my-day.html", "login.html", "onboard.html", "forgot-password.html",
                  "reset-password.html", "change-password.html", "index.html", ""];
    if (smPerms.StoryMode === "Yes" && smSkip.indexOf(smPage) === -1) {
      var addBtn = function () {
        if (document.getElementById("smReturnBtn")) return;
        var a = document.createElement("a");
        a.id = "smReturnBtn";
        a.href = "/my-day.html";
        a.textContent = "⚡ My Day";
        a.style.cssText = "position:fixed;bottom:18px;right:16px;z-index:99998;" +
          "background:linear-gradient(90deg,#003b82,#1e66ff);color:#fff;text-decoration:none;" +
          "font:700 15px/1 system-ui,-apple-system,sans-serif;padding:13px 18px;border-radius:999px;" +
          "box-shadow:0 6px 18px rgba(0,30,80,.35);";
        document.body.appendChild(a);
      };
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", addBtn);
      else addBtn();
    }
  } catch (e) {}

  // ── Field users: every "back / home" button returns to the You launcher ──────
  // Field staff (Staff Type = field, non-admin) live entirely in the engineer
  // app. A page's hard-coded back button must never drop them on the office menu
  // — or a page they lack permission for (e.g. van-check's back → vehicles.html).
  // So on every portal page, repoint the standard back button (data-role="home")
  // to you.html. Uses the shared mlIsFieldUser when present, else an inline copy
  // (ml-perms.js isn't loaded on every page; portal-config.js is).
  function mlFieldUserLocal() {
    try {
      if (typeof window.mlIsFieldUser === "function") return window.mlIsFieldUser();
      var p = JSON.parse(sessionStorage.getItem("mostlanePermissions") || localStorage.getItem("mostlanePermissions") || "{}") || {};
      var yes = function (v) { return String(v || "").toLowerCase() === "yes"; };
      if (yes(p.FullAccess) || yes(p.SLAAdmin)) return false;
      var st = String(localStorage.getItem("mostlaneStaffType") || sessionStorage.getItem("mostlaneStaffType") || "").toLowerCase();
      if (st === "office") return false;
      if (st === "field") return true;
      return yes(p.SLA) || yes(p.StoryMode);
    } catch (e) { return false; }
  }
  try {
    var fuPage = (location.pathname.split("/").pop() || "").toLowerCase();
    var FU_SKIP = ["login.html", "onboard.html", "forgot-password.html", "reset-password.html",
                   "change-password.html", "you.html", "route.html", "inbox.html", "engineer-jobs.html"];
    if (FU_SKIP.indexOf(fuPage) === -1 && mlFieldUserLocal()) {
      var fixBacks = function () {
        var links = document.querySelectorAll('[data-role="home"]');
        for (var i = 0; i < links.length; i++) { links[i].setAttribute("href", "/main.html"); }
      };
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fixBacks);
      else fixBacks();
    }
  } catch (e) {}

  // ── Back buttons: breadcrumb trail (loop-proof) ─────────────────────────────
  // Back must return to the page the user was ACTUALLY on before this one, and it
  // must never trap them in a revolving cycle. We do NOT use history.back(): the
  // portal mixes pop-navigation (history.back) with push-navigation
  // (location.href="parent") across pages, and mixing the two ping-pongs
  // parent⇄child forever (the reported SLA job-card loop). Instead we keep our own
  // per-tab trail in sessionStorage. Returning to a page ALREADY in the trail
  // COLLAPSES the trail back to it rather than growing it, so a cycle is
  // structurally impossible. window.mlBack(fallback) is the one way to go back;
  // the .ml-back handler and the pages' own custom back buttons all call it.
  (function mlNavBack() {
    var KEY = "mlNavTrail";
    function read() { try { return JSON.parse(sessionStorage.getItem(KEY) || "[]") || []; } catch (e) { return []; } }
    function write(a) { try { sessionStorage.setItem(KEY, JSON.stringify(a.slice(-60))); } catch (e) {} }
    // Record this page in the trail (runs on every load; no DOM needed).
    try {
      var here = location.pathname + location.search;
      var trail = read();
      if (trail[trail.length - 1] === here) {
        // reload of the same page — leave the trail unchanged
      } else if (trail[trail.length - 2] === here) {
        trail.pop();                    // stepped back to the previous page → collapse
      } else {
        var idx = trail.lastIndexOf(here);
        if (idx >= 0) trail = trail.slice(0, idx + 1);  // jumped to an earlier page → collapse to it
        else trail.push(here);          // genuinely new page → extend
      }
      write(trail);
    } catch (e) {}
    // The single "go back" entry point. `fallback` is used on a cold start (fresh
    // PWA launch / wiped sessionStorage) where we have no trail to walk.
    window.mlBack = function (fallback) {
      var t = read();
      var prev = t.length >= 2 ? t[t.length - 2] : "";
      var dest = prev || fallback || "/main.html";
      location.href = dest;
    };
    document.addEventListener("click", function (e) {
      // Leave modifier / middle clicks (open-in-new-tab) alone.
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var a = e.target && e.target.closest ? e.target.closest(".ml-back") : null;
      if (!a) return;
      e.preventDefault();
      // The button's own href is the sensible parent — use it as the cold-start
      // fallback so the user is never stranded when there's no trail.
      var href = a.getAttribute("href") || "";
      window.mlBack(href && href !== "#" ? href : "");
    }, true);
  })();

  // ── MLUI: styled toasts + confirm dialog (portal-wide) ──────────────────────
  // window.alert() everywhere becomes a clean branded toast (non-blocking; a
  // toast raised just before a redirect survives onto the next page), and
  // window.MLUI.confirm(msg, {title, okLabel, danger}) is a Promise-based
  // styled replacement for confirm() that pages adopt call-site by call-site
  // (native confirm stays available — it's synchronous, so it can't be swapped
  // globally without rewriting callers).
  (function mlui() {
    var PENDING_KEY = "mlToastPending";
    function ensureCss() {
      if (document.getElementById("mlui-css")) return;
      var s = document.createElement("style");
      s.id = "mlui-css";
      s.textContent =
        "#mlToastHost{position:fixed;left:0;right:0;bottom:calc(24px + env(safe-area-inset-bottom,0px));z-index:2147482000;display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none;}" +
        ".ml-toast{pointer-events:auto;max-width:min(92vw,460px);background:#0f172a;color:#fff;border-radius:12px;padding:12px 18px;font:600 14px/1.45 'Segoe UI',system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.35);opacity:0;transform:translateY(8px);transition:opacity .22s,transform .22s;cursor:pointer;white-space:pre-line;text-align:center;}" +
        ".ml-toast.on{opacity:1;transform:none;}" +
        ".ml-toast.ok{background:#14532d;}" +
        ".ml-toast.err{background:#7f1d1d;}" +
        ".ml-confirm-ov{position:fixed;inset:0;z-index:2147482001;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:18px;}" +
        ".ml-confirm{background:#fff;border-radius:16px;max-width:420px;width:100%;padding:20px 22px;box-shadow:0 18px 50px rgba(0,0,0,.35);font-family:'Segoe UI',system-ui,sans-serif;}" +
        ".ml-confirm h3{margin:0 0 8px;font-size:17px;color:#003366;}" +
        ".ml-confirm p{margin:0;font-size:14.5px;line-height:1.55;color:#334155;white-space:pre-line;}" +
        ".ml-confirm .mlc-btns{display:flex;justify-content:flex-end;gap:10px;margin-top:18px;}" +
        ".ml-confirm button{border:none;border-radius:10px;padding:10px 16px;font:600 14px 'Segoe UI',system-ui;cursor:pointer;}" +
        ".ml-confirm .mlc-cancel{background:#eef2f6;color:#1f2a44;}" +
        ".ml-confirm .mlc-ok{background:#003b82;color:#fff;}" +
        ".ml-confirm .mlc-ok.danger{background:#dc2626;}";
      (document.head || document.documentElement).appendChild(s);
    }
    var earlyQueue = [];
    function show(msg, type) {
      if (!document.body) { earlyQueue.push([msg, type]); return; }
      ensureCss();
      var host = document.getElementById("mlToastHost");
      if (!host) { host = document.createElement("div"); host.id = "mlToastHost"; document.body.appendChild(host); }
      var t = document.createElement("div");
      t.className = "ml-toast" + (type ? " " + type : "");
      t.textContent = msg;
      host.appendChild(t);
      requestAnimationFrame(function () { t.classList.add("on"); });
      var gone = false;
      var kill = function () { if (gone) return; gone = true; t.classList.remove("on"); setTimeout(function () { t.remove(); }, 250); };
      t.addEventListener("click", kill);
      setTimeout(kill, Math.min(9000, 3200 + msg.length * 30));
    }
    function toast(msg, type) {
      msg = String(msg == null ? "" : msg);
      if (!msg) return;
      // Survive an immediate redirect: stash the toast; the next page re-shows
      // it if we unloaded within ~1.5s, else the stash is cleared below.
      try { sessionStorage.setItem(PENDING_KEY, JSON.stringify({ msg: msg, type: type || "", at: Date.now() })); } catch (e) {}
      setTimeout(function () { try { sessionStorage.removeItem(PENDING_KEY); } catch (e) {} }, 1500);
      show(msg, type);
    }
    function confirmBox(msg, opts) {
      opts = opts || {};
      ensureCss();
      return new Promise(function (resolve) {
        var ov = document.createElement("div");
        ov.className = "ml-confirm-ov";
        ov.innerHTML = '<div class="ml-confirm" role="dialog" aria-modal="true"><h3 style="display:none"></h3><p></p>' +
          '<div class="mlc-btns"><button type="button" class="mlc-cancel"></button>' +
          '<button type="button" class="mlc-ok' + (opts.danger ? " danger" : "") + '"></button></div></div>';
        if (opts.title) { var h = ov.querySelector("h3"); h.style.display = ""; h.textContent = opts.title; }
        ov.querySelector("p").textContent = String(msg == null ? "" : msg);
        ov.querySelector(".mlc-cancel").textContent = opts.cancelLabel || "Cancel";
        ov.querySelector(".mlc-ok").textContent = opts.okLabel || "OK";
        var done = function (v) { ov.remove(); document.removeEventListener("keydown", onKey, true); resolve(v); };
        var onKey = function (e) { if (e.key === "Escape") { e.preventDefault(); done(false); } };
        ov.querySelector(".mlc-cancel").addEventListener("click", function () { done(false); });
        ov.querySelector(".mlc-ok").addEventListener("click", function () { done(true); });
        ov.addEventListener("click", function (e) { if (e.target === ov) done(false); });
        document.addEventListener("keydown", onKey, true);
        document.body.appendChild(ov);
        try { ov.querySelector(".mlc-ok").focus(); } catch (e) {}
      });
    }
    function boot() {
      earlyQueue.splice(0).forEach(function (a) { show(a[0], a[1]); });
      try {
        var p = JSON.parse(sessionStorage.getItem(PENDING_KEY) || "null");
        sessionStorage.removeItem(PENDING_KEY);
        if (p && p.msg && Date.now() - (p.at || 0) < 5000) show(p.msg, p.type);
      } catch (e) {}
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    else boot();
    window.MLUI = { toast: toast, confirm: confirmBox };
    window.alert = function (m) { toast(m); };
  })();

  // ── Status-bar cap: the slim branded bar every native app has ───────────────
  // The installed PWA is `apple-mobile-web-app-status-bar-style: black-translucent`
  // (set on main.html, the start_url, so it governs the WHOLE app). That makes
  // every page run full-bleed UNDER the iOS clock/battery. Rather than have each
  // page pad its own header — which only ever covered the handful of pages that
  // also set viewport-fit=cover, and left the rest with an untappable back button
  // — this paints one opaque bar across the status-bar inset and pushes the page
  // below it, portal-wide. Height is exactly the device's inset (0 on a phone
  // with no notch, and in a normal browser tab), so it's only ever as slim as it
  // needs to be. Content scrolling under it looks right because it's opaque.
  (function statusCap() {
    // Only the top document paints it — po.html embeds portal pages in an
    // iframe, and a second cap inside the frame would double the gap.
    try { if (window.self !== window.top) return; } catch (e) { return; }
    if (document.getElementById("ml-statuscap-style")) return;
    var st = document.createElement("style");
    st.id = "ml-statuscap-style";
    st.textContent =
      // The offset goes on <html>, NOT <body>. Two earlier attempts on body both
      // misfired: a CSS rule replaced whatever padding a page set for itself,
      // and a JS one that added to it broke pages where BODY is the scroll
      // container (main.html sets overflow-x:hidden, which makes overflow-y
      // scrollable on body) — padding a scroll box left a strip of background
      // at the end of the scroll range. Padding <html> instead shifts the whole
      // page down, and because percentage heights resolve against the parent's
      // CONTENT box, a `body{height:100%}` shrinks to fit exactly. Nothing
      // overflows and no page's own padding is touched.
      // min-height:100vh pins <html> to the FULL screen. With viewport-fit=cover
      // iOS can resolve a page's own `html{height:100%}` against the SAFE-AREA
      // box rather than the screen, which leaves the page ending short and a
      // band of canvas below it — the bottom bar Jamie kept seeing on main.html
      // (the one page that sets html,body{height:100%}). Chromium doesn't
      // reproduce that, so this is belt-and-braces: where html is already
      // full-height it changes nothing.
      // `--ml-topbar` is extra room for anything else pinned across the top —
      // currently the van-score banner. It's fixed, so without reserving space
      // it simply covered the first row of the page (Jamie saw the Van Check /
      // Holiday tiles sliced in half). Whatever sets it must clear it again.
      // padding-top is !important: portal-config runs as a head script and
      // injects this BEFORE a page's own <style> is parsed, so a page that
      // resets `html{padding:0}` (e.g. po-office) would otherwise zero the inset
      // and its header/back button would sit UNDER the fixed cap. !important
      // keeps the cap's inset winning regardless of a page's own html padding.
      "html{ box-sizing:border-box; min-height:100vh;"
      + "  padding-top:calc(env(safe-area-inset-top, 0px) + var(--ml-topbar, 0px)) !important; }"
      // `vh` is measured against the FULL screen and ignores the padding above,
      // so a page with `body{min-height:100vh}` (route.html and friends) ends up
      // exactly one inset too tall — the blank strip again. Re-base it. Pages
      // with no min-height simply gain a full-height body, which is harmless
      // and makes short pages fill the screen rather than half-paint it.
      + "body{ min-height:calc(100vh - env(safe-area-inset-top, 0px) - var(--ml-topbar, 0px)); }"
      + "@media (orientation:landscape){ html{ padding-left:env(safe-area-inset-left, 0px) !important;"
      + "  padding-right:env(safe-area-inset-right, 0px) !important; } }"
      + "#mlStatusCap{ position:fixed; top:0; left:0; right:0; height:env(safe-area-inset-top, 0px);"
      + "  background:#003468; z-index:2147483000; pointer-events:none; }"
;
    (document.head || document.documentElement).appendChild(st);

    var cap = null;
    function add() {
      if (!document.body || document.getElementById("mlStatusCap")) return;
      cap = document.createElement("div");
      cap.id = "mlStatusCap";
      document.body.appendChild(cap);
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add);
    else add();
  })();


  // ── Loading indicator: the Mostlane "M" spins, rests, spins again ───────────
  // There are ~200 "Loading…" strings across ~80 pages, written every which way
  // (static HTML, innerHTML, textContent). Rather than edit them all, this
  // upgrades any element whose WHOLE text is a loading phrase into the shared
  // animated mark, keeping the original wording as the label ("Loading sites…"
  // still reads as such). New code should call MLUI.loading() directly.
  (function mlLoading() {
    var ICON = "/icons/icon-192.png";
    // This component injects its OWN stylesheet rather than riding the sidebar's
    // (#pnav-style). That block is skipped inside iframes (po.html embeds
    // po-office.html), on the auth/my-day pages, and for Story users — and
    // without the CSS the mark would render as a raw 192px icon.
    function injectCss() {
      if (document.getElementById("ml-load-style")) return;
      var st = document.createElement("style");
      st.id = "ml-load-style";
      st.textContent =
        "@keyframes mlSpinStop{ 0%{transform:rotate(0)} 55%{transform:rotate(360deg)} 100%{transform:rotate(360deg)} }"
        + ".ml-load{ display:inline-flex; align-items:center; gap:.55em; color:inherit; font-size:inherit; vertical-align:middle; }"
        // Sized in em so it matches whatever it sits in — a small grey footer
        // status line and a full-size card row both look right.
        + ".ml-load .ml-load-m{ width:1.45em; height:1.45em; border-radius:.3em; flex:none; display:block;"
        + "  animation:mlSpinStop 1.7s cubic-bezier(.55,.05,.35,1) infinite; }"
        // Bigger centred variant for a whole empty panel (MLUI.loading(t,{big:1})).
        + ".ml-load.big{ flex-direction:column; gap:11px; padding:26px 10px; width:100%; justify-content:center; }"
        + ".ml-load.big .ml-load-m{ width:44px; height:44px; border-radius:9px; }"
        // Honour the OS "reduce motion" setting — hold it still rather than spin.
        + "@media (prefers-reduced-motion: reduce){ .ml-load .ml-load-m{ animation:none; } }";
      (document.head || document.documentElement).appendChild(st);
    }
    injectCss();
    // ANY wait state, not a fixed word list — the portal says Loading fleet…,
    // Checking access…, Reading spreadsheet…, Opening Purchase Orders…, Placing
    // jobs by postcode…, Claude is revising the programme…, and dozens more.
    // Two signals together identify one, and BOTH are needed:
    //   1. it ends in an ellipsis, and
    //   2. it contains a GERUND (an "-ing" word).
    // The ellipsis alone is not enough — dropdown placeholders ("Select site…",
    // "Choose a person…") and menu/button labels ("Edit finance…", "🗓 Shift
    // dates…", "Mark selected as…") all end in one. The gerund alone is not
    // enough either — the H&S pages carry "Working days" and "Working On or Near
    // Live Services". Checked against every "…" string in the repo: 100 wait
    // states matched, and the 22 non-matches are all placeholders or buttons.
    var STOP = { nothing: 1, something: 1, anything: 1, everything: 1, morning: 1,
      evening: 1, during: 1, thing: 1, string: 1, spring: 1, ring: 1, king: 1,
      ceiling: 1, sing: 1, wing: 1, bring: 1 };
    function isBusy(t) {
      if (!t || t.length > 40) return false;
      // Bare "Loading" (no ellipsis) is the one accepted exception.
      if (!/(…|\.\.\.)$/.test(t)) return /^loading$/i.test(t);
      if (/^\s*(please wait|one moment)\b/i.test(t)) return true;
      var re = /\b([a-z]{2,})ing\b/ig, m;   // fresh each call — /g keeps lastIndex
      while ((m = re.exec(t))) { if (!STOP[(m[1] + "ing").toLowerCase()]) return true; }
      return false;
    }
    var SKIP = { OPTION: 1, OPTGROUP: 1, SELECT: 1, TITLE: 1, SCRIPT: 1, STYLE: 1, TEXTAREA: 1, INPUT: 1, BUTTON: 1 };
    function esc(s) {
      return String(s).replace(/[&<>"]/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
      });
    }
    function markup(label, big) {
      return '<span class="ml-load' + (big ? " big" : "") + '" role="status" aria-live="polite">'
        + '<img class="ml-load-m" src="' + ICON + '" alt="" aria-hidden="true">'
        + '<span class="ml-load-t">' + esc(label == null ? "Loading…" : label) + "</span></span>";
    }
    function upgrade(el) {
      if (!el || el.nodeType !== 1 || SKIP[el.tagName]) return;
      // Text-only nodes. This ALSO means an already-upgraded element is skipped
      // (it now holds our <span>), so no permanent "done" flag is needed — and
      // must not be used: a page that re-shows its status (vehicles.html does
      // `statusLine.textContent = "Loading fleet…"` on every refresh) wipes the
      // mark back to plain text, and a sticky flag left it that way for good.
      if (el.children && el.children.length) return;
      // Never re-process our own markup (its label would match too).
      if (el.closest && el.closest(".ml-load")) return;
      if (!isBusy((el.textContent || "").trim())) return;
      el.innerHTML = markup((el.textContent || "").trim(), false);
    }
    var queue = [], pending = false;
    function flush() { pending = false; var q = queue; queue = []; for (var i = 0; i < q.length; i++) upgrade(q[i]); }
    function schedule() {
      if (pending || !queue.length) return;
      pending = true;
      (window.requestAnimationFrame || function (f) { setTimeout(f, 0); })(flush);
    }
    function consider(n) {
      if (!n) return;
      if (n.nodeType === 3) { queue.push(n.parentElement); return; }
      if (n.nodeType !== 1) return;
      queue.push(n);
      // Cheap: only look inside small subtrees (a rendered list is re-checked
      // by its own added rows anyway).
      if (n.children && n.children.length && n.querySelectorAll) {
        var d = n.querySelectorAll("*");
        if (d.length <= 60) for (var i = 0; i < d.length; i++) queue.push(d[i]);
      }
    }
    function start() {
      if (!document.body) return;
      var all = document.body.querySelectorAll("*");
      if (all.length <= 8000) for (var i = 0; i < all.length; i++) upgrade(all[i]);
      try {
        new MutationObserver(function (muts) {
          for (var i = 0; i < muts.length; i++) {
            var m = muts[i];
            if (m.type === "characterData") queue.push(m.target && m.target.parentElement);
            else for (var j = 0; j < m.addedNodes.length; j++) consider(m.addedNodes[j]);
          }
          schedule();
        }).observe(document.body, { childList: true, subtree: true, characterData: true });
      } catch (e) {}
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();
    window.MLUI = window.MLUI || {};
    // MLUI.loading("Loading jobs…")        → inline mark + label (HTML string)
    // MLUI.loading("Loading jobs…", {big:true}) → large centred, for a whole panel
    window.MLUI.loading = function (text, opts) { return markup(text, opts && opts.big); };
  })();

  // ── View As (owner only) ────────────────────────────────────────────────────
  // Jamie can open a real session as any user to see exactly what they see.
  // The server locks /auth/impersonate to the owner account and audits each use.
  // While viewing, a purple bottom bar on every page returns him to himself,
  // and the device lock is bypassed for the session (it's still his device).
  (function viewAs() {
    try {
      var OWNER = "Jamie Line";
      var vaPage = (location.pathname.split("/").pop() || "").toLowerCase();
      var VA_SKIP = ["login.html", "onboard.html", "confirmation.html", "forgot-password.html",
        "reset-password.html", "change-password.html", "hash.html"];
      if (VA_SKIP.indexOf(vaPage) !== -1) return;

      function setBoth(k, v) { try { localStorage.setItem(k, v); sessionStorage.setItem(k, v); } catch (e) {} }
      function applySession(d) {
        var u = d.user || {};
        localStorage.setItem(TOKEN_KEY, d.token);
        setBoth("mostlaneUser", u.Username || "");
        setBoth("mostlaneUsername", u.Username || "");
        var pj = JSON.stringify(u);
        setBoth("mostlanePermissions", pj);
        setBoth("mostlaneLoggedIn", "true");
        sessionStorage.setItem("mostlaneFolder", u.SharePointPath || "");
        sessionStorage.setItem("mostlaneVehicle", u.VehicleAssigned || "");
        sessionStorage.setItem("mostlaneEmployment", u.EmploymentType || "");
        sessionStorage.setItem("mostlaneMasterLogin", "1");   // bypass device lock while viewing
      }

      // Owner-only picker, callable from the sidebar and main.html.
      window.mlViewAsPicker = function () {
        if (document.getElementById("mlVaPick")) return;
        var token = localStorage.getItem(TOKEN_KEY);
        if (!token) return;
        var wrap = document.createElement("div");
        wrap.id = "mlVaPick";
        wrap.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:100000;display:flex;align-items:center;justify-content:center;padding:20px;";
        var card = document.createElement("div");
        card.style.cssText = "background:#fff;border-radius:14px;max-width:340px;width:100%;padding:18px;font-family:'Segoe UI',system-ui,sans-serif;";
        card.innerHTML = '<h3 style="margin:0 0 4px;color:#003366;font-size:16px;">👁 View portal as…</h3>'
          + '<p style="margin:0 0 10px;color:#667085;font-size:12.5px;">You will see exactly what they see. Use the purple bar at the bottom to return to your own account.</p>';
        var sel = document.createElement("select");
        sel.style.cssText = "width:100%;padding:10px;border:1px solid #ccd5dd;border-radius:8px;font-size:16px;";
        sel.innerHTML = "<option>Loading…</option>";
        var row = document.createElement("div");
        row.style.cssText = "display:flex;gap:8px;margin-top:12px;";
        var go = document.createElement("button");
        go.textContent = "View as";
        go.style.cssText = "flex:1;background:#0066cc;color:#fff;border:none;border-radius:9px;padding:11px;font-size:14px;font-weight:600;cursor:pointer;";
        var no = document.createElement("button");
        no.textContent = "Cancel";
        no.style.cssText = "flex:1;background:#5b6b78;color:#fff;border:none;border-radius:9px;padding:11px;font-size:14px;cursor:pointer;";
        row.appendChild(go); row.appendChild(no);
        card.appendChild(sel); card.appendChild(row);
        wrap.appendChild(card);
        document.body.appendChild(wrap);
        no.onclick = function () { wrap.remove(); };

        nativeFetch(API + "/users", { headers: { "Authorization": "Bearer " + token } })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            sel.innerHTML = "";
            (d.Users || []).filter(function (u) { return u.Username !== OWNER; }).forEach(function (u) {
              var o = document.createElement("option");
              o.value = u.Username;
              o.textContent = (((u.FirstName || "") + " " + (u.LastName || "")).trim() || u.Username)
                + (u.Status && u.Status !== "Active" ? " (" + u.Status + ")" : "");
              sel.appendChild(o);
            });
          }).catch(function () { sel.innerHTML = "<option>Couldn't load users</option>"; });

        go.onclick = function () {
          if (!sel.value) return;
          go.disabled = true; go.textContent = "Switching…";
          nativeFetch(API + "/auth/impersonate", {
            method: "POST",
            headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
            body: JSON.stringify({ username: sel.value })
          }).then(function (r) { return r.json(); }).then(function (d) {
            if (!d || !d.ok) { alert((d && d.error) || "Couldn't switch user."); go.disabled = false; go.textContent = "View as"; return; }
            // Stash the real session so the bottom bar can restore it.
            localStorage.setItem("mostlaneViewAsReal", JSON.stringify({
              token: token,
              user: localStorage.getItem("mostlaneUser") || OWNER,
              perms: localStorage.getItem("mostlanePermissions") || "{}",
              master: sessionStorage.getItem("mostlaneMasterLogin") || ""
            }));
            applySession(d);
            location.href = "/main.html";
          }).catch(function () { alert("Couldn't switch user."); go.disabled = false; go.textContent = "View as"; });
        };
      };

      // The return bar, shown on every page while a view-as session is active.
      var stash = null;
      try { stash = JSON.parse(localStorage.getItem("mostlaneViewAsReal") || "null"); } catch (e) {}
      if (stash && stash.token) {
        var addBar = function () {
          if (document.getElementById("mlVaBar")) return;
          var bar = document.createElement("div");
          bar.id = "mlVaBar";
          // NB no translateZ(0)/transform here: a transform on a position:fixed
          // element makes iOS Safari composite it in a layer that lags the scroll,
          // so the bar drifts up and sticks mid-page. Plain fixed pins correctly.
          bar.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:100001;background:#4a1d96;color:#fff;display:flex;align-items:center;gap:10px;padding:10px 14px;font:600 13px 'Segoe UI',system-ui,sans-serif;box-shadow:0 -2px 12px rgba(0,0,0,.3);";
          var who = sessionStorage.getItem("mostlaneUser") || localStorage.getItem("mostlaneUser") || "";
          var lbl = document.createElement("span");
          lbl.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
          lbl.innerHTML = "👁 Viewing as <b></b>";
          lbl.querySelector("b").textContent = who;
          var btn = document.createElement("button");
          btn.textContent = "Return to my account";
          btn.style.cssText = "background:#fff;color:#4a1d96;border:none;border-radius:999px;padding:8px 14px;font-weight:700;font-size:13px;cursor:pointer;flex:none;";
          btn.onclick = function () {
            var impTok = localStorage.getItem(TOKEN_KEY);
            try { nativeFetch(API + "/auth/logout", { method: "POST", headers: { "Authorization": "Bearer " + impTok } }); } catch (e) {}
            localStorage.setItem(TOKEN_KEY, stash.token);
            setBoth("mostlaneUser", stash.user || "");
            setBoth("mostlaneUsername", stash.user || "");
            setBoth("mostlanePermissions", stash.perms || "{}");
            setBoth("mostlaneLoggedIn", "true");
            if (stash.master) sessionStorage.setItem("mostlaneMasterLogin", stash.master);
            else sessionStorage.removeItem("mostlaneMasterLogin");
            localStorage.removeItem("mostlaneViewAsReal");
            location.href = "/main.html";
          };
          bar.appendChild(lbl); bar.appendChild(btn);
          document.body.appendChild(bar);
          // The field app (route/jobs/inbox/you) has its own fixed bottom tab bar
          // at bottom:0 — the purple bar would sit ON TOP and hide it. Lift the
          // tab bar to just above the purple bar so both stay usable while viewing.
          var barH = bar.offsetHeight || 52;
          var tb = document.querySelector(".tabbar");
          if (tb) {
            tb.style.bottom = barH + "px";
            document.body.style.paddingBottom = (barH + (tb.offsetHeight || 56)) + "px";
          } else {
            document.body.style.paddingBottom = barH + "px";
          }
        };
        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", addBar);
        else addBar();
      }
    } catch (e) { console.error("[view-as]", e); }
  })();

  // ── Desktop navigation sidebar (permission-aware) ──────────────────────────
  // Injected on every portal page; shown only on desktop (CSS ≥1000px). Mobile
  // keeps the existing tile menu + back buttons untouched. Story Mode users are
  // left in their guided flow (no sidebar).
  (function portalNav() {
    try {
      // Never paint the shell sidebar inside an embedded frame. Pages such as
      // po.html embed another same-origin portal page (e.g. po-office.html) in
      // an <iframe>; that page also loads portal-config.js, so without this
      // guard it renders a SECOND sidebar right beside the real one (the
      // "two sidebars side by side" seen after opening PO System). The parent
      // portal page already shows the sidebar — only the top document gets it.
      // (Cross-origin frames throw on window.top access → treat as embedded.)
      try { if (window.self !== window.top) return; } catch (e) { return; }

      var page = (location.pathname.split("/").pop() || "").toLowerCase();
      // Skip auth pages, the guided day, and the portal ROOT index (a redirect
      // shell) — but NOT sub-app index files like /hs-plan/index.html.
      var isRootIndex = (location.pathname === "/" || location.pathname === "/index.html");
      var SKIP = ["login.html", "onboard.html", "confirmation.html", "forgot-password.html",
        "reset-password.html", "change-password.html", "my-day.html", "hash.html"];
      if (isRootIndex || SKIP.indexOf(page) !== -1) return;
      var token = localStorage.getItem(TOKEN_KEY);
      if (!token) return;

      var perms = {};
      try { perms = JSON.parse(sessionStorage.getItem("mostlanePermissions") || localStorage.getItem("mostlanePermissions") || "{}"); } catch (e) {}
      if (yes(perms.StoryMode)) return;   // guided users keep the focused day

      // Restore collapsed state before paint to avoid a flash.
      try { if (localStorage.getItem("pnavCollapsed") === "1") document.documentElement.classList.add("pnav-collapsed"); } catch (e) {}

      function yes(v) { return String(v || "").toLowerCase() === "yes"; }
      function fetchAuthed(path) {
        return nativeFetch(API + path, { headers: { "Authorization": "Bearer " + token } }).then(function (r) { return r.json(); });
      }

      var ICONS = {
        home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>',
        jobs: '<rect x="3" y="7" width="18" height="13" rx="1.5"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
        sites: '<path d="M12 21s-7-5.6-7-11a7 7 0 0 1 14 0c0 5.4-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
        customers: '<path d="M3 21V8l9-5 9 5v13"/><path d="M9 21v-6h6v6"/>',
        sitelog: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4h6v3H9z"/><path d="M9 11h6M9 15h4"/>',
        assets: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>',
        projects: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
        po: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
        hs: '<path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/>',
        timesheet: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 3v3M16 3v3"/>',
        clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
        holiday: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="8" r="4"/><path d="M19 8v6M22 11h-6"/>',
        holidayAdmin: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 3v3M16 3v3"/><path d="M9 15l2 2 4-4"/>',
        weekly: '<path d="M3 21h18"/><rect x="5" y="11" width="3" height="7"/><rect x="11" y="6" width="3" height="12"/><rect x="17" y="14" width="3" height="4"/>',
        gauge: '<path d="M4 18a9 9 0 1 1 16 0"/><path d="M12 14l4-3"/>',
        labour: '<path d="M3 17l6-6 4 4 8-8"/><path d="M17 7h4v4"/>',
        vehicles: '<path d="M3 6h11v9H3z"/><path d="M14 9h4l3 3v3h-7z"/><circle cx="7" cy="18" r="1.6"/><circle cx="17" cy="18" r="1.6"/>',
        users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="8" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 4.1A4 4 0 0 1 16 12"/>',
        devices: '<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/>',
        forms: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
        compliance: '<path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/>',
        settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M6 6l2 2M16 16l2 2M6 18l2-2M16 8l2-2"/>',
        eye: '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>',
        paint: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
        help: '<circle cx="12" cy="12" r="9"/><path d="M9.3 9.2a2.7 2.7 0 1 1 3.6 2.6c-.8.3-.9 1-.9 1.6"/><path d="M12 17h.01"/>',
        chart: '<path d="M3 3v18h18"/><rect x="7" y="12" width="3" height="6"/><rect x="12" y="8" width="3" height="10"/><rect x="17" y="4" width="3" height="14"/>',
        user: '<circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-6 8-6s8 2 8 6"/>'
      };
      function svg(name) { return '<svg viewBox="0 0 24 24">' + (ICONS[name] || "") + "</svg>"; }

      // Single source of truth for the nav. perms:["__fullOnly"] => FullAccess only.
      var NAV = [
        { title: "Operations", items: [
          { label: "Home", href: "main.html", icon: "home", always: true, match: ["main.html", ""] },
          { label: "SLA / Jobs", href: "sla-main.html?reset=1", icon: "jobs", perms: ["SLA", "SLAAdmin"], match: ["sla-menu.html", "sla-main.html", "job-view.html", "sla-settings.html", "sla-scheduler.html", "engineer-jobs.html", "add-job.html"] },
          { label: "Sites", href: "sites.html", icon: "sites", perms: ["Sites", "AddSite"] },
          { label: "Customers", href: "customers.html", icon: "customers", perms: ["Sites", "AddSite"] },
          { label: "SiteLog", href: "sitelog.html", icon: "sitelog", perms: ["SiteLog"] },
          { label: "Plant & Equipment", href: "my-assets.html", icon: "assets", perms: ["Assets"], match: ["my-assets.html", "asset-menu.html", "assets-admin.html", "shared-assets.html"] },
          { label: "Projects", href: "projects-live.html", icon: "projects", perms: ["Projects", "ProjectsAdmin"], match: ["projects-live.html", "project-new.html", "project-hub.html", "projects.html", "projects-admin.html"] },
          { label: "PO System", href: "po.html", icon: "po", perms: ["PurchaseOrders"], match: ["po.html"] },
          { label: "H&S Plans", launch: "hs", icon: "hs", perms: ["HSPlan"] }
        ]},
        { title: "Time & HR", items: [
          { label: "Timesheet", href: "office-timesheet.html", icon: "timesheet", perms: ["__fullOnly"], match: ["office-timesheet.html"] },
          { label: "My Timesheet", href: "engineer-timesheet.html", icon: "timesheet", perms: ["EngTimesheet"], match: ["engineer-timesheet.html"] },
          { label: "Engineer Timesheets", href: "timesheets-admin.html", icon: "timesheet", perms: ["TimesheetAdmin"], match: ["timesheets-admin.html"] },
          { label: "My Hours", href: "office-my-hours.html", icon: "clock", perms: ["OfficeClock", "OfficeTimesheet"] },
          { label: "Holiday", href: "holiday.html", icon: "holiday", perms: ["Holiday"] },
          { label: "Holiday Admin", href: "holiday-admin.html", icon: "holidayAdmin", perms: ["HolidayAdmin"], match: ["holiday-admin.html", "holiday-config.html"] },
          { label: "Weekly Summary", href: "weekly.html", icon: "weekly", perms: ["Weekly"] },
          { label: "Hours Dashboard", href: "hours-dashboard-simple-v2.html", icon: "gauge", perms: ["HoursDashboard"] },
          // Labour Planning unlinked on request (legacy, unused) — page file kept.
          { label: "Vehicles", href: "vehicles.html", icon: "vehicles", perms: ["Vehicles"], match: ["vehicles.html", "fleet-report.html", "van-checks.html", "van-timesheet.html"] },
          { label: "CCTV Wall", href: "cctv.html", icon: "eye", perms: ["__fullOnly"], match: ["cctv.html"] }
          // Yard Gate removed from the desktop sidebar — desktop uses the
          // top status banner (gateBanner above); mobile keeps the menu tile.
        ]},
        { title: "Admin", items: [
          { label: "Users", href: "users-admin.html", icon: "users", perms: ["Users", "DeviceAdmin"], hrefBy: [["Users", "users-admin.html"], ["DeviceAdmin", "device-admin.html"]], match: ["users-admin.html", "device-admin.html"] },
          { label: "Stats", href: "stats.html", icon: "chart", perms: ["__fullOnly"] },
          { label: "Health", href: "health.html", icon: "chart", perms: ["__fullOnly"] },
          { label: "Notification Centre", href: "notification-centre.html", icon: "forms", perms: ["__fullOnly"] },
          { label: "Forms", href: "forms.html", icon: "forms", perms: ["Forms"] },
          { label: "Compliance", href: "compliance.html", icon: "compliance", perms: ["Compliance"] },
          { label: "Chapplins", href: "chapplins.html", icon: "compliance", perms: ["Compliance", "SLAAdmin"], match: ["chapplins.html", "chapplins-compliance.html"] },
          { label: "EICR Check", href: "eicr-check.html", icon: "compliance", perms: ["Compliance"], match: ["eicr-check.html"] },
          { label: "Programmes", href: "programmes.html", icon: "chart", perms: ["Programmes"], match: ["programmes.html", "programme-edit.html"] },
          { label: "Settings", href: "settings.html", icon: "settings", perms: ["__fullOnly"] },
          { label: "My Documents", href: "my-documents.html", icon: "forms", always: true, match: ["my-documents.html"] },
          { label: "Settings", href: "personalise.html", icon: "paint", always: true, match: ["personalise.html", "theme.html"] },
          { label: "Help & guides", href: "help.html", icon: "help", always: true },
          { label: "View as user…", launch: "viewas", icon: "eye", ownerOnly: true }
        ]}
      ];

      // Shared Full-access menu curation: an admin can hide irrelevant tiles for
      // everyone with Full access. The list is cached in localStorage (instant,
      // flicker-free) and refreshed from /menu-config on load.
      function mlMenuHidden() {
        try { var v = JSON.parse(localStorage.getItem("mlMenuHidden") || "[]"); return Array.isArray(v) ? v : []; } catch (e) { return []; }
      }
      function refreshMenuConfig() {
        fetchAuthed("/menu-config").then(function (d) {
          if (!d || !d.ok || !Array.isArray(d.hidden)) return;
          var prev = localStorage.getItem("mlMenuHidden") || "[]";
          var next = JSON.stringify(d.hidden);
          try { localStorage.setItem("mlMenuHidden", next); } catch (e) {}
          if (next !== prev) rebuild();
        }).catch(function () {});
      }

      function allowed(item) {
        if (item.ownerOnly) {
          var uu = sessionStorage.getItem("mostlaneUser") || localStorage.getItem("mostlaneUser") || "";
          return uu === "Jamie Line" && !localStorage.getItem("mostlaneViewAsReal");
        }
        if (item.always) return true;
        if (yes(perms.FullAccess)) {
          // Hide pages the admin has switched off for Full access.
          var hid = mlMenuHidden();
          if (item.href && hid.indexOf(item.href) !== -1) return false;
          if (item.launch && hid.indexOf(item.launch) !== -1) return false;   // e.g. H&S ("hs")
          return true;
        }
        if (!item.perms || !item.perms.length) return true;
        for (var i = 0; i < item.perms.length; i++) if (yes(perms[item.perms[i]])) return true;
        return false;
      }
      // Merged items point at the page THIS user can open (first perm they hold
      // wins), so a child-only permission still lands somewhere valid.
      function resolveHref(item) {
        if (item.hrefBy) {
          for (var i = 0; i < item.hrefBy.length; i++) {
            if (yes(perms.FullAccess) || yes(perms[item.hrefBy[i][0]])) return item.hrefBy[i][1];
          }
        }
        return item.href;
      }
      function isActive(item) {
        if ((item.href || "").toLowerCase() === page) return true;
        return !!(item.match && item.match.indexOf(page) !== -1);
      }
      function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

      function navInner() {
        var out = '<div class="pn-grp"><a class="pn-item pn-search" href="#" title="Quick search (Ctrl+K)">'
          + '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>'
          + '<span class="pn-label">Search <span class="pn-kbd">Ctrl K</span></span></a></div>';
        NAV.forEach(function (grp) {
          var items = grp.items.filter(allowed);
          if (!items.length) return;
          out += '<div class="pn-grp"><h4>' + esc(grp.title) + "</h4>";
          items.forEach(function (it) {
            // Root-absolute hrefs: the sidebar also renders inside sub-app
            // folders (e.g. /hs-plan/), where a relative "main.html" would
            // resolve to /hs-plan/main.html and 404.
            var attrs = it.launch ? 'href="#" data-launch="' + it.launch + '"' : 'href="/' + esc(resolveHref(it)) + '"';
            out += '<a class="pn-item' + (isActive(it) ? " active" : "") + '" ' + attrs + ' title="' + esc(it.label) + '">'
              + svg(it.icon) + '<span class="pn-label">' + esc(it.label) + "</span></a>";
          });
          out += "</div>";
        });
        return out;
      }

      function whoName() {
        var fn = perms.FirstName, ln = perms.LastName;
        if (fn || ln) return ((fn || "") + " " + (ln || "")).trim();
        var u = sessionStorage.getItem("mostlaneUser") || localStorage.getItem("mostlaneUser") || "";
        return u.replace(/[._]/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
      }
      function initials(name) {
        var p = name.trim().split(/\s+/);
        return ((p[0] ? p[0][0] : "") + (p[1] ? p[1][0] : "")).toUpperCase() || "?";
      }

      var built = false;
      function build() {
        if (built) { rebuild(); return; }
        built = true;
        var name = whoName();
        var el = document.createElement("aside");
        el.id = "pnav";
        el.innerHTML =
          '<div class="pn-brand"><div class="pn-logobox">'
          + '<img class="full" src="/mostlane-logo.jpg" alt="Mostlane">'
          + '<img class="mark" src="/icons/icon-512.png" alt="Mostlane"></div>'
          + ((yes(perms.YardGate) || yes(perms.FullAccess)) ? '<a class="pn-gate" id="pnGate" href="yard-gate.html" title="Yard gate" style="display:none"><span class="pn-gate-dot"></span><span class="pn-gate-lbl pn-label">Yard Gate</span></a>' : '')
          + '</div>'
          + '<nav class="pn-nav" id="pnavNav">' + navInner() + "</nav>"
          + '<div class="pn-foot"><div class="pn-av">' + esc(initials(name)) + "</div>"
          + '<div class="pn-who"><b>' + esc(name) + "</b><span>" + (yes(perms.FullAccess) ? "Full access" : "Team member") + "</span></div>"
          + '<button class="pn-logout" id="pnavLogout" title="Log out"><svg viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/></svg></button></div>'
          + '<button class="pn-collapse" id="pnavCollapse"><svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg><span class="pn-label">Minimise</span></button>';
        document.body.appendChild(el);
        document.body.classList.add("pnav-on");

        el.addEventListener("click", function (e) {
          var launch = e.target.closest ? e.target.closest("[data-launch]") : null;
          if (launch) { e.preventDefault(); doLaunch(launch.getAttribute("data-launch")); }
          var srch = e.target.closest ? e.target.closest(".pn-search") : null;
          if (srch) { e.preventDefault(); openPalette(); }
        });
        document.getElementById("pnavLogout").addEventListener("click", function () {
          localStorage.removeItem("mostlaneToken"); localStorage.removeItem("mostlaneViewAsReal"); sessionStorage.clear(); location.href = "/login.html";
        });
        document.getElementById("pnavCollapse").addEventListener("click", function () {
          var c = document.documentElement.classList.toggle("pnav-collapsed");
          try { localStorage.setItem("pnavCollapsed", c ? "1" : "0"); } catch (e) {}
        });
        try { initOfficeClock(); } catch (e) {}
        try { if (yes(perms.FullAccess)) refreshMenuConfig(); } catch (e) {}
        try { initPalette(); } catch (e) {}
        try { initGateLight(); } catch (e) {}
      }

      // Yard-gate traffic light under the sidebar logo: green=closed, red=open.
      function initGateLight() {
        var el = document.getElementById("pnGate"); if (!el) return;
        var API = window.MOSTLANE_API || "";
        function refresh() {
          if (document.hidden) return;
          nativeFetch(API + "/tuya/gate/state", { headers: { "Authorization": "Bearer " + (localStorage.getItem("mostlaneToken") || "") } })
            .then(function (r) { return r.json(); }).then(function (j) {
              if (!j || !j.ok || !j.configured) { el.style.display = "none"; return; }
              el.style.display = "";
              var open = !!j.open;
              el.className = "pn-gate " + (open ? "open" : "closed");
              var lbl = el.querySelector(".pn-gate-lbl"); if (lbl) lbl.textContent = open ? "Yard Gate Open" : "Yard Gate Closed";
              el.title = "Yard gate: " + (open ? "OPEN" : "Closed") + " — open controls";
            }).catch(function () {});
        }
        refresh(); setInterval(refresh, 60000);
        document.addEventListener("visibilitychange", function () { if (!document.hidden) refresh(); });
      }

      // ── Command palette (Ctrl+K / Cmd+K, desktop) ──────────────────────────
      // Type to jump anywhere: portal pages (permission-filtered, same list as
      // the sidebar), live site search (→ site folder) and vehicles (→ the
      // van's deep-dive). Arrow keys + Enter, Esc closes.
      var openPalette = function () {};
      function initPalette() {
        if (window.__mlPalette) return;
        window.__mlPalette = true;
        var st = document.createElement("style");
        st.textContent =
          ".pn-kbd{margin-left:auto;font:600 10px/1 'Segoe UI',system-ui;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.25);border-radius:5px;padding:2px 6px;color:#cbd9ec;}" +
          "#mlPalOv{position:fixed;inset:0;z-index:2147481000;background:rgba(10,20,40,.45);backdrop-filter:blur(2px);display:none;align-items:flex-start;justify-content:center;padding:12vh 16px 16px;}" +
          "#mlPalOv.on{display:flex;}" +
          "#mlPal{background:#fff;border-radius:16px;width:100%;max-width:560px;box-shadow:0 24px 70px rgba(0,0,0,.4);overflow:hidden;font-family:'Segoe UI',system-ui,sans-serif;}" +
          "#mlPal input{width:100%;border:none;outline:none;padding:16px 18px;font:600 16px 'Segoe UI',system-ui;color:#16202e;border-bottom:1px solid #e2e8f0;box-sizing:border-box;}" +
          "#mlPalList{max-height:46vh;overflow:auto;padding:6px;}" +
          ".mlp-it{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;cursor:pointer;font-size:14px;color:#16202e;}" +
          ".mlp-it .em{width:22px;text-align:center;flex:none;}" +
          ".mlp-it .hint{margin-left:auto;color:#94a3b8;font-size:11.5px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;flex:none;}" +
          ".mlp-it.sel{background:#eef4fc;}" +
          ".mlp-none{padding:18px;text-align:center;color:#94a3b8;font-size:13.5px;}";
        document.head.appendChild(st);
        var ov = document.createElement("div");
        ov.id = "mlPalOv";
        ov.innerHTML = '<div id="mlPal"><input id="mlPalIn" placeholder="Jump to a page, site or vehicle…" autocomplete="off"><div id="mlPalList"></div></div>';
        document.body.appendChild(ov);
        var input = ov.querySelector("#mlPalIn"), listEl = ov.querySelector("#mlPalList");
        var API = window.MOSTLANE_API, token = function () { return localStorage.getItem("mostlaneToken"); };
        var GRP_EMOJI = { }; // page rows use a generic emoji; data rows get their own
        var vehicles = null, siteHits = [], siteTimer = null, results = [], sel = 0, curQ = "";

        function pageItems() {
          var out = [];
          NAV.forEach(function (grp) {
            grp.items.filter(allowed).forEach(function (it) {
              out.push({ em: "📄", label: it.label, hint: grp.title, href: it.launch ? null : "/" + resolveHref(it), launch: it.launch || null });
            });
          });
          return out;
        }
        function loadVehicles() {
          if (vehicles !== null) return;
          vehicles = [];
          if (!(yes(perms.FullAccess) || yes(perms.Vehicles))) return;
          fetch(API + "/fleet/vehicles", { headers: { Authorization: "Bearer " + token() } })
            .then(function (r) { return r.json(); })
            .then(function (d) {
              vehicles = ((d && d.vehicles) || []).map(function (v) {
                return { em: "🚐", label: v.reg + (v.driver ? " — " + v.driver : ""), hint: "Vehicle", href: "/vehicles.html?veh=" + encodeURIComponent(v.reg) };
              });
              render(curQ);
            }).catch(function () {});
        }
        function searchSites(q) {
          clearTimeout(siteTimer);
          if (q.length < 2) { siteHits = []; return; }
          siteTimer = setTimeout(function () {
            fetch(API + "/ts/sites?q=" + encodeURIComponent(q), { headers: { Authorization: "Bearer " + token() } })
              .then(function (r) { return r.json(); })
              .then(function (d) {
                siteHits = ((d && d.sites) || []).filter(function (s) { return s.code; }).slice(0, 6).map(function (s) {
                  return { em: "📍", label: s.name + (s.postcode ? " · " + s.postcode : ""), hint: "Site folder", href: "/site-folder.html?site=" + encodeURIComponent(s.code) };
                });
                render(curQ);
              }).catch(function () {});
          }, 220);
        }
        function render(q) {
          curQ = q;
          var ql = q.toLowerCase().trim();
          var pages = pageItems().filter(function (it) { return !ql || it.label.toLowerCase().indexOf(ql) !== -1 || it.hint.toLowerCase().indexOf(ql) !== -1; });
          var vs = (vehicles || []).filter(function (v) { return ql && v.label.toLowerCase().indexOf(ql) !== -1; });
          results = pages.slice(0, ql ? 8 : 14).concat(vs.slice(0, 5)).concat(ql ? siteHits : []);
          sel = 0;
          if (!results.length) { listEl.innerHTML = '<div class="mlp-none">Nothing matches — try a page name, site or reg.</div>'; return; }
          listEl.innerHTML = results.map(function (it, i) {
            return '<div class="mlp-it' + (i === sel ? " sel" : "") + '" data-i="' + i + '"><span class="em">' + it.em + "</span><span>" + esc(it.label) + '</span><span class="hint">' + esc(it.hint) + "</span></div>";
          }).join("");
        }
        function go(it) {
          if (!it) return;
          close();
          if (it.launch) doLaunch(it.launch);
          else if (it.href) location.href = it.href;
        }
        function openPal() { ov.classList.add("on"); input.value = ""; siteHits = []; loadVehicles(); render(""); setTimeout(function () { input.focus(); }, 30); }
        function close() { ov.classList.remove("on"); }
        openPalette = openPal;
        input.addEventListener("input", function () { searchSites(input.value); render(input.value); });
        input.addEventListener("keydown", function (e) {
          if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(results.length - 1, sel + 1); }
          else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(0, sel - 1); }
          else if (e.key === "Enter") { e.preventDefault(); go(results[sel]); return; }
          else return;
          var kids = listEl.querySelectorAll(".mlp-it");
          for (var i = 0; i < kids.length; i++) kids[i].classList.toggle("sel", i === sel);
          if (kids[sel]) kids[sel].scrollIntoView({ block: "nearest" });
        });
        listEl.addEventListener("click", function (e) {
          var row = e.target.closest ? e.target.closest(".mlp-it") : null;
          if (row) go(results[+row.getAttribute("data-i")]);
        });
        ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
        document.addEventListener("keydown", function (e) {
          if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === "k") { e.preventDefault(); ov.classList.contains("on") ? close() : openPal(); }
          else if (e.key === "Escape" && ov.classList.contains("on")) { e.preventDefault(); close(); }
        });
      }

      function rebuild() {
        var nav = document.getElementById("pnavNav");
        if (nav) nav.innerHTML = navInner();
        var whoB = document.querySelector("#pnav .pn-who b");
        var whoS = document.querySelector("#pnav .pn-who span");
        var av = document.querySelector("#pnav .pn-av");
        var name = whoName();
        if (whoB) whoB.textContent = name;
        if (whoS) whoS.textContent = yes(perms.FullAccess) ? "Full access" : "Team member";
        if (av) av.textContent = initials(name);
        applyBadges();
      }

      // ── Office clock (desktop office machines) ─────────────────────────────
      // Start-of-day gate: office-clock users must start their timer before
      // using the portal (blocking centre-screen modal). While running, a
      // flashing green light sits at the top of the sidebar; clicking it opens
      // the modal to stop (two taps — an "are you sure"). Eligibility (office-
      // flagged device + OfficeClock permission) is decided by /office/config.
      function initOfficeClock() {
        if (window.__ocInit) return;
        if (!window.matchMedia || !window.matchMedia("(min-width:1000px)").matches) return;
        var token = localStorage.getItem("mostlaneToken"); if (!token) return;
        window.__ocInit = true;
        var API = window.MOSTLANE_API;
        var deviceId = localStorage.getItem("deviceID") || sessionStorage.getItem("deviceID") || "";
        function af(path, init) { init = init || {}; init.headers = Object.assign({ "Authorization": "Bearer " + token }, init.headers || {}); if (init.body) init.headers["Content-Type"] = "application/json"; return fetch(API + path, init); }
        function pad(n) { return String(n).padStart(2, "0"); }
        function hms(s) { s = Math.max(0, Math.floor(s)); return pad(Math.floor(s / 3600)) + ":" + pad(Math.floor(s % 3600 / 60)) + ":" + pad(s % 60); }
        function hm(s) { s = Math.max(0, Math.floor(s)); var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? h + "h " + m + "m" : m + "m"; }
        injectClockStyles();

        var state = null, tick = null, confirmT = null, mode = null;
        function stopTick() { if (tick) { clearInterval(tick); tick = null; } }
        function runSecs() { if (!state || !state.open) return 0; return (state.todayClosedSeconds || 0) + (Date.now() - Date.parse(state.open.clockIn)) / 1000; }

        function ensurePill() {
          var nav = document.getElementById("pnav"); if (!nav) return null;
          var p = document.getElementById("ocPill");
          if (!p) {
            p = document.createElement("button"); p.id = "ocPill"; p.type = "button";
            p.addEventListener("click", function () { if (state && state.open) openModal("stop"); else doStart(); });
            var brand = nav.querySelector(".pn-brand");
            if (brand && brand.nextSibling) nav.insertBefore(p, brand.nextSibling); else nav.insertBefore(p, nav.firstChild);
          }
          return p;
        }
        function renderPill() {
          var p = ensurePill(); if (!p) return;
          stopTick();
          if (state && state.open) {
            p.className = "oc-pill running";
            p.innerHTML = '<span class="oc-led"></span><span class="oc-txt">On the clock<br><b id="ocPillTime">' + hms(runSecs()) + '</b></span>';
            tick = setInterval(function () {
              var t = document.getElementById("ocPillTime"); if (t) t.textContent = hms(runSecs());
              var mt = document.getElementById("ocModalTime"); if (mt) mt.textContent = hms(runSecs());
            }, 1000);
          } else {
            p.className = "oc-pill idle";
            p.innerHTML = '<span class="oc-led"></span><span class="oc-txt">Start timer</span>';
          }
        }
        function removeUI() { var p = document.getElementById("ocPill"); if (p) p.remove(); closeModal(); stopTick(); }

        function closeModal() { var o = document.getElementById("ocModal"); if (o) o.remove(); mode = null; if (confirmT) { clearTimeout(confirmT); confirmT = null; } }
        function niceDay(d) { try { return new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }); } catch (e) { return d; } }
        function openModal(m) {
          // Already showing this modal? Don't re-render (a periodic refresh
          // would wipe what the user is typing into the finish-time box).
          if (mode === m && document.getElementById("ocModal")) return;
          mode = m;
          var o = document.getElementById("ocModal");
          if (!o) { o = document.createElement("div"); o.id = "ocModal"; document.body.appendChild(o); }
          // "start" and "stopped" BLOCK the whole portal; "stop" (viewing a
          // running timer) can be dismissed to keep working.
          var blocking = (m !== "stop");
          o.className = blocking ? "oc-overlay blocking" : "oc-overlay";
          if (m === "confirm") {
            var pa = (state && state.pendingAutoStop) || {};
            o.innerHTML = '<div class="oc-card"><div class="oc-big">🕘</div><h2>You didn\'t clock out</h2>'
              + '<p>On <b>' + niceDay(pa.date) + '</b> your timer was still running, so it was automatically stopped at <b>' + (pa.stoppedAtHM || "19:00") + '</b>.</p>'
              + '<p>What time did you actually finish that day?</p>'
              + '<input type="time" id="ocFinishTime" value="16:30" style="font-size:22px;padding:8px 12px;border:1px solid #ccd5dd;border-radius:10px;text-align:center;margin-bottom:14px;">'
              + '<button class="oc-cta" id="ocConfirmBtn">✔ Confirm finish time</button>'
              + '<p class="oc-note" style="color:#8a94a3;font-size:12px;margin:10px 0 0;">This goes onto the office timesheet against that day.</p></div>';
          } else if (m === "start") {
            o.innerHTML = '<div class="oc-card"><div class="oc-big">🕒</div><h2>Start your day</h2>'
              + '<p>Please start your timer to begin — you need to do this before using the portal.</p>'
              + '<button class="oc-cta" id="ocStartBtn">▶ Start timer</button></div>';
          } else if (m === "stopped") {
            var banked = state ? (state.todayClosedSeconds || 0) : 0;
            o.innerHTML = '<div class="oc-card"><div class="oc-big">✅</div><h2>Timer stopped</h2>'
              + '<div class="oc-modal-time">' + hm(banked) + '</div>'
              + '<p>logged today. Start again if you\'re back on, or log out if you\'re done.</p>'
              + '<button class="oc-cta" id="ocStartBtn">▶ Start again</button>'
              + '<button class="oc-close" id="ocLogoutBtn">Log out</button></div>';
          } else {
            o.innerHTML = '<div class="oc-card"><div class="oc-big">🟢</div><h2>On the clock</h2>'
              + '<div class="oc-modal-time" id="ocModalTime">' + hms(runSecs()) + '</div>'
              + '<p>Your timer is running. Keep working, or stop it when you\'re done.</p>'
              + '<button class="oc-stop" id="ocStopBtn">■ Stop the timer</button>'
              + '<button class="oc-close" id="ocCloseBtn">Keep working</button></div>';
          }
          if (!blocking) o.addEventListener("click", function (e) { if (e.target === o) closeModal(); });
          var sb = document.getElementById("ocStartBtn"); if (sb) sb.onclick = doStart;
          var cb = document.getElementById("ocCloseBtn"); if (cb) cb.onclick = closeModal;
          var lb = document.getElementById("ocLogoutBtn"); if (lb) lb.onclick = function () { localStorage.removeItem("mostlaneToken"); localStorage.removeItem("mostlaneViewAsReal"); sessionStorage.clear(); location.href = "/login.html"; };
          var stopB = document.getElementById("ocStopBtn"); if (stopB) stopB.onclick = onStopClick;
          var kb = document.getElementById("ocConfirmBtn"); if (kb) kb.onclick = doConfirmFinish;
        }
        function doConfirmFinish() {
          var pa = (state && state.pendingAutoStop) || {};
          var inp = document.getElementById("ocFinishTime");
          var hm = inp ? inp.value : "";
          if (!/^\d{2}:\d{2}$/.test(hm)) { alert("Pick the time you finished."); return; }
          var b = document.getElementById("ocConfirmBtn"); if (b) b.disabled = true;
          af("/office/confirm-finish", { method: "POST", body: JSON.stringify({ id: pa.id, time: hm }) })
            .then(function (r) { return r.json(); })
            .then(function (r) {
              if (!r || !r.ok) { alert((r && r.error) || "Couldn't save that time."); if (b) b.disabled = false; return; }
              closeModal(); refresh();   // next pending day, or the start gate
            })
            .catch(function () { alert("Network error — couldn't save that time."); if (b) b.disabled = false; });
        }
        // Two taps to stop — the second confirms (guards against accidental stops).
        function onStopClick() {
          var b = document.getElementById("ocStopBtn"); if (!b) return;
          if (b.getAttribute("data-confirm") === "1") { doStop(); return; }
          b.setAttribute("data-confirm", "1"); b.textContent = "⚠ Tap again to confirm stop"; b.className = "oc-stop confirm";
          confirmT = setTimeout(function () { if (b) { b.setAttribute("data-confirm", ""); b.textContent = "■ Stop the timer"; b.className = "oc-stop"; } }, 4000);
        }

        function doStart() {
          var b = document.getElementById("ocStartBtn"); if (b) b.disabled = true;
          af("/office/clock-in", { method: "POST", body: JSON.stringify({ deviceId: deviceId }) })
            .then(function (r) { return r.json(); })
            .then(function (r) { if (!r || !r.ok) { alert((r && r.error) || "Couldn't start the timer."); if (b) b.disabled = false; return; } closeModal(); refresh(); })
            .catch(function () { alert("Network error — couldn't start the timer."); if (b) b.disabled = false; });
        }
        function doStop() {
          var b = document.getElementById("ocStopBtn"); if (b) b.disabled = true;
          af("/office/clock-out", { method: "POST", body: JSON.stringify({ deviceId: deviceId }) })
            .then(function (r) { return r.json(); })
            .then(function (r) { if (!r || !r.ok) { alert((r && r.error) || "Couldn't stop the timer."); if (b) b.disabled = false; return; } mode = "stopped"; refresh(); })
            .catch(function () { alert("Network error — couldn't stop the timer."); if (b) b.disabled = false; });
        }

        function refresh() {
          af("/office/config?device=" + encodeURIComponent(deviceId))
            .then(function (r) { return r.json(); })
            .then(function (c) {
              state = c;
              if (!state || !state.ok || !state.enabled) { removeUI(); return; }
              renderPill();
              // Priority: an unconfirmed 19:00 auto-stop must be answered
              // first; then the gate blocks until the timer is running.
              if (state.pendingAutoStop) { openModal("confirm"); return; }
              if (mode === "confirm") closeModal();
              if (state.open) { if (mode === "start" || mode === "stopped") closeModal(); }
              else openModal(mode === "stopped" ? "stopped" : "start");
            })
            .catch(function () {});
        }
        refresh();
        // The clock appearing "first thing" is driven by the return-to-computer
        // triggers below (focus / tab-visible / bfcache restore) — they fire the
        // instant a user comes back to a tab left open overnight, so the start
        // gate (or a 19:00 auto-stop to confirm) pops immediately. The interval
        // is only a slow background fallback, so 60s keeps traffic light without
        // affecting that first-thing behaviour.
        setInterval(refresh, 60000);
        window.addEventListener("focus", refresh);
        window.addEventListener("pageshow", refresh);
        document.addEventListener("visibilitychange", function () { if (!document.hidden) refresh(); });
      }
      function injectClockStyles() {
        if (document.getElementById("oc-style")) return;
        var s = document.createElement("style"); s.id = "oc-style";
        s.textContent =
          "#ocPill{ display:flex; align-items:center; gap:9px; width:calc(100% - 20px); margin:8px 10px 2px; padding:9px 11px; border:none; border-radius:11px; cursor:pointer; font:600 13px 'Segoe UI',system-ui,sans-serif; color:#fff; text-align:left; }"
          + "#ocPill .oc-led{ width:12px; height:12px; border-radius:50%; flex:none; }"
          + "#ocPill .oc-txt{ line-height:1.15; } #ocPill .oc-txt b{ font-size:14px; font-variant-numeric:tabular-nums; }"
          + "#ocPill.running{ background:rgba(20,140,60,.30); box-shadow:0 0 0 1px rgba(60,220,120,.55) inset; }"
          + "#ocPill.running .oc-led{ background:#38e07b; animation:ocflash 1s ease-in-out infinite; }"
          + "#ocPill.idle{ background:rgba(255,255,255,.12); } #ocPill.idle .oc-led{ background:#c9d2dc; }"
          + "@keyframes ocflash{ 0%,100%{ opacity:1; box-shadow:0 0 10px 2px #38e07b; } 50%{ opacity:.3; box-shadow:0 0 2px 0 #38e07b; } }"
          + "html.pnav-collapsed #ocPill{ justify-content:center; } html.pnav-collapsed #ocPill .oc-txt{ display:none; }"
          + ".oc-overlay{ position:fixed; inset:0; z-index:99000; display:flex; align-items:center; justify-content:center; background:rgba(8,18,34,.55); font-family:'Segoe UI',system-ui,-apple-system,sans-serif; }"
          + ".oc-overlay .oc-cta + .oc-close{ margin-top:8px; display:inline-block; }"
          + ".oc-overlay .oc-card{ background:#fff; color:#16202e; width:min(420px,92vw); border-radius:18px; padding:26px 24px; text-align:center; box-shadow:0 20px 60px rgba(0,0,0,.35); }"
          + ".oc-overlay .oc-big{ font-size:40px; } .oc-overlay h2{ margin:6px 0 6px; color:#003366; font-size:22px; } .oc-overlay p{ color:#5b6b7b; font-size:14px; margin:0 0 16px; }"
          + ".oc-modal-time{ font-size:34px; font-weight:800; color:#0a7d33; font-variant-numeric:tabular-nums; margin:4px 0 10px; }"
          + ".oc-cta{ background:#0a7d33; color:#fff; border:none; border-radius:12px; padding:14px 22px; font-size:17px; font-weight:700; cursor:pointer; width:100%; }"
          + ".oc-stop{ background:#b00020; color:#fff; border:none; border-radius:12px; padding:13px 20px; font-size:16px; font-weight:700; cursor:pointer; width:100%; margin-bottom:8px; }"
          + ".oc-stop.confirm{ background:#7a0016; animation:ocflash2 .7s infinite; }"
          + "@keyframes ocflash2{ 50%{ opacity:.55; } }"
          + ".oc-close{ background:none; border:none; color:#5b6b7b; font-size:14px; cursor:pointer; text-decoration:underline; }";
        document.head.appendChild(s);
      }

      // ── Red badges on sidebar items ─────────────────────────────────────
      //   Plant & Equipment — pending transfers addressed to me
      //   Holiday           — decisions on MY requests I haven't seen yet
      //   Holiday Admin     — requests waiting for approval (admins only)
      var badgeCounts = {};   // nav href -> count
      function applyBadges() {
        Object.keys(badgeCounts).forEach(function (href) {
          var item = document.querySelector('#pnav a.pn-item[href="/' + href + '"]');
          if (!item) return;
          var old = item.querySelector(".pn-badge");
          if (old) old.remove();
          var n = badgeCounts[href];
          if (n > 0) {
            var b = document.createElement("span");
            b.className = "pn-badge";
            b.textContent = n > 9 ? "9+" : n;
            item.appendChild(b);
          }
        });
      }
      function setNavBadge(href, n) { badgeCounts[href] = Number(n) || 0; applyBadges(); }
      // "Seen" markers live server-side per USER (/prefs) so an alert dealt
      // with on one device clears on all of them; localStorage is just a
      // mirror/fallback. The newer of the two timestamps wins.
      function mlLater(a, b) { return String(a || "") > String(b || "") ? (a || "") : (b || ""); }
      function mlPrefs() {
        return fetchAuthed("/prefs").then(function (d) {
          var p = (d && d.ok && d.prefs) || {};
          try {
            if (p.holSeen) localStorage.setItem("mostlaneHolSeen", mlLater(p.holSeen, localStorage.getItem("mostlaneHolSeen")));
            if (p.holAdminSeen) localStorage.setItem("mostlaneHolAdminSeen", mlLater(p.holAdminSeen, localStorage.getItem("mostlaneHolAdminSeen")));
          } catch (e) {}
          return p;
        }).catch(function () { return {}; });
      }
      function updateBadges() {
        Promise.all([
          fetchAuthed("/vancheck/attention"),
          fetchAuthed("/prefs").catch(function () { return {}; })
        ]).then(function (r) {
          var d = r[0]; if (!(d && d.ok)) return;
          var prefs = (r[1] && r[1].ok && r[1].prefs) || {};
          // Admin "missing" count clears once this week's van-check page is seen.
          var localSeen = localStorage.getItem("mostlaneVcSeen") || "";
          var seenWk = String(localSeen) > String(prefs.vcSeen || "") ? localSeen : (prefs.vcSeen || "");
          var missingN = (d.missing && d.overdue && seenWk !== d.week) ? d.missing.length : 0;
          setNavBadge("vehicles.html", (d.mineDue ? 1 : 0) + missingN);
        }).catch(function () {});
        Promise.all([
          fetchAuthed("/asset/transfers/pending-count").catch(function () { return null; }),
          fetchAuthed("/asset/requests/attention").catch(function () { return null; }),
          fetchAuthed("/asset/confirm/pending-count").catch(function () { return null; })
        ]).then(function (res) {
          var t = (res[0] && res[0].ok ? res[0].count : 0)
                + (res[1] && res[1].ok ? (res[1].toAction || 0) + (res[1].decided || 0) : 0)
                + (res[2] && res[2].ok ? res[2].count : 0);
          setNavBadge("my-assets.html", t);
        }).catch(function () {});
        var yr = new Date().getFullYear();
        var prefsP = mlPrefs();
        // Unseen decisions on my own requests (seen marker set when holiday.html opens).
        Promise.all([fetchAuthed("/holiday/my?year=" + yr), prefsP]).then(function (res) {
          var list = res[0], prefs = res[1];
          var seen = mlLater(localStorage.getItem("mostlaneHolSeen"), prefs.holSeen);
          var meL = (sessionStorage.getItem("mostlaneUser") || localStorage.getItem("mostlaneUser") || "").toLowerCase();
          var n = (Array.isArray(list) ? list : []).filter(function (h) {
            return h.start && h.decisionAt && (!seen || h.decisionAt > seen)
              && ["Approved", "Rejected", "Cancelled"].indexOf(h.status) !== -1
              && String(h.cancelledBy || "").toLowerCase() !== meL;   // not my own cancellation
          }).length;
          setNavBadge("holiday.html", n);
        }).catch(function () {});
        if (yes(perms.FullAccess) || yes(perms.HolidayAdmin)) {
          Promise.all([fetchAuthed("/holiday/all?year=" + yr), prefsP]).then(function (res) {
            var arr = Array.isArray(res[0]) ? res[0] : [];
            var pending = arr.filter(function (h) { return h.status === "Pending"; }).length;
            // Staff cancelling their own (incl. approved) leave — unseen by admin.
            var seenA = mlLater(localStorage.getItem("mostlaneHolAdminSeen"), res[1].holAdminSeen);
            var cancels = arr.filter(function (h) {
              return h.status === "Cancelled" && h.cancelledBy && h.cancelledBy === h.username
                && h.decisionAt && (!seenA || h.decisionAt > seenA);
            }).length;
            setNavBadge("holiday-admin.html", pending + cancels);
          }).catch(function () {});
        }
      }

      function doLaunch(kind) {
        if (kind === "po") {
          fetchAuthed("/po-config").then(function (c) {
            if (c && c.ok && c.url) location.href = c.url;
            else alert("No PO link is set on your account yet — ask the office to add your personal PO URL in Users admin.");
          }).catch(function () { alert("Couldn't open the PO system."); });
        } else if (kind === "hs") {
          // H&S now opens the documents hub (inductions, permits, RAMS,
          // incidents); the Construction Phase Plan app launches from a tile there.
          location.href = "/hs-docs.html";
        } else if (kind === "viewas") {
          if (window.mlViewAsPicker) window.mlViewAsPicker();
        }
      }

      injectStyles();
      function start() {
        build();
        updateBadges();
        // Refresh from the server so gating is correct even if the cached perms
        // are stale/incomplete (older logins) — then re-render.
        fetchAuthed("/auth/me").then(function (d) {
          if (d && d.ok && d.user) {
            perms = d.user;
            try {
              var slim = {}; ["FullAccess","Users","DeviceAdmin","CheckInOut","Vehicles","Holiday","HolidayAdmin","EngineersHoursMenu","HoursDashboard","PurchaseOrders","Sites","AddSite","Assets","AssetAdmin","MyDocuments","Weekly","Forms","Compliance","Projects","ProjectsAdmin","TimesheetAdmin","LabourPlanning","SLA","SLAAdmin","StoryMode","HSPlan","SiteLog","OfficeClock","OfficeTimesheet","ThemeColour","ThemeBackground","FirstName","LastName"].forEach(function (k) { slim[k] = d.user[k]; });
              sessionStorage.setItem("mostlanePermissions", JSON.stringify(slim));
              localStorage.setItem("mostlanePermissions", JSON.stringify(slim));
            } catch (e) {}
            if (yes(perms.StoryMode)) { var n = document.getElementById("pnav"); if (n) n.remove(); document.body.classList.remove("pnav-on"); return; }
            rebuild();
            updateBadges();   // re-run with fresh perms (admin-only badges)
          }
        }).catch(function () {});
      }
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
      else start();

      function injectStyles() {
        if (document.getElementById("pnav-style")) return;
        var css =
          "@media (min-width:1000px){ body.pnav-on{ padding-left:248px !important; } html.pnav-collapsed body.pnav-on{ padding-left:64px !important; } }"
          + "@media (max-width:999px){ #pnav{ display:none !important; } }"
          + "#pnav{ position:fixed; left:0; top:0; height:100vh; width:248px; z-index:1000; background:linear-gradient(185deg,#1A4F8F 0%,#003468 100%); color:#fff; display:flex; flex-direction:column; font-family:'Segoe UI',system-ui,-apple-system,sans-serif; transition:width .16s ease; text-align:left; }"
          + "html.pnav-collapsed #pnav{ width:64px; }"
          + "#pnav *{ box-sizing:border-box; }"
          + "#pnav .pn-brand{ padding:14px 14px 12px; }"
          + "#pnav .pn-logobox{ background:#fff; border-radius:11px; padding:10px 12px; display:flex; align-items:center; justify-content:center; box-shadow:0 2px 8px rgba(0,0,0,.18); }"
          + "#pnav .pn-logobox img.full{ width:100%; max-width:168px; height:auto; display:block; } #pnav .pn-logobox img.mark{ display:none; width:34px; height:34px; border-radius:7px; }"
          + "html.pnav-collapsed #pnav .pn-brand{ padding:12px 8px; } html.pnav-collapsed #pnav .pn-logobox{ padding:5px; } html.pnav-collapsed #pnav .pn-logobox img.full{ display:none; } html.pnav-collapsed #pnav .pn-logobox img.mark{ display:block; }"
          // Yard-gate traffic light under the logo (desktop sidebar).
          + "#pnav .pn-gate{ display:flex; align-items:center; gap:8px; margin:9px auto 0; padding:5px 11px; border-radius:999px; background:rgba(255,255,255,.13); color:#fff; text-decoration:none; font:600 12px/1 inherit; width:max-content; }"
          + "#pnav .pn-gate:hover{ background:rgba(255,255,255,.22); }"
          + "#pnav .pn-gate-dot{ width:11px; height:11px; border-radius:50%; background:#94a3b8; box-shadow:0 0 0 3px rgba(148,163,184,.28); flex:0 0 auto; }"
          + "#pnav .pn-gate.open .pn-gate-dot{ background:#ef4444; box-shadow:0 0 0 3px rgba(239,68,68,.32); }"
          + "#pnav .pn-gate.closed .pn-gate-dot{ background:#22c55e; box-shadow:0 0 0 3px rgba(34,197,94,.32); }"
          + "html.pnav-collapsed #pnav .pn-gate{ padding:6px; margin-top:8px; }"
          + "#pnav .pn-nav{ flex:1; overflow-y:auto; overflow-x:hidden; padding:4px 10px 10px; }"
          + "#pnav .pn-grp{ margin-top:14px; } #pnav .pn-grp h4{ font-size:10.5px; text-transform:uppercase; letter-spacing:.9px; color:#9fc0e8; opacity:.75; margin:0 10px 5px; font-weight:600; white-space:nowrap; }"
          + "html.pnav-collapsed #pnav .pn-grp h4{ opacity:0; height:7px; margin:0; overflow:hidden; }"
          + "#pnav a.pn-item{ display:flex; align-items:center; gap:12px; padding:9px 11px; border-radius:9px; color:#dbe7f6; text-decoration:none; font-size:14px; font-weight:500; position:relative; margin-bottom:1px; white-space:nowrap; }"
          + "#pnav a.pn-item svg{ width:19px; height:19px; flex:none; stroke:currentColor; stroke-width:1.9; fill:none; }"
          + "#pnav a.pn-item:hover{ background:rgba(255,255,255,.09); color:#fff; } #pnav a.pn-item.active{ background:rgba(255,255,255,.15); color:#fff; font-weight:600; }"
          + "#pnav .pn-badge{ margin-left:auto; background:#e11900; color:#fff; border-radius:999px; min-width:19px; height:19px; padding:0 5px; font:700 11px/19px system-ui,sans-serif; text-align:center; flex:none; }"
          + "html.pnav-collapsed #pnav .pn-badge{ position:absolute; top:3px; right:5px; margin:0; }"
          + "#pnav a.pn-item.active::before{ content:''; position:absolute; left:-10px; top:7px; bottom:7px; width:4px; border-radius:0 4px 4px 0; background:#5fa0ff; }"
          + "html.pnav-collapsed #pnav a.pn-item{ justify-content:center; padding:10px 0; } html.pnav-collapsed #pnav a.pn-item .pn-label{ display:none; } html.pnav-collapsed #pnav a.pn-item.active::before{ left:0; }"
          + "#pnav .pn-foot{ border-top:1px solid rgba(255,255,255,.12); padding:11px 12px; display:flex; align-items:center; gap:10px; }"
          + "#pnav .pn-av{ width:34px; height:34px; border-radius:50%; background:#5fa0ff; color:#00234d; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:13px; flex:none; }"
          + "#pnav .pn-who{ line-height:1.2; flex:1; min-width:0; overflow:hidden; } #pnav .pn-who b{ display:block; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; } #pnav .pn-who span{ font-size:11px; opacity:.6; }"
          + "#pnav .pn-logout{ background:none; border:none; color:#dbe7f6; cursor:pointer; display:flex; padding:6px; border-radius:8px; } #pnav .pn-logout:hover{ background:rgba(255,255,255,.1); color:#fff; } #pnav .pn-logout svg{ width:19px; height:19px; stroke:currentColor; stroke-width:1.9; fill:none; }"
          + "html.pnav-collapsed #pnav .pn-who, html.pnav-collapsed #pnav .pn-logout{ display:none; } html.pnav-collapsed #pnav .pn-foot{ justify-content:center; }"
          + "#pnav .pn-collapse{ display:flex; align-items:center; gap:10px; color:#9fc0e8; font-size:12px; padding:10px 18px; cursor:pointer; border:none; border-top:1px solid rgba(255,255,255,.08); background:none; width:100%; font-family:inherit; text-align:left; }"
          + "#pnav .pn-collapse svg{ width:16px; height:16px; stroke:currentColor; stroke-width:2; fill:none; flex:none; transition:transform .16s ease; } html.pnav-collapsed #pnav .pn-collapse svg{ transform:rotate(180deg); } html.pnav-collapsed #pnav .pn-collapse{ justify-content:center; padding:10px 0; } html.pnav-collapsed #pnav .pn-collapse .pn-label{ display:none; }"
          // Standard portal back button (data-role='home' returns to the menu and
          // is hidden on desktop where the sidebar replaces it; data-role='up' is
          // a sub-page back and always stays).
          // The pill's LOOK is forced (!important) so it is identical on every
          // page. Without it a dark-header page's own `header.page a{color:#fff}`
          // (specificity 0,1,2) beat this rule and painted white text on the white
          // pill — a blank, invisible button. `display` is deliberately NOT forced:
          // the field app hides .ml-back outright (engineer-jobs.html uses its own
          // .eng-back), and the desktop sidebar rule below still hides the home one.
          + ".ml-back{ display:inline-flex; align-items:center; gap:6px !important; text-decoration:none !important; font:600 14px/1 -apple-system,system-ui,'Segoe UI',sans-serif !important; padding:8px 13px !important; border-radius:999px !important; background:#fff !important; border:1px solid #d7dee6 !important; color:#003366 !important; box-shadow:0 1px 2px rgba(0,0,0,.06) !important; cursor:pointer; }"
          + ".ml-back:hover{ background:#f4f7fb !important; }"
          + "@media (min-width:1000px){ body.pnav-on .ml-back[data-role='home']{ display:none !important; } }"
          // ===== Portal shared theme (Batch 3) — one look across every page.
          // Injected after each page parses, so it wins at EQUAL specificity;
          // bespoke, more-specific page rules (e.g. a red delete button) still
          // survive. Only colour / type / surface are unified — never layout.
          + ":root{ --ml-navy:#003468; --ml-blue:#1a4f8f; --ml-ink:#16202e; --ml-blue-ink:#003366; --ml-accent:#5fa0ff; --ml-bg:#eef1f5; --ml-card:#ffffff; --ml-line:#e2e8f0; --ml-muted:#5a6b82; --ml-radius:14px; --ml-shadow:0 2px 10px rgba(6,24,54,.06); }"
          + "body{ background:#eef1f5; color:#16202e; font-family:'Segoe UI',system-ui,-apple-system,Roboto,Arial,sans-serif; }"
          // Only the heading FONT is unified — not colour: many pages put white
          // headings on dark header bands, and recolouring them broke contrast.
          + "h1,h2,h3{ font-family:'Segoe UI',system-ui,-apple-system,Roboto,Arial,sans-serif; }"
          + ".card{ background:#fff; border:1px solid #e2e8f0; border-radius:14px; box-shadow:0 2px 10px rgba(6,24,54,.06); }"
          + ".btn, .button{ font-family:inherit; border-radius:10px; cursor:pointer; }"
          + "input, select, textarea{ font-family:inherit; }";
        var st = document.createElement("style");
        st.id = "pnav-style";
        st.textContent = css;
        (document.head || document.documentElement).appendChild(st);
      }
    } catch (e) { console.error("[portal-nav]", e); }
  })();

  // ── Live-chat widget ───────────────────────────────────────────────────────
  // Inject the floating chat launcher on portal pages. Field engineers get it
  // too now (they reach chat via main.html + the bubble, no Inbox tab) — but the
  // field-app pages themselves are skipped so the bubble never covers the tabbar.
  (function chatWidget() {
    try {
      var page = (location.pathname.split("/").pop() || "").toLowerCase();
      // The chat bubble lives ONLY on the home page (same reason as the bell —
      // it floated over full-screen photo/doc close buttons on other pages).
      if (page !== "main.html") return;
      var token = localStorage.getItem(TOKEN_KEY);
      if (!token) return;
      var p = {};
      try { p = JSON.parse(sessionStorage.getItem("mostlanePermissions") || localStorage.getItem("mostlanePermissions") || "{}"); } catch (e) {}
      var yes = function (v) { return String(v || "").toLowerCase() === "yes"; };
      if (yes(p.StoryMode)) return;                         // guided My Day users stay out of the bubble
      if (document.querySelector('script[data-mlchat]') || document.getElementById("mlchat-launch")) return;
      var s = document.createElement("script");
      s.src = "/chat-widget.js?v=4";
      s.async = true; s.setAttribute("data-mlchat", "1");
      (document.body || document.documentElement).appendChild(s);
    } catch (e) {}
  })();

  // ── Company memo gate ───────────────────────────────────────────────────────
  // A sent company memo MUST be read and signed. If this user has an unsigned
  // memo, show an UNAVOIDABLE, non-dismissible, non-snoozable overlay on every
  // portal page (except the sign page itself) linking to memo-sign.html.
  (function memoGate() {
    try {
      var page = (location.pathname.split("/").pop() || "").toLowerCase();
      var SKIP = ["login.html", "onboard.html", "confirmation.html", "forgot-password.html",
        "reset-password.html", "change-password.html", "hash.html", "memo-sign.html"];
      if (SKIP.indexOf(page) !== -1) return;
      var token = localStorage.getItem(TOKEN_KEY);
      if (!token) return;
      var esc = function (x) { return String(x == null ? "" : x).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
      nativeFetch(API + "/memos/pending", { headers: { Authorization: "Bearer " + token } })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d || !d.ok || !d.memos || !d.memos.length) return;
          if (document.getElementById("mlMemoGate")) return;
          var m = d.memos[0];
          var extra = d.memos.length > 1 ? "<p style='margin:8px 0 0;font-size:12.5px;color:#8aa0bd;'>You have " + d.memos.length + " memos to sign.</p>" : "";
          var ov = document.createElement("div");
          ov.id = "mlMemoGate";
          ov.style.cssText = "position:fixed;inset:0;z-index:100050;background:rgba(3,12,28,.82);display:flex;align-items:center;justify-content:center;padding:22px;font-family:'Segoe UI',system-ui,-apple-system,sans-serif;";
          ov.innerHTML = '<div style="background:#fff;border-radius:18px;max-width:420px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.4);overflow:hidden;">' +
            '<div style="background:linear-gradient(180deg,#1A4F8F,#003468);color:#fff;padding:20px;"><div style="font-size:34px;">📢</div>' +
            '<h2 style="margin:8px 0 0;font-size:19px;color:#fff;">Company memo</h2>' +
            '<p style="margin:6px 0 0;font-size:13.5px;color:#cfe0f5;">There\'s a memo you must read and sign before you carry on.</p></div>' +
            '<div style="padding:18px 20px 20px;">' +
            '<div style="font-weight:700;color:#003366;font-size:15px;">Re: ' + esc(m.re || "Company memo") + '</div>' +
            '<div style="color:#667085;font-size:13px;margin-top:2px;">From ' + esc(m.from || "the office") + '</div>' + extra +
            '<a href="/memo-sign.html?id=' + m.id + '" style="display:block;text-align:center;margin-top:16px;background:#003366;color:#fff;text-decoration:none;border-radius:10px;padding:13px;font-weight:700;font-size:15px;">Read &amp; sign now</a>' +
            '<p style="margin:10px 0 0;text-align:center;font-size:12px;color:#8a97a6;">This can\'t be dismissed — it must be signed.</p>' +
            '</div></div>';
          (document.body || document.documentElement).appendChild(ov);
          try { document.documentElement.style.overflow = "hidden"; } catch (e) {}
        }).catch(function () {});
    } catch (e) {}
  })();

  // ── EM remedial charge/quote gate (office) ─────────────────────────────────
  // When an EM cert has failed fittings, the office MUST confirm the client has
  // been charged (replaced on site) or quoted (remedial) — £50/fitting. Any
  // unconfirmed cert re-pops this BLOCKING modal (press "Do later" to snooze 4h
  // or confirm to clear); they stack. Office users only; field engineers skipped.
  (function remedialGate() {
    try {
      var page = (location.pathname.split("/").pop() || "").toLowerCase();
      var SKIP = ["login.html", "onboard.html", "confirmation.html", "forgot-password.html",
        "reset-password.html", "change-password.html", "hash.html", "memo-sign.html", "hs-sign.html", "programme-view.html"];
      if (SKIP.indexOf(page) !== -1) return;
      var token = localStorage.getItem(TOKEN_KEY);
      if (!token) return;
      var perms = {};
      try { perms = JSON.parse(sessionStorage.getItem("mostlanePermissions") || localStorage.getItem("mostlanePermissions") || "{}"); } catch (e) {}
      var yes = function (v) { return String(v || "").toLowerCase() === "yes"; };
      if (!(yes(perms.FullAccess) || yes(perms.SLAAdmin) || yes(perms.Compliance))) return;
      if (typeof mlFieldUserLocal === "function" && mlFieldUserLocal()) return;   // office only
      var esc = function (x) { return String(x == null ? "" : x).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
      var money = function (n) { return "£" + (Number(n) || 0).toFixed(0); };
      function ack(certId, action, cb) {
        nativeFetch(API + "/certs/remedials/ack", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify({ certId: certId, action: action }) })
          .then(function (r) { return r.json(); }).then(function () { cb && cb(); }).catch(function () { cb && cb(); });
      }
      function closeGate() { var o = document.getElementById("mlRemGate"); if (o) o.remove(); try { document.documentElement.style.overflow = ""; } catch (e) {} }
      function render(list) {
        closeGate();
        if (!list.length) return;
        var rows = list.map(function (m) {
          var q = m.batteries > 0
            ? (m.charge > 0 ? "Charged/quoted the works AND sent the battery enquiry?" : "Sent the battery enquiry to price?")
            : (m.pending > 0 && m.onsite > 0 ? "Have these been quoted &amp; charged?"
              : m.pending > 0 ? "Have the remedials been quoted?" : "Have the remedials been charged?");
          return '<div class="mlrem-item" data-cert="' + esc(m.certId) + '" style="border:1px solid #f0d9a6;background:#fffaf0;border-radius:12px;padding:12px;margin-top:10px;">'
            + '<div style="font-weight:700;color:#8a4b0a;">' + esc(m.siteName || m.siteCode || "Site") + ' · Cert ' + esc(m.certNumber || "") + '</div>'
            + '<div style="font-size:13px;color:#7a5b00;margin-top:2px;">' + m.fittings + ' fitting' + (m.fittings === 1 ? "" : "s") + ' failed'
            + (m.charge > 0 ? ' · <b>' + money(m.charge) + '</b> to charge' : '') + (m.batteries ? ' · <b>' + m.batteries + ' need batteries</b> (supplier quote)' : '')
            + (m.onsite ? ' · ' + m.onsite + ' on site' : '') + '</div>'
            + '<div style="font-size:13px;color:#8a4b0a;margin-top:6px;font-weight:600;">' + q + '</div>'
            + '<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">'
            + '<button data-act="done" style="flex:1;min-width:130px;background:#0a7d33;color:#fff;border:none;border-radius:9px;padding:11px;font-weight:700;font-size:14px;cursor:pointer;">&#10003; Charged / Quoted</button>'
            + '<button data-act="later" style="flex:1;min-width:100px;background:#fff;color:#8a4b0a;border:1px solid #e6c98a;border-radius:9px;padding:11px;font-weight:700;font-size:14px;cursor:pointer;">Do later</button>'
            + '</div></div>';
        }).join("");
        var ov = document.createElement("div");
        ov.id = "mlRemGate";
        ov.style.cssText = "position:fixed;inset:0;z-index:100060;background:rgba(3,12,28,.82);display:flex;align-items:center;justify-content:center;padding:22px;font-family:'Segoe UI',system-ui,-apple-system,sans-serif;overflow:auto;";
        ov.innerHTML = '<div style="background:#fff;border-radius:18px;max-width:470px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.4);overflow:hidden;">'
          + '<div style="background:linear-gradient(180deg,#b45309,#8a4b0a);color:#fff;padding:18px 20px;"><div style="font-size:30px;">&#9888;</div>'
          + '<h2 style="margin:6px 0 0;font-size:18px;color:#fff;">EM remedials &mdash; charge check</h2>'
          + '<p style="margin:6px 0 0;font-size:13px;color:#ffe9cf;">Confirm the client has been charged or quoted so we don\'t miss the works.</p></div>'
          + '<div style="padding:14px 18px 18px;max-height:70vh;overflow:auto;">' + rows
          + '<p style="margin:12px 0 0;text-align:center;font-size:12px;color:#8a97a6;">&ldquo;Do later&rdquo; reminds you again in 4 hours.</p></div></div>';
        ov.addEventListener("click", function (e) {
          var b = e.target && e.target.closest ? e.target.closest("button[data-act]") : null; if (!b) return;
          var item = b.closest(".mlrem-item"); var certId = item.getAttribute("data-cert");
          b.disabled = true;
          ack(certId, b.getAttribute("data-act"), function () { item.remove(); if (!ov.querySelector(".mlrem-item")) closeGate(); });
        });
        (document.body || document.documentElement).appendChild(ov);
        try { document.documentElement.style.overflow = "hidden"; } catch (e) {}
      }
      function check() {
        if (document.getElementById("mlRemGate")) return;   // don't stack overlays
        nativeFetch(API + "/certs/remedials/outstanding", { headers: { Authorization: "Bearer " + token } })
          .then(function (r) { return r.json(); }).then(function (d) {
            if (d && d.ok && d.remedials && d.remedials.length) render(d.remedials);
          }).catch(function () {});
      }
      window.mlRemedialCheck = check;        // let cert-review re-pop right after finalising
      check();
      setInterval(check, 15 * 60 * 1000);   // re-pop when a 4h snooze expires
    } catch (e) {}
  })();

  // ── Risk-assessment sign gate ───────────────────────────────────────────────
  // A risk assessment sent to this user MUST be read and signed. Push alone
  // isn't reliable (needs the PWA + permission), so — exactly like the memo gate
  // — show an UNAVOIDABLE, non-dismissible overlay on every portal page (except
  // the sign page) linking to hs-sign.html until it's signed.
  (function signGate() {
    try {
      var page = (location.pathname.split("/").pop() || "").toLowerCase();
      var SKIP = ["login.html", "onboard.html", "confirmation.html", "forgot-password.html",
        "reset-password.html", "change-password.html", "hash.html", "memo-sign.html", "hs-sign.html"];
      if (SKIP.indexOf(page) !== -1) return;
      var token = localStorage.getItem(TOKEN_KEY);
      if (!token) return;
      var esc = function (x) { return String(x == null ? "" : x).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
      nativeFetch(API + "/hs/to-sign", { headers: { Authorization: "Bearer " + token } })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d || !d.ok || !d.items || !d.items.length) return;
          if (document.getElementById("mlSignGate")) return;
          if (document.getElementById("mlMemoGate")) return;   // let the memo gate go first
          var it = d.items[0];
          var extra = d.items.length > 1 ? "<p style='margin:8px 0 0;font-size:12.5px;color:#8aa0bd;'>You have " + d.items.length + " to sign.</p>" : "";
          var ov = document.createElement("div");
          ov.id = "mlSignGate";
          ov.style.cssText = "position:fixed;inset:0;z-index:100050;background:rgba(3,12,28,.82);display:flex;align-items:center;justify-content:center;padding:22px;font-family:'Segoe UI',system-ui,-apple-system,sans-serif;";
          ov.innerHTML = '<div style="background:#fff;border-radius:18px;max-width:420px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.4);overflow:hidden;">' +
            '<div style="background:linear-gradient(180deg,#1A4F8F,#003468);color:#fff;padding:20px;"><div style="font-size:34px;">✍️</div>' +
            '<h2 style="margin:8px 0 0;font-size:19px;color:#fff;">Risk assessment to sign</h2>' +
            '<p style="margin:6px 0 0;font-size:13.5px;color:#cfe0f5;">You\'ve been sent a risk assessment to read and sign before you carry on.</p></div>' +
            '<div style="padding:18px 20px 20px;">' +
            '<div style="font-weight:700;color:#003366;font-size:15px;">' + esc(it.ref || "Risk assessment") + '</div>' +
            (it.site ? '<div style="color:#667085;font-size:13px;margin-top:2px;">' + esc(it.site) + '</div>' : '') + extra +
            '<a href="/hs-sign.html?id=' + encodeURIComponent(it.id) + '" style="display:block;text-align:center;margin-top:16px;background:#003366;color:#fff;text-decoration:none;border-radius:10px;padding:13px;font-weight:700;font-size:15px;">Read &amp; sign now</a>' +
            '<p style="margin:10px 0 0;text-align:center;font-size:12px;color:#8a97a6;">This can\'t be dismissed — it must be signed.</p>' +
            '</div></div>';
          (document.body || document.documentElement).appendChild(ov);
          try { document.documentElement.style.overflow = "hidden"; } catch (e) {}
        }).catch(function () {});
    } catch (e) {}
  })();

  // ── Notification bell (Facebook-style feed) ─────────────────────────────────
  // ── Hard refresh: 🔄 button (desktop) + pull-down gesture (touch/PWA) ─────
  // One action = the closest a page can get to Ctrl+Shift+R: wipe every
  // service-worker cache, re-fetch the service worker itself, force the core
  // scripts past the browser HTTP cache, then reload. The cure for "my phone
  // is stuck on an old version" without asking anyone to find browser settings.
  // On touch devices (mobile/PWA) the button is hidden and users pull DOWN at
  // the top of the page instead; on desktop the button stays (no pull-down).
  (function hardRefresh() {
    try {
      var page = (location.pathname.split("/").pop() || "").toLowerCase();
      var SKIP = ["login.html", "onboard.html", "confirmation.html", "forgot-password.html",
        "reset-password.html", "change-password.html", "hash.html", "my-day.html",
        "memo-sign.html", "hs-sign.html", "programme-view.html"];
      if (SKIP.indexOf(page) !== -1) return;
      if (!localStorage.getItem(TOKEN_KEY)) return;

      var isTouch = false;
      try { isTouch = window.matchMedia && window.matchMedia("(pointer:coarse)").matches; } catch (e) {}

      // The refresh routine — shared by the button + the pull gesture.
      var refreshing = false;
      async function doHardRefresh() {
        if (refreshing) return;
        refreshing = true;
        try {
          // 1. Wipe every Cache Storage cache (the service worker's copies).
          if (window.caches && caches.keys) {
            var keys = await caches.keys();
            await Promise.all(keys.map(function (k) { return caches.delete(k).catch(function () {}); }));
          }
          // 2. Ask each service worker registration to fetch its newest sw.js.
          if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
            var regs = await navigator.serviceWorker.getRegistrations();
            await Promise.all(regs.map(function (r) { return r.update().catch(function () {}); }));
          }
          // 3. Force the core shell past the browser HTTP cache so the reload
          //    picks up fresh copies immediately (best-effort, failures ignored).
          var core = ["/portal-config.js?v=18", "/portal.css?v=1", "/auth.js", "/device-auth.js",
            location.pathname + location.search];
          await Promise.all(core.map(function (u) {
            return fetch(u, { cache: "reload" }).catch(function () {});
          }));
        } catch (e) {}
        location.reload();
      }

      // ── Desktop-only button ────────────────────────────────────────────────
      function buildButton() {
        if (isTouch) return;   // touch users get the pull-to-refresh gesture instead
        if (document.getElementById("mlRefresh")) return;
        var btn = document.createElement("button");
        btn.id = "mlRefresh";
        btn.setAttribute("aria-label", "Refresh this page");
        btn.title = "Refresh — fetches the latest version of this page (clears cached copies)";
        // Bottom-LEFT so it never covers a top-corner Back button or a
        // full-screen photo's ✕. Lifted above the field-app tabbar when present.
        var bottom = 12;
        try { var tb = document.querySelector(".tabbar"); if (tb && tb.offsetParent !== null) bottom = Math.round(tb.getBoundingClientRect().height) + 12; } catch (e) {}
        btn.style.cssText = "position:fixed;bottom:calc(" + bottom + "px + env(safe-area-inset-bottom,0px));left:8px;z-index:98000;" +
          "width:34px;height:34px;border-radius:50%;border:none;background:rgba(255,255,255,.92);" +
          "box-shadow:0 3px 12px rgba(0,20,60,.28);cursor:pointer;font-size:16px;line-height:34px;padding:0;opacity:.9;";
        btn.textContent = "🔄";
        btn.onclick = function () {
          btn.style.transition = "transform .8s ease";
          btn.style.transform = "rotate(720deg)";
          btn.disabled = true;
          doHardRefresh();
        };
        (document.body || document.documentElement).appendChild(btn);
      }

      // ── Touch-only pull-to-refresh ────────────────────────────────────────
      // Pull DOWN at the very top of the page ~80px, release, and the same
      // hard refresh fires. A blue banner slides down from the top with a hint
      // ("↓ Pull to refresh" → "↻ Release to refresh"), matching modern app
      // conventions. Uses 60% resistance for a native feel.
      function wirePull() {
        if (!isTouch) return;
        // Suppress the browser's native overscroll (would trigger its own,
        // soft reload on Chromium and fight our gesture).
        try { document.documentElement.style.overscrollBehaviorY = "contain"; } catch (e) {}

        var THRESH = 80, banner = null, startY = 0, startX = 0, dragging = false, engaged = false;
        function atTop() {
          var se = document.scrollingElement || document.documentElement;
          return (se && se.scrollTop <= 0);
        }
        function ensureBanner() {
          if (banner) return banner;
          banner = document.createElement("div");
          banner.id = "mlP2R";
          banner.style.cssText = "position:fixed;top:0;left:0;right:0;height:0;overflow:hidden;" +
            "background:linear-gradient(180deg,#003366,#004080);color:#fff;font:600 14px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;" +
            "display:flex;align-items:flex-end;justify-content:center;padding-bottom:10px;" +
            "z-index:100000;box-shadow:0 3px 12px rgba(0,20,60,.28);will-change:height;transition:none;";
          document.body.appendChild(banner);
          return banner;
        }
        function killBanner() { if (banner) { banner.remove(); banner = null; } }

        document.addEventListener("touchstart", function (e) {
          if (e.touches.length !== 1 || !atTop()) return;
          startY = e.touches[0].clientY; startX = e.touches[0].clientX;
          dragging = true; engaged = false;
        }, { passive: true });

        document.addEventListener("touchmove", function (e) {
          if (!dragging) return;
          var t = e.touches[0], dy = t.clientY - startY, dx = Math.abs(t.clientX - startX);
          // Ignore upward or sideways drags — user is scrolling / swiping, not pulling.
          if (dy <= 0 || dx > Math.abs(dy) || !atTop()) { killBanner(); engaged = false; return; }
          var el = ensureBanner();
          var h = Math.min(dy * 0.6, THRESH + 30);
          el.style.height = h + "px";
          el.textContent = h >= THRESH ? "↻  Release to refresh" : "↓  Pull to refresh";
          engaged = h >= THRESH;
        }, { passive: true });

        function finish() {
          if (!dragging) return;
          dragging = false;
          if (engaged) {
            if (banner) { banner.style.height = "50px"; banner.textContent = "↻  Refreshing…"; }
            doHardRefresh();
          } else if (banner) {
            banner.style.transition = "height .2s ease"; banner.style.height = "0";
            setTimeout(killBanner, 220);
          }
        }
        document.addEventListener("touchend", finish, { passive: true });
        document.addEventListener("touchcancel", function () { dragging = false; killBanner(); }, { passive: true });
      }

      function start() { buildButton(); wirePull(); }
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
      else start();
    } catch (e) { console.error("[hard-refresh]", e); }
  })();

  // ── New van driving-score banner (top of every page for the engineer) ────
  // A dark navy "🚐 Your new van driving score is ready — tap to view" bar that
  // sits above the page header until dismissed or opened. Was hardcoded into
  // route.html only — moved here so it appears on every logged-in portal page.
  //
  // Two fixes over the original:
  //   • The seen marker is now keyed PER-USER (`mlVanScoreSeen:<username>`)
  //     instead of a shared device key. Without this, View As'ing a user
  //     inherited whoever's marker was on that phone last — so Jamie viewing
  //     as Connor saw no banner because Jamie had dismissed his own score.
  //   • Tapping the WHOLE banner (not only the ✕) now also POSTs to /prefs
  //     so the seen state syncs cross-device, matching the ✕ behaviour.
  (function vanScoreBanner() {
    try {
      var page = (location.pathname.split("/").pop() || "").toLowerCase();
      // Skip auth flows, gate pages, and the target page itself.
      var SKIP = ["login.html", "onboard.html", "confirmation.html",
        "forgot-password.html", "reset-password.html", "change-password.html",
        "hash.html", "memo-sign.html", "hs-sign.html", "programme-view.html",
        "my-van-scores.html"];
      if (SKIP.indexOf(page) !== -1) return;
      if (!localStorage.getItem(TOKEN_KEY)) return;

      // Per-user key so View As doesn't inherit the impersonator's marker.
      // Empty username → falls back to the shared key (legacy behaviour).
      function whoNow() {
        try { return (sessionStorage.getItem("mostlaneUser") || localStorage.getItem("mostlaneUser") || "").trim(); }
        catch (e) { return ""; }
      }
      function seenKey() {
        var u = whoNow();
        return u ? ("mlVanScoreSeen:" + u) : "mlVanScoreSeen";
      }

      function fetchAndShow() {
        var t = localStorage.getItem(TOKEN_KEY) || "";
        if (!t) return;
        fetch(window.MOSTLANE_API + "/fleet/scores/unseen", {
          headers: { "Authorization": "Bearer " + t }, cache: "no-store"
        }).then(function (r) { return r.json(); }).then(function (d) {
          if (!d || !d.ok || !d.latest) return;
          var key = seenKey(), seen = "";
          try { seen = localStorage.getItem(key) || ""; } catch (e) {}
          if (seen && seen >= d.latest) return;
          if (document.getElementById("mlVanScoreNote")) return;

          // Post the seen date to BOTH storages — the ✕ AND the whole-banner
          // click now do the same thing, so the marker survives on this device
          // AND on the user's other devices (via /prefs).
          function markSeen() {
            try { localStorage.setItem(key, d.latest); } catch (e) {}
            try { fetch(window.MOSTLANE_API + "/prefs", { method: "POST",
              headers: { "Authorization": "Bearer " + t, "Content-Type": "application/json" },
              body: JSON.stringify({ vanScoreSeen: d.latest }) }); } catch (e) {}
          }

          var a = document.createElement("a");
          a.id = "mlVanScoreNote";
          a.href = "/my-van-scores.html";
          // Sits BELOW the statusCap (which paints the notch inset). Padding
          // needs no safe-area allowance because statusCap owns that region.
          a.style.cssText = "position:fixed;top:env(safe-area-inset-top, 0px);left:0;right:0;z-index:99500;" +
            "background:#003468;color:#fff;text-decoration:none;padding:10px 14px;" +
            "font:650 13px -apple-system,system-ui,'Segoe UI',Roboto,Arial,sans-serif;" +
            "display:flex;align-items:center;gap:10px;box-shadow:0 2px 8px rgba(0,0,0,.22);";
          a.innerHTML = '<span style="flex:1">🚐 Your new van driving score is ready — tap to view</span>' +
            '<span id="mlVanScoreX" style="opacity:.85;font-size:16px;padding:0 6px">✕</span>';
          a.addEventListener("click", function () { markSeen(); });
          document.body.appendChild(a);
          // Reserve the space it occupies, or it just covers the top of the
          // page. Measured rather than assumed — the text wraps to two lines on
          // a narrow screen. Re-measured on resize/rotate.
          function reserve() {
            var h = Math.round(a.getBoundingClientRect().height);
            document.documentElement.style.setProperty("--ml-topbar", h + "px");
          }
          function release() {
            document.documentElement.style.removeProperty("--ml-topbar");
            removeEventListener("resize", reserve);
          }
          reserve();
          addEventListener("resize", reserve);
          var x = document.getElementById("mlVanScoreX");
          if (x) x.addEventListener("click", function (ev) {
            ev.preventDefault(); ev.stopPropagation();
            markSeen();
            release();
            a.remove();
          });
        }).catch(function () {});
      }
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fetchAndShow);
      else fetchAndShow();
    } catch (e) { console.error("[van-score]", e); }
  })();

  // A small bell, top-right on every portal page, that anyone can open at any
  // time to see their past notifications (holiday decisions, job updates, memos,
  // van scores, equipment, …). Each one links straight to the thing it's about
  // (the signed document, the job, the request). The feed is written server-side
  // for every push event, so it's complete even if the phone never turned push
  // on. Chat messages are deliberately NOT here — they have the 💬 chat bell.
  (function notifBell() {
    try {
      var page = (location.pathname.split("/").pop() || "").toLowerCase();
      // The bell lives ONLY on the home page — it used to float top-right on every
      // page and covered full-screen photo/doc close (✕) buttons.
      if (page !== "main.html") return;
      var token = localStorage.getItem(TOKEN_KEY);
      if (!token) return;
      var p = {};
      try { p = JSON.parse(sessionStorage.getItem("mostlanePermissions") || localStorage.getItem("mostlanePermissions") || "{}"); } catch (e) {}
      if (String(p.StoryMode || "").toLowerCase() === "yes") return;   // guided My Day users stay minimal

      function bf(path, init) {
        init = init || {};
        init.headers = Object.assign({ "Authorization": "Bearer " + token }, init.headers || {});
        if (init.body) init.headers["Content-Type"] = "application/json";
        return nativeFetch(API + path, init);
      }
      function esc(x) { return String(x == null ? "" : x).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
      function ago(iso) {
        try {
          var s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
          if (s < 60) return "just now";
          if (s < 3600) return Math.floor(s / 60) + "m";
          if (s < 86400) return Math.floor(s / 3600) + "h";
          if (s < 604800) return Math.floor(s / 86400) + "d";
          return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
        } catch (e) { return ""; }
      }
      function iconFor(n) {
        var t = (n.tag || "").toLowerCase() + " " + (n.url || "").toLowerCase() + " " + (n.title || "").toLowerCase();
        if (/holiday/.test(t)) return "🌴";
        if (/vancheck|van-check|van check/.test(t)) return "🚐";
        if (/handover/.test(t)) return "🤝";
        if (/score/.test(t)) return "🚚";
        if (/task/.test(t)) return "✅";
        if (/memo/.test(t)) return "📢";
        if (/asset|equipment|transfer|confirm/.test(t)) return "📦";
        if (/hold|safety|risk|job|sla|engineer/.test(t)) return "🧰";
        return "🔔";
      }

      function build() {
        if (document.getElementById("mlBell")) return;
        var wrap = document.createElement("div");
        wrap.id = "mlBell";
        wrap.style.cssText = "position:fixed;top:calc(8px + env(safe-area-inset-top,0px));right:10px;z-index:99000;font-family:'Segoe UI',system-ui,-apple-system,sans-serif;";
        wrap.innerHTML =
          '<button id="mlBellBtn" aria-label="Notifications" style="position:relative;width:42px;height:42px;border-radius:50%;border:none;background:rgba(255,255,255,.92);box-shadow:0 3px 12px rgba(0,20,60,.28);cursor:pointer;font-size:20px;line-height:42px;padding:0;backdrop-filter:blur(4px);">🔔' +
          '<span id="mlBellBadge" style="display:none;position:absolute;top:-3px;right:-3px;min-width:18px;height:18px;padding:0 4px;border-radius:9px;background:#e53935;color:#fff;font-size:11px;font-weight:700;line-height:18px;text-align:center;box-shadow:0 0 0 2px #fff;"></span>' +
          '</button>' +
          '<div id="mlBellPanel" style="display:none;position:absolute;top:50px;right:0;width:min(360px,calc(100vw - 20px));max-height:min(72vh,560px);overflow:auto;background:#fff;border-radius:14px;box-shadow:0 18px 50px rgba(0,20,60,.32);border:1px solid #e6ebf1;-webkit-overflow-scrolling:touch;">' +
          '<div style="position:sticky;top:0;background:#fff;padding:13px 16px;border-bottom:1px solid #eef1f4;display:flex;align-items:center;justify-content:space-between;z-index:1;">' +
          '<strong style="color:#0a2a52;font-size:15px;">Notifications</strong>' +
          '<button id="mlBellRead" style="border:none;background:none;color:#1565c0;font-size:12.5px;cursor:pointer;padding:2px 4px;">Mark all read</button></div>' +
          '<div id="mlBellList"><div style="padding:22px 16px;color:#8a97a6;font-size:13px;text-align:center;">Loading…</div></div>' +
          '</div>';
        (document.body || document.documentElement).appendChild(wrap);

        var btn = wrap.querySelector("#mlBellBtn");
        var badge = wrap.querySelector("#mlBellBadge");
        var panel = wrap.querySelector("#mlBellPanel");
        var list = wrap.querySelector("#mlBellList");
        var readBtn = wrap.querySelector("#mlBellRead");
        var open = false;

        function setBadge(n) {
          n = Number(n) || 0;
          if (n > 0) { badge.textContent = n > 99 ? "99+" : n; badge.style.display = "block"; }
          else badge.style.display = "none";
        }
        function pollCount() {
          if (open) return;
          bf("/notify/feed/count").then(function (r) { return r.json(); })
            .then(function (d) { if (d && d.ok) setBadge(d.unread); }).catch(function () {});
        }
        function render(items) {
          if (!items || !items.length) {
            list.innerHTML = '<div style="padding:26px 16px;color:#8a97a6;font-size:13px;text-align:center;">No notifications yet.<br>You\'ll see updates here as they happen.</div>';
            return;
          }
          list.innerHTML = items.map(function (n) {
            // An actionable alert stays OUTSTANDING (amber, bold, can't be dismissed
            // by clicking) until the underlying item is dealt with — then it resolves
            // to a read outcome ("✅ Approved by X").
            var outstanding = n.actionable && !n.resolved;
            var bg = outstanding ? "#fff8ec" : (n.read ? "#fff" : "#eef6ff");
            var tw = (outstanding || !n.read) ? "700" : "600";
            var href = n.url ? esc(n.url) : "";
            var dotC = outstanding ? "#f59e0b" : "#1e88e5";
            var dot = (outstanding || !n.read) ? '<span class="mlBellDot" style="position:absolute;left:7px;top:50%;width:7px;height:7px;border-radius:50%;background:' + dotC + ';transform:translateY(-50%);"></span>' : "";
            var pill = outstanding ? '<span style="display:inline-block;margin-top:3px;font-size:10.5px;font-weight:700;color:#b45309;background:#fef3c7;border-radius:6px;padding:1px 6px;">Needs action</span>' : "";
            return '<a class="mlBellItem" data-id="' + n.id + '" data-out="' + (outstanding ? "1" : "0") + '" href="' + href + '" style="position:relative;display:flex;gap:10px;align-items:flex-start;padding:12px 14px 12px 20px;border-bottom:1px solid #f1f4f7;text-decoration:none;color:inherit;background:' + bg + (outstanding ? ';box-shadow:inset 3px 0 0 #f59e0b' : '') + ';">' +
              dot +
              '<span style="font-size:20px;line-height:1.2;flex:0 0 auto;">' + iconFor(n) + '</span>' +
              '<span style="flex:1;min-width:0;">' +
              '<span class="mlBellTitle" style="display:block;font-weight:' + tw + ';color:#12233d;font-size:13.5px;">' + esc(n.title || "Notification") + '</span>' +
              (n.body ? '<span style="display:block;color:#55647a;font-size:12.5px;margin-top:1px;">' + esc(n.body) + '</span>' : '') +
              (pill ? '<span style="display:block;">' + pill + '</span>' : '') +
              '<span style="display:block;color:#98a4b3;font-size:11px;margin-top:3px;">' + ago(n.at) + '</span>' +
              '</span></a>';
          }).join("");
          Array.prototype.forEach.call(list.querySelectorAll(".mlBellItem"), function (a) {
            a.addEventListener("click", function (e) {
              var href = a.getAttribute("href");
              var id = a.getAttribute("data-id");
              var outstanding = a.getAttribute("data-out") === "1";
              if (id) bf("/notify/feed/read", { method: "POST", keepalive: true, body: JSON.stringify({ id: Number(id) }) }).catch(function () {});
              // Outstanding actionable items STAY highlighted — opening them isn't
              // "dealing with" them, so they keep nudging until actually actioned.
              if (!outstanding) {
                a.style.background = "#fff";
                var dt = a.querySelector(".mlBellDot"); if (dt) dt.style.display = "none";
                var tt = a.querySelector(".mlBellTitle"); if (tt) tt.style.fontWeight = "600";
              }
              if (!href) { e.preventDefault(); }   // no target — just a record
            });
          });
        }
        function openPanel() {
          open = true;
          panel.style.display = "block";
          list.innerHTML = '<div style="padding:22px 16px;color:#8a97a6;font-size:13px;text-align:center;">Loading…</div>';
          bf("/notify/feed?limit=40").then(function (r) { return r.json(); })
            .then(function (d) {
              render(d && d.items);
              // Opening the bell marks normal items "seen" (clears their part of the
              // count), but OUTSTANDING actionable alerts keep counting until they're
              // actually dealt with — so the badge drops to those, not to zero.
              var stillOut = ((d && d.items) || []).filter(function (i) { return i.actionable && !i.resolved; }).length;
              setBadge(stillOut);
              if (d && d.unread) { bf("/notify/feed/read", { method: "POST", body: JSON.stringify({ seen: true }) }).catch(function () {}); }
            }).catch(function () {
              list.innerHTML = '<div style="padding:22px 16px;color:#c0392b;font-size:13px;text-align:center;">Couldn\'t load notifications.</div>';
            });
        }
        function closePanel() { open = false; panel.style.display = "none"; }

        btn.addEventListener("click", function (e) { e.stopPropagation(); if (open) closePanel(); else openPanel(); });
        readBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          bf("/notify/feed/read", { method: "POST", body: JSON.stringify({ all: true }) }).catch(function () {});
          var out = 0;
          Array.prototype.forEach.call(list.querySelectorAll(".mlBellItem"), function (a) {
            // Outstanding actionable items can't be "marked read" — they stay until dealt with.
            if (a.getAttribute("data-out") === "1") { out++; return; }
            a.style.background = "#fff";
            var d = a.querySelector(".mlBellDot"); if (d) d.style.display = "none";
            var t = a.querySelector(".mlBellTitle"); if (t) t.style.fontWeight = "600";
          });
          setBadge(out);
        });
        document.addEventListener("click", function (e) { if (open && !wrap.contains(e.target)) closePanel(); });
        window.addEventListener("pageshow", pollCount);

        pollCount();
        setInterval(pollCount, 45000);
      }

      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build);
      else build();
    } catch (e) {}
  })();
})();
