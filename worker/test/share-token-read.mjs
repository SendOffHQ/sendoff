// Reading an unlisted race on a share link, with no account at all.
//
// This is the path that lets race data stop being written to git: before it,
// a signed-out visitor holding a share link read the file the site publishes,
// so races/** had to keep being published for those links to work.
//
// The properties that matter are all refusals. A token is a bearer credential
// for one race, and the ways it must not work are more interesting than the
// way it does: not for another race, not after it expires, not after it is
// revoked, and never as a way to become somebody.
//
//   node worker/test/share-token-read.mjs
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
      sha: 'sha-' + path,
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

// Straight into KV, in the shape handleShareLink writes. Minting one needs a
// Pro plan; what is under test here is the reading, not the minting.
const mint = async (slug, { expiresAt } = {}) => {
  const t = 'tok-' + slug + '-' + Math.random().toString(36).slice(2, 8);
  await KV.put('share:' + t, JSON.stringify({
    slug, role: 'view', label: null, createdBy: ME,
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt === undefined ? Date.now() + 7 * 24 * 3600e3 : expiresAt
  }));
  return t;
};

// No Authorization header anywhere in here. This is a stranger with a link.
const read = (path, t) => worker.fetch(new Request(
  'https://w/get?path=' + encodeURIComponent(path) + (t ? '&t=' + encodeURIComponent(t) : '')), env, ctx);

const race = (visibility) => ({
  name: 'Test Race', visibility,
  courseType: 'segments',
  course: { segments: [{ name: 'Start to Finish', distanceMi: 5 }] },
  startTime: '2026-10-03T13:00:00.000Z',
  runners: [{ id: 'jd', name: 'Jason Dupree', bib: '128' }],
});

let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p?'ok  ':'FAIL'} ${l.padEnd(56)} ${JSON.stringify(g)}${p?'':' expected '+JSON.stringify(w)}`); };

await commit('races/quiet-race/config.json', race('private'));
await commit('races/quiet-race/data.json', { runners: [{ id: 'jd', legs: [{ index: 1 }] }] });
await commit('races/other-race/config.json', race('private'));
await commit('races/other-race/data.json', { runners: [{ id: 'jd', legs: [] }] });

const body = async (res) => JSON.parse(Buffer.from((await res.json()).content, 'base64').toString('utf8'));

console.log('\na stranger with a share link reads an unlisted race');
const good = await mint('quiet-race');
let r = await read('races/quiet-race/data.json', good);
ok('the data comes back', r.status, 200);
ok('and it is the race the link was for', (await body(r)).runners[0].legs.length, 1);
r = await read('races/quiet-race/config.json', good);
ok('so does the config', r.status, 200);
ok('but the token makes them nobody, not somebody', (await body(r)).myRole, null);

console.log('\nand without the link, the same request is refused');
ok('no token at all', (await read('races/quiet-race/data.json')).status, 401);

console.log('\na token is for one race and not the rest');
// The failure that would matter most: one shared link becoming a key to
// every unlisted race on the hub.
ok('the other race refuses it', (await read('races/other-race/data.json', good)).status, 401);

console.log('\nand it stops working when it should');
const expired = await mint('quiet-race', { expiresAt: Date.now() - 1000 });
ok('an expired token', (await read('races/quiet-race/data.json', expired)).status, 401);
const revoked = await mint('quiet-race');
await KV.delete('share:' + revoked);
ok('a revoked token', (await read('races/quiet-race/data.json', revoked)).status, 401);
ok('a token nobody ever minted', (await read('races/quiet-race/data.json', 'made-up')).status, 401);

console.log('\nthe published copy is not a way around any of that');
// /public ignores tokens entirely: it is the cacheable route, and a body that
// varied by credential is exactly what must never be cached.
const pub = (path, t) => worker.fetch(new Request(
  'https://w/public?path=' + encodeURIComponent(path) + (t ? '&t=' + encodeURIComponent(t) : '')), env, ctx);
ok('an unlisted race, with a valid token', (await pub('races/quiet-race/data.json', good)).status, 404);
ok('and without one', (await pub('races/quiet-race/data.json')).status, 404);

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
