// A racer's goal, and the race page's on pace, tight and off pace held
// against it: a finish time in a race to a finish, a distance or a number of
// laps in a timed one. The cutoff still counts in a race to a finish, so the
// badge is the worse of the two.
//
//   node test/goal-pace.mjs
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
const G = Race.goal;
const H = 3600e3;

const race = { courseType: 'segments', startTime: '2026-10-10T06:00:00Z', cutoffs: { totalHours: 30 },
  course: { segments: Array.from({ length: 10 }, (_, i) => ({ fromAid: `A${i}`, toAid: `A${i + 1}`, distanceMi: 10 })) } };
const km = { ...race, units: { distance: 'km' } };
const timed = { courseType: 'loops', format: 'timed', startTime: new Date(Date.now() - 6 * H).toISOString(), cutoffs: { totalHours: 24 },
  course: { loopCount: 1, loops: [{ name: 'Out and back', distanceMi: 15, times: 6 }, { name: 'Short', distanceMi: 10, times: 1 }] } };

console.log('\nwhat goes in the box');
ok('a finish time, as typed', ['24:00', '23:30', '23h 30m', '24', '23.5', '30h'].map(t => G.parse(t, race).goal),
  [{ hours: 24 }, { hours: 23.5 }, { hours: 23.5 }, { hours: 24 }, { hours: 23.5 }, { hours: 30 }]);
ok('nothing is no goal', G.parse('  ', race), { goal: null });
ok('a time it cannot read says what it wants', [!!G.parse('soon', race).error, !!G.parse('23:75', race).error], [true, true]);
ok('a timed race takes a distance in its own unit, or laps',
  ['100', '100 mi', '7 laps', '7 loops', '1 lap'].map(t => G.parse(t, timed).goal),
  [{ distanceMi: 100 }, { distanceMi: 100 }, { laps: 7 }, { laps: 7 }, { laps: 1 }]);
ok('kilometres where the race is in them, or when said', [G.parse('160', { ...timed, units: { distance: 'km' } }).goal, G.parse('100 km', timed).goal],
  [{ distanceMi: 99.419 }, { distanceMi: 62.137 }]);
ok('half a lap is not a lap', !!G.parse('6.5 laps', timed).error, true);
ok('and reads back the way it went in', [G.text({ hours: 23.5 }, race), G.text({ distanceMi: 100 }, timed), G.text({ laps: 7 }, timed), G.text({ distanceMi: 99.419 }, { ...timed, units: { distance: 'km' } })],
  ['23:30', '100 mi', '7 laps', '160 km']);
ok('the box says what to put in it', [G.placeholder(race), G.placeholder(timed)], ['24:00', '100 mi or 7 laps']);

console.log('\nwhich goal counts');
ok('a time in a race to a finish, laps as their distance in a timed one',
  [G.of(race, { goal: { hours: 24 } }), G.of(timed, { goal: { laps: 7 } }), G.of(timed, { goal: { distanceMi: 120 } })],
  [{ hours: 24 }, { laps: 7, mi: 100 }, { mi: 120 }]);
ok('one of the other kind is kept but not used', [G.of(timed, { goal: { hours: 24 } }), G.of(race, { goal: { laps: 7 } }), G.of(race, {})], [null, null, null]);

console.log('\na race to a finish');
// Two 10-mile legs at 2h each, no time in aid: 20h for the hundred.
const legs = (n, h) => Array.from({ length: n }, (_, i) => ({ index: i + 1,
  startTime: new Date(Date.parse(race.startTime) + i * h * H).toISOString(),
  endTime: new Date(Date.parse(race.startTime) + (i + 1) * h * H).toISOString() }));
const c = (goal, cfg = race, n = 2, h = 2) => Race.compute.runner({ id: 'r', goal, legs: legs(n, h) }, cfg);
ok('no goal: held to the cutoff, as before', [c(undefined).status, c(undefined).goalStatus], ['onpace', null]);
ok('ahead of a 24h goal: on pace, 4h under', [c({ hours: 24 }).status, c({ hours: 24 }).goalMarginSec / 3600], ['onpace', 4]);
ok('inside the last 2.5% of it: tight', [c({ hours: 20.3 }).status, c({ hours: 20.3 }).goalStatus], ['tight', 'tight']);
ok('behind it: off pace, though the cutoff is hours away', [c({ hours: 18 }).status, c({ hours: 18 }).goalMarginSec / 3600], ['offpace', -2]);
const late = c({ hours: 40 }, race, 2, 3.1);
ok('a goal past the cutoff never hides the cutoff', [late.goalStatus, late.status], ['onpace', 'offpace']);
const done = c({ hours: 24 }, race, 10, 2);
ok('finished: made it, by 4h', [done.status, done.goalMet, done.goalMarginSec / 3600], ['finished', true, 4]);
ok('a race with no cutoff is held to the goal alone', c({ hours: 18 }, { ...race, cutoffs: {} }).status, 'offpace');

console.log('\na timed race');
// Six hours in, a 15-mile lap every three hours: 120 miles by the end.
const t0 = Date.parse(timed.startTime);
const tl = [{ index: 1, startTime: new Date(t0).toISOString(), endTime: new Date(t0 + 3 * H).toISOString() },
            { index: 2, startTime: new Date(t0 + 3 * H).toISOString(), endTime: new Date(t0 + 6 * H).toISOString() }];
const tc = (goal) => Race.compute.runner({ id: 'r', goal, legs: tl }, timed);
ok('no goal: racing, as before', [tc(undefined).status, tc(undefined).projectedMiles], ['onpace', 120]);
ok('100 miles: on pace, 20 to spare', [tc({ distanceMi: 100 }).status, tc({ distanceMi: 100 }).goalGapMi], ['onpace', 20]);
ok('seven laps is the same 100', [tc({ laps: 7 }).status, tc({ laps: 7 }).goal], ['onpace', { laps: 7, mi: 100 }]);
ok('118 is tight', tc({ distanceMi: 118 }).status, 'tight');
ok('130 is off pace, 10 short', [tc({ distanceMi: 130 }).status, tc({ distanceMi: 130 }).goalGapMi], ['offpace', -10]);
const stopped = Race.compute.runner({ id: 'r', goal: { distanceMi: 25 }, stoppedAt: new Date(t0 + 6.5 * H).toISOString(), legs: tl }, timed);
ok('stopped: done, and the goal made', [stopped.status, stopped.goalMet, stopped.goalGapMi], ['finished', true, 5]);

console.log('\nbefore a timed race starts');
const early = { ...timed, startTime: new Date(Date.now() + 15 * H).toISOString(), cutoffs: { totalHours: 30 } };
ok('the time left is the race, not the wait as well', Race.compute.runner({ id: 'r', legs: [] }, early).timeLeftSec / 3600, 30);

console.log(bad ? `\n${bad} failed\n` : '\nall good\n');
process.exit(bad ? 1 : 0);
