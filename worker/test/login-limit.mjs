// Signing in: wrong passwords are counted, and a session can be ended.
//
// /login answered as fast as it was asked, for ever, so a password could be
// guessed at the speed of the network. And a session was a signed token good
// for seven days with nothing that could take it back: changing a password
// because somebody else had it left that somebody signed in for a week.
//
// Wrong passwords are now counted per account and per client address, and a
// token carries the account's session epoch, which goes up when the password
// is changed or reset. Neither may cost the KV allowance much: a sign-in that
// works writes nothing, and the epoch is read at most once in five minutes.
//
//   node worker/test/login-limit.mjs
import worker from '../src/worker.js';
import { createHmac } from 'node:crypto';

const ME = 'me@example.com', YOU = 'you@example.com', ADMIN = 'admin@example.com';
const kv = new Map(), ttl = new Map();
let puts = [], gets = [], kvDown = false;
const KV = {
  async get(k) { gets.push(k); if (kvDown && k.startsWith(kvDown)) throw new Error('KV is out of reach'); return kv.has(k) ? kv.get(k) : null; },
  async put(k, v, o) { puts.push(k); kv.set(k, v); if (o && o.expirationTtl) ttl.set(k, o.expirationTtl); },
  async delete(k) { kv.delete(k); },
  async list({ prefix }) { return { keys: [...kv.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }; },
};
globalThis.caches = { default: { async match(){return undefined;}, async put(){}, async delete(){return true;} } };
globalThis.fetch = async () => new Response('{"message":"Not Found"}', { status: 404 });
// The clock, so a minute can pass without waiting for one.
const realNow = Date.now.bind(Date);
let skew = 0;
Date.now = () => realNow() + skew;

async function cred(pw){
  const salt=new Uint8Array(16); crypto.getRandomValues(salt);
  const km=await crypto.subtle.importKey('raw',new TextEncoder().encode(pw),'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:100000,hash:'SHA-256'},km,256);
  const b=a=>Buffer.from(a).toString('base64');
  return { hash:b(new Uint8Array(bits)), salt:b(salt), iterations:100000 };
}
const env = {
  AUTH_KV: KV, ALLOWED_ORIGINS:'*', JWT_SECRET:'test-secret', PUBLIC_BASE_URL: 'https://sendoff.run',
  USERS: JSON.stringify([{ email: ME, ...await cred('right-password') }, { email: YOU, ...await cred('right-password') },
    { email: ADMIN, role: 'admin', ...await cred('right-password') }]),
};
const call = async (p, o = {}) => {
  const r = await worker.fetch(new Request('https://w' + p, {
    method: o.body ? 'POST' : 'GET',
    headers: { 'Content-Type':'application/json', ...(o.token ? { Authorization: 'Bearer ' + o.token } : {}),
               ...(o.from ? { 'CF-Connecting-IP': o.from } : {}) },
    ...(o.body ? { body: JSON.stringify(o.body) } : {}) }), env, { waitUntil: () => {} });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, retryAfter: r.headers.get('Retry-After'), ...(j || {}) };
};
const login = (email, password, from) => call('/login', { body: { email, password }, from });
const claims = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
// Whether a token is still a session: any endpoint that needs one.
const works = async (token) => (await call('/username', { token })).status;

let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p?'ok  ':'FAIL'} ${l.padEnd(62)} ${JSON.stringify(g)}${p?'':' expected '+JSON.stringify(w)}`); };

console.log('\nsigning in');
puts = [];
const first = await login(ME, 'right-password');
ok('works, and costs no write', [first.status, puts.length], [200, 0]);

console.log('\na tired person mistyping');
const tries = [];
for (let i = 0; i < 9; i++) tries.push((await login(ME, 'wrong-' + i)).status);
ok('is told the password is wrong, nine times over', tries, Array(9).fill(401));
ok('and still gets in on the tenth go', (await login(ME, 'right-password')).status, 200);
ok('which wipes the slate', kv.has('loginfail:a:' + ME), false);

console.log('\nsomebody guessing');
for (let i = 0; i < 10; i++) tries.push((await login(ME, 'guess-' + i)).status);
ok('ten wrong passwords are each answered as wrong', tries.slice(9), Array(10).fill(401));
const blocked = await login(ME, 'guess-10');
ok('the eleventh is refused without being looked at', [blocked.status, blocked.code, blocked.retryAfter], [429, 'too_many_attempts', '900']);
ok('in words a person can act on', blocked.error, 'Too many wrong passwords. Wait 15 minutes and try again.');
ok('and so is the right password, or the limit would stop nothing', (await login(ME, 'right-password')).status, 429);
ok('the count lasts a quarter of an hour', ttl.get('loginfail:a:' + ME), 900);
ok('an address that is not an account is counted the same way', [(await login('nobody@example.com', 'x')).status, kv.get('loginfail:a:nobody@example.com')], [401, '1']);
ok('another account is not affected', (await login(YOU, 'right-password')).status, 200);
kv.delete('loginfail:a:' + ME);   // the quarter of an hour passes
ok('and when the time is up the account opens again', (await login(ME, 'right-password')).status, 200);

console.log('\nguesses spread across accounts from one address');
const spread = [];
for (let i = 0; i < 30; i++) spread.push((await login(`victim${i}@example.com`, 'guess', '203.0.113.9')).status);
ok('thirty are answered', spread, Array(30).fill(401));
ok('and then that address is refused, whoever it asks for', (await login(YOU, 'right-password', '203.0.113.9')).status, 429);
ok('a different address is not', (await login(YOU, 'right-password', '198.51.100.7')).status, 200);

// ---------- ending sessions ----------
console.log('\na session');
const phone = (await login(ME, 'right-password')).token;
const laptop = (await login(ME, 'right-password')).token;
ok('carries the account\'s session epoch', claims(phone).ep, 0);
ok('and works', await works(phone), 200);
gets = [];
for (let i = 0; i < 20; i++) await works(phone);
ok('checking it does not read the account on every request', gets.filter(k => k === 'user:' + ME).length <= 1, true);

console.log('\nthe password is changed, on the laptop');
const changed = await call('/change-password', { token: laptop, body: { currentPassword: 'right-password', newPassword: 'a-better-password' } });
ok('changed', [changed.status, changed.ok], [200, true]);
ok('the phone, signed in before, is signed out', await works(phone), 401);
ok('and so is the token the laptop was using', await works(laptop), 401);
ok('the laptop is handed a new one to carry on with', [claims(changed.token).ep, await works(changed.token)], [1, 200]);
ok('the old password no longer signs in', (await login(ME, 'right-password')).status, 401);
const after = await login(ME, 'a-better-password');
ok('the new one does, into the new epoch', [after.status, claims(after.token).ep], [200, 1]);

console.log('\na token from before epochs existed');
const sign = (payload) => {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = enc({ alg: 'HS256', typ: 'JWT' }) + '.' + enc(payload);
  return data + '.' + createHmac('sha256', env.JWT_SECRET).update(data).digest('base64url');
};
const legacy = sign({ sub: ME, email: ME, role: 'crew', exp: Date.now() + 3600e3 });
ok('still works until it expires, password change or not', await works(legacy), 200);
ok('and one made up with a bigger epoch and the wrong key does not', await works(sign({ sub: ME, email: ME, ep: 99, exp: Date.now() + 3600e3 }).slice(0, -2) + 'xx'), 401);

console.log('\nthe password is changed somewhere else, on another copy of the worker');
const mine = (await login(YOU, 'right-password')).token;
ok('signed in', await works(mine), 200);
// What that other copy wrote: the new password's record, with the epoch raised.
kv.set('user:' + YOU, JSON.stringify({ email: YOU, ...await cred('changed-elsewhere'), sessionEpoch: 1 }));
ok('this copy has not looked yet', await works(mine), 200);
skew += 301 * 1000;
ok('five minutes on, it has, and the old session is over', await works(mine), 401);

console.log('\na reset link ends sessions too');
const adminToken = (await login(ADMIN, 'right-password')).token;
const stale = (await login(ME, 'a-better-password')).token;
const reset = await call('/reset-link', { token: adminToken, body: { email: ME } });
const redeemed = await call('/reset-password', { body: { token: reset.token, newPassword: 'after-the-reset' } });
ok('the reset signs the person in, in a new epoch', [redeemed.status, claims(redeemed.token).ep, await works(redeemed.token)], [200, 2, 200]);
ok('and everything signed in before it is out', [await works(stale), await works(changed.token)], [401, 401]);

// KV has a daily allowance, and the day it runs out must not be the day every
// crew is signed out of a race in progress.
console.log('\nwhen the account cannot be read');
const fresh = (await login(ADMIN, 'right-password')).token;
skew += 301 * 1000;
kvDown = 'user:';
ok('a signed, unexpired token is not refused over it', await works(fresh), 200);
ok('but one already known to be over stays over', await works(stale), 401);
kvDown = false;

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
