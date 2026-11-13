// A press is on the phone before it is anywhere else (2026-11-13).
//
// Found in review: a press was sent first and only written to this phone's
// storage if the failure looked like "no signal". A server error, a reply cut
// off half way, or a sign-in that ran out at hour 20 showed "Save failed" for
// three seconds and the check-in was gone; the next refresh put the button
// back as if it had never been pressed. A tab closed while a send was in the
// air had nothing to recover from at all.
//
// Now the press is stored first and removed only when the server has it:
//   - while the request is in flight it is already in storage;
//   - a server error leaves it queued and it goes when the server is back;
//   - an expired sign-in leaves it queued, says so, and it goes after signing in;
//   - a refusal is shown as not saved, kept, and can be sent again by hand.
//
//   node test/press-kept.mjs
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
const SESSION = JSON.stringify({ session: 'stub', proxyUrl: BASE + '/api',
  email: 'crew@example.com', role: 'owner', expiresAt: Date.now() + 7 * 24 * 3600e3 });
await page.goto(BASE + '/index.html');
await page.evaluate(s => {
  localStorage.setItem('race-hub-session-v1', s);
  localStorage.setItem('race-hub-tutorial-v1', JSON.stringify({ racer: 99, pit: 99, race: 99 }));
}, SESSION);
const readLegs = () => page.evaluate(async (slug) => {
  const r = await (await fetch(`/api/get?path=races/${slug}/data.json&direct=1`, { headers: { Authorization: 'Bearer stub' } })).json();
  const d = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(r.content), c => c.charCodeAt(0))));
  return d.runners[0].legs;
}, SLUG);
const setLegs = (legs) => page.evaluate(async ([slug, legs]) => {
  await fetch('/api/commit?direct=1', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer stub' },
    body: JSON.stringify({ path: `races/${slug}/data.json`, content: JSON.stringify({ runners: [{ id: 'jason', legs }] }), message: 'legs' }) });
}, [SLUG, legs]);
const until = async (test, n = 60) => { for (let i = 0; i < n; i++) { try { if (await test()) return true; } catch (e) {} await page.waitForTimeout(150); } return false; };
const openRacer = async () => {
  await page.goto(BASE + `/racer.html?id=${SLUG}&runner=jason`);
  await page.waitForSelector('#go', { timeout: 20000 });
};
const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('sendoff-queue-v1') || '[]')
  .map(e => ({ op: e.op, failed: !!e.failed })));
const bar = () => page.evaluate(() => (document.getElementById('so-offline-bar') || {}).textContent || '');
const toastText = () => page.evaluate(() => { const t = document.getElementById('toast');
  return t && t.style.display !== 'none' ? t.textContent : ''; });
const arrived = async () => !!((await readLegs()).find(l => l.index === 1) || {}).endTime;
const ago = (min) => new Date(Date.now() - min * 60e3).toISOString();
// The page's own writes, and not this file's, which carry ?direct=1.
const WRITES = url => url.pathname === '/api/commit' && !url.search;
const fresh = async () => {
  await page.unroute(WRITES).catch(() => {});
  await page.evaluate(() => localStorage.removeItem('sendoff-queue-v1'));
  await setLegs([{ index: 1, startTime: ago(90) }]);
  await openRacer();
};

console.log('\nwhile the press is on its way');
await fresh();
let release;
const held = new Promise(r => { release = r; });
await page.route(WRITES, async route => { await held; try { await route.continue(); } catch (e) {} });
const before = await page.textContent('#go');
await page.click('#go');
await page.waitForTimeout(400);
ok('it is already in this phone\'s storage', await stored(), [{ op: 'setLegTimes', failed: false }]);
ok('and the server does not have it yet', await arrived(), false);
// Stored, but only on its way: an ordinary press must not put a bar across
// the bottom of the screen and move the button under the thumb.
ok('with no bar for a press that is merely in flight', await bar(), '');
// The tab goes away with the request still in the air.
await openRacer();
ok('a reload still shows the press as made', await page.textContent('#go') !== before, true);
release();
await page.waitForTimeout(400);
await page.unroute(WRITES);
// What the half-minute timer, or the phone coming out of a pocket, does.
await page.evaluate(() => Race.queue.flush());
ok('and it lands once the page can send', await until(arrived), true);
ok('after which nothing is left waiting', await until(async () => (await stored()).length === 0), true);

console.log('\na server error');
await fresh();
await page.route(WRITES, route => route.fulfill({ status: 500, body: 'nope' }));
await page.click('#go');
await page.waitForTimeout(900);
ok('the press is kept', await stored(), [{ op: 'setLegTimes', failed: false }]);
ok('nothing says it failed', /save failed/i.test(await toastText()), false);
ok('the bar says it is still to send', /1 update/i.test(await bar()), true);
await openRacer();
ok('and the screen still shows it after a refresh', await page.textContent('#go') !== before, true);
await page.unroute(WRITES);
await page.evaluate(() => Race.queue.flush());
ok('when the server is back it goes', await until(arrived), true);
ok('and the queue is empty', await until(async () => (await stored()).length === 0), true);

console.log('\na sign-in that ran out');
await fresh();
await page.route(WRITES, route => route.fulfill({ status: 401, body: '{"error":"expired"}' }));
await page.click('#go');
await page.waitForTimeout(900);
ok('the press is kept', await stored(), [{ op: 'setLegTimes', failed: false }]);
ok('and the bar asks for a sign-in', /sign in again/i.test(await bar()), true);
ok('saying what is waiting on it', /1 update is saved on this phone/i.test(await bar()), true);
await page.unroute(WRITES);
await page.evaluate(s => localStorage.setItem('race-hub-session-v1', s), SESSION);
await openRacer();
ok('signed in again, it sends', await until(arrived), true);
ok('and the queue is empty', await until(async () => (await stored()).length === 0), true);

console.log('\na press with nobody signed in at all');
await fresh();
await page.evaluate(() => localStorage.removeItem('race-hub-session-v1'));
const r = await page.evaluate(async (slug) => {
  try { return await Race.queue.write(`races/${slug}/data.json`, 'setLegTimes',
    { runnerId: 'jason', legs: { 1: { endTime: new Date().toISOString() } } }, 'test'); }
  catch (e) { return { threw: e.message }; }
}, SLUG);
ok('is kept rather than refused', [r.queued, r.label, (await stored()).length], [true, 'Sign in again', 1]);
await page.evaluate(s => localStorage.setItem('race-hub-session-v1', s), SESSION);
await page.evaluate(() => Race.queue.flush());
ok('and goes after signing in', await until(arrived), true);

console.log('\na refusal');
await fresh();
await page.route(WRITES, route => route.fulfill({ status: 403, contentType: 'application/json',
  body: '{"error":"Forbidden, no write access on this race"}' }));
await page.click('#go');
ok('is said out loud', await until(async () => /save failed/i.test(await toastText())), true);
ok('and the press is kept, marked as not saved', await stored(), [{ op: 'setLegTimes', failed: true }]);
ok('the bar says so', /could not be saved/i.test(await bar()), true);
await openRacer();
ok('the screen does not pretend it landed', await page.textContent('#go'), before);
// Whatever was wrong is put right, and the bar offers to send it again first.
await page.unroute(WRITES);
const asked = [];
page.once('dialog', d => { asked.push(d.message()); d.accept(); });
await page.click('#so-offline-bar');
ok('the bar offers to send it again', /try sending them again/i.test(asked[0] || ''), true);
ok('and it lands', await until(arrived), true);
ok('leaving nothing behind', await until(async () => (await stored()).length === 0), true);

console.log('\ntwo presses while the first is still sending');
await fresh();
let release2;
const held2 = new Promise(r => { release2 = r; });
let first = true;
await page.route(WRITES, async route => { if (first) { first = false; await held2; } try { await route.continue(); } catch (e) {} });
await page.click('#go');
await page.waitForTimeout(300);
const second = page.evaluate(async (slug) => Race.queue.write(`races/${slug}/data.json`, 'setLegFields',
  { runnerId: 'jason', legIndex: 1, fields: { notes: 'second' } }, 'test: note'), SLUG);
await page.waitForTimeout(300);
ok('both are on the phone', (await stored()).length, 2);
release2();
await page.waitForTimeout(100);
ok('the second is answered when it has landed, not left for the timer', (await second).queued, false);
const legs = await readLegs();
ok('and both are in the file, in order', [!!legs[0].endTime, legs[0].notes], [true, 'second']);
await page.unroute(WRITES);

ok('no page threw', errs, []);
await b.close();
console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
