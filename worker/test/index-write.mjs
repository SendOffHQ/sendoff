// Who may change what in the hub's list of races.
//
// races/index.json is one file, and the pages write it whole: read it, change
// the entry for the race in hand, send it all back. The worker used to store
// whatever came, from any signed-in account, so anybody could take another
// person's race off the hub, rewrite its entry, or empty the list. The request
// has not changed and the pages still send the whole file. What is kept of it
// has: an account's write changes only the entries of races it can edit, and
// every other entry is the stored one, whatever was sent.
//
//   node worker/test/index-write.mjs
import worker from '../src/worker.js';
import { fakeD1 } from './fake-d1.mjs';

const ANN = 'ann@example.com', BOB = 'bob@example.com', CREW = 'crew@example.com', ADMIN = 'admin@example.com';
const repo = new Map();
const kvStore = new Map();
const KV = {
  async get(k) { const v = kvStore.get(k); return v === undefined ? null : v; },
  async put(k, v) { kvStore.set(k, v); },
  async delete(k) { kvStore.delete(k); },
  async list({ prefix }) {
    return { keys: [...kvStore.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name })), list_complete: true };
  },
};
globalThis.caches = { default: { async match(){}, async put(){}, async delete(){ return true; } } };
let commits = 0, looked = 0;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('/git/trees/')) return new Response(JSON.stringify({ tree: [] }), { status: 200 });
  const m = u.match(/contents\/(.+?)(\?|$)/);
  const path = m ? decodeURIComponent(m[1]) : '';
  const method = opts.method || 'GET';
  if (method === 'GET') {
    if (path.endsWith('/config.json')) looked++;
    if (!repo.has(path)) return new Response('{"message":"Not Found"}', { status: 404 });
    return new Response(JSON.stringify({ sha: 'sha-' + path, content: Buffer.from(repo.get(path), 'utf8').toString('base64') }), { status: 200 });
  }
  if (method === 'DELETE') { repo.delete(path); return new Response('{}', { status: 200 }); }
  commits++;
  repo.set(path, Buffer.from(JSON.parse(opts.body).content, 'base64').toString('utf8'));
  return new Response(JSON.stringify({ content: { path, sha: 'new-' + path } }), { status: 200 });
};
async function cred(pw) {
  const salt = new Uint8Array(16); crypto.getRandomValues(salt);
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, km, 256);
  const b = a => Buffer.from(a).toString('base64');
  return { hash: b(new Uint8Array(bits)), salt: b(salt), iterations: 100000 };
}
const env = {
  DB: fakeD1(), GITHUB_OWNER: 'o', GITHUB_REPO: 'r', GITHUB_TOKEN: 't', GITHUB_BRANCH: 'main',
  AUTH_KV: KV, ALLOWED_ORIGINS: '*', JWT_SECRET: 's', PUBLIC_BASE_URL: 'https://sendoff.run',
  USERS: JSON.stringify([{ email: ANN, ...await cred('pw') }, { email: BOB, ...await cred('pw') },
    { email: CREW, ...await cred('pw') }, { email: ADMIN, role: 'admin', ...await cred('pw') }]),
};
const call = async (p, o = {}) => {
  const r = await worker.fetch(new Request('https://w' + p, {
    method: o.body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(o.token ? { Authorization: 'Bearer ' + o.token } : {}) },
    ...(o.body ? { body: JSON.stringify(o.body) } : {}) }), env, { waitUntil: () => {} });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, ...(j || {}) };
};
const login = async (e) => (await call('/login', { body: { email: e, password: 'pw' } })).token;
const put = (token, path, doc) => call('/commit', { token, body: { path, content: typeof doc === 'string' ? doc : JSON.stringify(doc), message: 't' } });
const index = () => JSON.parse(repo.get('races/index.json'));
const hub = () => index().races.map(r => `${r.slug}: ${r.name}`);
// The pages' own way of changing the list: read the whole file, change it,
// send the whole file back.
const mutate = async (token, change) => {
  const r = await call('/get?path=' + encodeURIComponent('races/index.json'), { token });
  const doc = JSON.parse(Buffer.from(r.content, 'base64').toString('utf8'));
  return put(token, 'races/index.json', change(doc) || doc);
};
const race = (name, by) => ({ name, visibility: 'public', createdBy: by, runners: [{ id: 'a', name: 'A' }], startTime: '2026-11-01T13:00:00Z' });

let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p ? 'ok  ' : 'FAIL'} ${l.padEnd(62)} ${JSON.stringify(g)}${p ? '' : ' expected ' + JSON.stringify(w)}`); };

const ann = await login(ANN), bob = await login(BOB), crew = await login(CREW), admin = await login(ADMIN);
await put(ann, 'races/ann-race/config.json', race('Ann Fifty', ANN));
await put(bob, 'races/bob-race/config.json', race('Bob Hundred', BOB));
await call('/access/add', { token: ann, body: { slug: 'ann-race', email: CREW, role: 'crew' } });

console.log('\nthe wizard lists a race its account has just made');
repo.set('races/index.json', JSON.stringify({ races: [], note: 'kept' }));
ok('the write is taken', (await mutate(ann, (d) => { d.races.push({ slug: 'ann-race', name: 'Ann Fifty', runnerNames: ['A'] }); d.lastUpdated = '2026-11-01T00:00:00.000Z'; })).status, 200);
await mutate(bob, (d) => { d.races = d.races.filter(r => r.slug !== 'bob-race'); d.races.push({ slug: 'bob-race', name: 'Bob Hundred' }); });
ok('both are on the hub', hub(), ['ann-race: Ann Fifty', 'bob-race: Bob Hundred']);
ok('with the time the page gave', index().lastUpdated, '2026-11-01T00:00:00.000Z');

console.log('\nan account that owns one race, writing the whole list');
await put(bob, 'races/index.json', { races: [{ slug: 'bob-race', name: 'Bob Hundred' }] });
ok('cannot take somebody else\'s race off it', hub(), ['ann-race: Ann Fifty', 'bob-race: Bob Hundred']);
await put(bob, 'races/index.json', { races: [] , evil: true });
ok('cannot empty it: only its own race goes', hub(), ['ann-race: Ann Fifty']);
ok('nor add anything of its own beside the list', [index().evil, index().note], [undefined, 'kept']);
await mutate(bob, (d) => { d.races[0].name = 'Ann Is Slow'; d.races[0].runnerNames = ['Nobody']; d.races.push({ slug: 'bob-race', name: 'Bob Hundred' }); });
ok('cannot rewrite somebody else\'s entry, and its own change still lands', [hub(), index().races[0].runnerNames], [['ann-race: Ann Fifty', 'bob-race: Bob Hundred'], ['A']]);
await mutate(bob, (d) => { d.races.push({ slug: 'no-such-race', name: 'Ghost' }); d.races.push({ slug: '../etc', name: 'Odd' }); d.races.push('junk'); });
ok('cannot list a race that does not exist, or a thing that is not a race', hub(), ['ann-race: Ann Fifty', 'bob-race: Bob Hundred']);
await mutate(bob, (d) => { d.races.find(r => r.slug === 'bob-race').runnerNames = ['Bob']; });
ok('can change its own entry', index().races.find(r => r.slug === 'bob-race').runnerNames, ['Bob']);

console.log('\nsomebody who can edit a race, without owning it');
await mutate(crew, (d) => { d.races.find(r => r.slug === 'ann-race').runnerNames = ['A', 'C']; d.races = d.races.filter(r => r.slug !== 'bob-race'); });
ok('can change that race\'s entry and no other', [index().races.find(r => r.slug === 'ann-race').runnerNames, hub().length], [['A', 'C'], 2]);

console.log('\na write that is not a list at all');
const before = repo.get('races/index.json');
ok('is refused', [(await put(bob, 'races/index.json', 'not json')).status, (await put(bob, 'races/index.json', { races: 'none' })).status], [400, 400]);
ok('and the file is as it was', repo.get('races/index.json') === before, true);

console.log('\nwhen the stored list cannot be read');
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => ((opts.method || 'GET') === 'GET' && String(url).includes('contents/races/index.json'))
  ? new Response('boom', { status: 500 }) : realFetch(url, opts);
commits = 0;
ok('the write waits rather than guess what was there', [(await put(bob, 'races/index.json', { races: [] })).status, commits], [503, 0]);
globalThis.fetch = realFetch;

// Working out whether an entry may be changed means reading that race, and
// the list sent is as long as the sender likes.
console.log('\na list sent to make the worker do a great deal of reading');
const many = Array.from({ length: 60 }, (_, i) => ({ slug: `race-${i}`, name: `Race ${i}` }));
repo.set('races/index.json', JSON.stringify({ races: many }));
looked = 0;
await put(bob, 'races/index.json', { races: Array.from({ length: 200 }, (_, i) => ({ slug: `made-up-${i}`, name: 'x' })) });
ok('is not read race by race without limit', looked <= 25, true);
ok('and changes nothing', hub().length, 60);

console.log('\na site admin');
await put(admin, 'races/index.json', { races: [{ slug: 'bob-race', name: 'Bob Hundred' }] });
ok('still writes the list whole', hub(), ['bob-race: Bob Hundred']);

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
