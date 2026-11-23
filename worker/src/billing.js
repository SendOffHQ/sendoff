// Paying for Pro, through Stripe (set up 2026-11-23, switched off).
//
// Stripe hosts both pages a person pays or cancels on (Checkout and the
// customer portal), so SendOff never sees a card. What SendOff keeps is who
// is paying and whether that is current: a billing record per account, under
// its own KV key rather than on the user record that holds the password hash,
// and one field on the user record, paidPlan, which is all the plan check
// reads (entitlementsFor in worker.js).
//
// Off unless BILLING is "on" (everybody) or "admins" (only site admins see
// it, for trying it end to end with test keys before anybody else does), and
// the keys are set. With it off, every billing route answers as if it were
// not there and the pages draw nothing. The webhook is the exception: it
// listens whenever STRIPE_WEBHOOK_SECRET is set, so a payment made while
// testing is never lost.
//
// What is a secret and what is not:
//   STRIPE_SECRET_KEY      secret   sk_test_... or sk_live_...
//   STRIPE_WEBHOOK_SECRET  secret   whsec_... from the webhook endpoint
//   STRIPE_PRICE_MONTHLY   var      price_... for Pro by the month
//   STRIPE_PRICE_YEARLY    var      price_... for Pro by the year (optional)
//   STRIPE_TAX             var      "true" to have Stripe Tax work out tax
//   BILLING                var      "off" (default), "admins" or "on"
//
// The setup steps are in ROADMAP.md under Billing.

// The statuses a subscription can be in that keep Pro. past_due is in: Stripe
// is retrying the card, and taking somebody's private race away the hour a
// renewal bounced, possibly mid-race, would be the wrong way round. Stripe
// moves it on to unpaid or canceled when the retries run out.
const PAID = new Set(['active', 'trialing', 'past_due']);

export function paidStatus(status) { return PAID.has(String(status || '')); }

export function mode(env) {
  const m = String((env && env.BILLING) || 'off').toLowerCase();
  return m === 'on' || m === 'admins' ? m : 'off';
}

// Whether billing is open to this session: switched on for them and able to
// make a checkout at all.
export function openTo(env, session) {
  const m = mode(env);
  if (m === 'off' || !env.STRIPE_SECRET_KEY || !env.STRIPE_PRICE_MONTHLY) return false;
  return m === 'on' || !!(session && session.role === 'admin');
}

export function prices(env) {
  const out = {};
  if (env.STRIPE_PRICE_MONTHLY) out.month = env.STRIPE_PRICE_MONTHLY;
  if (env.STRIPE_PRICE_YEARLY) out.year = env.STRIPE_PRICE_YEARLY;
  return out;
}

// Stripe's API takes form encoding with brackets for nesting.
export function form(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') form(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.join('&');
}

export async function stripe(env, path, body) {
  const res = await fetch('https://api.stripe.com/v1/' + path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': '2024-06-20'
    },
    body: form(body)
  });
  let j = null;
  try { j = await res.json(); } catch (e) {}
  if (!res.ok) {
    const msg = (j && j.error && j.error.message) || `Stripe answered ${res.status}`;
    throw Object.assign(new Error(msg), { status: 502 });
  }
  return j;
}

// The Checkout session: Pro by the month or the year, for this account. The
// account's address goes in three places so every later event can be tied
// back to it whichever object it carries: the session, the subscription's
// metadata, and (for somebody who has paid before) the customer itself.
export function checkoutBody(env, { email, customerId, interval, base }) {
  const price = prices(env)[interval];
  return {
    mode: 'subscription',
    'line_items[0][price]': price,
    'line_items[0][quantity]': 1,
    client_reference_id: email,
    ...(customerId ? { customer: customerId } : { customer_email: email }),
    metadata: { email },
    subscription_data: { metadata: { email } },
    allow_promotion_codes: 'true',
    ...(String(env.STRIPE_TAX) === 'true'
      ? { 'automatic_tax[enabled]': 'true', ...(customerId ? { 'customer_update[address]': 'auto' } : {}) } : {}),
    success_url: `${base}/profile?billing=done`,
    cancel_url: `${base}/profile?billing=cancelled`
  };
}

// Stripe-Signature: t=<seconds>,v1=<hex>[,v1=<hex>]. The signed text is
// "<t>.<raw body>", HMAC-SHA256 with the endpoint's secret. Five minutes
// either way, so a recorded event cannot be replayed later.
export async function verify(rawBody, header, secret, nowMs = Date.now(), toleranceSec = 300) {
  if (!header || !secret) return false;
  const parts = String(header).split(',').map(s => s.trim().split('='));
  const t = (parts.find(p => p[0] === 't') || [])[1];
  const sigs = parts.filter(p => p[0] === 'v1').map(p => p[1]).filter(Boolean);
  if (!t || !sigs.length || !/^\d+$/.test(t)) return false;
  if (Math.abs(nowMs / 1000 - +t) > toleranceSec) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${rawBody}`)));
  const want = [...mac].map(b => b.toString(16).padStart(2, '0')).join('');
  // Compared in full, every time, so the time taken says nothing about how
  // much of a forged signature was right.
  return sigs.some(s => {
    if (s.length !== want.length) return false;
    let diff = 0;
    for (let i = 0; i < s.length; i++) diff |= s.charCodeAt(i) ^ want.charCodeAt(i);
    return diff === 0;
  });
}

// A subscription, as the billing record keeps it.
export function fromSubscription(sub) {
  const item = sub && sub.items && sub.items.data && sub.items.data[0];
  const price = item && item.price;
  // current_period_end moved onto the item in newer API versions.
  const end = (sub && sub.current_period_end) || (item && item.current_period_end) || null;
  return {
    customerId: typeof sub.customer === 'string' ? sub.customer : (sub.customer && sub.customer.id) || null,
    subscriptionId: sub.id || null,
    status: sub.status || null,
    priceId: (price && price.id) || null,
    interval: (price && price.recurring && price.recurring.interval) || null,
    currentPeriodEnd: end ? new Date(end * 1000).toISOString() : null,
    cancelAtPeriodEnd: !!sub.cancel_at_period_end
  };
}
