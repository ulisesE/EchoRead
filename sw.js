const VERSION = '3.0.0';
const CACHE_NAME = `echoread-cache-v${VERSION}`;

// Only local assets to guarantee offline load without depending on external CDNs at installation time
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './icon.svg',
  './manifest.json'
];

// Install Service Worker
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('Service Worker: Caching local assets');
        return cache.addAll(ASSETS_TO_CACHE);
      })
      .then(() => self.skipWaiting())
  );
});

// Activate Service Worker - Cleans up orphan caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((cacheName) => cacheName !== CACHE_NAME)
            .map((cacheName) => {
              console.log('Service Worker: Clearing Old Cache', cacheName);
              return caches.delete(cacheName);
            })
        );
      })
      .then(() => self.clients.claim())
  );
});

// Fetch event router
self.addEventListener('fetch', (event) => {
  // Only handle GET requests
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Only handle http/https protocols (ignore chrome-extension, etc.)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  const destination = event.request.destination;

  // 1. HTML / Document -> Network First
  if (destination === 'document' || url.pathname === '/' || url.pathname.endsWith('.html')) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.status === 200) {
            const responseToCache = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseToCache));
          }
          return response;
        })
        .catch(() => {
          return caches.match('./index.html') || caches.match(event.request);
        })
    );
    return;
  }

  // 2. CSS / Styles, JS / Scripts
  // Local app assets are Network First so fixes are visible immediately.
  // CDNs use Stale-While-Revalidate for resilience.
  const isCdnAsset = url.hostname.includes('cdnjs.cloudflare.com') || 
                     url.hostname.includes('cdn.jsdelivr.net') || 
                     url.hostname.includes('unpkg.com');

  if ((destination === 'script' || destination === 'style') && !isCdnAsset) {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse.status === 200) {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseToCache));
          }
          return networkResponse;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  if (isCdnAsset) {
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        const fetchPromise = fetch(event.request)
          .then((networkResponse) => {
            if (networkResponse.status === 200) {
              const responseToCache = networkResponse.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseToCache));
            }
            return networkResponse;
          })
          .catch(() => cachedResponse);

        return cachedResponse || fetchPromise;
      })
    );
    return;
  }

  // 3. Images, Fonts & Audios (woff2, svg, png, mp3, epub, etc.) -> Cache First
  if (destination === 'image' || destination === 'font' || destination === 'audio' || url.pathname.endsWith('.epub') || url.hostname.includes('fonts.gstatic.com')) {
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(event.request)
          .then((networkResponse) => {
            if (networkResponse.status === 200) {
              const responseToCache = networkResponse.clone();
              event.waitUntil(
                caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseToCache))
              );
            }
            return networkResponse;
          })
          .catch((err) => {
            console.warn('Network request failed and not in cache:', event.request.url, err);
            return new Response('Recurso no disponible offline', { status: 503, statusText: 'Service Unavailable' });
          });
      })
    );
    return;
  }
  
  // 4. Default strategy: Network First with cache fallback
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (networkResponse.status === 200) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseToCache));
        }
        return networkResponse;
      })
      .catch(() => caches.match(event.request))
  );
});
