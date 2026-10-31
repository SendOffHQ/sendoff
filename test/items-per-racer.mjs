// One-tap items per racer (2026-10-31): the list stays the race's, since a
// leg counts an item under its position, but each racer can have their own
// of them on their screen and their card on the crew page. Chosen in
// Settings, in the items' On column for the racer picked in Plan for.
//
//   node test/items-per-racer.mjs
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
const t = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const until = async (test) => { for (let i = 0; i < 40; i++) { const v = await test(); if (v) return v; await page.waitForTimeout(150); } return null; };

const base = await api(CFG); delete base.myRole;
const cfg = { ...base, startTime: t(2),
  fuelPresets: [{ name: 'Gel', values: { calories: 100 } }, { name: 'Flask', values: { fluidOz: 17 } }, { name: 'Salt pill', values: { sodiumMg: 215 } }],
  runners: [{ id: 'ann', name: 'Ann', color: '#0fb8bf', presets: [0, 1] }, { id: 'bo', name: 'Bo', color: '#6ee7a8' }] };
delete cfg.presetOrder;
await api(CFG, cfg);
await api(DATA, { runners: [{ id: 'ann', legs: [{ index: 1, startTime: t(2) }] }, { id: 'bo', legs: [{ index: 1, startTime: t(2) }] }] });

console.log('\nthe racer screen');
await page.goto(BASE + `/racer.html?id=${SLUG}&runner=ann`);
await page.waitForSelector('.rchip[data-preset]', { timeout: 20000 });
const chipNames = () => page.$$eval('.rchip[data-preset]', els => els.map(e => e.firstElementChild.firstChild.textContent.replace('+', '').trim()));
ok('Ann sees her two', await chipNames(), ['Gel', 'Flask']);
await page.click('.rchip[data-preset="1"]');
let leg = await until(async () => { const d = await api(DATA); const l = d.runners.find(r => r.id === 'ann').legs[0]; return l.preset_1 ? l : null; });
ok('a tap on Flask counts the race\'s Flask', [leg && leg.preset_1, leg && leg.fluidOz], [1, 17]);
await page.goto(BASE + `/racer.html?id=${SLUG}&runner=bo`);
await page.waitForSelector('.rchip[data-preset]', { timeout: 20000 });
ok('Bo, with no list of his own, sees every item', await chipNames(), ['Gel', 'Flask', 'Salt pill']);

console.log('\nreordering some of them');
ok('Ann swapping her two leaves Salt pill where it was', await page.evaluate((c) => Race.fuel.mergeOrder(c, [1, 0]), cfg), [1, 0, 2]);
ok('and two with one between them keep it there', await page.evaluate((c) => Race.fuel.mergeOrder({ ...c, presetOrder: [0, 1, 2] }, [2, 0]), cfg), [2, 1, 0]);

console.log('\nthe crew page');
await page.goto(BASE + `/pit.html?id=${SLUG}`);
await page.waitForSelector('.preset-chip', { timeout: 20000 });
const crewChips = (id) => page.$$eval(`.preset-chip[data-runner="${id}"]`, els => els.map(e => e.firstChild.textContent.replace('+', '').trim()));
ok('Ann\'s card: her two', await crewChips('ann'), ['Gel', 'Flask']);
ok('Bo\'s card: all three', await crewChips('bo'), ['Gel', 'Flask', 'Salt pill']);

console.log('\nsettings');
await page.goto(BASE + `/settings.html?id=${SLUG}`);
await page.waitForSelector('#runner-editor-head', { timeout: 20000 });
await page.click('#runner-editor-head');
await page.waitForSelector('#preset-rows input[data-preset-on]', { timeout: 20000 });
const ticks = () => page.$$eval('#preset-rows input[data-preset-on]', els => els.map(e => e.checked));
ok('an On column for the racer picked, Ann', [(await page.textContent('.preset-on-head')).trim(), await ticks()], ['On Ann', [true, true, false]]);
await page.selectOption('#plan-runner', { label: 'Bo' });
ok('Bo: every item', [(await page.textContent('.preset-on-head')).trim(), await ticks()], ['On Bo', [true, true, true]]);
await page.uncheck('#preset-rows input[data-preset-on="1"]');
await page.selectOption('#plan-runner', { label: 'Ann' });
ok('Ann\'s are still hers after switching', await ticks(), [true, true, false]);
await page.click('#add-preset');
await page.fill('#preset-rows tr:last-child input[data-k="name"]', 'Caffeine gum');
ok('an item added is ticked for the racer picked', await ticks(), [true, true, false, true]);
await page.check('#preset-rows input[data-preset-on="2"]');
await page.click('#runner-save');
const saved = await until(async () => { const c = await api(CFG); return (c.fuelPresets || []).length === 4 ? c : null; });
ok('saved by racer: Ann every item, so no list; Bo without Flask or the gum', saved && saved.runners.map(r => r.presets || null), [null, [0, 2]]);
ok('fits a phone', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

console.log('\none racer');
await api(CFG, { ...saved, runners: saved.runners.slice(0, 1) });
await page.goto(BASE + `/settings.html?id=${SLUG}`);
await page.waitForSelector('#runner-editor-head', { timeout: 20000 });
await page.click('#runner-editor-head');
await page.waitForSelector('#preset-rows tr', { timeout: 20000 });
ok('no On column', await page.locator('#preset-rows input[data-preset-on]').count(), 0);

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
