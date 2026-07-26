// PWA service worker — 線上優先（network-first），離線先回緩存
// 升版本號 -> 自動清走舊緩存；新部署下次開 App 即生效，唔使人手清 cache
const CACHE = 'receipt-v3';
const FILES = ['index.html', 'style.css', 'app.js', 'ocr.js', 'manifest.webmanifest', 'icon.svg'];

self.addEventListener('install', e =>
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));

self.addEventListener('activate', e =>
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  ));

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return; // 寫入類唔緩存
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('index.html')))
  );
});
