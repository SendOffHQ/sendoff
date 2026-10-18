// Loop courses with more than one loop, and timed races.
//
// A race a friend is putting on: a 15-mile out-and-back run six times, then a
// 10-mile one once, so lap 7 lands on 100, and the pattern repeating; and
// scored by time, as far as you get before the clock runs out.
//
//   node test/timed-course.mjs
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

console.log('\nloops in a pattern');
const pattern = { courseType: 'loops', course: { loopCount: 14, loopDistanceMi: 15,
  loops: [{ name: 'Loop A', distanceMi: 15, times: 6 }, { name: 'Loop B', distanceMi: 10, times: 1 }] } };
ok('lap 7 is Loop B and lands on 100', [C.legAt(pattern, 7).name, C.legAt(pattern, 7).distanceMi, C.legAt(pattern, 7).cumulativeMi], ['Lap 7 · Loop B', 10, 100]);
ok('lap 8 starts the pattern again', [C.legAt(pattern, 8).loopName, C.legAt(pattern, 8).cumulativeMi], ['Loop A', 115]);
ok('and 14 laps is 200', C.totalDistanceMi(pattern), 200);
ok('seven laps is 100', C.totalDistanceMi({ ...pattern, course: { ...pattern.course, loopCount: 7 } }), 100);
ok('each lap is one leg', C.legCount(pattern), 14);

console.log('\neach loop with its own aid stations');
const withAid = { courseType: 'loops', course: { loopCount: 7, loops: [
  { name: 'Long', times: 6, segments: [{ fromAid: 'Pit', toAid: 'Turn 7.5', distanceMi: 7.5, checkpoint: true }, { fromAid: 'Turn 7.5', toAid: 'Pit', distanceMi: 7.5, crewAccess: true }] },
  { name: 'Short', times: 1, segments: [{ fromAid: 'Pit', toAid: 'Turn 5', distanceMi: 5 }, { fromAid: 'Turn 5', toAid: 'Pit', distanceMi: 5 }] }] } };
ok('two legs a lap, so 14 legs and 100 miles', [C.legCount(withAid), C.totalDistanceMi(withAid)], [14, 100]);
const l13 = C.legAt(withAid, 13), l14 = C.legAt(withAid, 14), l1 = C.legAt(withAid, 1);
ok('the first leg ends at a checkpoint on the long loop', [l1.name, l1.toAid, l1.checkpoint, l1.lapEnd], ['Lap 1 · Long · Pit → Turn 7.5', 'Turn 7.5', true, false]);
ok('lap 7 turns at 5 and ends on 100', [l13.toAid, l13.cumulativeMi, l14.toAid, l14.cumulativeMi, l14.lapEnd], ['Turn 5', 95, 'Pit', 100, true]);
ok('pages draw it as legs, not a lap grid', C.hasLoopAid(withAid), true);
const half = { id: 'x', legs: [{ index: 1, startTime: '2026-01-01T00:00:00Z', endTime: '2026-01-01T01:00:00Z' }, { index: 2, startTime: '2026-01-01T01:00:00Z', endTime: '2026-01-01T02:00:00Z' }, { index: 3, startTime: '2026-01-01T02:00:00Z', endTime: '2026-01-01T03:00:00Z' }] };
ok('three legs is one lap and a half: one lap done', Race.compute.runner(half, withAid).lapsDone, 1);

console.log('\none loop, as it always was');
const plain = { courseType: 'loops', course: { loopCount: 5, loopDistanceMi: 10, loopElevationGainFt: 300 } };
ok('same lap every time, named as before', [C.legAt(plain, 3).name, C.legAt(plain, 3).cumulativeMi, C.legAt(plain, 3).elevationGainFt, C.totalDistanceMi(plain)],
  ['Lap 3', 30, 300, 50]);
ok('no pattern', C.hasLoopPattern(plain), false);

console.log('\na timed race');
const now = Date.now();
const timed = { courseType: 'loops', format: 'timed', startTime: new Date(now - 5 * H).toISOString(),
  cutoffs: { totalHours: 24 }, course: pattern.course, runners: [{ id: 'sam', name: 'Sam' }] };
const lap = (i, s, e) => ({ index: i, startTime: new Date(now - s * H).toISOString(), ...(e != null ? { endTime: new Date(now - e * H).toISOString() } : {}) });
let sam = { id: 'sam', legs: [lap(1, 5, 2.5), lap(2, 2.4, 0.1)] };
ok('is timed, with no distance to run', [C.isTimed(timed), C.totalDistanceMi(timed)], [true, 0]);
let c = Race.compute.runner(sam, timed);
ok('two laps done and the next one there to run', [c.legsDone, c.totalLegs, c.timed], [2, 3, true]);
ok('racing, not on or off a pace', c.status, 'onpace');
ok('in the pit, with a send-off next', [Race.compute.nextActionFor(sam, timed).state, Race.compute.nextActionFor(sam, timed).nextLegIndex], ['in-pit', 3]);
ok('about 19 hours left', Math.round(c.timeLeftSec / 3600), 19);
// 30 miles in 4.9 hours with the pit: about 6.12 mi an hour for 19.1 more.
ok('projects the distance at the end from the pace so far', Math.round(c.projectedMiles), 147);
ok('and the whole laps that fit: 9 laps is 130, 10 is 145, 11 is 160', c.projectedLaps, 10);
ok('no finish time to project', c.projectedFinishSec, null);

console.log('\nstopped by the crew');
sam = { ...sam, stoppedAt: new Date(now).toISOString() };
c = Race.compute.runner(sam, timed);
ok('done, with what they ran as the result', [c.status, c.totalLegs, c.legsDone, c.milesDone, c.projectedLaps], ['finished', 2, 2, 30, 2]);
ok('nothing more to press', Race.compute.nextActionFor(sam, timed).state, 'finished');
ok('and the race is over for everyone on it', Race.everyRunnerDone(timed, { runners: [sam] }), true);

console.log('\nthe clock runs out');
const over = { ...timed, startTime: new Date(now - 25 * H).toISOString() };
let late = { id: 'sam', legs: [lap(1, 25, 22), lap(2, 21.9, 19), lap(3, 0.5, null)] };
ok('a lap under way at the horn is still running', [Race.compute.nextActionFor(late, over).state, C.runnerDone(over, late)], ['on-course', false]);
late = { id: 'sam', legs: [lap(1, 25, 22), lap(2, 21.9, 19), lap(3, 0.5, 0.05)] };
ok('and counts once it is in, then they are done', [Race.compute.nextActionFor(late, over).state, Race.compute.runner(late, over).legsDone], ['finished', 3]);

console.log('\nthe stop is written like any press');
// Replayed through the queue, the way a stop pressed with no signal lands.
const QK = 'sendoff-queue-v1';  // QUEUE_KEY in lib/race-core.js
const replay = (entries) => { win.localStorage.setItem(QK, JSON.stringify(entries));
  return Race.queue.applyTo('races/x/data.json', { runners: [{ id: 'sam', legs: [] }] }).runners[0]; };
ok('stopping sets the time on the runner', replay([{ path: 'races/x/data.json', op: 'setRunnerStopped', args: { runnerId: 'sam', stoppedAt: '2026-10-14T20:00:00Z' } }]).stoppedAt, '2026-10-14T20:00:00Z');
ok('and taking it back clears it', 'stoppedAt' in replay([
  { path: 'races/x/data.json', op: 'setRunnerStopped', args: { runnerId: 'sam', stoppedAt: '2026-10-14T20:00:00Z' } },
  { path: 'races/x/data.json', op: 'setRunnerStopped', args: { runnerId: 'sam', stoppedAt: null } }]), false);

// Left the turnaround the moment they reached it: the next leg starts at the
// very millisecond the last one ended. That is out on the course, and only
// the course clock runs. Reported from the Ghost Train, where the pit total
// said "in pit now" and ticked beside the course total for a whole leg.
console.log('\nstraight through a turnaround');
const through = { courseType: 'loops', format: 'timed', startTime: new Date(now - 3 * H).toISOString(),
  cutoffs: { totalHours: 30 }, course: withAid.course, runners: [{ id: 'joe', name: 'Joe' }] };
const turnAt = new Date(now - 1.5 * H).toISOString();
const joe = { id: 'joe', legs: [{ index: 1, startTime: new Date(now - 3 * H).toISOString(), endTime: turnAt }, { index: 2, startTime: turnAt }] };
const jc = Race.compute.runner(joe, through);
ok('on the course, not in the pit', [jc.inProgressLeg, jc.inPit], [true, false]);
ok('with no pit time running', Math.round(jc.totalPitSec), 0);
const jp = Race.compute.runner({ id: 'joe', legs: [joe.legs[0]] }, through);
ok('and in the pit before they have left it', jp.inPit, true);

// A checkpoint is a timing point, gone straight through: not a stop. The
// aid station chart drew one at every turnaround, a 0 each lap, and the card's
// average pit time counted them too. Reported from the Ghost Train.
console.log('\nstops, not checkpoints');
const T = (h) => new Date(now - h * H).toISOString();
const lapper = { id: 'joe', legs: [
  { index: 1, startTime: T(3), endTime: T(2.5) },            // to the turnaround, a checkpoint
  { index: 2, startTime: T(2.5), endTime: T(2) },            // straight back out, to the pit
  { index: 3, startTime: T(2 - 0.1), endTime: T(1.5) },      // six minutes in the pit
  { index: 4, startTime: T(1.5) }] };                        // through the turnaround again
ok('the chart has the pit stop and not the turnarounds', Race.charts.pitStops(lapper, through).map(p => [p.x, Math.round(p.y)]), [[2, 6]]);
const lc = Race.compute.runner(lapper, through);
ok('the average stop is the stop, not the stop and two nothings', [Math.round(lc.avgPitSec), Math.round(lc.lastPitSec)], [360, 360]);
ok('and the pit total is the same either way', Math.round(lc.totalPitSec), 360);
// Ticks on whole legs, so no leg number is printed twice.
const ticks = (lo, hi) => { const a = Race.charts.legAxis(lo, hi);
  return Array.from({ length: a.xTicks + 1 }, (_, i) => a.xMin + i * (a.xMax - a.xMin) / a.xTicks); };
ok('nine legs tick every leg', ticks(1, 9), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
ok('thirty legs every few, never a half', ticks(1, 30).every(Number.isInteger) && ticks(1, 30).length <= 11 && ticks(1, 30).pop() >= 30, true);

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
