// No commit message leaves this worker with an email address in it.
//
// The repository is public, so a commit message is published. This used to
// carry the address of whoever pressed the button, on every press, which meant
// a crew's addresses ended up in the public history of a repository that had
// just had those same addresses carefully removed from its files.
//
// The check is at the chokepoint rather than at each call site, and this test
// exercises it through the real endpoints for that reason: a caller composing a
// message with an address in it must not be able to publish one.
import worker from '../src/worker.js';

const ME = 'crew@example.com', SLUG = 'r1';
const repo = new Map();
const messages = [];
const kv = new Map();
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
const env = {
  GITHUB_OWNER:'o', GITHUB_REPO:'r', GITHUB_TOKEN:'t', GITHUB_BRANCH:'main',
  AUTH_KV: KV, ALLOWED_ORIGINS:'*', JWT_SECRET:'s',
  USERS: JSON.stringify([{ email: ME, ...await cred('pw') }]),
};

// Every message that would reach GitHub is captured here.
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const m = u.match(/contents\/(.+?)(\?|$)/);
  const path = m ? decodeURIComponent(m[1]) : '';
  const method = opts.method || 'GET';
  if (u.includes('/git/trees/')) {
    return new Response(JSON.stringify({ tree: [...repo.keys()]
      .filter(k => /^races\/[^/]+\/config\.json$/.test(k)).map(path => ({ type:'blob', path })) }), { status: 200 });
  }
  if (method === 'GET') {
    if (!repo.has(path)) return new Response('{"message":"Not Found"}', { status: 404 });
    return new Response(JSON.stringify({ sha:'sha',
      content: Buffer.from(repo.get(path),'utf8').toString('base64') }), { status: 200 });
  }
  const body = JSON.parse(opts.body || '{}');
  if (body.message) messages.push(body.message);
  if (method === 'PUT') repo.set(path, Buffer.from(body.content,'base64').toString('utf8'));
  if (method === 'DELETE') repo.delete(path);
  return new Response(JSON.stringify({ content: { sha: 'newsha' } }), { status: 200 });
};

const call = (p, o={}) => worker.fetch(new Request('https://w'+p, {
  method: o.method || (o.body ? 'POST' : 'GET'),
  headers: { 'Content-Type':'application/json', ...(o.token?{Authorization:'Bearer '+o.token}:{}) },
  ...(o.body?{body:JSON.stringify(o.body)}:{}) }), env);
const login = async (e) => (await (await call('/login',{body:{email:e,password:'pw'}})).json()).token;

let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p?'ok  ':'FAIL'} ${l.padEnd(54)} ${JSON.stringify(g)}${p?'':' expected '+JSON.stringify(w)}`); };
const EMAILISH = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

const t = await login(ME);

console.log('\na normal write says what happened and not who');
await call('/commit', { token: t, body: { path: `races/${SLUG}/config.json`,
  content: JSON.stringify({ name:'A race', visibility:'public', createdBy: ME, people:[], runners:[] }),
  message: 'hub: create race r1 (config)' } });
await call('/commit', { token: t, body: { path: `races/${SLUG}/data.json`,
  content: '{"runners":[]}', message: 'pit: jason sign-in leg 3' } });
ok('the message survives', messages.includes('pit: jason sign-in leg 3'), true);
ok('with nothing appended to it', messages.at(-1), 'pit: jason sign-in leg 3');

console.log('\nand a caller cannot publish an address even on purpose');
// The invite-accept path used to compose exactly this shape by itself.
await call('/commit', { token: t, body: { path: `races/${SLUG}/data.json`,
  content: '{"runners":[]}', message: `hub: accept invite for ${ME} on ${SLUG}` } });
ok('it is redacted rather than sent', messages.at(-1), 'hub: accept invite for [redacted] on r1');
ok('and the rest of the message is intact', /accept invite for .* on r1/.test(messages.at(-1)), true);

console.log('\nacross every message this worker has sent');
ok('none of them contains an address', messages.filter(m => EMAILISH.test(m)), []);
ok('and there were some to check', messages.length > 2, true);

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
