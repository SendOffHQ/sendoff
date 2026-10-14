// Install app, in the menu. Where the browser lets a page ask (Chrome and the
// rest on Android and on a computer), the item opens the browser's own install
// dialog. On an iPhone, where no page can, it says the taps that do it, and
// inside Instagram's browser it says to open the page in a real one first. Not
// offered from inside the installed app, nor on a computer that cannot.
//
//   node test/install-app.mjs
import { chromium, devices } from 'playwright';
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

// A signed-in crew member on the race page, in a browser described by `opts`.
const open = async (opts, init) => {
  const ctx = await b.newContext({ serviceWorkers: 'block', ...opts });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push(e.message));
  await page.goto(BASE + '/index.html');
  await page.evaluate(base => {
    localStorage.setItem('race-hub-session-v1', JSON.stringify({ session: 'stub', proxyUrl: base + '/api',
      email: 'crew@example.com', role: 'owner', expiresAt: Date.now() + 7 * 24 * 3600e3 }));
    localStorage.setItem('race-hub-tutorial-v1', JSON.stringify({ racer: 99, pit: 99, race: 99 }));
  }, BASE);
  await page.goto(BASE + `/race.html?id=${SLUG}`);
  await page.waitForSelector('.account-menu-btn', { timeout: 20000 });
  return { ctx, page };
};
const items = async (page) => {
  if (await page.$eval('.account-menu', m => m.hidden)) await page.click('.account-menu-btn');
  const out = await page.$$eval('.account-menu .account-menu-item:not(.nav-hoisted)', els => els.map(e => e.textContent.trim()));
  await page.keyboard.press('Escape');
  return out;
};

console.log('\na computer whose browser can install it');
let { ctx, page } = await open({ viewport: { width: 1200, height: 900 } });
ok('nothing offered until the browser says it can', (await items(page)).includes('Install app'), false);
const prevented = await page.evaluate(() => {
  window.__asked = 0;
  const e = new Event('beforeinstallprompt', { cancelable: true });
  e.prompt = () => { window.__asked++; return Promise.resolve(); };
  e.userChoice = Promise.resolve({ outcome: 'accepted' });
  window.dispatchEvent(e);
  return e.defaultPrevented;
});
ok('then it is in the menu, low down, above signing out', (await items(page)).slice(-3), ['Send feedback', 'Install app', 'Sign out']);
ok('and the browser\'s own bar is held back for it', prevented, true);
await page.click('.account-menu-btn');
await page.click('.account-menu-item[data-act="install"]');
ok('a tap opens the browser\'s install dialog', [await page.evaluate(() => window.__asked), await page.$('.modal-overlay')], [1, null]);
await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
ok('installed, it is gone from the menu', (await items(page)).includes('Install app'), false);
await ctx.close();

console.log('\nan iPhone');
({ ctx, page } = await open({ ...devices['iPhone 13'] }));
ok('offered with no browser help', (await items(page)).slice(-3), ['Send feedback', 'Install app', 'Sign out']);
await page.click('.account-menu-btn');
await page.click('.account-menu-item[data-act="install"]');
await page.waitForSelector('.install-steps');
const guide = await page.evaluate(() => ({ title: document.querySelector('.modal-title').textContent,
  why: document.querySelector('.install-why').textContent,
  steps: [...document.querySelectorAll('.install-steps li')].map(li => li.textContent),
  cancel: document.querySelector('.modal-cancel').hidden, fits: document.documentElement.scrollWidth <= innerWidth }));
ok('it says first why the button cannot do it', /Apple only lets a website be added from the Share menu/.test(guide.why), true);
ok('it says the taps, in order', [guide.title, guide.steps.length, /Share/.test(guide.steps[0]), /Add to Home Screen/.test(guide.steps[1])],
  ['Add SendOff to your home screen', 3, true, true]);
ok('with one button to close it, and it fits the phone', [guide.cancel, guide.fits], [true, true]);
await page.click('.modal-primary');
ok('which closes it', await page.$('.modal-overlay'), null);
await ctx.close();

console.log('\nopened from the home screen');
({ ctx, page } = await open({ ...devices['iPhone 13'] }, () => { Object.defineProperty(navigator, 'standalone', { get: () => true }); }));
ok('not offered inside the app itself', (await items(page)).includes('Install app'), false);
await ctx.close();

console.log('\ninside Instagram');
({ ctx, page } = await open({ ...devices['iPhone 13'],
  userAgent: devices['iPhone 13'].userAgent + ' Instagram 300.0.0.0 (iPhone14,5; iOS 17_0; en_US)' }));
await page.click('.account-menu-btn');
await page.click('.account-menu-item[data-act="install"]');
await page.waitForSelector('.install-steps');
ok('it says to open the page in a real browser first',
  /Open in browser/.test(await page.textContent('.install-steps')), true);
await ctx.close();

console.log('\nan Android phone whose browser has not offered');
({ ctx, page } = await open({ ...devices['Pixel 7'] }));
await page.click('.account-menu-btn');
await page.click('.account-menu-item[data-act="install"]');
await page.waitForSelector('.install-steps');
ok('it says the browser has not offered, and points at its own menu',
  [/has not offered to install/.test(await page.textContent('.install-why')), /Install app, or Add to Home screen/.test(await page.textContent('.install-steps'))], [true, true]);
await ctx.close();

console.log('\nan Android phone that already has it, opened in the browser');
({ ctx, page } = await open({ ...devices['Pixel 7'] }, () => {
  navigator.getInstalledRelatedApps = () => Promise.resolve([{ platform: 'webapp', url: location.origin + '/manifest.webmanifest' }]);
}));
await page.click('.account-menu-btn');
await page.click('.account-menu-item[data-act="install"]');
await page.waitForSelector('.install-why');
ok('it says so, rather than giving steps for something done',
  [await page.textContent('.modal-title'), /Open it from your home screen/.test(await page.textContent('.install-why')), await page.$('.install-steps')],
  ['SendOff is already on this phone', true, null]);
await ctx.close();

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
