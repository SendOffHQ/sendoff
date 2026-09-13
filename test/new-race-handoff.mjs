// What happens between finishing the wizard and having a race people can use.
//
// The wizard takes racers as names and bibs, and it cannot take their
// accounts: linking a racer to an account offers the people already on the
// race, and until the race exists there is nobody to offer. Somebody built a
// two-racer race here, went looking for where the second racer's account went,
// and there was nowhere. Nothing was broken; nothing said where to go either.
//
// Two halves, and both are copy in the sense that they are only words, and
// load-bearing in the sense that without them a race with two racers on it has
// one racer who can log and one who cannot, and no clue on any screen about
// why.
//
//   node test/new-race-handoff.mjs
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
const signIn = async (page) => page.evaluate(base => localStorage.setItem(
  'race-hub-session-v1', JSON.stringify({ session:'stub', proxyUrl: base + '/api',
    email:'crew@example.com', role:'owner', expiresAt: Date.now() + 7*24*3600e3 })), BASE);

// ---- the wizard ----
console.log('\nthe wizard says where a racer meets their account');
const setup = await ctx.newPage();
await setup.goto(BASE + '/index.html');
await signIn(setup);
await setup.goto(BASE + '/setup.html');
await setup.waitForTimeout(600);
const hint = await setup.evaluate(() => {
  const tbl = document.getElementById('runner-table');
  if (!tbl) return null;
  // The line belongs to the racer section, not to the page in general: a
  // sentence about linking accounts helps nobody three sections away.
  const sec = tbl.closest('section');
  const p = [...sec.querySelectorAll('p')].map(e => e.textContent.replace(/\s+/g, ' ').trim());
  return p.join(' ');
});
ok('it names the settings page', /race settings page/i.test(hint || ''), true);
ok('and says an invite comes first', /invited/i.test(hint || ''), true);
ok('and why it matters', /log their own legs/i.test(hint || ''), true);

// The hop itself only happens after a real creation, which this harness does
// not stand up, so what is checked here is that the marker is conditional at
// all. It is a source check and worth saying so: the failure it guards is
// somebody making it unconditional, which would put a "go invite the others"
// note on every single-racer race forever.
console.log('\nand it marks the hop only when there is more than one racer');
const wizardSrc = await (await ctx.request.get(BASE + '/setup.html')).text();
ok('the marker is tied to the racer count',
   /runners \|\| \[\]\)\.length > 1 \? '&invite=1' : ''/.test(wizardSrc), true);
await setup.close();

// ---- the race page ----
// Arriving from the wizard. ?new=1 is the patience marker that already
// existed; ?invite=1 is the new one, and it has to survive the wait and then
// not survive a refresh.
console.log('\nthe race page, arrived at from a two-racer wizard');
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(BASE + '/index.html');
await signIn(page);
await page.goto(BASE + `/race.html?id=${SLUG}&new=1&invite=1`);
await page.waitForFunction(() => {
  const el = document.getElementById('new-note');
  return el && el.style.display === 'block';
}, null, { timeout: 20000 }).catch(() => {});
const note = await page.evaluate(() => {
  const el = document.getElementById('new-note');
  if (!el || el.style.display !== 'block') return null;
  const a = el.querySelector('a');
  return { text: el.textContent.replace(/\s+/g, ' ').trim(),
           href: a ? a.getAttribute('href') : null };
});
ok('a note is shown', !!note, true);
ok('pointing at this race\'s settings', note && note.href, `settings.html?id=${SLUG}`);
ok('and saying what to do there', /invited|invite/i.test((note && note.text) || ''), true);

// Said once. The marker comes off the address on the same pass that shows the
// note, so a refresh, or a link copied out of the address bar, is an ordinary
// visit to the race and not an instruction to set it up again.
console.log('\nand it is said once');
ok('the markers are off the address', new URL(page.url()).search, `?id=${SLUG}`);
await page.reload();
await page.waitForTimeout(1500);
ok('a refresh shows no note', await page.evaluate(() =>
  (document.getElementById('new-note') || {}).style?.display || 'none'), 'none');

console.log('\nand a one-racer race is not told to go invite anybody');
await page.goto(BASE + `/race.html?id=${SLUG}&new=1`);
await page.waitForTimeout(2500);
ok('no note at all', await page.evaluate(() =>
  (document.getElementById('new-note') || {}).style?.display || 'none'), 'none');

ok('nothing threw', errs, []);
await b.close();
console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
