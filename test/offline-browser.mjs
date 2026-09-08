// The offline path, in a real browser with a real service worker.
//
// The unit tests cover the logic. This covers what actually went wrong on a
// phone, which was an interaction between three pieces that each looked right
// on their own: what a page reads, what the service worker has cached, and what
// the device wrote down last.
//
// Airplane mode is done by killing the server rather than with the browser's
// offline emulation. The emulation left same-origin requests alive and painted
// a convincing but wrong picture twice while this was being chased down.
//
//   npm i --no-save playwright && npm run test:browser
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const BASE = 'http://localhost:8787';
const SLUG = '000003-dry-run-sangre';
const ME = 'crew@example.com';
const HARNESS = new URL('./harness.mjs', import.meta.url).pathname;
// The sandbox's preinstalled Chromium when it is there, otherwise whichever
// one Playwright installed for itself.
const PINNED = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const CHROME = fs.existsSync(PINNED) ? PINNED : undefined;

let bad = 0;
const ok = (l, g, w) => {
  const p = JSON.stringify(g) === JSON.stringify(w);
  if (!p) bad++;
  console.log(`  ${p ? 'ok  ' : 'FAIL'} ${l.padEnd(52)} ${JSON.stringify(g)}${p ? '' : ' expected ' + JSON.stringify(w)}`);
};

let server = spawn('node', [HARNESS], { stdio: 'ignore' });
process.on('exit', () => { try { server.kill('SIGKILL'); } catch (e) {} });
await new Promise(r => setTimeout(r, 900));

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();

const navLinks = () => page.evaluate(() =>
  [...document.querySelectorAll('a')].map(a => a.textContent.trim())
    .filter(t => /Pit Board|Racer|Settings|Charts|Print/i.test(t)));

await page.goto(BASE + '/index.html');
await page.evaluate(([me, base]) => {
  localStorage.setItem('race-hub-session-v1', JSON.stringify({
    session: 'stub-token', proxyUrl: base + '/api', email: me, role: 'crew',
    expiresAt: Date.now() + 7 * 24 * 3600e3
  }));
}, [ME, BASE]);

// The order matters. The hub reads every race's config straight from the
// published files, which name nobody; the race page reads it through the proxy,
// which says who you are. Ending on the hub is what used to leave the device
// holding the copy that cannot answer the question, and it is why the bug
// depended on which page you happened to open last.
console.log('\nonline: the race, then the pit board, then back to the hub');
await page.goto(`${BASE}/race.html?id=${SLUG}`);
await page.waitForTimeout(2200);
ok('the crew member has their pages', await navLinks(), ['Pit Board', 'Racer', 'Settings', 'Charts', 'Print']);
await page.goto(`${BASE}/pit.html?id=${SLUG}`);
await page.waitForTimeout(1500);
await page.goto(BASE + '/index.html');
await page.waitForTimeout(2000);
ok('the service worker is in charge',
  await page.evaluate(() => !!navigator.serviceWorker.controller), true);
ok('and the saved config still knows the role', await page.evaluate((s) => {
  const r = JSON.parse(localStorage.getItem('so:seen:' + s + ':config.json') || 'null');
  return r && JSON.parse(r.text).myRole;
}, SLUG), 'crew');

console.log('\nthe server is gone');
server.kill('SIGKILL');
await new Promise(r => setTimeout(r, 600));

await page.goto(`${BASE}/race.html?id=${SLUG}`).catch(() => {});
await page.waitForTimeout(4000);
ok('the race page still opens', await page.evaluate(() => {
  const t = document.getElementById('race-title');
  return !!t && t.textContent.trim().length > 0;
}), true);
ok('the splits are still there',
  (await page.evaluate(() => document.querySelectorAll('#runners .leg-row, #runners tr').length)) > 0, true);
ok('the course drew', await page.evaluate(() => {
  const s = document.getElementById('course-map-section');
  return !!s && s.style.display !== 'none';
}), true);
// The one that matters: with no signal a crew member must still be able to
// reach the pages they log from.
ok('and the pit and racer pages are still reachable',
  await navLinks(), ['Pit Board', 'Racer', 'Settings', 'Charts', 'Print']);
ok('the page says it is showing saved data', await page.evaluate(() => {
  const b = document.getElementById('so-offline-bar');
  return !!b && /saved|No signal|network/i.test(b.textContent);
}), true);
ok('and the bar does not sit on top of the content', await page.evaluate(() =>
  getComputedStyle(document.documentElement).getPropertyValue('--so-offline-h').trim()) !== '0px', true);

console.log('\nthe pit board, with no signal');
await page.goto(`${BASE}/pit.html?id=${SLUG}`).catch(() => {});
await page.waitForTimeout(3000);
ok('it opens', (await page.evaluate(() => document.querySelectorAll('.big-btn').length)) > 0, true);
ok('and still offers the race and racer pages', await navLinks(), ['Racer', 'Settings', 'Charts', 'Print']);

console.log('\nthe hub, with no signal');
await page.goto(BASE + '/index.html').catch(() => {});
await page.waitForTimeout(3000);
// A private race is not in the published manifest at all, so without the saved
// list the hub silently drops the one race the crew member is here for.
ok('the private race is still listed', await page.evaluate((s) =>
  [...document.querySelectorAll('a[href*="race.html"]')].some(a => a.href.includes(s)), SLUG), true);

await browser.close();
console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
