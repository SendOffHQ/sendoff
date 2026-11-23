// The hub's race type and discipline filters (2026-11-23). This checks that:
//   - each lists only what the races on the hub have, in the cards' words,
//     and is drawn even when every race is the same kind;
//   - picking one narrows the cards, together with the search;
//   - nothing matching says what is narrowing it;
//   - and the choice is kept for the next visit.
//
//   node test/hub-filters.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net'; import fs from 'node:fs';
const BASE = 'http://localhost:8787';
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
await page.addInitScript(() => { try { localStorage.setItem('race-hub-intro-v1', '1'); } catch (e) {} });

const d = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const MIXED = [
  { slug: 'a', name: 'Canyon Rim 100', startTime: d(-500), courseType: 'segments', activity: 'trail-run', visibility: 'public' },
  { slug: 'b', name: 'Lakeside Backyard', startTime: d(-400), courseType: 'loops', format: 'backyard', activity: 'trail-run', visibility: 'public' },
  { slug: 'c', name: 'Gravel Grinder', startTime: d(-300), courseType: 'segments', activity: 'gravel-bike', visibility: 'public' },
  { slug: 'e', name: 'Track 24', startTime: d(-200), courseType: 'loops', format: 'timed', activity: 'road-run', visibility: 'public' },
  { slug: 'f', name: 'Old Loop Fifty', startTime: d(-100), courseType: 'loops', visibility: 'public' }
];
let races = MIXED;
await page.route('**/races/index.json*', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ races }) }));
const open = async () => { await page.goto(BASE + '/app/'); await page.waitForSelector('#cards', { timeout: 20000 }); await page.waitForTimeout(600); };
const opts = (id) => page.$$eval(`#${id} option`, o => o.map(x => x.textContent));
const shown = (id) => page.evaluate(id => { const l = document.getElementById(id).closest('label'); return !l.hidden && l.getBoundingClientRect().height > 0; }, id);
const names = () => page.$$eval('#cards .card-name', e => e.map(x => x.textContent.trim()).sort());

await open();
console.log('\nwhat they offer');
ok('race type, in the cards\' words, only those present', await opts('race-type'), ['All', 'Segments', 'Loops', 'Timed', 'Backyard']);
// Old Loop Fifty has no activity: a race from before there were any, on foot.
ok('discipline by activity group, only those present', await opts('race-disc'), ['All', 'On foot', 'Bike']);
ok('both drawn', [await shown('race-type'), await shown('race-disc')], [true, true]);
ok('every race to begin with', (await names()).length, 5);

console.log('\npicking');
await page.selectOption('#race-type', 'loops');
ok('a race type narrows the cards', await names(), ['Old Loop Fifty']);
await page.selectOption('#race-type', '');
await page.selectOption('#race-disc', 'bike');
ok('so does a discipline', await names(), ['Gravel Grinder']);
await page.selectOption('#race-disc', 'foot');
await page.selectOption('#race-type', 'backyard');
ok('and both together', await names(), ['Lakeside Backyard']);
await page.fill('#race-search', 'canyon');
ok('with the search too: nothing, and it says why',
  (await page.textContent('#cards .no-matches')).trim(), 'No races match “canyon”, Backyard, On foot.');
await page.fill('#race-search', '');

console.log('\nnext visit');
await open();
ok('the choice is kept', [await page.inputValue('#race-type'), await page.inputValue('#race-disc'), (await names())], ['backyard', 'foot', ['Lakeside Backyard']]);

console.log('\na hub where every race is the same');
races = MIXED.filter(r => r.slug === 'a' || r.slug === 'c').map(r => ({ ...r, activity: 'trail-run' }));
await open();
ok('both are still drawn, offering the one kind there is',
  [await shown('race-type'), await shown('race-disc'), await opts('race-disc')], [true, true, ['All', 'On foot']]);
ok('and a kept choice the races no longer have does not hide everything',
  [await page.inputValue('#race-type'), (await names()).length], ['', 2]);

ok('no page errors', errs, []);
await b.close();
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
