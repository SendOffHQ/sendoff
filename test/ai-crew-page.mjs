// An AI as crew, from the pages: inviting one from Manage access, the
// privacy notice said where it is made, the AI on the roster as what it is,
// its guesses shown with a ~, and a number a person types replacing a guess.
//
//   node test/ai-crew-page.mjs
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
  console.log(`  ${q?'ok  ':'FAIL'} ${l.padEnd(58)} ${JSON.stringify(g)}${q?'':' want '+JSON.stringify(w)}`)};
const ctx = await b.newContext({ viewport: { width: 390, height: 900 }, serviceWorkers: 'block', timezoneId: 'America/Chicago', locale: 'en-US' });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
let dialogs = [];
page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
await page.goto(BASE + '/index.html');
await page.evaluate(base => {
  localStorage.setItem('race-hub-session-v1', JSON.stringify({ session: 'stub', proxyUrl: base + '/api',
    email: 'crew@example.com', role: 'owner', expiresAt: Date.now() + 7 * 24 * 3600e3 }));
  localStorage.setItem('race-hub-tutorial-v1', JSON.stringify({ settings: 99, pit: 99, race: 99 }));
}, BASE);
const readData = () => page.evaluate(async (slug) => {
  const r = await (await fetch(`/api/get?path=races/${slug}/data.json`, { headers: { Authorization: 'Bearer stub' } })).json();
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(r.content), c => c.charCodeAt(0))));
}, SLUG);
const writeData = (d) => page.evaluate(async ([slug, d]) => fetch('/api/commit', { method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer stub' },
  body: JSON.stringify({ path: `races/${slug}/data.json`, content: JSON.stringify(d), message: 'test' }) }), [SLUG, d]);

console.log('\ninviting an AI from Manage access');
await page.goto(BASE + `/settings.html?id=${SLUG}`);
await page.waitForSelector('#access .access-head', { state: 'visible', timeout: 20000 });
await page.click('#access .access-head');
await page.waitForSelector('#ax-ai', { timeout: 10000 });
const help = (await page.textContent('#ax-ai')).replace(/\s+/g, ' ');
ok('it says what an AI crew can and cannot do', [/logs its best guess/.test(help), /cannot check anybody in or out/.test(help)], [true, true]);
ok('and what connecting one shares, and with whom, before it is made',
  [/sends this race's course and cutoffs/.test(help), /Anthropic for Claude/.test(help)], [true, true]);
ok('with the full story a tap away', await page.getAttribute('#ax-ai .ax-ai-privacy a', 'href'), 'privacy.html#ai-crew');
await page.fill('#ax-ai-label', 'Claude');
await page.click('#ax-ai-make');
await page.waitForSelector('#ax-ai-result .url', { timeout: 10000 });
ok('the notice is said again at the moment it is made', /sends this race's course and Test Racer's splits, food, drink, notes and goals to whoever runs it/.test(dialogs.at(-1)), true);
ok('it hands back the link to paste', (await page.textContent('#ax-ai-result .url')).trim().startsWith('https://worker.example/mcp/'), true);
ok('and how to connect it in Claude', (await page.textContent('#ax-ai-result .ax-ai-steps')).includes('Add custom connector'), true);
ok('the AI is on the roster, marked as one', await page.$$eval('#access .access-list .row', rows => rows
  .filter(r => r.querySelector('.tag.ai')).map(r => r.textContent.replace(/\s+/g, ' ').trim())), ['Claude AI crew for Test Racer AI']);
ok('its link is listed to copy again or remove', await page.$$eval('#ax-ai [data-revoke-ai]', els => els.map(e => e.dataset.aiLabel)), ['Claude']);
await page.click('#ax-ai [data-revoke-ai]');
await page.waitForFunction(() => !document.querySelector('#ax-ai [data-revoke-ai]'), null, { timeout: 10000 });
ok('removing asks first, then it is gone', [/Remove Claude\? Its link stops working at once\./.test(dialogs.at(-1)),
  await page.$$eval('#access .tag.ai', els => els.length)], [true, 0]);
const nav = await page.evaluate(() => document.documentElement.scrollWidth);
ok('none of it pushes a phone sideways', nav <= 390, true);

console.log('\nits guesses, on the race page');
const d0 = await readData();
const runner = d0.runners[0];
const leg1 = runner.legs.find(l => l.index === 1);
leg1.calories = 480; leg1.aiEst = { calories: 280 };
await writeData(d0);
await page.goto(BASE + `/race.html?id=${SLUG}`);
await page.waitForSelector('td[data-label="Done"]', { state: 'attached', timeout: 20000 });
const cells = await page.$$eval('td.num', els => els.map(e => e.textContent.trim()));
ok('a leg with a guess in it reads ~', cells.includes('~480cal'), true);
ok('and only that one', cells.filter(c => c.startsWith('~')), ['~480cal']);

console.log('\nand on the pit board');
await page.goto(BASE + `/pit.html?id=${SLUG}`);
await page.waitForSelector('[data-intake-leg]', { state: 'attached', timeout: 20000 });
const legShown = +(await page.$eval('[data-intake-leg]', s => s.value));
const d1 = await readData();
const shown = d1.runners[0].legs.find(l => l.index === legShown);
shown.calories = 300; shown.sodiumMg = 400; shown.aiEst = { calories: 200, sodiumMg: 400 };
await writeData(d1);
await page.reload();
await page.waitForSelector('[data-intake="calories"]', { state: 'attached', timeout: 20000 });
ok('the boxes holding a guess say so', await page.$$eval('.est-tag', els => els.map(e => e.closest('label').querySelector('[data-intake]').dataset.intake)), ['calories', 'sodiumMg']);
await page.fill('[data-intake="calories"]', '350');
await page.click('[data-action="save-intake"]');
await page.waitForTimeout(1500);
const after = (await readData()).runners[0].legs.find(l => l.index === legShown);
ok('a number typed replaces the guess, and only that one', [after.calories, after.aiEst], [350, { sodiumMg: 400 }]);

const d2 = await readData();
const again = d2.runners[0].legs.find(l => l.index === legShown);
again.aiEst = { calories: 200, sodiumMg: 400 };
await writeData(d2);
await page.reload();
await page.waitForSelector('button.preset-chip', { timeout: 20000 });
await page.click('button.preset-chip');
await page.click('[data-action="save-intake"]');
await page.waitForTimeout(1500);
const tapped = (await readData()).runners[0].legs.find(l => l.index === legShown);
ok('a save that only adds a tapped item keeps the guess', tapped.aiEst, { calories: 200, sodiumMg: 400 });

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
