// The AI as crew: what an assistant can see of one race and one racer, and
// what it can write. See "Your AI as crew" in ROADMAP.md.
//
// A racer with no crew dictates their aid stations to an assistant they
// already carry ("Colony Creek, half a ham and cheese quesadilla, drank 35 oz
// from the bladder"). Before this the numbers stayed in the chat. Now the
// assistant is invited onto the race the way a person is, from Manage access,
// and given a credential that names one race and one racer and nothing else.
//
// It is spoken to over MCP, which is how an assistant is given tools now. The
// worker answers the protocol itself (worker.js, /mcp/<token>), and this file
// is the part that does not touch a store: the tools, the race's state as the
// assistant is told it, and the changes the tools make to data.json. Pure
// functions of (config, data), so worker/test/ai-crew.mjs can hold them
// without standing up anything.
//
// What it can write is intake, items and notes on this racer's legs. Not
// splits: a wrong 280 calories moves nothing, a wrong check-in moves every ETA
// a crew is driving to, and that wants its own decision. Not the course, the
// roster or who can see the race.
//
// Its numbers are estimates and are kept as such. Each leg carries aiEst, the
// part of each metric the assistant guessed, so a page can show "~280" and a
// number a person types on the pit board replaces the guess outright.

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const DEFAULT_FUEL = [
  { key: 'calories', label: 'Calories', unit: 'cal', decimals: 0 },
  { key: 'fluidOz',  label: 'Fluid',    unit: 'oz',  decimals: 1 },
  { key: 'sodiumMg', label: 'Sodium',   unit: 'mg',  decimals: 0 }
];

// What every line the assistant writes into a leg's notes says after its
// time, so it can tell its own lines from the racer's when it reads them back.
export const AI_MARK = 'AI crew:';
const MAX_NOTE = 300;
const MAX_ITEMS = 12;

const num = (v) => { const n = +v; return v === '' || v == null || !Number.isFinite(n) ? null : n; };

// ---------- the course ----------
function loopSegments(cfg) { return (cfg && cfg.course && cfg.course.loopSegments) || []; }

export function legCount(cfg) {
  if (!cfg) return 0;
  const c = cfg.course || {};
  if (cfg.courseType === 'loops') return (c.loopCount || 0) * (loopSegments(cfg).length || 1);
  if (cfg.courseType === 'segments') return (c.segments || []).length;
  return 0;
}

// The same leg lib/race-core.js course.legAt describes, with only what is
// told to the assistant.
export function legAt(cfg, index) {
  const i = index - 1;
  if (!cfg || i < 0 || index > legCount(cfg)) return null;
  const c = cfg.course || {};
  if (cfg.courseType === 'loops') {
    const segs = loopSegments(cfg), per = segs.length || 1;
    const lap = Math.floor(i / per) + 1, k = i % per;
    const lapMi = segs.length ? segs.reduce((a, s) => a + (s.distanceMi || 0), 0) : (c.loopDistanceMi || 0);
    if (segs.length) {
      const s = segs[k] || {};
      let cum = 0;
      for (let j = 0; j <= k; j++) cum += (segs[j] && segs[j].distanceMi) || 0;
      return { index, lap, from: s.fromAid || null, to: s.toAid || `Lap ${lap} end`, distanceMi: s.distanceMi || 0,
        cumulativeMi: (lap - 1) * lapMi + cum, station: s,
        cutoffHours: index === legCount(cfg) ? num(cfg.cutoffs && cfg.cutoffs.totalHours) : null };
    }
    return { index, lap, from: 'Start', to: `Lap ${lap} end`, distanceMi: lapMi, cumulativeMi: lap * lapMi, station: {},
      cutoffHours: index === legCount(cfg) ? num(cfg.cutoffs && cfg.cutoffs.totalHours) : null };
  }
  const segs = c.segments || [];
  const s = segs[i];
  if (!s) return null;
  let cum = 0;
  for (let j = 0; j <= i; j++) cum += (segs[j] && segs[j].distanceMi) || 0;
  return { index, from: s.fromAid || null, to: s.toAid || s.name || `Aid ${index}`, distanceMi: s.distanceMi || 0,
    cumulativeMi: cum, station: s,
    cutoffHours: num(s.arriveCutoffHours) != null ? num(s.arriveCutoffHours)
      : (index === segs.length ? num(cfg.cutoffs && cfg.cutoffs.totalHours) : null) };
}

// Where the racer is, read the way lib/race-core.js nextActionFor reads it:
// the latest press decides. Intake goes on the leg they are running, or the
// one that ends at the station they are standing in.
export function whereIs(cfg, runner) {
  const legs = ((runner && runner.legs) || []).slice().sort((a, b) => a.index - b.index);
  const events = [];
  for (const l of legs) {
    if (l.startTime) events.push({ ts: Date.parse(l.startTime), idx: l.index, action: 'out', seq: 0 });
    if (l.endTime) events.push({ ts: Date.parse(l.endTime), idx: l.index, action: 'in', seq: 1 });
  }
  events.sort((a, b) => (a.ts - b.ts) || (a.idx - b.idx) || (a.seq - b.seq));
  const last = events[events.length - 1];
  if (!last) return { state: 'not started', leg: 0, intakeLeg: null };
  if (last.action === 'out') return { state: 'on course', leg: last.idx, intakeLeg: last.idx, since: last.ts };
  if (last.idx >= legCount(cfg)) return { state: 'finished', leg: last.idx, intakeLeg: null, since: last.ts };
  return { state: 'at aid station', leg: last.idx, intakeLeg: last.idx, since: last.ts };
}

// ---------- fuel ----------
export function metrics(cfg) {
  const listed = cfg && Array.isArray(cfg.fuelMetrics) ? cfg.fuelMetrics : DEFAULT_FUEL;
  return listed.filter(m => m && m.key && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(m.key))
    .map(m => ({ key: m.key, label: m.label || m.key, unit: m.unit || '', decimals: m.decimals != null ? +m.decimals : 0 }));
}

const round = (m, v) => { const p = Math.pow(10, m.decimals || 0); return Math.round(v * p) / p; };

// The racer's own goals where they have them, the race's where they do not,
// the same fall-back lib/race-core.js fuel.forRunner makes.
function plan(cfg, runner) {
  const r = runner || {};
  return {
    targets: r.targets !== undefined ? (r.targets || {}) : ((cfg && cfg.targets) || {}),
    bands: (Array.isArray(r.phaseTargets) ? r.phaseTargets : (cfg && Array.isArray(cfg.phaseTargets) ? cfg.phaseTargets : []))
      .filter(b => b && Number.isFinite(+b.fromHour)).map(b => ({ fromHour: +b.fromHour, targets: b.targets || {} }))
      .sort((a, b) => a.fromHour - b.fromHour),
    crewNotes: String((r.crewNotes !== undefined ? r.crewNotes : cfg && cfg.crewNotes) || '').trim()
  };
}

function targetAt(p, key, hours) {
  const tk = key + 'PerHour';
  for (let i = p.bands.length - 1; i >= 0; i--) {
    if (p.bands[i].fromHour > hours) continue;
    const v = num(p.bands[i].targets[tk]);
    if (v != null) return v;
  }
  return num(p.targets[tk]);
}

// What the average should be by now: six hours at 275 then two at 180 is a
// 251 race, which is what "per hour so far" can honestly be held against.
function expectedAverage(p, key, hours) {
  if (!(hours > 0)) return targetAt(p, key, 0);
  const edges = [0, ...p.bands.map(b => b.fromHour).filter(x => x > 0 && x < hours), hours];
  let weighted = 0, covered = 0;
  for (let i = 0; i < edges.length - 1; i++) {
    const t = targetAt(p, key, edges[i]);
    if (t == null) continue;
    weighted += t * (edges[i + 1] - edges[i]);
    covered += edges[i + 1] - edges[i];
  }
  return covered > 0 ? weighted / covered : null;
}

export function presets(cfg) {
  const list = cfg && Array.isArray(cfg.fuelPresets) ? cfg.fuelPresets : [];
  return list.filter(p => p && p.name && p.values && typeof p.values === 'object');
}

// ---------- clocks ----------
// On the race's clock. A race from before zones has none, and its start was
// written with the offset of wherever it was set up, so that offset stands in.
function validZone(z) {
  if (!z || typeof z !== 'string') return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return z; } catch (e) { return null; }
}
function fixedOffsetMin(iso) {
  const m = /([+-])(\d{2}):?(\d{2})$/.exec(String(iso || ''));
  return m ? (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]) : 0;
}
export function clock(ms, cfg, withDay) {
  if (ms == null || isNaN(ms)) return null;
  const zone = validZone(cfg && cfg.timezone);
  const opts = { hour: 'numeric', minute: '2-digit', ...(withDay ? { weekday: 'short' } : {}) };
  if (zone) return new Date(ms).toLocaleString('en-US', { ...opts, timeZone: zone });
  return new Date(ms + fixedOffsetMin(cfg && cfg.startTime) * 60000).toLocaleString('en-US', { ...opts, timeZone: 'UTC' });
}
export function zoneLabel(cfg, ms) {
  const zone = validZone(cfg && cfg.timezone);
  if (zone) {
    try {
      const p = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' })
        .formatToParts(new Date(ms)).find(x => x.type === 'timeZoneName');
      return p ? p.value : zone;
    } catch (e) { return zone; }
  }
  const off = fixedOffsetMin(cfg && cfg.startTime);
  return `UTC${off < 0 ? '-' : '+'}${Math.floor(Math.abs(off) / 60)}${Math.abs(off) % 60 ? ':' + String(Math.abs(off) % 60).padStart(2, '0') : ''}`;
}
function hm(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

// ---------- units ----------
function distance(mi, cfg) {
  if (mi == null) return null;
  const km = cfg && cfg.units && cfg.units.distance === 'km';
  return `${(km ? mi * 1.609344 : mi).toFixed(1)} ${km ? 'km' : 'mi'}`;
}

// ---------- the state, as the assistant is told it ----------
export function findRunner(data, runnerId) {
  return ((data && data.runners) || []).find(r => r && r.id === runnerId) || { id: runnerId, legs: [] };
}

export function raceStatus(cfg, data, runnerId, now) {
  now = now || Date.now();
  const def = ((cfg && cfg.runners) || []).find(r => r && r.id === runnerId) || {};
  const runner = findRunner(data, runnerId);
  const where = whereIs(cfg, runner);
  const start = Date.parse(cfg && cfg.startTime);
  const ms = metrics(cfg);
  const p = plan(cfg, def);
  const legs = (runner.legs || []);
  const elapsedH = !isNaN(start) && now > start ? (now - start) / 3600e3 : 0;
  const total = {}, est = {};
  for (const m of ms) {
    total[m.key] = round(m, legs.reduce((a, l) => a + (+l[m.key] || 0), 0));
    est[m.key] = round(m, legs.reduce((a, l) => a + (+((l.aiEst || {})[m.key]) || 0), 0));
  }
  const fmtVals = (vals) => {
    const o = {};
    for (const m of ms) if (vals[m.key] != null) o[`${m.label} (${m.unit})`] = vals[m.key];
    return o;
  };
  const perHour = {}, expected = {}, now_ = {};
  for (const m of ms) {
    if (elapsedH > 0.25) perHour[m.key] = round(m, total[m.key] / elapsedH);
    const e = expectedAverage(p, m.key, elapsedH), t = targetAt(p, m.key, elapsedH);
    if (e != null) expected[m.key] = round(m, e);
    if (t != null) now_[m.key] = t;
  }

  const out = {
    race: {
      name: cfg && cfg.name || null,
      location: cfg && cfg.location || null,
      clock: `${clock(now, cfg, true)} ${zoneLabel(cfg, now)}`,
      start: isNaN(start) ? null : clock(start, cfg, true),
      elapsed: !isNaN(start) && now > start ? hm(now - start) : null,
      legs: legCount(cfg),
      distanceUnit: cfg && cfg.units && cfg.units.distance === 'km' ? 'km' : 'mi'
    },
    racer: { name: def.name || runnerId, bib: def.bib || null },
    state: where.state
  };
  const total_ = num(cfg && cfg.cutoffs && cfg.cutoffs.totalHours);
  if (total_ && !isNaN(start)) {
    const at = start + total_ * 3600e3;
    out.race.finishCutoff = clock(at, cfg, true);
    if (now < at) out.race.timeToFinishCutoff = hm(at - now);
  }

  // The leg the racer is on, or about to start, and the station ahead.
  const legNo = where.state === 'at aid station' ? where.leg + 1 : where.state === 'not started' ? 1 : where.leg;
  const ahead = where.state !== 'finished' ? legAt(cfg, legNo) : null;
  if (where.state === 'at aid station') {
    const here = legAt(cfg, where.leg);
    out.atStation = here ? { name: here.to, at: distance(here.cumulativeMi, cfg), arrived: clock(where.since, cfg, true),
      dropBag: !!here.station.dropBag, crewNote: here.station.crewNote || null } : null;
  }
  if (ahead) {
    const next = { leg: ahead.index, from: ahead.from, to: ahead.to, legDistance: distance(ahead.distanceMi, cfg),
      at: distance(ahead.cumulativeMi, cfg), crewCanMeet: ahead.station.crewAccess !== false,
      dropBag: !!ahead.station.dropBag, pacerPickup: !!ahead.station.pacerEligible,
      checkpointOnly: !!ahead.station.checkpoint, crewNote: ahead.station.crewNote || null };
    if (ahead.cutoffHours != null && !isNaN(start)) {
      const at = start + ahead.cutoffHours * 3600e3;
      next.cutoff = clock(at, cfg, true);
      next.cutoffIn = now < at ? hm(at - now) : 'passed';
    }
    if (where.state === 'on course') next.leftAt = clock(where.since, cfg, true);
    out.nextStation = next;
  }

  const intakeLeg = where.intakeLeg ? legs.find(l => l.index === where.intakeLeg) : null;
  out.intake = {
    logsGoOn: where.intakeLeg ? `leg ${where.intakeLeg} (to ${(legAt(cfg, where.intakeLeg) || {}).to})` : 'nowhere yet: the racer has not started, or has finished',
    thisLeg: intakeLeg ? fmtVals(Object.fromEntries(ms.map(m => [m.key, +intakeLeg[m.key] || 0]))) : null,
    raceTotal: fmtVals(total),
    ofWhichEstimatedByAI: fmtVals(est),
    perHourSoFar: elapsedH > 0.25 ? fmtVals(perHour) : null,
    planAveragePerHourByNow: Object.keys(expected).length ? fmtVals(expected) : null,
    planPerHourRightNow: Object.keys(now_).length ? fmtVals(now_) : null
  };
  if (p.crewNotes) out.racerNotesForCrew = p.crewNotes;
  const items = presets(cfg);
  if (items.length) {
    out.oneTapItems = items.map(it => ({ name: it.name,
      adds: fmtVals(Object.fromEntries(ms.map(m => [m.key, num(it.values[m.key])]).filter(([, v]) => v))) }));
  }
  out.unreadNotes = unreadNotes(cfg, data, runnerId).length;
  return out;
}

// ---------- notes ----------
function noteLines(leg) {
  return String((leg && leg.notes) || '').split('\n').map(s => s.trim()).filter(Boolean);
}
const isAiLine = (line) => line.includes(' ' + AI_MARK) || line.startsWith(AI_MARK);

// The racer's write-ins the assistant has not turned into numbers yet: the
// lines held on a phone with no signal and sent when it came back.
export function unreadNotes(cfg, data, runnerId, all) {
  const runner = findRunner(data, runnerId);
  const out = [];
  for (const leg of (runner.legs || []).slice().sort((a, b) => a.index - b.index)) {
    const done = new Set(Array.isArray(leg.aiNoted) ? leg.aiNoted : []);
    for (const line of noteLines(leg)) {
      if (isAiLine(line)) continue;
      if (!all && done.has(line)) continue;
      out.push({ leg: leg.index, station: (legAt(cfg, leg.index) || {}).to || null, line, handled: done.has(line) });
    }
  }
  return out;
}

// ---------- writes ----------
function legFor(data, cfg, runnerId, legArg) {
  const runner = ((data && data.runners) || []).find(r => r && r.id === runnerId);
  if (!runner) throw new Error('Nothing has been logged for this racer yet, so there is no leg to put this on. They need to be checked out of the start first.');
  let index = legArg == null || legArg === '' ? null : Math.floor(+legArg);
  if (index == null) {
    index = whereIs(cfg, runner).intakeLeg;
    if (!index) throw new Error('The racer is not on a leg: not started yet, or finished. Pass leg to put it on a particular one.');
  }
  const leg = (runner.legs || []).find(l => l.index === index);
  if (!leg) throw new Error(`Leg ${index} has not been started yet.`);
  return leg;
}

function addNoteLine(leg, cfg, now, text) {
  const line = `${clock(now, cfg)}: ${AI_MARK} ${text}`;
  leg.notes = [String(leg.notes || '').trim(), line].filter(Boolean).join('\n');
  return line;
}

function markNoted(leg, lines) {
  if (!Array.isArray(lines) || !lines.length) return;
  const have = new Set(noteLines(leg));
  const done = new Set(Array.isArray(leg.aiNoted) ? leg.aiNoted : []);
  for (const l of lines) { const s = String(l || '').trim(); if (have.has(s)) done.add(s); }
  leg.aiNoted = [...done].slice(-100);
}

function cleanText(v, n) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n || MAX_NOTE);
}

// Intake, added to what the leg already holds. Negative amounts take back a
// mistake. Nothing goes below zero, and the estimated part never exceeds the
// whole.
export function logIntake(data, cfg, runnerId, args, now) {
  now = now || Date.now();
  const ms = metrics(cfg);
  const items = Array.isArray(args && args.items) ? args.items.slice(0, MAX_ITEMS) : [];
  if (!items.length) throw new Error('items is required: one entry per thing eaten or drunk.');
  const estimated = !(args && args.estimated === false);
  const leg = legFor(data, cfg, runnerId, args && args.leg);
  const sums = {};
  const parts = [];
  for (const it of items) {
    const what = cleanText(it && it.what, 120) || 'unnamed';
    const bits = [];
    for (const m of ms) {
      const v = num(it && it[m.key]);
      if (v == null || v === 0) continue;
      if (Math.abs(v) > 100000) throw new Error(`${m.label} of ${v} is not believable.`);
      sums[m.key] = (sums[m.key] || 0) + v;
      bits.push(`${estimated ? '~' : ''}${round(m, v)} ${m.unit}`.trim());
    }
    parts.push(bits.length ? `${what} (${bits.join(', ')})` : what);
  }
  if (!Object.keys(sums).length) throw new Error(`No amounts given. Use ${ms.map(m => m.key).join(', ')}.`);
  const est = Object.assign({}, leg.aiEst || {});
  for (const m of ms) {
    if (sums[m.key] == null) continue;
    const before = +leg[m.key] || 0;
    const after = Math.max(0, round(m, before + sums[m.key]));
    leg[m.key] = after;
    if (estimated) est[m.key] = Math.min(after, Math.max(0, round(m, (+est[m.key] || 0) + sums[m.key])));
    else if (est[m.key] != null) est[m.key] = Math.min(after, +est[m.key]);
    if (!(est[m.key] > 0)) delete est[m.key];
  }
  if (Object.keys(est).length) leg.aiEst = est; else delete leg.aiEst;
  const line = addNoteLine(leg, cfg, now, parts.join('; '));
  markNoted(leg, args && args.forNotes);
  return { leg: leg.index, wrote: line, legNowHolds: Object.fromEntries(ms.map(m => [`${m.label} (${m.unit})`, +leg[m.key] || 0])) };
}

// One of the race's one-tap items, the same as a press on the racer page:
// exact amounts, and the count kept beside them under the item's position.
export function logItem(data, cfg, runnerId, args, now) {
  now = now || Date.now();
  const list = presets(cfg);
  const name = cleanText(args && args.item, 120).toLowerCase();
  const i = list.findIndex(p => String(p.name).trim().toLowerCase() === name);
  if (i < 0) throw new Error(`No one-tap item called "${args && args.item}". The race has: ${list.map(p => p.name).join(', ') || 'none'}.`);
  const count = Math.max(-20, Math.min(20, Math.trunc(+((args && args.count) ?? 1)) || 0));
  if (!count) throw new Error('count must be a whole number, not zero.');
  const leg = legFor(data, cfg, runnerId, args && args.leg);
  const had = +leg[`preset_${i}`] || 0;
  const n = Math.max(-had, count);
  if (!n) throw new Error(`Nothing to take back: no ${list[i].name} logged on leg ${leg.index}.`);
  for (const m of metrics(cfg)) {
    const step = +list[i].values[m.key];
    if (!step) continue;
    leg[m.key] = Math.max(0, round(m, (+leg[m.key] || 0) + step * n));
    if (leg.aiEst && leg.aiEst[m.key] > leg[m.key]) leg.aiEst[m.key] = leg[m.key];
  }
  leg[`preset_${i}`] = had + n;
  const line = addNoteLine(leg, cfg, now, `${n > 0 ? '' : 'took back '}${Math.abs(n)} × ${list[i].name}`);
  markNoted(leg, args && args.forNotes);
  return { leg: leg.index, wrote: line };
}

export function addNote(data, cfg, runnerId, args, now) {
  const text = cleanText(args && args.text);
  if (!text) throw new Error('text is required.');
  const leg = legFor(data, cfg, runnerId, args && args.leg);
  const line = addNoteLine(leg, cfg, now || Date.now(), text);
  markNoted(leg, args && args.forNotes);
  return { leg: leg.index, wrote: line };
}

export function markRead(data, cfg, runnerId, args) {
  const lines = Array.isArray(args && args.lines) ? args.lines : [];
  const runner = findRunner(data, runnerId);
  let n = 0;
  for (const leg of runner.legs || []) {
    const before = (leg.aiNoted || []).length;
    markNoted(leg, lines);
    n += (leg.aiNoted || []).length - before;
  }
  return { marked: n };
}

// ---------- the tools ----------
export function tools(cfg) {
  const ms = metrics(cfg);
  const amount = {};
  for (const m of ms) amount[m.key] = { type: 'number', description: `${m.label}, in ${m.unit || 'units'}. Negative to take back a mistake.` };
  const leg = { type: 'integer', minimum: 1, description: 'Which leg to put it on. Leave out for the leg the racer is on now (or the one that ended at the aid station they are standing in).' };
  const forNotes = { type: 'array', items: { type: 'string' }, description: 'The racer\'s note lines this turns into numbers, copied exactly from read_notes, so they are not handed to you again.' };
  const items = presets(cfg).map(p => p.name);
  return [
    {
      name: 'race_status',
      title: 'Race status',
      description: 'Where the racer is on the course, what the next aid station is called, how far and when its cutoff is, what they have eaten and drunk so far against their plan, the race\'s one-tap items, and how many of their notes you have not read. Times are on the race\'s own clock. Call this first, and whenever you are asked how they are doing.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    {
      name: 'log_intake',
      title: 'Log food and drink',
      description: `Add what the racer ate or drank to their leg. One entry per thing, with your best numbers for ${ms.map(m => `${m.label.toLowerCase()} (${m.key}, ${m.unit})`).join(', ')}. Your numbers are kept as estimates and shown with a "~" unless you say they are exact (from a label, or the racer said so). A number a person types later replaces yours. Prefer log_item for anything on the race's one-tap list. Do not log something twice: check race_status if unsure.`,
      inputSchema: {
        type: 'object',
        properties: {
          items: { type: 'array', minItems: 1, maxItems: MAX_ITEMS, items: {
            type: 'object', properties: Object.assign({ what: { type: 'string', description: 'What it was, as the racer said it: "half a ham and cheese quesadilla".' } }, amount),
            required: ['what'], additionalProperties: false } },
          estimated: { type: 'boolean', default: true, description: 'false only when the numbers are exact.' },
          leg, forNotes
        },
        required: ['items'], additionalProperties: false
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    {
      name: 'log_item',
      title: 'Log a one-tap item',
      description: 'The same as the racer pressing one of the race\'s one-tap items: exact amounts, counted. A negative count takes presses back.' +
        (items.length ? ` The items: ${items.join(', ')}.` : ' This race has none set up.'),
      inputSchema: {
        type: 'object',
        properties: Object.assign({
          item: items.length ? { type: 'string', enum: items } : { type: 'string' },
          count: { type: 'integer', minimum: -20, maximum: 20, default: 1 },
          leg, forNotes
        }),
        required: ['item'], additionalProperties: false
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    {
      name: 'add_note',
      title: 'Add a note',
      description: 'A line on the leg for the crew and the race page: a gear change, a blister, how they say they feel. Not for food or drink, which go through log_intake so they count.',
      inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: MAX_NOTE }, leg, forNotes }, required: ['text'], additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    {
      name: 'read_notes',
      title: 'Read the racer\'s notes',
      description: 'What the racer typed into SendOff themselves, often with no signal, that you have not handled yet: food with no numbers, gear, problems. Turn food into log_intake calls, passing the lines in forNotes. Lines that need nothing from you go to mark_notes_read.',
      inputSchema: { type: 'object', properties: { includeHandled: { type: 'boolean', default: false } }, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    {
      name: 'mark_notes_read',
      title: 'Mark notes as read',
      description: 'Notes from read_notes that need no numbers, so they are not handed to you again.',
      inputSchema: { type: 'object', properties: { lines: { type: 'array', items: { type: 'string' }, minItems: 1 } }, required: ['lines'], additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }
  ];
}

export function instructions(cfg, runnerName) {
  return `You are crew for ${runnerName || 'a racer'} at ${(cfg && cfg.name) || 'a race'}, through SendOff. ` +
    'The racer will tell you what they eat and drink, often in passing, and you log it with your best estimate of the numbers so their crew, family and the race page see it. ' +
    'Call race_status before answering anything about where they are, what is next, their cutoff or their fueling, and use the aid station names it gives you. ' +
    'When asked to check their notes, call read_notes. Keep replies short: they are running.';
}

// ---------- the protocol ----------
// JSON-RPC 2.0 over MCP's streamable HTTP transport, answered as plain JSON:
// every call here is quick, so there is nothing to stream. `io` is what the
// worker hands in: load() for { cfg, data }, write(fn) to change data.json
// with fn(data) under the version guard and return what fn returned.
export async function handleRpc(msg, io) {
  const id = msg && msg.id;
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'Invalid request');
  // A notification wants no answer at all.
  if (id === undefined || id === null) return null;
  const params = msg.params || {};
  switch (msg.method) {
    case 'initialize': {
      const asked = params.protocolVersion;
      const { cfg, runnerName } = await io.load();
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'sendoff-crew', title: 'SendOff crew', version: '1.0.0' },
        instructions: instructions(cfg, runnerName)
      });
    }
    case 'ping': return reply({});
    case 'tools/list': {
      const { cfg } = await io.load();
      return reply({ tools: tools(cfg) });
    }
    case 'tools/call': {
      const name = params.name, args = params.arguments || {};
      const text = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o, null, 2) }], structuredContent: o });
      const err = (m) => ({ content: [{ type: 'text', text: m }], isError: true });
      try {
        if (name === 'race_status') {
          const { cfg, data, runnerId } = await io.load();
          return reply(text(raceStatus(cfg, data, runnerId, io.now && io.now())));
        }
        if (name === 'read_notes') {
          const { cfg, data, runnerId } = await io.load();
          const notes = unreadNotes(cfg, data, runnerId, !!args.includeHandled);
          return reply(text({ notes, howTo: notes.length ? 'Pass each line you handle in forNotes, or to mark_notes_read.' : 'Nothing new.' }));
        }
        const writers = { log_intake: logIntake, log_item: logItem, add_note: addNote, mark_notes_read: markRead };
        if (writers[name]) {
          const result = await io.write((data, cfg, runnerId) => writers[name](data, cfg, runnerId, args, io.now && io.now()));
          return reply(text(result));
        }
        return fail(-32602, `Unknown tool: ${name}`);
      } catch (e) {
        if (e && e.rpc) throw e;
        return reply(err(e && e.message ? e.message : String(e)));
      }
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}
