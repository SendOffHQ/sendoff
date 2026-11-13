// Backyard ultras (2026-11-13).
//
// A lap every hour, on the hour, until one runner is left: a lap goes on the
// bell, a runner not back by the next bell is out, and so is one who does not
// leave on a bell. The result is laps, and the last one standing wins.
//
// What is checked:
//   - with automatic send-off, a runner back in time is sent off on the bell
//     without anybody pressing anything, and the page writes it down;
//   - a bell that rings with no check-in splits the button: back in time and
//     off again, or did not make it back and out;
//   - with automatic send-off off, a bell with nobody sent off splits it too:
//     off on that bell, or did not start and out;
//   - between laps there is nothing to press until the bell;
//   - out and won read as such on the crew page, the race page and the
//     racer's own screen;
//   - settings and the setup wizard offer it, with the interval and the choice.
//
//   node test/backyard.mjs
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
  localStorage.setItem('race-hub-tutorial-v1', JSON.stringify({ racer: 99, pit: 99, race: 99, settings: 99, setup: 99 }));
}, BASE);
const AUTH = { Authorization: 'Bearer stub', 'Content-Type': 'application/json' };
const read = async (file) => {
  const r = await (await fetch(`${BASE}/api/get?path=races/${SLUG}/${file}`, { headers: AUTH })).json();
  return JSON.parse(Buffer.from(r.content, 'base64').toString('utf8'));
};
const write = (file, doc) => fetch(`${BASE}/api/commit`, { method: 'POST', headers: AUTH,
  body: JSON.stringify({ path: `races/${SLUG}/${file}`, content: JSON.stringify(doc), message: 'test' }) });
const until = async (test, n = 60) => { for (let i = 0; i < n; i++) { try { const v = await test(); if (v) return v; } catch (e) {} await page.waitForTimeout(150); } return false; };
const H = 3600e3, M = 60e3;
const iso = (ms) => new Date(ms).toISOString();
const original = await read('config.json'); delete original.myRole;
const runner = { ...original.runners[0], id: 'jason', name: 'Jason' };
// A backyard that began `hoursAgo` hours ago, on the hour every hour.
const yard = async (hoursAgo, extra) => {
  const start = Math.floor(Date.now() / M) * M - hoursAgo * H;
  const cfg = { ...JSON.parse(JSON.stringify(original)), courseType: 'loops', format: 'backyard',
    startTime: iso(start), backyard: { intervalMin: 60, autoStart: true, ...(extra || {}) },
    course: { loopDistanceMi: 4.167 }, cutoffs: {}, runners: [runner] };
  delete cfg.presetOrder;
  await write('config.json', cfg);
  return start;
};
const legs = async () => ((await read('data.json')).runners.find(r => r.id === 'jason') || {}).legs || [];
const setRunner = (r) => write('data.json', { runners: [{ id: 'jason', ...r }] });
const openPit = async () => {
  await page.goto(BASE + `/pit.html?id=${SLUG}`);
  await page.waitForSelector('article.runner[data-runner="jason"]', { timeout: 20000 });
  await page.waitForTimeout(400);
};
const card = () => page.evaluate(() => {
  const a = document.querySelector('article.runner[data-runner="jason"]');
  return { badge: a.querySelector('.state-badge').textContent.trim(),
    buttons: [...a.querySelectorAll('.big-btn')].map(b => b.textContent.trim() + (b.disabled ? ' [off]' : '')),
    bell: (a.querySelector('.bell-line') || {}).textContent ? a.querySelector('.bell-line').textContent.replace(/\s+/g, ' ').trim() : '',
    where: a.querySelector('.where').textContent.replace(/\s+/g, ' ').trim() };
});
const clock = (ms) => page.evaluate(([ms]) => Race.fmt.clockTime(new Date(ms).toISOString(), cfg), [ms]);

console.log('\nback in time, with automatic send-off');
// Two laps done, the second back at 1:55; it is now half past two.
let s0 = await yard(2.5);
await setRunner({ legs: [{ index: 1, startTime: iso(s0), endTime: iso(s0 + 50 * M) }, { index: 2, startTime: iso(s0 + H), endTime: iso(s0 + 115 * M) }] });
await openPit();
let c = await card();
ok('the bell sent them off on lap 3', c.buttons, ['Check In · lap 3']);
ok('and says when lap 3 is due back', c.bell.startsWith(`Lap 3 due back by ${await clock(s0 + 3 * H)}`), true);
ok('the send-off is written down, at the bell', await until(async () => ((await legs()).find(l => l.index === 3) || {}).startTime), iso(s0 + 2 * H));

console.log('\na bell with no check-in');
// Lap 3 went on the two o'clock bell; it is now ten past three.
s0 = await yard(3 + 10 / 60);
const lap3 = () => [{ index: 1, startTime: iso(s0), endTime: iso(s0 + 50 * M) }, { index: 2, startTime: iso(s0 + H), endTime: iso(s0 + 115 * M) }, { index: 3, startTime: iso(s0 + 2 * H) }];
await setRunner({ legs: lap3() });
await openPit();
c = await card();
ok('the button is two', c.buttons, ['Back in time · send off lap 4', "Didn't make it back · out"]);
ok('saying which lap was due, and when', c.bell, `Lap 3 was due ${await clock(s0 + 3 * H)} · no check-in`);
await page.click('[data-action="by-back"][data-runner="jason"]');
let l = await until(async () => { const x = await legs(); return x.find(y => y.index === 4) ? x : null; });
ok('back in time: lap 3 back by the bell, lap 4 off on it',
  l && [l.find(y => y.index === 3).endTime, !!l.find(y => y.index === 3).noTime, l.find(y => y.index === 4).startTime],
  [iso(s0 + 3 * H), true, iso(s0 + 3 * H)]);
await page.waitForTimeout(400);
ok('and the stop shows as by the bell, not a time nobody saw', await page.evaluate(() => {
  const sel = document.querySelector('article[data-runner="jason"] select[data-intake-leg]');
  return [...sel.options].some(o => o.value === '3');
}), true);

await setRunner({ legs: lap3() });
await openPit();
said.length = 0;
await page.click('[data-action="by-out"][data-runner="jason"]');
ok('did not make it back takes a second tap', [(await page.textContent('[data-action="by-out"][data-runner="jason"]')).trim(),
  !!(await read('data.json')).runners[0].stoppedAt], ['Tap again to confirm: out', false]);
await page.waitForTimeout(800);
await page.click('[data-action="by-out"][data-runner="jason"]');
ok('and no dialog', said, []);
const out = await until(async () => (await read('data.json')).runners[0].stoppedAt);
ok('and is out at the bell, whenever somebody got to it', out, iso(s0 + 3 * H));
c = await until(async () => { const x = await card(); return x.badge === 'Out' ? x : null; });
ok('the card says Out, after two laps', c && [c.badge, c.where, c.buttons], ['Out', 'Out after 2 laps', ['Out [off]']]);

await page.goto(BASE + `/race.html?id=${SLUG}`);
await page.waitForSelector('article.runner .status-badge');
ok('the race page says Out', (await page.textContent('article.runner .status-badge')).trim(), 'Out');
ok('with the laps', (await page.textContent('article.runner .stat-projected')).replace(/\s+/g, ' ').trim().startsWith('Out 2 laps'), true);

console.log('\nautomatic send-off off');
s0 = await yard(2.5, { autoStart: false });
await setRunner({ legs: [{ index: 1, startTime: iso(s0), endTime: iso(s0 + 50 * M) }, { index: 2, startTime: iso(s0 + H), endTime: iso(s0 + 115 * M) }] });
await openPit();
c = await card();
ok('the bell has rung and nobody sent them: the button is two', c.buttons, [`Send off · lap 3 on the ${await clock(s0 + 2 * H)} bell`, "Didn't start · out"]);
ok('and nothing has been written for them', !(await legs()).find(x => x.index === 3), true);
await page.click('.big-split [data-action="press"][data-runner="jason"]');
ok('sent off, at the bell, not when the button was pressed',
  await until(async () => ((await legs()).find(x => x.index === 3) || {}).startTime), iso(s0 + 2 * H));

console.log('\nbetween laps');
s0 = await yard(1.5);
await setRunner({ legs: [{ index: 1, startTime: iso(s0), endTime: iso(s0 + 50 * M) }, { index: 2, startTime: iso(s0 + H), endTime: iso(s0 + 85 * M) }] });
await openPit();
c = await card();
ok('nothing to press until the bell', c.buttons, [`Lap 3 goes on the ${await clock(s0 + 2 * H)} bell [off]`]);
ok('which is counted down', await until(async () => /Next bell .* · \d+:\d\d to go/.test((await card()).bell)), true);

console.log('\nthe last one standing');
said.length = 0;
await page.click('[data-action="by-won"][data-runner="jason"]');
ok('the first tap only asks', (await page.textContent('[data-action="by-won"][data-runner="jason"]')).trim(), 'Tap again to confirm: won');
await page.waitForTimeout(800);
await page.click('[data-action="by-won"][data-runner="jason"]');
ok('the second makes it so, with no dialog', said, []);
const won = await until(async () => { const r = (await read('data.json')).runners[0]; return r.won ? r : null; });
ok('and is the winner, at the end of their last lap', won && [won.won, won.stoppedAt], [true, iso(s0 + 85 * M)]);
c = await until(async () => { const x = await card(); return x.badge === 'Winner' ? x : null; });
ok('the card says so', c && [c.badge, c.where], ['Winner', 'Won, last one standing, with 2 laps']);

console.log('\nthe racer\'s own screen');
s0 = await yard(3 + 10 / 60);
await setRunner({ legs: lap3() });
await page.goto(BASE + `/racer.html?id=${SLUG}&runner=jason`);
await page.waitForSelector('#act .rsplit', { timeout: 20000 });
ok('the same two answers', (await page.$$eval('#act .rsplit .rbtn', bs => bs.map(x => x.innerText.replace(/\s+/g, ' ').trim()))),
  ['BACK BY THE BELL Off on lap 4', "DIDN'T MAKE IT I'm out"]);
s0 = await yard(1.5);
await setRunner({ legs: [{ index: 1, startTime: iso(s0), endTime: iso(s0 + 50 * M) }, { index: 2, startTime: iso(s0 + H), endTime: iso(s0 + 85 * M) }] });
await page.goto(BASE + `/racer.html?id=${SLUG}&runner=jason`);
await page.waitForSelector('#act .rbtn', { timeout: 20000 });
ok('and between laps, the bell it goes on', (await page.$eval('#act .rbtn', x => x.innerText)).replace(/\s+/g, ' ').trim(),
  `LAP 3 ON THE ${await clock(s0 + 2 * H)} BELL You go out with the bell`);
ok('nothing on the screen is wider than the phone', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

// Out takes two taps: the first only arms the button and says what the
// second will do; a second tap straight after is the thumb bouncing and does
// nothing; a deliberate second tap is the confirmation. No dialog.
console.log('\nI\'m out takes two taps');
said.length = 0;
await page.click('#stop');
ok('the first tap only asks', [(await page.textContent('#stop')).trim(), !!(await read('data.json')).runners[0].stoppedAt],
  ["Tap again to confirm: I'm out", false]);
await page.click('#stop');
await page.waitForTimeout(300);
ok('a second tap straight after does nothing', !!(await read('data.json')).runners[0].stoppedAt, false);
await page.waitForTimeout(600);
await page.click('#stop');
ok('a deliberate second tap puts them out', !!(await until(async () => (await read('data.json')).runners[0].stoppedAt)), true);
ok('with no dialog on the way', said, []);
ok('and the screen says so, with a way back', [(await page.$eval('#act .rbtn', x => x.innerText.trim())), await page.locator('#unstop').count()], ['OUT', 1]);

console.log('\nand so does the split at the bell');
s0 = await yard(3 + 10 / 60);
await setRunner({ legs: lap3() });
await page.goto(BASE + `/racer.html?id=${SLUG}&runner=jason`);
await page.waitForSelector('#by-out', { timeout: 20000 });
await page.click('#by-out');
ok('the first tap only asks', (await page.$eval('#by-out', x => x.innerText.replace(/\s+/g, ' ').trim())), "TAP AGAIN to confirm you're out");
await page.waitForTimeout(800);
await page.click('#by-out');
ok('the second puts them out at the bell', await until(async () => (await read('data.json')).runners[0].stoppedAt), iso(s0 + 3 * H));
ok('still with no dialog', said, []);

console.log('\nsettings');
await yard(1.5);
await page.goto(BASE + `/settings?id=${SLUG}`);
await page.waitForSelector('#loops-editor-head', { state: 'visible', timeout: 20000 });
await page.click('#loops-editor-head');
await page.waitForSelector('#loops-format');
ok('reads it as a backyard, every 60 minutes, sent off by the bell',
  [await page.inputValue('#loops-format'), await page.inputValue('#loops-interval'), await page.isChecked('#loops-auto')], ['backyard', '60', true]);
await page.fill('#loops-interval', '75');
await page.uncheck('#loops-auto');
await page.click('#loops-save');
const saved = await until(async () => { const x = await read('config.json'); return x.backyard && x.backyard.intervalMin === 75 ? x : null; });
ok('and saves the interval and the choice', saved && [saved.format, saved.backyard], ['backyard', { intervalMin: 75, autoStart: false }]);

console.log('\nthe setup wizard');
await page.goto(BASE + '/setup.html');
await page.waitForSelector('#race-date', { timeout: 20000 });
const wiz = await page.evaluate(() => {
  document.getElementById('race-name').value = 'Yard Test';
  document.getElementById('race-date').value = '2027-04-03';
  document.getElementById('race-date').dispatchEvent(new Event('change', { bubbles: true }));
  setCourseType('loops');
  document.querySelector('input[name="fmt"][value="backyard"]').click();
  state.runners = [{ name: 'Jason', bib: '1', color: '#0a8b92' }];
  const shown = [document.getElementById('backyard-fields').style.display, document.getElementById('race-cutoff-grid').style.display];
  const cfg = buildConfig();
  return { shown, format: cfg.format, by: cfg.backyard, lap: cfg.course.loopDistanceMi, total: cfg.cutoffs.totalHours ?? null,
    errs: validate(cfg, 'yard-test') };
});
ok('the interval and the choice are offered, the finish cutoff is not', wiz.shown, ['', 'none']);
ok('a 4.167 mile lap on the hour, sent off by the bell', [wiz.format, wiz.by, wiz.lap], ['backyard', { intervalMin: 60, autoStart: true }, 4.167]);
ok('with no finish cutoff, and nothing missing', [wiz.total, wiz.errs], [null, []]);

await write('config.json', original);
ok('no page threw', errs, []);
await b.close();
console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
