// The Google button in the sign-in box, in a real browser.
//
// Google's script is stood in for: a real one needs a real client id and a
// real Google account, and what is under test is what the page does with
// what Google hands it. The stand-in draws a button and exposes the callback,
// so a test can play Google's part.
//
//   node test/google-signin.mjs
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
  console.log(`  ${q?'ok  ':'FAIL'} ${l.padEnd(56)} ${JSON.stringify(g)}${q?'':' want '+JSON.stringify(w)}`)};

const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
let scriptLoads = 0;
await ctx.route('https://accounts.google.com/gsi/client', route => { scriptLoads++; route.fulfill({
  status: 200, contentType: 'application/javascript', body: `
    window.google = { accounts: { id: {
      initialize(cfg) { window.__gsiConfig = cfg; },
      renderButton(el) { el.innerHTML = '<button type="button" class="fake-gsi">Continue with Google</button>'; },
      prompt() {}
    } } };
    window.__fireGoogle = (credential) => window.__gsiConfig.callback({ credential });` }); });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));

const openSignin = async () => {
  await page.goto(BASE + '/profile.html');
  await page.waitForSelector('#signin', { timeout: 15000 });
  await page.click('#signin');
  await page.waitForSelector('#si-email');
  await page.waitForTimeout(600);
};

console.log('\nwith Google switched off');
await openSignin();
ok('no Google button', await page.isVisible('.signin-google'), false);
ok('and Google\'s script is never loaded', scriptLoads, 0);
ok('the password form is there as ever', await page.isVisible('#si-password'), true);

console.log('\nwith it on');
await page.evaluate(() => fetch('/api/google-on'));
await openSignin();
await page.waitForSelector('.fake-gsi', { timeout: 5000 }).catch(() => {});
ok('the button is drawn', await page.isVisible('.fake-gsi'), true);
ok('above the password, with a divider', await page.textContent('.signin-or'), 'or with your password');
ok('for the client id the worker gave', await page.evaluate(() => window.__gsiConfig.client_id), 'test-client.apps.googleusercontent.com');

console.log('\nan address with no account');
await page.evaluate(() => window.__fireGoogle('nobody'));
await page.waitForTimeout(600);
const msg = await page.textContent('.modal-msg');
ok('is told why, and how to get one', /no SendOff account.*invite/.test(msg), true);
ok('and is not signed in', await page.evaluate(() => !!localStorage.getItem('race-hub-session-v1')), false);

console.log('\nan account holder');
await Promise.all([
  page.waitForNavigation({ timeout: 10000 }),
  page.evaluate(() => window.__fireGoogle('good'))
]);
await page.waitForSelector('#actions:not([hidden])', { timeout: 15000 }).catch(() => {});
const sess = await page.evaluate(() => JSON.parse(localStorage.getItem('race-hub-session-v1') || 'null'));
ok('is signed in, with the same session a password gives', [!!sess, sess && sess.email, sess && sess.session], [true, 'crew@example.com', 'stub']);
ok('and the page reloads signed in', await page.isVisible('#add-manual'), true);
ok('Google\'s script loaded once', scriptLoads, 1);

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
