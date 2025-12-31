// auth.js — iOS-safe PWA auth (12h expiry, localStorage only)
(function () {
  const EXPIRY_HOURS = 12;
  const now = Date.now();

  const openPages = ["login.html", "onboard.html"];
  const path = window.location.pathname.toLowerCase();
  if (openPages.some(p => path.endsWith(p))) return;

  const loggedIn = localStorage.getItem("mostlaneLoggedIn") === "true";
  const expiry = parseInt(localStorage.getItem("mostlaneExpiry") || "0", 10);

  // ❌ Not logged in or expired
  if (!loggedIn || !expiry || now > expiry) {
    const deviceId = localStorage.getItem("mlDeviceId");

    // Clear auth only
    localStorage.removeItem("mostlaneLoggedIn");
    localStorage.removeItem("mostlaneUser");
    localStorage.removeItem("mostlaneExpiry");

    if (deviceId) {
      localStorage.setItem("mlDeviceId", deviceId);
    }

    window.location.replace("login.html");
    return;
  }

  // ✅ Logged in and valid — allow page
})();
