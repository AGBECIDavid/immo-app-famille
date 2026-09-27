/* ============================================================
   ImmoFamille — sw.js (service worker)
   Stratégie « réseau d'abord » :
   - en ligne  → on sert TOUJOURS la dernière version du site ;
   - hors ligne → on sert la dernière version gardée en cache.
   Supabase (connexion, biens, photos) et les fonds de carte ne sont
   jamais interceptés : les données restent toujours à jour.
============================================================ */
const CACHE = 'immofamille-v1';

// L'essentiel pour ouvrir l'app sans réseau
const SHELL = [
  './', './index.html', './style.css', './icons.js', './app.js', './config.js',
  './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'
];

// Bibliothèques et polices chargées depuis des CDN (gardées pour le hors-ligne)
const CDN_HOSTS = ['unpkg.com', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).catch(() => { /* hors ligne à l'installation */ }));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && !CDN_HOSTS.includes(url.hostname)) return;   // Supabase, cartes… : le navigateur s'en charge

  event.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok || res.type === 'opaque') {
          const copy = res.clone();
          caches.open(CACHE).then(cache => cache.put(req, copy));
        }
        return res;
      })
      .catch(async () => {
        // Hors ligne : les fichiers du site portent un ?v=… ; on accepte la version en cache
        const cached = await caches.match(req, { ignoreSearch: sameOrigin });
        if (cached) return cached;
        if (req.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      })
  );
});
