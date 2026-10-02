// Public racer profiles in a real browser: the switch on your own profile
// page, the switches on each race, and the page a stranger sees at /@name.
//
// The worker's rules about what a public profile may hold are in
// worker/test/public-profile.mjs; this is the pages.
//
//   node test/public-profile-page.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net'; import fs from 'node:fs';
const BASE = 'http://localhost:8787';
const SANGRE = '000001-sangre-de-cristo-100';
const UNLISTED = 'zz-fixture-unlisted';
const ME = 'crew@example.com';
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

const ctx = await b.newContext({ viewport: { width: 900, height: 1100 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(BASE + '/profile.html');
await page.evaluate(async ([base, me, slugs]) => {
  localStorage.setItem('race-hub-session-v1', JSON.stringify({ session: 'stub', proxyUrl: base + '/api',
    email: me, role: 'owner', expiresAt: Date.now() + 7 * 24 * 3600e3 }));
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer stub' };
  await fetch('/api/profile', { method: 'POST', headers: H, body: JSON.stringify({ displayName: 'Jason Dupree' }) });
  // This account is the racer on Sangre (public) and on the unlisted fixture.
  for (const slug of slugs) {
    const env0 = await (await fetch(`/api/get?path=races/${slug}/config.json`, { headers: H })).json();
    const cfg = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(env0.content), c => c.charCodeAt(0))));
    delete cfg.myRole; cfg.runners[0].email = me;
    await fetch('/api/commit', { method: 'POST', headers: H, body: JSON.stringify({ path: `races/${slug}/config.json`, content: JSON.stringify(cfg), message: 'link' }) });
  }
}, [BASE, ME, [SANGRE, UNLISTED]]);
const openMine = async () => { await page.goto(BASE + '/profile.html'); await page.waitForSelector('#pubprof:not([hidden])', { timeout: 15000 }); await page.waitForTimeout(300); };
const card = (name) => page.$$eval('article.p-card', (els, n) => {
  const el = els.find(e => e.querySelector('.p-race-name').textContent.trim() === n);
  const pub = el && el.querySelector('.p-race-pub');
  return pub ? pub.textContent.replace(/\s+/g, ' ').trim() : null;
}, name);

console.log('\nyour own profile page');
await openMine();
ok('the switch is there, off', [await page.isVisible('#pub-on'), await page.isChecked('#pub-on')], [true, false]);
ok('and cannot go on without a username', [await page.isDisabled('#pub-on'), /Pick a username first/.test(await page.textContent('#pubprof'))], [true, true]);
ok('no race carries public switches while it is off', await card('Sangre de Cristo 100'), null);
await page.click('#uname-pick').catch(() => {});
await page.fill('#uname-input', 'jason');
await page.click('#uname-save');
await page.waitForSelector('#pub-on:not([disabled])', { timeout: 5000 });
ok('a username makes it possible', await page.isDisabled('#pub-on'), false);
await page.click('#pub-on');
await page.waitForSelector('#pub-link', { timeout: 5000 });
ok('on: the address, made from the username', await page.textContent('#pub-link'), 'sendoff.run/@jason');
ok('and what it shows, and never shows', /Private and unlisted races never appear, not even in the totals/.test(await page.textContent('#pubprof')), true);
ok('search engines left out until ticked', await page.isChecked('#pub-index'), false);
ok('a listed public race: shown, report and fueling off', await card('Sangre de Cristo 100'), 'Public profile Shown Report Fueling');
ok('an unlisted race says it never appears', await card('Fixture Unlisted Race'), 'Public profile Private or unlisted race: never shown there.');
await page.click('article.p-card [data-pub="hide"]');
await page.waitForTimeout(300);
ok('a race can be hidden', await card('Sangre de Cristo 100'), 'Public profile Hidden');
await page.click('article.p-card [data-pub="hide"]');
await page.waitForTimeout(300);
ok('and shown again', await card('Sangre de Cristo 100'), 'Public profile Shown Report Fueling');

console.log('\nwhat a stranger sees');
const anon = await (await b.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' })).newPage();
anon.on('pageerror', e => errs.push(e.message));
await anon.goto(BASE + '/@jason');
await anon.waitForSelector('article.p-card', { timeout: 15000 });
ok('the racer\'s name, at their @', [await anon.textContent('#who'), await anon.title()], ['Jason Dupree', 'Jason Dupree · SendOff']);
ok('and the header says whose', (await anon.textContent('.brand-meta')).replace(/\s+/g, ' ').includes('@jason'), true);
ok('without the private page\'s label', /Profile/.test(await anon.textContent('.brand-meta')), false);
ok('their public race', await anon.$$eval('article.p-card .p-race-name', els => els.map(e => e.textContent.trim())), ['Sangre de Cristo 100']);
ok('totals and bests, read only: no edit, no forms, no switches',
   [await anon.isVisible('.p-totals'), await anon.$$eval('[data-edit], form, [data-pub], #actions:not([hidden])', e => e.length)], [true, 0]);
ok('no sign-in needed, and no "only you can see this"', /A racer profile on SendOff/.test(await anon.textContent('#foot')), true);
ok('kept out of search engines', await anon.getAttribute('#robots-meta', 'content'), 'noindex, nofollow');
ok('the same page at /u/jason', await anon.goto(BASE + '/u/jason').then(() => anon.waitForSelector('#who')).then(() => anon.waitForFunction(() => document.querySelector('#who').textContent === 'Jason Dupree', null, { timeout: 8000 }).then(() => true, () => false)), true);

console.log('\nchanges on your page reach it');
await page.click('#pub-index');
await page.waitForTimeout(300);
await anon.goto(BASE + '/@jason'); await anon.waitForSelector('article.p-card', { timeout: 15000 });
ok('search engines, once ticked', await anon.$('#robots-meta'), null);
await page.click('#pub-on');
await page.waitForTimeout(300);
await anon.goto(BASE + '/@jason'); await anon.waitForFunction(() => /Not/.test(document.querySelector('#who').textContent), null, { timeout: 8000 }).catch(() => {});
const offText = (await anon.textContent('#body')).replace(/\s+/g, ' ').trim();
ok('switched off, the address finds nothing', offText, 'There is no public profile at this address. Either nobody has this username, or its owner has not made their profile public.');
await anon.goto(BASE + '/@nobody_at_all'); await anon.waitForFunction(() => /Not/.test(document.querySelector('#who').textContent), null, { timeout: 8000 }).catch(() => {});
ok('the same words as a username nobody has', (await anon.textContent('#body')).replace(/\s+/g, ' ').trim(), offText);

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
