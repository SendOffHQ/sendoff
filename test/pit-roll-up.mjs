// A racer's card on the crew page rolls up to its name bar (2026-11-21), for
// a crew looking after several racers who only needs the one in front of
// them open. This checks that:
//   - tapping the name bar rolls the card up and back, keeping the name, the
//     where-they-are badge and the big Check in / Send off button on show,
//     and hiding the rest, Undo and Dropped included;
//   - it stays rolled through a refresh and a reload, per race on the device;
//   - the keyboard can do it (Enter and Space), as DESIGN.md asks of a fold;
//   - rolling one card up does not touch typing in another card's panel.
//
//   node test/pit-roll-up.mjs
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
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errs = [];
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
const ago = (min) => new Date(Date.now() - min * 60e3).toISOString();

const cfg = await api(CFG); delete cfg.myRole;
cfg.runners = [{ ...cfg.runners[0], id: 'ann', name: 'Ann' }, { ...cfg.runners[0], id: 'bo', name: 'Bo' }];
await api(CFG, cfg);
const out = () => [{ index: 1, startTime: ago(120), endTime: ago(60) }, { index: 2, startTime: ago(60) }];
await api(DATA, { runners: [{ id: 'ann', legs: out() }, { id: 'bo', legs: out() }] });

const open = async () => {
  await page.goto(BASE + `/pit.html?id=${SLUG}`);
  await page.waitForSelector('article[data-runner="bo"] [data-roll]', { timeout: 20000 });
  await page.waitForTimeout(500);
};
const state = (id) => page.evaluate((id) => {
  const a = document.querySelector(`article.runner[data-runner="${id}"]`);
  const shown = el => !!el && el.getBoundingClientRect().height > 0;
  return { rolled: a.classList.contains('rolled'),
    expanded: a.querySelector('[data-roll]').getAttribute('aria-expanded'),
    button: shown(a.querySelector('.big-btn')),
    undo: shown(a.querySelector('[data-action="undo"]')),
    drop: shown(a.querySelector('[data-arm="stop"], [data-action="stop"]')),
    where: shown(a.querySelector('.where')), splits: shown(a.querySelector('.splits')),
    name: shown(a.querySelector('.runner-name')), badge: shown(a.querySelector('.state-badge')) };
}, id);

await open();
console.log('\nthe name bar');
ok('a card starts open', await state('bo'),
  { rolled: false, expanded: 'true', button: true, undo: true, drop: true, where: true, splits: true, name: true, badge: true });
// The splits as the race page draws them (2026-11-21), under each racer.
ok('with the racer\'s splits, drawn as the race page draws them', await page.evaluate(() => {
  const a = document.querySelector('article.runner[data-runner="bo"] .splits');
  return [a.querySelector('.splits-title').textContent.trim(), a.querySelectorAll('.seg-row').length > 2,
    !!a.querySelector('.seg-row.current')];
}), ['Aid stations', true, true]);
ok('below the intake panel', await page.evaluate(() => {
  const a = document.querySelector('article.runner[data-runner="bo"]');
  return !!a.querySelector(':scope > .intake-panel ~ .splits');
}), true);
await page.click('article[data-runner="bo"] .runner-name');
// Asked for the same day: Undo and Dropped go too, and the big button stays.
ok('a tap rolls it up to its name, badge and big button', await state('bo'),
  { rolled: true, expanded: 'false', button: true, undo: false, drop: false, where: false, splits: false, name: true, badge: true });
ok('and leaves the other racer open', (await state('ann')).rolled, false);

console.log('\nkept');
await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
await page.waitForTimeout(1500);
ok('through a refresh', (await state('bo')).rolled, true);
await open();
ok('and a reload', (await state('bo')).rolled, true);

console.log('\nfrom the keyboard');
await page.focus('article[data-runner="bo"] [data-roll]');
await page.keyboard.press('Enter');
ok('Enter opens it', (await state('bo')).rolled, false);
await page.keyboard.press(' ');
ok('Space rolls it back up', (await state('bo')).rolled, true);
await page.keyboard.press(' ');

console.log('\nwhile somebody types on another card');
const NOTE = 'article[data-runner="ann"] textarea[data-intake="notes"]';
await page.waitForSelector(NOTE);
await page.fill(NOTE, 'half a sentence');
await page.evaluate(sel => { window.__note = document.querySelector(sel); }, NOTE);
await page.click('article[data-runner="bo"] .runner-name');
ok('rolling Bo up leaves Ann\'s typing where it was', await page.evaluate(sel => {
  const t = document.querySelector(sel); return [t === window.__note, t.value];
}, NOTE), [true, 'half a sentence']);
ok('and Bo is rolled', (await state('bo')).rolled, true);

ok('no page errors', errs, []);
await b.close();
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
