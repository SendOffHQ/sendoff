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
import { fakeD1 } from './fake-d1.mjs';

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

// Which races have been through tools/make-og.py, and so have a share page.
let sharePages = new Set();
// Which finishers have had their finish card drawn and put on the site.
let finishPages = new Set();

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  // The HEAD that decides whether to post the pretty URL or the app one.
  const share = u.match(/^https:\/\/sendoff\.run\/races\/([^/]+)\/$/);
  if (share) {
    return new Response('', { status: sharePages.has(share[1]) ? 200 : 404 });
  }
  const fin = u.match(/^https:\/\/sendoff\.run\/races\/([^/]+)\/finish-([^/]+)$/);
  if (fin) return new Response('', { status: finishPages.has(fin[1] + '/' + fin[2]) ? 200 : 404 });
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
  DB: fakeD1(),
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

// The version the database handed out for this file, which a save sends back.
const versionOf = (e, path) => {
  const m = /^races\/([^/]+)\/(config|data)\.json$/.exec(path);
  const r = m && e.DB && e.DB.races.get(m[1]);
  return (r && r[m[2] + '_sha']) || undefined;
};
const commit = async (path, doc, e = env) => {
  const r = await worker.fetch(new Request('https://w/commit', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ path, content: JSON.stringify(doc, null, 2) + '\n',
                           message: 'test', sha: versionOf(e, path) })
  }), e, ctx);
  await settle();
  return r;
};

// A two-lap course of two segments, so four legs is a finish. Started five
// hours ago rather than on a fixed day: only a finish that just happened is
// announced, so a fixed date would turn this test off as the calendar moved.
const T0 = Math.floor((Date.now() - 5 * 3600e3) / 1000) * 1000;
const T0_DAY = new Date(T0).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const course = {
  courseType: 'loops',
  course: { loopCount: 2, loopDistanceMi: 5, loopSegments: [
    { name: 'Start to Ridge', distanceMi: 2.5 }, { name: 'Ridge to Start', distanceMi: 2.5 } ] },
  startTime: new Date(T0).toISOString(),
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
ok('where and when', /Vermont/.test(posts[0].content) && posts[0].content.includes(T0_DAY), true);
ok('and a link somebody can follow',
  /https:\/\/sendoff\.run\/race\?id=902-open/.test(posts[0].content), true);

console.log('\nan evening start, announced on its own day');
posts = [];
// 9 PM in Denver on October 3 is already October 4 in UTC.
await commit('races/903-night/config.json',
  { ...course, startTime: '2026-10-03T21:00:00-06:00', timezone: 'America/Denver',
    name: 'Night Owl 50', location: 'Colorado', visibility: 'public', createdBy: ME });
ok('in the race\'s zone', /October 3, 2026/.test(posts[0] && posts[0].content), true);
posts = [];
await commit('races/904-night-old/config.json',
  { ...course, startTime: '2026-10-03T21:00:00-06:00',
    name: 'Night Owl Classic', location: 'Colorado', visibility: 'public', createdBy: ME });
ok('and with no zone, by the date its start was written with', /October 3, 2026/.test(posts[0] && posts[0].content), true);

console.log('\nwhen the race has a share page of its own');
// tools/make-og.py has been run for this one, so /races/<slug>/ exists and
// carries that race's name and card rather than the generic ones.
sharePages.add('905-pretty');
posts = [];
await commit('races/905-pretty/config.json',
  { ...course, name: 'Sangre de Cristo 100', location: 'Westcliffe, CO',
    visibility: 'public', createdBy: ME });
ok('that page is what gets posted',
  /https:\/\/sendoff\.run\/races\/905-pretty\/$/m.test(posts[0].content.trim()), true);
ok('and not the generic app URL', /race\?id=/.test(posts[0].content), false);

const flush = async (e = env) => (await (await worker.fetch(new Request('https://w/discord/flush', { method: 'POST' }), e, ctx)).json());
posts = [];
await commit('races/905-pretty/data.json', legs(4));
ok('a finish waits for its own card', posts.length, 0);
ok('and puts the finisher where make-og.py draws it from',
  JSON.parse(repo.get('races/905-pretty/finishers.json')).finishers, [{ id: 'jd', name: 'Jason Dupree', time: '04:00:00' }]);
ok('asking before the card is up sends nothing', [(await flush()).posted, posts.length], [0, 0]);
finishPages.add('905-pretty/jd');
ok('once it is on the site, the post goes', (await flush()).posted, 1);
ok('linking the finish page, whose preview is the finish card',
  /^https:\/\/sendoff\.run\/races\/905-pretty\/finish-jd$/m.test(posts[0].content.trim()), true);
ok('and only once', [(await flush()).posted, posts.length], [0, 1]);

console.log('\nand when it does not have one yet');
posts = [];
await commit('races/906-fresh/config.json',
  { ...course, name: 'Made Five Minutes Ago', location: 'Texas',
    visibility: 'public', createdBy: ME });
ok('it falls back rather than posting a 404',
  /race\?id=906-fresh/.test(posts[0].content), true);

console.log('\nfinishing it');
posts = [];
await commit('races/902-open/data.json', legs(2));
ok('half way through, nothing is said', posts.length, 0);
await commit('races/902-open/data.json', legs(4));
ok('the finish is held for its card', posts.length, 0);
// The card never arrives: half an hour on, the post goes with the race's own.
const held = JSON.parse(kvStore.get('dsc:finpend'));
kvStore.set('dsc:finpend', JSON.stringify(held.map(p => ({ ...p, at: p.at - 31 * 60e3 }))));
await flush();
ok('and goes anyway when the card is too long coming', posts.length, 1);
ok('naming the racer', /Jason Dupree/.test(posts[0].content), true);
ok('with the elapsed time', /04:00:00/.test(posts[0].content), true);
ok('and the race\'s own address', /race\?id=902-open/.test(posts[0].content), true);

console.log('\na held finish for a race that is gone');
posts = [];
kvStore.set('dsc:finpend', JSON.stringify([{ slug: 'nowhere', id: 'x', text: '**X** finished.', at: Date.now() - 60 * 60e3 }]));
await flush();
ok('is dropped, not posted', [posts.length, kvStore.has('dsc:finpend')], [0, false]);

console.log('\nwhen the repository will not take the finish');
posts = [];
const noGit = { ...env, GITHUB_TOKEN: '' };
await commit('races/907-nogit/config.json',
  { ...course, name: 'No Repo 50', location: 'Ohio', visibility: 'public', createdBy: ME }, noGit);
posts = [];
await commit('races/907-nogit/data.json', legs(4), noGit);
ok('the finish is posted at once, with the race\'s card', [posts.length, /race\?id=907-nogit/.test(posts[0] && posts[0].content)], [1, true]);

console.log('\nand only once');
posts = [];
await commit('races/902-open/data.json', legs(4));
ok('a correction after the finish does not repost', posts.length, 0);

console.log('\na timed race');
posts = [];
await commit('races/908-timed/config.json',
  { ...course, name: 'Twenty Four', location: 'Texas', visibility: 'public', createdBy: ME, format: 'timed',
    cutoffs: { totalHours: 24 },
    course: { loopDistanceMi: 15, loops: [{ name: 'Loop A', distanceMi: 15, times: 6 }, { name: 'Loop B', distanceMi: 10, times: 1 }] } });
posts = [];
await commit('races/908-timed/data.json', legs(4));
ok('four laps in, still racing: nothing is said', [posts.length, repo.has('races/908-timed/finishers.json')], [0, false]);
const stoppedLegs = legs(4); stoppedLegs.runners[0].stoppedAt = new Date().toISOString();
await commit('races/908-timed/data.json', stoppedLegs);
ok('stopped, the result is the distance and the laps',
  JSON.parse(repo.get('races/908-timed/finishers.json')).finishers, [{ id: 'jd', name: 'Jason Dupree', time: null, distance: '60.0 mi', laps: 4 }]);
const timedHeld = JSON.parse(kvStore.get('dsc:finpend') || '[]').find(p => p.slug === '908-timed');
ok('and the post says how far', timedHeld && timedHeld.text, '**Jason Dupree** ran 60.0 mi (4 laps) at Twenty Four.');
kvStore.delete('dsc:finpend');

console.log('\na race finished long ago, saved again');
posts = [];
const oldCourse = { ...course, startTime: '2026-09-01T13:00:00.000Z' };
await commit('races/909-old/config.json', { ...oldCourse, name: 'Long Done', location: 'Utah', visibility: 'public', createdBy: ME });
posts = [];
const oldLegs = { runners: [{ id: 'jd', legs: Array.from({ length: 4 }, (_, i) => ({ index: i + 1,
  startTime: new Date(Date.parse(oldCourse.startTime) + i * 3600e3).toISOString(),
  endTime: new Date(Date.parse(oldCourse.startTime) + (i + 1) * 3600e3).toISOString() })) }] };
await commit('races/909-old/data.json', oldLegs);
ok('is not announced as if it had just happened', [posts.length, repo.has('races/909-old/finishers.json')], [0, false]);

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
