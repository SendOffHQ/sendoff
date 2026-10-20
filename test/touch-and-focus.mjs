// The web interface guidelines audit, 2026-10-20 (Vercel's list, checked
// against SendOff by hand): what a phone at an aid station needs that the
// pages did not all do.
//
//   - pinch zoom allowed everywhere, which needs every field at 16px or more on
//     a touch screen, or the phone zooms the page in whenever one is tapped;
//   - every field, dropdown and button has a name a screen reader can say;
//   - the browser's own controls drawn for a dark page;
//   - a ring round the field being typed into;
//   - nothing blinking or pulsing for somebody who asked for less motion;
//   - toasts and errors read out when they appear.
//
//   node test/touch-and-focus.mjs            checks
//   node test/touch-and-focus.mjs --list     prints every offender
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net'; import fs from 'node:fs';
const BASE = 'http://localhost:8787';
const SLUG = 'zz-fixture-unlisted';
const PIN = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const LIST = process.argv.includes('--list');

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
const session = (base) => {
  localStorage.setItem('race-hub-session-v1', JSON.stringify({ session: 'stub', proxyUrl: base + '/api',
    email: 'crew@example.com', role: 'admin', expiresAt: Date.now() + 7 * 24 * 3600e3 }));
  localStorage.setItem('race-hub-tutorial-v1', JSON.stringify({ racer: 99, pit: 99, race: 99, settings: 99 }));
};
const phone = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
const page = await phone.newPage();
page.on('pageerror', e => errs.push(e.message));
await page.goto(BASE + '/index.html');
await page.evaluate(session, BASE);
const api = (path, body) => page.evaluate(async ([path, body]) => {
  if (!body) {
    const r = await (await fetch(`/api/get?path=${path}`, { headers: { Authorization: 'Bearer stub' } })).json();
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(r.content), c => c.charCodeAt(0))));
  }
  await fetch('/api/commit', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer stub' },
    body: JSON.stringify({ path, content: JSON.stringify(body), message: 'test' }) });
}, [path, body]);

// The fixture mid-race, so the live parts (the blinking LIVE label, the
// racer's dot) are on the page: legs one to eight done, the ninth out.
const CFG = `races/${SLUG}/config.json`, DATA = `races/${SLUG}/data.json`;
const cfg = await api(CFG); delete cfg.myRole;
const data = await api(DATA);
const last = data.runners[0].legs.filter(l => l.index <= 9).sort((a, b) => b.index - a.index)[0];
const shift = Date.now() - 30 * 60e3 - Date.parse(last.startTime);
const mv = (s) => s && new Date(Date.parse(s) + shift).toISOString();
cfg.startTime = mv(cfg.startTime);
for (const r of data.runners) r.legs = r.legs.filter(l => l.index <= 9)
  .map(l => ({ ...l, startTime: mv(l.startTime), endTime: l.index === 9 ? undefined : mv(l.endTime) }));
await api(CFG, cfg); await api(DATA, data);
const runner = data.runners[0].id;

const look = () => page.evaluate(() => {
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const name = (el) => {
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    const by = el.getAttribute('aria-labelledby');
    if (by) return by.split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ').trim();
    if (el.labels && el.labels.length) return [...el.labels].map(l => l.textContent).join(' ').trim();
    if (el.matches('button, a, summary, [role="button"]')) return (el.textContent || '').trim() || el.querySelector('img[alt], svg[aria-label], svg title')?.getAttribute?.('alt') || el.querySelector('svg title')?.textContent || '';
    if (el.matches('input[type="button"], input[type="submit"]')) return el.value;
    return el.getAttribute('title') || '';
  };
  const where = (el) => el.id ? '#' + el.id : el.tagName.toLowerCase() + [...el.attributes].filter(a => /^(class|name|data-[\w-]+|type)$/.test(a.name)).slice(0, 2).map(a => `[${a.name}${a.value ? '="' + a.value.slice(0, 20) + '"' : ''}]`).join('');
  const typing = 'input:not([type]), input[type="text"], input[type="password"], input[type="number"], input[type="datetime-local"], input[type="date"], input[type="time"], input[type="email"], input[type="url"], input[type="search"], input[type="tel"], textarea, select';
  const vp = document.querySelector('meta[name="viewport"]')?.content || '';
  const small = [...document.querySelectorAll(typing)].filter(shown)
    .filter(el => parseFloat(getComputedStyle(el).fontSize) < 16).map(el => `${where(el)} ${getComputedStyle(el).fontSize}`);
  const unnamed = [...document.querySelectorAll(typing + ', input[type="checkbox"], input[type="radio"], input[type="range"], input[type="color"], button, [role="button"]')]
    .filter(shown).filter(el => !name(el).replace(/\s+/g, '')).map(where);
  const toast = document.getElementById('toast'), err = document.getElementById('error');
  return {
    coarse: matchMedia('(pointer: coarse)').matches,
    zoom: !/user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0*)?\b/.test(vp),
    small, unnamed,
    scheme: getComputedStyle(document.documentElement).colorScheme,
    announced: [toast && (toast.getAttribute('role') === 'status' && toast.getAttribute('aria-live') === 'polite'), err && err.getAttribute('role') === 'alert'],
    hasToast: !!toast, hasError: !!err,
    endless: document.getAnimations().filter(a => a.playState === 'running' && a.effect && a.effect.getComputedTiming().iterations === Infinity).length,
  };
});
const focusRing = () => page.evaluate(() => {
  const el = [...document.querySelectorAll('input[type="text"], input[type="number"], input[type="email"], textarea')]
    .find(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !e.disabled; });
  if (!el) return null;
  el.focus();
  const cs = getComputedStyle(el);
  const outline = cs.outlineStyle !== 'none' && !/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)|transparent/.test(cs.outlineColor) && parseFloat(cs.outlineWidth) > 0;
  return outline || (cs.boxShadow && cs.boxShadow !== 'none');
});

const PAGES = [
  ['landing', '/index.html'], ['races list', '/app/'], ['race page', `/race.html?id=${SLUG}`],
  ['crew page', `/pit.html?id=${SLUG}`], ['racer screen', `/racer.html?id=${SLUG}&runner=${runner}`],
  ['settings', `/settings.html?id=${SLUG}`], ['setup wizard', '/setup.html'], ['admin', '/admin.html'],
  ['profile', '/profile.html'], ['charts', `/charts.html?id=${SLUG}`], ['sign-up', '/signup.html'], ['reset', '/reset.html'],
];
for (const [label, url] of PAGES) {
  await page.goto(BASE + url);
  await page.waitForTimeout(2500);
  // Settings keeps its tables folded; open every section so they are checked.
  for (const head of await page.$$('.editor-head')) { await head.click().catch(() => {}); await page.waitForTimeout(150); }
  const r = await look();
  if (LIST) { for (const s of r.small) console.log(`    ${label.padEnd(13)} small    ${s}`); for (const u of r.unnamed) console.log(`    ${label.padEnd(13)} unnamed  ${u}`); }
  console.log(`\n${label}`);
  ok('a touch screen, as the phone at the aid station is', r.coarse, true);
  ok('pinch zoom allowed', r.zoom, true);
  ok('every field 16px or more, so tapping one does not zoom', r.small.slice(0, 4), []);
  ok('every field, dropdown and button has a name', r.unnamed.slice(0, 4), []);
  ok('the browser\'s own controls drawn dark', r.scheme, 'dark');
  if (r.hasToast || r.hasError) ok('toasts and errors read out when they appear', r.announced.filter(x => x !== null), [r.hasToast, r.hasError].filter(Boolean).map(() => true));
  const ring = await focusRing();
  if (ring !== null) ok('the field being typed into has a ring', ring, true);
}

console.log('\nsettings sections from the keyboard');
await page.goto(BASE + `/settings.html?id=${SLUG}`);
await page.waitForSelector('#runner-editor-head', { timeout: 20000 });
ok('a section head is a button that says it is shut', await page.$eval('#runner-editor-head', h => [h.getAttribute('role'), h.tabIndex, h.getAttribute('aria-expanded')]), ['button', 0, 'false']);
await page.focus('#runner-editor-head'); await page.keyboard.press('Enter');
ok('Enter opens it, and it says so', [await page.$eval('#runner-editor', e => e.classList.contains('collapsed')), await page.$eval('#runner-editor-head', h => h.getAttribute('aria-expanded'))], [false, 'true']);

console.log('\nless motion');
await page.goto(BASE + `/race.html?id=${SLUG}`);
await page.waitForTimeout(2500);
ok('a live race page blinks and pulses as a rule', (await look()).endless > 0, true);
await page.emulateMedia({ reducedMotion: 'reduce' });
await page.goto(BASE + `/race.html?id=${SLUG}`);
await page.waitForTimeout(2500);
ok('and holds still for somebody who asked for less motion', (await look()).endless, 0);
await page.emulateMedia({ reducedMotion: 'no-preference' });

console.log('\non a laptop');
const laptop = await b.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
const lp = await laptop.newPage();
lp.on('pageerror', e => errs.push(e.message));
await lp.goto(BASE + '/index.html'); await lp.evaluate(session, BASE);
await lp.goto(BASE + `/pit.html?id=${SLUG}`);
await lp.waitForSelector('#runners input[data-intake]', { timeout: 20000 });
ok('fields keep their size where tapping cannot zoom', await lp.$eval('#runners input[data-intake]', el => getComputedStyle(el).fontSize), '13px');

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
