// auth.js — PWA-safe session guard + legacy fallback
(function () {
  const LOGIN_PAGE = "login.html";
  const WORKER_BASE = "https://login.jamie-def.workers.dev";

  function isLoginPage() {
    return /\/login\.html$/i.test(location.pathname) || location.pathname.endsWith("/login.html");
  }

  function hardRedirectToLogin() {
    // kill state
    try {
      sessionStorage.clear();
      localStorage.removeItem("mostlaneLoggedIn");
      localStorage.removeItem("mostlaneUser");
      localStorage.removeItem("mostlanePermissions");
      localStorage.removeItem("mostlaneExpiry");
      localStorage.removeItem("mostlaneSessionId");
    } catch {}
    location.replace(LOGIN_PAGE);
  }

  function getDeviceIdSafe() {
    return (
      localStorage.getItem("mostlaneDeviceId") ||
      localStorage.getItem("deviceId") ||
      localStorage.getItem("mlDeviceId") ||
      ""
    );
  }

  function getSessionId() {
    return localStorage.getItem("mostlaneSessionId") || "";
  }

  function legacyLooksLoggedIn() {
    const loggedIn = localStorage.getItem("mostlaneLoggedIn") === "true";
    const expiryRaw = localStorage.getItem("mostlaneExpiry");
    const expiry = expiryRaw ? Number(expiryRaw) : 0;
    return loggedIn && expiry && Date.now() < expiry;
  }

  async function sessionCheckAndHydrate() {
    const sid = getSessionId();
    if (!sid) return false;

    const did = getDeviceIdSafe();

    const res = await fetch(`${WORKER_BASE}/auth/session-check`, {
      method: "GET",
      headers: {
        "X-Session-Id": sid,
        "X-Device-Id": did
      }
    });

    if (!res.ok) return false;

    const data = await res.json().catch(() => null);
    if (!data || !data.ok || !data.user) return false;

    // Hydrate storage so the rest of your portal keeps working unchanged
    const user = data.user;

    localStorage.setItem("mostlaneLoggedIn", "true");
    localStorage.setItem("mostlaneUser", user.Username);
    if (data.expiresAt) localStorage.setItem("mostlaneExpiry", String(data.expiresAt));

    sessionStorage.setItem("mostlaneLoggedIn", "true");
    sessionStorage.setItem("mostlaneUser", user.Username);

    // permissions object (keep same shape you use elsewhere)
    const perms = {
      FullAccess: user.FullAccess,
      Users: user.Users,
      DeviceAdmin: user.DeviceAdmin,

      CheckInOut: user.CheckInOut,
      Vehicles: user.Vehicles,
      Holiday: user.Holiday,
      EngineersHoursMenu: user.EngineersHoursMenu,
      HoursDashboard: user.HoursDashboard,
      PurchaseOrders: user.PurchaseOrders,
      Sites: user.Sites,
      Assets: user.Assets,
      MyDocuments: user.MyDocuments,
      Weekly: user.Weekly,
      Forms: user.Forms,
      Compliance: user.Compliance
    };

    localStorage.setItem("mostlanePermissions", JSON.stringify(perms));
    sessionStorage.setItem("mostlanePermissions", JSON.stringify(perms));

    return true;
  }

  async function guard() {
    // Don't guard the login page
    if (isLoginPage()) return;

    // 1) Prefer server session (PWA-safe)
    try {
      const ok = await sessionCheckAndHydrate();
      if (ok) return;
    } catch {}

    // 2) Fallback to legacy localStorage auth
    if (legacyLooksLoggedIn()) {
      // ensure sessionStorage mirror exists (helps old pages that read session only)
      const u = localStorage.getItem("mostlaneUser") || "";
      if (u) sessionStorage.setItem("mostlaneUser", u);
      const p = localStorage.getItem("mostlanePermissions") || "";
      if (p) sessionStorage.setItem("mostlanePermissions", p);
      return;
    }

    // 3) No valid auth
    hardRedirectToLogin();
  }

  // Run immediately
  guard();
})();
