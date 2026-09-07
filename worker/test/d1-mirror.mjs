// Every write that lands in git also lands in D1.
//
// Backed by a real SQLite database rather than a stub, because the point of
// this test is the SQL: an upsert that is wrong, or a delete that removes the
// wrong rows, is exactly the kind of thing a hand-written fake would agree
// with. node:sqlite is built into Node 22, so this needs nothing installed.
import worker from '../src/worker.js';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const OWNER = 'owner@example.com', CREW = 'crew@example.com';
const SLUG = 'r1';

// A stand-in for the D1 binding with the same surface the worker uses.
const db = new DatabaseSync(':memory:');
for (const f of ['0001_initial.sql', '0002_leg_shape.sql']) {
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
  // All or nothing, the way D1 runs a batch: a half-applied leg update would
  // leave the mirror disagreeing with git in a way nothing later corrects.
  async batch(stmts) {
    db.exec('BEGIN');
    try {
      for (const s of stmts) db.prepare(s._sql).run(...s._args);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return stmts.map(() => ({ success: true }));
  },
};
// node:sqlite hands back null-prototype rows; the assertions below compare
// them as plain objects.
const row = (r) => (r == null ? r : Object.assign({}, r));
const rows = (rs) => rs.map(row);

const repo = new Map();
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
const env = {
  GITHUB_OWNER:'o', GITHUB_REPO:'r', GITHUB_TOKEN:'t', GITHUB_BRANCH:'main',
  AUTH_KV: KV, DB, ALLOWED_ORIGINS:'*', JWT_SECRET:'s',
  USERS: JSON.stringify([{ email:OWNER, ...await cred('pw') }, { email:CREW, ...await cred('pw') }]),
};
globalThis.fetch = async (url, opts = {}) => {
  const m = String(url).match(/contents\/(.+?)(\?|$)/);
  const path = m ? decodeURIComponent(m[1]) : '';
  if ((opts.method || 'GET') === 'GET') {
    if (!repo.has(path)) return new Response('{"message":"Not Found"}', { status: 404 });
    return new Response(JSON.stringify({ sha:'sha',
      content: Buffer.from(repo.get(path),'utf8').toString('base64') }), { status: 200 });
  }
  repo.set(path, Buffer.from(JSON.parse(opts.body).content,'base64').toString('utf8'));
  return new Response('{}', { status: 200 });
};
const call = (p, o={}) => worker.fetch(new Request('https://w'+p, {
  method: o.method || (o.body ? 'POST' : 'GET'),
  headers: { 'Content-Type':'application/json', ...(o.token?{Authorization:'Bearer '+o.token}:{}) },
  ...(o.body?{body:JSON.stringify(o.body)}:{}) }), env);
async function login(e){ const j=await (await call('/login',{body:{email:e,password:'pw'}})).json(); return j.token; }
const write = (token, path, obj) => call('/commit', { token,
  body: { path, content: JSON.stringify(obj, null, 2), message: 'test' } });

let bad=0;
const ok=(l,g,w)=>{const p=JSON.stringify(g)===JSON.stringify(w); if(!p)bad++;
  console.log(`  ${p?'ok  ':'FAIL'} ${l.padEnd(52)} ${JSON.stringify(g)}${p?'':' expected '+JSON.stringify(w)}`);};

const t = await login(OWNER);
const cfg = { name:'A race', location:'Somewhere', startTime:'2026-09-26T10:00:00Z',
              visibility:'public', createdBy: OWNER,
              people:[{email:CREW,role:'crew'}], runners:[{id:'jason',name:'Jason'}] };

console.log('\ncreating a race mirrors it');
await write(t, `races/${SLUG}/config.json`, cfg);
const race = db.prepare('select * from races where slug=?').get(SLUG);
ok('one race row', !!race, true);
ok('name, location and start carried', [race.name, race.location, race.start_time],
   ['A race','Somewhere','2026-09-26T10:00:00Z']);
ok('the creator is on the row', race.created_by, OWNER);
ok('the roster is in its own table',
   rows(db.prepare('select email, role from race_people where slug=?').all(SLUG)), [{email:CREW,role:'crew'}]);
ok('the config stored has no roster in it', JSON.parse(race.config).people, undefined);

console.log('\nlogging splits mirrors every leg');
const leg = (i, extra={}) => ({ index:i, startTime:`2026-09-26T1${i}:00:00Z`,
  endTime:`2026-09-26T1${i}:45:00Z`, calories:300, fluidOz:22.5, sodiumMg:700, ...extra });
await write(t, `races/${SLUG}/data.json`, { runners:[{ id:'jason',
  legs:[leg(1), leg(2, { notes:'felt rough', issues:['cramp'], intakeEstimated:true })] }] });
const legs = db.prepare('select * from legs where slug=? order by idx').all(SLUG);
ok('two legs', legs.length, 2);
ok('times and intake typed out', [legs[0].start_time, legs[0].calories, legs[0].fluid_oz, legs[0].sodium_mg],
   ['2026-09-26T11:00:00Z', 300, 22.5, 700]);
ok('notes, issues and the estimate flag',
   [legs[1].notes, JSON.parse(legs[1].issues), legs[1].intake_estimated], ['felt rough', ['cramp'], 1]);
ok('who pressed it', legs[0].actor, OWNER);
ok('raw round-trips the leg exactly', JSON.parse(legs[1].raw), leg(2, { notes:'felt rough', issues:['cramp'], intakeEstimated:true }));

console.log('\nediting a split updates rather than duplicates');
await write(t, `races/${SLUG}/data.json`, { runners:[{ id:'jason',
  legs:[{ ...leg(1), endTime:'2026-09-26T11:30:00Z' }, leg(2)] }] });
const after = db.prepare('select * from legs where slug=? order by idx').all(SLUG);
ok('still two legs', after.length, 2);
ok('the end time moved', after[0].end_time, '2026-09-26T11:30:00Z');

console.log('\ndeleting a split removes its row');
await write(t, `races/${SLUG}/data.json`, { runners:[{ id:'jason', legs:[leg(1)] }] });
ok('one leg left', db.prepare('select count(*) c from legs where slug=?').get(SLUG).c, 1);
ok('and it is the right one', db.prepare('select idx from legs where slug=?').get(SLUG).idx, 1);

console.log('\na second runner does not disturb the first');
await write(t, `races/${SLUG}/data.json`, { runners:[
  { id:'jason', legs:[leg(1)] }, { id:'sam', legs:[leg(1), leg(2)] }] });
ok('three legs across two runners',
   rows(db.prepare('select runner_id, count(*) c from legs where slug=? group by runner_id order by runner_id').all(SLUG)),
   [{runner_id:'jason',c:1},{runner_id:'sam',c:2}]);

console.log('\nthe mirror never fails the write');
const broken = { ...env, DB: { prepare(){ throw new Error('D1 is down'); }, async batch(){ throw new Error('D1 is down'); } } };
const r = await worker.fetch(new Request('https://w/commit', { method:'POST',
  headers:{'Content-Type':'application/json', Authorization:'Bearer '+t},
  body: JSON.stringify({ path:`races/${SLUG}/data.json`, content:'{"runners":[]}', message:'x' }) }), broken);
ok('the caller is still told it worked', r.status, 200);
ok('and git has it', JSON.parse(repo.get(`races/${SLUG}/data.json`)).runners, []);

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
