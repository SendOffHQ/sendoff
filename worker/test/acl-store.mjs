// The access list lives in KV, not in the published race config.
//
// The thing to be most careful about is not the exposure, it is locking people
// out of a race on the morning of it. So this covers the migration path, the
// fallback when KV has nothing, and every role still resolving.
//
//   node worker/test/acl-store.mjs
import worker from '../src/worker.js';

const OWNER = 'owner@example.com', CREW = 'crew@example.com', OUT = 'stranger@example.com';
const SLUG = 'r1';
const legacyCfg = {
  name: 'A race', visibility: 'public', createdBy: OWNER,
  people: [{ email: CREW, role: 'crew' }],
  editors: [CREW], viewers: [], course: { segments: [] }
};
let repo, kv;
const KV = { async get(k){return kv.has(k)?kv.get(k):null;}, async put(k,v){kv.set(k,v);},
             async delete(k){kv.delete(k);},
             async list({prefix}){return {keys:[...kv.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name}))};} };
globalThis.caches = { default: { async match(){return undefined;}, async put(){}, async delete(){return true;} } };
async function cred(pw){
  const salt=new Uint8Array(16); crypto.getRandomValues(salt);
  const km=await crypto.subtle.importKey('raw',new TextEncoder().encode(pw),'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:100000,hash:'SHA-256'},km,256);
  const b=a=>Buffer.from(a).toString('base64');
  return { hash:b(new Uint8Array(bits)), salt:b(salt), iterations:100000 };
}
const creds = { [OWNER]: await cred('pw'), [CREW]: await cred('pw'), [OUT]: await cred('pw') };
const env = {
  GITHUB_OWNER:'o', GITHUB_REPO:'r', GITHUB_TOKEN:'t', GITHUB_BRANCH:'main',
  AUTH_KV: KV, ALLOWED_ORIGINS:'*', JWT_SECRET:'s',
  USERS: JSON.stringify(Object.entries(creds).map(([email,c])=>({email,...c}))),
};
function reset(cfg = legacyCfg) {
  repo = new Map([[`races/${SLUG}/config.json`, JSON.stringify(cfg, null, 2)+'\n']]);
  kv = new Map();
}
globalThis.fetch = async (url, opts = {}) => {
  const m = String(url).match(/contents\/(.+?)(\?|$)/);
  const path = m ? decodeURIComponent(m[1]) : '';
  if ((opts.method || 'GET') === 'GET') {
    if (!repo.has(path)) return new Response('{"message":"Not Found"}', { status: 404 });
    return new Response(JSON.stringify({ sha:'sha',
      content: Buffer.from(repo.get(path),'utf8').toString('base64') }), { status: 200 });
  }
  repo.set(path, Buffer.from(JSON.parse(opts.body).content,'base64').toString('utf8'));
  return new Response('{}', { status: 200 });
};
const call = (path, opts={}) => worker.fetch(new Request('https://w'+path, {
  method: opts.method || (opts.body ? 'POST' : 'GET'),
  headers: { 'Content-Type':'application/json', ...(opts.token?{Authorization:'Bearer '+opts.token}:{}) },
  ...(opts.body?{body:JSON.stringify(opts.body)}:{}) }), env);
async function login(e){ const j=await (await call('/login',{body:{email:e,password:'pw'}})).json();
  if(!j.token) throw new Error('login '+e); return j.token; }
const myRole = async (token) => {
  const r = await call('/get?path='+encodeURIComponent(`races/${SLUG}/config.json`), { token });
  const j = await r.json();
  return JSON.parse(Buffer.from(j.content,'base64').toString('utf8')).myRole;
};
const storedCfg = () => JSON.parse(repo.get(`races/${SLUG}/config.json`));

let bad=0;
const ok=(l,g,w)=>{const p=JSON.stringify(g)===JSON.stringify(w); if(!p)bad++;
  console.log(`  ${p?'ok  ':'FAIL'} ${l.padEnd(54)} ${JSON.stringify(g)}${p?'':' expected '+JSON.stringify(w)}`);};

console.log('\na race whose roster is still in the file keeps working');
reset();
ok('the owner is the owner', await myRole(await login(OWNER)), 'owner');
ok('crew is crew',           await myRole(await login(CREW)),  'crew');
ok('a stranger is nobody',   await myRole(await login(OUT)),   null);
ok('and it was copied into KV on the way', kv.has('acl:'+SLUG), true);

console.log('\nonce in KV, the file no longer decides');
kv.set('acl:'+SLUG, JSON.stringify({ createdBy: OWNER, people: [{ email: OUT, role: 'racer' }] }));
ok('the promoted stranger is a racer', await myRole(await login(OUT)),  'racer');
ok('the demoted crew is nobody',       await myRole(await login(CREW)), null);

console.log('\nadding somebody writes KV and not the repo');
reset();
const owner = await login(OWNER);
const before = repo.get(`races/${SLUG}/config.json`);
const add = await call('/access/add', { token: owner, body: { slug: SLUG, email: OUT, role: 'pacer' } });
ok('the call succeeds', add.status, 200);
ok('the file is untouched', repo.get(`races/${SLUG}/config.json`) === before, true);
ok('and they can act', await myRole(await login(OUT)), 'pacer');

console.log('\na config write cannot publish the roster');
reset();
const t = await login(OWNER);
const round = { ...legacyCfg, name: 'Renamed' };
await call('/commit', { token: t, body: {
  path: `races/${SLUG}/config.json`, content: JSON.stringify(round), message: 'rename' } });
const after = storedCfg();
ok('the rename landed', after.name, 'Renamed');
ok('no createdBy in the file', after.createdBy, undefined);
ok('no people in the file',    after.people,    undefined);
ok('no editors in the file',   after.editors,   undefined);
ok('visibility stays',         after.visibility, 'public');
ok('the owner is still the owner', await myRole(await login(OWNER)), 'owner');

console.log('\nnor can the write that creates one');
reset();
const t2 = await login(CREW);
await call('/commit', { token: t2, body: { path: 'races/new1/config.json',
  content: JSON.stringify({ name:'New', visibility:'private', createdBy: CREW,
                            people:[{email:OUT,role:'viewer'}], runners:[] }), message:'create' } });
const madeCfg = JSON.parse(repo.get('races/new1/config.json'));
ok('the new file names nobody', [madeCfg.createdBy, madeCfg.people], [undefined, undefined]);
ok('but the creator owns it', JSON.parse(kv.get('acl:new1')).createdBy, CREW);
ok('and the invitee is on it', JSON.parse(kv.get('acl:new1')).people, [{email:OUT,role:'viewer'}]);

console.log('\nthe runner-to-account link is an address too');
reset({ ...legacyCfg, runners: [{ id:'a', name:'A', email: OWNER }, { id:'b', name:'B' }] });
const t3 = await login(OWNER);
// Read it back the way racer mode does, then save the config the way settings does.
const readBack = await call('/get?path='+encodeURIComponent(`races/${SLUG}/config.json`), { token: t3 });
const seen = JSON.parse(Buffer.from((await readBack.json()).content,'base64').toString('utf8'));
ok('a signed-in reader still sees the link', seen.runners[0].email, OWNER);
await call('/commit', { token: t3, body: { path: `races/${SLUG}/config.json`,
  content: JSON.stringify({ ...legacyCfg, name:'Saved',
    runners:[{ id:'a', name:'A', email: OWNER }, { id:'b', name:'B', email: CREW }] }), message:'save' } });
const onDisk = storedCfg();
ok('no address in the committed file', onDisk.runners.map(r => r.email), [undefined, undefined]);
ok('the runners survive', onDisk.runners.map(r => r.id), ['a','b']);
ok('both links are in KV', JSON.parse(kv.get('acl:'+SLUG)).runnerEmails, { a: OWNER, b: CREW });
const after2 = await call('/get?path='+encodeURIComponent(`races/${SLUG}/config.json`), { token: t3 });
const seen2 = JSON.parse(Buffer.from((await after2.json()).content,'base64').toString('utf8'));
ok('and come back on a read', seen2.runners.map(r => r.email), [OWNER, CREW]);

console.log('\nbut not to somebody with no session');
const anonRes = await call('/get?path='+encodeURIComponent(`races/${SLUG}/config.json`));
const anonCfg = JSON.parse(Buffer.from((await anonRes.json()).content,'base64').toString('utf8'));
ok('an anonymous reader sees no addresses', anonCfg.runners.map(r => r.email), [undefined, undefined]);

console.log('\nwithout KV, nobody is locked out');
reset();
const noKv = { ...env, AUTH_KV: undefined };
const r = await worker.fetch(new Request('https://w/login', { method:'POST',
  headers:{'Content-Type':'application/json'}, body: JSON.stringify({email:OWNER,password:'pw'}) }), noKv);
const tok = (await r.json()).token;
const res = await worker.fetch(new Request('https://w/get?path='+encodeURIComponent(`races/${SLUG}/config.json`),
  { headers:{ Authorization:'Bearer '+tok } }), noKv);
const cfgNoKv = JSON.parse(Buffer.from((await res.json()).content,'base64').toString('utf8'));
ok('the file still answers', cfgNoKv.myRole, 'owner');

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
