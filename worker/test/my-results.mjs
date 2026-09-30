// A racer's own results: which races count as theirs, what the page is sent
// about them, and what they can write down afterwards.
//
//   node worker/test/my-results.mjs
import worker from '../src/worker.js';
import { fakeD1 } from './fake-d1.mjs';

const ME = 'me@example.com', OTHER = 'other@example.com';
const kv = new Map();
const KV = { async get(k){return kv.has(k)?kv.get(k):null;}, async put(k,v){kv.set(k,v);},
             async delete(k){kv.delete(k);},
             async list({prefix}){return {keys:[...kv.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name}))};} };
globalThis.caches = { default: { async match(){return undefined;}, async put(){}, async delete(){return true;} } };
// Git holds nothing for these races; they live in D1, as new races do.
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
  DB: fakeD1(),
  GITHUB_OWNER:'o', GITHUB_REPO:'r', GITHUB_TOKEN:'t', GITHUB_BRANCH:'main',
  AUTH_KV: KV, ALLOWED_ORIGINS:'*', JWT_SECRET:'s',
  USERS: JSON.stringify([{ email: ME, ...await cred('pw') }, { email: OTHER, ...await cred('pw') }]),
};
const call = (p, o = {}) => worker.fetch(new Request('https://w' + p, {
  method: o.body ? 'POST' : 'GET',
  headers: { 'Content-Type':'application/json', ...(o.token ? { Authorization: 'Bearer ' + o.token } : {}) },
  ...(o.body ? { body: JSON.stringify(o.body) } : {}) }), env, { waitUntil: () => {} });
const login = async (e) => (await (await call('/login', { body: { email: e, password: 'pw' } })).json()).token;
const version = (slug, file) => { const r = env.DB.races.get(slug); return r ? r[file + '_sha'] : undefined; };
const put = async (token, slug, file, doc) => call('/commit', { token, body: {
  path: `races/${slug}/${file}.json`, content: JSON.stringify(doc), message: 'test', sha: version(slug, file) || undefined } });

let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p?'ok  ':'FAIL'} ${l.padEnd(56)} ${JSON.stringify(g)}${p?'':' expected '+JSON.stringify(w)}`); };

const me = await login(ME), other = await login(OTHER);
const course = { courseType: 'segments', course: { segments: [{ name: 'A to B', distanceMi: 10 }, { name: 'B to C', distanceMi: 10 }] } };
const legs = [{ index: 1, startTime: '2026-09-26T10:00:00Z', endTime: '2026-09-26T12:00:00Z', calories: 400 },
              { index: 2, startTime: '2026-09-26T12:05:00Z', endTime: '2026-09-26T14:00:00Z' }];

// Mine: public, and I am runner "me", linked. Somebody else runs it too.
await put(me, 'mine', 'config', { name: 'My Race', visibility: 'public', createdBy: ME, startTime: '2026-09-26T10:00:00Z',
  ...course, crewNotes: 'secret notes', runners: [{ id: 'me', name: 'Me', email: ME }, { id: 'pal', name: 'Pal', email: OTHER }] });
await put(me, 'mine', 'data', { runners: [{ id: 'me', legs }, { id: 'pal', legs: [legs[0]] }] });
// Also mine, private, but the runner was never linked: a candidate.
await put(me, 'unlinked', 'config', { name: 'Old Race', visibility: 'private', createdBy: ME, ...course,
  runners: [{ id: 'j', name: 'Jason' }] });
// Somebody else's, and I crewed it: not mine, not mine to link.
await put(other, 'crewed', 'config', { name: 'Crewed', visibility: 'public', createdBy: OTHER, ...course,
  people: [{ email: ME, role: 'crew' }], runners: [{ id: 'o', name: 'Other' }] });

console.log('\nthe races that are mine');
const r = await (await call('/my-results', { token: me })).json();
ok('the one I am linked to as a runner', r.races.map(x => x.slug), ['mine']);
ok('with my legs', r.races[0].runner.legs.length, 2);
ok('and only me on it, not the other runner', r.races[0].config.runners.map(x => x.id), ['me']);
ok('with no crew notes', r.races[0].config.crewNotes, undefined);
ok('and no other address anywhere', JSON.stringify(r).includes(OTHER), false);
ok('the unlinked one I made is offered to link', r.candidates.map(c => [c.slug, c.runners.map(x => x.name)]), [['unlinked', ['Jason']]]);
ok('a race I only crewed is neither', [...r.races, ...r.candidates].some(x => x.slug === 'crewed'), false);
ok('no one else\'s results', r.results, { bySlug: {}, manual: [] });

console.log('\nwriting down how it went');
const saveMine = await call('/my-results/save', { token: me, body: { slug: 'mine', result: {
  officialSec: 4 * 3600 + 3, placeOverall: 12, fieldOverall: 140, resultsUrl: 'https://ultrasignup.com/results/1',
  report: 'Went out too fast.', changeNext: 'Walk the first climb.', mystery: 'dropped' } } });
ok('a result for my race saves', saveMine.status, 200);
const stored = JSON.parse(kv.get('results:' + ME)).bySlug.mine;
ok('the fields it understood', [stored.officialSec, stored.placeOverall, stored.fieldOverall, stored.report], [14403, 12, 140, 'Went out too fast.']);
ok('and nothing it did not', stored.mystery, undefined);
ok('a result for a race I only crewed is refused',
   (await call('/my-results/save', { token: me, body: { slug: 'crewed', result: { officialSec: 100 } } })).status, 403);
ok('nor for somebody else\'s race by slug',
   (await call('/my-results/save', { token: other, body: { slug: 'unlinked', result: { officialSec: 100 } } })).status, 403);
const badPlace = await (await call('/my-results/save', { token: me, body: { slug: 'mine', result: { placeOverall: 200, fieldOverall: 140 } } })).json();
ok('a place past the field size says which field', badPlace.field, 'placeOverall');
const badUrl = await (await call('/my-results/save', { token: me, body: { slug: 'mine', result: { resultsUrl: 'javascript:alert(1)' } } })).json();
ok('a link that is not a web address is refused', badUrl.field, 'resultsUrl');
const dnf = await (await call('/my-results/save', { token: me, body: { slug: 'mine', result: { dnf: true, dnfWhere: 'Mile 86', officialSec: 99 } } })).json();
ok('a DNF keeps where, and drops a finish time', [dnf.result.dnf, dnf.result.dnfWhere, dnf.result.officialSec], [true, 'Mile 86', undefined]);

console.log('\na race from before SendOff');
const noName = await (await call('/my-results/save', { token: me, body: { result: { date: '2025-09-27', distanceMi: 100, officialSec: 130000 } } })).json();
ok('needs a name', noName.field, 'name');
const noTime = await (await call('/my-results/save', { token: me, body: { result: { name: 'Leadville', date: '2025-08-16', distanceMi: 100 } } })).json();
ok('needs a finish time or a DNF', noTime.field, 'officialSec');
const lead = await (await call('/my-results/save', { token: me, body: { result: {
  name: 'Leadville 100', date: '2025-08-16', distanceMi: 100.4, climbFt: 15600, activity: 'trail-run', officialSec: 29 * 3600 } } })).json();
ok('saves, with an id of its own', /^m-/.test(lead.result.id), true);
const edited = await (await call('/my-results/save', { token: me, body: { id: lead.result.id, result: {
  name: 'Leadville Trail 100', date: '2025-08-16', distanceMi: 100.4, officialSec: 28 * 3600 } } })).json();
ok('editing it keeps one entry', [edited.results.manual.length, edited.results.manual[0].name], [1, 'Leadville Trail 100']);
ok('and comes back on the page', (await (await call('/my-results', { token: me })).json()).results.manual[0].officialSec, 28 * 3600);

console.log('\nand they are mine alone');
const theirs = await (await call('/my-results', { token: other })).json();
ok('another account sees none of them', [theirs.results.manual.length, Object.keys(theirs.results.bySlug).length], [0, 0]);
ok('and sees their own linked race', theirs.races.map(x => x.slug), ['mine']);
ok('as their own runner, not mine', theirs.races[0].config.runners.map(x => x.id), ['pal']);
ok('nobody signed out gets anything', (await call('/my-results')).status, 401);

console.log('\ntaking one back');
await call('/my-results/delete', { token: me, body: { id: lead.result.id } });
await call('/my-results/delete', { token: me, body: { slug: 'mine' } });
const after = JSON.parse(kv.get('results:' + ME));
ok('both gone', [after.manual.length, Object.keys(after.bySlug).length], [0, 0]);

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
