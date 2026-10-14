// Editing a loop race's laps on the settings page: how it is scored, how many
// laps, and the loops themselves, each with its own aid stations and
// checkpoints.
//
//   node test/settings-loops.mjs
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
const page = await ctx.newPage();
page.on('pageerror', e => errs.push(e.message));
page.on('dialog', d => d.accept());
await page.goto(BASE + '/index.html');
await page.evaluate(base => {
  localStorage.setItem('race-hub-session-v1', JSON.stringify({ session: 'stub', proxyUrl: base + '/api',
    email: 'crew@example.com', role: 'owner', expiresAt: Date.now() + 7 * 864e5 }));
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
const until = async (test, n = 60) => { for (let i = 0; i < n; i++) { try { if (await test()) return true; } catch (e) {} await page.waitForTimeout(150); } return false; };

// A plain loop race to start from: 15 miles, 7 laps.
const cfg = await api(`races/${SLUG}/config.json`);
delete cfg.myRole;
Object.assign(cfg, { courseType: 'loops', course: { loopCount: 7, loopDistanceMi: 15 } });
delete cfg.format;
await api(`races/${SLUG}/config.json`, cfg);
await api(`races/${SLUG}/data.json`, { runners: [{ id: cfg.runners[0].id, legs: [] }] });

const open = async () => {
  await page.goto(BASE + `/settings?id=${SLUG}`);
  await page.waitForSelector('#loops-editor-head', { state: 'visible', timeout: 20000 });
  await page.click('#loops-editor-head');
  await page.waitForSelector('[data-l="0"][data-k="name"]');
};

console.log('\na plain loop race');
await open();
ok('shows one loop of 15, seven laps', [await page.inputValue('[data-l="0"][data-k="distance"]'), await page.inputValue('#loops-count')], ['15', '7']);
ok('and no aid stations section on the other page', await page.isVisible('#aid-editor'), false);

console.log('\nmade timed, with a second loop that has a turnaround');
await page.selectOption('#loops-format', 'timed');
ok('timed: no lap count', await page.isVisible('#loops-count'), false);
await page.click('#add-loop');
await page.fill('[data-l="0"][data-k="times"]', '6');
await page.fill('[data-l="1"][data-k="name"]', 'Short');
await page.click('[data-add-station="1"]');
await page.fill('[data-l="1"][data-s="1"][data-k="name"]', 'Turnaround');
await page.fill('[data-l="1"][data-s="1"][data-k="mileage"]', '5');
await page.check('[data-l="1"][data-s="1"][data-k="checkpoint"]');
await page.fill('[data-l="1"][data-s="2"][data-k="mileage"]', '10');
ok('the summary says the pattern', (await page.textContent('#loops-summary')).trim(), 'Loop A ×6, then Short ×1, repeating: 100.0 mi a round.');
await page.click('#loops-save');
ok('saved', await until(async () => (await api(`races/${SLUG}/config.json`)).format === 'timed'), true);
const saved = await api(`races/${SLUG}/config.json`);
ok('timed, with no lap count', [saved.format, 'loopCount' in saved.course], ['timed', false]);
ok('loop A plain, loop B with a checkpoint at 5 and the pit at 10',
  saved.course.loops.map(l => [l.name, l.times, l.distanceMi, (l.segments || []).map(s => [s.toAid, s.distanceMi, !!s.checkpoint])]),
  [['Loop A', 6, 15, []], ['Short', 1, 10, [['Turnaround', 5, true], ['Pit', 5, false]]]]);

console.log('\nreopened');
await open();
ok('it reads back as it was saved', [await page.inputValue('#loops-format'), await page.inputValue('[data-l="1"][data-s="1"][data-k="name"]'),
  await page.isChecked('[data-l="1"][data-s="1"][data-k="checkpoint"]'), await page.inputValue('[data-l="1"][data-k="distance"]')],
  ['timed', 'Turnaround', true, '10']);
await page.click('#race-editor-head');
ok('and the finish cutoff is when the race ends', (await page.textContent('#race-cutoff-lbl')).trim(), 'Race ends');
ok('nothing wider than the phone', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
if (process.argv[2]) await page.locator('#loops-editor').screenshot({ path: process.argv[2] + '/settings-loops.png' });

console.log('\na course file for each loop');
const gpx = (dLat, dLon, n, climb) => '<?xml version="1.0"?><gpx><trk><trkseg>' +
  Array.from({ length: n }, (_, i) => { const f = i < n / 2 ? i / (n / 2) : (n - i) / (n / 2);
    return `<trkpt lat="${(39 + dLat * f).toFixed(5)}" lon="${(-105 + dLon * f).toFixed(5)}"><ele>${(2000 + climb * f).toFixed(1)}</ele></trkpt>`; }).join('') +
  '</trkseg></trk></gpx>';
ok('with several loops the race-wide course section steps aside', await page.isVisible('#course-editor'), false);
ok('and while the race is under way, a loop\'s file is locked like the course', await page.isDisabled('[data-lgpx="1"]'), true);
// Before the start, as a course is only changed then.
const pastStart = (await api(`races/${SLUG}/config.json`)).startTime;
const setStart = async (iso) => { const c = await api(`races/${SLUG}/config.json`); delete c.myRole; c.startTime = iso; await api(`races/${SLUG}/config.json`, c); };
await setStart(new Date(Date.now() + 3 * 864e5).toISOString());
await open();
ok('and each loop card takes a file', [await page.isVisible('[data-lgpx="0"]'), await page.isVisible('[data-lgpx="1"]')], [true, true]);
await page.setInputFiles('[data-lgpx="1"]', { name: 'short.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(gpx(0, 0.093, 40, 200)) });
// The file is read in the background, so wait for the card to say so.
await page.waitForFunction(() => /short\.gpx/.test(document.querySelector('[data-lgpx="1"]').closest('.loop-file').textContent), null, { timeout: 5000 }).catch(() => {});
ok('the file is read and described', /short\.gpx · .*Saved with the loops/.test(await page.evaluate(() => document.querySelector('[data-lgpx="1"]').closest('.loop-file').textContent.replace(/\s+/g, ' '))), true);
await page.click('#loops-save');
ok('saved under the loop\'s own name', await until(async () => {
  const c = await api(`races/${SLUG}/config.json`);
  return c.course.loops && c.course.loops[1].gpx === 'course-b.gpx';
}), true);
const withFiles = await api(`races/${SLUG}/config.json`);
ok('each loop has an id, and Loop A the race\'s own file', withFiles.course.loops.map(l => [l.id, l.gpx || null]), [['a', 'course.gpx'], ['b', 'course-b.gpx']]);
ok('and the file is stored', await page.evaluate(async (slug) => (await fetch(`/api/get?path=races/${slug}/course-b.gpx`, { headers: { Authorization: 'Bearer stub' } })).status, SLUG), 200);
ok('the turnaround\'s legs took their climb from it', withFiles.course.loops[1].segments.every(s => s.elevationGainFt != null), true);
await setStart(pastStart);

console.log('\non the race page');
await page.goto(BASE + `/race?id=${SLUG}`);
await page.waitForSelector('.seg-row', { state: 'attached', timeout: 20000 });
ok('a course with stations on a loop is drawn as legs', await page.$$eval('.leg-cell', x => x.length), 0);
ok('and a runner who never started is not finished, even after the end', (await page.textContent('.status-badge')).trim(), 'Not Started');

console.log('\nback to a set number of laps');
await open();
await page.selectOption('#loops-format', 'distance');
await page.fill('#loops-count', '14');
await page.click('#loops-save');
ok('saved with a count again', await until(async () => { const c = await api(`races/${SLUG}/config.json`); return !c.format && c.course.loopCount === 14; }), true);
ok('and the hub lists 200 miles', await until(async () => {
  const idx = await api('races/index.json');
  const e = (idx.races || []).find(r => r.slug === SLUG);
  return !e || e.totalDistanceMi === 200;
}), true);

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
