// Screenshots of the real app for the feature posts, not mockups of it.
//
// Serves the site through test/harness.mjs and opens a real race from races/,
// with the clock wound back to a moment during the race and the logged data
// cut off at that moment, so the page draws itself exactly as a spectator saw
// it then: the live leg, on pace, the projected finish. Nothing on screen is
// drawn by hand.
//
//   node brand/social/capture-race.mjs            # every shot below
//   node brand/social/capture-race.mjs live-race  # just one
//
// Outputs land in brand/social/shots/ at 3x, and features.html places them.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import net from 'node:net'; import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..', '..');
const OUT = path.join(HERE, 'shots');
const BASE = 'http://localhost:8787';
const PIN = process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

// One entry per shot. `at` is the moment the page believes it is; `scrollTo`
// is what should sit at the top of the phone's screen.
const SHOTS = {
  'live-race': {
    slug: '000001-sangre-de-cristo-100', page: 'race.html',
    at: '2026-09-26T21:10:00Z',
    width: 390, height: 760, scrollTo: 'article.runner', scrollPad: 24
  }
};

const listening = () => new Promise(r => { const s = net.connect(8787, '127.0.0.1');
  const d = v => { s.destroy(); r(v); }; s.once('connect', () => d(true)); s.once('error', () => d(false));
  setTimeout(() => d(false), 500); });
if (await listening()) { console.error('port 8787 is busy'); process.exit(2); }
const srv = spawn('node', [path.join(ROOT, 'test', 'harness.mjs')], { stdio: 'ignore' });
process.on('exit', () => { try { srv.kill('SIGKILL'); } catch (e) {} });
for (let i = 0; i < 40 && !(await listening()); i++) await new Promise(r => setTimeout(r, 150));

fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch(fs.existsSync(PIN) ? { executablePath: PIN } : {});
const only = process.argv[2];

for (const [name, s] of Object.entries(SHOTS)) {
  if (only && only !== name) continue;
  // The race as it stood at `at`: legs not yet started are dropped, and a leg
  // under way loses the arrival it had not made yet.
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'races', s.slug, 'data.json'), 'utf8'));
  const at = new Date(s.at).getTime();
  for (const r of data.runners) {
    r.legs = r.legs.filter(l => new Date(l.startTime).getTime() < at).map(l => {
      l = { ...l };
      if (l.endTime && new Date(l.endTime).getTime() > at) delete l.endTime;
      return l;
    });
  }
  const text = JSON.stringify(data);

  const ctx = await b.newContext({ viewport: { width: s.width, height: s.height },
    deviceScaleFactor: 3, serviceWorkers: 'block' });
  await ctx.route(/data\.json/, route => {
    const u = new URL(route.request().url());
    const body = u.pathname.startsWith('/api/')
      ? JSON.stringify({ sha: 'x', path: `races/${s.slug}/data.json`,
          content: Buffer.from(text).toString('base64'), encoding: 'base64' })
      : text;
    return route.fulfill({ status: 200, contentType: 'application/json', body });
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.clock.install({ time: new Date(s.at) });
  await page.goto(`${BASE}/${s.page}?id=${s.slug}`);
  await page.waitForSelector('.seg-row', { timeout: 20000 });
  await page.clock.runFor(3000);
  await page.waitForTimeout(800);
  // Put the first-visit tutorial away the way a person would.
  const close = await page.$('.tut-close');
  if (close) { await close.click(); await page.waitForTimeout(300); }
  if (s.scrollTo) {
    await page.evaluate(([sel, pad]) => {
      const el = document.querySelector(sel);
      if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - pad);
    }, [s.scrollTo, s.scrollPad || 0]);
    await page.waitForTimeout(300);
  }
  if (errs.length) { console.error(name, 'page errors:', errs); process.exit(1); }
  await page.screenshot({ path: path.join(OUT, name + '.png') });
  console.log(name, `${s.width * 3}x${s.height * 3}`);
  await ctx.close();
}
await b.close(); srv.kill('SIGKILL'); process.exit(0);
