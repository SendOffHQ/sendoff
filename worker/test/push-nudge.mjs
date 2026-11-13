// The send-off nudge. A racer checks in at an aid station and leaves without
// the send-off; after twice their usual stop and five minutes, their phone is
// told. Asked for after Lake Murray, 2026-10-27.
//
//   node worker/test/push-nudge.mjs
import worker, { runNudges, nudgeAfterSec, nudgeDue, waitingAt } from '../src/worker.js';
import { fakeD1 } from './fake-d1.mjs';

const OWNER = 'owner@example.com', OTHER = 'other@example.com';
const kvStore = new Map();
const KV = {
  async get(k) { const v = kvStore.get(k); return v === undefined ? null : v; },
  async put(k, v) { kvStore.set(k, v); },
  async delete(k) { kvStore.delete(k); },
  async list({ prefix }) { return { keys: [...kvStore.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }; },
};
globalThis.caches = { default: { async match(){}, async put(){}, async delete(){ return true; } } };
const pushes = []; let pushStatus = 201;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://fcm.googleapis.com/')) { pushes.push({ url: u, headers: opts.headers }); return new Response('', { status: pushStatus }); }
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
const env = { DB, GITHUB_OWNER: 'o', GITHUB_REPO: 'r', GITHUB_TOKEN: 't', GITHUB_BRANCH: 'main',
  AUTH_KV: KV, ALLOWED_ORIGINS: '*', JWT_SECRET: 's', PUBLIC_API_URL: 'https://api.test',
  USERS: JSON.stringify([{ email: OWNER }, { email: OTHER }].map(u => ({ ...u, ...pw }))) };
const ctx = { waitUntil() {} };
const call = async (p, o = {}) => {
  const r = await worker.fetch(new Request('https://w' + p, {
    method: o.method || (o.body !== undefined ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', ...(o.token ? { Authorization: 'Bearer ' + o.token } : {}) },
    ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) }), env, ctx);
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, ...(j || {}) };
};
const login = async (e) => (await call('/login', { body: { email: e, password: 'pw' } })).token;
const owner = await login(OWNER), other = await login(OTHER);
await call('/commit', { token: owner, body: { path: 'races/lm/config.json', message: 't',
  content: JSON.stringify({ name: 'Lake', visibility: 'public', createdBy: OWNER, runners: [{ id: 'faj', name: 'Fajita' }] }) } });
const setLegs = async (legs) => {
  const sha = (await call('/get?path=' + encodeURIComponent('races/lm/data.json'), { token: owner })).sha;
  return (await call('/commit', { token: owner, body: { path: 'races/lm/data.json', message: 't', ...(sha ? { sha } : {}),
    content: JSON.stringify({ runners: [{ id: 'faj', legs }] }) } })).status;
};
const ago = (min) => new Date(Date.now() - min * 60e3).toISOString();
let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p ? 'ok  ' : 'FAIL'} ${l.padEnd(62)} ${JSON.stringify(g)}${p ? '' : ' expected ' + JSON.stringify(w)}`); };

console.log('\nthe key a phone subscribes with');
const k1 = (await call('/push/key')).key, k2 = (await call('/push/key')).key;
ok('made once and kept, the same on every ask', [typeof k1, k1 === k2, k1.length], ['string', true, 87]);
ok('the private half stays in KV', !!JSON.parse(kvStore.get('push:vapid')).jwk.d, true);

console.log('\nsubscribing');
const sub = { slug: 'lm', runnerId: 'faj', endpoint: 'https://fcm.googleapis.com/fcm/send/abc', legs: 4, stations: ['Buzzards Roost', 'Tucker Tower', 'Buzzards Roost 2', 'Finish'] };
ok('needs an account', (await call('/push/subscribe', { body: sub })).status, 401);
ok('and to be on the race', (await call('/push/subscribe', { token: other, body: sub })).status, 403);
ok('the racer\'s own race: yes', (await call('/push/subscribe', { token: owner, body: sub })).status, 200);

console.log('\nchecked in and not sent off');
await setLegs([{ index: 1, startTime: ago(90), endTime: ago(10) }]);
await runNudges(env);
ok('ten minutes in, with no stop to go by: not yet (fifteen)', pushes.length, 0);
await setLegs([{ index: 1, startTime: ago(90), endTime: ago(16) }]);
await runNudges(env);
ok('sixteen minutes in: the phone is told', pushes.length, 1);
const auth = pushes[0].headers.Authorization;
const [, jwt, key] = /^vapid t=([^,]+), k=(.+)$/.exec(auth);
const [h, p, sig] = jwt.split('.');
const dec = (x) => Buffer.from(x.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const pub = await crypto.subtle.importKey('raw', dec(key), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
ok('signed with the key the phone subscribed with', [key === k1, await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, dec(sig), new TextEncoder().encode(h + '.' + p))], [true, true]);
ok('for that push service', JSON.parse(dec(p)).aud, 'https://fcm.googleapis.com');
ok('with no payload: nothing about the race goes through it', pushes[0].headers['Content-Length'], '0');
const msg = await call('/push/message', { body: { endpoint: sub.endpoint } });
ok('the phone asks for its words', [msg.title, /checked in 16 min ago/.test(msg.body), msg.url], ['Still at Buzzards Roost?', true, '/racer.html?id=lm']);
await runNudges(env);
ok('once per station', pushes.length, 1);

console.log('\nby their own usual stop');
await setLegs([{ index: 1, startTime: ago(200), endTime: ago(120) }, { index: 2, startTime: ago(118), endTime: ago(11) }]);
ok('two minutes usual: ten is the least', nudgeAfterSec([{ index: 1, endTime: ago(120) }, { index: 2, startTime: ago(118) }]), 600);
await runNudges(env);
ok('eleven minutes at the next station: told', [pushes.length, (await call('/push/message', { body: { endpoint: sub.endpoint } })).title], [2, 'Still at Tucker Tower?']);
await setLegs([{ index: 1, startTime: ago(200), endTime: ago(120) }, { index: 2, startTime: ago(118), endTime: ago(60) }, { index: 3, startTime: ago(58), endTime: ago(30) }]);
const n = pushes.length;
await setLegs([{ index: 1, startTime: ago(200), endTime: ago(120) }, { index: 2, startTime: ago(118), endTime: ago(60) }, { index: 3, startTime: ago(58), endTime: ago(30) }, { index: 4, startTime: ago(29) }]);
await runNudges(env);
ok('sent off: nothing', pushes.length, n);
await setLegs([{ index: 1, startTime: ago(200), endTime: ago(120) }, { index: 2, startTime: ago(118), endTime: ago(60) }, { index: 3, startTime: ago(58), endTime: ago(30) }, { index: 4, startTime: ago(29), endTime: ago(20) }]);
await runNudges(env);
ok('finished: nothing', pushes.length, n);

console.log('\na phone that has gone');
await setLegs([{ index: 1, startTime: ago(200), endTime: ago(120) }, { index: 2, startTime: ago(118), endTime: ago(60) }, { index: 3, startTime: ago(58), endTime: ago(30) }]);
pushStatus = 410;
await runNudges(env);
ok('is forgotten when the push service says so', [kvStore.has('push:sub:' + [...kvStore.keys()].find(x => x.startsWith('push:sub:'))?.slice(9)), JSON.parse(kvStore.get('push:index'))], [false, []]);
pushStatus = 201;

console.log('\nturning it off');
await call('/push/subscribe', { token: owner, body: sub });
ok('subscribed again', JSON.parse(kvStore.get('push:index')).length, 1);
await call('/push/unsubscribe', { body: { endpoint: sub.endpoint } });
ok('and off', [JSON.parse(kvStore.get('push:index')), (await call('/push/message', { body: { endpoint: sub.endpoint } })).status], [[], 404]);

// ---------- no false reminders ----------
// A race of its own for each, with a course the worker can read, and a phone
// for each so the pushes can be told apart.
const race = async (slug, cfg) => (await call('/commit', { token: owner, body: { path: `races/${slug}/config.json`, message: 't',
  content: JSON.stringify({ name: slug, visibility: 'public', createdBy: OWNER, runners: [{ id: 'faj', name: 'Fajita' }], ...cfg }) } })).status;
const setRunner = async (slug, runner) => {
  const sha = (await call('/get?path=' + encodeURIComponent(`races/${slug}/data.json`), { token: owner })).sha;
  return (await call('/commit', { token: owner, body: { path: `races/${slug}/data.json`, message: 't', ...(sha ? { sha } : {}),
    content: JSON.stringify({ runners: [{ id: 'faj', ...runner }] }) } })).status;
};
const phone = (name) => 'https://fcm.googleapis.com/fcm/send/' + name;
const watch = async (slug, legs = 0) => (await call('/push/subscribe', { token: owner,
  body: { slug, runnerId: 'faj', endpoint: phone(slug), legs, stations: ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven'] } })).status;
const told = (slug) => pushes.filter(x => x.url === phone(slug)).length;
const words = async (slug) => (await call('/push/message', { body: { endpoint: phone(slug) } })).body;

console.log('\nwhen the race is over for them');
const timed = (startedMinAgo) => ({ courseType: 'loops', format: 'timed', startTime: ago(startedMinAgo), cutoffs: { totalHours: 6 }, course: { loopDistanceMi: 3 } });
await race('horn', timed(370));
await setRunner('horn', { legs: [{ index: 1, startTime: ago(370), endTime: ago(330) }, { index: 2, startTime: ago(328), endTime: ago(20) }] });
ok('a timed race, with the phone on it', await watch('horn'), 200);
await runNudges(env);
ok('ran to the horn and sat down at the pit: nothing', told('horn'), 0);
const lap = { legs: [{ index: 1, startTime: ago(100), endTime: ago(20) }] };
ok('the same stop with the race still on is a reminder', !!nudgeDue(timed(100), lap, 0, Date.now()), true);
ok('not for a racer who has stopped', nudgeDue(timed(100), { ...lap, stoppedAt: ago(19) }, 0, Date.now()), null);
const three = { courseType: 'segments', cutoffs: { totalHours: 30 },
  course: { segments: [{ toAid: 'One', distanceMi: 5 }, { toAid: 'Two', distanceMi: 5 }, { toAid: 'Finish', distanceMi: 5 }] } };
ok('nor past the final cutoff of a race to a finish', nudgeDue({ ...three, startTime: ago(31 * 60) }, lap, 0, Date.now()), null);
ok('which an hour before it is still a reminder', !!nudgeDue({ ...three, startTime: ago(29 * 60) }, lap, 0, Date.now()), true);

console.log('\nat the finish, and after hours at a station');
await race('sg', { ...three, startTime: ago(400) });
// The phone gave no number of legs: the course is what says where the finish is.
await setRunner('sg', { legs: [{ index: 1, startTime: ago(400), endTime: ago(300) }, { index: 2, startTime: ago(290), endTime: ago(200) }, { index: 3, startTime: ago(190), endTime: ago(20) }] });
ok('a race to a finish, with the phone on it', await watch('sg', 0), 200);
await runNudges(env);
ok('at the finish: nothing', told('sg'), 0);
await setRunner('sg', { legs: [{ index: 1, startTime: ago(400), endTime: ago(200) }] });
await runNudges(env);
ok('two hundred minutes at a station: nothing, they are not coming back to it', told('sg'), 0);
await setRunner('sg', { legs: [{ index: 1, startTime: ago(400), endTime: ago(170) }] });
await runNudges(env);
ok('inside three hours: told', [told('sg'), /checked in 170 min ago/.test(await words('sg'))], [1, true]);

console.log('\nthe usual stop is taken from real stops');
const cps = { courseType: 'segments', startTime: ago(400), cutoffs: { totalHours: 30 }, course: { segments: [
  { toAid: 'One', distanceMi: 5 }, { toAid: 'Two', distanceMi: 5, checkpoint: true }, { toAid: 'Three', distanceMi: 5, checkpoint: true },
  { toAid: 'Four', distanceMi: 5 }, { toAid: 'Five', distanceMi: 5, checkpoint: true }, { toAid: 'Six', distanceMi: 5 }, { toAid: 'Finish', distanceMi: 5 }] } };
// Ten minutes at One and at Four, straight through the three checkpoints.
const through = (at6) => [{ index: 1, startTime: ago(400), endTime: ago(360) }, { index: 2, startTime: ago(350), endTime: ago(320) },
  { index: 3, startTime: ago(320), endTime: ago(290) }, { index: 4, startTime: ago(290), endTime: ago(260) },
  { index: 5, startTime: ago(250), endTime: ago(220) }, { index: 6, startTime: ago(220), endTime: ago(at6) }];
ok('checkpoints are not stops: ten minutes usual is twenty-five before a reminder', nudgeAfterSec(through(12), cps), 1500);
ok('nor is a station gone straight through', nudgeAfterSec([{ index: 1, endTime: ago(90) }, { index: 2, startTime: ago(90), endTime: ago(60) }, { index: 3, startTime: ago(60), endTime: ago(30) }, { index: 4, startTime: ago(20) }]), 1500);
ok('nor one whose check-in was missed', nudgeAfterSec([{ index: 1, endTime: ago(60), skipped: true }, { index: 2, startTime: ago(60), endTime: ago(30) }, { index: 3, startTime: ago(20) }]), 1500);
ok('legs that are not a list are nobody waiting, not an error', [waitingAt('not a list'), nudgeDue(cps, { legs: { 1: {} } }, 0, Date.now()), nudgeAfterSec({ 1: {} })], [null, null, 900]);
await race('cp', cps);
await setRunner('cp', { legs: through(12) });
ok('a course with checkpoints, with the phone on it', await watch('cp', 7), 200);
await runNudges(env);
ok('twelve minutes into a usual ten-minute stop: nothing', told('cp'), 0);
await setRunner('cp', { legs: through(26) });
await runNudges(env);
ok('twenty-six: told', [told('cp'), (await call('/push/message', { body: { endpoint: phone('cp') } })).title], [1, 'Still at Six?']);

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
