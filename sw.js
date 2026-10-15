// Offline support: app shell cache-first, refreshed in the background.
const VERSION = 'spoolbook-v1.0.1';
const SHELL = [
  './', './index.html', './privacy.html', './manifest.webmanifest', './css/styles.css',
  './js/app.js', './js/calc.js', './js/gcode.js', './js/storage.js', './js/pro.js', './js/config.js',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './fonts/archivo-latin-wdth-normal.woff2',
];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
    const network = fetch(req).then((res) => { if (res && res.ok && res.type === 'basic') cache.put(req, res.clone()); return res; }).catch(() => null);
    if (cached) { event.waitUntil(network); return cached; }
    const res = await network;
    if (res) return res;
    if (req.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
    return Response.error();
  })());
});
