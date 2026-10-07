// The race page's Projected tile: the finish as a time of day on the race's
// own clock, the way the cutoffs are shown, with by how much it beats or
// misses the final cutoff small underneath.
//
//   node test/projected.mjs
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
// Watched from Chicago, of a race in Denver: the tile is on Denver's clock.
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', timezoneId: 'America/Chicago' });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(BASE + '/index.html');
await page.evaluate(base => {
  localStorage.setItem('race-hub-session-v1', JSON.stringify({ session: 'stub', proxyUrl: base + '/api',
    email: 'crew@example.com', role: 'owner', expiresAt: Date.now() + 7 * 24 * 3600e3 }));
  localStorage.setItem('race-hub-tutorial-v1', JSON.stringify({ racer: 99, pit: 99, race: 99 }));
}, BASE);
const api = (path, body) => page.evaluate(async ([path, body]) => {
  if (!body) {
    const r = await (await fetch(`/api/get?path=${path}`, { headers: { Authorization: 'Bearer stub' } })).json();
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(r.content), c => c.charCodeAt(0))));
  }
  await fetch('/api/commit', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer stub' },
    body: JSON.stringify({ path, content: JSON.stringify(body), message: 'test' }) });
}, [path, body]);
const cfg = await api(`races/${SLUG}/config.json`);
cfg.timezone = 'America/Denver';
await api(`races/${SLUG}/config.json`, cfg);

const tile = async (legs) => {
  await api(`races/${SLUG}/data.json`, { runners: [{ id: 'jason', legs }] });
  await page.goto(BASE + `/race.html?id=${SLUG}`);
  await page.waitForSelector('.stat-projected', { timeout: 20000 });
  return page.evaluate(() => {
    const t = document.querySelector('.stat-projected');
    const q = (s) => { const e = t.querySelector(s); return e ? e.textContent.trim() : null; };
    return { value: q('.value'), at: q('.proj-at'), margin: q('.proj-margin'),
      over: !!t.querySelector('.proj-margin.over'), size: [getComputedStyle(t.querySelector('.proj-at')).fontSize,
        t.querySelector('.proj-margin') && getComputedStyle(t.querySelector('.proj-margin')).fontSize],
      fits: document.documentElement.scrollWidth <= innerWidth };
  });
};
const start = Date.parse(cfg.startTime);
const iso = (h) => new Date(start + h * 3600e3).toISOString();

console.log('\non pace for the cutoff');
let legs = [{ index: 1, startTime: iso(0), endTime: iso(1) }, { index: 2, startTime: iso(1.05), endTime: iso(2) }, { index: 3, startTime: iso(2.05) }];
let t = await tile(legs);
const want = await page.evaluate(([legs, cfg]) => {
  const c = Race.compute.runner({ id: 'jason', legs }, cfg);
  const at = Date.parse(legs[0].startTime) + c.projectedFinishSec * 1000;
  const m = Math.round((cfg.cutoffs.totalHours * 3600 - c.projectedFinishSec) / 60);
  return { at, value: Race.fmt.duration(c.projectedFinishSec), m };
}, [legs, cfg]);
const denver = await page.evaluate((at) => {
  const f = (o) => new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: 'America/Denver' }, o)).format(at);
  return `${f({ weekday: 'short', hour: 'numeric', minute: '2-digit' })} ${f({ timeZoneName: 'short' }).split(' ').pop()}`;
}, want.at);
ok('the projected time, as before', t.value, want.value);
ok('the finish as a time of day on the race\'s clock and zone', t.at, denver);
ok('and by how much it beats the cutoff, small, underneath',
  [t.margin, t.over, parseFloat(t.size[1]) < parseFloat(t.size[0])],
  [want.m < 60 ? `${want.m}m under cutoff` : `${Math.floor(want.m / 60)}h ${String(want.m % 60).padStart(2, '0')}m under cutoff`, false, true]);
ok('and it fits a phone', t.fits, true);

console.log('\nbehind it');
legs = [{ index: 1, startTime: iso(0), endTime: iso(12) }, { index: 2, startTime: iso(12.1) }];
t = await tile(legs);
ok('says how far over, in red', [/^\d+h \d\dm over cutoff$/.test(t.margin), t.over], [true, true]);

console.log('\nnot started');
t = await tile([]);
ok('no time and no margin', [t.value, t.at, t.margin], ['–', '–', null]);

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
