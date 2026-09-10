// Two promises that only a real browser can check, in one run to save a launch.
//
// First: a stranger with no account can see every public race and open any of
// them. That is a commitment now (ROADMAP, "Every race, forever"), so it is
// held by a test rather than by whoever remembers it.
//
// Then: the offline path.
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
import net from 'node:net';
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

// Whether anything is listening. This test's whole second half rests on the
// server being gone, and a leftover harness from an earlier run would answer
// on the same port: the new one fails to bind, killing it kills nothing, and
// every offline assertion is quietly made against a live network. A test that
// can pass while testing nothing is worse than no test, so the port is checked
// on both sides.
const listening = () => new Promise((resolve) => {
  const sock = net.connect(8787, '127.0.0.1');
  const done = (v) => { sock.destroy(); resolve(v); };
  sock.once('connect', () => done(true));
  sock.once('error', () => done(false));
  setTimeout(() => done(false), 500);
});
const waitFor = async (want, what) => {
  for (let i = 0; i < 40; i++) {
    if (await listening() === want) return;
    await new Promise(r => setTimeout(r, 150));
  }
  console.error(`\n${what}\n`);
  process.exit(2);
};

if (await listening()) {
  console.error('\nPort 8787 is already in use. Something else is serving the site, so ' +
                'this test would check a live network and call it offline. Stop it first.\n');
  process.exit(2);
}

let server = spawn('node', [HARNESS], { stdio: 'ignore' });
process.on('exit', () => { try { server.kill('SIGKILL'); } catch (e) {} });
await waitFor(true, 'The harness never started listening on 8787.');

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();

const navLinks = () => page.evaluate(() =>
  [...document.querySelectorAll('a')].map(a => a.textContent.trim())
    .filter(t => /Pit Board|Racer|Settings|Charts|Print/i.test(t)));

// Before signing in, because signed out is the state being tested.
console.log('\na stranger with no account');
await page.goto(BASE + '/');
await page.waitForTimeout(600);
ok('lands on the marketing page, not the app', await page.evaluate(() =>
  !!document.querySelector('#beta-form') && !document.querySelector('a.card')), true);
ok('which offers a way into the app', await page.evaluate(() =>
  [...document.querySelectorAll('a')].some(a => new URL(a.href).pathname === '/app/')), true);

await page.goto(BASE + '/app/');
await page.waitForTimeout(2200);
await page.evaluate(() => { const o = document.querySelector('.intro-overlay'); if (o) o.remove(); });
const publicRaces = await page.evaluate(() =>
  [...document.querySelectorAll('a.card')].map(a => new URL(a.href).pathname));
ok('sees the public races on the hub', publicRaces.length >= 3, true);
ok('and is not shown an empty hub',
  await page.evaluate(() => !!document.querySelector('.empty')), false);
// Finished races included: a cap on history would show up here first.
ok('including ones that already finished', await page.evaluate(() =>
  [...document.querySelectorAll('a.card .card-status')].some(e => /finished/i.test(e.textContent))), true);

// The address worth sharing. /races/<slug>/ carries that race's own social
// card, so it is what the hub links to and what the race page leaves in the
// bar; race.html?id= still works and is what an unlisted race keeps.
ok('the hub links to the shareable page', publicRaces[0].startsWith('/races/'), true);

await page.goto(BASE + publicRaces[0]);
await page.waitForTimeout(2800);
ok('which opens the race', await page.evaluate(() => {
  const t = document.getElementById('race-title');
  return !!t && t.textContent.trim().length > 0 && !/loading/i.test(t.textContent);
}), true);
ok('and leaves that address in the bar to be copied',
  await page.evaluate(() => location.pathname), publicRaces[0]);

await page.goto(`${BASE}/race.html?id=${publicRaces[0].split('/')[2]}`);
await page.waitForTimeout(2800);
ok('arriving by the app URL tidies it to the shareable one',
  await page.evaluate(() => location.pathname), publicRaces[0]);
ok('can open one of them', await page.evaluate(() => {
  const t = document.getElementById('race-title');
  return !!t && t.textContent.trim().length > 0 && !/loading/i.test(t.textContent);
}), true);
ok('with no error shown', await page.evaluate(() => {
  const e = document.getElementById('error');
  return !e || getComputedStyle(e).display === 'none';
}), true);
ok('and the charts and printout are offered', await navLinks(), ['Charts', 'Print']);

await page.goto(BASE + '/app/');
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
await page.goto(BASE + '/app/');
await page.waitForTimeout(2000);
ok('the service worker is in charge',
  await page.evaluate(() => !!navigator.serviceWorker.controller), true);
ok('and the saved config still knows the role', await page.evaluate((s) => {
  const r = JSON.parse(localStorage.getItem('so:seen:' + s + ':config.json') || 'null');
  return r && JSON.parse(r.text).myRole;
}, SLUG), 'crew');

// The pit board polls every ten seconds and rebuilds every card's innerHTML.
// That used to throw away whatever was half typed, and because an empty box
// means "clear this field", saving afterwards deleted the note that was
// already there. A crew member types slower than ten seconds, so this was
// every note, every time.
console.log('\ntyping a note through a poll');
await page.goto(`${BASE}/pit.html?id=${SLUG}`);
await page.waitForTimeout(2500);
const box = await page.$('#runners textarea[data-intake="notes"]');
ok('there is a notes box to type in', !!box, true);
if (box) {
  await box.fill('Half a PB and J, ice in the kerchief');
  // Long enough for the poll to fire at least once.
  await page.waitForTimeout(12000);
  ok('the note survives the poll', await page.evaluate(() =>
    document.querySelector('#runners textarea[data-intake="notes"]').value),
    'Half a PB and J, ice in the kerchief');
  // And the board comes back to life once the draft is gone.
  await page.evaluate(() => {
    const t = document.querySelector('#runners textarea[data-intake="notes"]');
    t.value = t.dataset.rendered; t.dispatchEvent(new Event('input', { bubbles: true }));
  });
  ok('and clearing it lets the board update again', await page.evaluate(() =>
    [...document.querySelectorAll('#runners [data-intake]')]
      .every(el => el.value === (el.dataset.rendered ?? ''))), true);
}

console.log('\nthe server is gone');
server.kill('SIGKILL');
await waitFor(false, 'The server is still answering on 8787 after being killed, so nothing ' +
                     'below would actually be testing the offline path.');

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
// The address bar now leaves /races/<slug>/ behind, so that is the address a
// crew member reloads at an aid station. It is not precached and never can be
// (there is one per race), so the worker serves the precached race page for it
// and race.html reads the slug out of the path. Without that this whole change
// would have traded a better shared link for a worse offline reload.
await page.goto(`${BASE}/races/${SLUG}/`).catch(() => {});
await page.waitForTimeout(3500);
ok('the shareable address still opens the race offline', await page.evaluate(() => {
  const t = document.getElementById('race-title');
  return !!t && t.textContent.trim().length > 0 && !/loading/i.test(t.textContent);
}), true);
ok('and it is the right race', await page.evaluate(() =>
  document.getElementById('race-title').textContent.toLowerCase().includes('sangre')), true);

await page.goto(`${BASE}/race.html?id=${SLUG}`).catch(() => {});
await page.waitForTimeout(3500);
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
await page.goto(BASE + '/app/').catch(() => {});
await page.waitForTimeout(3000);
// An unlisted race is not in the published manifest at all, so without the saved
// list the hub silently drops the one race the crew member is here for.
ok('the unlisted race is still listed', await page.evaluate((s) =>
  [...document.querySelectorAll('a[href*="race.html"]')].some(a => a.href.includes(s)), SLUG), true);

await browser.close();
console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
