// Public racer profiles: off until switched on, at a username, and showing
// only what the racer chose. Never a private race, never an address, never a
// leg's notes, and the same "not found" for a profile that is off as for a
// username nobody has.
//
//   node worker/test/public-profile.mjs
import worker from '../src/worker.js';
import { fakeD1 } from './fake-d1.mjs';

const ME = 'me@example.com', PAL = 'pal@example.com';
const kv = new Map();
const KV = { async get(k){return kv.has(k)?kv.get(k):null;}, async put(k,v){kv.set(k,v);},
             async delete(k){kv.delete(k);},
             async list({prefix,limit}){return {keys:[...kv.keys()].filter(k=>k.startsWith(prefix)).sort().slice(0,limit||1000).map(name=>({name}))};} };
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
  DB: fakeD1(), GITHUB_OWNER:'o', GITHUB_REPO:'r', GITHUB_TOKEN:'t', GITHUB_BRANCH:'main',
  AUTH_KV: KV, ALLOWED_ORIGINS:'*', JWT_SECRET:'s',
  USERS: JSON.stringify([{ email: PAL, role: 'admin', ...await cred('pw') }]),
};
kv.set('user:' + ME, JSON.stringify({ email: ME, role: 'crew', ...await cred('pw') }));
const call = (p, o = {}) => worker.fetch(new Request('https://w' + p, {
  method: o.body ? 'POST' : 'GET',
  headers: { 'Content-Type':'application/json', ...(o.token ? { Authorization: 'Bearer ' + o.token } : {}) },
  ...(o.body ? { body: JSON.stringify(o.body) } : {}) }), env, { waitUntil: () => {} });
const login = async (e) => (await (await call('/login', { body: { email: e, password: 'pw' } })).json()).token;
const version = (slug, file) => { const r = env.DB.races.get(slug); return r ? r[file + '_sha'] : undefined; };
const put = (token, slug, file, doc) => call('/commit', { token, body: {
  path: `races/${slug}/${file}.json`, content: JSON.stringify(doc), message: 'test', sha: version(slug, file) || undefined } });
const pub = async (u) => { const r = await call('/public-profile?u=' + encodeURIComponent(u)); return { status: r.status, text: await r.text() }; };
const settings = async (token, body) => (await call('/public-profile-settings', { token, body })).json();

let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p?'ok  ':'FAIL'} ${l.padEnd(60)} ${JSON.stringify(g)}${p?'':' expected '+JSON.stringify(w)}`); };

const me = await login(ME), pal = await login(PAL);
await call('/profile', { token: me, body: { displayName: 'Jason Dupree' } });
const course = { courseType: 'segments', course: { segments: [{ name: 'A to B', distanceMi: 10 }, { name: 'B to C', distanceMi: 10 }] } };
const legs = [{ index: 1, startTime: '2026-09-26T10:00:00Z', endTime: '2026-09-26T12:00:00Z', calories: 400, sodiumMg: 600, notes: 'stomach rough', meds: 'ibuprofen', preset_0: 2 },
              { index: 2, startTime: '2026-09-26T12:05:00Z', endTime: '2026-09-26T14:00:00Z', issues: 'blister' }];
await put(me, 'open', 'config', { name: 'Open Race', visibility: 'public', createdBy: ME, ...course, crewNotes: 'gate code 1234',
  runners: [{ id: 'me', name: 'Jason', email: ME }, { id: 'pal', name: 'Pal', email: PAL }] });
await put(me, 'open', 'data', { runners: [{ id: 'me', legs }, { id: 'pal', legs }] });
await put(me, 'secret', 'config', { name: 'Secret Race', visibility: 'private', createdBy: ME, ...course, runners: [{ id: 'me', name: 'Jason', email: ME }] });
await put(me, 'secret', 'data', { runners: [{ id: 'me', legs }] });
await put(pal, 'theirs', 'config', { name: 'Not Mine', visibility: 'public', createdBy: PAL, ...course, runners: [{ id: 'p', name: 'Pal', email: PAL }] });
await call('/my-results/save', { token: me, body: { slug: 'open', result: { officialSec: 4 * 3600, placeOverall: 3, fieldOverall: 50, report: 'Went well.', changeNext: 'Eat more.' } } });
await call('/my-results/save', { token: me, body: { slug: 'secret', result: { officialSec: 9999 } } });
const lead = await (await call('/my-results/save', { token: me, body: { result: { name: 'Leadville 100', date: '2025-08-16', distanceMi: 100, officialSec: 100000, report: 'Long day.' } } })).json();

console.log('\noff until switched on');
const nobody = await pub('nobody_here');
ok('a username nobody has', nobody.status, 404);
ok('switching on needs a username first', (await settings(me, { public: true })).code, 'no_username');
await call('/username', { token: me, body: { username: 'jason' } });
const off = await pub('jason');
ok('a real username with the profile off reads exactly the same', [off.status, off.text], [nobody.status, nobody.text]);
ok('settings start off, out of search engines', await settings(me, {}), { public: false, indexable: false, races: {}, username: 'jason' });

console.log('\nswitched on');
await settings(me, { public: true });
let r = await pub('@Jason');
ok('anyone can read it, no sign-in, any capitals, with or without @', r.status, 200);
let p = JSON.parse(r.text);
ok('name and username', [p.name, p.username], ['Jason Dupree', 'jason']);
ok('only the listed public race of mine: no private, no one else\'s', p.races.map(x => x.slug), ['open']);
ok('the private race is not even counted', r.text.includes('Secret') || r.text.includes('9999'), false);
ok('just my runner, not the others on the race', p.races[0].config.runners.map(x => x.id), ['me']);
ok('legs carry times and nothing else', p.races[0].runner.legs, [
  { index: 1, startTime: '2026-09-26T10:00:00Z', endTime: '2026-09-26T12:00:00Z' },
  { index: 2, startTime: '2026-09-26T12:05:00Z', endTime: '2026-09-26T14:00:00Z' }]);
ok('the result, without the report', p.races[0].entered, { officialSec: 14400, dnf: false, placeOverall: 3, fieldOverall: 50 });
ok('races from before SendOff too, without their report', [p.manual.length, p.manual[0].name, p.manual[0].report], [1, 'Leadville 100', undefined]);
ok('no address, no crew notes, no leg notes anywhere', ['@example.com', 'gate code', 'stomach', 'ibuprofen', 'blister'].some(w => r.text.includes(w)), false);
ok('search engines still told no', p.indexable, false);

console.log('\nwhat the racer chooses, race by race');
await settings(me, { race: { key: 'open', report: true, fuel: true } });
p = JSON.parse((await pub('jason')).text);
ok('a report shown', [p.races[0].entered.report, p.races[0].entered.changeNext], ['Went well.', 'Eat more.']);
ok('fuel shown: the numbers and nothing more', p.races[0].runner.legs[0], { index: 1, startTime: '2026-09-26T10:00:00Z', endTime: '2026-09-26T12:00:00Z', calories: 400, sodiumMg: 600 });
await settings(me, { race: { key: lead.result.id, hide: true } });
await settings(me, { race: { key: 'open', hide: true } });
p = JSON.parse((await pub('jason')).text);
ok('any race can be hidden, by hand-entered ones too', [p.races.length, p.manual.length], [0, 0]);
await settings(me, { race: { key: 'open', hide: false, report: false, fuel: false } });
ok('back to the defaults leaves nothing stored for it', Object.keys((await settings(me, {})).races), [lead.result.id]);
await settings(me, { indexable: true });
ok('search engines, when ticked', JSON.parse((await pub('jason')).text).indexable, true);
ok('settings are the account\'s own', (await call('/public-profile-settings')).status, 401);

console.log('\nswitched off, and the username moved');
await settings(me, { public: false });
ok('off again: not found, the same as nobody', (await pub('jason')).text, nobody.text);
await settings(me, { public: true });
await call('/username', { token: me, body: { username: 'jdupree' } });
ok('a new username is the new address', [(await pub('jdupree')).status, (await pub('jason')).status], [200, 404]);

console.log('\nwhen the account is deleted');
await call('/account/delete', { token: pal, body: { email: ME } });
ok('the settings go with it', kv.has('pub:' + ME), false);
ok('and the address is not found', (await pub('jdupree')).status, 404);

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
