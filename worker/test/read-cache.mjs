// Measures what a poll of a race costs GitHub, with and without the shared
// read cache.
//
// Watching a race is a poll, and every poll of a race file costs two GitHub
// calls: one to read the config for the access check, one for the file. At six
// polls a minute over two files that is 1,440 an hour per open dashboard,
// against a GitHub ceiling of 5,000. This test pins the shape of that.
//
//   node worker/test/read-cache.mjs
import worker from '../src/worker.js';

const SLUG = '000001-sangre-de-cristo-100';
const ME = 'owner@example.com';

const repo = new Map([
  [`races/${SLUG}/config.json`, JSON.stringify({ name: 'Sangre', visibility: 'public', createdBy: ME, people: [] })],
  [`races/${SLUG}/data.json`, JSON.stringify({ runners: [] })],
]);
let ghCalls = 0;
const kvStore = new Map();
const KV = {
  async get(k) { return kvStore.has(k) ? kvStore.get(k) : null; },
  async put(k, v) { kvStore.set(k, v); },
  async delete(k) { kvStore.delete(k); },
};

// A stand-in for the edge cache, with the same shape the worker uses.
const cacheStore = new Map();
globalThis.caches = { default: {
  async match(req) { const v = cacheStore.get(req.url); return v ? new Response(v) : undefined; },
  async put(req, res) { cacheStore.set(req.url, await res.text()); },
  async delete(req) { return cacheStore.delete(req.url); },
} };

async function cred(pw) {
  const salt = new Uint8Array(16); crypto.getRandomValues(salt);
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, km, 256);
  const b = a => Buffer.from(a).toString('base64');
  return { hash: b(new Uint8Array(bits)), salt: b(salt), iterations: 100000 };
}
const env = {
  GITHUB_OWNER: 'o', GITHUB_REPO: 'r', GITHUB_TOKEN: 't', GITHUB_BRANCH: 'main',
  AUTH_KV: KV, ALLOWED_ORIGINS: '*', JWT_SECRET: 'test-secret',
  USERS: JSON.stringify([{ email: ME, ...await cred('pw') }]),
};

globalThis.fetch = async (url, opts = {}) => {
  const m = String(url).match(/contents\/(.+?)(\?|$)/);
  const path = m ? decodeURIComponent(m[1]) : '';
  if ((opts.method || 'GET') === 'GET') {
    ghCalls++;
    if (!repo.has(path)) return new Response('{"message":"Not Found"}', { status: 404 });
    return new Response(JSON.stringify({
      sha: 'sha', content: Buffer.from(repo.get(path), 'utf8').toString('base64') }), { status: 200 });
  }
  repo.set(path, Buffer.from(JSON.parse(opts.body).content, 'base64').toString('utf8'));
  return new Response('{}', { status: 200 });
};

const r = await worker.fetch(new Request('https://w/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: ME, password: 'pw' }) }), env);
const token = (await r.json()).token;
const read = p => worker.fetch(new Request('https://w/get?path=' + encodeURIComponent(p),
  { headers: { Authorization: 'Bearer ' + token } }), env);
const write = (p, c) => worker.fetch(new Request('https://w/commit', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
  body: JSON.stringify({ path: p, content: c, message: 'press' }) }), env);

// One poll = the two files a dashboard reads.
const poll = async () => {
  const a = await read(`races/${SLUG}/config.json`);
  const b = await read(`races/${SLUG}/data.json`);
  if (a.status !== 200 || b.status !== 200) throw new Error(`poll failed ${a.status}/${b.status}`);
};

let failures = 0;
const expect = (label, got, want) => {
  const ok = got === want; if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(52)} ${got}${ok ? '' : ` (expected ${want})`}`);
};

console.log('\ncost of one dashboard poll');
cacheStore.clear(); ghCalls = 0;
await poll();
expect('first poll, cold cache', ghCalls, 2);
ghCalls = 0;
await poll();
expect('second poll, warm cache', ghCalls, 0);

console.log('\nten dashboards on the same race, one poll each');
cacheStore.clear(); ghCalls = 0;
for (let i = 0; i < 10; i++) await poll();
expect('GitHub calls for all ten', ghCalls, 2);

console.log('\na press must not wait for the cache to expire');
ghCalls = 0;
await write(`races/${SLUG}/data.json`, JSON.stringify({ runners: [{ id: 'jason', legs: [1] }] }));
const after = await read(`races/${SLUG}/data.json`);
const body = JSON.parse(Buffer.from((await after.json()).content, 'base64').toString('utf8'));
expect('the next read sees the write', JSON.stringify(body.runners.length), '1');

console.log('\nthe cache must not become a way in');
// Anonymous reads of a public race are allowed, cache or no cache, and were
// before this existed. The cases worth pinning are the private ones, checked
// against a cache that is already warm from an allowed read.
const anonPublic = await worker.fetch(
  new Request('https://w/get?path=' + encodeURIComponent(`races/${SLUG}/data.json`)), env);
expect('public race, no session, warm cache', anonPublic.status, 200);

// Access comes from KV now, not from the file: rewriting config.json no longer
// rewrites who may see a race, which is the point of moving it. So the race is
// made private and handed to somebody else in both places.
repo.set(`races/${SLUG}/config.json`,
  JSON.stringify({ name: 'Sangre', visibility: 'private' }));
kvStore.set('acl:' + SLUG, JSON.stringify({ createdBy: 'someone@else.com', people: [] }));
cacheStore.clear();
await read(`races/${SLUG}/config.json`).catch(() => {});   // warm it as the owner would
const outsider = await read(`races/${SLUG}/data.json`);
expect('private race, warm cache, non-member session', outsider.status, 403);
const anonPrivate = await worker.fetch(
  new Request('https://w/get?path=' + encodeURIComponent(`races/${SLUG}/data.json`)), env);
expect('private race, warm cache, no session', anonPrivate.status, 401);

console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
