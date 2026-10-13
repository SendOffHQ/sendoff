// The demo race at /try: the real racer screen, pit board and race page,
// running a race that lives only in this browser (lib/demo.js).
//
//   node test/try-demo.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net'; import fs from 'node:fs';
const BASE = 'http://localhost:8787';
const NS = 'sendoff-try:';
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
const ctx = await b.newContext({ viewport: { width: 1400, height: 1000 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errs = [], worker = [];
ctx.on('page', p => p.on('pageerror', e => errs.push(e.message)));
page.on('pageerror', e => errs.push(e.message));
// The harness is the stand-in for SendOff's worker: nothing in the demo may
// reach it.
ctx.on('request', r => { if (/localhost:8787\/api\//.test(r.url())) worker.push(r.url()); });
const until = async (test, n = 60) => { for (let i = 0; i < n; i++) { try { if (await test()) return true; } catch (e) {} await page.waitForTimeout(150); } return false; };

// Somebody already signed in to the real thing on this browser, with a race
// of their own open.
await page.goto(BASE + '/index.html');
const REAL = { session: 'real-session', proxyUrl: BASE + '/api', email: 'crew@example.com', role: 'owner', expiresAt: Date.now() + 864e5 };
await page.evaluate((real) => {
  localStorage.setItem('race-hub-session-v1', JSON.stringify(real));
  localStorage.setItem('race-hub-tutorial-v1', JSON.stringify({ pit: 1 }));
}, REAL);
const realKeys = () => page.evaluate((ns) => Object.fromEntries(Object.keys(localStorage).filter(k => !k.startsWith(ns) && k !== 'so:hub')
  .sort().map(k => [k, localStorage.getItem(k)])), NS);
const before = await realKeys();
worker.length = 0;

const store = () => page.evaluate((ns) => JSON.parse(localStorage.getItem(ns + 'store') || 'null'), NS);
const legs = async () => JSON.parse((await store()).files['races/try-sendoff/data.json'].text).runners[0].legs;
const fr = (n) => page.frame({ url: new RegExp('/' + n + '\\?id=try-sendoff') });
const text = (n) => fr(n).evaluate(() => document.body.innerText);

console.log('\nopening it');
await page.goto(BASE + '/try');
await page.waitForFunction(() => [...document.querySelectorAll('iframe')].every(f => f.getAttribute('src')), null, { timeout: 15000 });
await until(async () => /arrived at colony creek 1/i.test(await fr('racer').textContent('#go')));
ok('the racer is out on the leg to Colony Creek', /arrived at colony creek 1/i.test(await fr('racer').textContent('#go')), true);
const s0 = await store();
ok('a race made for this visit, started a while ago', [!!s0, (await legs()).length,
  Math.round((s0.seededAt - Date.parse(JSON.parse(s0.files['races/try-sendoff/config.json'].text).startTime)) / 60000)], [true, 3, 170]);
ok('three phones side by side', await page.$$eval('.phone', ps => ps.filter(p => getComputedStyle(p).display !== 'none').length), 3);
await until(async () => /SendOff Demo 100/.test(await text('race')) && /Alex Rivera/.test(await text('pit')));
ok('each the real page, on the demo race', [/Alex Rivera/.test(await text('pit')), /SendOff Demo 100/.test(await text('race'))], [true, true]);

console.log('\na press on the racer\'s phone');
await fr('racer').click('#go');
const reached = await until(async () => /IN PIT/i.test(await text('pit')) && /at Colony Creek 1/i.test(await text('race')), 40);
ok('reaches the crew\'s board and the race page at once', reached, true);
ok('and is kept, with the time it was pressed', !!(await legs()).find(l => l.index === 3).endTime, true);

console.log('\nthe crew logs a gel');
await fr('pit').click('button:has-text("+ Gel")');
await fr('pit').click('button:has-text("Save intake")');
ok('it lands on the leg', await until(async () => +(await legs()).find(l => l.index === 3).calories >= 100, 40), true);

console.log('\nleaving the demo');
await fr('pit').evaluate(() => { const a = document.createElement('a'); a.href = '/settings?id=try-sendoff'; a.id = 'away'; a.textContent = 'x'; document.body.appendChild(a); });
await fr('pit').click('#away');
await page.waitForTimeout(300);
ok('a link to a page outside it says so and stays put',
  [/needs an account/.test(await fr('pit').textContent('#try-note')), /\/pit\?id=try-sendoff/.test(fr('pit').url())], [true, true]);

console.log('\nnothing real touched');
ok('no request reached SendOff\'s worker', worker, []);
ok('the real sign-in and settings on this browser are as they were', await realKeys(), before);

console.log('\nreset');
await page.click('#reset');
const reset = await until(async () => (await store()).seededAt !== s0.seededAt && (await legs()).length === 3 && !(await legs()).find(l => l.index === 3).endTime
  && /arrived at colony creek 1/i.test(await fr('racer').textContent('#go')), 60);
ok('starts the race over, and the phones with it', reset, true);
ok('the crew\'s board is back to waiting', await until(async () => /CHECK IN AT COLONY CREEK 1/i.test(await text('pit')), 40), true);

console.log('\ncome back the next day');
await page.evaluate((ns) => { const s = JSON.parse(localStorage.getItem(ns + 'store')); s.touchedAt = s.seededAt = Date.now() - 7 * 3600e3; localStorage.setItem(ns + 'store', JSON.stringify(s)); }, NS);
const old = (await store()).seededAt;
await page.reload();
await until(async () => (await store()).seededAt !== old);
ok('and it has started over by itself', Date.now() - (await store()).seededAt < 60000, true);

console.log('\nopened on its own');
const solo = await ctx.newPage();
await solo.goto(BASE + '/racer?id=try-sendoff&runner=alex');
await solo.waitForSelector('#try-pill', { timeout: 10000 });
ok('says it is the demo, with the way back', [await solo.getAttribute('#try-pill', 'href'), await solo.evaluate(() => document.body.style.paddingTop)], ['/try', '22px']);
await solo.close();

console.log('\non a phone');
await page.setViewportSize({ width: 390, height: 844 });
ok('one phone at a time, the racer\'s first', await page.$$eval('.phone', ps => ps.filter(p => getComputedStyle(p).display !== 'none').map(p => p.dataset.phone)), ['racer']);
await page.click('.tabs [data-tab="pit"]');
ok('a tab picks another', await page.$$eval('.phone', ps => ps.filter(p => getComputedStyle(p).display !== 'none').map(p => p.dataset.phone)), ['pit']);
ok('and nothing is wider than the phone', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

console.log('\nany other race');
const other = await ctx.newPage();
await other.goto(BASE + '/race?id=zz-fixture-unlisted');
await other.waitForTimeout(500);
ok('is left alone', await other.evaluate(() => [SendOffDemo.active, /native code/.test(String(window.fetch)), /native code/.test(String(Storage.prototype.getItem))]), [false, true, true]);
await other.close();

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
