// What to call somebody, now that a profile holds a real name as well as the
// one their crew sees.
//
// Three fields, and the point is that they answer different questions. First
// and last are who you are. "Name your crew will see" is what the board says,
// which is not always the same: a nickname, or just a first name where two
// people on the race share one.
//
// The rule is that the chosen name wins outright and the real name stands in
// when it is blank. Getting that backwards would quietly rename people on
// their own crew's board, which is the sort of thing nobody reports and
// everybody notices.
//
// And blank means blank. Guessing a name off the address, which is what the
// roster does as a last resort on the client, must not happen here: a stored
// profile that claims somebody is called "jdupree" is worse than one that says
// it does not know, because only the second can be told apart from a name.
//
//   node worker/test/profile-name.mjs
import worker from '../src/worker.js';

const ME = 'jason@example.com';
const MATE = 'crew@example.com';

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
globalThis.fetch = async (url, opts = {}) => {
  if (/\/git\/trees\//.test(String(url))) return new Response(JSON.stringify({ tree: [] }), { status: 200 });
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
          const [tok, slug, expected] = this.args;
          const r = rows.get(slug);
          const cur = r ? (r[cas[1]] ?? null) : null;
          if (!r || (cur !== null && cur !== (expected ?? null))) return { meta: { changes: 0 } };
          r[cas[1]] = tok;
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
const creds = await cred('pw');
const env = {
  GITHUB_OWNER:'o', GITHUB_REPO:'r', GITHUB_TOKEN:'t', GITHUB_BRANCH:'main',
  AUTH_KV: KV, DB, ALLOWED_ORIGINS:'*', JWT_SECRET:'s',
  PUBLIC_BASE_URL: 'https://sendoff.run',
  READ_FROM_D1: 'true', WRITE_TO_GIT: 'false',
  USERS: JSON.stringify([{ email: ME, ...creds }, { email: MATE, ...creds }]),
};
const login = async (email) => {
  const r = await worker.fetch(new Request('https://w/login', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ email, password: 'pw' }) }), env);
  return (await r.json()).token;
};
const mine = await login(ME);
const theirs = await login(MATE);
const call = (path, tok, init = {}) => worker.fetch(new Request('https://w' + path, {
  ...init, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (tok || mine) }
}), env, { waitUntil: () => {} });

const save = (body, tok) => call('/profile', tok, { method: 'POST', body: JSON.stringify(body) });
const read = async (tok) => (await (await call('/profile', tok)).json()).profile;

let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p?'ok  ':'FAIL'} ${l.padEnd(54)} ${JSON.stringify(g)}${p?'':' expected '+JSON.stringify(w)}`); };

console.log('\na profile that has never been filled in');
let p = await read(mine);
ok('has the fields, empty', [p.firstName, p.lastName, p.displayName], ['', '', '']);

console.log('\nand the three are stored and handed back');
await save({ firstName: 'Jason', lastName: 'Dupree', displayName: 'JD' }, mine);
p = await read(mine);
ok('all three', [p.firstName, p.lastName, p.displayName], ['Jason', 'Dupree', 'JD']);

console.log('\nthey are trimmed and cannot be used to store a novel');
await save({ firstName: '  Jason  ', lastName: 'D'.repeat(200), displayName: '' }, mine);
p = await read(mine);
ok('trimmed', p.firstName, 'Jason');
ok('capped at 80', p.lastName.length, 80);

console.log('\nand anything that is not text is simply not a name');
await save({ firstName: { evil: true }, lastName: ['nope'], displayName: 42 }, mine);
p = await read(mine);
ok('all blank rather than stringified', [p.firstName, p.lastName, p.displayName], ['', '', '']);

// The rule, on the endpoint that actually shows a name to a crew.
const SLUG = '000011-naming';
await call('/commit', mine, { method: 'POST', body: JSON.stringify({
  path: `races/${SLUG}/config.json`, message: 'test',
  content: JSON.stringify({ name: 'Naming', visibility: 'private', courseType: 'segments',
    course: { segments: [{ name: 'A', distanceMi: 5 }] },
    startTime: '2026-10-03T13:00:00.000Z', createdBy: ME,
    people: [{ email: MATE, role: 'crew' }],
    runners: [{ id: 'r1', name: 'R', bib: '1' }] }, null, 2) + '\n' }) });

const shownFor = async (email) => {
  const s = await (await call('/access?slug=' + SLUG, mine)).json();
  if (email === ME) return s.createdByName;
  return ((s.people || []).find(x => x.email === email) || {}).displayName;
};

console.log('\nthe name a crew sees, with only a real name filled in');
await save({ firstName: 'Jason', lastName: 'Dupree' }, mine);
ok('first and last, joined', await shownFor(ME), 'Jason Dupree');

console.log('\nand once they choose what the board should say');
await save({ firstName: 'Jason', lastName: 'Dupree', displayName: 'JD' }, mine);
ok('the chosen one wins outright', await shownFor(ME), 'JD');

console.log('\nwith only half a real name');
await save({ firstName: 'Jason' }, mine);
ok('no trailing space where the surname is not', await shownFor(ME), 'Jason');
await save({ lastName: 'Dupree' }, mine);
ok('and a surname alone is still a name', await shownFor(ME), 'Dupree');

console.log('\nand with nothing at all');
await save({}, mine);
ok('it says it does not know', await shownFor(ME), '');

console.log('\neverybody on the roster gets the same rule');
await save({ firstName: 'Casey', lastName: 'Kim' }, theirs);
ok('not just the person asking', await shownFor(MATE), 'Casey Kim');

// The gate on reading somebody else's profile is unchanged by any of this and
// is worth holding: these fields are a person's actual name.
console.log('\nand a teammate profile is still gated on the race');
let r = await call('/profile?email=' + encodeURIComponent(MATE) + '&slug=' + SLUG, mine);
ok('somebody on the race may read it', r.status, 200);
ok('and sees the name fields', (await r.json()).profile.firstName, 'Casey');
r = await call('/profile?email=' + encodeURIComponent(MATE), mine);
ok('naming no race is refused', r.status, 400);
r = await call('/profile?email=' + encodeURIComponent(MATE) + '&slug=nope-not-a-race', mine);
ok('and naming one you are not on is not a way in', r.status === 403 || r.status === 404, true);

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
