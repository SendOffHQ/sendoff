// Deleting a race takes its AI crew links and its push registrations with it.
//
// Both are kept in KV under a key of their own and name the race only by its
// slug. Deleting a race removed its share links and invites and left these,
// so a race made later under the same slug inherited them: an assistant
// holding the old link could write the new race's splits, and the old crew's
// phones were nudged about a race they had never heard of.
//
//   node worker/test/race-delete-cleanup.mjs
import worker from '../src/worker.js';
import { fakeD1 } from './fake-d1.mjs';

const OWNER = 'owner@example.com', NEXT = 'next@example.com';
const kv = new Map();
const KV = { async get(k){return kv.has(k)?kv.get(k):null;}, async put(k,v){kv.set(k,v);},
             async delete(k){kv.delete(k);},
             async list({prefix}){return {keys:[...kv.keys()].filter(k=>k.startsWith(prefix)).sort().map(name=>({name})), list_complete: true};} };
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
  USERS: JSON.stringify([{ email: OWNER, ...await cred('pw') }, { email: NEXT, ...await cred('pw') }]),
};
const call = (p, o = {}) => worker.fetch(new Request('https://w' + p, {
  method: o.body ? 'POST' : 'GET',
  headers: { 'Content-Type':'application/json', ...(o.token ? { Authorization: 'Bearer ' + o.token } : {}) },
  ...(o.body ? { body: JSON.stringify(o.body) } : {}) }), env, { waitUntil: () => {} });
const login = async (e) => (await (await call('/login', { body: { email: e, password: 'pw' } })).json()).token;
const make = (token, slug, by) => call('/commit', { token, body: { path: `races/${slug}/config.json`, message: 't',
  content: JSON.stringify({ name: slug, visibility: 'private', createdBy: by, courseType: 'segments',
    course: { segments: [{ fromAid: 'Start', toAid: 'Finish', distanceMi: 10 }] },
    startTime: '2026-10-03T12:00:00Z', runners: [{ id: 'pat', name: 'Pat' }] }) } });
const keys = (prefix) => [...kv.keys()].filter(k => k.startsWith(prefix));
const slugsOf = (prefix) => keys(prefix).map(k => JSON.parse(kv.get(k)).slug).sort();
// What an assistant sends: any call at all, on the link it was given.
const ask = (token) => call('/mcp/' + token, { body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'race_status', arguments: {} } } });

let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p?'ok  ':'FAIL'} ${l.padEnd(62)} ${JSON.stringify(g)}${p?'':' expected '+JSON.stringify(w)}`); };

const owner = await login(OWNER), next = await login(NEXT);
await make(owner, 'gone', OWNER);
await make(owner, 'stays', OWNER);
const link = await (await call('/ai-crew', { token: owner, body: { slug: 'gone', runnerId: 'pat' } })).json();
await call('/ai-crew', { token: owner, body: { slug: 'stays', runnerId: 'pat' } });
for (const [slug, phone] of [['gone', 'a'], ['gone', 'b'], ['stays', 'c']]) {
  await call('/push/subscribe', { token: owner, body: { slug, runnerId: 'pat', endpoint: 'https://fcm.googleapis.com/fcm/send/' + phone, legs: 1, stations: ['Finish'] } });
}
ok('two races, each with an AI crew link', slugsOf('aicrew:'), ['gone', 'stays']);
ok('and phones registered for their nudges', [slugsOf('push:sub:'), JSON.parse(kv.get('push:index')).length], [['gone', 'gone', 'stays'], 3]);
ok('the link works while the race exists', (await ask(link.token)).status, 200);

console.log('\none of them is deleted');
ok('deleted', (await call('/race/delete', { token: owner, body: { slug: 'gone' } })).status, 200);
ok('its AI crew link is gone, and the other race\'s is not', slugsOf('aicrew:'), ['stays']);
ok('its push registrations are gone, and the other race\'s are not', slugsOf('push:sub:'), ['stays']);
ok('and so are their places in the list the nudges walk', JSON.parse(kv.get('push:index')).map(e => e.id || e), keys('push:sub:').map(k => k.slice('push:sub:'.length)));

console.log('\nsomebody else makes a race under the same slug');
ok('made', [(await make(next, 'gone', NEXT)).status, JSON.parse(kv.get('acl:gone')).createdBy], [200, NEXT]);
ok('the old link does not open it', (await ask(link.token)).status, 404);
ok('and nobody is registered for its nudges', slugsOf('push:sub:'), ['stays']);

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
