// The racer profile page, in a real browser, on the Sangre de Cristo 100.
//
// What it has to get right: which races are yours, what they add up to, that
// an official time beats the logged one and a DNF is never a best, that
// records keep disciplines apart, and that linking a race and writing down a
// result both work from the page itself.
//
//   node test/profile-page.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net'; import fs from 'node:fs';
const BASE = 'http://localhost:8787';
const ME = 'crew@example.com';
const SANGRE = '000001-sangre-de-cristo-100';
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

const ctx = await b.newContext({ viewport: { width: 390, height: 900 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('dialog', d => d.accept());

console.log('\nsigned out');
await page.goto(BASE + '/profile.html');
await page.waitForSelector('#signin', { timeout: 15000 });
ok('asks you to sign in', await page.textContent('#body').then(t => /Sign in to see your races/.test(t)), true);
ok('and shows no buttons for a profile it has not got', await page.isVisible('#add-manual'), false);

await page.evaluate(base => localStorage.setItem('race-hub-session-v1', JSON.stringify({
  session: 'stub', proxyUrl: base + '/api', email: 'crew@example.com', role: 'owner',
  expiresAt: Date.now() + 7 * 24 * 3600e3 })), BASE);
// Link Sangre's runner to this account the way settings does: a config save.
await page.evaluate(async ([slug, me]) => {
  const env0 = await (await fetch(`/api/get?path=races/${slug}/config.json`, { headers: { Authorization: 'Bearer stub' } })).json();
  const cfg = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(env0.content), c => c.charCodeAt(0))));
  delete cfg.myRole;
  cfg.runners[0].email = me;
  await fetch('/api/commit', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer stub' },
    body: JSON.stringify({ path: `races/${slug}/config.json`, content: JSON.stringify(cfg), message: 'link' }) });
}, [SANGRE, ME]);
// The fixture race is short, fast test data: finished, it would be a 38 minute
// hundred and every best after it. Left out on its last leg, it is a race that
// counts toward the totals and never toward a record, which is the point of
// linking it here.
await page.evaluate(async () => {
  const env0 = await (await fetch('/api/get?path=races/zz-fixture-unlisted/data.json', { headers: { Authorization: 'Bearer stub' } })).json();
  const data = JSON.parse(atob(env0.content));
  for (const r of data.runners) { r.legs = (r.legs || []).slice(0, 2); if (r.legs[1]) delete r.legs[1].endTime; }
  await fetch('/api/commit', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer stub' },
    body: JSON.stringify({ path: 'races/zz-fixture-unlisted/data.json', content: JSON.stringify(data), message: 'unfinished' }) });
});

const totals = () => page.$$eval('.p-total', els => Object.fromEntries(els.map(e =>
  [e.querySelector('span').textContent, e.querySelector('b').textContent])));
const card = (name) => page.$$eval('article.p-card', (els, n) => {
  const el = els.find(e => e.querySelector('.p-race-name').textContent.trim() === n);
  if (!el) return null;
  return { chip: el.querySelector('.p-chip').textContent.trim(),
    stats: Object.fromEntries([...el.querySelectorAll('.p-stat')].map(s => [s.querySelector('span').textContent, s.querySelector('b').textContent])),
    text: el.textContent.replace(/\s+/g, ' ') };
}, name);
const bests = () => page.$$eval('.p-fam', els => els.map(e => ({
  family: e.querySelector('h3').textContent,
  rows: Object.fromEntries([...e.querySelectorAll('.p-best')].map(r => [r.querySelector('.k').textContent, r.querySelector('.v').textContent]))
})));

console.log('\nsigned in, with Sangre linked');
await page.goto(BASE + '/profile.html');
await page.waitForSelector('article.p-card', { timeout: 15000 });
const t1 = await totals();
ok('one race, one finish', [t1.Races, t1.Finished], ['1', '1']);
ok('its miles and climb', [t1.Miles, t1['Feet climbed']], ['101', '18,897']);
let s = await card('Sangre de Cristo 100');
ok('Sangre is finished', s && s.chip, 'Finished');
ok('with the logged time', s.stats['Logged time'], '35:41:15');
ok('and its time in aid stations', s.stats['In aid stations'], '02:55:18');
ok('intake per hour, honest about where the log stopped',
   Object.keys(s.stats).some(k => /Per hour, logged through leg \d+/.test(k)), true);
let bs = await bests();
ok('a best on foot, at 100 miles', bs.map(f => [f.family, f.rows['100 mile']]), [['On foot', '35:41:15']]);

console.log('\nthe race the page can tell is yours');
ok('the fixture race is offered to link', await page.$$eval('[data-link]', els => els.map(e => e.textContent)), ["I'm Test Racer"]);
await page.click('[data-link]');
await page.waitForFunction(() => document.querySelectorAll('article.p-card').length === 2, null, { timeout: 10000 });
ok('linking it puts it on the page', (await totals()).Races, '2');
ok('unfinished, so not a finish', (await totals()).Finished, '1');
ok('and it is no longer offered', await page.$$eval('[data-link]', els => els.length), 0);

console.log('\nwriting down how Sangre went');
await page.click(`[data-edit="${SANGRE}"]`);
await page.fill(`[data-form="${SANGRE}"] [name=official]`, '35h');
await page.click(`[data-form="${SANGRE}"] button[type=submit]`);
ok('a time that is not a time is refused on the page',
   await page.textContent(`[data-form="${SANGRE}"] [data-err]`).then(t => /hours:minutes:seconds/.test(t)), true);
await page.fill(`[data-form="${SANGRE}"] [name=official]`, '35:40:00');
await page.fill(`[data-form="${SANGRE}"] [name=placeOverall]`, '20');
await page.fill(`[data-form="${SANGRE}"] [name=fieldOverall]`, '60');
await page.fill(`[data-form="${SANGRE}"] [name=report]`, 'The second night is the fight.');
await page.fill(`[data-form="${SANGRE}"] [name=changeNext]`, 'Salt before the stomach turns.');
await page.click(`[data-form="${SANGRE}"] button[type=submit]`);
await page.waitForSelector(`[data-form="${SANGRE}"]`, { state: 'detached' });
s = await card('Sangre de Cristo 100');
ok('the official time is the one shown', s.stats['Official time'], '35:40:00');
ok('with the logged one noted beside it', /Logged on SendOff: 35:41:15/.test(s.text), true);
ok('the place', s.stats.Place || Object.values(s.stats).find(v => /of 60/.test(v)), '20 of 60 overall');
ok('and the report, with next time', /The second night is the fight\..*Next time: Salt before the stomach turns\./.test(s.text), true);
bs = await bests();
ok('the best is the official time now', bs[0].rows['100 mile'], '35:40:00');

console.log('\na race from before SendOff');
await page.click('#add-manual');
await page.fill('[data-form="new"] [name=official]', '28:00:00');
await page.click('[data-form="new"] button[type=submit]');
await page.waitForFunction(() => document.querySelector('[data-form="new"] [data-err]').textContent !== '', null, { timeout: 5000 }).catch(() => {});
ok('without a name it says so',
   await page.textContent('[data-form="new"] [data-err]').then(t => /name/.test(t)), true);
await page.fill('[data-form="new"] [name=name]', 'Leadville Trail 100');
await page.fill('[data-form="new"] [name=date]', '2025-08-16');
await page.fill('[data-form="new"] [name=distanceMi]', '100.4');
await page.fill('[data-form="new"] [name=climbFt]', '15600');
await page.click('[data-form="new"] button[type=submit]');
await page.waitForSelector('[data-form="new"]', { state: 'detached' });
ok('it joins the list', !!(await card('Leadville Trail 100')), true);
ok('marked as entered by hand', /Entered by hand/.test((await card('Leadville Trail 100')).text), true);
bs = await bests();
ok('and a faster hundred becomes the best', bs[0].rows['100 mile'], '28:00:00');
ok('three races now', (await totals()).Races, '3');

console.log('\nother disciplines stay apart, and a DNF is never a best');
await page.click('#add-manual');
await page.fill('[data-form="new"] [name=name]', 'Unbound 200');
await page.fill('[data-form="new"] [name=date]', '2025-05-31');
await page.selectOption('[data-form="new"] [name=activity]', 'gravel-bike');
await page.fill('[data-form="new"] [name=distanceMi]', '200');
await page.fill('[data-form="new"] [name=official]', '13:30:00');
await page.click('[data-form="new"] button[type=submit]');
await page.waitForSelector('[data-form="new"]', { state: 'detached' });
await page.click('#add-manual');
await page.fill('[data-form="new"] [name=name]', 'Hardrock 100');
await page.fill('[data-form="new"] [name=date]', '2024-07-12');
await page.fill('[data-form="new"] [name=distanceMi]', '102.5');
await page.check('[data-form="new"] [name=dnf]');
await page.fill('[data-form="new"] [name=dnfWhere]', 'Ouray');
await page.click('[data-form="new"] button[type=submit]');
await page.waitForSelector('[data-form="new"]', { state: 'detached' });
bs = await bests();
ok('a bike card of its own, with no running distances on it',
   bs.map(f => [f.family, Object.keys(f.rows).filter(k => /mile|K$/.test(k))]), [['On foot', ['100 mile']], ['Bike', []]]);
ok('the 200 on a bike is not the furthest on foot', bs[0].rows.Furthest, '101.3 mi');
ok('the DNF did not become a best', bs[0].rows['100 mile'], '28:00:00');
const hr = await card('Hardrock 100');
ok('and says where it stopped', [hr.chip, hr.stats['Stopped at']], ['DNF', 'Ouray']);

console.log('\nfits a phone');
ok('no sideways scroll at 390px', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

console.log('\nthe menu goes here');
await page.goto(BASE + '/app/');
await page.waitForTimeout(1200);
ok('Profile in the account menu is this page',
   await page.$$eval('.account-menu-item', els => els.filter(e => e.textContent.trim() === 'Profile').map(e => e.getAttribute('href'))), ['/profile.html']);

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
