// SendOff service worker.
//
// The job: make the app open and show your race when the phone has no signal.
// A crew member at an aid station, or a solo runner with the phone in a vest
// pocket, should not be looking at a browser error page because a ridge got in
// the way.
//
// Shape of the caching:
//
//   pages      network first, cache fallback   always fresh online, still there offline
//   race data  network first, cache fallback   the live file wins; the last one seen is the backup
//   assets     cache first, revalidate after   instant, and ?v= bumps are new URLs so they miss and refetch
//   the API    never cached                    authenticated, and a stale answer would be a lie
//
// A service worker is sticky: once installed it keeps serving until replaced.
// So the fetch handler is written to fall through to the network on any
// unexpected condition rather than risk serving something wrong, and activate
// claims clients immediately so a fixed worker takes over on the next load
// rather than waiting for every tab to close.

const VERSION = 'v1';
const SHELL = `sendoff-shell-${VERSION}`;
const DATA = `sendoff-data-${VERSION}`;
const OURS = [SHELL, DATA];

// Stable URLs only. Anything carrying a ?v= is deliberately left to runtime
// caching: pinning a version here means this list has to be edited in lockstep
// with every cache-bust, and the day it is forgotten the worker serves last
// week's JavaScript.
const SHELL_URLS = [
  '/', '/index.html', '/race.html', '/pit.html', '/setup.html',
  '/charts.html', '/print-report.html', '/signup.html', '/reset.html', '/admin.html',
  '/manifest.webmanifest',
  '/brand/sendoffprimaryonDark.svg',
  '/brand/sendoff-favicon.svg',
  '/brand/icon-192.png',
];

// Marks a response as having come from storage rather than the network, so the
// page can say "showing saved data" instead of quietly presenting stale times
// as current ones.
function fromCache(res) {
  if (!res) return res;
  const headers = new Headers(res.headers);
  headers.set('X-SendOff-Cache', 'hit');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // Individually, so one 404 cannot fail the whole install and leave the
    // worker never activating.
    await Promise.all(SHELL_URLS.map(u => cache.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n.startsWith('sendoff-') && !OURS.includes(n))
                           .map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

// The page asks for this when it wants the new worker now rather than on the
// next navigation.
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

const isRaceData = (url) =>
  /^\/races\/[^/]+\/(config|data)\.json$/.test(url.pathname) ||
  /^\/races\/[^/]+\/course\.gpx$/.test(url.pathname) ||
  url.pathname === '/races/index.json' ||
  url.pathname === '/hub.json';

// Race JSON is fetched with a ?_=<now> buster, so every request is a distinct
// URL. Storing them as they arrive means a new entry per poll, and race.html
// polls every ten seconds: an afternoon of that is thousands of copies of the
// same file. Race data is therefore keyed on the path alone, so each file has
// exactly one entry that the next poll overwrites.
// Pages get the same treatment. race.html?id=A and race.html?id=B are the same
// file with the race chosen by script, so keying on the path stores one copy
// instead of one per race, and each visit refreshes the copy a later offline
// load will fall back to.
function cacheKey(request, url) {
  return (isRaceData(url) || request.mode === 'navigate')
    ? new Request(url.origin + url.pathname)
    : request;
}

// Out on a course the phone is rarely cleanly offline. It holds one bar, the
// request opens, and then nothing comes back. `fetch` will wait a long time for
// that, so every network-first path gets a deadline: past it, serve what we
// have and let the real request keep running to refresh the cache for next
// time. A five second old split beats a spinner.
const NET_TIMEOUT_MS = 4000;

// The cache write has to be handed to the event. A service worker is killed
// as soon as it looks idle, and a put that is merely in flight when that
// happens is lost: every response still serves correctly and nothing is ever
// stored, which looks like working software right up until the signal drops.
function withCacheUpdate(cacheName, request, event, key) {
  return fetch(request).then(async (res) => {
    if (res && res.ok) {
      const copy = res.clone();
      const write = caches.open(cacheName).then(c => c.put(key || request, copy)).catch(() => {});
      if (event) event.waitUntil(write);
    }
    return res;
  });
}

async function networkFirst(cacheName, request, timeoutMs, event, key) {
  const net = withCacheUpdate(cacheName, request, event, key);
  // Swallow a late rejection so it cannot surface as an unhandled rejection
  // after we have already answered from cache.
  net.catch(() => {});

  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs || NET_TIMEOUT_MS);
  });

  try {
    const first = await Promise.race([net, deadline]);
    if (first !== 'timeout') return first;
  } catch (e) {
    // Network refused outright; fall through to the cache.
  } finally {
    clearTimeout(timer);
  }

  const cache = await caches.open(cacheName);
  const hit = await cache.match(key || request, { ignoreSearch: !key });
  if (hit) return fromCache(hit);
  return net;  // nothing saved, so the caller gets the real outcome
}

async function cacheFirst(cacheName, request, event) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  const update = withCacheUpdate(cacheName, request, event).catch(() => null);
  if (hit) return hit;           // update keeps running, refreshing for next time
  const res = await update;
  if (res) return res;
  throw new Error('offline and not cached');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Anything that changes state is none of this worker's business, and a
  // cached answer to it would be a fabrication.
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // Never cache the worker script. A service worker replaces itself by
  // fetching this file, and a worker that could serve its own stale copy would
  // be able to keep a broken version alive indefinitely.
  if (url.pathname === '/sw.js') return;

  // Cross-origin: the auth proxy above all. Its answers are per-session and
  // must never be replayed from storage. Fonts are the one exception, and
  // they degrade to the fallback stack if this misses.
  if (url.origin !== self.location.origin) {
    if (url.host === 'fonts.googleapis.com' || url.host === 'fonts.gstatic.com') {
      event.respondWith(cacheFirst(SHELL, req, event).catch(() => fetch(req)));
    }
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await networkFirst(SHELL, req, NET_TIMEOUT_MS, event, cacheKey(req, url));
        if (res) return res;
        throw new Error('no response');
      } catch (e) {
        const cache = await caches.open(SHELL);
        const hit = await cache.match(req, { ignoreSearch: true })
                 || await cache.match('/index.html');
        if (hit) return fromCache(hit);
        return new Response(
          '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
          '<title>Offline</title><body style="margin:0;background:#0A0F14;color:#F0ECE3;font:16px system-ui;' +
          'display:grid;place-items:center;height:100vh;text-align:center;padding:24px">' +
          '<div><p style="font-size:20px;font-weight:600">No signal, and this page was never saved.</p>' +
          '<p style="color:#7A8D99">Open it once with a connection and it will be here next time.</p></div>',
          { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
    })());
    return;
  }

  if (isRaceData(url)) {
    event.respondWith(networkFirst(DATA, req, NET_TIMEOUT_MS, event, cacheKey(req, url)));
    return;
  }

  event.respondWith(cacheFirst(SHELL, req, event).catch(() => fetch(req)));
});
