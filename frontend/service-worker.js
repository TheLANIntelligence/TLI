// TLI Service Worker — RECOVERY MODE
// This version unregisters itself and clears all caches so the browser
// fetches everything fresh from the server. Re-enable normal SW after recovery.

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.registration.unregister())
  );
  self.clients.claim();
});

// Pass all requests straight to network — no caching
self.addEventListener("fetch", () => {});
