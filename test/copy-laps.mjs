// Ran together: giving a racer who went the whole way beside another, and was
// not tracked, that racer's laps, from Settings. Asked for during the Ghost
// Train, where the second racer's crew had not realised it was a manual
// tracker and logged nothing. The copy itself is Race.laps, in
// test/timed-course.mjs; this is the page.
//
//   node test/copy-laps.mjs
import { chromium } from 'playwright';
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
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
page.on('pageerror', e => errs.push(e.message));
await page.goto(BASE + '/index.html');
await page.evaluate(base => {
  localStorage.setItem('race-hub-session-v1', JSON.stringify({ session: 'stub', proxyUrl: base + '/api',
    email: 'crew@example.com', role: 'owner', expiresAt: Date.now() + 7 * 24 * 3600e3 }));
  localStorage.setItem('race-hub-tutorial-v1', JSON.stringify({ racer: 99, pit: 99, race: 99, settings: 99 }));
}, BASE);
const api = (path, body) => page.evaluate(async ([path, body]) => {
  if (!body) {
    const r = await (await fetch(`/api/get?path=${path}`, { headers: { Authorization: 'Bearer stub' } })).json();
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(r.content), c => c.charCodeAt(0))));
  }
  await fetch('/api/commit', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer stub' },
    body: JSON.stringify({ path, content: JSON.stringify(body), message: 'test' }) });
}, [path, body]);
const CFG = `races/${SLUG}/config.json`, DATA = `races/${SLUG}/data.json`;

// Joe, tracked, with what he ate on his legs; Alex, beside him, with nothing.
const cfg = await api(CFG); delete cfg.myRole;
cfg.runners = [{ id: 'joe', name: 'Joe' }, { id: 'alex', name: 'Alex' }];
await api(CFG, cfg);
const t = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const joe = { id: 'joe', legs: [
  { index: 1, startTime: t(5), endTime: t(4), calories: 200, preset_0: 2 },
  { index: 2, startTime: t(4), endTime: t(3) },
  { index: 3, startTime: t(2.9) }] };
await api(DATA, { runners: [joe, { id: 'alex', legs: [] }] });

const open = async () => {
  await page.goto(BASE + `/settings.html?id=${SLUG}`);
  await page.waitForSelector('#runner-editor-head', { timeout: 20000 });
  await page.click('#runner-editor-head');
  await page.waitForSelector('#copy-laps:not([hidden])', { timeout: 10000 });
};
const alexLegs = async () => ((await api(DATA)).runners.find(d => d.id === 'alex') || {}).legs || [];

console.log('\nin Settings, beside the racers');
await open();
ok('offered, giving the racer with nothing the laps of the one with most', [await page.inputValue('#copy-to'), await page.inputValue('#copy-from')], ['alex', 'joe']);
ok('and fits a phone', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
let asked = '';
page.once('dialog', d => { asked = d.message(); d.accept(); });
await page.click('#copy-laps-go');
await page.waitForFunction(() => /Done/.test(document.getElementById('copy-laps-note').textContent), null, { timeout: 10000 });
ok('it asks first, saying only the times go', /Give Alex Joe's 3 legs\?/.test(asked) && /Times only/.test(asked), true);
const got = await alexLegs();
ok('Alex has Joe\'s legs, at Joe\'s times', got.map(l => [l.index, l.startTime, l.endTime || null]), joe.legs.map(l => [l.index, l.startTime, l.endTime || null]));
ok('and none of what Joe ate', got.some(l => 'calories' in l || 'preset_0' in l), false);
ok('Joe keeps his', (await api(DATA)).runners.find(d => d.id === 'joe').legs[0].calories, 200);
ok('it says what it did, and what happens next', /Alex has Joe's 3 legs\. Laps from here on are logged for each of them/.test(await page.textContent('#copy-laps-note')), true);

console.log('\ncopied again later');
const d = await api(DATA);
d.runners.find(r => r.id === 'joe').legs.push({ index: 4, startTime: t(1) });
d.runners.find(r => r.id === 'joe').legs[2].endTime = t(1);
await api(DATA, d);
await open();
await page.selectOption('#copy-to', 'alex'); await page.selectOption('#copy-from', 'joe');
page.once('dialog', d => { asked = d.message(); d.accept(); });
await page.click('#copy-laps-go');
await page.waitForFunction(() => /Done/.test(document.getElementById('copy-laps-note').textContent), null, { timeout: 10000 });
ok('it says it replaces what is there', /Alex has 3 legs logged\. Replace them with Joe's 4\?/.test(asked), true);
ok('and brings Alex up to date', (await alexLegs()).length, 4);

console.log('\nthe same racer twice');
await page.selectOption('#copy-to', 'joe'); await page.selectOption('#copy-from', 'joe');
await page.click('#copy-laps-go');
ok('is turned away, and nothing is written', [await page.textContent('#copy-laps-note'), (await api(DATA)).runners.find(r => r.id === 'joe').legs.length], ['Pick two different racers.', 4]);

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
