// The cache-bust on lib/ assets has to move when the asset does.
//
// Pages load them as lib/race-core.js?v=97. The service worker caches assets
// cache-first and keys them on the whole URL, so the ?v= is the only thing
// that makes a changed file a different file: bump it and every device misses
// and refetches, leave it and they keep serving what they already have.
//
// Which is a fine design and an easy one to forget. It was forgotten four
// times in one sitting: race-core.js changed in four commits and the version
// sat still through all of them, so the profile grew two fields that nobody
// could see. The site was right, the deploy was right, the file on the CDN was
// right, and the browser had a copy from last week.
//
// So the hashes are written down. Change an asset and this fails, naming the
// file and printing the line to paste back, which turns a silent staleness
// into a loud and specific instruction.
//
//   node test/asset-version.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

// Updated in the same commit as the asset, which is the whole point: the two
// cannot drift, because the test fails until they agree.
const EXPECTED = {
  'lib/race-core.js':    '5cea7e3297f0bff9',
  'lib/race-theme.css':  '90547f83612e2370',
  'lib/finish-card.js':  '81ff34caa2c6eba5',
};

let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p?'ok  ':'FAIL'} ${l.padEnd(52)} ${JSON.stringify(g)}${p?'':' want '+JSON.stringify(w)}`); };

const pages = fs.readdirSync(ROOT).filter(f => f.endsWith('.html'))
  .concat(fs.existsSync(path.join(ROOT, 'app'))
    ? fs.readdirSync(path.join(ROOT, 'app')).filter(f => f.endsWith('.html')).map(f => 'app/' + f) : [])
  .concat(fs.existsSync(path.join(ROOT, 'admin'))
    ? fs.readdirSync(path.join(ROOT, 'admin')).filter(f => f.endsWith('.html')).map(f => 'admin/' + f) : []);

// asset file name -> every ?v= value any page asks for
const asked = new Map();
for (const page of pages) {
  const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
  for (const m of html.matchAll(/\/?((?:lib\/)?[\w.-]+\.(?:js|css))\?v=(\d+)/g)) {
    const file = m[1].startsWith('lib/') ? m[1] : 'lib/' + m[1];
    if (!asked.has(file)) asked.set(file, new Map());
    const where = asked.get(file);
    if (!where.has(m[2])) where.set(m[2], []);
    where.get(m[2]).push(page);
  }
}

// A half-done bump is its own bug and looks like nothing: most of the app is
// new and one page is a fortnight behind, on a version nobody can name.
console.log('\nevery page agrees on one version per asset');
for (const [file, versions] of [...asked].sort()) {
  const list = [...versions.keys()];
  if (list.length !== 1) {
    console.log(`       ${file} is asked for at ${list.join(', ')}:`);
    for (const [v, where] of versions) console.log(`         v=${v}  ${where.join(', ')}`);
  }
  ok(file, list.length, 1);
}

console.log('\nand the version moved when the asset did');
for (const [file, want] of Object.entries(EXPECTED)) {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) { ok(`${file} exists`, false, true); continue; }
  const got = createHash('sha256').update(fs.readFileSync(full)).digest('hex').slice(0, 16);
  if (got !== want) {
    const name = path.basename(file);
    const cur = [...(asked.get(file) || new Map()).keys()][0];
    console.log(`\n  ${file} has changed.`);
    console.log(`  Bump ${name}?v=${cur || '?'} to ${cur ? +cur + 1 : '?'} in every page that loads it,`);
    console.log(`  then put this back in test/asset-version.mjs:`);
    console.log(`      '${file}': '${got}',\n`);
  }
  ok(`${file} is the version pages ask for`, got, want);
}

// Every asset carrying a ?v= has to be listed above, or a new one could be
// added and changed forever without this noticing.
console.log('\nand nothing versioned is unwatched');
for (const file of [...asked.keys()].sort()) {
  ok(`${file} is accounted for`, Object.prototype.hasOwnProperty.call(EXPECTED, file), true);
}

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
