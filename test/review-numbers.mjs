// Wrong numbers found in review, 2026-11-12, and what they should be.
//
// Each block is one finding: the cutoff a minute early, the pit-only racer in
// a timed race, what a leg-correction file may do, the projection for a racer
// placed by distance, where a racer is when the times are out of order, and
// a handful of smaller ones. The numbers in here are the ones that were wrong.
//
//   node test/review-numbers.mjs
import fs from 'node:fs';
import vm from 'node:vm';

function makeStorage() {
  const proto = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(this, k) ? this[k] : null; },
    setItem(k, v) {
      if (this._failNextSet) { this._failNextSet = false; const e = new Error('quota');
        e.name = 'QuotaExceededError'; throw e; }
      Object.defineProperty(this, k, { value: String(v), enumerable: true, configurable: true, writable: true });
    },
    removeItem(k) { delete this[k]; },
    _failNextSet: false,
  };
  return Object.create(proto);
}

function makeWindow() {
  const el = () => ({ style: { setProperty(){}, removeProperty(){} }, classList: { add(){}, remove(){} },
    setAttribute(){}, appendChild(){}, remove(){}, addEventListener(){},
    getBoundingClientRect: () => ({ height: 0 }), textContent: '', innerHTML: '' });
  const win = {
    localStorage: makeStorage(),
    navigator: { onLine: true },
    location: { protocol: 'https:', hostname: 'sendoff.run', href: 'https://sendoff.run/race.html', search: '' },
    addEventListener(){}, setInterval(){}, setTimeout(){},
    document: {
      createElement: el, getElementById: () => null, querySelector: () => null,
      querySelectorAll: () => [], addEventListener(){}, head: el(), body: el(),
      documentElement: el(), readyState: 'complete',
    },
  };
  win.window = win;
  return win;
}

const src = fs.readFileSync(new URL('../lib/race-core.js', import.meta.url), 'utf8');
const win = makeWindow();
const ctx = vm.createContext(Object.assign(win, {
  console, Date, JSON, Math, Object, Array, String, Number, Boolean, Error, Promise,
  isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent, escape, unescape,
  btoa: s => Buffer.from(s, 'binary').toString('base64'),
  atob: s => Buffer.from(s, 'base64').toString('binary'),
  TextEncoder, TextDecoder, URL, Set, Map, RegExp, Symbol,
}));
ctx.globalThis = ctx;
ctx.localStorage = win.localStorage;
ctx.navigator = win.navigator;
ctx.document = win.document;
ctx.location = win.location;
vm.runInContext(src, ctx);
const Race = ctx.window.Race;

let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p?'ok  ':'FAIL'} ${l.padEnd(60)} ${JSON.stringify(g)}${p?'':' expected '+JSON.stringify(w)}`); };
const C = Race.course;
const H = 3600e3;
const iso = (ms) => new Date(ms).toISOString();

// ---------------------------------------------------------------- cutoffs
// A cutoff is stored as hours from the start. To a hundredth of an hour,
// 6:20 PM after a 5:00 AM start was 13.33, which is 6:19:48 and was shown as
// 6:19. Five of the nine at Rio del Lago read a minute early.
console.log('\ncutoffs, to the minute');
const rdl = { timezone: 'America/Los_Angeles', startTime: '2026-11-07T13:00:00.000Z' };   // 5:00 AM PST
const h = Race.tz.wallToHours(rdl.startTime, '2026-11-07', '18:20', rdl);
ok('6:20 PM goes in as a whole minute', Math.round(h * 60), 800);
ok('and comes back as 6:20', Race.tz.hoursToWall(rdl.startTime, h, rdl).time, '18:20');
ok('every minute of a day survives the round trip', (() => {
  for (let m = 1; m < 1440; m++) {
    const t = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const back = Race.tz.hoursToWall(rdl.startTime, Race.tz.wallToHours(rdl.startTime, '2026-11-08', t, rdl), rdl);
    if (back.time !== t) return t;
  }
  return 'all';
})(), 'all');
// The ones already saved the old way are put back on their minute when the
// config is read, so nobody has to re-save a race to fix it.
const old = Race.safeConfig({ cutoffs: { totalHours: 30, lastLegStartHours: 26.33 }, runners: [],
  course: { segments: [{ name: 'A', arriveCutoffHours: 13.33 }, { name: 'B', arriveCutoffHours: 14.83 }, { name: 'C', arriveCutoffHours: 23.32 }] } });
ok('a saved 13.33 reads as 6:20 PM', Race.tz.hoursToWall(rdl.startTime, old.course.segments[0].arriveCutoffHours, rdl).time, '18:20');
ok('14.83 as 7:50 PM, 23.32 as 4:19 AM', [Race.tz.hoursToWall(rdl.startTime, old.course.segments[1].arriveCutoffHours, rdl).time,
  Race.tz.hoursToWall(rdl.startTime, old.course.segments[2].arriveCutoffHours, rdl).time], ['19:50', '04:19']);
ok('and whole hours are left alone', [old.cutoffs.totalHours, Math.round(old.cutoffs.lastLegStartHours * 60)], [30, 1580]);

// ------------------------------------------------------ pit-only, timed
// A racer who checks in only at the pit, in a timed race. The racer's own leg
// count ends at the leg they are on, so the "end of the lap" stopped at the
// first station: the press at the pit was an arrival at Fence Line.
console.log('\nchecking in only at the pit, in a timed race');
const lapSegs = [{ name: 'Pit to Fence', distanceMi: 2.5, toAid: 'Fence Line (out)', checkpoint: true },
  { name: 'Fence to Fence', distanceMi: 5.5, toAid: 'Fence Line (in)' }, { name: 'Fence to Pit', distanceMi: 2.5, toAid: 'Cedar Brake' }];
const timed = { courseType: 'loops', format: 'timed', startTime: iso(Date.now() - 3 * H), cutoffs: { totalHours: 24 },
  runners: [{ id: 'ann', name: 'Ann', checkIns: 'pit' }], course: { loopCount: 6, loopSegments: lapSegs } };
const ann = { id: 'ann', legs: [{ index: 1, startTime: iso(Date.now() - 2 * H) }] };
ok('the next check-in is the end of the lap', Race.checkIns.stop(timed, ann, 1), 3);
const arr = Race.checkIns.arrival(timed, ann, 1, ann.legs[0].startTime, iso(Date.now()));
ok('and the press writes the whole lap', [arr.to, arr.skips, Object.keys(arr.legs).map(Number)], [3, 2, [1, 2, 3]]);
const lapDone = { id: 'ann', legs: Object.keys(arr.legs).map(k => ({ index: +k, startTime: +k === 1 ? ann.legs[0].startTime : undefined, ...arr.legs[k] })) };
lapDone.legs[1].startTime = lapDone.legs[0].endTime; lapDone.legs[2].startTime = lapDone.legs[1].endTime;
const cAnn = Race.compute.runner(lapDone, timed);
ok('one lap is one lap and 10.5 miles', [cAnn.lapsDone, Math.round(cAnn.milesDone * 10) / 10], [1, 10.5]);

// A timed race is over, and the lap ends at a checkpoint. Going through it
// used to open another lap that nobody was running.
console.log('\nthe lap that ends after the horn');
const horn = { courseType: 'loops', format: 'timed', startTime: iso(Date.now() - 7 * H), cutoffs: { totalHours: 6 },
  runners: [{ id: 'a', name: 'A' }], course: { loopCount: 6, loopSegments: [{ name: 'Lap', distanceMi: 3, toAid: 'Timing mat', checkpoint: true }] } };
ok('does not start another', C.passesThrough(horn, 4, Date.now()), false);
ok('where the same checkpoint, before the horn, did', C.passesThrough(horn, 4, Date.parse(horn.startTime) + 5 * H), true);
ok('and a checkpoint part way round still passes straight through', C.passesThrough(
  { ...timed, startTime: iso(Date.now() - 30 * H) }, 1, Date.now()), true);

// ------------------------------------------------------------ leg fixes
console.log('\na leg-correction file');
const L = Race.legFix;
const seg3 = { timezone: 'America/Los_Angeles', startTime: '2026-10-31T12:00:00.000Z', courseType: 'segments',
  course: { segments: [{ name: 'A', distanceMi: 5, toAid: 'A' }, { name: 'B', distanceMi: 5, toAid: 'B' }, { name: 'C', distanceMi: 5, toAid: 'C' }] } };
ok('a month 13 is not a time', Number.isNaN(L.time('2026-13-45 10:00', seg3)), true);
ok('nor is the 30th of February', Number.isNaN(L.time('2026-02-30 10:00', seg3)), true);
ok('a real one still is', L.time('2026-10-31 10:00', seg3), Date.parse('2026-10-31T17:00:00Z'));
const one = [{ index: 1, startTime: '2026-10-31T12:00:00.000Z', endTime: '2026-10-31T13:00:00.000Z' }];
// A typo in the Leg column: an arrival on the last leg, which nobody started.
const typo = L.apply(one, [{ leg: 3, arrived: Date.parse('2026-10-31T15:00:00Z'), left: null }]);
ok('an arrival on a leg that never started is refused', typo.errors.length, 1);
ok('and says what to do about it', /Left column on leg 2/.test(typo.errors[0]), true);
ok('unless the same file says when they left for it', L.apply(one, [
  { leg: 2, arrived: Date.parse('2026-10-31T14:00:00Z'), left: Date.parse('2026-10-31T14:05:00Z') },
  { leg: 1, arrived: null, left: Date.parse('2026-10-31T13:05:00Z') },
  { leg: 3, arrived: Date.parse('2026-10-31T15:00:00Z'), left: null }]).errors, []);
ok('an arrival before the last leg ended is refused', L.apply(
  [...one, { index: 2, startTime: '2026-10-31T13:05:00.000Z' }],
  [{ leg: 2, arrived: Date.parse('2026-10-31T12:30:00Z'), left: null }]).errors.length > 0, true);
// A missed check-in's estimate is the end of one leg and the start of the next.
const est = [{ index: 1, startTime: '2026-10-31T12:00:00.000Z', endTime: '2026-10-31T13:00:00.000Z', skipped: true },
  { index: 2, startTime: '2026-10-31T13:00:00.000Z', endTime: '2026-10-31T14:00:00.000Z' }];
const fixed = L.apply(est, [{ leg: 1, arrived: Date.parse('2026-10-31T13:10:00Z'), left: null }]);
ok('correcting a skipped arrival moves the next leg\'s start with it',
  [fixed.legs[0].endTime, fixed.legs[0].skipped, fixed.legs[1].startTime],
  ['2026-10-31T13:10:00.000Z', undefined, '2026-10-31T13:10:00.000Z']);
ok('but not when the file says when they left', L.apply(est, [{ leg: 1, arrived: Date.parse('2026-10-31T13:10:00Z'),
  left: Date.parse('2026-10-31T13:20:00Z') }]).legs[1].startTime, '2026-10-31T13:20:00.000Z');
// The hour that happens twice when the clocks go back (1 November 2026).
const first = Date.parse('2026-11-01T08:30:06Z'), second = Date.parse('2026-11-01T09:30:06Z');
ok('the first 1:30 AM is written plainly', L._wall(first, seg3), '2026-11-01 01:30:06');
ok('both read back as the moment they were', [L.time(L._wall(first, seg3), seg3) === first, L.time(L._wall(second, seg3), seg3) === second], [true, true]);
const tpl = L.template(seg3, { id: 'j', legs: [{ index: 1, startTime: iso(second - H), endTime: iso(second) }, { index: 2, startTime: iso(second + 60000) }] });
const back = L.parse(tpl, seg3);
ok('so a template taken on that night changes nothing when put straight back', [back.errors, back.fixes[0].arrived === second, back.fixes[0].left === second + 60000], [[], true, true]);

// ------------------------------------------------------- where they are
// A send-off corrected to a minute before the arrival. By the clock the
// arrival was then the "last" thing, and the card flipped back to In Pit.
console.log('\nwhere a racer is, when the times are out of order');
const seg = { courseType: 'segments', startTime: iso(Date.now() - 6 * H), runners: [{ id: 'a', name: 'A' }],
  course: { segments: [{ name: 'A', distanceMi: 5, toAid: 'Alpha' }, { name: 'B', distanceMi: 5, toAid: 'Bravo' }, { name: 'C', distanceMi: 5, toAid: 'Charlie' }] } };
const odd = { id: 'a', legs: [{ index: 1, startTime: iso(Date.now() - 5 * H), endTime: iso(Date.now() - 3 * H) },
  { index: 2, startTime: iso(Date.now() - 3 * H - 60000) }] };
const next = Race.compute.nextActionFor(odd, seg), cr = Race.compute.runner(odd, seg);
ok('on the way to Bravo, and next to check in there', [next.state, next.nextAction, next.nextLegIndex], ['on-course', 'in', 2]);
ok('which is what the rest of the page says too', [!!cr.inProgressLeg, cr.inPit], [true, false]);

// In an aid station, in a race with no finish cutoff: nothing to project
// against, no leg in progress, and the badge said "Not Started".
console.log('\nsmaller ones');
const inAid = { id: 'a', legs: [{ index: 1, startTime: iso(Date.now() - 5 * H), endTime: iso(Date.now() - 3 * H) }] };
ok('a racer in an aid station has started', Race.compute.runner(inAid, seg).status, 'onpace');
ok('one who has not, has not', Race.compute.runner({ id: 'a', legs: [] }, seg).status, 'notstarted');
// The start of a course of several loops is the pit, by its name.
const pattern = { courseType: 'loops', course: { loopCount: 6, loops: [{ name: 'Long', times: 1, segments: lapSegs }] } };
ok('the start of a course of loops is called by its name', Race.stations.startName(pattern), 'Cedar Brake');
ok('and a plain course still says Start', Race.stations.startName(seg), 'Start');

// ----------------------------------------------------------- projection
// The curved projection, for a racer placed by distance part way round a lap
// whose stations they have not pressed. Every leg from the last check-in was
// counted in full, which put the line up to a lap too far out.
console.log('\nthe projection for a racer part way round a lap');
const flat = { courseType: 'segments', course: { segments: Array.from({ length: 12 }, (_, i) => ({ name: 'L' + (i + 1), distanceMi: 5, toAid: 'S' + (i + 1) })) } };
// Five legs done at an hour each; then placed 12 miles past the last check-in.
const cp = [1, 2, 3, 4, 5].map(i => ({ leg: i, x: i }));
const here = { x: 7.4, y: 37 };
const curve = Race.charts.trendProjection(flat, cp, 0, here, 100);
ok('it starts where they are', [curve[0].x, curve[0].y], [7.4, 37]);
ok('and never goes backwards', curve.every((p, i) => i === 0 || (p.y >= curve[i - 1].y && p.x >= curve[i - 1].x)), true);
const endX = curve[curve.length - 1].x;
// 23 miles left at about an hour per five miles: about 4.6 hours from here.
ok('the finish is the miles left away, not a lap more', endX > 7.4 + 3.4 && endX < 7.4 + 5.8, true);

console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
