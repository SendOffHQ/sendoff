// SendOff finish card.
//
// One image, made on the finisher's own device, for the post that happens in
// the parking lot afterwards. Everything here is drawn to a canvas from data
// the page already has: no server renders it, nothing is uploaded, and it
// works with no signal, which matters because the finish line of a 100 miler
// is rarely somewhere with bars.
//
// The elevation profile is the hero rather than a logo, because the shape of
// the course is the part that says which race this was. The splits are drawn
// onto it, so the picture is of this runner's day rather than of the map.
//
// Exposes window.FinishCard. Loaded only by race.html; the racer screen is
// meant to stay light and has no use for it.
(function () {
  'use strict';

  // The four shapes a post is usually asked for. Width by height, so 4:3 and
  // 16:9 are landscape and 4:5 is the tall Instagram frame.
  //
  // A landscape card cannot be the portrait one made shorter: a single column
  // across 1920px leaves the text stranded on the left and squashes the course
  // into a strip. So the wide two get their own arrangement, identity and time
  // down one side, course and numbers down the other, and both keep the same
  // type sizes, because a column of a two-column 16:9 is about as wide as the
  // single column of the portrait card.
  const RATIOS = [
    { key: '4:5',  label: '4:5',  w: 1080, h: 1350, mode: 'stack' },
    { key: '1:1',  label: '1:1',  w: 1080, h: 1080, mode: 'stack' },
    { key: '4:3',  label: '4:3',  w: 1440, h: 1080, mode: 'split' },
    { key: '16:9', label: '16:9', w: 1920, h: 1080, mode: 'split' }
  ];
  const DEFAULT_RATIO = '4:5';
  const PAD = 76;

  const C = {
    void:   '#0a0f14',
    panel:  '#121820',
    line:   '#253340',
    ink:    '#f0ece3',
    dim:    '#b6c2c9',
    muted:  '#7a8d99',
    signal: '#0fb8bf',
    beam:   '#5efdf6',
    green:  '#6ee7a8',
    warm:   '#ffb07a'
  };

  const DISPLAY = "'Barlow Condensed', 'Arial Narrow', sans-serif";
  const MONO    = "'JetBrains Mono', ui-monospace, monospace";

  function esc(s) {
    return String(s == null ? '' : s);
  }

  // Hours and minutes, said the way a person says them. Truncated, not rounded,
  // to match Race.fmt.duration everywhere else, and because rounding up on the
  // cutoff margin would hand someone thirty seconds of room they did not have.
  function compactDur(sec) {
    const total = Math.max(0, Math.floor(sec / 60));
    const h = Math.floor(total / 60), m = total % 60;
    return h ? `${h}h ${m}m` : `${m}m`;
  }

  // Shrink until it fits rather than clip. A name is not negotiable; the
  // point size is.
  function fitText(ctx, text, maxWidth, startPx, family, weight) {
    let px = startPx;
    for (;;) {
      ctx.font = `${weight} ${px}px ${family}`;
      if (ctx.measureText(text).width <= maxWidth || px <= 14) return px;
      px -= 2;
    }
  }

  function label(ctx, text, x, y, color) {
    ctx.font = `500 19px ${MONO}`;
    ctx.fillStyle = color || C.muted;
    ctx.letterSpacing = '3.4px';
    ctx.fillText(String(text).toUpperCase(), x, y);
    ctx.letterSpacing = '0px';
  }

  // The wordmark as it is actually drawn everywhere else, rather than the word
  // set in some other typeface. Built as a data URI so it needs no network and
  // survives an offline finish.
  const WORDMARK_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-130 -130 3781 1317.6">' +
    '<g transform="translate(0,700) skewX(-16) translate(0,-700)">' +
    '<g transform="translate(2006,0)"><circle cx="350" cy="350" r="294" fill="none" stroke="SIG" stroke-width="112"/></g>' +
    '<circle cx="2370" cy="350" r="80" fill="SIG"/>' +
    '<path d="M 374 168 C 374 44 56 44 56 190 C 56 322 374 368 374 506 C 374 656 56 656 56 528" fill="none" stroke="LTR" stroke-width="112" stroke-linejoin="round"/>' +
    '<g transform="translate(446,0)"><path d="M 56 425 L 544.24 425" fill="none" stroke="LTR" stroke-width="112" stroke-linejoin="round"/>' +
    '<path d="M 489.41 469.6 A 219 219 0 1 0 419.5 589.2" fill="none" stroke="LTR" stroke-width="112" stroke-linejoin="round"/></g>' +
    '<g transform="translate(1024,0)"><path d="M 56 700 L 56 150" fill="none" stroke="LTR" stroke-width="112" stroke-linejoin="round"/>' +
    '<path d="M 56 340 C 56 158 444 158 444 340 L 444 700" fill="none" stroke="LTR" stroke-width="112" stroke-linejoin="round"/></g>' +
    '<g transform="translate(1552,0)"><circle cx="275" cy="425" r="219" fill="none" stroke="LTR" stroke-width="112"/>' +
    '<path d="M 494 56 L 494 700" fill="none" stroke="LTR" stroke-width="112" stroke-linejoin="round"/></g>' +
    '<g transform="translate(2730,0)"><path d="M 152 700 L 152 150 C 152 34 264 6 332 62" fill="none" stroke="LTR" stroke-width="112" stroke-linejoin="round"/>' +
    '<path d="M 482 700 L 482 150 C 482 34 594 6 662 62" fill="none" stroke="LTR" stroke-width="112" stroke-linejoin="round"/>' +
    '<path d="M 56 208 L 600 208" fill="none" stroke="LTR" stroke-width="112" stroke-linejoin="round"/></g>' +
    '<path d="M -20 870 L 1224 870 L 1304 818.8 L 1384 850.8 L 1474 742 L 1554 793.2 L 1664 550 L 1754 927.6 L 1844 729.2 L 1934 806 L 2024 774 L 2124 844.4 L 2224 870 L 3468 870" fill="none" stroke="SIG" stroke-width="62.7" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</g></svg>';

  function wordmarkImage() {
    const svg = WORDMARK_SVG.split('SIG').join(C.signal).split('LTR').join(C.ink);
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);   // the card is fine without it
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    });
  }

  // ---------- the profile ----------
  // Course shape, with a tick at each aid station and a dot at each one this
  // runner actually reached. Falls back to a bar per leg when the race has no
  // GPX, which says less but never leaves a hole in the middle of the card.
  function drawProfile(ctx, box, cfg, runner, c, gpxPts) {
    const { x, y, w, h } = box;

    ctx.fillStyle = C.panel;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);

    const legs = (runner.legs || []).filter(l => l.startTime && l.endTime).sort((a, b) => a.index - b.index);

    if (gpxPts && gpxPts.length > 8) {
      const total = gpxPts[gpxPts.length - 1].dist || 0;
      let lo = Infinity, hi = -Infinity;
      for (const p of gpxPts) {
        if (p.ele == null) continue;
        if (p.ele < lo) lo = p.ele;
        if (p.ele > hi) hi = p.ele;
      }
      if (!(hi > lo)) { lo = 0; hi = 1; }

      const px = d => x + 14 + ((d / (total || 1)) * (w - 28));
      const py = e => y + h - 16 - (((e - lo) / (hi - lo)) * (h - 46));

      // Filled shape first, line on top: the fill reads as terrain, the line
      // keeps the ridges legible where the fill flattens them.
      ctx.beginPath();
      ctx.moveTo(px(0), y + h - 16);
      for (const p of gpxPts) if (p.ele != null) ctx.lineTo(px(p.dist || 0), py(p.ele));
      ctx.lineTo(px(total), y + h - 16);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, y, 0, y + h);
      grad.addColorStop(0, 'rgba(15,184,191,0.30)');
      grad.addColorStop(1, 'rgba(15,184,191,0.03)');
      ctx.fillStyle = grad;
      ctx.fill();

      ctx.beginPath();
      let started = false;
      for (const p of gpxPts) {
        if (p.ele == null) continue;
        const X = px(p.dist || 0), Y = py(p.ele);
        if (!started) { ctx.moveTo(X, Y); started = true; } else ctx.lineTo(X, Y);
      }
      ctx.strokeStyle = C.signal;
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.stroke();

      // Aid stations: a faint tick for every one, a solid dot for the ones
      // reached. On a finish card that is all of them, which is the point.
      const aids = (window.Race && Race.course.aidStations(cfg)) || [];
      const reached = new Set(legs.map(l => l.index));
      aids.forEach((a, i) => {
        const X = px(a.mileage || 0);
        let ele = null;
        for (const p of gpxPts) { if ((p.dist || 0) >= (a.mileage || 0)) { ele = p.ele; break; } }
        if (ele == null) return;
        const Y = py(ele);
        ctx.beginPath();
        ctx.moveTo(X, y + h - 16);
        ctx.lineTo(X, Y);
        ctx.strokeStyle = 'rgba(122,141,153,0.22)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        if (i === 0 || reached.has(i)) {
          ctx.beginPath();
          ctx.arc(X, Y, 5.5, 0, Math.PI * 2);
          ctx.fillStyle = C.void;
          ctx.fill();
          ctx.strokeStyle = C.beam;
          ctx.lineWidth = 2.5;
          ctx.stroke();
        }
      });
      return;
    }

    // No GPX: a bar per leg, tallest is the slowest. Still this runner's day.
    if (!legs.length) return;
    const secs = legs.map(l => (new Date(l.endTime) - new Date(l.startTime)) / 1000);
    const max = Math.max.apply(null, secs) || 1;
    const gap = 5;
    const bw = Math.max(4, (w - 28 - gap * (legs.length - 1)) / legs.length);
    legs.forEach((l, i) => {
      const bh = Math.max(4, (secs[i] / max) * (h - 46));
      const bx = x + 14 + i * (bw + gap);
      ctx.fillStyle = 'rgba(15,184,191,0.75)';
      ctx.fillRect(bx, y + h - 16 - bh, bw, bh);
    });
  }



  // ---------- what a card can carry ----------
  // Order is the order they are drawn. `stat` items share a grid and reflow
  // when one is switched off, so turning off Pace closes the gap.
  const PARTS = [
    { key: 'location', label: 'Location',      kind: 'line' },
    { key: 'cutoff',   label: 'Cutoff margin', kind: 'line' },
    { key: 'profile',  label: 'Course profile', kind: 'block' },
    { key: 'distance', label: 'Distance',      kind: 'stat' },
    { key: 'climb',    label: 'Climb',         kind: 'stat' },
    { key: 'pace',     label: 'Pace',          kind: 'stat' },
    { key: 'segments', label: 'Segments',      kind: 'stat' },
    { key: 'aid',      label: 'Time in aid',   kind: 'stat' },
    { key: 'longest',  label: 'Longest leg',   kind: 'stat' },
    { key: 'date',     label: 'Date',          kind: 'line' }
  ];

  const PREF_KEY = 'sendoff-finish-card-v1';

  function defaults() {
    const d = {};
    for (const p of PARTS) d[p.key] = true;
    return d;
  }

  // Remembered per device, because someone who does not put their pace on the
  // internet does not want to switch it off again at the next finish.
  function loadPrefs() {
    const d = { show: defaults(), ratio: DEFAULT_RATIO };
    try {
      const raw = localStorage.getItem(PREF_KEY);
      if (!raw) return d;
      const saved = JSON.parse(raw);
      const show = saved.show || saved;   // v1 stored the switches at the top level
      for (const p of PARTS) if (typeof show[p.key] === 'boolean') d.show[p.key] = show[p.key];
      if (RATIOS.some(r => r.key === saved.ratio)) d.ratio = saved.ratio;
    } catch (e) { /* a fresh card is the right fallback */ }
    return d;
  }
  function savePrefs(show, ratio) {
    try { localStorage.setItem(PREF_KEY, JSON.stringify({ show: show, ratio: ratio })); } catch (e) {}
  }

  // ---------- blocks ----------
  // Each returns the height it used, so a layout can add them up before it
  // decides where anything goes. Nothing here knows which arrangement it is in.

  function identityHeight(show, cfg) {
    return 128 + 46 + 34 + ((show.location && cfg.location) ? 30 : 0);
  }
  async function drawIdentity(ctx, x, y, w, cfg, runner, show) {
    const top = y;
    const wm = await wordmarkImage();
    if (wm) {
      const wmH = 46, wmW = wmH * (3781 / 1317.6);
      ctx.drawImage(wm, x, y - 6, wmW, wmH);
    }
    y += 128;

    const name = esc(runner.name || runner.id || 'Finisher');
    const namePx = fitText(ctx, name, w, 86, DISPLAY, 700);
    ctx.font = `700 ${namePx}px ${DISPLAY}`;
    ctx.fillStyle = C.ink;
    ctx.fillText(name, x, y);
    y += 46;

    const race = esc(cfg.name || '').toUpperCase();
    const racePx = fitText(ctx, race, w, 30, MONO, 500);
    ctx.font = `500 ${racePx}px ${MONO}`;
    ctx.fillStyle = C.signal;
    ctx.letterSpacing = '4px';
    ctx.fillText(race, x, y);
    ctx.letterSpacing = '0px';
    y += 34;

    if (show.location && cfg.location) {
      ctx.font = `400 23px ${MONO}`;
      ctx.fillStyle = C.muted;
      ctx.fillText(esc(cfg.location), x, y);
      y += 30;
    }
    return y - top;
  }

  function finishHeight(hasCutoff, px) {
    return 46 + 22 + ((px || 208) * 0.76 + 44) + (hasCutoff ? 30 : 0);
  }
  function drawFinish(ctx, x, y, w, R, c, totalH, spare, hasCutoff, maxPx) {
    const top = y;
    y += 46;
    label(ctx, 'Finish time', x, y, C.muted);
    y += 22;
    const finish = R.fmt.duration(c.completedRaceSec || 0);
    const cap = maxPx || 208;
    const finPx = fitText(ctx, finish, w, cap, DISPLAY, 700);
    ctx.font = `700 ${finPx}px ${DISPLAY}`;
    ctx.fillStyle = C.ink;
    ctx.fillText(finish, x, y + finPx * 0.76);
    y += cap * 0.76 + 44;
    if (hasCutoff) {
      const line = `${compactDur(spare)} inside the ${totalH}h cutoff`;
      const px = fitText(ctx, line, w, 27, MONO, 500);
      ctx.font = `500 ${px}px ${MONO}`;
      ctx.fillStyle = C.green;
      ctx.fillText(line, x, y);
      y += 30;
    }
    return y - top;
  }

  const STAT_ROW_1 = 104, STAT_ROW_N = 98;
  function statsHeight(stats, cols) {
    if (!stats.length) return 0;
    const rows = Math.ceil(stats.length / cols);
    return STAT_ROW_1 + (rows - 1) * STAT_ROW_N;
  }
  function drawStats(ctx, x, y, w, stats, cols) {
    if (!stats.length) return 0;
    const perRow = Math.min(cols, stats.length);
    const colW = w / perRow;
    stats.forEach((sv, i) => {
      const row = Math.floor(i / cols), col = i % cols;
      const rowY = y + row * STAT_ROW_N;
      const cx = x + col * colW;
      label(ctx, sv[0], cx, rowY, C.muted);
      const big = row === 0;
      const vPx = fitText(ctx, sv[1], colW - 20, big ? 52 : 46, DISPLAY, 700);
      ctx.font = `700 ${vPx}px ${DISPLAY}`;
      ctx.fillStyle = big ? C.ink : C.dim;
      ctx.fillText(sv[1], cx, rowY + (big ? 52 : 46));
    });
    return statsHeight(stats, cols);
  }

  function drawFooter(ctx, cardW, cardH, cfg, show) {
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(PAD, cardH - PAD - 46);
    ctx.lineTo(cardW - PAD, cardH - PAD - 46);
    ctx.stroke();
    ctx.font = `400 22px ${MONO}`;
    ctx.fillStyle = C.muted;
    if (show.date && cfg.startTime) {
      ctx.fillText(new Date(cfg.startTime).toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' }),
                   PAD, cardH - PAD - 8);
    }
    ctx.textAlign = 'right';
    ctx.fillText('sendoff.run', cardW - PAD, cardH - PAD - 8);
    ctx.textAlign = 'left';
  }

  // ---------- the card ----------
  // Returns what it had to give up, so the modal can say why rather than
  // leaving someone to wonder where their mountain went.
  async function render(canvas, opts) {
    const gaveUp = { profile: false, smallerTime: false };
    const cfg = opts.cfg, runner = opts.runner, gpxPts = opts.gpxPts || null;
    const show = Object.assign(defaults(), opts.show || {});
    const ratio = RATIOS.find(r => r.key === opts.ratio) || RATIOS.find(r => r.key === DEFAULT_RATIO);
    const R = window.Race;
    const c = R.compute.runner(runner, cfg);

    const CW = ratio.w, CH = ratio.h;
    canvas.width = CW;
    canvas.height = CH;
    const ctx = canvas.getContext('2d');

    // Webfonts have to be in before anything is measured, or the card is laid
    // out in a fallback face and set in the real one.
    if (document.fonts && document.fonts.ready) {
      try {
        await Promise.all([
          document.fonts.load(`700 200px ${DISPLAY}`),
          document.fonts.load(`600 60px ${DISPLAY}`),
          document.fonts.load(`500 20px ${MONO}`)
        ]);
        await document.fonts.ready;
      } catch (e) { /* fallback faces still produce a card */ }
    }

    ctx.fillStyle = C.void;
    ctx.fillRect(0, 0, CW, CH);
    const wash = ctx.createRadialGradient(CW * 0.12, -CH * 0.1, 40, CW * 0.12, -CH * 0.1, Math.max(CW, CH) * 0.95);
    wash.addColorStop(0, 'rgba(15,184,191,0.16)');
    wash.addColorStop(1, 'rgba(15,184,191,0)');
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, CW, CH);
    ctx.textBaseline = 'alphabetic';

    // --- the numbers, before deciding how much room they need ---
    const legSecs = (c.legDurations || []).filter(n => n > 0);
    const longest = legSecs.length ? Math.max.apply(null, legSecs) : null;
    const totalH = cfg.cutoffs && cfg.cutoffs.totalHours;
    const spare = (totalH && c.completedRaceSec) ? totalH * 3600 - c.completedRaceSec : null;
    const hasCutoff = show.cutoff && spare != null && spare > 0;

    const allStats = {
      distance: ['Distance', R.units.distance(c.milesDone || c.courseDist || 0, cfg)],
      climb:    ['Climb', c.elevGainFt != null
                  ? Math.round(R.units.elevationVal(c.elevGainFt, cfg)).toLocaleString() + ' ' + R.units.elevationLabel(cfg)
                  : '–'],
      pace:     ['Pace', R.units.pace(c.paceSecPerMile, cfg)],
      segments: ['Segments', `${c.legsDone}/${c.totalLegs}`],
      aid:      ['In aid', c.completedPitSec ? compactDur(c.completedPitSec) : '–'],
      longest:  ['Longest leg', longest ? compactDur(longest) : '–']
    };
    const stats = PARTS.filter(p => p.kind === 'stat' && show[p.key]).map(p => allStats[p.key]);

    const FOOT = 92;
    const bottom = CH - PAD - FOOT + 46;   // the rule sits at CH - PAD - 46

    if (ratio.mode === 'stack') {
      const colW = CW - PAD * 2;
      const idH = identityHeight(show, cfg);
      const stH = statsHeight(stats, 3);
      const room = (CH - PAD - FOOT) - PAD;
      const fixedFor = px => idH + finishHeight(hasCutoff, px) + 34 + (stH ? 48 + stH : 0);

      // The course takes what the rest does not. A square holds the same
      // content in less height than the tall frame, so when it will not fit
      // the giving-up happens in a deliberate order: the huge number comes
      // down first, then the course gets thin, and only if there is still no
      // room does the course go. It never runs into the footer.
      let finPx = 208;
      let profileH = show.profile ? room - fixedFor(finPx) : 0;
      if (show.profile && profileH < 150) { finPx = 150; gaveUp.smallerTime = true; profileH = room - fixedFor(finPx); }
      if (show.profile && profileH < 110) { profileH = 0; gaveUp.profile = true; }
      profileH = Math.max(0, Math.min(620, profileH));

      const slack = Math.max(0, room - fixedFor(finPx) - profileH);
      let y = PAD + Math.round(slack / 2);

      y += await drawIdentity(ctx, PAD, y, colW, cfg, runner, show);
      y += drawFinish(ctx, PAD, y, colW, R, c, totalH, spare, hasCutoff, finPx);
      y += 34;
      if (profileH > 0) {
        drawProfile(ctx, { x: PAD, y: y, w: colW, h: profileH }, cfg, runner, c, gpxPts);
        y += profileH;
      }
      if (stH) { y += 48; drawStats(ctx, PAD, y, colW, stats, 3); }
    } else {
      // Two columns. The left is who and how long, the right is the course and
      // the numbers off it, which is the split a person reads anyway.
      const gutter = 64;
      const leftW = Math.round((CW - PAD * 2 - gutter) * 0.44);
      const rightX = PAD + leftW + gutter;
      const rightW = CW - PAD - rightX;

      const idH = identityHeight(show, cfg);
      const fiH = finishHeight(hasCutoff, 208);
      const leftH = idH + fiH;
      const leftSlack = Math.max(0, (bottom - 46 - PAD) - leftH);
      let ly = PAD + Math.round(leftSlack / 2);
      ly += await drawIdentity(ctx, PAD, ly, leftW, cfg, runner, show);
      drawFinish(ctx, PAD, ly, leftW, R, c, totalH, spare, hasCutoff);

      const cols = rightW > 700 ? 3 : 2;
      const stH = statsHeight(stats, cols);
      const roomR = (CH - PAD - FOOT) - PAD;
      let profileH = show.profile ? Math.max(150, Math.min(760, roomR - (stH ? stH + 48 : 0))) : 0;
      const rSlack = Math.max(0, roomR - profileH - (stH ? stH + 48 : 0));
      let ry = PAD + Math.round(rSlack / 2);
      if (profileH > 0) {
        drawProfile(ctx, { x: rightX, y: ry, w: rightW, h: profileH }, cfg, runner, c, gpxPts);
        ry += profileH;
      }
      if (stH) { ry += 48; drawStats(ctx, rightX, ry, rightW, stats, cols); }
    }

    drawFooter(ctx, CW, CH, cfg, show);
    return gaveUp;
  }

  // ---------- the modal ----------
  function open(opts) {
    const prefs = loadPrefs();
    const show = prefs.show;
    let ratio = prefs.ratio;

    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    ov.innerHTML =
      '<div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="fc-title" style="max-width:620px;">' +
        '<div class="modal-title" id="fc-title">Finish card</div>' +
        '<div class="fc-stage"><canvas id="fc-canvas"></canvas></div>' +
        '<div class="fc-ratios" id="fc-ratios" role="group" aria-label="Image shape">' +
          RATIOS.map(r => `<button type="button" class="fc-ratio" data-ratio="${r.key}"` +
            `${r.key === ratio ? ' aria-pressed="true"' : ' aria-pressed="false"'}>${r.label}</button>`).join('') +
        '</div>' +
        '<div class="fc-parts" id="fc-parts"></div>' +
        '<p class="modal-hint" id="fc-hint">Drawing…</p>' +
        '<div class="modal-actions" style="margin-top:12px;">' +
          '<button class="btn" id="fc-close">Close</button>' +
          '<button class="btn" id="fc-share" hidden>Share</button>' +
          '<button class="btn primary" id="fc-save">Save image</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);

    const close = () => { document.removeEventListener('keydown', onKey, true); ov.remove(); };
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }
    document.addEventListener('keydown', onKey, true);
    ov.addEventListener('click', e => { if (e.target === ov) close(); });
    ov.querySelector('#fc-close').addEventListener('click', close);

    const canvas = ov.querySelector('#fc-canvas');
    const hint = ov.querySelector('#fc-hint');
    const save = ov.querySelector('#fc-save');
    const share = ov.querySelector('#fc-share');
    const parts = ov.querySelector('#fc-parts');
    const ratios = ov.querySelector('#fc-ratios');

    // A switch with nothing behind it is not offered: a race with no location
    // should not have a control that does nothing.
    const c0 = window.Race ? Race.compute.runner(opts.runner, opts.cfg) : null;
    const spare0 = (opts.cfg.cutoffs && opts.cfg.cutoffs.totalHours && c0)
      ? opts.cfg.cutoffs.totalHours * 3600 - (c0.completedRaceSec || 0) : null;
    const offered = PARTS.filter(p => {
      if (p.key === 'location') return !!opts.cfg.location;
      if (p.key === 'cutoff') return spare0 != null && spare0 > 0;
      if (p.key === 'date') return !!opts.cfg.startTime;
      return true;
    });
    parts.innerHTML =
      '<span class="fc-parts-title">On the card</span>' +
      offered.map(p =>
        `<label class="fc-part"><input type="checkbox" data-part="${p.key}"${show[p.key] ? ' checked' : ''}>` +
        `<span>${p.label}</span></label>`).join('');

    const base = `${(opts.cfg.name || 'race').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-` +
                 `${(opts.runner.name || opts.runner.id || 'finish').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const fileName = () => `${base}-${ratio.replace(':', 'x')}.png`;
    const toBlob = () => new Promise(res => canvas.toBlob(res, 'image/png'));

    let drawing = null;
    function draw() {
      drawing = render(canvas, { cfg: opts.cfg, runner: opts.runner, gpxPts: opts.gpxPts, show, ratio })
        .then((gaveUp) => {
          const r = RATIOS.find(x => x.key === ratio);
          let msg = `${r.w} × ${r.h}. Made on this device, nothing is uploaded.`;
          if (gaveUp && gaveUp.profile && show.profile) {
            msg = `${r.w} × ${r.h}. No room for the course at this shape: switch off a number, or try 4:5.`;
          }
          hint.textContent = msg;
        })
        .catch(err => { hint.textContent = 'Could not draw the card: ' + (err && err.message ? err.message : 'unknown'); });
      return drawing;
    }

    parts.addEventListener('change', (e) => {
      const key = e.target.dataset.part;
      if (!key) return;
      show[key] = e.target.checked;
      savePrefs(show, ratio);
      draw();
    });
    ratios.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-ratio]');
      if (!btn) return;
      ratio = btn.dataset.ratio;
      ratios.querySelectorAll('[data-ratio]').forEach(b =>
        b.setAttribute('aria-pressed', String(b.dataset.ratio === ratio)));
      savePrefs(show, ratio);
      draw();
    });

    draw().then(async () => {
      try {
        const blob = await toBlob();
        const file = new File([blob], fileName(), { type: 'image/png' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          share.hidden = false;
          share.addEventListener('click', async () => {
            // Re-made at press time so it carries the shape and the switches
            // as they stand now, not as they stood when the modal opened.
            await drawing;
            const b2 = await toBlob();
            try {
              await navigator.share({ files: [new File([b2], fileName(), { type: 'image/png' })],
                                      title: opts.cfg.name || 'Finish' });
            } catch (e) { /* dismissed */ }
          });
        }
      } catch (e) { /* saving is the path that always works */ }
    });

    save.addEventListener('click', async () => {
      await drawing;
      const blob = await toBlob();
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName();
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    });
  }

  window.FinishCard = { render: render, open: open, parts: PARTS, ratios: RATIOS };
})();
