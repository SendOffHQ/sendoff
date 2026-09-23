// A settings change reaching a race page that is already open.
//
// Reported on 2026-09-22: drop bags were changed on Sangre de Cristo 100 and
// the race page went on showing the old ones. The write had landed; what had
// not happened was anybody telling the page. The worker's push fired for
// data.json alone, and the pages re-read the config at most once a minute and
// only when a poll happens to fire, so an edit took up to two minutes to
// appear with nothing on screen to say it was coming.
//
// The worker half is worker/test/live-push.mjs: the push now names the file.
// This is the other half, in a real browser: the page has to act on that name.
// The sharp assertion is the last one, because "any nudge re-reads everything"
// would pass every check but the one that costs a poll on every split.
//
// The socket is stood in for rather than served. What is under test is what
// the page does with a message, not the framing it arrived in, and the harness
// does not speak websocket.
//
//   node test/live-push.mjs
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
  console.log(`  ${q?'ok  ':'FAIL'} ${l.padEnd(52)} ${JSON.stringify(g)}${q?'':' want '+JSON.stringify(w)}`)};

const ctx = await b.newContext({ viewport:{width:1000,height:1200}, serviceWorkers:'block' });

// Stands in for the socket, before any page script runs. It records what the
// page opened and hands back a way to deliver a message to it.
await ctx.addInitScript(() => {
  window.__sockets = [];
  window.WebSocket = class {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      window.__sockets.push(this);
      setTimeout(() => { try { this.onopen && this.onopen(); } catch (e) {} }, 0);
    }
    close() { this.readyState = 3; }
    send() {}
  };
  window.__push = (obj) => {
    const s = window.__sockets[window.__sockets.length - 1];
    if (!s || !s.onmessage) return false;
    s.onmessage({ data: JSON.stringify(obj) });
    return true;
  };
});

const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));

await page.goto(BASE + '/index.html');
await page.evaluate(base => localStorage.setItem('race-hub-session-v1', JSON.stringify({
  session:'stub', proxyUrl: base + '/api', email:'crew@example.com', role:'owner',
  expiresAt: Date.now() + 7*24*3600e3 })), BASE);
await page.evaluate(base => fetch(base + '/live-on'), BASE);

await page.goto(BASE + `/race.html?id=${SLUG}`);
await page.waitForSelector('.seg-row', { timeout: 20000 });
await page.waitForTimeout(1500);

const bags = () => page.evaluate(() => document.querySelectorAll('.st-tag.bag').length);

console.log('\nthe page opens a socket for this race');
ok('one was opened', await page.evaluate(() => window.__sockets.length >= 1), true);
ok('for the right race', await page.evaluate(s =>
  window.__sockets[0].url.includes('race=' + s), SLUG), true);
ok('over ws, off the proxy address', await page.evaluate(() =>
  window.__sockets[0].url.startsWith('ws://localhost:8787/api/live')), true);

// The config as the page has it, and the same config with one more drop bag
// written behind its back. The page is holding a copy it believes is good for
// a minute, which is exactly the state the report was made from.
const before = await bags();
ok('the race has drop bags to count', before > 0, true);

const addBag = async () => page.evaluate(async (slug) => {
  const r = await fetch(`/api/get?path=races/${slug}/config.json`, {
    headers: { Authorization: 'Bearer stub' } });
  const env0 = await r.json();
  const cfg = JSON.parse(atob(env0.content));
  const seg = (cfg.course.segments || []).find(s => !s.dropBag);
  if (!seg) return null;
  seg.dropBag = true;
  await fetch('/api/commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer stub' },
    body: JSON.stringify({ path: `races/${slug}/config.json`,
                           content: JSON.stringify(cfg, null, 2) + '\n', message: 'test' })
  });
  return seg.toAid || true;
}, SLUG);

console.log('\na drop bag is added while the page sits there');
ok('the station was changed', !!(await addBag()), true);
await page.waitForTimeout(600);
ok('the page has not noticed on its own', await bags(), before);

console.log('\nand the worker says the config moved');
ok('the message is delivered', await page.evaluate(() =>
  window.__push({ type: 'changed', slug: 'x', file: 'config.json',
                  at: new Date().toISOString() })), true);
await page.waitForFunction((n) =>
  document.querySelectorAll('.st-tag.bag').length !== n, before, { timeout: 8000 })
  .catch(() => {});
const after = await bags();
ok('the page re-read the config', after > before, true);

// The one that matters for cost. A split arrives every few minutes on a busy
// race and must not drag a config read along with it, which is the whole
// reason that read is cached for a minute in the first place.
console.log('\na split says nothing about the config');
ok('another station was changed', !!(await addBag()), true);
await page.evaluate(() => window.__push({ type: 'changed', slug: 'x', file: 'data.json',
                                          at: new Date().toISOString() }));
await page.waitForTimeout(1500);
ok('which does not re-read it', await bags(), after);

// An older worker sends no file at all. The page must still refresh on the
// poll it already runs rather than throwing or going deaf.
console.log('\na worker that predates the field');
ok('a message with no file is survivable', await page.evaluate(() =>
  window.__push({ type: 'changed', slug: 'x', at: new Date().toISOString() })), true);
ok('and one that is not JSON at all', await page.evaluate(() => {
  const s = window.__sockets[window.__sockets.length - 1];
  s.onmessage({ data: 'not json' });
  return true;
}), true);
await page.waitForTimeout(500);
ok('the page is still standing', await page.evaluate(() =>
  document.querySelectorAll('.seg-row').length > 0), true);

// The bug underneath the bug. live() used to read hub.json's answer on the
// spot and give up when it was still null, with no retry. pit.html and
// racer.html call it from inside an async function, after awaits, so theirs
// had landed; race.html calls it in the same tick its script starts, so the
// race page never opened a socket at all and nobody noticed, because the poll
// underneath made it slower rather than wrong.
console.log('\nevery page that watches a race opens one');
for (const file of ['race.html', 'pit.html', 'racer.html']) {
  const q = await ctx.newPage();
  const qerrs = [];
  q.on('pageerror', e => qerrs.push(e.message));
  await q.goto(BASE + `/${file}?id=${SLUG}`);
  await q.waitForFunction(() => window.__sockets.length > 0, null, { timeout: 15000 })
    .catch(() => {});
  ok(file, await q.evaluate(s => {
    const w = window.__sockets[0];
    return !!w && w.url.includes('/live?race=' + s);
  }, SLUG), true);
  ok(`  ${file} with no errors`, qerrs, []);
  await q.close();
}

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
