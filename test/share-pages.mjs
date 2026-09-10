// Every public race needs a share page, and nothing checked.
//
// tools/make-og.py builds races/<slug>/index.html and og.png: a real page per
// race carrying that race's social tags and its own preview card. It is run by
// hand, and on 2026-09-09 Sangre de Cristo 100 was found without one, two
// weeks after it was created. Anybody who shared that link, in Discord or a
// text, got the generic SendOff image for the race the whole app exists for.
//
// Forgetting is the failure mode, so this makes forgetting loud. It is a file
// check, no browser and no network, so it costs nothing to run every time.
//
//   node test/share-pages.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'races/index.json'), 'utf8'));

let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p ? 'ok  ' : 'FAIL'} ${l.padEnd(56)} ${JSON.stringify(g)}${p ? '' : ' expected ' + JSON.stringify(w)}`); };

console.log('\nevery public race can be shared with its own card');
const missing = [];
for (const r of manifest.races || []) {
  const dir = path.join(ROOT, 'races', r.slug);
  const has = fs.existsSync(path.join(dir, 'index.html')) && fs.existsSync(path.join(dir, 'og.png'));
  if (!has) missing.push(r.slug);
}
ok('none are missing a share page', missing, []);
if (missing.length) console.log('\n  Run: python3 tools/make-og.py\n');

// The other half, and the one that would be a leak rather than an oversight:
// a share page for an unlisted race would publish an address whose secrecy is
// the only thing protecting it. make-og.py reads the manifest, which unlisted
// races are never in, so this cannot happen by construction. Held anyway,
// because "cannot happen by construction" is a thing that stops being true.
console.log('\nand no unlisted race has one');
const listed = new Set((manifest.races || []).map(r => r.slug));
const leaked = [];
for (const slug of fs.readdirSync(path.join(ROOT, 'races'))) {
  const dir = path.join(ROOT, 'races', slug);
  if (!fs.statSync(dir).isDirectory() || listed.has(slug)) continue;
  if (fs.existsSync(path.join(dir, 'index.html'))) leaked.push(slug);
}
ok('nothing unlisted has a public share page', leaked, []);

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
