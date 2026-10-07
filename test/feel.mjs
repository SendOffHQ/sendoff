// How are you feeling: asked on the racer screen in the seconds after a press,
// while the Undo is still up, kept on the leg, and shown beside that leg's
// times on the race page and the pit board.
//
//   node test/feel.mjs
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
  localStorage.setItem('race-hub-tutorial-v1', JSON.stringify({ racer: 99, pit: 99, race: 99 }));
}, BASE);
const readLegs = () => page.evaluate(async (slug) => {
  const r = await (await fetch(`/api/get?path=races/${slug}/data.json`, { headers: { Authorization: 'Bearer stub' } })).json();
  const d = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(r.content), c => c.charCodeAt(0))));
  return d.runners[0].legs;
}, SLUG);
const setLegs = (legs) => page.evaluate(async ([slug, legs]) => {
  await fetch('/api/commit', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer stub' },
    body: JSON.stringify({ path: `races/${slug}/data.json`, content: JSON.stringify({ runners: [{ id: 'jason', legs }] }), message: 'legs' }) });
}, [SLUG, legs]);
// Out on leg 2, so the next press is an arrival at an aid station. Leg 1 ends
// at a timing checkpoint, where one press both arrives and leaves.
await setLegs([{ index: 1, startTime: new Date(Date.now() - 120 * 60e3).toISOString(), endTime: new Date(Date.now() - 60 * 60e3).toISOString() },
               { index: 2, startTime: new Date(Date.now() - 60 * 60e3).toISOString() }]);

const openRacer = async () => {
  await page.goto(BASE + `/racer.html?id=${SLUG}&runner=jason`);
  await page.waitForSelector('#go', { timeout: 20000 });
};
const leg = async (i) => (await readLegs()).find(l => l.index === i) || {};
// Saves happen in the background: wait until the file says what is expected,
// for up to six seconds, rather than sleeping a fixed time and hoping.
const until = async (test) => { for (let i = 0; i < 40; i++) { if (await test()) return; await page.waitForTimeout(150); } };

console.log('\nthe racer screen, after a press');
await openRacer();
await page.click('#go');
await page.waitForSelector('.rundo .rundo-feel', { timeout: 5000 });
ok('asks how they are feeling, with three faces, beside the Undo',
  [await page.textContent('.rundo-feel .q'), await page.$$eval('.rundo-feel [data-feel]', bs => bs.map(x => x.dataset.feel)), await page.isVisible('#undo')],
  ['How are you feeling?', ['good', 'ok', 'rough'], true]);
ok('and it all fits a phone', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
// The countdown moves without redrawing the faces under the thumb.
const before = await page.$('.rundo-feel [data-feel="ok"]');
await page.waitForTimeout(1300);
ok('the countdown ticks without redrawing the faces', await before.evaluate(el => el.isConnected), true);
await page.click('.rundo-feel [data-feel="ok"]');
await until(async () => (await leg(2)).feelIn === 'ok');
ok('a tap is kept on the leg they just finished, as the arrival', [(await leg(2)).feelIn, (await leg(2)).feelOut], ['ok', undefined]);
ok('and shown as chosen', [await page.textContent('.rundo-feel .q'), await page.$$eval('.feel-btn.on', bs => bs.map(x => x.dataset.feel))],
  ['Noted. Tap another to change it.', ['ok']]);
await page.click('.rundo-feel [data-feel="good"]');
await until(async () => (await leg(2)).feelIn === 'good');
ok('tapping another changes it', (await leg(2)).feelIn, 'good');

console.log('\nleaving the aid station');
await page.waitForFunction(() => !document.querySelector('.rundo'), null, { timeout: 20000 });
await page.waitForSelector('#go');
await page.click('#go');
await page.waitForSelector('.rundo .rundo-feel');
await page.click('.rundo-feel [data-feel="rough"]');
await until(async () => (await leg(3)).feelOut === 'rough');
ok('is kept as how they felt leaving, on the next leg', (await leg(3)).feelOut, 'rough');

console.log('\nundone');
await page.click('#undo');
await until(async () => !(await readLegs()).some(l => l.index === 3));
ok('the send-off and its feeling go together', (await readLegs()).some(l => l.index === 3), false);
ok('and the arrival keeps its own', (await leg(2)).feelIn, 'good');

console.log('\nanswered or not, the press stands');
await openRacer();
await page.click('#go');
await page.waitForSelector('.rundo');
// The press saves in the background, so wait for it to land rather than
// reading the file the instant the bar appears.
await until(async () => !!(await leg(3)).startTime);
ok('a press with no face tapped is a press like any other', !!(await leg(3)).startTime, true);
ok('with nothing stored for a feeling', (await leg(3)).feelOut, undefined);

console.log('\nthe race page and the pit board');
await setLegs([{ index: 1, startTime: new Date(Date.now() - 3 * 3600e3).toISOString(), endTime: new Date(Date.now() - 2 * 3600e3).toISOString(), feelOut: 'good', feelIn: 'ok' },
               { index: 2, startTime: new Date(Date.now() - 1.9 * 3600e3).toISOString(), feelOut: 'rough' }]);
await page.goto(BASE + `/race.html?id=${SLUG}`);
await page.waitForSelector('.seg-row', { state: 'attached', timeout: 20000 });
const raceFaces = await page.$$eval('.seg-row', rows => rows.slice(0, 3).map(r =>
  [...r.querySelectorAll('.feel-tag')].map(t => t.firstChild.textContent.trim() + ':' + t.querySelector('svg').getAttribute('aria-label'))));
ok('the race page puts them on the leg, leaving and arriving', raceFaces.filter(x => x.length),
  [['out:Feeling good', 'in:Getting by'], ['out:Rough']]);
await page.goto(BASE + `/pit.html?id=${SLUG}`);
await page.waitForSelector('.intake-times', { timeout: 20000 });
ok('the pit board puts them beside the Out and In times', await page.$$eval('.intake-times .feel-face', fs => fs.map(f => f.getAttribute('aria-label'))),
  ['Rough']);

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
