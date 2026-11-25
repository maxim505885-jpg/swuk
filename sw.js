const CACHE = 'sonora-studio-v72';
const SHELL = ['/', '/index.html', '/styles.css?v=24', '/theme.css?v=3', '/app.js?v=61', '/theme-core.mjs', '/arrangement-core.mjs?v=5', '/sequencer-audio.mjs?v=3', '/project-io.mjs?v=2', '/audio-meter.mjs?v=1', '/waveform-core.mjs?v=1', '/midi-edit-core.mjs?v=1', '/clip-fade-core.mjs?v=1', '/eq-core.mjs?v=2', '/dsp-worker.js?v=2', '/dsp-core.mjs', '/record-worklet.js', '/manifest.webmanifest', '/icon.svg'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
    if (response.ok && new URL(event.request.url).origin === location.origin) caches.open(CACHE).then(cache => cache.put(event.request, response.clone()));
    return response;
  })));
});
