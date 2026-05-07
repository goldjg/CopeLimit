/**
 * CopeLimit Service Worker — App Shell Cache Strategy
 *
 * @description
 * Implements a cache-first strategy for the PWA app shell (HTML, JS, CSS,
 * icons) with a network-first strategy for navigation requests. API calls and
 * Scriptable scripts bypass the cache entirely so they are always fresh.
 *
 * Cache versioning: Update {@link CACHE_NAME} whenever the app shell changes
 * to force old caches to be purged during the `activate` event.
 *
 * ## Request routing
 * - Cross-origin requests: pass-through (not cached).
 * - `/api/*` requests: pass-through (never cached).
 * - `/scriptable/*` requests: pass-through (never cached — scripts must be fresh).
 * - Navigation requests: network-first; falls back to cached `/index.html`,
 *   then `/offline.html`, then an inline 503 response.
 * - All other same-origin GET requests: cache-first; caches the response on
 *   first miss for future offline use.
 *
 * @version 2026-05-06
 */
const CACHE_NAME = 'copelimit-2026-05-06';
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon-32.png',
  '/icons/icon-180.png',
  '/icons/icon-192.png',
  '/offline.html'
];

async function shellResources() {
  try {
    const response = await fetch('/index.html');
    const html = await response.text();
    const assets = [...html.matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/g)].map((match) => match[1]);
    return [...new Set([...APP_SHELL, ...assets])];
  } catch {
    return APP_SHELL;
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    shellResources().then((resources) =>
      caches.open(CACHE_NAME).then((cache) => cache.addAll(resources))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/scriptable/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => {
        const cached = await caches.match('/index.html');
        if (cached) return cached;
        const offlinePage = await caches.match('/offline.html');
        if (offlinePage) return offlinePage;
        return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
      })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (!response || !response.ok) {
          return response;
        }
        const responseToCache = response.clone();
        caches.open(CACHE_NAME)
          .then((cache) => cache.put(request, responseToCache))
          .catch(() => undefined);
        return response;
      }).catch(() => new Response(null, { status: 503, statusText: 'Service Unavailable' }));
    })
  );
});
