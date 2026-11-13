// The racer screen, from the review of 2026-11-12.
//
//   - An undo made with no signal is sent whenever the phone next has some.
//     If the crew checked the racer in for real in the meantime, the late
//     press and its undo used to overwrite and then erase that check-in.
//   - A tap on an item sent the leg's whole new total, worked out from the
//     phone's copy. Anything the crew or an AI crew had logged since the
//     phone last refreshed was replaced. The same for a note.
//   - A racer added after the race began had a Start button that did nothing.
//   - The big button was rebuilt on every refresh, so a tap that straddled a
//     refresh was lost.
//   - A press that had landed was not written to the phone's saved copy, so
//     a phone that then lost signal showed the button as if never pressed.
//
//   node test/review-racer.mjs
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

// The crew, somewhere with signal: straight to the server from here, not
// through the phone, which for part of this has none.
const AUTH = { Authorization: 'Bearer stub', 'Content-Type': 'application/json' };
const crewRead = async (file) => {
  const r = await (await fetch(`${BASE}/api/get?path=races/${SLUG}/${file}`, { headers: AUTH })).json();
  return JSON.parse(Buffer.from(r.content, 'base64').toString('utf8'));
};
const crewWrite = (file, doc) => fetch(`${BASE}/api/commit`, { method: 'POST', headers: AUTH,
  body: JSON.stringify({ path: `races/${SLUG}/${file}`, content: JSON.stringify(doc), message: 'crew' }) });
const legs = async (id = 'jason') => ((await crewRead('data.json')).runners.find(r => r.id === id) || {}).legs || [];
const leg = async (i, id) => (await legs(id)).find(l => l.index === i) || {};
const until = async (test, n = 60) => { for (let i = 0; i < n; i++) { try { const v = await test(); if (v) return v; } catch (e) {} await page.waitForTimeout(150); } return false; };
const ago = (min) => new Date(Date.now() - min * 60e3).toISOString();
const openRacer = async (id = 'jason') => {
  await page.goto(BASE + `/racer.html?id=${SLUG}&runner=${id}`);
  await page.waitForSelector('#go', { timeout: 20000 });
};
const queued = () => page.evaluate(() => JSON.parse(localStorage.getItem('sendoff-queue-v1') || '[]').map(e => e.op));
// On the way to the first aid station (the stop before it is a checkpoint).
const onLeg2 = () => [{ index: 1, startTime: ago(120), endTime: ago(60) }, { index: 2, startTime: ago(60) }];

const cfg = await crewRead('config.json'); delete cfg.myRole;
cfg.fuelPresets = [{ name: 'Gel', values: { calories: 100 } }];
delete cfg.presetOrder;
await crewWrite('config.json', cfg);

console.log('\na press and its undo, both made with no signal');
await crewWrite('data.json', { runners: [{ id: 'jason', legs: onLeg2() }] });
await openRacer();
await ctx.setOffline(true);
await page.click('#go');
await page.waitForSelector('#undo');
await page.waitForTimeout(750);
await page.click('#undo');
ok('both are waiting on the phone', await until(async () => (await queued()).length === 2 && await queued()), ['setLegTimes', 'reopenLeg']);
// Meanwhile the crew, who have signal, check the racer in for real.
const real = ago(1);
const d1 = await crewRead('data.json');
d1.runners[0].legs.find(l => l.index === 2).endTime = real;
await crewWrite('data.json', d1);
await ctx.setOffline(false);
await page.evaluate(() => Race.queue.flush());
ok('the phone sends what it had', await until(async () => (await queued()).length === 0), true);
ok('and the crew\'s check-in is still there, at the time they made it', (await leg(2)).endTime, real);

console.log('\nan undo of a press that had landed');
await crewWrite('data.json', { runners: [{ id: 'jason', legs: onLeg2() }] });
await openRacer();
await page.click('#go');
ok('the arrival lands', !!(await until(async () => (await leg(2)).endTime)), true);
await page.waitForTimeout(750);
await page.click('#undo');
ok('and the undo takes it back', await until(async () => !(await leg(2)).endTime), true);

console.log('\nwhat an undo may take back');
const ops = await page.evaluate(() => {
  const run = (doc, op, args) => {
    localStorage.setItem('sendoff-queue-v1', JSON.stringify([{ id: 'x', path: 'p', op, args, tries: 0 }]));
    try { return Race.queue.applyTo('p', JSON.parse(JSON.stringify(doc))).runners[0].legs; }
    finally { localStorage.removeItem('sendoff-queue-v1'); }
  };
  const doc = { runners: [{ id: 'j', legs: [{ index: 1, startTime: 'S1', endTime: 'E1' }, { index: 2, startTime: 'S2' }] }] };
  return {
    // A send-off undone: only the leg this press started, at the time it gave it.
    own: run(doc, 'removeLeg', { runnerId: 'j', legIndex: 2, was: ['S2'] }).length,
    notMine: run(doc, 'removeLeg', { runnerId: 'j', legIndex: 2, was: ['other'] }).length,
    finished: run({ runners: [{ id: 'j', legs: [{ index: 1, startTime: 'S1', endTime: 'E1' }] }] },
      'removeLeg', { runnerId: 'j', legIndex: 1, was: ['S1'] }).length,
    arrival: run(doc, 'reopenLeg', { runnerId: 'j', legIndex: 1, upTo: 2, was: ['somebody else\'s'] }),
    plain: run(doc, 'clearLegField', { runnerId: 'j', legIndex: 1, field: 'endTime' })[0]
  };
});
ok('a send-off undone removes the leg it started', ops.own, 1);
ok('but not one started at another time', ops.notMine, 2);
ok('and never a leg that has since been finished', ops.finished, 1);
ok('an arrival undone leaves a check-in it did not make', ops.arrival,
  [{ index: 1, startTime: 'S1', endTime: 'E1' }, { index: 2, startTime: 'S2' }]);
ok('with nothing to compare, it clears as it always did', ops.plain, { index: 1, startTime: 'S1' });

console.log('\na tap, after the crew has logged something the phone has not seen');
await crewWrite('data.json', { runners: [{ id: 'jason', legs: onLeg2() }] });
await openRacer();
await page.waitForSelector('[data-preset]');
// The crew types 300 calories and a note onto the leg. The phone does not
// refresh before the racer taps.
const d2 = await crewRead('data.json');
Object.assign(d2.runners[0].legs.find(l => l.index === 2), { calories: 300, notes: 'crew: broth at the last stop' });
await crewWrite('data.json', d2);
await page.click('[data-preset="0"]');
ok('the gel is added to the crew\'s number, not put in its place',
  await until(async () => (await leg(2)).preset_0 === 1 && (await leg(2)).calories), 400);
await page.fill('#jot', 'felt a hot spot');
await page.press('#jot', 'Enter');
const noted = await until(async () => /hot spot/.test((await leg(2)).notes || '') && (await leg(2)).notes);
ok('and a note is added under the crew\'s, not over it', [/crew: broth/.test(noted), /felt a hot spot/.test(noted)], [true, true]);
await page.click('[data-preset="0"]');
await page.click('[data-preset="0"]');
ok('two quick taps are two', await until(async () => (await leg(2)).preset_0 === 3 && (await leg(2)).calories), 600);

console.log('\na press that landed is written down on the phone');
await crewWrite('data.json', { runners: [{ id: 'jason', legs: onLeg2() }] });
await openRacer();
await page.click('#go');
await until(async () => (await leg(2)).endTime);
const landed = (await leg(2)).endTime;
ok('the saved copy has it, for when the signal goes', await until(() => page.evaluate(([slug, t]) => {
  const row = JSON.parse(localStorage.getItem(`so:seen:${slug}:data.json`) || 'null');
  return !!row && row.text.includes(t);
}, [SLUG, landed])), true);

console.log('\nthe big button, through a refresh');
await crewWrite('data.json', { runners: [{ id: 'jason', legs: onLeg2() }] });
await openRacer();
await page.evaluate(() => { window.__go = document.getElementById('go'); });
await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
await page.waitForTimeout(1200);
ok('is the same button, not a new one like it', await page.evaluate(() => document.getElementById('go') === window.__go), true);

console.log('\na racer the data file has never heard of');
const c2 = await crewRead('config.json'); delete c2.myRole;
c2.runners = [...c2.runners, { ...c2.runners[0], id: 'late', name: 'Late Entry' }];
await crewWrite('config.json', c2);
await crewWrite('data.json', { runners: [{ id: 'jason', legs: onLeg2() }] });
await openRacer('late');
ok('is offered Start', /start/i.test(await page.textContent('#go')), true);
await page.click('#go');
ok('and Start starts them', !!(await until(async () => (await leg(1, 'late')).startTime)), true);

ok('no page threw', errs, []);
await b.close();
console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
