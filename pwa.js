// pwa.js — Service Worker + Android install prompt

let deferredPrompt = null;

// Register service worker + AUTO-UPDATE. Installed PWAs (esp. iOS) otherwise keep
// serving an old service worker — and its cached pages — until a manual hard
// refresh, so freshly-deployed changes never appear. We now (a) actively check
// for a new SW on load and periodically, and (b) reload once when a new SW takes
// control, so a deploy lands on the device by itself.
if ("serviceWorker" in navigator) {
  // Only auto-reload when an EXISTING controlled page is taken over by a NEW SW
  // (the update case) — never on the first-ever install (avoids a reload loop).
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading || !hadController) return;
    reloading = true;
    location.reload();
  });
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").then((reg) => {
      reg.update();                                   // check for a new SW now
      setInterval(() => { reg.update(); }, 30 * 60 * 1000); // …and every 30 min
    }).catch(() => {});
  });
  // Re-check whenever the app is brought back to the foreground.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && navigator.serviceWorker.controller) {
      navigator.serviceWorker.getRegistration().then((reg) => { if (reg) reg.update(); }).catch(() => {});
    }
  });
}

// Android install prompt handling
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); // stop Chrome auto-handling
  deferredPrompt = e;

  // Auto-show prompt after short delay (Android only)
  setTimeout(() => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      deferredPrompt.userChoice.finally(() => {
        deferredPrompt = null;
      });
    }
  }, 1500);
});
