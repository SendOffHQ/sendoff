// A settings save and the access list.
//
// Saving a race's settings stores two things on its access list: which
// account each runner is, and which crew look after which runner. It used to
// store them by writing the whole list back from the copy it read when the
// request began. So a person taken off the race while somebody else's save
// was under way was put straight back on, with the role they had, and nobody
// was told. A save now changes those two things on the list as it stands at
// the moment of writing, and nothing else on it.
//
//   node worker/test/settings-save-acl.mjs
import worker from '../src/worker.js';
import { fakeD1 } from './fake-d1.mjs';

const OWNER = 'owner@example.com', CREW = 'crew@example.com', GONE = 'gone@example.com';
const kv = new Map();
const KV = { async get(k){return kv.has(k)?kv.get(k):null;}, async put(k,v){kv.set(k,v);},
             async delete(k){kv.delete(k);},
             async list({prefix}){return {keys:[...kv.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name})), list_complete: true};} };
globalThis.caches = { default: { async match(){return undefined;}, async put(){}, async delete(){return true;} } };
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).includes('/git/trees/')) return new Response(JSON.stringify({ tree: [] }), { status: 200 });
  if ((opts.method || 'GET') === 'GET') return new Response('{"message":"Not Found"}', { status: 404 });
  return new Response(JSON.stringify({ content: { sha: 'x' } }), { status: 200 });
};

// The database, with a way to have something else happen in the middle of a
// write: after the worker has read the race and decided the save is allowed,
// and before it stores anything. That is where another person's request lands
// when two people are working a race at once.
const DB = fakeD1();
let meanwhile = null;
const prepare = DB.prepare;
DB.prepare = (sql) => {
  const st = prepare(sql);
  if (!/^SELECT slug FROM races WHERE slug = \?$/.test(sql.trim())) return st;
  return { ...st, bind: (...a) => {
    const bound = st.bind(...a);
    return { ...bound, async all() {
      if (meanwhile) { const f = meanwhile; meanwhile = null; await f(); }
      return bound.all();
    } };
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
  USERS: JSON.stringify([{ email: OWNER, ...await cred('pw') }, { email: CREW, ...await cred('pw') },
    { email: GONE, ...await cred('pw') }]),
};
const call = (p, o = {}) => worker.fetch(new Request('https://w' + p, {
  method: o.body ? 'POST' : 'GET',
  headers: { 'Content-Type':'application/json', ...(o.token ? { Authorization: 'Bearer ' + o.token } : {}) },
  ...(o.body ? { body: JSON.stringify(o.body) } : {}) }), env, { waitUntil: () => {} });
const login = async (e) => (await (await call('/login', { body: { email: e, password: 'pw' } })).json()).token;
const acl = () => JSON.parse(kv.get('acl:r1'));
const people = () => acl().people.map(p => `${p.email}:${p.role}`).sort();
// A save the way the settings page makes one: read the config, change it,
// write it back with the version it was read at.
const save = async (token, change) => {
  const r = await (await call('/get?path=' + encodeURIComponent('races/r1/config.json'), { token })).json();
  const doc = JSON.parse(Buffer.from(r.content, 'base64').toString('utf8'));
  return call('/commit', { token, body: { path: 'races/r1/config.json', message: 'settings', sha: r.sha,
    content: JSON.stringify(change(doc)) } });
};

let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p?'ok  ':'FAIL'} ${l.padEnd(62)} ${JSON.stringify(g)}${p?'':' expected '+JSON.stringify(w)}`); };

const owner = await login(OWNER), crew = await login(CREW);
await call('/commit', { token: owner, body: { path: 'races/r1/config.json', message: 'make',
  content: JSON.stringify({ name: 'R1', visibility: 'private', createdBy: OWNER,
    runners: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] }) } });
await call('/access/add', { token: owner, body: { slug: 'r1', email: CREW, role: 'crew' } });
await call('/access/add', { token: owner, body: { slug: 'r1', email: GONE, role: 'crew' } });
ok('two crew on the race', people(), [`${CREW}:crew`, `${GONE}:crew`]);

console.log('\nsomebody is taken off while another person\'s settings save is under way');
meanwhile = async () => {
  await call('/access/remove', { token: owner, body: { slug: 'r1', email: GONE } });
  await call('/access/team-invite', { token: owner, body: { slug: 'r1', allowed: true } });
};
const res = await save(crew, (doc) => { doc.units = 'km'; doc.runners[0].email = CREW; return doc; });
ok('the save goes through', [res.status, meanwhile], [200, null]);
ok('and does not put them back', people(), [`${CREW}:crew`]);
ok('nor undo the owner letting the team invite', acl().teamCanInvite, true);
ok('nor change who made the race', acl().createdBy, OWNER);
ok('what the save was for is stored', acl().runnerEmails, { a: CREW });
ok('and the person taken off cannot read the race', (await call('/get?path=' + encodeURIComponent('races/r1/config.json'), { token: await login(GONE) })).status, 403);

console.log('\nwhat a settings save may change, it still changes');
await save(crew, (doc) => { doc.runners[1].crew = [CREW]; return doc; });
ok('crew assigned to a runner', acl().runnerCrew, { b: [CREW] });
await save(crew, (doc) => { doc.runners.forEach(r => { delete r.crew; }); return doc; });
ok('a page that sends no crew list leaves them as they are', acl().runnerCrew, { b: [CREW] });
await save(crew, (doc) => { doc.runners[1].crew = []; doc.runners[0].email = ''; return doc; });
ok('an empty list clears them, and a link can be taken off', [acl().runnerCrew, acl().runnerEmails], [{}, {}]);

console.log('\nand what it may not, it still cannot');
await save(crew, (doc) => ({ ...doc, createdBy: CREW, teamCanInvite: false,
  people: [{ email: GONE, role: 'crew' }], editors: [GONE] }));
ok('the roster, the owner and the invite switch are not a save\'s to write',
  [people(), acl().createdBy, acl().teamCanInvite], [[`${CREW}:crew`], OWNER, true]);

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
