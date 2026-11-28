// The service worker that makes the site an installable app and lets it open
// without a connection. Pages, scripts, styles and data are fetched from the
// network first (so they're always current when online) and the last copy is
// kept for when there's no connection. The owner's live API and the board's
// posts (another site) are never kept.
const CACHE = 'potdrop-v1';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'dialogs.js', 'pwa.js',
  'suppliers.html', 'suppliers.js', 'graveyard.html', 'graveyard.js', 'board.html', 'board.js',
  'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png',
];

self.addEventListener('install', (event) => {
  // A missing file only means it's kept later, when first fetched.
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  // Other sites (photos, logos, the chart library) and anything that isn't a plain read go straight through.
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;
  event.respondWith(fetch(request)
    .then((response) => {
      if (response.ok) {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)));
      }
      return response;
    })
    .catch(async () => (await caches.match(request, { ignoreSearch: true }))
      ?? (request.mode === 'navigate' ? caches.match('./') : Response.error())));
});
