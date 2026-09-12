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
ok('nothing threw', errs, []);

await b.close();
console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
