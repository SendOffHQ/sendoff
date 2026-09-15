// Which way mail actually leaves, and what happens when it does not.
//
// Cloudflare Email Routing's send binding only delivers to addresses verified
// as destinations on the account. That is the right shape for telling the
// operator something happened and no shape at all for an invite, which goes to
// a stranger by definition, so invites went out by hand. RESEND_API_KEY
// switches the worker to a real sender.
//
// The properties worth holding, because getting any of them wrong is silent:
//   - the key alone decides the transport, so adding the secret is the whole
//     of the change and removing it is the whole of the rollback;
//   - git never sees the key, and neither does any response;
//   - a refusal comes back as a reason an operator can act on, not as a throw,
//     because the callers must not fail just because mail did;
//   - and the message that goes out is the one the templates wrote, from the
//     address the kind of mail calls for.
//
//   node worker/test/send-mail.mjs
import worker from '../src/worker.js';

const ADMIN = 'admin@example.com';
const kvStore = new Map();
const KV = {
  async get(k) { const v = kvStore.get(k); return v === undefined ? null : v; },
  async put(k, v) { kvStore.set(k, v); },
  async delete(k) { kvStore.delete(k); },
  async list({ prefix } = {}) {
    return { keys: [...kvStore.keys()].filter(k => !prefix || k.startsWith(prefix)).map(name => ({ name })),
             list_complete: true };
  },
};
globalThis.caches = { default: { async match(){}, async put(){}, async delete(){ return true; } } };

// Every call out of the worker, so the test can say what was sent where.
let sent = [];
let resendStatus = 200;
let resendBody = { id: 'stub-id' };
let networkDown = false;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://api.resend.com/')) {
    if (networkDown) throw new Error('connection reset');
    sent.push({ via: 'resend', url: u, headers: opts.headers || {}, body: JSON.parse(opts.body || '{}') });
    return new Response(JSON.stringify(resendBody), { status: resendStatus,
      headers: { 'Content-Type': 'application/json' } });
  }
  if (/\/git\/trees\//.test(u)) return new Response(JSON.stringify({ tree: [] }), { status: 200 });
  return new Response('{"message":"Not Found"}', { status: 404 });
};

// The Cloudflare binding, which refuses anybody it has not verified, exactly
// as the real one does.
const VERIFIED = new Set(['operator@example.com']);
const EMAIL = {
  async send(msg) {
    if (!VERIFIED.has(msg.to)) {
      throw new Error('destination address not verified');
    }
    sent.push({ via: 'routing', body: msg });
  }
};

async function cred(pw) {
  const salt = new Uint8Array(16); crypto.getRandomValues(salt);
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name:'PBKDF2', salt, iterations:100000, hash:'SHA-256' }, km, 256);
  const b = a => Buffer.from(a).toString('base64');
  return { hash: b(new Uint8Array(bits)), salt: b(salt), iterations: 100000 };
}
const KEY = 're_test_key_do_not_use';
const creds = await cred('pw');
const base = {
  GITHUB_OWNER:'o', GITHUB_REPO:'r', GITHUB_TOKEN:'t', GITHUB_BRANCH:'main',
  AUTH_KV: KV, ALLOWED_ORIGINS:'*', JWT_SECRET:'s',
  PUBLIC_BASE_URL: 'https://sendoff.run',
  NOTIFY_FROM: 'invites@sendoff.run', INFO_FROM: 'info@sendoff.run',
  NOTIFY_EMAIL: 'operator@example.com',
  EMAIL,
  USERS: JSON.stringify([{ email: ADMIN, ...creds, role: 'admin' }]),
};
const withResend = { ...base, RESEND_API_KEY: KEY };
const routingOnly = { ...base };
const noTransport = { ...base, EMAIL: undefined };

const tokenFor = async (env) => {
  const r = await worker.fetch(new Request('https://w/login', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ email: ADMIN, password: 'pw' }) }), env);
  return (await r.json()).token;
};
const call = async (env, path, init = {}) => {
  const tok = await tokenFor(env);
  return worker.fetch(new Request('https://w' + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }
  }), env, { waitUntil: () => {} });
};
const invite = (env, to) => call(env, '/account-invite', { method: 'POST',
  body: JSON.stringify({ email: to, send: true }) });

let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p?'ok  ':'FAIL'} ${l.padEnd(54)} ${JSON.stringify(g)}${p?'':' expected '+JSON.stringify(w)}`); };

const STRANGER = 'someone@nowhere.example';

// The whole reason this exists.
console.log('\nwith only the routing binding, a stranger cannot be reached');
sent = [];
let j = await (await invite(routingOnly, STRANGER)).json();
ok('the link is still made', /signup\.html\?account=/.test(j.url || ''), true);
ok('but it was not emailed', j.emailed, false);
ok('and the reason says so', /not verified/.test(j.emailError || ''), true);

console.log('\nand the operator, who is verified, still is');
sent = [];
await call(routingOnly, '/access-request', { method: 'POST',
  body: JSON.stringify({ kind: 'invite', email: 'asker@example.com', name: 'Asker', note: 'hi' }) });
ok('the note went out over the binding', sent.map(x => x.via), ['routing']);

console.log('\nwith the key set, the same invite sends for real');
sent = [];
j = await (await invite(withResend, STRANGER)).json();
ok('it was emailed', [j.emailed, j.emailError], [true, null]);
ok('over Resend, not the binding', sent.map(x => x.via), ['resend']);
ok('to the address asked for', sent[0].body.to, [STRANGER]);

console.log('\nand it is the branded message, from the right address');
ok('from invites@, because it is an invite', sent[0].body.from, 'SendOff <invites@sendoff.run>');
ok('carrying the subject the template wrote', sent[0].body.subject, 'Your SendOff invite');
ok('with the rendered markup', /wordmark-email\.png/.test(sent[0].body.html || ''), true);
ok('and the plain-text part beside it', /signup\.html\?account=/.test(sent[0].body.text || ''), true);

// A reset is not an invite and must not read as though the wrong department
// answered, which is what INFO_FROM exists for.
// A reset needs an account to reset, so it goes to one that exists. That it
// is the admin's own is incidental; what is being asked is the from-address.
console.log('\na password reset comes from info@');
sent = [];
await call(withResend, '/reset-link', { method: 'POST',
  body: JSON.stringify({ email: ADMIN, send: true }) });
ok('the from-address', sent[0].body.from, 'SendOff <info@sendoff.run>');
ok('and the subject', sent[0].body.subject, 'Reset your SendOff password');

console.log('\nthe key authenticates the call and goes nowhere else');
sent = [];
await invite(withResend, STRANGER);
ok('sent as a bearer token', sent[0].headers.Authorization, 'Bearer ' + KEY);
ok('and never in the body', JSON.stringify(sent[0].body).includes(KEY), false);
j = await (await invite(withResend, STRANGER)).json();
ok('nor in anything the worker answers with', JSON.stringify(j).includes(KEY), false);

// The callers cannot fail because mail did: the link is the record and the
// operator can always send it by hand.
console.log('\nwhen Resend refuses it');
resendStatus = 422; resendBody = { message: 'The sendoff.run domain is not verified.' };
j = await (await invite(withResend, STRANGER)).json();
ok('the invite is still issued', /signup\.html\?account=/.test(j.url || ''), true);
ok('and nothing threw', j.error || null, null);
ok('the reason is one an operator can act on', j.emailError,
   'Resend refused it (422): The sendoff.run domain is not verified.');
resendStatus = 200; resendBody = { id: 'stub-id' };

console.log('\nand when Resend cannot be reached at all');
networkDown = true;
j = await (await invite(withResend, STRANGER)).json();
ok('that reads as a different fault', /Could not reach Resend/.test(j.emailError || ''), true);
ok('and the invite still stands', /signup\.html\?account=/.test(j.url || ''), true);
networkDown = false;

console.log('\nwith no transport at all');
j = await (await invite(noTransport, STRANGER)).json();
ok('it says what is missing', /RESEND_API_KEY|EMAIL/.test(j.emailError || ''), true);
ok('and the link is still handed over', /signup\.html\?account=/.test(j.url || ''), true);

// What the admin page asks before deciding whether to offer to send at all.
console.log('\nand the page can ask which of those it is looking at');
for (const [env, transport, canSend] of [
  [withResend, 'resend', true], [routingOnly, 'routing', false], [noTransport, 'none', false]
]) {
  const s = await (await call(env, '/mail-status')).json();
  ok(`${transport}: what it reports`, [s.transport, s.canSendToAnyone], [transport, canSend]);
  ok(`${transport}: and never the key`, JSON.stringify(s).includes(KEY), false);
}

console.log('\nand only an admin may ask');
const plain = { ...withResend,
  USERS: JSON.stringify([{ email: 'crew@example.com', ...creds }]) };
const r = await worker.fetch(new Request('https://w/login', {
  method:'POST', headers:{'Content-Type':'application/json'},
  body: JSON.stringify({ email: 'crew@example.com', password: 'pw' }) }), plain);
const crewTok = (await r.json()).token;
const denied = await worker.fetch(new Request('https://w/mail-status',
  { headers: { Authorization: 'Bearer ' + crewTok } }), plain, { waitUntil: () => {} });
ok('a signed-in non-admin is refused', denied.status, 403);
const anon = await worker.fetch(new Request('https://w/mail-status'), plain, { waitUntil: () => {} });
ok('and a stranger too', anon.status, 401);

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
