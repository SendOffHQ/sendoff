// What a write tells the people watching.
//
// One Durable Object per race holds every open socket for it, and the worker
// pokes it after a write has landed so a page re-reads instead of waiting out
// its poll. That poke used to fire for data.json and nothing else.
//
// Which meant a split woke every open page at once, and a settings change woke
// nothing. The pages re-read the config at most once a minute and only when a
// poll happens to fire, so an edit made the week of a race took up to two
// minutes to reach anybody, with nothing on screen to say it was coming.
// Reported on 2026-09-22: drop bags changed on Sangre de Cristo 100 and the
// race page went on showing the old ones.
//
// So the poke now names the file, and covers both.
//
//   node worker/test/live-push.mjs
import worker from '../src/worker.js';

const ME = 'owner@example.com';

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

const git = new Map();
let shaN = 0;
const b64 = s => Buffer.from(s, 'utf8').toString('base64');
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const m = u.match(/\/contents\/([^?]+)/);
  const path = m ? decodeURI(m[1]) : null;
  const method = opts.method || 'GET';
  if (/\/git\/trees\//.test(u)) return new Response(JSON.stringify({ tree: [] }), { status: 200 });
  if (path && method === 'GET') {
    const f = git.get(path);
    if (!f) return new Response('{"message":"Not Found"}', { status: 404 });
    return new Response(JSON.stringify({ content: b64(f.text), encoding: 'base64', sha: f.sha, path }),
      { status: 200 });
  }
  if (path && method === 'PUT') {
    const body = JSON.parse(opts.body || '{}');
    git.set(path, { text: Buffer.from(body.content, 'base64').toString('utf8'), sha: 'git-' + (++shaN) });
    return new Response(JSON.stringify({ content: { path, sha: 'git-' + shaN } }), { status: 200 });
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

// The Durable Object, as far as the worker can tell: a namespace that names
// one object per race, and an object that records what it was told.
const published = [];
const named = [];
const RACE_HUB = {
  idFromName(name) { named.push(name); return { name }; },
  get(id) {
    return {
      async fetch(url, init) {
        let body = null;
        try { body = JSON.parse((init && init.body) || 'null'); } catch (e) { body = 'unparseable'; }
        published.push({ to: id.name, body });
        return new Response('{"sent":1}', { status: 200 });
      }
    };
  }
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
  AUTH_KV: KV, DB, RACE_HUB, ALLOWED_ORIGINS:'*', JWT_SECRET:'s',
  PUBLIC_BASE_URL: 'https://sendoff.run',
  READ_FROM_D1: 'true', WRITE_TO_GIT: 'false',
  USERS: JSON.stringify([{ email: ME, ...await cred('pw') }]),
};

const token = await (async () => {
  const r = await worker.fetch(new Request('https://w/login', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ email: ME, password: 'pw' }) }), env);
  return (await r.json()).token;
})();

// waitUntil that actually waits. The push is deliberately outside the
// response, so a ctx that drops the promise would make every assertion below
// pass by never running the code it is about.
const pending = [];
const ctx = { waitUntil: (p) => { pending.push(p); } };
const settle = async () => { await Promise.allSettled(pending.splice(0)); };

// The version token the store is holding for this file, which is what a
// client that has just read it would send back. Without it the second write to
// any file is refused as a conflict and never reaches the push, which would
// have made every assertion below pass for the wrong reason.
const currentSha = (path) => {
  const m = path.match(/^races\/([^/]+)\/(config|data)\.json$/);
  if (!m) return null;
  const r = rows.get(m[1]);
  return r ? (r[m[2] === 'config' ? 'config_sha' : 'data_sha'] || null) : null;
};
const commit = async (path, content, e) => {
  const body = { path, content, message: 'test' };
  const sha = currentSha(path);
  if (sha) body.sha = sha;
  const r = await worker.fetch(new Request('https://w/commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(body)
  }), e || env, ctx);
  await settle();
  return r;
};
const put = (path, doc, e) => commit(path, JSON.stringify(doc, null, 2) + '\n', e);
const putRaw = (path, text) => commit(path, text);

let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p?'ok  ':'FAIL'} ${l.padEnd(56)} ${JSON.stringify(g)}${p?'':' expected '+JSON.stringify(w)}`); };
const drain = () => published.splice(0);

const SLUG = '000021-watched';
const race = {
  name: 'Watched Race', visibility: 'public', courseType: 'segments',
  course: { segments: [{ name: 'A to B', distanceMi: 5, toAid: 'Aid 1', dropBag: false }] },
  startTime: '2026-09-26T10:00:00.000Z', cutoffs: { totalHours: 38 },
  createdBy: ME, runners: [{ id: 'jd', name: 'Jason' }]
};

console.log('\nthe race is created');
ok('the config write succeeds', (await put(`races/${SLUG}/config.json`, race)).status, 200);
await put(`races/${SLUG}/data.json`, { runners: [{ id: 'jd', legs: [] }] });
drain();

console.log('\na split, which is what this always pushed');
let r = await put(`races/${SLUG}/data.json`, {
  runners: [{ id: 'jd', legs: [{ index: 1, startTime: '2026-09-26T10:00:00.000Z' }] }] });
// Checked, because a refused write pushes nothing either, and "no push" would
// then be the right answer to the wrong question.
ok('the write was taken', r.status, 200);
let sent = drain();
ok('one push', sent.length, 1);
let p0 = sent[0] || { to: null, body: {} };
ok('to this race', p0.to, SLUG);
ok('naming the file', p0.body.file, 'data.json');
ok('and saying only that something changed', p0.body.type, 'changed');
ok('with the race and a time', [p0.body.slug, typeof p0.body.at], [SLUG, 'string']);

// The report this exists for: drop bags edited in settings, and the race page
// going on showing the old ones.
console.log('\na settings change, which it used to swallow');
const edited = JSON.parse(JSON.stringify(race));
edited.course.segments[0].dropBag = true;
r = await put(`races/${SLUG}/config.json`, edited);
ok('the write was taken', r.status, 200);
sent = drain();
ok('is pushed too', sent.length, 1);
p0 = sent[0] || { to: null, body: {} };
ok('naming the file that moved', p0.body.file, 'config.json');
ok('to the same race', p0.to, SLUG);

console.log('\nand the drop bag really did change');
ok('the stored config carries it', JSON.parse(rows.get(SLUG).config).course.segments[0].dropBag, true);

console.log('\nwhat it still says nothing about');
r = await putRaw(`races/${SLUG}/course.gpx`, '<gpx></gpx>');
ok('the course upload was taken', r.status, 200);
ok('but pushes nothing', drain().length, 0);
r = await put('races/index.json', { races: [] });
ok('the manifest write was taken', r.status, 200);
ok('and nor does that', drain().length, 0);

console.log('\nan unlisted race, whose watchers are not a public set');
const HIDDEN = '000022-hidden';
await put(`races/${HIDDEN}/config.json`, { ...race, name: 'Hidden', visibility: 'private' });
await put(`races/${HIDDEN}/data.json`, { runners: [] });
drain();
r = await put(`races/${HIDDEN}/config.json`, { ...race, name: 'Hidden Renamed', visibility: 'private' });
ok('the write was taken', r.status, 200);
ok('but it is not pushed about', drain().length, 0);

console.log('\na deployment with no Durable Object bound');
const envNoHub = { ...env, RACE_HUB: undefined };
r = await put(`races/${SLUG}/config.json`, race, envNoHub);
ok('the write still succeeds', r.status, 200);
ok('and nothing was pushed', drain().length, 0);

console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
