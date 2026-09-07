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

  // Hours and minutes, said the way a person says them. The seconds matter in
  // a finish time and not at all in the margin around it.
  function compactDur(sec) {
    const total = Math.max(0, Math.round(sec / 60));
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

  // ---------- the card ----------
  async function render(canvas, opts) {
    const cfg = opts.cfg, runner = opts.runner, gpxPts = opts.gpxPts || null;
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
    // A single wash from the top left, so the card is not a flat rectangle.
    const wash = ctx.createRadialGradient(W * 0.12, -H * 0.1, 40, W * 0.12, -H * 0.1, H * 0.95);
    wash.addColorStop(0, 'rgba(15,184,191,0.16)');
    wash.addColorStop(1, 'rgba(15,184,191,0)');
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, W, H);

    ctx.textBaseline = 'alphabetic';
    let y = PAD;

    // --- wordmark ---
    const wm = await wordmarkImage();
    if (wm) {
      const wmH = 46, wmW = wmH * (3781 / 1317.6);
      ctx.drawImage(wm, PAD, y - 6, wmW, wmH);
    }
    y += 128;

    // --- who and what ---
    const name = esc(runner.name || runner.id || 'Finisher');
    const namePx = fitText(ctx, name, W - PAD * 2, 86, DISPLAY, 700);
    ctx.font = `700 ${namePx}px ${DISPLAY}`;
    ctx.fillStyle = C.ink;
    ctx.fillText(name, PAD, y);
    y += 46;

    const race = esc(cfg.name || '').toUpperCase();
    const racePx = fitText(ctx, race, W - PAD * 2, 30, MONO, 500);
    ctx.font = `500 ${racePx}px ${MONO}`;
    ctx.fillStyle = C.signal;
    ctx.letterSpacing = '4px';
    ctx.fillText(race, PAD, y);
    ctx.letterSpacing = '0px';
    y += 34;

    if (cfg.location) {
      ctx.font = `400 23px ${MONO}`;
      ctx.fillStyle = C.muted;
      ctx.fillText(esc(cfg.location), PAD, y);
      y += 30;
    }

    // --- the number ---
    y += 46;
    label(ctx, 'Finish time', PAD, y, C.muted);
    y += 22;
    const finish = R.fmt.duration(c.completedRaceSec || 0);
    const finPx = fitText(ctx, finish, W - PAD * 2, 208, DISPLAY, 700);
    ctx.font = `700 ${finPx}px ${DISPLAY}`;
    ctx.fillStyle = C.ink;
    ctx.fillText(finish, PAD, y + finPx * 0.76);
    y += finPx * 0.76 + 44;

    // Room to spare is the number a finisher feels, and it is the one nobody
    // else's card has, because it needs the cutoff this race actually set.
    const totalH = cfg.cutoffs && cfg.cutoffs.totalHours;
    if (totalH && c.completedRaceSec) {
      const spare = totalH * 3600 - c.completedRaceSec;
      if (spare > 0) {
        ctx.font = `500 27px ${MONO}`;
        ctx.fillStyle = C.green;
        ctx.fillText(`${compactDur(spare)} inside the ${totalH}h cutoff`, PAD, y);
        y += 30;
      }
    }
    y += 34;

    // --- the course, as drawn by the day ---
    drawProfile(ctx, { x: PAD, y: y, w: W - PAD * 2, h: 300 }, cfg, runner, c, gpxPts);
    y += 300 + 48;

    // --- the numbers under it: one object, three columns ---
    const u = R.units.of(cfg);
    const stats = [
      ['Distance', R.units.distance(c.milesDone || c.courseDist || 0, cfg)],
      ['Climb', c.elevGainFt != null
        ? Math.round(R.units.elevationVal(c.elevGainFt, cfg)).toLocaleString() + ' ' + R.units.elevationLabel(cfg)
        : '–'],
      ['Pace', R.units.pace(c.paceSecPerMile, cfg)]
    ];
    const colW = (W - PAD * 2) / 3;
    stats.forEach((s, i) => {
      const x = PAD + i * colW;
      label(ctx, s[0], x, y, C.muted);
      const vPx = fitText(ctx, s[1], colW - 20, 52, DISPLAY, 700);
      ctx.font = `700 ${vPx}px ${DISPLAY}`;
      ctx.fillStyle = C.ink;
      ctx.fillText(s[1], x, y + 52);
    });
    y += 104;

    // The second row is the shape of the day rather than the shape of the
    // course: how much of it was spent standing still, and the leg that hurt.
    const legSecs = (c.legDurations || []).filter(n => n > 0);
    const longest = legSecs.length ? Math.max.apply(null, legSecs) : null;
    const started = cfg.startTime
      ? new Date(cfg.startTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '–';
    const row2 = [
      ['Segments', `${c.legsDone}/${c.totalLegs}`],
      ['In aid', c.completedPitSec ? compactDur(c.completedPitSec) : '–'],
      ['Longest leg', longest ? compactDur(longest) : '–']
    ];
    row2.forEach((sv, i) => {
      const x = PAD + i * colW;
      label(ctx, sv[0], x, y, C.muted);
      const vPx = fitText(ctx, sv[1], colW - 20, 46, DISPLAY, 700);
      ctx.font = `700 ${vPx}px ${DISPLAY}`;
      ctx.fillStyle = C.dim;
      ctx.fillText(sv[1], x, y + 46);
    });
    void started;
    y += 78;

    // --- rule and footer ---
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(PAD, H - PAD - 46);
    ctx.lineTo(W - PAD, H - PAD - 46);
    ctx.stroke();

    const when = cfg.startTime
      ? new Date(cfg.startTime).toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' })
      : '';
    ctx.font = `400 22px ${MONO}`;
    ctx.fillStyle = C.muted;
    ctx.fillText(when, PAD, H - PAD - 8);
    const legsTxt = `${c.legsDone}/${c.totalLegs} segments`;
    ctx.textAlign = 'right';
    ctx.fillText('sendoff.run', W - PAD, H - PAD - 8);
    ctx.textAlign = 'left';
    void legsTxt; void u;

    return canvas;
  }

  // ---------- the modal ----------
  function open(opts) {
    const R = window.Race;
    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    ov.innerHTML =
      '<div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="fc-title" style="max-width:520px;">' +
        '<div class="modal-title" id="fc-title">Finish card</div>' +
        '<p class="modal-hint" id="fc-hint">Drawing…</p>' +
        '<canvas id="fc-canvas" style="width:100%; height:auto; display:block; border-radius:4px; ' +
          'border:1px solid var(--border); background:var(--bg);"></canvas>' +
        '<div class="modal-actions" style="margin-top:14px;">' +
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

    const fileName = `${(opts.cfg.name || 'race').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-` +
                     `${(opts.runner.name || opts.runner.id || 'finish').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`;

    const toBlob = () => new Promise(res => canvas.toBlob(res, 'image/png'));

    render(canvas, opts).then(async () => {
      hint.textContent = 'Made on this device. Nothing is uploaded.';
      // On a phone this hands the image straight to Messages or Instagram,
      // which is the whole point; on a desktop it is not offered.
      try {
        const blob = await toBlob();
        const file = new File([blob], fileName, { type: 'image/png' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          share.hidden = false;
          share.addEventListener('click', async () => {
            try {
              await navigator.share({ files: [file], title: opts.cfg.name || 'Finish' });
            } catch (e) { /* dismissed */ }
          });
        }
      } catch (e) { /* share is a bonus; saving is the path that always works */ }
    }).catch(err => {
      hint.textContent = 'Could not draw the card: ' + (err && err.message ? err.message : 'unknown error');
    });

    save.addEventListener('click', async () => {
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

    void R;
  }

  window.FinishCard = { render: render, open: open, W: W, H: H };
})();
