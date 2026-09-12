// Aid stations can be put in order after they are typed in.
//
// The order is the course: segmentsFromAidStations reads the list in order and
// startAidFrom reads position 0, so a station typed in the wrong place used to
// mean retyping every row after it. The wizard now has up and down on each row.
//
// Three things that have to hold, and none of them are visible from the code:
//   - the whole station moves, mileage and options with it, or the course the
//     wizard builds does not match the table somebody is looking at;
//   - the start never moves and nothing moves above it, because its mileage is
//     fixed at zero and the course is read off it by position;
//   - the focus stays on the button, or moving a row three places means finding
//     it again three times.
//
//   node test/aid-reorder.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net'; import fs from 'node:fs';
const BASE = 'http://localhost:8787';
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
  console.log(`  ${q?'ok  ':'FAIL'} ${l.padEnd(50)} ${JSON.stringify(g)}${q?'':' want '+JSON.stringify(w)}`)};

const ctx = await b.newContext({ viewport:{width:900,height:1100}, serviceWorkers:'block' });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(BASE + '/index.html');
await page.evaluate(base => localStorage.setItem('race-hub-session-v1', JSON.stringify({
  session:'stub', proxyUrl: base + '/api', email:'me@example.com', role:'owner',
  expiresAt: Date.now() + 7*24*3600e3 })), BASE);
await page.goto(BASE + '/setup.html');
await page.waitForTimeout(800);

const rows = () => page.evaluate(() =>
  [...document.querySelectorAll('#aid-rows [data-k="name"]')].map((e, i) =>
    [e.value, document.querySelector(`#aid-rows [data-aid="${i}"][data-k="mileage"]`).value]));

// The shape a new race starts from. Start and Finish alone validates and
// teaches the wrong thing: a course with no aid station in it is not a course
// anybody is crewing.
console.log('\nthe table a new race opens with');
ok('start, one aid, finish', await rows(), [['Start','0'],['Aid station 1',''],['Finish','']]);

// A fourth row makes a list worth reordering.
await page.click('#add-aid');
const fill = async (i, name, mi) => {
  await page.fill(`[data-aid="${i}"][data-k="name"]`, name);
  if (i > 0) await page.fill(`[data-aid="${i}"][data-k="mileage"]`, String(mi));
};
await fill(0,'Start',0); await fill(1,'Finish',26); await fill(2,'Bravo',12); await fill(3,'Alpha',5);

console.log('\nfour stations, typed in the wrong order');
ok('as typed', await rows(), [['Start','0'],['Finish','26'],['Bravo','12'],['Alpha','5']]);

console.log('\nthe start is not one of the movable rows');
ok('it has no up or down', await page.locator('[data-aid-move="0"]').count(), 0);
ok('and nothing can move above it', await page.locator('[data-aid-move="1"][data-dir="-1"]').isDisabled(), true);
ok('nor past the end', await page.locator('[data-aid-move="3"][data-dir="1"]').isDisabled(), true);

console.log('\nmoving Alpha up carries its mileage with it');
await page.click('[data-aid-move="3"][data-dir="-1"]');
ok('one place', await rows(), [['Start','0'],['Finish','26'],['Alpha','5'],['Bravo','12']]);

console.log('\nand the button it was pressed on is still under the finger');
ok('focus followed the row',
  await page.evaluate(() => document.activeElement &&
    document.activeElement.dataset.aidMove + '/' + document.activeElement.dataset.dir), '2/-1');
await page.keyboard.press('Enter');
await page.waitForTimeout(200);
ok('so pressing again moves it again', await rows(),
   [['Start','0'],['Alpha','5'],['Finish','26'],['Bravo','12']]);

// Delete used to be "any row after the first two", which with nothing able to
// move was the same as "any row but the start, while two remain". It is that
// now, or moving a row down one place would be how you got to delete it.
console.log('\nand every row but the start can still be deleted');
ok('which rows offer it',
   await page.evaluate(() => [...document.querySelectorAll('#aid-rows [data-del-aid]')].map(e => e.dataset.delAid)),
   ['1','2','3']);

ok('nothing threw', errs, []);
await b.close();
console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
