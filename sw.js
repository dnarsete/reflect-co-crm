/* Reflect Co CRM service worker — shell cache only.
   Strategy: network-first for HTML/JS (so updates land immediately),
   cache-first for static assets (icons, fonts), pass-through for
   Supabase API calls (never cache live data).  */

const VERSION = 'reflect-crm-v5';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './config.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  /* never cache Supabase API / auth / storage */
  if (url.hostname.includes('supabase.co') || url.hostname.includes('supabase.in')) return;
  /* never cache external scripts/CDN */
  if (url.hostname !== self.location.hostname) return;
  /* only GET */
  if (e.request.method !== 'GET') return;

  /* network-first for HTML/JS (so deploys land immediately) */
  const isCode = /\.(html|js|css|json)$/.test(url.pathname) || url.pathname.endsWith('/');
  if (isCode) {
    e.respondWith(
      fetch(e.request).then(r => {
        const copy = r.clone();
        caches.open(VERSION).then(c => c.put(e.request, copy));
        return r;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  /* cache-first for everything else (images) */
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(r => {
      const copy = r.clone();
      caches.open(VERSION).then(c => c.put(e.request, copy));
      return r;
    }))
  );
});
