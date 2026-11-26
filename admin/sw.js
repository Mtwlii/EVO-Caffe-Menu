// Keeps the admin shell available when the internet drops (cache of the app files only; data is cached by the page).
var V = 'evo-admin-shell-v1';
self.addEventListener('install', function (e) { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function (e) {
  var r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin || u.pathname.indexOf('/api/') === 0) return;
  e.respondWith(fetch(r).then(function (res) { var c = res.clone(); caches.open(V).then(function (ch) { ch.put(r, c); }); return res; })
    .catch(function () { return caches.match(r, { ignoreSearch: true }).then(function (m) { return m || caches.match('./'); }); }));
});
