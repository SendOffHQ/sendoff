// The demo race at /try: the real racer screen, pit board and race page,
// running a race that lives only in this browser.
//
// Loaded before race-core.js on those pages. It does nothing at all unless
// the page was opened for the demo race (?id=try-sendoff). When it was, it
// stands in for the worker:
//
// - fetch() to the demo's made-up API address is answered here, from a copy
//   of the race kept in localStorage. Reads, saves (with the same version
//   check the worker does, so the pages' own retry-on-conflict runs) and the
//   handful of account calls the pages make on the way.
// - The live push is a BroadcastChannel standing in for the worker's
//   websocket, so a press on the racer's phone shows on the crew's board and
//   the race page at once, the way it does on race day.
// - Everything the pages store is kept under its own prefix, so the demo's
//   pretend sign-in never replaces a real one, and nothing a real race has
//   queued on this phone is touched.
//
// Nothing is sent anywhere: no request reaches SendOff's worker from a demo
// page. The map tiles are the one thing fetched from outside, as on any race.
//
// try.html loads this too, without the id, for SendOffDemo.ensureSeeded()
// and reset(): it seeds the race before the phones open, and Reset wipes it.
(function () {
  'use strict';

  var SLUG = 'try-sendoff';
  var API = 'https://try.sendoff.invalid';
  var WS = 'wss://try.sendoff.invalid';
  var NS = 'sendoff-try:';
  var STORE = NS + 'store';
  var CHANNEL = 'sendoff-try';
  // A demo left open, or come back to the next day, starts over: the times in
  // it are relative to when it was opened, and a racer forty hours into leg 3
  // is not much of a demo.
  var STALE_MS = 6 * 3600e3;
  // Bumped with demo/seed.json's own "version" when the race changes shape (a
  // renamed racer has a new id, and a page asking for her by it would find
  // nobody in a copy saved before): a browser holding an older copy starts over.
  var SEED_VERSION = 3;

  var ls = window.localStorage, ss = window.sessionStorage;
  var SP = Storage.prototype;
  var raw = { get: SP.getItem, set: SP.setItem, remove: SP.removeItem, key: SP.key, clear: SP.clear };
  var rget = function (k) { try { return raw.get.call(ls, k); } catch (e) { return null; } };
  var rset = function (k, v) { try { raw.set.call(ls, k, v); } catch (e) {} };

  var realFetch = window.fetch ? window.fetch.bind(window) : null;

  function readStore() {
    try { return JSON.parse(rget(STORE)) || null; } catch (e) { return null; }
  }
  function writeStore(s) { s.touchedAt = Date.now(); rset(STORE, JSON.stringify(s)); }

  // The race as a visitor first finds it: under way, a couple of aid stations
  // in, its times worked out from now.
  async function seed() {
    var res = await realFetch('/demo/seed.json', { cache: 'no-cache' });
    var s = await res.json();
    var now = Date.now();
    var at = function (min) { return new Date(now + min * 60e3).toISOString(); };
    var cfg = JSON.parse(JSON.stringify(s.config));
    cfg.startTime = at(s.startMinutes);
    var legs = s.legs.map(function (l) {
      var out = {};
      Object.keys(l).forEach(function (k) { if (k !== 'start' && k !== 'end') out[k] = l[k]; });
      out.startTime = at(l.start);
      if (l.end != null) out.endTime = at(l.end);
      return out;
    });
    var data = { runners: [{ id: s.runnerId, legs: legs }] };
    var store = {
      seededAt: now, n: 2, version: s.version || 1,
      files: {}
    };
    store.files['races/' + SLUG + '/config.json'] = { sha: 'try-1', text: JSON.stringify(cfg, null, 2) + '\n' };
    store.files['races/' + SLUG + '/data.json'] = { sha: 'try-2', text: JSON.stringify(data, null, 2) + '\n' };
    writeStore(store);
    // What the pages would otherwise ask a new visitor: the walkthroughs. The
    // demo page says what to try instead.
    rset(NS + 'race-hub-tutorial-v1', JSON.stringify({ racer: 99, pit: 99, race: 99 }));
    return store;
  }

  var seeding = null;
  function ensureSeeded() {
    var s = readStore();
    if (s && s.files && s.version === SEED_VERSION && Date.now() - (s.touchedAt || s.seededAt || 0) < STALE_MS) return Promise.resolve(s);
    if (!seeding) seeding = seed().finally(function () { seeding = null; });
    return seeding;
  }

  // Every key the demo has, in both stores, and then a fresh race. Real keys
  // are never touched: only the prefixed ones go.
  function reset() {
    [ls, ss].forEach(function (st) {
      try {
        var gone = [];
        for (var i = 0; i < st.length; i++) {
          var k = raw.key.call(st, i);
          if (k && k.indexOf(NS) === 0) gone.push(k);
        }
        gone.forEach(function (k) { raw.remove.call(st, k); });
      } catch (e) {}
    });
    // Said once the new race is written, so a phone that reloads on hearing
    // it reads the new one rather than seeding a second.
    return seed().then(function (st) {
      try { new BroadcastChannel(CHANNEL).postMessage({ reset: true }); } catch (e) {}
      return st;
    });
  }

  var active = new URLSearchParams(location.search).get('id') === SLUG;
  window.SendOffDemo = { SLUG: SLUG, active: active, ensureSeeded: ensureSeeded, reset: reset };
  if (!active) return;

  // ---------- storage, under the demo's own prefix ----------
  var mine = function (st) { return st === ls || st === ss; };
  SP.getItem = function (k) { return raw.get.call(this, mine(this) ? NS + k : k); };
  SP.setItem = function (k, v) { return raw.set.call(this, mine(this) ? NS + k : k, v); };
  SP.removeItem = function (k) { return raw.remove.call(this, mine(this) ? NS + k : k); };
  SP.clear = function () {
    if (!mine(this)) return raw.clear.call(this);
    var gone = [];
    for (var i = 0; i < this.length; i++) { var k = raw.key.call(this, i); if (k && k.indexOf(NS) === 0) gone.push(k); }
    var st = this; gone.forEach(function (k) { raw.remove.call(st, k); });
  };

  // Signed in as the race's owner, to a worker that is this file.
  var hubJson = { auth: { proxyUrl: API }, live: true };
  rset(NS + 'race-hub-session-v1', JSON.stringify({ proxyUrl: API, session: 'try', email: 'you@example.com',
    role: 'owner', expiresAt: Date.now() + 30 * 864e5 }));
  rset(NS + 'so:hub', JSON.stringify(hubJson));
  if (!rget(NS + 'race-hub-tutorial-v1')) rset(NS + 'race-hub-tutorial-v1', JSON.stringify({ racer: 99, pit: 99, race: 99 }));

  // ---------- the worker, answered here ----------
  var b64 = function (s) { return btoa(unescape(encodeURIComponent(s))); };
  var reply = function (status, body, type) {
    return new Response(typeof body === 'string' ? body : JSON.stringify(body),
      { status: status, headers: { 'Content-Type': type || 'application/json' } });
  };
  var channel = null;
  try { channel = new BroadcastChannel(CHANNEL); } catch (e) {}
  var gpx = null;
  var courseText = function () {
    if (!gpx) gpx = realFetch('/demo/course.gpx').then(function (r) { return r.text(); });
    return gpx;
  };
  var NOT_HERE = 'That needs a real race. In the demo, everything stays in this browser.';

  async function worker(u, init) {
    var method = ((init && init.method) || 'GET').toUpperCase();
    var path = u.pathname.replace(/\/+$/, '');
    var store = await ensureSeeded();
    if (path === '/get' || path === '/public') {
      var p = u.searchParams.get('path') || '';
      if (p === 'races/' + SLUG + '/course.gpx') return reply(200, { sha: 'try-gpx', path: p, content: b64(await courseText()), encoding: 'base64' });
      var f = store.files[p];
      if (!f) return reply(404, { message: 'Not Found' });
      var text = f.text;
      // Who is asking, as the worker would add it: the owner, so every
      // control on every page is there to press.
      if (/\/config\.json$/.test(p)) {
        var c = JSON.parse(text); c.myRole = 'owner'; text = JSON.stringify(c, null, 2) + '\n';
      }
      return reply(200, { sha: f.sha, path: p, content: b64(text), encoding: 'base64' });
    }
    if (path === '/commit') {
      var body = {};
      try { body = JSON.parse((init && init.body) || '{}'); } catch (e) {}
      if (!body.path || typeof body.content !== 'string') return reply(400, { error: 'Missing path or content' });
      if (body.path.indexOf('races/' + SLUG + '/') !== 0) return reply(403, { error: NOT_HERE });
      // Read again rather than trusting the copy from before the await: the
      // other phone may have saved in between, and this is the version check.
      store = readStore() || store;
      var cur = store.files[body.path];
      if (body.sha && cur && body.sha !== cur.sha) {
        return reply(409, { error: 'Someone else changed this first: re-read and try again' });
      }
      var sha = 'try-' + (++store.n);
      store.files[body.path] = { sha: sha, text: body.content };
      writeStore(store);
      try { channel && channel.postMessage({ file: body.path.split('/').pop() }); } catch (e) {}
      return reply(200, { content: { path: body.path, sha: sha } });
    }
    if (path === '/entitlements') {
      return reply(200, { plan: 'pro', label: 'Pro', maxRunnersPerRace: null, maxCrewPerRace: null,
        privateRaces: true, shareLinks: true, offlineLogging: true });
    }
    if (path === '/media') {
      if (method === 'GET') return reply(200, { media: [], configured: true });
      return reply(403, { error: 'Photos are not in the demo. On a real race they go straight to the race page.' });
    }
    if (path === '/my-races') return reply(200, { races: [] });
    if (method !== 'GET') return reply(403, { error: NOT_HERE });
    return reply(200, {});
  }

  // The site's own files for this race: the course, and the copies a page
  // falls back to. Answered from the same store.
  async function siteFile(u) {
    var name = u.pathname.split('/').pop();
    if (name === 'course.gpx') return reply(200, await courseText(), 'application/gpx+xml');
    var store = await ensureSeeded();
    var f = store.files['races/' + SLUG + '/' + name];
    return f ? reply(200, f.text) : reply(404, 'Not found', 'text/plain');
  }

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || String(input);
    var u;
    try { u = new URL(url, location.href); } catch (e) { return realFetch(input, init); }
    if (u.origin === API) return worker(u, init || (typeof input === 'object' ? { method: input.method } : null));
    if (u.origin === location.origin && u.pathname === '/hub.json') return Promise.resolve(reply(200, hubJson));
    if (u.origin === location.origin && u.pathname.indexOf('/races/' + SLUG + '/') === 0) return siteFile(u);
    return realFetch(input, init);
  };

  // ---------- the live push ----------
  var RealWS = window.WebSocket;
  function DemoSocket() {
    var self = this;
    this.readyState = 0;
    this._ch = null;
    setTimeout(function () {
      if (self.readyState !== 0) return;
      self.readyState = 1;
      try {
        self._ch = new BroadcastChannel(CHANNEL);
        self._ch.onmessage = function (ev) {
          if (self.readyState !== 1 || !ev.data || ev.data.reset) return;
          self.onmessage && self.onmessage({ data: JSON.stringify(ev.data) });
        };
      } catch (e) {}
      self.onopen && self.onopen({});
    }, 0);
  }
  DemoSocket.prototype.send = function () {};
  DemoSocket.prototype.close = function () {
    if (this.readyState === 3) return;
    this.readyState = 3;
    try { this._ch && this._ch.close(); } catch (e) {}
  };
  if (RealWS) {
    var WSWrap = function (url, protocols) {
      if (String(url).indexOf(WS) === 0) return new DemoSocket();
      return protocols === undefined ? new RealWS(url) : new RealWS(url, protocols);
    };
    WSWrap.prototype = RealWS.prototype;
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) { WSWrap[k] = RealWS[k]; });
    window.WebSocket = WSWrap;
  }

  // ---------- staying inside the demo ----------
  // The racer screen, the pit board and the race page are the demo. A link to
  // anything else (settings, the hub, an account) would leave it for a page
  // that does not know about the pretend race, so it says so instead.
  var DEMO_PAGES = ['race', 'pit', 'racer'];
  function say(text) {
    var el = document.getElementById('try-note');
    if (!el) {
      el = document.createElement('div');
      el.id = 'try-note';
      el.setAttribute('role', 'status');
      el.style.cssText = 'position:fixed;left:12px;right:12px;bottom:14px;z-index:99999;margin:0 auto;max-width:360px;' +
        'background:#0f1a22;color:#f0ece3;border:1px solid #0fb8bf;border-radius:10px;padding:12px 14px;' +
        "font:500 13px/1.45 'IBM Plex Sans',system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.45)";
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.hidden = false;
    clearTimeout(say.t);
    say.t = setTimeout(function () { el.hidden = true; }, 4200);
  }
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var u;
    try { u = new URL(a.href, location.href); } catch (err) { return; }
    if (u.origin !== location.origin) return;
    var page = u.pathname.replace(/^\/+/, '').replace(/\.html$/, '');
    if (page === 'try' || (DEMO_PAGES.indexOf(page) >= 0 && u.searchParams.get('id') === SLUG)) {
      // Opened in a new tab from inside a phone frame, it still works: the
      // race is in this browser, not in the frame.
      return;
    }
    e.preventDefault();
    say(window.top !== window
      ? 'That part needs an account. The demo is the race itself: the racer, the crew page and the race page.'
      : 'That part needs an account. Back to the demo at sendoff.run/try.');
  }, true);

  // On its own, outside the demo page, say what this is and how to get back.
  if (window.top === window) {
    document.addEventListener('DOMContentLoaded', function () {
      var bar = document.createElement('a');
      bar.href = '/try';
      bar.id = 'try-pill';
      bar.textContent = 'Demo race · back to the demo';
      bar.style.cssText = 'position:fixed;top:0;left:0;right:0;height:22px;z-index:99998;display:flex;' +
        'align-items:center;justify-content:center;background:#0fb8bf;color:#0a0f14;text-decoration:none;' +
        "font:700 10px/1 'JetBrains Mono',ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase";
      document.body.appendChild(bar);
      document.body.style.paddingTop = '22px';
    });
  }
  // A Reset from the demo page, or from another tab: this copy of the race
  // is gone, so read the new one.
  try {
    new BroadcastChannel(CHANNEL).onmessage = function (ev) { if (ev.data && ev.data.reset) location.reload(); };
  } catch (e) {}
})();
