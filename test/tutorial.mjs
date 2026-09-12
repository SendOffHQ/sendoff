// The first-visit tutorial: the store, the banner, and the way back to it.
//
// Fifteen screens are going to use this, so the mechanism is held here once
// rather than re-checked per screen. The wizard is the screen it is checked
// on because it is the first one a new owner meets after the hub.
//
// The three things that decide whether this is worth having at all:
//   - it shows the first time and not the second, which is the whole feature;
//   - "How this page works" brings it back, so dismissing is not a decision
//     somebody has to get right first time;
//   - storage refusing to work (private browsing) shows the banner rather than
//     breaking the page, because a teaching banner is never worth a blank screen.
//
//   node test/tutorial.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net'; import fs from 'node:fs';
const BASE = 'http://localhost:8787';
const KEY = 'race-hub-tutorial-v1';
// A race every one of these screens can open. See test/fixtures/races.
const SLUG = 'six-0-trail-marathon';
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
  console.log(`  ${q?'ok  ':'FAIL'} ${l.padEnd(50)} ${JSON.stringify(g)}${q?'':' want '+JSON.stringify(w)}`)};

const ctx = await b.newContext({ viewport:{width:900,height:1100}, serviceWorkers:'block' });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(BASE + '/index.html');
await page.evaluate(base => localStorage.setItem('race-hub-session-v1', JSON.stringify({
  session:'stub', proxyUrl: base + '/api', email:'me@example.com', role:'owner',
  expiresAt: Date.now() + 7*24*3600e3 })), BASE);

const banner = () => page.evaluate(() => {
  const el = document.querySelector('.tut');
  if (!el) return null;
  return { title: el.querySelector('.tut-title').textContent,
           points: el.querySelectorAll('.tut-points li').length,
           first: el.parentElement.firstElementChild === el };
});
const open = async () => { await page.goto(BASE + '/setup.html'); await page.waitForTimeout(900); };

console.log('\nthe first time somebody opens the wizard');
await open();
ok('the banner is there', await banner(), { title: 'Setting up a race', points: 4, first: true });
ok('and nothing is written down yet',
   await page.evaluate(k => localStorage.getItem(k), KEY), null);

console.log('\nGot it puts it away');
await page.click('.tut-close');
ok('it is gone', await page.evaluate(() => !!document.querySelector('.tut')), false);
ok('and that is remembered', await page.evaluate(k => JSON.parse(localStorage.getItem(k)), KEY), { setup: 1 });

console.log('\nand it stays away');
await open();
ok('the second visit is clean', await banner(), null);

console.log('\nbut the menu can bring it back');
await page.click('.account-menu-btn');
ok('the item is in the menu', await page.evaluate(() =>
  [...document.querySelectorAll('.account-menu-item')].map(e => e.textContent).includes('How this page works')), true);
await page.click('[data-act="tutorial"]');
await page.waitForTimeout(200);
ok('and it opens the same banner', await banner(), { title: 'Setting up a race', points: 4, first: true });

console.log('\nrewriting a screen shows it to people who dismissed the old words');
await page.evaluate(k => localStorage.setItem(k, JSON.stringify({ setup: 1 })), KEY);
await open();
ok('version 1 is still seen', await banner(), null);
await page.evaluate(() => Race.tutorial.register({
  key: 'setup', version: 2, where: '#tut-host', title: 'Setting up a race', points: ['new words'] }));
ok('version 2 is not', (await banner()).points, 1);

console.log('\nand with no storage at all it still teaches');
await page.evaluate(() => {
  const bang = () => { throw new Error('denied'); };
  for (const s of [localStorage, sessionStorage]) {
    Object.defineProperty(s, 'setItem', { value: bang });
    Object.defineProperty(s, 'getItem', { value: bang });
  }
});
ok('the banner opens', await page.evaluate(() => !!Race.tutorial.open()), true);

// Every screen that should have one, checked in one pass. Adding a screen and
// forgetting to register it is the way this stops being "each screen, the
// first time" and becomes "some screens, sometimes", and it would never be
// noticed: a missing banner looks exactly like a banner already dismissed.
console.log('\nand every screen that should have one, does');
const SCREENS = [
  ['/setup.html', 'setup', 'Setting up a race'],
  ['/race.html?id=' + SLUG, 'race', 'Following the race'],
  ['/pit.html?id=' + SLUG, 'pit', 'Working the pit board'],
  ['/racer.html?id=' + SLUG, 'racer', 'Your race'],
  ['/settings.html?id=' + SLUG, 'settings', 'Race settings'],
  ['/charts.html?id=' + SLUG, 'charts', 'Reading the charts'],
  ['/print-report.html?id=' + SLUG, 'print', 'The printable report']
];
const missing = [];
for (const [path, key, title] of SCREENS) {
  const fresh = await b.newContext({ viewport:{width:900,height:1100}, serviceWorkers:'block' });
  const pg = await fresh.newPage();
  await pg.goto(BASE + '/index.html');
  await pg.evaluate(base => localStorage.setItem('race-hub-session-v1', JSON.stringify({
    session:'stub', proxyUrl: base + '/api', email:'crew@example.com', role:'crew',
    expiresAt: Date.now() + 7*24*3600e3 })), BASE);
  await pg.goto(BASE + path);
  await pg.waitForTimeout(1600);
  const got = await pg.evaluate(() => {
    const el = document.querySelector('.tut');
    return el ? { title: el.querySelector('.tut-title').textContent,
                  points: el.querySelectorAll('.tut-points li').length } : null;
  });
  const menu = await pg.evaluate(() =>
    !!document.querySelector('.account-menu [data-act="tutorial"]'));
  if (!got || got.title !== title || !got.points || !menu) missing.push([path, got, menu]);
  await fresh.close();
}
ok('none of them is missing its tutorial', missing, []);

// The pit board is the screen this had to not get in the way of. Somebody who
// has started pressing has read it or decided not to, and either way a banner
// between them and the next racer is in the way.
console.log('\nthe pit board puts its own away on the first press');
const pit = await b.newContext({ viewport:{width:390,height:844}, serviceWorkers:'block' });
const pp = await pit.newPage();
await pp.goto(BASE + '/index.html');
await pp.evaluate(base => localStorage.setItem('race-hub-session-v1', JSON.stringify({
  session:'stub', proxyUrl: base + '/api', email:'crew@example.com', role:'crew',
  expiresAt: Date.now() + 7*24*3600e3 })), BASE);
// The fixture race has finished, so every button on it is disabled and there
// is nothing to press. The last leg's finish time is taken off on the way
// through, which puts one racer back on course. Both paths, because the board
// reads through the worker and falls back to the published file.
const onCourse = (doc) => {
  const r = (doc.runners || [])[0];
  const last = r && (r.legs || [])[r.legs.length - 1];
  if (last) delete last.endTime;
  return doc;
};
await pp.route('**/api/get**', async (route) => {
  if (!/data\.json/.test(route.request().url())) return route.continue();
  const env = await (await route.fetch()).json();
  const doc = onCourse(JSON.parse(Buffer.from(env.content, 'base64').toString('utf8')));
  env.content = Buffer.from(JSON.stringify(doc), 'utf8').toString('base64');
  await route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify(env) });
});
await pp.route(`**/races/${SLUG}/data.json*`, async (route) => {
  const doc = onCourse(await (await route.fetch()).json());
  await route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify(doc) });
});
await pp.goto(BASE + '/pit.html?id=' + SLUG);
await pp.waitForTimeout(1800);
ok('it is there to begin with', await pp.evaluate(() => !!document.querySelector('.tut')), true);
const big = pp.locator('.big-btn:not([disabled])').first();
ok('and there is a racer to press', await big.count(), 1);
await big.click();
await pp.waitForTimeout(400);
ok('pressing puts it away', await pp.evaluate(() => !!document.querySelector('.tut')), false);
ok('and it stays away next time', await pp.evaluate(
  k => JSON.parse(localStorage.getItem(k)).pit, KEY), 1);
await pit.close();

// The hub is the exception, and an intended one: it has a dialog of its own.
// What it must not be missing is the way back to it, in the same place as
// everywhere else.
console.log('\nthe hub keeps its dialog and gains the way back to it');
const hub = await b.newContext({ viewport:{width:900,height:1100}, serviceWorkers:'block' });
const hp = await hub.newPage();
await hp.goto(BASE + '/app/');
await hp.waitForTimeout(1400);
ok('the dialog opened, not a banner', await hp.evaluate(() =>
  [!!document.querySelector('.intro-overlay'), !!document.querySelector('.tut')]), [true, false]);
await hp.evaluate(() => { const o = document.querySelector('.intro-overlay'); if (o) o.remove(); });
await hp.click('.account-menu-btn');
await hp.click('[data-act="tutorial"]');
await hp.waitForTimeout(300);
ok('and the menu item reopens it', await hp.evaluate(() =>
  !!document.querySelector('.intro-overlay')), true);
await hub.close();

ok('nothing threw', errs, []);

await b.close();
console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
