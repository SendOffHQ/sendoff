// Cloudflare Worker: race-dashboard auth proxy.
//
// Endpoints (all under whatever base path you mount the worker at):
//
//   Auth & users
//     POST /login            { email, password }                      → { token, email, role, expiresAt }
//     POST /accept-invite    { token, password }                      → { token, email, role, expiresAt, slug, role: 'editor'|'viewer' }
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
//     POST /invite           { slug, email, role: 'editor'|'viewer' } → { url, token, expiresAt }
//     POST /share-link       { slug, role: 'view'|'edit',
//                              expiresAt? }                            → { url, token, expiresAt? }
//     POST /access/add       { slug, email, role }                    → { editors, viewers }
//     POST /access/remove    { slug, email, role }                    → { editors, viewers }
//     POST /share/revoke     { token }                                 → { ok: true }
//     GET  /access?slug=...                                            → { editors, viewers, shareLinks }
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
        return { email, hash: u.hash, salt: u.salt, iterations: u.iterations, role: u.role || 'crew', source: 'kv' };
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

async function createUserInKv(env, email, password, role) {
  if (!env.AUTH_KV) throw new Error('AUTH_KV is not configured');
  email = normalizeEmail(email);
  const existing = await lookupUser(env, email);
  if (existing) throw new Error('User already exists');
  const { hash, salt, iterations } = await hashPassword(password);
  await env.AUTH_KV.put('user:' + email, JSON.stringify({
    email, hash, salt, iterations, role: role || 'crew', createdAt: new Date().toISOString()
  }));
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

async function mutateRaceConfig(env, slug, mutate, message, actor) {
  return mutateJsonAt(env, `races/${slug}/config.json`, mutate, message, actor, 'throw');
}

// ---------- path / ACL helpers ----------
function isRacePath(path) {
  return /^races\/[^/]+\/[^/]+$/.test(path);
}
function racePathSlug(path) {
  const m = /^races\/([^/]+)\//.exec(path);
  return m ? m[1] : null;
}

async function loadRaceConfig(env, slug) {
  const r = await githubGetJson(env, `races/${slug}/config.json`);
  return r.missing ? null : r.data;
}

function canEditRace(raceCfg, email) {
  if (!raceCfg) return false;
  email = normalizeEmail(email);
  if (!email) return false;
  if (normalizeEmail(raceCfg.createdBy) === email) return true;
  return (raceCfg.editors || []).some(e => normalizeEmail(e) === email);
}
function canViewRace(raceCfg, email) {
  if (!raceCfg) return false;
  if (raceCfg.visibility === 'public') return true;
  if (canEditRace(raceCfg, email)) return true;
  email = normalizeEmail(email);
  return (raceCfg.viewers || []).some(v => normalizeEmail(v) === email);
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
  await env.AUTH_KV.put('user:' + session.email, JSON.stringify({
    email: session.email, hash, salt, iterations,
    role: user.role || 'crew', updatedAt: new Date().toISOString()
  }));
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

  let emailed = false, emailError = null;
  if (body && body.send) {
    const m = resetMail(url, RESET_TTL_DAYS);
    const err = await sendMail(env, { to: email, from: mailFrom(env, 'reset'), ...m });
    if (err) emailError = err; else emailed = true;
  }
  return json({ token, url, email, expiresAt, emailed, emailError }, {}, env, req);
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
  await env.AUTH_KV.put('user:' + rec.email, JSON.stringify({
    email: rec.email, hash, salt, iterations, role, updatedAt: new Date().toISOString()
  }));
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
  let emailed = false, emailError = null;
  if (body && body.send) {
    const m = inviteMail(url, INVITE_TTL_DAYS);
    const err = await sendMail(env, { to: email, from: mailFrom(env, 'invite'), ...m });
    if (err) emailError = err; else emailed = true;
  }
  return json({ token, url, email, expiresAt, emailed, emailError }, {}, env, req);
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
    if (email) { envEmails.add(email); byEmail.set(email, { email, role: u.role || 'crew', source: 'env' }); }
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
        byEmail.set(email, { email, role: u.role || 'crew', source: 'kv' });
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
    if (canEditRace(cfg, email)) role = 'editor';
    else if ((cfg.viewers || []).some(v => normalizeEmail(v) === email)) role = 'viewer';
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
  const { path, content, sha, message } = body || {};
  if (!path || typeof content !== 'string' || !message) {
    return json({ error: 'Missing path, content, or message' }, { status: 400 }, env, req);
  }

  // Path allowlist + ACL check.
  if (path === 'races/index.json') {
    // The hub manifest is editable by any signed-in user (the wizard writes
    // it when creating a public race). Private races are never registered
    // there; setup.html omits them from the entry it appends.
  } else if (isRacePath(path)) {
    const slug = racePathSlug(path);
    const raceCfg = await loadRaceConfig(env, slug);
    if (!raceCfg) {
      // Brand-new race: only allow writes to files under this slug if the body
      // looks like a self-creation. The wizard writes config.json first, then
      // data.json/course.gpx. For non-config writes against a missing race we
      // reject to prevent slug-squatting.
      if (!path.endsWith('/config.json')) {
        return json({ error: 'Race not found' }, { status: 404 }, env, req);
      }
      // For the initial config.json write, trust the body, the wizard sets
      // createdBy to the session email. If a malicious client lies about
      // createdBy, the worst case is the race is owned by the wrong account;
      // they still had to authenticate to reach this endpoint.
    } else if (!canEditRace(raceCfg, session.email)) {
      return json({ error: 'Forbidden, not an editor on this race' }, { status: 403 }, env, req);
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

  // ACL check
  if (path === 'races/index.json') {
    // Public manifest: accessible to anyone with a session OR with a share token.
    // (Anonymous public access happens via GitHub Pages directly, not the worker.)
    if (!sessionEmail && !shareToken) {
      return json({ error: 'Unauthorized' }, { status: 401 }, env, req);
    }
  } else if (isRacePath(path)) {
    const slug = racePathSlug(path);
    const raceCfg = await loadRaceConfig(env, slug);
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

  const ghUrl = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodeURI(path)}?ref=${encodeURIComponent(env.GITHUB_BRANCH || 'main')}`;
  const res = await fetch(ghUrl, {
    headers: {
      Authorization: `token ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'race-dashboard-proxy'
    }
  });
  const text = await res.text();
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
async function sendMail(env, { to, from, subject, html }) {
  const sender = from || env.NOTIFY_FROM;
  if (!env.EMAIL) return 'the worker has no EMAIL binding';
  if (!sender) return 'no from-address is set on the worker';
  try {
    await env.EMAIL.send({ to, from: sender, subject, html });
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

function mailShell(inner) {
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;` +
         `line-height:1.6;color:#121A1F;max-width:520px">${inner}` +
         `<p style="margin-top:28px;font-size:12px;color:#7A8D99">` +
         `SendOff, live crew tracking for ultras. ` +
         `<a href="https://sendoff.run" style="color:#0FB8BF">sendoff.run</a></p></div>`;
}

function mailButton(url, label) {
  return `<p style="margin:22px 0"><a href="${escHtml(url)}" ` +
         `style="background:#0FB8BF;color:#08121A;text-decoration:none;font-weight:600;` +
         `padding:12px 20px;border-radius:4px;display:inline-block">${escHtml(label)}</a></p>` +
         `<p style="font-size:12px;color:#7A8D99;word-break:break-all">` +
         `Or paste this in: ${escHtml(url)}</p>`;
}

// The two messages an admin sends from the requests queue.
function inviteMail(url, days) {
  return {
    subject: 'Your SendOff invite',
    html: mailShell(
      `<p>You asked for an invite to SendOff. Here it is.</p>` +
      mailButton(url, 'Set up your account →') +
      `<p style="font-size:13px;color:#4A5C68">The link works once and expires in ${days} days. ` +
      `If you did not ask for this, you can ignore it.</p>`)
  };
}

function resetMail(url, days) {
  return {
    subject: 'Reset your SendOff password',
    html: mailShell(
      `<p>Someone asked to reset the password on your SendOff account.</p>` +
      mailButton(url, 'Choose a new password →') +
      `<p style="font-size:13px;color:#4A5C68">The link expires in ${days} days. ` +
      `If this was not you, ignore it and your password stays as it is.</p>`)
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
        html: `<div style="font-family:system-ui,sans-serif;font-size:14px;color:#121A1F">` +
              `<p><strong>${escHtml(what)}</strong></p>` +
              `<table style="border-collapse:collapse">${rows}</table>` +
              `<p style="margin-top:16px"><a href="https://sendoff.run/admin.html">Open the admin panel</a></p>` +
              `</div>`
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

async function requireRaceAdmin(env, slug, sessionEmail) {
  const raceCfg = await loadRaceConfig(env, slug);
  if (!raceCfg) throw Object.assign(new Error('Race not found'), { status: 404 });
  if (!canEditRace(raceCfg, sessionEmail)) {
    throw Object.assign(new Error('Forbidden, not an editor on this race'), { status: 403 });
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
  try { raceCfg = await requireRaceAdmin(env, slug, session.email); }
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
  return json({
    slug,
    createdBy: raceCfg.createdBy || null,
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
  if (!slug || !email || !['editor', 'viewer'].includes(role)) {
    return json({ error: 'slug, email, role (editor|viewer) required' }, { status: 400 }, env, req);
  }
  let raceCfg;
  try { raceCfg = await requireRaceAdmin(env, slug, session.email); }
  catch (err) { return json({ error: err.message }, { status: err.status || 500 }, env, req); }

  const updated = await mutateRaceConfig(env, slug, (cfg) => {
    cfg.editors = (cfg.editors || []).filter(e => normalizeEmail(e) !== email);
    cfg.viewers = (cfg.viewers || []).filter(v => normalizeEmail(v) !== email);
    if (role === 'editor') cfg.editors.push(email);
    else cfg.viewers.push(email);
    return cfg;
  }, `hub: add ${role} ${email} to ${slug}`, session.email);

  return json({ editors: updated.editors || [], viewers: updated.viewers || [] }, {}, env, req);
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
  try { raceCfg = await requireRaceAdmin(env, slug, session.email); }
  catch (err) { return json({ error: err.message }, { status: err.status || 500 }, env, req); }
  if (normalizeEmail(raceCfg.createdBy) === email) {
    return json({ error: 'Cannot remove the creator' }, { status: 400 }, env, req);
  }

  const updated = await mutateRaceConfig(env, slug, (cfg) => {
    cfg.editors = (cfg.editors || []).filter(e => normalizeEmail(e) !== email);
    cfg.viewers = (cfg.viewers || []).filter(v => normalizeEmail(v) !== email);
    return cfg;
  }, `hub: revoke access for ${email} on ${slug}`, session.email);

  return json({ editors: updated.editors || [], viewers: updated.viewers || [] }, {}, env, req);
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
  if (!slug || !email || !['editor', 'viewer'].includes(role)) {
    return json({ error: 'slug, email, role (editor|viewer) required' }, { status: 400 }, env, req);
  }
  try { await requireRaceAdmin(env, slug, session.email); }
  catch (err) { return json({ error: err.message }, { status: err.status || 500 }, env, req); }

  const token = randomToken(24);
  const expiresAt = Date.now() + INVITE_TTL_DAYS * 24 * 3600 * 1000;
  await env.AUTH_KV.put('invite:' + token, JSON.stringify({
    email, slug, role,
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
      cfg.editors = (cfg.editors || []).filter(e => normalizeEmail(e) !== email);
      cfg.viewers = (cfg.viewers || []).filter(v => normalizeEmail(v) !== email);
      if (inv.role === 'editor') cfg.editors.push(email);
      else cfg.viewers.push(email);
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
  try { await requireRaceAdmin(env, slug, session.email); }
  catch (err) { return json({ error: err.message }, { status: err.status || 500 }, env, req); }

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
    try { await requireRaceAdmin(env, rec.slug, session.email); }
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
      role: canEditRace(cfg, session.email) ? 'editor' : 'viewer'
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
    if (request.method === 'GET'  && path === '/my-races')        return handleMyRaces(request, env);
    if (request.method === 'GET'  && path === '/next-race-id')    return handleNextRaceId(request, env);
    if (request.method === 'POST' && path === '/race/delete')     return handleRaceDelete(request, env);
    if (request.method === 'POST' && path === '/account-invite')  return handleAccountInvite(request, env);
    if (request.method === 'GET'  && path === '/account-invite-info') return handleAccountInviteInfo(request, env);
    if (request.method === 'POST' && path === '/accept-account-invite') return handleAcceptAccountInvite(request, env);
    if (request.method === 'GET'  && path === '/accounts')        return handleAccounts(request, env);
    if (request.method === 'POST' && path === '/account/delete')  return handleAccountDelete(request, env);
    if (request.method === 'GET'  && path === '/account-races')   return handleAccountRaces(request, env);

    return json({ error: 'Not found', path }, { status: 404 }, env, request);
  }
};
