// Cloudflare Worker: race-dashboard auth proxy.
//
// Endpoints (all under whatever base path you mount the worker at):
//
//   Auth & users
//     POST /login            { email, password }                      → { token, email, role, expiresAt }
//     POST /accept-invite    { token, password }                      → { token, email, expiresAt, slug, role }
//     POST /change-password  { currentPassword, newPassword }          → { ok: true }  (session required)
//     POST /reset-link       { email }                                 → { url, token } (admin only)
//     GET  /reset-info?token=...                                        → { email }
//     POST /reset-password   { token, newPassword }                     → { token, email, role, expiresAt }
//     POST /account-invite   { email }                                 → { url, token } (admin only)
//     GET  /account-invite-info?token=...                               → { email }
//     POST /accept-account-invite { token, password }                   → { token, email, role, expiresAt }
//     GET  /accounts                                                    → { accounts, pendingInvites } (admin only)
//     POST /account/delete   { email }                                  → { ok: true } (admin only, KV accounts)
//     GET  /account-races?email=...                                     → { races } (admin only)
//
//   Race file IO (session required; reads honour share-token query)
//     POST /commit           { path, content, sha?, message }         → GitHub PUT response (writer ACL enforced)
//     GET  /get?path=...     [?t=<share-token>]                       → GitHub Contents response (reader ACL enforced)
//
//   Access management (session required; creator/editor only)
//     POST /invite           { slug, email, role }                    → { url, token, expiresAt }
//         role is crew | racer | pacer | viewer. The first three can write;
//         viewer is read-only. "editor" is still accepted and means crew.
//     POST /share-link       { slug, role: 'view'|'edit',
//                              expiresAt? }                            → { url, token, expiresAt? }
//     POST /access/add       { slug, email, role }                    → { people, editors, viewers }
//     POST /access/remove    { slug, email }                          → { people, editors, viewers }
//     POST /share/revoke     { token }                                 → { ok: true }
//     GET  /access?slug=...                                            → { people, editors, viewers, shareLinks, teamCanInvite }
//     POST /access/team-invite { slug, allowed }                       → { teamCanInvite }
//     GET  /profile[?email=&slug=]                                     → { profile, own }
//     POST /profile          { displayName, targets, phaseTargets, notes } → { profile }
//         Your own by default. A teammate's only via a race you can write
//         and they are on. Writing is always your own.
//         Creator only. Off by default: without it, only the creator can
//         invite, add, remove, or hand out share links.
//
//   Race listing for logged-in users
//     GET  /my-races                                                   → { races: [...] }
//     GET  /next-race-id                                               → { id: "000042" }
//     POST /race/delete      { slug }                                  → { ok, deleted } (creator only)
//
//   Misc
//     GET  /health                                                     → { ok: true }
//
// Env vars (`wrangler secret put` for sensitive values):
//   GITHUB_TOKEN     PAT with Contents: Read and write on the hub repo
//   GITHUB_OWNER     e.g. "jpdupree"
//   GITHUB_REPO      e.g. "race-dashboard"
//   GITHUB_BRANCH    e.g. "main"
//   JWT_SECRET       random string, used to sign session tokens (HS256)
//   USERS            JSON array: [{ email|username, hash, salt, iterations, role? }]
//                    Generate hash/salt with admin/hash.html (PBKDF2-SHA256).
//   ALLOWED_ORIGINS  optional, comma-separated list. Defaults to "*".
//   PUBLIC_BASE_URL  optional, used for building invite/share URLs (e.g. https://jpdupree.github.io/race-dashboard).
//                    Defaults to deriving from the first allowed origin.
//
// KV bindings (set in wrangler.toml: optional):
//   AUTH_KV          stores invite tokens, share tokens, and dynamically created users.
//                    Without it, /login still works with USERS env var and ACL still works,
//                    but invite & share-link endpoints return 503.
//
// Session JWTs are HS256, 7 days. Share-token sessions are scoped to a single race and role.

const SESSION_HOURS = 168; // 7 days
const PBKDF2_DEFAULT_ITERATIONS = 100000;
const INVITE_TTL_DAYS = 14;
const SHARE_TTL_DAYS_DEFAULT = 30;
const RESET_TTL_DAYS = 2;

// ---------- CORS ----------
function corsHeaders(env, req) {
  const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
  const origin = req.headers.get('Origin') || '';
  let allowOrigin = '*';
  if (allowed[0] !== '*') {
    allowOrigin = allowed.includes(origin) ? origin : allowed[0];
  }
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(data, init, env, req) {
  return new Response(JSON.stringify(data), {
    ...(init || {}),
    headers: {
      ...((init && init.headers) || {}),
      'Content-Type': 'application/json',
      ...corsHeaders(env, req)
    }
  });
}

// ---------- base64 helpers ----------
function bytesToBase64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function base64ToBytes(s) {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64UrlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return base64ToBytes(s);
}

// UTF-8 string → base64 (for GitHub PUT content)
function utf8ToBase64(s) {
  const enc = new TextEncoder();
  return bytesToBase64(enc.encode(s));
}
function base64ToUtf8(b64) {
  const bytes = base64ToBytes(b64.replace(/\s/g, ''));
  return new TextDecoder('utf-8').decode(bytes);
}

function randomToken(bytes) {
  const buf = new Uint8Array(bytes || 24);
  crypto.getRandomValues(buf);
  return bytesToBase64Url(buf);
}

function normalizeEmail(s) {
  return String(s || '').trim().toLowerCase();
}

// ---------- PBKDF2 password verification + hashing ----------
async function deriveBits(password, saltBytes, iterations) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations: iterations || PBKDF2_DEFAULT_ITERATIONS, hash: 'SHA-256' },
    keyMaterial, 256
  );
}

async function verifyPassword(password, hashB64, saltB64, iterations) {
  const salt = base64ToBytes(saltB64);
  const expected = base64ToBytes(hashB64);
  const bits = await deriveBits(password, salt, iterations);
  const actual = new Uint8Array(bits);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

async function hashPassword(password) {
  const saltBytes = new Uint8Array(16);
  crypto.getRandomValues(saltBytes);
  const iterations = PBKDF2_DEFAULT_ITERATIONS;
  const bits = await deriveBits(password, saltBytes, iterations);
  return {
    hash: bytesToBase64(new Uint8Array(bits)),
    salt: bytesToBase64(saltBytes),
    iterations
  };
}

// ---------- HS256 JWT ----------
async function hmacKey(secret) {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
}

async function signJwt(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const enc = new TextEncoder();
  const headerB64 = bytesToBase64Url(enc.encode(JSON.stringify(header)));
  const payloadB64 = bytesToBase64Url(enc.encode(JSON.stringify(payload)));
  const data = headerB64 + '.' + payloadB64;
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return data + '.' + bytesToBase64Url(new Uint8Array(sig));
}

async function verifyJwt(token, secret) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const enc = new TextEncoder();
  const data = parts[0] + '.' + parts[1];
  try {
    const key = await hmacKey(secret);
    const sig = base64UrlToBytes(parts[2]);
    const ok = await crypto.subtle.verify('HMAC', key, sig, enc.encode(data));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[1])));
    if (payload.exp && payload.exp < Date.now()) return null;
    return payload;
  } catch (e) { return null; }
}

async function requireAuth(req, env) {
  const h = req.headers.get('authorization') || '';
  const token = h.replace(/^Bearer\s+/i, '');
  return verifyJwt(token, env.JWT_SECRET);
}

// ---------- user lookup ----------
// Users come from two places:
//   - USERS env var (admin-managed, baked in at deploy)
//   - AUTH_KV at key user:<email> (dynamically created via invite acceptance)
// Users come from two places. AUTH_KV (user:<email>) is checked FIRST so a
// changed password: written to KV: overrides the baked-in USERS env var.
// USERS is the bootstrap set; KV is the live store.
async function lookupUser(env, email) {
  email = normalizeEmail(email);
  if (!email) return null;
  if (env.AUTH_KV) {
    const raw = await env.AUTH_KV.get('user:' + email);
    if (raw) {
      try {
        const u = JSON.parse(raw);
        return { email, hash: u.hash, salt: u.salt, iterations: u.iterations,
                 role: u.role || 'crew', plan: u.plan || DEFAULT_PLAN,
                 earlyAccess: u.earlyAccess !== false, source: 'kv' };
      } catch (e) {}
    }
  }
  let envUsers = [];
  try { envUsers = JSON.parse(env.USERS || '[]'); } catch (e) { envUsers = []; }
  const envUser = envUsers.find(u => normalizeEmail(u.email || u.username) === email);
  if (envUser) {
    return {
      email,
      hash: envUser.hash,
      salt: envUser.salt,
      iterations: envUser.iterations,
      role: envUser.role || 'crew',
      source: 'env'
    };
  }
  return null;
}

// Merge into whatever is already stored rather than replacing it. Every writer
// below used to reconstruct the record from the handful of fields it happened
// to care about, so changing a password silently dropped createdAt, and would
// have dropped a plan the moment one existed.
async function putUserRecord(env, email, changes) {
  email = normalizeEmail(email);
  let existing = {};
  const raw = await env.AUTH_KV.get('user:' + email);
  if (raw) { try { existing = JSON.parse(raw) || {}; } catch (e) { existing = {}; } }
  const next = Object.assign({}, existing, changes, { email });
  if (!next.role) next.role = 'crew';
  if (!next.plan) next.plan = DEFAULT_PLAN;
  // Everyone signing up while these are free keeps them. See ROADMAP.md.
  if (next.earlyAccess === undefined) next.earlyAccess = true;
  await env.AUTH_KV.put('user:' + email, JSON.stringify(next));
  return next;
}

async function createUserInKv(env, email, password, role) {
  if (!env.AUTH_KV) throw new Error('AUTH_KV is not configured');
  email = normalizeEmail(email);
  const existing = await lookupUser(env, email);
  if (existing) throw new Error('User already exists');
  const { hash, salt, iterations } = await hashPassword(password);
  await putUserRecord(env, email, {
    hash, salt, iterations, role: role || 'crew', createdAt: new Date().toISOString()
  });
}

// ---------- plans and entitlements ----------
// One table, mirrored in lib/race-core.js for the UI. This one is the gate;
// the copy in the client only decides which buttons to draw. Getting the
// client's wrong shows somebody a button that fails. Getting this one wrong is
// a hole.
//
// Nothing is charged for yet. Every account is created on `pro` with
// `earlyAccess` set, deliberately, so the machinery can be exercised long
// before there is a checkout. An account is moved to `free` by an admin, which
// is how you test what a free account sees.
const PLANS = {
  free: {
    label: 'Free',
    maxRunnersPerRace: 1,
    maxCrewPerRace: 2,
    privateRaces: false,
    shareLinks: false
  },
  pro: {
    label: 'Pro',
    maxRunnersPerRace: null,     // null means no cap
    maxCrewPerRace: null,
    privateRaces: true,
    shareLinks: true
  }
};
const DEFAULT_PLAN = 'pro';

// The promise in ROADMAP.md: four things ship free today that the pricing plan
// puts in Pro, and anyone using them before that changes keeps them. This is
// that promise, as one line of code. It grants capabilities and never lifts the
// scale caps, because the caps were never given away.
//
// Two of the four, not four. The promise also covers offline logging and
// role-based permissions, and neither is here because neither is gated by plan
// yet, so there is nothing to restore. Gating either one means adding it to
// this list in the same change. Leaving it for afterwards breaks the promise
// for every account that signed up while it was free, and does it quietly.
const GRANDFATHERED = ['privateRaces', 'shareLinks'];

function entitlementsFor(user) {
  const plan = (user && PLANS[user.plan]) ? user.plan : DEFAULT_PLAN;
  const out = Object.assign({ plan }, PLANS[plan]);
  if (user && user.earlyAccess) {
    for (const k of GRANDFATHERED) out[k] = true;
    out.earlyAccess = true;
  }
  return out;
}

// Entitlements of whoever owns the race, not whoever is writing to it. A crew
// member on Pro must not be able to raise a free account's race past its caps
// by editing it.
async function raceOwnerEntitlements(env, raceCfg) {
  const owner = raceCfg && raceCfg.createdBy;
  if (!owner) return entitlementsFor(null);
  const user = await lookupUser(env, owner);
  return entitlementsFor(user);
}

// A cap is checked against what is being asked for, never against what is
// already stored. A race that is over its cap because the plan changed under it
// keeps working; it just cannot grow. Bricking somebody's race on the morning
// of it, over billing, would be indefensible.
function overCap(cap, wanted, existing) {
  if (cap == null) return false;
  if (wanted <= cap) return false;
  return wanted > Math.max(cap, existing);
}

// ---------- profiles ----------
// What a person brings to any race: what they aim to take in per hour, and the
// notes a crew would otherwise be told out loud at the trailhead and forget by
// mile 30. Kept per account rather than per race, because a runner's stomach
// does not reset between events.
//
// Stored under its own KV key rather than on the user record, which holds the
// password hash. A teammate is allowed to read your fuel defaults; nothing
// should put them one field away from your credentials.
const PROFILE_NOTES_MAX = 2000;

function emptyProfile(email) {
  return { email, displayName: '', targets: {}, phaseTargets: [], notes: '', updatedAt: null };
}

async function loadProfile(env, email) {
  email = normalizeEmail(email);
  if (!email || !env.AUTH_KV) return emptyProfile(email);
  const raw = await env.AUTH_KV.get('profile:' + email);
  if (!raw) return emptyProfile(email);
  try {
    const p = JSON.parse(raw);
    return {
      email,
      displayName: typeof p.displayName === 'string' ? p.displayName : '',
      targets: (p.targets && typeof p.targets === 'object' && !Array.isArray(p.targets)) ? p.targets : {},
      phaseTargets: Array.isArray(p.phaseTargets) ? p.phaseTargets : [],
      notes: typeof p.notes === 'string' ? p.notes : '',
      updatedAt: p.updatedAt || null
    };
  } catch (e) { return emptyProfile(email); }
}

// Per-hour numbers only, and only sane ones. A profile is written by its owner
// and read by their crew, so a bad number here would show up as a target
// nobody set, and a huge object would be a way to fill the namespace.
function cleanTargets(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const key of Object.keys(input).slice(0, 24)) {
    if (!/^[A-Za-z0-9_]{1,40}PerHour$/.test(key)) continue;
    const n = Number(input[key]);
    if (!Number.isFinite(n) || n < 0 || n > 100000) continue;
    out[key] = n;
  }
  return out;
}

// Hour-banded targets: "250 cal/hr for the first six hours, 180 after". Sorted
// and de-duplicated on the way in so every reader can assume the bands are in
// order and can take the last one whose start hour has passed.
function cleanPhaseTargets(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const bands = [];
  for (const raw of input.slice(0, 12)) {
    if (!raw || typeof raw !== 'object') continue;
    const fromHour = Number(raw.fromHour);
    if (!Number.isFinite(fromHour) || fromHour < 0 || fromHour > 240) continue;
    const h = Math.round(fromHour * 4) / 4;   // quarter-hour resolution
    if (seen.has(h)) continue;
    seen.add(h);
    bands.push({ fromHour: h, label: typeof raw.label === 'string' ? raw.label.slice(0, 60) : '',
                 targets: cleanTargets(raw.targets) });
  }
  return bands.sort((a, b) => a.fromHour - b.fromHour);
}

// ---------- GitHub Contents API helpers ----------
async function githubGet(env, path) {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodeURI(path)}?ref=${encodeURIComponent(env.GITHUB_BRANCH || 'main')}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `token ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'race-dashboard-proxy'
    }
  });
  return res;
}

// Reads coalesced in the edge cache.
//
// Watching a race is a poll, and every poll of a race file costs two GitHub
// calls: one to read the race config for the access check, and one for the
// file itself. Six polls a minute across two files is 1,440 calls an hour per
// open dashboard, and GitHub allows 5,000, so three or four people watching
// the same race was the whole budget. Cached, a hundred people watching one
// race cost what one person costs.
//
// The window is deliberately shorter than any poll interval, and a write
// purges the paths it touched, so the only staleness left is between readers
// during the same three seconds. The purge is per-colo, which is what the
// short window is really for: a reader somewhere else can still be up to
// CACHE_TTL_S behind.
//
// The access check is not cached. It re-runs against the cached config on
// every single request, so this changes how often GitHub is asked, never who
// is allowed to see the answer.
const CACHE_TTL_S = 3;

function readCacheKey(env, path) {
  const owner = env.GITHUB_OWNER, repo = env.GITHUB_REPO;
  const branch = env.GITHUB_BRANCH || 'main';
  return new Request(
    `https://race-read-cache.invalid/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/` +
    `${encodeURIComponent(branch)}/${encodeURIComponent(path)}`);
}

// Same contract as githubGet, plus a short shared cache. Only 200s are cached:
// a cached 404 is the exact failure that made creating a race break.
async function githubGetShared(env, path) {
  let cache = null;
  try { cache = caches.default; } catch (e) { /* no cache here, go direct */ }
  const key = cache ? readCacheKey(env, path) : null;
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return hit;
  }
  const res = await githubGet(env, path);
  if (cache && res.status === 200) {
    const body = await res.clone().text();
    const cacheable = new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${CACHE_TTL_S}` }
    });
    try { await cache.put(key, cacheable.clone()); } catch (e) { /* best effort */ }
    return cacheable;
  }
  return res;
}

async function purgeReadCache(env, path) {
  try { await caches.default.delete(readCacheKey(env, path)); } catch (e) { /* best effort */ }
}

async function githubGetJson(env, path) {
  const res = await githubGet(env, path);
  if (res.status === 404) return { sha: null, data: null, missing: true };
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET ${path} ${res.status}: ${text.slice(0, 200)}`);
  }
  const j = await res.json();
  return { sha: j.sha, data: JSON.parse(base64ToUtf8(j.content)), missing: false };
}

async function githubPutJson(env, path, data, sha, message, actor) {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodeURI(path)}`;
  const body = {
    message: actor ? `${message} (via ${actor})` : message,
    branch: env.GITHUB_BRANCH || 'main',
    content: utf8ToBase64(JSON.stringify(data, null, 2) + '\n')
  };
  if (sha) body.sha = sha;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `token ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'race-dashboard-proxy'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PUT ${path} ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// Optimistic-concurrency mutator: GET, apply, PUT, retry on a sha conflict.
// `missing` decides what an absent file means, since a race config that is not
// there is an error while the hub manifest simply starts empty.
async function mutateJsonAt(env, path, mutate, message, actor, onMissing) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await githubGetJson(env, path);
    if (r.missing && onMissing === 'throw') throw new Error(`"${path}" not found`);
    const next = mutate(r.missing ? null : r.data) || r.data;
    try {
      await githubPutJson(env, path, next, r.sha, message, actor);
      return next;
    } catch (err) {
      if (!/\b409\b/.test(err.message)) throw err;
    }
  }
  throw new Error(`Too many sha conflicts updating ${path}`);
}

// Applies a change to a race's access list. It used to be a commit to
// config.json, which is how the roster came to be published in the first
// place; it is a KV write now. The mutate function still receives and returns
// a config-shaped object, so the callers below read the same as they always
// did.
async function mutateRaceConfig(env, slug, mutate, message, actor) {
  const cfg = await loadRaceConfig(env, slug);
  if (!cfg) throw new Error(`Race not found: ${slug}`);
  const next = mutate(Object.assign({}, cfg)) || cfg;
  await writeAcl(env, slug, aclFromConfig(next));
  return next;
}

// ---------- path / ACL helpers ----------
function isRacePath(path) {
  return /^races\/[^/]+\/[^/]+$/.test(path);
}
function racePathSlug(path) {
  const m = /^races\/([^/]+)\//.exec(path);
  return m ? m[1] : null;
}

// ---------- the access list ----------
// Who owns a race and who is on it, kept in KV rather than in the race config.
//
// The config is a file in a public repository, published by Pages, so anything
// in it is readable by anyone who asks for the URL. A roster is a list of
// people's email addresses. It was being published for every race, private or
// not, which is a thing nobody agreed to.
//
// KV rather than D1 on purpose. KV is already load-bearing here, so this adds
// no new way for the app to fail; D1 would, and a fortnight before a race is
// the wrong time to put access control on a dependency that has never carried
// anything. It moves to D1 with the rest of the data afterwards.
//
// Races written before this keep their roster in the config, so a missing KV
// entry falls back to the file and is copied across the first time it is read.
const ACL_KEY = slug => 'acl:' + slug;

// Which runner record belongs to which account. Set on the settings page so
// racer mode knows whose splits it is looking at, and published in the config
// until now for exactly the reason the roster was: nobody thought about the
// file being world readable.
function runnerLinksFromConfig(cfg) {
  const out = {};
  for (const r of ((cfg && cfg.runners) || [])) {
    const email = normalizeEmail(r && r.email);
    if (r && r.id && email) out[r.id] = email;
  }
  return out;
}

function aclFromConfig(cfg) {
  return {
    createdBy: normalizeEmail(cfg && cfg.createdBy) || null,
    people: racePeople(cfg),
    teamCanInvite: !!(cfg && cfg.teamCanInvite),
    runnerEmails: runnerLinksFromConfig(cfg)
  };
}

async function readAcl(env, slug) {
  if (!env.AUTH_KV) return null;
  try {
    const raw = await env.AUTH_KV.get(ACL_KEY(slug));
    if (!raw) return null;
    const a = JSON.parse(raw);
    return {
      createdBy: normalizeEmail(a.createdBy) || null,
      people: Array.isArray(a.people)
        ? a.people.filter(p => p && p.email).map(p => ({
            email: normalizeEmail(p.email),
            role: RACE_ROLES.includes(p.role) ? p.role : 'viewer'
          }))
        : [],
      teamCanInvite: !!a.teamCanInvite,
      runnerEmails: (a.runnerEmails && typeof a.runnerEmails === 'object') ? a.runnerEmails : {}
    };
  } catch (e) { return null; }
}

async function writeAcl(env, slug, acl) {
  if (!env.AUTH_KV) throw new Error('Access control requires AUTH_KV');
  await env.AUTH_KV.put(ACL_KEY(slug), JSON.stringify({
    createdBy: normalizeEmail(acl.createdBy) || null,
    people: (acl.people || []).map(p => ({ email: normalizeEmail(p.email), role: p.role })),
    teamCanInvite: !!acl.teamCanInvite,
    runnerEmails: acl.runnerEmails || {},
    updatedAt: new Date().toISOString()
  }));
}

// Put the access list back onto the config, so every caller below reads the
// same shape it always did whether the roster is in KV or still in the file.
function withAcl(cfg, acl) {
  if (!cfg || !acl) return cfg;
  const out = Object.assign({}, cfg);
  out.createdBy = acl.createdBy;
  out.teamCanInvite = acl.teamCanInvite;
  setRacePeople(out, acl.people);
  const links = acl.runnerEmails || {};
  out.runners = (cfg.runners || []).map(r => (
    r && r.id && links[r.id] ? Object.assign({}, r, { email: links[r.id] }) : r));
  return out;
}

// The config as the rest of the worker wants it: the file, plus the access
// list, from KV when it is there and from the file itself when it is not. A
// race read for the first time since this shipped has its roster copied into
// KV, so the migration happens by being used.
async function attachAcl(env, slug, cfg) {
  if (!cfg) return cfg;
  const stored = await readAcl(env, slug);
  if (stored) return withAcl(cfg, stored);
  const fromFile = aclFromConfig(cfg);
  if (env.AUTH_KV && (fromFile.createdBy || fromFile.people.length)) {
    try { await writeAcl(env, slug, fromFile); } catch (e) { /* read still works */ }
  }
  return withAcl(cfg, fromFile);
}

async function loadRaceConfig(env, slug) {
  const r = await githubGetJson(env, `races/${slug}/config.json`);
  return r.missing ? null : attachAcl(env, slug, r.data);
}

// The same, off the shared read cache. Reads only. handleCommit deliberately
// keeps the uncached one: it reads the config to carry the ACL fields across a
// write, and acting on a roster three seconds out of date is not a trade worth
// making to save one API call.
async function loadRaceConfigShared(env, slug) {
  const res = await githubGetShared(env, `races/${slug}/config.json`);
  if (res.status === 404) return null;
  if (!res.ok) return null;
  try {
    const j = await res.clone().json();
    return attachAcl(env, slug, JSON.parse(base64ToUtf8(j.content)));
  } catch (e) { return null; }
}

// GitHub's Contents API is not read-after-write consistent, and the wizard
// makes that worse than a coin flip. Reserving a race number GETs
// races/<slug>/config.json to check the folder is free, which caches a 404 for
// that exact URL; the wizard then writes the file and, a moment later, writes
// data.json. Authorising that second write re-reads the same URL and is served
// the cached miss, so a race the same session just created comes back "Race
// not found". Public or private makes no difference: the write order is the
// same either way.
//
// So a creation leaves a note behind. This is not a permission of its own. It
// records only "this session created this slug just now", which is exactly
// what the config read would have said had it been current, and it is reachable
// only by having already made the config.json write that the code above
// permits. Without AUTH_KV it does nothing and the old 404 stands.
const CREATION_GRANT_TTL = 900;   // 15 minutes, far longer than any wizard run

async function noteRaceCreated(env, slug, email) {
  if (!env.AUTH_KV || !slug || !email) return;
  try {
    await env.AUTH_KV.put('created:' + slug,
      JSON.stringify({ email: normalizeEmail(email), at: Date.now() }),
      { expirationTtl: CREATION_GRANT_TTL });
  } catch (e) { /* the grant is an optimisation; losing it only costs a retry */ }
}

async function createdBySession(env, slug, email) {
  if (!env.AUTH_KV || !slug || !email) return false;
  try {
    const raw = await env.AUTH_KV.get('created:' + slug);
    if (!raw) return false;
    return normalizeEmail(JSON.parse(raw).email) === normalizeEmail(email);
  } catch (e) { return false; }
}

// Access is a role per person. Crew, Racer and Pacer all work the board during
// a race, so all three can write; Viewer is the read-only seat. The distinction
// between the three writing roles is not about permission, it is about who a
// person is, which is what makes a roster readable and what the per-person
// defaults will hang off later.
const RACE_ROLES = ['crew', 'racer', 'pacer', 'viewer'];
const WRITING_ROLES = new Set(['owner', 'crew', 'racer', 'pacer']);

// Races written before roles existed carry editors[] and viewers[]. Rather than
// migrate every config on disk, they are read as the roles they always meant:
// an editor was crew, a viewer was a viewer.
function racePeople(raceCfg) {
  if (!raceCfg) return [];
  if (Array.isArray(raceCfg.people)) {
    return raceCfg.people
      .filter(p => p && p.email)
      .map(p => ({
        email: normalizeEmail(p.email),
        role: RACE_ROLES.includes(p.role) ? p.role : 'viewer'
      }));
  }
  return [
    ...(raceCfg.editors || []).map(e => ({ email: normalizeEmail(e), role: 'crew' })),
    ...(raceCfg.viewers || []).map(v => ({ email: normalizeEmail(v), role: 'viewer' }))
  ].filter(p => p.email);
}

// Writes the roster, and keeps editors[]/viewers[] in step with it. A phone
// still running a cached copy of the old client reads those two arrays to
// decide whether to show an editing UI, and a crew member handed a read-only
// screen at mile 40 because their browser had not refreshed yet is a real
// failure, not a cosmetic one. The worker itself only ever trusts people[].
function setRacePeople(cfg, people) {
  const seen = new Set();
  const clean = [];
  for (const p of people) {
    const email = normalizeEmail(p.email);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    clean.push({ email, role: RACE_ROLES.includes(p.role) ? p.role : 'viewer' });
  }
  cfg.people = clean;
  cfg.editors = clean.filter(p => p.role !== 'viewer').map(p => p.email);
  cfg.viewers = clean.filter(p => p.role === 'viewer').map(p => p.email);
  return cfg;
}

function roleForRace(raceCfg, email) {
  if (!raceCfg) return null;
  email = normalizeEmail(email);
  if (!email) return null;
  if (normalizeEmail(raceCfg.createdBy) === email) return 'owner';
  const p = racePeople(raceCfg).find(x => x.email === email);
  return p ? p.role : null;
}

function canEditRace(raceCfg, email) {
  return WRITING_ROLES.has(roleForRace(raceCfg, email));
}
function canViewRace(raceCfg, email) {
  if (!raceCfg) return false;
  if (raceCfg.visibility === 'public') return true;
  return roleForRace(raceCfg, email) !== null;
}

// ---------- handlers ----------
async function handleLogin(req, env) {
  let body;
  try { body = await req.json(); }
  catch (e) { return json({ error: 'Invalid JSON' }, { status: 400 }, env, req); }
  const email = normalizeEmail(body && (body.email || body.username));
  const password = body && body.password;
  if (!email || !password) {
    return json({ error: 'email and password required' }, { status: 400 }, env, req);
  }
  const user = await lookupUser(env, email);
  // Always run a hash check to avoid timing leaks for invalid emails.
  if (!user) {
    await verifyPassword(password, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', 'AAAAAAAAAAAAAAAAAAAAAA==', PBKDF2_DEFAULT_ITERATIONS).catch(() => {});
    return json({ error: 'Invalid credentials' }, { status: 401 }, env, req);
  }
  const ok = await verifyPassword(password, user.hash, user.salt, user.iterations);
  if (!ok) return json({ error: 'Invalid credentials' }, { status: 401 }, env, req);
  const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  const token = await signJwt({ sub: email, email, role: user.role, exp }, env.JWT_SECRET);
  return json({ token, email, username: email, role: user.role, expiresAt: exp }, {}, env, req);
}

// Changes the signed-in user's password. The new hash is written to KV, which
// lookupUser checks before USERS, so this works for env-var users too.
async function handleChangePassword(req, env) {
  const session = await requireAuth(req, env);
  if (!session || !session.email) return json({ error: 'Unauthorized' }, { status: 401 }, env, req);
  if (!env.AUTH_KV) return json({ error: 'Password changes require AUTH_KV KV namespace binding' }, { status: 503 }, env, req);
  let body;
  try { body = await req.json(); }
  catch (e) { return json({ error: 'Invalid JSON' }, { status: 400 }, env, req); }
  const { currentPassword, newPassword } = body || {};
  if (!currentPassword || !newPassword) {
    return json({ error: 'currentPassword and newPassword required' }, { status: 400 }, env, req);
  }
  if (newPassword.length < 8) {
    return json({ error: 'New password must be at least 8 characters' }, { status: 400 }, env, req);
  }
  const user = await lookupUser(env, session.email);
  if (!user) return json({ error: 'Account not found' }, { status: 404 }, env, req);
  const ok = await verifyPassword(currentPassword, user.hash, user.salt, user.iterations);
  if (!ok) return json({ error: 'Current password is incorrect' }, { status: 401 }, env, req);
  const { hash, salt, iterations } = await hashPassword(newPassword);
  await putUserRecord(env, session.email, {
    hash, salt, iterations, updatedAt: new Date().toISOString()
  });
  return json({ ok: true }, {}, env, req);
}

// Admin-only: mint a one-time password-reset link for a locked-out user.
async function handleResetLink(req, env) {
  const session = await requireAuth(req, env);
  if (!session || !session.email) return json({ error: 'Unauthorized' }, { status: 401 }, env, req);
  if (session.role !== 'admin') return json({ error: 'Admins only' }, { status: 403 }, env, req);
  if (!env.AUTH_KV) return json({ error: 'Password resets require AUTH_KV KV namespace binding' }, { status: 503 }, env, req);
  let body;
  try { body = await req.json(); }
  catch (e) { return json({ error: 'Invalid JSON' }, { status: 400 }, env, req); }
  const email = normalizeEmail(body && body.email);
  if (!email) return json({ error: 'email required' }, { status: 400 }, env, req);
  const user = await lookupUser(env, email);
  if (!user) return json({ error: 'No account with that email' }, { status: 404 }, env, req);

  const token = randomToken(24);
  const expiresAt = Date.now() + RESET_TTL_DAYS * 24 * 3600 * 1000;
  await env.AUTH_KV.put('reset:' + token, JSON.stringify({
    email, createdBy: session.email, createdAt: new Date().toISOString(), expiresAt
  }), { expiration: Math.floor(expiresAt / 1000) });

  const base = publicBaseUrl(env, req);
  const url = (base ? base : '') + `/reset.html?reset=${encodeURIComponent(token)}`;

  const mail = resetMail(env, url, RESET_TTL_DAYS);
  let emailed = false, emailError = null;
  if (body && body.send) {
    const err = await sendMail(env, { to: email, from: mailFrom(env, 'reset'), ...mail });
    if (err) emailError = err; else emailed = true;
  }
  return json({ token, url, email, expiresAt, emailed, emailError, mail }, {}, env, req);
}

// Public: metadata for a reset link, so reset.html can show the email.
async function handleResetInfo(req, env) {
  if (!env.AUTH_KV) return json({ error: 'Password resets require AUTH_KV KV namespace binding' }, { status: 503 }, env, req);
  const url = new URL(req.url);
  const token = url.searchParams.get('token');
  if (!token) return json({ error: 'Missing token' }, { status: 400 }, env, req);
  const raw = await env.AUTH_KV.get('reset:' + token);
  if (!raw) return json({ error: 'Reset link not found or expired' }, { status: 404 }, env, req);
  let rec;
  try { rec = JSON.parse(raw); }
  catch (e) { return json({ error: 'Corrupt reset token' }, { status: 500 }, env, req); }
  if (rec.expiresAt && rec.expiresAt < Date.now()) {
    return json({ error: 'Reset link expired' }, { status: 410 }, env, req);
  }
  return json({ email: rec.email, expiresAt: rec.expiresAt }, {}, env, req);
}

// Public: redeem a reset link: set a new password and return a session.
async function handleResetPassword(req, env) {
  if (!env.AUTH_KV) return json({ error: 'Password resets require AUTH_KV KV namespace binding' }, { status: 503 }, env, req);
  let body;
  try { body = await req.json(); }
  catch (e) { return json({ error: 'Invalid JSON' }, { status: 400 }, env, req); }
  const { token, newPassword } = body || {};
  if (!token || !newPassword) return json({ error: 'token and newPassword required' }, { status: 400 }, env, req);
  if (newPassword.length < 8) return json({ error: 'New password must be at least 8 characters' }, { status: 400 }, env, req);
  const raw = await env.AUTH_KV.get('reset:' + token);
  if (!raw) return json({ error: 'Reset link not found or expired' }, { status: 404 }, env, req);
  let rec;
  try { rec = JSON.parse(raw); }
  catch (e) { return json({ error: 'Corrupt reset token' }, { status: 500 }, env, req); }
  if (rec.expiresAt && rec.expiresAt < Date.now()) {
    await env.AUTH_KV.delete('reset:' + token);
    return json({ error: 'Reset link expired' }, { status: 410 }, env, req);
  }
  const existing = await lookupUser(env, rec.email);
  const role = existing ? existing.role : 'crew';
  const { hash, salt, iterations } = await hashPassword(newPassword);
  await putUserRecord(env, rec.email, {
    hash, salt, iterations, role, updatedAt: new Date().toISOString()
  });
  await env.AUTH_KV.delete('reset:' + token);

  const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  const sessionToken = await signJwt({ sub: rec.email, email: rec.email, role, exp }, env.JWT_SECRET);
  return json({ token: sessionToken, email: rec.email, username: rec.email, role, expiresAt: exp }, {}, env, req);
}

// Admin-only: mint a hub account-invite link (not tied to any race). The
// recipient signs up and can then create their own races.
async function handleAccountInvite(req, env) {
  const session = await requireAuth(req, env);
  if (!session || !session.email) return json({ error: 'Unauthorized' }, { status: 401 }, env, req);
  if (session.role !== 'admin') return json({ error: 'Admins only' }, { status: 403 }, env, req);
  if (!env.AUTH_KV) return json({ error: 'Account invites require AUTH_KV KV namespace binding' }, { status: 503 }, env, req);
  let body;
  try { body = await req.json(); }
  catch (e) { return json({ error: 'Invalid JSON' }, { status: 400 }, env, req); }
  const email = normalizeEmail(body && body.email);
  if (!email) return json({ error: 'email required' }, { status: 400 }, env, req);
  if (await lookupUser(env, email)) {
    return json({ error: 'An account with that email already exists' }, { status: 409 }, env, req);
  }
  const token = randomToken(24);
  const expiresAt = Date.now() + INVITE_TTL_DAYS * 24 * 3600 * 1000;
  await env.AUTH_KV.put('acct:' + token, JSON.stringify({
    email, createdBy: session.email, createdAt: new Date().toISOString(), expiresAt
  }), { expiration: Math.floor(expiresAt / 1000) });
  const base = publicBaseUrl(env, req);
  const url = (base ? base : '') + `/signup.html?account=${encodeURIComponent(token)}`;

  // The link is returned either way. Mail is the convenience, not the record:
  // if it fails the admin still has something to paste into their own client,
  // and is told plainly that it did not go.
  // The rendered message goes back with the link. Sending it by hand is the
  // normal path right now, and building it a second time in the admin page is
  // how the two would drift into saying different things.
  const mail = inviteMail(env, url, INVITE_TTL_DAYS);
  let emailed = false, emailError = null;
  if (body && body.send) {
    const err = await sendMail(env, { to: email, from: mailFrom(env, 'invite'), ...mail });
    if (err) emailError = err; else emailed = true;
  }
  return json({ token, url, email, expiresAt, emailed, emailError, mail }, {}, env, req);
}

// Public: metadata for an account-invite link.
async function handleAccountInviteInfo(req, env) {
  if (!env.AUTH_KV) return json({ error: 'Account invites require AUTH_KV KV namespace binding' }, { status: 503 }, env, req);
  const url = new URL(req.url);
  const token = url.searchParams.get('token');
  if (!token) return json({ error: 'Missing token' }, { status: 400 }, env, req);
  const raw = await env.AUTH_KV.get('acct:' + token);
  if (!raw) return json({ error: 'Account invite not found or expired' }, { status: 404 }, env, req);
  let rec;
  try { rec = JSON.parse(raw); }
  catch (e) { return json({ error: 'Corrupt account invite' }, { status: 500 }, env, req); }
  if (rec.expiresAt && rec.expiresAt < Date.now()) {
    return json({ error: 'Account invite expired' }, { status: 410 }, env, req);
  }
  return json({ email: rec.email }, {}, env, req);
}

// Public: redeem an account invite: create the account, return a session.
async function handleAcceptAccountInvite(req, env) {
  if (!env.AUTH_KV) return json({ error: 'Account invites require AUTH_KV KV namespace binding' }, { status: 503 }, env, req);
  let body;
  try { body = await req.json(); }
  catch (e) { return json({ error: 'Invalid JSON' }, { status: 400 }, env, req); }
  const { token, password } = body || {};
  if (!token || !password) return json({ error: 'token and password required' }, { status: 400 }, env, req);
  if (password.length < 8) return json({ error: 'Password must be at least 8 characters' }, { status: 400 }, env, req);
  const raw = await env.AUTH_KV.get('acct:' + token);
  if (!raw) return json({ error: 'Account invite not found or expired' }, { status: 404 }, env, req);
  let rec;
  try { rec = JSON.parse(raw); }
  catch (e) { return json({ error: 'Corrupt account invite' }, { status: 500 }, env, req); }
  if (rec.expiresAt && rec.expiresAt < Date.now()) {
    await env.AUTH_KV.delete('acct:' + token);
    return json({ error: 'Account invite expired' }, { status: 410 }, env, req);
  }
  if (await lookupUser(env, rec.email)) {
    await env.AUTH_KV.delete('acct:' + token);
    return json({ error: 'An account with that email already exists: just sign in.' }, { status: 409 }, env, req);
  }
  try { await createUserInKv(env, rec.email, password, 'crew'); }
  catch (err) { return json({ error: err.message || 'Could not create account' }, { status: 500 }, env, req); }
  await env.AUTH_KV.delete('acct:' + token);
  const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  const sessionToken = await signJwt({ sub: rec.email, email: rec.email, role: 'crew', exp }, env.JWT_SECRET);
  return json({
    token: sessionToken, email: rec.email, username: rec.email,
    role: 'crew', expiresAt: exp, accountCreated: true
  }, {}, env, req);
}

// Admin-only: list hub accounts (USERS env + KV) and pending account invites.
// What the signed-in account may do. The UI reads this to decide which
// controls to draw; it is never what the gate reads. Every enforcement point
// above looks the plan up again, so a client holding a stale or edited copy of
// this gains nothing.
async function handleEntitlements(req, env) {
  const session = await requireAuth(req, env);
  if (!session || !session.email) return json({ error: 'Unauthorized' }, { status: 401 }, env, req);
  const user = await lookupUser(env, session.email);
  return json(entitlementsFor(user), {}, env, req);
}

// Admin-only: move an account between plans. This exists before billing does,
// because the only way to see what a free account sees is to have one.
async function handleAccountPlan(req, env) {
  const session = await requireAuth(req, env);
  if (!session || !session.email) return json({ error: 'Unauthorized' }, { status: 401 }, env, req);
  if (session.role !== 'admin') return json({ error: 'Admins only' }, { status: 403 }, env, req);
  if (!env.AUTH_KV) return json({ error: 'Plans require AUTH_KV KV namespace binding' }, { status: 503 }, env, req);

  let body;
  try { body = await req.json(); }
  catch (e) { return json({ error: 'Invalid JSON' }, { status: 400 }, env, req); }
  const email = normalizeEmail(body && body.email);
  const plan = body && body.plan;
  if (!email || !PLANS[plan]) {
    return json({ error: `email and plan (${Object.keys(PLANS).join('|')}) required` }, { status: 400 }, env, req);
  }
  const existing = await lookupUser(env, email);
  if (!existing) return json({ error: 'Account not found' }, { status: 404 }, env, req);
  if (existing.source === 'env') {
    return json({ error: 'This account is in the USERS list and has no stored record to change.' }, { status: 400 }, env, req);
  }
  // earlyAccess is a promise made to a person, not a property of a plan, so
  // moving somebody to free does not quietly take it away. It is settable on
  // its own, which is the only way to see a genuinely capped free account.
  const changes = { plan, updatedAt: new Date().toISOString() };
  if (typeof body.earlyAccess === 'boolean') changes.earlyAccess = body.earlyAccess;
  const next = await putUserRecord(env, email, changes);
  return json({ ok: true, email, entitlements: entitlementsFor(next) }, {}, env, req);
}

async function handleAccounts(req, env) {
  const session = await requireAuth(req, env);
  if (!session || !session.email) return json({ error: 'Unauthorized' }, { status: 401 }, env, req);
  if (session.role !== 'admin') return json({ error: 'Admins only' }, { status: 403 }, env, req);

  const byEmail = new Map();
  const envEmails = new Set();
  let envUsers = [];
  try { envUsers = JSON.parse(env.USERS || '[]'); } catch (e) { envUsers = []; }
  for (const u of envUsers) {
    const email = normalizeEmail(u.email || u.username);
    if (email) {
      envEmails.add(email);
      byEmail.set(email, { email, role: u.role || 'crew', source: 'env',
                           plan: u.plan || DEFAULT_PLAN, earlyAccess: u.earlyAccess !== false });
    }
  }
  const pendingInvites = [];
  if (env.AUTH_KV) {
    const users = await env.AUTH_KV.list({ prefix: 'user:' });
    for (const k of users.keys) {
      const raw = await env.AUTH_KV.get(k.name);
      if (!raw) continue;
      try {
        const u = JSON.parse(raw);
        const email = normalizeEmail(u.email || k.name.slice(5));
        byEmail.set(email, { email, role: u.role || 'crew', source: 'kv',
                             plan: u.plan || DEFAULT_PLAN,
                             earlyAccess: u.earlyAccess !== false });
      } catch (e) {}
    }
    const invites = await env.AUTH_KV.list({ prefix: 'acct:' });
    for (const k of invites.keys) {
      const raw = await env.AUTH_KV.get(k.name);
      if (!raw) continue;
      try {
        const r = JSON.parse(raw);
        pendingInvites.push({ token: k.name.slice(5), email: r.email, expiresAt: r.expiresAt || null });
      } catch (e) {}
    }
  }
  // removable: the worker can delete a KV account; accounts baked into the
  // USERS env var can only be removed by re-running `wrangler secret put`.
  const accounts = [...byEmail.values()]
    .map(a => ({ ...a, inEnv: envEmails.has(a.email), removable: !envEmails.has(a.email) }))
    .sort((a, b) => a.email.localeCompare(b.email));
  return json({ accounts, pendingInvites }, {}, env, req);
}

// Admin-only: delete a hub account (KV-stored accounts only).
async function handleAccountDelete(req, env) {
  const session = await requireAuth(req, env);
  if (!session || !session.email) return json({ error: 'Unauthorized' }, { status: 401 }, env, req);
  if (session.role !== 'admin') return json({ error: 'Admins only' }, { status: 403 }, env, req);
  if (!env.AUTH_KV) return json({ error: 'Account management requires AUTH_KV KV namespace binding' }, { status: 503 }, env, req);
  let body;
  try { body = await req.json(); }
  catch (e) { return json({ error: 'Invalid JSON' }, { status: 400 }, env, req); }
  const email = normalizeEmail(body && body.email);
  if (!email) return json({ error: 'email required' }, { status: 400 }, env, req);
  if (email === normalizeEmail(session.email)) {
    return json({ error: "You can't delete your own account." }, { status: 400 }, env, req);
  }
  let envUsers = [];
  try { envUsers = JSON.parse(env.USERS || '[]'); } catch (e) { envUsers = []; }
  if (envUsers.some(u => normalizeEmail(u.email || u.username) === email)) {
    return json({ error: 'This account is in the USERS list: remove it with `wrangler secret put USERS`.' }, { status: 400 }, env, req);
  }
  await env.AUTH_KV.delete('user:' + email);
  await env.AUTH_KV.delete('profile:' + email);
  return json({ ok: true }, {}, env, req);
}

// Admin-only: list the races a given account is creator / editor / viewer on.
async function handleAccountRaces(req, env) {
  const session = await requireAuth(req, env);
  if (!session || !session.email) return json({ error: 'Unauthorized' }, { status: 401 }, env, req);
  if (session.role !== 'admin') return json({ error: 'Admins only' }, { status: 403 }, env, req);
  const email = normalizeEmail(new URL(req.url).searchParams.get('email'));
  if (!email) return json({ error: 'email required' }, { status: 400 }, env, req);

  const treeUrl = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/git/trees/${encodeURIComponent(env.GITHUB_BRANCH || 'main')}?recursive=1`;
  const treeRes = await fetch(treeUrl, {
    headers: {
      Authorization: `token ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'race-dashboard-proxy'
    }
  });
  if (!treeRes.ok) return json({ email, races: [] }, {}, env, req);
  const tree = await treeRes.json();
  const configPaths = (tree.tree || [])
    .filter(t => t.type === 'blob' && /^races\/[^/]+\/config\.json$/.test(t.path))
    .map(t => t.path);

  const races = [];
  for (const p of configPaths) {
    const slug = p.split('/')[1];
    let cfg = null;
    try { cfg = await loadRaceConfig(env, slug); } catch (e) { continue; }
    if (!cfg) continue;
    let role = null;
    role = roleForRace(cfg, email);
    if (role) {
      races.push({
        slug, name: cfg.name,
        visibility: cfg.visibility || 'public',
        role,
        isCreator: normalizeEmail(cfg.createdBy) === email
      });
    }
  }
  return json({ email, races }, {}, env, req);
}

async function handleCommit(req, env) {
  const session = await requireAuth(req, env);
  if (!session || !session.email) return json({ error: 'Unauthorized' }, { status: 401 }, env, req);

  let body;
  try { body = await req.json(); }
  catch (e) { return json({ error: 'Invalid JSON' }, { status: 400 }, env, req); }
  const { path, sha, message } = body || {};
  const content0 = body && body.content;
  if (!path || typeof content0 !== 'string' || !message) {
    return json({ error: 'Missing path, content, or message' }, { status: 400 }, env, req);
  }

  // Who a race belongs to, who is on it, and who can see it. These never
  // change through a file write. The client legitimately PUTs the whole
  // config.json to save units or the roster of runners, and it round-trips
  // whatever it read; letting a writer's copy of these fields win would mean
  // anyone who can log a split could also write themselves in as the creator,
  // hand out access, or make a private race public. They change only through
  // the access endpoints, which check the right thing.
  const ACL_FIELDS = ['createdBy', 'people', 'editors', 'viewers', 'teamCanInvite', 'visibility'];
  // Added by handleGet for the caller's benefit. A client that reads a config
  // and writes it back would otherwise persist one person's role into the file
  // everybody reads.
  const INJECTED_FIELDS = ['myRole'];

  let content = content0;
  // Set when this write is the config.json that brings a race into existence,
  // so the grant above can be recorded once GitHub has accepted it.
  let isCreation = false;
  let creationSlug = null;
  // The access list lifted off a creating write, stored once GitHub accepts it.
  let creationAcl = null;
  // An access list lifted off an ordinary config write, stored once it lands.
  let aclUpdate = null;

  // Path allowlist + ACL check.
  if (path === 'races/index.json') {
    // The hub manifest is editable by any signed-in user (the wizard writes
    // it when creating a public race). Private races are never registered
    // there; setup.html omits them from the entry it appends.
  } else if (isRacePath(path)) {
    const slug = racePathSlug(path);
    creationSlug = slug;
    const raceCfg = await loadRaceConfig(env, slug);
    if (!raceCfg) {
      // Brand-new race: only allow writes to files under this slug if the body
      // looks like a self-creation. The wizard writes config.json first, then
      // data.json/course.gpx. For non-config writes against a missing race we
      // reject to prevent slug-squatting, unless this same session created the
      // race moments ago and GitHub has not caught up yet.
      if (!path.endsWith('/config.json')) {
        if (!(await createdBySession(env, slug, session.email))) {
          return json({ error: 'Race not found' }, { status: 404 }, env, req);
        }
      } else {
        isCreation = true;
      }
      // For the initial config.json write, trust the body, the wizard sets
      // createdBy to the session email. If a malicious client lies about
      // createdBy, the worst case is the race is owned by the wrong account;
      // they still had to authenticate to reach this endpoint.
      //
      // It is also the only moment a race's shape is set with nothing to
      // compare against, so the plan is checked here against the creator.
      let created;
      try { created = JSON.parse(content); } catch (e) { created = null; }
      if (created && typeof created === 'object' && !Array.isArray(created)) {
        // The wizard sends createdBy and an empty roster. Both are the access
        // list, so they go to KV and never into the commit.
        creationAcl = {
          createdBy: normalizeEmail(created.createdBy) || normalizeEmail(session.email),
          people: racePeople(created),
          teamCanInvite: !!created.teamCanInvite,
          runnerEmails: runnerLinksFromConfig(created)
        };
        for (const f of ACL_FIELDS) if (f !== 'visibility') delete created[f];
        for (const f of INJECTED_FIELDS) delete created[f];
        created.runners = (created.runners || []).map(r => {
          if (!r || r.email === undefined) return r;
          const copy = Object.assign({}, r); delete copy.email; return copy;
        });
        content = JSON.stringify(created, null, 2) + '\n';
        const ent = entitlementsFor(await lookupUser(env, session.email));
        if (created.visibility === 'private' && !ent.privateRaces) {
          return json({
            error: `Private races are a Pro feature. You are on the ${PLANS[ent.plan].label} plan.`,
            code: 'plan_limit', limit: 'privateRaces', plan: ent.plan
          }, { status: 402 }, env, req);
        }
        if (overCap(ent.maxRunnersPerRace, (created.runners || []).length, 0)) {
          return json({
            error: `The ${PLANS[ent.plan].label} plan allows ${ent.maxRunnersPerRace} runner per race.`,
            code: 'plan_limit', limit: 'maxRunnersPerRace', plan: ent.plan
          }, { status: 402 }, env, req);
        }
      }
    } else if (!canEditRace(raceCfg, session.email)) {
      return json({ error: 'Forbidden, no write access on this race' }, { status: 403 }, env, req);
    } else if (path.endsWith('/config.json')) {
      let submitted;
      try { submitted = JSON.parse(content); }
      catch (e) { return json({ error: 'config.json must be valid JSON' }, { status: 400 }, env, req); }
      if (!submitted || typeof submitted !== 'object' || Array.isArray(submitted)) {
        return json({ error: 'config.json must be an object' }, { status: 400 }, env, req);
      }
      const ent = await raceOwnerEntitlements(env, raceCfg);
      const wantRunners = (submitted.runners || []).length;
      const haveRunners = (raceCfg.runners || []).length;
      if (overCap(ent.maxRunnersPerRace, wantRunners, haveRunners)) {
        return json({
          error: `This race is on the ${PLANS[ent.plan].label} plan, which allows ${ent.maxRunnersPerRace} runner. Upgrade to add more.`,
          code: 'plan_limit', limit: 'maxRunnersPerRace', plan: ent.plan
        }, { status: 402 }, env, req);
      }
      // visibility stays in the file: it is not about a person, and a reader
      // arriving from Pages needs it. Everything else here names people, and
      // people do not belong in a file the whole internet can read. The access
      // list lives in KV now, so these are dropped rather than carried over.
      submitted.visibility = raceCfg.visibility === undefined
        ? submitted.visibility : raceCfg.visibility;
      for (const f of ACL_FIELDS) if (f !== 'visibility') delete submitted[f];
      for (const f of INJECTED_FIELDS) delete submitted[f];
      // The runner-to-account link is an address too. It is kept, in KV, and
      // taken out of the file. A writer can still change it: that is what the
      // settings page does when somebody picks who a runner is.
      const links = runnerLinksFromConfig(submitted);
      submitted.runners = (submitted.runners || []).map(r => {
        if (!r || r.email === undefined) return r;
        const copy = Object.assign({}, r); delete copy.email; return copy;
      });
      aclUpdate = Object.assign(aclFromConfig(raceCfg), { runnerEmails: links });
      content = JSON.stringify(submitted, null, 2) + '\n';
    }
  } else {
    return json({ error: 'Forbidden path' }, { status: 403 }, env, req);
  }

  const ghUrl = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodeURI(path)}`;
  const ghBody = {
    message: `${message} (via ${session.email})`,
    branch: env.GITHUB_BRANCH || 'main',
    content: utf8ToBase64(content)
  };
  if (sha) ghBody.sha = sha;

  const res = await fetch(ghUrl, {
    method: 'PUT',
    headers: {
      Authorization: `token ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'race-dashboard-proxy'
    },
    body: JSON.stringify(ghBody)
  });
  const text = await res.text();
  // Only once GitHub has actually taken the file: a grant for a write that
  // failed would authorise data.json against a race that does not exist.
  if (res.ok && isCreation) await noteRaceCreated(env, creationSlug, session.email);
  // Only after the file lands: an access list for a race that failed to be
  // created would outlive nothing and confuse the next attempt at the slug.
  if (res.ok && isCreation && creationAcl) {
    try { await writeAcl(env, creationSlug, creationAcl); } catch (e) { /* falls back to the file */ }
  }
  if (res.ok && aclUpdate && creationSlug) {
    try { await writeAcl(env, creationSlug, aclUpdate); } catch (e) { /* falls back to the file */ }
  }
  // The cached copy is now wrong. Dropping it means a press is visible on the
  // next poll rather than up to CACHE_TTL_S later, at least in this colo.
  if (res.ok) await purgeReadCache(env, path);
  return new Response(text, {
    status: res.status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env, req) }
  });
}

async function handleGet(req, env) {
  const url = new URL(req.url);
  const path = url.searchParams.get('path');
  const shareToken = url.searchParams.get('t');
  if (!path) return json({ error: 'Missing path' }, { status: 400 }, env, req);

  let sessionEmail = null;
  const session = await requireAuth(req, env);
  if (session && session.email) sessionEmail = session.email;
  // The config with its access list attached, kept from the check below so the
  // caller's role is worked out against the roster rather than against the
  // file, which no longer carries one.
  let aclCfg = null;

  // ACL check
  if (path === 'races/index.json') {
    // Public manifest: accessible to anyone with a session OR with a share token.
    // (Anonymous public access happens via GitHub Pages directly, not the worker.)
    if (!sessionEmail && !shareToken) {
      return json({ error: 'Unauthorized' }, { status: 401 }, env, req);
    }
  } else if (isRacePath(path)) {
    const slug = racePathSlug(path);
    aclCfg = await loadRaceConfigShared(env, slug);
    const raceCfg = aclCfg;
    if (!raceCfg) return json({ error: 'Not found' }, { status: 404 }, env, req);
    let allowed = false;
    if (sessionEmail && canViewRace(raceCfg, sessionEmail)) allowed = true;
    if (!allowed && shareToken && env.AUTH_KV) {
      const raw = await env.AUTH_KV.get('share:' + shareToken);
      if (raw) {
        try {
          const sh = JSON.parse(raw);
          if (sh.slug === slug && (!sh.expiresAt || sh.expiresAt > Date.now())) {
            allowed = true;
          }
        } catch (e) {}
      }
    }
    if (!allowed && raceCfg.visibility === 'public') allowed = true;
    if (!allowed) {
      return json({ error: sessionEmail ? 'Forbidden, not invited to this race' : 'Unauthorized' },
        { status: sessionEmail ? 403 : 401 }, env, req);
    }
  } else {
    return json({ error: 'Forbidden path' }, { status: 403 }, env, req);
  }

  const res = await githubGetShared(env, path);
  let text = await res.text();

  // A race config carries the roster, and the roster is a list of people's
  // email addresses. Nobody reading a race needs anyone's address but their
  // own role in it, so the copy handed back gains myRole. The stored copy is
  // untouched here; taking the roster out of it is the next change, and this
  // one has to ship first so that clients already know where to look.
  //
  // Computed per request, deliberately outside the shared cache above, because
  // it is the one part of the answer that differs by caller.
  if (res.status === 200 && isRacePath(path) && path.endsWith('/config.json')) {
    try {
      const env0 = JSON.parse(text);
      const cfg = JSON.parse(base64ToUtf8(env0.content));
      cfg.myRole = sessionEmail ? roleForRace(aclCfg || cfg, sessionEmail) : null;
      // Runner-to-account links come back only for somebody who works the
      // race. Crew need them to load a runner's goals and racer mode needs
      // them to know whose splits it is showing. A viewer does not, and an
      // anonymous reader certainly does not, so for them the addresses stay
      // where they now live, which is out of sight.
      if (aclCfg && WRITING_ROLES.has(cfg.myRole)) cfg.runners = aclCfg.runners;
      env0.content = utf8ToBase64(JSON.stringify(cfg, null, 2) + '\n');
      text = JSON.stringify(env0);
    } catch (e) { /* hand back exactly what GitHub gave us */ }
  }

  return new Response(text, {
    status: res.status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env, req) }
  });
}

// ---------- outbound mail ----------
// One place that knows how to put a message on the wire, so the operator
// notification and the invite and reset mails cannot drift apart.
//
// Returns null on success or a reason string on failure. Deliberately not
// throwing: some callers must not fail because mail did, and the ones that
// tell an admin "it has been sent" need the reason to show instead.
async function sendMail(env, { to, from, subject, html, text }) {
  const sender = from || env.NOTIFY_FROM;
  if (!env.EMAIL) return 'the worker has no EMAIL binding';
  if (!sender) return 'no from-address is set on the worker';
  try {
    await env.EMAIL.send({ to, from: sender, subject, html, ...(text ? { text } : {}) });
    return null;
  } catch (e) {
    return (e && e.message) ? e.message : String(e);
  }
}

// An invite comes from invites@, because that is what it is. Everything else,
// a password reset or a note to the operator, comes from info@ where it is
// configured: "invites@" on a reset mail reads like the wrong department
// answered. Falls back to the invite address so a worker without INFO_FROM
// still sends rather than refusing.
function mailFrom(env, kind) {
  return kind === 'invite' ? env.NOTIFY_FROM : (env.INFO_FROM || env.NOTIFY_FROM);
}

// Email is not the web: no flexbox, no CSS variables, no stylesheet, and
// Gmail strips SVG outright, so the wordmark ships as a PNG. Tables and inline
// styles only, 600px wide, and it has to still read if images are blocked,
// which is the default in plenty of clients.
//
// The band at the top is the brand's dark ground; the body below is light.
// A wholly dark mail gets mangled by clients that invert for dark mode, and
// gives light-mode readers a slab of black. A dark header over a light body is
// the shape that survives both.
const MAIL_INK      = '#121A1F';
const MAIL_MUTED    = '#7A8D99';
const MAIL_BAND     = '#0D1117';
const MAIL_PAGE     = '#F5F2EA';
const MAIL_BUTTON   = '#0A5F68';  // holds white text at 7.3:1
const MAIL_LINK     = '#0A8B92';  // the signal colour that works on white

function mailBase(env) {
  return (env.PUBLIC_BASE_URL || 'https://sendoff.run').replace(/\/+$/, '');
}

function mailShell(env, preheader, inner) {
  const base = mailBase(env);
  return `<!doctype html><html><body style="margin:0;padding:0;background:${MAIL_PAGE}">` +
    // Shown in the inbox preview line, never on the page itself.
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escHtml(preheader)}</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
      `style="background:${MAIL_PAGE};padding:24px 12px">` +
    `<tr><td align="center">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" ` +
      `style="width:100%;max-width:600px;border-collapse:collapse">` +

    // Header band. The alt text carries the name when images are blocked.
    `<tr><td align="left" style="background:${MAIL_BAND};padding:26px 32px;border-radius:6px 6px 0 0">` +
      `<img src="${base}/brand/wordmark-email.png" width="220" height="77" alt="SendOff" ` +
        `style="display:block;border:0;width:220px;height:auto;max-width:100%;` +
        `color:#F0ECE3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;` +
        `font-size:26px;font-weight:700;letter-spacing:-0.5px">` +
    `</td></tr>` +

    `<tr><td style="background:#FFFFFF;padding:32px;font-family:-apple-system,BlinkMacSystemFont,` +
      `'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:${MAIL_INK}">` +
      inner +
    `</td></tr>` +

    `<tr><td style="background:#FFFFFF;padding:0 32px 28px;border-radius:0 0 6px 6px;` +
      `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">` +
      `<div style="border-top:1px solid #E3DED2;padding-top:16px;font-size:12px;color:${MAIL_MUTED}">` +
        `SendOff, live crew tracking for ultras. ` +
        `<a href="${base}" style="color:${MAIL_LINK};text-decoration:none">sendoff.run</a>` +
      `</div>` +
    `</td></tr>` +

    `</table></td></tr></table></body></html>`;
}

// Built from a table rather than a styled link: Outlook ignores padding on an
// anchor, which would collapse the button to bare underlined text.
function mailButton(url, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0">` +
    `<tr><td align="center" bgcolor="${MAIL_BUTTON}" style="border-radius:4px">` +
    `<a href="${escHtml(url)}" style="display:inline-block;padding:13px 26px;font-family:-apple-system,` +
      `BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;` +
      `color:#FFFFFF;text-decoration:none;border-radius:4px">${escHtml(label)}</a>` +
    `</td></tr></table>` +
    // The button is an image-free element, but a blocked or broken renderer
    // still leaves the link reachable as text.
    `<p style="margin:0 0 4px;font-size:12px;color:${MAIL_MUTED}">Or paste this into your browser:</p>` +
    `<p style="margin:0;font-size:12px;word-break:break-all">` +
      `<a href="${escHtml(url)}" style="color:${MAIL_LINK}">${escHtml(url)}</a></p>`;
}

// The two messages an admin sends from the requests queue. Each carries a
// plain-text alternative: some clients prefer it, some people insist on it,
// and a mail with only an HTML part looks worse to a spam filter.
function inviteMail(env, url, days) {
  const h1 = `<h1 style="margin:0 0 14px;font-size:22px;line-height:1.25;color:${MAIL_INK}">` +
             `You are in.</h1>`;
  return {
    subject: 'Your SendOff invite',
    html: mailShell(env, `Set up your account. The link expires in ${days} days.`,
      h1 +
      `<p style="margin:0 0 4px">You asked for an invite to SendOff. Here it is.</p>` +
      mailButton(url, 'Set up your account') +
      `<p style="margin:20px 0 0;font-size:13px;color:${MAIL_MUTED}">The link works once and ` +
      `expires in ${days} days. If you did not ask for this, you can ignore it.</p>`),
    text: `You are in.\n\nYou asked for an invite to SendOff. Set up your account here:\n\n${url}\n\n` +
          `The link works once and expires in ${days} days. If you did not ask for this, you can ignore it.\n\n` +
          `SendOff, live crew tracking for ultras. ${mailBase(env)}\n`
  };
}

function resetMail(env, url, days) {
  const h1 = `<h1 style="margin:0 0 14px;font-size:22px;line-height:1.25;color:${MAIL_INK}">` +
             `Set a new password</h1>`;
  return {
    subject: 'Reset your SendOff password',
    html: mailShell(env, `Choose a new password. The link expires in ${days} days.`,
      h1 +
      `<p style="margin:0 0 4px">Someone asked to reset the password on your SendOff account.</p>` +
      mailButton(url, 'Choose a new password') +
      `<p style="margin:20px 0 0;font-size:13px;color:${MAIL_MUTED}">The link expires in ${days} days. ` +
      `If this was not you, ignore it and your password stays as it is.</p>`),
    text: `Set a new password\n\nSomeone asked to reset the password on your SendOff account. ` +
          `Choose a new one here:\n\n${url}\n\n` +
          `The link expires in ${days} days. If this was not you, ignore it and your password ` +
          `stays as it is.\n\nSendOff, live crew tracking for ultras. ${mailBase(env)}\n`
  };
}

// ---------- access requests ----------
// Public, unauthenticated: someone with no account asking for one. That makes
// it the only write endpoint a stranger can reach, so it carries its own
// limits rather than trusting the caller: a honeypot field, a length cap on
// everything, and a per-IP hourly quota in KV.
const ACCESS_REQ_TTL_DAYS = 90;
const ACCESS_REQ_PER_HOUR = 5;

function escHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function clip(v, n) {
  return typeof v === 'string' ? v.trim().slice(0, n) : '';
}

async function handleAccessRequest(req, env) {
  if (!env.AUTH_KV) return json({ error: 'Access requests require AUTH_KV KV namespace binding' }, { status: 503 }, env, req);
  let body;
  try { body = await req.json(); }
  catch (e) { return json({ error: 'Invalid JSON' }, { status: 400 }, env, req); }

  // Honeypot: a real person never sees this field, so anything in it is a bot.
  // Answer 200 so the bot has nothing to learn from the response.
  if (clip(body && body.website, 200)) return json({ ok: true }, {}, env, req);

  const email = normalizeEmail(body && body.email);
  const name = clip(body && body.name, 120);
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ error: 'A valid email is required' }, { status: 400 }, env, req);
  }
  if (!name && clip(body && body.kind, 20) !== 'reset') {
    return json({ error: 'Your name is required' }, { status: 400 }, env, req);
  }

  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  const bucket = 'arl:' + ip;
  const seen = parseInt((await env.AUTH_KV.get(bucket)) || '0', 10);
  if (seen >= ACCESS_REQ_PER_HOUR) {
    return json({ error: 'Too many requests from here. Try again later.' }, { status: 429 }, env, req);
  }
  await env.AUTH_KV.put(bucket, String(seen + 1), { expirationTtl: 3600 });

  const kind = clip(body && body.kind, 20) === 'reset' ? 'reset' : 'invite';
  const registered = !!(await lookupUser(env, email));

  if (kind === 'reset') {
    // A reset is only meaningful for an address that has an account. When it
    // does not, answer exactly as if it did and store nothing, so the reset
    // path cannot be used to enumerate who is registered.
    if (!registered) return json({ ok: true }, {}, env, req);
  } else if (registered) {
    // Tell them plainly rather than faking success and dropping the request on
    // the floor. This does reveal that an address is registered, which the
    // per-IP quota above is what keeps from being an enumeration tool.
    return json({ ok: true, account: 'exists' }, {}, env, req);
  }

  const now = new Date().toISOString();
  const key = 'areq:' + now + '-' + randomToken(6);
  await env.AUTH_KV.put(key, JSON.stringify({
    kind, email, name,
    race: clip(body && body.race, 160),
    when: clip(body && body.when, 60),
    note: clip(body && body.note, 600),
    requestedAt: now
  }), { expirationTtl: ACCESS_REQ_TTL_DAYS * 24 * 3600 });

  // Tell the admin something arrived. A queue nobody is told about is a queue
  // nobody checks. Never let a mail failure fail the request: the row is
  // already stored and the admin panel remains the source of truth.
  if (env.EMAIL && env.NOTIFY_EMAIL && env.NOTIFY_FROM) {
    try {
      const what = kind === 'reset' ? 'Password reset request' : 'Invite request';
      const rows = [
        ['Name', name], ['Email', email],
        ['Race', clip(body && body.race, 160)],
        ['When', clip(body && body.when, 60)],
        ['Note', clip(body && body.note, 600)]
      ].filter(r => r[1])
       .map(r => `<tr><td style="padding:2px 12px 2px 0;color:#7A8D99">${escHtml(r[0])}</td>` +
                 `<td style="padding:2px 0">${escHtml(r[1])}</td></tr>`).join('');
      const err = await sendMail(env, {
        to: env.NOTIFY_EMAIL,
        from: mailFrom(env, 'notify'),
        subject: `SendOff: ${what} from ${email}`,
        html: mailShell(env, `${what} from ${email}`,
          `<h1 style="margin:0 0 14px;font-size:22px;line-height:1.25;color:${MAIL_INK}">` +
            `${escHtml(what)}</h1>` +
          `<table style="border-collapse:collapse;font-size:14px">${rows}</table>` +
          mailButton(`${mailBase(env)}/admin.html`, 'Open the admin panel')),
        text: `${what} from ${email}\n\n` +
              `Open the admin panel: ${mailBase(env)}/admin.html\n`
      });
      if (err) throw new Error(err);
    } catch (e) {
      // Swallowed for the caller: the request is stored either way and must not
      // fail because mail did. Logged so `wrangler tail` can show an operator
      // why the notifications stopped arriving.
      console.error('access-request notify failed:', e && e.message ? e.message : e);
    }
  }

  return json({ ok: true }, {}, env, req);
}

// Admin: the queue of people waiting on an invite.
async function handleAccessRequests(req, env) {
  const session = await requireAuth(req, env);
  if (!session || !session.email) return json({ error: 'Unauthorized' }, { status: 401 }, env, req);
  if (session.role !== 'admin') return json({ error: 'Admins only' }, { status: 403 }, env, req);
  if (!env.AUTH_KV) return json({ error: 'Access requests require AUTH_KV KV namespace binding' }, { status: 503 }, env, req);

  const list = await env.AUTH_KV.list({ prefix: 'areq:' });
  const requests = [];
  for (const k of list.keys) {
    const raw = await env.AUTH_KV.get(k.name);
    if (raw) { try { requests.push({ key: k.name, ...JSON.parse(raw) }); } catch (e) {} }
  }
  requests.sort((a, b) => (b.requestedAt || '').localeCompare(a.requestedAt || ''));
  return json({ requests }, {}, env, req);
}

// Admin: clear one once it has been actioned.
async function handleAccessRequestDelete(req, env) {
  const session = await requireAuth(req, env);
  if (!session || !session.email) return json({ error: 'Unauthorized' }, { status: 401 }, env, req);
  if (session.role !== 'admin') return json({ error: 'Admins only' }, { status: 403 }, env, req);
  if (!env.AUTH_KV) return json({ error: 'Access requests require AUTH_KV KV namespace binding' }, { status: 503 }, env, req);
  let body;
  try { body = await req.json(); } catch (e) { return json({ error: 'Invalid JSON' }, { status: 400 }, env, req); }
  const key = clip(body && body.key, 200);
  if (!key.startsWith('areq:')) return json({ error: 'Bad key' }, { status: 400 }, env, req);
  await env.AUTH_KV.delete(key);
  return json({ ok: true }, {}, env, req);
}

// ---------- access management ----------
function publicBaseUrl(env, req) {
  if (env.PUBLIC_BASE_URL) return env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const origin = (req.headers.get('Origin') || '').replace(/\/+$/, '');
  if (origin) return origin;
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(s => s && s !== '*');
  return (allowed[0] || '').replace(/\/+$/, '');
}

// Anyone who can write the race. Enough to read the roster and see who else is
// on it, which the whole team has a reason to do.
async function requireRaceWriter(env, slug, sessionEmail) {
  const raceCfg = await loadRaceConfig(env, slug);
  if (!raceCfg) throw Object.assign(new Error('Race not found'), { status: 404 });
  if (!canEditRace(raceCfg, sessionEmail)) {
    throw Object.assign(new Error('Forbidden, no write access on this race'), { status: 403 });
  }
  return raceCfg;
}

// Handing out access, or taking it away, is a narrower thing than logging a
// split. By default only the creator can do it. A creator who wants their crew
// chief to be able to add people turns teamCanInvite on, and then everyone who
// can write can also invite.
function canManageAccess(raceCfg, email) {
  if (roleForRace(raceCfg, email) === 'owner') return true;
  return !!(raceCfg && raceCfg.teamCanInvite) && canEditRace(raceCfg, email);
}

async function requireAccessManager(env, slug, sessionEmail) {
  const raceCfg = await loadRaceConfig(env, slug);
  if (!raceCfg) throw Object.assign(new Error('Race not found'), { status: 404 });
  if (!canManageAccess(raceCfg, sessionEmail)) {
    throw Object.assign(new Error(
      canEditRace(raceCfg, sessionEmail)
        ? 'Forbidden, only the race creator can change who has access'
        : 'Forbidden, no write access on this race'), { status: 403 });
  }
  return raceCfg;
}

async function handleAccessList(req, env) {
  const session = await requireAuth(req, env);
  if (!session || !session.email) return json({ error: 'Unauthorized' }, { status: 401 }, env, req);
  const url = new URL(req.url);
  const slug = url.searchParams.get('slug');
  if (!slug) return json({ error: 'Missing slug' }, { status: 400 }, env, req);
  let raceCfg;
  try { raceCfg = await requireRaceWriter(env, slug, session.email); }
  catch (err) { return json({ error: err.message }, { status: err.status || 500 }, env, req); }

  let shareLinks = [];
  if (env.AUTH_KV) {
    const list = await env.AUTH_KV.list({ prefix: 'share:' });
    for (const k of list.keys) {
      const raw = await env.AUTH_KV.get(k.name);
      if (!raw) continue;
      try {
        const sh = JSON.parse(raw);
        if (sh.slug === slug) {
          shareLinks.push({
            token: k.name.slice('share:'.length),
            role: sh.role,
            label: sh.label || null,
            createdBy: sh.createdBy || null,
            createdAt: sh.createdAt || null,
            expiresAt: sh.expiresAt || null
          });
        }
      } catch (e) {}
    }
  }
  let pendingInvites = [];
  if (env.AUTH_KV) {
    const list = await env.AUTH_KV.list({ prefix: 'invite:' });
    for (const k of list.keys) {
      const raw = await env.AUTH_KV.get(k.name);
      if (!raw) continue;
      try {
        const inv = JSON.parse(raw);
        if (inv.slug === slug) {
          pendingInvites.push({
            token: k.name.slice('invite:'.length),
            email: inv.email,
            role: inv.role,
            createdAt: inv.createdAt || null,
            expiresAt: inv.expiresAt || null
          });
        }
      } catch (e) {}
    }
  }
  // Display names, so the roster and the runner picker can say "Jason Dupree"
  // rather than an email address. Only for people already on this race, and
  // only to someone who can write it, which is the same bar a caller already
  // has to clear to read a teammate's profile at all.
  const people = racePeople(raceCfg);
  const named = [];
  for (const p of people) {
    const prof = await loadProfile(env, p.email);
    named.push({ ...p, displayName: prof.displayName || '' });
  }
  let creatorName = '';
  if (raceCfg.createdBy) {
    const prof = await loadProfile(env, raceCfg.createdBy);
    creatorName = prof.displayName || '';
  }

  return json({
    slug,
    createdBy: raceCfg.createdBy || null,
    createdByName: creatorName,
    teamCanInvite: !!raceCfg.teamCanInvite,
    canManageAccess: canManageAccess(raceCfg, session.email),
    people: named,
    // Derived, and still sent so a client that has not picked up the new
    // shape yet renders the roster instead of an empty panel.
    editors: raceCfg.editors || [],
    viewers: raceCfg.viewers || [],
    shareLinks,
    pendingInvites
  }, {}, env, req);
}

async function handleAccessAdd(req, env) {
  const session = await requireAuth(req, env);
  if (!session || !session.email) return json({ error: 'Unauthorized' }, { status: 401 }, env, req);
  let body;
  try { body = await req.json(); }
  catch (e) { return json({ error: 'Invalid JSON' }, { status: 400 }, env, req); }
  const { slug } = body || {};
  const email = normalizeEmail(body && body.email);
  const role = body && body.role;
  // "editor" is still accepted so an older client, or a share link built before
  // roles existed, keeps working; it means what it always meant.
  const wanted = role === 'editor' ? 'crew' : role;
  if (!slug || !email || !RACE_ROLES.includes(wanted)) {
    return json({ error: `slug, email, role (${RACE_ROLES.join('|')}) required` }, { status: 400 }, env, req);
  }
  let raceCfg;
  try { raceCfg = await requireAccessManager(env, slug, session.email); }
  catch (err) { return json({ error: err.message }, { status: err.status || 500 }, env, req); }

  // The cap belongs to whoever owns the race, and it counts the people who can
  // write. Viewers are not crew and are never capped: telling somebody they may
  // not be watched is not a business model.
  if (WRITING_ROLES.has(wanted)) {
    const ent = await raceOwnerEntitlements(env, raceCfg);
    const current = racePeople(raceCfg).filter(pp => WRITING_ROLES.has(pp.role) && pp.email !== email);
    if (overCap(ent.maxCrewPerRace, current.length + 1, current.length)) {
      return json({
        error: `This race is on the ${PLANS[ent.plan].label} plan, which allows ${ent.maxCrewPerRace} crew. Upgrade to add more.`,
        code: 'plan_limit', limit: 'maxCrewPerRace', plan: ent.plan
      }, { status: 402 }, env, req);
    }
  }

  const updated = await mutateRaceConfig(env, slug, (cfg) => {
    const people = racePeople(cfg).filter(p => p.email !== email);
    people.push({ email, role: wanted });
    return setRacePeople(cfg, people);
  }, `hub: add ${wanted} ${email} to ${slug}`, session.email);

  return json({
    people: updated.people || [],
    editors: updated.editors || [],
    viewers: updated.viewers || []
  }, {}, env, req);
}

async function handleAccessRemove(req, env) {
  const session = await requireAuth(req, env);
  if (!session || !session.email) return json({ error: 'Unauthorized' }, { status: 401 }, env, req);
  let body;
  try { body = await req.json(); }
  catch (e) { return json({ error: 'Invalid JSON' }, { status: 400 }, env, req); }
  const { slug } = body || {};
  const email = normalizeEmail(body && body.email);
  if (!slug || !email) {
    return json({ error: 'slug and email required' }, { status: 400 }, env, req);
  }
  let raceCfg;
  try { raceCfg = await requireAccessManager(env, slug, session.email); }
  catch (err) { return json({ error: err.message }, { status: err.status || 500 }, env, req); }
  if (normalizeEmail(raceCfg.createdBy) === email) {
    return json({ error: 'Cannot remove the creator' }, { status: 400 }, env, req);
  }

  const updated = await mutateRaceConfig(env, slug, (cfg) =>
    setRacePeople(cfg, racePeople(cfg).filter(p => p.email !== email)),
    `hub: revoke access for ${email} on ${slug}`, session.email);

  return json({
    people: updated.people || [],
    editors: updated.editors || [],
    viewers: updated.viewers || []
  }, {}, env, req);
}

// Creator only, deliberately. The point of the switch is that the person who
// owns the race decides whether the rest of the team can hand out access; a
// team member who could flip it themselves would just be inviting by two steps
// instead of one.
// Your own profile, or a teammate's, and only ever through a race you both
// work. Letting any signed-in account read any email's profile would turn this
// into a way to ask "does this person have an account here", so the caller has
// to name a race they can write and the subject has to be on it.
async function handleProfileGet(req, env) {
  const session = await requireAuth(req, env);
  if (!session || !session.email) return json({ error: 'Unauthorized' }, { status: 401 }, env, req);
  if (!env.AUTH_KV) return json({ error: 'Profiles require AUTH_KV KV namespace binding' }, { status: 503 }, env, req);

  const url = new URL(req.url);
  const wanted = normalizeEmail(url.searchParams.get('email')) || normalizeEmail(session.email);
  const slug = url.searchParams.get('slug');

  if (wanted !== normalizeEmail(session.email)) {
    if (!slug) return json({ error: 'slug required to read a teammate profile' }, { status: 400 }, env, req);
    const raceCfg = await loadRaceConfig(env, slug);
    if (!raceCfg) return json({ error: 'Race not found' }, { status: 404 }, env, req);
    if (!canEditRace(raceCfg, session.email)) {
      return json({ error: 'Forbidden, no write access on this race' }, { status: 403 }, env, req);
    }
    if (roleForRace(raceCfg, wanted) === null) {
      return json({ error: 'That person is not on this race' }, { status: 404 }, env, req);
    }
  }

  const profile = await loadProfile(env, wanted);
  // Nothing here is secret to a teammate, but say plainly whose it is so a
  // client cannot mistake someone else's numbers for the signed-in user's.
  return json({ profile, own: wanted === normalizeEmail(session.email) }, {}, env, req);
}

// Your own, only. There is no reason for one account to write another's.
async function handleProfileSave(req, env) {
  const session = await requireAuth(req, env);
  if (!session || !session.email) return json({ error: 'Unauthorized' }, { status: 401 }, env, req);
  if (!env.AUTH_KV) return json({ error: 'Profiles require AUTH_KV KV namespace binding' }, { status: 503 }, env, req);
  let body;
  try { body = await req.json(); }
  catch (e) { return json({ error: 'Invalid JSON' }, { status: 400 }, env, req); }

  const email = normalizeEmail(session.email);
  const profile = {
    email,
    displayName: typeof body.displayName === 'string' ? body.displayName.trim().slice(0, 80) : '',
    targets: cleanTargets(body.targets),
    phaseTargets: cleanPhaseTargets(body.phaseTargets),
    notes: typeof body.notes === 'string' ? body.notes.slice(0, PROFILE_NOTES_MAX) : '',
    updatedAt: new Date().toISOString()
  };
  await env.AUTH_KV.put('profile:' + email, JSON.stringify(profile));
  return json({ profile }, {}, env, req);
}

async function handleTeamInvite(req, env) {
  const session = await requireAuth(req, env);
  if (!session || !session.email) return json({ error: 'Unauthorized' }, { status: 401 }, env, req);
  let body;
  try { body = await req.json(); }
  catch (e) { return json({ error: 'Invalid JSON' }, { status: 400 }, env, req); }
  const { slug } = body || {};
  const allowed = !!(body && body.allowed);
  if (!slug) return json({ error: 'slug required' }, { status: 400 }, env, req);

  const raceCfg = await loadRaceConfig(env, slug);
  if (!raceCfg) return json({ error: 'Race not found' }, { status: 404 }, env, req);
  if (roleForRace(raceCfg, session.email) !== 'owner') {
    return json({ error: 'Only the race creator can change this' }, { status: 403 }, env, req);
  }

  const updated = await mutateRaceConfig(env, slug, (cfg) => {
    cfg.teamCanInvite = allowed;
    return cfg;
  }, `hub: ${allowed ? 'allow' : 'stop'} team invites on ${slug}`, session.email);

  return json({ teamCanInvite: !!updated.teamCanInvite }, {}, env, req);
}

async function handleInvite(req, env) {
  const session = await requireAuth(req, env);
  if (!session || !session.email) return json({ error: 'Unauthorized' }, { status: 401 }, env, req);
  if (!env.AUTH_KV) return json({ error: 'Invites require AUTH_KV KV namespace binding' }, { status: 503 }, env, req);
  let body;
  try { body = await req.json(); }
  catch (e) { return json({ error: 'Invalid JSON' }, { status: 400 }, env, req); }
  const { slug } = body || {};
  const email = normalizeEmail(body && body.email);
  const role = body && body.role;
  // "editor" is still accepted so an older client, or a share link built before
  // roles existed, keeps working; it means what it always meant.
  const wanted = role === 'editor' ? 'crew' : role;
  if (!slug || !email || !RACE_ROLES.includes(wanted)) {
    return json({ error: `slug, email, role (${RACE_ROLES.join('|')}) required` }, { status: 400 }, env, req);
  }
  try { await requireAccessManager(env, slug, session.email); }
  catch (err) { return json({ error: err.message }, { status: err.status || 500 }, env, req); }

  const token = randomToken(24);
  const expiresAt = Date.now() + INVITE_TTL_DAYS * 24 * 3600 * 1000;
  await env.AUTH_KV.put('invite:' + token, JSON.stringify({
    email, slug, role: wanted,
    createdBy: session.email,
    createdAt: new Date().toISOString(),
    expiresAt
  }), { expiration: Math.floor(expiresAt / 1000) });

  const base = publicBaseUrl(env, req);
  const url = (base ? base : '') + `/signup.html?invite=${encodeURIComponent(token)}`;
  return json({ token, url, email, slug, role, expiresAt }, {}, env, req);
}

async function handleInviteInfo(req, env) {
  if (!env.AUTH_KV) return json({ error: 'Invites require AUTH_KV KV namespace binding' }, { status: 503 }, env, req);
  const url = new URL(req.url);
  const token = url.searchParams.get('token');
  if (!token) return json({ error: 'Missing token' }, { status: 400 }, env, req);
  const raw = await env.AUTH_KV.get('invite:' + token);
  if (!raw) return json({ error: 'Invite not found or expired' }, { status: 404 }, env, req);
  let inv;
  try { inv = JSON.parse(raw); }
  catch (e) { return json({ error: 'Corrupt invite' }, { status: 500 }, env, req); }
  if (inv.expiresAt && inv.expiresAt < Date.now()) {
    return json({ error: 'Invite expired' }, { status: 410 }, env, req);
  }
  // Also indicate whether an account for this email already exists, so
  // signup.html can change its prompt accordingly.
  const existing = await lookupUser(env, inv.email);
  return json({
    email: inv.email, slug: inv.slug, role: inv.role,
    expiresAt: inv.expiresAt, accountExists: !!existing
  }, {}, env, req);
}

async function handleAcceptInvite(req, env) {
  if (!env.AUTH_KV) return json({ error: 'Invites require AUTH_KV KV namespace binding' }, { status: 503 }, env, req);
  let body;
  try { body = await req.json(); }
  catch (e) { return json({ error: 'Invalid JSON' }, { status: 400 }, env, req); }
  const { token, password } = body || {};
  if (!token || !password) return json({ error: 'token and password required' }, { status: 400 }, env, req);
  if (password.length < 8) return json({ error: 'Password must be at least 8 characters' }, { status: 400 }, env, req);

  const raw = await env.AUTH_KV.get('invite:' + token);
  if (!raw) return json({ error: 'Invite not found or expired' }, { status: 404 }, env, req);
  let inv;
  try { inv = JSON.parse(raw); }
  catch (e) { return json({ error: 'Corrupt invite' }, { status: 500 }, env, req); }
  if (inv.expiresAt && inv.expiresAt < Date.now()) {
    await env.AUTH_KV.delete('invite:' + token);
    return json({ error: 'Invite expired' }, { status: 410 }, env, req);
  }

  const existing = await lookupUser(env, inv.email);
  if (!existing) {
    try { await createUserInKv(env, inv.email, password, 'crew'); }
    catch (err) { return json({ error: err.message || 'Could not create account' }, { status: 500 }, env, req); }
  } else {
    // Existing account: require the user to prove they own it by typing the
    // correct current password. We don't change their password.
    const ok = await verifyPassword(password, existing.hash, existing.salt, existing.iterations);
    if (!ok) {
      return json({
        error: 'This email already has an account. Sign in with your existing password to accept the invite.'
      }, { status: 401 }, env, req);
    }
  }

  // Add to race ACL.
  try {
    await mutateRaceConfig(env, inv.slug, (cfg) => {
      const email = normalizeEmail(inv.email);
      const role = inv.role === 'editor' ? 'crew' : inv.role;
      const people = racePeople(cfg).filter(p => p.email !== email);
      people.push({ email, role: RACE_ROLES.includes(role) ? role : 'viewer' });
      setRacePeople(cfg, people);
      return cfg;
    }, `hub: accept invite for ${inv.email} on ${inv.slug}`, inv.email);
  } catch (err) {
    return json({ error: err.message || 'Could not update race ACL' }, { status: 500 }, env, req);
  }

  await env.AUTH_KV.delete('invite:' + token);

  const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  const sessionToken = await signJwt({ sub: inv.email, email: inv.email, role: 'crew', exp }, env.JWT_SECRET);
  return json({
    token: sessionToken,
    email: inv.email, username: inv.email,
    role: 'crew',
    expiresAt: exp,
    slug: inv.slug, raceRole: inv.role,
    accountCreated: !existing
  }, {}, env, req);
}

async function handleShareLink(req, env) {
  const session = await requireAuth(req, env);
  if (!session || !session.email) return json({ error: 'Unauthorized' }, { status: 401 }, env, req);
  if (!env.AUTH_KV) return json({ error: 'Share links require AUTH_KV KV namespace binding' }, { status: 503 }, env, req);
  let body;
  try { body = await req.json(); }
  catch (e) { return json({ error: 'Invalid JSON' }, { status: 400 }, env, req); }
  const { slug, role, label, expiresInDays } = body || {};
  if (!slug || !['view', 'edit'].includes(role)) {
    return json({ error: 'slug and role (view|edit) required' }, { status: 400 }, env, req);
  }
  if (role === 'edit') {
    return json({ error: 'Edit share links are not supported: invite an account instead' }, { status: 400 }, env, req);
  }
  let shareCfg;
  try { shareCfg = await requireAccessManager(env, slug, session.email); }
  catch (err) { return json({ error: err.message }, { status: err.status || 500 }, env, req); }

  const shareEnt = await raceOwnerEntitlements(env, shareCfg);
  if (!shareEnt.shareLinks) {
    return json({
      error: `Share links are a Pro feature. This race is on the ${PLANS[shareEnt.plan].label} plan.`,
      code: 'plan_limit', limit: 'shareLinks', plan: shareEnt.plan
    }, { status: 402 }, env, req);
  }

  const token = randomToken(18);
  const ttlDays = (typeof expiresInDays === 'number' && expiresInDays > 0)
    ? Math.min(expiresInDays, 365) : SHARE_TTL_DAYS_DEFAULT;
  const expiresAt = Date.now() + ttlDays * 24 * 3600 * 1000;
  await env.AUTH_KV.put('share:' + token, JSON.stringify({
    slug, role, label: label || null,
    createdBy: session.email,
    createdAt: new Date().toISOString(),
    expiresAt
  }), { expiration: Math.floor(expiresAt / 1000) });

  const base = publicBaseUrl(env, req);
  const url = (base ? base : '') + `/race.html?id=${encodeURIComponent(slug)}&t=${encodeURIComponent(token)}`;
  return json({ token, url, slug, role, expiresAt }, {}, env, req);
}

async function handleShareRevoke(req, env) {
  const session = await requireAuth(req, env);
  if (!session || !session.email) return json({ error: 'Unauthorized' }, { status: 401 }, env, req);
  if (!env.AUTH_KV) return json({ error: 'Share links require AUTH_KV KV namespace binding' }, { status: 503 }, env, req);
  let body;
  try { body = await req.json(); }
  catch (e) { return json({ error: 'Invalid JSON' }, { status: 400 }, env, req); }
  const { token } = body || {};
  if (!token) return json({ error: 'token required' }, { status: 400 }, env, req);
  // The token may be a share link (share:), a race invite (invite:), or a
  // hub account invite (acct:): this endpoint revokes any of them.
  let kvKey = 'share:' + token;
  let raw = await env.AUTH_KV.get(kvKey);
  if (!raw) { kvKey = 'invite:' + token; raw = await env.AUTH_KV.get(kvKey); }
  if (!raw) { kvKey = 'acct:' + token; raw = await env.AUTH_KV.get(kvKey); }
  if (!raw) return json({ ok: true }, {}, env, req); // already gone
  let rec;
  try { rec = JSON.parse(raw); }
  catch (e) { return json({ error: 'Corrupt token' }, { status: 500 }, env, req); }
  if (kvKey.startsWith('acct:')) {
    // Account invites aren't race-scoped: gate on the hub admin role.
    if (session.role !== 'admin') return json({ error: 'Admins only' }, { status: 403 }, env, req);
  } else {
    try { await requireAccessManager(env, rec.slug, session.email); }
    catch (err) { return json({ error: err.message }, { status: err.status || 500 }, env, req); }
  }
  await env.AUTH_KV.delete(kvKey);
  return json({ ok: true }, {}, env, req);
}

// Every race created from the wizard gets a zero-padded numeric prefix on its
// slug (000042-forest-fifty), so two races sharing a name never collide. The
// counter has to see private races too, and those are deliberately absent from
// races/index.json, so it comes from the repo tree rather than the manifest.
const RACE_ID_DIGITS = 6;

// Returns every races/<slug>/ folder name in the repo, or null if the tree
// listing failed.
async function listRaceSlugs(env) {
  const treeUrl = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/git/trees/${encodeURIComponent(env.GITHUB_BRANCH || 'main')}?recursive=1`;
  const res = await fetch(treeUrl, {
    headers: {
      Authorization: `token ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'race-dashboard-proxy'
    }
  });
  if (!res.ok) return null;
  const tree = await res.json();
  return (tree.tree || [])
    .filter(t => t.type === 'blob' && /^races\/[^/]+\/config\.json$/.test(t.path))
    .map(t => t.path.split('/')[1]);
}

// Highest prefix in use, plus one. Slugs without a numeric prefix (the races
// that predate this scheme) simply don't count toward the maximum. The number
// alone tells the caller nothing about who owns which race, so any signed-in
// user may ask for one.
async function handleNextRaceId(req, env) {
  const session = await requireAuth(req, env);
  if (!session || !session.email) return json({ error: 'Unauthorized' }, { status: 401 }, env, req);

  const slugs = await listRaceSlugs(env);
  if (!slugs) return json({ error: 'Could not list existing races' }, { status: 502 }, env, req);

  let max = 0;
  for (const slug of slugs) {
    const m = /^(\d+)-/.exec(slug);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return json({ id: String(max + 1).padStart(RACE_ID_DIGITS, '0') }, {}, env, req);
}

async function handleMyRaces(req, env) {
  const session = await requireAuth(req, env);
  if (!session || !session.email) return json({ error: 'Unauthorized' }, { status: 401 }, env, req);

  const r = await githubGetJson(env, 'races/index.json');
  const publicEntries = (r.data && r.data.races) || [];

  // Public races are already listed; we add private races the user has access to.
  // Approach: list races/ directory via GitHub Trees API for fast slug enumeration.
  const treeUrl = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/git/trees/${encodeURIComponent(env.GITHUB_BRANCH || 'main')}?recursive=1`;
  const treeRes = await fetch(treeUrl, {
    headers: {
      Authorization: `token ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'race-dashboard-proxy'
    }
  });
  if (!treeRes.ok) {
    return json({ races: publicEntries }, {}, env, req);
  }
  const tree = await treeRes.json();
  const configPaths = (tree.tree || [])
    .filter(t => t.type === 'blob' && /^races\/[^/]+\/config\.json$/.test(t.path))
    .map(t => t.path);

  const seen = new Set(publicEntries.map(e => e.slug));
  const privateAccessible = [];
  for (const p of configPaths) {
    const slug = p.split('/')[1];
    if (seen.has(slug)) continue;
    let cfg = null;
    try { cfg = await loadRaceConfig(env, slug); } catch (e) { continue; }
    if (!cfg || cfg.visibility !== 'private') continue;
    if (!canViewRace(cfg, session.email)) continue;
    privateAccessible.push({
      slug,
      name: cfg.name,
      location: cfg.location,
      startTime: cfg.startTime,
      courseType: cfg.courseType,
      totalDistanceMi: cfg.course
        ? (cfg.courseType === 'loops'
            ? +((cfg.course.loopCount || 0) * (cfg.course.loopDistanceMi || 0)).toFixed(2)
            : +((cfg.course.segments || []).reduce((a, s) => a + (s.distanceMi || 0), 0)).toFixed(2))
        : 0,
      runnerNames: (cfg.runners || []).map(r => r.name),
      cutoffHours: cfg.cutoffs && cfg.cutoffs.totalHours || null,
      visibility: 'private',
      createdBy: cfg.createdBy || null,
      role: roleForRace(cfg, session.email) || 'viewer'
    });
    seen.add(slug);
  }

  // We deliberately don't annotate public-race entries with the caller's
  // role, that would mean fetching every config.json on each /my-races
  // call. Editor status for public races is determined when the user opens
  // race.html (which fetches config.json once for that race and renders the
  // manage-access panel accordingly).
  return json({ races: [...publicEntries, ...privateAccessible] }, {}, env, req);
}

// ---------- race deletion ----------
// Deleting is creator-only, deliberately stricter than editing. An editor was
// invited to help run a race, not to destroy one; the person who made it is the
// one who gets to unmake it.
async function handleRaceDelete(req, env) {
  const session = await requireAuth(req, env);
  if (!session || !session.email) return json({ error: 'Unauthorized' }, { status: 401 }, env, req);

  let body;
  try { body = await req.json(); }
  catch (e) { return json({ error: 'Invalid JSON' }, { status: 400 }, env, req); }

  const slug = clip(body && body.slug, 200);
  if (!slug || slug.includes('/') || slug === '.' || slug === '..') {
    return json({ error: 'Missing or invalid slug' }, { status: 400 }, env, req);
  }

  const raceCfg = await loadRaceConfig(env, slug);
  if (!raceCfg) return json({ error: 'Race not found' }, { status: 404 }, env, req);

  const me = normalizeEmail(session.email);
  if (!raceCfg.createdBy || normalizeEmail(raceCfg.createdBy) !== me) {
    return json({ error: 'Only the race creator can delete it' }, { status: 403 }, env, req);
  }

  // The manifest goes first. If a file delete then fails we are left with
  // orphaned files, which are invisible and harmless; the other order leaves a
  // listed race whose config 404s, which is the failure we are here to fix.
  let manifestErr = null;
  try {
    await mutateJsonAt(env, 'races/index.json', (data) => {
      const out = data && Array.isArray(data.races) ? data : { races: [] };
      out.races = (out.races || []).filter(r => r.slug !== slug);
      out.lastUpdated = new Date().toISOString();
      return out;
    }, `hub: unregister race ${slug}`, session.email, 'empty');
  } catch (e) {
    manifestErr = e.message || String(e);
  }

  // The tree carries a sha per blob, which is exactly what a delete needs.
  const treeUrl = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/git/trees/${encodeURIComponent(env.GITHUB_BRANCH || 'main')}?recursive=1`;
  const treeRes = await fetch(treeUrl, {
    headers: {
      Authorization: `token ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'race-dashboard-proxy'
    }
  });
  if (!treeRes.ok) {
    return json({ error: 'Could not list the race files', manifestErr }, { status: 502 }, env, req);
  }
  const tree = await treeRes.json();
  const prefix = `races/${slug}/`;
  const files = (tree.tree || []).filter(t => t.type === 'blob' && t.path.startsWith(prefix));

  const deleted = [], failed = [];
  for (const f of files) {
    const res = await fetch(
      `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodeURI(f.path)}`, {
        method: 'DELETE',
        headers: {
          Authorization: `token ${env.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'User-Agent': 'race-dashboard-proxy'
        },
        body: JSON.stringify({
          message: `hub: delete race ${slug} (${f.path.slice(prefix.length)}) (via ${session.email})`,
          sha: f.sha,
          branch: env.GITHUB_BRANCH || 'main'
        })
      });
    if (res.ok) deleted.push(f.path);
    else failed.push({ path: f.path, status: res.status });
  }

  // Share links and pending invites for a race that no longer exists are dead
  // weight, and an invite accepted afterwards would fail on the missing config
  // with an error nobody can act on. Both key spaces are paginated: a listing
  // that stops at the first page would leave tokens behind on a busy account.
  if (env.AUTH_KV) {
    for (const prefix of ['share:', 'invite:']) {
      try {
        let cursor;
        do {
          const list = await env.AUTH_KV.list({ prefix, cursor });
          for (const k of (list.keys || [])) {
            const raw = await env.AUTH_KV.get(k.name);
            if (!raw) continue;
            try {
              if (JSON.parse(raw).slug === slug) await env.AUTH_KV.delete(k.name);
            } catch (e) { /* not JSON we wrote; leave it alone */ }
          }
          cursor = list.list_complete ? null : list.cursor;
        } while (cursor);
      } catch (e) { /* tokens for a deleted race fail their slug check anyway */ }
    }
  }

  if (failed.length || manifestErr) {
    return json({ ok: false, deleted, failed, manifestErr }, { status: 207 }, env, req);
  }
  return json({ ok: true, deleted }, {}, env, req);
}

// ---------- router ----------
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env, request) });
    }
    const url = new URL(request.url);
    const mount = env.MOUNT_PATH || '';
    let path = url.pathname;
    if (mount && path.startsWith(mount)) path = path.slice(mount.length) || '/';
    path = path.replace(/\/+$/, '') || '/';

    if (request.method === 'GET'  && path === '/health')          return json({ ok: true, kv: !!env.AUTH_KV }, {}, env, request);
    if (request.method === 'POST' && path === '/access-request')  return handleAccessRequest(request, env);
    if (request.method === 'GET'  && path === '/access-requests') return handleAccessRequests(request, env);
    if (request.method === 'POST' && path === '/access-request/delete') return handleAccessRequestDelete(request, env);
    if (request.method === 'POST' && path === '/login')           return handleLogin(request, env);
    if (request.method === 'POST' && path === '/accept-invite')   return handleAcceptInvite(request, env);
    if (request.method === 'POST' && path === '/change-password') return handleChangePassword(request, env);
    if (request.method === 'POST' && path === '/reset-link')      return handleResetLink(request, env);
    if (request.method === 'GET'  && path === '/reset-info')      return handleResetInfo(request, env);
    if (request.method === 'POST' && path === '/reset-password')  return handleResetPassword(request, env);
    if (request.method === 'GET'  && path === '/invite-info')     return handleInviteInfo(request, env);
    if (request.method === 'POST' && path === '/commit')          return handleCommit(request, env);
    if (request.method === 'GET'  && path === '/get')             return handleGet(request, env);
    if (request.method === 'POST' && path === '/invite')          return handleInvite(request, env);
    if (request.method === 'POST' && path === '/share-link')      return handleShareLink(request, env);
    if (request.method === 'POST' && path === '/share/revoke')    return handleShareRevoke(request, env);
    if (request.method === 'POST' && path === '/access/add')      return handleAccessAdd(request, env);
    if (request.method === 'POST' && path === '/access/remove')   return handleAccessRemove(request, env);
    if (request.method === 'GET'  && path === '/access')          return handleAccessList(request, env);
    if (request.method === 'POST' && path === '/access/team-invite') return handleTeamInvite(request, env);
    if (request.method === 'GET'  && path === '/profile')         return handleProfileGet(request, env);
    if (request.method === 'POST' && path === '/profile')         return handleProfileSave(request, env);
    if (request.method === 'GET'  && path === '/my-races')        return handleMyRaces(request, env);
    if (request.method === 'GET'  && path === '/next-race-id')    return handleNextRaceId(request, env);
    if (request.method === 'POST' && path === '/race/delete')     return handleRaceDelete(request, env);
    if (request.method === 'POST' && path === '/account-invite')  return handleAccountInvite(request, env);
    if (request.method === 'GET'  && path === '/account-invite-info') return handleAccountInviteInfo(request, env);
    if (request.method === 'POST' && path === '/accept-account-invite') return handleAcceptAccountInvite(request, env);
    if (request.method === 'GET'  && path === '/entitlements')    return handleEntitlements(request, env);
    if (request.method === 'POST' && path === '/account/plan')    return handleAccountPlan(request, env);
    if (request.method === 'GET'  && path === '/accounts')        return handleAccounts(request, env);
    if (request.method === 'POST' && path === '/account/delete')  return handleAccountDelete(request, env);
    if (request.method === 'GET'  && path === '/account-races')   return handleAccountRaces(request, env);

    return json({ error: 'Not found', path }, { status: 404 }, env, request);
  }
};
