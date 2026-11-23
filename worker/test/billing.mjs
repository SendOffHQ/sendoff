// Paying for Pro through Stripe (2026-11-23), switched off until set up. What
// must hold: nothing is offered while it is off; a checkout is made for the
// account asking, tied to it every way Stripe allows; only a correctly signed
// event from Stripe changes a plan; events late, twice or out of order never
// leave the wrong plan; and an admin's own plan survives a subscription ending.
//
//   node worker/test/billing.mjs
import worker from '../src/worker.js';

const ADMIN = 'admin@example.com', PAYER = 'payer@example.com', ENVUSER = 'env@example.com';
const kv = new Map();
const KV = { async get(k){return kv.has(k)?kv.get(k):null;}, async put(k,v){kv.set(k,v);},
             async delete(k){kv.delete(k);},
             async list({prefix}){return {keys:[...kv.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name}))};} };
globalThis.caches = { default: { async match(){return undefined;}, async put(){}, async delete(){return true;} } };

// Stripe, as far as this needs it.
const stripeCalls = [];
const subs = new Map();
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://api.stripe.com/v1/')) {
    const path = u.slice('https://api.stripe.com/v1/'.length);
    stripeCalls.push({ path, method: opts.method || 'GET', body: opts.body ? new URLSearchParams(opts.body) : null,
      auth: (opts.headers || {}).Authorization });
    if (path === 'checkout/sessions') return new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' }), { status: 200 });
    if (path === 'billing_portal/sessions') return new Response(JSON.stringify({ url: 'https://billing.stripe.com/p/session/1' }), { status: 200 });
    if (path.startsWith('subscriptions/')) return new Response(JSON.stringify(subs.get(path.slice(14))), { status: 200 });
    return new Response('{"error":{"message":"no"}}', { status: 400 });
  }
  return new Response('{"message":"Not Found"}', { status: 404 });
};
async function cred(pw){
  const salt=new Uint8Array(16); crypto.getRandomValues(salt);
  const km=await crypto.subtle.importKey('raw',new TextEncoder().encode(pw),'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:100000,hash:'SHA-256'},km,256);
  const b=a=>Buffer.from(a).toString('base64');
  return { hash:b(new Uint8Array(bits)), salt:b(salt), iterations:100000 };
}
// A KV account an admin has put on free, a KV admin, and one from USERS.
kv.set('user:' + PAYER, JSON.stringify({ ...await cred('pw'), plan: 'free', earlyAccess: false }));
kv.set('user:' + ADMIN, JSON.stringify({ ...await cred('pw'), role: 'admin', plan: 'pro' }));
const WHSEC = 'whsec_test_secret';
const base = { AUTH_KV: KV, JWT_SECRET: 's', ALLOWED_ORIGINS: '*', GITHUB_OWNER: 'o', GITHUB_REPO: 'r', GITHUB_TOKEN: 't',
  USERS: JSON.stringify([{ email: ENVUSER, ...await cred('pw') }]) };
let env = { ...base };
const call = (p, o = {}) => worker.fetch(new Request('https://w' + p, {
  method: o.method || (o.body !== undefined || o.raw !== undefined ? 'POST' : 'GET'),
  headers: { 'Content-Type': 'application/json', ...(o.token ? { Authorization: 'Bearer ' + o.token } : {}), ...(o.headers || {}) },
  ...(o.raw !== undefined ? { body: o.raw } : o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) }), env, { waitUntil(){} });
const login = async (e) => (await (await call('/login', { body: { email: e, password: 'pw' } })).json()).token;
const j = async (r) => [r.status, await r.json().catch(() => null)];

async function sign(raw, t = Math.floor(Date.now() / 1000), secret = WHSEC) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${raw}`)));
  return `t=${t},v1=${[...mac].map(b => b.toString(16).padStart(2, '0')).join('')}`;
}
let evtN = 0;
const event = (type, object, created) => ({ id: 'evt_' + (++evtN), type, created: created || Math.floor(Date.now() / 1000), data: { object } });
const send = async (evt, sigOverride) => {
  const raw = JSON.stringify(evt);
  return call('/stripe/webhook', { raw, headers: { 'Stripe-Signature': sigOverride || await sign(raw) } });
};
const sub = (status, extra = {}) => ({ id: 'sub_1', object: 'subscription', customer: 'cus_1', status,
  metadata: { email: PAYER }, cancel_at_period_end: false, current_period_end: 1800000000,
  items: { data: [{ price: { id: 'price_m', recurring: { interval: 'month' } } }] }, ...extra });

let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p?'ok  ':'FAIL'} ${l.padEnd(62)} ${JSON.stringify(g)}${p?'':' expected '+JSON.stringify(w)}`); };

const payer = await login(PAYER), admin = await login(ADMIN), envUser = await login(ENVUSER);
const planOf = async (t) => { const [, b] = await j(await call('/billing', { token: t })); return [b.plan, b.paid]; };

console.log('\nswitched off, as shipped');
let [st, b] = await j(await call('/billing', { token: payer }));
ok('the account page is told there is nothing to show', [st, b.enabled, b.canSubscribe], [200, false, false]);
ok('a checkout is not there', (await call('/billing/checkout', { token: payer, body: { interval: 'month' } })).status, 404);
ok('nor is the webhook, with no secret set', (await send(event('ping', {}))).status, 404);
ok('and Stripe was never called', stripeCalls.length, 0);

console.log('\nfor admins only, to try it with test keys');
env = { ...base, BILLING: 'admins', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PRICE_MONTHLY: 'price_m', STRIPE_PRICE_YEARLY: 'price_y' };
ok('an ordinary account still sees nothing', (await j(await call('/billing', { token: payer })))[1].enabled, false);
ok('nor can it make a checkout', (await call('/billing/checkout', { token: payer, body: {} })).status, 404);
[st, b] = await j(await call('/billing', { token: admin }));
ok('an admin is offered both', [b.enabled, b.canSubscribe, b.intervals], [true, true, ['month', 'year']]);

console.log('\nswitched on');
env = { ...env, BILLING: 'on', STRIPE_WEBHOOK_SECRET: WHSEC, PUBLIC_BASE_URL: 'https://sendoff.run' };
ok('a USERS account cannot subscribe, having no record to put a plan on',
  [(await j(await call('/billing', { token: envUser })))[1].canSubscribe, (await call('/billing/checkout', { token: envUser, body: {} })).status], [false, 400]);
[st, b] = await j(await call('/billing/checkout', { token: payer, body: { interval: 'year' } }));
ok('a checkout hands back Stripe\'s page', [st, b.url], [200, 'https://checkout.stripe.com/c/pay/cs_1']);
const made = stripeCalls.at(-1);
ok('made with the secret key, for a subscription at the yearly price',
  [made.auth, made.body.get('mode'), made.body.get('line_items[0][price]')], ['Bearer sk_test_x', 'subscription', 'price_y']);
ok('tied to the account three ways', [made.body.get('client_reference_id'), made.body.get('metadata[email]'),
  made.body.get('subscription_data[metadata][email]'), made.body.get('customer_email')], [PAYER, PAYER, PAYER, PAYER]);
ok('and back to the profile page either way', [made.body.get('success_url'), made.body.get('cancel_url')],
  ['https://sendoff.run/profile?billing=done', 'https://sendoff.run/profile?billing=cancelled']);
ok('no tax line unless asked for', made.body.get('automatic_tax[enabled]'), null);

console.log('\nwhat Stripe says');
ok('an unsigned event is refused', (await call('/stripe/webhook', { raw: '{}' })).status, 400);
const forged = event('customer.subscription.created', sub('active'));
ok('so is one signed with the wrong secret', (await send(forged, await sign(JSON.stringify(forged), undefined, 'whsec_wrong'))).status, 400);
const replay = event('customer.subscription.created', sub('active'));
ok('and one signed long ago', (await send(replay, await sign(JSON.stringify(replay), Math.floor(Date.now() / 1000) - 3600))).status, 400);
ok('none of which moved the plan', await planOf(payer), ['free', false]);

subs.set('sub_1', sub('active'));
const t0 = Math.floor(Date.now() / 1000);
const done = event('checkout.session.completed', { object: 'checkout.session', mode: 'subscription', client_reference_id: PAYER,
  customer: 'cus_1', subscription: 'sub_1' }, t0);
ok('a finished checkout is taken', (await send(done)).status, 200);
ok('and the account is on Pro, paid', await planOf(payer), ['pro', true]);
[, b] = await j(await call('/billing', { token: payer }));
ok('with the subscription shown, and no second checkout offered',
  [b.subscription.status, b.subscription.interval, b.canSubscribe, b.canManage], ['active', 'month', false, true]);
ok('a second checkout is refused', (await call('/billing/checkout', { token: payer, body: {} })).status, 409);
ok('the Stripe customer now answers to the account', kv.get('stripecust:cus_1'), PAYER);

console.log('\nlate, twice, out of order');
const cancelOld = event('customer.subscription.updated', sub('canceled'), t0 - 60);
await send(cancelOld);
ok('an older event does not undo a newer one', await planOf(payer), ['pro', true]);
const dup = event('customer.subscription.deleted', sub('canceled'), t0 + 10);
kv.set('stripeevt:' + dup.id, '1');
await send(dup);
ok('an event already handled is not handled again', await planOf(payer), ['pro', true]);
const otherOld = event('customer.subscription.deleted', sub('canceled', { id: 'sub_0' }), t0 + 20);
await send(otherOld);
ok('an old subscription ending does not end the current one', await planOf(payer), ['pro', true]);
await send(event('customer.subscription.updated', sub('past_due'), t0 + 30));
ok('a failed renewal keeps Pro while Stripe retries', await planOf(payer), ['pro', true]);

console.log('\nan account with a live subscription');
ok('cannot be deleted from under it', (await call('/account/delete', { token: admin, body: { email: PAYER } })).status, 409);
[st, b] = await j(await call('/billing/portal', { token: payer, body: {} }));
ok('and can manage it on Stripe\'s page', [st, b.url, stripeCalls.at(-1).body.get('customer')],
  [200, 'https://billing.stripe.com/p/session/1', 'cus_1']);

console.log('\nwhen it ends');
await send(event('customer.subscription.deleted', sub('canceled'), t0 + 40));
ok('the plan goes back to the one an admin set, free here', await planOf(payer), ['free', false]);
ok('and the account page offers Pro again', (await j(await call('/billing', { token: payer })))[1].canSubscribe, true);
ok('with the customer kept, so paying again reuses it', (await call('/billing/checkout', { token: payer, body: {} }), stripeCalls.at(-1).body.get('customer')), 'cus_1');

console.log('\nswitched back off');
env = { ...base, STRIPE_SECRET_KEY: 'sk_test_x' };
[, b] = await j(await call('/billing', { token: payer }));
ok('somebody who has paid still sees their billing, to manage it', [b.enabled, b.canSubscribe, b.canManage], [true, false, true]);

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
