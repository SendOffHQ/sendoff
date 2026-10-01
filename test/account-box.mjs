// The Account box, from the menu: who you are signed in as, and connecting
// or disconnecting Google and Facebook.
//
// Google's script and Facebook's SDK are stood in for, as in
// google-signin.mjs and facebook-signin.mjs; the worker's own rules are in
// worker/test/auth-links.mjs.
//
//   node test/account-box.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net'; import fs from 'node:fs';
const BASE = 'http://localhost:8787';
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
await ctx.route('https://accounts.google.com/gsi/client', route => route.fulfill({
  status: 200, contentType: 'application/javascript', body: `
    window.google = { accounts: { id: {
      initialize(cfg) { window.__gsiConfig = cfg; },
      renderButton(el) { el.innerHTML = '<button type="button" class="fake-gsi">Continue with Google</button>'; },
      prompt() {}
    } } };
    window.__fireGoogle = (credential) => window.__gsiConfig.callback({ credential });` }));
await ctx.route('https://connect.facebook.net/en_US/sdk.js', route => route.fulfill({
  status: 200, contentType: 'application/javascript', body: `
    window.FB = { init() {}, login(cb) { cb(window.__fbAnswer || { authResponse: null }); } };
    setTimeout(() => window.fbAsyncInit && window.fbAsyncInit(), 0);` }));
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('dialog', d => d.accept());

await page.goto(BASE + '/profile.html');
await page.evaluate(base => localStorage.setItem('race-hub-session-v1', JSON.stringify({
  session: 'stub', proxyUrl: base + '/api', email: 'crew@example.com', role: 'owner',
  expiresAt: Date.now() + 7 * 24 * 3600e3 })), BASE);

const rows = () => page.$$eval('.modal-box .acct-row', els => els.map(e =>
  [e.querySelector('b').textContent, e.querySelector('.acct-row-main span').textContent]));
const msg = () => page.textContent('.modal-box .modal-msg');
const openAccount = async () => {
  await page.goto(BASE + '/profile.html');
  await page.waitForSelector('.account-menu-btn', { timeout: 15000 });
  await page.click('.account-menu-btn');
  await page.click('[data-act="account"]');
  await page.waitForSelector('.modal-box .acct-row', { timeout: 10000 });
  await page.waitForTimeout(500);
};

console.log('\nthe menu');
await page.goto(BASE + '/profile.html');
await page.waitForSelector('.account-menu-btn', { timeout: 15000 });
await page.click('.account-menu-btn');
ok('has Account, and no separate Password item',
   [await page.isVisible('[data-act="account"]'), await page.$$eval('[data-act="password"]', e => e.length)], [true, 0]);

console.log('\nwith only passwords on this site');
await openAccount();
ok('says who you are', (await page.textContent('.acct-who')).trim(), 'Signed in as crew@example.com');
ok('and lists only the password', await rows(), [['Password', 'Always on']]);
await page.click('[data-acct-password]');
await page.waitForSelector('#pw-current');
ok('Change opens the password box', await page.isVisible('#pw-current'), true);

console.log('\nwith Google and Facebook on');
await page.evaluate(async () => { await fetch('/api/google-on'); await fetch('/api/facebook-on'); });
await openAccount();
ok('both listed, not connected', await rows(), [['Password', 'Always on'], ['Google', 'Not connected'], ['Facebook', 'Not connected']]);
await page.waitForSelector('.acct-connect .fake-gsi', { timeout: 5000 }).catch(() => {});
await page.waitForSelector('.signin-fb.acct-connect:not([disabled])', { timeout: 5000 }).catch(() => {});
ok('each with a way to connect', [await page.isVisible('.acct-connect .fake-gsi'), await page.isVisible('.signin-fb.acct-connect')], [true, true]);

console.log('\nconnecting');
await page.evaluate(() => window.__fireGoogle('other'));
await page.waitForTimeout(500);
ok('a Google account with another address is refused, saying why', /is for other@example.com, not crew@example.com/.test(await msg()), true);
await page.evaluate(() => window.__fireGoogle('garbage'));
await page.waitForTimeout(500);
ok('a token that fails does not sign you out',
   await page.evaluate(() => !!localStorage.getItem('race-hub-session-v1')), true);
await page.evaluate(() => window.__fireGoogle('good'));
await page.waitForSelector('[data-acct-remove="google"]', { timeout: 5000 }).catch(() => {});
ok('the right one connects', (await rows())[1], ['Google', `Connected since ${await page.evaluate(() =>
   new Date('2026-10-01T15:00:00Z').toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }))}`]);
ok('and says so', /Google connected/.test(await msg()), true);
await page.evaluate(() => { window.__fbAnswer = { authResponse: { accessToken: 'good' } }; });
await page.click('.signin-fb.acct-connect');
await page.waitForSelector('[data-acct-remove="facebook"]', { timeout: 5000 }).catch(() => {});
ok('Facebook connects the same way', (await rows())[2][1].startsWith('Connected'), true);

console.log('\ndisconnecting');
await page.click('[data-acct-remove="google"]');
await page.waitForTimeout(600);
ok('Google is taken off', (await rows())[1], ['Google', 'Not connected']);
ok('and it says so', await msg(), 'Google disconnected.');
ok('Facebook stays', (await rows())[2][1].startsWith('Connected'), true);
await openAccount();
ok('and it holds after a reload', (await rows()).map(r => r[1].split(' ')[0]), ['Always', 'Not', 'Connected']);
ok('Done closes the box', await page.click('.modal-box .modal-primary').then(() => page.isVisible('.modal-box')), false);

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
