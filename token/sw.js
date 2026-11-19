/* TokenLive patient page: only here so the page can show a "your turn is near" notification.
   It caches nothing and makes no requests of its own. */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) if ('focus' in list[i]) return list[i].focus();
    if (self.clients.openWindow) return self.clients.openWindow((e.notification.data && e.notification.data.url) || './');
  }));
});
