// A race made after git stopped being written, opened by the person who made
// it.
//
// On 2026-09-13 a race was created and Manage access answered "Could not load
// access: Race not found" to its own creator. The race existed, the creator
// was on it, and the panel could not see either: the roster read went through
// a git-only config lookup, and with WRITE_TO_GIT="false" that race's config
// is in the mirror and nowhere else.
//
// It was never only Manage access. The same git-only lookup stood behind
// invites, share links, team invites, teammate profiles, the live push, the
// hub's list of private races and the race-number counter. The counter is the
// one that does damage quietly: a new race it cannot see is a number handed
// out twice.
//
// So this file is a race that exists only in the mirror, and every one of
// those asked about it. git is present and answers 404 for everything, which
// is exactly what git does for a race it was never sent.
//
//   node worker/test/race-after-flip.mjs
import worker from '../src/worker.js';

const ME = 'owner@example.com';
const MATE = 'crew@example.com';

const kvStore = new Map();
const KV = {
  async get(k) { const v = kvStore.get(k); return v === undefined ? null : v; },
  async put(k, v) { kvStore.set(k, v); },
  async delete(k) { kvStore.delete(k); },
  async list({ prefix, cursor } = {}) {
    return { keys: [...kvStore.keys()].filter(k => !prefix || k.startsWith(prefix)).map(name => ({ name })),
             list_complete: true };
  },
};
globalThis.caches = { default: { async match(){}, async put(){}, async delete(){ return true; } } };

// git holds nothing and says so. A tree listing of a repository with no races
// in it is an empty tree, not a failure, so the only place a slug can come
// from here is the mirror.
let treeOk = true;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (/\/git\/trees\//.test(u)) {
    return treeOk ? new Response(JSON.stringify({ tree: [] }), { status: 200 })
                  : new Response('nope', { status: 500 });
  }
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
        if (/SELECT slug FROM races WHERE slug/.test(this.sql)) {
          const r = rows.get(this.args[0]);
          return { results: r ? [{ slug: r.slug }] : [] };
        }
        if (/SELECT config, config_sha FROM races/.test(this.sql)) {
          const r = rows.get(this.args[0]);
          return { results: r ? [{ config: r.config, config_sha: r.config_sha }] : [] };
        }
        if (/SELECT data FROM races WHERE slug/.test(this.sql)) {
          const r = rows.get(this.args[0]);
          return { results: r ? [{ data: r.data }] : [] };
        }
        if (/SELECT config, config_sha, data, data_sha FROM races/.test(this.sql)) {
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
        if (/INSERT INTO races/.test(this.sql)) { applyInsert(this.sql, this.args); return { meta: { changes: 1 } }; }
        return { meta: { changes: 1 } };
      }
    };
  },
  async batch(stmts) { for (const st of stmts) await st.run(); return []; }
};
function applyInsert(sql, args) {
  if (/config, config_sha, updated_at/.test(sql)) {
    const [slug, name, location, start, visibility, createdBy, config, sha] = args;
    const r = rows.get(slug) || { slug };
    Object.assign(r, { name, location, start_time: start, visibility, created_by: createdBy,
                       config, config_sha: sha ?? null });
    rows.set(slug, r);
  } else if (/data, data_sha, updated_at/.test(sql)) {
    const [slug, data, sha] = args;
    const r = rows.get(slug) || { slug, config: '{}', config_sha: null };
    Object.assign(r, { data, data_sha: sha ?? null });
    rows.set(slug, r);
  }
}

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
  READ_FROM_D1: 'true', WRITE_TO_GIT: 'false',
  USERS: JSON.stringify([{ email: ME, ...await cred('pw') },
                         { email: MATE, ...await cred('pw') }]),
};
const login = async (email) => {
  const r = await worker.fetch(new Request('https://w/login', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ email, password: 'pw' }) }), env);
  return (await r.json()).token;
};
const token = await login(ME);
const mateToken = await login(MATE);

const call = (path, tok, init = {}) => worker.fetch(new Request('https://w' + path, {
  ...init,
  headers: Object.assign({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + (tok || token) },
                         init.headers || {})
}), env, { waitUntil: () => {} });
const put = (path, doc) => call('/commit', token, { method: 'POST',
  body: JSON.stringify({ path, content: JSON.stringify(doc, null, 2) + '\n', message: 'test' }) });

let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p?'ok  ':'FAIL'} ${l.padEnd(54)} ${JSON.stringify(g)}${p?'':' expected '+JSON.stringify(w)}`); };

const SLUG = '000042-after-the-flip';
const race = {
  name: 'After The Flip', visibility: 'private', courseType: 'segments',
  course: { segments: [{ name: 'Start to Aid 1', distanceMi: 5 }] },
  startTime: '2026-10-03T13:00:00.000Z',
  createdBy: ME, people: [{ email: MATE, role: 'crew' }],
  runners: [{ id: 'jd', name: 'Jason', bib: '1' }]
};

console.log('\nthe race is created, and lands only in the mirror');
ok('the config write succeeds', (await put(`races/${SLUG}/config.json`, race)).status, 200);
await put(`races/${SLUG}/data.json`, { runners: [{ id: 'jd', legs: [] }] });
ok('git holds no config for it', rows.has(SLUG) && true, true);

// The thing the report was about. Manage access is a read, which is why it
// kept the git-only loader long after the write path stopped using it.
console.log('\nManage access, by the person who made the race');
let r = await call('/access?slug=' + SLUG, token);
let j = await r.json();
ok('it answers', r.status, 200);
ok('and not "Race not found"', j.error || null, null);
ok('naming the creator', (j.createdBy || '').toLowerCase(), ME);
ok('who is allowed to manage it', j.canManageAccess, true);
ok('and the crew member they added', (j.people || []).some(p =>
  (p.email || '').toLowerCase() === MATE), true);

console.log('\nand by the crew member, who can write but not manage');
r = await call('/access?slug=' + SLUG, mateToken);
ok('they can read the roster', r.status, 200);

console.log('\ninviting somebody onto it');
r = await call('/invite', token, { method: 'POST',
  body: JSON.stringify({ slug: SLUG, email: 'new@example.com', role: 'crew' }) });
j = await r.json();
ok('the invite is issued', r.status, 200);
ok('and not refused as a missing race', j.error || null, null);

console.log('\na share link for it');
r = await call('/share-link', token, { method: 'POST', body: JSON.stringify({ slug: SLUG, role: 'view' }) });
ok('is made', r.status, 200);

console.log('\nletting the team invite');
r = await call('/access/team-invite', token, { method: 'POST',
  body: JSON.stringify({ slug: SLUG, allowed: true }) });
j = await r.json();
ok('the setting takes', [r.status, j.teamCanInvite], [200, true]);

console.log('\nreading a teammate profile, which is gated on the race');
r = await call('/profile?email=' + encodeURIComponent(MATE) + '&slug=' + SLUG, token);
ok('the gate opens', r.status, 200);

// A private race is not in the manifest by design, so the hub can only find it
// by enumerating races. Enumerating git alone finds nothing here.
console.log('\nthe hub, which is where the creator goes looking for it');
r = await call('/my-races', token);
j = await r.json();
ok('the race is listed', (j.races || []).map(x => x.slug), [SLUG]);
ok('as theirs', (j.races || [])[0] && (j.races || [])[0].mine, true);

console.log('\nand for the crew member it is on');
j = await (await call('/my-races', mateToken)).json();
ok('they see it too', (j.races || []).map(x => x.slug), [SLUG]);

// The quiet one. The counter takes the highest prefix in use and adds one; a
// race it cannot see is a number given out a second time, and two races that
// collide on a slug is not a thing anybody notices until it has happened.
console.log('\nthe next race number');
j = await (await call('/next-race-id', token)).json();
ok('counts past the race it cannot see in git', j.id, '000043');

// git failing should not turn the hub into an empty page when the mirror is
// holding every race anyway.
console.log('\nand when the tree listing fails outright');
treeOk = false;
j = await (await call('/my-races', token)).json();
ok('the mirror still answers', (j.races || []).map(x => x.slug), [SLUG]);
j = await (await call('/next-race-id', token)).json();
ok('and the counter still counts', j.id, '000043');
treeOk = true;

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
