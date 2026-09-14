// Saving says so on the button, not at the bottom of the screen.
//
// A save used to be announced by a strip along the bottom: three seconds of
// "Race details saved." a long way from the button that had just been pressed.
// On a phone, with the keyboard closing and the page settling under it, it was
// easy to press Save and never see that anything happened, and pressing again
// because you did not see it is how you find out whether a form is idempotent.
//
// The button reports on itself now. What has to hold:
//   - it says it is working while it is working, and cannot be pressed twice;
//   - it says it is done only once the save has actually landed and been read
//     back, not when the request left the phone;
//   - it goes back to being an ordinary Save button, so the page does not end
//     up wearing a stale "Saved" from ten minutes ago;
//   - a failure puts the button back as it was and says why somewhere a
//     sentence fits, because a button is two words wide.
//
//   node test/save-button.mjs
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

const ctx = await b.newContext({ viewport:{width:390,height:844}, serviceWorkers:'block' });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(BASE + '/index.html');
await page.evaluate(base => localStorage.setItem('race-hub-session-v1', JSON.stringify({
  session:'stub', proxyUrl: base + '/api', email:'crew@example.com', role:'owner',
  expiresAt: Date.now() + 7*24*3600e3 })), BASE);
await page.goto(BASE + `/settings.html?id=${SLUG}`);
await page.waitForSelector('#race-save', { state: 'attached' });
await page.waitForTimeout(1200);

// The editors start collapsed; the button is only reachable once one is open.
await page.evaluate(() => {
  const head = document.getElementById('race-editor-head');
  if (head) head.click();
});
await page.waitForTimeout(300);

const label = () => page.evaluate(() => {
  const el = document.getElementById('race-save');
  return { text: el.textContent.trim(), disabled: el.disabled,
           busy: el.classList.contains('is-busy'), saved: el.classList.contains('is-saved') };
});

console.log('\nbefore anything is pressed');
ok('it is an ordinary save button', await label(),
   { text: 'Save changes', disabled: false, busy: false, saved: false });

// The save is watched from inside the page rather than polled from out here: a
// fast round trip against a local stub can begin and end between two polls,
// and a state nobody saw is a state this test would call missing.
console.log('\nwhile it is saving');
const seen = page.evaluate(() => new Promise(resolve => {
  const el = document.getElementById('race-save');
  const states = [];
  const note = () => {
    const s = el.textContent.trim() + (el.disabled ? '/off' : '/on');
    if (states[states.length - 1] !== s) states.push(s);
  };
  note();
  const mo = new MutationObserver(note);
  mo.observe(el, { childList: true, characterData: true, subtree: true, attributes: true });
  setTimeout(() => { mo.disconnect(); resolve(states); }, 4000);
}));
await page.click('#race-save');
await page.waitForTimeout(400);
const mid = await label();
ok('it says what it is doing', /saving/i.test(mid.text) || mid.saved, true);

console.log('\nand once it has landed');
await page.waitForFunction(() =>
  document.getElementById('race-save').classList.contains('is-saved'), null, { timeout: 15000 });
const done = await label();
ok('the button says so', done.text, 'Saved');
ok('and is pressable again straight away', done.disabled, false);
ok('nothing was said at the bottom of the screen', await page.evaluate(() => {
  const t = document.getElementById('toast');
  return !t || t.style.display === 'none';
}), true);

console.log('\nand then it is a save button again');
await page.waitForFunction(() =>
  document.getElementById('race-save').textContent.trim() === 'Save changes',
  null, { timeout: 8000 }).catch(() => {});
ok('back to how it started', await label(),
   { text: 'Save changes', disabled: false, busy: false, saved: false });

console.log('\nthe whole sequence, as the button showed it');
const states = await seen;
ok('save, saving, saved', states.filter((s, i) => i === 0 || s !== states[i - 1]),
   ['Save changes/on', 'Saving…/off', 'Saved/on', 'Save changes/on']);

// A failure is the case a button cannot carry: "Save failed: PUT ... 500" does
// not fit in two words, so the button goes back to normal and the sentence
// goes where a sentence fits.
console.log('\nand when the save fails');
await page.route('**/api/commit', route => route.fulfill({ status: 500, body: 'nope' }));
await page.click('#race-save');
await page.waitForTimeout(1500);
const failed = await label();
ok('the button is back as it was', failed,
   { text: 'Save changes', disabled: false, busy: false, saved: false });
ok('and the reason is on screen', await page.evaluate(() => {
  const t = document.getElementById('toast');
  return !!t && t.style.display !== 'none' && t.classList.contains('error') &&
         t.textContent.trim().length > 0;
}), true);

await page.unroute('**/api/commit');

// The pit board is the harder case and the reason saveBtn takes a selector.
// Saving intake reloads the board, which rebuilds every runner card from
// scratch, so the button that was pressed no longer exists by the time there
// is anything to say to it. Marking the element would mark a corpse.
console.log('\nthe pit board, whose buttons are rebuilt under them');
await page.goto(BASE + `/pit.html?id=${SLUG}`);
await page.waitForSelector('[data-action="save-intake"]', { timeout: 15000 });
await page.waitForTimeout(500);
const intake = '[data-action="save-intake"]';
const pitLabel = () => page.evaluate(sel => {
  const el = document.querySelector(sel);
  return el ? { text: el.textContent.trim(), saved: el.classList.contains('is-saved') } : null;
}, intake);
ok('starts as Save intake', await pitLabel(), { text: 'Save intake', saved: false });

// The three buttons here used to share one wrapping flex row, so on a phone
// the wrap fell wherever the widths landed and Save ended up beside a time
// correction with the other one orphaned below it. The two corrections belong
// together; saving is what the panel is for and gets its own line.
console.log('\nand the buttons are laid out by what they do');
const rows = await page.evaluate(() => {
  const box = el => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
  const times = [...document.querySelectorAll('[data-action="edit-time"]')].map(box);
  const save = box(document.querySelector('[data-action="save-intake"]'));
  return { times, save };
});
ok('both time buttons are on the same line', rows.times.length === 2 &&
   Math.abs(rows.times[0].top - rows.times[1].top) < 2, true);
ok('and save is below them, on its own', rows.save.top >= rows.times[0].bottom - 1, true);

const idleWidth = await page.evaluate(sel => document.querySelector(sel).offsetWidth, intake);

// Something to actually save, or the write is a no-op and proves nothing.
await page.evaluate(sel => {
  const box = document.querySelector('[data-intake="notes"]');
  if (box) { box.value = 'feeling good'; box.dispatchEvent(new Event('input', { bubbles: true })); }
  // Marked so the check further down can tell whether the redraw replaced it.
  document.querySelector(sel).dataset.wasClicked = 'yes';
}, intake);
await page.click(intake);
await page.waitForFunction(sel => {
  const el = document.querySelector(sel);
  return el && el.classList.contains('is-saved');
}, intake, { timeout: 15000 }).catch(() => {});
ok('and says Saved on the button the redraw left behind', await pitLabel(),
   { text: 'Saved', saved: true });

// The redraw hands back an element that never saw busy() and so carries no
// pinned width, which is how this button shrank to fit the word "Saved" while
// the settings ones held still. done() measures too, for exactly this.
ok('without changing size under the finger', await page.evaluate(sel =>
  document.querySelector(sel).offsetWidth, intake), idleWidth);

// The redraw really did happen, so this is a different element than the one
// that was clicked. If it were the same, the test above would pass for the
// wrong reason and the selector would be pointless.
ok('which is not the element that was pressed', await page.evaluate(sel => {
  const el = document.querySelector(sel);
  return !!(el && el.dataset.wasClicked !== 'yes');
}, intake), true);

ok('nothing threw', errs, []);
await b.close();
console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
