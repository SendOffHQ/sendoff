// The published copy: /public, the endpoint a signed-out spectator reads.
//
// Two properties carry this file. The first is that an unlisted race is
// answered exactly as a race that does not exist, because an unlisted race's
// only protection is that its address is not known and "forbidden" confirms a
// guess. The second is that the answer never depends on who asked: this route
// is meant to sit behind a shared cache, and a body that varied by caller
// would be a cache poisoning bug rather than a feature.
//
//   node worker/test/published-copy.mjs
import worker from '../src/worker.js';

const ME = 'owner@example.com';
const repo = new Map();
const kvStore = new Map();
const KV = {
  async get(k) { const v = kvStore.get(k); return v === undefined ? null : v; },
  async put(k, v) { kvStore.set(k, v); },
  async delete(k) { kvStore.delete(k); },
};
globalThis.caches = { default: { async match(){}, async put(){}, async delete(){ return true; } } };

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const m = u.match(/contents\/(.+?)(\?|$)/);
  const path = m ? decodeURIComponent(m[1]) : '';
  if ((opts.method || 'GET') === 'GET') {
    if (!repo.has(path)) return new Response('{"message":"Not Found"}', { status: 404 });
    return new Response(JSON.stringify({
      sha: 'sha-' + path + '-' + repo.get(path).length,
      content: Buffer.from(repo.get(path), 'utf8').toString('base64'),
    }), { status: 200 });
  }
  const body = JSON.parse(opts.body);
  repo.set(path, Buffer.from(body.content, 'base64').toString('utf8'));
  return new Response(JSON.stringify({ content: { path, sha: 'new-' + path } }), { status: 200 });
};

async function cred(pw) {
  const salt = new Uint8Array(16); crypto.getRandomValues(salt);
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name:'PBKDF2', salt, iterations:100000, hash:'SHA-256' }, km, 256);
  const b = a => Buffer.from(a).toString('base64');
  return { hash: b(new Uint8Array(bits)), salt: b(salt), iterations: 100000 };
}
const env = {
  GITHUB_OWNER:'o', GITHUB_REPO:'r', GITHUB_TOKEN:'t', GITHUB_BRANCH:'main',
  AUTH_KV: KV, ALLOWED_ORIGINS:'*', JWT_SECRET:'s', PUBLIC_BASE_URL: 'https://sendoff.run',
  USERS: JSON.stringify([{ email: ME, ...await cred('pw') }]),
};

const waited = [];
const ctx = { waitUntil: (p) => waited.push(p) };
const settle = async () => { await Promise.all(waited.splice(0)); };

const token = await (async () => {
  const r = await worker.fetch(new Request('https://w/login', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ email: ME, password: 'pw' }) }), env);
  return (await r.json()).token;
})();

const commit = async (path, doc) => {
  const r = await worker.fetch(new Request('https://w/commit', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ path, content: JSON.stringify(doc, null, 2) + '\n',
                           message: 'test', sha: repo.has(path) ? 'sha-' + path : undefined })
  }), env, ctx);
  await settle();
  return r;
};

// No Authorization header at all: this is the spectator.
const pub = (path, headers = {}) =>
  worker.fetch(new Request('https://w/public?path=' + encodeURIComponent(path), { headers }), env, ctx);

const race = (visibility) => ({
  name: 'Test Race', visibility,
  courseType: 'loops',
  course: { loopCount: 2, loopDistanceMi: 5, loopSegments: [
    { name: 'Start to Ridge', distanceMi: 2.5 }, { name: 'Ridge to Start', distanceMi: 2.5 } ] },
  startTime: '2026-10-03T13:00:00.000Z',
  runners: [{ id: 'jd', name: 'Jason Dupree', bib: '128' }],
});

let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p?'ok  ':'FAIL'} ${l.padEnd(56)} ${JSON.stringify(g)}${p?'':' expected '+JSON.stringify(w)}`); };

await commit('races/open-race/config.json', race('public'));
await commit('races/open-race/data.json', { runners: [{ id: 'jd', legs: [] }] });
await commit('races/quiet-race/config.json', race('private'));
await commit('races/quiet-race/data.json', { runners: [{ id: 'jd', legs: [] }] });

const body = async (res) => JSON.parse(Buffer.from((await res.json()).content, 'base64').toString('utf8'));

console.log('\na public race is served to nobody in particular');
let r = await pub('races/open-race/data.json');
ok('the data comes back', r.status, 200);
ok('and it is the race asked for', (await body(r)).runners[0].id, 'jd');
r = await pub('races/open-race/config.json');
ok('so does the config', r.status, 200);
const cfg = await body(r);
ok('with no role, because the reader is nobody', cfg.myRole, null);
ok('and it is still the right race', cfg.name, 'Test Race');

console.log('\nan unlisted race is not served, and does not admit it exists');
const quiet = await pub('races/quiet-race/data.json');
const missing = await pub('races/no-such-race/data.json');
ok('the unlisted race is a 404', quiet.status, 404);
ok('a race that does not exist is the same 404', missing.status, 404);
ok('and the two answers are indistinguishable',
  await quiet.clone().text() === await missing.clone().text(), true);

console.log('\nthe answer never depends on who asked');
// The whole reason this is a separate route from /get. A shared cache keys on
// the address, so a session that changed the body would be served to the next
// caller along.
const anon = await pub('races/open-race/config.json');
const withSession = await pub('races/open-race/config.json', { Authorization: 'Bearer ' + token });
ok('a caller holding a valid session gets the anonymous body',
  await anon.clone().text() === await withSession.clone().text(), true);
ok('including the null role', (await body(withSession)).myRole, null);
ok('which is not what /get would have said', await (async () => {
  const g = await worker.fetch(new Request('https://w/get?path=' +
    encodeURIComponent('races/open-race/config.json'),
    { headers: { Authorization: 'Bearer ' + token } }), env, ctx);
  const c = JSON.parse(Buffer.from((await g.json()).content, 'base64').toString('utf8'));
  return c.myRole;
})(), 'owner');

console.log('\na poll that finds nothing new costs a 304');
r = await pub('races/open-race/data.json');
const etag = r.headers.get('ETag');
ok('there is an ETag to go back with', !!etag, true);
ok('and a cache is told it may keep it', r.headers.get('Cache-Control'), 'public, max-age=3');
const again = await pub('races/open-race/data.json', { 'If-None-Match': etag });
ok('the same copy comes back as 304', again.status, 304);
ok('with no body at all', await again.text(), '');

console.log('\nand a change breaks the match');
await commit('races/open-race/data.json', { runners: [{ id: 'jd', legs: [{ index: 1 }] }] });
const changed = await pub('races/open-race/data.json', { 'If-None-Match': etag });
ok('the stale tag no longer matches', changed.status, 200);
ok('the new tag is different', changed.headers.get('ETag') !== etag, true);
ok('and the new leg is in it', (await body(changed)).runners[0].legs.length, 1);

console.log('\nthe route says no to everything else');
ok('a path outside races/', (await pub('hub.json')).status, 404);
ok('a directory rather than a file', (await pub('races/open-race')).status, 404);
ok('nothing at all', (await worker.fetch(new Request('https://w/public'), env, ctx)).status, 404);

console.log('\nand a browser on another origin can actually use it');
r = await pub('races/open-race/data.json', { Origin: 'https://sendoff.run' });
ok('ETag is readable cross-origin', (r.headers.get('Access-Control-Expose-Headers') || ''), 'ETag');
ok('If-None-Match is an allowed header',
  (r.headers.get('Access-Control-Allow-Headers') || '').includes('If-None-Match'), true);
ok('and the cache is told the origin matters', (r.headers.get('Vary') || ''), 'Origin');

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
