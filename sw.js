// Edge Tracker service worker — makes the app installable + offline-capable.
// Network-first for the app shell (so updates land), cache fallback offline.
// Cross-origin requests (the backend API, Google Fonts) and non-GET (POST/DELETE
// research writes) are left untouched and always go to the network.
const CACHE = 'edge-tracker-v1';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;                  // research writes etc. → network
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;         // backend API + fonts → network
  e.respondWith(
    fetch(e.request)
      .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html')))
  );
});
