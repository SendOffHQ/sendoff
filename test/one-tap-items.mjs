// A one-tap item that carries no numbers, which is how a medicine gets logged.
//
// The items were built for fuel: a flask is 17oz and 1200mg, one tap adds
// both. A medicine has neither, and the only thing worth recording about it is
// that it was taken and when. Before this the only way was to type it into the
// Meds box every time, at an aid station, on a phone, in the dark.
//
// So an item needs a name and nothing else. Which is a small rule with a long
// tail, because the counting was only half built:
//
//   - the pit board stages intake and commits it on Save, so a tap on an item
//     with no boxes to fill had nothing to stage and did nothing at all;
//   - both pages listed a filtered subset of items and handed each chip that
//     subset's index, while the tap handler looked the item up by its real
//     position. Equal only while nothing could ever be filtered out, which
//     stopped being true the moment an item could have no numbers. A chip
//     would have logged one item under another's name;
//   - and a count nobody displays is not a record, so the race page and the
//     printout show what was taken on each leg.
//
//   node test/one-tap-items.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net'; import fs from 'node:fs';
const BASE = 'http://localhost:8787';
const SLUG = 'zz-fixture-unlisted';
const PIN = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const listening = () => new Promise(r => { const s = net.connect(8787,'127.0.0.1');
  const d=v=>{s.destroy();r(v)}; s.once('connect',()=>d(true)); s.once('error',()=>d(false)); setTimeout(()=>d(false),500); });
if (await listening()) { console.error('port busy'); process.exit(2); }
const srv = spawn('node', [new URL('./harness.mjs', import.meta.url).pathname], { stdio: 'ignore' });
process.on('exit', () => { try { srv.kill('SIGKILL'); } catch (e) {} });
for (let i=0;i<40 && !(await listening());i++) await new Promise(r=>setTimeout(r,150));

const b = await chromium.launch(fs.existsSync(PIN) ? { executablePath: PIN } : {});
let bad = 0;
const ok=(l,g,w)=>{const q=JSON.stringify(g)===JSON.stringify(w); if(!q)bad++;
  console.log(`  ${q?'ok  ':'FAIL'} ${l.padEnd(52)} ${JSON.stringify(g)}${q?'':' want '+JSON.stringify(w)}`)};

const ctx = await b.newContext({ viewport:{width:900,height:1100}, serviceWorkers:'block' });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(BASE + '/index.html');
await page.evaluate(base => localStorage.setItem('race-hub-session-v1', JSON.stringify({
  session:'stub', proxyUrl: base + '/api', email:'crew@example.com', role:'owner',
  expiresAt: Date.now() + 7*24*3600e3 })), BASE);

// A medicine, defined the way somebody would: a name and nothing else.
console.log('\nan item with only a name can be saved at all');
await page.goto(BASE + `/settings.html?id=${SLUG}`);
await page.waitForSelector('#runner-editor-head', { timeout: 20000 });
await page.click('#runner-editor-head');
await page.waitForSelector('#preset-rows tr');
await page.click('#add-preset');
await page.fill('#preset-rows tr:last-child [data-k="name"]', 'Ibuprofen');
await page.click('#runner-save');
await page.waitForTimeout(2000);
await page.reload();
await page.waitForSelector('#runner-editor-head');
await page.click('#runner-editor-head');
await page.waitForSelector('#preset-rows tr');
ok('it is there after a reload', await page.evaluate(() =>
  [...document.querySelectorAll('#preset-rows [data-k="name"]')].map(e => e.value)),
  ['Flask of LMNT', 'Ibuprofen']);
ok('carrying no amounts', await page.evaluate(() =>
  [...document.querySelectorAll('#preset-rows tr:last-child [data-mk]')].map(e => e.value)),
  ['', '', '']);

// The pit board is where a crew member is standing when they hand one over.
console.log('\nand the pit board offers it');
await page.goto(BASE + `/pit.html?id=${SLUG}`);
await page.waitForSelector('[data-action="preset"]', { timeout: 20000 });
await page.waitForTimeout(400);
const chips = () => page.evaluate(() =>
  [...document.querySelectorAll('[data-action="preset"]')].map(e => ({
    name: e.childNodes[0].textContent.trim(),
    count: (e.querySelector('.chip-count') || {}).textContent || '',
    idx: e.dataset.preset })));
ok('both items, each with its real position', (await chips()).map(c => [c.name, c.idx]),
   [['+ Flask of LMNT', '0'], ['+ Ibuprofen', '1']]);

console.log('\ntapping it stages a count, since there are no boxes to fill');
await page.click('[data-action="preset"][data-preset="1"]');
await page.waitForTimeout(200);
ok('the chip says so', (await chips())[1].count, '×1');
await page.click('[data-action="preset"][data-preset="1"]');
await page.waitForTimeout(200);
ok('and counts up on a second tap', (await chips())[1].count, '×2');

// The numbered one still behaves as it always did, and must: the boxes are
// what a crew member checks before committing.
console.log('\nand a numbered item still fills the boxes');
const fluid = () => page.evaluate(() =>
  document.querySelector('[data-intake="fluidOz"]').value);
ok('the box starts empty', await fluid(), '');
await page.click('[data-action="preset"][data-preset="0"]');
await page.waitForTimeout(200);
ok('the flask\u2019s 17oz went in', await fluid(), '17');

console.log('\nSave intake commits what was staged');
await page.click('[data-action="save-intake"]');
await page.waitForTimeout(2500);
ok('the chip is clear again', (await chips())[1].count, '');
const saved = await page.evaluate(async (slug) => {
  const r = await fetch(`/api/get?path=races/${slug}/data.json`,
    { headers: { Authorization: 'Bearer stub' } });
  const j = await r.json();
  return JSON.parse(atob(j.content));
}, SLUG);
const legWith = (saved.runners || []).flatMap(r => r.legs || [])
  .find(l => l && l.preset_1);
ok('and the leg holds the count', legWith ? legWith.preset_1 : null, 2);

// A count nobody can read is not a record. This is the whole point of logging
// a medicine: somebody afterwards asking when it was given.
console.log('\nand it reads back as words where people look');
await page.goto(BASE + `/race.html?id=${SLUG}`);
await page.waitForSelector('#runners .leg-log, #runners table', { timeout: 20000 });
await page.waitForTimeout(800);
const onRace = await page.evaluate(() =>
  [...document.querySelectorAll('.note-row')].map(e => e.textContent).join(' | '));
ok('on the race page', /Ibuprofen ×2/.test(onRace), true);

await page.goto(BASE + `/print-report.html?id=${SLUG}`);
await page.waitForTimeout(2000);
const onPrint = await page.evaluate(() => document.body.textContent);
ok('and on the printout', /Ibuprofen ×2/.test(onPrint), true);

// The racer's own page, which is where a solo runner logs from.
//
// The chips used to appear only while a racer was stopped at an aid station,
// on the reasoning that logging belongs where you are standing still. That is
// wrong for what these are for: a gel or a dose is taken between aid stations,
// and logged at the next one it is logged from memory, which is the thing
// one-tap items exist to avoid. Medicines are the whole reason an item with no
// numbers can exist at all.
//
// So they are drawn while a leg is underway too, and the concern that answered
// is met head on instead: a chip that has been pressed carries a take-back
// beside it, so a mistaken tap costs one press to undo without leaving the
// page.
console.log('\nthe racer page, with a leg underway');
const setLegs = (legs) => page.evaluate(async ([slug, legs]) => {
  await fetch('/api/commit', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer stub' },
    body: JSON.stringify({ path: `races/${slug}/data.json`,
      content: JSON.stringify({ runners: [{ id: 'jason', legs }] }, null, 2) + '\n',
      message: 'test' }) });
}, [SLUG, legs]);
const openRacer = async () => {
  await page.goto(BASE + `/racer.html?id=${SLUG}`);
  await page.waitForTimeout(2600);
};
const racerChips = () => page.evaluate(() => {
  const ro = document.getElementById('readout');
  return {
    chips: ro.querySelectorAll('.rchip').length,
    undos: ro.querySelectorAll('.rchip-undo').length,
    counts: [...ro.querySelectorAll('.rchip .cnt')].map(e => e.textContent.trim())
  };
});
const storedLeg = () => page.evaluate(async (slug) => {
  const r = await fetch(`/api/get?path=races/${slug}/data.json`, { headers: { Authorization: 'Bearer stub' } });
  const d = JSON.parse(atob((await r.json()).content));
  return ((d.runners[0] || {}).legs || [])[0] || null;
}, SLUG);

const OUT = { index: 1, startTime: '2026-09-08T01:00:00.000Z' };

await setLegs([]);
await openRacer();
ok('nothing to press before the race starts', (await racerChips()).chips, 0);

await setLegs([OUT]);
await openRacer();
ok('but on the move the items are there', (await racerChips()).chips, 2);
ok('with nothing to take back yet', (await racerChips()).undos, 0);

await page.click('.rchip-row:nth-child(2) .rchip');
await page.waitForTimeout(900);
ok('a dose logs from the trail', (await racerChips()).counts[1], '×1');
ok('and a take-back appears beside it', (await racerChips()).undos, 1);
await page.click('.rchip-row:nth-child(2) .rchip');
await page.waitForTimeout(900);
ok('a second one counts up', (await racerChips()).counts[1], '×2');

console.log('\nand a mistaken tap costs one press to undo');
await page.click('.rchip-row:nth-child(2) .rchip-undo');
await page.waitForTimeout(900);
ok('one comes back off', (await racerChips()).counts[1], '×1');
await page.click('.rchip-row:nth-child(2) .rchip-undo');
await page.waitForTimeout(900);
ok('and the last one clears it', (await racerChips()).counts[1], '');
ok('the take-back goes with it', (await racerChips()).undos, 0);
ok('and the leg is back to none, not below it',
  (await storedLeg() || {}).preset_1, 0);

// A numbered item takes its amounts back too, and stops at zero: the crew can
// type into these from the pit board, and a blind subtraction would take
// somebody else's number negative.
console.log('\nand a numbered item gives its amounts back');
await page.click('.rchip-row:nth-child(1) .rchip');
await page.waitForTimeout(900);
ok('the flask\u2019s fluid went on the leg', (await storedLeg() || {}).fluidOz, 17);
await page.click('.rchip-row:nth-child(1) .rchip-undo');
await page.waitForTimeout(900);
const back = await storedLeg() || {};
ok('and comes back off', back.fluidOz, 0);
ok('leaving the count at none', back.preset_0, 0);

// The case the floor is actually for, and it is reachable: the racer taps a
// flask, the crew then corrects the leg's fluid to zero from the pit board,
// and the racer takes the flask back. A blind subtraction would put somebody
// else's number at minus seventeen.
console.log('\neven when the crew has already corrected the number');
await setLegs([{ ...OUT, preset_0: 1, fluidOz: 0, sodiumMg: 0 }]);
await openRacer();
ok('the tap is still on the chip', (await racerChips()).counts[0], '×1');
await page.click('.rchip-row:nth-child(1) .rchip-undo');
await page.waitForTimeout(900);
const floored = await storedLeg() || {};
ok('taking it back does not go below zero',
  [floored.fluidOz, floored.sodiumMg], [0, 0]);
ok('and the count still clears', floored.preset_0, 0);

ok('nothing threw', errs, []);
await b.close();
console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
