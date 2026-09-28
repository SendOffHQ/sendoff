// Racing with no crew, from what the Sangre de Cristo 100 taught.
//
// That race was run self-crewed and logged from the racer page alone. Check in
// and out held for all 32 presses; the one-tap items held for eleven legs;
// everything that had to be typed was given up, and the page then spent
// thirteen hours saying the runner was falling behind on everything. Four
// changes came out of it, and each is held here:
//
//   - the items can be dragged into order, so the ones pressed most are on top,
//     without moving any count already logged onto a different item;
//   - a write-in box for whatever has no item, which keeps what was typed
//     through a poll and is held on the phone with no signal;
//   - the per-hour rate stops at the last leg that was logged, and says so;
//   - photos sit above the items, and the button stays at the bottom of the
//     screen however far down the page has been scrolled.
//
//   node test/solo-racer.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net'; import fs from 'node:fs';
const BASE = 'http://localhost:8787';
const SLUG = 'zz-fixture-unlisted';
const PIN = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const HARNESS = new URL('./harness.mjs', import.meta.url).pathname;

const listening = () => new Promise(r => { const s = net.connect(8787,'127.0.0.1');
  const d=v=>{s.destroy();r(v)}; s.once('connect',()=>d(true)); s.once('error',()=>d(false)); setTimeout(()=>d(false),500); });
if (await listening()) { console.error('port busy'); process.exit(2); }
let srv = spawn('node', [HARNESS], { stdio: 'ignore' });
process.on('exit', () => { try { srv.kill('SIGKILL'); } catch (e) {} });
const waitFor = async (up) => { for (let i = 0; i < 60 && (await listening()) !== up; i++) await new Promise(r => setTimeout(r, 150)); };
await waitFor(true);

const b = await chromium.launch(fs.existsSync(PIN) ? { executablePath: PIN } : {});
let bad = 0;
const ok=(l,g,w)=>{const q=JSON.stringify(g)===JSON.stringify(w); if(!q)bad++;
  console.log(`  ${q?'ok  ':'FAIL'} ${l.padEnd(56)} ${JSON.stringify(g)}${q?'':' want '+JSON.stringify(w)}`)};

// A phone, because that is where all of this happens.
const ctx = await b.newContext({ viewport: { width: 390, height: 700 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(BASE + '/index.html');
await page.evaluate(base => localStorage.setItem('race-hub-session-v1', JSON.stringify({
  session:'stub', proxyUrl: base + '/api', email:'crew@example.com', role:'owner',
  expiresAt: Date.now() + 7*24*3600e3 })), BASE);

const api = (path, body) => page.evaluate(async ([path, body]) => {
  const r = await fetch('/api/' + path, body ? { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer stub' }, body: JSON.stringify(body) }
    : { headers: { Authorization: 'Bearer stub' } });
  if (!r.ok) throw new Error(path + ' ' + r.status);
  return r.json();
}, [path, body]);
const read = async file => JSON.parse(Buffer.from((await api(`get?path=races/${SLUG}/${file}`)).content, 'base64').toString('utf8'));
const write = (file, doc) => api('commit', { path: `races/${SLUG}/${file}`,
  content: JSON.stringify(doc, null, 2) + '\n', message: 'test' });

const HOUR = 3600e3;
// Legs of an hour, back to back, starting `hoursAgo` ago; `extra` fills in
// what was logged on each, by leg index. The leg after the last done one is
// underway unless the race is over.
const legsFrom = (hoursAgo, done, extra = {}) => {
  const t0 = Date.now() - hoursAgo * HOUR;
  const out = [];
  for (let i = 0; i < done; i++) {
    out.push({ index: i + 1, startTime: new Date(t0 + i * HOUR).toISOString(),
      endTime: new Date(t0 + (i + 1) * HOUR).toISOString(), ...(extra[i + 1] || {}) });
  }
  out.push({ index: done + 1, startTime: new Date(t0 + done * HOUR).toISOString(), endTime: null,
    ...(extra[done + 1] || {}) });
  return out;
};
const setLegs = legs => write('data.json', { runners: [{ id: 'jason', legs }] });

// Eight items, so the list is longer than the screen, and a goal to measure
// against so the per-hour block is drawn at all.
const cfg = await read('config.json');
delete cfg.myRole;
cfg.fuelPresets = ['Gel', 'Salt pill', 'Flask', 'Ibuprofen', 'Broth', 'Coke', 'Chips', 'Tums']
  .map((name, n) => ({ name, values: n === 0 ? { calories: 100 } : {} }));
delete cfg.presetOrder;
cfg.runners = cfg.runners.map(r => ({ ...r, targets: { caloriesPerHour: 250 } }));
// Started six hours ago, so it is live by the clock and the pages poll every
// five seconds. The fixture's own start is weeks back, which reads as a
// finished race polled every two minutes, and a test of what a poll does to
// the page would then run without a single poll in it.
cfg.startTime = new Date(Date.now() - 6 * HOUR).toISOString();
await write('config.json', cfg);

console.log('\nputting the items in order');
// Two gels already on the leg underway, before anything moves.
await setLegs(legsFrom(1.5, 1, { 2: { preset_0: 2, calories: 200 } }));
await page.goto(BASE + `/settings.html?id=${SLUG}`);
await page.waitForSelector('#runner-editor-head', { timeout: 20000 });
await page.click('#runner-editor-head');
await page.waitForSelector('#preset-rows tr');
const names = () => page.evaluate(() =>
  [...document.querySelectorAll('#preset-rows [data-k="name"]')].map(e => e.value));
ok('every row has a handle', await page.locator('#preset-rows [data-drag]').count(), 8);

// Drag Tums, the last, up to the top, the way a thumb would: press on the
// handle, move, let go.
const grab = async (from, toRow) => {
  const h = await page.locator(`#preset-rows tr:nth-child(${from}) [data-drag]`).boundingBox();
  const t = await page.locator(`#preset-rows tr:nth-child(${toRow})`).boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2, t.y + 2, { steps: 12 });
  await page.mouse.up();
};
// On screen first: a press that lands off the page lands on nothing, for a
// test as for a thumb.
await page.evaluate(() => document.getElementById('preset-table').scrollIntoView({ block: 'center' }));
await grab(8, 1);
ok('a drag moves the row', (await names())[0], 'Tums');
// And the keys on the same handle, for anybody without a pointer: Salt pill,
// now third, goes up one.
await page.focus('#preset-rows tr:nth-child(3) [data-drag]');
await page.keyboard.press('ArrowUp');
ok('the arrow keys move it one place', (await names()).slice(0, 3), ['Tums', 'Salt pill', 'Gel']);
ok('and the handle keeps the focus', await page.evaluate(() =>
  document.activeElement && document.activeElement.closest('tr').querySelector('[data-k="name"]').value), 'Salt pill');
await page.click('#runner-save');
await page.waitForTimeout(2000);

const saved = await read('config.json');
// The list is not rewritten, only the order beside it. A count is kept under
// the item's position, so rewriting the list is how two gels would have become
// two Tums.
ok('the items themselves are where they were', saved.fuelPresets.map(p => p.name),
  ['Gel', 'Salt pill', 'Flask', 'Ibuprofen', 'Broth', 'Coke', 'Chips', 'Tums']);
ok('with the order kept beside them', saved.presetOrder, [7, 1, 0, 2, 3, 4, 5, 6]);

console.log('\nthe racer page, in that order');
const openRacer = async () => {
  await page.goto(BASE + `/racer.html?id=${SLUG}`);
  await page.waitForSelector('#rclock', { timeout: 20000 });
  await page.waitForTimeout(1500);
};
await openRacer();
const chips = () => page.evaluate(() => [...document.querySelectorAll('#intake .rchip')].map(c => ({
  name: c.querySelector('span').firstChild.textContent.replace(/^\+\s*/, '').trim(),
  count: c.querySelector('.cnt').textContent.trim() })));
ok('the chips come in the dragged order', (await chips()).slice(0, 3).map(c => c.name), ['Tums', 'Salt pill', 'Gel']);
ok('and the two gels are still gels', (await chips()).find(c => c.name === 'Gel').count, '×2');
await page.click('#intake .rchip >> text=Tums');
await page.waitForTimeout(800);
const leg2 = (await read('data.json')).runners[0].legs.find(l => l.index === 2);
ok('a tap on the moved item counts that item', [leg2.preset_7, leg2.preset_0], [1, 2]);

// A runner with no crew should not have to go into settings mid-race to get
// the item they keep pressing to the top. Behind a switch, so a thumb
// scrolling the list is never a thumb dragging it.
console.log('\nputting them in order from the racer page');
ok('no grips until asked for', await page.locator('#intake [data-grip]').count(), 0);
await page.click('#reorder-toggle');
ok('the switch brings them, one per item', await page.locator('#intake [data-grip]').count(), 8);
ok('on the left of each chip', await page.evaluate(() =>
  [...document.querySelectorAll('#rchips .rchip-row')].every(r => r.firstElementChild.matches('[data-grip]'))), true);
ok('and the items do not log while it is on', await page.evaluate(() =>
  [...document.querySelectorAll('#rchips .rchip')].every(c => c.disabled)), true);
await page.evaluate(() => document.getElementById('rchips').scrollIntoView({ block: 'center' }));
const dragChip = async (from, toRow) => {
  const h = await page.locator(`#rchips .rchip-row:nth-child(${from}) [data-grip]`).boundingBox();
  const t = await page.locator(`#rchips .rchip-row:nth-child(${toRow})`).boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2, t.y + 2, { steps: 14 });
  await page.mouse.up();
};
await dragChip(8, 1);
await page.waitForTimeout(800);
ok('a drag moves it to the top', (await chips()).slice(0, 3).map(c => c.name), ['Chips', 'Tums', 'Salt pill']);
ok('and the race keeps that order', (await read('config.json')).presetOrder, [6, 7, 1, 0, 2, 3, 4, 5]);
ok('without the list itself moving', (await read('config.json')).fuelPresets.map(p => p.name),
  ['Gel', 'Salt pill', 'Flask', 'Ibuprofen', 'Broth', 'Coke', 'Chips', 'Tums']);
await page.click('#reorder-toggle');
ok('done puts the grips away', await page.locator('#intake [data-grip]').count(), 0);
await page.click('#intake .rchip >> text=Gel');
await page.waitForTimeout(800);
ok('and a gel is still a gel', (await read('data.json')).runners[0].legs.find(l => l.index === 2).preset_0, 3);

// The menu, left open, through the polls. Every race page calls nav.setRace
// from inside its poll, and that used to redraw the whole menu every five
// seconds, closed, so it snapped shut under somebody still reading it.
console.log('\nthe menu stays open through the polls');
const menuOpenThroughPolls = async () => {
  await page.click('.account-menu-btn');
  const open = () => page.evaluate(() => {
    const m = document.querySelector('.account-menu');
    return !!m && !m.hidden;
  });
  const before = await open();
  await page.waitForTimeout(12000);
  const after = await open();
  await page.keyboard.press('Escape');
  return [before, after];
};
ok('on the racer page', await menuOpenThroughPolls(), [true, true]);
await page.goto(BASE + `/pit.html?id=${SLUG}`);
await page.waitForTimeout(2500);
ok('and on the pit board', await menuOpenThroughPolls(), [true, true]);
await openRacer();

console.log('\nthe page, top to bottom');
ok('photos above the items, the button after everything', await page.evaluate(() => {
  const at = id => document.getElementById(id);
  const follows = (a, bb) => (at(a).compareDocumentPosition(at(bb)) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  return [follows('readout', 'photos'), follows('photos', 'intake'), follows('intake', 'act'), !at('act').nextElementSibling];
}), [true, true, true, true]);
ok('eight items make the page longer than the screen', await page.evaluate(() =>
  document.documentElement.scrollHeight > window.innerHeight + 200), true);
const pinned = () => page.evaluate(() => {
  const r = document.getElementById('act').getBoundingClientRect();
  return r.top >= 0 && Math.abs(window.innerHeight - r.bottom) < 2;
});
ok('the button is at the bottom of the screen at the top', await pinned(), true);
await page.evaluate(() => document.getElementById('photos').scrollIntoView({ block: 'start' }));
ok('and scrolled to the photos', await pinned(), true);
await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
ok('and all the way down', await pinned(), true);

console.log('\nwriting in what has no item');
await page.fill('#jot', 'half a hummus wrap');
// The readout redraws on every poll. What is typed must not go with it.
await page.waitForTimeout(6500);
ok('what is typed survives a poll', await page.inputValue('#jot'), 'half a hummus wrap');
await page.press('#jot', 'Enter');
await page.waitForTimeout(800);
ok('sending clears the box', await page.inputValue('#jot'), '');
ok('and the line shows under it', await page.evaluate(() =>
  [...document.querySelectorAll('#jot-list div')].map(d => d.textContent.replace(/^[^:]+:\d\d(\s?[AP]M)?:\s*/, ''))),
  ['half a hummus wrap']);
let notes = (await read('data.json')).runners[0].legs.find(l => l.index === 2).notes || '';
ok('stored on the leg underway, with the time', /^\d{1,2}:\d\d(\s?[AP]M)?: half a hummus wrap$/.test(notes), true);
await page.click('#jot-send');
ok('an empty box sends nothing', ((await read('data.json')).runners[0].legs.find(l => l.index === 2).notes || '').split('\n').length, 1);
await page.fill('#jot', 'new socks');
await page.click('#jot-send');
await page.waitForTimeout(800);
notes = (await read('data.json')).runners[0].legs.find(l => l.index === 2).notes || '';
ok('a second one is a second line, not a replacement', notes.split('\n').map(s => s.replace(/^[^:]+:\d\d(\s?[AP]M)?:\s*/, '')),
  ['half a hummus wrap', 'new socks']);

// No signal. The server is gone, not emulated away: see offline-browser.mjs
// for why the emulation cannot be trusted with this.
console.log('\nwith no signal');
srv.kill('SIGKILL');
await waitFor(false);
await page.fill('#jot', 'blister on left heel');
await page.click('#jot-send');
await page.waitForTimeout(600);
ok('it still shows as written', await page.evaluate(() =>
  [...document.querySelectorAll('#jot-list div')].some(d => /blister on left heel$/.test(d.textContent))), true);
ok('and is held on the phone', await page.evaluate(() => Race.queue.pending().length > 0), true);
// A reorder with no signal is held the same way.
await page.click('#reorder-toggle');
await page.focus('#rchips .rchip-row:nth-child(4) [data-grip]');
await page.keyboard.press('ArrowUp');
await page.click('#reorder-toggle');
ok('a reorder with no signal still shows', (await chips()).slice(0, 4).map(c => c.name),
  ['Chips', 'Tums', 'Gel', 'Salt pill']);
ok('and is held with it', await page.evaluate(() =>
  Race.queue.pending().some(e => e.op === 'setPresetOrder')), true);
srv = spawn('node', [HARNESS], { stdio: 'ignore' });
await waitFor(true);
// The restarted server has only the fixture, so what lands is the held write
// itself and nothing else.
// What a phone does when the signal comes back. The queue also retries every
// thirty seconds on its own, which the wait below would outlast anyway.
await page.evaluate(() => window.dispatchEvent(new Event('online')));
let landed = false;
for (let i = 0; i < 80 && !landed; i++) {
  await page.waitForTimeout(500);
  try {
    const n = (await read('data.json')).runners[0].legs.find(l => l.index === 2).notes || '';
    landed = /blister on left heel$/.test(n);
  } catch (e) { /* not up yet */ }
}
ok('and sent when the signal comes back', landed, true);
let order = null;
for (let i = 0; i < 40 && JSON.stringify(order) !== '[6,7,0,1,2,3,4,5]'; i++) {
  await page.waitForTimeout(500);
  try { order = (await read('config.json')).presetOrder; } catch (e) { /* not up yet */ }
}
ok('the held reorder lands too', order, [6, 7, 0, 1, 2, 3, 4, 5]);

console.log('\nwhen the logging stops');
// Restored after the restart, which forgot everything written before it.
await write('config.json', { ...cfg, presetOrder: [7, 1, 0, 2, 3, 4, 5, 6] });
// 200 calories an hour on legs one to three, nothing on four and five, and
// the sixth underway: the Sangre de Cristo shape, shortened.
await setLegs(legsFrom(5.5, 5, { 1: { calories: 200 }, 2: { calories: 200 }, 3: { calories: 200 } }));
await openRacer();
const perHour = () => page.evaluate(() => {
  const blk = [...document.querySelectorAll('#readout .rblock')].find(b => /per hour/i.test(b.textContent));
  return { note: (blk.querySelector('.rlogged') || {}).textContent || null,
           cal: blk.querySelector('.rfuel .v').textContent.trim() };
});
const ph = await perHour();
ok('it says where the log ends', ph.note,
  'Logged through leg 3 (Colony Creek 1). Nothing since, so the rate stops there.');
// Five hours of legs, 600 calories: 120 an hour if the silence counted as
// eating nothing, 200 over the three hours that were logged.
ok('and the rate is the one it logged', ph.cal.startsWith('200'), true);

await setLegs(legsFrom(5.5, 5, { 1: { calories: 200 }, 2: { calories: 200 }, 3: { calories: 200 }, 5: { preset_1: 1 } }));
await openRacer();
ok('logging again puts it back to the whole race', (await perHour()).note, null);

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
