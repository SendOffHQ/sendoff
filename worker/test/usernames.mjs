// Usernames: a handle that names a person without being a way in. Unique
// whatever the capitals, kept back for a while once given up, findable only
// by choice, and never turned back into an email address for anybody.
//
//   node worker/test/usernames.mjs
import worker from '../src/worker.js';
import { fakeD1 } from './fake-d1.mjs';

const ME = 'me@example.com', YOU = 'you@example.com', SHY = 'shy@example.com';
const kv = new Map(), ttl = new Map();
const KV = { async get(k){return kv.has(k)?kv.get(k):null;}, async put(k,v,o){kv.set(k,v); if (o&&o.expirationTtl) ttl.set(k,o.expirationTtl);},
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
  USERS: JSON.stringify([{ email: ME, role: 'admin', ...await cred('pw') }, { email: SHY, ...await cred('pw') }]),
};
// An account made by invite, which is the kind that can be deleted.
kv.set('user:' + YOU, JSON.stringify({ email: YOU, role: 'crew', ...await cred('pw') }));
const call = (p, o = {}) => worker.fetch(new Request('https://w' + p, {
  method: o.body ? 'POST' : 'GET',
  headers: { 'Content-Type':'application/json', ...(o.token ? { Authorization: 'Bearer ' + o.token } : {}) },
  ...(o.body ? { body: JSON.stringify(o.body) } : {}) }), env, { waitUntil: () => {} });
const login = async (e) => (await (await call('/login', { body: { email: e, password: 'pw' } })).json()).token;
const setName = async (token, username) => { const r = await call('/username', { token, body: { username } }); return { status: r.status, ...(await r.json()) }; };
const check = async (token, name) => (await call('/username/check?name=' + encodeURIComponent(name), { token })).json();
const search = async (token, q) => (await call('/users/search?q=' + encodeURIComponent(q), { token })).json();

let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p?'ok  ':'FAIL'} ${l.padEnd(60)} ${JSON.stringify(g)}${p?'':' expected '+JSON.stringify(w)}`); };

const me = await login(ME), you = await login(YOU), shy = await login(SHY);
await call('/profile', { token: me, body: { displayName: 'Jason Dupree' } });

console.log('\npicking one');
ok('nobody has one to start', (await (await call('/username', { token: me })).json()), { username: null, findable: true, nextChangeAt: null });
ok('too short', (await check(me, 'jd')).ok, false);
ok('spaces and symbols refused', (await check(me, 'j d!')).reason, 'Use letters, numbers, underscores and full stops only.');
ok('a full stop at the end refused', (await check(me, 'jason.')).ok, false);
ok('names kept back are refused', (await check(me, 'Admin')).reason, 'That username is kept back. Pick another.');
ok('a free one is free', (await check(me, 'Jason')).ok, true);
const set = await setName(me, '@Jason');
ok('saved as typed, without the @', [set.status, set.username], [200, 'Jason']);
ok('and can be changed straight away once, the first pick being free', set.nextChangeAt, null);
ok('taken, whatever the capitals', [(await check(you, 'jason')).ok, (await setName(you, 'JASON')).status], [false, 409]);
ok('fixing the capitals of my own is not a change', [(await setName(me, 'jason')).username, (await setName(me, 'Jason')).nextChangeAt], ['jason', null]);
ok('signed out, no username', (await call('/username')).status, 401);

console.log('\nfinding people');
await setName(you, 'jasmine_r');
await call('/profile', { token: you, body: { displayName: 'Jasmine R' } });
await setName(shy, 'jasper');
await call('/username/findable', { token: shy, body: { findable: false } });
const found = await search(you, 'jas');
ok('by the start of a name, findable people only', found.results.map(r => r.username).sort(), ['Jason', 'jasmine_r']);
ok('with the name on their profile', found.results.find(r => r.username === 'Jason').displayName, 'Jason Dupree');
ok('and never an email address', JSON.stringify(found).includes('@example.com'), false);
ok('the @ is optional', (await search(you, '@jaso')).results.map(r => r.username), ['Jason']);
ok('one letter finds nothing', (await search(you, 'j')).results, []);
ok('signed out, nothing', (await call('/users/search?q=jas')).status, 401);

console.log('\nchanging it');
const ch = await setName(me, 'jd_runs');
ok('a change works', ch.username, 'jd_runs');
ok('and starts the 30 day wait', !!ch.nextChangeAt, true);
const again = await setName(me, 'jd_again');
ok('a second change inside 30 days is refused, saying when', [again.status, again.code], [429, 'too_soon']);
ok('the old name is kept back from everyone else', [(await check(you, 'Jason')).ok, (await setName(you, 'jason')).status], [false, 409]);
ok('for 30 days, then KV lets it go', ttl.get('uname:jason'), 30 * 86400);
ok('and it no longer finds me', (await search(you, 'jason')).results, []);

console.log('\nadding somebody to a race by username');
await call('/commit', { token: me, body: { path: 'races/mine/config.json', message: 't',
  content: JSON.stringify({ name: 'Mine', visibility: 'public', createdBy: ME, runners: [] }) } });
const add = await call('/access/add', { token: me, body: { slug: 'mine', username: '@jasmine_r', role: 'crew' } });
ok('a findable username is added', add.status, 200);
const roster = await (await call('/access?slug=mine', { token: me })).json();
ok('and the roster shows their username', roster.people.find(p => p.email === YOU).username, 'jasmine_r');
const hidden = await (await call('/access/add', { token: me, body: { slug: 'mine', username: 'jasper', role: 'viewer' } })).json();
ok('somebody who turned finding off cannot be added that way', hidden.code, 'no_username');
ok('nor a name nobody has', (await call('/access/add', { token: me, body: { slug: 'mine', username: 'nobody_here', role: 'viewer' } })).status, 404);
for (let i = 0; i < 25; i++) await call('/access/add', { token: me, body: { slug: 'mine', username: 'nobody_' + i, role: 'viewer' } });
ok('and adds by username are capped per day', (await call('/access/add', { token: me, body: { slug: 'mine', username: 'jasmine_r', role: 'viewer' } })).status, 429);

console.log('\nwhen an account is deleted');
await call('/account/delete', { token: me, body: { email: YOU } });
ok('its username goes, and is kept back', [kv.has('handle:' + YOU), JSON.parse(kv.get('uname:jasmine_r')).held], [false, true]);
ok('so nobody else can take it yet', (await setName(shy, 'jasmine_r')).status, 409);

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
