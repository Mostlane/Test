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
        for (var i = 0; i < links.length; i++) { links[i].setAttribute("href", "/you.html"); }
      };
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fixBacks);
      else fixBacks();
    }
  } catch (e) {}

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
          document.body.style.paddingBottom = "56px";
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
        chart: '<path d="M3 3v18h18"/><rect x="7" y="12" width="3" height="6"/><rect x="12" y="8" width="3" height="10"/><rect x="17" y="4" width="3" height="14"/>'
      };
      function svg(name) { return '<svg viewBox="0 0 24 24">' + (ICONS[name] || "") + "</svg>"; }

      // Single source of truth for the nav. perms:["__fullOnly"] => FullAccess only.
      var NAV = [
        { title: "Operations", items: [
          { label: "Home", href: "main.html", icon: "home", always: true, match: ["main.html", ""] },
          { label: "SLA / Jobs", href: "sla-main.html", icon: "jobs", perms: ["SLA", "SLAAdmin"], match: ["sla-menu.html", "sla-main.html", "job-view.html", "sla-settings.html", "sla-scheduler.html", "engineer-jobs.html", "add-job.html"] },
          { label: "Sites", href: "sites.html", icon: "sites", perms: ["Sites", "AddSite"] },
          { label: "Customers", href: "customers.html", icon: "customers", perms: ["Sites", "AddSite"] },
          { label: "SiteLog", href: "sitelog.html", icon: "sitelog", perms: ["SiteLog"] },
          { label: "Plant & Equipment", href: "my-assets.html", icon: "assets", perms: ["Assets"], match: ["my-assets.html", "asset-menu.html", "assets-admin.html", "shared-assets.html"] },
          { label: "Projects", href: "projects.html", icon: "projects", perms: ["Projects", "ProjectsAdmin"], hrefBy: [["Projects", "projects.html"], ["ProjectsAdmin", "projects-admin.html"]], match: ["projects.html", "projects-admin.html"] },
          { label: "PO System", href: "po.html", icon: "po", perms: ["PurchaseOrders"], match: ["po.html"] },
          { label: "H&S Plans", launch: "hs", icon: "hs", perms: ["HSPlan"] }
        ]},
        { title: "Time & HR", items: [
          { label: "Timesheet", href: "office-timesheet.html", icon: "timesheet", perms: ["OfficeTimesheet", "Vehicles"], hrefBy: [["OfficeTimesheet", "office-timesheet.html"], ["Vehicles", "van-timesheet.html"]], match: ["office-timesheet.html", "van-timesheet.html"] },
          { label: "My Timesheet", href: "engineer-timesheet.html", icon: "timesheet", perms: ["EngTimesheet"], match: ["engineer-timesheet.html"] },
          { label: "Engineer Timesheets", href: "timesheets-admin.html", icon: "timesheet", perms: ["TimesheetAdmin"], match: ["timesheets-admin.html"] },
          { label: "My Hours", href: "office-my-hours.html", icon: "clock", perms: ["OfficeClock"] },
          { label: "Holiday", href: "holiday.html", icon: "holiday", perms: ["Holiday"] },
          { label: "Holiday Admin", href: "holiday-admin.html", icon: "holidayAdmin", perms: ["HolidayAdmin"], match: ["holiday-admin.html", "holiday-config.html"] },
          { label: "Weekly Summary", href: "weekly.html", icon: "weekly", perms: ["Weekly"] },
          { label: "Hours Dashboard", href: "hours-dashboard-simple-v2.html", icon: "gauge", perms: ["HoursDashboard"] },
          // Labour Planning unlinked on request (legacy, unused) — page file kept.
          { label: "Vehicles", href: "vehicles.html", icon: "vehicles", perms: ["Vehicles"], match: ["vehicles.html", "fleet-report.html", "van-checks.html", "van-timesheet.html"] }
        ]},
        { title: "Admin", items: [
          { label: "Users", href: "users-admin.html", icon: "users", perms: ["Users", "DeviceAdmin"], hrefBy: [["Users", "users-admin.html"], ["DeviceAdmin", "device-admin.html"]], match: ["users-admin.html", "device-admin.html"] },
          { label: "Stats", href: "stats.html", icon: "chart", perms: ["__fullOnly"] },
          { label: "Notification Centre", href: "notification-centre.html", icon: "forms", perms: ["__fullOnly"] },
          { label: "Forms", href: "forms.html", icon: "forms", perms: ["Forms"] },
          { label: "Compliance", href: "compliance.html", icon: "compliance", perms: ["Compliance"] },
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
        var out = "";
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
          + '<img class="mark" src="/icons/icon-512.png" alt="Mostlane"></div></div>'
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
        });
        document.getElementById("pnavLogout").addEventListener("click", function () {
          localStorage.removeItem("mostlaneToken"); sessionStorage.clear(); location.href = "/login.html";
        });
        document.getElementById("pnavCollapse").addEventListener("click", function () {
          var c = document.documentElement.classList.toggle("pnav-collapsed");
          try { localStorage.setItem("pnavCollapsed", c ? "1" : "0"); } catch (e) {}
        });
        try { initOfficeClock(); } catch (e) {}
        try { if (yes(perms.FullAccess)) refreshMenuConfig(); } catch (e) {}
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
              + '<input type="time" id="ocFinishTime" value="17:00" style="font-size:22px;padding:8px 12px;border:1px solid #ccd5dd;border-radius:10px;text-align:center;margin-bottom:14px;">'
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
          var lb = document.getElementById("ocLogoutBtn"); if (lb) lb.onclick = function () { localStorage.removeItem("mostlaneToken"); sessionStorage.clear(); location.href = "/login.html"; };
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
        fetchAuthed("/vancheck/attention").then(function (d) {
          if (d && d.ok) setNavBadge("vehicles.html", (d.mineDue ? 1 : 0) + ((d.missing && d.overdue) ? d.missing.length : 0));
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
          + ".ml-back{ display:inline-flex; align-items:center; gap:6px; text-decoration:none; font:600 14px/1 -apple-system,system-ui,'Segoe UI',sans-serif; padding:8px 13px; border-radius:999px; background:#fff; border:1px solid #d7dee6; color:#003366; box-shadow:0 1px 2px rgba(0,0,0,.06); cursor:pointer; }"
          + ".ml-back:hover{ background:#f4f7fb; }"
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
})();
