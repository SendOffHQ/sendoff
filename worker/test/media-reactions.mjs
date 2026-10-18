// Emoji reactions on race photos. An account is required to react, and anybody
// signed in who may see the race may; everybody sees the counts and nobody is
// told who reacted. A reaction goes with its photo, its race and its account.
//
//   node worker/test/media-reactions.mjs
import worker from '../src/worker.js';
import { fakeD1 } from './fake-d1.mjs';

const OWNER = 'owner@example.com', FAN = 'fan@example.com', OTHER = 'other@example.com', ADMIN = 'admin@example.com';
const kvStore = new Map();
const KV = {
  async get(k) { const v = kvStore.get(k); return v === undefined ? null : v; },
  async put(k, v) { kvStore.set(k, v); },
  async delete(k) { kvStore.delete(k); },
  async list({ prefix }) { return { keys: [...kvStore.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }; },
};
const bucket = new Map();
const MEDIA = { async put(k, v) { bucket.set(k, v); }, async get(k) { return bucket.has(k) ? { body: bucket.get(k), httpMetadata: {} } : null; }, async delete(k) { bucket.delete(k); } };
globalThis.caches = { default: { async match(){}, async put(){}, async delete(){ return true; } } };
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('/git/trees/')) return new Response(JSON.stringify({ tree: [] }), { status: 200 });
  if ((opts.method || 'GET') === 'GET') return new Response('{"message":"Not Found"}', { status: 404 });
  return new Response(JSON.stringify({ content: { sha: 'x' } }), { status: 200 });
};
async function cred(pw) {
  const salt = new Uint8Array(16); crypto.getRandomValues(salt);
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, km, 256);
  const b = a => Buffer.from(a).toString('base64');
  return { hash: b(new Uint8Array(bits)), salt: b(salt), iterations: 100000 };
}
const DB = fakeD1();
const pw = await cred('pw');
const env = {
  DB, MEDIA, GITHUB_OWNER: 'o', GITHUB_REPO: 'r', GITHUB_TOKEN: 't', GITHUB_BRANCH: 'main',
  AUTH_KV: KV, ALLOWED_ORIGINS: '*', JWT_SECRET: 's', PUBLIC_API_URL: 'https://api.test',
  USERS: JSON.stringify([{ email: OWNER }, { email: OTHER }, { email: ADMIN, role: 'admin' }].map(u => ({ ...u, ...pw }))),
};
// An account made by invite, which is the kind that can be deleted.
kvStore.set('user:' + FAN, JSON.stringify({ email: FAN, role: 'crew', ...pw }));

const ctx = { waitUntil() {} };
const call = async (p, o = {}) => {
  const r = await worker.fetch(new Request('https://w' + p, {
    method: o.method || (o.body !== undefined ? 'POST' : 'GET'),
    headers: { ...(o.type ? { 'Content-Type': o.type } : { 'Content-Type': 'application/json' }), ...(o.token ? { Authorization: 'Bearer ' + o.token } : {}) },
    ...(o.body !== undefined ? { body: o.raw ? o.body : JSON.stringify(o.body) } : {}) }), env, ctx);
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, cache: r.headers.get('Cache-Control'), ...(j || {}) };
};
const login = async (e) => (await call('/login', { body: { email: e, password: 'pw' } })).token;
const owner = await login(OWNER), fan = await login(FAN), other = await login(OTHER), admin = await login(ADMIN);
const makeRace = (slug, extra) => call('/commit', { token: owner, body: { path: `races/${slug}/config.json`, message: 't',
  content: JSON.stringify({ name: slug, visibility: 'public', createdBy: OWNER, runners: [{ id: 'a', name: 'A' }], ...extra }) } });
const upload = async (slug) => (await call(`/media?id=${slug}&leg=1`, { token: owner, type: 'image/jpeg', raw: true, body: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) })).media;
const list = async (slug, token) => (await call(`/media?id=${slug}`, { token }));
const react = (token, id, emoji, on) => call('/media/react', { token, body: { id, emoji, ...(on === false ? { on: false } : {}) } });

let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p ? 'ok  ' : 'FAIL'} ${l.padEnd(62)} ${JSON.stringify(g)}${p ? '' : ' expected ' + JSON.stringify(w)}`); };

await makeRace('pub');
const photo = await upload('pub');
ok('a photo on a public race', !!(photo && photo.id), true);

console.log('\nan account is required');
ok('signed out, a reaction is refused and says why', [(await react(null, photo.id, '🔥')).status, (await react(null, photo.id, '🔥')).error], [401, 'Sign in to react to a photo.']);
ok('and nothing is stored', DB.reactions.size, 0);

console.log('\nsigned in');
const first = await react(fan, photo.id, '🔥');
ok('anybody with an account can react to a public race\'s photo', [first.status, first.reactions, first.mine], [200, { '🔥': 1 }, ['🔥']]);
ok('the same reaction twice is still one', (await react(fan, photo.id, '🔥')).reactions, { '🔥': 1 });
await react(owner, photo.id, '🔥'); await react(owner, photo.id, '❤️');
ok('only the six are allowed', (await react(fan, photo.id, '💩')).status, 400);

console.log('\nwhat the photo list says');
const asFan = (await list('pub', fan)).media[0];
ok('counts for each, and which are mine', [asFan.reactions, asFan.mine], [{ '🔥': 2, '❤️': 1 }, ['🔥']]);
const anon = await list('pub');
ok('a spectator with no account sees the counts', [anon.media[0].reactions, anon.media[0].mine], [{ '🔥': 2, '❤️': 1 }, []]);
const said = (l) => JSON.stringify(l.media.map(m => [m.reactions, m.mine]));
ok('and never who reacted', [said(anon), said(await list('pub', fan))].some(t => t.includes('@')), false);
ok('a list with somebody\'s own reactions in it is not shared-cacheable', [(await list('pub', fan)).cache, anon.cache], ['private, max-age=5', 'public, max-age=5']);

console.log('\ntaking it back');
const back = await react(fan, photo.id, '🔥', false);
ok('one tap takes it back', [back.reactions, back.mine], [{ '🔥': 1, '❤️': 1 }, []]);

console.log('\na race only its people can see');
await makeRace('mine', { visibility: 'private' });
const hidden = await upload('mine');
ok('somebody signed in but not on it cannot react', (await react(other, hidden.id, '👏')).status, 403);
ok('its own crew can', (await react(owner, hidden.id, '👏')).status, 200);

console.log('\ngone with what they belong to');
await react(fan, photo.id, '😂');
await call('/media/delete', { token: owner, body: { id: hidden.id } });
ok('a deleted photo takes its reactions', [...DB.reactions.values()].some(r => r.media_id === hidden.id), false);
await call('/account/delete', { token: admin, body: { email: FAN } });
ok('a deleted account takes its reactions', [...DB.reactions.values()].some(r => r.email === FAN), false);
ok('and leaves everybody else\'s', (await list('pub', owner)).media[0].reactions, { '🔥': 1, '❤️': 1 });
await call('/race/delete', { token: owner, body: { slug: 'pub' } });
ok('a deleted race takes all of its photos\' reactions', [...DB.reactions.values()].some(r => r.slug === 'pub'), false);

console.log('\nnot without limit');
await makeRace('busy');
const busy = await upload('busy');
for (let i = 0; i < 300; i++) await react(other, busy.id, '👏', i % 2 ? false : undefined);
ok('three hundred an hour, then a pause', (await react(other, busy.id, '👏')).status, 429);

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
