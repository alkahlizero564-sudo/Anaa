// يخزّن واجهة التطبيق لتفتح بسرعة حتى مع اتصال ضعيف. طلبات /api لا تُخزَّن أبدًا.
const CACHE = 'anaa-v2';
const SHELL = ['/', '/index.html', '/style.css', '/app.js', '/icon.svg', '/google.svg', '/manifest.webmanifest',
  '/vendor/leaflet/leaflet.js', '/vendor/leaflet/leaflet.css'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // الشبكة أولًا ثم النسخة المخزنة
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/index.html'))),
  );
});
