// The Account box's sign-in methods: what is connected, connecting one, and
// taking one off. Always the signed-in account's own, and only a Google or
// Facebook account that carries that account's address.
//
//   node worker/test/auth-links.mjs
import worker from '../src/worker.js';

const CLIENT = '1234-sendoff.apps.googleusercontent.com';
const FB_APP = '987654321', FB_SECRET = 'fb-secret';
const ME = 'crew@example.com', OTHER = 'other@example.com';
const kv = new Map();
const KV = { async get(k){return kv.has(k)?kv.get(k):null;}, async put(k,v){kv.set(k,v);},
             async delete(k){kv.delete(k);},
             async list({prefix}){return {keys:[...kv.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name}))};} };
globalThis.caches = { default: { async match(){return undefined;}, async put(){}, async delete(){return true;} } };

// Google, stood in for with a key made here; Facebook, with a Graph API that
// knows a few tokens.
const alg = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
const gkey = await crypto.subtle.generateKey(alg, true, ['sign', 'verify']);
const pub = { ...(await crypto.subtle.exportKey('jwk', gkey.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
const FB = {
  FBMETOKEN000000000000001: { user_id: 'fb-me', email: ME },
  FBOTHERTOKEN00000000001: { user_id: 'fb-other', email: OTHER },
  FBSECONDTOKEN0000000001: { user_id: 'fb-me-2', email: ME },
};
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  if (String(url).startsWith('https://www.googleapis.com/oauth2/v3/certs')) return new Response(JSON.stringify({ keys: [pub] }));
  if (u.hostname === 'graph.facebook.com') {
    if (u.pathname.endsWith('/debug_token')) {
      const t = FB[u.searchParams.get('input_token')];
      return new Response(JSON.stringify({ data: t ? { app_id: FB_APP, is_valid: true, user_id: t.user_id } : { is_valid: false } }));
    }
    const t = FB[u.searchParams.get('access_token')];
    return new Response(JSON.stringify({ id: t.user_id, email: t.email }));
  }
  return new Response('{"message":"Not Found"}', { status: 404 });
};
const b64u = (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const enc = (o) => b64u(new TextEncoder().encode(JSON.stringify(o)));
async function gtoken(claims = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = enc({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
  const p = enc({ iss: 'https://accounts.google.com', aud: CLIENT, sub: 'g-me', email: ME, email_verified: true, iat: now, exp: now + 3600, ...claims });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', gkey.privateKey, new TextEncoder().encode(h + '.' + p));
  return `${h}.${p}.${b64u(new Uint8Array(sig))}`;
}
async function cred(pw){
  const salt=new Uint8Array(16); crypto.getRandomValues(salt);
  const km=await crypto.subtle.importKey('raw',new TextEncoder().encode(pw),'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:100000,hash:'SHA-256'},km,256);
  const b=a=>Buffer.from(a).toString('base64');
  return { hash:b(new Uint8Array(bits)), salt:b(salt), iterations:100000 };
}
const env = {
  GITHUB_OWNER:'o', GITHUB_REPO:'r', GITHUB_TOKEN:'t', GITHUB_BRANCH:'main',
  AUTH_KV: KV, ALLOWED_ORIGINS:'*', JWT_SECRET:'s', GOOGLE_CLIENT_ID: CLIENT,
  FACEBOOK_APP_ID: FB_APP, FACEBOOK_APP_SECRET: FB_SECRET,
  USERS: JSON.stringify([{ email: ME, role: 'crew', ...await cred('pw') }, { email: OTHER, role: 'crew', ...await cred('pw') }]),
};
const call = (p, { body, token, e = env } = {}) => worker.fetch(new Request('https://w' + p, {
  method: body ? 'POST' : 'GET',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}) }), e, { waitUntil: () => {} });
const login = async (email) => (await (await call('/login', { body: { email, password: 'pw' } })).json()).token;
const links = async (token, e) => (await call('/auth-links', { token, e })).json();

let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p?'ok  ':'FAIL'} ${l.padEnd(58)} ${JSON.stringify(g)}${p?'':' expected '+JSON.stringify(w)}`); };

const me = await login(ME), other = await login(OTHER);

console.log('\nwhat is connected');
const first = await links(me);
ok('nothing yet, and a password always', [first.email, first.password, first.google, first.facebook], [ME, true, null, null]);
ok('and which ones this site offers', first.available, { google: true, facebook: true });
ok('Facebook not offered when it is off', (await links(me, { ...env, FACEBOOK_APP_SECRET: '' })).available.facebook, false);
ok('signed out, refused', (await call('/auth-links')).status, 401);

console.log('\nconnecting Google');
const g = await call('/auth-links/google', { token: me, body: { credential: await gtoken() } });
ok('a Google account with my address connects', g.status, 200);
ok('and is listed, with when', !!(await links(me)).google.linkedAt, true);
ok('the identifier is kept, and not sent to the page',
   [JSON.parse(kv.get('glink:' + ME)).sub, JSON.stringify(await links(me)).includes('g-me')], ['g-me', false]);
const wrong = await (await call('/auth-links/google', { token: me, body: { credential: await gtoken({ sub: 'g-x', email: OTHER }) } })).json();
ok('one with another address is refused, saying why', wrong.code, 'wrong_email');
ok('one Google has not verified is refused, without signing me out (not a 401)',
   (await call('/auth-links/google', { token: me, body: { credential: await gtoken({ email_verified: false }) } })).status, 400);
const swap = await call('/auth-links/google', { token: me, body: { credential: await gtoken({ sub: 'g-me-2' }) } });
ok('a second Google account is not swapped in quietly', [swap.status, (await swap.json()).code], [409, 'other_linked']);
ok('the first one is still the one', JSON.parse(kv.get('glink:' + ME)).sub, 'g-me');
ok('signed out, cannot connect', (await call('/auth-links/google', { body: { credential: await gtoken() } })).status, 401);

console.log('\nconnecting Facebook');
ok('mine connects', (await call('/auth-links/facebook', { token: me, body: { accessToken: 'FBMETOKEN000000000000001' } })).status, 200);
ok('someone else\'s does not', (await (await call('/auth-links/facebook', { token: me, body: { accessToken: 'FBOTHERTOKEN00000000001' } })).json()).code, 'wrong_email');
ok('both listed now', Object.values(await links(me)).filter(v => v && v.linkedAt).length, 2);
ok('not offered, not connectable', (await call('/auth-links/facebook', { token: me, e: { ...env, FACEBOOK_APP_ID: '' },
   body: { accessToken: 'FBMETOKEN000000000000001' } })).status, 404);

console.log('\ntaking one off');
ok('Google disconnects', (await call('/auth-links/remove', { token: me, body: { provider: 'google' } })).status, 200);
ok('and is gone', [(await links(me)).google, kv.has('glink:' + ME)], [null, false]);
ok('so Google sign-in will link afresh, and the other one can now connect',
   (await call('/auth-links/google', { token: me, body: { credential: await gtoken({ sub: 'g-me-2' }) } })).status, 200);
ok('Facebook untouched by it', kv.has('fblink:' + ME), true);
ok('a provider that is not one is refused', (await call('/auth-links/remove', { token: me, body: { provider: 'user:' } })).status, 400);
ok('signed out, cannot remove', (await call('/auth-links/remove', { body: { provider: 'facebook' } })).status, 401);

console.log('\nonly ever your own');
await call('/auth-links/remove', { token: other, body: { provider: 'facebook' } });
ok('another account removing "facebook" removes theirs, not mine', kv.has('fblink:' + ME), true);
ok('and sees none of mine', [(await links(other)).google, (await links(other)).facebook], [null, null]);

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
