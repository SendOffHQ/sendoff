// What "pending" means in the admin page's list of account invites.
//
// Reported: somebody accepted an invite, has an account, is using the hub, and
// their address still sat under Pending account invites.
//
// Accepting an account invite does delete its token, and always has. The list
// was answering a different question from the one being read off it: it said
// "a token row exists" where an admin reads "this person still has no
// account". Two things make those disagree.
//
// The first is a real gap. Accepting a *race* invite also creates an account,
// and it clears its own invite: token knowing nothing about an acct: token for
// the same person, so anybody sent both keeps one forever. That is the case
// this file is mostly about, because it is silent and permanent.
//
// The second is the same shape and needs no second account at all: generate an
// account invite twice for one address, accept either, and the other is
// orphaned. Easy to do by pressing the button again when the first mail is
// slow. Note that two live invites for one address are two rows on purpose,
// because Cancel revokes a token rather than an address; it is only once an
// account exists that both stop being pending.
//
// KV's list being eventually consistent looks like a third cause and is not:
// the listing already re-reads each key and skips the ones that are gone. That
// is asserted below so the guard is not removed as redundant.
//
// So pending is derived from whether the account exists. Both causes go with
// it, and so does any third nobody has thought of.
//
//   node worker/test/pending-invites.mjs
import worker from '../src/worker.js';

const ADMIN = 'admin@example.com';
const FRIEND = 'friend@example.com';

const kvStore = new Map();
// Set by the test to make list() lie the way the real one can: a key that has
// been deleted but is still being listed somewhere in the world.
let ghostKeys = [];
const KV = {
  async get(k) { const v = kvStore.get(k); return v === undefined ? null : v; },
  async put(k, v) { kvStore.set(k, v); },
  async delete(k) { kvStore.delete(k); },
  async list({ prefix } = {}) {
    const real = [...kvStore.keys()].filter(k => !prefix || k.startsWith(prefix));
    const ghosts = ghostKeys.filter(k => !prefix || k.startsWith(prefix));
    return { keys: [...new Set([...real, ...ghosts])].map(name => ({ name })), list_complete: true };
  },
};
globalThis.caches = { default: { async match(){}, async put(){}, async delete(){ return true; } } };
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://api.resend.com/')) return new Response('{"id":"x"}', { status: 200 });
  if (/\/git\/trees\//.test(u)) return new Response(JSON.stringify({ tree: [] }), { status: 200 });
  if ((opts.method || 'GET') === 'PUT') {
    return new Response(JSON.stringify({ content: { path: 'x', sha: 'git-x' } }), { status: 200 });
  }
  return new Response('{"message":"Not Found"}', { status: 404 });
};

const rows = new Map();
const DB = {
  prepare(sql) {
    return {
      sql, args: [],
      bind(...a) { return { ...this, args: a }; },
      async all() {
        if (/^SELECT slug FROM races$/.test(this.sql.trim())) {
          return { results: [...rows.values()].map(r => ({ slug: r.slug })) };
        }
        if (/SELECT config, config_sha FROM races/.test(this.sql)) {
          const r = rows.get(this.args[0]);
          return { results: r ? [{ config: r.config, config_sha: r.config_sha }] : [] };
        }
        if (/SELECT (slug|data) FROM races WHERE slug/.test(this.sql)) {
          const r = rows.get(this.args[0]);
          return { results: r ? [r] : [] };
        }
        return { results: [] };
      },
      async run() {
        const cas = this.sql.match(/UPDATE races SET (config_sha|data_sha) = \? WHERE slug = \? AND \((config_sha|data_sha) IS \? OR \2 IS NULL\)/);
        if (cas) {
          const [token, slug, expected] = this.args;
          const r = rows.get(slug);
          const cur = r ? (r[cas[1]] ?? null) : null;
          if (!r || (cur !== null && cur !== (expected ?? null))) return { meta: { changes: 0 } };
          r[cas[1]] = token;
          return { meta: { changes: 1 } };
        }
        const set = this.sql.match(/^UPDATE races SET (config_sha|data_sha) = \? WHERE slug = \?$/);
        if (set) { const r = rows.get(this.args[1]); if (r) r[set[1]] = this.args[0] ?? null; return { meta: { changes: 1 } }; }
        if (/INSERT INTO races/.test(this.sql)) {
          if (/config, config_sha, updated_at/.test(this.sql)) {
            const [slug, name, location, start, visibility, createdBy, config, sha] = this.args;
            const r = rows.get(slug) || { slug };
            Object.assign(r, { name, location, start_time: start, visibility, created_by: createdBy,
                               config, config_sha: sha ?? null });
            rows.set(slug, r);
          } else if (/data, data_sha, updated_at/.test(this.sql)) {
            const [slug, data, sha] = this.args;
            const r = rows.get(slug) || { slug, config: '{}', config_sha: null };
            Object.assign(r, { data, data_sha: sha ?? null });
            rows.set(slug, r);
          }
        }
        return { meta: { changes: 1 } };
      }
    };
  },
  async batch(stmts) { for (const st of stmts) await st.run(); return []; }
};

async function cred(pw) {
  const salt = new Uint8Array(16); crypto.getRandomValues(salt);
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name:'PBKDF2', salt, iterations:100000, hash:'SHA-256' }, km, 256);
  const b = a => Buffer.from(a).toString('base64');
  return { hash: b(new Uint8Array(bits)), salt: b(salt), iterations: 100000 };
}
const env = {
  GITHUB_OWNER:'o', GITHUB_REPO:'r', GITHUB_TOKEN:'t', GITHUB_BRANCH:'main',
  AUTH_KV: KV, DB, ALLOWED_ORIGINS:'*', JWT_SECRET:'s',
  PUBLIC_BASE_URL: 'https://sendoff.run',
  NOTIFY_FROM: 'invites@sendoff.run', INFO_FROM: 'info@sendoff.run',
  READ_FROM_D1: 'true', WRITE_TO_GIT: 'false',
  USERS: JSON.stringify([{ email: ADMIN, ...await cred('pw'), role: 'admin' }]),
};
const token = await (async () => {
  const r = await worker.fetch(new Request('https://w/login', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ email: ADMIN, password: 'pw' }) }), env);
  return (await r.json()).token;
})();
const call = (path, init = {}) => worker.fetch(new Request('https://w' + path, {
  ...init,
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }
}), env, { waitUntil: () => {} });
const open = (path, init = {}) => worker.fetch(new Request('https://w' + path, {
  ...init, headers: { 'Content-Type': 'application/json' }
}), env, { waitUntil: () => {} });

const pending = async () => ((await (await call('/accounts')).json()).pendingInvites || [])
  .map(i => i.email).sort();
const accounts = async () => ((await (await call('/accounts')).json()).accounts || [])
  .map(a => a.email).sort();

let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p?'ok  ':'FAIL'} ${l.padEnd(54)} ${JSON.stringify(g)}${p?'':' expected '+JSON.stringify(w)}`); };

console.log('\nan account invite is pending until it is taken up');
let r = await (await call('/account-invite', { method: 'POST',
  body: JSON.stringify({ email: FRIEND }) })).json();
ok('it shows in the list', await pending(), [FRIEND]);

console.log('\nand accepting it clears the row');
let acc = await (await open('/accept-account-invite', { method: 'POST',
  body: JSON.stringify({ token: r.token, password: 'a-good-password' }) })).json();
ok('the account was created', acc.accountCreated, true);
ok('they are an account now', await accounts(), [ADMIN, FRIEND].sort());
ok('and no longer pending', await pending(), []);

// The case that was silent and permanent. A race invite creates an account
// too, and clears a different key.
console.log('\nsomebody sent both an account invite and a race invite');
const SLUG = '000009-two-invites';
const OTHER = 'other@example.com';
await call('/commit', { method: 'POST', body: JSON.stringify({
  path: `races/${SLUG}/config.json`, message: 'test',
  content: JSON.stringify({ name: 'Two Invites', visibility: 'private', courseType: 'segments',
    course: { segments: [{ name: 'A', distanceMi: 5 }] },
    startTime: '2026-10-03T13:00:00.000Z', createdBy: ADMIN,
    runners: [{ id: 'r1', name: 'R', bib: '1' }] }, null, 2) + '\n' }) });
await call('/account-invite', { method: 'POST', body: JSON.stringify({ email: OTHER }) });
const raceInv = await (await call('/invite', { method: 'POST',
  body: JSON.stringify({ slug: SLUG, email: OTHER, role: 'crew' }) })).json();
ok('the account invite is pending', await pending(), [OTHER]);

console.log('\nand they use the race one, which is the one they were sent last');
acc = await (await open('/accept-invite', { method: 'POST',
  body: JSON.stringify({ token: raceInv.token, password: 'another-good-one' }) })).json();
ok('that created the account too', acc.accountCreated, true);
ok('they have an account', (await accounts()).includes(OTHER), true);
// Before this change the acct: token was still there and still listed, so an
// admin saw a pending invite for somebody already using the hub, for a
// fortnight, with nothing to press to make it go away.
ok('and nothing is left pending for them', await pending(), []);

// The same address invited twice, which is what pressing the button again when
// the first mail is slow does.
console.log('\nan address invited twice, then accepted once');
const TWICE = 'twice@example.com';
const first = await (await call('/account-invite', { method: 'POST',
  body: JSON.stringify({ email: TWICE }) })).json();
await call('/account-invite', { method: 'POST', body: JSON.stringify({ email: TWICE }) });
// Two rows, deliberately, and this is the one place the list should not
// collapse to one person. Two tokens were issued and both work; Cancel revokes
// a token, not an address, so hiding one would leave a live invite behind a
// row that looked dealt with. Ugly and correct beats tidy and wrong.
ok('both are shown, because both still work', await pending(), [TWICE, TWICE]);
await open('/accept-account-invite', { method: 'POST',
  body: JSON.stringify({ token: first.token, password: 'a-third-password' }) });
ok('and none once they have an account', await pending(), []);

// KV's list is eventually consistent: it can name a key that is already gone.
// Already handled by the re-read in the listing, and asserted so that guard is
// not taken out as redundant.
console.log("\nand when KV's listing is behind");
const third = await (await call('/account-invite', { method: 'POST',
  body: JSON.stringify({ email: 'third@example.com' }) })).json();
ok('pending while it truly is', await pending(), ['third@example.com']);
await open('/accept-account-invite', { method: 'POST',
  body: JSON.stringify({ token: third.token, password: 'yet-another-one' }) });
ghostKeys = ['acct:' + third.token];
ok('a listed-but-deleted key is not resurrected', await pending(), []);
ghostKeys = [];

// The list still has to do its actual job, or the fix is just a blank list.
console.log('\nand a real pending invite is still shown');
await call('/account-invite', { method: 'POST',
  body: JSON.stringify({ email: 'nobody@example.com' }) });
ok('somebody who has not accepted yet', await pending(), ['nobody@example.com']);
ok('with what the admin needs to chase it', await (async () => {
  const j = await (await call('/accounts')).json();
  const row = (j.pendingInvites || [])[0];
  return !!(row && row.email && row.token && row.expiresAt);
})(), true);

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
