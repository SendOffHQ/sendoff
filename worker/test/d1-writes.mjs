// Writing race data with git out of the path, behind WRITE_TO_GIT="false".
//
// The property this file exists for is the one git used to provide for free.
// Two crew members at the same aid station read the same file, and the second
// one to write must be told to re-read rather than quietly overwriting the
// first. GitHub did that with a blob sha; with git gone, the version columns
// do it, and if they do it wrong the failure is silent and costs somebody's
// splits.
//
//   node worker/test/d1-writes.mjs
import worker from '../src/worker.js';

const ME = 'owner@example.com';
const kvStore = new Map();
const KV = {
  async get(k) { const v = kvStore.get(k); return v === undefined ? null : v; },
  async put(k, v) { kvStore.set(k, v); },
  async delete(k) { kvStore.delete(k); },
};
globalThis.caches = { default: { async match(){}, async put(){}, async delete(){ return true; } } };

// git must not be touched at all for a race file. Anything that reaches here
// with a PUT is a bug this test is meant to catch.
let gitPuts = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const m = u.match(/contents\/(.+?)(\?|$)/);
  const path = m ? decodeURIComponent(m[1]) : '';
  if ((opts.method || 'GET') === 'PUT') { gitPuts.push(path); 
    return new Response(JSON.stringify({ content: { path, sha: 'git-' + path } }), { status: 200 }); }
  return new Response('{"message":"Not Found"}', { status: 404 });
};

// A very small stand-in for D1: enough of prepare/bind/all/run/batch for the
// statements the worker actually issues against `races`.
const rows = new Map();
const DB = {
  prepare(sql) {
    return {
      sql, args: [],
      bind(...a) { return { ...this, args: a, bind: this.bind, all: this.all, run: this.run }; },
      async all() {
        if (/SELECT slug FROM races WHERE slug/.test(this.sql)) {
          const r = rows.get(this.args[0]);
          return { results: r ? [{ slug: r.slug }] : [] };
        }
        if (/SELECT config, config_sha, data, data_sha FROM races/.test(this.sql)) {
          const r = rows.get(this.args[0]);
          return { results: r ? [r] : [] };
        }
        if (/SELECT config, config_sha FROM races/.test(this.sql)) {
          const r = rows.get(this.args[0]);
          return { results: r ? [{ config: r.config, config_sha: r.config_sha }] : [] };
        }
        return { results: [] };
      },
      async run() {
        const cas = this.sql.match(/UPDATE races SET (config_sha|data_sha) = \? WHERE slug = \? AND \1 IS \?/);
        if (cas) {
          const [token, slug, expected] = this.args;
          const r = rows.get(slug);
          const cur = r ? (r[cas[1]] ?? null) : null;
          if (!r || cur !== (expected ?? null)) return { meta: { changes: 0 } };
          r[cas[1]] = token;
          return { meta: { changes: 1 } };
        }
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
  READ_FROM_D1: 'true', WRITE_TO_GIT: 'false',
  USERS: JSON.stringify([{ email: ME, ...await cred('pw') }]),
};
const token = await (async () => {
  const r = await worker.fetch(new Request('https://w/login', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ email: ME, password: 'pw' }) }), env);
  return (await r.json()).token;
})();

const put = (path, doc, sha) => worker.fetch(new Request('https://w/commit', {
  method:'POST', headers:{ 'Content-Type':'application/json', Authorization: 'Bearer ' + token },
  body: JSON.stringify({ path, content: JSON.stringify(doc, null, 2) + '\n', message: 'test', sha })
}), env, { waitUntil: () => {} });

const read = async (path) => {
  const r = await worker.fetch(new Request('https://w/get?path=' + encodeURIComponent(path),
    { headers: { Authorization: 'Bearer ' + token } }), env, { waitUntil: () => {} });
  const j = await r.json();
  return { sha: j.sha, doc: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')) };
};

let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p?'ok  ':'FAIL'} ${l.padEnd(54)} ${JSON.stringify(g)}${p?'':' expected '+JSON.stringify(w)}`); };

const race = { name: 'CAS Race', visibility: 'public', courseType: 'segments',
  course: { segments: [{ name: 'A to B', distanceMi: 5 }] },
  startTime: '2026-10-03T13:00:00.000Z', runners: [{ id: 'jd', name: 'Jason', bib: '1' }] };

console.log('\na race is created and written without touching git');
gitPuts = [];
ok('creating the config succeeds', (await put('races/cas/config.json', race)).status, 200);
ok('and the first data write too', (await put('races/cas/data.json', { runners: [{ id:'jd', legs: [] }] })).status, 200);
ok('git was never asked to store any of it', gitPuts, []);

console.log('\nand a read hands back a token to write with');
let cur = await read('races/cas/data.json');
ok('there is a version to echo', /^d1-/.test(cur.sha), true);
ok('and it is not a git sha', /^git-/.test(cur.sha), false);

console.log('\ntwo crew members, one aid station');
// Both read the same version. The first press wins; the second must be told.
const shared = cur.sha;
const first = await put('races/cas/data.json', { runners: [{ id:'jd', legs: [{ index:1 }] }] }, shared);
const second = await put('races/cas/data.json', { runners: [{ id:'jd', legs: [{ index:9 }] }] }, shared);
ok('the first press lands', first.status, 200);
ok('the second is refused, not silently applied', second.status, 409);
cur = await read('races/cas/data.json');
ok('and the first press is what survived', cur.doc.runners[0].legs[0].index, 1);

console.log('\nthe loser re-reads and gets through');
const retry = await put('races/cas/data.json', { runners: [{ id:'jd', legs: [{ index:1 },{ index:2 }] }] }, cur.sha);
ok('the retry lands', retry.status, 200);
ok('with both legs', (await read('races/cas/data.json')).doc.runners[0].legs.length, 2);

console.log('\na stale token never works again');
ok('the version it replaced', (await put('races/cas/data.json', { runners: [] }, shared)).status, 409);
ok('and a token nobody issued', (await put('races/cas/data.json', { runners: [] }, 'd1-made-up')).status, 409);

console.log('\ngit is still the place for everything else');
gitPuts = [];
await worker.fetch(new Request('https://w/commit', {
  method:'POST', headers:{ 'Content-Type':'application/json', Authorization: 'Bearer ' + token },
  body: JSON.stringify({ path: 'races/index.json', content: '{"races":[]}\n', message: 'manifest' })
}), env, { waitUntil: () => {} });
ok('the hub manifest still goes to git', gitPuts, ['races/index.json']);

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
