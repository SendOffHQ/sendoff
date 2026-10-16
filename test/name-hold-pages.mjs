// A race name held for review, on the pages. The people running the race are
// told on the race page and in settings why it is not on the hub; the admin
// sees every held race with what tripped it and lets it through; the wizard
// does not list a race the worker says it has held. The holding itself is the
// worker's, and worker/test/name-hold.mjs holds it.
//
//   node test/name-hold-pages.mjs
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
const errs = [];
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
page.on('pageerror', e => errs.push(e.message));
const signIn = (role) => page.evaluate(([base, role]) => {
  localStorage.setItem('race-hub-session-v1', JSON.stringify({ session: 'stub', proxyUrl: base + '/api',
    email: role === 'admin' ? 'admin@example.com' : 'crew@example.com', role, expiresAt: Date.now() + 7 * 24 * 3600e3 }));
  localStorage.setItem('race-hub-tutorial-v1', JSON.stringify({ racer: 99, pit: 99, race: 99, settings: 99 }));
}, [BASE, role]);
await page.goto(BASE + '/index.html');
await signIn('owner');

// The config as the worker hands it to someone running a held race.
const CFG = `races/${SLUG}/config.json`;
const setHeld = (held) => page.evaluate(async ([path, held]) => {
  const r = await (await fetch(`/api/get?path=${path}`, { headers: { Authorization: 'Bearer stub' } })).json();
  const c = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(r.content), x => x.charCodeAt(0))));
  delete c.myRole;
  if (held) c.held = true; else delete c.held;
  await fetch('/api/commit', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer stub' },
    body: JSON.stringify({ path, content: JSON.stringify(c), message: 'test' }) });
}, [CFG, held]);
const note = async (url) => {
  await page.goto(BASE + url);
  await page.waitForFunction(() => !/Loading/.test(document.getElementById('race-title').textContent), null, { timeout: 20000 });
  return page.evaluate(() => { const n = document.getElementById('held-note');
    return n && getComputedStyle(n).display !== 'none' ? n.textContent : null; });
};

console.log('\nthe race page');
await setHeld(true);
const said = await note(`/race.html?id=${SLUG}`);
ok('says the name is held, and that it is off the hub', /held for review, so it is not on the hub/.test(said || ''), true);
ok('and that everything else works', /Everything else works as normal/.test(said || ''), true);
await setHeld(false);
ok('says nothing about a race that is not held', await note(`/race.html?id=${SLUG}`), null);

console.log('\nsettings');
await setHeld(true);
ok('says the same', /held for review/.test(await note(`/settings.html?id=${SLUG}`) || ''), true);
await setHeld(false);
ok('and nothing once it is let through', await note(`/settings.html?id=${SLUG}`), null);

console.log('\nthe admin');
await signIn('admin');
await page.goto(BASE + '/admin.html');
await page.waitForSelector('#held-list .held-row', { timeout: 20000 });
const row = await page.evaluate(() => {
  const r = document.querySelector('#held-list .held-row');
  return { name: r.querySelector('.pending-name').textContent, meta: r.querySelector('.pending-meta').textContent,
    link: r.querySelector('a').getAttribute('href') };
});
ok('sees the held race by name, with a link to it', [row.name, row.link], ['Bullsh*t Backyard', '/race?id=zz-held-race']);
ok('and what tripped it, and who made it', /Caught: shit · made by crew@example\.com/.test(row.meta), true);
ok('and it fits a phone', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
page.once('dialog', d => d.accept());
await page.click('#held-list [data-approve]');
await page.waitForFunction(() => /Nothing is held/.test(document.getElementById('held-list').textContent), null, { timeout: 10000 });
ok('lets it through, and the list empties', await (await ctx.request.get(BASE + '/held-approved')).json(), ['zz-held-race']);

console.log('\nthe wizard');
// A real creation is not something this harness stands up, so this one reads
// the wizard: a race the worker says it held is not written onto the hub.
const wizard = await (await ctx.request.get(BASE + '/setup.html')).text();
ok('reads held off the worker\'s answer to the config write', /const held = !!\(made && made\.held\);/.test(wizard), true);
ok('and skips the hub list for it', /if \(held\) \{\s*progressLine\(`The race name is held for review/.test(wizard), true);

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
