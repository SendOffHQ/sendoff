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
  USERS: JSON.stringify([{ email:OWNER, ...await cred('pw'), role:'admin' },
                         { email:CREW,  ...await cred('pw') }]),
};
globalThis.fetch = async (url, opts = {}) => {
  // The backfill finds races by walking the git tree.
  if (String(url).includes('/git/trees/')) {
    return new Response(JSON.stringify({ tree: [...repo.keys()]
      .filter(p => /^races\/[^/]+\/config\.json$/.test(p))
      .map(path => ({ type:'blob', path })) }), { status: 200 });
  }
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


// A race that predates the mirror: in git, with an access list in KV, but
// never written through the worker since the mirror existed. This is every
// race on the site right now, which is what the backfill is for.
console.log('\nthe backfill brings in a race the mirror never saw');
const OLD = 'r0';
repo.set(`races/${OLD}/config.json`, JSON.stringify({ name:'An older race', location:'Elsewhere',
  startTime:'2026-08-01T13:00:00Z', visibility:'public', runners:[{id:'pat',name:'Pat'}] }));
repo.set(`races/${OLD}/data.json`, JSON.stringify({ runners:[{ id:'pat', legs:[leg(1), leg(2)] }] }));
kv.set('acl:' + OLD, JSON.stringify({ createdBy: OWNER, people:[{email:CREW,role:'crew'}],
  teamCanInvite:false, runnerEmails:{} }));

const status = () => call('/d1-status', { token: t }).then(r => r.json());
const before = (await status()).races.find(r => r.slug === OLD);
ok('the older race is missing before', [before.inD1, before.legs, before.gitLegs], [false, 0, 2]);
ok('and the check says so', (await status()).allMatch, false);
// The write above went to git with D1 down, so r1's legs are now stale. The
// check has to notice a drift like that too, not just a missing race: after
// reads move over it is the only thing standing between a quiet divergence
// and a race day run off the wrong numbers.
const drifted = (await status()).races.find(r => r.slug === SLUG);
ok('a leg count that has drifted is caught',
   [drifted.inD1, drifted.legs, drifted.gitLegs, drifted.matches], [true, 3, 0, false]);

const fill = await (await call('/d1-backfill', { token: t, method:'POST' })).json();
ok('the backfill reports no failures', [fill.ok, fill.failed], [true, []]);

const filled = (await status()).races.find(r => r.slug === OLD);
ok('now it is there, with its roster and its legs',
   [filled.inD1, filled.createdBy, filled.people, filled.legs, filled.gitLegs], [true, true, 1, 2, 2]);
ok('every race agrees with its files', (await status()).allMatch, true);
ok('the creator came from KV, not the file',
   row(db.prepare('select created_by from races where slug=?').get(OLD)).created_by, OWNER);
ok('a backfilled leg has no actor, because nobody pressed it',
   row(db.prepare('select actor from legs where slug=? and idx=1').get(OLD)).actor, null);

// Twice is the same as once: the button is safe to press again.
await call('/d1-backfill', { token: t, method:'POST' });
ok('running it again changes nothing',
   [(await status()).allMatch,
    db.prepare('select count(*) c from legs where slug=?').get(OLD).c,
    db.prepare('select count(*) c from race_people where slug=?').get(OLD).c], [true, 2, 1]);

// The failure that actually happened: the migrations never applied, so every
// query threw and the panel rendered four races with nothing in them, which
// looks exactly like an empty mirror rather than a missing schema.
console.log('\na database with no tables says so');
const bare = new DatabaseSync(':memory:');
const bareEnv = { ...env, DB: {
  prepare: (sql) => ({ _sql: sql, _args: [], bind(...a){ this._args=a; return this; },
    async all(){ return { results: bare.prepare(this._sql).all(...this._args) }; },
    async run(){ return bare.prepare(this._sql).run(...this._args); } }),
  async batch(){ throw new Error('no such table: races'); } } };
const bareRes = await worker.fetch(new Request('https://w/d1-status',
  { headers: { Authorization: 'Bearer ' + t } }), bareEnv);
const bareJson = await bareRes.json();
ok('it reports the database, not the races', [bareJson.races, bareJson.allMatch], [[], false]);
ok('and says which table is missing', /no such table/.test(bareJson.dbError || ''), true);
ok('with somewhere to go and look', /Apply D1 migrations/.test(bareJson.hint || ''), true);

const bareFill = await (await worker.fetch(new Request('https://w/d1-backfill',
  { method: 'POST', headers: { Authorization: 'Bearer ' + t } }), bareEnv)).json();
ok('the backfill gives one reason rather than four',
   [bareFill.ok, /no such table/.test(bareFill.why || '')], [false, true]);

console.log('\nand it is admins only');
const ct = await login(CREW);
ok('the crew cannot read the status', (await call('/d1-status', { token: ct })).status, 403);
ok('the crew cannot run the backfill', (await call('/d1-backfill', { token: ct, method:'POST' })).status, 403);
ok('and neither can a stranger', (await call('/d1-status')).status, 401);

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
