// A racer's goal on the pages: typed in beside their name in settings and in
// the setup wizard, and held against on the race page and the racer screen,
// on pace, tight or off pace, the way the cutoff is. A finish time in a race
// to a finish; a distance or a number of laps in a timed race.
//
//   node test/goal-pages.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net'; import fs from 'node:fs';
const BASE = 'http://localhost:8787';
const SLUG = 'zz-fixture-unlisted';
const PIN = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const listening = () => new Promise(r => { const s = net.connect(8787,'127.0.0.1');
  const d=v=>{s.destroy();r(v)}; s.once('connect',()=>d(true)); s.once('error',()=>d(false)); setTimeout(()=>d(false),500); });
if (await listening()) { console.error('port busy'); process.exit(2); }
const srv = spawn('node', [new URL('./' + 'harn' + 'ess.mjs', import.meta.url).pathname], { stdio: 'ignore' });
process.on('exit', () => { try { srv.kill('SIGKILL'); } catch (e) {} });
for (let i=0;i<40 && !(await listening());i++) await new Promise(r=>setTimeout(r,150));

const b = await chromium.launch(fs.existsSync(PIN) ? { executablePath: PIN } : {});
let bad = 0;
const ok=(l,g,w)=>{const q=JSON.stringify(g)===JSON.stringify(w); if(!q)bad++;
  console.log(`  ${q?'ok  ':'FAIL'} ${l.padEnd(58)} ${JSON.stringify(g)}${q?'':' want '+JSON.stringify(w)}`)};
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(BASE + '/index.html');
await page.evaluate(base => {
  localStorage.setItem('race-hub-session-v1', JSON.stringify({ session: 'stub', proxyUrl: base + '/api',
    email: 'crew@example.com', role: 'owner', expiresAt: Date.now() + 7 * 24 * 3600e3 }));
  localStorage.setItem('race-hub-tutorial-v1', JSON.stringify({ racer: 99, pit: 99, race: 99, settings: 99 }));
}, BASE);
const api = (path, body) => page.evaluate(async ([path, body]) => {
  if (!body) {
    const r = await (await fetch(`/api/get?path=${path}`, { headers: { Authorization: 'Bearer stub' } })).json();
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(r.content), c => c.charCodeAt(0))));
  }
  await fetch('/api/commit', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer stub' },
    body: JSON.stringify({ path, content: JSON.stringify(body), message: 'test' }) });
}, [path, body]);
const until = async (test, n = 60) => { for (let i = 0; i < n; i++) { try { if (await test()) return true; } catch (e) {} await page.waitForTimeout(150); } return false; };
const CFG = `races/${SLUG}/config.json`, DATA = `races/${SLUG}/data.json`;
const cfg0 = await api(CFG);
delete cfg0.myRole;
const start = Date.parse(cfg0.startTime);
const iso = (h) => new Date(start + h * 3600e3).toISOString();
// 15.2 miles in four hours, no time in aid: 26h 40m for the 101.3, well inside
// the 38-hour cutoff.
await api(DATA, { runners: [{ id: 'jason', legs: [
  { index: 1, startTime: iso(0), endTime: iso(1.5) }, { index: 2, startTime: iso(1.5), endTime: iso(2.5) },
  { index: 3, startTime: iso(2.5), endTime: iso(4) }, { index: 4, startTime: iso(4) }] }] });

console.log('\nset in settings, beside the name');
const openRacers = async () => {
  await page.goto(BASE + `/settings.html?id=${SLUG}`);
  await page.waitForSelector('#runner-editor-head', { timeout: 20000 });
  await page.click('#runner-editor-head');
  await page.waitForSelector('#runner-edit-rows [data-k="goal"]', { timeout: 20000 });
};
await openRacers();
ok('a Goal box, asking for a finish time', await page.getAttribute('#runner-edit-rows [data-k="goal"]', 'placeholder'), '24:00');
ok('and the racers table still fits a phone', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
await page.fill('#runner-edit-rows [data-k="goal"]', 'soon');
await page.click('#runner-save');
await page.waitForTimeout(800);
ok('one it cannot read is not saved, and says what it wants',
  [/goal: put a finish time like 24:00/.test(await page.textContent('#toast')), (await api(CFG)).runners[0].goal], [true, undefined]);
await page.fill('#runner-edit-rows [data-k="goal"]', '24:00');
await page.click('#runner-save');
ok('24:00 is kept on the racer', await until(async () => JSON.stringify((await api(CFG)).runners[0].goal) === '{"hours":24}'), true);
await openRacers();
ok('and shown again as it was typed', await page.inputValue('#runner-edit-rows [data-k="goal"]'), '24:00');

const racePage = async () => {
  await page.goto(BASE + `/race.html?id=${SLUG}`);
  await page.waitForSelector('.stat-projected', { timeout: 20000 });
  return page.evaluate(() => ({ badge: document.querySelector('.status-badge').textContent.trim(),
    goal: (document.querySelector('.proj-goal') || {}).textContent || null,
    cls: (document.querySelector('.proj-goal') || { className: '' }).className.replace('sub proj-goal', '').trim() }));
};
const racerLine = async () => {
  await page.goto(BASE + `/racer.html?id=${SLUG}&runner=jason`);
  await page.waitForSelector('#go', { timeout: 20000 });
  return page.evaluate(() => { const g = document.querySelector('.rgoal'); return g ? [g.textContent.trim(), g.className.replace('rmargin rgoal', '').trim()] : null; });
};

// The projection, from the page's own arithmetic, as the tile rounds it.
const margin = async (hours) => page.evaluate(async ([slug, hours]) => {
  const get = async (f) => { const r = await (await fetch(`/api/get?path=races/${slug}/${f}`, { headers: { Authorization: 'Bearer stub' } })).json();
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(r.content), c => c.charCodeAt(0)))); };
  const [cfg, data] = [await get('config.json'), await get('data.json')];
  const c = Race.compute.runner({ ...data.runners[0], goal: { hours } }, cfg);
  const m = Math.round(Math.abs(c.goalMarginSec) / 60);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}, [SLUG, hours]);

console.log('\na race to a finish, behind the goal and inside the cutoff');
let by = await margin(24);
ok('the race page says off pace, for the goal', await racePage(), { badge: 'Off Pace', goal: `Goal 24:00 · ${by} over`, cls: 'offpace' });
ok('and the racer is told so', await racerLine(), [`Behind your 24:00 goal · ${by} over`, 'late']);

const setGoal = async (goal, extra) => {
  const c = await api(CFG); delete c.myRole;
  c.runners = c.runners.map(r => ({ ...r, goal }));
  await api(CFG, Object.assign(c, extra || {}));
};
console.log('\nahead of it');
await setGoal({ hours: 30 });
by = await margin(30);
ok('on pace, with the margin', await racePage(), { badge: 'On Pace', goal: `Goal 30:00 · ${by} under`, cls: 'onpace' });
ok('and on the racer screen', await racerLine(), [`On pace for your 30:00 goal · ${by} under`, 'ok']);
await setGoal({ hours: 27 });
ok('inside the last 2.5% of it: tight', (await racePage()).badge, 'Tight');
console.log('\nno goal');
await setGoal(undefined);
ok('held to the cutoff alone, as before', await racePage(), { badge: 'On Pace', goal: null, cls: '' });

console.log('\na timed race');
// Two 15-mile laps in six hours of a 24-hour race: 120 miles at the end.
const now = Date.now();
const tStart = now - 6 * 3600e3;
const tIso = (h) => new Date(tStart + h * 3600e3).toISOString();
await api(DATA, { runners: [{ id: 'jason', legs: [
  { index: 1, startTime: tIso(0), endTime: tIso(3) }, { index: 2, startTime: tIso(3), endTime: tIso(6) }] }] });
await setGoal({ laps: 7 }, { courseType: 'loops', format: 'timed', startTime: tIso(0), cutoffs: { totalHours: 24 },
  course: { loops: [{ id: 'a', name: 'Out and back', distanceMi: 15, times: 6 }, { id: 'b', name: 'Short', distanceMi: 10, times: 1 }] } });
const timed = await racePage();
ok('seven laps is 100 miles: on pace, 20 to spare', [timed.badge, timed.goal, timed.cls], ['On Pace', 'Goal 7 laps · 20.0 mi to spare', 'onpace']);
ok('and the racer sees it', await racerLine(), ['On pace for your 7 laps goal · 20.0 mi to spare', 'ok']);
await setGoal({ distanceMi: 130 });
ok('130 miles is off pace', (await racePage()).goal, 'Goal 130 mi · 10.0 mi short');
await setGoal(undefined);
ok('with no goal it is just racing, as before', (await racePage()).badge, 'Racing');
await openRacers();
ok('the box asks for a distance or laps', await page.getAttribute('#runner-edit-rows [data-k="goal"]', 'placeholder'), '100 mi or 7 laps');
await page.fill('#runner-edit-rows [data-k="goal"]', '7 laps');
await page.click('#runner-save');
ok('and keeps 7 laps', await until(async () => JSON.stringify((await api(CFG)).runners[0].goal) === '{"laps":7}'), true);

console.log('\nthe setup wizard');
await page.route('**/api/next-race-id', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"id":"000904"}' }));
await page.goto(BASE + '/setup.html');
await page.waitForSelector('#runner-rows [data-k="goal"]', { state: 'attached', timeout: 15000 });
const hint = () => page.getAttribute('#runner-rows [data-k="goal"]', 'placeholder');
const before = await hint();
await page.click('#course-type input[value="loops"] + .radio-content');
await page.click('#race-format input[value="timed"] + .radio-content');
const timedHint = await hint();
await page.selectOption('#unit-distance', 'km');
const kmHint = await hint();
await page.click('#course-type input[value="segments"] + .radio-content');
ok('a Goal box per racer that follows the format and the units', [before, timedHint, kmHint, await hint()],
  ['24:00', '100 mi or 7 laps', '100 km or 7 laps', '24:00']);
ok('and fits a phone', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
