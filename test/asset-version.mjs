// The cache-bust on a lib/ asset has to be a hash of that asset.
//
// Pages load lib/race-core.js?v=<hash>. The service worker caches assets
// cache-first and keys them on the whole URL, so that value is the only thing
// that makes a changed file a different file to a browser that already has
// one. Leave it alone and the phone keeps serving what it has, whatever the
// CDN says.
//
// It used to be a counter, which cannot be derived from anything and so could
// only be remembered. It was forgotten through four commits in a row, and the
// failure is the quiet sort: green deploy, correct CDN, and a profile that
// grew two fields nobody could see. The version is the file's own hash now, so
// there is one source of truth and it is the file.
//
// That leaves exactly one way to get it wrong, which is not running the tool.
// This is what says so.
//
//   node test/asset-version.mjs
import path from 'node:path';
import { survey } from '../tools/stamp-assets.mjs';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const rel = p => path.relative(ROOT, p);

let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p?'ok  ':'FAIL'} ${l.padEnd(52)} ${JSON.stringify(g)}${p?'':' want '+JSON.stringify(w)}`); };

const rows = survey();

// A page can only ask for a file that exists, or the browser gets a 404 for
// the app's own stylesheet and the page renders unstyled.
console.log('\nevery reference points at a file that is there');
const missing = rows.filter(r => r.missing);
for (const r of missing) console.log(`       ${rel(r.page)} asks for ${r.asset}`);
ok('none missing', missing.length, 0);

// The one that matters, and the one that was being got wrong.
console.log('\nand carries that file’s current hash');
const stale = rows.filter(r => r.stale);
for (const r of stale) {
  console.log(`       ${rel(r.page)}: ${r.asset} asks for ${r.has}, is ${r.want}`);
}
if (stale.length) console.log('\n       Run: node tools/stamp-assets.mjs\n');
ok('none stale', stale.length, 0);

// A half-done stamp leaves most of the app current and one page a fortnight
// behind, on a version nobody can name. It cannot happen while the value is
// derived, so this is here to catch a hand-edited one rather than a forgotten
// run, and to fail with the page named rather than as a mystery.
console.log('\nand every page agrees, asset by asset');
const byAsset = new Map();
for (const r of rows) {
  if (!byAsset.has(r.asset)) byAsset.set(r.asset, new Set());
  byAsset.get(r.asset).add(r.has);
}
for (const [asset, versions] of [...byAsset].sort()) {
  ok(asset, versions.size, 1);
}

// If nothing is versioned at all then every assertion above passes vacuously,
// which is the shape of a test that has quietly stopped testing: somebody
// renames the folder, the survey finds nothing, and this file goes green
// forever while every browser serves a stale app.
console.log('\nand there is something here to check');
ok('assets found', byAsset.size > 0, true);
ok('pages found', new Set(rows.map(r => r.page)).size > 0, true);

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
