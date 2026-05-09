/* ════════════════════════════════════════════════════════════════
   ÓMBRE · sw.js — Service Worker
   Network-first strategy. Bumps version to invalidate cache.
   ════════════════════════════════════════════════════════════════ */

'use strict';

const CACHE_VERSION = 'ombre-v2';
const ASSETS = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './manifest.json'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_VERSION).then(cache => cache.addAll(ASSETS))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    if (new URL(req.url).origin !== self.location.origin) return;

    event.respondWith(
        fetch(req).then(resp => {
            if (resp && resp.status === 200) {
                const clone = resp.clone();
                caches.open(CACHE_VERSION).then(c => c.put(req, clone));
            }
            return resp;
        }).catch(() =>
            caches.match(req).then(cached => cached || caches.match('./index.html'))
        )
    );
});
