// Screenshots of the real app for the feature posts, not mockups of it.
//
// Serves the site through test/harness.mjs and opens a real race from races/,
// with the clock wound back to a moment during the race and the logged data
// cut off at that moment, so each page draws itself exactly as it looked then:
// the live leg, on pace, the projected finish. Nothing on screen is drawn by
// hand. Where a shot needs a person to have done something (open a panel,
// type a note, lose signal), `prep` does it through the page the way a person
// would.
//
//   node brand/social/capture-race.mjs            # every shot below
//   node brand/social/capture-race.mjs live-race  # just one
//   FULL=1 node brand/social/capture-race.mjs pit # whole page, for framing
//
// Outputs land in brand/social/shots/ at 3x, and features.html places them.
import { chromium } from 'playwright';
import { spawn, execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs'; import net from 'node:net'; import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..', '..');
const OUT = path.join(HERE, 'shots');
const BASE = 'http://localhost:8787';
const PIN = process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const ME = 'crew@example.com';   // the harness's signed-in stub
const SANGRE = '000001-sangre-de-cristo-100';
const MID = '2026-09-26T21:10:00Z';       // leg 7 of 16, mid-afternoon
const DONE = '2026-09-28T02:00:00Z';      // the night after the finish

const sleep = ms => new Promise(r => setTimeout(r, ms));

// One entry per shot.
//   at        the moment the page believes it is; data after it is cut
//   signedIn  as the harness's stub, who is made owner and the racer
//   scrollTo  what sits at the top of the screen, less scrollPad
//   prep      anything a person would have done first
const click = (page, sel) => page.click(sel).then(() => sleep(400));
const openSection = (page, head) => page.evaluate(h => {
  const el = document.querySelector(h);
  if (el) { el.scrollIntoView(); el.click(); }
}, head).then(() => sleep(600));
const PHOTOS_AT = '2026-09-27T16:30:00Z';  // leg 14, the morning after

// A roster that reads like a crew rather than the harness's one stub account.
// Example addresses only; no real person is named here.
const CREW = [
  { email: 'jason@example.com', role: 'owner', displayName: 'Jason' },
  { email: 'sam@example.com', role: 'crew', displayName: 'Sam' },
  { email: 'riley@example.com', role: 'pacer', displayName: 'Riley' },
  { email: 'mom@example.com', role: 'viewer', displayName: 'Mom' }
];

const SHOTS = {
  'live-race': { page: 'race.html', at: MID, scrollTo: 'article.runner', scrollPad: 24 },
  'map': { page: 'race.html', at: MID, scrollTo: '.leaflet-container', scrollPad: 70 },
  'legs': { page: 'race.html', at: MID, scrollTo: '.seg-row', scrollPad: 90 },
  'photos': { page: 'race.html', at: PHOTOS_AT, media: true,
    prep: async page => {
      await page.click('#gallery-open');
      await sleep(600);
      await page.evaluate(() => {
        const h = [...document.querySelectorAll('.gallery-leg h3')].find(x => /Leg 14/.test(x.textContent));
        if (h) h.scrollIntoView();
      });
      await sleep(400);
      await page.waitForFunction(() => [...document.querySelectorAll('.gallery-box img')]
        .filter(i => i.getBoundingClientRect().top < innerHeight).every(i => i.complete && i.naturalWidth > 0),
        null, { timeout: 30000 }).catch(() => {});
      await sleep(400);
    } },
  'pit': { page: 'pit.html', at: MID, signedIn: true, notRacer: true, media: true },
  'racer': { page: 'racer.html', at: MID, signedIn: true, media: true },
  'racer-reorder': { page: 'racer.html', at: MID, signedIn: true, media: true,
    scrollTo: '#reorder-toggle', scrollPad: 80, prep: page => click(page, '#reorder-toggle') },
  'racer-jot': { page: 'racer.html', at: MID, signedIn: true, media: true, scrollTo: '#jot-form', scrollPad: 330,
    prep: async page => {
      for (const note of ['Half a quesadilla and broth', 'New socks, taped left heel']) {
        await page.fill('#jot', note); await click(page, '#jot-send');
      }
    } },
  // Shorter, so the no-signal banner along the bottom sits inside the frame.
  'racer-offline': { page: 'racer.html', at: MID, signedIn: true, media: true, height: 700,
    prep: async page => {
      await page.context().setOffline(true);
      // Located afresh each time: a tap redraws the list.
      for (const i of [0, 1]) { await page.locator('.rchip').nth(i).click(); await sleep(500); }
      await page.evaluate(() => window.scrollTo(0, 0));
    } },
  'charts': { page: 'charts.html', at: DONE, scrollText: 'Aid station time', scrollPad: 60 },
  'report': { page: 'print-report.html', at: DONE, width: 820, height: 1060 },
  'fuel-plan': { page: 'settings.html', at: MID, signedIn: true, width: 600, height: 780,
    prep: async page => {
      await openSection(page, '#runner-editor .editor-head');
      await page.evaluate(() => {
        const h = [...document.querySelectorAll('#runner-editor *')].find(x =>
          x.children.length === 0 && /^hour bands$/i.test(x.textContent.trim()));
        if (h) window.scrollTo(0, h.getBoundingClientRect().top + scrollY - 14);
      });
      await sleep(300);
    } },
  'access': { page: 'settings.html', at: MID, signedIn: true, email: 'jason@example.com', access: CREW,
    prep: async page => {
      await openSection(page, '#access .access-head');
      await page.evaluate(() => {
        const el = document.querySelector('#access .access-head');
        window.scrollTo(0, el.getBoundingClientRect().top + scrollY - 16);
      });
      await sleep(300);
    } },
  'hub': { page: 'app/index.html', at: DONE, noSlug: true, scrollText: 'Sangre de Cristo 100', scrollPad: 62 },
  'setup': { page: 'setup.html', at: DONE, signedIn: true, noSlug: true, scrollTo: '#visibility-field', scrollPad: 150 },
  'finish-card': { page: 'race.html', at: DONE, prep: async page => { await click(page, '.finish-card-btn'); await sleep(1500); } }
};

const listening = () => new Promise(r => { const s = net.connect(8787, '127.0.0.1');
  const d = v => { s.destroy(); r(v); }; s.once('connect', () => d(true)); s.once('error', () => d(false));
  setTimeout(() => d(false), 500); });
if (await listening()) { console.error('port 8787 is busy'); process.exit(2); }

fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch(fs.existsSync(PIN) ? { executablePath: PIN } : {});

// Map tiles and photos come from the internet. The browser does not go out on
// its own; these are fetched here, where the machine's proxy applies, and
// handed to the page. Cached for the run, since every shot draws the same map.
const EXTERNAL = /^https:\/\/(server\.arcgisonline\.com|media\.sendoff\.run)\//;
const fetched = new Map();
const external = async route => {
  const url = route.request().url();
  if (!fetched.has(url)) {
    try { fetched.set(url, execFileSync('curl', ['-sSf', '--max-time', '20', url], { maxBuffer: 50e6 })); }
    catch (e) { fetched.set(url, null); }
  }
  const body = fetched.get(url);
  if (!body) return route.fulfill({ status: 404, body: '' });
  return route.fulfill({ status: 200, body,
    contentType: /\.png|tile\//.test(url) ? 'image/png' : 'image/jpeg' });
};

// The race's real photos, from the live worker, for the shots that show them.
// Public race, public list: the same call a spectator's browser makes.
const WORKER = 'https://race-dashboard-proxy.thebillyman.workers.dev';
let photoList = null;
const photos = () => photoList || (photoList = JSON.parse(execSync(
  `curl -sS '${WORKER}/media?id=${SANGRE}'`, { encoding: 'utf8' })).media || []);
const only = process.argv[2];

for (const [name, s] of Object.entries(SHOTS)) {
  if (only && only !== name) continue;
  // A fresh harness per shot, because it holds whatever the last shot wrote.
  const srv = spawn('node', [path.join(ROOT, 'test', 'harness.mjs')], { stdio: 'ignore' });
  for (let i = 0; i < 40 && !(await listening()); i++) await sleep(150);

  const slug = s.slug || SANGRE;
  const at = new Date(s.at).getTime();
  // The race as it stood at `at`: legs not yet started are dropped, and a leg
  // under way loses the arrival it had not made yet.
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'races', slug, 'data.json'), 'utf8'));
  for (const r of data.runners) {
    r.legs = r.legs.filter(l => new Date(l.startTime).getTime() < at).map(l => {
      l = { ...l };
      if (l.endTime && new Date(l.endTime).getTime() > at) delete l.endTime;
      return l;
    });
  }
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'races', slug, 'config.json'), 'utf8'));
  if (s.signedIn) {
    // The stub is the owner, and the racer, so every page opens as it would
    // for the person who ran it.
    cfg.createdBy = ME;
    if (cfg.runners && cfg.runners[0] && !s.notRacer) cfg.runners[0].email = ME;
  }

  const ctx = await b.newContext({ viewport: { width: s.width || 390, height: s.height || 760 },
    deviceScaleFactor: 3, serviceWorkers: 'block' });
  await ctx.route(EXTERNAL, external);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.clock.install({ time: new Date(s.at) });
  await page.goto(BASE + '/index.html');
  await page.evaluate(async ([slug, cfg, data, signedIn, base, me]) => {
    const put = (file, doc) => fetch('/api/commit', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer stub' },
      body: JSON.stringify({ path: `races/${slug}/${file}`, content: JSON.stringify(doc, null, 2) + '\n', message: 'shot' }) });
    localStorage.setItem('race-hub-intro-v1', '1');
    await put('config.json', cfg);
    await put('data.json', data);
    if (signedIn) localStorage.setItem('race-hub-session-v1', JSON.stringify({
      session: 'stub', proxyUrl: base + '/api', email: me, role: 'owner',
      expiresAt: Date.now() + 30 * 24 * 3600e3 }));
  }, [slug, cfg, data, !!s.signedIn, BASE, s.email || ME]);

  if (s.access) {
    await page.route(/\/api\/access\?/, route => route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ slug, createdBy: s.access[0].email, createdByName: s.access[0].displayName,
        teamCanInvite: false, canManageAccess: true, people: s.access,
        editors: [], viewers: [], shareLinks: [], pendingInvites: [] }) }));
  }
  if (s.media) {
    const shown = photos().filter(m => new Date(m.createdAt).getTime() < at);
    await page.route(/\/api\/media\?/, route => route.fulfill({ status: 200,
      contentType: 'application/json', body: JSON.stringify({ media: shown, configured: true }) }));
  }
  await page.goto(`${BASE}/${s.page}${s.noSlug ? '' : '?id=' + slug}`);
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.clock.runFor(3000);
  await sleep(1200);
  // Put the first-visit tutorial away the way a person would.
  for (const close of await page.$$('.tut-close')) {
    if (await close.isVisible()) { await close.click(); await sleep(200); }
  }
  if (s.prep) {
    try { await s.prep(page); }
    catch (e) { console.error(name, 'prep failed:', e.message.split('\n')[0]); }
  }
  if (s.scrollText) {
    await page.evaluate(([text, pad]) => {
      const el = [...document.querySelectorAll('body *')].find(x =>
        x.children.length === 0 && x.textContent.trim() === text);
      if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - pad);
    }, [s.scrollText, s.scrollPad || 0]);
    await sleep(300);
  }
  if (s.scrollTo) {
    await page.evaluate(([sel, pad]) => {
      const el = document.querySelector(sel);
      if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - pad);
    }, [s.scrollTo, s.scrollPad || 0]);
    await sleep(300);
  }
  if (errs.length) console.error(name, 'page errors:', errs);
  await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: !!process.env.FULL });
  console.log(name, 'done');
  await ctx.close();
  srv.kill('SIGKILL');
  for (let i = 0; i < 40 && (await listening()); i++) await sleep(100);
}
await b.close(); process.exit(0);
