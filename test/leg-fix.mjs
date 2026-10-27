// Correcting legs from a file, after the race. Asked for 2026-10-27, after
// Lake Murray: four check-ins missed in the night and two pressed at the wrong
// time, with the real times in the racer's Strava track. Settings, Racers and
// fueling offers a template of the racer's legs and takes back a CSV of just
// the legs that were wrong, once the race is over and not before.
//
//   node test/leg-fix.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const TMP = path.join(os.tmpdir(), 'leg-fix-test.csv');
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
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', acceptDownloads: true });
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

// Saturday 10 October 2026, 6 AM in Chicago. Legs of an hour each with a
// minute at each station; legs 2 and 3 a missed check-in shared out.
const cfg = await api(CFG); delete cfg.myRole;
cfg.timezone = 'America/Chicago'; cfg.startTime = '2026-10-10T06:00:00-05:00';
cfg.runners = [{ id: 'faj', name: 'Fajita' }];
await api(CFG, cfg);
const at = (h, m = 0) => new Date(Date.parse('2026-10-10T11:00:00Z') + (h * 60 + m) * 60e3).toISOString();
const legs = [
  { index: 1, startTime: at(0), endTime: at(1) },
  { index: 2, startTime: at(1, 1), endTime: at(2, 30), skipped: true },
  { index: 3, startTime: at(2, 30), endTime: at(4) },
  { index: 4, startTime: at(4, 2), endTime: at(5) }];
await api(DATA, { runners: [{ id: 'faj', legs }] });

const open = async () => {
  await page.goto(BASE + `/settings.html?id=${SLUG}`);
  await page.waitForSelector('#runner-editor-head', { timeout: 20000 });
  await page.click('#runner-editor-head');
  await page.waitForTimeout(400);
};

console.log('\nin Settings, once the race is over');
await open();
ok('offered beside Ran together', await page.isVisible('#leg-fix'), true);
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#leg-fix-template')]);
const tpl = fs.readFileSync(await dl.path(), 'utf8').trim().split('\n');
ok('a template of the racer\'s legs, on the race\'s clock', tpl[0], 'Leg,Aid station,Mile,Arrived,Left');
ok('arrivals and departures as written', [tpl[1].split(',').slice(-2), tpl[3].split(',').slice(-2)],
  [['2026-10-10 07:00:00', '2026-10-10 07:01:00'], ['2026-10-10 10:00:00', '2026-10-10 10:02:00']]);
ok('a row per leg of the course', tpl.length - 1, 16);

console.log('\nimporting just the legs that were wrong');
// The shape of the Strava file sent on 2026-10-27: weekday times, a Needs
// fixing column, and a crew column that is not the one to read.
const csv = ['Leg,Aid station,Mile,Arrived (Strava),Left (Strava),Crew logged arrival,Needs fixing',
  '1,Colony Creek 1,4.3,Sat 7:00:00 AM,Sat 7:01:00 AM,Sat 7:00:00 AM,',
  '2,Music Meadows 1,8.6,Sat 8:20:06 AM,Sat 8:22:00 AM,est.,yes',
  '3,Horn Creek 1,15.2,Sat 9:55:30 AM,Sat 9:58:00 AM,Sat 10:00:00 AM,yes'].join('\n');
fs.writeFileSync(TMP, csv);
let asked = '';
page.once('dialog', d => { asked = d.message(); d.accept(); });
await page.setInputFiles('#leg-fix-file', TMP);
await page.waitForFunction(() => /Done/.test(document.getElementById('leg-fix-note').textContent), null, { timeout: 10000 });
ok('it asks first, listing the times', /Put these times on Fajita's legs\?/.test(asked) && /Leg 2: arrived Sat 8:20:06 AM, left Sat 8:22:00 AM/.test(asked), true);
const got = (await api(DATA)).runners[0].legs;
ok('arrivals end their leg, departures start the next', got.map(l => [l.index, l.startTime, l.endTime]), [
  [1, at(0), at(1)], [2, at(1, 1), new Date(Date.parse(at(2)) + (20 * 60 + 6) * 1000).toISOString()],
  [3, at(2, 22), new Date(Date.parse(at(3)) + (55 * 60 + 30) * 1000).toISOString()], [4, at(3, 58), at(5)]]);
ok('a missed check-in, once timed, is no longer an estimate', got[1].skipped, undefined);
ok('only the rows marked for fixing', got[0].endTime, at(1));
ok('it says what it did', (await page.textContent('#leg-fix-note')).trim(), "Done: 2 legs of Fajita's corrected from leg-fix-test.csv.");

console.log('\na file with a mistake in it');
fs.writeFileSync(TMP, 'Leg,Arrived,Left\n3,Sat 9:70 AM,\n');
await page.setInputFiles('#leg-fix-file', TMP);
await page.waitForFunction(() => /not imported/.test(document.getElementById('leg-fix-note').textContent), null, { timeout: 10000 });
ok('is turned away, saying where', /Row 2: "Sat 9:70 AM" is not a time/.test(await page.textContent('#leg-fix-note')), true);
fs.writeFileSync(TMP, 'Leg,Arrived,Left\n3,2026-10-10 12:00:00,2026-10-10 12:05:00\n');
await page.setInputFiles('#leg-fix-file', TMP);
await page.waitForFunction(() => /With these times/.test(document.getElementById('leg-fix-note').textContent), null, { timeout: 10000 });
ok('as is one that would leave the next leg ending before it began', /Leg 4 would end before it started/.test(await page.textContent('#leg-fix-note')), true);
ok('and nothing changed', (await api(DATA)).runners[0].legs[2].endTime, got[2].endTime);

console.log('\nduring the race');
const live = await api(CFG); delete live.myRole;
live.startTime = new Date(Date.now() - 3600e3).toISOString();
await api(CFG, live);
await open();
ok('it is not offered', await page.isVisible('#leg-fix'), false);

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
