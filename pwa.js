// pwa.js — Service Worker + Android install prompt

let deferredPrompt = null;

// Register service worker (unchanged behaviour)
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js");
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
