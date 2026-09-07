// The config handed to a caller gains their own role, and that field never
// survives a write back.
//
//   node worker/test/my-role.mjs
import worker from '../src/worker.js';

const OWNER = 'owner@example.com', CREW = 'crew@example.com', OUT = 'stranger@example.com';
const SLUG = 'r1';
const baseCfg = {
  name: 'A race', visibility: 'public', createdBy: OWNER,
  people: [{ email: CREW, role: 'crew' }], course: { segments: [] }
};
const repo = new Map([[`races/${SLUG}/config.json`, JSON.stringify(baseCfg, null, 2) + '\n']]);
const kv = new Map();
const KV = { async get(k){return kv.has(k)?kv.get(k):null;}, async put(k,v){kv.set(k,v);},
             async delete(k){kv.delete(k);}, async list({prefix}){return {keys:[...kv.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name}))};} };
globalThis.caches = { default: { async match(){return undefined;}, async put(){}, async delete(){return true;} } };
async function cred(pw){
  const salt=new Uint8Array(16); crypto.getRandomValues(salt);
  const km=await crypto.subtle.importKey('raw',new TextEncoder().encode(pw),'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:100000,hash:'SHA-256'},km,256);
  const b=a=>Buffer.from(a).toString('base64');
  return { hash:b(new Uint8Array(bits)), salt:b(salt), iterations:100000 };
}
const env = {
  GITHUB_OWNER:'o', GITHUB_REPO:'r', GITHUB_TOKEN:'t', GITHUB_BRANCH:'main',
  AUTH_KV: KV, ALLOWED_ORIGINS:'*', JWT_SECRET:'s',
  USERS: JSON.stringify([{ email:OWNER, ...await cred('pw') }, { email:CREW, ...await cred('pw') }, { email:OUT, ...await cred('pw') }]),
};
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
  method: opts.body ? 'POST' : 'GET',
  headers: { 'Content-Type':'application/json', ...(opts.token?{Authorization:'Bearer '+opts.token}:{}) },
  ...(opts.body?{body:JSON.stringify(opts.body)}:{}) }), env);
async function login(e){ const j = await (await call('/login',{body:{email:e,password:'pw'}})).json();
  if(!j.token) throw new Error('login '+e); return j.token; }
async function readCfg(token){
  const r = await call('/get?path='+encodeURIComponent(`races/${SLUG}/config.json`), { token });
  const j = await r.json();
  return JSON.parse(Buffer.from(j.content,'base64').toString('utf8'));
}
let bad = 0;
const ok = (label, got, want) => { const p = String(got)===String(want); if(!p) bad++;
  console.log(`  ${p?'ok  ':'FAIL'} ${label.padEnd(50)} ${got}${p?'':` (expected ${want})`}`); };

console.log('\nthe config tells you your own role');
ok('the creator is owner',      (await readCfg(await login(OWNER))).myRole, 'owner');
ok('a crew member is crew',     (await readCfg(await login(CREW))).myRole,  'crew');
ok('somebody else has none',    (await readCfg(await login(OUT))).myRole,   'null');
const anon = await (await call('/get?path='+encodeURIComponent(`races/${SLUG}/config.json`))).json();
ok('anonymous has none', JSON.parse(Buffer.from(anon.content,'base64').toString('utf8')).myRole, 'null');

console.log('\nand it never gets written back');
const t = await login(OWNER);
const round = await readCfg(t);
round.name = 'Renamed';                       // a client round-tripping the config
await call('/commit', { token: t, body: {
  path: `races/${SLUG}/config.json`, content: JSON.stringify(round, null, 2)+'\n', message: 'rename' } });
const stored = JSON.parse(repo.get(`races/${SLUG}/config.json`));
ok('the rename landed', stored.name, 'Renamed');
ok('myRole is not in the stored file', stored.myRole, undefined);
// The roster no longer lives in the file at all; acl-store.mjs covers where it
// went. What matters here is that a write does not put it back.
ok('the roster is not in the file', stored.people, undefined);

console.log('\nnor on the write that creates a race');
const t2 = await login(CREW);
await call('/commit', { token: t2, body: { path: 'races/r2/config.json',
  content: JSON.stringify({ name:'New', visibility:'public', createdBy: CREW, myRole:'owner', runners:[] }), message:'create' } });
ok('myRole is not in a new race', JSON.parse(repo.get('races/r2/config.json')).myRole, undefined);

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
