// What search engines are told. Cloudflare redirects /privacy.html to
// /privacy, so a canonical tag naming the .html address points at a redirect,
// and Search Console files the page that serves as "an alternate" of a page
// that does not. Every canonical names the address that serves. A public race
// is listed at /race?id=<slug>, which its share page forwards to; an unlisted
// or private one asks not to be listed.
//
//   node test/search-tags.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net'; import fs from 'node:fs'; import path from 'node:path';
const BASE = 'http://localhost:8787';
const SLUG = 'zz-fixture-unlisted';
const ROOT = new URL('..', import.meta.url).pathname;
const PIN = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
let bad = 0;
const ok=(l,g,w)=>{const q=JSON.stringify(g)===JSON.stringify(w); if(!q)bad++;
  console.log(`  ${q?'ok  ':'FAIL'} ${l.padEnd(58)} ${JSON.stringify(g)}${q?'':' want '+JSON.stringify(w)}`)};

console.log('\nevery page');
const pages = fs.readdirSync(ROOT).filter(f => f.endsWith('.html'));
const html = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
ok('no canonical or og:url names a .html address',
  pages.filter(f => /<link rel="canonical" href="[^"]*\.html|og:url" content="[^"]*\.html/.test(html(f))), []);
ok('and none names another page', pages.filter(f => {
  const m = html(f).match(/<link rel="canonical" href="https:\/\/sendoff\.run\/([^"]*)"/);
  return m && m[1] !== (f === 'index.html' ? '' : f.replace(/\.html$/, ''));
}), []);
ok('the race page has none of its own until it knows the race', /<link rel="canonical"/.test(html('race.html').replace(/<!--[\s\S]*?-->/g, '')), false);
const sitemap = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
const listed = JSON.parse(fs.readFileSync(path.join(ROOT, 'races/index.json'), 'utf8')).races.map(r => r.slug);
ok('the sitemap lists every public race at its canonical address',
  listed.filter(s => !sitemap.includes(`<loc>https://sendoff.run/race?id=${s}</loc>`)), []);
ok('and no .html address', /\.html/.test(sitemap), false);
ok('robots.txt points at it', /Sitemap: https:\/\/sendoff\.run\/sitemap\.xml/.test(fs.readFileSync(path.join(ROOT, 'robots.txt'), 'utf8')), true);
for (const s of listed) {
  const stub = fs.readFileSync(path.join(ROOT, 'races', s, 'index.html'), 'utf8');
  if (!stub.includes(`<link rel="canonical" href="https://sendoff.run/race?id=${s}">`) || !stub.includes(`location.replace('/race?id=${s}'`)) {
    ok(`share page for ${s} points at /race?id=`, false, true);
  }
}

const listening = () => new Promise(r => { const s = net.connect(8787,'127.0.0.1');
  const d=v=>{s.destroy();r(v)}; s.once('connect',()=>d(true)); s.once('error',()=>d(false)); setTimeout(()=>d(false),500); });
if (await listening()) { console.error('port busy'); process.exit(2); }
const srv = spawn('node', [new URL('./' + 'harn' + 'ess.mjs', import.meta.url).pathname], { stdio: 'ignore' });
process.on('exit', () => { try { srv.kill('SIGKILL'); } catch (e) {} });
for (let i=0;i<40 && !(await listening());i++) await new Promise(r=>setTimeout(r,150));

const b = await chromium.launch(fs.existsSync(PIN) ? { executablePath: PIN } : {});
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(BASE + '/index.html');
await page.evaluate(base => {
  localStorage.setItem('race-hub-session-v1', JSON.stringify({ session: 'stub', proxyUrl: base + '/api',
    email: 'crew@example.com', role: 'owner', expiresAt: Date.now() + 7 * 24 * 3600e3 }));
  localStorage.setItem('race-hub-tutorial-v1', JSON.stringify({ racer: 99, pit: 99, race: 99 }));
}, BASE);
const tags = async () => {
  await page.goto(BASE + `/race?id=${SLUG}`);
  await page.waitForFunction(() => document.title !== 'SendOff', null, { timeout: 20000 });
  return page.evaluate(() => ({
    canonical: (document.querySelector('link[rel="canonical"]') || {}).href || null,
    robots: (document.querySelector('meta[name="robots"]') || {}).content || null }));
};

console.log('\nthe race page');
ok('an unlisted race asks not to be listed', await tags(), { canonical: null, robots: 'noindex, nofollow' });
const cfg = await page.evaluate(async (slug) => {
  const r = await (await fetch(`/api/get?path=races/${slug}/config.json`, { headers: { Authorization: 'Bearer stub' } })).json();
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(r.content), c => c.charCodeAt(0))));
}, SLUG);
cfg.visibility = 'public';
await page.evaluate(async ([slug, cfg]) => {
  await fetch('/api/commit', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer stub' },
    body: JSON.stringify({ path: `races/${slug}/config.json`, content: JSON.stringify(cfg), message: 'public' }) });
}, [SLUG, cfg]);
ok('a public one is listed at /race?id=, whatever address it was opened at', await tags(),
  { canonical: `https://sendoff.run/race?id=${SLUG}`, robots: null });

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
