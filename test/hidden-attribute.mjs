// The `hidden` attribute loses to an author `display:` rule.
//
// `hidden` works by a user-agent rule of `display: none`, which any author rule
// setting `display` outranks. So an element styled `display: flex` and hidden
// in script stays on screen, and the code that hid it carries on believing it
// did. In this codebase that has happened three times: the account menu and the
// connection form are guarded in CSS, and the fueling picker was not, so a race
// with one racer showed a "Plan for" label above an empty dropdown. The code was
// right and the stylesheet quietly disagreed with it.
//
// Nothing catches this by loading a page, because the page works: it just shows
// something it meant to hide.
//
//   node test/hidden-attribute.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SKIP = new Set(['node_modules', 'vendor', '.git', 'worker', 'test', 'tools', 'races', 'dist']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(html|css)$/.test(e.name)) out.push(full);
  }
  return out;
}

const files = walk(ROOT);
// Every stylesheet in the project, as one haystack: a page's own <style> and
// the shared theme both count, and either can carry the guard.
const allCss = files.map(f => fs.readFileSync(f, 'utf8')).join('\n');

// Classes on an element that is hidden in the markup. That is the shape used
// here: the element ships hidden and script decides when to show it.
const hiddenClasses = new Set();
for (const f of files.filter(f => f.endsWith('.html'))) {
  const src = fs.readFileSync(f, 'utf8');
  // The attribute itself, not aria-hidden. \b matches at the hyphen, so the
  // first version of this flagged a monogram that is controlled by a parent
  // class and never touches the attribute at all.
  for (const tag of src.match(/<[a-z][^>]*\shidden(?=[\s>]|="")[^>]*>/gi) || []) {
    const cls = /class="([^"]*)"/.exec(tag);
    if (!cls) continue;
    for (const c of cls[1].split(/\s+/).filter(Boolean)) hiddenClasses.add(c);
  }
}

// A class whose rule sets `display`, anywhere, with no [hidden] rule to match.
const unguarded = [];
for (const c of [...hiddenClasses].sort()) {
  const rule = new RegExp(`\\.${c.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*\\{([^}]*)\\}`, 'g');
  let setsDisplay = false;
  let m;
  while ((m = rule.exec(allCss))) if (/(^|[;\s])display\s*:/.test(m[1])) setsDisplay = true;
  if (!setsDisplay) continue;
  const guard = new RegExp(`\\.${c.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\[hidden\\]`);
  if (!guard.test(allCss)) unguarded.push(c);
}

let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p?'ok  ':'FAIL'} ${l.padEnd(52)} ${JSON.stringify(g)}${p?'':' want '+JSON.stringify(w)}`); };

console.log('\nnothing hidden is left on screen by its own stylesheet');
console.log(`     ${hiddenClasses.size} classes ship hidden; checking the ones that set display`);
ok('every one of those has a [hidden] rule', unguarded, []);

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
