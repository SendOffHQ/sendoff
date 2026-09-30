// Regression test for "Race not found" on a race the same session just made.
//
// GitHub's Contents API is not read-after-write consistent, and the wizard
// makes that worse than a coin flip: reserving a race number GETs
// races/<slug>/config.json to check the folder is free, which caches a 404 for
// that exact URL. The wizard writes the file and then writes data.json;
// authorising that second write re-reads the same URL and is served the cached
// miss. The stub below models exactly that, so the test fails against a worker
// without the creation grant and passes with it.
//
// Config and data go to D1 now, which is read-after-write consistent, so the
// cached miss can only bite the course file, still committed for a public
// race. The sequence is kept whole because the wizard's is.
//
//   node worker/test/creation-grant.mjs
import worker from '../src/worker.js';
import { fakeD1 } from './fake-d1.mjs';

const SLUG = '000002-test-race-z9ruhk';
const ME = 'owner@example.com', OTHER = 'someone@else.com';

const repo = new Map();       // what GitHub actually holds
const negCache = new Set();   // paths a GET has already cached a 404 for
const kvStore = new Map();

const KV = {
  async get(k) { const v = kvStore.get(k); return v === undefined ? null : v; },
  async put(k, v) { kvStore.set(k, v); },
  async delete(k) { kvStore.delete(k); },
};

async function cred(pw) {
  const salt = new Uint8Array(16); crypto.getRandomValues(salt);
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, km, 256);
  const b64 = a => Buffer.from(a).toString('base64');
  return { hash: b64(new Uint8Array(bits)), salt: b64(salt), iterations: 100000 };
}
const env = {
  GITHUB_OWNER: 'o', GITHUB_REPO: 'r', GITHUB_TOKEN: 't', GITHUB_BRANCH: 'main',
  AUTH_KV: KV, ALLOWED_ORIGINS: '*', JWT_SECRET: 'test-secret',
  DB: fakeD1(), READ_FROM_D1: 'true',
  USERS: JSON.stringify([{ email: ME, ...await cred('pw') }, { email: OTHER, ...await cred('pw') }]),
};

const realFetch = async (url, opts = {}) => {
  const m = String(url).match(/contents\/(.+?)(\?|$)/);
  const path = m ? decodeURIComponent(m[1]) : '';
  if ((opts.method || 'GET') === 'GET') {
    if (negCache.has(path) || !repo.has(path)) {
      negCache.add(path);
      return new Response('{"message":"Not Found"}', { status: 404 });
    }
    return new Response(JSON.stringify({
      sha: 'sha-' + path,
      content: Buffer.from(repo.get(path), 'utf8').toString('base64'),
    }), { status: 200 });
  }
  const body = JSON.parse(opts.body);
  repo.set(path, Buffer.from(body.content, 'base64').toString('utf8'));
  return new Response(JSON.stringify({ content: { path } }), { status: 200 });
};
globalThis.fetch = realFetch;

async function login(email) {
  const r = await worker.fetch(new Request('https://w/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'pw' }) }), env);
  const { token } = await r.json();
  if (!token) throw new Error('login failed for ' + email);
  return token;
}
const commit = (token, path, content) => worker.fetch(new Request('https://w/commit', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
  body: JSON.stringify({ path, content, message: 'test' }) }), env);
const read = (token, path) => worker.fetch(new Request(
  'https://w/get?path=' + encodeURIComponent(path), { headers: { Authorization: 'Bearer ' + token } }), env);

let failures = 0;
function expect(label, got, want) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(48)} ${got}${ok ? '' : ` (expected ${want})`}`);
}

const cfgJson = JSON.stringify({ name: 'Test Race', visibility: 'public', createdBy: ME, people: [] });
const mine = await login(ME);
const theirs = await login(OTHER);

console.log('\nthe wizard sequence, cache primed the way it really is');
expect('reserve probe caches the 404', (await read(mine, `races/${SLUG}/config.json`)).status, 404);
expect('PUT config.json', (await commit(mine, `races/${SLUG}/config.json`, cfgJson)).status, 200);
expect('PUT data.json', (await commit(mine, `races/${SLUG}/data.json`, '{"runners":[]}')).status, 200);
expect('PUT course.gpx', (await commit(mine, `races/${SLUG}/course.gpx`, '<gpx/>')).status, 200);

console.log('\nthe grant must not become a way in');
// 403, not the 404 this once was: that 404 was GitHub's cached miss hiding the
// race. The database answers straight, so the race is found and refused.
expect('another account writes that slug', (await commit(theirs, `races/${SLUG}/data.json`, '{}')).status, 403);
expect('a slug nobody created', (await commit(mine, 'races/000003-never-made/data.json', '{}')).status, 404);

console.log('\na creation the database rejected must leave no grant');
const FAIL = '000004-put-fails';
const realPrepare = env.DB.prepare;
env.DB.prepare = (sql) => {
  const st = realPrepare(sql);
  const bind = st.bind;
  return { ...st, bind: (...a) => {
    const b = bind(...a);
    return a.includes(FAIL) && /^INSERT/.test(b.sql) ? { ...b, run: async () => { throw new Error('boom'); } } : b;
  } };
};
expect('PUT config.json fails upstream', (await commit(mine, `races/${FAIL}/config.json`, cfgJson)).status, 503);
expect('PUT data.json after that failure', (await commit(mine, `races/${FAIL}/data.json`, '{}')).status, 404);

console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
