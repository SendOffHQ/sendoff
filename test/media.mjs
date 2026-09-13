// Photos on a leg: what leaves the phone, and what a spectator gets.
//
// Three claims worth holding, and the first one is not a nicety:
//
//   EXIF comes off. A photo of a runner at an aid station carries that
//   person's exact coordinates, the time, and the camera, until something
//   takes them off. The something is the canvas re-encode, which means a
//   privacy property is living inside an optimisation, which is exactly the
//   kind of thing that gets refactored away by somebody tuning image quality.
//   So it is asserted directly, against a file that really has a GPS tag in it.
//
//   The queue is IndexedDB. The localStorage one everything else uses holds
//   about five megabytes of string and swallows its quota error, so a photo
//   pushed through it fails silently and a crew member believes it was saved.
//
//   A photo belongs to the leg of the course, not to a runner. See
//   migrations/0004_media.sql.
//
//   node test/media.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net'; import fs from 'node:fs';
const BASE = 'http://localhost:8787';
const SLUG = 'six-0-trail-marathon';
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

const ctx = await b.newContext({ viewport:{width:900,height:1100}, serviceWorkers:'block' });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(BASE + '/index.html');
await page.evaluate(base => localStorage.setItem('race-hub-session-v1', JSON.stringify({
  session:'stub', proxyUrl: base + '/api', email:'crew@example.com', role:'crew',
  expiresAt: Date.now() + 7*24*3600e3 })), BASE);
await page.goto(BASE + '/pit.html?id=' + SLUG);
await page.waitForTimeout(1800);

// A deployment with no bucket and a race with no photographs look identical
// from an empty list, and the difference decides whether the pit board offers
// a camera at all. It shipped once offering one that could only fail.
console.log('\nthe board knows whether photos can land at all');
ok('this one can', await page.evaluate(async () => {
  await Race.media.list('six-0-trail-marathon');
  return Race.media.configured();
}), true);
ok('and an older worker that never heard of them cannot', await page.evaluate(async () => {
  const real = window.fetch;
  window.fetch = (u, o) => String(u).includes('/media?')
    ? Promise.resolve(new Response('not found', { status: 404 })) : real(u, o);
  await Race.media.list('six-0-trail-marathon');
  const out = Race.media.configured();
  window.fetch = real;
  await Race.media.list('six-0-trail-marathon');
  return out;
}), false);

console.log('\nthe crew get a way to add one, on the leg the race is on');
ok('the section is there', await page.locator('#photos').isVisible(), true);

// Shut on arrival. Everything on this screen competes with the button somebody
// came to press, and the board is opened with a runner in front of you far
// more often than it is opened to add a photograph.
ok('and shut', await page.locator('#photo-body').isVisible(), false);
ok('with nothing under it to tab into',
   await page.locator('#photo-leg').isVisible(), false);
await page.click('#photo-toggle');
await page.waitForTimeout(200);
ok('the head opens it', await page.locator('#photo-body').isVisible(), true);
ok('and lands on the leg picker',
   await page.evaluate(() => document.activeElement && document.activeElement.id), 'photo-leg');
const legDefault = await page.evaluate(() => document.querySelector('#photo-leg').value);
ok('a leg is chosen for them', /^\d+$/.test(legDefault), true);
ok('and every leg is offered', await page.evaluate(() =>
  document.querySelectorAll('#photo-leg option').length > 1), true);
// The optional tag, offered second and never required.
ok('nobody in particular is the default', await page.evaluate(() =>
  document.querySelector('#photo-runner').value), '');

// A real JPEG with a real GPS tag, built here so the assertion below is about
// this code and not about whatever a fixture happened to contain.
const EXIF_JPEG = await page.evaluate(async () => {
  // A tiny image, drawn rather than fetched.
  const c = document.createElement('canvas');
  c.width = 2400; c.height = 1200;
  const g = c.getContext('2d');
  g.fillStyle = '#0fb8bf'; g.fillRect(0, 0, 2400, 1200);
  g.fillStyle = '#0a0f14'; g.fillRect(600, 300, 1200, 600);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // Splice an APP1/Exif segment carrying a GPS IFD in after SOI. Minimal but
  // real: the marker, the "Exif\0\0" header and a GPS tag a reader will find.
  const exifBody = [];
  const push = (...v) => exifBody.push(...v);
  push(0x45,0x78,0x69,0x66,0x00,0x00);        // "Exif\0\0"
  push(0x4d,0x4d,0x00,0x2a,0x00,0x00,0x00,0x08); // big-endian TIFF header
  push(0x00,0x01);                             // one IFD entry
  push(0x88,0x25,0x00,0x04,0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x1a); // GPS IFD pointer
  push(0x00,0x00,0x00,0x00);                   // no next IFD
  push(0x00,0x01);                             // one GPS entry
  push(0x00,0x01,0x00,0x02,0x00,0x00,0x00,0x02,0x4e,0x00,0x00,0x00); // GPSLatitudeRef "N"
  push(0x00,0x00,0x00,0x00);
  const len = exifBody.length + 2;
  const app1 = [0xff,0xe1,(len >> 8) & 0xff, len & 0xff, ...exifBody];
  const out = new Uint8Array(bytes.length + app1.length);
  out.set(bytes.subarray(0, 2), 0);
  out.set(app1, 2);
  out.set(bytes.subarray(2), 2 + app1.length);
  return [...out];
});

const hasExif = (arr) => {
  const s = Buffer.from(arr).toString('latin1');
  return s.includes('Exif\0\0');
};
ok('the file really does carry Exif to begin with', hasExif(EXIF_JPEG), true);

console.log('\npreparing one takes the location off it, and shrinks it');
const prepared = await page.evaluate(async (bytes) => {
  const file = new File([new Uint8Array(bytes)], 'shot.jpg', { type: 'image/jpeg' });
  const out = await Race.media.prepare(file);
  return { w: out.width, h: out.height, type: out.blob.type,
           bytes: [...new Uint8Array(await out.blob.arrayBuffer())] };
}, EXIF_JPEG);
ok('no Exif survives the re-encode', hasExif(prepared.bytes), false);
ok('the long edge is capped', prepared.w, 1600);
ok('and the shape is kept', prepared.h, 800);
ok('always jpeg, whatever went in', prepared.type, 'image/jpeg');
ok('and it is smaller than it was', prepared.bytes.length < EXIF_JPEG.length, true);

console.log('\nit queues, in IndexedDB rather than the localStorage one');
await page.evaluate(async (bytes) => {
  const file = new File([new Uint8Array(bytes)], 'shot.jpg', { type: 'image/jpeg' });
  window.__q = await Race.media.enqueue('six-0-trail-marathon',
    { legIndex: 4, runnerId: null, caption: 'Quesadilla', file });
}, EXIF_JPEG);
await page.waitForTimeout(900);
ok('the split queue was left alone', await page.evaluate(() =>
  JSON.parse(localStorage.getItem('sendoff-queue-v1') || '[]').length), 0);

console.log('\nand it lands on the leg, not on a runner');
const landed = await page.evaluate(() => Race.media.list('six-0-trail-marathon'));
ok('one photo on the race', landed.length, 1);
ok('on the leg it was taken on', landed[0].legIndex, 4);
ok('with nobody tagged', landed[0].runnerId, null);
ok('and its caption', landed[0].caption, 'Quesadilla');
ok('the queue emptied once it went', await page.evaluate(
  () => Race.media.pending('six-0-trail-marathon').then(q => q.length)), 0);

// The bug this exists for. The section used to rebuild its own innerHTML on
// every poll, so tapping Add photo, waiting for the operating system's picker
// (which is up for longer than five seconds), and coming back handed the photo
// to an <input> the poll had already replaced. The change event fired on a
// detached node, never reached the listener, and nothing happened at all: no
// thumbnail, no error, no queue entry. Reported from a real airplane-mode test
// and silent in every way that matters.
// The camera, and why it is first. In airplane mode the Android picker opens
// Google Photos, most of a phone's library is in the cloud, and Google Photos
// answers "Can't load some Photos" and never hands a file back: the crew
// member never reaches our code at all. capture goes to the camera app, which
// has never needed a network.
console.log('\nthere is a way to take one that does not go through a gallery');
ok('the camera input is there', await page.locator('#photo-camera').count(), 1);
ok('and asks for the camera', await page.evaluate(
  () => document.querySelector('#photo-camera').getAttribute('capture')), 'environment');
// capture takes one picture at a time; multiple on it would be a lie.
ok('one at a time', await page.evaluate(
  () => document.querySelector('#photo-camera').multiple), false);
ok('the gallery is still offered alongside', await page.locator('#photo-file').count(), 1);
ok('and that one takes several', await page.evaluate(
  () => document.querySelector('#photo-file').multiple), true);
// Both go the same way in, or one of them silently does nothing.
ok('a camera photo queues like any other', await page.evaluate(async (bytes) => {
  const before = (await Race.media.pending('six-0-trail-marathon')).length;
  const file = new File([new Uint8Array(bytes)], 'cam.jpg', { type: 'image/jpeg' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const input = document.querySelector('#photo-camera');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 1200));
  const after = await Race.media.list('six-0-trail-marathon');
  return after.length > 0 && before === 0;
}, EXIF_JPEG), true);

console.log('\nthe poll does not pull the picker out from under a crew member');
const survives = await page.evaluate(async () => {
  const before = document.querySelector('#photo-file');
  // Exactly what the poll does, and more times than it would in one pick.
  for (let i = 0; i < 4; i++) renderPhotos();
  const after = document.querySelector('#photo-file');
  return { same: before === after, attached: document.contains(before) };
});
ok('the file input is the same element afterwards', survives.same, true);
ok('and still in the document', survives.attached, true);

// The other half: what somebody typed or chose is still there.
await page.selectOption('#photo-leg', '7');
await page.fill('#photo-caption', 'Half a quesadilla');
await page.evaluate(() => { for (let i = 0; i < 3; i++) renderPhotos(); });
ok('the leg they chose survives the poll',
   await page.evaluate(() => document.querySelector('#photo-leg').value), '7');
ok('and so does the caption they typed',
   await page.evaluate(() => document.querySelector('#photo-caption').value), 'Half a quesadilla');

// With no signal a photo has to look like it was taken, or a crew member
// takes it again, or gives up on the feature at the aid station it is for.
console.log('\nwith the worker unreachable it still queues, and says so');
await page.evaluate(async (bytes) => {
  const real = window.fetch;
  window.__realFetch = real;
  window.fetch = (u, o) => String(u).includes('/media')
    ? Promise.reject(new TypeError('Failed to fetch')) : real(u, o);
  const file = new File([new Uint8Array(bytes)], 'offline.jpg', { type: 'image/jpeg' });
  await Race.media.enqueue('six-0-trail-marathon',
    { legIndex: 7, runnerId: null, caption: 'No signal', file });
}, EXIF_JPEG);
await page.waitForTimeout(600);
await page.evaluate(() => refreshPhotos());
await page.waitForTimeout(300);
ok('it is in the queue', await page.evaluate(
  () => Race.media.pending('six-0-trail-marathon').then(q => q.length)), 1);
ok('a thumbnail shows it', await page.evaluate(
  () => document.querySelectorAll('#photo-thumbs figure.queued').length), 1);
ok('and the head says so without opening anything', await page.evaluate(
  () => document.querySelector('#photo-summary').textContent), '1 waiting for signal');
// The camera must not disappear just because this load could not reach the
// worker. That is the aid station it exists for.
ok('the section is still offered', await page.evaluate(
  () => document.getElementById('photos').style.display !== 'none'), true);

// Without being asked, which is the whole of "it took a couple of refreshes".
// The `online` event does not reliably fire when a phone comes off airplane
// mode, and when it does it can arrive before the radio is carrying anything,
// so the single retry it triggers fails and nothing tries again. Coming back
// to the foreground is the moment that actually happens: somebody unlocks the
// phone and looks at the board.
console.log('\nand it goes out when the phone comes back, with nobody asking');
await page.evaluate(() => { window.fetch = window.__realFetch; });
await page.evaluate(() => {
  Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
});
await page.waitForTimeout(1200);
ok('the foreground alone sent it', await page.evaluate(
  () => Race.media.pending('six-0-trail-marathon').then(q => q.length)), 0);

// And the board shows it as landed rather than as gone. The sent list used to
// arrive only on the slow minute timer, so there was a window where the dimmed
// thumbnail had disappeared and the real one had not shown up yet, and the
// photograph looked thrown away.
await page.waitForTimeout(400);
ok('and the board has it, without a minute of nothing', await page.evaluate(
  () => document.querySelectorAll('#photo-thumbs figure:not(.queued)').length > 0), true);

await page.evaluate(() => Race.media.flush());
await page.waitForTimeout(900);
ok('the queue emptied', await page.evaluate(
  () => Race.media.pending('six-0-trail-marathon').then(q => q.length)), 0);
const landedOffline = await page.evaluate(() => Race.media.list('six-0-trail-marathon'));
ok('and it landed on the leg it was taken on',
   landedOffline.filter(m => m.caption === 'No signal').map(m => m.legIndex), [7]);

console.log('\nthe race page shows it against that leg, and not before asked');
const spectator = await b.newContext({ viewport:{width:900,height:1100}, serviceWorkers:'block' });
const sp = await spectator.newPage();
await sp.goto(BASE + '/race.html?id=' + SLUG);
await sp.locator('[data-media-leg="4"]').waitFor({ state: 'attached', timeout: 15000 });
ok('the leg offers its media', await sp.locator('[data-media-leg="4"]').count(), 1);
ok('no image is fetched until it is opened', await sp.evaluate(() =>
  document.querySelectorAll('.media-strip img').length), 0);

// A collapsed leg log shows the last two legs and hides the rest, and a photo
// on a hidden leg is hidden with it, which is right: the row it belongs to is
// not on screen. The gallery below is how you see those without hunting.
ok('a photo on an old leg is folded away with the leg',
   await sp.locator('[data-media-leg="4"]').isVisible(), false);
await sp.locator('.leglog.collapsed .leglog-head').first().click();
await sp.waitForTimeout(300);
ok('expanding the log brings it back',
   await sp.locator('[data-media-leg="4"]').isVisible(), true);

await sp.click('[data-media-leg="4"]');
await sp.waitForTimeout(400);
ok('opening it draws the photo', await sp.evaluate(() =>
  document.querySelectorAll('#media-leg-4 img').length), 1);

console.log('\nand there is a way to see all of them');
ok('the button appeared', await sp.locator('#gallery-open').count(), 1);
await sp.click('#gallery-open');
await sp.waitForTimeout(300);
ok('the gallery opened', await sp.locator('.gallery-overlay').count(), 1);
// Both of them: the one added with signal and the one that queued without.
// Counted from what the race has rather than written down, so adding a case
// above does not quietly make this assert the wrong number.
ok('with every photo in it', await sp.evaluate(() =>
  document.querySelectorAll('.gallery-body img').length),
  (await sp.evaluate(() => Race.media.list('six-0-trail-marathon'))).length);
await sp.keyboard.press('Escape');
await sp.waitForTimeout(200);
ok('and Escape closes it', await sp.locator('.gallery-overlay').count(), 0);

ok('nothing threw', errs, []);
await b.close();
console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
