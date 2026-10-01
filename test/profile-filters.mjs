// Finding a race on a long profile: search, filters, and "show more".
//
// Twenty-four races entered by hand, over four years, on foot and on a bike,
// some finished and some not, so every control has something to narrow.
//
//   node test/profile-filters.mjs
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
  console.log(`  ${q?'ok  ':'FAIL'} ${l.padEnd(58)} ${JSON.stringify(g)}${q?'':' want '+JSON.stringify(w)}`)};

const ctx = await b.newContext({ viewport: { width: 390, height: 900 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));

await page.goto(BASE + '/profile.html');
await page.evaluate(base => localStorage.setItem('race-hub-session-v1', JSON.stringify({
  session: 'stub', proxyUrl: base + '/api', email: 'crew@example.com', role: 'owner',
  expiresAt: Date.now() + 7 * 24 * 3600e3 })), BASE);

// Race i: 2023 to 2026 in turn, a bike race every third, a DNF every fifth.
const race = (i) => ({
  name: i === 7 ? 'Leadville Trail 100' : i === 13 ? 'Western States' : `Race number ${i}`,
  location: i === 13 ? 'Olympic Valley, CA' : i === 7 ? 'Leadville, CO' : 'Somewhere',
  date: `${2023 + (i % 4)}-06-${String(1 + i).padStart(2, '0')}`,
  activity: i % 3 === 0 ? 'gravel-bike' : 'trail-run', distanceMi: 50,
  ...(i % 5 === 0 ? { dnf: true } : { officialSec: 36000 + i * 60 }) });
const seed = (from, to) => page.evaluate(async (rs) => {
  for (const result of rs) await fetch('/api/my-results/save', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer stub' }, body: JSON.stringify({ result }) });
}, Array.from({ length: to - from }, (_, k) => race(from + k)));

const cards = () => page.$$eval('#race-list article.p-card', els => els.map(e => e.querySelector('.p-race-name').textContent.trim()));
const countLine = () => page.$eval('.p-count', e => e.textContent).catch(() => null);
const totals = () => page.$eval('.p-totals', e => e.textContent.replace(/\s+/g, ' '));
const query = () => page.evaluate(() => location.search);
const load = async (q = '') => { await page.goto(BASE + '/profile.html' + q); await page.waitForSelector('#race-list', { timeout: 15000 }); };
const chip = (label) => page.click(`#race-chips .p-fchip:text-is("${label}")`);

console.log('\na short list needs no tools');
await seed(0, 3);
await load();
ok('three races, all drawn', (await cards()).length, 3);
ok('no search box', await page.isVisible('#race-q'), false);
ok('no count line', await countLine(), null);

console.log('\na long one');
await seed(3, 24);
await load();
ok('the first ten, newest first', (await cards()).length, 10);
ok('saying how many there are', await countLine(), 'Showing 10 of 24 · 24 races');
const allTotals = await totals();
await page.click('#race-more');
ok('"Show 10 more" draws ten more', (await cards()).length, 20);
ok('and the keyboard lands on the first new one',
   await page.evaluate(() => { const c = document.querySelectorAll('#race-list .p-card')[10]; return c.contains(document.activeElement); }), true);
ok('the last few say how many', await page.textContent('#race-more'), 'Show the last 4');
await page.click('#race-more');
ok('then all of them, and no button', [(await cards()).length, await page.isVisible('#race-more')], [24, false]);

console.log('\nsearching');
await page.fill('#race-q', 'leadville');
ok('finds the race by name', await cards(), ['Leadville Trail 100']);
ok('says how many match', await countLine(), '1 of 24 races match');
ok('and the typing is not interrupted', await page.evaluate(() => document.activeElement.id), 'race-q');
ok('the search is in the address', await query(), '?q=leadville');
ok('the totals still count every race', await totals(), allTotals);
await page.fill('#race-q', 'olympic valley');
ok('finds it by place, every word counted', await cards(), ['Western States']);
await page.fill('#race-q', 'trail run western');
ok('and by discipline', await cards(), ['Western States']);
await page.fill('#race-q', 'zzz');
ok('nothing matching says so', await page.textContent('#race-list .p-empty'), 'No races match.');
await page.click('#race-list [data-clear]');
ok('and one tap clears it', [(await cards()).length, await page.inputValue('#race-q'), await query()], [10, '', '']);

console.log('\nfilters');
ok('only disciplines and outcomes there are, and the years',
   await page.$$eval('#race-chips .p-fchip', els => els.map(e => e.textContent)), ['On foot', 'Bike', 'Finished', 'Did not finish']);
await chip('Bike');
ok('Bike: the eight bike races', await countLine(), '8 of 24 races match');
ok('the chip shows it is on, and keeps the keyboard',
   await page.evaluate(() => [document.activeElement.textContent, document.activeElement.getAttribute('aria-pressed')]), ['Bike', 'true']);
await chip('Did not finish');
ok('and did not finish: two', (await cards()).length, 2);
await page.selectOption('#race-year', '2023');
ok('and 2023: one', await cards(), ['Race number 0']);
ok('all three in the address', await query(), '?d=bike&o=dnf&y=2023');
await load(await query());
ok('a reload keeps them', [await cards(), await page.inputValue('#race-year'),
   await page.$$eval('#race-chips [aria-pressed="true"]', els => els.map(e => e.textContent))],
   [['Race number 0'], '2023', ['Bike', 'Did not finish']]);
await chip('Bike');
ok('tapping a chip again takes it off', await countLine(), '2 of 24 races match');
await page.click('#race-chips [data-clear]');
ok('Clear takes everything off', [await countLine(), await query()], ['Showing 10 of 24 · 24 races', '']);

console.log('\na card being edited stays');
const first = (await cards())[0];
await page.click('#race-list article.p-card [data-edit]');
await page.fill('#race-q', 'western');
ok('beside the match, while its form is open', (await cards()).sort(), [first, 'Western States'].sort());
ok('with its form still there', await page.isVisible('#race-list form[data-form]'), true);

console.log('\nan address somebody made up');
await load('?y=%22%3E%3Cimg%20src%3Dx%20onerror%3Dwindow.__x%3D1%3E&d=nope&o=__proto__');
ok('is ignored, and runs nothing', [(await cards()).length, await page.evaluate(() => window.__x)], [10, undefined]);

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
