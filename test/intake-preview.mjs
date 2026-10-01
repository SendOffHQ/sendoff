// Before the start: the intake panel is shown small, not left out.
//
// The panel needs a leg to log against, and there is none until the first
// send-off, so it used to be absent until then. Somebody new to SendOff had
// no way to know it was coming, or to check the race's one-tap items before
// race day. Now both screens show what is coming, and nothing can be logged.
//
//   node test/intake-preview.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net'; import fs from 'node:fs';
const BASE = 'http://localhost:8787';
const SLUG = 'zz-fixture-unlisted';
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
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(BASE + '/index.html');
await page.evaluate(base => {
  localStorage.setItem('race-hub-session-v1', JSON.stringify({ session: 'stub', proxyUrl: base + '/api',
    email: 'crew@example.com', role: 'owner', expiresAt: Date.now() + 7 * 24 * 3600e3 }));
  // Seen already: the tutorial is not what is under test, and on a phone it
  // pushes the cards down.
  localStorage.setItem('race-hub-tutorial-v1', JSON.stringify({ pit: 99, racer: 99 }));
}, BASE);

// The race, a week out: nobody sent off yet.
const edit = (file, fn) => page.evaluate(async ([slug, file, fnSrc]) => {
  const env0 = await (await fetch(`/api/get?path=races/${slug}/${file}`, { headers: { Authorization: 'Bearer stub' } })).json();
  const doc = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(env0.content), c => c.charCodeAt(0))));
  delete doc.myRole;
  const out = (0, eval)(fnSrc)(doc);
  await fetch('/api/commit', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer stub' },
    body: JSON.stringify({ path: `races/${slug}/${file}`, content: JSON.stringify(out), message: 'test' }) });
  return out;
}, [SLUG, file, fn.toString()]);
const cfg = await edit('config.json', c => {
  c.startTime = new Date(Date.now() + 7 * 864e5).toISOString();
  // A second racer, so one can be sent off while the other still waits.
  if (c.runners.length < 2) c.runners.push({ id: 'second', name: 'Second Racer' });
  return c;
});
await edit('data.json', d => { for (const r of d.runners) r.legs = []; return d; });
const [first, second] = cfg.runners;
const items = (cfg.fuelPresets || cfg.presets || []).map(p => p.name);

const card = (id) => `article.runner[data-runner="${id}"]`;
const openPit = async () => {
  await page.goto(BASE + `/pit.html?id=${SLUG}`);
  await page.waitForSelector(`${card(first.id)} .big-btn`, { timeout: 20000 });
  await page.waitForTimeout(400);
};

console.log('\nthe pit board, before anybody is sent off');
await openPit();
ok('every racer shows the panel, small', await page.$$eval('[data-intake-preview]', els => els.length), cfg.runners.length);
ok('with the race\'s items, as they will be',
   await page.$$eval(`${card(first.id)} .preset-chip.is-preview`, els => els.map(e => e.textContent.replace(/^\+\s*/, ''))), items);
ok('none of them pressable, and nothing to type in',
   await page.$$eval(`${card(first.id)} button.preset-chip, ${card(first.id)} [data-intake]`, els => els.length), 0);
ok('saying when it arrives, for whom',
   (await page.textContent(`${card(first.id)} .intake-preview-note`)).includes(`once ${first.name} is sent off`), true);
ok('with a way to change the items',
   await page.getAttribute(`${card(first.id)} .intake-preview-note a`, 'href'), `settings.html?id=${SLUG}#items`);
const box = await page.$eval(`${card(first.id)} [data-intake-preview]`, e => e.getBoundingClientRect().height);
ok('and small: under 140px on a phone', box < 140, true);

console.log('\nonce a racer is sent off');
await page.click(`${card(first.id)} .big-btn`);
await page.waitForSelector(`${card(first.id)} [data-intake-leg]`, { timeout: 10000 });
ok('their card has the real panel', [await page.isVisible(`${card(first.id)} [data-intake="notes"]`),
   await page.$$eval(`${card(first.id)} [data-intake-preview]`, els => els.length)], [true, 0]);
ok('with the items pressable', await page.$$eval(`${card(first.id)} button.preset-chip`, els => els.length), items.length);
ok('and the racer still waiting keeps the preview',
   await page.$$eval(`${card(second.id)} [data-intake-preview]`, els => els.length), 1);

console.log('\nthe racer screen, before the start');
const waiting = second;
await page.goto(BASE + `/racer.html?id=${SLUG}&runner=${encodeURIComponent(waiting.id)}`);
await page.waitForSelector('#intake .rpreview', { timeout: 20000 }).catch(() => {});
ok('shows what the buttons will be', await page.$$eval('#intake .rpreview-chip', els => els.map(e => e.textContent.replace(/^\+\s*/, ''))), items);
ok('saying when they start working', /once your race starts/.test(await page.textContent('#intake .rpreview-note')), true);
ok('with nothing to press and nowhere to write',
   [await page.$$eval('#intake .rchip', els => els.length), await page.isVisible('#jot-form')], [0, false]);

console.log('\na race with no one-tap items yet');
await edit('config.json', c => { c.fuelPresets = []; c.presets = []; return c; });
await openPit();
const note = await page.textContent(`${card(waiting.id)} .intake-preview-note`);
ok('the pit board says so', /No one-tap items yet/.test(note), true);
await page.goto(BASE + `/racer.html?id=${SLUG}&runner=${encodeURIComponent(waiting.id)}`);
await page.waitForSelector('#intake .rpreview', { timeout: 20000 }).catch(() => {});
ok('and so does the racer screen', /Add them in settings/.test(await page.textContent('#intake .rpreview-note')), true);

console.log('\nthe link goes straight to the items');
await openPit();
await page.click(`${card(waiting.id)} .intake-preview-note a`);
await page.waitForSelector('#preset-table', { timeout: 20000 });
await page.waitForTimeout(600);
ok('the racers section is open', await page.evaluate(() => !document.getElementById('runner-editor').classList.contains('collapsed')), true);
ok('and the items are on screen', await page.evaluate(() => {
  const r = document.getElementById('items').getBoundingClientRect();
  return r.top >= 0 && r.top < innerHeight;
}), true);

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
