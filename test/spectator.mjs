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
// The fixture, not a race somebody might delete. See test/fixtures/races.
const UNLISTED_SLUG = 'zz-fixture-unlisted';
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
async function watch(slug, extra = '', page_ = '/race.html') {
  const ctx = await b.newContext({ viewport:{width:390,height:844}, serviceWorkers:'block' });
  const page = await ctx.newPage();
  const asked = { published: 0, worker: 0, get: 0 };
  page.on('request', r => {
    const u = r.url();
    if (/\/api\/public\?/.test(u)) asked.worker++;
    else if (/\/api\/get\?/.test(u)) asked.get++;
    else if (new RegExp(`/races/${slug}/(data|config)\\.json`).test(u)) asked.published++;
  });
  // No session is set. This is a stranger with a link.
  await page.goto(`${BASE}${page_}?id=${slug}${extra}`);
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

console.log('\nand an unlisted race with no link still comes off the published file');
({ page, asked } = await watch(UNLISTED_SLUG));
ok('the published file answered it', asked.published >= 1, true);
// publicMiss: the worker is asked once, told no, and not asked again. Without
// that memo every poll would pay for a 404 it already knows about.
ok('the worker was asked once and not again', asked.worker, 1);
await page.context().close();

// The share link. This is what lets races/** stop being written to git: before
// it, a stranger holding a link to an unlisted race read the published file,
// so that file had to keep existing.
console.log('\na stranger with a share link to an unlisted race');
({ page, asked } = await watch(UNLISTED_SLUG, `&t=stub-${UNLISTED_SLUG}`));
ok('reads it through the worker', asked.get >= 1, true);
ok('and never touches the published file', asked.published, 0);
ok('the race rendered', await page.evaluate(() =>
  ((document.getElementById('race-title')||{}).textContent || '').length > 0), true);
// A token grants reading, not a role: no pit board, no settings.
ok('with no crew pages offered', await page.evaluate(() =>
  [...document.querySelectorAll('nav a, .nav a')].map(a => a.textContent.trim())
    .filter(t => t === 'Pit Board' || t === 'Settings')), []);
await page.context().close();

// charts and print-report read their own race files. They used to fetch the
// published copy directly, with no worker path at all, which meant they would
// have been the two pages that broke the moment races/** stopped being
// written. Signed out on a public race is the case with no session to lean on.
console.log('\nthe charts page, signed out on a public race');
({ page, asked } = await watch(PUBLIC_SLUG, '', '/charts.html'));
ok('reads through the worker', asked.worker >= 1, true);
ok('and not the published file', asked.published, 0);
ok('and it drew something', await page.evaluate(() =>
  document.querySelectorAll('svg, canvas').length > 0), true);
await page.context().close();

console.log('\nthe printable report, same');
({ page, asked } = await watch(PUBLIC_SLUG, '', '/print-report.html'));
ok('reads through the worker', asked.worker >= 1, true);
ok('and not the published file', asked.published, 0);
ok('the race name made it onto the page', await page.evaluate(() =>
  /Six-0/.test(document.body.textContent || '')), true);
await page.context().close();

console.log('\nand a link for the wrong race gets nothing from the worker');
({ page, asked } = await watch(UNLISTED_SLUG, '&t=stub-some-other-race'));
ok('the worker refused it', asked.get >= 1, true);
ok('so the published file had to answer', asked.published >= 1, true);
await page.context().close();

await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad?1:0);
