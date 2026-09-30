// Reads served from D1, which is where every race write lands.
//
// The thing being tested is not "does it return something" but "does it return
// the same thing": the bytes written, and a version the next write will
// accept, because the client hands the sha it was given straight back as its
// concurrency guard. Before 2026-09-30 this compared D1 against git, when git
// took the writes and D1 was the copy; git now holds only archives, so the
// comparison is against what was written.
import worker from '../src/worker.js';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const OWNER = 'owner@example.com', CREW = 'crew@example.com';
const SLUG = 'r1';

const db = new DatabaseSync(':memory:');
for (const f of ['0001_initial.sql', '0002_leg_shape.sql', '0003_documents.sql']) {
  db.exec(fs.readFileSync(new URL('../migrations/' + f, import.meta.url), 'utf8'));
}
const mkStmt = (sql) => ({
  _sql: sql, _args: [],
  bind(...a) { this._args = a; return this; },
  // D1's shape: { meta: { changes } }, which the version guard reads.
  async run() { const r = db.prepare(this._sql).run(...this._args); return { meta: r, success: true }; },
  async all() { return { results: db.prepare(this._sql).all(...this._args) }; },
});
const DB = {
  prepare: (sql) => mkStmt(sql),
  async batch(stmts) {
    db.exec('BEGIN');
    try { for (const s of stmts) db.prepare(s._sql).run(...s._args); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
    return stmts.map(() => ({ success: true }));
  },
};

const repo = new Map();
const shas = new Map();
let ghReads = 0;
const kv = new Map();
const KV = { async get(k){return kv.has(k)?kv.get(k):null;}, async put(k,v){kv.set(k,v);},
             async delete(k){kv.delete(k);},
             async list({prefix}){return {keys:[...kv.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name}))};} };
globalThis.caches = { default: { async match(){return undefined;}, async put(){}, async delete(){return true;} } };
async function cred(pw){
  const salt=new Uint8Array(16); crypto.getRandomValues(salt);
  const km=await crypto.subtle.importKey('raw',new TextEncoder().encode(pw),'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:100000,hash:'SHA-256'},km,256);
  const b=a=>Buffer.from(a).toString('base64');
  return { hash:b(new Uint8Array(bits)), salt:b(salt), iterations:100000 };
}
const base = {
  GITHUB_OWNER:'o', GITHUB_REPO:'r', GITHUB_TOKEN:'t', GITHUB_BRANCH:'main',
  AUTH_KV: KV, DB, ALLOWED_ORIGINS:'*', JWT_SECRET:'s',
  USERS: JSON.stringify([{ email:OWNER, ...await cred('pw'), role:'admin' },
                         { email:CREW,  ...await cred('pw') }]),
};
const env = base;

let n = 0;
globalThis.fetch = async (url, opts = {}) => {
  const m = String(url).match(/contents\/(.+?)(\?|$)/);
  const path = m ? decodeURIComponent(m[1]) : '';
  if ((opts.method || 'GET') === 'GET') {
    ghReads++;
    if (!repo.has(path)) return new Response('{"message":"Not Found"}', { status: 404 });
    return new Response(JSON.stringify({ name: path.split('/').pop(), path, sha: shas.get(path),
      size: repo.get(path).length, encoding: 'base64',
      content: Buffer.from(repo.get(path),'utf8').toString('base64') }), { status: 200 });
  }
  const text = Buffer.from(JSON.parse(opts.body).content,'base64').toString('utf8');
  repo.set(path, text);
  const sha = 'sha' + (++n);
  shas.set(path, sha);
  return new Response(JSON.stringify({ content: { sha } }), { status: 200 });
};
const call = (env, p, o={}) => worker.fetch(new Request('https://w'+p, {
  method: o.method || (o.body ? 'POST' : 'GET'),
  headers: { 'Content-Type':'application/json', ...(o.token?{Authorization:'Bearer '+o.token}:{}) },
  ...(o.body?{body:JSON.stringify(o.body)}:{}) }), env);
async function login(e){ const j=await (await call(env,'/login',{body:{email:e,password:'pw'}})).json(); return j.token; }
const write = (token, path, text, sha, e = env) => call(e, '/commit', { token,
  body: { path, content: text, sha: sha || null, message: 'test' } });
const get = (e, token, path) => call(e, '/get?path=' + encodeURIComponent(path), { token });
const text = (j) => Buffer.from(j.content, 'base64').toString('utf8');

let bad=0;
const ok=(l,g,w)=>{const p=JSON.stringify(g)===JSON.stringify(w); if(!p)bad++;
  console.log(`  ${p?'ok  ':'FAIL'} ${l.padEnd(54)} ${JSON.stringify(g)}${p?'':' expected '+JSON.stringify(w)}`);};

const t = await login(OWNER);
const cfgText = JSON.stringify({ name:'A race', location:'Somewhere',
  startTime:'2026-09-26T10:00:00Z', visibility:'public', createdBy: OWNER,
  people:[{email:CREW,role:'crew'}], runners:[{id:'jason',name:'Jason'}] }, null, 2) + '\n';
const dataText = JSON.stringify({ lastUpdated:'2026-09-26T14:03:00Z',
  runners:[{ id:'jason', legs:[{ index:1, startTime:'2026-09-26T11:00:00Z', notes:'ok' }] }] }, null, 2) + '\n';
await write(t, `races/${SLUG}/config.json`, cfgText);
await write(t, `races/${SLUG}/data.json`, dataText);

console.log('\na read gives back exactly what was written');
const first = await (await get(env, t, `races/${SLUG}/data.json`)).json();
ok('the bytes are the file, unchanged', text(first), dataText);
ok('lastUpdated survived the round trip', JSON.parse(text(first)).lastUpdated, '2026-09-26T14:03:00Z');
ok('with a version of the database\'s own', /^d1-/.test(first.sha), true);
ok('and git was never asked to hold it', repo.has(`races/${SLUG}/data.json`), false);

console.log('\nthe version it hands back is one a write will accept');
const r = await write(t, `races/${SLUG}/data.json`, dataText.replace('ok','better'), first.sha);
ok('a write using it succeeds', r.status, 200);
ok('and the next read has it', text(await (await get(env, t, `races/${SLUG}/data.json`)).json()).includes('better'), true);

console.log('\na config read still says who you are');
const cfgD1 = JSON.parse(text(await (await get(env, t, `races/${SLUG}/config.json`)).json()));
ok('myRole is injected', cfgD1.myRole, 'owner');
ok('and the roster is not in the stored copy',
   JSON.parse(db.prepare('select config from races where slug=?').get(SLUG).config).people, undefined);

console.log('\na race the database has not seen is served by git anyway');
// An archived race from before the database, with no row. Every race on the
// site was this until the backfill.
repo.set('races/r9/config.json', '{"name":"Untouched","visibility":"public"}');
shas.set('races/r9/config.json', 'sha-r9');
kv.set('acl:r9', JSON.stringify({ createdBy: OWNER, people:[], teamCanInvite:false, runnerEmails:{} }));
const miss = await (await get(env, t, 'races/r9/config.json')).json();
ok('it reads, rather than 404s', miss.sha, 'sha-r9');
ok('with the name from the file', JSON.parse(text(miss)).name, 'Untouched');

console.log('\nwith a database bound, a poll costs git nothing, whatever is set');
// READ_FROM_D1 used to decide this, and the default was git. Writes only go
// to D1 now, so a read that skipped it would show a running race frozen at
// whatever git last held. No setting is consulted any more.
for (const [label, extra] of [['as deployed', {}], ['with the old switch off', { READ_FROM_D1: 'false' }]]) {
  ghReads = 0;
  await get({ ...base, ...extra }, t, `races/${SLUG}/config.json`);
  await get({ ...base, ...extra }, t, `races/${SLUG}/data.json`);
  ok(label, ghReads, 0);
}

console.log('\na press the database cannot store is refused, and reads keep the last that landed');
let breakDb = false;
const flaky = { ...base, DB: {
  prepare: (sql) => {
    const st = mkStmt(sql);
    if (breakDb && /INSERT INTO/i.test(sql)) st.run = async () => { throw new Error('D1 write failed'); };
    return st;
  },
  async batch(stmts) {
    if (breakDb) throw new Error('D1 write failed');
    return DB.batch(stmts);
  },
} };
const before = await (await get(env, t, `races/${SLUG}/data.json`)).json();
breakDb = true;
const w = await write(t, `races/${SLUG}/data.json`, dataText.replace('ok', 'lost split'), before.sha, flaky);
breakDb = false;
ok('the crew is told to try again', w.status, 503);
const after = await (await get(env, t, `races/${SLUG}/data.json`)).json();
ok('the read shows the last press that landed', text(after), text(before));
ok('with the version it had, so the retry is taken', after.sha, before.sha);
const retry = await write(t, `races/${SLUG}/data.json`, dataText.replace('ok', 'lost split'), after.sha);
ok('and the retry lands', [retry.status,
  text(await (await get(env, t, `races/${SLUG}/data.json`)).json()).includes('lost split')], [200, true]);

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
