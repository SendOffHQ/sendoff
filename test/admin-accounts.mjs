// The admin page's accounts list, opened: an account's races sit under its
// header at full width, and the admin can give the account a name of their own.
//
// Reported 2026-10-14: an opened account put its races beside the header in a
// sliver of a column, so "2026 Hennepin 100" read one or two letters a line.
// The theme gives .acct-row display:flex for the account box's own rows.
//
//   node test/admin-accounts.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net'; import fs from 'node:fs';
const BASE = 'http://localhost:8787';
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
for (const width of [1280, 390]) {
  const ctx = await b.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push(e.message));
  await page.goto(BASE + '/index.html');
  await page.evaluate(base => localStorage.setItem('race-hub-session-v1', JSON.stringify({
    session: 'stub', proxyUrl: base + '/api', email: 'admin@example.com', role: 'admin',
    expiresAt: Date.now() + 7 * 864e5 })), BASE);
  await page.goto(BASE + '/admin.html');
  await page.waitForSelector('.acct-row[data-email="crew@example.com"] .acct-head', { timeout: 20000 });
  await page.click('.acct-row[data-email="crew@example.com"] .acct-head');
  await page.waitForSelector('.acct-row[data-email="crew@example.com"] .race-row a', { timeout: 10000 });

  console.log(`\nan opened account, ${width}px wide`);
  const geo = await page.evaluate(() => {
    const row = document.querySelector('.acct-row[data-email="crew@example.com"]');
    const head = row.querySelector('.acct-head').getBoundingClientRect();
    const box = row.querySelector('.acct-races').getBoundingClientRect();
    const a = row.querySelector('.race-row a');
    // Wide enough to read: the bug gave it two characters. On a phone it may
    // wrap between words, never inside one.
    return { below: box.top >= head.bottom - 1, full: Math.abs(box.width - row.getBoundingClientRect().width) <= 2,
             oneLine: a.getBoundingClientRect().width >= Math.min(140, a.scrollWidth) };
  });
  ok('its races sit under it, not beside it', geo.below, true);
  ok('across the whole row', geo.full, true);
  ok('and a race name has room to read', geo.oneLine, true);
  ok('nothing is wider than the screen', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (process.argv[2]) await page.screenshot({ path: `${process.argv[2]}/acct-${width}.png` });

  if (width === 1280) {
    console.log('\nnaming it');
    ok('the name box starts with the name it has', await page.inputValue('.acct-row[data-email="crew@example.com"] [data-name-input]'), 'Casey Kim');
    await page.fill('.acct-row[data-email="crew@example.com"] [data-name-input]', 'Casey K. (crew chief)');
    await page.click('.acct-row[data-email="crew@example.com"] [data-name-save]');
    await page.waitForFunction(() => /Saved/.test(document.querySelector('.acct-row[data-email="crew@example.com"] [data-name-hint]').textContent), null, { timeout: 10000 });
    const sent = await page.evaluate(base => fetch(base + '/api/last-name').then(r => r.json()), BASE);
    ok('goes to the worker for that account', [sent.email, sent.name], ['crew@example.com', 'Casey K. (crew chief)']);
    ok('and the row says it at once', await page.textContent('.acct-row[data-email="crew@example.com"] .acct-name'), 'Casey K. (crew chief)');
    ok('without closing the account', await page.$$eval('.acct-row[data-email="crew@example.com"] .acct-races', x => x.length), 1);

    console.log('\nan account with no name yet');
    await page.click('.acct-row[data-email="nameless@example.com"] .acct-head');
    await page.waitForSelector('.acct-row[data-email="nameless@example.com"] [data-name-input]', { timeout: 10000 });
    await page.fill('.acct-row[data-email="nameless@example.com"] [data-name-input]', 'Nia Noname');
    await page.press('.acct-row[data-email="nameless@example.com"] [data-name-input]', 'Enter');
    await page.waitForSelector('.acct-row[data-email="nameless@example.com"] .acct-name', { timeout: 10000 });
    ok('Enter saves it too, and the name appears', await page.textContent('.acct-row[data-email="nameless@example.com"] .acct-name'), 'Nia Noname');
  }
  await ctx.close();
}
ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
