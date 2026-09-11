// A race address that has no page of its own still opens the race.
//
// A public race is linked as /races/<slug>/. That is a real page in this repo,
// built per race by tools/make-og.py so the link carries that race's own
// preview card, and it is built after the race exists. On 2026-09-11 a race
// was created, listed on the hub, and every click on its card landed on the
// 404 page: the manifest entry had committed and the page had not.
//
// The race itself was fine. 404.html now forwards a /races/<slug>/ address
// into the app rather than telling somebody their race does not exist, which
// covers the window for every race from here on. This is that, in a browser,
// because it is a claim about what a navigation does.
//
//   node test/race-page-fallback.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net'; import fs from 'node:fs';
const BASE = 'http://localhost:8787';
// A slug with no directory in this repo, which is exactly the case: the race
// exists, its wrapper page does not.
const NOPAGE = 'zz-no-page-yet';
const HASPAGE = 'six-0-trail-marathon';
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

// Service workers blocked: the question is where the browser ends up, and a
// cached shell answering the navigation would hide it.
const ctx = await b.newContext({ viewport:{width:390,height:844}, serviceWorkers:'block' });
async function land(path) {
  const page = await ctx.newPage();
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  const url = page.url().replace(BASE, '');
  await page.close();
  return url;
}

// /race.html, not /race: the page is asked for by its real name and both this
// harness and Cloudflare Pages 308 it to the extensionless form, which is what
// the address bar ends up showing. Asserting the landing address rather than
// the one in the script keeps this a test of where somebody ends up.
console.log('\na race whose page has not been built yet');
ok('opens the race instead of the 404', await land(`/races/${NOPAGE}/`), `/race?id=${NOPAGE}`);
ok('without the trailing slash too', await land(`/races/${NOPAGE}`), `/race?id=${NOPAGE}`);

// A share link is the whole of an unlisted race's access. Dropping the token
// on the way through would turn a working link into a sign-in prompt.
console.log('\nand a share token rides through it');
ok('the token is still on the address',
   await land(`/races/${NOPAGE}/?t=stub-${NOPAGE}`), `/race?id=${NOPAGE}&t=stub-${NOPAGE}`);

console.log('\na race that does have its own page keeps it');
const res = await ctx.request.get(`${BASE}/races/${HASPAGE}/`);
ok('served, not 404ed', res.status(), 200);

// The fallback is on the 404 page, so it sees every missing address, not only
// race-shaped ones. A slug never has a dot in it; a file always does.
console.log('\nand a missing file under races/ is left alone');
ok('still the 404 page', await land('/races/nothing.json'), '/races/nothing.json');
ok('so is a file inside a race', await land(`/races/${NOPAGE}/config.json`), `/races/${NOPAGE}/config.json`);

await b.close();
console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
