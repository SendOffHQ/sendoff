// An unlisted race's course does not go into a public repository.
//
// config.json and data.json moved to the database and the roster moved to KV,
// and course.gpx went on being committed to git the whole time: the course of
// a race somebody deliberately kept off the hub, at a guessable path, readable
// by anyone who looked. A GPX is also the most revealing file a race has,
// because it is a list of coordinates.
//
// Three things, and the first is the whole point:
//   - an unlisted race's course never reaches git;
//   - it still comes back to somebody allowed to read the race;
//   - a public race is untouched, because it is public and the static path
//     costs the worker nothing.
//
//   node worker/test/course-privacy.mjs
import worker from '../src/worker.js';

const ME = 'owner@example.com';
const OUTSIDER = 'nobody@example.com';
const repo = new Map();
const bucket = new Map();
const kvStore = new Map();
const KV = {
  async get(k) { const v = kvStore.get(k); return v === undefined ? null : v; },
  async put(k, v) { kvStore.set(k, v); },
  async delete(k) { kvStore.delete(k); },
  async list() { return { keys: [] }; },
};
const MEDIA = {
  async put(k, v) { bucket.set(k, typeof v === 'string' ? v : Buffer.from(v).toString('utf8')); },
  async get(k) {
    if (!bucket.has(k)) return null;
    const s = bucket.get(k);
    return { etag: 'e-' + k, size: s.length, async text() { return s; } };
  },
  async delete(k) { bucket.delete(k); },
};
globalThis.caches = { default: { async match(){}, async put(){}, async delete(){ return true; } } };

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const m = u.match(/contents\/(.+?)(\?|$)/);
  const path = m ? decodeURIComponent(m[1]) : '';
  if ((opts.method || 'GET') === 'GET') {
    if (!repo.has(path)) return new Response('{"message":"Not Found"}', { status: 404 });
    return new Response(JSON.stringify({
      sha: 'sha-' + path, content: Buffer.from(repo.get(path), 'utf8').toString('base64'),
    }), { status: 200 });
  }
  const body = JSON.parse(opts.body);
  repo.set(path, Buffer.from(body.content, 'base64').toString('utf8'));
  return new Response(JSON.stringify({ content: { path, sha: 'new-' + path } }), { status: 200 });
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
  AUTH_KV: KV, MEDIA, ALLOWED_ORIGINS:'*', JWT_SECRET:'s',
  PUBLIC_BASE_URL: 'https://sendoff.run',
  // Git left as the write path on purpose. The course rule must not depend on
  // where a race's JSON goes: that is a migration flag with a rollback behind
  // it, and an unlisted race's coordinates must stay out of a public
  // repository either way. If this ever passes only with the flag off, the
  // rule has been hung on the wrong thing again.
  USERS: JSON.stringify([
    { email: ME, ...await cred('pw') },
    { email: OUTSIDER, ...await cred('pw') },
  ]),
};

const waited = [];
const ctx = { waitUntil: (p) => waited.push(p) };
const settle = async () => { await Promise.all(waited.splice(0)); };
const login = async (who) => {
  const r = await worker.fetch(new Request('https://w/login', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ email: who, password: 'pw' }) }), env);
  return (await r.json()).token;
};
const token = await login(ME);
const other = await login(OUTSIDER);

const put = async (path, content, tok = token) => {
  const r = await worker.fetch(new Request('https://w/commit', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', Authorization: 'Bearer ' + tok },
    body: JSON.stringify({ path, content, message: 'test' })
  }), env, ctx);
  await settle();
  return r;
};
const get = (path, tok) => worker.fetch(new Request(
  'https://w/get?path=' + encodeURIComponent(path),
  { headers: tok ? { Authorization: 'Bearer ' + tok } : {} }), env, ctx);

const race = (visibility) => JSON.stringify({
  name: 'Test Race', visibility, createdBy: ME,
  courseType: 'segments',
  course: { segments: [{ name: 'Start to Ridge', distanceMi: 5, toAid: 'Ridge' }] },
  startTime: '2026-10-03T13:00:00.000Z',
  runners: [{ id: 'jd', name: 'Jason Dupree' }],
}, null, 2) + '\n';

const GPX = '<?xml version="1.0"?><gpx><trk><trkseg>' +
  '<trkpt lat="37.9614" lon="-105.4331"><ele>2400</ele></trkpt>' +
  '</trkseg></trk></gpx>';

let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p?'ok  ':'FAIL'} ${l.padEnd(56)} ${JSON.stringify(g)}${p?'':' expected '+JSON.stringify(w)}`); };

await put('races/quiet-race/config.json', race('private'));
await put('races/open-race/config.json', race('public'));

console.log('\nan unlisted race keeps its course out of the repository');
const wrote = await put('races/quiet-race/course.gpx', GPX);
ok('the write was accepted', wrote.status, 200);
// The course, specifically. This test leaves git as the write path for the
// race's JSON on purpose (see the env note above), so config.json going there
// is this harness and not the thing under test. What must never be there is
// the file full of coordinates.
ok('and no course file reached git',
   [...repo.keys()].filter(k => k.endsWith('course.gpx')), []);
ok('the bucket has it instead',
   [...bucket.keys()], ['course/quiet-race/course.gpx']);

console.log('\nand hands it back to somebody allowed to read the race');
let r = await get('races/quiet-race/course.gpx', token);
ok('the owner gets it', r.status, 200);
ok('and it is the course that went in',
   Buffer.from((await r.json()).content, 'base64').toString('utf8'), GPX);

console.log('\nbut not to somebody who is not on it');
r = await get('races/quiet-race/course.gpx', other);
ok('a stranger is refused', r.status, 403);
r = await get('races/quiet-race/course.gpx');
ok('and so is nobody at all', r.status, 401);

console.log('\na public race is left exactly as it was');
await put('races/open-race/course.gpx', GPX);
ok('its course is committed',
   repo.has('races/open-race/course.gpx'), true);
ok('and the bucket was not used for it',
   [...bucket.keys()].some(k => k.includes('open-race')), false);

console.log('\nand deleting the race takes the course with it');
r = await worker.fetch(new Request('https://w/race/delete', {
  method:'POST', headers:{ 'Content-Type':'application/json', Authorization:'Bearer ' + token },
  body: JSON.stringify({ slug: 'quiet-race' }) }), env, ctx);
await settle();
ok('the bucket no longer holds it', bucket.has('course/quiet-race/course.gpx'), false);

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
