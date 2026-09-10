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
let archived = false;          // whether the git stub should admit to holding files
const gitFiles = new Map();
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const m = u.match(/contents\/(.+?)(\?|$)/);
  const path = m ? decodeURIComponent(m[1]) : '';
  if ((opts.method || 'GET') === 'PUT') {
    gitPuts.push(path);
    const body = JSON.parse(opts.body);
    gitFiles.set(path, Buffer.from(body.content, 'base64').toString('utf8'));
    return new Response(JSON.stringify({ content: { path, sha: 'git-' + path } }), { status: 200 });
  }
  if (archived && gitFiles.has(path)) {
    return new Response(JSON.stringify({ sha: 'git-' + path,
      content: Buffer.from(gitFiles.get(path), 'utf8').toString('base64') }), { status: 200 });
  }
  return new Response('{"message":"Not Found"}', { status: 404 });
};

// A very small stand-in for D1: enough of prepare/bind/all/run/batch for the
// statements the worker actually issues against `races`.
const rows = new Map();
let batchSizes = [];
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
        if (/SELECT data FROM races WHERE slug/.test(this.sql)) {
          const r = rows.get(this.args[0]);
          return { results: r ? [{ data: r.data }] : [] };
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
        if (set) {
          const [val, slug] = this.args;
          const r = rows.get(slug); if (r) r[set[1]] = val ?? null;
          return { meta: { changes: r ? 1 : 0 } };
        }
        const nulled = this.sql.match(/UPDATE races SET (config_sha|data_sha) = NULL WHERE slug = \?/);
        if (nulled) {
          const r = rows.get(this.args[0]); if (r) r[nulled[1]] = null;
          return { meta: { changes: r ? 1 : 0 } };
        }
        if (/INSERT INTO races/.test(this.sql)) { applyInsert(this.sql, this.args); return { meta: { changes: 1 } }; }
        return { meta: { changes: 1 } };
      }
    };
  },
  async batch(stmts) { batchSizes.push(stmts.length); for (const st of stmts) await st.run(); return []; }
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

// ---------- the archive ----------
// The half that makes "git only for archive" true rather than half true.
// Nothing else commits race data with WRITE_TO_GIT off, so if this never
// fires the day's splits live in one place only.
const waits = [];
const wctx = { waitUntil: (p) => waits.push(p) };
const settle = async () => { await Promise.all(waits.splice(0)); };
const putW = (path, doc, sha) => worker.fetch(new Request('https://w/commit', {
  method:'POST', headers:{ 'Content-Type':'application/json', Authorization: 'Bearer ' + token },
  body: JSON.stringify({ path, content: JSON.stringify(doc, null, 2) + '\n', message: 'test', sha })
}), env, wctx);

console.log('\nan unfinished race is not archived');
gitPuts = [];
cur = await read('races/cas/data.json');
// Out on the leg, not through it. This course has one segment, so a leg with
// an endTime would already be a finish.
await putW('races/cas/data.json', { runners: [{ id:'jd', legs: [
  { index:1, startTime:'2026-10-03T13:00:00Z' } ] }] }, cur.sha);
await settle();
ok('git is left alone while the race is running', gitPuts, []);

console.log('\nand the finishing press puts it in the archive');
gitPuts = [];
cur = await read('races/cas/data.json');
// One segment on this course, so one completed leg is a finish.
await putW('races/cas/data.json', { runners: [{ id:'jd', legs: [
  { index:1, startTime:'2026-10-03T13:00:00Z', endTime:'2026-10-03T14:00:00Z' } ] }] }, cur.sha);
await settle();
ok('both files are committed', gitPuts.sort(), ['races/cas/config.json','races/cas/data.json']);

console.log('\nand archiving again with nothing changed commits nothing');
// Idempotent by comparing bytes, not by a marker: a marker has to be cleared
// for every correction filed after the finish, and forgetting is how an
// archive quietly stops matching the race.
gitPuts = [];
archived = true;
cur = await read('races/cas/data.json');
await putW('races/cas/data.json', JSON.parse(JSON.stringify(cur.doc)), cur.sha);
await settle();
ok('no second commit for the same bytes', gitPuts, []);

console.log('\na correction after the finish still gets through');
gitPuts = [];
cur = await read('races/cas/data.json');
await putW('races/cas/data.json', { runners: [{ id:'jd', legs: [
  { index:1, startTime:'2026-10-03T13:00:00Z', endTime:'2026-10-03T14:05:00Z' } ] }] }, cur.sha);
await settle();
ok('the corrected data is archived', gitPuts.includes('races/cas/data.json'), true);

console.log('\na race that exists only in the mirror is still writable');
// Two bugs meet here. handleCommit resolved the race config with a git-only
// lookup, so a race created after the flip, which has no config in git at all,
// answered "Race not found" to every write by anyone but the session that made
// it: a race the crew cannot work. And readFromD1 refuses a row whose version
// column is NULL, so that read fell through to git and the client came back
// holding a git blob sha that could never match the guard, which mutateJson
// would retry four times and give up on.
// readFromD1 refuses to serve a row whose version column is NULL, so that
// read fell through to git and the client is holding a git blob sha. Without
// the OR in the guard it could never match, and mutateJson would retry four
// times against the same answer and give up: a race nobody could write to.
rows.set('legacy', { slug: 'legacy', config: JSON.stringify({ ...race, createdBy: ME }),
                     config_sha: 'gitsha', data: '{"runners":[]}', data_sha: null });
ok('git has no config for it at all', gitFiles.has('races/legacy/config.json'), false);
ok('a git sha against a NULL column is taken, not refused',
  (await put('races/legacy/data.json', { runners: [{ id:'jd', legs: [] }] }, 'git-blob-sha')).status, 200);
ok('and the row now carries a version of ours', /^d1-/.test(rows.get('legacy').data_sha), true);
ok('after which a stale sha is refused again',
  (await put('races/legacy/data.json', { runners: [] }, 'git-blob-sha')).status, 409);

console.log('\na press costs the same whatever the roster looks like');
// The ceiling this removes: D1's free plan allows fifty queries per Worker
// invocation, and this used to write one statement per leg on the whole
// roster on every press. Three runners on a sixteen-leg course was the edge
// and four was over, which is a limit on how many people a crew can follow.
const bigRoster = { name: 'Big', visibility: 'public', courseType: 'segments',
  course: { segments: Array.from({ length: 16 }, (_, i) => ({ name: 'S' + i, distanceMi: 3 })) },
  startTime: '2026-10-03T13:00:00.000Z',
  runners: ['a','b','c','d','e'].map(id => ({ id, name: id, bib: id })) };
const fullDoc = (extra) => ({ runners: ['a','b','c','d','e'].map(id => ({ id,
  legs: Array.from({ length: 16 }, (_, i) => ({ index: i + 1,
    startTime: '2026-10-03T13:00:00Z',
    endTime: (id === 'a' && i === 0 && extra) ? extra : '2026-10-03T14:00:00Z' })) })) });

await put('races/big/config.json', bigRoster);
let c2 = await read('races/big/config.json');
// First data write: eighty legs, nothing stored yet, so all of them go.
await put('races/big/data.json', fullDoc());
batchSizes = [];
c2 = await read('races/big/data.json');
// One runner's one leg corrected. Everything else is byte-identical.
await put('races/big/data.json', fullDoc('2026-10-03T14:07:00Z'), c2.sha);
ok('eighty legs on the roster, one changed', batchSizes, [3]);
ok('which is well under the fifty-query ceiling', Math.max(...batchSizes) < 50, true);

console.log('\nand a leg that did not change is not rewritten');
batchSizes = [];
c2 = await read('races/big/data.json');
await put('races/big/data.json', JSON.parse(JSON.stringify(c2.doc)), c2.sha);
ok('nothing but the race row and the delete', batchSizes, [2]);

console.log('\nan unlisted race is never archived');
// The archive is a public git repository. Publishing an unlisted race when it
// finishes is the exact thing storage step 3 exists to stop, and it would have
// undone the whole point of taking git out of the write path.
gitPuts = [];
await put('races/quiet/config.json', { ...race, name: 'Quiet', visibility: 'private' });
cur = await read('races/quiet/data.json').catch(() => ({ sha: undefined }));
await putW('races/quiet/data.json', { runners: [{ id:'jd', legs: [
  { index:1, startTime:'2026-10-03T13:00:00Z', endTime:'2026-10-03T14:00:00Z' } ] }] }, cur.sha);
await settle();
ok('a finished unlisted race commits nothing', gitPuts, []);

console.log('\na press the database cannot store is not reported as landed');
// The worst failure available now that git is not written. mirrorToD1 stands
// down when it cannot keep up, dropping the sha so reads fall through to git,
// which was right while git held the write. It no longer does, so a swallowed
// failure would tell a crew member their split landed when it is nowhere.
const realBatch = DB.batch;
DB.batch = async () => { throw new Error('D1_ERROR: too many SQL variables'); };
cur = await read('races/cas/data.json');
const broke = await put('races/cas/data.json', { runners: [{ id:'jd', legs: [{ index:1 }] }] }, cur.sha);
ok('the crew are told it did not land', broke.status, 503);
DB.batch = realBatch;
// 503 is what the client's queue treats as transient, so the press is held on
// the phone and retried rather than lost. The stand-down nulls the version, so
// that retry meets a NULL and is taken.
ok('and the retry afterwards is accepted',
  (await put('races/cas/data.json', { runners: [{ id:'jd', legs: [{ index:1 }] }] }, cur.sha)).status, 200);

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
