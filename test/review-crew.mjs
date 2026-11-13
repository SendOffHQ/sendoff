// The crew page and the race page, from the review of 2026-11-12.
//
//   - Undo last took a press back a piece at a time. After a Skipped press,
//     or a lap filled in for a racer who checks in only at the pit, it cleared
//     the last leg's end and left the estimates and their "skipped" marks on
//     the legs before it: the tangle that had to be fixed by hand after Rio
//     del Lago. Now the whole press goes.
//   - A station picked by hand in the list stayed picked all day.
//   - A time out could be saved earlier than the time in at the same stop.
//   - A send-off that was never pressed had no button to set it afterwards.
//   - An item with no amounts, tapped and not saved, was left behind under
//     the old station when the racer was sent off.
//   - A racer who dropped had no end: clocks ran, the badge said On Pace.
//
//   node test/review-crew.mjs
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
const said = [];
page.on('dialog', d => { said.push(d.message()); d.accept(); });
await page.goto(BASE + '/index.html');
await page.evaluate(base => {
  localStorage.setItem('race-hub-session-v1', JSON.stringify({ session: 'stub', proxyUrl: base + '/api',
    email: 'crew@example.com', role: 'owner', expiresAt: Date.now() + 7 * 24 * 3600e3 }));
  localStorage.setItem('race-hub-tutorial-v1', JSON.stringify({ racer: 99, pit: 99, race: 99 }));
}, BASE);
const AUTH = { Authorization: 'Bearer stub', 'Content-Type': 'application/json' };
const read = async (file) => {
  const r = await (await fetch(`${BASE}/api/get?path=races/${SLUG}/${file}`, { headers: AUTH })).json();
  return JSON.parse(Buffer.from(r.content, 'base64').toString('utf8'));
};
const write = (file, doc) => fetch(`${BASE}/api/commit`, { method: 'POST', headers: AUTH,
  body: JSON.stringify({ path: `races/${SLUG}/${file}`, content: JSON.stringify(doc), message: 'test' }) });
const legs = async () => ((await read('data.json')).runners[0] || {}).legs || [];
const until = async (test, n = 60) => { for (let i = 0; i < n; i++) { try { const v = await test(); if (v) return v; } catch (e) {} await page.waitForTimeout(150); } return false; };
const ago = (min) => new Date(Date.now() - min * 60e3).toISOString();
const setLegs = (l, extra) => write('data.json', { runners: [{ id: 'jason', legs: l, ...(extra || {}) }] });
const openPit = async () => {
  await page.goto(BASE + `/pit.html?id=${SLUG}`);
  await page.waitForSelector('[data-action="press"][data-runner="jason"]', { timeout: 20000 });
  await page.waitForTimeout(300);
};
const undo = async () => { await page.click('[data-action="undo"][data-runner="jason"]'); };
const card = () => page.evaluate(() => {
  const a = document.querySelector('article.runner[data-runner="jason"]');
  return { button: a.querySelector('.big-btn').textContent.trim(), disabled: a.querySelector('.big-btn').disabled,
    badge: a.querySelector('.state-badge').textContent.trim(), timer: a.querySelector('.runner-timer').textContent.trim() };
});

const cfg = await read('config.json'); delete cfg.myRole;
// An item with no amounts: a salt pill is counted, not measured.
cfg.fuelPresets = [{ name: 'Gel', values: { calories: 100 } }, { name: 'Salt pill', values: {} }];
delete cfg.presetOrder;
await write('config.json', cfg);
// Station 1 is a checkpoint (Music Pass); 2 and 3 are aid stations.
const T = { s1: ago(240), e1: ago(180), est: ago(120), e3: ago(60) };

console.log('\nUndo last, after a station was skipped');
await setLegs([{ index: 1, startTime: T.s1, endTime: T.e1 }, { index: 2, startTime: T.e1, endTime: T.est, skipped: true },
  { index: 3, startTime: T.est, endTime: T.e3 }]);
await openPit();
await undo();
ok('takes the whole press back: on the way to the skipped station again',
  await until(async () => { const l = await legs(); return l.length === 2 && !l[1].endTime ? l : null; }),
  [{ index: 1, startTime: T.s1, endTime: T.e1 }, { index: 2, startTime: T.e1 }]);

console.log('\nUndo last, after a checkpoint was passed straight through');
await setLegs([{ index: 1, startTime: T.s1, endTime: T.e1 }, { index: 2, startTime: T.e1 }]);
await openPit();
await undo();
ok('reopens the leg to the checkpoint, and removes the one it opened',
  await until(async () => { const l = await legs(); return l.length === 1 && !l[0].endTime ? l : null; }),
  [{ index: 1, startTime: T.s1 }]);

console.log('\nUndo last, after an ordinary send-off');
await setLegs([{ index: 1, startTime: T.s1, endTime: T.e1 }, { index: 2, startTime: T.e1, endTime: T.est }, { index: 3, startTime: T.e3 }]);
await openPit();
await undo();
ok('removes the leg it started and nothing else',
  await until(async () => { const l = await legs(); return l.length === 2 ? l.map(x => [x.index, !!x.endTime]) : null; }), [[1, true], [2, true]]);

console.log('\nthe station list');
// In the aid station at the end of leg 2.
await setLegs([{ index: 1, startTime: T.s1, endTime: T.e1 }, { index: 2, startTime: T.e1, endTime: T.est }]);
await openPit();
const picked = () => page.$eval('article[data-runner="jason"] select[data-intake-leg]', s => s.value);
ok('opens on the station the race is at', await picked(), '2');
await page.selectOption('article[data-runner="jason"] select[data-intake-leg]', '1');
await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
await page.waitForTimeout(900);
ok('a station picked by hand stays through a refresh', await picked(), '1');
await page.evaluate(() => document.activeElement && document.activeElement.blur());
await page.click('[data-action="press"][data-runner="jason"]');
ok('and lets go when the race moves on', await until(async () => (await picked()) === '3'), true);

console.log('\na time out earlier than the time in');
await setLegs([{ index: 1, startTime: T.s1, endTime: T.e1 }, { index: 2, startTime: T.e1, endTime: T.est }, { index: 3, startTime: T.e3 }]);
await openPit();
await page.selectOption('article[data-runner="jason"] select[data-intake-leg]', '2');
await page.click('[data-action="edit-time"][data-leg="3"][data-field="startTime"]');
await page.waitForSelector('[data-edit="time"]');
ok('the box shows when they came in to the same stop', /In at this stop/.test(await page.textContent('.edit-time')), true);
// Ten minutes before they arrived there.
const early = new Date(Date.parse(T.est) - 10 * 60e3);
const parts = await page.evaluate(([ms, c]) => { const p = Race.tz.parts(ms, c); return p; }, [early.getTime(), cfg]);
await page.fill('[data-edit="time"]', `${(parts.h % 12) || 12}:${String(parts.mi).padStart(2, '0')}:00`);
await page.selectOption('[data-edit="ampm"]', parts.h >= 12 ? 'PM' : 'AM');
await page.click('.modal-actions .btn.primary, .so-modal .btn.primary, [data-modal-primary]').catch(async () => {
  await page.evaluate(() => [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Save time').click());
});
await page.waitForTimeout(400);
ok('is questioned before it is saved', /time out before the time in/.test(await page.evaluate(() => document.body.innerText)), true);
ok('and nothing has been written', (await legs()).find(l => l.index === 3).startTime, T.e3);

console.log('\na send-off nobody pressed');
// Arrived at station 3 with no send-off from station 2 on record.
await setLegs([{ index: 1, startTime: T.s1, endTime: T.e1 }, { index: 2, startTime: T.e1, endTime: T.est }, { index: 3, endTime: T.e3 }]);
await openPit();
await page.selectOption('article[data-runner="jason"] select[data-intake-leg]', '2');
ok('can be set from the stop it was missed at',
  (await page.textContent('[data-action="edit-time"][data-leg="3"][data-field="startTime"]')).trim(), 'Set time out');

console.log('\nan item with no amounts, tapped, then the racer sent off');
await setLegs([{ index: 1, startTime: T.s1, endTime: T.e1 }, { index: 2, startTime: T.e1, endTime: T.est }]);
await openPit();
await page.click('article[data-runner="jason"] [data-action="preset"][data-preset="1"]');
await page.evaluate(() => document.activeElement && document.activeElement.blur());
const before = await card();
await page.click('[data-action="press"][data-runner="jason"]');
ok('the button moves on', await until(async () => (await card()).button !== before.button), true);
ok('and the tap is still in front of them, on the station it was for',
  [await picked(), (await page.textContent('article[data-runner="jason"] [data-action="preset"][data-preset="1"] .chip-count')).trim()], ['2', '×1']);
await page.click('article[data-runner="jason"] [data-action="save-intake"]');
ok('where Save puts it', await until(async () => ((await legs()).find(l => l.index === 2) || {}).preset_1), 1);

console.log('\na racer who drops');
await setLegs([{ index: 1, startTime: T.s1, endTime: T.e1 }, { index: 2, startTime: T.e1, endTime: T.est }]);
await openPit();
said.length = 0;
await page.click('[data-action="stop"][data-runner="jason"]');
ok('is asked about first, in words about dropping', /as dropped/.test(said[0] || ''), true);
const dropped = await until(async () => { const c = await card(); return c.badge === 'Dropped' ? c : null; });
ok('the badge says Dropped and there is nothing left to press', dropped && [dropped.badge, dropped.button, dropped.disabled], ['Dropped', 'Dropped', true]);
ok('it is on the record', !!(await read('data.json')).runners[0].stoppedAt, true);
await page.waitForTimeout(2300);
ok('and the clock has stopped', (await card()).timer, dropped.timer);
ok('the stop they ended at does not say "still here"', /still here/.test(await page.textContent('article[data-runner="jason"] .intake-times')), false);

await page.goto(BASE + `/race.html?id=${SLUG}`);
await page.waitForSelector('article.runner .status-badge');
ok('the race page says Dropped too', (await page.textContent('article.runner .status-badge')).trim(), 'Dropped');
const tiles = await page.evaluate(() => document.querySelector('article.runner').innerText);
ok('with where and when, and no projected finish', [/dropped at/i.test(tiles), /Projected/i.test(tiles)], [true, false]);
const liveBefore = await page.$eval('article.runner .live-timer', e => e.textContent);
await page.waitForTimeout(2300);
ok('and nothing on it is still counting', await page.$eval('article.runner .live-timer', e => e.textContent), liveBefore);

await page.goto(BASE + `/racer.html?id=${SLUG}&runner=jason`);
await page.waitForSelector('#act button');
ok('the racer screen shows it, with a way back', [(await page.textContent('#act .rbtn')).trim(), await page.locator('#unstop').count()], ['Dropped', 1]);

await openPit();
said.length = 0;
await undo();
ok('Undo last puts them back in the race', await until(async () => (await card()).badge !== 'Dropped' && !(await read('data.json')).runners[0].stoppedAt), true);

ok('no page threw', errs, []);
await b.close();
console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
