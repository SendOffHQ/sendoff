// The setup wizard, for a race of two loops each with its own stations and
// course file: a 15-mile out-and-back six times, then a 10-mile one with a
// checkpoint at its turnaround, once.
//
//   node test/setup-loops.mjs
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
const errs = [];
const ctx = await b.newContext({ viewport: { width: 390, height: 900 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
page.on('pageerror', e => errs.push(e.message));
await page.goto(BASE + '/index.html');
await page.evaluate(base => {
  localStorage.setItem('race-hub-session-v1', JSON.stringify({ session: 'stub', proxyUrl: base + '/api',
    email: 'crew@example.com', role: 'owner', expiresAt: Date.now() + 7 * 864e5 }));
}, BASE);

const gpx = (dLat, dLon, n, climb) => '<?xml version="1.0"?><gpx><trk><trkseg>' +
  Array.from({ length: n }, (_, i) => { const f = i < n / 2 ? i / (n / 2) : (n - i) / (n / 2);
    return `<trkpt lat="${(39 + dLat * f).toFixed(5)}" lon="${(-105 + dLon * f).toFixed(5)}"><ele>${(2000 + climb * f).toFixed(1)}</ele></trkpt>`; }).join('') +
  '</trkseg></trk></gpx>';
const A = gpx(0.108, 0, 60, 300), B = gpx(0, 0.093, 40, 200);

const written = {};
await page.route('**/api/commit', async (route) => {
  const j = JSON.parse(route.request().postData() || '{}');
  if (/^races\/0/.test(j.path || '')) written[j.path.split('/').pop()] = j.content;
  await route.continue();
});
await page.route('**/api/next-race-id', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"id":"000903"}' }));
await page.goto(BASE + '/setup.html');
await page.waitForSelector('#race-tz option', { state: 'attached', timeout: 15000 });
await page.fill('#race-name', 'Two Loop Hundred');
await page.fill('#race-date', '2026-11-07'); await page.dispatchEvent('#race-date', 'change');
await page.selectOption('#race-hour', '6'); await page.selectOption('#race-minute', '0'); await page.selectOption('#race-ampm', 'AM');
await page.click('#course-type input[value="loops"] + .radio-content');
await page.fill('#loop-count', '7');

console.log('\none loop to start with');
ok('no stations or file in the card: those are the table and the course section', [await page.isVisible('[data-add-st="0"]'), await page.isVisible('#gpx-file')], [false, true]);
await page.fill('[data-loop="0"][data-k="distance"]', '15');
await page.setInputFiles('#gpx-file', { name: 'long.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(A) });

console.log('\nadding a second loop');
await page.click('#add-loop');
ok('each card takes stations and a file now, and the race-wide file is put away',
  [await page.isVisible('[data-add-st="1"]'), await page.isVisible('[data-loop-gpx="1"]'), await page.isVisible('#gpx-file'), await page.isVisible('#gpx-per-loop')], [true, true, false, true]);
ok('the file already picked is Loop A\'s', (await page.textContent('[data-loop-gpx="0"] + .hint')).trim(), 'The course file picked for the race.');
console.log('\nswitching to segments and back');
await page.click('#course-type input[value="segments"] + .radio-content');
ok('segments take the race\'s own course file again', [await page.isVisible('#gpx-file'), await page.isVisible('#gpx-per-loop')], [true, false]);
await page.click('#course-type input[value="loops"] + .radio-content');
ok('and back on loops, each loop takes its own', [await page.isVisible('#gpx-file'), await page.isVisible('[data-loop-gpx="1"]')], [false, true]);
await page.fill('[data-loop="0"][data-k="times"]', '6');
await page.fill('[data-loop="1"][data-k="name"]', 'Short');
await page.click('[data-add-st="1"]');
await page.fill('[data-loop="1"][data-st="1"][data-k="name"]', 'Turnaround');
await page.fill('[data-loop="1"][data-st="1"][data-k="mileage"]', '5');
await page.check('[data-loop="1"][data-st="1"][data-k="checkpoint"]');
await page.fill('[data-loop="1"][data-st="2"][data-k="mileage"]', '10');
await page.setInputFiles('[data-loop-gpx="1"]', { name: 'short.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(B) });
ok('its file is read and described', /^short\.gpx · /.test((await page.textContent('[data-loop-gpx="1"] + .hint')).trim()), true);
ok('the summary has the pattern', /Loop A<\/strong> ×6, then <strong>Short<\/strong> ×1, repeating · <strong>100\.0 mi/.test(await page.innerHTML('#loops-summary')), true);
ok('nothing wider than the phone', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
if (process.argv[2]) await page.locator('#loops-fields').screenshot({ path: process.argv[2] + '/setup-loops.png' });

await page.fill('[data-runner="0"][data-k="name"]', 'Sam');
await page.click('#btn-submit');
for (let i = 0; i < 80 && !(written['config.json'] && written['course-b.gpx']); i++) await page.waitForTimeout(150);
const cfg = written['config.json'] ? JSON.parse(written['config.json']) : null;
console.log('\nwhat it wrote');
ok('the loops, in order, each with its course file', cfg && cfg.course.loops.map(l => [l.id, l.name, l.times, l.distanceMi, l.gpx]),
  [['a', 'Loop A', 6, 15, 'course.gpx'], ['b', 'Short', 1, 10, 'course-b.gpx']]);
ok('Short\'s turnaround a checkpoint, then the pit', cfg && cfg.course.loops[1].segments.map(s => [s.toAid, s.distanceMi, !!s.checkpoint]),
  [['Turnaround', 5, true], ['Pit', 5, false]]);
ok('Loop A\'s climb taken from its file', cfg && Math.round(cfg.course.loops[0].elevationGainFt), Math.round(300 * 3.28084));
ok('Short\'s climb on its legs, from its file', cfg && cfg.course.loops[1].segments.every(s => s.elevationGainFt != null), true);
ok('both files uploaded under their own names', [written['course.gpx'] === A, written['course-b.gpx'] === B], [true, true]);
ok('and no loop stations stored the one-loop way', cfg && 'loopSegments' in cfg.course, false);

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
