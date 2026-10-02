// Usernames in a real browser: picking one on the profile page, changing it,
// turning finding off, and adding somebody to a race by theirs.
//
//   node test/username-page.mjs
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
  console.log(`  ${q?'ok  ':'FAIL'} ${l.padEnd(58)} ${JSON.stringify(g)}${q?'':' want '+JSON.stringify(w)}`)};

const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(BASE + '/profile.html');
await page.evaluate(base => {
  localStorage.setItem('race-hub-session-v1', JSON.stringify({ session: 'stub', proxyUrl: base + '/api',
    email: 'crew@example.com', role: 'owner', expiresAt: Date.now() + 7 * 24 * 3600e3 }));
  localStorage.setItem('race-hub-tutorial-v1', JSON.stringify({ pit: 99, racer: 99, settings: 99, profile: 99 }));
}, BASE);
const openProfile = async () => { await page.goto(BASE + '/profile.html'); await page.waitForSelector('#uname:not([hidden])', { timeout: 15000 }); };
const msg = async () => { await page.waitForTimeout(500); return page.textContent('#uname-msg'); };

console.log('\nthe offer');
await openProfile();
ok('the profile asks for a username', (await page.textContent('#uname h2')).trim(), 'Pick a username');
ok('and says it is not for signing in', /Not used to sign in/.test(await page.textContent('#uname')), true);
await page.click('#uname-cancel');
ok('"Not now" folds it to a line', (await page.textContent('#uname')).replace(/\s+/g, ' ').trim(), 'No username yet. Pick one');
await openProfile();
ok('and it stays folded', await page.isVisible('#uname-pick'), true);
await page.click('#uname-pick');
ok('"Pick one" brings it back', await page.isVisible('#uname-input'), true);

console.log('\npicking one');
await page.fill('#uname-input', 'ab');
ok('too short says so as you type', await msg(), 'A username is 3 to 20 characters.');
await page.fill('#uname-input', 'taken');
ok('a taken one says so', await msg(), 'That username is taken.');
await page.click('#uname-save');
await page.waitForTimeout(400);
ok('and saving it is refused, the box still open', [await msg(), await page.isVisible('#uname-input')], ['That username is taken.', true]);
await page.fill('#uname-input', '@Casey');
ok('a free one says so, without the @', await msg(), '@Casey is free.');
ok('and the @ typed into the box is dropped, since one is drawn beside it', await page.inputValue('#uname-input'), 'Casey');
await page.click('#uname-save');
await page.waitForSelector('.p-handle', { timeout: 5000 });
ok('saved, and shown with its @', await page.textContent('.p-handle'), '@Casey');
ok('findable unless you say otherwise', await page.isChecked('#uname-findable'), true);
ok('and changeable once straight away', await page.isVisible('#uname-change'), true);

console.log('\nchanging it');
await page.click('#uname-change');
ok('the box opens with the current one', await page.inputValue('#uname-input'), 'Casey');
ok('and warns about the wait', /again in 30 days/.test(await page.textContent('#uname')), true);
await page.fill('#uname-input', 'casey_k');
await page.click('#uname-save');
await page.waitForSelector('.p-handle', { timeout: 5000 });
ok('changed', await page.textContent('.p-handle'), '@casey_k');
ok('and the next change waits, with the date', [await page.isVisible('#uname-change'), /change it again on/.test(await page.textContent('#uname'))], [false, true]);

console.log('\nnot findable');
await page.click('#uname-findable');
await page.waitForTimeout(400);
ok('turned off, and it says what that means', /Nobody can find you by it/.test(await page.textContent('#uname')), true);
await openProfile();
ok('and stays off', await page.isChecked('#uname-findable'), false);

console.log('\nadding somebody to a race by username');
await page.goto(BASE + `/settings.html?id=${SLUG}`);
await page.waitForSelector('#access .access-head', { timeout: 20000 });
await page.click('#access .access-head');
await page.waitForSelector('#ax-email', { timeout: 10000 });
ok('the box takes an email or a username', await page.getAttribute('#ax-email', 'placeholder'), 'email or @username');
await page.fill('#ax-email', '@jas');
await page.waitForSelector('#ax-suggest:not([hidden]) button', { timeout: 5000 }).catch(() => {});
ok('@ and a few letters offers people', await page.$$eval('#ax-suggest button', els => els.map(e => e.textContent.trim())),
   ['@jasmine_r Jasmine R', '@jasper Jasper Lee']);
ok('with no email address anywhere in them', /@example\.com/.test(await page.textContent('#ax-suggest')), false);
await page.click('[data-pick-user="jasmine_r"]');
ok('picking one fills it in', await page.inputValue('#ax-email'), '@jasmine_r');
await page.click('#ax-invite');
ok('an invite link needs an email, and says so',
   (await page.textContent('#ax-invite-result')).trim(), 'An invite link goes to an email address. To add somebody by username, use Add.');
await page.click('#ax-add-existing');
await page.waitForFunction(() => /Added @jasmine_r/.test(document.querySelector('#ax-invite-result')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
ok('Add puts them on the race', (await page.textContent('#ax-invite-result')).trim().startsWith('Added @jasmine_r as'), true);
ok('and the roster shows their username', /Jasmine R\s*@jasmine_r/.test(await page.textContent('#access .access-list')), true);
await page.fill('#ax-email', '@nobody_here');
await page.click('#ax-add-existing');
await page.waitForTimeout(500);
ok('a username nobody has is refused, saying what to do', /Nobody can be found as @nobody_here/.test(await page.textContent('#ax-invite-result')), true);

ok('no page errors', errs, []);
await b.close(); srv.kill('SIGKILL');
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
