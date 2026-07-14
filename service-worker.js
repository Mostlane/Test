// Mostlane Portal service worker — offline caching + Web Push.
// Single canonical SW (scope "/"). Registering this replaces any earlier SW at
// the same scope (the old push-only service-worker.js), so there's just one.

const CACHE_NAME = "mostlane-v2";

const CORE_ASSETS = [
  "/",
  "/main.html",
  "/login.html",
  "/Mostlane_Embossed.png",
  "/pwa.js"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Never cache Cloudflare Workers / APIs
  if (url.hostname.includes("workers.dev")) return;

  // Network-first for HTML
  if (e.request.headers.get("accept")?.includes("text/html")) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Cache-first for assets
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request))
  );
});

// ── Web Push ────────────────────────────────────────────────────────────────
// Payload is JSON: { title, body, url, tag?, icon?, badge? }. On iOS the OS uses
// the installed Home-Screen (apple-touch) icon; on Android we set icon/badge.
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch { data = { body: event.data ? event.data.text() : "" }; }

  const title = data.title || "Mostlane Portal";
  const options = {
    body: data.body || "",
    icon: data.icon || "/icons/icon-192.png",
    badge: data.badge || "/icons/icon-192.png",
    data: { url: data.url || "/main.html" },
    tag: data.tag || undefined,
    renotify: data.tag ? true : undefined
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/main.html";
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      try {
        await c.focus();
        if ("navigate" in c && target) { try { await c.navigate(target); } catch {} }
        return;
      } catch {}
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});
