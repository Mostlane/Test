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
          return nativeFetch(newUrl, init);
        }
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
        a.href = "my-day.html";
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

  // ── Desktop navigation sidebar (permission-aware) ──────────────────────────
  // Injected on every portal page; shown only on desktop (CSS ≥1000px). Mobile
  // keeps the existing tile menu + back buttons untouched. Story Mode users are
  // left in their guided flow (no sidebar).
  (function portalNav() {
    try {
      var page = (location.pathname.split("/").pop() || "").toLowerCase();
      var SKIP = ["login.html", "onboard.html", "confirmation.html", "forgot-password.html",
        "reset-password.html", "change-password.html", "index.html", "my-day.html", "hash.html", ""];
      if (SKIP.indexOf(page) !== -1) return;
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
        settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M6 6l2 2M16 16l2 2M6 18l2-2M16 8l2-2"/>'
      };
      function svg(name) { return '<svg viewBox="0 0 24 24">' + (ICONS[name] || "") + "</svg>"; }

      // Single source of truth for the nav. perms:["__fullOnly"] => FullAccess only.
      var NAV = [
        { title: "Operations", items: [
          { label: "Home", href: "main.html", icon: "home", always: true, match: ["main.html", ""] },
          { label: "SLA / Jobs", href: "sla-menu.html", icon: "jobs", perms: ["SLA"], match: ["sla-menu.html", "sla-main.html", "job-view.html", "sla-settings.html"] },
          { label: "Sites", href: "sites.html", icon: "sites", perms: ["Sites", "AddSite"] },
          { label: "Customers", href: "customers.html", icon: "customers", perms: ["Sites", "AddSite"] },
          { label: "SiteLog", href: "sitelog.html", icon: "sitelog", perms: ["SiteLog"] },
          { label: "Plant & Equipment", href: "asset-menu.html", icon: "assets", perms: ["Assets"], match: ["asset-menu.html", "assets-admin.html", "my-assets.html", "shared-assets.html"] },
          { label: "Projects", href: "projects.html", icon: "projects", perms: ["Projects"] },
          { label: "Projects Admin", href: "projects-admin.html", icon: "projects", perms: ["ProjectsAdmin"] },
          { label: "PO System", launch: "po", icon: "po", perms: ["PurchaseOrders"] },
          { label: "H&S Plans", launch: "hs", icon: "hs", perms: ["HSPlan"] }
        ]},
        { title: "Time & HR", items: [
          { label: "Office Timesheet", href: "office-timesheet.html", icon: "timesheet", perms: ["OfficeTimesheet"] },
          { label: "My Hours", href: "office-my-hours.html", icon: "clock", perms: ["OfficeClock"] },
          { label: "Holiday", href: "holiday.html", icon: "holiday", perms: ["Holiday"] },
          { label: "Holiday Admin", href: "holiday-admin.html", icon: "holidayAdmin", perms: ["HolidayAdmin"], match: ["holiday-admin.html", "holiday-config.html"] },
          { label: "Weekly Summary", href: "weekly.html", icon: "weekly", perms: ["Weekly"] },
          { label: "Hours Dashboard", href: "hours-dashboard-simple-v2.html", icon: "gauge", perms: ["HoursDashboard"] },
          { label: "Labour Planning", href: "labour-planning.html", icon: "labour", perms: ["LabourPlanning"] },
          { label: "Vehicles", href: "vehicles.html", icon: "vehicles", perms: ["Vehicles"] }
        ]},
        { title: "Admin", items: [
          { label: "Users", href: "users-admin.html", icon: "users", perms: ["Users"] },
          { label: "Devices", href: "device-admin.html", icon: "devices", perms: ["DeviceAdmin"] },
          { label: "Forms", href: "forms.html", icon: "forms", perms: ["Forms"] },
          { label: "Compliance", href: "compliance.html", icon: "compliance", perms: ["Compliance"] },
          { label: "Settings", href: "settings.html", icon: "settings", perms: ["__fullOnly"] }
        ]}
      ];

      function allowed(item) {
        if (item.always) return true;
        if (yes(perms.FullAccess)) return true;
        if (!item.perms || !item.perms.length) return true;
        for (var i = 0; i < item.perms.length; i++) if (yes(perms[item.perms[i]])) return true;
        return false;
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
            var attrs = it.launch ? 'href="#" data-launch="' + it.launch + '"' : 'href="' + esc(it.href) + '"';
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
          localStorage.removeItem("mostlaneToken"); sessionStorage.clear(); location.href = "login.html";
        });
        document.getElementById("pnavCollapse").addEventListener("click", function () {
          var c = document.documentElement.classList.toggle("pnav-collapsed");
          try { localStorage.setItem("pnavCollapsed", c ? "1" : "0"); } catch (e) {}
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
      }

      function doLaunch(kind) {
        if (kind === "po") {
          fetchAuthed("/po-config").then(function (c) {
            if (c && c.ok && c.url) location.href = c.url;
            else alert("No PO link is set on your account yet — ask the office to add your personal PO URL in Users admin.");
          }).catch(function () { alert("Couldn't open the PO system."); });
        } else if (kind === "hs") {
          fetchAuthed("/hs-plan-config").then(function (c) {
            if (c && c.ok && c.token) location.href = "hs-plan/#worker=" + encodeURIComponent(c.worker) + "&token=" + encodeURIComponent(c.token);
            else alert("The H&S planner isn't available for your account yet.");
          }).catch(function () { alert("Couldn't open the H&S planner."); });
        }
      }

      injectStyles();
      function start() {
        build();
        // Refresh from the server so gating is correct even if the cached perms
        // are stale/incomplete (older logins) — then re-render.
        fetchAuthed("/auth/me").then(function (d) {
          if (d && d.ok && d.user) {
            perms = d.user;
            try {
              var slim = {}; ["FullAccess","Users","DeviceAdmin","CheckInOut","Vehicles","Holiday","HolidayAdmin","EngineersHoursMenu","HoursDashboard","PurchaseOrders","Sites","AddSite","Assets","MyDocuments","Weekly","Forms","Compliance","Projects","ProjectsAdmin","TimesheetAdmin","LabourPlanning","SLA","StoryMode","HSPlan","SiteLog","OfficeClock","OfficeTimesheet","FirstName","LastName"].forEach(function (k) { slim[k] = d.user[k]; });
              sessionStorage.setItem("mostlanePermissions", JSON.stringify(slim));
              localStorage.setItem("mostlanePermissions", JSON.stringify(slim));
            } catch (e) {}
            if (yes(perms.StoryMode)) { var n = document.getElementById("pnav"); if (n) n.remove(); document.body.classList.remove("pnav-on"); return; }
            rebuild();
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
          + "#pnav{ position:fixed; left:0; top:0; height:100vh; width:248px; z-index:1000; background:linear-gradient(185deg,#1A4F8F 0%,#003468 100%); color:#fff; display:flex; flex-direction:column; font-family:'Segoe UI',system-ui,-apple-system,sans-serif; transition:width .16s ease; }"
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
          + "@media (min-width:1000px){ body.pnav-on .ml-back[data-role='home']{ display:none !important; } }";
        var st = document.createElement("style");
        st.id = "pnav-style";
        st.textContent = css;
        (document.head || document.documentElement).appendChild(st);
      }
    } catch (e) { console.error("[portal-nav]", e); }
  })();
})();
