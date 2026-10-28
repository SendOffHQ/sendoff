// Checking in only at the pit (2026-10-28): on a loop course a racer can be
// set, in Settings, Racers, to check in only at the end of each lap, for the
// ones who would rather not press anything out on the course. The press is
// then the arrival at the start/finish, and the stations on the lap are
// filled in by distance (Race.checkIns), on the racer screen and the crew
// page alike. Loop courses only, for now.
//
//   node test/pit-check-ins.mjs
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

// Dino Valley's 100K: six laps of 10.5 miles, Fence Line on the way out and
// on the way back, crew only at Cedar Brake.
const base = await api(CFG); delete base.myRole;
const cfg = { ...base, startTime: t(2), courseType: 'loops',
  course: { loopCount: 6, loops: [{ name: 'Long', times: 6, segments: [
    { fromAid: 'Cedar Brake', toAid: 'Fence Line (out)', distanceMi: 2.5 },
    { fromAid: 'Fence Line (out)', toAid: 'Fence Line (in)', distanceMi: 5.5 },
    { fromAid: 'Fence Line (in)', toAid: 'Cedar Brake', distanceMi: 2.5 }] }] },
  runners: [{ id: 'ann', name: 'Ann', color: '#0fb8bf', checkIns: 'pit' }, { id: 'bo', name: 'Bo', color: '#6ee7a8' }] };
await api(CFG, cfg);
const fresh = { runners: [{ id: 'ann', legs: [{ index: 1, startTime: t(2) }] }, { id: 'bo', legs: [{ index: 1, startTime: t(2) }] }] };
await api(DATA, fresh);

console.log('\nthe racer screen, for a racer who checks in at the pit');
await page.goto(BASE + `/racer.html?id=${SLUG}&runner=ann`);
await page.waitForSelector('#go', { timeout: 20000 });
const readNext = () => page.evaluate(() => [...document.querySelectorAll('.rblock')].map(x => x.textContent.replace(/\s+/g, ' ').trim()).find(x => x.startsWith('Next')));
ok('the next check-in is the end of the lap', await readNext(), 'Next Cedar Brake 10.5 mi to go · mile 10.5');
ok('and the button says so', (await page.textContent('#go')).replace(/\s+/g, ' ').trim().split('Logs')[0].trim(), 'Lap done · Lap 1 · Long');
await page.click('#go');
await page.waitForSelector('.rundo', { timeout: 5000 });
ok('no Skipped offer, and no "Skipped" line', [await page.locator('#skip').count(), await page.locator('.rundo .skipped').count()], [0, 0]);
let legs = await until(async () => { const d = await api(DATA); const l = d.runners.find(r => r.id === 'ann').legs; return l.length >= 3 ? l : null; });
const by = Object.fromEntries((legs || []).map(l => [l.index, l]));
ok('the lap is done, Fence Line both ways filled in', [!!by[1]?.skipped, !!by[2]?.skipped, !!by[3]?.endTime, !!by[3]?.skipped], [true, true, true, false]);
const mins = (a, z) => Math.round((Date.parse(z) - Date.parse(a)) / 60000);
ok('by distance: 2.5, 5.5 and 2.5 of 10.5 miles in two hours', [mins(by[1].startTime, by[1].endTime), mins(by[2].startTime, by[2].endTime), mins(by[3].startTime, by[3].endTime)], [29, 63, 29]);
ok('and now in the pit at Cedar Brake', (await page.textContent('#readout')).includes('Cedar Brake'), true);
await page.click('#undo');
legs = await until(async () => { const d = await api(DATA); const l = d.runners.find(r => r.id === 'ann').legs; return l.length === 1 && !l[0].endTime ? l : null; });
ok('Undo takes the whole lap back', !!legs, true);

console.log('\nthe crew page');
await page.goto(BASE + `/pit.html?id=${SLUG}`);
await page.waitForSelector('[data-action="press"][data-runner="ann"]', { timeout: 20000 });
ok('Ann: check in at the pit', (await page.textContent('[data-action="press"][data-runner="ann"]')).trim(), 'Check In at Cedar Brake');
ok('Bo, who checks in everywhere: Fence Line', (await page.textContent('[data-action="press"][data-runner="bo"]')).trim(), 'Check In at Fence Line (out)');
await page.click('[data-action="press"][data-runner="ann"]');
legs = await until(async () => { const d = await api(DATA); const l = d.runners.find(r => r.id === 'ann').legs; return l.length >= 3 ? l : null; });
ok('the crew\'s check-in fills the lap in too', (legs || []).map(l => !!l.skipped), [true, true, false]);
await page.waitForFunction(() => /Send Off/.test(document.querySelector('[data-action="press"][data-runner="ann"]').textContent), null, { timeout: 5000 });
ok('and sends off to the end of the next lap', (await page.textContent('[data-action="press"][data-runner="ann"]')).trim(), 'Send Off · Lap 2');
ok('nothing offered to skip', await page.locator('[data-action="skip"][data-runner="ann"]').count(), 0);

console.log('\nsettings');
await page.goto(BASE + `/settings.html?id=${SLUG}`);
await page.waitForSelector('#runner-editor-head', { timeout: 20000 });
await page.click('#runner-editor-head');
await page.waitForSelector('#runner-edit-rows select[data-k="checkIns"]', { timeout: 20000 });
ok('a Check in choice on each racer', await page.$$eval('#runner-edit-rows select[data-k="checkIns"]', els => els.map(e => e.value)), ['pit', '']);
await page.selectOption('#runner-edit-rows tr:nth-child(2) select[data-k="checkIns"]', 'pit');
await page.selectOption('#runner-edit-rows tr:nth-child(1) select[data-k="checkIns"]', '');
await page.click('#runner-save');
const saved = await until(async () => { const c = await api(CFG); return c.runners[1].checkIns === 'pit' ? c : null; });
ok('saved by racer', saved && saved.runners.map(r => r.checkIns || ''), ['', 'pit']);
ok('fits a phone', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

console.log('\nnot on a course of aid stations from start to finish, for now');
await api(CFG, { ...base, runners: cfg.runners });
await page.goto(BASE + `/settings.html?id=${SLUG}`);
await page.waitForSelector('#runner-editor-head', { timeout: 20000 });
await page.click('#runner-editor-head');
await page.waitForSelector('#runner-edit-rows tr', { timeout: 20000 });
ok('no choice offered', await page.locator('#runner-edit-rows select[data-k="checkIns"]').count(), 0);
ok('and a racer set to the pit checks in everywhere', await page.evaluate((c) => Race.checkIns.stop(c, { id: 'ann' }, 1), { ...base, runners: cfg.runners }), 1);

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
