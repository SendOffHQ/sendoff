// A new name on the profile, carried over to the races you are the racer on,
// by asking. And on the settings page, a linked racer says what name the race
// shows, with the account's own name one tap away.
//
// Sangre is the race: its racer is "Jason", linked here to this account the
// way the settings page links one, by a config save.
//
//   node test/racer-name-sync.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net'; import fs from 'node:fs';
const BASE = 'http://localhost:8787';
const SANGRE = '000001-sangre-de-cristo-100';
const ME = 'crew@example.com';
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

const ctx = await b.newContext({ viewport: { width: 900, height: 1100 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(BASE + '/profile.html');
await page.evaluate(base => {
  localStorage.setItem('race-hub-session-v1', JSON.stringify({ session: 'stub', proxyUrl: base + '/api',
    email: 'crew@example.com', role: 'owner', expiresAt: Date.now() + 7 * 24 * 3600e3 }));
  localStorage.setItem('race-hub-tutorial-v1', JSON.stringify({ settings: 99, profile: 99, pit: 99 }));
  localStorage.setItem('so:uname-later', '1');
}, BASE);
const read = (p) => page.evaluate(async (p) => {
  const r = await (await fetch(`/api/get?path=${p}`, { headers: { Authorization: 'Bearer stub' } })).json();
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(r.content), c => c.charCodeAt(0))));
}, p);
// Link Sangre's racer to this account, under the short name it started
// with. Set here rather than read from the repo, where the real race has
// since been renamed through this very feature.
await page.evaluate(async ([slug, me]) => {
  const env0 = await (await fetch(`/api/get?path=races/${slug}/config.json`, { headers: { Authorization: 'Bearer stub' } })).json();
  const cfg = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(env0.content), c => c.charCodeAt(0))));
  delete cfg.myRole; cfg.runners[0].email = me; cfg.runners[0].name = 'Jason';
  await fetch('/api/commit', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer stub' },
    body: JSON.stringify({ path: `races/${slug}/config.json`, content: JSON.stringify(cfg), message: 'link' }) });
}, [SANGRE, ME]);

const saveName = async (name) => {
  await page.goto(BASE + '/profile.html');
  await page.waitForSelector('#edit-profile:visible', { timeout: 15000 });
  await page.click('#edit-profile');
  await page.waitForSelector('#prof-name:visible', { timeout: 10000 });
  await page.fill('#prof-name', name);
  await page.click('.modal-box .modal-primary');
  await page.waitForTimeout(1200);
};

console.log('\na new name on the profile');
ok('the race starts as "Jason"', (await read(`races/${SANGRE}/config.json`)).runners[0].name, 'Jason');
await saveName('Jason Dupree');
ok('saving offers to carry it over', (await page.textContent('.modal-box .modal-title')).trim(), 'Your name on your races');
ok('naming the new name', (await page.textContent('.ns-lead')).replace(/\s+/g, ' ').trim(), 'Use Jason Dupree as your racer name on this race?');
ok('and the race, with what it shows now', (await page.textContent('.ns-row')).replace(/\s+/g, ' ').trim(), 'Sangre de Cristo 100now “Jason”');
ok('ticked, with a button that counts', [await page.isChecked('[data-ns="0"]'), (await page.textContent('.modal-box .modal-primary')).trim()], [true, 'Update 1 race']);
ok('and "Not now" to leave it', (await page.textContent('.modal-box .modal-cancel')).trim(), 'Not now');
await page.click('[data-ns="0"]');
ok('nothing ticked, nothing to press', await page.isDisabled('.modal-box .modal-primary'), true);
await page.click('[data-ns="0"]');
await page.click('.modal-box .modal-primary');
await page.waitForFunction(() => /Updated 1 race/.test(document.querySelector('.modal-box .modal-msg')?.textContent || ''), null, { timeout: 8000 }).catch(() => {});
ok('it says so', (await page.textContent('.modal-box .modal-msg')).startsWith('Updated 1 race.'), true);
const cfg = await read(`races/${SANGRE}/config.json`);
ok('the race now shows the new name', cfg.runners[0].name, 'Jason Dupree');
ok('and nothing else about the racer changed', [cfg.runners[0].id, cfg.runners.length], ['jason', 1]);
ok('and the hub listing says it too', (await read('races/index.json')).races.find(r => r.slug === SANGRE).runnerNames, ['Jason Dupree']);

console.log('\nwhen every race already has it');
await saveName('Jason Dupree');
ok('there is nothing to offer, and the box closes', await page.isVisible('.modal-box'), false);

console.log('\nthe settings page');
// The roster stub names this account "Casey Kim", so the race and the
// account now disagree, which is the case the button is for.
await page.goto(BASE + `/settings.html?id=${SANGRE}`);
await page.waitForSelector('#runner-editor-head', { timeout: 20000 });
await page.click('#runner-editor-head');
await page.waitForSelector('.runner-shown', { timeout: 10000 }).catch(() => {});
ok('a linked racer says the name the race shows', (await page.textContent('.runner-shown')).replace(/\s+/g, ' ').trim().startsWith('Shown as Jason Dupree'), true);
ok('and offers the account\'s own name', (await page.textContent('[data-use-profile-name]')).trim(), 'Use “Casey Kim”');
await page.click('[data-use-profile-name]');
ok('one tap puts it on the row', (await page.textContent('.runner-shown')).replace(/\s+/g, ' ').trim(), 'Shown as Casey Kim');
await page.click('#runner-save');
await page.waitForTimeout(1500);
ok('and Save keeps it', (await read(`races/${SANGRE}/config.json`)).runners[0].name, 'Casey Kim');

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
