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

  // Instagram's portrait frame. The tallest thing a feed will show without
  // cropping, which buys room for the profile and the splits under it.
  const W = 1080, H = 1350;
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
  // Order is the order they are drawn. `stat` items share the grid under the
  // profile and reflow when one is switched off, so turning off Pace closes
  // the gap rather than leaving one.
  const PARTS = [
    { key: 'location', label: 'Location',    kind: 'line' },
    { key: 'cutoff',   label: 'Cutoff margin', kind: 'line' },
    { key: 'profile',  label: 'Course profile', kind: 'block' },
    { key: 'distance', label: 'Distance',    kind: 'stat' },
    { key: 'climb',    label: 'Climb',       kind: 'stat' },
    { key: 'pace',     label: 'Pace',        kind: 'stat' },
    { key: 'segments', label: 'Segments',    kind: 'stat' },
    { key: 'aid',      label: 'Time in aid', kind: 'stat' },
    { key: 'longest',  label: 'Longest leg', kind: 'stat' },
    { key: 'date',     label: 'Date',        kind: 'line' }
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
    const d = defaults();
    try {
      const raw = localStorage.getItem(PREF_KEY);
      if (!raw) return d;
      const saved = JSON.parse(raw);
      for (const p of PARTS) if (typeof saved[p.key] === 'boolean') d[p.key] = saved[p.key];
    } catch (e) { /* a fresh card is the right fallback */ }
    return d;
  }
  function savePrefs(show) {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(show)); } catch (e) {}
  }

  // ---------- the card ----------
  async function render(canvas, opts) {
    const cfg = opts.cfg, runner = opts.runner, gpxPts = opts.gpxPts || null;
    const show = Object.assign(defaults(), opts.show || {});
    const R = window.Race;
    const c = R.compute.runner(runner, cfg);

    canvas.width = W;
    canvas.height = H;
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
    ctx.fillRect(0, 0, W, H);
    const wash = ctx.createRadialGradient(W * 0.12, -H * 0.1, 40, W * 0.12, -H * 0.1, H * 0.95);
    wash.addColorStop(0, 'rgba(15,184,191,0.16)');
    wash.addColorStop(1, 'rgba(15,184,191,0)');
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = 'alphabetic';

    // --- what the numbers say, before deciding how much room they need ---
    const u = R.units.of(cfg);
    const legSecs = (c.legDurations || []).filter(n => n > 0);
    const longest = legSecs.length ? Math.max.apply(null, legSecs) : null;
    const totalH = cfg.cutoffs && cfg.cutoffs.totalHours;
    const spare = (totalH && c.completedRaceSec) ? totalH * 3600 - c.completedRaceSec : null;

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
    const statRows = Math.ceil(stats.length / 3);

    const hasLocation = show.location && !!cfg.location;
    const hasCutoff   = show.cutoff && spare != null && spare > 0;

    // --- the layout, decided from what is actually on ---
    // Everything except the profile has a known height, so the profile takes
    // whatever is left. Switching a row off makes the course bigger rather
    // than leaving a hole under it, which is why nothing here needs a filler.
    const H_WORDMARK = 128, H_NAME = 46, H_RACE = 34, H_LOC = 30;
    const H_FINISH_LABEL = 22, H_FINISH = 208 * 0.76 + 44, H_CUTOFF = 30;
    const H_STATROW = 104, H_STATROW2 = 98, H_GAP_BEFORE_STATS = 48;
    const bottomLimit = H - PAD - 92;   // above the rule and the footer

    let fixed = PAD + H_WORDMARK + H_NAME + H_RACE + (hasLocation ? H_LOC : 0)
              + 46 + H_FINISH_LABEL + H_FINISH + (hasCutoff ? H_CUTOFF : 0) + 34;
    if (statRows) fixed += H_GAP_BEFORE_STATS + H_STATROW + (statRows - 1) * H_STATROW2;

    // The profile stretches to fill a full-height card. With it switched off
    // there is nothing to stretch, so the card is cropped to what it holds
    // rather than padded out with a hole: turning things off gives a tighter
    // card, never an emptier one.
    const FOOT = 92;
    let profileH = 0;
    if (show.profile) profileH = Math.max(150, Math.min(470, bottomLimit - fixed));
    const cardH = Math.max(880, Math.min(H, Math.round(fixed + profileH + FOOT)));

    // Repaint the ground at the height actually needed.
    canvas.height = cardH;
    ctx.fillStyle = C.void;
    ctx.fillRect(0, 0, W, cardH);
    const wash2 = ctx.createRadialGradient(W * 0.12, -cardH * 0.1, 40, W * 0.12, -cardH * 0.1, cardH * 0.95);
    wash2.addColorStop(0, 'rgba(15,184,191,0.16)');
    wash2.addColorStop(1, 'rgba(15,184,191,0)');
    ctx.fillStyle = wash2;
    ctx.fillRect(0, 0, W, cardH);
    ctx.textBaseline = 'alphabetic';

    let y = PAD;

    // --- wordmark ---
    const wm = await wordmarkImage();
    if (wm) {
      const wmH = 46, wmW = wmH * (3781 / 1317.6);
      ctx.drawImage(wm, PAD, y - 6, wmW, wmH);
    }
    y += H_WORDMARK;

    // --- who and what ---
    const name = esc(runner.name || runner.id || 'Finisher');
    const namePx = fitText(ctx, name, W - PAD * 2, 86, DISPLAY, 700);
    ctx.font = `700 ${namePx}px ${DISPLAY}`;
    ctx.fillStyle = C.ink;
    ctx.fillText(name, PAD, y);
    y += H_NAME;

    const race = esc(cfg.name || '').toUpperCase();
    const racePx = fitText(ctx, race, W - PAD * 2, 30, MONO, 500);
    ctx.font = `500 ${racePx}px ${MONO}`;
    ctx.fillStyle = C.signal;
    ctx.letterSpacing = '4px';
    ctx.fillText(race, PAD, y);
    ctx.letterSpacing = '0px';
    y += H_RACE;

    if (hasLocation) {
      ctx.font = `400 23px ${MONO}`;
      ctx.fillStyle = C.muted;
      ctx.fillText(esc(cfg.location), PAD, y);
      y += H_LOC;
    }

    // --- the number ---
    y += 46;
    label(ctx, 'Finish time', PAD, y, C.muted);
    y += H_FINISH_LABEL;
    const finish = R.fmt.duration(c.completedRaceSec || 0);
    const finPx = fitText(ctx, finish, W - PAD * 2, 208, DISPLAY, 700);
    ctx.font = `700 ${finPx}px ${DISPLAY}`;
    ctx.fillStyle = C.ink;
    ctx.fillText(finish, PAD, y + finPx * 0.76);
    y += H_FINISH;

    if (hasCutoff) {
      ctx.font = `500 27px ${MONO}`;
      ctx.fillStyle = C.green;
      ctx.fillText(`${compactDur(spare)} inside the ${totalH}h cutoff`, PAD, y);
      y += H_CUTOFF;
    }
    y += 34;

    // --- the course, as drawn by the day ---
    if (profileH > 0) {
      drawProfile(ctx, { x: PAD, y: y, w: W - PAD * 2, h: profileH }, cfg, runner, c, gpxPts);
      y += profileH;
    }

    // --- the numbers, three to a row, reflowing as they are switched off ---
    if (stats.length) {
      y += H_GAP_BEFORE_STATS;
      const colW = (W - PAD * 2) / Math.min(3, stats.length);
      stats.forEach((sv, i) => {
        const row = Math.floor(i / 3), col = i % 3;
        const x = PAD + col * colW;
        const rowY = y + row * H_STATROW2;
        label(ctx, sv[0], x, rowY, C.muted);
        const big = row === 0;
        const vPx = fitText(ctx, sv[1], colW - 20, big ? 52 : 46, DISPLAY, 700);
        ctx.font = `700 ${vPx}px ${DISPLAY}`;
        ctx.fillStyle = big ? C.ink : C.dim;
        ctx.fillText(sv[1], x, rowY + (big ? 52 : 46));
      });
    }

    // --- rule and footer ---
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(PAD, cardH - PAD - 46);
    ctx.lineTo(W - PAD, cardH - PAD - 46);
    ctx.stroke();

    ctx.font = `400 22px ${MONO}`;
    ctx.fillStyle = C.muted;
    if (show.date && cfg.startTime) {
      ctx.fillText(new Date(cfg.startTime).toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' }),
                   PAD, cardH - PAD - 8);
    }
    ctx.textAlign = 'right';
    ctx.fillText('sendoff.run', W - PAD, cardH - PAD - 8);
    ctx.textAlign = 'left';
    void u;

    return canvas;
  }

  // ---------- the modal ----------
  function open(opts) {
    const show = loadPrefs();
    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    ov.innerHTML =
      '<div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="fc-title" style="max-width:560px;">' +
        '<div class="modal-title" id="fc-title">Finish card</div>' +
        '<canvas id="fc-canvas" style="width:100%; height:auto; display:block; border-radius:4px; ' +
          'border:1px solid var(--border); background:var(--bg);"></canvas>' +
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

    // A part with nothing behind it is not offered: a race with no location
    // should not have a switch that does nothing.
    const spare = (opts.cfg.cutoffs && opts.cfg.cutoffs.totalHours && window.Race)
      ? opts.cfg.cutoffs.totalHours * 3600 - (Race.compute.runner(opts.runner, opts.cfg).completedRaceSec || 0)
      : null;
    const offered = PARTS.filter(p => {
      if (p.key === 'location') return !!opts.cfg.location;
      if (p.key === 'cutoff') return spare != null && spare > 0;
      if (p.key === 'date') return !!opts.cfg.startTime;
      if (p.key === 'climb') return true;
      return true;
    });

    parts.innerHTML =
      '<span class="fc-parts-title">On the card</span>' +
      offered.map(p =>
        `<label class="fc-part"><input type="checkbox" data-part="${p.key}"${show[p.key] ? ' checked' : ''}>` +
        `<span>${p.label}</span></label>`).join('');

    const fileName = `${(opts.cfg.name || 'race').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-` +
                     `${(opts.runner.name || opts.runner.id || 'finish').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`;
    const toBlob = () => new Promise(res => canvas.toBlob(res, 'image/png'));

    let drawing = null;
    function draw() {
      drawing = render(canvas, { cfg: opts.cfg, runner: opts.runner, gpxPts: opts.gpxPts, show })
        .then(() => { hint.textContent = 'Made on this device. Nothing is uploaded.'; })
        .catch(err => { hint.textContent = 'Could not draw the card: ' + (err && err.message ? err.message : 'unknown'); });
      return drawing;
    }

    parts.addEventListener('change', (e) => {
      const key = e.target.dataset.part;
      if (!key) return;
      show[key] = e.target.checked;
      savePrefs(show);
      draw();
    });

    draw().then(async () => {
      try {
        const blob = await toBlob();
        const file = new File([blob], fileName, { type: 'image/png' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          share.hidden = false;
          share.addEventListener('click', async () => {
            // Re-made at press time so it carries whatever is switched on now.
            await drawing;
            const b2 = await toBlob();
            try {
              await navigator.share({ files: [new File([b2], fileName, { type: 'image/png' })],
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
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    });
  }

  window.FinishCard = { render: render, open: open, parts: PARTS, W: W, H: H };
})();
