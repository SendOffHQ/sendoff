// Legibility on a phone: no text smaller than 11px as it is drawn on the
// screen, and none fainter than 4.5:1 against what is behind it (3:1 for large
// text). Asked for 2026-10-20 after an audit found the race page's stat labels
// at 9px, the station tags at 8px and a good deal at 10px, on the pages crews
// read in the dark and the sun. Chart text counts at the size it is drawn, so
// a chart scaled down to a phone cannot shrink its labels out of sight.
//
//   node test/legibility.mjs            checks
//   node test/legibility.mjs --list     prints every offender, for fixing
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net'; import fs from 'node:fs';
const BASE = 'http://localhost:8787';
const SLUG = 'zz-fixture-unlisted';
const PIN = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const LIST = process.argv.includes('--list');
const MIN_PX = 11;

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
await page.goto(BASE + '/index.html');
await page.evaluate(base => {
  localStorage.setItem('race-hub-session-v1', JSON.stringify({ session: 'stub', proxyUrl: base + '/api',
    email: 'crew@example.com', role: 'admin', expiresAt: Date.now() + 7 * 24 * 3600e3 }));
  localStorage.setItem('race-hub-tutorial-v1', JSON.stringify({ racer: 99, pit: 99, race: 99, settings: 99 }));
}, BASE);
const api = (path, body) => page.evaluate(async ([path, body]) => {
  if (!body) {
    const r = await (await fetch(`/api/get?path=${path}`, { headers: { Authorization: 'Bearer stub' } })).json();
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(r.content), c => c.charCodeAt(0))));
  }
  await fetch('/api/commit', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer stub' },
    body: JSON.stringify({ path, content: JSON.stringify(body), message: 'test' }) });
}, [path, body]);

// The fixture, put mid-race so every live part of every page is drawn: legs
// one to eight done, the ninth out for the last half hour.
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

// Every visible run of text: the size it is drawn at, and its contrast with
// the colour behind it, worked out by laying each background up the tree over
// the one beneath, with the opacity of everything on the way.
const measure = () => page.evaluate((MIN) => {
  const rgba = (s) => { const m = s.match(/[\d.]+/g) || [0, 0, 0, 0]; return [+m[0], +m[1], +m[2], m[3] === undefined ? 1 : +m[3]]; };
  const over = (top, under) => { const a = top[3]; return [0, 1, 2].map(i => top[i] * a + under[i] * (1 - a)).concat(1); };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const backdrop = (el) => {
    const layers = []; let photo = false;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage !== 'none' && !/gradient/.test(cs.backgroundImage)) photo = true;
      const c = rgba(cs.backgroundColor); if (c[3] > 0) layers.push(c);
      if (c[3] >= 1) break;
    }
    let bg = [10, 15, 20, 1];
    for (const l of layers.reverse()) bg = over(l, bg);
    return { bg, photo };
  };
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('.leaflet-control-attribution, .leaflet-tile-pane, [aria-hidden="true"], script, style, noscript, option')) continue;
    const text = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || el.closest('[hidden]')) continue;
    let op = 1; for (let n = el; n && n.nodeType === 1; n = n.parentElement) op *= +getComputedStyle(n).opacity;
    if (op < 0.05) continue;
    if (el.matches(':disabled') || el.closest(':disabled')) continue;
    let px = parseFloat(cs.fontSize);
    if (el instanceof SVGElement && el.getScreenCTM) { const m = el.getScreenCTM(); if (m) px *= Math.hypot(m.a, m.b); }
    const { bg, photo } = backdrop(el);
    const fg = rgba(cs.color); const drawn = over([fg[0], fg[1], fg[2], fg[3] * op], bg);
    const big = px >= 24 || (px >= 18.66 && +cs.fontWeight >= 700);
    const c = el instanceof SVGElement ? null : ratio(drawn, bg);
    const where = el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/)[0] : '');
    if (px < MIN - 0.01) out.push({ kind: 'size', px: Math.round(px * 10) / 10, where, text: text.slice(0, 40) });
    const hex = (c) => '#' + c.slice(0, 3).map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
    if (c !== null && !photo && c < (big ? 3 : 4.5)) out.push({ kind: 'contrast', ratio: Math.round(c * 100) / 100, where, text: `${hex(drawn)} on ${hex(bg)}  ${text.slice(0, 40)}` });
  }
  return out;
}, MIN_PX);

const PAGES = [
  ['landing', '/index.html'], ['races list', '/app/'], ['race page', `/race.html?id=${SLUG}`],
  ['crew page', `/pit.html?id=${SLUG}`], ['racer screen', `/racer.html?id=${SLUG}&runner=${runner}`],
  ['settings', `/settings.html?id=${SLUG}`], ['setup wizard', '/setup.html'], ['admin', '/admin.html'],
  ['profile', '/profile.html'], ['charts', `/charts.html?id=${SLUG}`],
];
for (const [name, url] of PAGES) {
  await page.goto(BASE + url);
  await page.waitForTimeout(2500);
  // Measured at rest: a blink or a fade caught half way is not how it reads.
  await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });
  const found = await measure();
  const sizes = found.filter(f => f.kind === 'size'), faint = found.filter(f => f.kind === 'contrast');
  if (LIST) for (const f of found) console.log(`    ${name.padEnd(13)} ${f.kind.padEnd(8)} ${String(f.px ?? f.ratio).padEnd(5)} ${f.where.padEnd(26)} ${f.text}`);
  ok(`${name}: nothing drawn under ${MIN_PX}px`, sizes.map(f => `${f.px}px ${f.text}`).slice(0, 5), []);
  ok(`${name}: text stands out from what is behind it`, faint.map(f => `${f.ratio}:1 ${f.text}`).slice(0, 5), []);
}

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
