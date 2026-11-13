// The send-off nudge's registrations: who may make one and for where, how
// many, what happens when a push fails, two races on one phone, and the ones
// already stored when registrations came to be kept by race.
//
//   node worker/test/push-registrations.mjs
import worker, { runNudges, pushEndpointOk } from '../src/worker.js';
import { fakeD1 } from './fake-d1.mjs';

const OWNER = 'owner@example.com', OTHER = 'other@example.com', BUSY = 'busy@example.com';
const kvStore = new Map();
// What the worker asks of KV, counted, and with a way for a test to step in
// on a write the way a second request would.
const kvCalls = { get: 0, put: 0, list: 0 };
let onPut = null;
const KV = {
  async get(k) { kvCalls.get++; const v = kvStore.get(k); return v === undefined ? null : v; },
  async put(k, v) { kvCalls.put++; kvStore.set(k, v); if (onPut) await onPut(k, v); },
  async delete(k) { kvStore.delete(k); },
  async list({ prefix }) { kvCalls.list++; return { keys: [...kvStore.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }; },
};
globalThis.caches = { default: { async match(){}, async put(){}, async delete(){ return true; } } };
const PUSH_HOST = /^https:\/\/(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)\//;
const pushes = [], elsewhere = []; let pushStatus = 201;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (PUSH_HOST.test(u)) {
    pushes.push({ url: u, headers: opts.headers });
    if (pushStatus === 'down') throw new Error('network');
    return new Response('', { status: pushStatus });
  }
  if (u.includes('/git/trees/')) return new Response(JSON.stringify({ tree: [] }), { status: 200 });
  if ((opts.method || 'GET') === 'GET') return new Response('{"message":"Not Found"}', { status: 404 });
  if (!u.includes('api.github.com')) elsewhere.push(u);
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
const env = { DB, GITHUB_OWNER: 'o', GITHUB_REPO: 'r', GITHUB_TOKEN: 't', GITHUB_BRANCH: 'main',
  AUTH_KV: KV, ALLOWED_ORIGINS: '*', JWT_SECRET: 's', PUBLIC_API_URL: 'https://api.test',
  USERS: JSON.stringify([{ email: OWNER }, { email: OTHER }, { email: BUSY }].map(u => ({ ...u, ...pw }))) };
const ctx = { waitUntil() {} };
const call = async (p, o = {}) => {
  const r = await worker.fetch(new Request('https://w' + p, {
    method: o.method || (o.body !== undefined ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', ...(o.token ? { Authorization: 'Bearer ' + o.token } : {}) },
    ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) }), env, ctx);
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, ...(j || {}) };
};
const sha = async (t) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].map(b => b.toString(16).padStart(2, '0')).join('');
const ago = (min) => new Date(Date.now() - min * 60e3).toISOString();
let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p ? 'ok  ' : 'FAIL'} ${l.padEnd(62)} ${JSON.stringify(g)}${p ? '' : ' expected ' + JSON.stringify(w)}`); };

console.log('\ntwo first asks for the key at once');
// The other request's key lands in KV after this one's: what is stored is not
// the pair this request made.
const theirs = JSON.stringify({ pub: 'B'.repeat(87), jwk: await crypto.subtle.exportKey('jwk',
  (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])).privateKey) });
onPut = async (k) => { if (k === 'push:vapid') { onPut = null; kvStore.set(k, theirs); } };
const first = (await call('/push/key')).key;
ok('the one handed out is the one that was kept', [first === JSON.parse(kvStore.get('push:vapid')).pub, first], [true, 'B'.repeat(87)]);
ok('and the same from then on', (await call('/push/key')).key, first);

const login = async (e) => (await call('/login', { body: { email: e, password: 'pw' } })).token;
const owner = await login(OWNER), other = await login(OTHER), busy = await login(BUSY);
// Three races. OWNER made all of them; BUSY is crew on the first two, OTHER
// on none.
const race = async (slug, people = []) => (await call('/commit', { token: owner, body: { path: `races/${slug}/config.json`, message: 't',
  content: JSON.stringify({ name: slug, visibility: 'public', createdBy: OWNER, people, runners: [{ id: 'faj', name: 'Fajita' }, { id: 'bo', name: 'Bo' }] }) } })).status;
const setLegs = async (slug, legs, bo) => {
  const v = (await call('/get?path=' + encodeURIComponent(`races/${slug}/data.json`), { token: owner })).sha;
  return (await call('/commit', { token: owner, body: { path: `races/${slug}/data.json`, message: 't', ...(v ? { sha: v } : {}),
    content: JSON.stringify({ runners: [{ id: 'faj', legs }, ...(bo ? [{ id: 'bo', legs: bo }] : [])] }) } })).status;
};
await race('one', [{ email: BUSY, role: 'crew' }]); await race('two', [{ email: BUSY, role: 'crew' }]); await race('six');
const phone = (name) => 'https://fcm.googleapis.com/fcm/send/' + name;
const body = (slug, name, more = {}) => ({ slug, runnerId: 'faj', endpoint: phone(name), legs: 4, stations: ['Roost', 'Tower', 'Dam', 'Finish'], ...more });
const subscribe = (token, slug, name, more) => call('/push/subscribe', { token, body: body(slug, name, more) });
const index = () => JSON.parse(kvStore.get('push:index') || '[]');
const told = (name) => pushes.filter(x => x.url === phone(name)).length;
const record = (id) => { const v = kvStore.get('push:sub:' + id); return v ? JSON.parse(v) : null; };
const idOf = async (name, slug, runnerId = 'faj') => (await sha(phone(name))) + ':' + (await sha(slug + '\n' + runnerId)).slice(0, 16);

console.log('\nonly the real push services');
const at = (endpoint) => call('/push/subscribe', { token: owner, body: { ...body('one', 'x'), endpoint } });
ok('not any https address', (await at('https://example.com/hook')).status, 400);
ok('not a host that only starts like one', (await at('https://fcm.googleapis.com.evil.example/x')).status, 400);
ok('not one behind a name and an @', (await at('https://fcm.googleapis.com@evil.example/x')).status, 400);
ok('not an address inside a network', (await at('https://169.254.169.254/latest/meta-data')).status, 400);
ok('not another port', (await at('https://fcm.googleapis.com:8443/x')).status, 400);
ok('nothing was stored for any of them', [index(), [...kvStore.keys()].filter(k => k.startsWith('push:sub:'))], [[], []]);
ok('Google, Mozilla, Apple and Microsoft are', ['https://fcm.googleapis.com/fcm/send/a', 'https://updates.push.services.mozilla.com/wpush/v2/a',
  'https://web.push.apple.com/a', 'https://api.web.push.apple.com/a', 'https://wns2-by3p.notify.windows.com/w/?token=a'].map(pushEndpointOk), [true, true, true, true, true]);
ok('and not their look-alikes', ['http://fcm.googleapis.com/a', 'https://push.apple.com/a', 'https://notify.windows.com.example/a', 'https://evil.example/web.push.apple.com', 'nonsense'].map(pushEndpointOk),
  [false, false, false, false, false]);
ok('a race the caller is not on is still refused', (await subscribe(other, 'one', 'stranger')).status, 403);

console.log('\ntwo races on one phone');
await setLegs('one', [{ index: 1, startTime: ago(90), endTime: ago(20) }]);
await setLegs('two', [{ index: 1, startTime: ago(90), endTime: ago(60) }, { index: 2, startTime: ago(58) }]);
const s1 = await subscribe(owner, 'one', 'vest');
ok('the first race, and the key in use comes back with it', [s1.status, s1.key === first], [200, true]);
ok('and the second, on the same phone', (await subscribe(owner, 'two', 'vest')).status, 200);
ok('are two registrations', index().map(e => e.slug), ['one', 'two']);
await runNudges(env);
ok('waiting in the first race: told', [told('vest'), (await call('/push/message', { body: { endpoint: phone('vest') } })).url], [1, '/racer.html?id=one']);
ok('and marked for that race only', [record(await idOf('vest', 'one')).nudged['1'] !== undefined, record(await idOf('vest', 'two')).nudged], [true, {}]);
await setLegs('two', [{ index: 1, startTime: ago(90), endTime: ago(20) }]);
await runNudges(env);
ok('waiting at the same station in the second: told there too', [told('vest'), (await call('/push/message', { body: { endpoint: phone('vest') } })).url], [2, '/racer.html?id=two']);
await runNudges(env);
ok('once each', told('vest'), 2);
await call('/push/unsubscribe', { body: { endpoint: phone('vest'), slug: 'two', runnerId: 'faj' } });
ok('one race turned off leaves the other', index().map(e => e.slug), ['one']);
await call('/push/unsubscribe', { body: { endpoint: phone('vest') } });
ok('and the phone turned off takes the rest', [index(), (await call('/push/message', { body: { endpoint: phone('vest') } })).status], [[], 404]);

console.log('\na registration from before they were kept by race');
// As the worker stored it then: under the phone alone, the index a list of
// ids, and already reminded at the first station.
const oldId = await sha(phone('old'));
const oldSub = () => ({ endpoint: phone('old'), slug: 'one', runnerId: 'faj', email: OWNER, legs: 4, stations: ['Roost', 'Tower', 'Dam', 'Finish'],
  nudged: { 1: ago(5) }, createdAt: ago(600), message: { title: 'Still at Roost?', body: 'x', url: '/racer.html?id=one' } });
kvStore.set('push:sub:' + oldId, JSON.stringify(oldSub()));
kvStore.set('push:index', JSON.stringify([oldId]));
await runNudges(env);
ok('is not reminded again where it already was', told('old'), 0);
ok('still answers the phone with its words', (await call('/push/message', { body: { endpoint: phone('old') } })).title, 'Still at Roost?');
ok('and the index is told its race, once, with nothing asked of the racer', index().map(e => [e.id === oldId, e.slug, e.runnerId, e.email]), [[true, 'one', 'faj', OWNER]]);
await setLegs('one', [{ index: 1, startTime: ago(90), endTime: ago(60) }, { index: 2, startTime: ago(58), endTime: ago(20) }]);
await runNudges(env);
ok('and is reminded at the next station', [told('old'), (await call('/push/message', { body: { endpoint: phone('old') } })).title], [1, 'Still at Tower?']);
ok('the racer screen opened again moves it under its race', (await subscribe(owner, 'one', 'old')).status, 200);
ok('with its marks, and no second copy', [Object.keys(record(await idOf('old', 'one')).nudged), record(oldId), index().map(e => e.id === oldId)], [['1', '2'], null, [false]]);
await runNudges(env);
ok('so nothing is sent twice', told('old'), 1);
// The same phone at a second race in the four days its marks last.
await call('/push/unsubscribe', { body: { endpoint: phone('old') } });
await setLegs('one', [{ index: 1, startTime: ago(90), endTime: ago(60) }, { index: 2, startTime: ago(58) }]);
kvStore.set('push:sub:' + oldId, JSON.stringify(oldSub()));
kvStore.set('push:index', JSON.stringify([oldId]));
await setLegs('two', [{ index: 1, startTime: ago(90), endTime: ago(20) }]);
ok('the same phone at a second race', (await subscribe(owner, 'two', 'old')).status, 200);
ok('does not start with the first race\'s marks', record(await idOf('old', 'two')).nudged, {});
await runNudges(env);
ok('so its first station is a reminder', [told('old'), (await call('/push/message', { body: { endpoint: phone('old') } })).url], [2, '/racer.html?id=two']);
ok('and the first race is still watched', index().length, 2);
await call('/push/unsubscribe', { body: { endpoint: phone('old') } });

console.log('\na push that fails');
await setLegs('one', [{ index: 1, startTime: ago(90), endTime: ago(20) }]);
await subscribe(owner, 'one', 'flaky');
const flaky = await idOf('flaky', 'one');
pushStatus = 503;
await runNudges(env);
ok('the push service is down: tried, and not marked as sent', [told('flaky'), record(flaky).nudged], [1, {}]);
pushStatus = 'down';
await runNudges(env);
ok('no answer at all: tried again on the next run', [told('flaky'), record(flaky).nudged], [2, {}]);
pushStatus = 201;
const r3 = await runNudges(env);
ok('it is back: sent, and marked', [told('flaky'), r3.sent, !!record(flaky).nudged['1']], [3, 1, true]);
await runNudges(env);
ok('and not again', told('flaky'), 3);
await setLegs('one', [{ index: 1, startTime: ago(90), endTime: ago(60) }, { index: 2, startTime: ago(58), endTime: ago(20) }]);
pushStatus = 500;
for (let i = 0; i < 5; i++) await runNudges(env);
ok('down for good: three tries for a station, then no more', [told('flaky'), record(flaky).nudged['2']], [6, undefined]);
ok('and the registration is kept for the next station', index().map(e => e.id), [flaky]);
await setLegs('one', [{ index: 1, startTime: ago(90), endTime: ago(60) }, { index: 2, startTime: ago(58), endTime: ago(40) }, { index: 3, startTime: ago(38), endTime: ago(20) }]);
pushStatus = 403;
await runNudges(env);
ok('refused for its key, as after the key has changed: forgotten', [told('flaky'), record(flaky), index()], [7, null, []]);
pushStatus = 201;

console.log('\none bad record');
// A racer whose legs are not a list, a registration that is not JSON and one
// whose race file is not, each ahead of a racer who is waiting.
await setLegs('one', [{ index: 1, startTime: ago(90), endTime: ago(20) }], 'not a list');
await call('/push/subscribe', { token: owner, body: body('one', 'bo', { runnerId: 'bo' }) });
await subscribe(owner, 'six', 'six');
DB.races.get('six').data = '{not json';
DB.races.get('six').data_sha = 'x';
await subscribe(owner, 'two', 'torn');
kvStore.set('push:sub:' + await idOf('torn', 'two'), '{not json');
await setLegs('two', [{ index: 1, startTime: ago(90), endTime: ago(20) }]);
await subscribe(owner, 'one', 'good');
ok('four registrations, the good one last', index().length, 4);
const ran = await runNudges(env).then(x => x.sent, () => 'threw');
ok('does not stop the run for the rest', [ran, told('good')], [1, 1]);
// And one stored before addresses were checked, somewhere that is no push service.
const evilId = await sha('https://internal.example/hook');
kvStore.set('push:sub:' + evilId, JSON.stringify({ endpoint: 'https://internal.example/hook', slug: 'two', runnerId: 'faj', email: OTHER,
  legs: 4, stations: [], nudged: {}, createdAt: ago(10) }));
kvStore.set('push:index', JSON.stringify([...index(), evilId]));
await runNudges(env);
ok('an address that is no push service is never sent to, and goes', [elsewhere, record(evilId), index().some(e => e.id === evilId)], [[], null, false]);
for (const n of ['bo', 'six', 'torn', 'good']) await call('/push/unsubscribe', { body: { endpoint: phone(n) } });
ok('all turned off', index(), []);

console.log('\nwhat a run costs');
await setLegs('one', [{ index: 1, startTime: ago(90), endTime: ago(60) }, { index: 2, startTime: ago(58) }]);
await setLegs('two', [{ index: 1, startTime: ago(90), endTime: ago(60) }, { index: 2, startTime: ago(58) }]);
for (const [t, slug, n] of [[owner, 'one', 'c1'], [owner, 'two', 'c2'], [busy, 'one', 'c3'], [busy, 'two', 'c4']]) await subscribe(t, slug, n);
Object.assign(kvCalls, { get: 0, put: 0, list: 0 });
const quiet = await runNudges(env);
ok('four racers out on course: one read of KV, no write, no list', [quiet.checked, kvCalls], [4, { get: 1, put: 0, list: 0 }]);

console.log('\na sign-up lost to another at the same moment');
// Another request read the index before this sign-up and writes it after:
// this entry is gone from what is stored.
const before = kvStore.get('push:index');
await race('open', [{ email: OTHER, role: 'racer' }]);
onPut = async (k) => { if (k === 'push:index') { onPut = null; kvStore.set(k, before); } };
ok('signed up as the other write lands', (await subscribe(other, 'open', 'raced')).status, 200);
ok('is read back and put in again', index().some(e => e.slug === 'open'), true);
kvStore.set('push:index', before);
Object.assign(kvCalls, { get: 0, put: 0, list: 0 });
const again = await subscribe(other, 'open', 'raced');
ok('and one lost later is put back when the racer screen is next opened', [again.status, index().some(e => e.slug === 'open')], [200, true]);
ok('which writes the index and nothing else', kvCalls.put, 1);
Object.assign(kvCalls, { get: 0, put: 0, list: 0 });
await subscribe(other, 'open', 'raced');
ok('opened again with nothing changed: no write at all', kvCalls.put, 0);

console.log('\nno account crowds out another');
const mine = () => index().filter(e => e.email === BUSY).length;
for (let i = 0; i < 12; i++) await subscribe(busy, i % 2 ? 'one' : 'two', 'b' + i);
ok('one account holds ten at most', mine(), 10);
ok('its own oldest made way for its newest', [record(await idOf('c3', 'one')), !!record(await idOf('b11', 'one')), index().filter(e => e.email === BUSY).every(e => record(e.id))], [null, true, true]);
ok('nobody else\'s did', [index().filter(e => e.email === OWNER).length, index().filter(e => e.email === OTHER).length], [2, 1]);
let last = 0, lastErr = '';
for (let i = 12; i < 24; i++) { const r = await subscribe(busy, 'one', 'b' + i); last = r.status; lastErr = r.error || ''; }
ok('twenty new ones in a day, then no more', [last, /today/.test(lastErr), mine()], [429, true, 10]);
ok('one it already has can still be opened', (await subscribe(busy, 'one', 'b17')).status, 200);
ok('and another account is not held up by it', (await subscribe(owner, 'one', 'c5')).status, 200);
// A race with a hundred, and five hundred in all, made by other accounts.
const keep = index();
const filler = (n, slug) => Array.from({ length: n }, (_, i) => ({ id: 'f'.repeat(48) + String(i).padStart(16, '0') + ':' + slug, slug, runnerId: 'r' + i, email: `p${i}@example.com`, legs: 4, exp: Date.now() + 86400e3 }));
kvStore.set('push:index', JSON.stringify([...keep, ...filler(100, 'six')]));
const full = await subscribe(owner, 'six', 'c6');
ok('a race that is full takes no more', [full.status, index().length], [429, keep.length + 100]);
kvStore.set('push:index', JSON.stringify([...filler(500, 'elsewhere')]));
const all = await subscribe(owner, 'one', 'c7');
ok('nor does the whole, and nobody is pushed out to make room', [all.status, index().length, index()[0].runnerId], [503, 500, 'r0']);
kvStore.set('push:index', JSON.stringify([...filler(499, 'elsewhere'), { ...filler(1, 'gone')[0], exp: Date.now() - 1 }]));
ok('one that has run out is not counted', [(await subscribe(owner, 'one', 'c7')).status, index().length, index().some(e => e.slug === 'gone')], [200, 500, false]);

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
