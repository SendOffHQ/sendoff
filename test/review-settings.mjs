// Settings and the setup wizard, from the review of 2026-11-12.
//
//   - Deleting a one-tap item moved every item after it up one, and with it
//     every count already logged: six gels became six salt pills.
//   - An item taken off a racer could not be given back.
//   - Going from two racers to one left the survivor with a hidden list.
//   - Changing units and then saving the loops rescaled every lap.
//   - Moving the start date left aid station cutoffs on the old date.
//   - The half-minute refresh put unsaved unit choices back.
//   - The wizard gave two racers of the same name one id, kept "mi" on loop
//     cards after a switch to km, and let a bad last-lap gate through.
//
//   node test/review-settings.mjs
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
const ctx = await b.newContext({ viewport: { width: 1100, height: 900 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('dialog', d => d.accept());
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
const original = await read('config.json'); delete original.myRole;
const base = () => JSON.parse(JSON.stringify(original));
const ago = (min) => new Date(Date.now() - min * 60e3).toISOString();
const openItems = async () => {
  await page.goto(BASE + `/settings?id=${SLUG}`);
  await page.waitForSelector('#runner-editor-head', { state: 'visible', timeout: 20000 });
  await page.click('#runner-editor-head');
  await page.waitForSelector('#preset-rows', { state: 'attached' });
  await page.waitForTimeout(300);
};
const itemNames = () => page.$$eval('#preset-rows [data-k="name"]', els => els.map(e => e.value));
const saveRacers = async () => { await page.click('#runner-save'); await page.waitForTimeout(900); };

// ------------------------------------------------------------------ items
console.log('\ndeleting an item that things were logged after');
let cfg = base();
cfg.runners = [{ ...cfg.runners[0], id: 'jason' }];
cfg.fuelPresets = [{ name: 'Gel', values: { calories: 100 } }, { name: 'Salt pill', values: {} }, { name: 'Flask', values: { calories: 200 } }];
delete cfg.presetOrder;
await write('config.json', cfg);
// Six salt pills and a flask on the first leg.
await write('data.json', { runners: [{ id: 'jason', legs: [{ index: 1, startTime: ago(90), endTime: ago(30), preset_1: 6, preset_2: 1 }] }] });
await openItems();
ok('three items to start with', await itemNames(), ['Gel', 'Salt pill', 'Flask']);
await page.click('[data-del-preset="0"]');
ok('the Gel row goes', await itemNames(), ['Salt pill', 'Flask']);
await saveRacers();
let saved = await until(async () => { const c = await read('config.json'); return c.fuelPresets.some(p => p.removed) ? c : null; });
ok('but it keeps its place, marked as removed, so nothing after it moves',
  saved && saved.fuelPresets.map(p => [p.name, !!p.removed]), [['Gel', true], ['Salt pill', false], ['Flask', false]]);
const shown = await page.evaluate(([c, d]) => ({
  offered: Race.fuel.presetsFor(c, c.runners[0]).map(x => [x.p.name, x.i]),
  logged: Race.fuel.presets(c)[1].name
}), [saved, null]);
ok('the six are still six salt pills', shown.logged, 'Salt pill');
ok('and the removed one is offered nowhere', shown.offered, [['Salt pill', 1], ['Flask', 2]]);

console.log('\ndeleting one that nothing depends on');
await write('data.json', { runners: [{ id: 'jason', legs: [{ index: 1, startTime: ago(90), endTime: ago(30), preset_0: 2 }] }] });
cfg = base(); cfg.runners = [{ ...cfg.runners[0], id: 'jason' }];
cfg.fuelPresets = [{ name: 'Gel', values: { calories: 100 } }, { name: 'Flask', values: { calories: 200 } }];
delete cfg.presetOrder;
await write('config.json', cfg);
await openItems();
await page.click('[data-del-preset="1"]');
await saveRacers();
saved = await until(async () => { const c = await read('config.json'); return c.fuelPresets.length === 1 ? c : null; });
ok('takes it out of the list for good', saved && saved.fuelPresets.map(p => p.name), ['Gel']);

console.log('\nan item taken off a racer, and given back');
cfg = base();
cfg.runners = [{ ...cfg.runners[0], id: 'ann', name: 'Ann', presets: [0] }, { ...cfg.runners[0], id: 'bo', name: 'Bo' }];
cfg.fuelPresets = [{ name: 'Gel', values: { calories: 100 } }, { name: 'Flask', values: { calories: 200 } }];
delete cfg.presetOrder;
await write('config.json', cfg);
await write('data.json', { runners: [{ id: 'ann', legs: [] }, { id: 'bo', legs: [] }] });
await openItems();
ok('Ann has the one', await itemNames(), ['Gel']);
ok('and is offered the other', (await page.textContent('#preset-more')).replace(/\s+/g, ' ').trim(), 'Also on this race: + Flask');
await page.click('[data-give-preset="1"]');
ok('one tap gives it to her', await itemNames(), ['Gel', 'Flask']);
await saveRacers();
saved = await until(async () => { const c = await read('config.json'); return !c.runners[0].presets ? c : null; });
ok('and with every item hers, no list is kept', saved && saved.runners.map(r => r.presets || null), [null, null]);

console.log('\ntwo racers down to one');
cfg = base();
cfg.runners = [{ ...cfg.runners[0], id: 'ann', name: 'Ann', presets: [0] }];
cfg.fuelPresets = [{ name: 'Gel', values: { calories: 100 } }, { name: 'Flask', values: { calories: 200 } }];
delete cfg.presetOrder;
await write('config.json', cfg);
await write('data.json', { runners: [{ id: 'ann', legs: [] }] });
await openItems();
ok('settings shows every item', await itemNames(), ['Gel', 'Flask']);
ok('and so does everything that offers them', await page.evaluate((c) => Race.fuel.presetsFor(c, c.runners[0]).map(x => x.p.name), cfg), ['Gel', 'Flask']);
await saveRacers();
saved = await until(async () => { const c = await read('config.json'); return !c.runners[0].presets ? c : null; });
ok('a save clears the list left over from when there were two', !!saved, true);

// ------------------------------------------------------------ race details
console.log('\nmoving the start date');
cfg = base();
await write('config.json', cfg);
await write('data.json', { runners: [{ id: cfg.runners[0].id, legs: [] }] });
const cutsBefore = cfg.course.segments.map(s => s.arriveCutoffHours ?? null);
await page.goto(BASE + `/settings?id=${SLUG}`);
await page.waitForSelector('#race-editor-head', { state: 'visible', timeout: 20000 });
await page.click('#race-editor-head');
await page.waitForSelector('#race-start-date', { state: 'visible' });
const startDate = await page.inputValue('#race-start-date');
const later = new Date(Date.parse(startDate + 'T12:00:00Z') + 7 * 864e5).toISOString().slice(0, 10);
await page.fill('#race-start-date', later);
await page.dispatchEvent('#race-start-date', 'change');
await page.click('#race-save');
saved = await until(async () => { const c = await read('config.json'); return c.startTime !== cfg.startTime ? c : null; });
const round = (v) => v == null ? null : Math.round(v * 60);
ok('the race is a week later', saved && Math.round((Date.parse(saved.startTime) - Date.parse(cfg.startTime)) / 864e5), 7);
ok('and every cutoff is as long after the start as it was',
  saved && [saved.course.segments.map(s => round(s.arriveCutoffHours ?? null)), round(saved.cutoffs.totalHours)],
  [cutsBefore.map(round), round(cfg.cutoffs.totalHours)]);

console.log('\na unit picked and not yet saved');
await write('config.json', base());
await page.goto(BASE + `/settings?id=${SLUG}`);
await page.waitForSelector('#race-editor-head', { state: 'visible', timeout: 20000 });
await page.click('#race-editor-head');
await page.selectOption('#race-unit-distance', 'km');
await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
await page.waitForTimeout(1500);
await page.evaluate(() => render());
ok('is still picked after a refresh', await page.inputValue('#race-unit-distance'), 'km');

console.log('\nchanging units, then saving the loops');
cfg = base();
Object.assign(cfg, { courseType: 'loops', course: { loopCount: 7, loopDistanceMi: 10 } });
delete cfg.format;
await write('config.json', cfg);
await page.goto(BASE + `/settings?id=${SLUG}`);
await page.waitForSelector('#loops-editor-head', { state: 'visible', timeout: 20000 });
await page.click('#loops-editor-head');
await page.waitForSelector('[data-l="0"][data-k="distance"]');
ok('a ten mile lap', await page.inputValue('[data-l="0"][data-k="distance"]'), '10');
await page.click('#race-editor-head');
await page.selectOption('#race-unit-distance', 'km');
await page.click('#race-save');
await until(async () => ((await read('config.json')).units || {}).distance === 'km');
ok('reads as 16.09 once the race is in kilometres', await until(async () => (await page.inputValue('[data-l="0"][data-k="distance"]')) === '16.09'), true);
await page.click('#loops-save');
await page.waitForTimeout(1200);
saved = await read('config.json');
const lapMi = saved.course.loopDistanceMi || (saved.course.loops && saved.course.loops[0].distanceMi);
ok('and is still ten miles when the loops are saved', Math.round(lapMi * 100) / 100, 10);
await write('config.json', base());

// ------------------------------------------------------------------ wizard
console.log('\nthe setup wizard');
await page.goto(BASE + '/setup.html');
await page.waitForSelector('#race-date', { timeout: 20000 });
const wiz = await page.evaluate(() => {
  document.getElementById('race-name').value = 'Wizard Test';
  document.getElementById('race-date').value = '2027-03-06';
  document.getElementById('race-date').dispatchEvent(new Event('change', { bubbles: true }));
  state.aidStations = [{ name: 'Start', mileage: 0, arriveCutoffHours: '' }, { name: 'Halfway', mileage: 10, arriveCutoffHours: '' }, { name: 'Finish', mileage: 20, arriveCutoffHours: '' }];
  state.runners = [{ name: 'Sam', bib: '1', color: '#0a8b92' }, { name: 'Sam', bib: '2', color: '#1f5e8a' }, { name: '!!!', bib: '3', color: '#3a8a3a' }, { name: '???', bib: '4', color: '#8a3a5e' }];
  const first = buildConfig();
  // The date was typed wrong and is corrected to a week later.
  const cutBefore = JSON.stringify(state.finishCut);
  document.getElementById('race-date').value = '2027-03-13';
  document.getElementById('race-date').dispatchEvent(new Event('change', { bubbles: true }));
  const second = buildConfig();
  // A last-lap gate after the finish cutoff.
  const gated = buildConfig(); gated.cutoffs.lastLegStartHours = gated.cutoffs.totalHours + 1;
  // A named station with no distance.
  state.aidStations.splice(2, 0, { name: 'Forgotten Gap', mileage: '', arriveCutoffHours: '' });
  const halfErrs = validate(buildConfig(), 'wizard-test');
  state.aidStations.splice(2, 1);
  return {
    ids: first.runners.map(r => r.id),
    hours: [Math.round(first.cutoffs.totalHours), Math.round(second.cutoffs.totalHours)],
    moved: [cutBefore, JSON.stringify(state.finishCut)],
    gate: validate(gated, 'wizard-test').filter(e => /last-lap gate/.test(e)).length,
    half: halfErrs.filter(e => /Forgotten Gap has no distance/.test(e)).length,
    clean: validate(second, 'wizard-test')
  };
});
ok('every racer gets an id of their own', [new Set(wiz.ids).size, wiz.ids], [4, ['sam', 'sam-2', 'race', 'race-2']]);
ok('the finish cutoff follows a corrected start date', wiz.hours, [36, 36]);
ok('a last-lap gate after the finish is refused', wiz.gate, 1);
ok('a named station with no distance is said, not dropped', wiz.half, 1);
ok('and a good race still passes', wiz.clean, []);
await page.evaluate(() => { state.courseType = 'loops'; });
await page.selectOption('#unit-distance', 'km');
ok('loop cards say km once the race does', await until(() => page.evaluate(() => /Lap km/.test(document.getElementById('loop-cards').textContent))), true);

ok('no page threw', errs, []);
await b.close();
console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
