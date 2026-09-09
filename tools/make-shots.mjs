// Captures the landing page's two screenshots from the real app, driven
// against test/harness.mjs, so the marketing page shows the app rather than a
// drawing of it.
//
// The race is six-0-trail-marathon: real, finished, public, and the founder's
// own, so no other person's name lands on a marketing page.
//
// The crew shot needs the race to be *in progress*, because the whole point of
// the pit board is the one big button you hit with your hands full, and a
// finished race does not show it. So the clock is pinned to a moment mid-race
// and the logged legs are truncated to that moment, with the racer out on
// course. Nothing is invented: it is this race's own data, replayed at 14:15Z.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';

const BASE = 'http://localhost:8787';
const SLUG = 'six-0-trail-marathon';
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const OUT = ROOT + '/brand/marketing';
const HARNESS = ROOT + '/test/harness.mjs';
const PINNED = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const CHROME = fs.existsSync(PINNED) ? PINNED : undefined;
const NOW = Date.parse('2026-09-05T14:15:00.000Z');   // leg 3, out on course

const listening = () => new Promise(r => {
  const s = net.connect(8787, '127.0.0.1');
  const d = v => { s.destroy(); r(v); };
  s.once('connect', () => d(true)); s.once('error', () => d(false));
  setTimeout(() => d(false), 500);
});
if (await listening()) { console.error('port 8787 busy'); process.exit(2); }
const server = spawn('node', [HARNESS], { stdio: 'ignore' });
process.on('exit', () => { try { server.kill('SIGKILL'); } catch (e) {} });
for (let i = 0; i < 40 && !(await listening()); i++) await new Promise(r => setTimeout(r, 150));

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 3,
  isMobile: true, hasTouch: true, timezoneId: 'America/Chicago',
  // Route interception does not reach requests a service worker makes, and
  // the replayed data below has to reach the page.
  serviceWorkers: 'block'
});

async function fresh(live) {
  const page = await ctx.newPage();
  if (live) {
    await page.addInitScript(`{
      const FIXED = ${NOW};
      const real = Date.now.bind(Date);
      const base = real();
      const D = Date;
      const shim = new Proxy(D, {
        construct(t, a) { return a.length ? new t(...a) : new t(FIXED + (real() - base)); },
        apply() { return new D(FIXED + (real() - base)).toString(); }
      });
      shim.now = () => FIXED + (real() - base);
      window.Date = shim;
    }`);
    // The same race, replayed: legs up to 14:15Z, the last one still open
    // because the racer is out on course.
    // Both doors: the page reads this file through the worker proxy and, on a
    // miss, straight from the published copy.
    const replay = (doc) => {
      for (const r of doc.runners || []) {
        r.legs = (r.legs || []).filter(l => Date.parse(l.startTime) <= NOW).slice(0, 3);
        const last = r.legs[r.legs.length - 1];
        if (last) delete last.endTime;
      }
      doc.lastUpdated = new Date(NOW - 4 * 60000).toISOString();
      return doc;
    };
    await page.route('**/api/get**', async (route) => {
      if (!/data\.json/.test(route.request().url())) return route.continue();
      const env = await (await route.fetch()).json();
      const doc = replay(JSON.parse(Buffer.from(env.content, 'base64').toString('utf8')));
      env.content = Buffer.from(JSON.stringify(doc, null, 2) + '\n', 'utf8').toString('base64');
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(env) });
    });
    await page.route('**/races/' + SLUG + '/data.json*', async (route) => {
      const doc = replay(await (await route.fetch()).json());
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(doc, null, 2) + '\n' });
    });
  }
  await page.goto(BASE + '/index.html');
  await page.evaluate((base) => {
    localStorage.setItem('race-hub-session-v1', JSON.stringify({
      session: 'stub-token', proxyUrl: base + '/api', email: 'crew@example.com',
      role: 'crew', expiresAt: Date.now() + 7 * 24 * 3600e3
    }));
    localStorage.setItem('sendoff-intro-seen-v1', '1');
  }, BASE);
  return page;
}

// Chrome that belongs to the harness, not to the product: the stub session
// banner, the intro, and the offline bar.
const tidy = `
  document.querySelectorAll('.intro-overlay,.modal-overlay,#so-offline-bar').forEach(e => e.remove());
  document.querySelectorAll('.auth-box,.session-box,#auth-status,#session-panel').forEach(e => e.remove());
  [...document.querySelectorAll('div,section')].forEach(e => {
    if (/Signed in as/.test(e.textContent) && e.children.length < 6 && e.offsetHeight < 260) e.remove();
  });`;

async function shot(page, url, file, height) {
  await page.goto(url);
  await page.waitForTimeout(3800);
  await page.evaluate(tidy);
  await page.waitForTimeout(400);
  const h = await page.evaluate(() => document.body.scrollHeight);
  await page.screenshot({ path: `${OUT}/${file}`,
    clip: { x: 0, y: 0, width: 390, height: Math.min(h, height) } });
  console.log(file.padEnd(18), 'captured, page is', h, 'tall');
}

const a = await fresh(false);
await shot(a, `${BASE}/race.html?id=${SLUG}`, 'shot-race.png', 1000);
await a.close();

const b = await fresh(true);
await shot(b, `${BASE}/pit.html?id=${SLUG}`, 'shot-pit.png', 1000);
await b.close();

await browser.close();
server.kill('SIGKILL');

// A flat dark interface is nearly all flat fills and monospaced text, which a
// 256-colour palette holds at full resolution for about a third of the bytes.
// Shrinking the image instead makes it larger, because resampling adds the
// noise that palette turns into banding. Needs Pillow; skipped without it.
const shrink = spawn('python3', ['-c', `
from PIL import Image
import os, sys
for f in ['${OUT}/shot-pit.png', '${OUT}/shot-race.png']:
    before = os.path.getsize(f)
    im = Image.open(f).convert('RGB')
    im.quantize(colors=256, method=Image.MEDIANCUT, dither=Image.FLOYDSTEINBERG).save(f, optimize=True)
    print('  %s %d kB -> %d kB' % (os.path.basename(f), before // 1024, os.path.getsize(f) // 1024))
`], { stdio: 'inherit' });
shrink.on('close', (code) => {
  if (code !== 0) console.log('  (Pillow not available, screenshots left unquantised)');
});
