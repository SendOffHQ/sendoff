// The finish projection on the cumulative chart follows the trend in the
// racer's pace (2026-11-07, asked for during Rio del Lago): slowing down
// projects a later finish than a straight line at the pace so far, picking
// it up an earlier one, and a climb still to come costs time.
//
//   node test/projection-trend.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
const PIN = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const b = await chromium.launch(fs.existsSync(PIN) ? { executablePath: PIN } : {});
const page = await b.newPage();
await page.setContent('<script>' + fs.readFileSync(new URL('../lib/race-core.js', import.meta.url), 'utf8') + '</scr' + 'ipt>');
let bad = 0;
const ok = (l, g, w) => { const q = JSON.stringify(g) === JSON.stringify(w); if (!q) bad++;
  console.log(`  ${q ? 'ok  ' : 'FAIL'} ${l.padEnd(58)} ${JSON.stringify(g)}${q ? '' : ' want ' + JSON.stringify(w)}`); };

// Ten flat legs of 10 miles. Four done, the fifth just started.
const run = (hours, gains) => page.evaluate(([hours, gains]) => {
  const cfg = { courseType: 'segments', course: { segments: Array.from({ length: 10 }, (_, i) => ({ fromAid: 'A' + i, toAid: 'A' + (i + 1), distanceMi: 10, elevationGainFt: (gains || [])[i] || 0 })) } };
  let x = 0;
  const cp = hours.map((h, i) => { x += h; return { x, y: (i + 1) * 10, leg: i + 1 }; });
  const here = { x, y: cp.length * 10 };
  const curve = Race.charts.trendProjection(cfg, cp, 0, here, 200);
  return curve && +curve[curve.length - 1].x.toFixed(2);
}, [hours, gains]);

console.log('\nthe finish it projects');
const steady = await run([2, 2, 2, 2]);
ok('a steady pace: 6 more legs at 2 hours, so hour 20', steady, 20);
const slowing = await run([2, 2.2, 2.4, 2.6]);
ok('slowing down: later than the 2.3h average would say (hour 22.6)', slowing > 22.6, true);
const faster = await run([2.6, 2.4, 2.2, 2]);
ok('picking it up: earlier than the average would say', faster < 22.6, true);
ok('but never quicker than three quarters of the pace now', faster >= 9.2 + 6 * 2 * 0.75 - 0.01, true);
const climb = await run([2, 2, 2, 2], [0, 0, 0, 0, 0, 0, 3000, 0, 0, 0]);
ok('a 3,000 ft climb still to come costs about 0.6h more', climb, 20.6);
ok('too few legs to read a trend: none, and the straight line is drawn', await run([2, 2]), null);

await b.close();
console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
