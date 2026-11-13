// Being put on a race is not the same as joining it.
//
// Anybody who owns a race can type anybody's address onto it, as crew or as
// the account behind a runner. That used to be all it took to read the
// person's profile (name, fuel goals, notes) and their username through the
// race, and to put the race on their public profile. Now a race is told about
// a person, and a person's public profile about a race, only once the person
// has joined by their own doing: made the race, accepted an invite to it, or
// opened it while signed in.
//
//   node worker/test/joined.mjs
import worker from '../src/worker.js';
import { fakeD1 } from './fake-d1.mjs';

const OWNER = 'owner@example.com', VICTIM = 'victim@example.com', PAL = 'pal@example.com',
      ADMIN = 'admin@example.com', NEW = 'new@example.com';
const kv = new Map();
let aclWrites = 0;
const KV = { async get(k){return kv.has(k)?kv.get(k):null;},
             async put(k,v){ if (k.startsWith('acl:')) aclWrites++; kv.set(k,v); },
             async delete(k){kv.delete(k);},
             async list({prefix,limit}){return {keys:[...kv.keys()].filter(k=>k.startsWith(prefix)).sort().slice(0,limit||1000).map(name=>({name})), list_complete: true};} };
globalThis.caches = { default: { async match(){return undefined;}, async put(){}, async delete(){return true;} } };
// Everything sent to the repository, which is the public site.
const published = [];
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).includes('/git/trees/')) return new Response(JSON.stringify({ tree: [] }), { status: 200 });
  if ((opts.method || 'GET') === 'GET') return new Response('{"message":"Not Found"}', { status: 404 });
  if (opts.body) published.push(Buffer.from(JSON.parse(opts.body).content || '', 'base64').toString('utf8'));
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
  AUTH_KV: KV, ALLOWED_ORIGINS:'*', JWT_SECRET:'s', PUBLIC_BASE_URL: 'https://sendoff.run',
  USERS: JSON.stringify([{ email: OWNER, ...await cred('pw') }, { email: VICTIM, ...await cred('pw') },
    { email: PAL, ...await cred('pal-password') }, { email: ADMIN, role: 'admin', ...await cred('pw') }]),
};
const call = (p, o = {}) => worker.fetch(new Request('https://w' + p, {
  method: o.body ? 'POST' : 'GET',
  headers: { 'Content-Type':'application/json', ...(o.token ? { Authorization: 'Bearer ' + o.token } : {}) },
  ...(o.body ? { body: JSON.stringify(o.body) } : {}) }), env, { waitUntil: () => {} });
const login = async (e, password = 'pw') => (await (await call('/login', { body: { email: e, password } })).json()).token;
const version = (slug, file) => { const r = env.DB.races.get(slug); return r ? r[file + '_sha'] : undefined; };
const put = (token, slug, file, doc) => call('/commit', { token, body: {
  path: `races/${slug}/${file}.json`, content: JSON.stringify(doc), message: 'test', sha: version(slug, file) || undefined } });
const open = (token, slug) => call('/get?path=' + encodeURIComponent(`races/${slug}/config.json`), { token });
const roster = async (slug, token) => (await (await call('/access?slug=' + slug, { token })).json());
const entry = async (slug, email) => (await roster(slug, owner)).people.find(p => p.email === email);
const profileOf = async (email, slug, token) => {
  const r = await call('/profile?email=' + encodeURIComponent(email) + '&slug=' + slug, { token });
  return { status: r.status, body: await r.text() };
};
const stored = (slug) => JSON.parse(kv.get('acl:' + slug));

let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p?'ok  ':'FAIL'} ${l.padEnd(62)} ${JSON.stringify(g)}${p?'':' expected '+JSON.stringify(w)}`); };

const owner = await login(OWNER), victim = await login(VICTIM), pal = await login(PAL, 'pal-password'), admin = await login(ADMIN);
await call('/profile', { token: owner, body: { displayName: 'Olive Owner' } });
await call('/profile', { token: victim, body: { firstName: 'Vera', lastName: 'Victim', notes: 'stomach turns at mile 60',
  targets: { caloriesPerHour: 250 } } });
await call('/username', { token: victim, body: { username: 'vera_runs' } });
await call('/profile', { token: pal, body: { displayName: 'Pat Pal' } });
await call('/username', { token: pal, body: { username: 'patpal' } });

const course = { courseType: 'segments', course: { segments: [{ name: 'A to B', distanceMi: 10 }] } };
await put(owner, 'trap', 'config', { name: 'Trap', visibility: 'private', createdBy: OWNER, ...course, runners: [{ id: 'r', name: 'R' }] });

console.log('\ntyping somebody onto a race you own');
const added = await call('/access/add', { token: owner, body: { slug: 'trap', email: VICTIM, role: 'crew' } });
ok('puts them on it', [added.status, (await added.json()).people.map(p => p.email)], [200, [VICTIM]]);
ok('and the roster has their address and nothing else about them', await entry('trap', VICTIM),
  { email: VICTIM, role: 'crew', displayName: '', username: null });
const notOn = await profileOf('nobody@example.com', 'trap', owner);
const typedOn = await profileOf(VICTIM, 'trap', owner);
ok('their profile reads exactly as for somebody not on the race', [typedOn.status, typedOn.body], [notOn.status, notOn.body]);
ok('which is not found', typedOn.status, 404);
const whole = JSON.stringify(await roster('trap', owner));
ok('nothing of theirs is anywhere in the roster', ['Vera', 'vera_runs', 'mile 60'].some(w => whole.includes(w)), false);
ok('the person who made the race is named, having made it', (await roster('trap', owner)).createdByName, 'Olive Owner');

console.log('\nlooking is not joining');
aclWrites = 0;
await open(admin, 'trap');
await open(pal, 'trap');
ok('an admin passing through, or somebody not on it, writes nothing', aclWrites, 0);
ok('and changes nothing', (await entry('trap', VICTIM)).displayName, '');

console.log('\nthey open the race themselves');
aclWrites = 0;
ok('the read works', (await open(victim, 'trap')).status, 200);
ok('and is written down once', [aclWrites, stored('trap').joined], [1, [VICTIM]]);
for (let i = 0; i < 5; i++) await open(victim, 'trap');
await call('/get?path=' + encodeURIComponent('races/trap/data.json'), { token: victim });
ok('and never again, however often they read it', aclWrites, 1);
ok('now the roster names them', await entry('trap', VICTIM),
  { email: VICTIM, role: 'crew', displayName: 'Vera Victim', username: 'vera_runs' });
const joinedProfile = await profileOf(VICTIM, 'trap', owner);
ok('and a teammate may read their profile', [joinedProfile.status, JSON.parse(joinedProfile.body).profile.notes], [200, 'stomach turns at mile 60']);

console.log('\na username its owner has asked not to be found by');
await call('/username/findable', { token: victim, body: { findable: false } });
ok('is not on the roster, joined or not', await entry('trap', VICTIM),
  { email: VICTIM, role: 'crew', displayName: 'Vera Victim', username: null });
await call('/username/findable', { token: victim, body: { findable: true } });

console.log('\ntaken off and put back on');
await call('/access/remove', { token: owner, body: { slug: 'trap', email: VICTIM } });
ok('being taken off forgets that they joined', stored('trap').joined, []);
await call('/access/add', { token: owner, body: { slug: 'trap', email: VICTIM, role: 'viewer' } });
ok('so putting them back does not bring their name with it', await entry('trap', VICTIM),
  { email: VICTIM, role: 'viewer', displayName: '', username: null });
ok('nor their profile', (await profileOf(VICTIM, 'trap', owner)).status, 404);
await open(victim, 'trap');
await call('/access/add', { token: owner, body: { slug: 'trap', email: VICTIM, role: 'crew' } });
ok('a change of role, once joined, keeps them joined', (await entry('trap', VICTIM)).displayName, 'Vera Victim');

console.log('\naccepting an invite is joining');
const inv = await (await call('/invite', { token: owner, body: { slug: 'trap', email: PAL, role: 'pacer' } })).json();
ok('an invite alone tells the race nothing', (await roster('trap', owner)).people.some(p => p.email === PAL), false);
const acc = await call('/accept-invite', { body: { token: inv.token, password: 'pal-password' } });
ok('accepted', acc.status, 200);
ok('they are on the roster by name at once', await entry('trap', PAL),
  { email: PAL, role: 'pacer', displayName: 'Pat Pal', username: 'patpal' });
const inv2 = await (await call('/invite', { token: owner, body: { slug: 'trap', email: NEW, role: 'viewer' } })).json();
await call('/accept-invite', { body: { token: inv2.token, password: 'a-new-password' } });
ok('and so is somebody whose account the invite made', stored('trap').joined.includes(NEW), true);

console.log('\na race from before any of this');
await put(owner, 'old', 'config', { name: 'Old', visibility: 'private', createdBy: OWNER, ...course, runners: [] });
kv.set('acl:old', JSON.stringify({ createdBy: OWNER, people: [{ email: VICTIM, role: 'crew' }], teamCanInvite: false,
  runnerEmails: {}, runnerCrew: {} }));
ok('still opens for its owner and its crew', [(await open(owner, 'old')).status, (await roster('old', owner)).createdByName], [200, 'Olive Owner']);
ok('its crew are not named until they next open it', (await entry('old', VICTIM)).displayName, '');
ok('and they can still open it', (await open(victim, 'old')).status, 200);
ok('which is them joining', (await entry('old', VICTIM)).displayName, 'Vera Victim');

console.log('\nwho has joined is not a thing a file can say');
const doc = JSON.parse(Buffer.from((await (await open(pal, 'trap')).json()).content, 'base64').toString('utf8'));
await put(pal, 'trap', 'config', { ...doc, joined: ['stranger@example.com'], people: [{ email: 'stranger@example.com', role: 'crew' }] });
ok('a save that claims it is not believed', [stored('trap').joined.includes('stranger@example.com'), stored('trap').people.some(p => p.email === 'stranger@example.com')], [false, false]);
ok('and does not undo anybody who has', stored('trap').joined.sort(), [NEW, PAL, VICTIM].sort());
ok('nor is it stored in the race file', /joined/.test(env.DB.races.get('trap').config), false);

// ---------- the public profile ----------
console.log('\na race attached to somebody else\'s public profile');
await call('/public-profile-settings', { token: victim, body: { public: true } });
const pub = async () => JSON.parse(await (await call('/public-profile?u=vera_runs')).text());
const legs = [{ index: 1, startTime: '2026-09-26T10:00:00Z', endTime: '2026-09-26T12:00:00Z' }];
await put(owner, 'planted', 'config', { name: 'Vera Is A Fraud 50', visibility: 'public', createdBy: OWNER, ...course,
  runners: [{ id: 'v', name: 'Vera', email: VICTIM }] });
await put(owner, 'planted', 'data', { runners: [{ id: 'v', legs }] });
ok('is not on it: the link was somebody else\'s doing', (await pub()).races.map(r => r.slug), []);
const mine = await (await call('/my-results', { token: victim })).json();
ok('their own results page still lists it, so they can see it', mine.races.map(r => r.slug), ['planted']);
aclWrites = 0;
await open(pal, 'planted');
ok('a stranger reading the public race changes nothing', [aclWrites, (await pub()).races.length], [0, 0]);
await open(victim, 'planted');
ok('once they have opened it themselves, it is theirs to show', (await pub()).races.map(r => r.slug), ['planted']);
await put(victim, 'own', 'config', { name: 'My Own Race', visibility: 'public', createdBy: VICTIM, ...course,
  runners: [{ id: 'v', name: 'Vera', email: VICTIM }] });
ok('and a race they made needs no opening', (await pub()).races.map(r => r.slug).sort(), ['own', 'planted']);

console.log('\nand none of it is published');
const everywhere = published.join('\n') + [...env.DB.races.values()].map(r => r.config + r.data).join('\n');
ok('no file carries who joined, or an address', [/"joined"/.test(everywhere), /@example\.com/.test(everywhere)], [false, false]);

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
