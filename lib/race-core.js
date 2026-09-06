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
    return new URLSearchParams(location.search).get(name);
  }

  // ---------- hub config (hub.json) ----------
  // hub.json at repo root carries optional auth.proxyUrl. When set,
  // writes go through the worker; otherwise pages use direct PAT mode.
  const hub = {
    _data: null,
    _promise: null,
    async load() {
      if (this._data) return this._data;
      if (this._promise) return this._promise;
      this._promise = (async () => {
        try {
          const res = await fetch('hub.json?_=' + Date.now(), { cache: 'no-store' });
          this._data = res.ok ? await res.json() : {};
        } catch (e) { this._data = {}; }
        return this._data;
      })();
      return this._promise;
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

  const gh = {
    utf8ToBase64, base64ToUtf8,

    async getFile(cfg, path) {
      if (cfg.mode === 'proxy') {
        const url = `${cfg.proxyUrl}/get?path=${encodeURIComponent(path)}`;
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
    async mutateJson(cfg, path, mutate, message, tries) {
      tries = tries || 4;
      let lastErr = null;
      for (let i = 0; i < tries; i++) {
        const r = await gh.getJson(cfg, path);
        const data = r.data || {};
        const next = mutate(data) || data;
        try {
          return await gh.putJson(cfg, path, next, r.sha, message);
        } catch (err) {
          lastErr = err;
          if (err.status !== 409) throw err;
        }
      }
      throw lastErr || new Error('Too many sha conflicts');
    },

    // Read a race JSON file (races/<slug>/<file>).
    // Anonymous viewers read from GitHub Pages (CDN-cached, no auth). With
    // preferWorker, a signed-in/PAT reader goes through the worker first, // that hits GitHub's API directly, so live data isn't stale behind the
    // Pages rebuild. Pages stays the fallback either way.
    async readRaceJson(slug, file, preferWorker) {
      const cfg = auth.cfg();
      const path = `races/${slug}/${file}`;
      if (preferWorker && cfg) {
        try {
          const r = await gh.getJson(cfg, path);
          if (!r.missing) return r.data;
        } catch (e) { /* fall through to Pages */ }
      }
      try {
        const res = await netFetch(`races/${encodeURIComponent(slug)}/${file}?_=` + Date.now(), { cache: 'no-store' });
        if (res.ok) { offline.noteResponse(res); return await res.json(); }
      } catch (e) { /* fall through */ }
      if (cfg) {
        const r = await gh.getJson(cfg, path);
        if (!r.missing) return r.data;
      }
      throw new Error(`${file} not found for race "${slug}"`);
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
      const out = [{ name: segs[0].fromAid || 'Start', mileage: 0 }];
      let cum = 0;
      for (const s of segs) {
        cum += (s.distanceMi || 0);
        out.push({ name: s.toAid || `Aid ${out.length}`, mileage: +cum.toFixed(2) });
      }
      return out;
    },

    // Rebuild segments[] from an aid-station list [{name, mileage, arriveCutoffHours?}].
    // The start aid contributes only its name to seg[0].fromAid; downstream aids
    // become toAid for the segment and fromAid for the next.
    segmentsFromAidStations(aids, prevSegments) {
      const out = [];
      for (let i = 0; i < aids.length - 1; i++) {
        const from = aids[i], to = aids[i + 1];
        const dist = +(to.mileage - from.mileage).toFixed(2);
        // Preserve any prior elevation data when aid order is unchanged.
        const prev = (prevSegments && prevSegments[i]) || {};
        const matched = prev.fromAid === from.name && prev.toAid === to.name;
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
    metrics(cfg) {
      const listed = cfg && Array.isArray(cfg.fuelMetrics) ? cfg.fuelMetrics : DEFAULT_FUEL;
      const t = (cfg && cfg.targets) || {};
      return listed.filter(m => m && m.key).map(m => {
        const targetKey = m.key + 'PerHour';
        const raw = t[targetKey];
        return {
          key: m.key,
          label: m.label || m.key,
          unit: m.unit || '',
          short: m.short || m.label || m.key,
          decimals: m.decimals != null ? +m.decimals : 0,
          step: m.step != null ? +m.step : 1,
          targetKey,
          targetPerHour: (raw == null || raw === '' || !+raw) ? null : +raw
        };
      });
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

    // Sum positive/negative deltas between cumulative-mileage range [fromMi, toMi].
    elevationBetween(pts, fromMi, toMi) {
      let gainM = 0, lossM = 0;
      let prev = null;
      for (const p of pts) {
        if (p.dist < fromMi) continue;
        if (p.dist > toMi) break;
        if (prev) {
          const dz = p.ele - prev.ele;
          if (dz > 0) gainM += dz; else lossM += -dz;
        }
        prev = p;
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
  // Injects a slim "signed in as <email> · Sign out" strip above header.site
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
        '<label class="modal-field"><span>Notes for your crew</span>' +
          '<textarea id="prof-notes" rows="4" placeholder="What you want them to know without being asked. ' +
            'Allergies, what settles late, what to do when you go quiet."></textarea></label>' +
      '</div>';

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
      '<p class="modal-hint">Forgot your password? <a href="/?reset=1" style="color: var(--accent);">Request a password reset</a>.<br>' +
        'No account yet? <a href="/?invite=1" style="color: var(--accent);">Request an invite</a>.</p>';
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
    if (!header || !header.parentNode) return;

    let bar = document.querySelector('.account-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'account-bar';
      header.parentNode.insertBefore(bar, header);
    }

    function render() {
      if (!hub.isProxyMode()) { bar.style.display = 'none'; return; }
      bar.style.display = '';
      const s = auth.loadSession();
      const signedIn = !!(s && s.session && (!s.expiresAt || s.expiresAt > Date.now()));
      if (signedIn) {
        const isAdmin = s.role === 'admin';
        bar.innerHTML =
          '<span class="account-dot"></span>' +
          '<span class="account-email"></span>' +
          (isAdmin ? '<a class="account-admin" href="admin.html">Admin</a>' : '') +
          '<button type="button" class="account-profile">Profile</button>' +
          '<button type="button" class="account-pw">Password</button>' +
          '<button type="button" class="account-signout">Sign out</button>';
        bar.querySelector('.account-email').textContent = s.email || s.username || 'account';
        bar.querySelector('.account-profile').addEventListener('click', openProfileModal);
        bar.querySelector('.account-pw').addEventListener('click', openPasswordModal);
        bar.querySelector('.account-signout').addEventListener('click', () => {
          auth.logout();
          location.reload();
        });
      } else {
        bar.innerHTML = '<button type="button" class="account-signin">Sign in</button>';
        bar.querySelector('.account-signin').addEventListener('click', openSigninModal);
      }
    }

    // Let auth.saveSession/clearSession refresh the bar on later sign-in/out.
    accountWidgetRender = render;

    // hub.json may still be loading; render once now and again once it resolves.
    render();
    hub.load().then(render);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountAccountWidget);
  } else {
    mountAccountWidget();
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
      if (opts.target != null) allY.push(opts.target);
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
      if (opts.target != null && opts.target >= yMin && opts.target <= yMax) {
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
      const t = cfg.targets || {};
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
                `<div class="intake-card"><h3>${fuel.fieldLabel(m)} / hour</h3>` +
                `<svg id="chart-fuel-${m.key}" class="chart-svg"></svg></div>`).join('') +
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
      for (const m of fuel.metrics(cfg)) {
        charts.lineChart(svg('chart-fuel-' + m.key), intakeOne(l => l[m.key]), {
          height: 220, xMin: 1, xMax: legCount,
          target: m.targetPerHour,
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

  // ---------- offline ----------
  // The service worker makes the app openable without signal. This is the part
  // the person sees: whether what is on screen came off the network or out of
  // storage, and how old it is. Showing a saved split as though it were live is
  // the one thing worse than showing nothing.
  const offline = {
    // Set when a read is answered from cache; the worker stamps the header.
    stale: false,
    staleAt: null,

    noteResponse(res) {
      if (res && res.headers && res.headers.get('X-SendOff-Cache') === 'hit') {
        offline.stale = true;
        const d = res.headers.get('date');
        offline.staleAt = d ? new Date(d) : offline.staleAt;
      } else if (res) {
        offline.stale = false;
        offline.staleAt = null;
      }
      offline.render();
      return res;
    },

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

    render() {
      let el = document.getElementById('so-offline-bar');
      const msg = offline.message();
      if (!msg) { if (el) el.remove(); return; }
      if (!el) {
        el = document.createElement('div');
        el.id = 'so-offline-bar';
        el.setAttribute('role', 'status');
        el.setAttribute('role', 'status');
        document.body.appendChild(el);
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
    },

    register() {
      if (!('serviceWorker' in navigator)) return;
      // file:// and plain http have no worker, and registering from a page
      // served off something other than the site root would scope it wrongly.
      if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(() => {});
      });
      window.addEventListener('online', () => { offline.stale = false; offline.render(); queue.flush(); });
      window.addEventListener('offline', offline.render);
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

  // ---------- expose ----------
  window.Race = { fmt, units, slug, qs, hub, config, auth, share, api, gh, queue, roles, course, stationAt, fuel, compute, gpx, charts, mountAccountWidget, offline };
})();
