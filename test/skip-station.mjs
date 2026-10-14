// A station gone by with no check-in. The racer leaves the phone at the start,
// runs out to Music Pass and back, and picks it up again at Music Meadows,
// where the next thing to press is Music Pass. Pressed, that was a long leg
// out and a one-second leg back. Skipped, from the Undo bar, it is one
// stretch from the start to Music Meadows, with Music Pass marked as missed,
// and the race page, the pit board and the printed report show it as one time.
//
//   node test/skip-station.mjs
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
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(BASE + '/index.html');
await page.evaluate(base => {
  localStorage.setItem('race-hub-session-v1', JSON.stringify({ session: 'stub', proxyUrl: base + '/api',
    email: 'crew@example.com', role: 'owner', expiresAt: Date.now() + 7 * 24 * 3600e3 }));
  localStorage.setItem('race-hub-tutorial-v1', JSON.stringify({ racer: 99, pit: 99, race: 99 }));
}, BASE);
const readLegs = () => page.evaluate(async (slug) => {
  const r = await (await fetch(`/api/get?path=races/${slug}/data.json`, { headers: { Authorization: 'Bearer stub' } })).json();
  const d = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(r.content), c => c.charCodeAt(0))));
  return d.runners[0].legs;
}, SLUG);
const setLegs = (legs) => page.evaluate(async ([slug, legs]) => {
  await fetch('/api/commit', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer stub' },
    body: JSON.stringify({ path: `races/${slug}/data.json`, content: JSON.stringify({ runners: [{ id: 'jason', legs }] }), message: 'legs' }) });
}, [SLUG, legs]);
const leg = async (i) => (await readLegs()).find(l => l.index === i) || {};
const until = async (test, n = 60) => { for (let i = 0; i < n; i++) { try { if (await test()) return true; } catch (e) {} await page.waitForTimeout(150); } return false; };
const openRacer = async () => {
  await page.goto(BASE + `/racer.html?id=${SLUG}&runner=jason`);
  await page.waitForSelector('#go', { timeout: 20000 });
};
const ago = (min) => new Date(Date.now() - min * 60e3).toISOString();
const START = ago(120);

await setLegs([{ index: 1, startTime: START }]);
await openRacer();

console.log('\nthe core');
const core = await page.evaluate(async (slug) => {
  const r = await (await fetch(`/api/get?path=races/${slug}/config.json`, { headers: { Authorization: 'Bearer stub' } })).json();
  const cfg = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(r.content), c => c.charCodeAt(0))));
  const s = '2026-01-01T10:00:00.000Z', e = '2026-01-01T12:00:00.000Z';
  const w = Race.skip.legs(cfg, 1, 1, s, e);
  const doc = { runners: [{ id: 'j', legs: [{ index: 1, startTime: s, endTime: e, skipped: true }, { index: 2, startTime: e }] }] };
  const legs = [{ index: 1, startTime: s, endTime: '2026-01-01T11:00:00.000Z', skipped: true },
                { index: 2, startTime: '2026-01-01T11:00:00.000Z', endTime: e }, { index: 3, startTime: e }];
  return {
    // Music Pass is 4.3 mi and 2,824 ft up; the way back 4.3 mi down.
    share: Math.round((Date.parse(w[1].endTime) - Date.parse(s)) / (Date.parse(e) - Date.parse(s)) * 1000) / 1000,
    written: Object.keys(w).map(Number), flags: [w[1].skipped, w[2].skipped, w[2].endTime === e, w[2].startTime === w[1].endTime],
    span: [Race.skip.span(legs, 1), Race.skip.span(legs, 2), Race.skip.span(legs, 3)],
    missed: Race.skip.missed(cfg, { first: 1, last: 2 }),
    // The ops, as the queue replays them: a null clears a field, an arrival
    // undone from the pit board takes its skip with it, and one undone from
    // the racer's bar takes the legs it opened too.
    ops: (() => {
      const run = (op, args) => {
        localStorage.setItem('sendoff-queue-v1', JSON.stringify([{ id: 'x', path: 'p', op, args, tries: 0 }]));
        try { return Race.queue.applyTo('p', JSON.parse(JSON.stringify(doc))).runners[0].legs; }
        finally { localStorage.removeItem('sendoff-queue-v1'); }
      };
      return [run('setLegTimes', { runnerId: 'j', legs: { 1: { skipped: null, feelIn: 'ok' } } })[0],
              run('clearLegField', { runnerId: 'j', legIndex: 1, field: 'endTime' })[0],
              run('reopenLeg', { runnerId: 'j', legIndex: 1, upTo: 2 })];
    })()
  };
}, SLUG);
ok('the time is shared out by distance and climb', core.share, Math.round(7.124 / 11.424 * 1000) / 1000);
ok('the missed station is marked, the next leg ends at the press', [core.written, core.flags], [[1, 2], [true, undefined, true, true]]);
ok('and the stretch is one time', core.span, [{ first: 1, last: 2, sec: 7200 }, { first: 1, last: 2, sec: 7200 }, null]);
ok('named by the station that was missed', core.missed, ['Music Pass']);
ok('a null clears a field', core.ops[0], { index: 1, startTime: '2026-01-01T10:00:00.000Z', endTime: '2026-01-01T12:00:00.000Z', feelIn: 'ok' });
ok('an arrival undone is not skipped any more', core.ops[1], { index: 1, startTime: '2026-01-01T10:00:00.000Z' });
ok('and reopened, the legs it opened go with it', core.ops[2], [{ index: 1, startTime: '2026-01-01T10:00:00.000Z' }]);

console.log('\nthe phone left at the start');
ok('the next thing to press is Music Pass', /arrived at music pass/i.test(await page.textContent('#go')), true);
await page.click('#go');
await page.waitForSelector('.rundo #skip', { timeout: 5000 });
ok('the Undo bar offers Skipped, saying where that puts them',
  (await page.textContent('#skip')).replace(/\s+/g, ' ').trim(), 'Skipped · check-in missed Past Music Pass, at Music Meadows 1 now');
ok('and it all fits a phone', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
await until(async () => !!(await leg(2)).startTime);
await page.click('.rundo-feel [data-feel="good"]');
await until(async () => (await leg(1)).feelIn === 'good');
await page.click('#skip');
const skipped = await until(async () => (await leg(1)).skipped === true && !!(await leg(2)).endTime && (await leg(2)).feelIn === 'good');
ok('Skipped makes it the arrival at Music Meadows', skipped, true);
let l1 = await leg(1), l2 = await leg(2);
const total = Date.parse(l2.endTime) - Date.parse(START);
ok('one stretch from the start, shared out across the two legs',
  [l1.endTime === l2.startTime, Math.round((Date.parse(l1.endTime) - Date.parse(START)) / total * 100) / 100, Math.abs(Date.now() - Date.parse(l2.endTime)) < 30000],
  [true, Math.round(7.124 / 11.424 * 100) / 100, true]);
ok('the feeling moves with the arrival', [l1.feelIn, l2.feelIn], [undefined, 'good']);
ok('no leg past it', (await readLegs()).map(l => l.index), [1, 2]);
ok('the bar says where they are and what was skipped',
  [/Music Meadows 1/.test(await page.textContent('.rundo .stamp')), await page.textContent('.rundo .skipped')],
  [true, 'Skipped: Music Pass']);
ok('and offers the next one along', /Past Music Meadows 1, at Colony Creek 1 now/.test(await page.textContent('#skip')), true);

console.log('\nundone');
await page.click('#undo');
const undone = await until(async () => { const ls = await readLegs(); return ls.length === 1 && !ls[0].endTime; });
ok('the whole press goes: back out on the way to Music Pass', [undone, await leg(1)], [true, { index: 1, startTime: START }]);
await page.waitForSelector('#go');
ok('with the press to make again', /arrived at music pass/i.test(await page.textContent('#go')), true);

console.log('\nan Undo at a checkpoint, skipped or not');
await page.click('#go');
await until(async () => !!(await leg(2)).startTime);
await page.click('#undo');
ok('takes back the arrival as well as the leg it opened',
  await until(async () => { const ls = await readLegs(); return ls.length === 1 && !ls[0].endTime; }), true);

console.log('\ntwo stations missed');
await page.waitForSelector('#go');
await page.click('#go');
await page.waitForSelector('#skip');
await page.click('#skip');
await page.waitForSelector('.rundo .skipped');
await page.click('#skip');
await until(async () => !!(await leg(3)).endTime);
const ls2 = await readLegs();
ok('a second tap skips the next one too', [ls2.map(l => [l.index, !!l.skipped, !!l.endTime]), await page.textContent('.rundo .skipped')],
  [[[1, true, true], [2, true, true], [3, false, true]], 'Skipped: Music Pass, Music Meadows 1']);
ok('each leg starting where the last one was put', [ls2[0].endTime === ls2[1].startTime, ls2[1].endTime === ls2[2].startTime], [true, true]);

console.log('\nthe pages, once it stands');
await setLegs([{ index: 1, startTime: START }]);
await openRacer();
await page.click('#go');
await page.waitForSelector('#skip');
await page.click('#skip');
await until(async () => !!(await leg(2)).endTime);
l1 = await leg(1); l2 = await leg(2);
const stretch = await page.evaluate(([a, b]) => Race.fmt.durationShort((Date.parse(b) - Date.parse(a)) / 1000), [START, l2.endTime]);
await openRacer();
ok('the racer is in at Music Meadows, next out to Colony Creek', /leaving · to colony creek 1/i.test(await page.textContent('#go')), true);

await page.goto(BASE + `/race.html?id=${SLUG}`);
await page.waitForSelector('.seg-row', { state: 'attached', timeout: 20000 });
const rows = await page.$$eval('.seg-list .seg-row:not(.start)', rs => rs.slice(0, 2).map(r => ({
  tag: !!r.querySelector('.st-tag.skip'), dur: r.querySelector('.col-dur').textContent.trim(),
  line: (r.querySelector('.skip-line') || {}).textContent || null, pit: r.querySelector('.col-pit').textContent.trim() })));
ok('the race page: Music Pass marked, one time for the two legs', rows, [
  { tag: true, dur: stretch, line: 'One time for legs 1 to 2', pit: '' },
  { tag: false, dur: 'with 1', line: null, pit: rows[1].pit }]);
const log = await page.$$eval('.leglog tr.leg-row', rs => rs.map(r => [...r.querySelectorAll('td')].slice(1, 3).map(td => td.textContent.trim())));
ok('and the leg log: no time at Music Pass, the stretch on its first leg', [log.find(r => r[1] === stretch) && log.find(r => r[1] === stretch)[0], log.some(r => r[1] === 'with 1')], ['–', true]);

await page.goto(BASE + `/pit.html?id=${SLUG}`);
await page.waitForSelector('.intake-times', { timeout: 20000 });
const pitLine = (await page.textContent('.intake-times')).replace(/\s+/g, ' ').trim();
ok('the pit board: no check-in on the way out, and the stretch',
  [/^Out no check-in ?In \S+/.test(pitLine), pitLine.includes('Legs 1 to 2')], [true, true]);

console.log('\na real time from somebody who saw it');
await page.selectOption('select[data-intake-leg]', '1');
await page.waitForFunction(() => /no check-in/.test((document.querySelector('.intake-times') || {}).textContent || '') &&
  /^Out/.test(document.querySelector('.intake-times').textContent.trim()) && document.querySelector('[data-action="edit-time"][data-leg="1"]'));
await page.click('[data-action="edit-time"][data-leg="1"][data-field="endTime"]');
await page.waitForSelector('.edit-time [data-edit="time"]');
ok('the box says it is an estimate', /No check-in here/.test(await page.textContent('.edit-time')), true);
await page.click('.modal-primary');
const fixed = await until(async () => !(await leg(1)).skipped);
l1 = await leg(1); l2 = await leg(2);
ok('saved, it is the check-in, on both legs', [fixed, l1.endTime === l2.startTime, l1.skipped], [true, true, undefined]);

console.log('\nthe finish');
const legs14 = Array.from({ length: 13 }, (_, i) => ({ index: i + 1, startTime: ago(900 - i * 60), endTime: ago(841 - i * 60) }));
await setLegs(legs14.concat([{ index: 14, startTime: ago(60) }]));
await openRacer();
await page.click('#go');
await page.waitForSelector('#skip');
ok('past Music Meadows 3 is Music Pass 2', /Past Music Meadows 3, at Music Pass 2 now/.test(await page.textContent('#skip')), true);
await page.click('#skip');
await until(async () => !!(await leg(16)).startTime);
ok('a checkpoint skipped to is passed through, as a press there is', [!!(await leg(15)).endTime, !!(await leg(16)).startTime, !!(await leg(16)).endTime], [true, true, false]);
ok('and then the finish', /Past Music Pass 2, at Finish now/.test(await page.textContent('#skip')), true);
await page.click('#skip');
await until(async () => !!(await leg(16)).endTime);
ok('which ends the race, with nothing past it to skip to', [!!(await leg(16)).endTime, !!(await leg(15)).skipped, await page.$('#skip')], [true, true, null]);

console.log('\na lap with no tap at its end');
const cfgNow = await page.evaluate(async (slug) => {
  const r = await (await fetch(`/api/get?path=races/${slug}/config.json`, { headers: { Authorization: 'Bearer stub' } })).json();
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(r.content), c => c.charCodeAt(0))));
}, SLUG);
cfgNow.courseType = 'loops';
cfgNow.course = { loopDistanceMi: 5, loopCount: 10 };
await page.evaluate(async ([slug, cfg]) => {
  await fetch('/api/commit', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer stub' },
    body: JSON.stringify({ path: `races/${slug}/config.json`, content: JSON.stringify(cfg), message: 'loops' }) });
}, [SLUG, cfgNow]);
await setLegs([{ index: 1, startTime: ago(180), endTime: ago(130) },
               { index: 2, startTime: ago(129), endTime: ago(79), skipped: true },
               { index: 3, startTime: ago(79), endTime: ago(29) }]);
await page.goto(BASE + `/race.html?id=${SLUG}`);
await page.waitForSelector('.legs-grid .leg-cell', { state: 'attached', timeout: 20000 });
const cells = await page.$$eval('.legs-grid .leg-cell', cs => cs.slice(0, 4).map(c => c.querySelector('.t').textContent.trim()));
const twoLaps = await page.evaluate(() => Race.fmt.durationShort(100 * 60));
ok('the lap grid: the two laps as one time, the second pointing back', cells.slice(1, 3), [twoLaps, 'with L2']);
ok('saying why', await page.getAttribute('.legs-grid .leg-cell:nth-child(2)', 'title'), 'No tap at the end of Lap 2: one time for laps 2 to 3');

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
