// auth.js — Mostlane session guard (PWA-safe)
(function () {

  // ⛔️ ABSOLUTE BLOCK: never run auth on login or onboard
  const path = window.location.pathname.toLowerCase();
  if (
    path.endsWith("/login.html") ||
    path.endsWith("/onboard.html")
  ) {
    return;
  }

  const now = Date.now();
  const loggedIn = localStorage.getItem("mostlaneLoggedIn");
  const expiry = parseInt(localStorage.getItem("mostlaneExpiry") || "0", 10);

  // ✅ Valid persistent session
  if (loggedIn === "true" && expiry && now < expiry) {

    // Rehydrate sessionStorage if missing (PWA restart)
    if (!sessionStorage.getItem("mostlaneLoggedIn")) {
      sessionStorage.setItem("mostlaneLoggedIn", "true");
      sessionStorage.setItem(
        "mostlaneUser",
        localStorage.getItem("mostlaneUser") || ""
      );
    }

    return; // ✅ allow page to load
  }

  // ❌ Invalid / expired session → clean redirect
  const deviceId = localStorage.getItem("mlDeviceId");

  localStorage.removeItem("mostlaneLoggedIn");
  localStorage.removeItem("mostlaneUser");
  localStorage.removeItem("mostlaneExpiry");

  sessionStorage.clear();

  if (deviceId) {
    localStorage.setItem("mlDeviceId", deviceId);
  }

  window.location.replace("login.html");
})();
