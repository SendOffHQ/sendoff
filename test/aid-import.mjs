// Aid stations from a spreadsheet, in the setup wizard and on the settings
// page, and the template download.
//
// Three files: the Excel template SendOff hands out, the same as CSV, and one
// written by openpyxl the way Excel writes a sheet (test/fixtures/aid-import/
// times-km.xlsx: columns in another order and named differently, kilometres,
// and cutoffs typed as [h]:mm durations, which Excel stores as fractions of
// a day). Cutoffs land in the table as the day and time they fall on.
//
//   node test/aid-import.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net'; import fs from 'node:fs'; import path from 'node:path';
const BASE = 'http://localhost:8787';
const SLUG = 'zz-fixture-unlisted';
const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const XLSX = path.join(ROOT, 'templates/sendoff-aid-stations.xlsx');
const CSV = path.join(ROOT, 'templates/sendoff-aid-stations.csv');
const TIMES = path.join(ROOT, 'test/fixtures/aid-import/times-km.xlsx');
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

const ctx = await b.newContext({ viewport: { width: 900, height: 1100 }, serviceWorkers: 'block', acceptDownloads: true,
  timezoneId: 'America/Chicago', locale: 'en-US' });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
let dialogs = [];
page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
await page.goto(BASE + '/index.html');
await page.evaluate(base => {
  localStorage.setItem('race-hub-session-v1', JSON.stringify({ session: 'stub', proxyUrl: base + '/api',
    email: 'crew@example.com', role: 'owner', expiresAt: Date.now() + 7 * 24 * 3600e3 }));
  localStorage.setItem('race-hub-tutorial-v1', JSON.stringify({ setup: 99, settings: 99, pit: 99 }));
}, BASE);

const rows = () => page.evaluate(() => [...document.querySelectorAll('#aid-rows [data-k="name"]')].map(e => {
  const i = e.dataset.aid, f = (k) => document.querySelector(`#aid-rows [data-aid="${i}"][data-k="${k}"]`);
  // The cutoff sits on the line under the name and distance; the start has none.
  const cell = f('mileage').closest('tr').nextElementSibling.querySelector('.aid-cut');
  const day = cell && cell.querySelector('select'), time = cell && cell.querySelector('input[type="time"]');
  const hrs = cell && cell.querySelector('input[type="number"]'), wait = cell && cell.querySelector('.cut-wait');
  const cut = !cell ? '' : time ? (time.value ? `${day.selectedOptions[0].textContent} ${time.value}` : '')
    : hrs ? hrs.value : wait ? wait.textContent.trim() : '';
  return [e.value, f('mileage').value, cut];
}));
const flags = () => page.evaluate(() => [...document.querySelectorAll('#aid-rows [data-k="name"]')].map(e => {
  const i = e.dataset.aid, on = (k) => { const x = document.querySelector(`#aid-rows [data-aid="${i}"][data-k="${k}"]`); return x ? (x.checked ? 1 : 0) : '-'; };
  return `${on('crewAccess')}${on('dropBag')}${on('pacerEligible')}${on('checkpoint')}`;
}));
const note = (i) => page.inputValue(`#aid-rows [data-aid="${i}"][data-k="crewNote"]`);
const importFile = async (file) => {
  await page.setInputFiles('#aid-import .aid-import-file', file);
  await page.waitForFunction(() => !/^Reading/.test(document.querySelector('#aid-import .aid-import-msg').textContent), null, { timeout: 5000 });
  return (await page.textContent('#aid-import .aid-import-msg')).replace(/\s+/g, ' ').trim();
};
const tpl = (c) => [['Start','0',''],['Ridge Road','6.2',''],['Summit Timing','11.4',''],['Lakeside','17.9',c[0]],['Pine Hollow','24.6',c[1]],['Finish','31.1',c[2]]];
const TEMPLATE_ROWS = tpl(['Sat, Oct 3 12:30', 'Sat, Oct 3 15:00', 'Sat, Oct 3 17:00']);
const setStart = async (date, hour, ampm) => {
  await page.selectOption('#race-tz', 'America/Chicago');
  await page.fill('#race-date', date); await page.dispatchEvent('#race-date', 'change');
  await page.selectOption('#race-hour', hour); await page.selectOption('#race-ampm', ampm);
};

console.log('\nthe setup wizard');
await page.goto(BASE + '/setup.html');
await page.waitForSelector('#aid-import .aid-import-file', { state: 'attached', timeout: 15000 });
ok('offers an import and both templates', [await page.isVisible('#aid-import .aid-import-btn'),
  await page.getAttribute('#aid-import a[href$=".xlsx"]', 'href'), await page.getAttribute('#aid-import a[href$=".csv"]', 'href')],
  [true, '/templates/sendoff-aid-stations.xlsx', '/templates/sendoff-aid-stations.csv']);
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#aid-import a[href$=".xlsx"]')]);
ok('the Excel template downloads', dl.suggestedFilename(), 'sendoff-aid-stations.xlsx');
const before = await rows();
let m = await importFile(XLSX);
ok('the blank starting table is replaced without asking', dialogs.length, 0);
ok('with no start date yet, cutoffs wait as written', (await rows()).map(r => r[2]),
  ['', 'Set the start date first', 'Set the start date first', 'Sat 12:30 PM', 'Sat 3:00 PM', 'Sat 5:00 PM']);
await setStart('2026-10-03', '7', 'AM');
ok('the Excel template fills the table, cutoffs on the race\'s days', await rows(), TEMPLATE_ROWS);
ok('with each stop\'s crew, drop bag, pacer and checkpoint flags', await flags(), ['100-', '1000', '0001', '1110', '1000', '1000']);
ok('and the crew notes', [await note(0), await note(3)], ['Park in the main lot', 'Walk in 0.3 mi from the boat ramp']);
ok('and says what it did, and that nothing is saved yet', m, 'Imported 6 aid stations from sendoff-aid-stations.xlsx, 31.1 mi in all. Check them below, then carry on.');

m = await importFile(CSV);
ok('replacing a filled table asks first', dialogs.at(-1), 'Replace the 5 aid stations in the table with the 6 in sendoff-aid-stations.csv?');
ok('and the CSV template reads the same', await rows(), TEMPLATE_ROWS);

await page.selectOption('#unit-distance', 'km').catch(() => {});
await page.waitForTimeout(200);
m = await importFile(TIMES);
ok('Excel\'s own file: other headings, any order, kilometres', (await rows()).map(r => r.slice(0, 2)), [['Départ','0'],['Col du Lac','10'],['Arrivée','21.1']]);
ok('cutoffs typed as durations count from the start', (await rows()).map(r => r[2]), ['', 'Sat, Oct 3 09:30', 'Sun, Oct 4 13:00']);
ok('"N" for crew access means no', (await flags()).map(f => f[0]), ['1', '0', '1']);

m = await importFile({ name: 'clock.csv', mimeType: 'text/csv', buffer: Buffer.from(
  'Aid station,Distance (mi),Cutoff\nStart,0,\nRidge,30,9:00 PM\nValley,60,6:00 AM\nLake,80,28\nFinish,100,Sun 1pm\n') });
ok('a time with no day is the next one after the cutoff above it', (await rows()).map(r => r[2]),
  ['', 'Sat, Oct 3 21:00', 'Sun, Oct 4 06:00', 'Sun, Oct 4 11:00', 'Sun, Oct 4 13:00']);
await page.selectOption('#race-tz', 'America/Denver');
ok('a new zone keeps each cutoff at its clock time', (await rows()).map(r => r[2]),
  ['', 'Sat, Oct 3 21:00', 'Sun, Oct 4 06:00', 'Sun, Oct 4 11:00', 'Sun, Oct 4 13:00']);
await page.selectOption('#race-tz', 'America/Chicago');

console.log('\na file that is wrong');
const kept = await rows();
m = await importFile({ name: 'muddled.csv', mimeType: 'text/csv', buffer: Buffer.from(
  'Aid station;Distance (mi);Cutoff\nStart;0;\nTop;12,5;soon\nBottom;9;\nFinish;\n') });
ok('is not imported, and the table is untouched', [m.startsWith('muddled.csv was not imported. Nothing in the table changed.'), JSON.stringify(await rows()) === JSON.stringify(kept)], [true, true]);
ok('every problem is named, by row', await page.$$eval('#aid-import .aid-import-msg li', els => els.map(e => e.textContent)), [
  'Row 3 (Top): the cutoff "soon" is not a time like Sun 1:00 PM, or a number of hours.',
  'Row 5 (Finish): no distance.',
  '"Bottom" is not further along than "Top". Distances count from the start and go up row by row.']);
m = await importFile({ name: 'names.csv', mimeType: 'text/csv', buffer: Buffer.from('Stop,When\nA,1\n') });
ok('a sheet with no distance column says which heading to use', /No column for the distance. Head it "Distance \(mi\)" or "Distance \(km\)"/.test(m), true);
m = await importFile({ name: 'old.xls', mimeType: 'application/vnd.ms-excel', buffer: Buffer.from('xx') });
ok('an old .xls says how to save it', /old-style \.xls file\. In Excel, use Save As/.test(m), true);

console.log('\nthe settings page');
await page.goto(BASE + `/settings.html?id=${SLUG}`);
await page.waitForSelector('#aid-editor-head', { timeout: 20000 });
await page.click('#aid-editor-head');
await page.waitForSelector('#aid-import .aid-import-file', { state: 'attached' });
const savedBefore = await page.evaluate(async (slug) => {
  const r = await (await fetch(`/api/get?path=races/${slug}/config.json`, { headers: { Authorization: 'Bearer stub' } })).json();
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(r.content), c => c.charCodeAt(0)))).course.segments.length;
}, SLUG);
dialogs = [];
m = await importFile(XLSX);
ok('asks before replacing the race\'s stations', /^Replace the \d+ aid stations in the table with the 6 in sendoff-aid-stations\.xlsx\?$/.test(dialogs.at(-1) || ''), true);
// The fixture race starts Monday Sep 7, 08:11 MDT, and has no zone of its
// own, so it reads in this viewer's: Chicago.
ok('fills the table, in miles as this table is', await rows(), tpl(['Sat, Sep 12 12:30', 'Sat, Sep 12 15:00', 'Sat, Sep 12 17:00']));
ok('and says to press Save changes', m.endsWith('Check them below, then press Save changes.'), true);
const savedAfter = await page.evaluate(async (slug) => {
  const r = await (await fetch(`/api/get?path=races/${slug}/config.json`, { headers: { Authorization: 'Bearer stub' } })).json();
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(r.content), c => c.charCodeAt(0)))).course.segments.length;
}, SLUG);
ok('nothing is saved by importing alone', savedAfter, savedBefore);
await page.click('#aid-save');
await page.waitForTimeout(1500);
const segs = await page.evaluate(async (slug) => {
  const r = await (await fetch(`/api/get?path=races/${slug}/config.json`, { headers: { Authorization: 'Bearer stub' } })).json();
  const c = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(r.content), c => c.charCodeAt(0))));
  return c.course.segments.map(s => [s.toAid || s.name, +s.distanceMi.toFixed(1), s.arriveCutoffHours]);
}, SLUG);
ok('Save changes writes them as the course, cutoffs as hours from the start', segs,
  [['Ridge Road', 6.2, null], ['Summit Timing', 5.2, null], ['Lakeside', 6.5, 123.31], ['Pine Hollow', 6.7, 125.81], ['Finish', 6.5, 127.81]]);

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
