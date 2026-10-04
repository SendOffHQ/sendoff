// Crew notes on an aid station (the lot, the walk-in, a pin) are for the crew
// driving there, so they are on the pit board, beside the racer being met, and
// not on the race page. A long one on the race page used to sit on one
// unbreakable line, push its row past the edge of a phone and take the leg's
// time with it ("01:0").
//
//   node test/long-crew-note.mjs
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
const ctx = await b.newContext({ viewport: { width: 360, height: 800 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(BASE + '/index.html');
await page.evaluate(base => {
  localStorage.setItem('race-hub-session-v1', JSON.stringify({ session: 'stub', proxyUrl: base + '/api',
    email: 'crew@example.com', role: 'owner', expiresAt: Date.now() + 7 * 24 * 3600e3 }));
  localStorage.setItem('race-hub-tutorial-v1', JSON.stringify({ race: 99 }));
}, BASE);
// Two long notes on legs that have been run, so each row also has a time.
const LONG = 'Very limited parking. Skip it unless the runner needs something, and if you go, use the gravel lot past the second gate on the left';
const COORDS = '41.4008686, -89.7981585, took 2 Tylenol at the last stop and wants the blue bottle back';
await page.evaluate(async ([slug, a, c]) => {
  const r = await (await fetch(`/api/get?path=races/${slug}/config.json`, { headers: { Authorization: 'Bearer stub' } })).json();
  const cfg = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(r.content), x => x.charCodeAt(0))));
  delete cfg.myRole;
  cfg.course.segments[0].crewNote = a;
  cfg.course.segments[1].crewNote = c;
  cfg.course.segments[1].dropBag = true;
  await fetch('/api/commit', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer stub' },
    body: JSON.stringify({ path: `races/${slug}/config.json`, content: JSON.stringify(cfg), message: 'note' }) });
}, [SLUG, LONG, COORDS]);

const setLegs = (legs) => page.evaluate(async ([slug, legs]) => {
  await fetch('/api/commit', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer stub' },
    body: JSON.stringify({ path: `races/${slug}/data.json`, content: JSON.stringify({ runners: [{ id: 'jason', legs }] }), message: 'legs' }) });
}, [SLUG, legs]);
const t = (h) => new Date(Date.parse('2026-09-07T14:11:13Z') + h * 3600e3).toISOString();

console.log('\nthe race page');
await setLegs([{ index: 1, startTime: t(0), endTime: t(2.3) }, { index: 2, startTime: t(2.35), endTime: t(3) }]);
await page.goto(BASE + `/race.html?id=${SLUG}`);
await page.waitForSelector('.seg-row', { state: 'attached', timeout: 20000 });
const course = await page.$eval('body', b => b.textContent);
ok('carries no crew notes', [course.includes('gravel lot'), course.includes('Tylenol'), course.includes('Crew lot C1')], [false, false, false]);
ok('but still says where a drop bag is', await page.$$eval('.seg-row .st-tag.bag', els => els.length > 0), true);
const rows = await page.$$eval('.seg-row', rs => rs.map(r => {
  const box = r.getBoundingClientRect(), dur = r.querySelector('.col-dur'), d = dur.getBoundingClientRect();
  return r.scrollWidth <= r.clientWidth + 1 && d.right <= box.right + 1 && dur.scrollWidth <= dur.clientWidth + 1;
}));
ok('and every row, leg time included, fits a phone', rows.every(Boolean), true);

console.log('\nthe pit board');
const stop = async () => {
  await page.goto(BASE + `/pit.html?id=${SLUG}`);
  await page.waitForSelector('article.runner .where', { timeout: 20000 });
  return page.$eval('article.runner', a => {
    const s = a.querySelector('.where .stop'), n = s && s.querySelector('.stop-note');
    const card = a.getBoundingClientRect(), nb = n && n.getBoundingClientRect();
    return s && { line: s.firstElementChild.textContent + ' ' + s.querySelector('strong').textContent,
      tags: [...s.querySelectorAll('.stop-tag')].map(x => x.textContent), note: n ? n.textContent : null,
      wraps: n ? nb.right <= card.right + 1 && nb.height > 30 : null };
  });
};
await setLegs([{ index: 1, startTime: t(0) }]);
let st = await stop();
ok('on course: where to meet the racer, with its note', [st.line, st.note], ['Meet at Music Pass', LONG]);
ok('a long note wraps inside the card', st.wraps, true);
await setLegs([{ index: 1, startTime: t(0), endTime: t(2.3) }]);
st = await stop();
ok('in the pit: where the crew goes next', [st.line, st.tags, st.note], ['Next stop Music Meadows 1', ['Drop bag'], COORDS]);
ok('nothing pushes the pit board sideways', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
