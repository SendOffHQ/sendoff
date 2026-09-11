// Shared helpers for the race-dashboard hub.
// Exposes window.Race: see the expose block at the bottom of this file.

(function () {
  'use strict';

  // ---------- formatters ----------
  const fmt = {
    duration(seconds) {
      if (seconds == null || isNaN(seconds) || seconds < 0) return '–';
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = Math.floor(seconds % 60);
      const pad = n => String(n).padStart(2, '0');
      return `${pad(h)}:${pad(m)}:${pad(s)}`;
    },
    durationShort(seconds) {
      // Drops leading 00: for sub-hour values.
      return fmt.duration(seconds).replace(/^00:/, '');
    },
    pace(secondsPerMile) {
      if (secondsPerMile == null || isNaN(secondsPerMile)) return '–';
      const m = Math.floor(secondsPerMile / 60);
      const s = Math.floor(secondsPerMile % 60);
      return `${m}:${String(s).padStart(2, '0')}`;
    },
    clockTime(iso) {
      if (!iso) return '–';
      return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    },
    clockTimeSec(iso) {
      if (!iso) return '–';
      return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    },
    dateRange(startIso, endIso) {
      if (!startIso) return '–';
      const s = new Date(startIso);
      const opts = { month: 'short', day: 'numeric' };
      if (!endIso) return s.toLocaleDateString([], opts);
      const e = new Date(endIso);
      const sameDay = s.toDateString() === e.toDateString();
      if (sameDay) return s.toLocaleDateString([], opts);
      return `${s.toLocaleDateString([], opts)} – ${e.toLocaleDateString([], opts)}`;
    },
    hoursToHm(hours) {
      if (hours == null || isNaN(hours)) return '–';
      const h = Math.floor(hours);
      const m = Math.round((hours - h) * 60);
      return m === 0 ? `${h}h` : `${h}h ${m}m`;
    }
  };

  // ---------- units (per-race display preference) ----------
  // Distances and elevations are always STORED canonically (miles, feet).
  // A race's optional `units` setting only changes how they're displayed and
  // entered. Missing/partial settings fall back to miles + feet.
  const KM_PER_MI = 1.609344;
  const M_PER_FT = 0.3048;
  const units = {
    of(cfg) {
      const u = (cfg && cfg.units) || {};
      return {
        distance: u.distance === 'km' ? 'km' : 'mi',
        elevation: u.elevation === 'm' ? 'm' : 'ft'
      };
    },
    distanceLabel(cfg) { return units.of(cfg).distance; },
    elevationLabel(cfg) { return units.of(cfg).elevation; },
    paceLabel(cfg) { return 'min / ' + units.of(cfg).distance; },
    // miles → display-unit number
    distanceVal(mi, cfg) {
      if (mi == null || isNaN(mi)) return null;
      return units.of(cfg).distance === 'km' ? mi * KM_PER_MI : +mi;
    },
    // feet → display-unit number
    elevationVal(ft, cfg) {
      if (ft == null || isNaN(ft)) return null;
      return units.of(cfg).elevation === 'm' ? ft * M_PER_FT : +ft;
    },
    // display-unit input → miles (for setup/edit forms)
    toMiles(val, cfg) {
      const n = parseFloat(val);
      if (isNaN(n)) return null;
      return units.of(cfg).distance === 'km' ? n / KM_PER_MI : n;
    },
    // display-unit input → feet (for setup/edit forms)
    toFeet(val, cfg) {
      const n = parseFloat(val);
      if (isNaN(n)) return null;
      return units.of(cfg).elevation === 'm' ? n / M_PER_FT : n;
    },
    // formatted "5.9 mi" / "9.5 km"
    distance(mi, cfg, decimals) {
      const v = units.distanceVal(mi, cfg);
      if (v == null) return '–';
      return v.toFixed(decimals == null ? 1 : decimals) + ' ' + units.of(cfg).distance;
    },
    // formatted "6,219 ft" / "1,895 m"
    elevation(ft, cfg) {
      const v = units.elevationVal(ft, cfg);
      if (v == null) return '–';
      return Math.round(v).toLocaleString() + ' ' + units.of(cfg).elevation;
    },
    // sec-per-mile → pace string in the race's distance unit
    pace(secPerMile, cfg) {
      if (secPerMile == null || isNaN(secPerMile)) return '–';
      const sec = units.of(cfg).distance === 'km' ? secPerMile / KM_PER_MI : secPerMile;
      return fmt.pace(sec);
    }
  };

  // ---------- slug ----------
  function slug(s) {
    return (s || '')
      .toString().toLowerCase().trim()
      .replace(/['']/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'race';
  }

  // ---------- query string ----------
  function qs(name) {
    const v = new URLSearchParams(location.search).get(name);
    if (v !== null) return v;
    // A race has two addresses that mean the same thing: race.html?id=<slug>,
    // which is the app, and /races/<slug>/, which is the page carrying that
    // race's own social card. The second is the one worth sharing, so it is
    // the one the address bar ends up showing, and a page served there has no
    // query to read the slug out of.
    if (name === 'id') {
      const m = location.pathname.match(/^\/races\/([^/]+)\/?$/);
      if (m) return decodeURIComponent(m[1]);
    }
    return null;
  }

  // The address to hand somebody for a race. Only a public race has a page of
  // its own: tools/make-og.py builds those from the public manifest, so an
  // unlisted race never gets one and keeps the app URL.
  function raceHref(slug, isPublic) {
    return isPublic
      ? `races/${encodeURIComponent(slug)}/`
      : `race.html?id=${encodeURIComponent(slug)}`;
  }

  // ---------- polling ----------
  // Every page that watches a race used to run setInterval(load, 10000) and
  // keep running it forever, whatever was happening. Three things wrong with
  // that, in order of how much they cost:
  //
  // 1. A hidden tab polls exactly as hard as one somebody is looking at. A
  //    phone in a vest pocket with the race page open asks twice every ten
  //    seconds all night. Spectator reads are the one axis that grows without
  //    bound (see ROADMAP), and most of them are nobody watching.
  // 2. A finished race is polled at the same rate as one in progress, forever,
  //    and it has nothing left to say.
  // 3. setInterval stacks. If a load takes longer than the interval, which is
  //    exactly what happens when the signal is bad, the next one starts before
  //    the last finished and it gets worse from there. Chaining a timeout off
  //    the end of each run cannot do that.
  //
  // The budget this buys back is what pays for a faster interval while
  // somebody is actually looking, which is the only time faster is worth
  // anything.
  function poll(fn, opts) {
    const o = opts || {};
    const interval = typeof o.interval === 'function' ? o.interval : () => o.interval || 10000;
    let timer = null, stopped = false, running = false;

    const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };

    async function run() {
      clear();
      if (stopped || running) return;
      // Nobody is looking. Stop asking; visibilitychange will start it again.
      if (typeof document !== 'undefined' && document.hidden) return;
      running = true;
      try { await fn(); } catch (e) { /* a poll that throws must not end polling */ }
      running = false;
      schedule();
    }

    function schedule() {
      clear();
      if (stopped) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      const ms = Math.max(1000, interval());
      timer = setTimeout(run, ms);
    }

    function onVisible() {
      if (stopped) return;
      // Coming back to a page is the moment its contents matter most, so this
      // refreshes at once rather than waiting out an interval.
      if (!document.hidden) run(); else clear();
    }

    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    schedule();

    return {
      now: run,
      stop() {
        stopped = true; clear();
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
      }
    };
  }

  // ---------- live push (prototype) ----------
  // A socket that says "something changed", so a page can read at once instead
  // of waiting out a poll. Off unless hub.json says live: true, and the worker
  // refuses unless its Durable Object binding exists, so this is two switches
  // away from doing anything.
  //
  // It never replaces polling. A socket can be blocked by a captive portal, a
  // corporate proxy, or a phone that has decided to sleep it, and none of those
  // announce themselves. So the poll keeps running underneath at a slower
  // interval, and the socket's job is only to make the common case quick.
  function live(slug, onChange) {
    let ws = null, closed = false, tries = 0, timer = null;
    const state = { connected: false, close };

    // A session's proxy if there is one, otherwise the address hub.json gives
    // everybody. This used to require a session, which quietly made the push a
    // feature for signed-in crew only: the spectators, who are the many and
    // the whole reason a fan-out is worth having, went on polling. /live takes
    // no auth and serves public races only, so there was never a reason for
    // the client to insist on one.
    const sess = auth.cfg();
    const proxy = (sess && sess.proxyUrl) || hub.proxyUrl();
    if (!hub.data() || !hub.data().live || !proxy) return state;

    function url() {
      const base = String(proxy).replace(/^http/, 'ws').replace(/\/+$/, '');
      return `${base}/live?race=${encodeURIComponent(slug)}`;
    }

    function open() {
      if (closed) return;
      try { ws = new WebSocket(url()); } catch (e) { return retry(); }
      ws.onopen = () => { tries = 0; state.connected = true; };
      ws.onmessage = () => { try { onChange(); } catch (e) {} };
      ws.onerror = () => { try { ws.close(); } catch (e) {} };
      ws.onclose = () => { state.connected = false; retry(); };
    }

    // Backoff, because a worker that is refusing (no binding, private race)
    // will refuse every time, and a page open all day must not spend the day
    // asking. Caps at a minute.
    function retry() {
      if (closed || timer) return;
      const wait = Math.min(60000, 1000 * Math.pow(2, Math.min(tries++, 6)));
      timer = setTimeout(() => { timer = null; open(); }, wait);
    }

    function close() {
      closed = true;
      if (timer) { clearTimeout(timer); timer = null; }
      try { if (ws) ws.close(); } catch (e) {}
    }

    open();
    return state;
  }

  // Which of the three things a race is, for deciding how often to ask about
  // it. Deliberately forgiving: anything it cannot work out is 'live', because
  // polling a finished race too often is cheap and polling a live one too
  // rarely is the failure that matters.
  function raceState(cfg, data) {
    if (!cfg) return 'live';
    const start = cfg.startTime ? Date.parse(cfg.startTime) : NaN;
    if (isFinite(start) && Date.now() < start - 5 * 60000) return 'upcoming';
    const runners = (cfg.runners || []);
    if (runners.length && data) {
      const total = course.legCount(cfg);
      const done = total > 0 && runners.every(r => {
        const d = (data.runners || []).find(x => x.id === r.id);
        return d && ((d.legs || []).filter(l => l && l.endTime).length >= total);
      });
      if (done) return 'finished';
    }
    const hours = (cfg.cutoffs && cfg.cutoffs.totalHours) || 36;
    if (isFinite(start) && Date.now() > start + hours * 3600000) return 'finished';
    return 'live';
  }

  // How often to ask, by what the race is doing. Live is faster than the ten
  // seconds this replaces, which the hidden-tab saving pays for.
  const POLL_MS = { live: 5000, upcoming: 30000, finished: 120000 };

  // ---------- hub config (hub.json) ----------
  // hub.json at repo root carries optional auth.proxyUrl. When set,
  // writes go through the worker; otherwise pages use direct PAT mode.
  const HUB_KEY = 'so:hub';
  const hub = {
    _data: null,
    _promise: null,
    // What load() found, once it has. Null before that.
    data() { return this._data; },
    async load() {
      if (this._data) return this._data;
      if (this._promise) return this._promise;
      this._promise = (async () => {
        try {
          const res = await fetch('hub.json', { cache: 'no-cache' });
          if (res.ok) {
            this._data = await res.json();
            try { localStorage.setItem(HUB_KEY, JSON.stringify(this._data)); } catch (e) {}
            return this._data;
          }
        } catch (e) { /* fall through to what was saved */ }
        // Whether this site puts writes through the proxy is a property of the
        // site. It changes about never, and certainly not because a phone lost
        // signal. Treating an unreachable hub.json as "no proxy" put the page
        // into PAT mode, where the question "may this person edit" is answered
        // by whether the device holds a token, which offline is always no. The
        // crew member lost the pit and racer links at the moment they needed
        // them. So the last hub.json this device saw is the answer when the
        // network has none.
        this._data = hub._saved() || {};
        return this._data;
      })();
      return this._promise;
    },

    _saved() {
      if (typeof localStorage === 'undefined') return null;
      try { return JSON.parse(localStorage.getItem(HUB_KEY)) || null; }
      catch (e) { return null; }
    },
    // Synchronous getter: only valid after load() has resolved at least once.
    proxyUrl() { return this._data?.auth?.proxyUrl || null; },
    isProxyMode() { return !!this.proxyUrl(); }
  };

  // ---------- config / session storage ----------
  // Two storage shapes live side-by-side:
  //   direct mode:  race-hub-config-v1  = { token, owner, repo, branch }
  //   proxy mode:   race-hub-session-v1 = { proxyUrl, session, email, role, expiresAt }
  // Only the one matching the active mode is consulted.
  const CONFIG_KEY  = 'race-hub-config-v1';
  const SESSION_KEY = 'race-hub-session-v1';
  // sessionStorage key for a share-token captured from race.html?t=<token>.
  // Lives only for the current tab; not persisted.
  const SHARE_TOKEN_KEY = 'race-hub-share-token-v1';

  const config = {
    load() {
      try { return JSON.parse(localStorage.getItem(CONFIG_KEY)) || null; }
      catch (e) { return null; }
    },
    save(c) { localStorage.setItem(CONFIG_KEY, JSON.stringify(c)); },
    clear() { localStorage.removeItem(CONFIG_KEY); },
    has() {
      const c = config.load();
      return !!(c && c.token && c.owner && c.repo && c.branch);
    },
    detectDefaults() {
      const host = location.hostname;
      let owner = '', repo = '';
      if (host.endsWith('.github.io')) {
        owner = host.split('.')[0];
        const parts = location.pathname.split('/').filter(Boolean);
        if (parts.length && !parts[0].endsWith('.html')) repo = parts[0];
      }
      return { token: '', owner, repo, branch: 'main', marker: '' };
    }
  };

  // Set by mountAccountWidget() once the account bar exists; called by
  // auth.saveSession/clearSession so the bar reflects sign-in/out immediately
  // on any page, without a reload.
  let accountWidgetRender = null;
  // The admin feedback badge, fetched at most once per page load. See the note
  // where it is used.
  let feedbackCountOnce = null;
  // The page's header links, lifted out once and re-homed in the menu on every
  // render. Null until the widget has mounted and looked.
  let navLinks = null;
  // The header separator tidy runs once per page, independently of the hoist.
  let metaTidied = false;

  const auth = {
    // Returns 'proxy' | 'direct' based on hub.json. Defaults to 'direct'.
    mode() { return hub.isProxyMode() ? 'proxy' : 'direct'; },

    // Session state for proxy mode.
    loadSession() {
      try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || null; }
      catch (e) { return null; }
    },
    saveSession(s) {
      // Back-compat: prefer email over username.
      const out = { ...s };
      if (!out.email && out.username) out.email = out.username;
      localStorage.setItem(SESSION_KEY, JSON.stringify(out));
      if (accountWidgetRender) accountWidgetRender();
    },
    clearSession() {
      localStorage.removeItem(SESSION_KEY);
      // The saved copies of race files go too. They hold a roster and, for
      // crew, runner-to-account links; the next person to pick this phone up
      // is not necessarily the one who was crewing on it.
      lastSeen.clear();
      if (accountWidgetRender) accountWidgetRender();
    },

    // Has a usable auth state (PAT or unexpired session) for the current mode?
    has() {
      if (auth.mode() === 'proxy') {
        const s = auth.loadSession();
        return !!(s && s.session && s.proxyUrl && (!s.expiresAt || s.expiresAt > Date.now() + 60_000));
      }
      return config.has();
    },

    email() {
      if (auth.mode() !== 'proxy') return null;
      const s = auth.loadSession();
      return s ? (s.email || s.username || null) : null;
    },

    // Build the "cfg" object the gh.* functions need. Returns null if not authed.
    cfg() {
      if (auth.mode() === 'proxy') {
        const s = auth.loadSession();
        if (!s) return null;
        return {
          mode: 'proxy', proxyUrl: s.proxyUrl, session: s.session,
          email: s.email || s.username, username: s.email || s.username
        };
      }
      const c = config.load();
      if (!c) return null;
      return { mode: 'direct', token: c.token, owner: c.owner, repo: c.repo, branch: c.branch };
    },

    async login(email, password) {
      const proxyUrl = hub.proxyUrl();
      if (!proxyUrl) throw new Error('Proxy not configured in hub.json');
      const res = await fetch(proxyUrl.replace(/\/+$/, '') + '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      if (!res.ok) {
        let msg = `Login failed (${res.status})`;
        try { const j = await res.json(); if (j.error) msg = j.error; } catch (e) {}
        throw new Error(msg);
      }
      const data = await res.json();
      auth.saveSession({
        proxyUrl: proxyUrl.replace(/\/+$/, ''),
        session: data.token,
        email: data.email || data.username,
        role: data.role,
        expiresAt: data.expiresAt
      });
      return data;
    },

    logout() { auth.clearSession(); }
  };

  // ---------- share-token (anonymous access via ?t=<token>) ----------
  // race.html stashes ?t=<token> in sessionStorage on load so subsequent
  // worker GETs can validate the token. The token is scoped to the URL's slug.
  const share = {
    get() {
      try { return sessionStorage.getItem(SHARE_TOKEN_KEY) || null; }
      catch (e) { return null; }
    },
    set(token) {
      try { sessionStorage.setItem(SHARE_TOKEN_KEY, token); } catch (e) {}
    },
    clear() {
      try { sessionStorage.removeItem(SHARE_TOKEN_KEY); } catch (e) {}
    },
    // Initialize from window.location.search if a ?t=<token> is present.
    captureFromUrl() {
      const t = qs('t');
      if (t) share.set(t);
      return share.get();
    }
  };

  // ---------- proxy API client (invite / share / access / my-races) ----------
  // Wraps fetch calls against the worker for things beyond file IO.
  // For endpoints anybody may reach. Same proxy, same shape, but the base
  // comes from hub.json rather than from a session, and the token is attached
  // only if there is one: somebody watching a race on a shared link has no
  // account and is still worth hearing from.
  async function publicCall(path, opts) {
    const base = hub.proxyUrl();
    if (!base) throw new Error('This site has no login worker configured.');
    opts = opts || {};
    const s = auth.loadSession();
    const res = await netFetch(base + path, {
      method: opts.method || 'GET',
      headers: {
        ...(s && s.session ? { Authorization: 'Bearer ' + s.session } : {}),
        ...(opts.body ? { 'Content-Type': 'application/json' } : {})
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    let payload = null;
    try { payload = await res.json(); } catch (e) {}
    if (!res.ok) {
      const err = new Error((payload && payload.error) || `${path} ${res.status}`);
      err.status = res.status; throw err;
    }
    return payload;
  }

  async function proxyCall(path, opts) {
    const cfg = auth.cfg();
    if (!cfg || cfg.mode !== 'proxy') throw new Error('Sign in required');
    opts = opts || {};
    const res = await fetch(cfg.proxyUrl + path, {
      method: opts.method || 'GET',
      headers: {
        Authorization: 'Bearer ' + cfg.session,
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.headers || {})
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    if (res.status === 401) {
      auth.clearSession();
      const err = new Error('Session expired: please sign in again.');
      err.status = 401; throw err;
    }
    let payload = null;
    try { payload = await res.json(); } catch (e) {}
    if (!res.ok) {
      const msg = (payload && payload.error) || `${path} ${res.status}`;
      const err = new Error(msg); err.status = res.status; throw err;
    }
    return payload;
  }

  const api = {
    myRaces:     ()                          => proxyCall('/my-races'),
    accessList:  (slug)                      => proxyCall('/access?slug=' + encodeURIComponent(slug)),
    accessAdd:   (slug, email, role)         => proxyCall('/access/add',    { method: 'POST', body: { slug, email, role } }),
    accessRemove:(slug, email)               => proxyCall('/access/remove', { method: 'POST', body: { slug, email } }),
    teamInvite:  (slug, allowed)             => proxyCall('/access/team-invite', { method: 'POST', body: { slug, allowed } }),
    // No arguments reads your own; an email plus a race you both work reads theirs.
    profile:     (email, slug)               => proxyCall('/profile' + (email
                                                  ? `?email=${encodeURIComponent(email)}&slug=${encodeURIComponent(slug || '')}`
                                                  : ''), { method: 'GET' }),
    saveProfile: (profile)                   => proxyCall('/profile', { method: 'POST', body: profile }),
    entitlements: ()                         => proxyCall('/entitlements'),
    aclStatus:   ()                          => proxyCall('/acl-status'),
    sendFeedback:(payload)                   => publicCall('/feedback', { method: 'POST', body: payload }),
    feedbackList:()                          => proxyCall('/feedback-list'),
    feedbackCount:(since)                    => proxyCall('/feedback-count' +
                                                  (since ? '?since=' + encodeURIComponent(since) : '')),
    feedbackDelete:(key)                     => proxyCall('/feedback/delete', { method: 'POST', body: { key } }),
    d1Status:    ()                          => proxyCall('/d1-status'),
    d1Backfill:  ()                          => proxyCall('/d1-backfill', { method: 'POST' }),
    setPlan:     (email, plan, opts)         => proxyCall('/account/plan', { method: 'POST', body: { email, plan, ...(opts || {}) } }),
    invite:      (slug, email, role)         => proxyCall('/invite',        { method: 'POST', body: { slug, email, role } }),
    shareLink:   (slug, role, opts)          => proxyCall('/share-link',    { method: 'POST', body: { slug, role, ...(opts || {}) } }),
    shareRevoke: (token)                     => proxyCall('/share/revoke',  { method: 'POST', body: { token } }),
    deleteRace:  (slug)                      => proxyCall('/race/delete',  { method: 'POST', body: { slug } }),
    changePassword: (currentPassword, newPassword) => proxyCall('/change-password', { method: 'POST', body: { currentPassword, newPassword } }),
    // opts.send asks the worker to mail the link to them as well as return it.
    resetLink: (email, opts) => proxyCall('/reset-link', { method: 'POST', body: { email, send: !!(opts && opts.send) } }),
    resetInfo: async (token) => {
      const proxyUrl = hub.proxyUrl();
      if (!proxyUrl) throw new Error('Proxy not configured in hub.json');
      const res = await fetch(proxyUrl.replace(/\/+$/, '') + '/reset-info?token=' + encodeURIComponent(token));
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error((payload && payload.error) || `reset-info ${res.status}`);
      return payload;
    },
    resetPassword: async (token, newPassword) => {
      const proxyUrl = hub.proxyUrl();
      if (!proxyUrl) throw new Error('Proxy not configured in hub.json');
      const res = await fetch(proxyUrl.replace(/\/+$/, '') + '/reset-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword })
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error((payload && payload.error) || `reset-password ${res.status}`);
      auth.saveSession({
        proxyUrl: proxyUrl.replace(/\/+$/, ''),
        session: payload.token, email: payload.email, role: payload.role, expiresAt: payload.expiresAt
      });
      return payload;
    },
    acceptInvite: async (token, password) => {
      const proxyUrl = hub.proxyUrl();
      if (!proxyUrl) throw new Error('Proxy not configured in hub.json');
      const res = await fetch(proxyUrl.replace(/\/+$/, '') + '/accept-invite', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password })
      });
      let payload = null;
      try { payload = await res.json(); } catch (e) {}
      if (!res.ok) throw new Error((payload && payload.error) || `accept-invite ${res.status}`);
      auth.saveSession({
        proxyUrl: proxyUrl.replace(/\/+$/, ''),
        session: payload.token,
        email: payload.email,
        role: payload.role,
        expiresAt: payload.expiresAt
      });
      return payload;
    },

    // Hub-level account invites (not tied to a race).
    accountInvite: (email, opts) => proxyCall('/account-invite', { method: 'POST', body: { email, send: !!(opts && opts.send) } }),
    accounts:      ()        => proxyCall('/accounts'),
    accountRaces:  (email)   => proxyCall('/account-races?email=' + encodeURIComponent(email)),
    deleteAccount: (email)   => proxyCall('/account/delete', { method: 'POST', body: { email } }),
    accessRequests: ()       => proxyCall('/access-requests'),
    deleteAccessRequest: (key) => proxyCall('/access-request/delete', { method: 'POST', body: { key } }),
    accountInviteInfo: async (token) => {
      const proxyUrl = hub.proxyUrl();
      if (!proxyUrl) throw new Error('Proxy not configured in hub.json');
      const res = await fetch(proxyUrl.replace(/\/+$/, '') + '/account-invite-info?token=' + encodeURIComponent(token));
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error((payload && payload.error) || `account-invite-info ${res.status}`);
      return payload;
    },
    acceptAccountInvite: async (token, password) => {
      const proxyUrl = hub.proxyUrl();
      if (!proxyUrl) throw new Error('Proxy not configured in hub.json');
      const res = await fetch(proxyUrl.replace(/\/+$/, '') + '/accept-account-invite', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password })
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error((payload && payload.error) || `accept-account-invite ${res.status}`);
      auth.saveSession({
        proxyUrl: proxyUrl.replace(/\/+$/, ''),
        session: payload.token, email: payload.email, role: payload.role, expiresAt: payload.expiresAt
      });
      return payload;
    }
  };

  // ---------- GitHub Contents API ----------
  function utf8ToBase64(s) { return btoa(unescape(encodeURIComponent(s))); }
  function base64ToUtf8(b) { return decodeURIComponent(escape(atob(b.replace(/\s/g, '')))); }

  // fetch rejects with a bare TypeError whether the phone has no signal or the
  // code handed it something invalid, and by the time the queue sees the error
  // those look identical. Tagging it here is the only place the difference is
  // still knowable, and the queue depends on it: a press must wait out a ridge,
  // and must not wait out a bug.
  async function netFetch(url, init) {
    try {
      return await fetch(url, init);
    } catch (cause) {
      const err = new Error(cause && cause.message ? cause.message : 'Network request failed');
      err.offline = true;
      err.cause = cause;
      throw err;
    }
  }

  // A race whose published copy the worker will not serve, remembered so that
  // an unlisted race does not pay for the question on every single poll. Per
  // page load, because a race going public mid-session is a reload away and
  // getting it wrong for one visit costs nothing but the old latency.
  const publicMiss = new Set();

  const gh = {
    utf8ToBase64, base64ToUtf8,

    // The published copy: a public race read from the worker with no session
    // at all. Null means "the worker will not serve this one", which is the
    // signal to fall back to the file the site publishes.
    //
    // Deliberately not 'no-store' and with no cache-buster on the end. Both
    // defeat the ETag, and the ETag is the entire economy of this: a poll that
    // finds nothing new costs a 304 with no body. 'no-cache' still asks every
    // time, it just asks conditionally, and the browser adds If-None-Match
    // itself, which is why that does not become a preflighted request.
    async readPublic(path) {
      const base = hub.proxyUrl();
      // Not the same as "this race is not public": it means we could not ask,
      // because hub.json has not landed yet. Throwing rather than returning
      // null is what keeps it out of publicMiss, which is only ever for a
      // settled 404. Returning null here memoised "not public" for the rest of
      // the visit on any page that reads before Race.hub.load() resolves.
      if (!base) throw new Error('hub.json has not been loaded yet');
      const url = `${base.replace(/\/+$/, '')}/public?path=${encodeURIComponent(path)}`;
      const res = await netFetch(url, { cache: 'no-cache' });
      // 404 is the settled answer: this race is not one the worker will serve,
      // and asking again on the next poll would only cost another 404. Any
      // other failure is the worker having a bad moment, which must not get
      // remembered as "not public" for the rest of the visit, so it throws and
      // this poll alone falls back.
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GET public ${path} ${res.status}`);
      const j = await res.json();
      // A 200 with nothing in it is a broken answer, not a refusal, so it does
      // not get remembered as one either.
      if (!j || j.content == null) throw new Error(`GET public ${path}: no content`);
      return base64ToUtf8(j.content);
    },

    async getFile(cfg, path) {
      if (cfg.mode === 'proxy') {
        // A share token, if this visit arrived on one. The worker checks it
        // against KV and treats it as another way to be allowed, so sending it
        // alongside a session is additive rather than a second opinion: the
        // role in the answer still comes from the session. Sending it is what
        // lets somebody with no account read an unlisted race at all.
        const t = share.get();
        const url = `${cfg.proxyUrl}/get?path=${encodeURIComponent(path)}` +
                    (t ? `&t=${encodeURIComponent(t)}` : '');
        const headers = cfg.session ? { Authorization: `Bearer ${cfg.session}` } : {};
        const res = await netFetch(url, { headers, cache: 'no-store' });
        if (res.status === 404) return { sha: null, content: null, missing: true };
        if (res.status === 401) {
          auth.clearSession();
          const err = new Error('Session expired: please log in again.');
          err.status = 401; throw err;
        }
        if (!res.ok) {
          const text = await res.text();
          const err = new Error(`GET ${path} ${res.status}: ${text.slice(0, 200)}`);
          err.status = res.status; throw err;
        }
        const j = await res.json();
        // The worker proxies GitHub's response, which includes content (base64) and sha.
        // For files that don't exist, the worker returns the upstream 404.
        return { sha: j.sha, content: base64ToUtf8(j.content), missing: false };
      }
      const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(cfg.branch)}`;
      const res = await netFetch(url, {
        headers: { Authorization: `token ${cfg.token}`, Accept: 'application/vnd.github.v3+json' },
        cache: 'no-store'
      });
      if (res.status === 404) return { sha: null, content: null, missing: true };
      if (!res.ok) {
        const text = await res.text();
        const err = new Error(`GET ${path} ${res.status}: ${text.slice(0, 200)}`);
        err.status = res.status; throw err;
      }
      const j = await res.json();
      return { sha: j.sha, content: base64ToUtf8(j.content), missing: false };
    },

    // Allocates the numeric prefix for a new race slug (000042-forest-fifty).
    // Private races never appear in races/index.json, so the count comes from
    // the repo tree: the worker does the scan in proxy mode, and in token mode
    // we ask GitHub directly with the user's own token.
    async nextRaceId(cfg) {
      const digits = 6;
      if (cfg.mode === 'proxy') {
        const res = await netFetch(`${cfg.proxyUrl}/next-race-id`, {
          headers: { Authorization: `Bearer ${cfg.session}` },
          cache: 'no-store'
        });
        if (res.status === 401) {
          auth.clearSession();
          const err = new Error('Session expired: please log in again.');
          err.status = 401; throw err;
        }
        if (res.status === 404) {
          // The site is newer than the worker. Failing here is deliberate:
          // falling back to a bare name-only slug is how two races end up in
          // the same folder, which is the thing the ID exists to prevent.
          const err = new Error('The race proxy is out of date (no /next-race-id). Deploy the worker, then try again.');
          err.status = 404; throw err;
        }
        if (!res.ok) {
          const text = await res.text();
          const err = new Error(`GET /next-race-id ${res.status}: ${text.slice(0, 200)}`);
          err.status = res.status; throw err;
        }
        const j = await res.json();
        return j.id;
      }
      const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/git/trees/${encodeURIComponent(cfg.branch)}?recursive=1`;
      const res = await netFetch(url, {
        headers: { Authorization: `token ${cfg.token}`, Accept: 'application/vnd.github.v3+json' },
        cache: 'no-store'
      });
      if (!res.ok) {
        const text = await res.text();
        const err = new Error(`GET tree ${res.status}: ${text.slice(0, 200)}`);
        err.status = res.status; throw err;
      }
      const tree = await res.json();
      let max = 0;
      for (const t of (tree.tree || [])) {
        if (t.type !== 'blob' || !/^races\/[^/]+\/config\.json$/.test(t.path)) continue;
        const m = /^(\d+)-/.exec(t.path.split('/')[1]);
        if (!m) continue;
        const n = parseInt(m[1], 10);
        if (n > max) max = n;
      }
      return String(max + 1).padStart(digits, '0');
    },

    async getJson(cfg, path) {
      const r = await gh.getFile(cfg, path);
      if (r.missing) return { sha: null, data: null, missing: true };
      return { sha: r.sha, data: JSON.parse(r.content), missing: false };
    },

    async putFile(cfg, path, body, sha, message) {
      if (cfg.mode === 'proxy') {
        // The worker accepts a UTF-8 string content; for binary (already-base64) bodies
        // we decode back to UTF-8 isn't safe, so the wizard's GPX upload stays direct.
        // Here we accept strings; a future worker rev can accept base64 directly.
        if (typeof body !== 'string') {
          throw new Error('Proxy mode currently supports text content only.');
        }
        const res = await netFetch(`${cfg.proxyUrl}/commit`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${cfg.session}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ path, content: body, sha: sha || null, message })
        });
        if (res.status === 401) {
          auth.clearSession();
          const err = new Error('Session expired: please log in again.');
          err.status = 401; throw err;
        }
        if (!res.ok) {
          const text = await res.text();
          const err = new Error(`PUT ${path} ${res.status}: ${text.slice(0, 200)}`);
          err.status = res.status; throw err;
        }
        return res.json();
      }
      const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${encodeURI(path)}`;
      const payload = {
        message, branch: cfg.branch,
        content: typeof body === 'string'
          ? utf8ToBase64(body)
          : body  // already base64-encoded (used for binary like GPX)
      };
      if (sha) payload.sha = sha;
      const res = await netFetch(url, {
        method: 'PUT',
        headers: {
          Authorization: `token ${cfg.token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const text = await res.text();
        const err = new Error(`PUT ${path} ${res.status}: ${text.slice(0, 200)}`);
        err.status = res.status; throw err;
      }
      return res.json();
    },

    async putJson(cfg, path, data, sha, message) {
      return gh.putFile(cfg, path, JSON.stringify(data, null, 2) + '\n', sha, message);
    },

    // Mutate JSON at `path` with optimistic concurrency: GET → mutate(data) → PUT,
    // retrying up to `tries` times on 409.
    //
    // Returns the document as written. Callers want that rather than the API's
    // reply, because reading a file back straight after writing it is the one
    // thing that does not work: GitHub's contents API is not read-after-write
    // consistent, so the read that follows a save can hand back the version
    // from before it. A page that re-reads to refresh itself shows the edit
    // being undone. The writer already knows what it wrote.
    async mutateJson(cfg, path, mutate, message, tries) {
      tries = tries || 4;
      let lastErr = null;
      for (let i = 0; i < tries; i++) {
        const r = await gh.getJson(cfg, path);
        const data = r.data || {};
        const next = mutate(data) || data;
        try {
          await gh.putJson(cfg, path, next, r.sha, message);
          return next;
        } catch (err) {
          lastErr = err;
          if (err.status !== 409) throw err;
        }
      }
      throw lastErr || new Error('Too many sha conflicts');
    },

    // Read a race file (races/<slug>/<file>), whatever it takes.
    //
    // In order: the worker, then the published copy on Pages, then the worker
    // again, then whatever this device saw last. Returns null if none of them
    // has it, because a race without a GPX is normal and the caller decides
    // whether a missing file is a problem.
    //
    // The last step is the one that matters out on a course. The service
    // worker caches the Pages URLs, but a signed-in reader goes through the
    // proxy and never fetches those URLs, so nothing ever lands in that cache
    // to fall back on; and the proxy's own answers are per-session and are
    // deliberately never cached. Between the two, a phone that had a race open
    // all morning had nothing to show the moment the signal went. So every
    // read that succeeds is written down here, and a read that cannot reach
    // anything reads it back.
    async readRaceFile(slug, file, preferWorker) {
      const cfg = auth.cfg();
      const path = `races/${slug}/${file}`;
      const keep = (text, opts) => { if (text != null) lastSeen.save(slug, file, text, opts); return text; };

      if (preferWorker && cfg) {
        try {
          const r = await gh.getFile(cfg, path);
          if (!r.missing) { offline.note(path, false); return keep(r.content, { source: 'proxy' }); }
        } catch (e) { /* fall through to Pages */ }
      }
      // Signed out. Two ways the worker will still answer, tried in the order
      // that covers the most races.
      if (preferWorker && !cfg) {
        // A share link. Works for an unlisted race as well as a public one,
        // which is the whole point: an unlisted race has no published copy it
        // is allowed to have, so before this its only fresh reader was
        // somebody with an account.
        const tok = share.get();
        if (tok) {
          try {
            const r = await gh.getFile({ mode: 'proxy', proxyUrl: hub.proxyUrl(), session: null }, path);
            if (!r.missing) { offline.note(path, false); return keep(r.content, { source: 'proxy' }); }
          } catch (e) { /* an expired or revoked token: carry on below */ }
        }
        // The published copy. Public races only; anything else answers 404,
        // which is remembered so the next poll does not ask again.
        if (!publicMiss.has(slug)) {
          try {
            const text = await gh.readPublic(path);
            if (text != null) { offline.note(path, false); return keep(text, { source: 'proxy' }); }
            publicMiss.add(slug);
          } catch (e) { /* fall through to the published file */ }
        }
      }
      try {
        // Absolute. This used to be relative, which was right for every page
        // that lives at the site root and wrong the moment race.html is served
        // at /races/<slug>/, where it resolved to /races/<slug>/races/<slug>/…
        // and quietly found nothing. That only happens with no signal, when
        // the service worker answers the share address with the app shell,
        // which is exactly when there is nothing else to fall back to.
        // No cache-buster, and 'no-cache' rather than 'no-store'. The buster
        // made every poll a URL nothing had ever seen, which defeated ETag
        // revalidation completely; it was load-bearing only while GitHub Pages
        // served these with max-age=600 and no way to say otherwise. Cloudflare
        // Pages honours the no-cache in _headers, so the browser now asks
        // conditionally and an unchanged file comes back as a 304 with no body.
        const res = await netFetch(`/races/${encodeURIComponent(slug)}/${file}`, { cache: 'no-cache' });
        // A host that answers a missing file with 200 and a page of markup,
        // which Cloudflare Pages does unless there is a 404.html, would
        // otherwise have that markup written down below as this race's data.
        // A poisoned copy in storage outlives the mistake: it is what gets
        // handed back with no signal, when there is nothing to correct it.
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        if (res.ok && ct.includes('html')) throw new Error('not the file asked for');
        if (res.ok) {
          const text = await res.text();
          // Offline, this "success" is often the service worker handing back
          // its own copy of the published file, which can be far older than
          // what this device last saw through the proxy. Taking it as truth
          // showed a crew member an empty leg list; writing it down as well
          // replaced their splits with it. So a copy that came out of storage
          // has to say when it was made and win on that, not on arriving last.
          if (res.headers.get('X-SendOff-Cache') !== 'hit') {
            offline.noteResponse(res, path);
            return keep(text, { source: 'published' });
          }
          // Which copy answers is the same question as which copy to keep, so
          // it is asked the same way. Recency alone got this wrong: visiting
          // the hub makes the service worker cache the published config, which
          // is then newer than the proxy copy saved when the race page was
          // last opened, and a newer file that names nobody still cannot say
          // who you are.
          const at = Date.parse(res.headers.get('date') || '') || 0;
          const stamp = at ? new Date(at).toISOString() : new Date(0).toISOString();
          const saved = lastSeen.load(slug, file);
          if (saved && lastSeen.better(saved, { source: 'published', at: stamp })) {
            offline.noteSaved(saved.at, path);
            return saved.text;
          }
          offline.noteResponse(res, path);
          return keep(text, { source: 'published', at: stamp });
        }
      } catch (e) { /* fall through */ }
      if (cfg) {
        try {
          const r = await gh.getFile(cfg, path);
          if (!r.missing) { offline.note(path, false); return keep(r.content, { source: 'proxy' }); }
        } catch (e) { /* nothing left on the network */ }
      }
      const saved = lastSeen.load(slug, file);
      if (saved) { offline.noteSaved(saved.at, path); return saved.text; }
      return null;
    },

    async readRaceJson(slug, file, preferWorker) {
      const text = await gh.readRaceFile(slug, file, preferWorker);
      if (text == null) throw new Error(`${file} not found for race "${slug}"`);
      return JSON.parse(text);
    },

    // The same, for a file that is not JSON. course.gpx used to be fetched
    // from Pages alone, which made it the one part of a race that had to wait
    // for the site to rebuild: the page came up off the worker read and then
    // sat there with no map and no elevation until Pages caught up.
    readRaceText(slug, file, preferWorker) {
      return gh.readRaceFile(slug, file, preferWorker);
    }
  };

  // ---------- what this device saw last ----------
  // A per-device copy of the last version of each race file this browser
  // successfully read, so a phone that loses signal shows the race it was
  // already showing rather than an empty page.
  //
  // Deliberately stores the answer the app actually used, which for a signed
  // in reader is the proxy's copy of the config, with myRole on it. That is
  // what lets the offline page still know you are crew and still offer you the
  // pit and racer pages. The published copy names nobody, by design, so
  // falling back to it would leave a crew member a stranger to their own race.
  //
  // It holds a roster and runner-to-account links for someone who already had
  // them on screen, in their own browser, and it is cleared on sign out.
  // The proxy knows who is asking; the published file does not. That is the
  // whole difference, and it is why a published copy must never replace a
  // proxy one.
  const SOURCE_RANK = { published: 1, proxy: 2 };

  const lastSeen = {
    KEY: 'so:seen:',
    RACES_KEY: 'so:races',
    key(slug, file) { return `${lastSeen.KEY}${slug}:${file}`; },

    // What was last written, in memory. The race page re-reads data.json every
    // ten seconds and almost always gets the same bytes back; localStorage
    // writes are synchronous and go to disk, so writing an unchanged file over
    // and over is jank on a phone in a vest pocket for no benefit at all.
    _written: new Map(),

    // Two copies of a race file are not equivalent, so the newer one does not
    // automatically win.
    //
    // The proxy's config carries myRole, and for crew it carries the runner to
    // account links as well. The published file carries neither: it names
    // nobody, deliberately. The hub reads every race's config straight from
    // Pages to draw its cards, so a visit to the hub was quietly replacing
    // every saved config with the version that cannot say who you are. Offline
    // after that, a crew member had no role, and so no pit board and no racer
    // page. Which page you happened to open last decided whether you could
    // work the race.
    //
    // So a copy is replaced only by one at least as informative: the proxy
    // outranks the published file, and within a rank the newer one wins.
    // `at` is for a copy that did not come off the network just now.
    // Is `a` the better copy? Rank first, then age. Rank first because the two
    // sources do not carry the same thing: the proxy's config says who you are
    // and, for crew, which account each runner belongs to, and the published
    // file carries neither. For data.json both sources say the same thing, so
    // rank only decides there in the case where the published copy is the one
    // this device happens to have cached, and then it is stale by definition.
    better(a, b) {
      const ra = SOURCE_RANK[a.source] || SOURCE_RANK.published;
      const rb = SOURCE_RANK[b.source] || SOURCE_RANK.published;
      if (ra !== rb) return ra > rb;
      return Date.parse(a.at) > Date.parse(b.at);
    },

    save(slug, file, text, opts) {
      if (typeof localStorage === 'undefined' || !slug || text == null) return;
      const source = (opts && opts.source) || 'published';
      const stamp = (opts && opts.at) || new Date().toISOString();
      const k = lastSeen.key(slug, file);
      if (lastSeen._written.get(k) === text) return;
      const have = lastSeen.load(slug, file);
      if (have && lastSeen.better(have, { source, at: stamp })) return;
      const row = JSON.stringify({ at: stamp, text, source });
      try {
        localStorage.setItem(k, row);
        lastSeen._written.set(k, text);
      } catch (e) {
        // Out of room. A course GPX runs to half a megabyte, so a few races
        // fill the quota on their own. The race being looked at now is the one
        // worth keeping; the rest are re-read the next time they are opened.
        try {
          lastSeen.evictExcept(slug);
          localStorage.setItem(k, row);
          lastSeen._written.set(k, text);
        } catch (e2) { /* a nicety, never a blocker */ }
      }
    },

    load(slug, file) {
      if (typeof localStorage === 'undefined') return null;
      try {
        const raw = localStorage.getItem(lastSeen.key(slug, file));
        if (!raw) return null;
        const row = JSON.parse(raw);
        return (row && typeof row.text === 'string') ? row : null;
      } catch (e) { return null; }
    },

    evictExcept(slug) {
      const prefix = slug ? `${lastSeen.KEY}${slug}:` : null;
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith(lastSeen.KEY) && (!prefix || !k.startsWith(prefix))) {
          localStorage.removeItem(k);
          lastSeen._written.delete(k);
        }
      }
    },

    // The hub's list of races. Private races are not in the published
    // manifest at all, by design, so with no signal the only place they exist
    // is here: without this the hub showed a crew member the public races and
    // silently dropped the one they were actually working.
    //
    // Tied to the account that fetched it, because it names races somebody
    // else on this phone has no business seeing.
    saveRaces(email, races) {
      if (typeof localStorage === 'undefined' || !email || !Array.isArray(races)) return;
      try {
        localStorage.setItem(lastSeen.RACES_KEY,
          JSON.stringify({ email: String(email).toLowerCase(), at: new Date().toISOString(), races }));
      } catch (e) { /* a nicety, never a blocker */ }
    },

    loadRaces(email) {
      if (typeof localStorage === 'undefined' || !email) return null;
      try {
        const row = JSON.parse(localStorage.getItem(lastSeen.RACES_KEY) || 'null');
        if (!row || row.email !== String(email).toLowerCase()) return null;
        return Array.isArray(row.races) ? row : null;
      } catch (e) { return null; }
    },

    // Signing out takes the race data with it. The next person to use this
    // phone is not necessarily the one who was crewing on it.
    clear() {
      if (typeof localStorage === 'undefined') return;
      try {
        lastSeen.evictExcept(null);
        localStorage.removeItem(lastSeen.RACES_KEY);
      } catch (e) {}
    }
  };

  // ---------- what kind of race this is ----------
  // One list, because these become stored values and a picker that drifts from
  // the reader is how a race ends up filed under a discipline that no longer
  // exists.
  //
  // Two fields carry weight beyond the label:
  //
  //   speed   whether people think in distance per hour rather than time per
  //           distance. A cyclist reads 18 mph; a runner reads 8:30 a mile.
  //           units.paceLabel() still says "min / mi" for everything, which is
  //           wrong for four of these, and this is the flag that fixes it.
  //   family  what a result is comparable to. The archive's buckets are 50K,
  //           50 mile, 100K and 100 mile, which are running distances: a
  //           hundred mile bike race held against a hundred mile run would be
  //           a meaningless personal best. Nothing reads this yet; it is here
  //           so the archive has it when it needs it.
  //
  // Absent means unset rather than "trail run". Races created before this
  // existed are not retro-labelled with a guess, however good the guess.
  const ACTIVITIES = [
    { key: 'trail-run',   label: 'Trail run',        family: 'foot',   speed: false },
    { key: 'road-run',    label: 'Road run',         family: 'foot',   speed: false },
    { key: 'hike',        label: 'Hike',             family: 'foot',   speed: false },
    { key: 'swim',        label: 'Swim',             family: 'swim',   speed: false },
    { key: 'mtb',         label: 'Mountain bike',    family: 'bike',   speed: true  },
    { key: 'gravel-bike', label: 'Gravel bike',      family: 'bike',   speed: true  },
    { key: 'road-bike',   label: 'Road bike',        family: 'bike',   speed: true  },
    { key: 'paddle',      label: 'Paddle',           family: 'paddle', speed: true  },
    // The long name is right in a picker and too long for a card chip.
    { key: 'mixed',       label: 'Mixed discipline', short: 'Mixed',   family: 'mixed', speed: false },
    { key: 'other',       label: 'Other',            family: 'other',  speed: false }
  ];

  const activities = {
    all: ACTIVITIES,
    // What a new race starts on. Only a default for the picker; it is never
    // written onto a race that did not choose it.
    DEFAULT: 'trail-run',

    find(key) { return ACTIVITIES.find(a => a.key === key) || null; },
    of(cfg) { return activities.find(cfg && cfg.activity); },
    // The label, or null when a race predates the field or names something
    // this list has since dropped. Callers draw nothing rather than "Other":
    // a race with no answer is not the same as a race whose answer is other.
    label(cfg) { const a = activities.of(cfg); return a ? a.label : null; },
    short(cfg) { const a = activities.of(cfg); return a ? (a.short || a.label) : null; },
    family(cfg) { const a = activities.of(cfg); return a ? a.family : null; },
    isSpeed(cfg) { const a = activities.of(cfg); return !!(a && a.speed); }
  };

  // ---------- archive ----------
  // A runner's history across races, and the records that fall out of it.
  //
  // Who you were in a race is decided by the email on the runner record, which
  // is the link the settings page already writes. A race you crewed is not
  // your race, and does not appear.
  const archive = {
    // Ultra distances are never exact, so a race is filed under the nearest
    // standard rather than having to be it. A 103 mile course is a hundred.
    // Anything outside these ranges still counts toward the overall bests; it
    // just has nothing to be compared against.
    BUCKETS: [
      { key: '50k',   label: '50K',      min: 28, max: 36 },
      { key: '50mi',  label: '50 mile',  min: 45, max: 57 },
      { key: '100k',  label: '100K',     min: 60, max: 70 },
      { key: '100mi', label: '100 mile', min: 95, max: 112 }
    ],

    bucketFor(mi) {
      if (!(mi > 0)) return null;
      return archive.BUCKETS.find(b => mi >= b.min && mi <= b.max) || null;
    },

    // One race from one runner's point of view, or null if they were not in it.
    // `finished` is every leg logged; anything short of that is a day that
    // happened and is worth keeping, but is not a result.
    resultFor(cfg, data, email) {
      const want = String(email || '').trim().toLowerCase();
      if (!want) return null;
      const runnerDef = (cfg.runners || []).find(
        r => String(r.email || '').trim().toLowerCase() === want);
      if (!runnerDef) return null;
      const legsFor = ((data && data.runners) || []).find(r => r.id === runnerDef.id);
      const c = compute.runner(Object.assign({}, runnerDef, legsFor || { legs: [] }), cfg);
      const finished = c.totalLegs > 0 && c.legsDone === c.totalLegs;
      const mi = c.courseDist || 0;
      return {
        slug: cfg.slug || null,
        name: cfg.name || '',
        location: cfg.location || '',
        startTime: cfg.startTime || null,
        distanceMi: mi,
        elevGainFt: c.elevGainFt,
        finished,
        finishSec: finished ? c.raceSec : null,
        legsDone: c.legsDone,
        totalLegs: c.totalLegs,
        milesDone: c.milesDone,
        bucket: archive.bucketFor(mi)
      };
    },

    // Bests over finished races only. A DNF is not a personal record, and
    // pretending otherwise would make the number meaningless.
    records(results) {
      const done = (results || []).filter(r => r && r.finished && r.finishSec > 0);
      const best = (list, better) => list.reduce(
        (a, b) => (a == null || better(b, a) ? b : a), null);
      const byBucket = {};
      for (const b of archive.BUCKETS) {
        const inBucket = done.filter(r => r.bucket && r.bucket.key === b.key);
        if (inBucket.length) {
          byBucket[b.key] = { bucket: b, race: best(inBucket, (x, y) => x.finishSec < y.finishSec),
                              count: inBucket.length };
        }
      }
      return {
        byBucket,
        furthest:   best(done, (x, y) => x.distanceMi > y.distanceMi),
        mostClimb:  best(done.filter(r => r.elevGainFt != null),
                         (x, y) => x.elevGainFt > y.elevGainFt),
        longestDay: best(done, (x, y) => x.finishSec > y.finishSec),
        finishedCount: done.length
      };
    },

    // Newest first, which is the order anyone reads a history in.
    sort(results) {
      return (results || []).slice().sort((a, b) =>
        new Date(b.startTime || 0) - new Date(a.startTime || 0));
    }
  };

  // ---------- plans ----------
  // A mirror of the table in the worker, for drawing the UI. The worker is the
  // gate: it looks the plan up again on every write, so this copy being wrong,
  // stale, or edited in a console grants nothing. Getting it wrong only shows
  // somebody a control that will come back 402.
  //
  // Nothing is charged for yet. Accounts are created on pro on purpose, so the
  // machinery is exercised long before there is a checkout.
  const PLANS = {
    free: { label: 'Free', maxRunnersPerRace: 1, maxCrewPerRace: 2, privateRaces: false, shareLinks: false },
    pro:  { label: 'Pro',  maxRunnersPerRace: null, maxCrewPerRace: null, privateRaces: true, shareLinks: true }
  };

  const plans = {
    all: PLANS,
    label(plan) { return (PLANS[plan] || PLANS.pro).label; },

    // Cached for the page's life. A plan does not change while somebody is
    // looking at a race, and an extra round trip per render would.
    _ent: null,
    async entitlements() {
      if (plans._ent) return plans._ent;
      const cfg = auth.cfg();
      if (!cfg || cfg.mode !== 'proxy') {
        // Direct mode is a developer with a token, not a customer.
        plans._ent = Object.assign({ plan: 'pro' }, PLANS.pro);
        return plans._ent;
      }
      try {
        plans._ent = await api.entitlements();
      } catch (e) {
        // Assume the generous answer when it cannot be asked. The worker still
        // refuses anything that is not allowed, so the cost of being wrong here
        // is a message, not a hole.
        plans._ent = Object.assign({ plan: 'pro', unknown: true }, PLANS.pro);
      }
      return plans._ent;
    },
    forget() { plans._ent = null; },

    // Whether one more of something fits, given how many there already are.
    // Mirrors the worker: an existing overage is kept, never grown.
    fits(ent, key, wanted, existing) {
      const cap = ent && ent[key];
      if (cap == null) return true;
      if (wanted <= cap) return true;
      return wanted <= Math.max(cap, existing || 0);
    }
  };

  // ---------- roles ----------
  // Crew, Racer and Pacer all work the board during a race, so all three can
  // write; Viewer is the read-only seat. The split is not about permission,
  // it is about who a person is, which is what makes a roster readable and
  // what per-person defaults will hang off later.
  //
  // This mirrors the worker, which is the actual gate. Getting it wrong here
  // shows someone the wrong buttons; getting it wrong there would be a hole.
  const ROLES = [
    { key: 'crew',   label: 'Crew',   blurb: 'Works the aid station and logs the race' },
    { key: 'racer',  label: 'Racer',  blurb: 'Running it, and can log their own splits' },
    { key: 'pacer',  label: 'Pacer',  blurb: 'Runs with them for a stretch and can log' },
    { key: 'viewer', label: 'Viewer', blurb: 'Follows along, changes nothing' }
  ];
  const ROLE_LABEL = Object.fromEntries(ROLES.map(r => [r.key, r.label]));
  const WRITING_ROLES = new Set(['owner', 'crew', 'racer', 'pacer']);

  const roles = {
    all: ROLES,
    label(key) { return ROLE_LABEL[key] || (key === 'owner' ? 'Creator' : 'Viewer'); },
    canWrite(role) { return WRITING_ROLES.has(role); },

    // Races written before roles existed carry editors[] and viewers[], and are
    // read as the roles they always meant: an editor was crew.
    people(cfg) {
      if (!cfg) return [];
      const norm = e => String(e || '').trim().toLowerCase();
      if (Array.isArray(cfg.people)) {
        return cfg.people.filter(p => p && p.email).map(p => ({
          email: norm(p.email),
          role: ROLE_LABEL[p.role] ? p.role : 'viewer'
        }));
      }
      return [
        ...(cfg.editors || []).map(e => ({ email: norm(e), role: 'crew' })),
        ...(cfg.viewers || []).map(v => ({ email: norm(v), role: 'viewer' }))
      ].filter(p => p.email);
    },

    of(cfg, email) {
      const me = String(email || '').trim().toLowerCase();
      if (!cfg || !me) return null;
      // The worker answers this for the caller and puts it on the config it
      // hands back, so a page can know its own role without the file listing
      // everybody's address. Read straight from Pages, or from a race written
      // before that existed, myRole is absent and the roster below still
      // answers it.
      if (cfg.myRole !== undefined) return cfg.myRole;
      if (String(cfg.createdBy || '').trim().toLowerCase() === me) return 'owner';
      const p = roles.people(cfg).find(x => x.email === me);
      return p ? p.role : null;
    },

    canEdit(cfg, email) { return roles.canWrite(roles.of(cfg, email)); },

    // Handing out access is narrower than logging a split. The creator always
    // can; the rest of the team only when the creator has said so, which is off
    // until they do. The worker enforces this, the same way; here it decides
    // which controls are worth showing.
    canInvite(cfg, email) {
      if (roles.of(cfg, email) === 'owner') return true;
      return !!(cfg && cfg.teamCanInvite) && roles.canEdit(cfg, email);
    }
  };

  // ---------- offline write queue ----------
  //
  // A crew member presses "Check In" on a ridge with one bar and the write
  // fails. Before this, that press was simply lost and the only record of it
  // was whatever they remembered to type in later, from memory, hours after
  // the fact. Six-0 was logged that way and it shows.
  //
  // The trick that makes queueing safe here is that the writes are already
  // intent-shaped. Every one of them is "runner R reached leg N at time T",
  // never "here is the new data.json". So an entry stores the intent, not the
  // document: a closure cannot be put in localStorage, and replaying a whole
  // document an hour later would stomp everything anyone else logged in the
  // meantime, while "set leg 4's endTime to 2:14:07 PM" replays correctly
  // against whatever the file has become.
  //
  // The time in the entry is the time of the press, not the time of the sync.
  // That is the entire point: check a runner in at 2:14 with no signal, ride
  // back into coverage at 4:30, and the log still reads 2:14.

  const QUEUE_KEY = 'sendoff-queue-v1';
  const QUEUE_MAX_TRIES = 5;

  function findRunner(doc, runnerId, create) {
    doc.runners = doc.runners || [];
    let r = doc.runners.find(x => x.id === runnerId);
    if (!r && create) { r = { id: runnerId, legs: [] }; doc.runners.push(r); }
    return r || null;
  }

  function findLeg(runner, index, create) {
    runner.legs = runner.legs || [];
    let l = runner.legs.find(x => x.index === index);
    if (!l && create) {
      l = { index };
      runner.legs.push(l);
      runner.legs.sort((a, b) => a.index - b.index);
    }
    return l || null;
  }

  // Every queueable change, as a pure function of (document, arguments). These
  // run twice for a given entry in the normal case: once against the copy the
  // page is showing, once against the file at sync time. They must therefore
  // be idempotent and must not throw on a document that has moved on, which is
  // why a missing runner or leg is a no-op rather than an error.
  const queueOps = {
    // One press. A checkpoint closes one leg and opens the next in the same
    // instant, so both land in a single entry and can never be split.
    setLegTimes(doc, a) {
      const r = findRunner(doc, a.runnerId, true);
      for (const key of Object.keys(a.legs || {})) {
        Object.assign(findLeg(r, +key, true), a.legs[key]);
      }
    },

    // Intake and notes. A null value clears the field, which is how an emptied
    // box is told apart from one that was left alone.
    setLegFields(doc, a) {
      const r = findRunner(doc, a.runnerId, false);
      const leg = r && findLeg(r, a.legIndex, false);
      if (!leg) return;
      for (const key of Object.keys(a.fields || {})) {
        if (a.fields[key] === null) delete leg[key];
        else leg[key] = a.fields[key];
      }
    },

    // Undo of a single event.
    clearLegField(doc, a) {
      const r = findRunner(doc, a.runnerId, false);
      const leg = r && findLeg(r, a.legIndex, false);
      if (leg) delete leg[a.field];
    },

    // Undo of a send-off, which leaves a leg with nothing in it.
    removeLeg(doc, a) {
      const r = findRunner(doc, a.runnerId, false);
      if (!r || !r.legs) return;
      const i = r.legs.findIndex(l => l.index === a.legIndex);
      if (i >= 0) r.legs.splice(i, 1);
    }
  };

  // Worth waiting out, versus worth reporting. A press must never be dropped
  // because a ridge was in the way, and must never be queued forever because
  // the session expired or the account lost access, which no amount of
  // retrying will fix.
  function isTransient(err) {
    if (!err) return false;
    if (err.offline) return true;                       // fetch could not reach the network
    if (err.status == null && typeof navigator !== 'undefined' && navigator.onLine === false) return true;
    return err.status === 0 || err.status === 502 || err.status === 503 || err.status === 504;
  }

  const queueListeners = [];

  const queue = {
    all() {
      try {
        const raw = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
        return Array.isArray(raw) ? raw : [];
      } catch (e) { return []; }
    },

    save(list) {
      try { localStorage.setItem(QUEUE_KEY, JSON.stringify(list)); } catch (e) {}
      for (const fn of queueListeners) { try { fn(); } catch (e) {} }
    },

    onChange(fn) { queueListeners.push(fn); },

    // Entries still trying. Ones that gave up are counted separately, so a
    // single rejected write cannot make the banner claim the whole race is
    // unsynced.
    pending(path) {
      return queue.all().filter(e => !e.failed && (!path || e.path === path));
    },
    failed() { return queue.all().filter(e => e.failed); },

    // Replay what has not landed yet on top of a freshly-read document, so a
    // page shows the queued check-in as done. Survives a reload, which matters:
    // a phone with no signal is a phone whose browser may drop the tab.
    applyTo(path, doc) {
      for (const e of queue.pending(path)) {
        try { queueOps[e.op] && queueOps[e.op](doc, e.args); } catch (err) {}
      }
      return doc;
    },

    discardFailed() {
      queue.save(queue.all().filter(e => !e.failed));
    },

    // The one way race data gets written. Sends it now when it can, queues it
    // when it cannot, and either way the same op function does the work, so an
    // entry that syncs an hour late lands exactly what an online press would.
    async write(path, op, args, message) {
      if (!queueOps[op]) throw new Error(`Unknown queue op "${op}"`);
      const cfg = auth.cfg();
      if (!cfg) { const e = new Error('Not signed in'); e.status = 401; throw e; }

      const entry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        at: new Date().toISOString(),
        path, op, args, message, tries: 0
      };

      // Anything already waiting has to land first. Sending this one live
      // while an earlier press sits in the queue would let a correction
      // overtake the check-in it corrects.
      const blocked = queue.pending(path).length > 0
                   || (typeof navigator !== 'undefined' && navigator.onLine === false);
      if (blocked) {
        queue.save(queue.all().concat([entry]));
        queue.flush();
        return { queued: true };
      }

      try {
        await gh.mutateJson(cfg, path, (doc) => {
          queueOps[op](doc, args);
          doc.lastUpdated = new Date().toISOString();
          return doc;
        }, message);
        return { queued: false };
      } catch (err) {
        if (!isTransient(err)) throw err;
        queue.save(queue.all().concat([entry]));
        queue.flush();
        return { queued: true };
      }
    },

    // Send everything waiting, oldest first, one PUT per file. Safe to call
    // whenever: it returns immediately if there is nothing to do, no session,
    // or a flush already running.
    async flush() {
      if (queue.flushing) return;
      const cfg = auth.cfg();
      if (!cfg) return;
      const list = queue.pending();
      if (!list.length) return;

      queue.flushing = true;
      try {
        for (const path of [...new Set(list.map(e => e.path))]) {
          const batch = list.filter(e => e.path === path);
          try {
            await gh.mutateJson(cfg, path, (doc) => {
              for (const e of batch) queueOps[e.op](doc, e.args);
              doc.lastUpdated = new Date().toISOString();
              return doc;
            }, batch.length === 1
                 ? batch[0].message
                 : `${batch[0].message} (+${batch.length - 1} more queued)`);
            const done = new Set(batch.map(e => e.id));
            queue.save(queue.all().filter(e => !done.has(e.id)));
          } catch (err) {
            // Still no signal: leave the batch alone and try again later.
            if (isTransient(err)) return;
            // Rejected for a reason retrying will not fix. Count the attempt,
            // and after a few give up on it visibly rather than blocking every
            // later press behind an entry that will never land.
            const counted = new Set(batch.map(e => e.id));
            queue.save(queue.all().map(e => {
              if (!counted.has(e.id)) return e;
              const tries = (e.tries || 0) + 1;
              return { ...e, tries, failed: tries >= QUEUE_MAX_TRIES, error: err.message };
            }));
            return;
          }
        }
      } finally {
        queue.flushing = false;
      }
    }
  };

  // ---------- course helpers (loops vs. segments) ----------
  // Both course types expose a uniform per-leg accessor so render code
  // doesn't have to branch.
  //
  // A loop course may carry course.loopSegments, the aid-to-aid segments
  // of ONE lap. When present, the loop is modelled as that segment pattern
  // repeated loopCount times: total legs = loopCount × loopSegments.length.
  // When absent (or empty), each lap is a single leg, exactly as before.
  const course = {
    type(cfg) { return cfg && cfg.courseType; },

    // Per-lap segment list for a loop course ([] for a simple lap-only loop).
    loopSegments(cfg) {
      return (cfg && cfg.course && cfg.course.loopSegments) || [];
    },
    // Legs per lap: number of loop segments, or 1 for a simple loop.
    legsPerLoop(cfg) {
      return course.loopSegments(cfg).length || 1;
    },
    // Distance of one lap: sum of loop segments if present, else loopDistanceMi.
    loopDistance(cfg) {
      const segs = course.loopSegments(cfg);
      if (segs.length) return segs.reduce((a, s) => a + (s.distanceMi || 0), 0);
      return (cfg && cfg.course && cfg.course.loopDistanceMi) || 0;
    },

    legCount(cfg) {
      if (!cfg) return 0;
      if (cfg.courseType === 'loops') {
        return (cfg.course?.loopCount || 0) * course.legsPerLoop(cfg);
      }
      if (cfg.courseType === 'segments') return (cfg.course?.segments || []).length;
      return 0;
    },

    // Returns the leg definition for a 1-based index, normalized:
    // { index, name, fromAid?, toAid?, distanceMi, elevationGainFt?,
    //   elevationLossFt?, arriveCutoffHours?, cumulativeMi, lap?, segInLap? }
    legAt(cfg, index1) {
      const i = index1 - 1;
      if (!cfg || i < 0) return null;
      if (cfg.courseType === 'loops') {
        const c = cfg.course || {};
        const segs = course.loopSegments(cfg);
        const per = course.legsPerLoop(cfg);
        const total = (c.loopCount || 0) * per;
        if (index1 > total) return null;
        const lap = Math.floor(i / per) + 1;
        const segInLap = i % per;
        const isLastOfRace = index1 === total;
        if (segs.length) {
          const s = segs[segInLap];
          const loopDist = course.loopDistance(cfg);
          let cumInLap = 0;
          for (let k = 0; k <= segInLap; k++) cumInLap += (segs[k]?.distanceMi || 0);
          return {
            index: index1,
            name: `Lap ${lap} · ${s.name || `${s.fromAid || '?'} → ${s.toAid || '?'}`}`,
            fromAid: s.fromAid,
            toAid: s.toAid,
            distanceMi: s.distanceMi || 0,
            elevationGainFt: s.elevationGainFt ?? null,
            elevationLossFt: s.elevationLossFt ?? null,
            arriveCutoffHours: isLastOfRace ? (cfg.cutoffs?.totalHours || null) : null,
            crewAccess: s.crewAccess !== false,
            crewNote: s.crewNote || null,
            pacerEligible: !!s.pacerEligible,
            dropBag: !!s.dropBag,
            checkpoint: !!s.checkpoint,
            cumulativeMi: +((lap - 1) * loopDist + cumInLap).toFixed(2),
            lap, segInLap
          };
        }
        return {
          index: index1,
          name: `Lap ${lap}`,
          distanceMi: c.loopDistanceMi || 0,
          elevationGainFt: c.loopElevationGainFt || null,
          elevationLossFt: c.loopElevationGainFt || null, // loop ends where it starts
          arriveCutoffHours: isLastOfRace ? (cfg.cutoffs?.totalHours || null) : null,
          cumulativeMi: lap * (c.loopDistanceMi || 0),
          lap, segInLap: 0
        };
      }
      if (cfg.courseType === 'segments') {
        const segs = cfg.course?.segments || [];
        const s = segs[i];
        if (!s) return null;
        let cum = 0;
        for (let k = 0; k <= i; k++) cum += (segs[k]?.distanceMi || 0);
        return {
          index: index1,
          name: s.name || `${s.fromAid || '?'} → ${s.toAid || '?'}`,
          fromAid: s.fromAid,
          toAid: s.toAid,
          distanceMi: s.distanceMi || 0,
          elevationGainFt: s.elevationGainFt ?? null,
          elevationLossFt: s.elevationLossFt ?? null,
          arriveCutoffHours: s.arriveCutoffHours ?? null,
          // What the destination station offers. legAt rebuilds a leg from an
          // explicit field list rather than spreading the segment, so anything
          // added to a segment has to be named here or it never reaches a page.
          crewAccess: s.crewAccess !== false,
          crewNote: s.crewNote || null,
          pacerEligible: !!s.pacerEligible,
          dropBag: !!s.dropBag,
          checkpoint: !!s.checkpoint,
          cumulativeMi: cum
        };
      }
      return null;
    },

    legs(cfg) {
      const n = course.legCount(cfg);
      const out = [];
      for (let i = 1; i <= n; i++) out.push(course.legAt(cfg, i));
      return out;
    },

    totalDistanceMi(cfg) {
      if (!cfg) return 0;
      if (cfg.courseType === 'loops') {
        return (cfg.course?.loopCount || 0) * course.loopDistance(cfg);
      }
      if (cfg.courseType === 'segments') {
        return (cfg.course?.segments || []).reduce((a, s) => a + (s.distanceMi || 0), 0);
      }
      return 0;
    },

    // Derive [{name, mileage}] aid stations from consecutive fromAid/toAid
    // pairs. For segments this is the whole course; for loops it's one lap.
    aidStations(cfg) {
      if (!cfg) return [];
      let segs = [];
      if (cfg.courseType === 'segments') segs = cfg.course?.segments || [];
      else if (cfg.courseType === 'loops') segs = course.loopSegments(cfg);
      if (!segs.length) return [];
      // Each station carries what it offers, taken from the segment that
      // arrives at it, so this and segmentsFromAidStations are proper inverses.
      // An editor that reads one and writes the other used to lose every
      // setting on the way through.
      //
      // The start is the exception: nothing arrives at it, so it has no segment
      // to hang anything on and keeps its own. Without this you could tick a
      // drop bag at the start, watch it tick, and find it gone on the next
      // load, which is worse than not offering it.
      const out = [{ ...course.startAid(cfg), name: segs[0].fromAid || 'Start', mileage: 0 }];
      let cum = 0;
      for (const s of segs) {
        cum += (s.distanceMi || 0);
        out.push({
          name: s.toAid || `Aid ${out.length}`,
          mileage: +cum.toFixed(2),
          crewAccess: s.crewAccess !== false,
          crewNote: s.crewNote || null,
          pacerEligible: !!s.pacerEligible,
          dropBag: !!s.dropBag,
          checkpoint: !!s.checkpoint
        });
      }
      return out;
    },

    // What the start offers. A checkpoint is not among them: a checkpoint is a
    // place you are timed through, and nobody passes the start.
    startAid(cfg) {
      const a = (cfg && cfg.course && cfg.course.startAid) || {};
      return {
        crewAccess: a.crewAccess !== false,
        crewNote: a.crewNote || null,
        pacerEligible: !!a.pacerEligible,
        dropBag: !!a.dropBag,
        checkpoint: false
      };
    },

    // The inverse of startAid: an editor row in, the stored shape out.
    startAidFrom(row) {
      row = row || {};
      return {
        crewAccess: row.crewAccess !== false,
        crewNote: (row.crewNote || '').trim() || null,
        pacerEligible: !!row.pacerEligible,
        dropBag: !!row.dropBag
      };
    },

    // Anything about the start worth telling a crew, or nothing.
    startAidTags(cfg) {
      const a = course.startAid(cfg);
      return (!a.crewAccess || a.crewNote || a.pacerEligible || a.dropBag) ? a : null;
    },

    // Rebuild segments[] from an aid-station list [{name, mileage, arriveCutoffHours?}].
    // The start aid contributes only its name to seg[0].fromAid; downstream aids
    // become toAid for the segment and fromAid for the next.
    segmentsFromAidStations(aids, prevSegments) {
      const out = [];
      for (let i = 0; i < aids.length - 1; i++) {
        const from = aids[i], to = aids[i + 1];
        const dist = +(to.mileage - from.mileage).toFixed(2);
        // Elevation is a fact about a stretch of ground, so it survives anything
        // that leaves that stretch alone. Matching on the names meant renaming a
        // station threw away the climb on both sides of it; matching on the
        // distance keeps it through a rename and still drops it when a station
        // is inserted, moved, or remeasured, which is when it really is stale.
        const prev = (prevSegments && prevSegments[i]) || {};
        const matched = prev.distanceMi != null && Math.abs(prev.distanceMi - dist) < 0.005;
        out.push({
          name: `${from.name} → ${to.name}`,
          fromAid: from.name,
          toAid: to.name,
          distanceMi: dist,
          elevationGainFt: matched ? (prev.elevationGainFt ?? null) : null,
          elevationLossFt: matched ? (prev.elevationLossFt ?? null) : null,
          arriveCutoffHours: to.arriveCutoffHours ?? null,
          // What the aid station at the far end of this segment offers. These
          // describe the destination, not the running, which is why they ride
          // on the segment that arrives there rather than the one that leaves.
          crewAccess: to.crewAccess !== false,
          crewNote: to.crewNote || null,
          pacerEligible: !!to.pacerEligible,
          dropBag: !!to.dropBag,
          checkpoint: !!to.checkpoint
        });
      }
      return out;
    },

    // Fill each segment's climb from a course GPX.
    //
    // Two rules, in this order. A number already on the segment is never
    // touched: that is somebody typing the race's published climb, and a
    // published figure beats arithmetic over a trace every time. And where an
    // official total is given, the trace only decides which segments are the
    // steep ones while that total sets the scale, so the parts still sum to
    // the number on the race's own website.
    //
    // Without a GPX there is no shape to go on, so an official total is spread
    // by distance. That makes the total right and the split a guess, which is
    // the correct trade: the total is the number people quote.
    fillSegmentElevation(segments, gpxPts, officialGainFt) {
      const segs = segments || [];
      if (!segs.length) return segs;
      const havePts = !!(gpxPts && gpxPts.length > 8);
      const official = (officialGainFt != null && isFinite(officialGainFt) && officialGainFt > 0)
        ? officialGainFt : null;
      if (!havePts && official === null) return segs;

      // Derive a gain/loss for every segment that has not been given one.
      const derived = [];
      let cum = 0;
      for (const s of segs) {
        const from = cum;
        cum += (s.distanceMi || 0);
        if (s.elevationGainFt != null) { derived.push(null); continue; }
        derived.push(havePts
          ? gpx.elevationBetween(gpxPts, from, cum)
          : { gainFt: (s.distanceMi || 0), lossFt: (s.distanceMi || 0) });  // shapeless: weight by distance
      }

      let k = 1;
      if (official !== null) {
        const fixed = segs.reduce((n, s) => n + (s.elevationGainFt || 0), 0);
        const loose = derived.reduce((n, d) => n + (d ? d.gainFt : 0), 0);
        k = loose > 0 ? Math.max(0, official - fixed) / loose : 0;
      }

      segs.forEach((s, i) => {
        const d = derived[i];
        if (!d) return;
        s.elevationGainFt = Math.round(d.gainFt * k);
        s.elevationLossFt = Math.round(d.lossFt * k);
      });
      return segs;
    }
  };

  // What waits at the end of a leg. A checkpoint is a timing point with no aid:
  // it is reached, not worked, so it takes one press instead of in and out.
  function stationAt(cfg, legIndex) {
    const def = course.legAt(cfg, legIndex);
    if (!def) return null;
    return {
      name: def.toAid || null,
      checkpoint: !!def.checkpoint,
      crewAccess: def.crewAccess !== false,
      crewNote: def.crewNote || null,
      pacerEligible: !!def.pacerEligible,
      dropBag: !!def.dropBag
    };
  }

  // ---------- fuel metrics ----------
  // What a race tracks per leg. Calories, fluid and sodium are the default, but
  // they are only a default: a race can add carbs or drop one it never fills
  // in. Everything downstream, the pit inputs, the leg log columns, the charts
  // and the print report, reads this list rather than naming the three.
  //
  // Races written before this existed carry targets.caloriesPerHour and its
  // siblings and no fuelMetrics, so the default list is derived from those and
  // nothing has to be migrated.
  // A target is a positive number or it is not a target. Blank, zero, a string
  // that is not a number: all mean "no goal set", which reads differently from
  // a goal of zero and is the only sense any of the callers want.
  function num(v) {
    if (v == null || v === '') return null;
    const n = +v;
    return (Number.isFinite(n) && n > 0) ? n : null;
  }

  const DEFAULT_FUEL = [
    { key: 'calories', label: 'Calories', unit: 'cal', short: 'Cal',   decimals: 0, step: 10 },
    { key: 'fluidOz',  label: 'Fluid',    unit: 'oz',  short: 'Fluid', decimals: 1, step: 1 },
    { key: 'sodiumMg', label: 'Sodium',   unit: 'mg',  short: 'Na',    decimals: 0, step: 50 }
  ];

  const fuel = {
    // The one list every fuel-shaped thing reads: the pit inputs, the leg log
    // columns, the per-hour bars, the charts and the printed report. Add Carbs
    // here and it appears in all of them.
    //
    // An absent cfg.fuelMetrics means "never configured", which is every race
    // written before this existed, so it gets the default three. An empty array
    // is a decision: the crew turned fuel tracking off, and that is honoured.
    //
    // Targets stay in cfg.targets under `<key>PerHour`, which is where the
    // original three already lived, so no race needs rewriting to keep its
    // goals.
    metrics(cfg, elapsedHours) {
      const listed = cfg && Array.isArray(cfg.fuelMetrics) ? cfg.fuelMetrics : DEFAULT_FUEL;
      const t = (cfg && cfg.targets) || {};
      const banded = elapsedHours != null && fuel.bands(cfg).length;
      return listed.filter(m => m && m.key).map(m => {
        const targetKey = m.key + 'PerHour';
        const flat = num(t[targetKey]);
        return {
          key: m.key,
          label: m.label || m.key,
          unit: m.unit || '',
          short: m.short || m.label || m.key,
          decimals: m.decimals != null ? +m.decimals : 0,
          step: m.step != null ? +m.step : 1,
          targetKey,
          // The flat goal, always: the editors edit this one.
          targetPerHour: flat,
          // What to hold a cumulative average against, once hours are known.
          expectedPerHour: banded ? fuel.expectedAverage(cfg, m.key, elapsedHours) : flat,
          // What they should be taking right now.
          targetNow: banded ? fuel.targetAt(cfg, m.key, elapsedHours) : flat
        };
      });
    },

    // Goals, hour bands and crew notes belong to a runner rather than to a
    // race: two people on the same course do not eat the same way, and what one
    // wants their crew to know is not what the other does. What stays on the
    // race is the list of metrics itself, because that is the shape of the
    // board, and the shorthand, because a flask is a flask whoever drinks it.
    //
    // This hands back a cfg-shaped view with the runner's three swapped in, so
    // every reader below still takes one object and reads cfg.targets. A race
    // written before this carries one set at the top level and no runner
    // carries any, so each of them falls back to it and nothing is migrated.
    //
    // The fallback is by presence of the key, not by emptiness: a runner who
    // has deliberately cleared their bands has an empty array and keeps it,
    // rather than quietly inheriting the race's.
    forRunner(cfg, runner) {
      const r = runner || {};
      const view = Object.assign({}, cfg);
      if (r.targets !== undefined) view.targets = r.targets;
      if (r.phaseTargets !== undefined) view.phaseTargets = r.phaseTargets;
      if (r.crewNotes !== undefined) view.crewNotes = r.crewNotes;
      return view;
    },

    // What this runner wants their crew to know, or the race's note if they
    // have not said anything of their own.
    notesFor(cfg, runner) {
      return String(fuel.forRunner(cfg, runner).crewNotes || '').trim();
    },

    // Whether every runner on this race resolves to the same goals and the same
    // bands. A single line drawn across a chart of everyone's intake is honest
    // only when they agree; when they do not, there is no one goal to draw.
    plansAgree(cfg) {
      const rs = (cfg && cfg.runners) || [];
      if (rs.length < 2) return true;
      const sig = (r) => {
        const v = fuel.forRunner(cfg, r);
        return JSON.stringify([v.targets || {}, fuel.bands(v)]);
      };
      const first = sig(rs[0]);
      return rs.every(r => sig(r) === first);
    },

    // Hour-banded goals: 275 an hour for the first six, 180 after that. Sorted
    // and de-duplicated so every reader can take the last band whose start hour
    // has passed. A band that does not name a metric leaves that metric on the
    // race's flat goal, so adding a band for calories does not silently drop
    // the sodium target.
    bands(cfg) {
      const list = cfg && Array.isArray(cfg.phaseTargets) ? cfg.phaseTargets : [];
      return list
        .filter(b => b && Number.isFinite(+b.fromHour) && +b.fromHour >= 0)
        .map(b => ({
          fromHour: +b.fromHour,
          label: typeof b.label === 'string' ? b.label : '',
          targets: (b.targets && typeof b.targets === 'object') ? b.targets : {}
        }))
        .sort((a, b) => a.fromHour - b.fromHour);
    },

    bandAt(cfg, hours) {
      const bands = fuel.bands(cfg);
      let found = null;
      for (const b of bands) { if (b.fromHour <= hours) found = b; else break; }
      return found;
    },

    // The goal in force at a given hour, falling back through earlier bands and
    // then to the race's flat goal.
    targetAt(cfg, key, hours) {
      const bands = fuel.bands(cfg);
      const tk = key + 'PerHour';
      for (let i = bands.length - 1; i >= 0; i--) {
        if (bands[i].fromHour > hours) continue;
        const v = num(bands[i].targets[tk]);
        if (v != null) return v;
      }
      return num(((cfg && cfg.targets) || {})[tk]);
    },

    // What the average should be by now, which is the thing a cumulative
    // "per hour so far" number can honestly be held against. Six hours at 275
    // followed by two at 180 is not a 180 race and is not a 275 race; it is a
    // 251 race, and that is the line the bar should be measured against.
    expectedAverage(cfg, key, elapsedHours) {
      const h = +elapsedHours;
      if (!Number.isFinite(h) || h <= 0) return fuel.targetAt(cfg, key, 0);
      const edges = [0, ...fuel.bands(cfg).map(b => b.fromHour).filter(x => x > 0 && x < h), h];
      let weighted = 0, covered = 0, sawOne = false;
      for (let i = 0; i < edges.length - 1; i++) {
        const span = edges[i + 1] - edges[i];
        if (span <= 0) continue;
        const t = fuel.targetAt(cfg, key, edges[i]);
        if (t == null) continue;      // an uncovered stretch is not counted as zero
        sawOne = true;
        weighted += t * span;
        covered += span;
      }
      if (!sawOne || covered <= 0) return null;
      return weighted / covered;
    },

    // A metric's key is what every logged leg stores its number under, so it is
    // derived once, at save, and then never follows the label. Renaming
    // "Calories" to "Cals" relabels a column; it does not orphan a season of
    // logged data. Deriving it from the label means the built-in three keep the
    // keys they have always had: "Fluid oz" comes back out as fluidOz.
    keyFor(label, taken) {
      const base = (slug(label) || 'metric').replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
      let cand = base, n = 2;
      while (taken && taken.has(cand)) cand = base + (n++);
      return cand;
    },

    // Editor rows in, config-shaped metrics out: blank rows dropped, missing
    // keys filled in, and the per-hour goals split off into a targets object
    // since that is where every reader looks for them.
    fromRows(rows) {
      const named = (rows || []).filter(r => r && (r.label || '').trim());
      const taken = new Set(named.map(r => r.key).filter(Boolean));
      const metrics = [], targets = {};
      for (const r of named) {
        const key = r.key || fuel.keyFor(r.label, taken);
        taken.add(key);
        metrics.push({
          key,
          label: (r.label || '').trim(),
          unit: (r.unit || '').trim(),
          short: (r.short || '').trim() || (r.label || '').trim(),
          decimals: r.decimals != null ? +r.decimals : 0,
          step: r.step != null ? +r.step : 1
        });
        targets[key + 'PerHour'] = parseFloat(r.target) || 0;
      }
      return { metrics, targets };
    },

    // The inverse: a config back into editable rows, goals included.
    toRows(cfg) {
      return fuel.metrics(cfg).map(m => ({
        key: m.key, label: m.label, unit: m.unit, short: m.short,
        decimals: m.decimals, step: m.step,
        target: m.targetPerHour ?? ''
      }));
    },

    // What a metric editor writes back: strip the derived fields so the config
    // keeps only what was authored.
    strip(list) {
      return (list || []).filter(m => m && m.key).map(m => ({
        key: m.key, label: m.label, unit: m.unit, short: m.short,
        decimals: m.decimals, step: m.step
      }));
    },

    // Band editor rows in, config-shaped bands out, filtered against the metrics
    // that survived the same save. A band that names no metric at all is not a
    // band, and a band carrying a number for a metric the race no longer tracks
    // would sit in the file forever without ever being read.
    bandsFromRows(rows, metrics) {
      const live = new Set((metrics || []).map(m => m.key + 'PerHour'));
      const seen = new Set();
      return (rows || [])
        .map(b => ({
          fromHour: Math.round((+b.fromHour || 0) * 4) / 4,   // quarter-hour resolution
          label: String(b.label || '').trim().slice(0, 60),
          targets: Object.fromEntries(Object.entries(b.targets || {})
            .filter(([k, v]) => live.has(k) && num(v) != null)
            .map(([k, v]) => [k, +v]))
        }))
        .filter(b => Number.isFinite(b.fromHour) && b.fromHour >= 0 && Object.keys(b.targets).length)
        .filter(b => !seen.has(b.fromHour) && seen.add(b.fromHour))
        .sort((a, b) => a.fromHour - b.fromHour);
    },

    // Bands are keyed by the hour they start, so two cannot start at the same
    // time and bandsFromRows keeps the first of any pair. That is the right
    // rule and a terrible surprise, so an editor can ask first: this names the
    // rows that would lose, and what they would take with them.
    bandCollisions(rows, metrics) {
      const kept = new Map();
      const lost = [];
      for (const b of (rows || [])) {
        const cleaned = fuel.bandsFromRows([b], metrics)[0];
        if (!cleaned) continue;                 // empty rows are dropped anyway
        if (kept.has(cleaned.fromHour)) lost.push({ band: cleaned, keeps: kept.get(cleaned.fromHour) });
        else kept.set(cleaned.fromHour, cleaned);
      }
      return lost;
    },

    // Shorthand editor rows in, config-shaped presets out, filtered against the
    // metrics that survived the same save. Removing Fluid should not leave every
    // shorthand carrying an orphaned fluid number, and a shorthand with nothing
    // left in it is not a shorthand.
    presetsFromRows(rows, metrics) {
      const live = new Set((metrics || []).map(m => m.key));
      return (rows || [])
        .filter(p => p && (p.name || '').trim())
        .map(p => ({
          name: p.name.trim(),
          values: Object.fromEntries(Object.entries(p.values || {})
            .filter(([k, v]) => live.has(k) && +v)
            .map(([k, v]) => [k, +v]))
        }))
        .filter(p => Object.keys(p.values).length);
    },

    // Quick-add buttons on the pit form: one tap adds a flask, two taps two.
    // A preset is { name, values: { <metricKey>: amount } }.
    presets(cfg) {
      const list = cfg && Array.isArray(cfg.fuelPresets) ? cfg.fuelPresets : [];
      return list.filter(p => p && p.name && p.values && typeof p.values === 'object');
    },

    // "Fluid oz" and "Sodium mg" earn the unit; "Calories cal" does not, because
    // the label already opens with it. Used wherever a metric names a field.
    fieldLabel(m) {
      const u = (m.unit || '').trim();
      if (!u) return m.label;
      return m.label.toLowerCase().startsWith(u.toLowerCase()) ? m.label : m.label + ' ' + u;
    },

    // A column header for a grid you type numbers into. The short name alone
    // does not say whether Fluid wants ounces or millilitres, and someone
    // entering a flask needs to know that before they type.
    colHead(m, esc) {
      const e = esc || (v => String(v == null ? '' : v));
      return e(m.short) + (m.unit ? `<span class="th-unit">${e(m.unit)}</span>` : '');
    },

    round(m, v) {
      const n = +v;
      if (!isFinite(n)) return 0;
      return m.decimals ? +n.toFixed(m.decimals) : Math.round(n);
    },

    // A number for a person to read: "420cal", "18.5oz", "1,200mg".
    fmt(m, v) {
      if (v == null || v === '') return '\u2013';
      const n = +v;
      if (!isFinite(n)) return '\u2013';
      const body = m.decimals ? n.toFixed(m.decimals) : Math.round(n).toLocaleString();
      return body + (m.unit || '');
    },

    total(legs, key) {
      return (legs || []).reduce((a, l) => a + (+l[key] || 0), 0);
    }
  };

  // ---------- compute (runner state, intake, projection) ----------
  const compute = {
    runner(runner, cfg) {
      const legs = (runner.legs || []).slice().sort((a, b) => a.index - b.index);
      const now = new Date();
      const totalLegs = course.legCount(cfg);
      const courseDist = course.totalDistanceMi(cfg);

      const legDurations = [];          // seconds per completed leg, keyed by position in legs
      const legDistances = [];          // miles per completed leg, parallel to legDurations
      const pitDurations = [];          // seconds in aid/pit between consecutive legs
      let elevGainFt = 0, elevLossFt = 0, hasElev = false;  // climbed over completed legs
      for (let i = 0; i < legs.length; i++) {
        const l = legs[i];
        if (l.startTime && l.endTime) {
          legDurations.push((new Date(l.endTime) - new Date(l.startTime)) / 1000);
          const def = course.legAt(cfg, l.index);
          legDistances.push(def?.distanceMi || 0);
          if (def && def.elevationGainFt != null) { elevGainFt += def.elevationGainFt; hasElev = true; }
          if (def && def.elevationLossFt != null) { elevLossFt += def.elevationLossFt; }
        }
        const next = legs[i + 1];
        if (l.endTime && next && next.startTime) {
          pitDurations.push((new Date(next.startTime) - new Date(l.endTime)) / 1000);
        }
      }

      const inProgressLeg = legs.find(l => l.startTime && !l.endTime);
      const currentLegSeconds = inProgressLeg
        ? Math.max(0, (now - new Date(inProgressLeg.startTime)) / 1000)
        : 0;
      const lastCompleted = [...legs].reverse().find(l => l.startTime && l.endTime);
      const nextStarted = lastCompleted
        ? legs.some(l => l.startTime && new Date(l.startTime) > new Date(lastCompleted.endTime))
        : false;
      const legsDone = legDurations.length;
      const inPit = !!lastCompleted && !nextStarted && legsDone < totalLegs;
      const currentPitSeconds = inPit
        ? Math.max(0, (now - new Date(lastCompleted.endTime)) / 1000)
        : 0;

      const completedCourseSec = legDurations.reduce((a, b) => a + b, 0);
      const completedPitSec    = pitDurations.reduce((a, b) => a + b, 0);
      const completedRaceSec   = completedCourseSec + completedPitSec;
      const totalCourseSec     = completedCourseSec + currentLegSeconds;
      const totalPitSec        = completedPitSec + currentPitSeconds;
      const raceSec            = totalCourseSec + totalPitSec;

      const milesDone = legDistances.reduce((a, b) => a + b, 0);
      const legHours  = completedCourseSec / 3600;
      const avgLegSec = legDurations.length
        ? completedCourseSec / legDurations.length : null;
      const lastLegSec = legDurations.length
        ? legDurations[legDurations.length - 1] : null;
      const avgPitSec = pitDurations.length
        ? completedPitSec / pitDurations.length : null;
      const lastPitSec = pitDurations.length
        ? pitDurations[pitDurations.length - 1] : null;

      // Pace: total course seconds ÷ total miles done. Honest across uneven legs.
      const paceSecPerMile = milesDone > 0 ? completedCourseSec / milesDone : null;

      // Intake aggregates over completed legs only.
      const completedEntries = legs.filter(l => l.startTime && l.endTime);
      // Keyed by metric so a race that tracks Carbs gets the same treatment as
      // one that tracks Calories, with no name of any particular fuel in here.
      const intake = {};
      for (const m of fuel.metrics(cfg)) {
        const total = completedEntries.reduce((a, l) => a + (+l[m.key] || 0), 0);
        intake[m.key] = { total, perHour: legHours > 0 ? total / legHours : 0 };
      }

      // Projection: extrapolate avg leg+pit rate over remaining legs by mileage.
      // For loops this matches the old (avgLap + avgPit) × totalLoops formula;
      // for segments it correctly weights by leg length.
      let projectedFinishSec = null;
      if (legsDone >= totalLegs && totalLegs > 0) {
        projectedFinishSec = completedRaceSec;
      } else if (legsDone > 0 && courseDist > 0) {
        const secPerMile = completedRaceSec / milesDone;
        projectedFinishSec = secPerMile * courseDist;
      }

      const cutoffSec = (cfg.cutoffs?.totalHours || 0) * 3600;
      let status = 'notstarted';
      if (legsDone >= totalLegs && totalLegs > 0) status = 'finished';
      else if (projectedFinishSec != null && cutoffSec > 0) {
        const tightThreshold = cutoffSec * (1 - 0.025);
        if (projectedFinishSec > cutoffSec) status = 'offpace';
        else if (projectedFinishSec > tightThreshold) status = 'tight';
        else status = 'onpace';
      } else if (inProgressLeg) status = 'onpace';

      let liveSince = null, liveLegIndex = null;
      if (inProgressLeg) {
        liveSince = inProgressLeg.startTime;
        liveLegIndex = inProgressLeg.index;
      } else if (inPit && lastCompleted) {
        liveSince = lastCompleted.endTime;
        liveLegIndex = lastCompleted.index;
      }

      return {
        legs, legsDone, totalLegs, milesDone, courseDist,
        elevGainFt: hasElev ? elevGainFt : null,
        elevLossFt: hasElev ? elevLossFt : null,
        raceSec, totalCourseSec, totalPitSec,
        completedRaceSec, completedCourseSec, completedPitSec,
        currentLegSeconds, currentPitSeconds,
        avgLegSec, lastLegSec, avgPitSec, lastPitSec, paceSecPerMile,
        intake,
        legDurations, pitDurations, legDistances,
        status, projectedFinishSec,
        inPit, inProgressLeg: !!inProgressLeg,
        liveSince, liveLegIndex
      };
    },

    // Derives "what should the runner press next" from their legs.
    // For both course types: the leg array's last entry tells us whether
    // they're on course or in aid.
    nextActionFor(runner, cfg) {
      const legs = (runner.legs || []).slice().sort((a, b) => a.index - b.index);
      const totalLegs = course.legCount(cfg);
      if (!legs.length) {
        return { state: 'idle', currentLegIndex: 0, nextAction: 'out', nextLegIndex: 1, lastTs: null };
      }
      const events = [];
      for (const l of legs) {
        if (l.startTime) events.push({ ts: new Date(l.startTime).getTime(), idx: l.index, action: 'out', seq: 0, raw: l.startTime });
        if (l.endTime)   events.push({ ts: new Date(l.endTime).getTime(),   idx: l.index, action: 'in',  seq: 1, raw: l.endTime });
      }
      events.sort((a, b) => (a.ts - b.ts) || (a.idx - b.idx) || (a.seq - b.seq));
      const last = events[events.length - 1] || null;
      let bestTs = last ? last.raw : null;
      let bestAction = last ? last.action : null;
      let bestIdx = last ? last.idx : null;
      if (!bestTs) {
        return { state: 'idle', currentLegIndex: 0, nextAction: 'out', nextLegIndex: 1, lastTs: null };
      }
      if (bestAction === 'out') {
        return { state: 'on-course', currentLegIndex: bestIdx, nextAction: 'in', nextLegIndex: bestIdx, lastTs: bestTs };
      }
      // bestAction === 'in'
      if (bestIdx >= totalLegs) {
        return { state: 'finished', currentLegIndex: bestIdx, nextAction: null, nextLegIndex: null, lastTs: bestTs };
      }
      return { state: 'in-pit', currentLegIndex: bestIdx, nextAction: 'out', nextLegIndex: bestIdx + 1, lastTs: bestTs };
    },

    // Estimates a runner's current cumulative position along the course.
    // idle → 0; finished → full distance; in-pit / at an aid → exact aid
    // mileage; on-course → interpolated along the current leg from average
    // pace (a projection, flagged with est:true, not a GPS fix).
    // Returns { courseMi, state, est }.
    predictedMileage(runner, cfg) {
      const c = compute.runner(runner, cfg);
      const next = compute.nextActionFor(runner, cfg);
      const totalMi = course.totalDistanceMi(cfg);
      if (next.state === 'idle') return { courseMi: 0, state: 'idle', est: false };
      if (next.state === 'finished') return { courseMi: totalMi, state: 'finished', est: false };
      if (next.state === 'in-pit') {
        const def = course.legAt(cfg, next.currentLegIndex);
        return {
          courseMi: def ? def.cumulativeMi : c.milesDone,
          state: 'in-pit', est: false,
          atAid: (def && def.toAid) || null
        };
      }
      const def = course.legAt(cfg, next.currentLegIndex);
      if (!def) return { courseMi: c.milesDone, state: 'on-course', est: true };
      const legStartMi = def.cumulativeMi - def.distanceMi;
      const leg = (runner.legs || []).find(l =>
        l.index === next.currentLegIndex && l.startTime && !l.endTime);
      if (!leg) return { courseMi: legStartMi, state: 'on-course', est: true };
      const elapsed = (Date.now() - new Date(leg.startTime).getTime()) / 1000;
      let frac = 0;
      if (c.paceSecPerMile && def.distanceMi > 0) {
        frac = Math.max(0, Math.min(1, elapsed / (c.paceSecPerMile * def.distanceMi)));
      }
      return { courseMi: legStartMi + frac * def.distanceMi, state: 'on-course', est: true };
    }
  };

  // ---------- GPX ----------
  const gpx = {
    // A course that passes the same aid station four times puts four dots on
    // the map a few metres apart, which reads as four stations rather than as
    // one visited four times. This groups the ones that are plainly the same
    // place and hands back a single point for each.
    //
    // Single-link at a fixed radius: A joins a group if it is close to any
    // member, not only to the first one seen, so a chain of passes spread over
    // a couple of hundred metres still comes out as one station. The default
    // radius is generous next to GPS noise and the nearest-track-point lookup,
    // and tight next to any two aid stations a race would actually pitch
    // separately.
    //
    // The point is the median of the members rather than the mean, so one pass
    // whose nearest track point landed up the trail moves the dot by nothing.
    clusterStops(stops, meters) {
      const R = meters == null ? 250 : meters;
      const list = (stops || []).filter(s => s && isFinite(s.lat) && isFinite(s.lon));
      const groups = [];
      for (const s of list) {
        const hit = groups.find(g => g.members.some(m =>
          gpx.haversine(m.lat, m.lon, s.lat, s.lon) * 1609.34 <= R));
        if (hit) hit.members.push(s);
        else groups.push({ members: [s] });
      }
      const median = (nums) => {
        const a = nums.slice().sort((x, y) => x - y);
        const i = Math.floor(a.length / 2);
        return a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2;
      };
      for (const g of groups) {
        g.lat = median(g.members.map(m => m.lat));
        g.lon = median(g.members.map(m => m.lon));
      }
      return groups;
    },

    haversine(lat1, lon1, lat2, lon2) {
      const R = 3958.8; // miles
      const toRad = d => d * Math.PI / 180;
      const dLat = toRad(lat2 - lat1);
      const dLon = toRad(lon2 - lon1);
      const a = Math.sin(dLat/2)**2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
      return 2 * R * Math.asin(Math.sqrt(a));
    },

    // Parse GPX XML into [{lat, lon, ele (meters), dist (miles cum)}].
    parse(xmlText) {
      const xml = new DOMParser().parseFromString(xmlText, 'text/xml');
      if (xml.querySelector('parsererror')) throw new Error('Invalid GPX');
      const trkpts = Array.from(xml.querySelectorAll('trkpt'));
      if (!trkpts.length) throw new Error('GPX has no trkpt points');
      const pts = trkpts.map(p => {
        const eleEl = p.querySelector('ele');
        return {
          lat: parseFloat(p.getAttribute('lat')),
          lon: parseFloat(p.getAttribute('lon')),
          ele: eleEl ? parseFloat(eleEl.textContent) : 0
        };
      });
      pts[0].dist = 0;
      let cum = 0;
      for (let i = 1; i < pts.length; i++) {
        cum += gpx.haversine(pts[i-1].lat, pts[i-1].lon, pts[i].lat, pts[i].lon);
        pts[i].dist = cum;
      }
      return pts;
    },

    metersToFeet(m) { return m * 3.28084; },

    // A change is only banked once it clears this much from the last committed
    // elevation. Summing every raw delta measures the file, not the course: a
    // denser or noisier trace of the same route returns a bigger number with no
    // ceiling. Two GPX files of Sangre de Cristo, same summits to within 30 ft,
    // gave 15,465 and 26,685 ft that way; the denser one sampled every 39 ft
    // instead of 106 and wiggled four times as much over any 100 ft of trail,
    // and every wiggle was banked as climb.
    //
    // 15 ft is chosen to sit above that noise and below real terrain. It takes
    // about 20% off a noisy trace and about 4% off a clean one, which is the
    // right shape: it removes jitter, not hills. It does not make the two files
    // agree, and nothing would. Where a course has a published climb figure,
    // that number is better than any arithmetic over a GPX, so a value entered
    // by hand always wins over this one.
    ELEV_NOISE_FT: 15,

    // Gain and loss over the cumulative-mileage range [fromMi, toMi].
    elevationBetween(pts, fromMi, toMi) {
      const thresh = gpx.ELEV_NOISE_FT / 3.28084;   // to metres, as pts are
      let gainM = 0, lossM = 0;
      let ref = null;
      for (const p of pts) {
        if (p.dist < fromMi) continue;
        if (p.dist > toMi) break;
        if (ref === null) { ref = p.ele; continue; }
        const dz = p.ele - ref;
        if (dz > thresh) { gainM += dz; ref = p.ele; }
        else if (dz < -thresh) { lossM += -dz; ref = p.ele; }
      }
      return {
        gainFt: Math.round(gpx.metersToFeet(gainM)),
        lossFt: Math.round(gpx.metersToFeet(lossM))
      };
    },

    totalDistanceMi(pts) { return pts.length ? pts[pts.length - 1].dist : 0; },

    totalElevation(pts) {
      return gpx.elevationBetween(pts, 0, gpx.totalDistanceMi(pts) + 1);
    }
  };

  // ---------- account bar ----------
  // Puts the account menu in the top right of header.site, level with the
  // wordmark. It used to be its own strip above the header carrying the signed
  // in address, but the menu shows the address, so a whole row was being spent
  // on a repeat.
  // on every page. In direct/PAT mode (no proxy) it stays hidden, since there
  // are no accounts. Auto-mounts on DOM ready; also exposed for manual calls.

  // ---------- modals ----------
  // Builds a fresh modal overlay; returns refs. close() removes it from the DOM.
  function createModal(title, primaryLabel) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML =
      '<div class="modal-box" role="dialog" aria-modal="true">' +
        '<div class="modal-title"></div>' +
        '<div class="modal-body"></div>' +
        '<div class="modal-msg"></div>' +
        '<div class="modal-actions">' +
          '<button type="button" class="btn modal-cancel">Cancel</button>' +
          '<button type="button" class="btn primary modal-primary"></button>' +
        '</div>' +
      '</div>';
    overlay.querySelector('.modal-title').textContent = title;
    overlay.querySelector('.modal-primary').textContent = primaryLabel;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    overlay.querySelector('.modal-cancel').addEventListener('click', close);
    return {
      overlay,
      body: overlay.querySelector('.modal-body'),
      msg: overlay.querySelector('.modal-msg'),
      primary: overlay.querySelector('.modal-primary'),
      setMsg(text, cls) { overlay.querySelector('.modal-msg').textContent = text; overlay.querySelector('.modal-msg').className = 'modal-msg ' + (cls || ''); },
      close
    };
  }

  // Change-password modal: opened from the account bar.
  // ---------- feedback ----------
  // A form that works with no signal, because the person most worth hearing
  // from is often the one who has none. A report that cannot be sent is held
  // on the device and goes out when the signal does.
  const feedback = {
    KEY: 'so:feedback',

    // The number bumped on every change to race-core, read off the script tag
    // that loaded it. It is the one thing that says which build somebody was
    // actually running, which is the difference between a report you can act
    // on and one you cannot.
    version() {
      const el = document.querySelector('script[src*="race-core.js"]');
      const m = el && /[?&]v=([\w.-]+)/.exec(el.getAttribute('src') || '');
      return m ? 'v' + m[1] : 'unknown';
    },

    context() {
      let queued = 0;
      try { queued = queue.pending().length; } catch (e) {}
      return {
        page: String(location.pathname + location.search).slice(0, 300),
        race: (typeof qs === 'function' ? qs('id') : null) || '',
        version: feedback.version(),
        offline: (typeof navigator !== 'undefined' && navigator.onLine === false) || offline.stale,
        queued
      };
    },

    held() {
      if (typeof localStorage === 'undefined') return [];
      try { const a = JSON.parse(localStorage.getItem(feedback.KEY) || '[]'); return Array.isArray(a) ? a : []; }
      catch (e) { return []; }
    },
    hold(row) {
      if (typeof localStorage === 'undefined') return;
      // Ten is already more than anyone writes in one outage, and the cap
      // stops a broken send loop from filling a phone.
      try { localStorage.setItem(feedback.KEY, JSON.stringify([...feedback.held(), row].slice(-10))); }
      catch (e) {}
    },
    setHeld(rows) {
      if (typeof localStorage === 'undefined') return;
      try {
        if (rows.length) localStorage.setItem(feedback.KEY, JSON.stringify(rows));
        else localStorage.removeItem(feedback.KEY);
      } catch (e) {}
    },

    // Sends, or holds it for later and says which happened.
    async send(row) {
      try { await api.sendFeedback(row); return true; }
      catch (e) {
        // A rejection is the point of the queue; a refusal is not. A message
        // the server will never accept must not be retried forever.
        if (e && e.status && e.status !== 429) throw e;
        feedback.hold(row);
        return false;
      }
    },

    // Anything held, on the next load and whenever the signal returns.
    async flush() {
      const rows = feedback.held();
      if (!rows.length) return;
      const left = [];
      for (const row of rows) {
        try { await api.sendFeedback(row); }
        catch (e) { if (!e || !e.status || e.status === 429) left.push(row); }
      }
      feedback.setHeld(left);
    }
  };

  // The newest report this admin has looked at, per device. Deliberately not
  // stored on the account: it is a nudge, not a record, and two admins on two
  // phones each wanting their own unread mark is the behaviour you want.
  feedback.SEEN_KEY = 'so:fb-seen';
  feedback.seen = function () {
    if (typeof localStorage === 'undefined') return '';
    try { return localStorage.getItem(feedback.SEEN_KEY) || ''; } catch (e) { return ''; }
  };
  feedback.markSeen = function (newest) {
    if (typeof localStorage === 'undefined' || !newest) return;
    try { localStorage.setItem(feedback.SEEN_KEY, newest); } catch (e) {}
  };

  function openFeedbackModal() {
    const held = feedback.held().length;
    const ctx = feedback.context();
    const m = createModal('Send feedback', 'Send');
    const s = auth.loadSession();
    const known = s && (s.email || s.username);
    // Only claim what is actually gathered. The race comes off the address of
    // the page, so the hub, the wizard and the admin page have no race to send:
    // telling somebody there not to describe it would lose the one thing the
    // report needs most.
    const lede = ctx.race
      ? 'The page, the race and the version go with it, so no need to describe those.'
      : 'The page and the version go with it. If this is about a particular race, say which.';
    m.body.innerHTML =
      '<p class="modal-lede">What happened, and what did you expect instead? ' + lede + '</p>' +
      '<label class="modal-field"><span>What happened</span>' +
        '<textarea id="fb-msg" rows="5" placeholder="The pit board would not…"></textarea></label>' +
      (known
        ? `<p class="modal-hint">Sent as ${esc(known)}.</p>`
        : '<label class="modal-field"><span>Your email, if you want a reply</span>' +
            '<input type="email" id="fb-email" autocomplete="email" placeholder="optional" /></label>') +
      // Never shown to a person; anything in it came from a bot.
      '<input type="text" id="fb-website" tabindex="-1" autocomplete="off" aria-hidden="true" ' +
        'style="position:absolute;left:-9999px;width:1px;height:1px" />' +
      (held ? `<p class="modal-hint">${held} earlier note${held > 1 ? 's' : ''} still waiting to send.</p>` : '');

    const submit = async () => {
      const message = m.body.querySelector('#fb-msg').value.trim();
      if (message.length < 3) return m.setMsg('Tell us what happened.', 'err');
      const emailEl = m.body.querySelector('#fb-email');
      const row = {
        message,
        email: known || (emailEl ? emailEl.value.trim() : ''),
        website: m.body.querySelector('#fb-website').value,
        writtenAt: new Date().toISOString(),
        // Re-read rather than reused: the queue may have moved, and the device
        // may have lost signal, between opening the box and pressing send.
        ...feedback.context()
      };
      m.primary.disabled = true; m.primary.textContent = 'Sending…';
      try {
        const sent = await feedback.send(row);
        m.setMsg(sent ? 'Sent. Thank you.'
                      : 'No signal. Saved on this phone and it will send itself later.', 'ok');
        setTimeout(m.close, sent ? 1200 : 2200);
      } catch (err) {
        m.setMsg(err.message || 'Could not send that.', 'err');
        m.primary.disabled = false; m.primary.textContent = 'Send';
      }
    };
    m.primary.addEventListener('click', submit);
    m.body.querySelector('#fb-msg').focus();
  }

  function openPasswordModal() {
    const m = createModal('Change password', 'Change password');
    m.body.innerHTML =
      '<label class="modal-field"><span>Current password</span>' +
        '<input type="password" id="pw-current" autocomplete="current-password" /></label>' +
      '<label class="modal-field"><span>New password</span>' +
        '<input type="password" id="pw-new" autocomplete="new-password" /></label>' +
      '<label class="modal-field"><span>Confirm new password</span>' +
        '<input type="password" id="pw-confirm" autocomplete="new-password" /></label>';
    const submit = async () => {
      const cur = m.body.querySelector('#pw-current').value;
      const nw = m.body.querySelector('#pw-new').value;
      const cf = m.body.querySelector('#pw-confirm').value;
      if (!cur || !nw) return m.setMsg('All fields are required.', 'err');
      if (nw.length < 8) return m.setMsg('New password must be at least 8 characters.', 'err');
      if (nw !== cf) return m.setMsg("New passwords don't match.", 'err');
      m.primary.disabled = true; m.primary.textContent = 'Saving…';
      try {
        await api.changePassword(cur, nw);
        m.setMsg('Password changed.', 'ok');
        setTimeout(m.close, 1200);
      } catch (err) {
        m.setMsg(err.message || 'Could not change password.', 'err');
        m.primary.disabled = false; m.primary.textContent = 'Change password';
      }
    };
    m.primary.addEventListener('click', submit);
    m.body.querySelector('#pw-confirm').addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    m.body.querySelector('#pw-current').focus();
  }

  // Your fuelling defaults and the notes a crew would otherwise be told at the
  // trailhead and forget by mile 30. Per account, not per race, because a
  // runner's stomach does not reset between events.
  //
  // The fields are the built-in three, since a profile is not attached to any
  // one race and cannot know what a given race chose to track. A race that
  // tracks carbs will simply not find a default for them here, which is the
  // honest answer rather than a guess.
  function escapeAttrLite(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function openProfileModal() {
    const m = createModal('Your profile', 'Save profile');
    const metrics = fuel.metrics(null);
    m.body.innerHTML =
      '<p class="modal-hint" id="prof-loading">Loading\u2026</p>' +
      '<div id="prof-form" style="display:none">' +
        '<label class="modal-field"><span>Name your crew will see</span>' +
          '<input type="text" id="prof-name" autocomplete="name" placeholder="e.g. Jason" /></label>' +
        '<p class="modal-hint">Default hourly targets. A new race starts from these; ' +
          'changing them later does not touch a race already set up.</p>' +
        metrics.map(mt =>
          `<label class="modal-field"><span>${fuel.fieldLabel(mt)} / hr</span>` +
            `<input type="number" min="0" step="${mt.step}" data-prof-target="${mt.key}PerHour" /></label>`).join('') +
        '<p class="modal-hint">Hour bands, if what you can take changes as a race wears on. ' +
          'Leave this empty and the defaults above hold the whole way. ' +
          'A band only overrides what you fill in; the rest stay on the defaults.</p>' +
        '<div id="prof-bands"></div>' +
        '<button type="button" class="modal-addrow" id="prof-add-band">+ Add an hour band</button>' +
        '<label class="modal-field"><span>Notes for your crew</span>' +
          '<textarea id="prof-notes" rows="4" placeholder="What you want them to know without being asked. ' +
            'Allergies, what settles late, what to do when you go quiet."></textarea></label>' +
      '</div>';

    // Bands are edited here, on the person, because what a stomach does after
    // hour six belongs to the runner and not to any one race.
    let bands = [];
    function renderBands() {
      const host = m.body.querySelector('#prof-bands');
      host.innerHTML = bands.map((b, i) => `
        <div class="prof-band">
          <div class="prof-band-head">
            <span>From hour</span>
            <input type="number" min="0" step="0.25" data-band="${i}" data-bk="fromHour" value="${b.fromHour}" />
            <input type="text" data-band="${i}" data-bk="label" value="${escapeAttrLite(b.label || '')}" placeholder="what to call it" />
            <button type="button" class="prof-band-del" data-band-del="${i}" aria-label="Remove band">\u00d7</button>
          </div>
          <div class="prof-band-targets">
            ${metrics.map(mt => `<label><span>${escapeAttrLite(fuel.fieldLabel(mt))}</span>` +
              `<input type="number" min="0" step="${mt.step}" data-band="${i}" data-bt="${mt.key}PerHour" ` +
              `value="${b.targets[mt.key + 'PerHour'] ?? ''}" placeholder="\u2014" /></label>`).join('')}
          </div>
        </div>`).join('');
    }
    m.body.querySelector('#prof-add-band').addEventListener('click', () => {
      const last = bands.length ? bands[bands.length - 1].fromHour : -1;
      bands.push({ fromHour: last + 1 > 0 ? last + 1 : 0, label: '', targets: {} });
      renderBands();
    });
    m.body.querySelector('#prof-bands').addEventListener('input', (e) => {
      const i = e.target.dataset.band;
      if (i == null) return;
      const b = bands[+i];
      if (e.target.dataset.bk === 'fromHour') b.fromHour = e.target.value;
      else if (e.target.dataset.bk === 'label') b.label = e.target.value;
      else if (e.target.dataset.bt) {
        const v = e.target.value.trim();
        if (v === '') delete b.targets[e.target.dataset.bt];
        else b.targets[e.target.dataset.bt] = parseFloat(v) || 0;
      }
    });
    m.body.querySelector('#prof-bands').addEventListener('click', (e) => {
      const d = e.target.dataset.bandDel;
      if (d == null) return;
      bands.splice(+d, 1);
      renderBands();
    });

    const form = m.body.querySelector('#prof-form');
    const loading = m.body.querySelector('#prof-loading');
    m.primary.disabled = true;

    api.profile().then(({ profile }) => {
      m.body.querySelector('#prof-name').value = profile.displayName || '';
      m.body.querySelector('#prof-notes').value = profile.notes || '';
      for (const el of m.body.querySelectorAll('[data-prof-target]')) {
        const v = (profile.targets || {})[el.dataset.profTarget];
        el.value = (v == null ? '' : v);
      }
      bands = (profile.phaseTargets || []).map(b => ({
        fromHour: b.fromHour, label: b.label || '', targets: { ...(b.targets || {}) }
      }));
      renderBands();
      loading.style.display = 'none';
      form.style.display = '';
      m.primary.disabled = false;
      m.body.querySelector('#prof-name').focus();
    }).catch(err => {
      loading.textContent = '';
      m.setMsg(err.message || 'Could not load your profile.', 'err');
    });

    m.primary.addEventListener('click', async () => {
      const targets = {};
      for (const el of m.body.querySelectorAll('[data-prof-target]')) {
        const v = el.value.trim();
        if (v !== '') targets[el.dataset.profTarget] = parseFloat(v) || 0;
      }
      m.primary.disabled = true; m.primary.textContent = 'Saving\u2026';
      try {
        await api.saveProfile({
          displayName: m.body.querySelector('#prof-name').value,
          targets,
          phaseTargets: bands
            .filter(b => b.fromHour !== '' && b.fromHour != null)
            .map(b => ({ fromHour: +b.fromHour, label: b.label, targets: b.targets })),
          notes: m.body.querySelector('#prof-notes').value
        });
        m.setMsg('Profile saved.', 'ok');
        setTimeout(m.close, 1000);
      } catch (err) {
        m.setMsg(err.message || 'Could not save.', 'err');
        m.primary.disabled = false; m.primary.textContent = 'Save profile';
      }
    });
  }

  // Sign-in modal: opened from the account bar's "Sign in" button.
  function openSigninModal() {
    const m = createModal('Sign in', 'Sign in');
    m.body.innerHTML =
      '<label class="modal-field"><span>Email</span>' +
        '<input type="email" id="si-email" autocomplete="username" spellcheck="false" /></label>' +
      '<label class="modal-field"><span>Password</span>' +
        '<input type="password" id="si-password" autocomplete="current-password" /></label>' +
      '<p class="modal-hint">Forgot your password? <a href="/app/?reset=1" style="color: var(--accent);">Request a password reset</a>.<br>' +
        'No account yet? <a href="/app/?invite=1" style="color: var(--accent);">Request an invite</a>.</p>';
    const submit = async () => {
      const email = m.body.querySelector('#si-email').value.trim();
      const password = m.body.querySelector('#si-password').value;
      if (!email || !password) return m.setMsg('Email and password required.', 'err');
      m.primary.disabled = true; m.primary.textContent = 'Signing in…';
      try {
        await auth.login(email, password);
        m.setMsg('Signed in.', 'ok');
        setTimeout(() => location.reload(), 600);
      } catch (err) {
        m.setMsg(err.message || 'Could not sign in.', 'err');
        m.primary.disabled = false; m.primary.textContent = 'Sign in';
      }
    };
    m.primary.addEventListener('click', submit);
    m.body.querySelector('#si-password').addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    m.body.querySelector('#si-email').focus();
  }

  function mountAccountWidget() {
    const header = document.querySelector('header.site');
    if (!header) return;

    let bar = document.querySelector('.account-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'account-bar';
    }
    // Last child of the header, so it sits opposite the brand rather than on a
    // line of its own. Re-appending a bar that is already there is a no-op.
    if (bar.parentNode !== header) header.appendChild(bar);

    // The page's own navigation, taken out of the header and kept aside. Each
    // page still declares its links in its own markup; they are moved rather
    // than copied, so the ids and hrefs the page sets later still apply, and
    // race.html revealing "Pit →" once it knows you can edit still works with
    // the link sitting in the menu.
    if (!navLinks) {
      navLinks = [...header.querySelectorAll('a[href]')]
        .filter(a => !a.classList.contains('wordmark') && !bar.contains(a));
      for (const a of navLinks) {
        a.classList.add('account-menu-item', 'nav-hoisted');
        a.setAttribute('role', 'menuitem');
        a.remove();
      }
    }

    // The pages separate the items on that line with a middot. Taking the
    // links out leaves those stranded: a trailing dot after the wordmark, or
    // two in a row where a link used to sit between them.
    //
    // Outside the block above on purpose. A page that calls nav.setRace before
    // DOM ready has already filled navLinks by the time this runs, so the
    // block is skipped and the tidy went with it: the pit board and the charts
    // have been carrying a stray separator after their own name ever since.
    if (!metaTidied) {
      metaTidied = true;
      const meta = header.querySelector('.brand-meta');
      if (meta) {
        const isDot = (el) => el && el.tagName === 'SPAN' && el.textContent.trim() === '\u00b7';
        let kids = [...meta.children];
        for (let i = 0; i < kids.length; i++) {
          if (!isDot(kids[i])) continue;
          const prev = kids.slice(0, i).reverse().find(k => k.offsetParent !== null || !isDot(k));
          const next = kids.slice(i + 1).find(k => true);
          if (!prev || isDot(prev) || !next) { kids[i].remove(); kids[i] = null; }
        }
        kids = [...meta.children];
        while (kids.length && isDot(kids[kids.length - 1])) { kids.pop().remove(); }
      }
    }

    function render() {
      if (!hub.isProxyMode()) { bar.style.display = 'none'; return; }
      bar.style.display = '';
      const s = auth.loadSession();
      const signedIn = !!(s && s.session && (!s.expiresAt || s.expiresAt > Date.now()));

      if (!signedIn && !navLinks.length) {
        // Nowhere to go and one thing to do: a menu to hold it would be a menu
        // of one.
        bar.innerHTML = '<button type="button" class="account-signin">Sign in</button>';
        bar.querySelector('.account-signin').addEventListener('click', openSigninModal);
        return;
      }

      // Four buttons and an address did not fit across a phone: the address got
      // cut to two characters and the buttons wrapped onto their own line above
      // the wordmark. All of it lives behind one control now, the address
      // included, which is why the header can hold it.
      const email = signedIn ? (s.email || s.username || 'account') : null;
      const isAdmin = signedIn && s.role === 'admin';
      bar.innerHTML =
        '<button type="button" class="account-menu-btn" aria-haspopup="true" aria-expanded="false" ' +
          'aria-label="Menu"><span class="account-bars"></span></button>' +
        '<div class="account-menu" role="menu" hidden>' +
          '<div class="account-menu-nav"></div>' +
          (signedIn
            ? '<div class="account-menu-who"></div>' +
              (isAdmin ? '<a class="account-menu-item" role="menuitem" href="admin.html">Admin</a>' : '') +
              '<button type="button" class="account-menu-item" role="menuitem" data-act="profile">Profile</button>' +
              '<button type="button" class="account-menu-item" role="menuitem" data-act="password">Password</button>' +
              '<button type="button" class="account-menu-item" role="menuitem" data-act="feedback">Send feedback</button>' +
              '<button type="button" class="account-menu-item danger" role="menuitem" data-act="signout">Sign out</button>'
            : '<button type="button" class="account-menu-item" role="menuitem" data-act="feedback">Send feedback</button>' +
              '<button type="button" class="account-menu-item" role="menuitem" data-act="signin">Sign in</button>') +
        '</div>';

      // Where you can go, above who you are. The same elements every render,
      // moved back in rather than rebuilt, so whatever the page has done to
      // them survives a sign-in or sign-out.
      const nav = bar.querySelector('.account-menu-nav');
      for (const a of navLinks) nav.appendChild(a);
      nav.hidden = !navLinks.length;

      if (signedIn) {
        // The only place the address appears now, so it is never abbreviated.
        bar.querySelector('.account-menu-who').textContent = email;
      }

      // Feedback nobody has read yet, shown against the one menu item that
      // leads to it. An operator should not have to remember to go and look,
      // and mail is not a queue: it gets read on a laptop days later, or not
      // at all. Failures are silent on purpose, since a number on a menu is
      // not worth an error message.
      if (isAdmin) {
        // Once per page load, not once per render. This render runs from
        // nav._build, which runs from setRace, which every race page calls
        // inside load() — and load() is the poll. At a five second interval
        // that was 720 of these an hour, each one a KV list() on the worker,
        // against a free-plan allowance of a thousand a day: an admin with a
        // pit board open exhausted the day's budget in under ninety minutes,
        // and the first thing to say so was Manage access refusing to load.
        //
        // Holding the promise rather than the answer means concurrent renders
        // share one request too. A badge counting unread feedback has no business
        // being live to the second.
        if (!feedbackCountOnce) feedbackCountOnce = api.feedbackCount(feedback.seen());
        feedbackCountOnce.then((r) => {
          const item = bar.querySelector('a[href="admin.html"]');
          if (!item || !r || !r.new) return;
          item.classList.add('has-count');
          const tag = document.createElement('span');
          tag.className = 'menu-count';
          tag.textContent = r.new > 99 ? '99+' : String(r.new);
          tag.title = `${r.new} unread feedback report${r.new > 1 ? 's' : ''}`;
          item.appendChild(tag);
        }).catch(() => {});
      }

      const btn = bar.querySelector('.account-menu-btn');
      const menu = bar.querySelector('.account-menu');

      function closeMenu(refocus) {
        if (menu.hidden) return;
        menu.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
        document.removeEventListener('click', onDocClick, true);
        document.removeEventListener('keydown', onKey, true);
        if (refocus) btn.focus();
      }
      function onDocClick(e) { if (!bar.contains(e.target)) closeMenu(false); }
      function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(true); } }

      btn.addEventListener('click', () => {
        if (!menu.hidden) return closeMenu(false);
        menu.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
        // Captured, so a click anywhere else closes it before that click does
        // whatever else it was going to do.
        document.addEventListener('click', onDocClick, true);
        document.addEventListener('keydown', onKey, true);
        const first = menu.querySelector('.account-menu-item');
        if (first) first.focus();
      });

      menu.addEventListener('click', (e) => {
        const item = e.target.closest('.account-menu-item');
        if (!item) return;
        const act = item.dataset.act;
        closeMenu(false);
        if (act === 'feedback') openFeedbackModal();
        else if (act === 'profile') openProfileModal();
        else if (act === 'password') openPasswordModal();
        else if (act === 'signin') openSigninModal();
        else if (act === 'signout') { auth.logout(); location.reload(); }
      });
    }

    // Let auth.saveSession/clearSession refresh the bar on later sign-in/out.
    accountWidgetRender = render;

    // hub.json may still be loading; render once now and again once it resolves.
    render();
    hub.load().then(render);
  }

  // ---------- beta badge ----------
  // SendOff is being used on real races while it is still being built, so it
  // says so, on every page, next to its own name. Mounted from here rather
  // than written into eleven headers, because the day it comes off it should
  // come off everywhere at once.
  //
  // Deliberately not a button. It sits on the pit board and the racer page,
  // where every tappable thing is something a crew member might mean to press
  // with cold hands mid-race; a badge that opened a dialog there would be a
  // trap. The explanation lives on the intro screen, where there is room for
  // it and nobody is in a hurry.
  function mountBetaBadge() {
    for (const meta of document.querySelectorAll('.brand-meta')) {
      if (meta.querySelector('.beta-badge')) continue;
      const wm = meta.querySelector('.wordmark');
      if (!wm) continue;
      const tag = document.createElement('span');
      tag.className = 'beta-badge';
      tag.textContent = 'Beta';
      tag.title = 'SendOff is new and still changing. It is being used on real races; expect rough edges.';
      wm.insertAdjacentElement('afterend', tag);
    }
  }

  function mountHeaderExtras() {
    // Anything written with no signal goes out now, quietly.
    feedback.flush().catch(() => {});
    // The badge first: the account widget hoists the page's own links out of
    // this row and tidies the separators around them, and it should see the
    // row in its final shape.
    mountBetaBadge();
    mountAccountWidget();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountHeaderExtras);
  } else {
    mountHeaderExtras();
  }

  // Tapping the live-pulse dot in the header refreshes the page.
  function wirePulseRefresh() {
    document.querySelectorAll('.pulse').forEach(el => {
      if (el.dataset.pulseWired) return;
      el.dataset.pulseWired = '1';
      el.setAttribute('role', 'button');
      el.setAttribute('tabindex', '0');
      el.setAttribute('title', 'Refresh');
      el.setAttribute('aria-label', 'Refresh');
      el.addEventListener('click', () => location.reload());
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); location.reload(); }
      });
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wirePulseRefresh);
  } else {
    wirePulseRefresh();
  }

  // ---------- charts ----------
  // Builds the race charts into a container element. Shared by charts.html
  // and print-report.html so both render identically. Needs the .chart-*
  // CSS classes on the host page.
  const charts = {
    _esc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },

    _linePath(points, xs, ys) {
      if (!points.length) return '';
      return points.map((p, i) => (i === 0 ? 'M' : 'L') + xs(p.x).toFixed(1) + ',' + ys(p.y).toFixed(1)).join(' ');
    },

    // Draw a line chart into the given <svg> element.
    lineChart(svg, series, opts) {
      if (!svg) return;
      opts = opts || {};
      const W = 1000, H = opts.height || 320;
      const padL = 56, padR = 16, padT = 16, padB = 32;
      const innerW = W - padL - padR, innerH = H - padT - padB;

      const allX = series.flatMap(s => [...s.points, ...(s.projection || [])].map(p => p.x));
      const allY = series.flatMap(s => [...s.points, ...(s.projection || [])].map(p => p.y));
      // A target is either one number, or a staircase: [{x, y}, ...] giving the
      // goal in force from that x onward. Bands make the second shape the
      // honest one, since a race whose plan steps down at hour six never had a
      // single horizontal line to draw.
      const targetSteps = Array.isArray(opts.target)
        ? opts.target.filter(t => t && Number.isFinite(+t.x) && Number.isFinite(+t.y))
                     .map(t => ({ x: +t.x, y: +t.y })).sort((a, b) => a.x - b.x)
        : null;
      if (targetSteps) targetSteps.forEach(t => allY.push(t.y));
      else if (opts.target != null) allY.push(opts.target);
      const xMin = opts.xMin != null ? opts.xMin : Math.min(...allX, 0);
      const xMax = opts.xMax != null ? opts.xMax : Math.max(...allX, 1);
      const yMin = opts.yMin != null ? opts.yMin : Math.min(...allY, 0);
      const yMax = opts.yMax != null ? opts.yMax : Math.max(...allY, 1);

      const xScale = x => padL + ((x - xMin) / Math.max(0.001, xMax - xMin)) * innerW;
      const yScale = y => padT + innerH - ((y - yMin) / Math.max(0.001, yMax - yMin)) * innerH;

      const xTicks = opts.xTicks || 6;
      const yTicks = opts.yTicks || 5;
      let grid = '', xAxis = '', yAxis = '';
      for (let i = 0; i <= yTicks; i++) {
        const y = yMin + (i / yTicks) * (yMax - yMin);
        const yy = yScale(y).toFixed(1);
        grid += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}"/>`;
        yAxis += `<text x="${padL - 8}" y="${yy}" text-anchor="end" dominant-baseline="middle">${(opts.yFmt ? opts.yFmt(y) : y.toFixed(1))}</text>`;
      }
      for (let i = 0; i <= xTicks; i++) {
        const x = xMin + (i / xTicks) * (xMax - xMin);
        const xx = xScale(x).toFixed(1);
        xAxis += `<text x="${xx}" y="${H - padB + 16}" text-anchor="middle">${(opts.xFmt ? opts.xFmt(x) : x.toFixed(1))}</text>`;
      }
      const axisLines =
        `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}"/>` +
        `<line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}"/>`;

      let lines = '';
      for (const s of series) {
        lines += `<path class="data-line" d="${charts._linePath(s.points, xScale, yScale)}" stroke="${s.color}"/>`;
        if (s.projection && s.projection.length >= 2) {
          lines += `<path class="data-line projection" d="${charts._linePath(s.projection, xScale, yScale)}" stroke="${s.color}"/>`;
          const end = s.projection[s.projection.length - 1];
          lines += `<circle class="data-dot projection-dot" cx="${xScale(end.x).toFixed(1)}" cy="${yScale(end.y).toFixed(1)}" r="4" fill="${s.color}"/>`;
        }
        if (opts.dots !== false) {
          for (const p of s.points) {
            lines += `<circle class="data-dot" cx="${xScale(p.x).toFixed(1)}" cy="${yScale(p.y).toFixed(1)}" r="3" fill="${s.color}"/>`;
          }
        }
      }

      let target = '';
      if (targetSteps && targetSteps.length) {
        // Drawn as a staircase: flat across each band, a riser at each change.
        let d = '', prev = null;
        for (const t of targetSteps) {
          const x = xScale(Math.max(xMin, t.x)).toFixed(1);
          const y = yScale(t.y).toFixed(1);
          d += prev === null ? `M ${padL} ${y}` : ` L ${x} ${prev} L ${x} ${y}`;
          prev = y;
        }
        if (prev !== null) d += ` L ${W - padR} ${prev}`;
        const last = targetSteps[targetSteps.length - 1];
        target = `<path class="target" d="${d}" fill="none"/>` +
          `<text class="target-label" x="${W - padR}" y="${yScale(last.y) - 4}" text-anchor="end">` +
          `target ${opts.yFmt ? opts.yFmt(last.y) : last.y}</text>`;
      } else if (opts.target != null && opts.target >= yMin && opts.target <= yMax) {
        const ty = yScale(opts.target).toFixed(1);
        target = `<line class="target" x1="${padL}" y1="${ty}" x2="${W - padR}" y2="${ty}"/>` +
          `<text class="target-label" x="${W - padR}" y="${ty - 4}" text-anchor="end">target ${opts.yFmt ? opts.yFmt(opts.target) : opts.target}</text>`;
      }
      let cutoff = '';
      if (opts.cutoff != null && opts.cutoff >= yMin && opts.cutoff <= yMax) {
        const cy = yScale(opts.cutoff).toFixed(1);
        cutoff = `<line class="cutoff" x1="${padL}" y1="${cy}" x2="${W - padR}" y2="${cy}"/>` +
          `<text class="target-label" style="fill: var(--red);" x="${W - padR}" y="${cy + 14}" text-anchor="end">cutoff</text>`;
      }

      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      svg.innerHTML =
        `<g class="grid">${grid}</g>` +
        `<g class="axis">${axisLines}${xAxis}${yAxis}</g>` +
        `${target}${cutoff}${lines}`;
    },

    // Build the chart cards into `container` and draw every chart.
    render(container, cfg, data) {
      if (!container || !cfg || !data) return;
      const runners = (data.runners || []).map(d => {
        const meta = (cfg.runners || []).find(r => r.id === d.id) || {};
        return { ...meta, ...d };
      });
      // Timeline origin: race start, or the earliest logged leg if activity
      // predates it: keeps the cumulative x-axis from going negative.
      let originMs = new Date(cfg.startTime).getTime();
      for (const r of runners) {
        for (const l of (r.legs || [])) {
          if (l.startTime) originMs = Math.min(originMs, new Date(l.startTime).getTime());
        }
      }
      const start = new Date(originMs);
      const cutoffHours = (cfg.cutoffs && cfg.cutoffs.totalHours) || 0;
      const totalDist = course.totalDistanceMi(cfg);
      const legCount = course.legCount(cfg);

      // Goals belong to runners now, so the goal line on a chart of everyone's
      // intake is drawn only when they are all on the same plan. With one
      // runner, which is most races, that is always true and it is theirs.
      const agree = fuel.plansAgree(cfg);
      const plan = fuel.forRunner(cfg, runners[0]);

      const legendHtml = runners.map(r =>
        `<span><span class="legend-dot" style="background:${r.color || 'var(--accent)'}"></span>${charts._esc(r.name)}</span>`
      ).join('');

      const card = (title, sub, svgId) =>
        `<div class="chart-card"><div class="chart-head"><div>` +
        `<div class="chart-title">${title}</div><div class="chart-sub">${sub}</div>` +
        `</div><div class="chart-legend">${legendHtml}</div></div>` +
        `<svg id="${svgId}" class="chart-svg"></svg></div>`;

      container.innerHTML =
        card('Leg time', 'Time per leg, by leg index', 'chart-leg-time') +
        card('Leg pace', 'Per-leg pace (' + units.paceLabel(cfg) + ')', 'chart-pace') +
        card('Aid station time', 'Minutes in aid/pit, by stop number', 'chart-pit') +
        // A race that tracks no fuel gets no empty grid to explain.
        (fuel.metrics(cfg).length
          ? '<div class="intake-grid">' +
              fuel.metrics(cfg).map(m =>
                `<div class="intake-card"><h3>${fuel.fieldLabel(m)} / hour` +
                (agree ? '' : ' <span class="chart-sub">goals differ per runner</span>') +
                `</h3><svg id="chart-fuel-${m.key}" class="chart-svg"></svg></div>`).join('') +
            '</div>'
          : '') +
        card('Cumulative progress', 'Distance covered over race time; dashed = projected finish, cutoff line shown', 'chart-cum');
      const svg = id => container.querySelector('#' + id);

      const legTimeSeries = runners.map(r => {
        const pts = [];
        for (const l of (r.legs || [])) {
          if (l.startTime && l.endTime) {
            pts.push({ x: l.index, y: (new Date(l.endTime) - new Date(l.startTime)) / 1000 });
          }
        }
        return { name: r.name, color: r.color || 'var(--accent)', points: pts };
      });
      charts.lineChart(svg('chart-leg-time'), legTimeSeries, {
        height: 320, xMin: 1, xMax: legCount,
        yFmt: s => fmt.durationShort(s), xFmt: x => 'L' + Math.round(x),
        xTicks: Math.min(legCount, 10)
      });

      const paceSeries = runners.map(r => {
        const pts = [];
        for (const l of (r.legs || [])) {
          if (l.startTime && l.endTime) {
            const def = course.legAt(cfg, l.index);
            const dist = (def && def.distanceMi) || 0;
            if (dist > 0) pts.push({ x: l.index, y: ((new Date(l.endTime) - new Date(l.startTime)) / 1000) / dist });
          }
        }
        return { name: r.name, color: r.color || 'var(--accent)', points: pts };
      });
      charts.lineChart(svg('chart-pace'), paceSeries, {
        height: 260, xMin: 1, xMax: legCount,
        yFmt: s => units.pace(s, cfg), xFmt: x => 'L' + Math.round(x),
        xTicks: Math.min(legCount, 10)
      });

      const pitSeries = runners.map(r => {
        const sorted = (r.legs || []).slice().sort((a, b) => a.index - b.index);
        const pts = [];
        for (let i = 0; i < sorted.length - 1; i++) {
          if (sorted[i].endTime && sorted[i + 1].startTime) {
            pts.push({ x: sorted[i].index, y: (new Date(sorted[i + 1].startTime) - new Date(sorted[i].endTime)) / 60000 });
          }
        }
        return { name: r.name, color: r.color || 'var(--accent)', points: pts };
      });
      charts.lineChart(svg('chart-pit'), pitSeries, {
        height: 240, xMin: 1, xMax: Math.max(1, legCount - 1),
        yFmt: y => y.toFixed(0) + 'm', xFmt: x => '#' + Math.round(x),
        xTicks: Math.min(legCount, 10)
      });

      const intakeOne = extract => runners.map(r => {
        const pts = [];
        for (const l of (r.legs || [])) {
          if (l.startTime && l.endTime) {
            const hours = ((new Date(l.endTime) - new Date(l.startTime)) / 1000) / 3600;
            const val = extract(l);
            if (val != null && hours > 0) pts.push({ x: l.index, y: val / hours });
          }
        }
        return { name: r.name, color: r.color || 'var(--accent)', points: pts };
      });
      // These charts run on leg index, and bands are stated in hours, so a
      // banded goal has to be placed at the leg where that hour arrives. Which
      // leg that is depends on the runner, and one line is drawn for all of
      // them, so it is placed by whoever is furthest along: the plan as the
      // race is actually unfolding rather than an average of nobody.
      const bands = fuel.bands(plan);
      const pace = runners
        .map(r => (r.legs || []).filter(l => l.startTime && l.endTime).sort((a, b) => a.index - b.index))
        .sort((a, b) => b.length - a.length)[0] || [];
      const raceStart = cfg.startTime ? new Date(cfg.startTime).getTime() : null;
      const legIndexAtHour = (h) => {
        if (!raceStart || !pace.length) return null;
        for (const l of pace) {
          if ((new Date(l.endTime).getTime() - raceStart) / 3600000 >= h) return l.index;
        }
        return null;     // that hour has not been reached yet
      };

      for (const m of fuel.metrics(plan)) {
        // One line drawn across everyone's intake can only speak for one plan.
        // When the runners are on different ones there is no such line to draw,
        // so the chart shows the intake and says why the goal is missing rather
        // than picking a runner and implying it is everybody's.
        let target = agree ? m.targetPerHour : null;
        if (agree && bands.length) {
          const steps = [];
          for (const b of bands) {
            const y = fuel.targetAt(plan, m.key, b.fromHour);
            if (y == null) continue;
            const x = b.fromHour <= 0 ? 1 : legIndexAtHour(b.fromHour);
            if (x == null) continue;
            if (steps.length && steps[steps.length - 1].y === y) continue;
            steps.push({ x, y });
          }
          // A metric no band changes collapses to one value, which is a flat
          // line and should be drawn as one rather than as a staircase of one
          // step. Only a goal that actually moves gets the staircase.
          if (steps.length > 1) target = steps;
          else if (steps.length === 1) target = steps[0].y;
        }
        charts.lineChart(svg('chart-fuel-' + m.key), intakeOne(l => l[m.key]), {
          height: 220, xMin: 1, xMax: legCount,
          target: target == null ? undefined : target,
          yFmt: y => m.decimals ? y.toFixed(m.decimals) : Math.round(y)
        });
      }

      // Cumulative progress with the clipped pace-projection ray.
      const raceStartMs = new Date(cfg.startTime).getTime();
      const cutoffWindowX = (raceStartMs - start.getTime()) / 3600000 + (cutoffHours || 24);
      const cumSeries = runners.map(r => {
        const sorted = (r.legs || []).slice().sort((a, b) => a.index - b.index);
        const pts = [{ x: 0, y: 0 }];
        const completed = [];
        let miles = 0;
        for (const l of sorted) {
          if (l.endTime) {
            const def = course.legAt(cfg, l.index);
            miles += (def && def.distanceMi) || 0;
            const p = { x: (new Date(l.endTime) - start) / 3600000, y: miles };
            pts.push(p); completed.push(p);
          }
        }
        const pred = compute.predictedMileage(r, cfg);
        const onCourse = pred.state === 'on-course' || pred.state === 'in-pit';
        if (onCourse) pts.push({ x: (Date.now() - start) / 3600000, y: pred.courseMi });
        const firstLeg = sorted.find(l => l.startTime);
        const runnerStartX = firstLeg ? (new Date(firstLeg.startTime) - start) / 3600000 : 0;
        return {
          name: r.name, color: r.color || 'var(--accent)', points: pts,
          _completed: completed, _onCourse: onCourse, _runnerStartX: runnerStartX
        };
      });
      let cumMaxX = cutoffWindowX;
      cumSeries.forEach(s => s.points.forEach(p => { if (p.x > cumMaxX) cumMaxX = p.x; }));
      cumSeries.forEach(s => {
        const cp = s._completed;
        if (!s._onCourse || !cp.length) return;
        const here = s.points[s.points.length - 1];
        if (here.y <= 0 || here.y >= totalDist || here.x >= cumMaxX) return;
        const last = cp[cp.length - 1];
        const anchor = cp.length >= 4 ? cp[cp.length - 4] : { x: s._runnerStartX, y: 0 };
        const dt = last.x - anchor.x, dm = last.y - anchor.y;
        if (dt <= 0 || dm <= 0) return;
        const mph = dm / dt;
        const goalH = here.x + (totalDist - here.y) / mph;
        let endH, endMiles;
        if (goalH <= cumMaxX) { endH = goalH; endMiles = totalDist; }
        else { endH = cumMaxX; endMiles = here.y + (cumMaxX - here.x) * mph; }
        if (endH > here.x) s.projection = [{ x: here.x, y: here.y }, { x: endH, y: endMiles }];
      });
      charts.lineChart(svg('chart-cum'), cumSeries, {
        height: 360, xMin: 0, xMax: cumMaxX, yMin: 0, yMax: totalDist,
        cutoff: totalDist, yFmt: y => Math.round(units.distanceVal(y, cfg)) + units.distanceLabel(cfg), xFmt: x => x.toFixed(0) + 'h',
        dots: false
      });
    }
  };

  // ---------- page navigation ----------
  // The four pages of a race are siblings: the dashboard, the pit board, the
  // charts and the printout. Being on one of them should not mean going back to
  // the race page first to reach the others, so every one of them offers the
  // whole set, minus itself.
  //
  // Declared here rather than in four headers, because the list is the same
  // list and the rule about who may see the pit board is the same rule.
  const RACE_PAGES = [
    { key: 'race',   label: 'Race',      file: 'race.html' },
    { key: 'pit',    label: 'Pit Board', file: 'pit.html', needsEdit: true },
    { key: 'racer',  label: 'Racer',     file: 'racer.html', needsEdit: true },
    { key: 'settings', label: 'Settings', file: 'settings.html', needsEdit: true },
    { key: 'charts', label: 'Charts',    file: 'charts.html' },
    { key: 'print',  label: 'Print',     file: 'print-report.html' }
  ];

  const nav = {
    // Called once a page knows which race it is showing. `canEdit` may be a
    // boolean or a function returning one; a function is re-asked after
    // hub.json has loaded, because until it does auth.mode() is not 'proxy'
    // and auth.email() answers null, which would quietly hide the pit board
    // from the person who owns the race.
    setRace(slug, current, canEdit) {
      if (!slug) return;
      if (typeof canEdit === 'function') {
        const fn = canEdit;
        nav._build(slug, current, !!fn());
        // Rebuilt whether or not hub.json loads. It used to be rebuilt only on
        // success, so a phone with no signal answered the question once, too
        // early, and hid the pit and racer pages from the crew member holding
        // it. Offline is exactly when they need them.
        hub.load().catch(() => {}).then(() => nav._build(slug, current, !!fn()));
        return;
      }
      nav._build(slug, current, !!canEdit);
    },

    _build(slug, current, canEdit) {
      const links = [];
      const mk = (href, text) => {
        const a = document.createElement('a');
        a.href = href;
        a.textContent = text;
        return a;
      };
      // '/app/', not 'index.html'. The hub used to be the site root, so this
      // was right until the app moved under /app/ and the root became the
      // marketing page. Every page here carries <base href="/">, so the
      // relative form resolved to /index.html and the Hub link quietly sent
      // crew to the landing page.
      links.push(mk('/app/', '\u2190 Hub'));
      for (const pg of RACE_PAGES) {
        if (pg.key === current) continue;
        if (pg.needsEdit && !canEdit) continue;
        links.push(mk(`${pg.file}?id=${encodeURIComponent(slug)}`, pg.label));
      }
      navLinks = links;
      for (const a of navLinks) {
        a.classList.add('account-menu-item', 'nav-hoisted');
        a.setAttribute('role', 'menuitem');
      }
      if (accountWidgetRender) accountWidgetRender();
    }
  };

  // ---------- offline ----------
  // The service worker makes the app openable without signal. This is the part
  // the person sees: whether what is on screen came off the network or out of
  // storage, and how old it is. Showing a saved split as though it were live is
  // the one thing worse than showing nothing.
  const offline = {
    // Where each thing on screen came from, by file. Per file rather than one
    // flag, because a page shows several: the config, the splits, the course.
    // A single boolean meant the last read to finish decided the answer for all
    // of them, so a fresh course could clear the notice that the splits were an
    // hour old, and the page then presented saved times as live ones. That is
    // the failure this bar exists to prevent.
    _by: new Map(),

    get stale() { for (const v of offline._by.values()) if (v.stale) return true; return false; },
    // The oldest thing on screen, not the newest: the bar should not claim the
    // page is fresher than its stalest part.
    get staleAt() {
      let out = null;
      for (const v of offline._by.values()) {
        if (!v.stale || !v.at) continue;
        if (!out || v.at < out) out = v.at;
      }
      return out;
    },

    note(key, stale, at) {
      const d = at ? new Date(at) : null;
      offline._by.set(key || '', { stale, at: (d && !isNaN(d)) ? d : null });
      offline.render();
    },

    // A read answered from the service worker's cache; the worker stamps the
    // header. Anything else came off the network just now.
    noteResponse(res, key) {
      if (res && res.headers) {
        const hit = res.headers.get('X-SendOff-Cache') === 'hit';
        offline.note(key, hit, hit ? res.headers.get('date') : null);
      }
      return res;
    },

    // A read that fell all the way back to what this device saw last. Same
    // effect as a cache hit, and for the same reason: what is on screen is not
    // what is on the server, and saying so is the whole point of the bar. The
    // time is when the copy was taken, not when it was displayed.
    noteSaved(at, key) { offline.note(key, true, at); },

    // Nothing on screen is from storage any more.
    noteFresh() { offline._by.clear(); offline.render(); },

    // What the bar says, in priority order: writes that gave up matter more
    // than writes still waiting, which matter more than a stale read, because
    // the first is data the crew thinks is saved and is not.
    message() {
      const failed = queue.failed().length;
      if (failed) {
        return { tone: 'bad', text: `${failed} update${failed > 1 ? 's' : ''} could not be saved. Tap to see.` };
      }
      const waiting = queue.pending().length;
      const when = offline.staleAt
        ? offline.staleAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        : null;
      if (waiting) {
        return { tone: 'warn', text: navigator.onLine === false
          ? `No signal. ${waiting} update${waiting > 1 ? 's' : ''} saved on this phone, will sync.`
          : `Syncing ${waiting} update${waiting > 1 ? 's' : ''}\u2026` };
      }
      if (!offline.stale && navigator.onLine !== false) return null;
      return { tone: 'warn', text: navigator.onLine === false
        ? (when ? `No signal. Showing what was saved at ${when}.` : 'No signal. Showing saved data.')
        : (when ? `Could not reach the network. Showing ${when}.` : 'Could not reach the network. Showing saved data.') };
    },

    // The bar is pinned to the bottom of the viewport, so on its own it sits on
    // top of whatever is down there. On the racer page that is the one button
    // the runner has, which is not a thing to cover with a status message.
    // --so-offline-h is how tall it currently is, or 0px when it is gone;
    // anything anchored to the bottom of the screen offsets by it.
    reserve(el) {
      const h = el ? Math.ceil(el.getBoundingClientRect().height) : 0;
      document.documentElement.style.setProperty('--so-offline-h', h + 'px');
    },

    render() {
      let el = document.getElementById('so-offline-bar');
      const msg = offline.message();
      if (!msg) { if (el) el.remove(); offline.reserve(null); return; }
      if (!el) {
        el = document.createElement('div');
        el.id = 'so-offline-bar';
        el.setAttribute('role', 'status');
        document.body.appendChild(el);
        // Injected rather than asked of every page, so a page that gains a bar
        // cannot forget to make room for it.
        if (!document.getElementById('so-offline-style')) {
          const st = document.createElement('style');
          st.id = 'so-offline-style';
          st.textContent = 'body{padding-bottom:var(--so-offline-h,0px)}';
          document.head.appendChild(st);
        }
        el.addEventListener('click', () => {
          const bad = queue.failed();
          if (!bad.length) { queue.flush(); return; }
          const lines = bad.map(e => `\u00b7 ${e.message}\n    ${e.error || 'rejected'}`).join('\n');
          if (confirm(`These could not be saved:\n\n${lines}\n\nDiscard them? They will be gone for good.`)) {
            queue.discardFailed();
            offline.render();
          }
        });
      }
      const bad = msg.tone === 'bad';
      el.style.cssText =
        'position:fixed;left:0;right:0;bottom:0;z-index:2000;padding:9px 14px;' +
        "font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:0.08em;" +
        'text-align:center;border-top:1px solid;cursor:pointer;' +
        (bad ? 'background:#3A1414;color:#E5484D;border-color:#E5484D;'
             : 'background:#3A2A12;color:#FFB07A;border-color:#FFB07A;');
      el.textContent = msg.text;
      // After the text, because the height depends on how many lines it wraps to.
      offline.reserve(el);
    },

    register() {
      if (!('serviceWorker' in navigator)) return;
      // file:// and plain http have no worker, and registering from a page
      // served off something other than the site root would scope it wrongly.
      if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(() => {});
      });
      window.addEventListener('online', () => {
        offline.noteFresh(); queue.flush(); feedback.flush().catch(() => {});
      });
      window.addEventListener('offline', offline.render);
      // Two lines in portrait can be one in landscape.
      window.addEventListener('resize', () => offline.reserve(document.getElementById('so-offline-bar')));
    }
  };

  offline.register();

  // Whenever the queue changes, the bar changes with it.
  queue.onChange(() => offline.render());

  // The three moments worth retrying: the page opens, the phone comes back to
  // the foreground after being in a vest pocket, and a slow tick for the case
  // where the browser never fires either. `flush` is a no-op when there is
  // nothing waiting, so none of these cost anything on a normal race day.
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    queue.flush();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) queue.flush();
    });
    setInterval(() => { if (queue.pending().length) queue.flush(); }, 30000);
  }


  // ---------- manage access ----------
  // The roster, the invites, the share links, the display units and the delete
  // button. It lived on the dashboard, but the pit board is where a race is
  // actually run and where the roster is edited, so it is mounted from here and
  // both pages get the same panel from one copy of the code.
  // Deleting a race, on its own rather than tucked inside the access panel.
  // It is not an access control: it is the one irreversible thing on the page,
  // and it now gets a section of its own that a person has to open on purpose.
  //
  // ctx: { slug, cfg(), data?(), }  — cfg and data are getters because the
  // settings page reassigns both on every load.
  function mountDeleteRace(host, ctx) {
    if (!host || !ctx || !ctx.slug) return null;
    host.innerHTML =
      '<div class="access-help">Removes the course, the roster and every logged ' +
      'leg, and takes the race off the hub. Share links stop working. Only you ' +
      'can do this, crew cannot.</div>' +
      '<div class="access-add" style="margin-top:10px">' +
        '<button class="btn danger" id="ax-delete">Delete race</button>' +
      '</div>' +
      '<div id="ax-delete-result"></div>';

    const del = host.querySelector('#ax-delete');
    const out = host.querySelector('#ax-delete-result');
    del.addEventListener('click', async () => {
      const cfg = ctx.cfg ? ctx.cfg() : null;
      const name = (cfg && cfg.name) || ctx.slug;
      if (!await confirmDeleteRace(name, ctx.data ? ctx.data() : null)) return;
      del.disabled = true; del.textContent = 'Deleting…';
      out.innerHTML = '';
      try {
        const res = await api.deleteRace(ctx.slug);
        if (res && res.ok === false) {
          // A 207: some of it went, some did not. Say which rather than
          // claiming success and leaving the repository half tidied.
          const bits = [];
          if (res.manifestErr) bits.push('the hub listing');
          if ((res.failed || []).length) bits.push((res.failed || []).map(f => f.path).join(', '));
          out.innerHTML = `<div class="access-err">Partly deleted. Still there: ${esc(bits.join('; '))}. Try again, or remove them in GitHub.</div>`;
          del.disabled = false; del.textContent = 'Delete race';
          return;
        }
        out.innerHTML = '<div style="color: var(--green); font-size: 11px; margin-top: 8px;">Deleted. Back to the hub…</div>';
        setTimeout(() => { location.href = '/app/'; }, 900);
      } catch (err) {
        out.innerHTML = `<div class="access-err">${esc(err.message)}</div>`;
        del.disabled = false; del.textContent = 'Delete race';
      }
    });
    return { host };
  }

  const access = {
    // `section` is a <section class="access"> holding a .access-head and an
    // .access-body. Nothing renders for someone who cannot manage the race.
    //
    // ctx: { slug, cfg(), data?(), onUnitsSaved?(units), onRosterChanged?() }
    // cfg is a getter because both pages reassign theirs on every load.
    mountDelete: mountDeleteRace,
    mount(section, ctx) {
      if (!section || !ctx || !ctx.slug) return null;
      const panel = new AccessPanel(section, ctx);
      access._last = panel;
      panel.refresh();
      return panel;
    },
    // The roster the panel last fetched, for pages that need to name the people
    // on a race. It used to be read off the config; the config no longer lists
    // anybody, because it is a file in a public repository and a roster is a
    // list of addresses. Null when no panel is mounted or it has not loaded.
    roster() {
      const p = access._last;
      if (!p || !p.state) return null;
      return {
        createdBy: p.state.createdBy || null,
        people: roles.people(p.state.people ? p.state
                  : { editors: p.state.editors, viewers: p.state.viewers })
      };
    },
    // What a page needs to decide whether to bother mounting.
    canManage(cfg) {
      if (!hub.isProxyMode() || !auth.has()) return false;
      return roles.canEdit(cfg, auth.email());
    }
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function AccessPanel(section, ctx) {
    this.section = section;
    this.ctx = ctx;
    this.state = null;
    this.loaded = false;
    this.wired = false;
  }

  AccessPanel.prototype.cfg = function () { return this.ctx.cfg() || {}; };
  AccessPanel.prototype.slug = function () { return this.ctx.slug; };

  // Deleting is creator-only, stricter than managing: an editor was invited to
  // help run the race, not to unmake it.
  AccessPanel.prototype.isCreator = function () {
    if (!hub.isProxyMode() || !auth.has()) return false;
    const me = (auth.email() || '').toLowerCase();
    // From the panel's own fetch when it has one, since the config no longer
    // names the creator: it is a file in a public repository. The worker's
    // myRole answers it otherwise, and both fall back to the old field for a
    // race written before any of this.
    const s = this.state;
    if (s && s.createdBy !== undefined) return !!me && String(s.createdBy || '').toLowerCase() === me;
    const cfg = this.cfg() || {};
    if (cfg.myRole !== undefined) return cfg.myRole === 'owner';
    return !!me && ((cfg.createdBy || '').toLowerCase() === me);
  };

  // Called on every page load: shows the panel to whoever can use it, hides it
  // from everyone else, and wires the header once.
  AccessPanel.prototype.refresh = function () {
    const sec = this.section;
    if (!access.canManage(this.cfg())) { sec.style.display = 'none'; return; }
    sec.style.display = '';
    if (!this.wired) {
      const self = this;
      sec.querySelector('.access-head').addEventListener('click', () => {
        sec.classList.toggle('open');
        if (sec.classList.contains('open') && !self.loaded) self.load();
      });
      this.wired = true;
    }
  };

  AccessPanel.prototype.body = function () { return this.section.querySelector('.access-body'); };

  AccessPanel.prototype.load = async function () {
    const body = this.body();
    body.innerHTML = '<div class="access-section"><div class="access-section-title">Loading…</div></div>';
    try {
      this.state = await api.accessList(this.slug());
      this.loaded = true;
      await this.render();
    } catch (err) {
      body.innerHTML = `<div class="access-err">Could not load access: ${esc(err.message)}</div>`;
    }
  };

  // Everyone on the race, newest shape first. A race written before roles
  // arrives as editors[]/viewers[] and roles.people reads it as the roles it
  // always meant.
  AccessPanel.prototype.people = function () {
    const s = this.state;
    if (!s) return [];
    const byEmail = new Map((s.people || []).map(p => [String(p.email || '').toLowerCase(), p]));
    return roles.people(s.people ? s : { editors: s.editors, viewers: s.viewers })
      .map(p => ({ ...p, displayName: (byEmail.get(p.email) || {}).displayName || '' }));
  };

  // The people who could plausibly be running: the creator, plus anyone
  // invited to race or pace. Used by the pit board's runner picker, so a runner
  // row can be tied to the account that will log it.
  AccessPanel.prototype.racers = function () {
    const s = this.state;
    if (!s) return [];
    const out = [];
    if (s.createdBy) out.push({ email: String(s.createdBy).toLowerCase(), role: 'owner', displayName: s.createdByName || '' });
    for (const p of this.people()) {
      if (p.email === (s.createdBy || '').toLowerCase()) continue;
      if (p.role === 'racer') out.push(p);
    }
    return out;
  };

  AccessPanel.prototype.render = async function () {
    const s = this.state;
    if (!s) return;
    const self = this;
    const cfg = this.cfg();
    const me = (auth.email() || '').toLowerCase();
    const u = units.of(cfg);
    const people = this.people().filter(p => p.email !== (s.createdBy || '').toLowerCase());

    // The worker is the gate; this decides which controls are worth drawing.
    // Someone who cannot change the roster still sees it, because knowing who
    // else is on your race is not a privilege.
    const mayInvite = s.canManageAccess !== undefined
      ? !!s.canManageAccess
      : roles.canInvite({ ...cfg, teamCanInvite: s.teamCanInvite }, me);

    // A name if they have set one, and the address underneath, because the
    // address is what an invite is sent to and what has to match.
    const who = (email, name) => name
      ? `<span class="who"><strong>${esc(name)}</strong> <span style="color: var(--text-muted);">${esc(email)}</span>${email.toLowerCase() === me ? ' <span style="color: var(--text-muted);">(you)</span>' : ''}</span>`
      : `<span class="who">${esc(email)}${email.toLowerCase() === me ? ' <span style="color: var(--text-muted);">(you)</span>' : ''}</span>`;

    const personRow = (email, role, fixed, name) => `
      <div class="row">
        ${who(email, name)}
        ${fixed
          ? `<span class="tag creator">Creator</span><span></span>`
          : mayInvite
            ? `<select class="role-pick" data-set-role="${esc(email)}" aria-label="Role for ${esc(email)}">
                 ${roles.all.map(r =>
                   `<option value="${r.key}"${r.key === role ? ' selected' : ''}>${esc(r.label)}</option>`).join('')}
               </select>
               <button data-revoke="${esc(email)}">Revoke</button>`
            : `<span class="tag">${esc(roles.label(role))}</span><span></span>`}
      </div>`;

    const rosterHtml = (s.createdBy ? [personRow(s.createdBy, 'owner', true, s.createdByName)] : [])
      .concat(people.map(p => personRow(p.email, p.role, false, p.displayName)))
      .join('') || `<div class="empty">Nobody has access yet.</div>`;

    const dir = location.pathname.replace(/[^/]*$/, '');
    const shareUrl = tok => `${location.origin}${dir}race.html?id=${encodeURIComponent(this.slug())}&t=${encodeURIComponent(tok)}`;
    // The address of the race, which on a public race is the whole story: the
    // worker allows a public race before it ever looks at a token, so a
    // generated link grants nothing the plain URL does not, and offering one
    // implies a control that is not there. Revoking it would change nothing.
    const isPrivate = (this.cfg() || {}).visibility === 'private';

    // Which of the two addresses to hand somebody.
    //
    //   /races/<slug>/      a real page for this race, built by
    //                       tools/make-og.py, whose social tags name the race
    //                       and whose preview image is the race's own card. It
    //                       forwards into the app, so it is the same thing to
    //                       click. This is what should be pasted anywhere a
    //                       link gets a preview: a chat, a text, a post.
    //   race.html?id=       the app. One static file serving every race, so it
    //                       can only carry one set of preview tags and they are
    //                       the generic ones.
    //
    // The share page only exists for public races that have been through
    // make-og.py, which reads the public manifest. So an unlisted race never
    // has one, by construction, and a race made minutes ago may not have one
    // yet. Hence the ask: default to the address that always works, and upgrade
    // once the better one is known to be there.
    const appUrl = `${location.origin}${dir}race.html?id=${encodeURIComponent(this.slug())}`;
    const cardUrl = `${location.origin}${dir}${raceHref(this.slug(), true)}`;
    let pageUrl = appUrl;
    if (!isPrivate) {
      try {
        const probe = await fetch(cardUrl, { method: 'HEAD', cache: 'no-store' });
        if (probe.ok) pageUrl = cardUrl;
      } catch (e) { /* no signal, or no page: the app address is always right */ }
    }
    // null means the worker could not read them, which is not the same as
    // there being none, and saying "none" would invite somebody to generate a
    // second link for a race that already has one.
    const shareLinksUnknown = s.shareLinks === null;
    const shareLinksHtml = shareLinksUnknown
      ? '<div class="access-hint">Could not check existing view links just now. Any that exist still work.</div>'
      : (s.shareLinks || []).length
      ? (s.shareLinks || []).map(sh => {
          const exp = sh.expiresAt ? new Date(sh.expiresAt).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) : 'no expiry';
          const url = shareUrl(sh.token);
          return `
            <div class="share-row">
              <div>
                <div class="lbl">View link · expires ${exp}</div>
                <div class="url">${esc(url)}</div>
              </div>
              <button class="copy" data-copy-share="${esc(url)}">Copy</button>
              <button class="revoke" data-revoke-share="${esc(sh.token)}">Revoke</button>
            </div>`;
        }).join('')
      : `<div class="empty">No share links yet.</div>`;

    const inviteUrl = token => `${location.origin}${dir}signup.html?invite=${encodeURIComponent(token)}`;
    const pendingHtml = (s.pendingInvites || []).length
      ? (s.pendingInvites || []).map(inv => {
          const exp = inv.expiresAt ? new Date(inv.expiresAt).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) : 'no expiry';
          const url = inviteUrl(inv.token);
          return `
            <div class="share-row">
              <div>
                <div class="lbl">Invite for ${esc(inv.email)} (${esc(inv.role)}) · expires ${exp}</div>
                <div class="url">${esc(url)}</div>
              </div>
              <button class="copy" data-copy-share="${esc(url)}">Copy</button>
              <button class="revoke" data-revoke-invite="${esc(inv.token)}">Cancel</button>
            </div>`;
        }).join('')
      : '';

    this.body().innerHTML = `
      <div class="access-section">
        <div class="access-section-title">Who has access</div>
        <div class="access-list">${rosterHtml}</div>
        <div class="access-help">
          ${roles.all.map(r => `<strong>${esc(r.label)}</strong>: ${esc(r.blurb)}.`).join('<br>')}
          <br>Changing someone's role takes effect the next time they load the race.
        </div>
      </div>

      ${!mayInvite ? '' : `
      <div class="access-section">
        <div class="access-section-title">Invite someone</div>
        <div class="access-add">
          <input type="email" id="ax-email" placeholder="email@example.com" autocomplete="off" spellcheck="false" />
          <select id="ax-role">
            ${roles.all.map(r => `<option value="${r.key}">${esc(r.label)}</option>`).join('')}
          </select>
          <button class="btn primary" id="ax-invite">Generate invite link</button>
          <button class="btn" id="ax-add-existing">Add (already has account)</button>
        </div>
        <div class="access-help">
          <strong>Invite link</strong>: generates a one-time link you send to them; they pick a password and get access in one step.<br>
          <strong>Add (already has account)</strong>: adds them by email if they're already signed up. No notification is sent.
        </div>
        <div id="ax-invite-result"></div>
      </div>

      <div class="access-section">
        <div class="access-section-title">Share this race</div>
        <div class="share-row">
          <div>
            <div class="lbl">Page link</div>
            <div class="url">${esc(pageUrl)}</div>
          </div>
          <button class="copy" data-copy-share="${esc(pageUrl)}">Copy</button>
        </div>
        <div class="access-hint">${isPrivate
          ? 'This race is unlisted. It is kept off the hub and out of search, and SendOff asks for a sign-in, but the file behind it sits on a public host: anybody who has this address can read it. A view link below lets somebody watch without an account.'
          : (pageUrl === cardUrl
            ? 'This race is public. Send this to anyone. It opens the race and, pasted anywhere that shows a preview, carries this race\'s own card. There is nothing else to generate: a token would not make it any more or less open than the address itself.'
            : 'This race is public. Send this to anyone. There is nothing else to generate: a token would not make it any more or less open than the address itself.')}</div>
        ${isPrivate ? `
          <div class="access-list">${shareLinksHtml}</div>
          <div class="access-add">
            <button class="btn primary" id="ax-share">Generate view link</button>
            <span style="color: var(--text-muted); font-size: 11px;">Expires in 30 days. Anyone with it can watch without signing in.</span>
          </div>
          <div id="ax-share-result"></div>
        ` : ((shareLinksUnknown || (s.shareLinks || []).length) ? `
          <div class="access-list">${shareLinksHtml}</div>
          <div class="access-hint">These were made while the race was unlisted. They do nothing while it is public, and start working again if you make it unlisted.</div>
        ` : '')}
      </div>

      ${pendingHtml ? `
        <div class="access-section">
          <div class="access-section-title">Pending invites</div>
          <div class="access-list">${pendingHtml}</div>
        </div>
      ` : ''}
      `}

      ${!this.isCreator() ? '' : `
        <div class="access-section">
          <div class="access-section-title">Who can invite</div>
          <label class="switch-row">
            <input type="checkbox" id="ax-team-invite" ${s.teamCanInvite ? 'checked' : ''} />
            <span>Let the team invite people too</span>
          </label>
          <div class="access-help">
            Off, and you are the only one who can add people, change a role, or
            hand out a share link. On, and anyone who can log the race can do it
            as well, which is worth it when a crew chief is assembling the team
            for you. Either way, only you can delete the race.
          </div>
          <div id="ax-team-invite-result"></div>
        </div>

      `}
    `;

    this.wireHandlers();
    if (this.ctx.onRosterChanged) this.ctx.onRosterChanged(this);
    void self;
  };

  // Deleting a race destroys logged legs, so the dialog says how many rather
  // than asking someone to guess what they are about to lose. Typing the name
  // is the gate: a race with splits on it should be hard to delete by reflex.
  AccessPanel.prototype.confirmDelete = function () {
    const cfg = this.cfg();
    return confirmDeleteRace(cfg.name || this.slug(), this.ctx.data ? this.ctx.data() : null);
  };

  // Standalone, because deleting a race is no longer part of the access panel:
  // it has its own section on the settings page. Same modal either way, so
  // there is one place deciding what a person has to type to mean it.
  function confirmDeleteRace(name, data) {
    const legCount = ((data && data.runners) || [])
      .reduce((n, r) => n + ((r.legs || []).length), 0);
    return new Promise(resolve => {
      const ov = document.createElement('div');
      ov.className = 'modal-overlay';
      ov.innerHTML = `
        <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="del-title">
          <div class="modal-title" id="del-title" style="color: var(--red);">Delete this race?</div>
          <p style="font-size: 12px; line-height: 1.6; color: var(--text-dim); margin: 0 0 12px;">
            <strong>${esc(name)}</strong> and everything logged on it:
            ${legCount} leg${legCount === 1 ? '' : 's'}, the roster and the course.
            Share links stop working. This cannot be undone from the app.
          </p>
          <label class="modal-field">
            <span>Type the race name to confirm</span>
            <input type="text" id="del-confirm" autocomplete="off" spellcheck="false" />
          </label>
          <div class="modal-actions">
            <button class="btn" id="del-cancel">Cancel</button>
            <button class="btn danger" id="del-go" disabled>Delete race</button>
          </div>
        </div>`;
      document.body.appendChild(ov);
      const input = ov.querySelector('#del-confirm');
      const go = ov.querySelector('#del-go');
      const done = (v) => { document.removeEventListener('keydown', onKey, true); ov.remove(); resolve(v); };
      function matches() {
        return input.value.trim().toLowerCase() === String(name).trim().toLowerCase();
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); done(false); }
        else if (e.key === 'Enter' && matches()) { e.preventDefault(); done(true); }
      }
      input.addEventListener('input', () => { go.disabled = !matches(); });
      ov.querySelector('#del-cancel').addEventListener('click', () => done(false));
      go.addEventListener('click', () => done(true));
      ov.addEventListener('click', e => { if (e.target === ov) done(false); });
      document.addEventListener('keydown', onKey, true);
      input.focus({ preventScroll: true });
    });
  }

  AccessPanel.prototype.wireHandlers = function () {
    const self = this;
    const slug = this.slug();
    const body = this.body();

    const teamToggle = body.querySelector('#ax-team-invite');
    if (teamToggle) {
      teamToggle.addEventListener('change', async () => {
        const out = body.querySelector('#ax-team-invite-result');
        const want = teamToggle.checked;
        teamToggle.disabled = true;
        try {
          await api.teamInvite(slug, want);
          if (out) out.innerHTML = `<div class="access-invite-result">${want
            ? 'The team can now invite people and hand out share links.'
            : 'Only you can invite people now.'}</div>`;
          await self.load();
        } catch (err) {
          teamToggle.checked = !want;
          teamToggle.disabled = false;
          if (out) out.innerHTML = `<div class="access-invite-result">Could not change that: ${esc(err.message)}</div>`;
        }
      });
    }

    body.querySelectorAll('[data-revoke]').forEach(b => {
      b.addEventListener('click', async () => {
        const email = b.dataset.revoke;
        if (!confirm(`Remove ${email} from this race?`)) return;
        b.disabled = true; b.textContent = '…';
        try { await api.accessRemove(slug, email); await self.load(); }
        catch (err) { alert('Could not revoke: ' + err.message); b.disabled = false; b.textContent = 'Revoke'; }
      });
    });
    // Changing a role is the same call as adding one, so a promotion never
    // leaves someone briefly with no access at all.
    body.querySelectorAll('[data-set-role]').forEach(sel => {
      const was = sel.value;
      sel.addEventListener('change', async () => {
        const email = sel.dataset.setRole;
        sel.disabled = true;
        try { await api.accessAdd(slug, email, sel.value); await self.load(); }
        catch (err) {
          alert('Could not change role: ' + err.message);
          sel.value = was; sel.disabled = false;
        }
      });
    });
    body.querySelectorAll('[data-copy-share]').forEach(b => {
      b.addEventListener('click', () => copyToClipboard(b.dataset.copyShare, b));
    });
    body.querySelectorAll('[data-revoke-share]').forEach(b => {
      b.addEventListener('click', async () => {
        if (!confirm('Revoke this share link?')) return;
        b.disabled = true; b.textContent = '…';
        try { await api.shareRevoke(b.dataset.revokeShare); await self.load(); }
        catch (err) { alert('Could not revoke: ' + err.message); b.disabled = false; b.textContent = 'Revoke'; }
      });
    });
    body.querySelectorAll('[data-revoke-invite]').forEach(b => {
      b.addEventListener('click', async () => {
        if (!confirm('Cancel this pending invite? The link will stop working.')) return;
        b.disabled = true; b.textContent = '…';
        try { await api.shareRevoke(b.dataset.revokeInvite); await self.load(); }
        catch (err) { alert('Could not cancel: ' + err.message); b.disabled = false; b.textContent = 'Cancel'; }
      });
    });

    const inviteBtn = body.querySelector('#ax-invite');
    if (inviteBtn) inviteBtn.addEventListener('click', async () => {
      const email = body.querySelector('#ax-email').value.trim();
      const role = body.querySelector('#ax-role').value;
      const out = body.querySelector('#ax-invite-result');
      if (!email) { out.innerHTML = `<div class="access-err">Email required.</div>`; return; }
      inviteBtn.disabled = true; inviteBtn.textContent = 'Generating…';
      try {
        const r = await api.invite(slug, email, role);
        // Re-render the panel first (it shows the new pending invite), then
        // render the result box into the fresh node so it isn't wiped.
        await self.load();
        const out2 = self.body().querySelector('#ax-invite-result');
        if (out2) {
          out2.innerHTML = `
            <div class="access-invite-result">
              <div>Send this link to <strong>${esc(email)}</strong>. They'll set a password and land on the race as ${esc(roles.label(role))}.</div>
              <span class="url">${esc(r.url)}</span>
              <button class="btn copy" data-copy-share="${esc(r.url)}">Copy link</button>
            </div>`;
          out2.querySelector('[data-copy-share]').addEventListener('click', (e) => copyToClipboard(r.url, e.currentTarget));
        }
      } catch (err) {
        out.innerHTML = `<div class="access-err">${esc(err.message)}</div>`;
        inviteBtn.disabled = false; inviteBtn.textContent = 'Generate invite link';
      }
    });

    const addExistingBtn = body.querySelector('#ax-add-existing');
    if (addExistingBtn) addExistingBtn.addEventListener('click', async () => {
      const email = body.querySelector('#ax-email').value.trim();
      const role = body.querySelector('#ax-role').value;
      const out = body.querySelector('#ax-invite-result');
      if (!email) { out.innerHTML = `<div class="access-err">Email required.</div>`; return; }
      addExistingBtn.disabled = true; addExistingBtn.textContent = 'Adding…';
      try {
        await api.accessAdd(slug, email, role);
        await self.load();
        const out2 = self.body().querySelector('#ax-invite-result');
        if (out2) out2.innerHTML = `<div class="access-invite-result">Added ${esc(email)} as ${esc(roles.label(role))}. They'll see this race in their hub on next visit.</div>`;
      } catch (err) {
        out.innerHTML = `<div class="access-err">${esc(err.message)}</div>`;
        addExistingBtn.disabled = false; addExistingBtn.textContent = 'Add (already has account)';
      }
    });

    const shareBtn = body.querySelector('#ax-share');
    if (shareBtn) shareBtn.addEventListener('click', async () => {
      const out = body.querySelector('#ax-share-result');
      shareBtn.disabled = true; shareBtn.textContent = 'Generating…';
      try {
        const r = await api.shareLink(slug, 'view');
        await self.load();
        const out2 = self.body().querySelector('#ax-share-result');
        if (out2) {
          out2.innerHTML = `
            <div class="access-share-result">
              <div>Anyone with this link can view the live dashboard for the next 30 days. Revoke any time below.</div>
              <span class="url">${esc(r.url)}</span>
              <button class="btn copy" data-copy-share="${esc(r.url)}">Copy link</button>
            </div>`;
          out2.querySelector('[data-copy-share]').addEventListener('click', (e) => copyToClipboard(r.url, e.currentTarget));
        }
      } catch (err) {
        out.innerHTML = `<div class="access-err">${esc(err.message)}</div>`;
        shareBtn.disabled = false; shareBtn.textContent = 'Generate view share link';
      }
    });
  };

  function copyToClipboard(text, btn) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => flashBtn(btn, 'Copied ✓'), () => fallbackCopy(text, btn));
    } else {
      fallbackCopy(text, btn);
    }
  }

  function fallbackCopy(text, btn) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); flashBtn(btn, 'Copied ✓'); }
    catch (e) { flashBtn(btn, 'Copy failed'); }
    ta.remove();
  }

  function flashBtn(btn, label) {
    if (!btn) return;
    const was = btn.textContent;
    btn.textContent = label;
    setTimeout(() => { btn.textContent = was; }, 1600);
  }

  // ---------- expose ----------
  window.Race = { fmt, units, slug, qs, raceHref, poll, raceState, POLL_MS, live, hub, config, auth, share, api, gh, queue, roles, plans, archive, activities, nav, course, stationAt, fuel, compute, gpx, charts, access, mountAccountWidget, mountBetaBadge, offline, lastSeen, feedback, openFeedbackModal, openSigninModal };
})();
