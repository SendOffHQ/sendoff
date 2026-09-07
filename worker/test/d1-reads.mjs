// Reads served from the mirror instead of from git.
//
// The thing being tested is not "does it return something" but "does it return
// the same thing". A read that comes back subtly different from the git one
// breaks a write, because the client hands the sha it was given straight back
// as its concurrency guard.
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
  async run() { return db.prepare(this._sql).run(...this._args); },
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
const gitEnv = { ...base, READ_FROM_D1: 'false' };
const d1Env  = { ...base, READ_FROM_D1: 'true' };

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
  // GitHub names the blob it just made; the worker takes the sha from here.
  return new Response(JSON.stringify({ content: { sha } }), { status: 200 });
};
const call = (env, p, o={}) => worker.fetch(new Request('https://w'+p, {
  method: o.method || (o.body ? 'POST' : 'GET'),
  headers: { 'Content-Type':'application/json', ...(o.token?{Authorization:'Bearer '+o.token}:{}) },
  ...(o.body?{body:JSON.stringify(o.body)}:{}) }), env);
async function login(e){ const j=await (await call(gitEnv,'/login',{email:e,body:{email:e,password:'pw'}})).json(); return j.token; }
const write = (token, path, text, sha) => call(gitEnv, '/commit', { token,
  body: { path, content: text, sha: sha || null, message: 'test' } });
const get = (env, token, path) => call(env, '/get?path=' + encodeURIComponent(path), { token });

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

console.log('\nthe mirror gives back what git gives back');
const fromGit = await (await get(gitEnv, t, `races/${SLUG}/data.json`)).json();
const fromD1  = await (await get(d1Env,  t, `races/${SLUG}/data.json`)).json();
ok('same sha', fromD1.sha, fromGit.sha);
ok('same bytes', fromD1.content, fromGit.content);
ok('and the bytes are the file, unchanged',
   Buffer.from(fromD1.content, 'base64').toString('utf8'), dataText);
ok('lastUpdated survived the round trip',
   JSON.parse(Buffer.from(fromD1.content,'base64').toString('utf8')).lastUpdated,
   '2026-09-26T14:03:00Z');

console.log('\nthe sha it hands back is one git will still accept');
const guard = fromD1.sha;
const r = await write(t, `races/${SLUG}/data.json`, dataText.replace('ok','better'), guard);
ok('a write using it succeeds', r.status, 200);
ok('and the mirror moved with it',
   Buffer.from((await (await get(d1Env, t, `races/${SLUG}/data.json`)).json()).content,'base64')
     .toString('utf8').includes('better'), true);

console.log('\na config read still says who you are');
const cfgD1 = JSON.parse(Buffer.from(
  (await (await get(d1Env, t, `races/${SLUG}/config.json`)).json()).content, 'base64').toString('utf8'));
ok('myRole is injected the same way', cfgD1.myRole, 'owner');
ok('and the roster is still not in the stored copy',
   JSON.parse(db.prepare('select config from races where slug=?').get(SLUG).config).people, undefined);

console.log('\na race the mirror has not seen is served by git anyway');
repo.set('races/r9/config.json', '{"name":"Untouched","visibility":"public"}');
shas.set('races/r9/config.json', 'sha-r9');
kv.set('acl:r9', JSON.stringify({ createdBy: OWNER, people:[], teamCanInvite:false, runnerEmails:{} }));
const miss = await (await get(d1Env, t, 'races/r9/config.json')).json();
ok('it reads, rather than 404s', miss.sha, 'sha-r9');
ok('with the name from the file',
   JSON.parse(Buffer.from(miss.content,'base64').toString('utf8')).name, 'Untouched');

console.log('\nthe flag is what decides, and it is off unless it says true');
ghReads = 0;
await get(d1Env, t, `races/${SLUG}/config.json`);
await get(d1Env, t, `races/${SLUG}/data.json`);
ok('on: git is not asked at all', ghReads, 0);
ok('and a whole poll costs git nothing', ghReads, 0);
ghReads = 0;
await get(gitEnv, t, `races/${SLUG}/config.json`);
await get(gitEnv, t, `races/${SLUG}/data.json`);
// Two per file: the access check reads the config, then the file itself is
// read. The live worker's 3s cache folds some of these together; the point
// here is the shape, which is that every read is a trip to GitHub.
ok('off: the same poll is four trips to GitHub', ghReads, 4);
ghReads = 0;
await get({ ...base }, t, `races/${SLUG}/data.json`);
ok('absent means off', ghReads > 0, true);
ghReads = 0;
await get({ ...base, READ_FROM_D1: 'yes' }, t, `races/${SLUG}/data.json`);
ok('and only the word true turns it on', ghReads > 0, true);

console.log('\nand the mirror never serves a read it cannot stand behind');
db.prepare('update races set data_sha = null where slug = ?').run(SLUG);
ghReads = 0;
const noSha = await (await get(d1Env, t, `races/${SLUG}/data.json`)).json();
ok('a row with no sha falls through to git', ghReads > 0, true);
ok('and git answers with a real one', typeof noSha.sha, 'string');

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
