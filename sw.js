// 万事通 service worker: keeps the app shell available offline. AI requests always go straight to the network.
const VERSION = 'wst-1.0.2';
const CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './app.css',
  './main.js',
  './util.js',
  './store.js',
  './models.js',
  './api.js',
  './files.js',
  './agent.js',
  './render.js',
  './voice.js',
  './marked.esm.js',
  './purify.es.mjs',
  './brand-serif.woff2',
  './icon-192.png',
  './apple-touch-icon.png',
  './favicon-64.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((c) => c.addAll(CORE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(networkFirst(event));
});

// Fresh copy when online (so updates arrive on the next launch); cached copy when offline or slow.
async function networkFirst(event) {
  const req = event.request;
  const cache = await caches.open(VERSION);
  const net = fetch(req).then((res) => {
    if (res && res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(() => {});
    return res;
  });
  const cached = cache.match(req, { ignoreSearch: req.mode === 'navigate' });
  try {
    const winner = await Promise.race([net, new Promise((r) => setTimeout(r, 3500, 'slow'))]);
    if (winner !== 'slow') return winner;
    const c = await cached;
    if (c) {
      event.waitUntil(net.catch(() => {}));
      return c;
    }
    return await net;
  } catch {
    const c = await cached;
    if (c) return c;
    if (req.mode === 'navigate') {
      const shell = (await cache.match('./index.html')) || (await cache.match('./'));
      if (shell) return shell;
    }
    return new Response('离线中，请连上网络再试。', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}
