const CACHE_NAME = 'SR-Light-web-v29';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.url.startsWith('chrome-extension') || e.request.url.includes('chrome')) {
    return;
  }

  e.respondWith(
    fetch(e.request).then((response) => {
      if (response && response.status === 200) {
        const responseCopy = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(e.request, responseCopy);
        });
      }
      return response;
    }).catch(() => {
      return caches.match(e.request);
    })
  );
});
