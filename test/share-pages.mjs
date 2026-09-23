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
// races are never in, so it never builds one for an unlisted race. What it
// does not do is take one down, and a race can be unlisted long after its page
// was built: that is what the settings page does now, and the worker deletes
// both files when it does. This is the check that says whether that worked.
console.log('\nand no unlisted race has one');
const listed = new Set((manifest.races || []).map(r => r.slug));
const leaked = [];
for (const slug of fs.readdirSync(path.join(ROOT, 'races'))) {
  const dir = path.join(ROOT, 'races', slug);
  if (!fs.statSync(dir).isDirectory() || listed.has(slug)) continue;
  if (fs.existsSync(path.join(dir, 'index.html'))) leaked.push(slug);
}
ok('nothing unlisted has a public share page', leaked, []);

// The worker writes this page too, when somebody puts a race back on the hub
// from the settings page: the hub links to /races/<slug>/ and a listed race
// without one is a card that 404s. So the template exists twice, once in
// Python here and once in JavaScript there, which is a thing that drifts. A
// tag added to one and not the other is a preview card that is right on races
// built by the tool and wrong on races listed from the app, and nothing would
// say so. This says so.
console.log('\nand the two copies of that page still agree');
const pyStub = fs.readFileSync(path.join(ROOT, 'tools/make-og.py'), 'utf8')
  .match(/^STUB = r?"""([\s\S]*?)"""$/m);
const jsStub = fs.readFileSync(path.join(ROOT, 'worker/src/worker.js'), 'utf8')
  .match(/return `(<!DOCTYPE html>[\s\S]*?)`;\n}/);
ok('both templates are where this expects them', [!!pyStub, !!jsStub], [true, true]);

// Placeholders blanked and the head compared tag by tag. Python doubles its
// braces to escape them and JavaScript does not, and each names its holes its
// own way; neither difference is drift.
const tags = (src, holes) => {
  let t = src.replace(/\{\{/g, '{').replace(/\}\}/g, '}').replace(holes, '@');
  return (t.match(/<(?:meta|link|title)\b[^>]*>/g) || [])
    .map(x => x.replace(/\s+/g, ' ').trim()).sort();
};
if (pyStub && jsStub) {
  const py = tags(pyStub[1], /\{(slug|title|desc|base)\}/g);
  const js = tags(jsStub[1].replace(/\\u00b7/g, '\u00b7'), /\$\{(slug|title|desc|base)\}/g);
  const onlyPy = py.filter(x => !js.includes(x));
  const onlyJs = js.filter(x => !py.includes(x));
  ok('the tool has nothing the worker is missing', onlyPy, []);
  ok('and the worker has nothing the tool is missing', onlyJs, []);
  ok('and there is something here to compare', py.length > 10, true);
}

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
