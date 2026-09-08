// The feedback endpoint. Public on purpose, which is why it is worth testing:
// anyone on the internet can post to it, including people who are not people.
import worker from '../src/worker.js';

const ME = 'crew@example.com';
const kv = new Map();
const KV = {
  async get(k) { return kv.has(k) ? kv.get(k) : null; },
  async put(k, v) { kv.set(k, v); },
  async delete(k) { kv.delete(k); },
  async list({ prefix }) { return { keys: [...kv.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) }; }
};
globalThis.caches = { default: { async match(){ return undefined; }, async put(){}, async delete(){ return true; } } };
globalThis.fetch = async () => new Response('{}', { status: 200 });

async function cred(pw) {
  const salt = new Uint8Array(16); crypto.getRandomValues(salt);
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name:'PBKDF2', salt, iterations:100000, hash:'SHA-256' }, km, 256);
  const b = a => Buffer.from(a).toString('base64');
  return { hash: b(new Uint8Array(bits)), salt: b(salt), iterations: 100000 };
}
const env = {
  GITHUB_OWNER:'o', GITHUB_REPO:'r', GITHUB_TOKEN:'t', GITHUB_BRANCH:'main',
  AUTH_KV: KV, ALLOWED_ORIGINS:'*', JWT_SECRET:'s',
  USERS: JSON.stringify([{ email: ME, ...await cred('pw') },
                         { email: 'admin@example.com', ...await cred('pw'), role: 'admin' }]),
};
const call = (p, o = {}) => worker.fetch(new Request('https://w' + p, {
  method: o.method || (o.body ? 'POST' : 'GET'),
  headers: {
    'Content-Type': 'application/json',
    'CF-Connecting-IP': o.ip || '203.0.113.1',
    'User-Agent': 'TestBrowser/1.0',
    ...(o.token ? { Authorization: 'Bearer ' + o.token } : {})
  },
  ...(o.body ? { body: JSON.stringify(o.body) } : {})
}), env);
const login = async (e) => (await (await call('/login', { body: { email: e, password: 'pw' } })).json()).token;
const rows = () => [...kv.entries()].filter(([k]) => k.startsWith('fb:')).map(([, v]) => JSON.parse(v));

let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p?'ok  ':'FAIL'} ${l.padEnd(52)} ${JSON.stringify(g)}${p?'':' expected '+JSON.stringify(w)}`); };

console.log('\nanyone can send it, signed in or not');
let r = await call('/feedback', { body: { message: 'The elevation looks wrong on leg 4.',
  email: 'watcher@example.com', page: '/race.html?id=r1', race: 'r1', version: 'v65' } });
ok('a signed-out reader is accepted', r.status, 200);
ok('and it is stored with what they gave', (() => {
  const f = rows()[0];
  return [f.message.slice(0, 9), f.email, f.account, f.page, f.version];
})(), ['The eleva', 'watcher@example.com', null, '/race.html?id=r1', 'v65']);

const t = await login(ME);
await call('/feedback', { token: t, body: { message: 'Pit board froze.', email: 'someone-else@example.com' } });
ok('a signed-in sender is recorded as themselves', rows().find(f => f.message === 'Pit board froze.').account, ME);
ok('and their address is the account, not whatever was typed',
   rows().find(f => f.message === 'Pit board froze.').email, ME);

console.log('\ncontext travels with it');
await call('/feedback', { token: t, body: { message: 'Lost the buttons.', offline: true, queued: 3,
  writtenAt: '2026-09-26T14:00:00Z' } });
const ctx = rows().find(f => f.message === 'Lost the buttons.');
ok('offline and queue depth', [ctx.offline, ctx.queued], [true, 3]);
ok('the browser it happened in', ctx.agent, 'TestBrowser/1.0');
ok('when it was written, not just when it arrived', ctx.writtenAt, '2026-09-26T14:00:00Z');
ok('and the two are different for a queued note', ctx.writtenAt !== ctx.sentAt, true);

console.log('\nwhat it refuses');
ok('an empty message', (await call('/feedback', { body: { message: '  ' } })).status, 400);
ok('and no message at all', (await call('/feedback', { body: {} })).status, 400);
const before = rows().length;
const hp = await call('/feedback', { body: { message: 'buy pills', website: 'http://spam' } });
ok('a bot filling the honeypot is told it worked', hp.status, 200);
ok('and nothing is stored', rows().length, before);

console.log('\nand it cannot be used as a firehose');
let last = 200;
for (let i = 0; i < 12; i++) {
  last = (await call('/feedback', { ip: '198.51.100.7', body: { message: 'flood ' + i } })).status;
}
ok('the eleventh from one address is refused', last, 429);
ok('a different address is not', (await call('/feedback', { ip: '198.51.100.8',
  body: { message: 'still fine' } })).status, 200);

console.log('\nreading and clearing it is admins only');
ok('a crew member cannot read', (await call('/feedback-list', { token: t })).status, 403);
ok('nor a stranger', (await call('/feedback-list')).status, 401);
const at = await login('admin@example.com');
const listed = await (await call('/feedback-list', { token: at })).json();
ok('an admin can', listed.items.length > 0, true);
ok('newest first', listed.items[0].sentAt >= listed.items[listed.items.length - 1].sentAt, true);
ok('a crew member cannot clear', (await call('/feedback/delete', { token: t,
  body: { key: listed.items[0].key } })).status, 403);
const n = rows().length;
ok('an admin can', (await call('/feedback/delete', { token: at, body: { key: listed.items[0].key } })).status, 200);
ok('and it is gone', rows().length, n - 1);
ok('but not some other key they made up',
   (await call('/feedback/delete', { token: at, body: { key: 'user:someone@example.com' } })).status, 400);

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
