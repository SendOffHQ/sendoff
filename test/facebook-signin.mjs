// The Facebook button in the sign-in box, in a real browser.
//
// Facebook's SDK is stood in for, as Google's script is in google-signin.mjs:
// a real one needs a real app and a real Facebook account, and what is under
// test is what the page does with what Facebook hands it. The stand-in's
// FB.login answers with whatever the test sets in window.__fbAnswer.
//
//   node test/facebook-signin.mjs
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
let sdkLoads = 0, blockSdk = false;
await ctx.route('https://connect.facebook.net/en_US/sdk.js', route => {
  if (blockSdk) return route.abort('blockedbyclient');
  sdkLoads++;
  route.fulfill({ status: 200, contentType: 'application/javascript', body: `
    window.FB = {
      init(cfg) { window.__fbConfig = cfg; },
      login(cb, opts) { window.__fbLoginOpts = opts; cb(window.__fbAnswer || { status: 'unknown', authResponse: null }); }
    };
    setTimeout(() => window.fbAsyncInit && window.fbAsyncInit(), 0);` });
});
await ctx.route('https://accounts.google.com/gsi/client', route => route.abort('blockedbyclient'));
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
const tapAs = async (answer) => {
  await page.evaluate(a => { window.__fbAnswer = a; }, answer);
  await page.click('.signin-fb');
  await page.waitForTimeout(600);
  return page.textContent('.modal-msg');
};

console.log('\nwith Facebook switched off');
await openSignin();
ok('no Facebook button', await page.isVisible('.signin-fb'), false);
ok('no divider either', await page.isVisible('.signin-or'), false);
ok('and Facebook\'s SDK is never loaded', sdkLoads, 0);

console.log('\nwith it on');
await page.evaluate(() => fetch('/api/facebook-on'));
await openSignin();
await page.waitForSelector('.signin-fb:not([disabled])', { timeout: 5000 }).catch(() => {});
ok('the button is drawn, and ready', [await page.isVisible('.signin-fb'), await page.isEnabled('.signin-fb')], [true, true]);
ok('saying what it does', (await page.textContent('.signin-fb')).trim(), 'Continue with Facebook');
ok('above the password, with a divider', await page.textContent('.signin-or'), 'or with your password');
ok('for the app id the worker gave', await page.evaluate(() => window.__fbConfig.appId), '123456789');
ok('with no Facebook cookie or login check on load',
   await page.evaluate(() => [window.__fbConfig.cookie, window.__fbConfig.status]), [false, false]);
ok('Google, which did not load, leaves no gap', await page.isVisible('.signin-google'), false);

console.log('\nwhat Facebook can hand back');
ok('closing the popup says so', await tapAs(null), 'Facebook sign-in was cancelled.');
ok('asking for the email address, again if it was refused before',
   await page.evaluate(() => window.__fbLoginOpts), { scope: 'email', auth_type: 'rerequest' });
ok('no email shared: pointed at the password',
   /did not share an email.*password/.test(await tapAs({ status: 'connected', authResponse: { accessToken: 'noemail' } })), true);
ok('an address with no account: told how to get one',
   /no SendOff account.*invite/.test(await tapAs({ status: 'connected', authResponse: { accessToken: 'nobody' } })), true);
ok('and not signed in by any of it', await page.evaluate(() => !!localStorage.getItem('race-hub-session-v1')), false);

console.log('\nan account holder');
await page.evaluate(() => { window.__fbAnswer = { status: 'connected', authResponse: { accessToken: 'good' } }; });
await Promise.all([page.waitForNavigation({ timeout: 10000 }), page.click('.signin-fb')]);
await page.waitForSelector('#actions:not([hidden])', { timeout: 15000 }).catch(() => {});
const sess = await page.evaluate(() => JSON.parse(localStorage.getItem('race-hub-session-v1') || 'null'));
ok('is signed in, with the same session a password gives', [!!sess, sess && sess.email, sess && sess.session], [true, 'crew@example.com', 'stub']);
ok('and the page reloads signed in', await page.isVisible('#add-manual'), true);
ok('the SDK loaded once', sdkLoads, 1);
ok('no page errors', errs, []);

console.log('\nwhen a blocker stops Facebook\'s SDK');
const ctx2 = await b.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
await ctx2.route('https://connect.facebook.net/**', route => route.abort('blockedbyclient'));
await ctx2.route('https://accounts.google.com/**', route => route.abort('blockedbyclient'));
const p2 = await ctx2.newPage();
await p2.goto(BASE + '/profile.html');
await p2.waitForSelector('#signin', { timeout: 15000 });
await p2.click('#signin');
await p2.waitForSelector('#si-email');
await p2.waitForTimeout(1200);
ok('no dead button and no lone divider', [await p2.isVisible('.signin-fb'), await p2.isVisible('.signin-social')], [false, false]);
ok('the password form is there as ever', await p2.isVisible('#si-password'), true);

await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
