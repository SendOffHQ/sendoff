// The race clock on the racer page, as it is first drawn.
//
// Reported after the Sangre de Cristo 100: once the race was over, the racer
// page showed the time since the start rather than the finish time, for about
// a second. Two copies of the clock: the per-second tick had been taught that a
// finished race has stopped, and the draw had not, so every load and every
// poll put up the finish time plus the days since, and the tick corrected it a
// second later.
//
// A second is exactly long enough to be seen and too short to be caught by
// looking at the page afterwards, so the ticker is switched off here and what
// is checked is the frame the draw produced on its own.
//
//   node test/racer-clock.mjs
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

const HOUR = 3600e3;
// Legs of exactly an hour, back to back, so the race time is a whole number
// of hours and the pits add nothing: whatever the page shows past that is time
// it should not have counted.
const legs = (startMs, done, runningSinceMs) => {
  const out = [];
  for (let i = 0; i < done; i++) {
    out.push({ index: i + 1,
      startTime: new Date(startMs + i * HOUR).toISOString(),
      endTime: new Date(startMs + (i + 1) * HOUR).toISOString() });
  }
  if (runningSinceMs) out.push({ index: done + 1, startTime: new Date(runningSinceMs).toISOString(), endTime: null });
  return out;
};
const secs = t => t.split(':').map(Number).reduce((a, n) => a * 60 + n, 0);

// Two pages: one as a racer would see it, and one with setInterval switched off
// so the per-second tick never runs and the draw is all there is.
const ctx = await b.newContext({ viewport: { width: 420, height: 900 }, serviceWorkers: 'block' });
const setup = await ctx.newPage();
const errs = [];
await setup.goto(BASE + '/index.html');
await setup.evaluate(base => localStorage.setItem('race-hub-session-v1', JSON.stringify({
  session:'stub', proxyUrl: base + '/api', email:'crew@example.com', role:'owner',
  expiresAt: Date.now() + 7*24*3600e3 })), BASE);
const setLegs = (l) => setup.evaluate(async ([slug, l]) => {
  const r = await fetch('/api/commit', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer stub' },
    body: JSON.stringify({ path: `races/${slug}/data.json`,
      content: JSON.stringify({ runners: [{ id: 'jason', legs: l }] }, null, 2) + '\n',
      message: 'test' }) });
  if (!r.ok) throw new Error('setLegs ' + r.status);
}, [SLUG, l]);

const clockAt = async (ticking) => {
  const p = await ctx.newPage();
  p.on('pageerror', e => errs.push(e.message));
  if (!ticking) await p.addInitScript(() => { window.setInterval = () => 0; });
  await p.goto(BASE + `/racer.html?id=${SLUG}`);
  await p.waitForSelector('#rclock', { timeout: 20000 });
  await p.waitForTimeout(ticking ? 2500 : 300);
  const t = await p.evaluate(() => document.getElementById('rclock').textContent.trim());
  await p.close();
  return t;
};

console.log('\na race that finished five days ago, sixteen hours after it started');
await setLegs(legs(Date.now() - 5 * 24 * HOUR, 16));
ok('the first frame is the finish time', await clockAt(false), '16:00:00');
ok('and so is every one after it', await clockAt(true), '16:00:00');

// The other half of the same function, so the fix cannot have been bought by
// stopping the clock altogether: a racer out on a leg is still being timed.
console.log('\nand one still going: three legs done, the fourth ten minutes in');
// Leg four starts the moment leg three ends, so there is no pit time and the
// answer is three hours ten, give or take the page load.
const t0 = Date.now() - 3 * HOUR - 10 * 60e3;
await setLegs(legs(t0, 3, t0 + 3 * HOUR));
const drawn = secs(await clockAt(false));
ok('the first frame counts the leg in progress',
  drawn >= 3 * 3600 + 10 * 60 && drawn <= 3 * 3600 + 10 * 60 + 30, true);

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
