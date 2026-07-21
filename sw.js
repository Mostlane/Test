// Mostlane Portal service worker — offline caching + Web Push.
// Single canonical SW (scope "/"). Registering this replaces any earlier SW at
// the same scope (the old push-only service-worker.js), so there's just one.

const CACHE_NAME = "mostlane-v11";

// Precache the shell so the app can at least boot on a dead/flaky connection.
const CORE_ASSETS = [
  "/",
  "/main.html",
  "/login.html",
  "/you.html",
  "/route.html",
  "/offline.html",
  "/Mostlane_Embossed.png",
  "/icons/icon-192.png",
  "/pwa.js"
];

self.addEventListener("install", (e) => {
  // Cache each asset INDEPENDENTLY (not addAll): addAll rejects the whole batch
  // if any one URL 404s, which would leave the cache EMPTY and the app with no
  // offline shell. Per-asset means one bad URL can't wipe the rest.
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.allSettled(CORE_ASSETS.map((u) => cache.add(u)))
    ).catch(() => {})
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

// Race a network fetch against a timeout so a weak signal can't hang the page.
function fetchWithTimeout(request, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    fetch(request).then(
      (res) => { clearTimeout(t); resolve(res); },
      (err) => { clearTimeout(t); reject(err); }
    );
  });
}
function cachePut(request, response) {
  if (response && response.ok) {
    const copy = response.clone();
    caches.open(CACHE_NAME).then((c) => c.put(request, copy)).catch(() => {});
  }
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Never touch the API / cross-origin workers — always straight to network.
  if (url.hostname.includes("workers.dev") || url.origin !== self.location.origin) return;

  // Page navigations: network-first with a short timeout, then cached copy,
  // then the offline page. Prevents the blank white screen on poor signal.
  //
  // CRITICAL for installed PWAs: a navigation must NEVER be answered with a
  // failed response (Response.error()) OR a redirected response — iOS reacts by
  // ejecting the standalone app into a blank Safari tab ("Search or enter
  // website name"). So we (a) rebuild any redirected network response into a
  // plain one, and (b) guarantee the fallback chain always returns real HTML.
  if (req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html")) {
    e.respondWith((async () => {
      try {
        const res = await fetchWithTimeout(req, 4000);
        // A redirected response can't be returned to a navigation — it fails
        // the load. Reconstruct it as a clean, non-redirected response.
        if (res && res.redirected) {
          const buf = await res.clone().arrayBuffer();
          const clean = new Response(buf, { status: res.status, statusText: res.statusText, headers: res.headers });
          cachePut(req, clean.clone());
          return clean;
        }
        cachePut(req, res);
        return res;
      } catch {
        return (await caches.match(req, { ignoreSearch: true }))
          || (await caches.match("/main.html"))
          || (await caches.match("/login.html"))
          || (await caches.match("/offline.html"))
          // Last resort: a tiny self-reloading page — anything but a blank tab.
          || new Response(
               "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>" +
               "<title>Reconnecting…</title><body style='margin:0;font:16px system-ui;display:flex;height:100vh;" +
               "align-items:center;justify-content:center;background:#e6e8eb;color:#123'>" +
               "<div style='text-align:center'><p>Reconnecting…</p>" +
               "<p><a href='/login.html' style='color:#0066cc'>Open Mostlane</a></p></div>" +
               "<script>setTimeout(function(){location.replace('/login.html')},1500)</script>",
               { headers: { "Content-Type": "text/html; charset=utf-8" } }
             );
      }
    })());
    return;
  }

  // Scripts & styles (portal-config.js, auth.js, …): stale-while-revalidate —
  // serve the cached copy instantly (works offline) and refresh in the
  // background. Their ?v=N bump changes the URL, so it never pins a real update.
  if (req.destination === "script" || req.destination === "style") {
    e.respondWith((async () => {
      const cached = await caches.match(req);
      const network = fetchWithTimeout(req, 4000).then((res) => { cachePut(req, res); return res; }).catch(() => null);
      return cached || (await network) || Response.error();
    })());
    return;
  }

  // Everything else (images, fonts…): cache-first, fall back to network.
  e.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => { cachePut(req, res); return res; }).catch(() => cached || Response.error()))
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
