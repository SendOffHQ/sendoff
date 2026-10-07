// Talking instead of typing in the racer screen's write-in box. The browser's
// speech engine is faked here: what is being checked is what the page does
// with the words, and that it never offers a button the browser cannot back.
//
//   node test/voice-note.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import net from 'node:net'; import fs from 'node:fs';
const BASE = 'http://localhost:8787';
const SLUG = 'zz-fixture-unlisted';
const PIN = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const listening = () => new Promise(r => { const s = net.connect(8787,'127.0.0.1');
  const d=v=>{s.destroy();r(v)}; s.once('connect',()=>d(true)); s.once('error',()=>d(false)); setTimeout(()=>d(false),500); });
if (await listening()) { console.error('port busy'); process.exit(2); }
const srv = spawn('node', [new URL('./harn' + 'ess.mjs', import.meta.url).pathname], { stdio: 'ignore' });
process.on('exit', () => { try { srv.kill('SIGKILL'); } catch (e) {} });
for (let i=0;i<40 && !(await listening());i++) await new Promise(r=>setTimeout(r,150));

const b = await chromium.launch(fs.existsSync(PIN) ? { executablePath: PIN } : {});
let bad = 0;
const ok=(l,g,w)=>{const q=JSON.stringify(g)===JSON.stringify(w); if(!q)bad++;
  console.log(`  ${q?'ok  ':'FAIL'} ${l.padEnd(58)} ${JSON.stringify(g)}${q?'':' want '+JSON.stringify(w)}`)};
const errs = [];

// A stand-in for the browser's engine: start() hands back the words it is
// told to, in pieces, the way a real one does while somebody is talking.
const FAKE = `
  window.__said = ['half a ham', ' and cheese quesadilla'];
  window.__fail = null;
  class FakeSR {
    start() {
      window.__started = (window.__started || 0) + 1; window.__lang = this.lang;
      setTimeout(() => {
        if (window.__fail) { this.onerror && this.onerror({ error: window.__fail }); this.onend && this.onend(); return; }
        const results = [];
        window.__said.forEach((t, i) => { results.push([{ transcript: t }]); setTimeout(() => this.onresult && this.onresult({ results: results.slice() }), 40 * i); });
        setTimeout(() => this.onend && this.onend(), 40 * window.__said.length + 30);
      }, 30);
    }
    stop() { this.onend && this.onend(); }
  }
  window.SpeechRecognition = FakeSR; window.webkitSpeechRecognition = FakeSR;`;

const open = async (withSpeech) => {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  if (withSpeech) await ctx.addInitScript(FAKE);
  else await ctx.addInitScript('delete window.webkitSpeechRecognition; delete window.SpeechRecognition;');
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push(e.message));
  await page.goto(BASE + '/index.html');
  await page.evaluate(base => {
    localStorage.setItem('race-hub-session-v1', JSON.stringify({ session: 'stub', proxyUrl: base + '/api',
      email: 'crew@example.com', role: 'owner', expiresAt: Date.now() + 7 * 24 * 3600e3 }));
    localStorage.setItem('race-hub-tutorial-v1', JSON.stringify({ racer: 99 }));
  }, BASE);
  // On course, so the write-in box is there.
  await page.evaluate(async (slug) => {
    await fetch('/api/commit', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer stub' },
      body: JSON.stringify({ path: `races/${slug}/data.json`, message: 'legs', content: JSON.stringify({ runners: [{ id: 'jason',
        legs: [{ index: 1, startTime: new Date(Date.now() - 20 * 60e3).toISOString() }] }] }) }) });
  }, SLUG);
  await page.goto(BASE + `/racer.html?id=${SLUG}&runner=jason`);
  await page.waitForSelector('#jot', { state: 'visible', timeout: 20000 });
  return page;
};

console.log('\na phone that can turn speech into words');
let page = await open(true);
ok('has a microphone in the write-in box', await page.isVisible('#jot-mic'), true);
const box = await page.evaluate(() => {
  const i = document.getElementById('jot').getBoundingClientRect(), m = document.getElementById('jot-mic').getBoundingClientRect();
  return m.left >= i.left && m.right <= i.right + 1 && m.top >= i.top - 1 && m.bottom <= i.bottom + 1;
});
ok('inside the box, at its right edge', box, true);
await page.click('#jot-mic');
ok('which shows it is listening', [await page.getAttribute('#jot-mic', 'aria-pressed'), await page.$eval('#jot-mic', el => el.classList.contains('on'))], ['true', true]);
await page.waitForFunction(() => !document.getElementById('jot-mic').classList.contains('on'), null, { timeout: 5000 });
ok('the words land in the box, to be read over', await page.inputValue('#jot'), 'half a ham and cheese quesadilla');
ok('in the language the phone is set to', await page.evaluate(() => window.__lang), 'en-US');
ok('and nothing is logged until Log is pressed', await page.$$eval('#jot-list div', d => d.length), 0);
await page.click('#jot-send');
await page.waitForFunction(() => document.querySelectorAll('#jot-list div').length > 0, null, { timeout: 5000 });
ok('which logs it like anything typed', /: half a ham and cheese quesadilla$/.test(await page.textContent('#jot-list div:last-child')), true);

await page.fill('#jot', 'Coke at Ridge,');
await page.evaluate(() => { window.__said = ['two cups']; });
await page.click('#jot-mic');
await page.waitForFunction(() => !document.getElementById('jot-mic').classList.contains('on'), null, { timeout: 5000 });
ok('talking adds to what was typed', await page.inputValue('#jot'), 'Coke at Ridge, two cups');

await page.fill('#jot', '');
await page.evaluate(() => { window.__said = ['ate two gels and a cup of broth at the river crossing,', ' left shoe rubbing', ' on the outside of the heel']; window.__seen = [];
  const el = document.getElementById('jot'), d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  // After each piece lands, note whether the end of the text is in view.
  Object.defineProperty(el, 'value', { configurable: true, get() { return d.get.call(this); },
    set(v) { d.set.call(this, v); setTimeout(() => window.__seen.push(Math.abs(el.scrollLeft - (el.scrollWidth - el.clientWidth)) <= 1), 0); } });
});
await page.click('#jot-mic');
await page.waitForFunction(() => !document.getElementById('jot-mic').classList.contains('on'), null, { timeout: 5000 });
const scroll = await page.$eval('#jot', el => [el.scrollWidth > el.clientWidth, el.scrollLeft > 0, document.activeElement === el]);
ok('a long one scrolls along so the newest words show', [scroll[0], scroll[1], await page.evaluate(() => window.__seen.every(Boolean) && window.__seen.length >= 3)], [true, true, true]);
ok('without pulling up the keyboard', scroll[2], false);
await page.evaluate(() => { delete document.getElementById('jot').value; });

await page.fill('#jot', '');
await page.evaluate(() => { window.__fail = 'network'; });
await page.click('#jot-mic');
await page.waitForFunction(() => document.getElementById('toast').style.display === 'block', null, { timeout: 5000 });
ok('with no signal, it says to type instead', /needs a signal/.test(await page.textContent('#toast')), true);
ok('and stops listening', await page.$eval('#jot-mic', el => el.classList.contains('on')), false);
await page.context().close();

console.log('\na browser that cannot');
page = await open(false);
ok('offers no microphone', await page.isVisible('#jot-mic'), false);
ok('and the box is as it was', await page.$eval('#jot', el => getComputedStyle(el).paddingRight), '14px');
await page.context().close();

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
