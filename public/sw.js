// Service worker for Rebuild & Ruin PWA
// Only caches in production — dev server (localhost:5173) is excluded at registration time

const CACHE_NAME = "rr-v1";

self.addEventListener("install", (e) => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  // Clean old caches
  e.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Don't cache WebSocket, API calls, or non-GET requests
  if (e.request.method !== "GET") return;
  if (url.pathname.startsWith("/ws")) return;
  if (url.pathname.startsWith("/api")) return;

  e.respondWith(
    caches.match(e.request).then((cached) => {
      // Network first, cache fallback (stale-while-revalidate)
      const fetchPromise = fetch(e.request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
        }
        return response;
      }).catch(() => cached);

      return cached || fetchPromise;
    })
  );
});
