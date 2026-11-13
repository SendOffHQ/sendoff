// What a race file may put on a page (2026-11-13).
//
// Found in review: the race's name went into the page title's markup
// unescaped, a racer's colour went straight into style attributes, the map's
// tooltips took names as HTML, and a fuel unit was glued onto numbers written
// as markup. Anybody who can write a race can put anything in those fields,
// and everyone who opens the race then runs it.
//
// So this writes a race where every free-text field is markup that would set
// window.__pwned if it were ever parsed, and opens each page that draws a
// race. None of it may run, none of it may become an element, and the text
// must still be there to read.
//
//   node test/hostile-names.mjs
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
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
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

const boom = (n) => `<img src=x onerror="window.__pwned=${n}">`;
const cfg = await api(`races/${SLUG}/config.json`); delete cfg.myRole;
const data = await api(`races/${SLUG}/data.json`);
cfg.name = `Hostile ${boom(1)} Hundred`;
cfg.location = `Nowhere ${boom(2)}`;
cfg.runners.forEach((r, i) => {
  r.name = `Racer ${i} ${boom(3)}`;
  r.color = `red;" onmouseover="window.__pwned=4" data-x="`;
});
const segs = (cfg.course && cfg.course.segments) || [];
segs.forEach((s, i) => { s.name = `Leg ${i} ${boom(5)}`; if (s.toAid) s.toAid = `${s.toAid} ${boom(6)}`; });
cfg.fuelMetrics = [
  { key: 'calories', label: `Calories ${boom(7)}`, unit: boom(8), short: `Cal ${boom(9)}` },
  { key: 'x" onclick="window.__pwned=10', label: 'Bad key', unit: 'g', short: 'Bad' }];
cfg.fuelPresets = [{ name: `Gel ${boom(11)}`, values: { calories: 100 } }];
// A racer in data.json alone, whose id is markup.
data.runners.push({ id: 'x" onmouseover="window.__pwned=12', legs: [] });
// And somebody on course, so the Live tile and the map have a name to draw.
const first = data.runners[0];
const t0 = new Date(cfg.startTime).getTime();
first.legs = [{ index: 1, startTime: new Date(t0).toISOString(), endTime: new Date(t0 + 3600e3).toISOString(), calories: 200 },
              { index: 2, startTime: new Date(t0 + 3700e3).toISOString() }];
await api(`races/${SLUG}/config.json`, cfg);
await api(`races/${SLUG}/data.json`, data);

const errs = [];
page.on('pageerror', e => errs.push(e.message));
const check = async (label, url, ready) => {
  console.log(`\n${label}`);
  await page.goto(BASE + url);
  await page.waitForSelector(ready, { timeout: 20000, state: 'attached' });
  await page.waitForTimeout(600);
  // Move the mouse over every card: an injected onmouseover needs a hover.
  for (const el of await page.$$('article.runner, .legend-dot, .runner-dot')) { try { await el.hover({ timeout: 500, force: true }); } catch (e) {} }
  const got = await page.evaluate(() => ({
    ran: window.__pwned === undefined ? null : window.__pwned,
    imgs: document.querySelectorAll('img[src="x"]').length,
    handlers: [...document.querySelectorAll('*')].filter(e =>
      [...e.attributes].some(a => /^on/i.test(a.name) && /__pwned/.test(a.value))).length,
    text: document.body.innerText
  }));
  ok('nothing in the race file ran', got.ran, null);
  ok('none of it became an element', got.imgs, 0);
  ok('or a handler on one', got.handlers, 0);
  return got.text;
};

let text = await check('the race page', `/race.html?id=${SLUG}`, 'article.runner');
ok('the name is still there to read, as text', /Hostile <img src=x/i.test(text), true);
ok('and the racer\'s', /Racer 0 <img/i.test(text), true);
ok('the racer whose id is markup is left off', await page.$$eval('article.runner', a => a.length), cfg.runners.length);
ok('a colour that is not one falls back to the accent',
  await page.$eval('article.runner', a => a.style.getPropertyValue('--runner-color').trim()), 'var(--accent)');

text = await check('the crew page', `/pit.html?id=${SLUG}`, 'article.runner');
ok('names read as text', /Racer 0 <img/i.test(text), true);

await check('the racer screen', `/racer.html?id=${SLUG}&me=${encodeURIComponent(cfg.runners[0].id)}`, '#act');
await check('the charts', `/charts.html?id=${SLUG}`, '#chart-cum');
text = await check('the printed report', `/print-report.html?id=${SLUG}`, 'article.runner');
ok('the title reads as text', /Hostile <img src=x/i.test(text), true);
await check('settings', `/settings.html?id=${SLUG}`, '#runner-table tbody tr');
ok('the colour box holds a colour', await page.$eval('#runner-table input[type="color"]', i => /^#[0-9a-f]{6}$/i.test(i.value)), true);

ok('no page threw', errs, []);
await b.close();
console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
