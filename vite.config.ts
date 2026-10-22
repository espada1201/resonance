/// <reference types="vitest/config" />
import { createHash } from 'node:crypto';
import { defineConfig, type Plugin } from 'vite';

/** Emits a service worker that precaches the whole build, so the app opens with no network. */
function offline(): Plugin {
  return {
    name: 'resonance-offline',
    apply: 'build',
    enforce: 'post',
    generateBundle(_opts, bundle) {
      const files = [...Object.keys(bundle), 'manifest.webmanifest', 'icon.svg'].filter((f) => !f.endsWith('.map')).sort();
      const version = createHash('sha256').update(files.join()).digest('hex').slice(0, 12);
      const source = `const CACHE = 'resonance-${version}';
const FILES = ${JSON.stringify(['./', ...files])};
// cache: 'reload' skips the browser's HTTP cache: a page it still held from before a deploy would point at assets the deploy removed.
// No skipWaiting: a page opened before a deploy fetches its decoder only when Start is pressed, and only its own version's cache
// still holds it. A new version waits until every page of the app has closed.
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))));
// clients.claim puts the first visit under this worker without a reload, so it can already lose the network.
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  // ignoreVary: preview servers send Vary: Origin, and module scripts are fetched with an Origin header the precache never had.
  e.respondWith(caches.match(e.request, { ignoreSearch: true, ignoreVary: true }).then((r) => r || fetch(e.request)));
});
`;
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [offline()],
  build: {
    target: 'es2022',
    rollupOptions: { input: { main: 'index.html', beacon: 'beacon.html' } },
  },
  worker: { format: 'es' },
  // Channel simulations are CPU-heavy; shared CI runners need headroom.
  test: { include: ['src/**/*.test.ts'], testTimeout: 60_000 },
});
