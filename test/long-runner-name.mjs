// A racer's name too long for its card's header on a phone.
//
// Reported 2026-10-16: on a phone, "alexander.golik16" was wider than the
// card, so the name ran past its edge and pushed the status badge out of
// sight. The header now wraps, putting the badge under the name, and a name
// with no spaces breaks after a full stop or underscore. A short name keeps
// the badge beside it, as before.
//
//   node test/long-runner-name.mjs
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
  localStorage.setItem('race-hub-tutorial-v1', JSON.stringify({ racer: 99, pit: 99, race: 99 }));
}, BASE);
const CFG = `races/${SLUG}/config.json`;
const cfg = await page.evaluate(async (path) => {
  const r = await (await fetch(`/api/get?path=${path}`, { headers: { Authorization: 'Bearer stub' } })).json();
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(r.content), c => c.charCodeAt(0))));
}, CFG);
delete cfg.myRole;
const setName = (name) => page.evaluate(async ([path, cfg, name]) => {
  cfg.runners = cfg.runners.map((r, i) => i ? r : { ...r, name });
  await fetch('/api/commit', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer stub' },
    body: JSON.stringify({ path, content: JSON.stringify(cfg), message: 'test' }) });
}, [CFG, cfg, name]);

// Before the start, as the race was when it was reported: one badge, no
// finish card beside it.
await page.evaluate(async (slug) => {
  await fetch('/api/commit', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer stub' },
    body: JSON.stringify({ path: `races/${slug}/data.json`, content: JSON.stringify({ runners: [{ id: 'jason', legs: [] }] }), message: 'test' }) });
}, SLUG);

// Where the name and the badge sit against the card they belong to. Below
// means under the name and bib together: beside them, the badge lines up
// with the bib, so it is lower than the name either way.
const head = async () => {
  await page.goto(BASE + `/race.html?id=${SLUG}`);
  await page.waitForSelector('article.runner .status-badge', { timeout: 20000 });
  return page.evaluate(() => {
    const card = document.querySelector('article.runner').getBoundingClientRect();
    const name = document.querySelector('article.runner .runner-name');
    const n = name.getBoundingClientRect();
    const s = document.querySelector('article.runner .status-badge').getBoundingClientRect();
    return { nameInside: n.right <= card.right + 0.5, badgeInside: s.right <= card.right + 0.5 && s.left >= card.left,
      badgeBelow: s.top >= name.parentElement.getBoundingClientRect().bottom - 0.5, text: name.textContent,
      fits: document.documentElement.scrollWidth <= innerWidth };
  });
};

console.log('\na username for a name, on a phone');
await setName('alexander.golik16');
let h = await head();
ok('the name stays on the card', h.nameInside, true);
ok('and so does the badge, under it', [h.badgeInside, h.badgeBelow], [true, true]);
ok('the name reads as it was typed', h.text, 'alexander.golik16');
ok('and the page does not scroll sideways', h.fits, true);

console.log('\na short name');
await setName('Jason');
h = await head();
ok('keeps the badge beside it', [h.nameInside, h.badgeInside, h.badgeBelow], [true, true, false]);

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
