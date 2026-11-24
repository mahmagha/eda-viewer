// Service worker for the static copy of the EDA viewer (copied to app/sw.js by eda_static.py).
// It keeps the exported data files (../data/...) on the device, so a second visit doesn't download the
// 3 MB product table again. Each export writes a new VERSION, which gives a fresh cache and deletes the old
// one, so visitors never mix data from two exports. Pages and scripts are always fetched from the network.
const VERSION = "20261124022413";
const CACHE = "eda-data-" + VERSION;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys())
      if (name.startsWith("eda-data-") && name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin || !/\/data\//.test(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  })());
});
