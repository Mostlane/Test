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
})();
