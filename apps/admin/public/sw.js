/* Floor admin shell — cache static assets only; never cache live inventory/API data. */
const SHELL = 'floor-shell-v12';
const SHELL_URLS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  // Do not skipWaiting here — the page activates the new worker only when Receive
  // is idle, so inventoring isn't interrupted by a reload mid-scan/photo.
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll(SHELL_URLS)).catch(() => undefined),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') void self.skipWaiting();
});

function isLiveData(url) {
  try {
    const u = new URL(url);
    if (u.pathname.startsWith('/api/')) return true;
    if (u.hostname.includes('supabase')) return true;
    if (u.pathname.includes('/rest/v1') || u.pathname.includes('/auth/v1') || u.pathname.includes('/storage/v1')) return true;
    if (u.pathname.includes('/.netlify/functions/')) return true;
  } catch { /* ignore */ }
  return false;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (isLiveData(request.url)) return;

  let url;
  try { url = new URL(request.url); } catch { return; }
  if (url.origin !== self.location.origin) return;

  // Navigations and hashed bundles: network-first so deploys aren't stuck on stale shell.
  const asset = url.pathname.startsWith('/assets/')
    || url.pathname.endsWith('.js')
    || url.pathname.endsWith('.css')
    || url.pathname.endsWith('.webmanifest');
  if (request.mode === 'navigate' || asset) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            const key = request.mode === 'navigate' ? '/index.html' : request;
            void caches.open(SHELL).then((c) => c.put(key, copy)).catch(() => undefined);
          }
          return res;
        })
        .catch(async () => {
          if (request.mode === 'navigate') {
            return (await caches.match('/index.html')) || (await caches.match('/')) || Response.error();
          }
          return (await caches.match(request)) || Response.error();
        }),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res && res.ok && (url.pathname.startsWith('/icons/') || url.pathname.endsWith('.png') || url.pathname.endsWith('.webp'))) {
            const copy = res.clone();
            void caches.open(SHELL).then((c) => c.put(request, copy)).catch(() => undefined);
          }
          return res;
        })
        .catch(() => cached || Response.error());
      return cached || network;
    }),
  );
});
