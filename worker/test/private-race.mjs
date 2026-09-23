// A race created unlisted is not published anywhere.
//
// Asked plainly on 2026-09-23: "would it actually be private if created as
// so?" The answer was worth a test rather than a reading of the code, because
// it is a promise made to somebody about their own race, and because the
// surfaces are spread out: a repository, a bucket, a manifest, a share page, a
// chat webhook, a websocket and four endpoints. Any one of them left open
// makes the other six irrelevant.
//
// So this creates one the way the wizard does, with production's flags
// (WRITE_TO_GIT off, D1 bound), and then asks every surface in turn.
//
// One of them was open when this was written. /commit took any filename under
// races/<slug>/: config.json and data.json go to the database and course.gpx
// of a non-public race goes to the bucket, and a file with a fourth name fell
// through all of that into the public repository with its bytes intact.
// Nothing in the app writes one, so nothing exercised it. isRacePath is a
// whitelist now, and the last section here is what says so.
//
//   node worker/test/private-race.mjs
import worker from '../src/worker.js';

const ME = 'owner@example.com';
const MATE = 'crew@example.com';
const STRANGER = 'nobody@example.com';
const POOR = 'free@example.com';
const BOSS = 'admin@example.com';
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

// R2, as much of it as the course move uses.
const bucket = new Map();
const MEDIA = {
  async put(k, v) { bucket.set(k, String(v)); },
  async get(k) { const v = bucket.get(k); return v === undefined ? null : { async text() { return v; } }; },
  async delete(k) { bucket.delete(k); },
};

// git, holding the two files that stay in git after the flip: the manifest and
// the course. Everything else 404s, which is what git does for a race that was
// only ever written to the mirror.
const git = new Map();
let shaN = 0;
const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const posted = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://discord.example/')) {
    posted.push(String((opts && opts.body) || ''));
    return new Response('', { status: 204 });
  }
  const m = u.match(/\/contents\/([^?]+)/);
  const path = m ? decodeURI(m[1]) : null;
  const method = opts.method || 'GET';

  if (/\/git\/trees\//.test(u)) return new Response(JSON.stringify({ tree: [] }), { status: 200 });

  if (path && method === 'GET') {
    const f = git.get(path);
    if (!f) return new Response('{"message":"Not Found"}', { status: 404 });
    // Over a megabyte GitHub stops inlining the blob: empty content, encoding
    // "none", sha still there. A detailed GPX reaches that, so it is modelled.
    if (f.huge) {
      return new Response(JSON.stringify({ content: '', encoding: 'none', sha: f.sha, path }),
        { status: 200 });
    }
    return new Response(JSON.stringify({ content: b64(f.text), encoding: 'base64', sha: f.sha, path }),
      { status: 200 });
  }
  if (path && method === 'PUT') {
    const body = JSON.parse(opts.body || '{}');
    const cur = git.get(path);
    // The same sha check the real API makes, because mutateJsonAt's retry is
    // built on it.
    if (cur && body.sha && body.sha !== cur.sha) {
      return new Response('{"message":"conflict"}', { status: 409 });
    }
    const text = Buffer.from(body.content, 'base64').toString('utf8');
    const sha = 'git-' + (++shaN);
    git.set(path, { text, sha });
    return new Response(JSON.stringify({ content: { path, sha } }), { status: 200 });
  }
  if (path && method === 'DELETE') {
    git.delete(path);
    return new Response('{}', { status: 200 });
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
const creds = await cred('pw');
const env = {
  GITHUB_OWNER:'o', GITHUB_REPO:'r', GITHUB_TOKEN:'t', GITHUB_BRANCH:'main',
  AUTH_KV: KV, DB, MEDIA, ALLOWED_ORIGINS:'*', JWT_SECRET:'s',
  PUBLIC_BASE_URL: 'https://sendoff.run',
  READ_FROM_D1: 'true', WRITE_TO_GIT: 'false',
  USERS: JSON.stringify([{ email: ME, ...creds }, { email: MATE, ...creds },
                         { email: STRANGER, ...creds }]),
  // A webhook that records instead of posting, so "the chat was told nothing"
  // is a check and not an absence of configuration.
  DISCORD_WEBHOOK: 'https://discord.example/hook',
  // Bound, so "the live push refuses this race" is the refusal being checked
  // and not the push being switched off.
  RACE_HUB: { idFromName: (n) => ({ name: n }),
              get: () => ({ async fetch() { return new Response('{"sent":0}', { status: 200 }); } }) },
};
// A free account with no grandfathering, which is the only way to be without
// private races: DEFAULT_PLAN is pro and env users are early-access by default.
kvStore.set('user:' + POOR, JSON.stringify({ ...creds, plan: 'free', earlyAccess: false }));
// A site admin, who did not make any of these races.
kvStore.set('user:' + BOSS, JSON.stringify({ ...creds, role: 'admin' }));

const login = async (email) => {
  const r = await worker.fetch(new Request('https://w/login', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ email, password: 'pw' }) }), env);
  return (await r.json()).token;
};
const token = await login(ME);
const mateToken = await login(MATE);
const poorToken = await login(POOR);
const bossToken = await login(BOSS);
const strangerToken = await login(STRANGER);

const call = (path, tok, init = {}) => worker.fetch(new Request('https://w' + path, {
  ...init,
  headers: Object.assign({ 'Content-Type': 'application/json' },
                         tok ? { Authorization: 'Bearer ' + tok } : {},
                         init.headers || {})
}), env, ctxOf());

// waitUntil that waits, so the Discord post and the live push are actually
// exercised rather than dropped on the floor.
const pending = [];
const ctxOf = () => ({ waitUntil: (p) => { pending.push(p); } });
const settle = () => Promise.allSettled(pending.splice(0));

const commit = async (path, content, tok) => {
  const body = { path, content, message: 'test' };
  const m = path.match(/^races\/([^/]+)\/(config|data)\.json$/);
  if (m) {
    const r = rows.get(m[1]);
    const sha = r ? (r[m[2] === 'config' ? 'config_sha' : 'data_sha'] || null) : null;
    if (sha) body.sha = sha;
  }
  const res = await call('/commit', tok || token, { method: 'POST', body: JSON.stringify(body) });
  await settle();
  return res;
};
const put = (path, doc, tok) => commit(path, JSON.stringify(doc, null, 2) + '\n', tok);

let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p?'ok  ':'FAIL'} ${l.padEnd(58)} ${JSON.stringify(g)}${p?'':' expected '+JSON.stringify(w)}`); };

const SLUG = '000031-quiet-one-a7f3k2';
const GPX = '<?xml version="1.0"?><gpx><trk><trkseg>' +
  '<trkpt lat="37.9614" lon="-105.4331"><ele>2400</ele></trkpt></trkseg></trk></gpx>';

// The wizard's order, and its shape: an unlisted race gets a random suffix on
// its slug and is never appended to the manifest.
const race = {
  name: 'The Quiet One', location: 'Westcliffe, CO', visibility: 'private',
  courseType: 'segments', units: 'mi', activity: 'trail-run',
  course: { segments: [{ name: 'Start to Ridge', distanceMi: 8, toAid: 'Ridge' }] },
  startTime: '2027-05-01T12:00:00.000Z', cutoffs: { totalHours: 12 },
  createdBy: ME,
  people: [{ email: MATE, role: 'crew' }],
  runners: [{ id: 'kr', name: 'Kristin Miller', email: MATE }]
};

git.set('races/index.json', { text: JSON.stringify({ races: [
  { slug: 'six-0-trail-marathon', name: 'Six-O Trail Marathon' }
] }, null, 2), sha: 'git-index-0' });

console.log('\ncreating it, the way the wizard does');
ok('the config write is accepted', (await put(`races/${SLUG}/config.json`, race)).status, 200);
ok('the data write is accepted',
  (await put(`races/${SLUG}/data.json`, { runners: [{ id: 'kr', legs: [] }] })).status, 200);
ok('and the course upload is accepted',
  (await commit(`races/${SLUG}/course.gpx`, GPX)).status, 200);
ok('it is stored unlisted', JSON.parse(rows.get(SLUG).config).visibility, 'private');

console.log('\nwhat reached the public repository');
ok('nothing at all under this race', [...git.keys()].filter(k => k.includes(SLUG)), []);
ok('the hub manifest is untouched',
  JSON.parse(git.get('races/index.json').text).races.map(r => r.slug), ['six-0-trail-marathon']);
ok('no share page', git.has(`races/${SLUG}/index.html`), false);
ok('no preview card', git.has(`races/${SLUG}/og.png`), false);
ok('the course is in the bucket instead', bucket.has(`course/${SLUG}/course.gpx`), true);

console.log('\nwhat the stored config says about the people on it');
const stored = JSON.parse(rows.get(SLUG).config);
ok('no roster', stored.people, undefined);
ok('no creator', stored.createdBy, undefined);
ok('and no address on the racer', (stored.runners || [])[0].email, undefined);
ok('nobody\'s address anywhere in it', /@/.test(JSON.stringify(stored)), false);

console.log('\na stranger with an account');
let r = await call(`/get?path=races/${SLUG}/config.json`, strangerToken);
ok('cannot read the config', r.status, 403);
ok('nor the splits', (await call(`/get?path=races/${SLUG}/data.json`, strangerToken)).status, 403);
ok('nor the course', (await call(`/get?path=races/${SLUG}/course.gpx`, strangerToken)).status, 403);
r = await call('/my-races', strangerToken);
ok('and it is not on their hub', ((await r.json()).races || []).some(x => x.slug === SLUG), false);

console.log('\nnobody at all');
ok('is refused the config', (await call(`/get?path=races/${SLUG}/config.json`, null)).status, 401);
ok('and the published copy answers as if it does not exist',
  (await call(`/public?path=races/${SLUG}/config.json`, null)).status, 404);
ok('for the splits too',
  (await call(`/public?path=races/${SLUG}/data.json`, null)).status, 404);
ok('and the course',
  (await call(`/public?path=races/${SLUG}/course.gpx`, null)).status, 404);

console.log('\nthe people who are on it');
ok('the creator reads the config', (await call(`/get?path=races/${SLUG}/config.json`, token)).status, 200);
ok('the crew member does too', (await call(`/get?path=races/${SLUG}/config.json`, mateToken)).status, 200);
ok('and gets the course out of the bucket',
  (await call(`/get?path=races/${SLUG}/course.gpx`, mateToken)).status, 200);
r = await call('/my-races', mateToken);
ok('and it is on their hub', ((await r.json()).races || []).some(x => x.slug === SLUG), true);

console.log('\nthe chat webhook');
ok('was told nothing', posted, []);

console.log('\nthe live push');
ok('refuses to watch an unlisted race',
  (await worker.fetch(new Request('https://w/live?race=' + SLUG, {
    headers: { Upgrade: 'websocket' } }), env, ctxOf())).status, 403);

// The hole this test was written for. /commit took any name under
// races/<slug>/, and everything above is about three of them.
console.log('\na file with a fourth name');
r = await commit(`races/${SLUG}/notes.txt`, 'meeting Kristin at the low water crossing at 6am');
ok('is refused outright', r.status, 403);
ok('and nothing reached the repository', [...git.keys()].filter(k => k.includes(SLUG)), []);
r = await commit(`races/${SLUG}/roster.csv`, 'name,email\nKristin,' + MATE);
ok('so is any other', r.status, 403);
ok('on a public race as well, where it was only ever junk',
  (await commit('races/six-0-trail-marathon/notes.txt', 'x')).status, 403);

console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
