// Emoji reactions on a race's photos, on the race page. Everybody sees the
// counts; reacting takes an account, and a tap while signed out opens the
// sign-in box instead. The worker's side is worker/test/media-reactions.mjs.
//
//   node test/photo-reactions.mjs
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
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
page.on('pageerror', e => errs.push(e.message));
await page.goto(BASE + '/index.html');
await page.evaluate(() => localStorage.setItem('race-hub-tutorial-v1', JSON.stringify({ racer: 99, pit: 99, race: 99 })));

// A photo on leg 1, taken by the crew, and a heart from somebody else.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const photoId = await page.evaluate(async ([slug, png]) => {
  const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0));
  const r = await (await fetch(`/api/media?id=${slug}&leg=1&w=1&h=1`, { method: 'POST',
    headers: { Authorization: 'Bearer crew', 'Content-Type': 'image/png' }, body: bytes })).json();
  await fetch('/api/media/react', { method: 'POST', headers: { Authorization: 'Bearer someone-else', 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: r.media.id, emoji: '🔥' }) });
  return r.media.id;
}, [SLUG, PNG]);

const openStrip = async (url) => {
  await page.goto(BASE + url);
  await page.locator('[data-media-leg="1"]').waitFor({ state: 'attached', timeout: 20000 });
  // The leg log starts folded; open it the way a person would.
  if (!(await page.locator('[data-media-leg="1"]').isVisible())) await page.locator('.leglog.collapsed .leglog-head').first().click();
  await page.click('[data-media-leg="1"]');
  await page.waitForSelector(`#media-leg-1 [data-react-for]`, { timeout: 5000 });
};
const bar = () => page.evaluate(() => {
  const el = document.querySelector('#media-leg-1 [data-react-for]');
  return [...el.querySelectorAll('.react-chip')].map(c => c.textContent + (c.classList.contains('mine') ? ' mine' : ''));
});
const stored = () => page.evaluate(async (id) => {
  const r = await (await fetch(`/api/media?id=zz-fixture-unlisted`, { headers: { Authorization: 'Bearer stub' } })).json();
  const m = r.media.find(x => x.id === id); return [m.reactions, m.mine];
}, photoId);

console.log('\nsigned out, by a share link');
await openStrip(`/race.html?id=${SLUG}&t=stub-${SLUG}`);
ok('the photo shows its reactions, with counts', await bar(), ['🔥1']);
await page.click('#media-leg-1 .react-chip');
await page.waitForSelector('.modal-overlay', { timeout: 5000 });
ok('a tap asks them to sign in', /Sign in/.test(await page.textContent('.modal-overlay')), true);
ok('and adds nothing', await stored(), [{ '🔥': 1 }, []]);
await page.keyboard.press('Escape');

console.log('\nsigned in');
await page.evaluate(base => localStorage.setItem('race-hub-session-v1', JSON.stringify({ session: 'stub', proxyUrl: base + '/api',
  email: 'crew@example.com', role: 'owner', expiresAt: Date.now() + 7 * 24 * 3600e3 })), BASE);
await openStrip(`/race.html?id=${SLUG}`);
await page.click('#media-leg-1 .react-chip');
await page.waitForFunction(() => /mine/.test(document.querySelector('#media-leg-1 .react-chip').className), null, { timeout: 5000 });
ok('a tap on a reaction adds theirs', [await bar(), await stored()], [['🔥2 mine'], [{ '🔥': 2 }, ['🔥']]]);
await page.click('#media-leg-1 .react-chip');
await page.waitForFunction(() => !/mine/.test(document.querySelector('#media-leg-1 .react-chip').className), null, { timeout: 5000 });
ok('and another takes it back', [await bar(), await stored()], [['🔥1'], [{ '🔥': 1 }, []]]);

await page.click('#media-leg-1 [data-react-add]');
const six = await page.$$eval('#media-leg-1 .react-pick button', bs => bs.map(x => x.textContent));
ok('+ react offers the six', six, ['❤️', '🔥', '👏', '💪', '😂', '😮']);
await page.click('#media-leg-1 .react-pick button[data-react="👏"]');
await page.waitForFunction(() => document.querySelectorAll('#media-leg-1 .react-chip').length === 2, null, { timeout: 5000 });
ok('picking one adds it, beside the others', await bar(), ['🔥1', '👏1 mine']);
ok('and puts the picker away', await page.$eval('#media-leg-1 .react-pick', p => p.hidden), true);
ok('it all fits a phone', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

console.log('\nthe gallery');
await page.click('#gallery-open');
await page.waitForSelector('.gallery-overlay [data-react-for]', { timeout: 5000 });
ok('shows the same', await page.$$eval('.gallery-overlay .react-chip', cs => cs.map(c => c.textContent)), ['🔥1', '👏1']);
await page.click('.gallery-close');

console.log('\nsomebody else reacting');
await page.evaluate(async (id) => {
  await fetch('/api/media/react', { method: 'POST', headers: { Authorization: 'Bearer a-third', 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, emoji: '❤️' }) });
}, photoId);
await openStrip(`/race.html?id=${SLUG}`);
ok('turns up with the photos', await bar(), ['❤️1', '🔥1', '👏1 mine']);

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
