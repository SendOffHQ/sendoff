// Counts what the race page actually asks for. Adaptive polling is a claim
// about a number of requests, and nothing but counting them is evidence.
//
// No race in the repo is live today, so the "in progress" runs happen in a
// context whose clock is pinned inside the dry run's window. The finished run
// uses the real clock, because six-0 really is finished.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net'; import fs from 'node:fs';
const BASE = 'http://localhost:8787';
// Six-0 for both, because it is real. For the live runs its clock is pinned
// mid-race and its data truncated to the legs that had happened by then, so
// the page sees a race in progress rather than one whose every leg is logged.
// A finished race is finished by completion, not only by the clock, which is
// why pinning alone was not enough.
const SLUG = 'six-0-trail-marathon';
const MIDRACE = Date.parse('2026-09-05T14:15:00.000Z');
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
  console.log(`  ${q?'ok  ':'FAIL'} ${l.padEnd(50)} ${JSON.stringify(g)}${q?'':' want '+JSON.stringify(w)}`)};

// The service worker would answer some reads from cache and hide them. The
// question is what leaves the page.
async function fresh(midRace) {
  const ctx = await b.newContext({ viewport:{width:390,height:844}, serviceWorkers:'block' });
  const page = await ctx.newPage();
  if (midRace) {
    const cut = (doc) => {
      for (const r of doc.runners || []) {
        r.legs = (r.legs || []).filter(l => Date.parse(l.startTime) <= MIDRACE).slice(0, 3);
        const last = r.legs[r.legs.length - 1];
        if (last) delete last.endTime;
      }
      return doc;
    };
    await page.route('**/api/get**', async (route) => {
      if (!/data\.json/.test(route.request().url())) return route.continue();
      const env = await (await route.fetch()).json();
      const doc = cut(JSON.parse(Buffer.from(env.content, 'base64').toString('utf8')));
      env.content = Buffer.from(JSON.stringify(doc), 'utf8').toString('base64');
      await route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify(env) });
    });
    await page.route(`**/races/${SLUG}/data.json*`, async (route) => {
      const doc = cut(await (await route.fetch()).json());
      await route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify(doc) });
    });
  }
  if (midRace) await page.addInitScript(`{
    const real = Date.now.bind(Date), base = real(), D = Date;
    const at = () => ${MIDRACE} + (real() - base);
    const shim = new Proxy(D, {
      construct(t, a) { return a.length ? new t(...a) : new t(at()); },
      apply() { return new D(at()).toString(); }
    });
    shim.now = at;
    window.Date = shim;
  }`);
  await page.goto(BASE + '/index.html');
  await page.evaluate(b => localStorage.setItem('race-hub-session-v1', JSON.stringify({
    session:'stub', proxyUrl:b+'/api', email:'crew@example.com', role:'crew',
    expiresAt: Date.now()+7*24*3600e3 })), BASE);
  return page;
}

const setHidden = (page, v) => page.evaluate((h) => {
  Object.defineProperty(document, 'hidden', { get: () => h, configurable: true });
  Object.defineProperty(document, 'visibilityState', { get: () => h ? 'hidden' : 'visible', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}, v);

async function count(page, seconds) {
  let n = 0;
  const on = r => { if (/data\.json|\/api\/get/.test(r.url())) n++; };
  page.on('request', on);
  await page.waitForTimeout(seconds * 1000);
  page.off('request', on);
  return n;
}

console.log('\na race in progress, tab in front of you');
let page = await fresh(true);
await page.goto(`${BASE}/race.html?id=${SLUG}`);
await page.waitForTimeout(5000);                 // let the first load finish
ok('the page agrees it is live', await page.evaluate(async () => {
  const cfg = await Race.gh.readRaceJson(Race.qs('id'), 'config.json', true);
  const data = await Race.gh.readRaceJson(Race.qs('id'), 'data.json', true);
  return Race.raceState(cfg, data);
}), 'live');
const live = await count(page, 16);
console.log(`     ${live} data reads in 16s`);
ok('asks more than once every ten seconds', live >= 2, true);

console.log('\nthe same race, tab hidden');
await setHidden(page, true);
const hidden = await count(page, 16);
console.log(`     ${hidden} data reads in 16s`);
ok('stops asking entirely', hidden, 0);

console.log('\nand wakes when you come back to it');
let woke = 0;
const onWake = r => { if (/data\.json|\/api\/get/.test(r.url())) woke++; };
page.on('request', onWake);
await setHidden(page, false);
await page.waitForTimeout(1500);
page.off('request', onWake);
ok('refreshes at once rather than waiting an interval', woke >= 1, true);
await page.context().close();

console.log('\na race that finished days ago');
page = await fresh(false);
await page.goto(`${BASE}/race.html?id=${SLUG}`);
await page.waitForTimeout(5000);
const done = await count(page, 16);
console.log(`     ${done} data reads in 16s`);
ok('is left nearly alone', done, 0);
await page.context().close();

await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad?1:0);
