// Sign in with Facebook: only a token Facebook says is valid and was issued to
// SendOff's app, for an address on an existing account, gets a session.
//
// Facebook's Graph API is stood in for, answering debug_token and /me the way
// the real one does, so each way a sign-in can be wrong can be made on purpose.
//
//   node worker/test/facebook-login.mjs
import worker from '../src/worker.js';
import crypto from 'node:crypto';

const APP_ID = '987654321', SECRET = 'fb-app-secret-never-sent-anywhere-else';
const KV_USER = 'crew@example.com', ENV_ADMIN = 'admin@example.com';
const kv = new Map();
const KV = { async get(k){return kv.has(k)?kv.get(k):null;}, async put(k,v){kv.set(k,v);},
             async delete(k){kv.delete(k);},
             async list({prefix}){return {keys:[...kv.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name}))};} };
globalThis.caches = { default: { async match(){return undefined;}, async put(){}, async delete(){return true;} } };

// Tokens Facebook would recognise, and what it says about each.
const TOKENS = {
  GOODTOKEN000000000000001: { app_id: APP_ID, is_valid: true, user_id: 'fb-1', email: KV_USER },
  ADMINTOKEN00000000000001: { app_id: APP_ID, is_valid: true, user_id: 'fb-admin', email: ENV_ADMIN },
  OTHERAPPTOKEN00000000001: { app_id: '111', is_valid: true, user_id: 'fb-1', email: KV_USER },
  REVOKEDTOKEN000000000001: { app_id: APP_ID, is_valid: false, user_id: 'fb-1', email: KV_USER },
  NOEMAILTOKEN000000000001: { app_id: APP_ID, is_valid: true, user_id: 'fb-2', email: null },
  STRANGERTOKEN00000000001: { app_id: APP_ID, is_valid: true, user_id: 'fb-3', email: 'stranger@example.com' },
  SWAPPEDTOKEN000000000001: { app_id: APP_ID, is_valid: true, user_id: 'fb-1', email: KV_USER, meId: 'fb-someone-else' },
  SECONDFBTOKEN00000000001: { app_id: APP_ID, is_valid: true, user_id: 'fb-9', email: KV_USER },
};
let graphCalls = 0, proofs = [], appTokens = [];
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  if (u.hostname !== 'graph.facebook.com') return new Response('{"message":"Not Found"}', { status: 404 });
  graphCalls++;
  if (u.pathname.endsWith('/debug_token')) {
    appTokens.push(u.searchParams.get('access_token'));
    const t = TOKENS[u.searchParams.get('input_token')];
    if (!t) return new Response(JSON.stringify({ data: { is_valid: false } }), { status: 200 });
    return new Response(JSON.stringify({ data: { app_id: t.app_id, is_valid: t.is_valid, user_id: t.user_id,
      expires_at: Math.floor(Date.now() / 1000) + 3600, scopes: ['email', 'public_profile'] } }), { status: 200 });
  }
  if (u.pathname.endsWith('/me')) {
    const tok = u.searchParams.get('access_token');
    proofs.push([tok, u.searchParams.get('appsecret_proof')]);
    const t = TOKENS[tok];
    return new Response(JSON.stringify({ id: t.meId || t.user_id, ...(t.email ? { email: t.email } : {}) }), { status: 200 });
  }
  return new Response('{}', { status: 404 });
};

async function cred(pw){
  const salt=new Uint8Array(16); globalThis.crypto.getRandomValues(salt);
  const km=await globalThis.crypto.subtle.importKey('raw',new TextEncoder().encode(pw),'PBKDF2',false,['deriveBits']);
  const bits=await globalThis.crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:100000,hash:'SHA-256'},km,256);
  const b=a=>Buffer.from(a).toString('base64');
  return { hash:b(new Uint8Array(bits)), salt:b(salt), iterations:100000 };
}
kv.set('user:' + KV_USER, JSON.stringify({ email: KV_USER, ...(await cred('pw')), role: 'crew' }));
const baseEnv = {
  GITHUB_OWNER:'o', GITHUB_REPO:'r', GITHUB_TOKEN:'t', GITHUB_BRANCH:'main',
  AUTH_KV: KV, ALLOWED_ORIGINS:'*', JWT_SECRET:'s',
  USERS: JSON.stringify([{ email: ENV_ADMIN, role: 'admin', ...(await cred('adminpw')) }]),
};
const env = { ...baseEnv, FACEBOOK_APP_ID: APP_ID, FACEBOOK_APP_SECRET: SECRET };
const call = (e, p, body, tok) => worker.fetch(new Request('https://w' + p, {
  method: body ? 'POST' : 'GET',
  headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}) }), e, { waitUntil: () => {} });
const fb = async (accessToken, e = env) => {
  const r = await call(e, '/login/facebook', { accessToken });
  const text = await r.text();
  return { status: r.status, raw: text, ...JSON.parse(text) };
};

let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p?'ok  ':'FAIL'} ${l.padEnd(58)} ${JSON.stringify(g)}${p?'':' expected '+JSON.stringify(w)}`); };

console.log('\noff until both halves are set');
ok('no app id: the page is told there is no Facebook', (await (await call(baseEnv, '/auth-providers')).json()).facebook, null);
ok('an app id with no secret is still off', (await (await call({ ...baseEnv, FACEBOOK_APP_ID: APP_ID }, '/auth-providers')).json()).facebook, null);
ok('and a sign-in is refused outright', (await fb('GOODTOKEN000000000000001', { ...baseEnv, FACEBOOK_APP_ID: APP_ID })).status, 404);
ok('with both, the page gets the app id and nothing else', await (await call(env, '/auth-providers')).json(), { google: null, facebook: APP_ID });

console.log('\na good sign-in for an account made by invite');
const good = await fb('GOODTOKEN000000000000001');
ok('signs in', [good.status, good.email, good.via, good.role], [200, KV_USER, 'facebook', 'crew']);
ok('the session works like a password one', (await call(env, '/profile', null, good.token)).status, 200);
ok('Facebook was asked whether the token is ours, with the app token', appTokens.at(-1), `${APP_ID}|${SECRET}`);
const [tok, proof] = proofs.at(-1);
ok('and asked for the address with a correct appsecret_proof',
   proof, crypto.createHmac('sha256', SECRET).update(tok).digest('hex'));
ok('the Facebook identity is linked, on its own key', JSON.parse(kv.get('fblink:' + KV_USER)).id, 'fb-1');
ok('the account record is untouched', Object.keys(JSON.parse(kv.get('user:' + KV_USER))).includes('fblink'), false);

console.log('\nthe admin, whose account lives in the bootstrap list');
const admin = await fb('ADMINTOKEN00000000000001');
ok('signs in as admin', [admin.status, admin.role], [200, 'admin']);
ok('with no user record appearing to shadow the real one', kv.has('user:' + ENV_ADMIN), false);

console.log('\nevery way it can be wrong');
ok('a token issued to another app', (await fb('OTHERAPPTOKEN00000000001')).status, 401);
ok('a token Facebook says is not valid', (await fb('REVOKEDTOKEN000000000001')).status, 401);
ok('a /me that names a different person than the token', (await fb('SWAPPEDTOKEN000000000001')).status, 401);
const before = graphCalls;
ok('something that is not a token at all', (await fb('<script>')).status, 401);
ok('which never reaches Facebook', graphCalls, before);
const noEmail = await fb('NOEMAILTOKEN000000000001');
ok('no address shared: told to use the password', [noEmail.status, noEmail.code], [403, 'no_email']);
const stranger = await fb('STRANGERTOKEN00000000001');
ok('an address with no account is told so', [stranger.status, stranger.code], [403, 'no_account']);
ok('and no account is made', kv.has('user:stranger@example.com'), false);
ok('a second Facebook identity for a linked address is refused', (await fb('SECONDFBTOKEN00000000001')).status, 403);

console.log('\nthe secret stays on the worker');
const everything = [good.raw, admin.raw, noEmail.raw, stranger.raw,
  await (await call(env, '/auth-providers')).text()].join('\n');
ok('in no response the page could see', everything.includes(SECRET), false);

console.log('\ndeleting the account takes the Facebook link with it');
await call(env, '/account/delete', { email: KV_USER }, admin.token);
ok('gone', [kv.has('user:' + KV_USER), kv.has('fblink:' + KV_USER)], [false, false]);

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
