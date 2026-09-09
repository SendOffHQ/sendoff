// The Discord announcements.
//
// The rule worth a test more than any other: an unlisted race must never be
// posted. Its address is the only thing keeping it off the public list, so
// announcing it in a chat channel is exactly what un-unlists it. Everything
// else here protects that, or protects a crew member's commit from a chat
// service.
//
//   node worker/test/discord.mjs
import worker from '../src/worker.js';

const ME = 'owner@example.com';
const repo = new Map();
const kvStore = new Map();
const KV = {
  async get(k) { const v = kvStore.get(k); return v === undefined ? null : v; },
  async put(k, v) { kvStore.set(k, v); },
  async delete(k) { kvStore.delete(k); },
};
globalThis.caches = { default: { async match(){}, async put(){}, async delete(){ return true; } } };

// Everything the worker sends to Discord, in order.
let posts = [];

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://discord.test/')) {
    posts.push(JSON.parse(opts.body));
    return new Response('', { status: 204 });
  }
  const m = u.match(/contents\/(.+?)(\?|$)/);
  const path = m ? decodeURIComponent(m[1]) : '';
  if ((opts.method || 'GET') === 'GET') {
    if (!repo.has(path)) return new Response('{"message":"Not Found"}', { status: 404 });
    return new Response(JSON.stringify({
      sha: 'sha-' + path,
      content: Buffer.from(repo.get(path), 'utf8').toString('base64'),
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
const base = {
  GITHUB_OWNER:'o', GITHUB_REPO:'r', GITHUB_TOKEN:'t', GITHUB_BRANCH:'main',
  AUTH_KV: KV, ALLOWED_ORIGINS:'*', JWT_SECRET:'s', PUBLIC_BASE_URL: 'https://sendoff.run',
  USERS: JSON.stringify([{ email: ME, ...await cred('pw') }]),
};
const env = { ...base, DISCORD_WEBHOOK: 'https://discord.test/hook' };

// The real runtime keeps the worker alive for these; here they are simply
// awaited, so an assertion after a commit sees the post it caused.
const waited = [];
const ctx = { waitUntil: (p) => waited.push(p) };
const settle = async () => { await Promise.all(waited.splice(0)); };

const token = await (async () => {
  const r = await worker.fetch(new Request('https://w/login', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ email: ME, password: 'pw' }) }), env);
  return (await r.json()).token;
})();

const commit = async (path, doc, e = env) => {
  const r = await worker.fetch(new Request('https://w/commit', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ path, content: JSON.stringify(doc, null, 2) + '\n',
                           message: 'test', sha: repo.has(path) ? 'sha-' + path : undefined })
  }), e, ctx);
  await settle();
  return r;
};

// A two-lap course of two segments, so four legs is a finish.
const course = {
  courseType: 'loops',
  course: { loopCount: 2, loopDistanceMi: 5, loopSegments: [
    { name: 'Start to Ridge', distanceMi: 2.5 }, { name: 'Ridge to Start', distanceMi: 2.5 } ] },
  startTime: '2026-10-03T13:00:00.000Z',
  runners: [{ id: 'jd', name: 'Jason Dupree', bib: '128' }],
};
const legs = (n) => ({ runners: [{ id: 'jd', legs: Array.from({ length: n }, (_, i) => ({
  index: i + 1,
  startTime: new Date(Date.parse(course.startTime) + i * 3600e3).toISOString(),
  endTime: new Date(Date.parse(course.startTime) + (i + 1) * 3600e3).toISOString(),
})) }] });

let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p?'ok  ':'FAIL'} ${l.padEnd(54)} ${JSON.stringify(g)}${p?'':' expected '+JSON.stringify(w)}`); };

console.log('\nan unlisted race is never announced');
posts = [];
await commit('races/900-secret/config.json',
  { ...course, name: 'Quiet Hundred', location: 'Nowhere', visibility: 'private', createdBy: ME });
ok('creating it says nothing', posts.length, 0);
await commit('races/900-secret/data.json', legs(4));
ok('and finishing it says nothing', posts.length, 0);
ok('not even the slug leaves the worker',
  posts.some(p => JSON.stringify(p).includes('900-secret')), false);

console.log('\na config with no visibility field is not consent');
posts = [];
await commit('races/901-legacy/config.json',
  { ...course, name: 'Old Race', location: 'Somewhere', createdBy: ME });
ok('a missing field announces nothing', posts.length, 0);

console.log('\na public race');
posts = [];
await commit('races/902-open/config.json',
  { ...course, name: 'Blood Root Ultra', location: 'Vermont', visibility: 'public', createdBy: ME });
ok('is announced once', posts.length, 1);
ok('with its name', /Blood Root Ultra/.test(posts[0].content), true);
ok('where and when', /Vermont/.test(posts[0].content) && /October 3, 2026/.test(posts[0].content), true);
ok('and a link somebody can follow',
  /https:\/\/sendoff\.run\/race\.html\?id=902-open/.test(posts[0].content), true);

console.log('\nfinishing it');
posts = [];
await commit('races/902-open/data.json', legs(2));
ok('half way through, nothing is said', posts.length, 0);
await commit('races/902-open/data.json', legs(4));
ok('the finish is announced', posts.length, 1);
ok('naming the racer', /Jason Dupree/.test(posts[0].content), true);
ok('with the elapsed time', /04:00:00/.test(posts[0].content), true);

console.log('\nand only once');
posts = [];
await commit('races/902-open/data.json', legs(4));
ok('a correction after the finish does not repost', posts.length, 0);

console.log('\na race cannot ping the server');
posts = [];
await commit('races/903-loud/config.json',
  { ...course, name: '@everyone free entry', location: '@here', visibility: 'public', createdBy: ME });
ok('mentions are refused by the payload', posts[0].allowed_mentions, { parse: [] });
ok('and stripped from the text before it is sent',
  /@(everyone|here)/.test(posts[0].content), false);

console.log('\nwith no webhook configured');
posts = [];
const quiet = { ...base };
await commit('races/904-quiet/config.json',
  { ...course, name: 'Nobody Listening', location: 'Texas', visibility: 'public', createdBy: ME }, quiet);
ok('the worker never calls Discord at all', posts.length, 0);

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
