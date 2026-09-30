// Renders the feature posts from features.html, one PNG per slide.
//
// Every <section class="slide" id="..."> becomes sendoff-feature-<id>.png, so a
// new feature is a new section and nothing here changes. Run capture-race.mjs
// first if a phone screen needs refreshing. The font check is the same as the
// other two scripts and is not optional: see the note in README.md.
const { chromium } = require('playwright');
const path = require('path');
const OUT = process.env.OUT || __dirname;
const SRC = process.env.SRC || path.join(__dirname, 'features.html');
(async () => {
  const exe = process.env.CHROMIUM || undefined;
  const b = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await b.newContext({ viewport: { width: 1200, height: 1400 }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log('PAGEERROR:', e.message));
  await p.goto('file://' + SRC, { waitUntil: 'networkidle' });
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(500);

  const faces = await p.evaluate(() =>
    Array.from(document.fonts).map(f => `${f.family} ${f.weight} ${f.status}`));
  const want = ['Barlow Condensed', 'JetBrains Mono', 'IBM Plex Sans'];
  const missing = want.filter(w => !faces.some(f => f.startsWith(w) && f.endsWith('loaded')));
  if (missing.length) {
    console.error('FONTS NOT LOADED:', missing.join(', '), '| present:', JSON.stringify(faces));
    process.exit(1);
  }
  // A phone screen that failed to load renders as an empty frame, which looks
  // almost right at a glance. Refuse it.
  const broken = await p.evaluate(() => Array.from(document.images)
    .filter(i => !i.complete || i.naturalWidth === 0).map(i => i.getAttribute('src')));
  if (broken.length) { console.error('IMAGES NOT LOADED:', broken.join(', ')); process.exit(1); }

  // Text that runs into the device is the mistake that is easiest to miss at
  // full size and most obvious in the grid. Measure it rather than eyeball it.
  const clashes = await p.$$eval('section.slide[id]', slides => slides.flatMap(s => {
    const dev = s.querySelector('.phone, .tablet, .thread');
    if (!dev) return [];
    const d = dev.getBoundingClientRect();
    return [...s.querySelectorAll('.top h1, .top p, .top .chip')].flatMap(el => {
      const r = document.createRange(); r.selectNodeContents(el);
      return [...r.getClientRects()].filter(b => b.width > 0 &&
        b.right > d.left - 12 && b.left < d.right && b.bottom > d.top - 12 && b.top < d.bottom)
        .map(() => `${s.id}: "${el.textContent.trim().slice(0, 30)}"`);
    });
  }));
  if (clashes.length) { console.error('TEXT RUNS INTO THE DEVICE:\n  ' + [...new Set(clashes)].join('\n  ')); process.exit(1); }

  const only = process.argv[2];
  for (const id of await p.$$eval('section.slide[id]', s => s.map(x => x.id))) {
    if (only && only !== id) continue;
    const el = await p.$('#' + id);
    const name = 'sendoff-feature-' + id;
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
