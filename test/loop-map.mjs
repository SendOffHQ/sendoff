// A course of two loops, each with a course file of its own: both are drawn on
// the map, the one a racer is on is lit, the racer's dot is on that loop, and
// a chip per loop picks which profile is shown.
//
//   node test/loop-map.mjs
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
const ctx = await b.newContext({ viewport: { width: 390, height: 900 }, serviceWorkers: 'block' });
// Map tiles are not this test's business, and offline they are slow errors.
await ctx.route(/arcgisonline/, r => r.fulfill({ status: 204, body: '' }));
const page = await ctx.newPage();
page.on('pageerror', e => errs.push(e.message));
await page.goto(BASE + '/index.html');
await page.evaluate(base => {
  localStorage.setItem('race-hub-session-v1', JSON.stringify({ session: 'stub', proxyUrl: base + '/api',
    email: 'crew@example.com', role: 'owner', expiresAt: Date.now() + 7 * 864e5 }));
  localStorage.setItem('race-hub-tutorial-v1', JSON.stringify({ racer: 99, pit: 99, race: 99 }));
}, BASE);
const api = (path, body, raw) => page.evaluate(async ([path, body, raw]) => {
  if (body == null) {
    const r = await (await fetch(`/api/get?path=${path}`, { headers: { Authorization: 'Bearer stub' } })).json();
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(r.content), c => c.charCodeAt(0))));
  }
  await fetch('/api/commit', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer stub' },
    body: JSON.stringify({ path, content: raw ? body : JSON.stringify(body), message: 'test' }) });
}, [path, body, raw]);

// Two out-and-backs from one pit: Loop A north, Loop B east, with a climb.
const gpx = (dLat, dLon, n) => '<?xml version="1.0"?><gpx><trk><trkseg>' +
  Array.from({ length: n }, (_, i) => { const f = i < n / 2 ? i / (n / 2) : (n - i) / (n / 2);
    return `<trkpt lat="${(39 + dLat * f).toFixed(5)}" lon="${(-105 + dLon * f).toFixed(5)}"><ele>${(2000 + 300 * f).toFixed(1)}</ele></trkpt>`; }).join('') +
  '</trkseg></trk></gpx>';
await api(`races/${SLUG}/course.gpx`, gpx(0.108, 0, 60), true);
await api(`races/${SLUG}/course-b.gpx`, gpx(0, 0.093, 40), true);
const cfg = await api(`races/${SLUG}/config.json`);
delete cfg.myRole; delete cfg.format;
const now = Date.now(), H = 3600e3;
Object.assign(cfg, { courseType: 'loops', startTime: new Date(now - 30 * H).toISOString(), cutoffs: { totalHours: 48 },
  course: { loopCount: 14, loopDistanceMi: 15, loops: [
    { id: 'a', name: 'Loop A', distanceMi: 15, times: 6, gpx: 'course.gpx' },
    { id: 'b', name: 'Loop B', distanceMi: 10, times: 1, gpx: 'course-b.gpx' }] } });
await api(`races/${SLUG}/config.json`, cfg);
const rid = cfg.runners[0].id;
const laps = (n, open) => Array.from({ length: n }, (_, i) => ({ index: i + 1,
  startTime: new Date(now - (30 - i * 4.5) * H).toISOString(),
  ...(open && i === n - 1 ? {} : { endTime: new Date(now - (30 - i * 4.5 - 4.4) * H).toISOString() }) }));

const view = async () => {
  await page.goto(BASE + `/race?id=${SLUG}`);
  await page.waitForSelector('.course-loop-chip', { timeout: 20000 });
  await page.waitForTimeout(400);
  return page.evaluate(() => ({
    chips: [...document.querySelectorAll('.course-loop-chip')].map(c => c.textContent.replace(/\s+/g, ' ').trim()),
    active: [...document.querySelectorAll('.course-loop-chip.active')].map(c => +c.dataset.loop),
    shown: [...document.querySelectorAll('.course-loop-chip.shown')].map(c => +c.dataset.loop),
    lines: [...document.querySelectorAll('.course-map path.leaflet-interactive')].map(p => p.getAttribute('stroke')).filter(s => s && s !== '#fff'),
    meta: document.querySelector('.course-map-meta').textContent,
    dot: !!document.querySelector('.course-map .runner-dot'),
    profileDot: !!document.querySelector('.course-elev .runner-dot') }));
};

console.log('\nout on lap 7, the short loop');
await api(`races/${SLUG}/data.json`, { runners: [{ id: rid, legs: laps(7, true) }] });
let v = await view();
ok('a chip for each loop', v.chips, ['Loop A 15.0 mi', 'Loop B 10.0 mi']);
ok('both loops drawn, Loop B lit', [v.lines.length, v.lines.filter(c => c === '#0fb8bf').length], [2, 1]);
ok('Loop B marked as the one being run', v.active, [1]);
ok('and its profile is the one shown', [v.shown, /^Loop B/.test(v.meta)], [[1], true]);
ok('with the racer on the map and on the profile', [v.dot, v.profileDot], [true, true]);

console.log('\nin the pit after lap 6');
await api(`races/${SLUG}/data.json`, { runners: [{ id: rid, legs: laps(6, false) }] });
v = await view();
ok('the loop they go out on next is the one lit', v.active, [1]);

console.log('\npicking the other loop');
await page.click('.course-loop-chip[data-loop="0"]');
await page.waitForTimeout(300);
v = await page.evaluate(() => ({ shown: [...document.querySelectorAll('.course-loop-chip.shown')].map(c => +c.dataset.loop),
  meta: document.querySelector('.course-map-meta').textContent }));
ok('shows its profile instead', [v.shown, /^Loop A/.test(v.meta)], [[0], true]);
if (process.argv[2]) await page.locator('.course-view').first().screenshot({ path: process.argv[2] + '/loop-map.png' });
ok('nothing wider than the phone', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

console.log('\na race with one loop');
Object.assign(cfg, { course: { loopCount: 6, loopDistanceMi: 15 } });
await api(`races/${SLUG}/config.json`, cfg);
await page.goto(BASE + `/race?id=${SLUG}`);
await page.waitForSelector('.course-map path.leaflet-interactive', { state: 'attached', timeout: 20000 });
ok('draws as it always did, with no chips', await page.isVisible('.course-loops'), false);

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
