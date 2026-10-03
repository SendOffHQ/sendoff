// A race keeps its own clock. The start, the finish cutoff and every aid
// station cutoff are entered and shown as a day and a time in the race's
// zone, whatever zone the person at the keyboard is in, and are stored as
// hours from the start the way they always were.
//
//   node test/race-timezone.mjs
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
  console.log(`  ${q?'ok  ':'FAIL'} ${l.padEnd(58)} ${JSON.stringify(g)}${q?'':' want '+JSON.stringify(w)}`)};
const errs = [];

const open = async (timezoneId) => {
  const ctx = await b.newContext({ viewport: { width: 390, height: 900 }, serviceWorkers: 'block', timezoneId, locale: 'en-US' });
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push(e.message));
  page.on('dialog', d => d.accept());
  await page.goto(BASE + '/index.html');
  await page.evaluate(base => {
    localStorage.setItem('race-hub-session-v1', JSON.stringify({ session: 'stub', proxyUrl: base + '/api',
      email: 'crew@example.com', role: 'owner', expiresAt: Date.now() + 7 * 24 * 3600e3 }));
    localStorage.setItem('race-hub-tutorial-v1', JSON.stringify({ setup: 99, settings: 99, pit: 99 }));
  }, BASE);
  return page;
};
const saved = (page) => page.evaluate(async (slug) => {
  const r = await (await fetch(`/api/get?path=races/${slug}/config.json`, { headers: { Authorization: 'Bearer stub' } })).json();
  const c = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(r.content), c => c.charCodeAt(0))));
  return { startTime: c.startTime, timezone: c.timezone || null, totalHours: c.cutoffs.totalHours,
    aid: c.course.segments.filter(s => s.arriveCutoffHours != null).map(s => s.arriveCutoffHours) };
}, SLUG);
const form = (page) => page.evaluate(() => {
  const pick = (id) => { const h = document.getElementById(id); const d = h.querySelector('select'), t = h.querySelector('input');
    return d ? `${d.selectedOptions[0].textContent} ${t.value}` : h.textContent.trim(); };
  return [document.getElementById('race-start-date').value, document.getElementById('race-start-time').value,
    document.getElementById('race-tz').value, pick('race-cutoff-pick')];
});
const aidCuts = (page) => page.evaluate(() => [...document.querySelectorAll('#aid-rows .cut-pick')]
  .map(p => [p.querySelector('select').selectedOptions[0].textContent, p.querySelector('input').value])
  .filter(([, t]) => t).map(x => x.join(' ')));
const openSettings = async (page) => {
  await page.goto(BASE + `/settings.html?id=${SLUG}`);
  await page.waitForSelector('#race-editor-head', { timeout: 20000 });
  await page.waitForFunction(() => document.getElementById('race-start-date').value, null, { timeout: 20000 });
  await page.click('#race-editor-head');
  await page.click('#aid-editor-head');
};
const saveDetails = async (page) => {
  await page.click('#race-save');
  await page.waitForFunction(() => !document.getElementById('race-save').classList.contains('busy') &&
    !/Saving/.test(document.getElementById('race-save').textContent), null, { timeout: 10000 });
  await page.waitForTimeout(800);
};

// The fixture race starts Monday Sep 7 at 08:11 MDT and has no zone of its
// own, as every race from before zones did. Cutoffs at 18.5, 26.5, 28.75, 34
// and 38 hours.
console.log('\na race from before zones, opened in Chicago');
let page = await open('America/Chicago');
await openSettings(page);
ok('reads in the viewer\'s zone, as it always has', await form(page), ['2026-09-07', '09:11', 'America/Chicago', 'Tue, Sep 8 23:11']);
ok('the aid cutoffs are a day and a time', await aidCuts(page),
  ['Tue, Sep 8 03:41', 'Tue, Sep 8 11:41', 'Tue, Sep 8 13:56', 'Tue, Sep 8 19:11', 'Tue, Sep 8 23:11']);

console.log('\ngiven a zone of its own');
await page.selectOption('#race-tz', 'America/Denver');
ok('the start stays at its clock time in the new zone', await form(page), ['2026-09-07', '09:11', 'America/Denver', 'Tue, Sep 8 23:11']);
await saveDetails(page);
let c = await saved(page);
ok('and is saved with the zone and its offset', [c.startTime, c.timezone], ['2026-09-07T09:11:00-06:00', 'America/Denver']);
ok('every cutoff keeps its clock time, so the same hours', [c.totalHours, c.aid], [38, [18.5, 26.5, 28.75, 34, 38]]);

console.log('\nthe start moved an hour later');
await page.fill('#race-start-time', '10:11'); await page.dispatchEvent('#race-start-time', 'change');
await saveDetails(page);
c = await saved(page);
ok('the start moves', c.startTime, '2026-09-07T10:11:00-06:00');
ok('and the cutoffs stay put, an hour fewer from the start', [c.totalHours, c.aid], [37, [17.5, 25.5, 27.75, 33, 37]]);
ok('the aid table still shows the same days and times', await aidCuts(page),
  ['Tue, Sep 8 03:41', 'Tue, Sep 8 11:41', 'Tue, Sep 8 13:56', 'Tue, Sep 8 19:11', 'Tue, Sep 8 23:11']);

console.log('\nan aid cutoff moved in the table');
await page.fill('#aid-rows .cut-pick input[value="03:41"]', '04:41');
await page.click('#aid-save');
await page.waitForTimeout(1500);
c = await saved(page);
ok('is saved as hours from the start', c.aid, [18.5, 25.5, 27.75, 33, 37]);

console.log('\nthe finish cutoff, a day later');
await page.selectOption('#race-cutoff-pick select', '2026-09-09');
await saveDetails(page);
ok('is 24 hours more', (await saved(page)).totalHours, 61);
await page.selectOption('#race-cutoff-pick select', '2026-09-07');
await page.fill('#race-cutoff-pick input', '08:00');
await page.click('#race-save');
await page.waitForTimeout(500);
ok('and one before the start is refused', [(await saved(page)).totalHours,
  (await page.textContent('#toast')).trim()], [61, 'The finish cutoff has to be after the start.']);
await page.context().close();

console.log('\nthe same race opened in Tokyo');
page = await open('Asia/Tokyo');
await openSettings(page);
ok('is on the race\'s clock, not Tokyo\'s', await form(page), ['2026-09-07', '10:11', 'America/Denver', 'Wed, Sep 9 23:11']);
ok('and so are its aid cutoffs', await aidCuts(page),
  ['Tue, Sep 8 04:41', 'Tue, Sep 8 11:41', 'Tue, Sep 8 13:56', 'Tue, Sep 8 19:11', 'Tue, Sep 8 23:11']);
await page.context().close();

// The wizard, from a laptop in New York, for a race in Colorado.
console.log('\nthe setup wizard, in New York, for a race in Denver');
page = await open('America/New_York');
let written = null;
await page.route('**/api/commit', async (route) => {
  const j = JSON.parse(route.request().postData() || '{}');
  if (/config\.json$/.test(j.path || '') && /^races\/0/.test(j.path)) written = JSON.parse(j.content);
  await route.continue();
});
// The stub worker hands out no race numbers; this one is free.
await page.route('**/api/next-race-id', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"id":"000901"}' }));
await page.goto(BASE + '/setup.html');
await page.waitForSelector('#race-tz option', { state: 'attached', timeout: 15000 });
ok('the zone starts as this device\'s', await page.inputValue('#race-tz'), 'America/New_York');
ok('and no cutoff can be picked before there is a start', (await page.textContent('#race-cutoff-pick')).trim(), 'Set the start date first');
await page.fill('#race-name', 'Zone Test 50');
await page.selectOption('#race-tz', 'America/Denver');
await page.fill('#race-date', '2026-10-03'); await page.dispatchEvent('#race-date', 'change');
await page.selectOption('#race-hour', '6'); await page.selectOption('#race-minute', '0'); await page.selectOption('#race-ampm', 'AM');
ok('the finish cutoff starts 36 hours on', [await page.inputValue('#race-cutoff-pick select'), await page.inputValue('#race-cutoff-pick input')], ['2026-10-04', '18:00']);
await page.selectOption('#race-cutoff-pick select', '2026-10-04');
await page.fill('#race-cutoff-pick input', '12:00');
ok('and says how long that is', (await page.textContent('#race-cutoff-hint')).trim(), '30h after the start.');
await page.fill('[data-aid="1"][data-k="name"]', 'Halfway');
await page.fill('[data-aid="1"][data-k="mileage"]', '25');
await page.selectOption('[data-aid="1"][data-k="cut"][data-part="day"]', '2026-10-03');
await page.fill('[data-aid="1"][data-k="cut"][data-part="time"]', '18:30');
await page.fill('[data-aid="2"][data-k="mileage"]', '50');
await page.fill('[data-runner="0"][data-k="name"]', 'Pat');
await page.click('#btn-submit');
await page.waitForFunction(() => /Done|created|Opening/i.test(document.getElementById('progress').textContent) ||
  document.querySelector('#progress .error'), null, { timeout: 15000 }).catch(() => {});
ok('the race is written in its zone', written && [written.startTime, written.timezone], ['2026-10-03T06:00:00-06:00', 'America/Denver']);
ok('with its cutoffs as hours from the start', written && [written.cutoffs.totalHours, written.course.segments.map(s => s.arriveCutoffHours)], [30, [12.5, null]]);
await page.context().close();

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
