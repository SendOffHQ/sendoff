// Unlisting a finished race takes its files off the site.
//
// When a public race finishes, its config.json and data.json are committed to
// the repository, which is the public site: that is the archive. Taking the
// race off the hub removed its hub entry, its share page, its finish cards and
// its course, and left those two files where they were, so every split and
// every note the crew wrote could still be read by address. They go now, the
// way the other published files go.
//
// A race from before the database is the careful case. For that race the two
// files in the repository are not a copy, they are the race, so each is put
// into the database first and removed only once it is there.
//
//   node worker/test/unlist-archive.mjs
import worker from '../src/worker.js';
import { fakeD1 } from './fake-d1.mjs';

const ME = 'owner@example.com';
const kvStore = new Map();
const KV = {
  async get(k) { const v = kvStore.get(k); return v === undefined ? null : v; },
  async put(k, v) { kvStore.set(k, v); },
  async delete(k) { kvStore.delete(k); },
  async list({ prefix } = {}) {
    return { keys: [...kvStore.keys()].filter(k => !prefix || k.startsWith(prefix)).map(name => ({ name })), list_complete: true };
  },
};
globalThis.caches = { default: { async match(){}, async put(){}, async delete(){ return true; } } };

// The repository: files by path, a folder listed the way the contents API
// lists one, and a delete that can be made to fail for one path.
const git = new Map();
let shaN = 0, refuseDelete = null;
const b64 = s => Buffer.from(s, 'utf8').toString('base64');
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (/^https:\/\/sendoff\.run\//.test(u)) return new Response('', { status: 404 });
  if (/\/git\/trees\//.test(u)) return new Response(JSON.stringify({ tree: [] }), { status: 200 });
  const m = u.match(/\/contents\/([^?]+)/);
  const path = m ? decodeURIComponent(m[1]) : null;
  const method = opts.method || 'GET';
  if (path && method === 'GET') {
    const f = git.get(path);
    if (!f) {
      const inside = [...git.keys()].filter(k => k.startsWith(path + '/') && !k.slice(path.length + 1).includes('/'));
      if (inside.length) return new Response(JSON.stringify(inside.map(k =>
        ({ type: 'file', name: k.slice(path.length + 1), path: k, sha: git.get(k).sha }))), { status: 200 });
      return new Response('{"message":"Not Found"}', { status: 404 });
    }
    return new Response(JSON.stringify({ content: b64(f.text), encoding: 'base64', sha: f.sha, path }), { status: 200 });
  }
  if (path && method === 'PUT') {
    const body = JSON.parse(opts.body || '{}');
    const cur = git.get(path);
    if (cur && body.sha && body.sha !== cur.sha) return new Response('{"message":"conflict"}', { status: 409 });
    const sha = 'git-' + (++shaN);
    git.set(path, { text: Buffer.from(body.content, 'base64').toString('utf8'), sha });
    return new Response(JSON.stringify({ content: { path, sha } }), { status: 200 });
  }
  if (path && method === 'DELETE') {
    if (refuseDelete && path.endsWith(refuseDelete)) return new Response('{"message":"nope"}', { status: 500 });
    git.delete(path);
    return new Response('{}', { status: 200 });
  }
  return new Response('{"message":"Not Found"}', { status: 404 });
};

// The database, which can be made to refuse a race's data.
const DB = fakeD1();
let refuseData = false;
const prepare = DB.prepare;
DB.prepare = (sql) => {
  if (refuseData && /^INSERT INTO races \(slug, name, created_by, config, data, data_sha/.test(sql.replace(/\s+/g, ' ').trim())) {
    throw new Error('D1_ERROR: no room');
  }
  return prepare(sql);
};

async function cred(pw) {
  const salt = new Uint8Array(16); crypto.getRandomValues(salt);
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name:'PBKDF2', salt, iterations:100000, hash:'SHA-256' }, km, 256);
  const b = a => Buffer.from(a).toString('base64');
  return { hash: b(new Uint8Array(bits)), salt: b(salt), iterations: 100000 };
}
const env = {
  DB, GITHUB_OWNER:'o', GITHUB_REPO:'r', GITHUB_TOKEN:'t', GITHUB_BRANCH:'main',
  AUTH_KV: KV, ALLOWED_ORIGINS:'*', JWT_SECRET:'s', PUBLIC_BASE_URL: 'https://sendoff.run',
  USERS: JSON.stringify([{ email: ME, ...await cred('pw') }]),
};
const waited = [];
const ctx = { waitUntil: (p) => waited.push(p) };
const settle = async () => { await Promise.all(waited.splice(0)); };
const call = async (p, o = {}) => {
  const r = await worker.fetch(new Request('https://w' + p, {
    method: o.body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(o.token ? { Authorization: 'Bearer ' + o.token } : {}) },
    ...(o.body ? { body: JSON.stringify(o.body) } : {}) }), env, ctx);
  await settle();
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, ...(j || {}) };
};
const token = (await call('/login', { body: { email: ME, password: 'pw' } })).token;
const version = (slug, file) => { const r = DB.races.get(slug); return r ? r[file + '_sha'] : undefined; };
const put = (slug, file, doc) => call('/commit', { token, body: { path: `races/${slug}/${file}.json`,
  content: JSON.stringify(doc, null, 2) + '\n', message: 'test', sha: version(slug, file) || undefined } });
const flip = (slug, visibility) => call('/race/visibility', { token, body: { slug, visibility } });
const readData = async (slug) => {
  const r = await call('/get?path=' + encodeURIComponent(`races/${slug}/data.json`), { token });
  return r.content ? JSON.parse(Buffer.from(r.content, 'base64').toString('utf8')) : r;
};
const inGit = (slug) => [...git.keys()].filter(k => k.startsWith(`races/${slug}/`)).map(k => k.slice(`races/${slug}/`.length)).sort();

let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p?'ok  ':'FAIL'} ${l.padEnd(62)} ${JSON.stringify(g)}${p?'':' expected '+JSON.stringify(w)}`); };

// One leg, so one arrival is a finish. Started long enough ago that the
// finish is old news and nothing is announced.
const course = { courseType: 'segments', course: { segments: [{ name: 'Out and back', distanceMi: 10 }] },
  startTime: '2026-09-01T13:00:00.000Z', runners: [{ id: 'jd', name: 'Jason' }] };
const finished = { runners: [{ id: 'jd', legs: [{ index: 1, startTime: '2026-09-01T13:00:00.000Z',
  endTime: '2026-09-01T15:00:00.000Z', notes: 'threw up at the turnaround' }] }] };

console.log('\na public race that has finished');
await put('done', 'config', { ...course, name: 'Done Fifty', visibility: 'public', createdBy: ME });
await put('done', 'data', finished);
ok('is archived to the site: its config and its splits', inGit('done'), ['config.json', 'data.json']);
ok('notes and all', git.get('races/done/data.json').text.includes('threw up'), true);

console.log('\ntaken off the hub');
let r = await flip('done', 'private');
ok('the change is made, with nothing left over to report', [r.status, r.visibility, r.shareErr], [200, 'private', null]);
ok('the archive is off the site', inGit('done'), []);
ok('the race itself is untouched, for the people on it', (await readData('done')).runners[0].legs[0].notes, 'threw up at the turnaround');
ok('and is not served to anybody else', (await call('/public?path=' + encodeURIComponent('races/done/data.json'))).status, 404);

console.log('\nput back on the hub');
r = await flip('done', 'public');
ok('it is archived again, as the next split would have done', [r.visibility, inGit('done').filter(f => f.endsWith('.json'))], ['public', ['config.json', 'data.json']]);

console.log('\na file that will not come down');
refuseDelete = 'done/data.json';
r = await flip('done', 'private');
ok('is named, so the owner knows the race is not fully off the site',
  [r.visibility, r.shareErr], ['private', 'the race\'s own files are still published (races/done/data.json)']);
refuseDelete = null;
await flip('done', 'public');

console.log('\na race from before the database, which lives in the repository');
git.set('races/old/config.json', { sha: 'old-c', text: JSON.stringify({ ...course, name: 'Old Fifty', visibility: 'public', createdBy: ME }) });
git.set('races/old/data.json', { sha: 'old-d', text: JSON.stringify(finished) });
ok('the database has never seen it', DB.races.has('old'), false);
r = await flip('old', 'private');
ok('it is taken off the hub', [r.status, r.visibility, r.shareErr], [200, 'private', null]);
ok('and off the site', inGit('old'), []);
ok('having been put in the database first, splits and notes intact', (await readData('old')).runners[0].legs[0].notes, 'threw up at the turnaround');
ok('where its owner still owns it', (await call('/access?slug=old', { token })).createdBy, ME);

console.log('\nand when the database will not take it');
git.set('races/older/config.json', { sha: 'older-c', text: JSON.stringify({ ...course, name: 'Older Fifty', visibility: 'public', createdBy: ME }) });
git.set('races/older/data.json', { sha: 'older-d', text: JSON.stringify(finished) });
refuseData = true;
r = await flip('older', 'private');
refuseData = false;
ok('the only copy of its splits is not deleted', git.has('races/older/data.json'), true);
ok('and the owner is told what is still published', r.shareErr, 'the race\'s own files are still published (races/older/data.json)');
ok('the splits are still readable', (await readData('older')).runners[0].legs[0].notes, 'threw up at the turnaround');

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
