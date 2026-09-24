// Giving a race a course after it has been created.
//
// The wizard could always take a GPX; nothing else could. A race set up without
// one, or carrying last year's route, had to be rebuilt to get a new one, which
// for a race that has already been worked is not an option.
//
// Three things here are worth a real browser rather than a unit test. The lock
// is one: it has to read the race, and the race it must not unlock for is a
// race whose cutoff has passed with somebody still walking it in. The climb
// checkbox is another, because "recalculate" and "fill in the blanks" are
// different operations on the same button and only one of them is destructive.
// The size limit is the third: it is the one failure that is otherwise silent.
//
//   node test/course-upload.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const BASE = 'http://localhost:8787';
const SLUG = 'zz-fixture-unlisted';
const PIN = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const listening = () => new Promise(r => { const s = net.connect(8787,'127.0.0.1');
  const d=v=>{s.destroy();r(v)}; s.once('connect',()=>d(true)); s.once('error',()=>d(false)); setTimeout(()=>d(false),500); });
if (await listening()) { console.error('port busy'); process.exit(2); }
const srv = spawn('node', [new URL('./harness.mjs', import.meta.url).pathname], { stdio: 'ignore' });
process.on('exit', () => { try { srv.kill('SIGKILL'); } catch (e) {} });
for (let i=0;i<40 && !(await listening());i++) await new Promise(r=>setTimeout(r,150));

// Two files to pick: one that climbs steadily, so a recalculated segment has a
// figure that could not have been the one already stored, and one over the
// limit.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'so-gpx-'));
const trk = (n, climb) => {
  let out = '';
  for (let i = 0; i < n; i++) {
    out += `<trkpt lat="${(37.9 + i * 0.0006).toFixed(6)}" lon="-105.5">` +
           `<ele>${(2400 + i * climb).toFixed(1)}</ele></trkpt>`;
  }
  return `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">` +
         `<trk><name>test course</name><trkseg>${out}</trkseg></trk></gpx>`;
};
const GOOD = path.join(dir, 'new-course.gpx');
const HUGE = path.join(dir, 'enormous.gpx');
fs.writeFileSync(GOOD, trk(900, 3));
fs.writeFileSync(HUGE, trk(19000, 3));
if (fs.statSync(HUGE).size <= 1024 * 1024) { console.error('the oversized fixture is not oversized'); process.exit(2); }
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

const b = await chromium.launch(fs.existsSync(PIN) ? { executablePath: PIN } : {});
let bad = 0;
const ok=(l,g,w)=>{const q=JSON.stringify(g)===JSON.stringify(w); if(!q)bad++;
  console.log(`  ${q?'ok  ':'FAIL'} ${l.padEnd(54)} ${JSON.stringify(g)}${q?'':' want '+JSON.stringify(w)}`)};

const ctx = await b.newContext({ viewport:{width:900,height:1200}, serviceWorkers:'block' });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(BASE + '/index.html');
await page.evaluate(base => localStorage.setItem('race-hub-session-v1', JSON.stringify({
  session:'stub', proxyUrl: base + '/api', email:'crew@example.com', role:'owner',
  expiresAt: Date.now() + 7*24*3600e3 })), BASE);

// Rewrites the race so the lock has something to read. legsDone is how many of
// the sixteen the one runner has finished.
const setRace = (startsInHours, legsDone) => page.evaluate(async ([base, slug, h, done]) => {
  const read = async (file) => {
    const r = await fetch(`${base}/api/get?path=races/${slug}/${file}`, { headers: { Authorization: 'Bearer stub' } });
    return JSON.parse(atob((await r.json()).content));
  };
  const write = async (file, doc) => {
    const r = await fetch(base + '/api/commit', {
      method: 'POST', headers: { Authorization: 'Bearer stub', 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: `races/${slug}/${file}`, content: JSON.stringify(doc, null, 2), message: 'test' })
    });
    if (!r.ok) throw new Error(`setRace could not write ${file}: ${r.status}`);
  };
  const cfg = await read('config.json');
  cfg.startTime = new Date(Date.now() + h * 3600e3).toISOString();
  await write('config.json', cfg);
  const data = await read('data.json');
  for (const r of data.runners) {
    r.legs = r.legs.map((l, i) => i < done ? l : Object.assign({}, l, { endTime: null }));
  }
  await write('data.json', data);
}, [BASE, SLUG, startsInHours, legsDone]);

const open = async () => {
  await page.goto(BASE + `/settings.html?id=${SLUG}`);
  await page.waitForSelector('#course-editor-head', { timeout: 20000 });
  await page.waitForTimeout(1200);
  await page.evaluate(() => document.getElementById('course-editor').classList.remove('collapsed'));
};
const sec = () => page.evaluate(() => {
  const s = document.getElementById('course-editor');
  const warn = document.getElementById('course-warn');
  return {
    locked: s.classList.contains('locked'),
    warned: warn.style.display !== 'none' && /under way/.test(warn.textContent),
    fileDisabled: document.getElementById('course-file').disabled,
    saveDisabled: document.getElementById('course-save').disabled
  };
});
const line = id => page.evaluate(i => document.getElementById(i).textContent.trim(), id);
const segOne = () => page.evaluate(async ([base, slug]) => {
  const r = await fetch(`${base}/api/get?path=races/${slug}/config.json`, { headers: { Authorization: 'Bearer stub' } });
  const cfg = JSON.parse(atob((await r.json()).content));
  return cfg.course.segments[0].elevationGainFt;
}, [BASE, SLUG]);

console.log('\nthe section, on a race nobody is out on');
await setRace(-400, 16);            // long over, everybody home
await open();
ok('is there', await page.evaluate(() => !!document.getElementById('course-editor')), true);
ok('and open for business', await sec(),
  { locked: false, warned: false, fileDisabled: false, saveDisabled: true });
ok('saying what the race already has', /^On the race now: .* pts .*Saving replaces it\.$/.test(await line('course-current')), true);

console.log('\npicking a file');
await page.setInputFiles('#course-file', GOOD);
await page.waitForTimeout(600);
ok('is described before it is saved', await line('course-status'),
  'new-course.gpx · 900 pts · 37.3 mi · +8,839 / -0 ft (est.)');
ok('which arms Save', await page.evaluate(() => document.getElementById('course-save').disabled), false);

console.log('\nand a file over the limit, which can be written but never read back');
await page.setInputFiles('#course-file', HUGE);
await page.waitForTimeout(600);
ok('is refused with the number', /^enormous\.gpx is [\d.]+ MB\. The limit is 1 MB/.test(await line('course-status')), true);
ok('and Save goes back off', await page.evaluate(() => document.getElementById('course-save').disabled), true);

console.log('\nsaving, with the climb left alone');
const before = await segOne();
await page.setInputFiles('#course-file', GOOD);
await page.waitForTimeout(400);
await page.click('#course-save');
// "Saved" is on the button for saveBtn.DONE_MS and then the label goes home,
// so this waits for it rather than sleeping past it.
const saidSaved = await page.waitForFunction(
  () => document.getElementById('course-save').textContent.trim() === 'Saved',
  { timeout: 15000 }).then(() => true, () => false);
ok('the button says so', saidSaved, true);
ok('the course landed', await page.evaluate(async ([base, slug]) => {
  const r = await fetch(`${base}/api/get?path=races/${slug}/course.gpx`, { headers: { Authorization: 'Bearer stub' } });
  return atob((await r.json()).content).includes('<name>test course</name>');
}, [BASE, SLUG]), true);
ok('the segment keeps the climb it was given', await segOne(), before);
ok('and the line above is the file we just wrote, not a read of it',
  /900 pts/.test(await line('course-current')), true);

console.log('\nsaving again, this time asking for the climb back');
await open();
await page.setInputFiles('#course-file', GOOD);
await page.waitForTimeout(400);
await page.evaluate(() => { document.getElementById('course-recalc').checked = true; });
page.once('dialog', d => d.accept());
await page.click('#course-save');
await page.waitForTimeout(2500);
const after = await segOne();
ok('the stored figure is thrown away and worked out again', after !== before, true);
ok('and the new one came off the trace', after > 0, true);
ok('the box does not stay ticked for the next upload',
  await page.evaluate(() => document.getElementById('course-recalc').checked), false);

console.log('\nwhile the race is being run');
await setRace(-2, 4);               // started two hours ago, four legs in
await open();
ok('the section is drawn, disabled, with the reason', await sec(),
  { locked: true, warned: true, fileDisabled: true, saveDisabled: true });

// The edge the roadmap flagged. raceState calls this race finished, because the
// clock is past the cutoff; the runner is still out on it. Reading raceState
// here would swap the map under her.
console.log('\nand the race that blew its cutoff with somebody still out');
await setRace(-400, 4);
await open();
ok('raceState calls it finished', await page.evaluate(async ([base, slug]) => {
  const g = async f => JSON.parse(atob((await (await fetch(`${base}/api/get?path=races/${slug}/${f}`,
    { headers: { Authorization: 'Bearer stub' } })).json()).content));
  return Race.raceState(await g('config.json'), await g('data.json'));
}, [BASE, SLUG]), 'finished');
ok('the course stays locked anyway', await sec(),
  { locked: true, warned: true, fileDisabled: true, saveDisabled: true });

// The other way this section can be offered to somebody who cannot use it, and
// the one that actually happened: the race is readable, the page draws the
// whole editor, and /commit refuses the write after the file has been uploaded.
// Nothing about the race says no; the person does.
console.log('\nsomebody who can read this race but not write it');
// The race is set up first and the caller loses their role afterwards: once
// they have lost it the stub refuses these writes too, exactly as the worker
// would. Starting in two days, so the clock is not the reason for anything
// below.
await setRace(48, 0);
await page.evaluate(async base => {
  await fetch(base + '/api/race/visibility', {
    method: 'POST', headers: { Authorization: 'Bearer stub', 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: 'zz-fixture-unlisted', visibility: 'public' })
  });
  await fetch(base + '/api/not-on-race');
}, BASE);
await open();
ok('the clock says the section should be open', await page.evaluate(async ([base, slug]) => {
  const g = async f => JSON.parse(atob((await (await fetch(`${base}/api/get?path=races/${slug}/${f}`,
    { headers: { Authorization: 'Bearer stub' } })).json()).content));
  return Race.raceState(await g('config.json'), await g('data.json'));
}, [BASE, SLUG]), 'upcoming');
ok('the section is disabled', await page.evaluate(() => {
  const s = document.getElementById('course-editor');
  return { locked: s.classList.contains('locked'),
           fileDisabled: document.getElementById('course-file').disabled,
           saveDisabled: document.getElementById('course-save').disabled };
}), { locked: true, fileDisabled: true, saveDisabled: true });
ok('and says whose race it is, not that the clock is wrong',
  await page.evaluate(() => document.getElementById('course-warn').textContent.trim()),
  'You are not on this race as crew, so its course is not yours to change. Ask whoever set it up to add you from Manage access.');
// The rest of the page saves through the same endpoint and is refused the same
// way, so it says so once at the top rather than at the end of each attempt.
ok('the page says it up front', await page.evaluate(() => {
  const el = document.getElementById('read-only');
  return el.style.display !== 'none' && /not change it/.test(el.textContent);
}), true);

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
