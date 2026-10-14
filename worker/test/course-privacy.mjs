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
import { fakeD1 } from './fake-d1.mjs';

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
  async list({ prefix } = {}) { return { objects: [...bucket.keys()].filter(k => !prefix || k.startsWith(prefix)).map(key => ({ key })) }; },
};
globalThis.caches = { default: { async match(){}, async put(){}, async delete(){ return true; } } };

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const m = u.match(/contents\/(.+?)(\?|$)/);
  const path = m ? decodeURIComponent(m[1]) : '';
  if ((opts.method || 'GET') === 'GET') {
    if (!repo.has(path)) return new Response('{"message":"Not Found"}', { status: 404 });
    return new Response(JSON.stringify({
      sha: 'sha-' + path, encoding: 'base64', content: Buffer.from(repo.get(path), 'utf8').toString('base64'),
    }), { status: 200 });
  }
  // A delete, the way GitHub's contents API takes one: moving a course off
  // the hub removes it from the repository.
  if (opts.method === 'DELETE') {
    const had = repo.delete(path);
    return new Response('{}', { status: had ? 200 : 404 });
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
  DB: fakeD1(),
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
// A save of a file that exists, with the version it is replacing, the way the
// pages send one.
const save = async (path, content) => {
  const cur = await (await get(path, token)).json();
  const r = await worker.fetch(new Request('https://w/commit', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ path, content, sha: cur.sha, message: 'test' })
  }), env, ctx);
  await settle();
  if (r.status !== 200) throw new Error(`save ${path}: ${r.status} ${await r.text()}`);
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

console.log('\na loop with a course of its own');
const loopsRace = (visibility) => JSON.stringify({ ...JSON.parse(race(visibility)), courseType: 'loops',
  course: { loopCount: 7, loops: [{ id: 'a', name: 'Long', distanceMi: 15, times: 6, gpx: 'course.gpx' },
    { id: 'b', name: 'Short', distanceMi: 10, times: 1, gpx: 'course-b.gpx' }] } }, null, 2) + '\n';
await put('races/quiet-loops/config.json', loopsRace('private'));
ok('an unlisted race takes it', (await put('races/quiet-loops/course-b.gpx', GPX)).status, 200);
ok('into the bucket, not git', [repo.has('races/quiet-loops/course-b.gpx'), bucket.has('course/quiet-loops/course-b.gpx')], [false, true]);
r = await get('races/quiet-loops/course-b.gpx', token);
ok('and hands it back to the owner', [r.status, Buffer.from((await r.json()).content, 'base64').toString('utf8')], [200, GPX]);
ok('but not to a stranger', (await get('races/quiet-loops/course-b.gpx', other)).status, 403);
ok('any other name is still refused', [(await put('races/quiet-loops/notes.gpx', GPX)).status,
  (await put('races/quiet-loops/course-B.gpx', GPX)).status, (await put('races/quiet-loops/course-b.gpx.txt', GPX)).status], [403, 403, 403]);
await put('races/open-loops/config.json', loopsRace('public'));
await put('races/open-loops/course-b.gpx', GPX);
ok('a public race commits it', repo.has('races/open-loops/course-b.gpx'), true);

console.log('\nand moves with the race');
const flip = async (slug, visibility) => { const res = await worker.fetch(new Request('https://w/race/visibility', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
  body: JSON.stringify({ slug, visibility }) }), env, ctx); await settle(); return res; };
await put('races/open-loops/course.gpx', GPX);
await flip('open-loops', 'private');
ok('unlisting takes every course file out of git', [repo.has('races/open-loops/course.gpx'), repo.has('races/open-loops/course-b.gpx')], [false, false]);
ok('and into the bucket', [bucket.has('course/open-loops/course.gpx'), bucket.has('course/open-loops/course-b.gpx')], [true, true]);
await flip('open-loops', 'public');
ok('listing it again puts them back', [repo.has('races/open-loops/course.gpx'), repo.has('races/open-loops/course-b.gpx'),
  bucket.has('course/open-loops/course-b.gpx')], [true, true, false]);

console.log('\na loop removed');
const threeLoops = (visibility, keepC) => JSON.stringify({ ...JSON.parse(race(visibility)), courseType: 'loops',
  course: { loopCount: 7, loops: [{ id: 'a', name: 'Long', distanceMi: 15, times: 5, gpx: 'course.gpx' },
    { id: 'b', name: 'Short', distanceMi: 10, times: 1, gpx: 'course-b.gpx' },
    ...(keepC ? [{ id: 'c', name: 'Tiny', distanceMi: 5, times: 1, gpx: 'course-c.gpx' }] : [])] } }, null, 2) + '\n';
await save('races/quiet-loops/config.json', threeLoops('private', true));
await put('races/quiet-loops/course-c.gpx', GPX);
ok('an unlisted race has the third loop\'s file', bucket.has('course/quiet-loops/course-c.gpx'), true);
await save('races/quiet-loops/config.json', threeLoops('private', false));
ok('saving the race without that loop deletes it', bucket.has('course/quiet-loops/course-c.gpx'), false);
ok('and leaves the others alone', bucket.has('course/quiet-loops/course-b.gpx'), true);
await save('races/open-loops/config.json', threeLoops('public', true));
await put('races/open-loops/course-c.gpx', GPX);
ok('a public race has it in git', repo.has('races/open-loops/course-c.gpx'), true);
await save('races/open-loops/config.json', threeLoops('public', false));
ok('and it is taken out of git the same way', [repo.has('races/open-loops/course-c.gpx'), repo.has('races/open-loops/course-b.gpx'), repo.has('races/open-loops/course.gpx')], [false, true, true]);

console.log('\nand goes with it when the race is deleted');
await put('races/quiet-loops/course.gpx', GPX);
// A file nothing names, left from before the cleanup existed.
await put('races/quiet-loops/course-d.gpx', GPX);
await worker.fetch(new Request('https://w/race/delete', {
  method:'POST', headers:{ 'Content-Type':'application/json', Authorization:'Bearer ' + token },
  body: JSON.stringify({ slug: 'quiet-loops' }) }), env, ctx);
await settle();
ok('no course file is left in the bucket, named or not', [...bucket.keys()].filter(k => k.startsWith('course/quiet-loops/')), []);

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
