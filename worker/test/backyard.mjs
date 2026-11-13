// A backyard, on the worker's side (2026-11-13): the send-offs a bell makes,
// written by the scheduled run for whoever has no page open; what the AI
// crew is told; and no send-off reminder, since the bell is the reminder.
//
//   node worker/test/backyard.mjs
import worker, { runBells, nudgeDue } from '../src/worker.js';
import { raceStatus, bellStartDue, whereIs } from '../src/ai-crew.js';
import { fakeD1 } from './fake-d1.mjs';

const OWNER = 'owner@example.com';
const kv = new Map();
const KV = { async get(k){return kv.has(k)?kv.get(k):null;}, async put(k,v){kv.set(k,v);},
             async delete(k){kv.delete(k);},
             async list({prefix}){return {keys:[...kv.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name}))};} };
globalThis.caches = { default: { async match(){return undefined;}, async put(){}, async delete(){return true;} } };
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).includes('/git/trees/')) return new Response(JSON.stringify({ tree: [] }), { status: 200 });
  if ((opts.method || 'GET') === 'GET') return new Response('{"message":"Not Found"}', { status: 404 });
  return new Response(JSON.stringify({ content: { sha: 'x' } }), { status: 200 });
};
async function cred(pw){
  const salt=new Uint8Array(16); crypto.getRandomValues(salt);
  const km=await crypto.subtle.importKey('raw',new TextEncoder().encode(pw),'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:100000,hash:'SHA-256'},km,256);
  const b=a=>Buffer.from(a).toString('base64');
  return { hash:b(new Uint8Array(bits)), salt:b(salt), iterations:100000 };
}
const env = {
  DB: fakeD1(), READ_FROM_D1: 'true', WRITE_TO_GIT: 'false',
  GITHUB_OWNER:'o', GITHUB_REPO:'r', GITHUB_TOKEN:'t', GITHUB_BRANCH:'main',
  AUTH_KV: KV, ALLOWED_ORIGINS:'https://sendoff.run', JWT_SECRET:'s',
  USERS: JSON.stringify([{ email: OWNER, ...await cred('pw') }]),
};
const ctx = { waitUntil: () => {} };
const call = (p, o = {}) => worker.fetch(new Request('https://w' + p, {
  method: o.method || (o.body ? 'POST' : 'GET'),
  headers: { 'Content-Type':'application/json', ...(o.token ? { Authorization: 'Bearer ' + o.token } : {}) },
  ...(o.body ? { body: JSON.stringify(o.body) } : {}) }), env, ctx);
const token = (await (await call('/login', { body: { email: OWNER, password: 'pw' } })).json()).token;
const version = (slug, file) => { const r = env.DB.races.get(slug); return r ? r[file + '_sha'] : undefined; };
const put = (slug, file, doc) => call('/commit', { token, body: {
  path: `races/${slug}/${file}.json`, content: JSON.stringify(doc), message: 'test', sha: version(slug, file) || undefined } });
const dataOf = (slug) => JSON.parse(env.DB.races.get(slug).data);

let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p?'ok  ':'FAIL'} ${l.padEnd(60)} ${JSON.stringify(g)}${p?'':' expected '+JSON.stringify(w)}`); };

const H = 3600e3, M = 60e3, iso = (ms) => new Date(ms).toISOString();
const NOW = Math.floor(Date.now() / M) * M;
const S0 = NOW - 2.5 * H;
const cfg = (extra) => ({ name: 'Yard', visibility: 'private', createdBy: OWNER, courseType: 'loops', format: 'backyard',
  startTime: iso(S0), timezone: 'UTC', backyard: { intervalMin: 60, autoStart: true, ...(extra || {}) },
  course: { loopDistanceMi: 4.167 }, cutoffs: {},
  runners: [{ id: 'ann', name: 'Ann' }, { id: 'bo', name: 'Bo' }, { id: 'cy', name: 'Cy' }] });
const back = [{ index: 1, startTime: iso(S0), endTime: iso(S0 + 50 * M) }, { index: 2, startTime: iso(S0 + H), endTime: iso(S0 + 115 * M) }];

console.log('\nthe bell, with nobody\'s page open');
await put('000301-yard', 'config', cfg());
await put('000301-yard', 'data', { runners: [
  { id: 'ann', legs: back },                                                     // back in time: off on the 2:00 bell
  { id: 'bo', legs: [back[0], { index: 2, startTime: iso(S0 + H) }] },          // out on lap 2, past its bell
  { id: 'cy', legs: back, stoppedAt: iso(S0 + 2 * H) } ] });                    // already out
const run = await runBells(env, ctx, NOW);
const d = dataOf('000301-yard');
const legsOf = (id) => d.runners.find(r => r.id === id).legs;
ok('one race looked at, one send-off written', [run.races, run.written], [1, 1]);
ok('the runner back in time left on the bell', legsOf('ann').find(l => l.index === 3).startTime, iso(S0 + 2 * H));
ok('the one still out on a lap is left for the crew to decide', legsOf('bo').length, 2);
ok('and the one already out is left alone', legsOf('cy').length, 2);
ok('a second run writes nothing more', (await runBells(env, ctx, NOW)).written, 0);

console.log('\nautomatic send-off off');
await put('000302-yard', 'config', cfg({ autoStart: false }));
await put('000302-yard', 'data', { runners: [{ id: 'ann', legs: back }] });
ok('nothing is written: the crew sends each lap', [(await runBells(env, ctx, NOW)).written, dataOf('000302-yard').runners[0].legs.length], [0, 2]);

console.log('\nwhen the bell is owed');
const c = cfg();
ok('not before the bell', bellStartDue(c, { id: 'ann', legs: back }, S0 + 110 * M + H - H), null);
ok('nor for a lap back after its bell', bellStartDue(c, { id: 'ann', legs: [back[0], { index: 2, startTime: iso(S0 + H), endTime: iso(S0 + 2 * H + M) }] }, NOW), null);
ok('the start is a bell too', bellStartDue(c, { id: 'ann', legs: [] }, S0 + M), { leg: 1, startTime: iso(S0) });

console.log('\nwhat the AI crew is told');
const st = raceStatus(c, { runners: [{ id: 'ann', legs: [...back, { index: 3, startTime: iso(S0 + 2 * H) }] }] }, 'ann', NOW);
ok('laps done, and the next bell in half an hour', [st.backyard.lapsDone, !!st.backyard.nextBell, st.backyard.nextBellIn], [2, true, '0h 30m']);
ok('how it is scored', /backyard/.test(st.race.scoredBy), true);
ok('and no finish cutoff', st.race.finishCutoff || null, null);
ok('a runner out is out', whereIs(c, { id: 'cy', legs: back, stoppedAt: iso(S0 + 2 * H) }).state, 'out');
ok('the winner is finished', whereIs(c, { id: 'cy', legs: back, stoppedAt: iso(S0 + 115 * M), won: true }).state, 'finished');

console.log('\nthe send-off reminder');
ok('says nothing in a backyard, however long the stop', nudgeDue(c, { id: 'ann', legs: back }, 0, S0 + 115 * M + 40 * M), null);

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
