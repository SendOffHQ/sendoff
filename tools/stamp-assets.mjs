// Stamps every lib/ asset reference with a hash of what that file now holds.
//
//   node tools/stamp-assets.mjs          rewrite the pages
//   node tools/stamp-assets.mjs --check  say what is stale and exit 1
//
// Why this exists. Pages load lib/race-core.js?v=<something>, and the service
// worker caches assets cache-first keyed on the whole URL, so that value is
// the only thing that makes a changed file a different file to a browser that
// already has one. It used to be a number somebody remembered to increase. It
// was forgotten through four commits in a row, and the way that fails is the
// worst kind: the deploy is green, the CDN is right, and a phone quietly
// serves last week's JavaScript.
//
// A counter cannot be derived from anything, so it can only be remembered. A
// hash of the file can, so there is now one source of truth and it is the file
// itself. Run this and the references are right by construction; forget to run
// it and test/asset-version.mjs says so by name.
//
// Eight hex characters. Enough that two versions of one file colliding is not
// a thing to plan around, short enough to read in a page source.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const HASH_LEN = 8;

// Matches a reference and captures the path as written, so it can be put back
// exactly as it was with only the version changed. Any leading ../ or / is
// kept: pages sit at three different depths and rewriting that would break
// them. The extension is required, which is what keeps this off the prose in
// brand/index.html that talks about "?v=" without naming a file.
const REF = /((?:\.\.\/|\/)?lib\/[\w.-]+\.(?:js|css))\?v=[\w.-]+/g;

export function hashOf(assetPath) {
  return createHash('sha256').update(fs.readFileSync(assetPath)).digest('hex').slice(0, HASH_LEN);
}

// Every .html in the repo, wherever it sits. Walked rather than listed: a page
// added in a new folder should be stamped without anybody remembering to add
// it here, which is the same mistake this file exists to stop.
export function htmlFiles(dir = ROOT, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) htmlFiles(full, out);
    else if (entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

// What every page asks for, and what it should be asking for.
export function survey() {
  const cache = new Map();
  const rows = [];
  for (const page of htmlFiles()) {
    const html = fs.readFileSync(page, 'utf8');
    for (const m of html.matchAll(REF)) {
      const asset = 'lib/' + path.basename(m[1]);
      const full = path.join(ROOT, asset);
      if (!fs.existsSync(full)) {
        rows.push({ page, asset, ref: m[0], missing: true });
        continue;
      }
      if (!cache.has(asset)) cache.set(asset, hashOf(full));
      const want = cache.get(asset);
      const has = m[0].slice(m[0].indexOf('?v=') + 3);
      rows.push({ page, asset, ref: m[0], has, want, stale: has !== want });
    }
  }
  return rows;
}

function stamp() {
  let changed = 0, pages = 0;
  const cache = new Map();
  for (const page of htmlFiles()) {
    const before = fs.readFileSync(page, 'utf8');
    let hits = 0;
    const after = before.replace(REF, (whole, ref) => {
      const asset = 'lib/' + path.basename(ref);
      const full = path.join(ROOT, asset);
      if (!fs.existsSync(full)) {
        console.warn(`  ! ${path.relative(ROOT, page)} asks for ${asset}, which is not there`);
        return whole;
      }
      if (!cache.has(asset)) cache.set(asset, hashOf(full));
      const next = `${ref}?v=${cache.get(asset)}`;
      if (next !== whole) hits++;
      return next;
    });
    if (after !== before) { fs.writeFileSync(page, after); pages++; changed += hits; }
  }
  for (const [asset, h] of [...cache].sort()) console.log(`  ${asset.padEnd(24)} ${h}`);
  console.log(changed ? `\nstamped ${changed} reference(s) across ${pages} page(s)\n`
                      : '\nalready current\n');
}

if (process.argv.includes('--check')) {
  const stale = survey().filter(r => r.stale || r.missing);
  for (const r of stale) {
    console.error(r.missing
      ? `${path.relative(ROOT, r.page)}: ${r.asset} does not exist`
      : `${path.relative(ROOT, r.page)}: ${r.asset} asks for ${r.has}, should be ${r.want}`);
  }
  if (stale.length) { console.error('\nRun: node tools/stamp-assets.mjs\n'); process.exit(1); }
  console.log('every reference is current');
} else if (import.meta.url === `file://${process.argv[1]}`) {
  stamp();
}
