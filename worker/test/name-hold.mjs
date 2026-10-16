// A race name that trips the foul-language check is held for review: the race
// is made and works, and is kept off the hub, the share page and Discord until
// an admin lets the name through or the race is renamed to one that passes.
//
//   node worker/test/name-hold.mjs
import worker from '../src/worker.js';
import { nameProblems } from '../src/moderation.js';
import { fakeD1 } from './fake-d1.mjs';

const OWNER = 'owner@example.com', ADMIN = 'admin@example.com';
const repo = new Map();
const kvStore = new Map();
const KV = {
  async get(k) { const v = kvStore.get(k); return v === undefined ? null : v; },
  async put(k, v) { kvStore.set(k, v); },
  async delete(k) { kvStore.delete(k); },
  async list({ prefix, cursor }) {
    return { keys: [...kvStore.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name })), list_complete: true };
  },
};
globalThis.caches = { default: { async match(){}, async put(){}, async delete(){ return true; } } };
let posts = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (/^https:\/\/sendoff\.run\/races\/[^/]+\/$/.test(u)) return new Response('', { status: 404 });
  if (u.startsWith('https://discord.test/')) { posts.push(JSON.parse(opts.body)); return new Response('', { status: 204 }); }
  if (u.includes('/git/trees/')) return new Response(JSON.stringify({ tree: [] }), { status: 200 });
  const m = u.match(/contents\/(.+?)(\?|$)/);
  const path = m ? decodeURIComponent(m[1]) : '';
  const method = opts.method || 'GET';
  if (method === 'GET') {
    if (!repo.has(path)) return new Response('{"message":"Not Found"}', { status: 404 });
    return new Response(JSON.stringify({ sha: 'sha-' + path, content: Buffer.from(repo.get(path), 'utf8').toString('base64') }), { status: 200 });
  }
  if (method === 'DELETE') { repo.delete(path); return new Response('{}', { status: 200 }); }
  const body = JSON.parse(opts.body);
  repo.set(path, Buffer.from(body.content, 'base64').toString('utf8'));
  return new Response(JSON.stringify({ content: { path, sha: 'new-' + path } }), { status: 200 });
};
async function cred(pw) {
  const salt = new Uint8Array(16); crypto.getRandomValues(salt);
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, km, 256);
  const b = a => Buffer.from(a).toString('base64');
  return { hash: b(new Uint8Array(bits)), salt: b(salt), iterations: 100000 };
}
const env = {
  DB: fakeD1(), GITHUB_OWNER: 'o', GITHUB_REPO: 'r', GITHUB_TOKEN: 't', GITHUB_BRANCH: 'main',
  AUTH_KV: KV, ALLOWED_ORIGINS: '*', JWT_SECRET: 's', PUBLIC_BASE_URL: 'https://sendoff.run',
  DISCORD_WEBHOOK: 'https://discord.test/hook',
  USERS: JSON.stringify([{ email: OWNER, ...await cred('pw') }, { email: ADMIN, role: 'admin', ...await cred('pw') }]),
};
const waited = [];
const ctx = { waitUntil: (p) => waited.push(p) };
const settle = async () => { await Promise.all(waited.splice(0)); };
const call = async (p, o = {}) => {
  const r = await worker.fetch(new Request('https://w' + p, {
    method: o.body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(o.token ? { Authorization: 'Bearer ' + o.token } : {}) },
    ...(o.body ? { body: JSON.stringify(o.body) } : {}) }), env, ctx);
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, ...(j || {}) };
};
const login = async (e) => (await call('/login', { body: { email: e, password: 'pw' } })).token;
const owner = await login(OWNER), admin = await login(ADMIN);
const put = (token, path, doc, sha) => call('/commit', { token, body: { path, content: JSON.stringify(doc), message: 't', ...(sha ? { sha } : {}) } });
const readCfg = async (slug, token) => {
  const r = await call('/get?path=' + encodeURIComponent(`races/${slug}/config.json`), { token });
  return r.content ? JSON.parse(Buffer.from(r.content, 'base64').toString('utf8')) : r;
};
// A change to a race's config, made the way settings makes one: read it, with
// the version it is at, and write it back changed.
const edit = async (slug, change) => {
  const r = await call('/get?path=' + encodeURIComponent(`races/${slug}/config.json`), { token: owner });
  const doc = JSON.parse(Buffer.from(r.content, 'base64').toString('utf8'));
  return put(owner, `races/${slug}/config.json`, { ...doc, ...change }, r.sha);
};
const hub = () => (JSON.parse(repo.get('races/index.json') || '{"races":[]}').races || []).map(r => `${r.slug}: ${r.name}`);
const held = (slug) => { const v = kvStore.get('held:' + slug); return v ? JSON.parse(v) : null; };
const race = (name, extra) => ({ name, visibility: 'public', createdBy: OWNER, runners: [{ id: 'a', name: 'A' }],
  startTime: '2026-11-01T13:00:00Z', ...extra });

let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p ? 'ok  ' : 'FAIL'} ${l.padEnd(62)} ${JSON.stringify(g)}${p ? '' : ' expected ' + JSON.stringify(w)}`); };

console.log('\nthe check');
const clean = ['Hellgate 100K', 'Massanutten Mountain Trails 100', 'Cumberland Trail 50', 'Dick Collins Firetrails 50',
  'Scunthorpe Half', 'Badass 50K', 'Cockeysville Classic', 'Assateague Island', 'Push It 5K', 'Ghost Train 30 Hour Ultra'];
ok('real race names pass', clean.filter(n => nameProblems(n).length), []);
ok('the clearly foul is caught', ['Fuck It 50', 'Bullshit Backyard', 'Bitchin 50', 'Nazi Run'].map(n => nameProblems(n)),
  [['fuck'], ['shit'], ['bitch'], ['nazi']]);
ok('through stand-ins, stars, spacing and stretching', ['F*ck It', 'Sh!tshow', 'F.U.C.K. 100', 'fuuuck', '$hit', 'Fück'].map(n => nameProblems(n).length > 0),
  [true, true, true, true, true, true]);

console.log('\na race made with a name that trips it');
await repo.set('races/index.json', JSON.stringify({ races: [] }));
const made = await put(owner, 'races/foul/config.json', race('Fuck It 50'));
ok('is made, and the wizard is told it is held', [made.status, made.held], [200, true]);
ok('held, with what tripped it and who made it', [held('foul').name, held('foul').words, held('foul').by], ['Fuck It 50', ['fuck'], OWNER]);
await put(owner, 'races/index.json', { races: [{ slug: 'foul', name: 'Fuck It 50' }] });
ok('is kept off the hub when the wizard lists it', hub(), []);
await settle();
ok('and is not posted to Discord', posts.length, 0);
await put(owner, 'races/nice/config.json', race('Nice Run 50'));
await settle();
ok('a race with a clean name is posted, as before', posts.length, 1);
await put(owner, 'races/index.json', { races: [{ slug: 'nice', name: 'Nice Run 50' }] });
ok('and listed', hub(), ['nice: Nice Run 50']);

console.log('\nthe people running it are told; nobody else is');
ok('the owner reads held', (await readCfg('foul', owner)).held, true);
ok('a stranger does not', (await readCfg('foul')).held, undefined);
ok('an ordinary save goes through', (await edit('foul', { units: 'km' })).status, 200);
ok('and writing the config back does not store it', (await readCfg('foul')).held, undefined);
ok('nor does an ordinary save let it go', !!held('foul'), true);

console.log('\nanybody writing the hub list');
await put(owner, 'races/index.json', { races: [{ slug: 'nice', name: 'Nice Run 50' }, { slug: 'sneaky', name: 'Shit Show' }] });
ok('cannot list a foul name for any race', hub(), ['nice: Nice Run 50']);
ok('and the race it named is held', held('sneaky') && held('sneaky').words, ['shit']);

console.log('\nthe admin');
const list = await call('/held', { token: admin });
ok('sees every held race, newest first, with its name', list.held.map(h => `${h.slug}: ${h.name}`).sort(), ['foul: Fuck It 50', 'sneaky: Shit Show']);
ok('and nobody else can', [(await call('/held', { token: owner })).status, (await call('/held/approve', { token: owner, body: { slug: 'foul' } })).status], [403, 403]);

console.log('\nrenamed to a name that passes');
await edit('foul', { name: 'Fun Run 50' });
ok('it is let go', held('foul'), null);
ok('and goes on the hub under its new name', hub().sort(), ['foul: Fun Run 50', 'nice: Nice Run 50']);

console.log('\nrenamed back');
const back = await edit('foul', { name: 'F*ck It 50' });
ok('it is held again', [back.held, held('foul') && held('foul').name], [true, 'F*ck It 50']);
ok('and comes straight off the hub', hub(), ['nice: Nice Run 50']);

console.log('\nlet through by the admin');
const yes = await call('/held/approve', { token: admin, body: { slug: 'foul' } });
ok('it is let go and listed', [yes.ok, yes.listed, held('foul')], [true, true, null]);
ok('under the name it has', hub().sort(), ['foul: F*ck It 50', 'nice: Nice Run 50']);
await put(owner, 'races/index.json', JSON.parse(repo.get('races/index.json')));
ok('and the same name is not held again on the next write', [hub().length, held('foul')], [2, null]);
await edit('foul', { name: 'Fuck It 50' });
ok('a different one is', !!held('foul'), true);
const gone = await call('/held/approve', { token: admin, body: { slug: 'sneaky' } });
ok('a hold on a race that does not exist is cleared', [gone.status, held('sneaky')], [404, null]);

console.log('\nmade public while held');
await put(owner, 'races/flip/config.json', race('Clean Run'));
await edit('flip', { name: 'Shit Show' });
await call('/race/visibility', { token: admin, body: { slug: 'flip', visibility: 'private' } });
const pub = await call('/race/visibility', { token: admin, body: { slug: 'flip', visibility: 'public' } });
ok('it is public, and says it is held', [pub.visibility, pub.held], ['public', true]);
ok('it is not listed', hub().some(e => e.startsWith('flip:')), false);
ok('and gets no share page', repo.has('races/flip/index.html'), false);

console.log('\ndeleted');
await call('/race/delete', { token: owner, body: { slug: 'flip' } });
ok('its hold goes with it', held('flip'), null);

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
