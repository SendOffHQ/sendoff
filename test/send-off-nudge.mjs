// The send-off reminder (2026-10-27): turned on from the racer screen, it
// registers this phone with the worker, which pushes a notification if the
// racer checks in at a station and is still not sent off well past their
// usual stop. The browser's push service is stood in for here; the worker's
// side is tested in worker/test/push-nudge.mjs.
//
//   node test/send-off-nudge.mjs
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

// A phone whose push service answers, and whose owner says yes or no.
const stubPush = (answer) => {
  let perm = 'default', sub = null;
  Object.defineProperty(Notification, 'permission', { get: () => perm });
  Notification.requestPermission = async () => (perm = answer);
  const pushManager = {
    getSubscription: async () => sub,
    subscribe: async () => (sub = { endpoint: 'https://push.example/abc', unsubscribe: async () => { sub = null; return true; } })
  };
  Object.defineProperty(navigator.serviceWorker, 'ready', { get: () => Promise.resolve({ pushManager }) });
};

const session = async (page) => {
  await page.goto(BASE + '/index.html');
  await page.evaluate(base => {
    localStorage.setItem('race-hub-session-v1', JSON.stringify({ session: 'stub', proxyUrl: base + '/api',
      email: 'crew@example.com', role: 'owner', expiresAt: Date.now() + 7 * 24 * 3600e3 }));
    localStorage.setItem('race-hub-tutorial-v1', JSON.stringify({ racer: 99, pit: 99, race: 99, settings: 99 }));
  }, BASE);
};
const open = async (answer) => {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(stubPush, answer);
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push(e.message));
  await session(page);
  await page.goto(BASE + `/racer.html?id=${SLUG}&runner=jason`);
  await page.waitForSelector('#nudge-toggle', { timeout: 20000 });
  return page;
};
const log = (page) => page.evaluate(async () => (await fetch('/api/push-log')).json());

console.log('\nturning it on');
let page = await open('granted');
ok('offered, off to begin with', [await page.textContent('#nudge-toggle'), await page.getAttribute('#nudge-toggle', 'aria-pressed')],
  ['Remind me if I forget to send off', 'false']);
await page.click('#nudge-toggle');
await page.waitForSelector('#nudge-toggle.on', { timeout: 5000 });
ok('says it is on', (await page.textContent('#nudge-toggle')).trim(), 'Send-off reminder: on');
let l = await log(page);
const s = l.find(x => x.path === 'subscribe') || {};
ok('registers this phone for this racer', [s.slug, s.runnerId, s.endpoint], [SLUG, 'jason', 'https://push.example/abc']);
ok('with the course, so the words name the station', [s.legs > 0, Array.isArray(s.stations) && s.stations.length === s.legs, (s.stations || []).at(-1)],
  [true, true, 'the finish']);
ok('fits a phone', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

console.log('\nand off again');
await page.click('#nudge-toggle');
await page.waitForSelector('#nudge-toggle:not(.on)', { timeout: 5000 });
l = await log(page);
ok('tells the worker to forget it', l.filter(x => x.path === 'unsubscribe').map(x => x.endpoint), ['https://push.example/abc']);
await page.context().close();

console.log('\nwhen the phone says no');
page = await open('denied');
await page.click('#nudge-toggle');
await page.waitForFunction(() => /blocked/.test(document.getElementById('nudge').textContent), null, { timeout: 5000 });
ok('stays off and says why', [await page.getAttribute('#nudge-toggle', 'aria-pressed'), (await log(page)).filter(x => x.path === 'subscribe').length], ['false', 1]);
await page.context().close();

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
