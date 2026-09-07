const { chromium } = require('playwright');
const path = require('path');
const OUT = process.env.OUT || __dirname;
const SRC = process.env.SRC || path.join(__dirname, 'ig.html');
(async () => {
  // Fall back to whatever Playwright finds when CHROMIUM is not pointed at a
  // binary, so this is not welded to one machine's layout.
  const exe = process.env.CHROMIUM || undefined;
  const b = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await b.newContext({ viewport:{width:3400,height:1500}, deviceScaleFactor:1 });
  const p = await ctx.newPage();
  p.on('pageerror', e=>console.log('PAGEERROR:', e.message));
  await p.goto('file://' + SRC, { waitUntil:'networkidle' });
  // Fonts must be in before anything is captured.
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(500);

  // document.fonts.check() answers true when nothing needs loading, so it says
  // yes to a system fallback too. The only honest test is that the faces are
  // actually in the document and loaded.
  const faces = await p.evaluate(() =>
    Array.from(document.fonts).map(f => `${f.family} ${f.weight} ${f.status}`));
  const want = ['Barlow Condensed', 'JetBrains Mono', 'IBM Plex Sans'];
  const missing = want.filter(w => !faces.some(f => f.startsWith(w) && f.endsWith('loaded')));
  if (missing.length) {
    console.error('FONTS NOT LOADED:', missing.join(', '), '| present:', JSON.stringify(faces));
    process.exit(1);
  }
  console.log('fonts loaded:', faces.length, 'faces');

  for (let i = 1; i <= 6; i++) {
    const el = await p.$('#s' + i);
    await el.screenshot({ path: `${OUT}/sendoff-ig-${String(i).padStart(2,'0')}.png` });
  }
  for (let i = 1; i <= 6; i++) {
    const el = await p.$('#st' + i);
    await el.screenshot({ path: `${OUT}/sendoff-story-${String(i).padStart(2,'0')}.png` });
    const box = await el.boundingBox();
    if (Math.round(box.width) !== 1080 || Math.round(box.height) !== 1920) {
      console.log('WRONG SIZE story', i, JSON.stringify(box));
    }
  }
  const strip = await p.$('#strip');
  await strip.screenshot({ path: `${OUT}/_strip.png` });
  const box = await strip.boundingBox();
  console.log('strip box:', JSON.stringify(box));
  console.log('slides written');
  await b.close();
})();
