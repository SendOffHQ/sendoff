// Taking a race off the hub, from the page where you would look for it.
//
// A friend set up a race, never ran it, and it sat on the public hub with
// nothing behind it. There was no control anywhere to move it: visibility was
// decided in the wizard and fixed from then on. This is the control, and what
// matters about it is who gets to see it and that the page tells the truth
// about what happened.
//
// The half-done case is the one worth a browser: the config is the fact and
// the manifest and the course follow it, so a save can succeed and still leave
// the race listed. Saying "Saved" to that would be a lie.
//
//   node test/race-visibility.mjs
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

const ctx = await b.newContext({ viewport:{width:900,height:1000}, serviceWorkers:'block' });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(BASE + '/index.html');
await page.evaluate(base => localStorage.setItem('race-hub-session-v1', JSON.stringify({
  session:'stub', proxyUrl: base + '/api', email:'crew@example.com', role:'owner',
  expiresAt: Date.now() + 7*24*3600e3 })), BASE);

const open = async () => {
  await page.goto(BASE + `/settings.html?id=${SLUG}`);
  await page.waitForSelector('#runner-editor-head', { timeout: 20000 });
  // The section is mounted off the roster fetch, not off the config, so it
  // arrives a beat after the page does.
  await page.waitForFunction(() => {
    const s = document.getElementById('visibility-editor');
    return s && (s.style.display !== 'none' || window.__vischecked);
  }, { timeout: 20000 }).catch(() => {});
};
const shown = () => page.evaluate(() => {
  const s = document.getElementById('visibility-editor');
  return !!s && s.style.display !== 'none';
});
const btnText = () => page.evaluate(() => {
  const el = document.getElementById('ax-vis-save');
  return el ? el.textContent.trim() : null;
});
const err = () => page.evaluate(() => {
  const el = document.querySelector('#ax-vis-result .access-err');
  return el ? el.textContent.trim() : null;
});

await open();

console.log('\nthe control, on the page where the race is set up');
ok('the section is there for the person who made the race', await shown(), true);
ok('collapsed, because it is not a day-to-day setting',
  await page.evaluate(() => document.getElementById('visibility-editor').classList.contains('collapsed')), true);
await page.click('#visibility-editor-head');
ok('and opens', await page.evaluate(() =>
  !document.getElementById('visibility-editor').classList.contains('collapsed')), true);

console.log('\nwhat it offers');
ok('two choices', await page.evaluate(() =>
  [...document.querySelectorAll('#ax-vis option')].map(o => o.value)), ['public','private']);
ok('showing what the race is now, which is unlisted',
  await page.evaluate(() => document.getElementById('ax-vis').value), 'private');
ok('worded for a person, not a database', await page.evaluate(() =>
  [...document.querySelectorAll('#ax-vis option')].map(o => o.textContent)),
  ['Listed on the hub', 'Unlisted']);

console.log('\nsaving it as listed');
await page.selectOption('#ax-vis', 'public');
await page.click('#ax-vis-save');
await page.waitForFunction(() => {
  const el = document.getElementById('ax-vis-save');
  return el && /Saved|Save$/.test(el.textContent.trim()) && !el.disabled;
}, { timeout: 10000 });
ok('the button says so rather than a toast at the ankle', await btnText(), 'Saved');
ok('with nothing to report', await err(), null);

console.log('\nand it stuck');
await open();
await page.click('#visibility-editor-head');
ok('the race comes back listed',
  await page.evaluate(() => document.getElementById('ax-vis').value), 'public');

// The settings page reloads itself every thirty seconds and redraws from what
// comes back. A redraw that rebuilt this panel would throw away a choice
// somebody was part way through making, and wipe the confirmation off the
// button a moment after it appeared. Driven on a panel of its own rather than
// by waiting out thirty seconds, because it is the panel's rule being checked.
console.log('\na reload landing while somebody is mid-choice');
ok('the redraw leaves an unsaved choice alone', await page.evaluate(() => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const cfg = { visibility: 'public' };
  const panel = Race.access.mountVisibility(host, { slug: 'scratch', cfg: () => cfg });
  const sel = host.querySelector('#ax-vis');
  sel.value = 'private';
  panel.redraw();
  const kept = host.querySelector('#ax-vis').value;
  // And a race whose stored visibility really did move is redrawn. The select
  // is put on the wrong value first, so a redraw that did not happen would
  // leave 'public' there and be told apart from one that did.
  cfg.visibility = 'private';
  host.querySelector('#ax-vis').value = 'public';
  panel.redraw();
  const moved = host.querySelector('#ax-vis').value;
  host.remove();
  return [kept, moved];
}), ['private', 'private']);

console.log('\nasking for what it already is');
await page.click('#ax-vis-save');
await page.waitForTimeout(400);
ok('is not called a save', await btnText(), 'No change');

console.log('\nwhen the worker refuses');
await page.evaluate(base => fetch(base + '/api/visibility-fails'), BASE);
await page.selectOption('#ax-vis', 'private');
await page.click('#ax-vis-save');
await page.waitForTimeout(600);
ok('the page says why', (await err() || '').includes('creator'), true);
ok('and the button does not claim it saved', await btnText(), 'Save');

// The refusal used to arrive at the press, as a 402 rendered in the panel.
// Greyed out with the reason up front is better: nobody reaches for something
// that cannot work, and the one-way door gets named before they walk through
// it rather than after.
//
// Nobody is actually on this footing today. DEFAULT_PLAN is pro and early
// access grandfathers private races, so the gate only bites an account
// deliberately set to Free with early access off.
console.log('\na race whose owner cannot have an unlisted one');
await page.evaluate(base => fetch(base + '/api/free-plan'), BASE);
await page.goto(BASE + `/settings.html?id=${SLUG}`);
await page.waitForSelector('#visibility-editor-head', { timeout: 20000 });
await page.click('#visibility-editor-head');
await page.waitForFunction(() => {
  const o = document.querySelector('#ax-vis option[value="private"]');
  return o && o.disabled;
}, { timeout: 10000 }).catch(() => {});
ok('the control is still there', await shown(), true);
ok('unlisted cannot be chosen', await page.evaluate(() =>
  document.querySelector('#ax-vis option[value="private"]').disabled), true);
ok('listing it is not gated', await page.evaluate(() =>
  document.querySelector('#ax-vis option[value="public"]').disabled), false);
const note = await page.evaluate(() => {
  const n = [...document.querySelectorAll('#visibility-editor-body .access-help')]
    .map(e => e.textContent.trim()).find(t => /Pro/.test(t));
  return n || null;
});
ok('and the reason is up front', /Pro feature/.test(note || ''), true);
ok('naming the plan it is on', /Free plan/.test(note || ''), true);

// The other branch, and the trap the whole warning exists for: a race that is
// already unlisted on a plan that cannot unlist one. The worker will take it
// public and then refuse to give it back, so that has to be said before the
// press and not after. Driven on a panel of its own, because the fixture race
// is listed by this point in the run.
ok('a race already unlisted is warned it is a one-way door', await page.evaluate(async () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  Race.access.mountVisibility(host, { slug: 'scratch', cfg: () => ({ visibility: 'private' }) });
  for (let i = 0; i < 40 && !/Pro/.test(host.textContent); i++) {
    await new Promise(r => setTimeout(r, 25));
  }
  const text = host.textContent;
  const stillChoosable = !host.querySelector('#ax-vis option[value="private"]').disabled;
  host.remove();
  return [/cannot be undone/.test(text), stillChoosable];
}), [true, true]);

console.log('\nsomebody who did not make the race');
await page.evaluate(base => fetch(base + '/api/not-creator'), BASE);
await page.goto(BASE + `/settings.html?id=${SLUG}`);
await page.waitForSelector('#runner-editor-head', { timeout: 20000 });
await page.waitForTimeout(1200);
ok('never sees the control', await shown(), false);
ok('and cannot see Delete either', await page.evaluate(() =>
  document.getElementById('delete-editor').style.display), 'none');

// The moderation case. A race set up and never run sits on the hub with
// nothing behind it, and the person who made it has stopped looking: if only
// they can take it down, it stays up. Taking it off the hub is reversible and
// destroys nothing, which is why this is an admin's to do and Delete is not.
console.log('\nand a site admin, who also did not make it');
await page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem('race-hub-session-v1'));
  s.role = 'admin';
  localStorage.setItem('race-hub-session-v1', JSON.stringify(s));
});
await page.goto(BASE + `/settings.html?id=${SLUG}`);
await page.waitForSelector('#runner-editor-head', { timeout: 20000 });
await page.waitForTimeout(1200);
ok('can take it off the hub', await shown(), true);
ok('but still cannot delete it', await page.evaluate(() =>
  document.getElementById('delete-editor').style.display), 'none');
// The free plan is still switched on from the section above, and an admin is
// not gated by it: the owner's plan is a reason they cannot hide their own
// race, never a reason a dead one has to stay on the hub.
await page.click('#visibility-editor-head');
ok('and is not held back by the owner\'s plan', await page.evaluate(() =>
  document.querySelector('#ax-vis option[value="private"]').disabled), false);

// And the shape that actually matters, because it is the one the Jr Texas
// Water Safari is: an admin who is not on the race at all. The config comes
// back with no role and the roster is refused, which is right, and the control
// still has to be there or the moderation lever cannot be reached.
console.log('\nan admin who is not on the race at all');
await page.evaluate(base => fetch(base + '/api/not-on-race'), BASE);
await page.goto(BASE + `/settings.html?id=${SLUG}`);
await page.waitForSelector('#runner-editor-head', { timeout: 20000 });
await page.waitForTimeout(1500);
ok('has no role on it', await page.evaluate(() =>
  document.getElementById('access').style.display), 'none');
ok('and can still take it off the hub', await shown(), true);
await page.click('#visibility-editor-head');
ok('with the control drawn', await page.evaluate(() =>
  !!document.getElementById('ax-vis')), true);

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
