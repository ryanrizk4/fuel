/* Service worker: cache-first for the app shell, network-first for data files. */
importScripts("js/release.js");
const VERSION = globalThis.FUEL_RELEASE.version;
const SHELL = [
  "./",
  "index.html",
  "css/styles.css",
  "js/app.js",
  "js/engine.js",
  "js/persistence.js",
  "js/release.js",
  "js/reloadGuard.js",
  "data/products.json",
  "data/templates.json",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("fuel-") && k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;

  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(e.request);
    // Keep the shell coherent for this release. Background replacement could mix
    // new modules with old ones before the next worker finishes installing.
    if (cached && !url.pathname.includes("/data/")) return cached;
    try {
      const res = await fetch(e.request, { cache: "no-cache" });
      if (!res.ok) return cached || res; // Never cache a server error over good data.
      e.waitUntil(cache.put(e.request, res.clone()).catch(() => {}));
      return res;
    } catch {
      return cached || new Response("Fuel is offline. Reconnect to load this resource.", { status: 503 });
    }
  })());
});
