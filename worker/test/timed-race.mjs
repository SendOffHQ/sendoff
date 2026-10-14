// The worker reads a loop course the way lib/race-core.js does: loops in a
// repeating pattern, and timed races with no set number of laps. Two copies of
// one model drift, so this holds the worker's against the page's, and checks
// what the worker does with a timed race: when it is finished, and what a
// finish says.
//
//   node worker/test/timed-race.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import * as crew from '../src/ai-crew.js';

// The page's model, loaded the way test/offline-fallback.mjs loads it.
const store = Object.create({ getItem(k) { return this[k] ?? null; }, setItem(k, v) { this[k] = String(v); }, removeItem(k) { delete this[k]; } });
const el = () => ({ style: { setProperty(){}, removeProperty(){} }, classList: { add(){}, remove(){} },
  setAttribute(){}, appendChild(){}, remove(){}, addEventListener(){}, getBoundingClientRect: () => ({ height: 0 }) });
const win = { localStorage: store, navigator: { onLine: true },
  location: { protocol: 'https:', hostname: 'sendoff.run', href: 'https://sendoff.run/', search: '' },
  addEventListener(){}, setInterval(){}, setTimeout(){},
  document: { createElement: el, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener(){}, head: el(), body: el(), documentElement: el(), readyState: 'complete' } };
win.window = win;
const ctx = vm.createContext(Object.assign(win, { console, Date, JSON, Math, Object, Array, String, Number, Boolean, Error, Promise,
  isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent, escape, unescape,
  btoa: s => Buffer.from(s, 'binary').toString('base64'), atob: s => Buffer.from(s, 'base64').toString('binary'),
  TextEncoder, TextDecoder, URL, Set, Map, RegExp, Symbol }));
Object.assign(ctx, { globalThis: ctx, localStorage: store, navigator: win.navigator, document: win.document, location: win.location });
vm.runInContext(fs.readFileSync(new URL('../../lib/race-core.js', import.meta.url), 'utf8'), ctx);
const Page = ctx.window.Race.course;

let bad = 0;
const ok = (l, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); if (!p) bad++;
  console.log(`  ${p?'ok  ':'FAIL'} ${l.padEnd(58)} ${JSON.stringify(g)}${p?'':' expected '+JSON.stringify(w)}`); };

const H = 3600e3, now = Date.now();
const loops = [{ name: 'Loop A', distanceMi: 15, times: 6 }, { name: 'Loop B', distanceMi: 10, times: 1 }];
const shapes = {
  'a pattern of two loops': { courseType: 'loops', course: { loopCount: 14, loopDistanceMi: 15, loops } },
  'one plain loop': { courseType: 'loops', course: { loopCount: 6, loopDistanceMi: 4.2 } },
  'a loop with aid on it': { courseType: 'loops', course: { loopCount: 3, loopSegments: [{ distanceMi: 2 }, { distanceMi: 3 }] } },
  'loops with their own aid stations': { courseType: 'loops', course: { loopCount: 14, loops: [
    { name: 'Long', times: 6, segments: [{ fromAid: 'Pit', toAid: 'Turn 7.5', distanceMi: 7.5, checkpoint: true }, { fromAid: 'Turn 7.5', toAid: 'Pit', distanceMi: 7.5 }] },
    { name: 'Short', times: 1, segments: [{ fromAid: 'Pit', toAid: 'Turn 5', distanceMi: 5 }, { fromAid: 'Turn 5', toAid: 'Pit', distanceMi: 5 }] }] } },
  'a timed pattern': { courseType: 'loops', format: 'timed', startTime: new Date(now - 5 * H).toISOString(),
    cutoffs: { totalHours: 24 }, course: { loops } },
};

console.log('\nthe worker and the page read a course the same way');
for (const [what, cfg] of Object.entries(shapes)) {
  const laps = [1, 2, 6, 7, 8, 13, 14, 15, 27, 28].filter(i => i <= Math.min(28, crew.legCount(cfg)));
  ok(what, [crew.totalDistanceMi(cfg), crew.isTimed(cfg), laps.map(i => crew.legAt(cfg, i).cumulativeMi), laps.map(i => crew.legAt(cfg, i).distanceMi)],
    [Page.totalDistanceMi(cfg), Page.isTimed(cfg), laps.map(i => Page.legAt(cfg, i).cumulativeMi), laps.map(i => Page.legAt(cfg, i).distanceMi)]);
}

console.log('\nwhen a timed runner is done');
const timed = shapes['a timed pattern'];
const lap = (i, s, e) => ({ index: i, startTime: new Date(now - s * H).toISOString(), ...(e != null ? { endTime: new Date(now - e * H).toISOString() } : {}) });
const running = { id: 'sam', legs: [lap(1, 5, 2.5), lap(2, 2.4, 0.1)] };
const stopped = { ...running, stoppedAt: new Date(now).toISOString() };
const over = { ...timed, startTime: new Date(now - 25 * H).toISOString() };
const atHorn = { id: 'sam', legs: [lap(1, 25, 22), lap(2, 21.9, 0.5)] };
const outAtHorn = { id: 'sam', legs: [lap(1, 25, 22), lap(2, 21.9, null)] };
const cases = [[timed, running], [timed, stopped], [over, atHorn], [over, outAtHorn]];
// Out of time partway round a loop with an aid station on it: they go on to
// finish the lap, so they are not done at the turnaround.
const aidTimed = { ...shapes['loops with their own aid stations'], format: 'timed', startTime: new Date(now - 25 * H).toISOString(), cutoffs: { totalHours: 24 } };
const atTurn = { id: 'sam', legs: [lap(1, 25, 23), lap(2, 23, 21), lap(3, 21, 0.5)] };
const backAtPit = { id: 'sam', legs: [lap(1, 25, 23), lap(2, 23, 21), lap(3, 21, 0.5), lap(4, 0.5, 0.1)] };
cases.push([aidTimed, atTurn], [aidTimed, backAtPit], [aidTimed, { id: 'sam', legs: [] }]);
ok('the same answer on both sides', cases.map(([c, r]) => crew.runnerDone(c, r)), cases.map(([c, r]) => Page.runnerDone(c, r)));
ok('racing, stopped, out of time, on the last lap, at a turnaround, back at the pit, never started', cases.map(([c, r]) => crew.runnerDone(c, r)), [false, true, true, false, false, true, false]);
ok('the assistant hears they are finished', crew.whereIs(timed, stopped).state, 'finished');
ok('and that the race is scored by time', /scored|time/i.test(JSON.stringify(crew.raceStatus(timed, { runners: [running] }, 'sam', now).race)), true);

console.log(bad ? `\n${bad} failed\n` : '\nall passed\n');
process.exit(bad ? 1 : 0);
