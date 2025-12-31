// auth.js – Mostlane PWA session guard (12h expiry) – FINAL
(function () {
  const EXPIRY_HOURS = 12;
  const now = Date.now();

  // Pages allowed without auth
  const openPages = ["login.html", "onboard.html"];
  const path = window.location.pathname.toLowerCase();
  if (openPages.some(p => path.endsWith(p))) return;

  // ---- SOURCE OF TRUTH (localStorage ONLY) ----
  const loggedIn = localStorage.getItem("mostlaneLoggedIn") === "true";
  const expiryRaw = localStorage.getItem("mostlaneExpiry");
  const expiry = expiryRaw ? parseInt(expiryRaw, 10) : null;
  const user = localStorage.getItem("mostlaneUser");

  const sessionValid = loggedIn && expiry && now < expiry && user;

  // ---- REHYDRATE SESSION EVERY TIME (SAFE) ----
  if (sessionValid) {
    sessionStorage.setItem("mostlaneLoggedIn", "true");
    sessionStorage.setItem("mostlaneUser", user);
    return; // ✅ IMPORTANT: stop here, do NOT fall through
  }

  // ---- SESSION INVALID → FORCE LOGOUT ----
  const deviceId = localStorage.getItem("mlDeviceId");

  localStorage.removeItem("mostlaneLoggedIn");
  localStorage.removeItem("mostlaneUser");
  localStorage.removeItem("mostlaneExpiry");

  sessionStorage.clear();

  // Preserve device binding
  if (deviceId) {
    localStorage.setItem("mlDeviceId", deviceId);
  }

  window.location.href = "login.html";
})();
