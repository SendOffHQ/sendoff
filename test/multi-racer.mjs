// Several athletes on one race, asked for ahead of Dino Valley (2026-10-27):
// on the race page each racer's section rolls up, all of them rolled up to
// begin with; and racers can be assigned to particular crew, so the crew page
// shows each crew member their own racers.
//
//   node test/multi-racer.mjs
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

const cfg = await api(CFG); delete cfg.myRole;
cfg.startTime = t(3);
cfg.runners = [{ id: 'ann', name: 'Ann', color: '#0fb8bf' }, { id: 'bo', name: 'Bo', color: '#6ee7a8' }, { id: 'cy', name: 'Cy', color: '#ffb07a' }];
await api(CFG, cfg);
await api(DATA, { runners: ['ann', 'bo', 'cy'].map(id => ({ id, legs: [{ index: 1, startTime: t(3), endTime: t(2) }, { index: 2, startTime: t(2) }] })) });

console.log('\nthe race page, three racers');
const racePage = async () => {
  await page.goto(BASE + `/race.html?id=${SLUG}`);
  await page.waitForSelector('#runners .runner', { timeout: 20000 });
  return page.evaluate(() => [...document.querySelectorAll('#runners .runner')].map(a => ({
    id: a.dataset.runnerId, open: !a.querySelector('.runner-body').hidden,
    line: !!a.querySelector('.runner-fold-line') })));
};
let cards = await racePage();
ok('every section rolled up to begin with', cards.map(c => c.open), [false, false, false]);
ok('each with where they are on one line', cards.map(c => c.line), [true, true, true]);
await page.click('[data-fold="bo"]');
cards = await page.evaluate(() => [...document.querySelectorAll('#runners .runner')].map(a => !a.querySelector('.runner-body').hidden));
ok('Show opens one', cards, [false, true, false]);
ok('and says it is open', await page.getAttribute('[data-fold="bo"]', 'aria-expanded'), 'true');
await page.click('.runner[data-runner-id="cy"] .runner-name');
ok('so does tapping the name', (await page.evaluate(() => !document.querySelector('.runner[data-runner-id="cy"] .runner-body').hidden)), true);
cards = await racePage();
ok('remembered for this viewer after a reload', cards.map(c => c.open), [false, true, true]);
ok('and fits a phone', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

console.log('\none racer');
const one = { ...cfg, runners: cfg.runners.slice(0, 1) };
const allData = await api(DATA);
await api(CFG, one);
await api(DATA, { runners: allData.runners.slice(0, 1) });
await page.goto(BASE + `/race.html?id=${SLUG}`);
await page.waitForSelector('#runners .runner', { timeout: 20000 });
ok('is shown in full, with nothing to roll up', await page.evaluate(() => [!document.querySelector('.runner-body').hidden, !!document.querySelector('[data-fold]')]), [true, false]);
await api(CFG, cfg);
await api(DATA, allData);

console.log('\nassigning crew, in settings');
await page.evaluate(async () => {
  for (const [email, role] of [['sam@example.com', 'crew'], ['pat@example.com', 'pacer'], ['ren@example.com', 'racer']]) {
    await fetch('/api/access/add', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer stub' },
      body: JSON.stringify({ slug: 'zz-fixture-unlisted', email, role }) });
  }
});
await page.goto(BASE + `/settings.html?id=${SLUG}`);
await page.waitForSelector('#runner-editor-head', { timeout: 20000 });
await page.click('#runner-editor-head');
await page.waitForSelector('#runner-edit-rows details.runner-crew', { timeout: 20000 });
ok('a crew list on each racer', await page.locator('#runner-edit-rows details.runner-crew').count(), 3);
ok('offering the owner, crew and pacers, not racers', await page.$$eval('#runner-edit-rows tr:nth-child(1) details.runner-crew input', els => els.map(e => e.value)),
  ['crew@example.com', 'sam@example.com', 'pat@example.com']);
const boRow = '#runner-edit-rows tr:nth-child(2) details.runner-crew';
await page.click(`${boRow} summary`);
await page.check(`${boRow} input[value="crew@example.com"]`);
await page.check(`${boRow} input[value="sam@example.com"]`);
ok('the summary names who is ticked', (await page.textContent(`${boRow} summary`)).trim(), 'Crew: Casey Kim, sam');
const annRow = '#runner-edit-rows tr:nth-child(1) details.runner-crew';
await page.click(`${annRow} summary`);
await page.check(`${annRow} input[value="sam@example.com"]`);
await page.click('#runner-save');
await page.waitForFunction(async () => true);
let saved = null;
for (let i = 0; i < 40; i++) { saved = await api(CFG); if ((saved.runners[1].crew || []).length) break; await page.waitForTimeout(150); }
ok('saved by racer', saved.runners.map(r => r.crew), [['sam@example.com'], ['crew@example.com', 'sam@example.com'], []]);

console.log('\nthe crew page, for somebody assigned to Bo');
const board = () => page.evaluate(() => ({
  shown: [...document.querySelectorAll('#runners .runner-card, #runners article')].map(a => a.dataset.runnerId || a.querySelector('[data-runner]')?.dataset.runner).filter(Boolean),
  scope: (document.querySelector('.board-scope') || {}).textContent || null }));
await page.goto(BASE + `/pit.html?id=${SLUG}`);
await page.waitForSelector('#runners .board-scope', { timeout: 20000 });
const names = () => page.$$eval('#runners .runner-name, #runners h2, #runners .rname', els => els.map(e => e.textContent.trim()));
let scope = await page.textContent('.board-scope');
ok('says it is showing their racers', scope.replace(/\s+/g, ' ').trim(), 'Your racers: 2 of 3 · Show all');
ok('each card in its racer\'s colour, as on the race page', await page.$$eval('#runners article.runner', els => els.map(e => [e.dataset.runner, e.style.getPropertyValue('--runner-color').trim()])),
  [['bo', '#6ee7a8'], ['cy', '#ffb07a']]);
ok('Bo, and Cy who nobody is assigned to; not Ann', (await page.evaluate(() => document.getElementById('runners').textContent)).includes('Ann'), false);
await page.click('[data-scope="all"]');
ok('Show all brings everybody', (await page.evaluate(() => document.getElementById('runners').textContent)).includes('Ann'), true);
await page.reload();
await page.waitForSelector('#runners .board-scope', { timeout: 20000 });
ok('kept for the tab', (await page.textContent('.board-scope')).replace(/\s+/g, ' ').trim(), 'All 3 racers · Just mine (2)');
await page.click('[data-scope="mine"]');
ok('and back to just theirs', (await page.evaluate(() => document.getElementById('runners').textContent)).includes('Ann'), false);

console.log('\nfor somebody assigned to nobody');
const c2 = await api(CFG); delete c2.myRole;
c2.runners = c2.runners.map(r => ({ ...r, crew: r.id === 'bo' ? ['sam@example.com'] : [] }));
await api(CFG, c2);
await page.goto(BASE + `/pit.html?id=${SLUG}`);
await page.waitForSelector('#runners article, #runners .runner', { timeout: 20000 });
ok('the whole field, with no line about it', [await page.locator('.board-scope').count(), (await page.evaluate(() => document.getElementById('runners').textContent)).includes('Ann')], [0, true]);

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
