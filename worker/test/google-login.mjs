// Sign in with Google: only a token Google signed, for SendOff, for an address
// Google vouches for, that belongs to an existing account, gets a session.
//
// Google's keys are stood in for by a key made here, served where the worker
// fetches Google's certificates from, so every way a token can be wrong can be
// made on purpose.
//
//   node worker/test/google-login.mjs
import worker from '../src/worker.js';

const CLIENT = '1234-sendoff.apps.googleusercontent.com';
const KV_USER = 'crew@example.com', ENV_ADMIN = 'admin@example.com', NOBODY = 'stranger@example.com';

const kv = new Map();
const KV = { async get(k){return kv.has(k)?kv.get(k):null;}, async put(k,v){kv.set(k,v);},
             async delete(k){kv.delete(k);},
             async list({prefix}){return {keys:[...kv.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name}))};} };
globalThis.caches = { default: { async match(){return undefined;}, async put(){}, async delete(){return true;} } };

// Google's key, and an impostor's with the same key id.
const alg = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
const google = await crypto.subtle.generateKey(alg, true, ['sign', 'verify']);
const impostor = await crypto.subtle.generateKey(alg, true, ['sign', 'verify']);
const KID = 'test-kid-1';
const pub = { ...(await crypto.subtle.exportKey('jwk', google.publicKey)), kid: KID, alg: 'RS256', use: 'sig' };
let certFetches = 0;
globalThis.fetch = async (url) => {
  if (String(url).startsWith('https://www.googleapis.com/oauth2/v3/certs')) {
    certFetches++;
    return new Response(JSON.stringify({ keys: [pub] }), { status: 200 });
  }
  return new Response('{"message":"Not Found"}', { status: 404 });
};

const b64u = (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const enc = (o) => b64u(new TextEncoder().encode(JSON.stringify(o)));
async function token(claims = {}, { key = google.privateKey, header = {} } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = enc({ alg: 'RS256', kid: KID, typ: 'JWT', ...header });
  const p = enc({ iss: 'https://accounts.google.com', aud: CLIENT, sub: 'g-111', email: KV_USER,
                  email_verified: true, iat: now, exp: now + 3600, ...claims });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(h + '.' + p));
  return `${h}.${p}.${b64u(new Uint8Array(sig))}`;
}

async function cred(pw){
  const salt=new Uint8Array(16); crypto.getRandomValues(salt);
  const km=await crypto.subtle.importKey('raw',new TextEncoder().encode(pw),'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:100000,hash:'SHA-256'},km,256);
  const b=a=>Buffer.from(a).toString('base64');
  return { hash:b(new Uint8Array(bits)), salt:b(salt), iterations:100000 };
}
// One account made by invite (in KV), one from the bootstrap list (not in KV).
kv.set('user:' + KV_USER, JSON.stringify({ email: KV_USER, ...(await cred('pw')), role: 'crew' }));
const baseEnv = {
  GITHUB_OWNER:'o', GITHUB_REPO:'r', GITHUB_TOKEN:'t', GITHUB_BRANCH:'main',
  AUTH_KV: KV, ALLOWED_ORIGINS:'*', JWT_SECRET:'s',
  USERS: JSON.stringify([{ email: ENV_ADMIN, role: 'admin', ...(await cred('adminpw')) }]),
};
const env = { ...baseEnv, GOOGLE_CLIENT_ID: CLIENT };
const call = (e, p, body, tok) => worker.fetch(new Request('https://w' + p, {
  method: body ? 'POST' : 'GET',
  headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}) }), e, { waitUntil: () => {} });
const google_ = async (credential, e = env) => {
  const r = await call(e, '/login/google', { credential });
  return { status: r.status, ...(await r.json()) };
};

let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p?'ok  ':'FAIL'} ${l.padEnd(58)} ${JSON.stringify(g)}${p?'':' expected '+JSON.stringify(w)}`); };

console.log('\noff until a client id is set');
ok('the page is told there is no Google', (await (await call(baseEnv, '/auth-providers')).json()).google, null);
ok('and a token is refused outright', (await google_(await token(), baseEnv)).status, 404);
ok('with it set, the page gets the client id', (await (await call(env, '/auth-providers')).json()).google, CLIENT);

console.log('\na good token for an account made by invite');
const good = await google_(await token());
ok('signs in', [good.status, good.email, good.via], [200, KV_USER, 'google']);
ok('with the account\'s own role', good.role, 'crew');
ok('and the session works like a password one', (await call(env, '/profile', null, good.token)).status, 200);
ok('the Google identity is linked, on its own key', JSON.parse(kv.get('glink:' + KV_USER)).sub, 'g-111');
ok('and the account record is untouched', JSON.parse(kv.get('user:' + KV_USER)).glink, undefined);
ok('the password still works too', (await call(env, '/login', { email: KV_USER, password: 'pw' })).status, 200);

console.log('\nthe admin, whose account lives in the bootstrap list');
const admin = await google_(await token({ email: ENV_ADMIN, sub: 'g-admin' }));
ok('signs in as admin', [admin.status, admin.role], [200, 'admin']);
ok('without a user record appearing in KV to shadow the real one', kv.has('user:' + ENV_ADMIN), false);
const pw = await (await call(env, '/login', { email: ENV_ADMIN, password: 'adminpw' })).json();
ok('so the password and the role both survive', [!!pw.token, pw.role], [true, 'admin']);

console.log('\nno account, no session');
const none = await google_(await token({ email: NOBODY, sub: 'g-999' }));
ok('an address with no account is told so', [none.status, none.code], [403, 'no_account']);
ok('and no account is made', [kv.has('user:' + NOBODY), kv.has('glink:' + NOBODY)], [false, false]);

console.log('\nevery way a token can be wrong');
ok('for another site', (await google_(await token({ aud: 'someone-else.apps.googleusercontent.com' }))).status, 401);
ok('expired', (await google_(await token({ exp: Math.floor(Date.now() / 1000) - 3600 }))).status, 401);
ok('an address Google has not verified', (await google_(await token({ email_verified: false }))).status, 401);
ok('not issued by Google', (await google_(await token({ iss: 'https://evil.example.com' }))).status, 401);
ok('signed by somebody else with Google\'s key id', (await google_(await token({}, { key: impostor.privateKey }))).status, 401);
ok('with the signature stripped', (await google_((await token()).split('.').slice(0, 2).join('.') + '.')).status, 401);
ok('claiming no algorithm', (await google_(await token({}, { header: { alg: 'none' } }))).status, 401);
ok('with its claims edited after signing', await (async () => {
  const [h, , s] = (await token()).split('.');
  return (await google_(`${h}.${enc({ iss: 'https://accounts.google.com', aud: CLIENT, sub: 'g-111', email: ENV_ADMIN,
    email_verified: true, exp: Math.floor(Date.now() / 1000) + 3600 })}.${s}`)).status;
})(), 401);
ok('not a token at all', (await google_('hello')).status, 401);

console.log('\nonce linked, only that Google account');
const other = await google_(await token({ sub: 'g-222' }));
ok('a different Google identity with the same address is refused', other.status, 403);
ok('the first one still works', (await google_(await token())).status, 200);

console.log('\nGoogle\'s keys are fetched once, not per sign-in');
ok('one fetch across all of the above', certFetches, 1);

console.log('\ndeleting the account takes the link and the results with it');
kv.set('results:' + KV_USER, JSON.stringify({ bySlug: {}, manual: [{ id: 'm-1' }] }));
await call(env, '/account/delete', { email: KV_USER }, admin.token);
ok('gone: account, link and results', [kv.has('user:' + KV_USER), kv.has('glink:' + KV_USER), kv.has('results:' + KV_USER)], [false, false, false]);
ok('and Google sign-in stops working for it', (await google_(await token())).code, 'no_account');

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
