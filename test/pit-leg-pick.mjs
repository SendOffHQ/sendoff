// The crew page's leg dropdown, over the intake fields. Reported 2026-10-18:
// it kept going away. Every poll rebuilt the racer's card, five seconds apart
// during a race, and the rebuild swapped the dropdown for a new one, shutting
// the list somebody had open; and a reload forgot which leg they had picked.
//
//   node test/pit-leg-pick.mjs
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
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
page.on('pageerror', e => errs.push(e.message));
await page.goto(BASE + '/index.html');
await page.evaluate(base => {
  localStorage.setItem('race-hub-session-v1', JSON.stringify({ session: 'stub', proxyUrl: base + '/api',
    email: 'crew@example.com', role: 'owner', expiresAt: Date.now() + 7 * 24 * 3600e3 }));
  localStorage.setItem('race-hub-tutorial-v1', JSON.stringify({ racer: 99, pit: 99, race: 99, settings: 99 }));
}, BASE);
const api = (path, body) => page.evaluate(async ([path, body]) => {
  if (!body) {
    const r = await (await fetch(`/api/get?path=${path}`, { headers: { Authorization: 'Bearer stub' } })).json();
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(r.content), c => c.charCodeAt(0))));
  }
  await fetch('/api/commit', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer stub' },
    body: JSON.stringify({ path, content: JSON.stringify(body), message: 'test' }) });
}, [path, body]);
const CFG = `races/${SLUG}/config.json`, DATA = `races/${SLUG}/data.json`;
const t = (h) => new Date(Date.now() - h * 3600e3).toISOString();

// A race under way, so the page polls at race pace: two legs done, the third out.
const cfg = await api(CFG); delete cfg.myRole;
cfg.startTime = t(3);
await api(CFG, cfg);
const id = cfg.runners[0].id;
const legs = [{ index: 1, startTime: t(3), endTime: t(2) }, { index: 2, startTime: t(2), endTime: t(1) }, { index: 3, startTime: t(1) }];
await api(DATA, { runners: [{ id, legs }] });

await page.goto(BASE + `/pit.html?id=${SLUG}`);
await page.waitForSelector('select[data-intake-leg]', { timeout: 20000 });
const options = () => page.$$eval('select[data-intake-leg] option', os => os.map(o => o.value));

console.log('\nchoosing a leg while the race moves on');
await page.$eval('select[data-intake-leg]', s => { s.dataset.mark = 'the one they opened'; });
await page.focus('select[data-intake-leg]');
// The racer comes in and goes back out while the list is open.
await api(DATA, { runners: [{ id, legs: [...legs.slice(0, 2), { ...legs[2], endTime: t(0.1) }, { index: 4, startTime: t(0.05) }] }] });
await page.waitForTimeout(7000);
ok('the dropdown they opened is still there after a poll', await page.$eval('select[data-intake-leg]', s => s.dataset.mark || null), 'the one they opened');
await page.evaluate(() => document.activeElement.blur());
await page.waitForFunction(() => !document.querySelector('select[data-intake-leg]').dataset.mark, null, { timeout: 10000 });
ok('closed, the board catches up at once', (await options()).includes('4'), true);

console.log('\na leg chosen, then the page reloaded');
await page.selectOption('select[data-intake-leg]', '1');
await page.waitForFunction(() => document.querySelector('select[data-intake-leg]').value === '1', null, { timeout: 5000 });
await page.reload();
await page.waitForSelector('select[data-intake-leg]', { timeout: 20000 });
ok('it comes back on the leg they chose', await page.inputValue('select[data-intake-leg]'), '1');

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
