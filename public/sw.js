// Service worker for CodeVia PWA — app shell cache + offline fallback for navigation.
// v3: the OAuth handshake (/auth/…) is never answered by this worker — see the
// fetch handler below for why that used to swallow the GitHub redirect.
const CACHE = "codevia-shell-v3";
const SHELL = [
  "/",
  "/index.html",
  "/app.css",
  "/app.js",
  "/manifest.json",
  "/icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // NEVER answer the OAuth handshake with respondWith(fetch(req)).
  // /auth/github/login 302-redirects to github.com and /auth/github/callback
  // 302s back; a service worker that answers a *navigation* by following that
  // redirect chain returns a cross-origin-redirected response, which the
  // browser rejects as a network error. The page then silently stays where it
  // is — exactly the "Redirecting to GitHub in 0s…" that never leaves the app.
  // Returning WITHOUT respondWith() hands the request back to the browser, so
  // the login/consent/callback navigations run natively, cookies included.
  if (url.pathname.startsWith("/auth/")) return;

  // Network-first for navigation (so users always get fresh HTML when online)
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match("/index.html")))
    );
    return;
  }

  // Cache-first for static assets
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res.ok && (req.destination === "script" || req.destination === "style" || req.destination === "image" || req.destination === "font")) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
    })
  );
});
