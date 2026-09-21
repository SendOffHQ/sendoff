// Renders the two announce images from announce.html.
//
// Separate from shoot.js because that one walks a fixed six-slide carousel and
// its story variants; this is a pair that gets posted on its own. The font
// check is the same and is not optional: see the note in README.md about the
// first build shipping twelve images in a system fallback.
const { chromium } = require('playwright');
const path = require('path');
const OUT = process.env.OUT || __dirname;
const SRC = process.env.SRC || path.join(__dirname, 'announce.html');
(async () => {
  const exe = process.env.CHROMIUM || undefined;
  const b = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await b.newContext({ viewport: { width: 1200, height: 1400 }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log('PAGEERROR:', e.message));
  await p.goto('file://' + SRC, { waitUntil: 'networkidle' });
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(500);

  // document.fonts.check() answers true when nothing needs loading, which
  // includes a silent fallback. The honest test is that the faces are in the
  // document and loaded.
  const faces = await p.evaluate(() =>
    Array.from(document.fonts).map(f => `${f.family} ${f.weight} ${f.status}`));
  const want = ['Barlow Condensed', 'JetBrains Mono', 'IBM Plex Sans'];
  const missing = want.filter(w => !faces.some(f => f.startsWith(w) && f.endsWith('loaded')));
  if (missing.length) {
    console.error('FONTS NOT LOADED:', missing.join(', '), '| present:', JSON.stringify(faces));
    process.exit(1);
  }
  console.log('fonts loaded:', faces.length, 'faces');

  for (const [id, name] of [['a1', 'sendoff-announce-logo'], ['a2', 'sendoff-announce-card']]) {
    const el = await p.$('#' + id);
    await el.screenshot({ path: `${OUT}/${name}.png` });
    const box = await el.boundingBox();
    if (Math.round(box.width) !== 1080 || Math.round(box.height) !== 1350) {
      console.error('WRONG SIZE', name, JSON.stringify(box));
      process.exit(1);
    }
    console.log(name, '1080x1350');
  }
  await b.close();
})();
