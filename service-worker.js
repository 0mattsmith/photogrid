/*
 * PhotoGrid service worker — makes the app usable offline after first load.
 *
 *   Strategy:
 *     • App shell (HTML/CSS/JS/icon/manifest): stale-while-revalidate, so the
 *       app boots instantly from cache and updates in the background.
 *     • CDN libraries (heic2any / jsPDF / docx / file-saver): cache-first.
 *       These pin to specific versions so they never need to change.
 *     • Everything else: try network, fall back to cache.
 *
 * Bump CACHE_VERSION when shipping any asset change so old caches get pruned.
 */

const CACHE_VERSION = "v9";
const CACHE_NAME = `photogrid-${CACHE_VERSION}`;

const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./image-worker.js",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
];

const CDN_LIBS = [
  "https://cdn.jsdelivr.net/npm/libheif-js@1.19.8/libheif-wasm/libheif-bundle.js",
  "https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js",
  "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js",
  "https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.min.js",
  "https://cdn.jsdelivr.net/npm/file-saver@2.0.5/dist/FileSaver.min.js",
];

// ─── install ──────────────────────────────────────────────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // App shell must succeed
    await cache.addAll(APP_SHELL);
    // CDN libs are best-effort — if one fails (offline first install), keep going
    await Promise.all(CDN_LIBS.map(async (url) => {
      try {
        const res = await fetch(url, { mode: "cors" });
        if (res.ok) await cache.put(url, res);
      } catch (_) { /* will be cached lazily on first real fetch */ }
    }));
    self.skipWaiting();
  })());
});

// ─── activate ─────────────────────────────────────────────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// ─── fetch ────────────────────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const isAppShell = url.origin === self.location.origin;
  const isPinnedLib = CDN_LIBS.includes(req.url);

  if (isAppShell) {
    // Stale-while-revalidate
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req);
      const networkPromise = fetch(req).then(res => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => null);
      return cached || (await networkPromise) || new Response("Offline", { status: 503 });
    })());
    return;
  }

  if (isPinnedLib) {
    // Cache-first — pinned versions never change
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      } catch (e) {
        return new Response("Library unavailable offline", { status: 503 });
      }
    })());
    return;
  }

  // Anything else (e.g., dynamically loaded resources): network, fall back to cache
  event.respondWith(
    fetch(req).catch(() => caches.match(req))
  );
});

// Allow the page to trigger an immediate activation
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});
