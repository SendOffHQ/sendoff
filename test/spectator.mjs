// What a signed-out spectator actually asks for.
//
// The published file the site serves only changes when the site rebuilds,
// which for this repo is twenty to thirty seconds. A public race has a copy
// the worker writes during the commit, so the spectator should be reading
// that. This counts which one the page really asks for, because "it should
// use the worker now" is a claim about a request.
//
//   node test/spectator.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net'; import fs from 'node:fs';
const BASE = 'http://localhost:8787';
const PUBLIC_SLUG = 'six-0-trail-marathon';
const UNLISTED_SLUG = '000003-dry-run-sangre';
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

// The service worker would answer some of these from its own cache and hide
// which one the page chose. The question is what leaves the page.
async function watch(slug) {
  const ctx = await b.newContext({ viewport:{width:390,height:844}, serviceWorkers:'block' });
  const page = await ctx.newPage();
  const asked = { published: 0, worker: 0 };
  page.on('request', r => {
    const u = r.url();
    if (/\/api\/public\?/.test(u)) asked.worker++;
    else if (new RegExp(`/races/${slug}/(data|config)\\.json`).test(u)) asked.published++;
  });
  // No session is set. This is a stranger with a link.
  await page.goto(`${BASE}/race.html?id=${slug}`);
  await page.waitForTimeout(4000);
  return { page, asked };
}

console.log('\na stranger opens a public race');
let { page, asked } = await watch(PUBLIC_SLUG);
ok('it reads the copy the worker holds', asked.worker >= 1, true);
ok('and does not fall back to the published file', asked.published, 0);
ok('the race rendered', await page.evaluate(() =>
  (document.getElementById('race-title')||{}).textContent || ''), 'Six-0 Trail Marathon');
ok('with splits on it', await page.evaluate(() =>
  document.querySelectorAll('#runners tr, .runner, [data-runner]').length > 0), true);
await page.context().close();

console.log('\nand an unlisted race still comes off the published file');
({ page, asked } = await watch(UNLISTED_SLUG));
ok('the published file answered it', asked.published >= 1, true);
// publicMiss: the worker is asked once, told no, and not asked again. Without
// that memo every poll would pay for a 404 it already knows about.
ok('the worker was asked once and not again', asked.worker, 1);
await page.context().close();

await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad?1:0);
