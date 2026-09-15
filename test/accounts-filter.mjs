// Finding one person in the accounts list.
//
// The list was every account, in one column, sorted by address, with no way to
// narrow it. That is fine at ten accounts and not at a hundred, and an address
// is a poor thing to scan for somebody by: a profile now holds a real name, so
// the row shows it and the search reads both.
//
// Filtering is done in the page against the list already fetched. The endpoint
// reads a profile per account, so a request per keystroke would be a lot of
// work to narrow a list that is already in hand.
//
//   node test/accounts-filter.mjs
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

const ctx = await b.newContext({ viewport:{width:390,height:844}, serviceWorkers:'block' });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
let apiCalls = 0;
page.on('request', r => { if (r.url().includes('/api/accounts')) apiCalls++; });
await page.goto(BASE + '/index.html');
await page.evaluate(base => localStorage.setItem('race-hub-session-v1', JSON.stringify({
  session:'stub', proxyUrl: base + '/api', email:'admin@example.com', role:'admin',
  expiresAt: Date.now() + 7*24*3600e3 })), BASE);
await page.goto(BASE + '/admin.html');
await page.waitForSelector('#acct-list .acct-row', { timeout: 20000 });

const shown = () => page.evaluate(() =>
  [...document.querySelectorAll('#acct-list .acct-row')].map(r => r.dataset.email));
const count = () => page.evaluate(() => document.getElementById('acct-count').textContent.trim());
const set = async (id, v) => { await page.selectOption('#' + id, v); await page.waitForTimeout(150); };
const type = async (v) => { await page.fill('#acct-search', v); await page.waitForTimeout(150); };

console.log('\nthe list as it arrives');
ok('everybody', (await shown()).length, 4);
ok('and says so', await count(), '4 accounts');

console.log('\nthe name is on the row, where an address used to be alone');
ok('for somebody who filled their profile in', await page.evaluate(() =>
  document.querySelector('[data-email="jason@example.com"] .acct-name').textContent), 'Jason Dupree');
ok('and the address is still there to identify them', await page.evaluate(() =>
  document.querySelector('[data-email="jason@example.com"] .acct-email').textContent),
  'jason@example.com');
ok('nothing invented for somebody who has not', await page.evaluate(() =>
  document.querySelectorAll('[data-email="nameless@example.com"] .acct-name').length), 0);

console.log('\nsearching by name, which is what you have in mind');
await type('dupree');
ok('finds them', await shown(), ['jason@example.com']);
ok('and says what it narrowed', await count(), '1 of 4 accounts');

console.log('\nand by address, because sometimes that is what you have');
await type('crew@');
ok('finds them too', await shown(), ['crew@example.com']);

console.log('\nit does not care about case');
await type('ADA');
ok('still finds her', await shown(), ['admin@example.com']);

console.log('\nand says so plainly when nothing matches');
await type('nobody-by-that-name');
ok('no rows', (await shown()).length, 0);
ok('and it reads as a filter, not as an empty hub', await page.evaluate(() =>
  document.querySelector('#acct-list .muted').textContent.trim()), 'No account matches that.');
await type('');

console.log('\nfiltering by role');
await set('acct-role', 'admin');
ok('admins only', await shown(), ['admin@example.com']);
await set('acct-role', 'crew');
ok('and crew only', (await shown()).sort(),
   ['crew@example.com', 'jason@example.com', 'nameless@example.com']);
await set('acct-role', '');

console.log('\nand by plan');
await set('acct-plan-filter', 'pro');
ok('pro', (await shown()).sort(), ['admin@example.com', 'crew@example.com']);
await set('acct-plan-filter', 'free');
ok('free, both kinds', (await shown()).sort(),
   ['jason@example.com', 'nameless@example.com']);

// Nearly everyone signing up today is grandfathered in, so the capped one is
// the account that actually sees the limits and is worth being able to find.
console.log('\nand free with early access is not the same as free without it');
await set('acct-plan-filter', 'free-early');
ok('grandfathered', await shown(), ['jason@example.com']);
await set('acct-plan-filter', 'free-capped');
ok('genuinely capped', await shown(), ['nameless@example.com']);

console.log('\nsearch and filters narrow together, not one or the other');
await set('acct-plan-filter', 'free');
await type('jason');
ok('both applied', await shown(), ['jason@example.com']);
await type('ada');
ok('and an admin is not free, so nothing', (await shown()).length, 0);
await type(''); await set('acct-plan-filter', '');

// A pending invite is somebody who is not an account yet: no role, no plan,
// nothing to filter on. Hiding it while a search is typed would make an invite
// look cancelled.
console.log('\npending invites are left out of all of it');
await type('zzz-matches-nothing');
ok('still listed', await page.evaluate(() =>
  [...document.querySelectorAll('#pending-list .pending-row .who')].map(e => e.textContent)),
  ['waiting@example.com']);
await type('');

console.log('\nand none of it asks the worker again');
ok('fetched once, filtered in the page', apiCalls, 1);

ok('nothing threw', errs, []);
await b.close();
console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
