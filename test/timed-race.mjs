// A timed race on a course of two loops: set up in the wizard, then run on
// the race page, the pit board and the racer screen.
//
// The race a friend is putting on: a 15-mile out-and-back run six times, then
// a 10-mile one once, so lap 7 lands on 100, repeating; as far as you get in
// 24 hours.
//
//   node test/timed-race.mjs
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
const errs = [];
const ctx = await b.newContext({ viewport: { width: 390, height: 900 }, serviceWorkers: 'block', timezoneId: 'America/Chicago' });
const page = await ctx.newPage();
page.on('pageerror', e => errs.push(e.message));
page.on('dialog', d => d.accept());
await page.goto(BASE + '/index.html');
await page.evaluate(base => {
  localStorage.setItem('race-hub-session-v1', JSON.stringify({ session: 'stub', proxyUrl: base + '/api',
    email: 'crew@example.com', role: 'owner', expiresAt: Date.now() + 7 * 864e5 }));
  localStorage.setItem('race-hub-tutorial-v1', JSON.stringify({ racer: 99, pit: 99, race: 99 }));
}, BASE);
const until = async (test, n = 60) => { for (let i = 0; i < n; i++) { try { if (await test()) return true; } catch (e) {} await page.waitForTimeout(150); } return false; };

console.log('\nsetting it up');
let written = null;
await page.route('**/api/commit', async (route) => {
  const j = JSON.parse(route.request().postData() || '{}');
  if (/config\.json$/.test(j.path || '') && /^races\/0/.test(j.path)) written = JSON.parse(j.content);
  await route.continue();
});
await page.route('**/api/next-race-id', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"id":"000902"}' }));
await page.goto(BASE + '/setup.html');
await page.waitForSelector('#race-tz option', { state: 'attached', timeout: 15000 });
await page.fill('#race-name', 'Out and Back 24');
await page.fill('#race-date', '2026-11-07'); await page.dispatchEvent('#race-date', 'change');
await page.selectOption('#race-hour', '6'); await page.selectOption('#race-minute', '0'); await page.selectOption('#race-ampm', 'AM');
await page.click('#course-type input[value="loops"] + .radio-content');
await page.click('#race-format input[value="timed"] + .radio-content');
ok('timed: no lap count, and the cutoff is when it ends',
  [await page.isVisible('#loop-count'), (await page.textContent('#race-cutoff-lbl')).trim()], [false, 'Race ends']);
await page.selectOption('#race-cutoff-pick select', '2026-11-08');
await page.fill('#race-cutoff-pick input', '06:00');
await page.fill('[data-loop="0"][data-k="distance"]', '15');
ok('one loop asks nothing about laps in a row', await page.isVisible('[data-loop="0"][data-k="times"]'), false);
await page.click('#add-loop');
await page.fill('[data-loop="0"][data-k="times"]', '6');
await page.fill('[data-loop="1"][data-k="distance"]', '10');
ok('the pattern is said back, with what a round adds up to',
  (await page.textContent('#loops-summary')).replace(/\s+/g, ' ').trim(),
  'Loop A ×6, then Loop B ×1, repeating · 100.0 mi a round · timed: as many laps as fit before the race ends');
if (process.argv[2]) await page.locator('#loops-fields').screenshot({ path: process.argv[2] + '/timed-setup.png' });
await page.fill('[data-runner="0"][data-k="name"]', 'Sam');
await page.click('#btn-submit');
await until(async () => !!written, 80);
ok('written as a timed loop race', written && [written.courseType, written.format, written.cutoffs.totalHours, 'loopCount' in written.course], ['loops', 'timed', 24, false]);
ok('with its loops in order', written && written.course.loops.map(l => [l.name, l.distanceMi, l.times]), [['Loop A', 15, 6], ['Loop B', 10, 1]]);

console.log('\nrunning it');
const H = 3600e3, now = Date.now();
const api = (path, body) => page.evaluate(async ([path, body]) => {
  if (!body) {
    const r = await (await fetch(`/api/get?path=${path}`, { headers: { Authorization: 'Bearer stub' } })).json();
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(r.content), c => c.charCodeAt(0))));
  }
  await fetch('/api/commit', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer stub' },
    body: JSON.stringify({ path, content: JSON.stringify(body), message: 'test' }) });
}, [path, body]);
const cfg = await api(`races/${SLUG}/config.json`);
Object.assign(cfg, { courseType: 'loops', format: 'timed', startTime: new Date(now - 30 * H).toISOString(), timezone: 'America/Denver',
  cutoffs: { totalHours: 48 }, course: { loopDistanceMi: 15, loops: written.course.loops } });
await api(`races/${SLUG}/config.json`, cfg);
const runnerId = cfg.runners[0].id;
// Six laps of 15 done, in the pit before the short one.
const laps = Array.from({ length: 6 }, (_, i) => ({ index: i + 1,
  startTime: new Date(now - (30 - i * 4.5) * H).toISOString(), endTime: new Date(now - (30 - i * 4.5 - 4.4) * H).toISOString() }));
await api(`races/${SLUG}/data.json`, { runners: [{ id: runnerId, legs: laps }] });

await page.goto(BASE + `/race?id=${SLUG}`);
await page.waitForSelector('.leg-cell', { timeout: 20000 });
const race = await page.evaluate(() => ({
  badge: document.querySelector('.status-badge').textContent.trim(),
  laps: [...document.querySelectorAll('.stat')].find(s => /Laps/.test(s.querySelector('.label').textContent)).querySelector('.value').textContent.trim(),
  cells: [...document.querySelectorAll('.leg-cell .n')].map(n => n.textContent.trim()),
  proj: document.querySelector('.stat-projected .label').textContent.trim(),
  ends: [...document.querySelectorAll('.cutoff-item .l')].map(e => e.textContent.trim()).pop(),
  left: /left/.test(document.querySelector('.legs-head').textContent) }));
if (process.argv[2]) await page.screenshot({ path: process.argv[2] + '/timed-race.png', fullPage: true });
ok('racing, not on pace or off it', race.badge, 'Racing');
ok('laps run, with no total to run them against', race.laps, '6');
ok('the laps so far and the next, each saying which loop', race.cells, ['L1A', 'L2A', 'L3A', 'L4A', 'L5A', 'L6A', 'L7B']);
ok('projected to the end of the clock, not a finish', race.proj, 'At the end');
ok('the race ends rather than closes', race.ends, 'Ends · 48h');
ok('and says the time left', race.left, true);

await page.goto(BASE + `/racer?id=${SLUG}&runner=${runnerId}`);
await page.waitForSelector('#go', { timeout: 20000 });
ok('the racer is told the time left in the race', /left in the race/.test(await page.textContent('.rmargin')), true);
ok('and that the next lap is the short one', (await page.textContent('#go')).replace(/\s+/g, ' ').trim().startsWith('Leaving · Lap 7 · Loop B'), true);
ok('with a way to stop here', await page.isVisible('#stop'), true);

console.log('\nstopping');
await page.goto(BASE + `/pit?id=${SLUG}`);
await page.waitForSelector('[data-action="stop"]', { timeout: 20000 });
await page.click('[data-action="stop"]');
ok('the crew stops them, and the time is kept', await until(async () => !!(await api(`races/${SLUG}/data.json`)).runners[0].stoppedAt), true);
await page.waitForSelector('.state-badge.state-done', { timeout: 10000 });
ok('the board says they are done, with nothing left to press', [await page.textContent('.state-badge'), await page.isDisabled('.big-btn')], ['Finished', true]);
await page.click('[data-action="undo"]');
ok('undo puts them back in the race', await until(async () => !(await api(`races/${SLUG}/data.json`)).runners[0].stoppedAt), true);
await page.waitForSelector('[data-action="stop"]', { timeout: 10000 });
ok('with the stop on offer again', await page.isVisible('[data-action="stop"]'), true);
ok('nothing wider than the phone', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
