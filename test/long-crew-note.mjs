// A long crew note on the race page's course list, on a phone. It used to sit
// on one unbreakable line, push its row past the edge of the screen and take
// the leg's time with it ("01:0").
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

await page.goto(BASE + `/race.html?id=${SLUG}`);
await page.waitForSelector('.seg-row .st-tag.note', { state: 'attached', timeout: 20000 });
// The course list sits in a collapsed section on some layouts; open whatever holds it.
await page.evaluate(() => { const r = document.querySelector('.seg-row'); let p = r; while (p) { if (p.tagName === 'DETAILS') p.open = true; p.classList && p.classList.remove('collapsed'); p = p.parentElement; } });
await page.waitForTimeout(300);
const rows = await page.$$eval('.seg-row', rs => rs.filter(r => r.querySelector('.st-tag.note') && r.querySelector('.st-tag.note').textContent.length > 60).map(r => {
  const box = r.getBoundingClientRect(), note = r.querySelector('.st-tag.note').getBoundingClientRect();
  const dur = r.querySelector('.col-dur'), d = dur.getBoundingClientRect();
  return { text: r.querySelector('.st-tag.note').textContent, rowFits: r.scrollWidth <= r.clientWidth + 1,
    noteInside: note.right <= box.right + 1, noteLines: Math.round(note.height / parseFloat(getComputedStyle(r.querySelector('.st-tag.note')).lineHeight)),
    time: dur.textContent.trim(), timeInside: d.right <= box.right + 1 && dur.scrollWidth <= dur.clientWidth + 1 };
}));
ok('both notes are there, whole', rows.map(r => r.text), [LONG, COORDS]);
ok('each row stays inside the screen', rows.map(r => r.rowFits), [true, true]);
ok('the note wraps inside its row', rows.map(r => [r.noteInside, r.noteLines > 1]), [[true, true], [true, true]]);
ok('and the leg time is all there', rows.map(r => [/^\d\d:\d\d(:\d\d)?$/.test(r.time), r.timeInside]), [[true, true], [true, true]]);
ok('nothing pushes the page sideways', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
await page.screenshot({ path: process.env.SHOT || '/dev/null', fullPage: false }).catch(() => {});

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
