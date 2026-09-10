// Where "the hub" actually is.
//
// The hub was the site root until the app moved under /app/ and the root
// became the marketing page. Every link that meant "back to the hub" went on
// saying index.html, and because every page carries <base href="/"> those
// resolved to /index.html: the Hub link in the nav sent crew to the landing
// page, and so did the redirect after deleting a race.
//
// Nothing caught it because it is not a broken link. It is a working link to
// the wrong page, which no amount of checking for 404s will ever find.
//
//   node test/hub-links.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SKIP = new Set(['node_modules', 'vendor', '.git', 'worker', 'test', 'tools', 'races', 'brand']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(html|js)$/.test(e.name)) out.push(full);
  }
  return out;
}

let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p?'ok  ':'FAIL'} ${l.padEnd(52)} ${JSON.stringify(g)}${p?'':' want '+JSON.stringify(w)}`); };

// A navigation whose target is index.html, relative or via ../, which is the
// shape that used to mean "the hub" and now means the marketing page. The
// service worker's cache fallback is exempt: /index.html there is the last
// resort behind /app/index.html, and the marketing page is the right thing to
// show somebody with no signal and nothing else saved.
const offenders = [];
for (const f of walk(ROOT)) {
  const rel = path.relative(ROOT, f);
  if (rel === 'sw.js') continue;
  const src = fs.readFileSync(f, 'utf8');
  for (const [i, line] of src.split('\n').entries()) {
    if (/^\s*(\/\/|\*)/.test(line)) continue;
    if (/(location(\.href)?\s*=\s*|href=["']|mk\()\s*["']\.{0,2}\/?index\.html["']/.test(line)) {
      offenders.push(`${rel}:${i + 1}`);
    }
  }
}
console.log('\nnothing sends a crew member to the marketing page');
ok('no page navigates to index.html for the hub', offenders, []);

// And the nav really does offer the hub at its new address.
const core = fs.readFileSync(path.join(ROOT, 'lib/race-core.js'), 'utf8');
ok('the nav Hub link points at /app/', /mk\('\/app\/',\s*'\\u2190 Hub'\)/.test(core), true);

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
