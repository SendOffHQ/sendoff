// The course, drawn: a map of the route and an elevation profile, with the aid
// stations on both and a dot for where each racer probably is.
//
// One copy for the race page and the pit board. It started inside race.html;
// the crew asked for it on the pit board so they would have little reason to
// switch pages mid-race, and two copies of three hundred lines is two things
// to keep in step.
//
//   const view = CourseView.mount(host, { slug, cfg: () => cfg, runners: () => list });
//   view.load();     // reads course.gpx once it can; call again until it has
//   view.update();   // moves the racer dots; cheap, so call it every second
//
// `host` is an empty element. It stays hidden until there is a course to show,
// so a race without a GPX looks exactly as it did. The map needs Leaflet on the
// page and is left out without it; the profile is plain SVG and always draws.
// Positions are Race.compute.predictedMileage, an estimate from pace, and are
// labelled as one.
//
// A loop course of more than one loop can give each loop a course file of its
// own (Race.course.loopPattern's gpx). Then every loop is drawn, the one a
// racer is on (or about to start, from the pit) bright and the rest dim, each
// racer's dot sits on their own loop, and a row of chips picks which loop's
// profile is shown, the active one until somebody picks another.
(function () {
  const AID_END_COLOR = '#6ee7a8';
  const AID_MID_COLOR = '#0fb8bf';
  const IDLE_LOOP_COLOR = '#5b6b78';
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // The GPX point nearest a given cumulative mileage.
  function nearestGpxPoint(pts, mi) {
    let best = pts[0], bestDiff = Infinity;
    for (const p of pts) {
      const diff = Math.abs((p.dist || 0) - mi);
      if (diff < bestDiff) { bestDiff = diff; best = p; }
    }
    return best;
  }

  function mount(host, opts) {
    if (!host) return { load() {}, update() {} };
    const Race = window.Race;
    const cfg = () => opts.cfg() || {};
    const runners = () => (opts.runners && opts.runners()) || [];
    host.classList.add('course-view');
    host.style.display = 'none';
    host.innerHTML = `
      <div class="course-map-head">
        <span class="course-map-title">${esc(opts.title || 'Course')}</span>
        <span class="course-map-meta"></span>
      </div>
      <div class="course-map"></div>
      <div class="course-loops" hidden></div>
      <svg class="course-elev" viewBox="0 0 1000 200"></svg>`;
    const mapEl = host.querySelector('.course-map');
    const svg = host.querySelector('.course-elev');
    const chips = host.querySelector('.course-loops');

    let ready = false, loading = false;
    let map = null, pts = null, elevX = null, elevY = null;
    const markers = {};
    // Several loops: a track per loop that has a file, by its place in the
    // pattern. `pts` is then whichever loop's profile is showing.
    let tracks = null, picked = null, shownLoop = null, activeKey = '';
    const lines = {};

    // A loop course with more than one loop, at least one of which has a
    // course file of its own.
    const multi = () => {
      const c = cfg();
      return c.courseType === 'loops' && Race.course.loopPattern(c).length > 1;
    };

    async function load() {
      if (ready || loading || !opts.slug) return;
      loading = true;
      try {
        if (multi()) { await loadLoops(); return; }
        // Through the worker first, like config.json and data.json, so the
        // course is not the one thing still waiting on the Pages rebuild. Null
        // means no GPX, or none reachable yet; the caller tries again later.
        const text = await Race.gh.readRaceText(opts.slug, 'course.gpx', true);
        if (!text) return;
        let parsed;
        try { parsed = Race.gpx.parse(text); } catch (e) { return; }
        if (!parsed.length) return;
        pts = parsed;
        ready = true;
        host.style.display = '';
        draw();
        update();
      } finally {
        loading = false;
      }
    }

    // Each loop's file, read side by side. A loop with no file is left off the
    // map; the rest still draw.
    async function loadLoops() {
      const pat = Race.course.loopPattern(cfg());
      const got = await Promise.all(pat.map(async (l) => {
        if (!l.gpx) return null;
        try {
          const text = await Race.gh.readRaceText(opts.slug, l.gpx, true);
          const p = text ? Race.gpx.parse(text) : null;
          return p && p.length ? { loop: l, pts: p } : null;
        } catch (e) { return null; }
      }));
      if (!got.some(Boolean)) return;
      tracks = got;
      ready = true;
      host.style.display = '';
      drawLoops();
      update();
    }

    // The stations on one loop, as the aid list the profile and the map take.
    function loopAids(l) {
      return l.segments.length
        ? Race.course.aidStations({ courseType: 'loops', course: { loopSegments: l.segments, startAid: cfg().course?.startAid } })
        : [{ name: 'Pit', mileage: 0 }, { name: 'Pit', mileage: l.distanceMi }];
    }

    // Which loop's profile to show: the one picked, else the first one a
    // racer is on, else the first with a file.
    function profileLoop(active) {
      if (picked != null && tracks[picked]) return picked;
      for (const i of active) if (tracks[i]) return i;
      return tracks.findIndex(Boolean);
    }

    function drawLoops() {
      const c = cfg();
      if (typeof L !== 'undefined') {
        map = L.map(mapEl, { scrollWheelZoom: false });
        L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
          attribution: 'Tiles &copy; <a href="https://www.esri.com/">Esri</a> &mdash; Esri, HERE, Garmin, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
          maxZoom: 16
        }).addTo(map);
        let bounds = null;
        const placed = [];
        tracks.forEach((t, i) => {
          if (!t) return;
          lines[i] = L.polyline(t.pts.map(p => [p.lat, p.lon]), { color: IDLE_LOOP_COLOR, weight: 3, opacity: 0.6 })
            .addTo(map).bindTooltip(esc(t.loop.name), { sticky: true, className: 'aid-marker-label' });
          bounds = bounds ? bounds.extend(lines[i].getBounds()) : lines[i].getBounds();
          const aids = loopAids(t.loop);
          aids.forEach((aid, k) => {
            const p = nearestGpxPoint(t.pts, aid.mileage);
            placed.push({ name: `${t.loop.name} · ${aid.name}`, mileage: aid.mileage, isEnd: k === 0 || k === aids.length - 1, lat: p.lat, lon: p.lon });
          });
        });
        if (bounds) map.fitBounds(bounds, { padding: [24, 24] });
        Race.gpx.clusterStops(placed).forEach(group => {
          const isEnd = group.members.some(m => m.isEnd);
          const label = group.members.map(m => `${esc(m.name)} · ${Race.units.distance(m.mileage, c)}`).join('<br>');
          L.circleMarker([group.lat, group.lon], {
            radius: isEnd ? 6 : 5, color: '#fff', weight: 2,
            fillColor: isEnd ? AID_END_COLOR : AID_MID_COLOR, fillOpacity: 1
          }).addTo(map).bindTooltip(label, { className: 'aid-marker-label', direction: 'top' });
        });
      } else {
        mapEl.style.display = 'none';
      }
      // A chip per loop, which picks its profile; the loops a racer is on are
      // marked on them as well as on the map.
      chips.hidden = false;
      chips.innerHTML = tracks.map((t, i) => t
        ? `<button type="button" class="course-loop-chip" data-loop="${i}"><span class="sw"></span>${esc(t.loop.name)} <span class="mi">${esc(Race.units.distance(t.loop.distanceMi, c))}</span></button>`
        : '').join('');
      chips.addEventListener('click', (e) => {
        const b = e.target.closest('[data-loop]');
        if (!b) return;
        picked = +b.dataset.loop;
        shownLoop = null;
        update();
      });
    }

    // One loop's profile, with that loop's stations on it.
    function showProfile(i) {
      if (i === shownLoop || i < 0 || !tracks[i]) return;
      shownLoop = i;
      pts = tracks[i].pts;
      const c = cfg();
      const elev = Race.gpx.totalElevation(pts);
      host.querySelector('.course-map-meta').textContent =
        `${tracks[i].loop.name} · ${Race.units.distance(Race.gpx.totalDistanceMi(pts), c)} · +${Math.round(Race.units.elevationVal(elev.gainFt, c)).toLocaleString()} / -${Math.round(Race.units.elevationVal(elev.lossFt, c)).toLocaleString()} ${Race.units.elevationLabel(c)}`;
      try { drawProfile(loopAids(tracks[i].loop)); } catch (e) {}
      chips.querySelectorAll('[data-loop]').forEach(b => b.classList.toggle('shown', +b.dataset.loop === i));
    }

    // Where a racer is on a course of several loops: the loop their lap is,
    // and how far round it.
    function onLoop(pos) {
      const c = cfg();
      if (!pos || !pos.lap) return null;
      const l = Race.course.lapLoop(c, pos.lap);
      if (!l) return null;
      return { index: l.index, mi: Math.max(0, pos.courseMi - Race.course.lapsDistance(c, pos.lap - 1)) };
    }

    function updateLoops() {
      const list = runners();
      // The loops anyone is on, or about to start from the pit.
      const active = [];
      list.forEach(r => {
        const pos = Race.compute.predictedMileage(r, cfg());
        if (pos.state === 'finished' || !pos.nextLap) return;
        const l = Race.course.lapLoop(cfg(), pos.nextLap);
        if (l && !active.includes(l.index)) active.push(l.index);
      });
      const key = active.join(',');
      if (key !== activeKey) {
        activeKey = key;
        Object.keys(lines).forEach(i => {
          const on = active.includes(+i);
          lines[i].setStyle(on ? { color: AID_MID_COLOR, weight: 4, opacity: 1 } : { color: IDLE_LOOP_COLOR, weight: 3, opacity: 0.6 });
          if (on) lines[i].bringToFront();
        });
        chips.querySelectorAll('[data-loop]').forEach(b => b.classList.toggle('active', active.includes(+b.dataset.loop)));
      }
      showProfile(profileLoop(active));

      if (map) {
        const live = new Set();
        list.forEach(r => {
          const pos = position(r);
          const at = onLoop(pos);
          if (!pos || !at || !tracks[at.index]) return;
          live.add(r.id);
          const p = nearestGpxPoint(tracks[at.index].pts, at.mi);
          const color = r.color || AID_MID_COLOR;
          const text = `${r.name} · ${label(pos)}`;
          let m = markers[r.id];
          if (m) {
            m.setLatLng([p.lat, p.lon]); m.setStyle({ fillColor: color }); m.setTooltipContent(text);
          } else {
            m = L.circleMarker([p.lat, p.lon], { radius: 7, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1, className: 'runner-dot' })
              .addTo(map).bindTooltip(text, { permanent: true, direction: 'right', offset: [8, 0], className: 'runner-dot-label' });
            markers[r.id] = m;
          }
          m.bringToFront();
        });
        Object.keys(markers).forEach(id => {
          if (!live.has(id)) { map.removeLayer(markers[id]); delete markers[id]; }
        });
      }

      // On the profile, only the racers on the loop it shows.
      const g = svg.querySelector('.elev-runners');
      if (g && elevX && elevY && pts) {
        g.innerHTML = list.map(r => {
          const pos = position(r);
          const at = onLoop(pos);
          if (!pos || !at || at.index !== shownLoop) return '';
          const pt = nearestGpxPoint(pts, at.mi);
          const cx = elevX(at.mi), cy = elevY(pt.ele);
          const color = r.color || AID_MID_COLOR;
          return `
            <circle class="runner-dot" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="5" fill="${color}" stroke="#0a0f14" stroke-width="1.5">
              <title>${esc(r.name)} · ${esc(label(pos))}</title>
            </circle>
            <text class="elev-runner-label" x="${cx.toFixed(1)}" y="${(cy - 9).toFixed(1)}" text-anchor="middle" fill="${color}">${esc(r.name)}</text>`;
        }).join('');
      }
    }

    function draw() {
      const c = cfg();
      const aids = Race.course.aidStations(c);
      const dist = Race.gpx.totalDistanceMi(pts);
      const elev = Race.gpx.totalElevation(pts);
      host.querySelector('.course-map-meta').textContent =
        `${Race.units.distance(dist, c)} · +${Math.round(Race.units.elevationVal(elev.gainFt, c)).toLocaleString()} / -${Math.round(Race.units.elevationVal(elev.lossFt, c)).toLocaleString()} ${Race.units.elevationLabel(c)}`;

      try { drawProfile(aids); } catch (e) {}

      if (typeof L === 'undefined') { mapEl.style.display = 'none'; return; }
      map = L.map(mapEl, { scrollWheelZoom: false });
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles &copy; <a href="https://www.esri.com/">Esri</a> &mdash; Esri, HERE, Garmin, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 16
      }).addTo(map);
      const line = L.polyline(pts.map(p => [p.lat, p.lon]), { color: AID_MID_COLOR, weight: 3, opacity: 0.9 }).addTo(map);
      map.fitBounds(line.getBounds(), { padding: [24, 24] });

      // One dot per place, not one per visit. A lapped course passes the same
      // aid four times and drew four dots a few metres apart, which read as
      // four stations. The passes are grouped and the dot sits at their
      // median; the tooltip lists every visit, so nothing is hidden by it.
      const placed = aids.map((aid, i) => {
        const p = nearestGpxPoint(pts, aid.mileage);
        return { name: aid.name, mileage: aid.mileage, isEnd: i === 0 || i === aids.length - 1, lat: p.lat, lon: p.lon };
      });
      Race.gpx.clusterStops(placed).forEach(group => {
        // Start and finish share a field at most races, so a group holding
        // either is drawn as an end.
        const isEnd = group.members.some(m => m.isEnd);
        const label = group.members.map(m => `${esc(m.name)} · ${Race.units.distance(m.mileage, c)}`).join('<br>');
        L.circleMarker([group.lat, group.lon], {
          radius: isEnd ? 6 : 5, color: '#fff', weight: 2,
          fillColor: isEnd ? AID_END_COLOR : AID_MID_COLOR, fillOpacity: 1
        }).addTo(map).bindTooltip(label, { className: 'aid-marker-label', direction: 'top' });
      });
    }

    // Elevation against distance, with the same aid markers as the map. The
    // trailing <g class="elev-runners"> is filled by update(). Drawn at the
    // width it is shown at, as the charts are, so its labels stay readable on
    // a phone, and redrawn with the racers on it when that width changes.
    let prof = { W: 1000, padL: 48, padR: 8, padT: 20 };
    function drawProfile(aids) {
      const c = cfg();
      const shown = Math.floor(svg.clientWidth || svg.getBoundingClientRect().width);
      const W = shown >= 200 ? shown : 1000;
      const H = Math.round(Math.max(120, Math.min(200, W * 0.2)));
      const padL = 48, padR = 8, padT = 20, padB = 14;
      prof = { W, padL, padR, padT };
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      Race.charts._redrawOnResize(svg, W, () => { try { drawProfile(aids); update(); } catch (e) {} });
      const plotW = W - padL - padR, plotH = H - padT - padB;
      const totalMi = pts[pts.length - 1].dist || 1;
      let minE = Infinity, maxE = -Infinity;
      for (const p of pts) { if (p.ele < minE) minE = p.ele; if (p.ele > maxE) maxE = p.ele; }
      if (maxE - minE < 1) maxE = minE + 1;
      const x = mi => padL + (Math.min(mi, totalMi) / totalMi) * plotW;
      const y = ele => padT + (1 - (ele - minE) / (maxE - minE)) * plotH;
      const baseY = padT + plotH;
      elevX = x; elevY = y;

      let scale = `<text class="elev-axis-unit" x="${padL - 6}" y="11" text-anchor="end">${Race.units.elevationLabel(c)}</text>`;
      for (let i = 0; i <= 4; i++) {
        const ele = minE + (i / 4) * (maxE - minE);
        const yy = y(ele).toFixed(1);
        const ft = Math.round(Race.units.elevationVal(Race.gpx.metersToFeet(ele), c));
        scale += `<line class="elev-grid" x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" />` +
          `<text class="elev-axis-label" x="${padL - 6}" y="${yy}" text-anchor="end" dominant-baseline="middle">${ft.toLocaleString()}</text>`;
      }
      const linePts = pts.map(p => `${x(p.dist).toFixed(1)},${y(p.ele).toFixed(1)}`);
      const areaPath = `M${x(0).toFixed(1)},${baseY.toFixed(1)} L${linePts.join(' L')} L${x(totalMi).toFixed(1)},${baseY.toFixed(1)} Z`;

      // A dot per aid; the name shows on hover (<title>) or tap.
      const marks = aids.map((aid, i) => {
        const ax = x(aid.mileage);
        const pt = nearestGpxPoint(pts, aid.mileage);
        const isEnd = i === 0 || i === aids.length - 1;
        const color = isEnd ? AID_END_COLOR : AID_MID_COLOR;
        const ft = Math.round(Race.units.elevationVal(Race.gpx.metersToFeet(pt.ele), c));
        const label = `${aid.name} · ${Race.units.distance(aid.mileage, c)}`;
        return `
          <line class="elev-aid-line" x1="${ax.toFixed(1)}" y1="${padT}" x2="${ax.toFixed(1)}" y2="${baseY.toFixed(1)}" stroke="${color}" stroke-opacity="0.3" />
          <circle class="elev-aid-dot" cx="${ax.toFixed(1)}" cy="${y(pt.ele).toFixed(1)}" r="5" fill="${color}" stroke="#0a0f14" stroke-width="1.5" data-label="${esc(label)}">
            <title>${esc(label)} · ${ft.toLocaleString()} ${Race.units.elevationLabel(c)}</title>
          </circle>`;
      }).join('');

      svg.innerHTML = `${scale}
        <path class="elev-area" d="${areaPath}" />
        <path class="elev-line" d="M${linePts.join(' L')}" />
        ${marks}
        <g class="elev-aid-popup"></g>
        <g class="elev-runners"></g>`;

    }

    // Tap an aid dot to show its name, as well as the hover <title>. Wired
    // once, reading the size the profile was last drawn at.
    svg.addEventListener('click', (e) => {
      const popup = svg.querySelector('.elev-aid-popup');
      if (!popup) return;
      const dot = e.target.closest('.elev-aid-dot');
      if (!dot) { popup.innerHTML = ''; return; }
      const { W, padL, padR, padT } = prof;
      const text = dot.getAttribute('data-label') || '';
      const cx = parseFloat(dot.getAttribute('cx')), cy = parseFloat(dot.getAttribute('cy'));
      const h = 19, w = text.length * 6.3 + 16;
      const bx = Math.max(padL, Math.min(cx - w / 2, W - padR - w));
      let by = cy - h - 9;
      if (by < padT) by = cy + 9;
      popup.innerHTML =
        `<rect class="elev-popup-bg" x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${w.toFixed(1)}" height="${h}" rx="3" />` +
        `<text class="elev-popup-text" x="${(bx + w / 2).toFixed(1)}" y="${(by + h / 2 + 0.5).toFixed(1)}" text-anchor="middle" dominant-baseline="middle">${esc(text)}</text>`;
    });

    // Where each racer probably is. Racers who have not started get no dot.
    function position(r) {
      const pos = Race.compute.predictedMileage(r, cfg());
      return pos.state === 'idle' ? null : pos;
    }
    function label(pos) {
      const c = cfg();
      if (pos.state === 'finished') return 'finished';
      if (pos.state === 'in-pit') return pos.atAid ? `in pit at ${pos.atAid}` : `in pit · ${Race.units.distance(pos.courseMi, c)}`;
      return `~${Race.units.distance(pos.courseMi, c)} (est)`;
    }

    function update() {
      if (!ready) return;
      if (tracks) { updateLoops(); return; }
      if (!pts) return;
      const c = cfg();
      const loopMode = c.courseType === 'loops';
      const loopDist = loopMode ? Race.course.loopDistance(c) : 0;
      // The GPX covers one lap for loops, the whole course for segments.
      const trackMi = mi => (loopMode && loopDist > 0) ? (mi % loopDist) : mi;
      const list = runners();

      // Markers are moved in place, not cleared and re-added, so the
      // per-second updates do not flicker.
      if (map) {
        const live = new Set();
        list.forEach(r => {
          const pos = position(r);
          if (!pos) return;
          live.add(r.id);
          const p = nearestGpxPoint(pts, trackMi(pos.courseMi));
          const color = r.color || AID_MID_COLOR;
          const text = `${r.name} · ${label(pos)}`;
          let m = markers[r.id];
          if (m) {
            m.setLatLng([p.lat, p.lon]); m.setStyle({ fillColor: color }); m.setTooltipContent(text);
          } else {
            m = L.circleMarker([p.lat, p.lon], { radius: 7, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1, className: 'runner-dot' })
              .addTo(map).bindTooltip(text, { permanent: true, direction: 'right', offset: [8, 0], className: 'runner-dot-label' });
            markers[r.id] = m;
          }
        });
        Object.keys(markers).forEach(id => {
          if (!live.has(id)) { map.removeLayer(markers[id]); delete markers[id]; }
        });
      }

      const g = svg.querySelector('.elev-runners');
      if (g && elevX && elevY) {
        g.innerHTML = list.map(r => {
          const pos = position(r);
          if (!pos) return '';
          const tmi = trackMi(pos.courseMi);
          const pt = nearestGpxPoint(pts, tmi);
          const cx = elevX(tmi), cy = elevY(pt.ele);
          const color = r.color || AID_MID_COLOR;
          return `
            <circle class="runner-dot" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="5" fill="${color}" stroke="#0a0f14" stroke-width="1.5">
              <title>${esc(r.name)} · ${esc(label(pos))}</title>
            </circle>
            <text class="elev-runner-label" x="${cx.toFixed(1)}" y="${(cy - 9).toFixed(1)}" text-anchor="middle" fill="${color}">${esc(r.name)}</text>`;
        }).join('');
      }
    }

    return { load, update, points: () => pts, ready: () => ready,
      // Which loops are drawn and which is lit, for the tests.
      loops: () => tracks ? { drawn: tracks.map((t, i) => t ? i : null).filter(i => i != null),
        active: activeKey ? activeKey.split(',').map(Number) : [], shown: shownLoop } : null };
  }

  window.CourseView = { mount, nearestGpxPoint };
})();
