// Two things that decide whether somebody can touch a race they did not make.
//
// The first is a bug that looked exactly like a permission decision. readAcl
// caught every failure and returned null, and null means "this race has no
// owner and no crew", so a KV that could not be asked refused a race to its
// own creator with "no write access on this race". It reproduced here as a
// race that accepted a write one moment and refused it the next with nothing
// changed in between, which is what was reported on 2026-09-24.
//
// The second is the admin override, asked for the same night: support was
// impossible without it, because helping somebody with a race meant asking
// them to add you to it, and somebody locked out of their own race could not.
//
//   node worker/test/admin-race-access.mjs
import worker from '../src/worker.js';

const OWNER = 'owner@example.com', ADMIN = 'admin@example.com', OUT = 'stranger@example.com';
const SLUG = 'r1';
// The shape a config has now: the roster moved to KV and createdBy went with
// it, so the stored file names nobody. That is what makes a lost access list
// unrecoverable rather than merely slow.
const storedCfg = { name: 'A race', visibility: 'private', course: { segments: [] } };

// Broken only for the access list, which is the read under test. Scoping it
// keeps the test about one thing: a KV that is down altogether also takes
// signing in with it, and that failure is neither silent nor confusable with a
// permission decision.
let kv, kvBroken = false;
const KV = {
  async get(k) {
    if (kvBroken && k.startsWith('acl:')) throw new Error('KV get() limit exceeded');
    return kv.has(k) ? kv.get(k) : null;
  },
  async put(k, v) { if (kvBroken && k.startsWith('acl:')) throw new Error('KV put() limit exceeded'); kv.set(k, v); },
  async delete(k) { kv.delete(k); },
  async list({ prefix }) { return { keys: [...kv.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) }; }
};
globalThis.caches = { default: { async match(){}, async put(){}, async delete(){ return true; } } };

// Enough D1 for the mirror's own copy of the roster, which is the fallback.
// peopleBroken breaks only the roster tables: the config still reads, which is
// the case that matters, because a config that cannot be read is a different
// failure with a different answer.
let dbRows, dbPeople, peopleBroken = false;
const DB = {
  prepare(sql) {
    return { sql, args: [],
      bind(...a) { return { ...this, args: a, bind: this.bind, all: this.all, run: this.run }; },
      async all() {
        if (/SELECT created_by FROM races/.test(this.sql)) {
          if (peopleBroken) throw new Error('D1 unavailable');
          const r = dbRows.get(this.args[0]);
          return { results: r ? [{ created_by: r.created_by }] : [] };
        }
        if (/SELECT email, role FROM race_people/.test(this.sql)) {
          if (peopleBroken) throw new Error('D1 unavailable');
          return { results: (dbPeople.get(this.args[0]) || []).slice() };
        }
        if (/SELECT config, config_sha, data, data_sha FROM races/.test(this.sql)) {
          const r = dbRows.get(this.args[0]);
          return { results: r ? [{ config: r.config, config_sha: r.config_sha, data: null, data_sha: null }] : [] };
        }
        if (/SELECT config, config_sha FROM races/.test(this.sql)) {
          const r = dbRows.get(this.args[0]);
          return { results: r ? [{ config: r.config, config_sha: r.config_sha }] : [] };
        }
        return { results: [] };
      },
      async run() { return { meta: { changes: 1 } }; }
    };
  },
  async batch(stmts) { return stmts.map(() => ({ meta: { changes: 1 } })); }
};

// A private race's course goes to the bucket rather than to a public repo, so
// without this every write below is refused for a reason that has nothing to
// do with who is asking.
const media = new Map();
const MEDIA = {
  async get(k) { return media.has(k) ? { etag: 'e', size: media.get(k).length, async text() { return media.get(k); } } : null; },
  async put(k, v) { media.set(k, v); },
  async delete(k) { media.delete(k); }
};

async function cred(pw) {
  const salt = new Uint8Array(16); crypto.getRandomValues(salt);
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name:'PBKDF2', salt, iterations:100000, hash:'SHA-256' }, km, 256);
  const b = a => Buffer.from(a).toString('base64');
  return { hash: b(new Uint8Array(bits)), salt: b(salt), iterations: 100000 };
}
const creds = {
  [OWNER]: { ...await cred('pw'), role: 'crew' },
  [ADMIN]: { ...await cred('pw'), role: 'admin' },
  [OUT]:   { ...await cred('pw'), role: 'crew' }
};
const baseEnv = {
  GITHUB_OWNER:'o', GITHUB_REPO:'r', GITHUB_TOKEN:'t', GITHUB_BRANCH:'main',
  AUTH_KV: KV, DB, MEDIA, ALLOWED_ORIGINS:'*', JWT_SECRET:'s',
  READ_FROM_D1: 'true', WRITE_TO_GIT: 'false',
  USERS: JSON.stringify(Object.entries(creds).map(([email, c]) => ({ email, ...c })))
};
let env = { ...baseEnv };

globalThis.fetch = async () => new Response('{"message":"Not Found"}', { status: 404 });

function reset() {
  kv = new Map();
  kvBroken = false; peopleBroken = false;
  env = { ...baseEnv };
  const config = JSON.stringify(storedCfg, null, 2) + '\n';
  dbRows = new Map([[SLUG, { slug: SLUG, config, config_sha: 'v1', created_by: OWNER }]]);
  dbPeople = new Map([[SLUG, []]]);
  kv.set('acl:' + SLUG, JSON.stringify({ createdBy: OWNER, people: [] }));
}

const call = (path, opts = {}) => worker.fetch(new Request('https://w' + path, {
  method: opts.method || (opts.body ? 'POST' : 'GET'),
  headers: { 'Content-Type':'application/json', ...(opts.token ? { Authorization: 'Bearer ' + opts.token } : {}) },
  ...(opts.body ? { body: JSON.stringify(opts.body) } : {}) }), env);
async function login(e) {
  const j = await (await call('/login', { body: { email: e, password: 'pw' } })).json();
  if (!j.token) throw new Error('login ' + e + ': ' + JSON.stringify(j));
  return j.token;
}
const writeCourse = (token) => call('/commit', { token, body: {
  path: `races/${SLUG}/course.gpx`, content: '<gpx/>', message: 'course' } });
const readConfig = (token) => call('/get?path=' + encodeURIComponent(`races/${SLUG}/config.json`), { token });
const roleSeenBy = async (token) => {
  const r = await readConfig(token);
  if (r.status !== 200) return `status ${r.status}`;
  return JSON.parse(Buffer.from((await r.json()).content, 'base64').toString('utf8')).myRole;
};

let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p ? 'ok  ' : 'FAIL'} ${l.padEnd(56)} ${JSON.stringify(g)}${p ? '' : ' want ' + JSON.stringify(w)}`); };

console.log('\nthe ordinary case, for something to compare against');
reset();
ok('the creator may write their race', (await writeCourse(await login(OWNER))).status, 200);
ok('a stranger may not', (await writeCourse(await login(OUT))).status, 403);

console.log('\nwhen the access list cannot be read at all');
reset();
const owner = await login(OWNER);
ok('the creator may write it', (await writeCourse(owner)).status, 200);
kvBroken = true;
// The mirror holds the same roster, written from KV on every config write, so
// nothing is lost: the race carries on working while KV is unreachable.
ok('and still may, from the mirror, when KV will not answer',
  (await writeCourse(owner)).status, 200);
ok('a stranger is still a stranger', (await writeCourse(await login(OUT))).status, 403);

console.log('\nand when neither store can answer, with the race itself readable');
reset();
const owner2 = await login(OWNER);
kvBroken = true; peopleBroken = true;
const dead = await writeCourse(owner2);
// The thing this must never be is 403. "No write access on this race" is a
// sentence about the person, and it sent somebody looking for a permission
// they had not lost. 503 is a sentence about the store, and the client's queue
// already holds a press on one and retries it.
ok('the answer is not a permission decision', dead.status, 503);
ok('and says what actually happened', /access list/.test((await dead.json()).error), true);

console.log('\na site admin, on a private race they are not on');
reset();
const admin = await login(ADMIN);
ok('may read it', (await readConfig(admin)).status, 200);
ok('is told why they may, and it is not that they own it', await roleSeenBy(admin), 'admin');
ok('may write it', (await writeCourse(admin)).status, 200);
ok('and may see the roster', (await call('/access?slug=' + SLUG, { token: admin })).status, 200);
ok('while the creator is still the creator', await roleSeenBy(await login(OWNER)), 'owner');

console.log('\nwith ADMIN_RACE_ACCESS="false", which is the whole of switching it back');
reset();
env.ADMIN_RACE_ACCESS = 'false';
const admin2 = await login(ADMIN);
ok('reading a private race is refused again', (await readConfig(admin2)).status, 403);
ok('and so is writing it', (await writeCourse(admin2)).status, 403);
ok('and the roster', (await call('/access?slug=' + SLUG, { token: admin2 })).status, 403);

console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
