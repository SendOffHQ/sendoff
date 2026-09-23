// Taking a race off the hub, and putting it back.
//
// A race that was set up and then never run should not sit on the public hub
// forever, and until now there was no way to move one: visibility was decided
// at creation and nothing could change it afterwards. ACL_FIELDS keeps
// `visibility` out of every file write on purpose, and handleCommit pins it, so
// the only way it can move is a path that exists to move it.
//
// What this checks is that the move is complete. A race is advertised in three
// places, and unlisting it in one of them is worse than not unlisting it at
// all, because it looks done:
//
//   the config      what the worker reads to decide who may open it
//   races/index.json    what the hub and every share card list
//   course.gpx      a list of coordinates, in a public repository
//
// The course is the one that would have been missed. It is the most revealing
// file a race has, and it is served off Pages without going near the worker, so
// leaving it there would mean an "unlisted" race whose route anybody can read.
//
//   node worker/test/race-visibility.mjs
import worker from '../src/worker.js';

const ME = 'owner@example.com';
const MATE = 'crew@example.com';
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
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
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
  USERS: JSON.stringify([{ email: ME, ...creds }, { email: MATE, ...creds }]),
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

const call = (path, tok, init = {}) => worker.fetch(new Request('https://w' + path, {
  ...init,
  headers: Object.assign({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + (tok || token) },
                         init.headers || {})
}), env, { waitUntil: () => {} });
// A write carries the version it is replacing, the way the client's mutateJson
// does after a read. Without it the second write to a file is refused as a
// conflict, and an assertion about what that write did would be measuring the
// refusal instead.
const put = (path, doc, tok) => {
  const body = { path, content: JSON.stringify(doc, null, 2) + '\n', message: 'test' };
  const m = path.match(/^races\/([^/]+)\/(config|data)\.json$/);
  if (m) {
    const row = rows.get(m[1]);
    const sha = row ? (row[m[2] === 'config' ? 'config_sha' : 'data_sha'] || null) : null;
    if (sha) body.sha = sha;
  }
  return call('/commit', tok || token, { method: 'POST', body: JSON.stringify(body) });
};
const flip = (slug, visibility, tok) => call('/race/visibility', tok || token,
  { method: 'POST', body: JSON.stringify({ slug, visibility }) });

let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p?'ok  ':'FAIL'} ${l.padEnd(56)} ${JSON.stringify(g)}${p?'':' expected '+JSON.stringify(w)}`); };

const stored = (slug) => JSON.parse(rows.get(slug).config);
const manifest = () => JSON.parse(git.get('races/index.json').text);
const listed = (slug) => manifest().races.some(r => r.slug === slug);

const SLUG = '000007-never-run';
const GPX = '<?xml version="1.0"?><gpx><trk><trkseg><trkpt lat="30.1" lon="-97.7"/></trkseg></trk></gpx>';
const race = {
  name: 'The Race Nobody Ran', location: 'San Marcos, TX', visibility: 'public',
  courseType: 'segments', units: 'mi', activity: 'paddle',
  course: { segments: [{ name: 'Start to Aid 1', distanceMi: 12.5 },
                       { name: 'Aid 1 to Finish', distanceMi: 7.5 }] },
  startTime: '2026-06-13T13:00:00.000Z',
  cutoffs: { totalHours: 40 },
  createdBy: ME, people: [{ email: MATE, role: 'crew' }],
  runners: [{ id: 'jd', name: 'Jason', bib: '1' }]
};

git.set('races/index.json', { text: JSON.stringify({ races: [
  { slug: SLUG, name: race.name, location: race.location, startTime: race.startTime,
    courseType: 'segments', units: 'mi', activity: 'paddle', totalDistanceMi: 20,
    runnerNames: ['Jason'], cutoffHours: 40 },
  { slug: '000001-other', name: 'Another Race' }
] }, null, 2), sha: 'git-index-0' });
git.set(`races/${SLUG}/course.gpx`, { text: GPX, sha: 'git-gpx-0' });
// The share page tools/make-og.py builds for every public race: the address
// the hub links to, and the card its preview tags point at.
git.set(`races/${SLUG}/index.html`, { text: '<html>old stub</html>', sha: 'git-stub-0' });
git.set(`races/${SLUG}/og.png`, { text: 'PNG-bytes', sha: 'git-card-0' });

console.log('\na public race, listed on the hub with its course in the repo');
ok('the config write succeeds', (await put(`races/${SLUG}/config.json`, race)).status, 200);
ok('it is on the hub', listed(SLUG), true);
ok('and its course is in the repo', git.has(`races/${SLUG}/course.gpx`), true);
ok('and it has a share page', [git.has(`races/${SLUG}/index.html`),
  git.has(`races/${SLUG}/og.png`)], [true, true]);

console.log('\nwho is allowed to move it');
ok('a crew member is not', (await flip(SLUG, 'private', mateToken)).status, 403);
ok('and neither is a stranger with no session',
  (await worker.fetch(new Request('https://w/race/visibility', { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: SLUG, visibility: 'private' }) }), env, { waitUntil: () => {} })).status, 401);
ok('the race has not moved', stored(SLUG).visibility, 'public');

console.log('\nwhat it will accept');
ok('a made-up visibility is refused', (await flip(SLUG, 'secret')).status, 400);
ok('a missing slug is refused', (await flip('', 'private')).status, 400);
ok('a slug that escapes its directory is refused', (await flip('../etc', 'private')).status, 400);
ok('and so is anything that is not a slug shape',
  (await flip('a"><script>x</script>', 'private')).status, 400);
ok('a race that does not exist is a 404', (await flip('000099-nope', 'private')).status, 404);
ok('asking for what it already is changes nothing',
  await (await flip(SLUG, 'public')).json(), { slug: SLUG, visibility: 'public', changed: false });

console.log('\nunlisting it');
let r = await flip(SLUG, 'private');
let j = await r.json();
ok('the call succeeds', r.status, 200);
ok('reporting the change', [j.changed, j.visibility], [true, 'private']);
ok('with nothing left behind', [j.manifestErr, j.courseErr, j.shareErr], [null, null, null]);
ok('the stored config says unlisted', stored(SLUG).visibility, 'private');
ok('it is off the hub', listed(SLUG), false);
ok('the other race is still on it', listed('000001-other'), true);
ok('the course is out of the repo', git.has(`races/${SLUG}/course.gpx`), false);
ok('and in private storage, byte for byte', bucket.get(`course/${SLUG}/course.gpx`), GPX);
// The one that would have been missed. index.html is a static page on Pages:
// it opens the race without the worker ever seeing the request, and its
// preview tags put the race name and the runner's name in any chat window the
// link is pasted into. An unlisted race that still has one is not unlisted.
ok('the share page is off the site', git.has(`races/${SLUG}/index.html`), false);
ok('and so is its preview card', git.has(`races/${SLUG}/og.png`), false);

// Taking a race off the hub cannot take back what was published while it was
// on it, so the race has to remember having been there. Without this it reads
// as plainly private the moment it flips, which is the comfortable answer and
// not the true one.
console.log('\nand it remembers having been published');
ok('the stored config says so', stored(SLUG).everPublic, true);

console.log('\nthe race still works for the people on it');
ok('the creator can still read it', (await call('/access?slug=' + SLUG, token)).status, 200);
ok('so can the crew member', (await call('/access?slug=' + SLUG, mateToken)).status, 200);
r = await call('/my-races', mateToken);
j = await r.json();
ok('and it is still on their own list', (j.races || []).some(x => x.slug === SLUG), true);

console.log('\nlisting it again');
r = await flip(SLUG, 'public');
j = await r.json();
ok('the call succeeds', r.status, 200);
ok('with nothing left behind', [j.manifestErr, j.courseErr, j.shareErr], [null, null, null]);
ok('the stored config says public', stored(SLUG).visibility, 'public');
ok('the course is back in the repo, byte for byte', git.get(`races/${SLUG}/course.gpx`).text, GPX);
ok('and gone from private storage', bucket.has(`course/${SLUG}/course.gpx`), false);

const back = manifest().races.find(x => x.slug === SLUG);
console.log('\nand the hub entry it comes back with');
ok('is there', !!back, true);
ok('naming the race', [back.name, back.location], [race.name, race.location]);
ok('with its start and cutoff', [back.startTime, back.cutoffHours], [race.startTime, 40]);
ok('the course it describes', [back.courseType, back.units, back.activity],
  ['segments', 'mi', 'paddle']);
ok('the distance, summed from the segments', back.totalDistanceMi, 20);
ok('and the racers', back.runnerNames, ['Jason']);
ok('but nobody\'s address', JSON.stringify(back).includes('@'), false);
ok('listed once, not twice', manifest().races.filter(x => x.slug === SLUG).length, 1);

// The hub links to /races/<slug>/, so a race listed without this page is a
// card that 404s. The image is not rebuilt here, because nothing in a worker
// renders a PNG; test/share-pages.mjs is what says so out loud.
const stub = git.get(`races/${SLUG}/index.html`);
console.log('\nand the share page it comes back with');
ok('is there again', !!stub, true);
ok('and is not the stale one', stub.text.includes('old stub'), false);
ok('naming the race', stub.text.includes('<title>The Race Nobody Ran'), true);
ok('pointing at that race', stub.text.includes('/races/' + SLUG + '/'), true);
ok('carrying its preview card', stub.text.includes(`/races/${SLUG}/og.png`), true);
ok('and forwarding into the app', stub.text.includes(`/race.html?id=${SLUG}`), true);
ok('the date and the racers, for the description',
  /Jun 13, 2026 · San Marcos, TX · Jason/.test(stub.text), true);
ok('but nobody\'s address', stub.text.includes('@'), false);

console.log('\nand the mark survives what would erase it');
// An ordinary settings save writes the whole config back. A client that sends
// a fresh object rather than the one it read must not be able to drop this,
// the same way it cannot drop visibility.
r = await put(`races/${SLUG}/config.json`, { ...race, name: 'Renamed By A Save' });
ok('a config write that omits it is accepted', r.status, 200);
ok('and the mark is still there', stored(SLUG).everPublic, true);
ok('the rename did land, so the write was real', stored(SLUG).name, 'Renamed By A Save');

console.log('\na race that was made private and never listed');
const BORN = '000013-born-private';
await put(`races/${BORN}/config.json`, {
  name: 'Born Private', visibility: 'private', courseType: 'segments',
  course: { segments: [{ name: 'A to B', distanceMi: 4 }] },
  startTime: '2027-06-01T12:00:00.000Z', createdBy: ME, runners: [{ id: 'b', name: 'Sam' }]
});
ok('carries no such mark', stored(BORN).everPublic, undefined);
// Listing it and taking it back sets it, because by then it has been on the hub.
await flip(BORN, 'public');
await flip(BORN, 'private');
ok('until it has been on the hub and come back', stored(BORN).everPublic, true);

console.log('\na loop course described by its aid stations, which has no loopDistanceMi');
const LOOP = '000008-loops';
await put(`races/${LOOP}/config.json`, {
  name: 'Six Loops', visibility: 'private', courseType: 'loops', units: 'mi',
  course: { loopCount: 6, loopSegments: [{ name: 'Start to Creek', distanceMi: 2 },
                                         { name: 'Creek to Start', distanceMi: 1.5 }] },
  startTime: '2026-11-01T12:00:00.000Z', cutoffs: { totalHours: 24 },
  createdBy: ME, runners: [{ id: 'a', name: 'Sam' }]
});
await flip(LOOP, 'public');
ok('is listed at its real distance, not zero',
  manifest().races.find(x => x.slug === LOOP).totalDistanceMi, 21);

console.log('\nunlisting is a Pro feature');
const POORSLUG = '000009-free-plan';
await put(`races/${POORSLUG}/config.json`, {
  name: 'Free Plan Race', visibility: 'public', courseType: 'segments',
  course: { segments: [{ name: 'A to B', distanceMi: 3 }] },
  startTime: '2026-12-01T12:00:00.000Z', createdBy: POOR,
  runners: [{ id: 'z', name: 'Kim' }]
}, poorToken);
r = await flip(POORSLUG, 'private', poorToken);
j = await r.json();
ok('a free account is told so', [r.status, j.code], [402, 'plan_limit']);
ok('and the race stays public', stored(POORSLUG).visibility, 'public');
ok('but listing one is not gated', (await flip(POORSLUG, 'public', poorToken)).status, 200);

// The moderation case, and the reason the endpoint is not creator-only. A race
// gets set up, the day comes, nobody uses it, and it sits on the public hub
// with nothing behind it. The one person allowed to take it down is the one who
// has stopped looking at it, so if that is the only bar, it stays up forever.
console.log('\nan admin, who made none of these races');
r = await flip(POORSLUG, 'private', bossToken);
j = await r.json();
ok('can take one off the hub', [r.status, j.visibility], [200, 'private']);
ok('the owner\'s plan is not a reason it has to stay up', j.error || null, null);
ok('the stored config moved', stored(POORSLUG).visibility, 'private');
ok('and it is off the hub', listed(POORSLUG), false);
ok('and can put it back', (await flip(POORSLUG, 'public', bossToken)).status, 200);
ok('but cannot delete somebody else\'s race, which is a different thing',
  (await call('/race/delete', bossToken, { method: 'POST',
    body: JSON.stringify({ slug: POORSLUG }) })).status, 403);

// A course big enough that GitHub will not hand it back inline. Copying an
// empty file to R2 and then deleting the real one would destroy the course, so
// it says so and leaves both where they are.
// The share page is a static page on the apex domain and a race name is
// whatever somebody typed. Every use of the name below sits inside a double
// quoted attribute, so a quote in it must not be able to close one.
console.log('\na race named with a quote in it');
const QUOTED = '000012-quoted';
await put(`races/${QUOTED}/config.json`, {
  name: 'The "Big" Race <b>', visibility: 'private', courseType: 'segments',
  course: { segments: [{ name: 'A to B', distanceMi: 3 }] },
  startTime: '2027-03-01T12:00:00.000Z', createdBy: ME,
  runners: [{ id: 'q', name: "O'Hara" }]
});
await flip(QUOTED, 'public');
const qs = git.get(`races/${QUOTED}/index.html`).text;
ok('the quote cannot close an attribute', qs.includes('"Big"'), false);
ok('it is escaped instead', qs.includes('&quot;Big&quot;'), true);
ok('and so is the tag somebody tried to open', qs.includes('<b>'), false);
ok('the apostrophe in a racer name too', qs.includes("O'Hara"), false);
ok('every meta tag still closes where it should',
  (qs.match(/<meta [^<>]*>/g) || []).length, (qs.match(/<meta /g) || []).length);

console.log('\na course too big for the contents API');
const BIG = '000011-big-course';
await put(`races/${BIG}/config.json`, {
  name: 'Big Course', visibility: 'public', courseType: 'segments',
  course: { segments: [{ name: 'A to B', distanceMi: 100 }] },
  startTime: '2027-02-01T12:00:00.000Z', createdBy: ME, runners: []
});
git.set(`races/${BIG}/course.gpx`, { text: 'x', sha: 'git-big', huge: true });
r = await flip(BIG, 'private');
j = await r.json();
ok('the race still comes off the hub', [r.status, stored(BIG).visibility], [200, 'private']);
ok('and it says the course did not move', /too large/.test(j.courseErr || ''), true);
ok('leaving the real one where it is', git.has(`races/${BIG}/course.gpx`), true);
ok('rather than an empty file in its place', bucket.has(`course/${BIG}/course.gpx`), false);

console.log('\na race with no course at all');
const BARE = '000010-no-course';
await put(`races/${BARE}/config.json`, {
  name: 'No Course', visibility: 'public', courseType: 'segments', course: { segments: [] },
  startTime: '2027-01-01T12:00:00.000Z', createdBy: ME, runners: []
});
r = await flip(BARE, 'private');
j = await r.json();
ok('unlists without complaining about the missing file', [r.status, j.courseErr], [200, null]);
ok('nor about a share page it never had', j.shareErr, null);

console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
