// An AI invited onto a race as crew: the credential, what it can read and
// write over MCP, and everything it must not be able to reach.
//
//   node worker/test/ai-crew.mjs
import worker from '../src/worker.js';
import { fakeD1 } from './fake-d1.mjs';

const OWNER = 'owner@example.com', CREW = 'crew@example.com', FREE = 'free@example.com';
const kv = new Map();
const KV = { async get(k){return kv.has(k)?kv.get(k):null;}, async put(k,v){kv.set(k,v);},
             async delete(k){kv.delete(k);},
             async list({prefix}){return {keys:[...kv.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name}))};} };
globalThis.caches = { default: { async match(){return undefined;}, async put(){}, async delete(){return true;} } };
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).includes('/git/trees/')) return new Response(JSON.stringify({ tree: [] }), { status: 200 });
  if ((opts.method || 'GET') === 'GET') return new Response('{"message":"Not Found"}', { status: 404 });
  return new Response(JSON.stringify({ content: { sha: 'x' } }), { status: 200 });
};
async function cred(pw){
  const salt=new Uint8Array(16); crypto.getRandomValues(salt);
  const km=await crypto.subtle.importKey('raw',new TextEncoder().encode(pw),'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:100000,hash:'SHA-256'},km,256);
  const b=a=>Buffer.from(a).toString('base64');
  return { hash:b(new Uint8Array(bits)), salt:b(salt), iterations:100000 };
}
kv.set('user:' + FREE, JSON.stringify({ ...await cred('pw'), plan: 'free', earlyAccess: false }));
const env = {
  DB: fakeD1(),
  GITHUB_OWNER:'o', GITHUB_REPO:'r', GITHUB_TOKEN:'t', GITHUB_BRANCH:'main',
  AUTH_KV: KV, ALLOWED_ORIGINS:'https://sendoff.run', JWT_SECRET:'s',
  USERS: JSON.stringify([{ email: OWNER, ...await cred('pw') }, { email: CREW, ...await cred('pw') }]),
};
const call = (p, o = {}) => worker.fetch(new Request('https://w' + p, {
  method: o.method || (o.body ? 'POST' : 'GET'),
  headers: { 'Content-Type':'application/json', ...(o.token ? { Authorization: 'Bearer ' + o.token } : {}), ...(o.headers || {}) },
  ...(o.body ? { body: typeof o.body === 'string' ? o.body : JSON.stringify(o.body) } : {}) }), env, { waitUntil: () => {} });
const login = async (e) => (await (await call('/login', { body: { email: e, password: 'pw' } })).json()).token;
const version = (slug, file) => { const r = env.DB.races.get(slug); return r ? r[file + '_sha'] : undefined; };
const put = async (token, slug, file, doc) => call('/commit', { token, body: {
  path: `races/${slug}/${file}.json`, content: JSON.stringify(doc), message: 'test', sha: version(slug, file) || undefined } });
const dataOf = (slug) => JSON.parse(env.DB.races.get(slug).data);

let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p?'ok  ':'FAIL'} ${l.padEnd(58)} ${JSON.stringify(g)}${p?'':' expected '+JSON.stringify(w)}`); };

const owner = await login(OWNER), crew = await login(CREW), free = await login(FREE);
// Saturday 7:00 AM in Chicago. Two racers, so the credential has to name one.
const NOW0 = Date.parse('2026-10-03T12:00:00Z');
const course = { courseType: 'segments', startTime: '2026-10-03T07:00:00-05:00', timezone: 'America/Chicago',
  cutoffs: { totalHours: 30 },
  course: { segments: [
    { fromAid: 'Start', toAid: 'Ridge', distanceMi: 10, arriveCutoffHours: 4, dropBag: true, crewNote: 'Lot B' },
    { fromAid: 'Ridge', toAid: 'Valley', distanceMi: 15, arriveCutoffHours: 9 },
    { fromAid: 'Valley', toAid: 'Finish', distanceMi: 25 } ] },
  targets: { caloriesPerHour: 250, fluidOzPerHour: 20, sodiumMgPerHour: 500 },
  fuelPresets: [{ name: 'Gel', values: { calories: 100, sodiumMg: 50 } }, { name: 'Flask', values: { fluidOz: 16, calories: 200 } }] };
await put(owner, 'hen', 'config', { name: 'Hennepin Test 100', visibility: 'private', createdBy: OWNER, ...course,
  people: [{ email: CREW, role: 'crew' }],
  runners: [{ id: 'pat', name: 'Pat', bib: '12', crewNotes: 'Salt every hour' }, { id: 'sam', name: 'Sam' }] });
await put(owner, 'hen', 'data', { runners: [
  { id: 'pat', legs: [{ index: 1, startTime: '2026-10-03T12:00:00Z', endTime: '2026-10-03T14:00:00Z', calories: 200,
      notes: '8:30 AM: ate half a quesadilla\n8:50 AM: blister left heel' },
    { index: 2, startTime: '2026-10-03T14:05:00Z' }] },
  { id: 'sam', legs: [{ index: 1, startTime: '2026-10-03T12:00:00Z', calories: 50 }] }] });
await put(owner, 'other', 'config', { name: 'Other', visibility: 'public', createdBy: OWNER, ...course, runners: [{ id: 'o', name: 'O' }] });
await put(owner, 'other', 'data', { runners: [{ id: 'o', legs: [{ index: 1, startTime: '2026-10-03T12:00:00Z' }] }] });
await put(free, 'cheap', 'config', { name: 'Cheap', visibility: 'public', createdBy: FREE, ...course, runners: [{ id: 'c', name: 'C' }] });

console.log('\ninviting an AI as crew');
ok('crew who cannot hand out access cannot', (await call('/ai-crew', { token: crew, body: { slug: 'hen', runnerId: 'pat' } })).status, 403);
ok('nor for a racer who is not on the race', (await call('/ai-crew', { token: owner, body: { slug: 'hen', runnerId: 'nope' } })).status, 400);
const freeTry = await call('/ai-crew', { token: free, body: { slug: 'cheap', runnerId: 'c' } });
ok('a race on the free plan is told it is Pro', [freeTry.status, (await freeTry.json()).limit], [402, 'aiCrew']);
const made = await (await call('/ai-crew', { token: owner, body: { slug: 'hen', runnerId: 'pat', label: 'Claude' } })).json();
ok('the owner gets an address with the key in it', /^https:\/\/w\/mcp\/[A-Za-z0-9_-]{32}$/.test(made.url), true);
ok('that outlasts the race', made.expiresAt > Date.parse('2026-10-04T12:00:00Z') + 6 * 864e5, true);
const listed = await (await call('/ai-crew?slug=hen', { token: crew })).json();
ok('crew see it on the race, and for whom', listed.aiCrew.map(a => [a.label, a.runnerName]), [['Claude', 'Pat']]);
ok('but not its key', listed.aiCrew[0].token === undefined && listed.aiCrew[0].url === undefined, true);
ok('the owner sees the key, to copy it again',
  (await (await call('/ai-crew?slug=hen', { token: owner })).json()).aiCrew[0].url, made.url);

const mcpPath = new URL(made.url).pathname;
const rpc = async (method, params, id = 1, path = mcpPath, headers) => {
  const r = await call(path, { body: { jsonrpc: '2.0', id, method, params }, headers });
  return { status: r.status, body: r.status === 202 ? null : await r.json() };
};
const tool = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args || {} });
  const res = r.body.result;
  return { error: res && res.isError ? res.content[0].text : null, data: res && res.structuredContent, raw: r.body };
};

console.log('\nthe MCP handshake');
const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
ok('initialize answers with tools and who it is crew for',
  [init.status, init.body.result.protocolVersion, !!init.body.result.capabilities.tools, /crew for Pat at Hennepin Test 100/.test(init.body.result.instructions)],
  [200, '2025-06-18', true, true]);
ok('an initialized notification gets an empty 202', (await call(mcpPath, { body: { jsonrpc: '2.0', method: 'notifications/initialized' } })).status, 202);
const list = await rpc('tools/list', {});
ok('the tools', list.body.result.tools.map(t => t.name), ['race_status', 'log_intake', 'log_item', 'add_note', 'read_notes', 'mark_notes_read']);
ok('log_intake takes this race\'s metrics', Object.keys(list.body.result.tools[1].inputSchema.properties.items.items.properties),
  ['what', 'calories', 'fluidOz', 'sodiumMg']);
ok('log_item offers this race\'s items', list.body.result.tools[2].inputSchema.properties.item.enum, ['Gel', 'Flask']);
ok('a GET is not served', (await call(mcpPath)).status, 405);
ok('any origin may preflight it', (await call(mcpPath, { method: 'OPTIONS' })).headers.get('Access-Control-Allow-Origin'), '*');
ok('the key also works as a bearer token on /mcp',
  (await rpc('ping', {}, 9, '/mcp', { Authorization: 'Bearer ' + made.token })).body.result, {});

console.log('\nwhat it is told');
const st = (await tool('race_status')).data;
ok('the racer, and that they are on course', [st.racer.name, st.state], ['Pat', 'on course']);
ok('the next station by name, with its cutoff on the race clock',
  [st.nextStation.to, st.nextStation.at, st.nextStation.cutoff], ['Valley', '25.0 mi', 'Sat 4:00 PM']);
ok('the finish cutoff', st.race.finishCutoff, 'Sun 1:00 PM');
ok('what they have had, and the plan', [st.intake.raceTotal['Calories (cal)'], st.intake.planPerHourRightNow['Calories (cal)']], [200, 250]);
ok('their own notes for crew', st.racerNotesForCrew, 'Salt every hour');
ok('the one-tap items', st.oneTapItems.map(i => i.name), ['Gel', 'Flask']);
ok('and that two of their notes are unread', st.unreadNotes, 2);
ok('nothing about the other racer, or anybody\'s address',
  [JSON.stringify(st).includes('Sam'), JSON.stringify(st).includes('@example.com')], [false, false]);

console.log('\nreading the racer\'s notes');
const notes = (await tool('read_notes')).data.notes;
ok('the lines the racer typed, on their legs', notes.map(n => [n.leg, n.station, n.line]),
  [[1, 'Ridge', '8:30 AM: ate half a quesadilla'], [1, 'Ridge', '8:50 AM: blister left heel']]);

console.log('\nlogging what they ate');
let r = await tool('log_intake', { leg: 1, items: [{ what: 'half a quesadilla', calories: 280, sodiumMg: 600 }],
  forNotes: ['8:30 AM: ate half a quesadilla'] });
let d = dataOf('hen');
let leg1 = d.runners[0].legs[0];
ok('it lands on the leg it was eaten on', [leg1.calories, leg1.sodiumMg], [480, 600]);
ok('marked as an estimate', leg1.aiEst, { calories: 280, sodiumMg: 600 });
ok('with a line saying who logged it', /^\d+:\d\d [AP]M: AI crew: half a quesadilla \(~280 cal, ~600 mg\)$/.test(leg1.notes.split('\n').pop()), true);
await tool('mark_notes_read', { lines: ['8:50 AM: blister left heel'] });
ok('handled notes are not handed back', (await tool('read_notes')).data.notes, []);
ok('its own lines are never handed back either', (await tool('read_notes', { includeHandled: true })).data.notes.length, 2);

r = await tool('log_intake', { items: [{ what: 'Coke', calories: 100, fluidOz: 8 }] });
d = dataOf('hen');
ok('with no leg named, the leg they are running', [r.data.leg, d.runners[0].legs[1].calories, d.runners[0].legs[1].fluidOz], [2, 100, 8]);
await tool('log_intake', { items: [{ what: 'Coke, logged twice', calories: -100, fluidOz: -8 }] });
d = dataOf('hen');
ok('a negative amount takes a mistake back', [d.runners[0].legs[1].calories, d.runners[0].legs[1].aiEst], [0, undefined]);
await tool('log_item', { item: 'Gel', count: 2 });
d = dataOf('hen');
ok('a one-tap item counts like a press, exact', [d.runners[0].legs[1].calories, d.runners[0].legs[1].preset_0, d.runners[0].legs[1].aiEst], [200, 2, undefined]);
await tool('add_note', { text: 'Changed socks' });
ok('a note is a line on the leg', /AI crew: Changed socks$/.test(dataOf('hen').runners[0].legs[1].notes), true);
ok('the other racer is untouched', dataOf('hen').runners[1].legs, [{ index: 1, startTime: '2026-10-03T12:00:00Z', calories: 50 }]);

console.log('\nwhat it cannot do');
let e = await tool('log_intake', { leg: 3, items: [{ what: 'x', calories: 1 }] });
ok('a leg not started yet', e.error, 'Leg 3 has not been started yet.');
e = await tool('log_intake', { items: [{ what: 'nothing' }] });
ok('an entry with no numbers', /^No amounts given/.test(e.error), true);
e = await tool('log_item', { item: 'Pizza' });
ok('an item the race does not have', /No one-tap item called "Pizza"/.test(e.error), true);
ok('a tool that does not exist', (await rpc('tools/call', { name: 'set_split', arguments: {} })).body.error.code, -32602);
ok('the race\'s config is not something it can touch', JSON.parse(env.DB.races.get('hen').config).name, 'Hennepin Test 100');
ok('a made-up key is refused', (await rpc('ping', {}, 1, '/mcp/' + 'A'.repeat(32))).status, 404);
ok('no key at all is refused', (await rpc('ping', {}, 1, '/mcp')).status, 404);
ok('it is not a session anywhere else', (await call('/commit', { token: made.token, body: {
  path: 'races/other/data.json', content: '{"runners":[]}', message: 'x' } })).status, 401);
ok('nor on the race it is crew for', (await call('/get?path=races/hen/data.json', { token: made.token })).status, 401);

console.log('\ntaken away');
const rev = await call('/ai-crew/revoke', { token: crew, body: { token: made.token } });
ok('crew who cannot hand out access cannot take it away', rev.status, 403);
ok('the owner can', (await call('/ai-crew/revoke', { token: owner, body: { token: made.token } })).status, 200);
ok('and the address stops working at once', (await rpc('tools/call', { name: 'race_status', arguments: {} })).status, 404);
ok('and it is off the list', (await (await call('/ai-crew?slug=hen', { token: owner })).json()).aiCrew, []);

console.log('\nan owner who leaves Pro');
const again = await (await call('/ai-crew', { token: owner, body: { slug: 'hen', runnerId: 'pat' } })).json();
const again2 = new URL(again.url).pathname;
kv.set('user:' + OWNER, JSON.stringify({ ...await cred('pw'), plan: 'free', earlyAccess: false }));
const cut = await rpc('tools/call', { name: 'race_status', arguments: {} }, 1, again2);
ok('closes the door on the next call', [cut.body.result.isError, /no longer on Pro/.test(cut.body.result.content[0].text)], [true, true]);

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
