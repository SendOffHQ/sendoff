// Renders the full lockup to PNG, on a transparent background, for anywhere
// that will not take an SVG: a flyer, a sponsor deck, a race director's
// newsletter. The brand page offered only square icons as PNG, so somebody
// asking for "the logo" had nothing to be handed.
//
// Drawn from the two source SVGs rather than redrawn, so a change to the
// artwork is one edit and a rerun. The SVGs carry their own clear space in the
// viewBox, and so do these.
//
//   node tools/make-logo-pngs.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const BRAND = ROOT + '/brand';
const PINNED = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const CHROME = fs.existsSync(PINNED) ? PINNED : undefined;

// Which ground each file is for, not what is behind it: both are transparent.
// Cream letters vanish on white and near-black ones vanish on black, so the
// name says where it can go.
const SOURCES = [
  { svg: 'sendoffprimaryonDark.svg',  name: 'sendoff-logo-dark-bg' },
  { svg: 'sendoffprimaryonLight.svg', name: 'sendoff-logo-light-bg' }
];
const WIDTHS = [400, 800, 1600];

const b = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const out = [];
for (const src of SOURCES) {
  const text = fs.readFileSync(`${BRAND}/${src.svg}`, 'utf8');
  const vb = /viewBox="([-\d.\s]+)"/.exec(text)[1].trim().split(/\s+/).map(Number);
  const ratio = vb[3] / vb[2];
  const dataUrl = 'data:image/svg+xml;base64,' + Buffer.from(text).toString('base64');
  for (const w of WIDTHS) {
    const h = Math.round(w * ratio);
    const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.setContent(
      `<html><body style="margin:0;background:transparent">` +
      `<img src="${dataUrl}" style="display:block;width:${w}px;height:${h}px"></body></html>`);
    await page.waitForFunction(() => document.images[0].complete && document.images[0].naturalWidth > 0);
    const file = `${src.name}-${w}.png`;
    await page.screenshot({ path: `${BRAND}/${file}`, omitBackground: true, clip: { x: 0, y: 0, width: w, height: h } });
    await ctx.close();
    out.push(`${file}  ${w}x${h}`);
  }
}
await b.close();
console.log(out.join('\n'));
