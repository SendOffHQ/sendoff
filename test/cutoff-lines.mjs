// Every cutoff on the cumulative progress chart as a vertical line
// (2026-11-02): each aid station's, the last leg's start and the finish, on
// the race clock, labelled up the line. The fixture's course has station
// cutoffs at 18.5, 26.5, 28.75 and 34 hours and the finish at 38.
//
//   node test/cutoff-lines.mjs
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
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
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
const CFG = `races/${SLUG}/config.json`;
const lines = () => page.evaluate(() => {
  const svg = document.getElementById('chart-cum');
  const v = [...svg.querySelectorAll('line.cutoff')].filter(l => l.getAttribute('x1') === l.getAttribute('x2'));
  return { count: v.length, labels: [...svg.querySelectorAll('text.cutoff-label[transform]')].map(t => t.textContent),
    finish: [...svg.querySelectorAll('text.cutoff-label:not([transform])')].map(t => t.textContent) };
});

console.log('\nthe charts page');
await page.goto(BASE + `/charts.html?id=${SLUG}`);
await page.waitForSelector('#chart-cum line.cutoff', { timeout: 20000, state: 'attached' });
let got = await lines();
ok('a vertical line for each cutoff, the finish once', got.count, 5);
ok('labelled with the station', got.labels, ['Music Meadows 2', 'Venable 2', 'Horn Creek 4', 'Music Meadows 3', 'Finish']);
ok('and the line across the top says finish, not cutoff', got.finish, ['finish']);

console.log('\na last leg start');
const cfg = await api(CFG); delete cfg.myRole;
cfg.cutoffs = { totalHours: 38, lastLegStartHours: 36 };
await api(CFG, cfg);
await page.reload();
await page.waitForSelector('#chart-cum line.cutoff', { timeout: 20000, state: 'attached' });
got = await lines();
ok('gets a line too', got.labels.includes('Last leg start'), true);

console.log('\nthe printed report');
await page.goto(BASE + `/print-report.html?id=${SLUG}`);
await page.waitForSelector('#chart-cum line.cutoff', { timeout: 20000, state: 'attached' });
ok('has them as well', (await lines()).count, 6);

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
