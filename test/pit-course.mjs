// The course map and elevation profile at the foot of the pit board, so the
// crew have little reason to open the race page mid-race. Drawn by
// lib/course-view.js, which the race page shares.
//
//   node test/pit-course.mjs
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
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(BASE + '/index.html');
await page.evaluate(base => {
  localStorage.setItem('race-hub-session-v1', JSON.stringify({ session: 'stub', proxyUrl: base + '/api',
    email: 'crew@example.com', role: 'owner', expiresAt: Date.now() + 7 * 24 * 3600e3 }));
  localStorage.setItem('race-hub-tutorial-v1', JSON.stringify({ pit: 99, race: 99 }));
}, BASE);
const setLegs = (legs) => page.evaluate(async ([slug, legs]) => {
  await fetch('/api/commit', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer stub' },
    body: JSON.stringify({ path: `races/${slug}/data.json`, content: JSON.stringify({ runners: [{ id: 'jason', legs }] }), message: 'legs' }) });
}, [SLUG, legs]);
// Out on leg 2 for a while, so there is a racer to put on the course.
await setLegs([{ index: 1, startTime: new Date(Date.now() - 3 * 3600e3).toISOString(), endTime: new Date(Date.now() - 2 * 3600e3).toISOString() },
               { index: 2, startTime: new Date(Date.now() - 1.9 * 3600e3).toISOString() }]);

const course = () => page.evaluate(() => {
  const s = document.getElementById('course-map-section');
  const cards = document.getElementById('runners');
  return {
    shown: !!s && s.style.display !== 'none' && s.offsetHeight > 0,
    belowCards: !!(s && cards && (cards.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING)),
    meta: (s.querySelector('.course-map-meta') || {}).textContent || '',
    map: !!s.querySelector('.course-map.leaflet-container'),
    route: s.querySelectorAll('.course-map path.leaflet-interactive').length > 0,
    profile: !!s.querySelector('.course-elev .elev-line'),
    aids: s.querySelectorAll('.course-elev .elev-aid-dot').length,
    racerOnProfile: [...s.querySelectorAll('.course-elev .elev-runner-label')].map(t => t.textContent),
    racerOnMap: [...s.querySelectorAll('.runner-dot-label')].map(t => t.textContent.split(' · ')[0])
  };
});

console.log('\nthe pit board');
await page.goto(BASE + `/pit.html?id=${SLUG}`);
await page.waitForSelector('#course-map-section .course-elev .elev-line', { state: 'attached', timeout: 20000 });
let c = await course();
ok('shows the course, under the racer cards', [c.shown, c.belowCards], [true, true]);
ok('with its distance and climb', /mi · \+[\d,]+ \/ -[\d,]+ ft/.test(c.meta), true);
ok('a map with the route on it', [c.map, c.route], [true, true]);
ok('and the elevation profile with every aid station', [c.profile, c.aids > 2], [true, true]);
ok('and where the racer probably is, on both', [c.racerOnProfile, c.racerOnMap], [['Test Racer'], ['Test Racer']]);
ok('nothing pushes the board sideways', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

console.log('\nand the race page, drawn from the same code');
await page.goto(BASE + `/race.html?id=${SLUG}`);
await page.waitForSelector('#course-map-section .course-elev .elev-line', { state: 'attached', timeout: 20000 });
c = await course();
ok('still shows the course', [c.shown, c.map, c.profile, c.racerOnProfile], [true, true, true, ['Test Racer']]);
// The first tile on a racer's card: how far they have come of the whole
// course, not how many segments the course was typed in as.
const tile = await page.$eval('.runner .stats .stat', el => ({
  label: el.querySelector('.label').textContent.trim(),
  value: el.querySelector('.value').textContent.replace(/\s+/g, ' ').trim(),
  sub: el.querySelector('.sub').textContent.trim() }));
ok('the first tile is distance, done of the whole course', [tile.label, /^\d+\.\d\/\d+\.\d mi$/.test(tile.value), /^\d+% of the course$/.test(tile.sub)],
  ['Distance', true, true]);
ok('with no segment count on it', /segment/i.test(JSON.stringify(tile)), false);

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
