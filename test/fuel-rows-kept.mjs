// Saving the fueling editor does not throw away what somebody typed.
//
// Reported: added a shorthand on a real race, pressed Save, and it was gone.
// No message, nothing to reload, the row simply not there.
//
// The dropping was deliberate and the rules behind it are right. A fueling
// metric with no name has no column to be. A shorthand with no numbers is a
// button on the pit board that adds nothing when tapped. What was wrong is
// that a half-filled row met those rules in silence, so the app looked like it
// had deleted your work, which from where you are sitting is what happened.
//
// The line this draws: a row nobody touched is still dropped without comment,
// because pressing "+ Add" and changing your mind must not block a save. A row
// with anything in it is either saved or refused out loud, naming the row.
//
//   node test/fuel-rows-kept.mjs
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

const openEditor = async () => {
  await page.goto(BASE + `/settings.html?id=${SLUG}`);
  await page.waitForSelector('#runner-editor-head', { timeout: 20000 });
  await page.click('#runner-editor-head');
  await page.waitForSelector('#preset-rows tr', { timeout: 20000 });
};
const presetNames = () => page.evaluate(() =>
  [...document.querySelectorAll('#preset-rows [data-k="name"]')].map(e => e.value));
const fuelNames = () => page.evaluate(() =>
  [...document.querySelectorAll('#fuel-rows [data-k="label"]')].map(e => e.value));
const save = async () => {
  await page.click('#runner-save');
  await page.waitForTimeout(1800);
};
const toast = () => page.evaluate(() => {
  const t = document.getElementById('toast');
  return (t && t.style.display !== 'none') ? t.textContent.trim() : null;
});
const clearToast = () => page.evaluate(() => {
  const t = document.getElementById('toast'); if (t) t.style.display = 'none';
});

await openEditor();
console.log('\nthe race as it starts');
ok('one shorthand', await presetNames(), ['Flask of LMNT']);

// The report, exactly: add a shorthand, type a name, press Save.
console.log('\na shorthand with a name and no amounts');
await page.click('#add-preset');
await page.fill('#preset-rows tr:last-child [data-k="name"]', 'Gel');
await save();
ok('the row is still there', await presetNames(), ['Flask of LMNT', 'Gel']);
ok('and it says why it cannot be saved',
   /has no amounts/i.test(await toast() || ''), true);
ok('naming the row, so it can be found', /Gel/.test(await toast() || ''), true);
await clearToast();

console.log('\nand once an amount is filled in');
await page.fill('#preset-rows tr:last-child [data-mk="calories"]', '100');
await save();
await openEditor();
ok('it survives the save and the reload', await presetNames(), ['Flask of LMNT', 'Gel']);
ok('with the amount on it', await page.evaluate(() =>
  document.querySelector('#preset-rows tr:last-child [data-mk="calories"]').value), '100');

console.log('\namounts with no name');
await page.click('#add-preset');
await page.fill('#preset-rows tr:last-child [data-mk="calories"]', '50');
await save();
ok('refused rather than dropped', (await presetNames()).length, 3);
ok('and says what is missing', /needs a name/i.test(await toast() || ''), true);
await clearToast();

// The other half of the line. An abandoned click must not wedge the editor.
console.log('\nan added row nobody typed in');
await page.fill('#preset-rows tr:last-child [data-mk="calories"]', '');
await save();
await openEditor();
ok('the save goes through', await presetNames(), ['Flask of LMNT', 'Gel']);
ok('with nothing said about it', await toast(), null);

// Same silence, same save button, one table up: a metric with a target typed
// against it but no name was dropped exactly as quietly.
console.log('\na fueling metric with a goal but no name');
const before = await fuelNames();
await page.click('#add-fuel');
await page.fill('#fuel-rows tr:last-child [data-k="target"]', '60');
await save();
ok('refused', (await fuelNames()).length, before.length + 1);
ok('and says a name is needed', /needs a name/i.test(await toast() || ''), true);
await clearToast();

console.log('\nand named, it saves like any other');
await page.fill('#fuel-rows tr:last-child [data-k="label"]', 'Carbs');
await save();
await openEditor();
ok('it is there', await fuelNames(), [...before, 'Carbs']);
// A new metric means a new column in the shorthand table, and the shorthand
// that was already saved has to come through that unchanged.
ok('and the shorthands came through with it', await presetNames(), ['Flask of LMNT', 'Gel']);

ok('nothing threw', errs, []);
await b.close();
console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
