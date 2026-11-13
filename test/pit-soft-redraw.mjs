// The crew page redraws round an intake box with unsaved input (2026-11-13).
//
// Found in review: while anything in an intake panel was unsaved, the whole
// board stood down. A crew member who tapped "+ Gel" and then Send Off saw the
// button and the badge stay exactly as they were, which invites a second press
// that is read as the next action; and one racer's half-typed note froze every
// other racer's card.
//
// Now only the panel being typed in is left alone. This checks that:
//   - a press on another racer redraws that racer's card;
//   - a press on the same racer redraws their own button and badge;
//   - a change from somewhere else (a poll) lands on the other cards;
//   - through all of it the typing, the tapped item and the focus are kept,
//     in the very same field, and Save still files it under the station it
//     was typed for.
//
//   node test/pit-soft-redraw.mjs
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
const until = async (test, n = 60) => { for (let i = 0; i < n; i++) { try { const v = await test(); if (v) return v; } catch (e) {} await page.waitForTimeout(150); } return false; };
const CFG = `races/${SLUG}/config.json`, DATA = `races/${SLUG}/data.json`;
const ago = (min) => new Date(Date.now() - min * 60e3).toISOString();

// Two racers, both on the way to the first aid station (the stop before it
// is a checkpoint), and one item to tap.
const cfg = await api(CFG); delete cfg.myRole;
cfg.runners = [{ ...cfg.runners[0], id: 'ann', name: 'Ann' }, { ...cfg.runners[0], id: 'bo', name: 'Bo' }];
cfg.fuelPresets = [{ name: 'Gel', values: { calories: 100 } }];
delete cfg.presetOrder;
await api(CFG, cfg);
const out = () => [{ index: 1, startTime: ago(120), endTime: ago(60) }, { index: 2, startTime: ago(60) }];
await api(DATA, { runners: [{ id: 'ann', legs: out() }, { id: 'bo', legs: out() }] });

await page.goto(BASE + `/pit.html?id=${SLUG}`);
await page.waitForSelector('[data-action="press"][data-runner="bo"]', { timeout: 20000 });
await page.waitForSelector('article[data-runner="ann"] textarea[data-intake="notes"]');
const card = (id) => page.evaluate((id) => {
  const a = document.querySelector(`article.runner[data-runner="${id}"]`);
  return { button: a.querySelector('.big-btn').textContent.trim(), badge: a.querySelector('.state-badge').textContent.trim() };
}, id);
const NOTE = 'article[data-runner="ann"] textarea[data-intake="notes"]';
const typing = () => page.evaluate((sel) => {
  const t = document.querySelector(sel);
  return { value: t.value, focused: document.activeElement === t, same: t === window.__note };
}, NOTE);

console.log('\na note half typed on one racer');
const annBefore = await card('ann'), boBefore = await card('bo');
await page.click(NOTE);
await page.keyboard.type('Half a PB and J');
await page.evaluate((sel) => { window.__note = document.querySelector(sel); }, NOTE);
ok('is in the box, with the cursor in it', await typing(), { value: 'Half a PB and J', focused: true, same: true });

console.log('\nand a check-in on the other');
// Pressed from script so the focus stays where the crew member is typing:
// the point is what the board does, not where the tap went.
await page.evaluate(() => document.querySelector('[data-action="press"][data-runner="bo"]').click());
const boAfter = await until(async () => { const c = await card('bo'); return c.button !== boBefore.button ? c : null; }, 30);
ok('their button moves on', !!boAfter, true);
ok('and their badge', boAfter && boAfter.badge !== boBefore.badge, true);
ok('the note is untouched, same box, cursor still in it', await typing(), { value: 'Half a PB and J', focused: true, same: true });
await page.keyboard.type(', ice');
ok('and typing carries on where it was', (await typing()).value, 'Half a PB and J, ice');

console.log('\nan item tapped, then that racer\'s own button');
await page.evaluate(() => document.querySelector('article[data-runner="ann"] [data-action="preset"]').click());
ok('the item is counted in the box', await page.$eval('article[data-runner="ann"] [data-intake="calories"]', e => e.value), '100');
await page.evaluate(() => document.querySelector('[data-action="press"][data-runner="ann"]').click());
const annAfter = await until(async () => { const c = await card('ann'); return c.button !== annBefore.button ? c : null; }, 30);
ok('the button says what is next, not what was just pressed', !!annAfter, true);
ok('and the badge has changed with it', annAfter && annAfter.badge !== annBefore.badge, true);
ok('the unsaved numbers are still there', await page.$eval('article[data-runner="ann"] [data-intake="calories"]', e => e.value), '100');
ok('and the note, in the same box', [(await typing()).value, (await typing()).same], ['Half a PB and J, ice', true]);
ok('still marked as the station it was typed for', await page.$eval('article[data-runner="ann"] select[data-intake-leg]', s => s.value), '2');

console.log('\na change from somewhere else');
const d = await api(DATA);
const bo = d.runners.find(r => r.id === 'bo');
// Somebody else sends Bo off.
bo.legs.push({ index: 3, startTime: new Date().toISOString() });
await api(DATA, d);
// What the poll does, without waiting out its interval: coming back to the
// page refreshes at once, and the refresh is the same unforced load.
await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
const boPolled = await until(async () => { const c = await card('bo'); return c.button !== boAfter.button ? c : null; }, 120);
ok('reaches the other racer\'s card on the next poll', !!boPolled, true);
ok('with the typing still where it was', [(await typing()).value, (await typing()).same], ['Half a PB and J, ice', true]);

console.log('\nsaving it');
await page.click('article[data-runner="ann"] [data-action="save-intake"]');
const saved = await until(async () => {
  const l = (await api(DATA)).runners.find(r => r.id === 'ann').legs.find(l => l.index === 2);
  return l && l.notes ? l : null;
});
ok('files the note and the item under the station it was typed for',
  saved && [saved.notes, saved.calories], ['Half a PB and J, ice', 100]);
ok('and the board is whole again', await until(() => page.evaluate(() =>
  [...document.querySelectorAll('#runners [data-intake]')].every(el => el.value === (el.dataset.rendered ?? '')))), true);

ok('no page threw', errs, []);
await b.close();
console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
