/* TU BBM Study Hub — offline service worker.
 *
 * Strategy
 *  - The app shell (the page itself): stale-while-revalidate. It loads instantly
 *    from the phone's cache (so the app opens with no internet), and every time
 *    you ARE online a fresh copy is fetched in the background and stored for the
 *    next launch. If the fresh copy is newer, the open tab is told so it can show
 *    a "reload for the new version" chip.
 *  - pdf.js (loaded from a CDN): cache-first, precached best-effort so the in-app
 *    PDF reader also works with no internet. Your uploaded PDFs are already stored
 *    on the phone (IndexedDB) — only this library was still coming from the web.
 *  - Everything else cross-origin (YouTube, video thumbnails): straight to the
 *    network, and simply fails when offline (video needs internet anyway).
 *
 * Bump SW_REV only when THIS file's logic changes — it forces every browser to
 * install the new worker. Content updates do NOT need a bump; they flow through
 * the stale-while-revalidate path above.
 */
const SW_REV = '2026-09-03.1';
const SHELL_CACHE = 'studyhub-shell-v1';
const PDF_CACHE   = 'studyhub-pdfjs-v1';
const SHELL_KEY   = './';                       // canonical cache key for the app page

const PDFJS = [
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js'
];
const SHELL_ASSETS = [
  SHELL_KEY,
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    await shell.addAll(SHELL_ASSETS);                 // same-origin, must succeed
    const pdf = await caches.open(PDF_CACHE);
    await Promise.allSettled(PDFJS.map((u) => pdf.add(u)));  // best-effort, non-fatal
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = [SHELL_CACHE, PDF_CACHE];
    for (const name of await caches.keys()) {
      if (!keep.includes(name)) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

async function notifyClients(msg) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  clients.forEach((c) => c.postMessage(msg));
}

function tag(resp) {
  if (!resp) return null;
  return resp.headers.get('etag') || resp.headers.get('last-modified') || null;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(SHELL_KEY);

  const network = fetch(new Request(request.url, { cache: 'no-cache' }))
    .then(async (resp) => {
      if (resp && resp.ok) {
        const before = tag(cached);
        await cache.put(SHELL_KEY, resp.clone());
        const after = tag(resp);
        if (cached && before && after && before !== after) {
          await notifyClients('sw-update-ready');
        }
      }
      return resp;
    })
    .catch(() => null);

  return cached
      || (await network)
      || new Response(
           'The Study Hub is not cached on this device yet. Open it once with an internet connection.',
           { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
         );
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  try {
    const resp = await fetch(request);
    if (resp && resp.ok) cache.put(request, resp.clone());
    return resp;
  } catch (e) {
    return hit || new Response('', { status: 504 });
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // The app itself.
  if (req.mode === 'navigate') {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }
  // pdf.js from the CDN.
  if (PDFJS.includes(url.href.split('?')[0])) {
    event.respondWith(cacheFirst(req, PDF_CACHE));
    return;
  }
  // Our own static files (icons, manifest, the worker).
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(req, SHELL_CACHE));
    return;
  }
  // Anything else cross-origin (YouTube etc.) — leave it to the network.
});

self.addEventListener('message', (event) => {
  if (event.data === 'sw-skip-waiting') self.skipWaiting();
});
