// The plan gate: what a free account cannot do, what a pro account can, and
// the promises that must survive it.
//
//   node worker/test/entitlements.mjs
import worker from '../src/worker.js';

const ADMIN = 'admin@example.com', PRO = 'pro@example.com', FREE = 'free@example.com';
const repo = new Map();
const kv = new Map();
const KV = {
  async get(k) { return kv.has(k) ? kv.get(k) : null; },
  async put(k, v) { kv.set(k, v); },
  async delete(k) { kv.delete(k); },
  async list({ prefix }) { return { keys: [...kv.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) }; },
};
globalThis.caches = { default: {
  async match() { return undefined; }, async put() {}, async delete() { return true; } } };

async function cred(pw) {
  const salt = new Uint8Array(16); crypto.getRandomValues(salt);
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name:'PBKDF2', salt, iterations:100000, hash:'SHA-256' }, km, 256);
  const b = a => Buffer.from(a).toString('base64');
  return { hash: b(new Uint8Array(bits)), salt: b(salt), iterations: 100000 };
}
const env = {
  GITHUB_OWNER:'o', GITHUB_REPO:'r', GITHUB_TOKEN:'t', GITHUB_BRANCH:'main',
  AUTH_KV: KV, ALLOWED_ORIGINS:'*', JWT_SECRET:'test-secret',
  USERS: JSON.stringify([{ email: ADMIN, role: 'admin', ...await cred('pw') }]),
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

const call = (path, opts = {}) => worker.fetch(new Request('https://w' + path, {
  method: opts.body ? 'POST' : 'GET',
  headers: { 'Content-Type':'application/json', ...(opts.token ? { Authorization:'Bearer ' + opts.token } : {}) },
  ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
}), env);
async function login(email, pw = 'pw') {
  const j = await (await call('/login', { body: { email, password: pw } })).json();
  if (!j.token) throw new Error('login failed ' + email + ': ' + JSON.stringify(j));
  return j.token;
}

let failures = 0;
const expect = (label, got, want) => {
  const ok = String(got) === String(want); if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(56)} ${got}${ok ? '' : ` (expected ${want})`}`);
};

const admin = await login(ADMIN);
// Two stored accounts. Written the way createUserInKv writes them, with no
// plan and no earlyAccess field, which is also the shape every record that
// predates this feature has on disk. What they read back as is the first
// thing worth checking.
for (const e of [PRO, FREE]) {
  await KV.put('user:' + e, JSON.stringify({ email: e, role: 'crew', ...await cred('pw') }));
}

console.log('\nevery account starts on Pro, with the grandfather flag set');
const proTok = await login(PRO);
const e1 = await (await call('/entitlements', { token: proTok })).json();
expect('a brand new account is pro', e1.plan, 'pro');
expect('and carries earlyAccess', e1.earlyAccess, true);
expect('with no runner cap', e1.maxRunnersPerRace, null);

console.log('\nan admin can move an account to free');
const r = await call('/account/plan', { token: admin, body: { email: FREE, plan: 'free', earlyAccess: false } });
expect('the change is accepted', r.status, 200);
const freeTok = await login(FREE);
const e2 = await (await call('/entitlements', { token: freeTok })).json();
expect('the account reads as free', e2.plan, 'free');
expect('one runner', e2.maxRunnersPerRace, 1);
expect('two crew', e2.maxCrewPerRace, 2);
expect('no private races', e2.privateRaces, false);

console.log('\nthe caps hold on the way in');
const mk = (slug, body) => call('/commit', { token: freeTok,
  body: { path: `races/${slug}/config.json`, content: JSON.stringify(body), message: 'create' } });
expect('free: a public race with one runner',
  (await mk('r1', { name:'A', visibility:'public', createdBy: FREE, runners:[{id:'a'}] })).status, 200);
expect('free: a private race is refused',
  (await mk('r2', { name:'B', visibility:'private', createdBy: FREE, runners:[{id:'a'}] })).status, 402);
expect('free: two runners is refused',
  (await mk('r3', { name:'C', visibility:'public', createdBy: FREE, runners:[{id:'a'},{id:'b'}] })).status, 402);
expect('free: a share link is refused',
  (await call('/share-link', { token: freeTok, body: { slug:'r1', role:'view' } })).status, 402);

console.log('\nand pro is not capped');
const mkPro = (slug, body) => call('/commit', { token: proTok,
  body: { path: `races/${slug}/config.json`, content: JSON.stringify(body), message: 'create' } });
expect('pro: a private race with four runners',
  (await mkPro('p1', { name:'D', visibility:'private', createdBy: PRO,
                       runners:[{id:'a'},{id:'b'},{id:'c'},{id:'d'}] })).status, 200);

console.log('\nthe promises that must survive the gate');
// A race already over its cap keeps working. Nothing is bricked retroactively.
repo.set('races/r1/config.json', JSON.stringify({
  name:'A', visibility:'public', createdBy: FREE, runners:[{id:'a'},{id:'b'},{id:'c'}], people:[] }));
expect('an over-cap race can still be saved',
  (await mk('r1', { name:'A renamed', visibility:'public', createdBy: FREE,
                    runners:[{id:'a'},{id:'b'},{id:'c'}] })).status, 200);
expect('but still cannot grow',
  (await mk('r1', { name:'A', visibility:'public', createdBy: FREE,
                    runners:[{id:'a'},{id:'b'},{id:'c'},{id:'d'}] })).status, 402);

// earlyAccess is a promise to a person, not a property of a plan.
await call('/account/plan', { token: admin, body: { email: FREE, plan: 'free', earlyAccess: true } });
const e3 = await (await call('/entitlements', { token: await login(FREE) })).json();
expect('grandfathered free keeps private races', e3.privateRaces, true);
expect('and share links', e3.shareLinks, true);
expect('but is still capped at one runner', e3.maxRunnersPerRace, 1);

console.log('\na password change must not drop the plan');
await call('/account/plan', { token: admin, body: { email: FREE, plan: 'free', earlyAccess: false } });
const t = await login(FREE);
const ch = await call('/change-password', { token: t, body: { currentPassword:'pw', newPassword:'newpassword1' } });
expect('the change succeeds', ch.status, 200);
const e4 = await (await call('/entitlements', { token: await login(FREE, 'newpassword1') })).json();
expect('the plan survived', e4.plan, 'free');
expect('so did earlyAccess being off', e4.earlyAccess, undefined);

console.log('\nonly an admin moves a plan');
expect('a pro account cannot promote itself',
  (await call('/account/plan', { token: proTok, body: { email: PRO, plan:'pro' } })).status, 403);

console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
