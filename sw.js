
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open('mostlane-cache').then(function(cache) {
      return cache.addAll([
        '/',
        '/index.html',
        '/checkin.html',
        '/checkout.html',
        '/confirm.html',
        '/confirmation.html',
        '/style.css',
        '/main.html',
        '/timesheet.html',
        '/purchase.html',
        '/weekly.html',
        '/login.html',
        '/onboard.html'
      ]);
    })
  );
});

self.addEventListener('fetch', function(event) {
  event.respondWith(
    caches.match(event.request).then(function(response) {
      return response || fetch(event.request);
    })
  );
});
