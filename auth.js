// auth.js - Mostlane session guard (12h expiry)
(function(){
  const EXPIRY_HOURS = 12;
  const now = Date.now();

  // ✅ Restore the sessionStorage mirrors from localStorage FIRST. iOS wipes
  // sessionStorage whenever it kills the PWA, and device-auth.js needs
  // mostlaneUsername from sessionStorage — without this restore, every
  // relaunch of the installed app bounced to the login screen.
  if (localStorage.getItem("mostlaneLoggedIn") === "true") {
    if (!sessionStorage.getItem("mostlaneLoggedIn")) sessionStorage.setItem("mostlaneLoggedIn", "true");
    if (!sessionStorage.getItem("mostlaneUser"))
      sessionStorage.setItem("mostlaneUser", localStorage.getItem("mostlaneUser") || "");
    if (!sessionStorage.getItem("mostlaneUsername"))
      sessionStorage.setItem("mostlaneUsername", localStorage.getItem("mostlaneUsername") || localStorage.getItem("mostlaneUser") || "");
  }

  // ✅ 90-DAY PWA LOGIN BYPASS
  const bypassUntil = Number(localStorage.getItem("mostlaneBypassUntil") || 0);
if (
  bypassUntil &&
  now < bypassUntil &&
  localStorage.getItem("mostlaneLoggedIn") === "true"
) {
  // Trust existing login during bypass window
  return;
}
  // Pages that should be allowed without a session
  const openPages = ["login.html", "onboard.html", "confirmation.html"];

  // If we're on login or onboarding, do nothing
  const path = window.location.pathname.toLowerCase();
  if (openPages.some(p => path.endsWith(p))) return;

  // Restore check: boot expired sessions
  const expiry = localStorage.getItem("mostlaneExpiry");

  // Check expiry or missing login
  if (!localStorage.getItem("mostlaneLoggedIn") || !expiry || now > parseInt(expiry)) {

    // 🔒 Preserve device ID
    const deviceId = localStorage.getItem("mlDeviceId");

    // Clear auth-related keys only
    localStorage.removeItem("mostlaneLoggedIn");
    localStorage.removeItem("mostlaneUser");
    localStorage.removeItem("mostlaneExpiry");

    sessionStorage.clear();

    // 🔁 Restore device ID
    if (deviceId) {
      localStorage.setItem("mlDeviceId", deviceId);
    }

    window.location.href = "login.html";
  }
})();
