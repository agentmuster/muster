// Muster service worker. It makes the app installable and shows a small offline page when the
// desktop cannot be reached. Pages, the API and the chat stream always go to the network: nothing private
// is cached, and Cloudflare Access sign-in redirects pass through untouched.
const CACHE = 'muster-shell-v1';
const SHELL = ['/offline.html', '/icons/icon-192.png'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then(cache => cache.addAll(SHELL))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(() => caches.match('/offline.html')));
});
