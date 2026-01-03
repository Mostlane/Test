self.addEventListener("push", event => {
  const data = event.data ? event.data.json() : {};

  event.waitUntil(
    self.registration.showNotification(
      data.title || "Mostlane Portal",
      {
        body: data.body || "Test notification",
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
        data: data.url || "/main.html"
      }
    )
  );
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data)
  );
});
