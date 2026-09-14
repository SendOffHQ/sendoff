// Inviting somebody to the hub, and resetting their password, as emails they
// will actually open.
//
// Two panels on the admin page generate the same account invite. The requests
// queue, which handles invites people asked for, has offered the branded
// message since it shipped: Open in Gmail, Copy branded email, Open in mail
// app, Copy link. "Invite someone to the hub", which is where an invite is
// typed in by hand, offered Copy link and nothing else.
//
// So the same invite went out branded or as a bare signup URL depending on
// which box it was typed into, and a bare signup URL from somebody you half
// know reads like phishing to a person who has never heard of SendOff, which
// is everybody being invited to the hub.
//
// The password reset panel beside it had the same gap and is worse in one way:
// somebody locked out is already unsure, and a bare reset URL in an inbox is
// exactly the shape of the mail people are told their whole life not to click.
//
// The message is rendered by the worker and never by the page. What this asks
// is what the page is responsible for, which is carrying it.
//
//   node test/hub-invite-mail.mjs
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
  console.log(`  ${q?'ok  ':'FAIL'} ${l.padEnd(52)} ${JSON.stringify(g)}${q?'':' want '+JSON.stringify(w)}`)};

// The clipboard is the whole point of the button, so the test reads it rather
// than stubbing it: a stub would pass against a button that writes nothing.
const ctx = await b.newContext({ viewport:{width:390,height:844}, serviceWorkers:'block',
  permissions: ['clipboard-read', 'clipboard-write'] });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(BASE + '/index.html');
await page.evaluate(base => localStorage.setItem('race-hub-session-v1', JSON.stringify({
  session:'stub', proxyUrl: base + '/api', email:'admin@example.com', role:'admin',
  expiresAt: Date.now() + 7*24*3600e3 })), BASE);

const generate = async () => {
  await page.goto(BASE + '/admin.html');
  await page.waitForSelector('#inv-gen', { timeout: 20000 });
  await page.fill('#inv-email', 'friend@example.com');
  await page.click('#inv-gen');
  await page.waitForSelector('#inv-out .ok', { timeout: 20000 });
};
await generate();

console.log('\nevery way out the requests queue has, this panel has too');
const inOut = sel => page.locator('#inv-out ' + sel);
ok('open in Gmail', await inOut('[data-gmail]').count(), 1);
ok('copy the branded email', await inOut('[data-rich]').count(), 1);
ok('open the mail app', await inOut('a[href^="mailto:"]').count(), 1);
ok('and the bare link it always had', await inOut('[data-copy]').count(), 1);

console.log('\nand pressing it puts the message on the clipboard');
await page.click('#inv-out [data-rich]');
await page.waitForTimeout(600);
const clip = await page.evaluate(async () => {
  const items = await navigator.clipboard.read();
  const out = {};
  for (const it of items) {
    for (const type of it.types) {
      if (type === 'text/html' || type === 'text/plain') out[type] = await (await it.getType(type)).text();
    }
  }
  return out;
});
ok('as formatted markup, not as a link', /<h1|<img/.test(clip['text/html'] || ''), true);
ok('carrying the wordmark', (clip['text/html'] || '').includes('/brand/wordmark-email.png'), true);
ok('and the signup link itself', (clip['text/html'] || '').includes('account=stub-account'), true);
ok('with a plain-text flavour alongside', /account=stub-account/.test(clip['text/plain'] || ''), true);

// Pasting is a two-step thing and the button is the only place to say so.
console.log('\nand the button says what to do next');
ok('it confirms and prompts', await page.evaluate(() =>
  document.querySelector('#inv-out [data-rich]').textContent.trim()), 'Copied ✓ now paste it');

console.log('\nthe bare link still does its own job');
await page.click('#inv-out [data-copy]');
await page.waitForTimeout(400);
ok('the plain link, alone', await page.evaluate(() => navigator.clipboard.readText()),
   'http://localhost:8787/signup.html?account=stub-account');

// Gmail cannot be handed markup in a compose URL, so the branded message goes
// to the clipboard on the way out and the draft it opens is empty, ready to
// paste into. An href still carrying a plain-text body would mean the draft
// arrives pre-filled with the unbranded version and the paste has to fight it.
console.log('\nand Open in Gmail opens an empty draft to paste into');
ok('no body on the href', /[?&]body=/.test(await page.evaluate(() =>
  document.querySelector('#inv-out [data-gmail]').getAttribute('href'))), false);
ok('and it is a compose URL', /mail\.google\.com.*view=cm/.test(await page.evaluate(() =>
  document.querySelector('#inv-out [data-gmail]').getAttribute('href'))), true);

// The reset panel is the invite panel's sibling, wired the same way, and the
// two are asked the same questions because the failure was the same failure.
console.log('\nand a password reset, which had the same gap');
await page.goto(BASE + '/admin.html');
await page.waitForSelector('#reset-gen', { timeout: 20000 });
await page.fill('#reset-email', 'lockedout@example.com');
await page.click('#reset-gen');
await page.waitForSelector('#reset-out .ok', { timeout: 20000 });
const inReset = sel => page.locator('#reset-out ' + sel);
ok('every way out is offered there too',
   [await inReset('[data-gmail]').count(), await inReset('[data-rich]').count(),
    await inReset('a[href^="mailto:"]').count(), await inReset('[data-copy]').count()],
   [1, 1, 1, 1]);
await page.click('#reset-out [data-rich]');
await page.waitForTimeout(600);
const rclip = await page.evaluate(async () => {
  const items = await navigator.clipboard.read();
  for (const it of items) {
    if (it.types.includes('text/html')) return await (await it.getType('text/html')).text();
  }
  return '';
});
ok('and it is the reset message, not the invite', /Set a new password/.test(rclip), true);
ok('carrying the reset link', rclip.includes('reset=stub-reset'), true);

// An older worker returns the link and nothing else. Offering a button that
// could only fail is worse than not offering one, and the panel says why
// rather than going quiet.
console.log('\nand against a worker too old to render one');
await page.evaluate(base => fetch(base + '/api/account-invite-nomail'), BASE);
await page.waitForTimeout(200);
await generate();
ok('the link is still offered', await inOut('[data-copy]').count(), 1);
ok('the branded button is disabled, not missing', await page.evaluate(() => {
  const el = document.querySelector('#inv-out [data-rich]');
  return !!el && el.disabled;
}), true);
ok('and it says why', await page.evaluate(() =>
  /deploy the worker/i.test(document.querySelector('#inv-out [data-compose-help]').textContent)), true);

ok('nothing threw', errs, []);
await b.close();
console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
