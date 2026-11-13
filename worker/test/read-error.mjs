// A race that could not be read is not a race that does not exist.
//
// The two used to come back from the database lookup as the same null. A race
// made since writes moved to D1 has nothing in git to fall back on, so one
// failed read said "no such race", and "no such race" is what opens the path
// that creates one: the caller's config.json was taken as a new race over the
// top of the real one, and the caller written in as its owner. Now a read that
// failed is answered 503, which the pages already hold and retry, and nothing
// is created.
//
//   node worker/test/read-error.mjs
import worker from '../src/worker.js';
import { fakeD1 } from './fake-d1.mjs';

const OWNER = 'owner@example.com', THIEF = 'thief@example.com', ADMIN = 'admin@example.com';
const kv = new Map();
let kvDown = null;   // a key prefix whose reads fail
const KV = { async get(k){ if (kvDown && k.startsWith(kvDown)) throw new Error('KV is out of reach'); return kv.has(k)?kv.get(k):null; },
             async put(k,v){kv.set(k,v);}, async delete(k){kv.delete(k);},
             async list({prefix}){return {keys:[...kv.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name})), list_complete: true};} };
globalThis.caches = { default: { async match(){return undefined;}, async put(){}, async delete(){return true;} } };
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).includes('/git/trees/')) return new Response(JSON.stringify({ tree: [] }), { status: 200 });
  if ((opts.method || 'GET') === 'GET') return new Response('{"message":"Not Found"}', { status: 404 });
  return new Response(JSON.stringify({ content: { sha: 'x' } }), { status: 200 });
};

// The database, with a switch that makes reading a race's config fail the way
// a D1 hiccup does, and a count of what is asked of it.
const DB = fakeD1();
let dbDown = false, asked = 0;
const prepare = DB.prepare;
DB.prepare = (sql) => {
  asked++;
  const st = prepare(sql);
  if (!/^SELECT config, config_sha FROM races WHERE slug = \?$/.test(sql.trim())) return st;
  return { ...st, bind: (...a) => {
    const bound = st.bind(...a);
    return { ...bound, async all() { if (dbDown) throw new Error('D1_ERROR: network connection lost'); return bound.all(); } };
  } };
};

async function cred(pw){
  const salt=new Uint8Array(16); crypto.getRandomValues(salt);
  const km=await crypto.subtle.importKey('raw',new TextEncoder().encode(pw),'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:100000,hash:'SHA-256'},km,256);
  const b=a=>Buffer.from(a).toString('base64');
  return { hash:b(new Uint8Array(bits)), salt:b(salt), iterations:100000 };
}
const env = {
  DB, GITHUB_OWNER:'o', GITHUB_REPO:'r', GITHUB_TOKEN:'t', GITHUB_BRANCH:'main',
  AUTH_KV: KV, ALLOWED_ORIGINS:'*', JWT_SECRET:'s',
  USERS: JSON.stringify([{ email: OWNER, ...await cred('pw') }, { email: THIEF, ...await cred('pw') },
    { email: ADMIN, role: 'admin', ...await cred('pw') }]),
};
const call = async (p, o = {}) => {
  const r = await worker.fetch(new Request('https://w' + p, {
    method: o.body ? 'POST' : 'GET',
    headers: { 'Content-Type':'application/json', ...(o.token ? { Authorization: 'Bearer ' + o.token } : {}) },
    ...(o.body ? { body: JSON.stringify(o.body) } : {}) }), env, { waitUntil: () => {} });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, ...(j || {}) };
};
const login = async (e) => (await call('/login', { body: { email: e, password: 'pw' } })).token;
const commit = (token, path, doc, sha) => call('/commit', { token, body: { path, content: JSON.stringify(doc), message: 't', ...(sha ? { sha } : {}) } });
const acl = (slug) => JSON.parse(kv.get('acl:' + slug) || 'null');
const row = (slug) => DB.races.get(slug);

let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p?'ok  ':'FAIL'} ${l.padEnd(62)} ${JSON.stringify(g)}${p?'':' expected '+JSON.stringify(w)}`); };

const owner = await login(OWNER), thief = await login(THIEF), admin = await login(ADMIN);
await commit(owner, 'races/real/config.json', { name: 'Real Race', visibility: 'public', createdBy: OWNER, runners: [{ id: 'a', name: 'A' }] });
await commit(owner, 'races/real/data.json', { runners: [{ id: 'a', legs: [] }] });
ok('a race, and whose it is', [row('real').name, acl('real').createdBy], ['Real Race', OWNER]);

console.log('\nthe database cannot be read, and somebody sends a config for the race');
// The version token is on every public read of the race, so a stranger has it.
const sha = (await call('/public?path=' + encodeURIComponent('races/real/config.json'))).sha;
dbDown = true;
const steal = await commit(thief, 'races/real/config.json', { name: 'Mine Now', visibility: 'public', createdBy: THIEF, runners: [] }, sha);
ok('it is not taken as a new race', [steal.status, steal.retryable], [503, true]);
ok('the race is still its owner\'s', acl('real').createdBy, OWNER);
ok('and still says what it said', row('real').name, 'Real Race');
ok('a split sent then is held too, not told the race is missing', (await commit(thief, 'races/real/data.json', { runners: [] })).status, 503);
ok('the owner\'s own save waits the same way', (await commit(owner, 'races/real/config.json', { name: 'Real Race', runners: [] }, sha)).status, 503);

console.log('\nand nothing else mistakes it for a race that has gone');
kv.set('held:real', JSON.stringify({ slug: 'real', name: 'Real Race', words: ['x'] }));
const approve = await call('/held/approve', { token: admin, body: { slug: 'real' } });
ok('a hold is not cleared as belonging to no race', [approve.status, kv.has('held:real')], [503, true]);
ok('the roster says it cannot be read, not that there is no race', (await call('/access?slug=real', { token: owner })).status, 503);
ok('deleting it waits', [(await call('/race/delete', { token: owner, body: { slug: 'real' } })).status, !!row('real')], [503, true]);
kv.delete('held:real');
dbDown = false;

console.log('\nonce it can be read again');
ok('the stranger is refused as a stranger', (await commit(thief, 'races/real/config.json', { name: 'Mine Now', createdBy: THIEF, runners: [] }, sha)).status, 403);
ok('and the owner\'s save lands', (await commit(owner, 'races/real/config.json', { name: 'Real Race Again', visibility: 'public', runners: [] }, sha)).status, 200);

console.log('\na race that really is not there');
asked = 0;
const miss = await call('/get?path=' + encodeURIComponent('races/nope/config.json'), { token: owner });
ok('reads as not found, as it always did', miss.status, 404);
ok('for one question to the database', asked, 1);
ok('and to a signed-out reader too', (await call('/public?path=' + encodeURIComponent('races/nope/config.json'))).status, 404);
ok('a split for it is refused as a missing race', (await commit(owner, 'races/nope/data.json', { runners: [] })).status, 404);
ok('and its config makes it', [(await commit(thief, 'races/nope/config.json', { name: 'Nope', visibility: 'public', createdBy: THIEF, runners: [] })).status, acl('nope').createdBy], [200, THIEF]);

console.log('\nthe note a new race leaves for its own next write');
kv.delete('acl:fresh');
kvDown = 'created:';
ok('unreadable is held and retried, not answered "Race not found"', (await commit(owner, 'races/fresh/data.json', { runners: [] })).status, 503);
kvDown = null;
ok('and readable and absent is still not found', (await commit(owner, 'races/fresh/data.json', { runners: [] })).status, 404);

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
