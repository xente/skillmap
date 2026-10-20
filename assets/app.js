/* SkillMap visualizer — vanilla JS, no dependencies.
   Two canvas renderers share one stage + drawer:
     • Diagram  — UML-style draggable cards with agent/skill info
     • Graph    — classic force-directed node map (for comparison) */
(() => {
  const DATA = JSON.parse(document.getElementById('skillmap-data').textContent);
  const N = DATA.nodes, E = DATA.edges, A = DATA.analysis, META = DATA.meta;
  const nodeById = new Map(N.map(n => [n.id, n]));
  const UNUSED = new Set(A.unused);
  const UNUSED_LEAF = new Set(A.unusedLeaves);
  const UNUSED_ORG = new Set(A.unusedOrganizers);
  const MANUAL = new Set(A.manualOnly);
  const DUP_NAME = new Set(A.duplicateNames.flatMap(d => d.ids));
  const SIMILAR_NAME = new Set(A.similarNames.flatMap(d => d.ids));
  const nameOf = (id) => (nodeById.get(id) || {}).name || id;

  const KIND_COLOR = { skill: '#a78bfa', agent: '#38bdf8', instructions: '#fbbf24' };
  const EDGE_COLOR = { 'skill-ref': '#a78bfa', delegation: '#38bdf8', 'instruction-ref': '#fbbf24', 'path-ref': '#8ea2c0', uses: '#7c8aa3' };
  const KIND_LABEL = { skill: 'Skill', agent: 'Agent', instructions: 'Instructions' };
  const EDGE_LABEL = { 'skill-ref': 'skill ref', delegation: 'delegates', 'instruction-ref': 'instructs', 'path-ref': 'path ref', uses: 'uses' };

  const state = {
    view: 'diagram',
    renderMode: 'diagram',
    query: '',
    kinds: new Set(['skill', 'agent', 'instructions']),
    scopes: new Set(Object.keys(A.scopes)),
    selected: null,
    hover: null,
    groupBy: false,
    collapsed: new Set(),
  };

  // ---- tiny DOM helper ----
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) for (const [k, v] of Object.entries(props)) {
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined) el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const kindDot = (kind) => h('span', { class: 'dot', style: `background:${KIND_COLOR[kind] || '#888'}` });

  /* ================= top bar / filters ================= */
  document.querySelector('.brand .sub').textContent = META.projectLabel || META.root;
  document.querySelector('.brand .sub').title = META.root;

  const healthEl = document.getElementById('health');
  healthEl.dataset.grade = A.health.grade;
  healthEl.append(h('span', { class: 'grade' }, A.health.grade), h('span', null, `Health ${A.health.score}`));
  healthEl.title = `Unused ${A.unused.length} · Orphan organizers ${A.unusedOrganizers.length} · Duplicate names ${A.duplicateNames.length} · Similar names ${A.similarNames.length} · Similar descriptions ${A.descDupes.length} · Cross-scope copies ${A.scopeDivergence.length} · Cycles ${A.cycles.length}`;

  document.getElementById('topstats').append(
    stat('Skills', N.filter(n => n.kind === 'skill').length),
    stat('Agents', N.filter(n => n.kind === 'agent').length),
    stat('Instructions', N.filter(n => n.kind === 'instructions').length),
    stat('Links', E.length),
  );
  function stat(label, value) { return h('div', null, h('b', null, String(value)), ' ', label); }

  const filtersEl = document.getElementById('filters');
  for (const kind of ['skill', 'agent', 'instructions']) {
    const count = N.filter(n => n.kind === kind).length;
    const c = h('button', { class: 'chip', 'aria-pressed': 'true', 'data-kind': kind, title: `Show/hide ${KIND_LABEL[kind].toLowerCase()} (${count})`, onclick: () => toggleKind(kind, c) }, kindDot(kind), KIND_LABEL[kind]);
    filtersEl.append(c);
  }
  for (const scope of Object.keys(A.scopes)) {
    const c = h('button', { class: 'chip', 'aria-pressed': 'true', 'data-scope': scope, title: `Show/hide scope ${scope} (${A.scopes[scope]})`, onclick: () => toggleScope(scope, c) }, scope);
    filtersEl.append(c);
  }
  function toggleKind(kind, el) {
    if (state.kinds.has(kind)) state.kinds.delete(kind); else state.kinds.add(kind);
    el.setAttribute('aria-pressed', String(state.kinds.has(kind)));
    rebuild();
  }
  function toggleScope(scope, el) {
    if (state.scopes.has(scope)) state.scopes.delete(scope); else state.scopes.add(scope);
    el.setAttribute('aria-pressed', String(state.scopes.has(scope)));
    rebuild();
  }

  const searchEl = document.getElementById('search');
  searchEl.addEventListener('input', () => { state.query = searchEl.value; rebuild(); });
  const fitBtn = document.getElementById('fitBtn');
  if (fitBtn) fitBtn.addEventListener('click', () => fitView());
  const relayoutBtn = document.getElementById('relayoutBtn');
  if (relayoutBtn) relayoutBtn.addEventListener('click', () => reLayout());
  const zoomInBtn = document.getElementById('zoomIn');
  if (zoomInBtn) zoomInBtn.addEventListener('click', () => zoomBy(1.25));
  const zoomOutBtn = document.getElementById('zoomOut');
  if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => zoomBy(0.8));
  const zoomResetBtn = document.getElementById('zoomReset');
  if (zoomResetBtn) zoomResetBtn.addEventListener('click', () => zoomReset());
  const exportPngBtn = document.getElementById('exportPng');
  if (exportPngBtn) exportPngBtn.addEventListener('click', () => exportPNG());
  const exportJsonBtn = document.getElementById('exportJson');
  if (exportJsonBtn) exportJsonBtn.addEventListener('click', () => exportJSON());
  const groupBtn = document.getElementById('groupBtn');
  if (groupBtn) groupBtn.addEventListener('click', () => {
    state.groupBy = !state.groupBy;
    groupBtn.setAttribute('aria-pressed', String(state.groupBy));
    if (state.renderMode === 'diagram') relayout();
    invalidate();
  });
  searchEl.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      // jump to the best match: exact name first, then the first visible hit
      const q = state.query.trim().toLowerCase();
      const ids = [...visible];
      const best = ids.find(id => nodeById.get(id).name.toLowerCase() === q) || ids[0];
      if (best) { searchEl.blur(); focusNode(best); }
    } else if (ev.key === 'Escape') {
      if (searchEl.value) { searchEl.value = ''; state.query = ''; rebuild(); } else searchEl.blur();
      ev.stopPropagation();
    }
  });
  document.addEventListener('keydown', (ev) => {
    // leave browser shortcuts (⌘R, ⌘F, ⌘0, ⌘+…) alone, and don't act behind an open dialog
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (document.querySelector('.reader-overlay')) return;
    const t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const onCanvas = state.view === 'diagram' || state.view === 'graph';
    const k = ev.key;
    if (k === '/') { ev.preventDefault(); searchEl.focus(); searchEl.select(); }
    else if (k === 'Escape') { if (state.selected) select(null); }
    else if (k === '1') setView('diagram');
    else if (k === '2') setView('graph');
    else if (k === '3') setView('hierarchy');
    else if (k === '4') setView('insights');
    else if (k === '5') setView('runtime');
    else if (k === '?') toggleHelp();
    else if ((k === 'o' || k === 'O') && state.selected) openReader(state.selected);
    else if (!onCanvas) return;
    else if (k === 'f' || k === 'F') fitView();
    else if (k === 'r' || k === 'R') reLayout();
    else if (k === '+' || k === '=') zoomBy(1.25);
    else if (k === '-' || k === '_') zoomBy(0.8);
    else if (k === '0') zoomReset();
    else if ((k === 'g' || k === 'G') && state.view === 'diagram') { if (groupBtn) groupBtn.click(); }
    else return;
    invalidate();
  });

  document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => setView(tab.dataset.view)));
  function setView(view) {
    state.view = view;
    const isCanvas = view === 'diagram' || view === 'graph';
    for (const bid of ['fitBtn', 'relayoutBtn', 'zoomOut', 'zoomIn', 'zoomReset', 'exportPng']) {
      const b = document.getElementById(bid);
      if (b) b.style.display = isCanvas ? '' : 'none';
    }
    const gb = document.getElementById('groupBtn');
    if (gb) gb.style.display = view === 'diagram' ? '' : 'none';
    const tabView = view === 'session' ? 'runtime' : view; // a session page lives under Runtime
    document.querySelectorAll('.tab').forEach(t => { t.classList.toggle('active', t.dataset.view === tabView); t.setAttribute('aria-selected', String(t.dataset.view === tabView)); });
    filtersEl.style.display = view === 'runtime' || view === 'session' ? 'none' : '';
    if (view !== 'session' && location.hash.startsWith('#session/')) history.replaceState(null, '', location.pathname + location.search);
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', isCanvas ? v.id === 'view-canvas' : v.id === 'view-' + view));
    if (isCanvas) {
      state.renderMode = view;
      pos = layouts[view];
      document.getElementById('hint').textContent = view === 'diagram'
        ? 'Drag to move · scroll to zoom · double-click to zoom in · ? for shortcuts'
        : 'Drag to pan · scroll to zoom · click a node for details · ? for shortcuts';
      resize();
      if (!laidOut.has(view)) { relayout(); laidOut.add(view); }
      else { rebuild(); fitView(); }
    }
    invalidate();
  }

  /* ================= canvas + layouts ================= */
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const layouts = { diagram: new Map(), graph: new Map() };
  let pos = layouts.diagram;
  let visible = new Set();
  let links = [];
  let pan = { x: 0, y: 0 }, zoom = 1;
  let dpr = 1, W = 0, H = 0;
  let dragging = null, panning = null;
  const boxCache = new Map();
  const laidOut = new Set();
  // Redraw only when something changed, instead of repainting every frame.
  let dirty = true;
  function invalidate() { dirty = true; }

  function computeVisible() {
    const q = state.query.trim().toLowerCase();
    const s = new Set();
    for (const n of N) {
      if (!state.kinds.has(n.kind)) continue;
      if (!state.scopes.has(n.scope)) continue;
      if (q && !(n.name.toLowerCase().includes(q) || (n.description || '').toLowerCase().includes(q) || n.slug.includes(q))) continue;
      s.add(n.id);
    }
    return s;
  }

  // Give coordinates to any visible node that has none yet.
  // Existing nodes are never moved — the layout stays put.
  function seedMissing() {
    const ids = [...visible];
    const R = (state.renderMode === 'diagram' ? 78 : 34) * Math.sqrt(Math.max(ids.length, 1));
    let i = 0;
    for (const id of ids) {
      if (!pos.has(id)) {
        const nb = E.find(e => (e.source === id && pos.has(e.target)) || (e.target === id && pos.has(e.source)));
        if (nb) {
          const p = pos.get(nb.source === id ? nb.target : nb.source);
          const off = state.renderMode === 'diagram' ? 280 : 60;
          pos.set(id, { x: p.x + (Math.random() - 0.5) * off * 2, y: p.y + (Math.random() - 0.5) * off * 2, vx: 0, vy: 0 });
          i++;
          continue;
        }
        const a = (i / Math.max(ids.length, 1)) * Math.PI * 2 + Math.random();
        pos.set(id, { x: Math.cos(a) * R * (0.4 + Math.random() * 0.6), y: Math.sin(a) * R * (0.4 + Math.random() * 0.6), vx: 0, vy: 0 });
      }
      i++;
    }
  }

  function rebuild() {
    visible = computeVisible();
    links = E.filter(e => visible.has(e.source) && visible.has(e.target));
    seedMissing(); // only newly-shown nodes get a spot; the rest don't budge
    updateStatus();
    invalidate();
  }

  // Tell the user when filters/search are hiding things, and how to undo it.
  const statusEl = document.getElementById('status');
  function updateStatus() {
    if (!statusEl) return;
    const hidden = N.length - visible.size;
    statusEl.innerHTML = '';
    if (!N.length || !hidden) { statusEl.hidden = true; return; }
    statusEl.hidden = false;
    statusEl.append(
      visible.size ? `Showing ${visible.size} of ${N.length}` : 'No matches for the current search / filters',
      h('button', { class: 'linkbtn', onclick: resetFilters }, 'Show all'));
  }
  function resetFilters() {
    state.query = ''; searchEl.value = '';
    state.kinds = new Set(['skill', 'agent', 'instructions']);
    state.scopes = new Set(Object.keys(A.scopes));
    filtersEl.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', 'true'));
    rebuild();
  }

  // One physics iteration.
  function physicsStep() {
    const ids = [...visible];
    const dia = state.renderMode === 'diagram';
    const grouped = state.groupBy && dia;
    const kRep = grouped ? 16000 : (dia ? 150000 : 9000);
    const L = grouped ? 190 : (dia ? 330 : 96);
    const damp = dia ? 0.84 : 0.86;
    const minD = grouped ? 0 : (dia ? 300 : 0);
    for (let a = 0; a < ids.length; a++) {
      const pa = pos.get(ids[a]);
      for (let b = a + 1; b < ids.length; b++) {
        const pb = pos.get(ids[b]);
        let dx = pa.x - pb.x, dy = pa.y - pb.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
        const d = Math.sqrt(d2);
        let f = kRep / d2;
        if (minD && d < minD) f += (minD - d) * 0.5; // soft collision so cards don't overlap
        const fx = (dx / d) * f, fy = (dy / d) * f;
        pa.vx += fx; pa.vy += fy; pb.vx -= fx; pb.vy -= fy;
      }
    }
    for (const e of links) {
      const s = pos.get(e.source), t = pos.get(e.target);
      let dx = t.x - s.x, dy = t.y - s.y;
      const d = Math.hypot(dx, dy) || 0.01;
      const f = (d - L) * (dia ? 0.012 : 0.02);
      const fx = (dx / d) * f, fy = (dy / d) * f;
      s.vx += fx; s.vy += fy; t.vx -= fx; t.vy -= fy;
    }
    const grav = dia ? 0.0012 : 0.0025;
    const maxV = dia ? 10 : 12;
    // pull each card toward its scope's centroid so scopes cluster
    let cen = null;
    if (state.groupBy && dia) {
      cen = new Map();
      for (const id of ids) {
        const n = nodeById.get(id); const p = pos.get(id);
        const c = cen.get(n.scope) || { x: 0, y: 0, k: 0 };
        c.x += p.x; c.y += p.y; c.k += 1; cen.set(n.scope, c);
      }
    }
    for (const id of ids) {
      const p = pos.get(id);
      if (cen) { const c = cen.get(nodeById.get(id).scope); p.vx += (c.x / c.k - p.x) * 0.05; p.vy += (c.y / c.k - p.y) * 0.05; }
      p.vx += -p.x * grav; p.vy += -p.y * grav;
      p.vx *= damp; p.vy *= damp;
      const sp = Math.hypot(p.vx, p.vy);
      if (sp > maxV) { p.vx = (p.vx / sp) * maxV; p.vy = (p.vy / sp) * maxV; }
      p.x += p.vx; p.y += p.vy;
    }
  }

  // ---- scope grouping helpers ----
  function scopeGroups() {
    const g = new Map();
    for (const id of visible) {
      const n = nodeById.get(id);
      if (!g.has(n.scope)) g.set(n.scope, []);
      g.get(n.scope).push(id);
    }
    return g;
  }
  function groupBounds(ids, pad = 26, header = 30) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of ids) {
      const p = pos.get(id); const b = boxFor(nodeById.get(id));
      minX = Math.min(minX, p.x - b.w / 2); maxX = Math.max(maxX, p.x + b.w / 2);
      minY = Math.min(minY, p.y - b.h / 2); maxY = Math.max(maxY, p.y + b.h / 2);
    }
    return { x: minX - pad, y: minY - pad - header, w: (maxX - minX) + pad * 2, h: (maxY - minY) + pad * 2 + header };
  }
  function shiftGroup(ids, dx, dy) { for (const id of ids) { const p = pos.get(id); if (p) { p.x += dx; p.y += dy; } } }

  function collapsedCenter(ids) {
    let x = 0, y = 0, k = 0;
    for (const id of ids) { const p = pos.get(id); if (p) { x += p.x; y += p.y; k++; } }
    return k ? { x: x / k, y: y / k } : { x: 0, y: 0 };
  }
  function toggleCollapse(scope) {
    if (state.collapsed.has(scope)) state.collapsed.delete(scope); else state.collapsed.add(scope);
    if (state.groupBy && state.renderMode === 'diagram') { layout(); fitView(); }
    invalidate();
  }
  // Click on a collapsed group's pill, or on an expanded group's header strip.
  function hitGroup(mx, my) {
    if (!state.groupBy || state.renderMode !== 'diagram') return null;
    for (const [scope, ids] of scopeGroups()) {
      if (state.collapsed.has(scope)) {
        const p = project(collapsedCenter(ids));
        if (Math.abs(mx - p.x) <= 105 * zoom && Math.abs(my - p.y) <= 24 * zoom) return scope;
      } else {
        const b = groupBounds(ids, 26, 30);
        const p0 = project({ x: b.x, y: b.y });
        if (mx >= p0.x && mx <= p0.x + b.w * zoom && my >= p0.y && my <= p0.y + 30 * zoom) return scope;
      }
    }
    return null;
  }
  // Push whole scopes apart so their container boxes don't overlap.
  function groupSeparation() {
    const groups = [...scopeGroups().values()];
    if (groups.length < 2) return;
    for (let it = 0; it < 400; it++) {
      let moved = false;
      const bnds = groups.map((ids) => groupBounds(ids, 34, 34));
      for (let a = 0; a < groups.length; a++) {
        for (let b = a + 1; b < groups.length; b++) {
          const A = bnds[a], B = bnds[b];
          const ox = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x);
          const oy = Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y);
          if (ox > 0 && oy > 0) {
            moved = true;
            const dx = (B.x + B.w / 2) - (A.x + A.w / 2);
            const dy = (B.y + B.h / 2) - (A.y + A.h / 2);
            if (ox < oy) { const s = ox / 2 + 1; const dir = dx < 0 ? -1 : 1; shiftGroup(groups[a], -s * dir, 0); shiftGroup(groups[b], s * dir, 0); }
            else { const s = oy / 2 + 1; const dir = dy < 0 ? -1 : 1; shiftGroup(groups[a], 0, -s * dir); shiftGroup(groups[b], 0, s * dir); }
          }
        }
      }
      if (!moved) break;
    }
  }

  // Compute the layout once (synchronously) and freeze it. No ongoing animation.
  function layout() {
    seedMissing();
    if (state.renderMode === 'diagram' && state.groupBy) { groupedLayout(); return; }
    const iters = Math.min(700, 200 + visible.size * 5);
    for (let k = 0; k < iters; k++) physicsStep();
    packIsolated();
    if (state.renderMode === 'diagram') resolveOverlaps();
    for (const id of visible) { const p = pos.get(id); if (p) { p.vx = 0; p.vy = 0; } }
    invalidate();
  }

  // Nodes with no visible links get pushed far out by repulsion, which forces
  // the fit-to-view to zoom way out. Line them up under the connected cluster.
  function packIsolated() {
    const linked = new Set();
    for (const e of links) { linked.add(e.source); linked.add(e.target); }
    const lone = [...visible].filter(id => !linked.has(id)).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
    if (!lone.length || lone.length === visible.size) return;
    const dia = state.renderMode === 'diagram';
    let minX = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of linked) {
      if (!visible.has(id)) continue;
      const p = pos.get(id); const hh = dia ? boxFor(nodeById.get(id)).h / 2 : 10; const hw = dia ? BOX.w / 2 : 10;
      minX = Math.min(minX, p.x - hw); maxX = Math.max(maxX, p.x + hw); maxY = Math.max(maxY, p.y + hh);
    }
    const cellW = dia ? BOX.w + 40 : 110, cellH = dia ? 190 : 60;
    const cols = Math.max(1, Math.floor((maxX - minX) / cellW));
    const rowW = Math.min(cols, lone.length) * cellW;
    const x0 = (minX + maxX) / 2 - rowW / 2 + cellW / 2;
    const y0 = maxY + (dia ? 140 : 70);
    lone.forEach((id, i) => {
      const p = pos.get(id);
      p.x = x0 + (i % cols) * cellW; p.y = y0 + Math.floor(i / cols) * cellH; p.vx = 0; p.vy = 0;
    });
  }

  // Grouped mode: a tidy grid per scope, packed in rows. Deterministic and compact.
  function groupedLayout() {
    const groups = [...scopeGroups().entries()].sort((a, b) => b[1].length - a[1].length);
    if (!groups.length) return;
    const cellW = BOX.w + 40, cellH = 205, gap = 70, pillW = 220, pillH = 50;
    const blocks = groups.map(([scope, ids]) => {
      if (state.collapsed.has(scope)) return { scope, ordered: ids, cols: 1, w: pillW, h: pillH, collapsed: true };
      const ordered = [...ids].sort((a, b) => (nodeById.get(b).degree || 0) - (nodeById.get(a).degree || 0));
      const cols = Math.max(1, Math.ceil(Math.sqrt(ordered.length)));
      const rows = Math.ceil(ordered.length / cols);
      return { scope, ordered, cols, w: cols * cellW, h: rows * cellH, collapsed: false };
    });
    const targetW = Math.max(1100, Math.sqrt(blocks.reduce((s, b) => s + (b.w + gap) * (b.h + gap), 0)) * 1.5);
    let x = 0, y = 0, rowH = 0;
    const placed = [];
    for (const b of blocks) {
      if (x > 0 && x + b.w > targetW) { x = 0; y += rowH + gap; rowH = 0; }
      placed.push({ ...b, bx: x, by: y });
      x += b.w + gap;
      rowH = Math.max(rowH, b.h);
    }
    const totalW = Math.max(...placed.map((p) => p.bx + p.w));
    const totalH = y + rowH;
    const offX = -totalW / 2, offY = -totalH / 2;
    for (const p of placed) {
      if (p.collapsed) {
        const cx = p.bx + offX + p.w / 2, cy = p.by + offY + p.h / 2;
        for (const id of p.ordered) { const pt = pos.get(id); pt.x = cx; pt.y = cy; pt.vx = 0; pt.vy = 0; }
        continue;
      }
      p.ordered.forEach((id, i) => {
        const c = i % p.cols, r = Math.floor(i / p.cols);
        const pt = pos.get(id);
        pt.x = p.bx + offX + c * cellW + cellW / 2;
        pt.y = p.by + offY + r * cellH + cellH / 2;
        pt.vx = 0; pt.vy = 0;
      });
    }
  }

  // Push apart any cards whose rectangles overlap, so nothing is hidden.
  function resolveOverlaps() {
    const ids = [...visible];
    const pad = 18;
    for (let it = 0; it < 150; it++) {
      let moved = false;
      for (let a = 0; a < ids.length; a++) {
        const pa = pos.get(ids[a]); const ba = boxFor(nodeById.get(ids[a]));
        for (let b = a + 1; b < ids.length; b++) {
          const pb = pos.get(ids[b]); const bb = boxFor(nodeById.get(ids[b]));
          const dx = pb.x - pa.x, dy = pb.y - pa.y;
          const ox = (ba.w + bb.w) / 2 + pad - Math.abs(dx);
          const oy = (ba.h + bb.h) / 2 + pad - Math.abs(dy);
          if (ox > 0 && oy > 0) {
            moved = true;
            if (ox < oy) { const s = (ox / 2) * (dx < 0 ? -1 : 1); pa.x -= s; pb.x += s; }
            else { const s = (oy / 2) * (dy < 0 ? -1 : 1); pa.y -= s; pb.y += s; }
          }
        }
      }
      if (!moved) break;
    }
  }

  // Full (re)layout for the current mode, then frame it.
  function relayout() {
    rebuild();
    layout();
    fitView();
  }

  // Explicit "shuffle again" — throws away the current arrangement.
  function reLayout() {
    pos.clear();
    relayout();
    laidOut.add(state.renderMode);
  }

  function project(p) { return { x: p.x * zoom + pan.x, y: p.y * zoom + pan.y }; }
  function radius(n) { return (5 + Math.min(n.degree || 0, 6) * 1.6) * Math.min(Math.max(zoom, 0.5), 1.6); }

  /* ---------- card layout for the diagram ---------- */
  const BOX = { w: 240, headerH: 32, padX: 12, padY: 10, gap: 5 };
  const F = { title: 13.5, sub: 10.5, body: 11, meta: 10 };
  function wrap(text, maxW, font) {
    ctx.font = font;
    const words = String(text).split(/\s+/);
    const lines = [];
    let cur = '';
    for (const w of words) {
      const test = cur ? cur + ' ' + w : w;
      if (ctx.measureText(test).width > maxW && cur) { lines.push(cur); cur = w; }
      else cur = test;
    }
    if (cur) lines.push(cur);
    return lines;
  }
  // Shorten one line with an ellipsis until it fits maxW (ctx.font must already be set).
  function ellipsize(text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t.trimEnd() + '…';
  }
  // Wrap text to the card width, at most maxLines, ending in … if it was cut.
  function fitLines(text, maxW, font, maxLines) {
    const all = wrap(text, maxW, font);
    const out = all.slice(0, maxLines);
    if (all.length > maxLines) out[out.length - 1] += ' …';
    ctx.font = font;
    return out.map((l) => ellipsize(l, maxW)); // a single long word can still be too wide
  }
  function boxFor(n) {
    if (boxCache.has(n.id)) return boxCache.get(n.id);
    const innerW = BOX.w - BOX.padX * 2;
    const lines = [];
    const sub = [n.scope];
    if (n.mode) sub.push(`mode: ${n.mode}`);
    if (n.isOrganizer) sub.push(`${n.children.length} children`);
    sub.push(`${n.inDegree} in · ${n.outDegree} out`);
    const subFont = '500 ' + F.sub + 'px -apple-system,Inter,sans-serif';
    for (const l of fitLines(sub.join('  ·  '), innerW, subFont, 2)) lines.push({ t: l, size: F.sub, color: '#8ea2c0', font: subFont });

    if (n.description) {
      const bodyFont = '400 ' + F.body + 'px -apple-system,Inter,sans-serif';
      for (const l of fitLines(n.description, innerW, bodyFont, 3)) lines.push({ t: l, size: F.body, color: '#c4d0e2', font: bodyFont });
    }
    // model / tools / args each start on their own line and wrap inside the card
    const metaFont = '400 ' + F.meta + 'px ui-monospace,Menlo,monospace';
    const meta = [];
    if (n.model) meta.push('model: ' + n.model);
    if (n.tools && n.tools.length) meta.push('tools: ' + n.tools.slice(0, 6).join(', ') + (n.tools.length > 6 ? ` +${n.tools.length - 6}` : ''));
    if (n.argumentHint) meta.push('args: ' + n.argumentHint);
    for (const m of meta) for (const l of fitLines(m, innerW, metaFont, 2)) lines.push({ t: l, size: F.meta, color: '#7c8aa3', font: metaFont });

    let flag = null, flagColor = null;
    if (UNUSED_LEAF.has(n.id)) { flag = '⚠ unused'; flagColor = '#f87171'; }
    else if (UNUSED_ORG.has(n.id)) { flag = 'orphan organizer'; flagColor = '#fbbf24'; }
    else if (DUP_NAME.has(n.id)) { flag = 'duplicate name'; flagColor = '#fbbf24'; }
    else if (SIMILAR_NAME.has(n.id)) { flag = 'similar name'; flagColor = '#fbbf24'; }
    if (flag) lines.push({ t: flag, size: F.meta, color: flagColor, font: '700 ' + F.meta + 'px -apple-system,Inter,sans-serif' });

    let height = BOX.headerH + BOX.padY;
    for (const l of lines) height += l.size * 1.35 + BOX.gap;
    height += BOX.padY - BOX.gap;
    const box = { w: BOX.w, h: height, lines, color: KIND_COLOR[n.kind] || '#888' };
    boxCache.set(n.id, box);
    return box;
  }

  /* ---------- drawing ---------- */
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function focusSets() {
    const focus = state.selected || state.hover;
    const neighbors = new Set();
    if (focus) { neighbors.add(focus); for (const e of links) { if (e.source === focus) neighbors.add(e.target); if (e.target === focus) neighbors.add(e.source); } }
    return { focus, neighbors };
  }

  function drawGraph() {
    const { focus, neighbors } = focusSets();
    for (const e of links) {
      const s = pos.get(e.source), t = pos.get(e.target);
      if (!s || !t) continue;
      const ps = project(s), pt = project(t);
      const near = focus && (e.source === focus || e.target === focus);
      ctx.strokeStyle = EDGE_COLOR[e.type] || '#7c8aa3';
      ctx.globalAlpha = focus ? (near ? 0.95 : 0.07) : 0.32;
      ctx.lineWidth = near ? 2 : 1;
      ctx.beginPath(); ctx.moveTo(ps.x, ps.y); ctx.lineTo(pt.x, pt.y); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    for (const id of visible) {
      const n = nodeById.get(id); const p = pos.get(id); if (!p) continue;
      const sp = project(p); const r = radius(n);
      const dim = focus && !neighbors.has(id);
      ctx.globalAlpha = dim ? 0.2 : 1;
      if (id === state.selected || id === state.hover) {
        ctx.beginPath(); ctx.arc(sp.x, sp.y, r + 7, 0, Math.PI * 2); ctx.fillStyle = 'rgba(99,102,241,.28)'; ctx.fill();
      }
      ctx.beginPath(); ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
      ctx.fillStyle = KIND_COLOR[n.kind] || '#888'; ctx.fill();
      if (UNUSED.has(id)) { ctx.strokeStyle = '#f87171'; ctx.lineWidth = 2.4; ctx.stroke(); }
      else if (n.isOrganizer) { ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 2; ctx.stroke(); }
      else { ctx.strokeStyle = 'rgba(255,255,255,.28)'; ctx.lineWidth = 1; ctx.stroke(); }
      ctx.globalAlpha = 1;
    }
    const many = visible.size > 110;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const id of visible) {
      const n = nodeById.get(id); const p = pos.get(id); if (!p) continue;
      const isFocus = id === state.selected || id === state.hover;
      if (many && !isFocus && (n.degree || 0) < 2) continue;
      const sp = project(p); const r = radius(n);
      ctx.globalAlpha = (focus && !neighbors.has(id)) ? 0.25 : 1;
      ctx.fillStyle = isFocus ? '#ffffff' : '#9fb0c9';
      ctx.font = '11px -apple-system,Inter,Segoe UI,sans-serif';
      ctx.fillText(n.name, sp.x, sp.y + r + 3);
    }
    ctx.globalAlpha = 1;
  }

  function rectEdge(cx, cy, dx, dy, hw, hh) {
    const tx = dx !== 0 ? hw / Math.abs(dx) : Infinity;
    const ty = dy !== 0 ? hh / Math.abs(dy) : Infinity;
    const t = Math.min(tx, ty);
    return { x: cx + dx * t, y: cy + dy * t };
  }

  const SCOPE_PALETTE = ['#60a5fa', '#34d399', '#f59e0b', '#f472b6', '#a78bfa', '#22d3ee', '#fb7185', '#7c8aa3'];
  function scopeColor(scope) {
    let h = 0; for (let i = 0; i < scope.length; i++) h = (h * 31 + scope.charCodeAt(i)) >>> 0;
    return SCOPE_PALETTE[h % SCOPE_PALETTE.length];
  }
  function drawGroupBoxes() {
    const groups = [...scopeGroups().entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [scope, ids] of groups) {
      const col = scopeColor(scope);
      if (state.collapsed.has(scope)) {
        const p = project(collapsedCenter(ids));
        const w = 210 * zoom, h = 44 * zoom;
        ctx.save();
        roundRect(p.x - w / 2, p.y - h / 2, w, h, 10 * Math.min(zoom, 1.3));
        ctx.fillStyle = col; ctx.globalAlpha = 0.16; ctx.fill();
        ctx.globalAlpha = 0.75; ctx.lineWidth = 1.4; ctx.strokeStyle = col; ctx.stroke();
        ctx.globalAlpha = 1; ctx.fillStyle = col;
        ctx.font = `700 ${13 * zoom}px -apple-system,Inter,sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(`▸ ${scope}  ·  ${ids.length}`, p.x, p.y + 1);
        ctx.restore();
        continue;
      }
      const b = groupBounds(ids, 26, 30);
      const p0 = project({ x: b.x, y: b.y });
      ctx.save();
      roundRect(p0.x, p0.y, b.w * zoom, b.h * zoom, 16 * Math.min(zoom, 1.3));
      ctx.fillStyle = col; ctx.globalAlpha = 0.07; ctx.fill();
      ctx.globalAlpha = 0.5; ctx.setLineDash([6, 5]); ctx.lineWidth = 1.2; ctx.strokeStyle = col; ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.92; ctx.fillStyle = col;
      ctx.font = `700 ${12 * zoom}px -apple-system,Inter,sans-serif`;
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText(`▾ ${scope}  ·  ${ids.length}`, p0.x + 12 * zoom, p0.y + 9 * zoom);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  function drawDiagram() {
    const { focus, neighbors } = focusSets();
    if (state.groupBy) drawGroupBoxes();
    // resolve an endpoint to a screen point + half-size, honouring collapsed groups
    const ccenters = new Map();
    if (state.groupBy) for (const [scope, ids] of scopeGroups()) if (state.collapsed.has(scope)) ccenters.set(scope, collapsedCenter(ids));
    const end = (id) => {
      const n = nodeById.get(id);
      if (state.groupBy && state.collapsed.has(n.scope)) {
        const c = ccenters.get(n.scope); const p = project(c);
        return { p, hw: 105 * zoom, hh: 24 * zoom, collapsed: true, scope: n.scope };
      }
      const b = boxFor(n);
      return { p: project(pos.get(id)), hw: (b.w / 2) * zoom, hh: (b.h / 2) * zoom, collapsed: false };
    };
    // edges first
    for (const e of links) {
      const s = pos.get(e.source), t = pos.get(e.target);
      if (!s || !t) continue;
      const es = end(e.source), et = end(e.target);
      if (es.collapsed && et.collapsed && es.scope === et.scope) continue;
      const ps = es.p, pt = et.p;
      const a = rectEdge(ps.x, ps.y, pt.x - ps.x, pt.y - ps.y, es.hw, es.hh);
      const b = rectEdge(pt.x, pt.y, ps.x - pt.x, ps.y - pt.y, et.hw, et.hh);
      const near = focus && (e.source === focus || e.target === focus);
      ctx.strokeStyle = EDGE_COLOR[e.type] || '#7c8aa3';
      ctx.globalAlpha = focus ? (near ? 0.95 : 0.06) : 0.4;
      ctx.lineWidth = near ? 2.2 : 1.2;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      // arrowhead at target
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const sz = (near ? 9 : 7);
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - Math.cos(ang - 0.4) * sz, b.y - Math.sin(ang - 0.4) * sz);
      ctx.lineTo(b.x - Math.cos(ang + 0.4) * sz, b.y - Math.sin(ang + 0.4) * sz);
      ctx.closePath(); ctx.fillStyle = EDGE_COLOR[e.type] || '#7c8aa3'; ctx.fill();
      if (near) {
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        ctx.font = '10px -apple-system,Inter,sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const label = EDGE_LABEL[e.type] || e.type;
        const tw = ctx.measureText(label).width;
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = '#0b0f17';
        roundRect(mx - tw / 2 - 5, my - 8, tw + 10, 16, 5); ctx.fill();
        ctx.fillStyle = EDGE_COLOR[e.type] || '#7c8aa3';
        ctx.fillText(label, mx, my + 1);
      }
    }
    ctx.globalAlpha = 1;

    // boxes
    for (const id of visible) {
      const n = nodeById.get(id); const p = pos.get(id); if (!p) continue;
      if (state.groupBy && state.collapsed.has(n.scope)) continue;
      const b = boxFor(n); const sp = project(p);
      const w = b.w * zoom, hgt = b.h * zoom, x = sp.x - w / 2, y = sp.y - hgt / 2;
      const dim = focus && !neighbors.has(id);
      ctx.globalAlpha = dim ? 0.28 : 1;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = 16 * Math.min(zoom, 1.4); ctx.shadowOffsetY = 4;
      roundRect(x, y, w, hgt, 11 * Math.min(zoom, 1.3));
      ctx.fillStyle = '#131c2e'; ctx.fill();
      ctx.restore();
      // header
      ctx.save();
      roundRect(x, y, w, hgt, 11 * Math.min(zoom, 1.3)); ctx.clip();
      ctx.fillStyle = b.color; ctx.globalAlpha = (dim ? 0.28 : 1) * 0.16;
      ctx.fillRect(x, y, w, BOX.headerH * zoom);
      ctx.restore();
      // border
      roundRect(x, y, w, hgt, 11 * Math.min(zoom, 1.3));
      const selected = id === state.selected || id === state.hover;
      ctx.lineWidth = selected ? 2.5 : 1.4;
      ctx.strokeStyle = selected ? '#818cf8' : (UNUSED.has(id) ? 'rgba(248,113,113,.7)' : b.color + '99');
      ctx.stroke();

      // header text
      ctx.globalAlpha = dim ? 0.35 : 1;
      ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      ctx.beginPath(); ctx.arc(x + 14 * zoom, y + (BOX.headerH / 2) * zoom, 5 * zoom, 0, Math.PI * 2);
      ctx.fillStyle = b.color; ctx.fill();
      ctx.font = `700 ${F.title * zoom}px -apple-system,Inter,sans-serif`;
      ctx.fillStyle = '#f2f6ff';
      ctx.textAlign = 'right';
      ctx.font = `700 ${F.meta * zoom}px -apple-system,Inter,sans-serif`;
      const kindTxt = KIND_LABEL[n.kind].toUpperCase();
      const kindW = ctx.measureText(kindTxt).width;
      ctx.fillStyle = b.color;
      ctx.fillText(kindTxt, x + w - 11 * zoom, y + (BOX.headerH / 2) * zoom + 1);
      ctx.textAlign = 'left';
      ctx.font = `700 ${F.title * zoom}px -apple-system,Inter,sans-serif`;
      ctx.fillStyle = '#f2f6ff';
      const nameMax = w - 24 * zoom - kindW - 16 * zoom;
      let nm = n.name;
      while (ctx.measureText(nm).width > nameMax && nm.length > 3) nm = nm.slice(0, -1);
      if (nm !== n.name) nm = nm.slice(0, -1) + '…';
      ctx.fillText(nm, x + 24 * zoom, y + (BOX.headerH / 2) * zoom + 1);
      // body
      ctx.textAlign = 'left';
      let ly = y + BOX.headerH * zoom + BOX.padY * zoom;
      for (const l of b.lines) {
        ctx.font = l.font.replace(/(\d+(?:\.\d+)?)px/, (m, s) => (parseFloat(s) * zoom) + 'px');
        ctx.fillStyle = l.color;
        ctx.fillText(l.t, x + BOX.padX * zoom, ly + (l.size * 1.35 * zoom) / 2);
        ly += (l.size * 1.35 + BOX.gap) * zoom;
      }
      ctx.globalAlpha = 1;
    }
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (state.renderMode === 'diagram') drawDiagram(); else drawGraph();
  }

  function fitView() {
    const ids = [...visible];
    if (!ids.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of ids) {
      const p = pos.get(id); if (!p) continue;
      let hw, hh;
      if (state.renderMode === 'diagram') { const b = boxFor(nodeById.get(id)); hw = b.w / 2; hh = b.h / 2; }
      else { const r = radius(nodeById.get(id)) + 22; hw = r; hh = r; }
      minX = Math.min(minX, p.x - hw); maxX = Math.max(maxX, p.x + hw);
      minY = Math.min(minY, p.y - hh); maxY = Math.max(maxY, p.y + hh);
    }
    // grouped mode draws container boxes (with a header) around the cards — frame those too
    if (state.renderMode === 'diagram' && state.groupBy) {
      for (const [scope, gids] of scopeGroups()) {
        if (state.collapsed.has(scope)) continue;
        const b = groupBounds(gids, 26, 30);
        minX = Math.min(minX, b.x); minY = Math.min(minY, b.y); maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
      }
    }
    if (!isFinite(minX)) return;
    const bw = Math.max(maxX - minX, 1), bh = Math.max(maxY - minY, 1);
    const margin = 48; // keep clear of the legend / hint overlays
    zoom = Math.min(2.2, Math.max(0.15, Math.min((W - margin * 2) / bw, (H - margin * 2) / bh)));
    pan = { x: W / 2 - ((minX + maxX) / 2) * zoom, y: H / 2 - ((minY + maxY) / 2) * zoom };
    updateZoomLabel();
    invalidate();
  }

  function zoomTo(mx, my, z) {
    const before = toWorld(mx, my);
    zoom = Math.min(4, Math.max(0.15, z));
    const after = toWorld(mx, my);
    pan.x += (after.x - before.x) * zoom; pan.y += (after.y - before.y) * zoom;
    updateZoomLabel();
    invalidate();
  }
  function zoomBy(f) { zoomTo(W / 2, H / 2, zoom * f); }
  function zoomReset() { zoomTo(W / 2, H / 2, 1); }
  function zoomAt(mx, my, f) { zoomTo(mx, my, zoom * f); }
  function zoomToNode(id) {
    const p = pos.get(id); if (!p) return;
    zoom = Math.min(2.6, Math.max(zoom, 1.5));
    pan = { x: W / 2 - p.x * zoom, y: H / 2 - p.y * zoom };
    updateZoomLabel();
    invalidate();
  }
  // The "100%" button doubles as a live zoom readout.
  function updateZoomLabel() { if (zoomResetBtn) zoomResetBtn.textContent = Math.round(zoom * 100) + '%'; }

  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  function safeName(s) { return String(s || 'project').replace(/[^a-z0-9._-]+/gi, '-'); }
  function exportPNG() {
    if (state.view !== 'diagram' && state.view !== 'graph') return;
    const out = document.createElement('canvas');
    out.width = canvas.width; out.height = canvas.height;
    const octx = out.getContext('2d');
    octx.fillStyle = '#0b0f17'; octx.fillRect(0, 0, out.width, out.height);
    octx.drawImage(canvas, 0, 0);
    out.toBlob((blob) => { if (blob) downloadBlob(blob, `skillmap-${safeName(META.projectLabel)}-${state.renderMode}.png`); }, 'image/png');
  }
  function exportJSON() {
    downloadBlob(new Blob([JSON.stringify(DATA, null, 2)], { type: 'application/json' }), `skillmap-${safeName(META.projectLabel)}.json`);
  }

  function loop() {
    if (dirty && (state.view === 'diagram' || state.view === 'graph')) { dirty = false; draw(); }
    requestAnimationFrame(loop);
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    W = rect.width; H = rect.height;
    canvas.width = Math.max(1, W * dpr); canvas.height = Math.max(1, H * dpr);
    invalidate();
  }
  window.addEventListener('resize', resize);

  /* ================= interaction ================= */
  function toWorld(mx, my) { return { x: (mx - pan.x) / zoom, y: (my - pan.y) / zoom }; }
  function hit(mx, my) {
    let best = null, bestD = Infinity;
    for (const id of visible) {
      const n = nodeById.get(id); const p = pos.get(id); if (!p) continue;
      if (state.renderMode === 'diagram' && state.groupBy && state.collapsed.has(n.scope)) continue;
      const sp = project(p);
      if (state.renderMode === 'diagram') {
        const b = boxFor(n);
        const inside = Math.abs(mx - sp.x) <= (b.w / 2) * zoom && Math.abs(my - sp.y) <= (b.h / 2) * zoom;
        const d = Math.hypot(mx - sp.x, my - sp.y);
        if (inside && d < bestD) { bestD = d; best = id; }
      } else {
        const d = Math.hypot(sp.x - mx, sp.y - my);
        if (d < radius(n) + 6 && d < bestD) { bestD = d; best = id; }
      }
    }
    return best;
  }
  function evPos(ev) { const r = canvas.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; }

  // Pointer events cover mouse, pen and touch. A press that moves more than a
  // few pixels is a drag/pan, not a click — so panning never drops the selection.
  let press = null;
  canvas.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    const m = evPos(ev);
    press = { x: m.x, y: m.y, moved: false };
    canvas.setPointerCapture(ev.pointerId);
    const id = hit(m.x, m.y);
    if (id) {
      const p = pos.get(id); const w = toWorld(m.x, m.y);
      dragging = { id, dx: p.x - w.x, dy: p.y - w.y };
    } else { panning = { x: m.x - pan.x, y: m.y - pan.y }; canvas.classList.add('dragging'); }
  });
  canvas.addEventListener('pointermove', (ev) => {
    const m = evPos(ev);
    if (press && !press.moved && Math.hypot(m.x - press.x, m.y - press.y) > 4) press.moved = true;
    if (dragging) {
      if (!press || !press.moved) return;
      const w = toWorld(m.x, m.y); const p = pos.get(dragging.id);
      p.x = w.x + dragging.dx; p.y = w.y + dragging.dy;
      invalidate();
    } else if (panning) {
      pan.x = m.x - panning.x; pan.y = m.y - panning.y;
      invalidate();
    } else {
      const id = hit(m.x, m.y);
      const g = hitGroup(m.x, m.y);
      canvas.style.cursor = (id || g) ? 'pointer' : '';
      if (id !== state.hover) { state.hover = id; invalidate(); }
    }
  });
  canvas.addEventListener('pointerleave', () => {
    if (!dragging && !panning && state.hover) { state.hover = null; invalidate(); }
  });
  const endPress = (ev) => {
    if (press && !press.moved) {
      const m = evPos(ev);
      const g = hitGroup(m.x, m.y);
      const id = hit(m.x, m.y);
      if (g) toggleCollapse(g);
      else select(id || null);
    }
    press = null; dragging = null; panning = null; canvas.classList.remove('dragging');
  };
  canvas.addEventListener('pointerup', endPress);
  canvas.addEventListener('pointercancel', () => { press = null; dragging = null; panning = null; canvas.classList.remove('dragging'); });
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const m = evPos(ev);
    zoomAt(m.x, m.y, Math.min(1.08, Math.max(0.92, Math.exp(-ev.deltaY * 0.0015))));
  }, { passive: false });
  canvas.addEventListener('dblclick', (ev) => {
    const m = evPos(ev);
    if (hitGroup(m.x, m.y)) return;            // don't fight the collapse toggle
    const id = hit(m.x, m.y);
    if (id) { select(id); zoomToNode(id); }     // double-click a card → zoom to it
    else { zoomAt(m.x, m.y, 1.6); }             // double-click empty space → zoom in there
  });

  function focusNode(id) {
    const n = nodeById.get(id); if (!n) return;
    // Make sure the target is actually on screen: lift filters/search hiding it
    // and expand its collapsed group.
    if (!computeVisible().has(id)) {
      if (state.query) { state.query = ''; searchEl.value = ''; }
      if (!state.kinds.has(n.kind)) { state.kinds.add(n.kind); filtersEl.querySelector(`[data-kind="${n.kind}"]`)?.setAttribute('aria-pressed', 'true'); }
      if (!state.scopes.has(n.scope)) { state.scopes.add(n.scope); filtersEl.querySelector(`[data-scope="${CSS.escape(n.scope)}"]`)?.setAttribute('aria-pressed', 'true'); }
    }
    if (state.collapsed.has(n.scope)) { state.collapsed.delete(n.scope); if (state.groupBy) layout(); }
    select(id);
    setView(state.renderMode);
    const p = pos.get(id);
    if (p) { zoom = state.renderMode === 'diagram' ? Math.max(zoom, 0.85) : Math.max(zoom, 0.9); pan = { x: W / 2 - p.x * zoom, y: H / 2 - p.y * zoom }; }
    updateZoomLabel();
    invalidate();
  }
  window.__skillmapFocus = focusNode;

  /* ================= drawer ================= */
  const drawer = document.getElementById('drawer');
  function select(id) {
    state.selected = id;
    renderDrawer();
    invalidate();
  }

  function renderDrawer() {
    const id = state.selected;
    if (!id) {
      drawer.innerHTML = '';
      drawer.append(h('div', { class: 'drawer-empty' },
        h('h2', null, 'Details'),
        h('p', { html: 'Select a card or node — in <b>Diagram</b>, <b>Graph</b> or <b>Insights</b> — to inspect it, its path and every connection.' })));
      return;
    }
    const n = nodeById.get(id);
    drawer.innerHTML = '';
    const absPath = META.root.replace(/[\\/]+$/, '') + '/' + n.rel;
    const copyBtn = h('button', { class: 'linkbtn', title: absPath, onclick: () => copyText(absPath, copyBtn) }, 'Copy path');
    drawer.append(
      h('div', { class: 'drawer-head' },
        h('span', { class: 'node-kind k-' + n.kind }, KIND_LABEL[n.kind], ' · ', n.scope),
        h('button', { class: 'reader-close', 'aria-label': 'Close details (Esc)', title: 'Close (Esc)', onclick: () => select(null) }, '✕')),
      h('h2', null, n.name),
      h('div', { class: 'path' }, n.rel, ' ', copyBtn),
    );
    const flags = [];
    if (UNUSED_LEAF.has(n.id)) flags.push(['bad', '⚠ Unused — nothing references it']);
    if (UNUSED_ORG.has(n.id)) flags.push(['warn', 'Orphan organizer — references others but is never invoked']);
    if (MANUAL.has(n.id)) flags.push(['warn', 'Invoked manually (model-invocation disabled)']);
    if (n.isOrganizer) flags.push(['ok', `Organizer — ${n.children.length} children`]);
    if (DUP_NAME.has(n.id)) flags.push(['warn', 'Duplicate name in project']);
    const sim = A.similarNames.filter(d => d.ids.includes(n.id)).map(d => nameOf(d.ids.find(x => x !== n.id)));
    if (sim.length) flags.push(['warn', `Name very similar to: ${sim.join(', ')}`]);
    if (n.inDegree > 0) flags.push(['ok', `${n.inDegree} incoming reference(s)`]);
    for (const [tone, txt] of flags) drawer.append(h('div', { class: 'flag ' + tone, style: 'margin:0 0 6px' }, txt));

    if (n.description) drawer.append(h('div', { class: 'desc', style: 'margin-top:10px' }, n.description));

    const meta = [];
    if (n.model) meta.push(['model', n.model]);
    if (n.mode) meta.push(['mode', n.mode]);
    if (n.commandOnly) meta.push(['command', 'yes']);
    if (n.argumentHint) meta.push(['args', n.argumentHint]);
    if (n.tools && n.tools.length) meta.push(['tools', n.tools.join(', ')]);
    meta.push(['lines', n.lines]);
    drawer.append(h('div', { class: 'meta' }, meta.map(([k, v]) => h('span', { class: 'm' }, h('b', null, k + ': '), v))));

    const xd = A.scopeDivergence.find(d => d.ids.includes(n.id));
    if (xd) {
      drawer.append(h('button', { class: 'read-btn', style: 'margin-bottom:14px', onclick: () => openDiff(xd.ids) },
        '⇄ Compare copies', h('span', { style: 'color:var(--tx3);font-weight:500' }, `(${xd.scopes.join(' · ')})`)));
    }

    const out = E.filter(e => e.source === id);
    const inc = E.filter(e => e.target === id);
    drawer.append(connSection('Uses / delegates to', out.map(e => [e.target, '→', e.type, e.evidence])));
    drawer.append(connSection('Referenced by', inc.map(e => [e.source, '←', e.type, e.evidence])));

    if (n.raw) {
      drawer.append(h('div', { class: 'sec-title' }, 'Definition'));
      const lines = n.raw.split('\n');
      const preview = lines.slice(0, 14).join('\n') + (lines.length > 14 ? '\n…' : '');
      drawer.append(h('pre', { class: 'raw-preview' }, preview));
      drawer.append(h('button', { class: 'read-btn', onclick: () => openReader(n.id) },
        '⤢ Read full definition', h('span', { style: 'color:var(--tx3);font-weight:500' }, `(${lines.length} lines)`)));
    }
  }

  function copyText(text, btn) {
    const done = () => { const o = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = o; }, 1200); };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, () => fallback());
    else fallback();
    function fallback() {
      const ta = h('textarea', { style: 'position:fixed;opacity:0' }); ta.value = text;
      document.body.append(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch { /* ignore */ }
      ta.remove();
    }
  }

  /* ---- minimal, dependency-free Markdown renderer (text is escaped first) ---- */
  // Quotes are escaped too: link URLs end up inside href="…".
  function mdEscape(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function mdInline(s) {
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (m, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    return s
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) =>
        /^(javascript|data|vbscript):/i.test(u) ? t : `<a href="${u}" target="_blank" rel="noopener">${t}</a>`)
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m, pre, u) => `${pre}<a href="${u}" target="_blank" rel="noopener">${u}</a>`)
      .replace(/\u0000(\d+)\u0000/g, (m, i) => `<code>${codes[+i]}</code>`);
  }
  function renderMarkdown(src) {
    let fm = '';
    let body = String(src).replace(/\r\n/g, '\n');
    const m = body.match(/^---\n([\s\S]*?)\n---\n?/);
    if (m) {
      const rows = m[1].split('\n').map((l) => {
        const i = l.indexOf(':');
        return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : null;
      }).filter(Boolean);
      if (rows.length) fm = '<table class="md-fm">' + rows.map(([k, v]) =>
        `<tr><th>${mdEscape(k)}</th><td>${mdInline(mdEscape(v))}</td></tr>`).join('') + '</table>';
      body = body.slice(m[0].length);
    }
    const lines = body.split('\n');
    const out = [];
    let para = [];
    const flush = () => { if (para.length) { out.push('<p>' + mdInline(mdEscape(para.join(' '))) + '</p>'); para = []; } };
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const fence = line.match(/^```(.*)$/);
      if (fence) {
        flush();
        const buf = []; i++;
        while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        out.push('<pre class="md-code"><code>' + mdEscape(buf.join('\n')) + '</code></pre>');
        continue;
      }
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { flush(); const lv = h[1].length; out.push(`<h${lv}>${mdInline(mdEscape(h[2]))}</h${lv}>`); i++; continue; }
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }
      if (/^\s*>\s?/.test(line)) {
        flush(); const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        out.push('<blockquote>' + mdInline(mdEscape(buf.join(' '))) + '</blockquote>');
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^[\s|:-]+$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
        flush();
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(lines[i]); i++; }
        const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        const head = cells(rows[0]);
        const rest = rows.slice(2).map(cells);
        out.push('<table class="md-table"><thead><tr>' + head.map((c) => `<th>${mdInline(mdEscape(c))}</th>`).join('') +
          '</tr></thead><tbody>' + rest.map((r) => '<tr>' + r.map((c) => `<td>${mdInline(mdEscape(c))}</td>`).join('') + '</tr>').join('') +
          '</tbody></table>');
        continue;
      }
      if (/^\s*[-*+]\s+/.test(line)) {
        flush(); const items = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*+]\s+/, '')); i++; }
        out.push('<ul>' + items.map((t) => `<li>${mdInline(mdEscape(t))}</li>`).join('') + '</ul>');
        continue;
      }
      if (/^\s*\d+\.\s+/.test(line)) {
        flush(); const items = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, '')); i++; }
        out.push('<ol>' + items.map((t) => `<li>${mdInline(mdEscape(t))}</li>`).join('') + '</ol>');
        continue;
      }
      if (/^\s*$/.test(line)) { flush(); i++; continue; }
      para.push(line.trim()); i++;
    }
    flush();
    return (fm ? `<div class="md-fm-wrap">${fm}</div>` : '') + out.join('\n');
  }

  // Modal shell shared by the reader, the diff and the help: Esc / backdrop
  // closes it, focus moves in and is restored on close, only one at a time.
  function openOverlay(label, build) {
    document.querySelector('.reader-overlay')?.__close?.();
    const prevFocus = document.activeElement;
    const overlay = h('div', { class: 'reader-overlay', onclick: (e) => { if (e.target === overlay) close(); } });
    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      if (prevFocus && prevFocus.focus) prevFocus.focus();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); close(); }
    };
    overlay.__close = close;
    const closeBtn = h('button', { class: 'reader-close', 'aria-label': 'Close (Esc)', title: 'Close (Esc)', onclick: close }, '✕');
    const panel = build(closeBtn, close);
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', label);
    overlay.append(panel);
    document.body.append(overlay);
    document.addEventListener('keydown', onKey, true);
    closeBtn.focus();
    return close;
  }

  function openReader(id) {
    const n = nodeById.get(id);
    if (!n || !n.raw) return;
    openOverlay(`Definition of ${n.name}`, (closeBtn) => h('div', { class: 'reader' },
      h('div', { class: 'reader-head' },
        h('span', { class: 'node-kind k-' + n.kind }, KIND_LABEL[n.kind], ' · ', n.scope),
        h('span', { class: 'reader-title' }, n.name),
        h('span', { class: 'reader-path', title: n.rel }, n.rel),
        closeBtn),
      h('div', { class: 'reader-body', tabindex: '0', html: renderMarkdown(n.raw) })));
  }
  function diffLines(a0, b0) {
    // Strip the common head/tail first — copies usually differ in a few spots,
    // and it keeps the O(n·m) table small.
    let pre = 0;
    while (pre < a0.length && pre < b0.length && a0[pre] === b0[pre]) pre++;
    let suf = 0;
    while (suf < a0.length - pre && suf < b0.length - pre && a0[a0.length - 1 - suf] === b0[b0.length - 1 - suf]) suf++;
    const a = a0.slice(pre, a0.length - suf), b = b0.slice(pre, b0.length - suf);
    const head = a0.slice(0, pre).map(x => ({ t: ' ', x }));
    const tail = a0.slice(a0.length - suf).map(x => ({ t: ' ', x }));
    const n = a.length, m = b.length;
    if (n * m > 4e6) {
      // too big for an exact diff in the browser — show it as a block replacement
      return [...head, ...a.map(x => ({ t: '-', x })), ...b.map(x => ({ t: '+', x })), ...tail];
    }
    const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const out = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { out.push({ t: ' ', x: a[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: '-', x: a[i] }); i++; }
      else { out.push({ t: '+', x: b[j] }); j++; }
    }
    while (i < n) out.push({ t: '-', x: a[i++] });
    while (j < m) out.push({ t: '+', x: b[j++] });
    return [...head, ...out, ...tail];
  }

  function openDiff(ids) {
    const a = nodeById.get(ids[0]), b = nodeById.get(ids[1]);
    if (!a || !b) return;
    const al = (a.raw || '').replace(/\r\n/g, '\n').split('\n');
    const bl = (b.raw || '').replace(/\r\n/g, '\n').split('\n');
    const diff = diffLines(al, bl);
    const added = diff.filter((d) => d.t === '+').length;
    const removed = diff.filter((d) => d.t === '-').length;
    // keep changes + 3 context lines, collapse the rest
    const CTX = 3;
    const keep = new Array(diff.length).fill(false);
    diff.forEach((d, i) => { if (d.t !== ' ') for (let k = Math.max(0, i - CTX); k <= Math.min(diff.length - 1, i + CTX); k++) keep[k] = true; });
    const rows = []; let skip = 0;
    for (let i = 0; i < diff.length; i++) {
      if (keep[i]) { if (skip) { rows.push({ skip }); skip = 0; } rows.push(diff[i]); }
      else skip++;
    }
    if (skip) rows.push({ skip });

    const body = h('div', { class: 'diff-body', tabindex: '0' });
    if (!added && !removed) body.append(h('div', { class: 'diff-line d-ctx' }, 'The two copies are identical.'));
    for (const r of rows) {
      if (r.skip) { body.append(h('div', { class: 'diff-line d-skip' }, `⋯ ${r.skip} unchanged line${r.skip > 1 ? 's' : ''}`)); continue; }
      const cls = r.t === '+' ? 'd-add' : r.t === '-' ? 'd-del' : 'd-ctx';
      body.append(h('div', { class: 'diff-line ' + cls }, r.t + ' ' + r.x));
    }
    const title = a.name === b.name ? a.name : `${a.name} ↔ ${b.name}`;
    openOverlay(`Compare ${title}`, (closeBtn, close) => {
      const show = (n) => h('button', { class: 'linkbtn', title: n.rel, onclick: () => { close(); focusNode(n.id); } }, `Show ${n.name} (${n.scope})`);
      return h('div', { class: 'reader' },
        h('div', { class: 'reader-head' },
          h('span', { class: 'node-kind k-' + a.kind }, 'Compare'),
          h('span', { class: 'reader-title' }, title),
          h('span', { class: 'diff-stat' }, h('b', { class: 'd-add-t' }, `+${added}`), ' ', h('b', { class: 'd-del-t' }, `−${removed}`)),
          closeBtn),
        h('div', { class: 'diff-sub' },
          h('div', null, h('span', { class: 'd-del-t' }, '− '), `${a.scope}  ${a.rel}`),
          h('div', null, h('span', { class: 'd-add-t' }, '+ '), `${b.scope}  ${b.rel}`),
          ids.length > 2 ? h('div', null, `(${ids.length} copies exist — comparing the first two)`) : null,
          h('div', { class: 'diff-actions' }, show(a), show(b))),
        body);
    });
  }

  function connSection(title, rows) {
    const wrap = h('div', null, h('div', { class: 'sec-title' }, `${title} (${rows.length})`));
    const list = h('div', { class: 'conn' });
    if (!rows.length) list.append(h('p', { class: 'hintp' }, 'None'));
    const nameCount = {};
    for (const [nid] of rows) { const nm = nameOf(nid); nameCount[nm] = (nameCount[nm] || 0) + 1; }
    for (const [nid, dir, type, evidence] of rows) {
      const t = nodeById.get(nid); if (!t) continue;
      // same name twice (e.g. two AGENTS.md) → tell them apart by path
      const where = nameCount[t.name] > 1 ? t.rel : (t.scope !== nodeById.get(state.selected)?.scope ? t.scope : '');
      // Show *why* the link was detected, so false positives are easy to spot.
      const ev = (evidence || [])[0];
      list.append(h('button', { class: 'c', title: (evidence || []).join('\n') || null, onclick: () => focusNode(nid) },
        h('span', { class: 'crow' },
          h('span', { class: 'dir' }, dir), kindDot(t.kind),
          h('span', { class: 'nm' }, t.name),
          h('span', { class: 'tag' }, where),
          h('span', { class: 'ty' }, EDGE_LABEL[type] || type)),
        ev ? h('span', { class: 'ev' }, '“' + ev + '”') : null));
    }
    wrap.append(list);
    return wrap;
  }

  /* ================= insights ================= */
  function renderInsights() {
    const root = document.getElementById('insights');
    root.innerHTML = '';
    let issues = 0;
    root.append(
      h('h2', null, 'Insights'),
      h('p', { class: 'lead' }, 'Structural findings to keep your skill library tidy: skills nothing uses, names that collide, descriptions that overlap, and the organizers that tie everything together.'),
    );
    const grid = h('div', { class: 'grid' });

    grid.append(card(`Unused skills`, A.unusedLeaves, 'bad',
      'Skills nothing references — no agent, instruction file or other skill uses them. Candidates for deletion or wiring in.', false));
    issues += A.unusedLeaves.length;

    grid.append(card(`Orphan organizers`, A.unusedOrganizers, 'warn',
      'Organizer skills that reference other skills but are themselves never invoked. Link them to an agent or a parent skill.', false));
    issues += A.unusedOrganizers.length;

    grid.append(groupCard(`Duplicate names`, A.duplicateNames,
      'The same skill/agent name exists in more than one place (often the same skill copied across scopes). Click to compare the copies.',
      (d) => `${d.ids.length}×`));
    issues += A.duplicateNames.length;

    grid.append(groupCard(`Similar names`, A.similarNames,
      'Names close enough to be confusing (plurals, typos, or design vs design-system). Click to compare both files.',
      (d) => `${Math.round(d.score * 100)}%`));
    issues += A.similarNames.length;

    grid.append(groupCard(`Overlapping descriptions`, A.descDupes,
      'Pairs whose descriptions are ≥40% similar — they likely cover the same ground. Click to compare both files.',
      (d) => `${Math.round(d.score * 100)}%`));
    issues += A.descDupes.length;

    grid.append(groupCard(`Cross-scope copies`, A.scopeDivergence,
      'The same skill/agent name lives in more than one scope (.claude / .opencode / .codex). The % is how much of the file the copies share — low means they have drifted apart. Click to see the exact diff.',
      (d) => `${Math.round(d.similarity * 100)}%${d.diverged ? ' · drifted' : ''}`,
      (d) => d.scopes.join(' · ')));
    issues += A.scopeDivergence.filter(d => d.diverged).length;

    grid.append(card(`Organizers`, A.organizers.map(o => o.id), 'ok',
      'Nodes that orchestrate 2+ children. Great hubs — click to explore their reach.', false, null));

    grid.append(cycleCard());
    issues += A.cycles.length;

    grid.append(card(`Most connected`, A.godNodes, 'ok',
      'Highest degree hubs in the graph — the backbone of this project.', false,
      (id) => { const n = nodeById.get(id); return `${n.degree}°`; }, 'info'));

    root.append(grid);

    root.append(h('div', { class: 'sec-title' }, 'Scanned locations'));
    const scopes = Object.entries(A.scopes).sort((a, b) => b[1] - a[1]);
    root.append(h('div', { class: 'meta', style: 'margin-bottom:24px' },
      scopes.map(([s, c]) => h('span', { class: 'm' }, h('b', null, s + ': '), c))));

    document.getElementById('insightCount').textContent = String(issues);
  }

  function card(title, ids, tone, hint, isNodeList, badge, kind, onItem) {
    const c = h('div', { class: 'card' });
    c.append(h('h3', null, title, h('span', { class: 'count' }, String(ids.length))));
    c.append(h('p', { class: 'hintp' }, hint));
    const list = h('div', { class: 'itemlist' });
    if (!ids.length) list.append(h('div', { class: 'empty-ok' }, '✓ None found'));
    const items = ids.map((id) => {
      const n = nodeById.get(id); if (!n) return null;
      const b = badge ? h('span', { class: 'score' }, badge(id)) : null;
      return h('button', { class: 'item', title: n.rel, onclick: onItem ? () => onItem(id) : () => focusNode(id) },
        kindDot(n.kind), h('span', { class: 'nm' }, n.name), b, h('span', { class: 'tag' }, n.scope));
    }).filter(Boolean);
    appendCapped(list, items);
    c.append(list);
    return c;
  }

  // Findings that involve several nodes (pairs or copies): show every name, click to compare.
  function groupCard(title, groups, hint, badge, sub) {
    const c = h('div', { class: 'card' });
    c.append(h('h3', null, title, h('span', { class: 'count' }, String(groups.length))));
    c.append(h('p', { class: 'hintp' }, hint));
    const list = h('div', { class: 'itemlist' });
    if (!groups.length) list.append(h('div', { class: 'empty-ok' }, '✓ None found'));
    const items = groups.map((d) => {
      const ns = d.ids.map(id => nodeById.get(id)).filter(Boolean);
      if (!ns.length) return null;
      const sameName = ns.every(n => n.name === ns[0].name);
      const label = sameName ? ns[0].name : ns.map(n => n.name).join(' ↔ ');
      const tag = sub ? sub(d) : [...new Set(ns.map(n => n.scope))].join(' · ');
      return h('button', { class: 'item', title: ns.map(n => n.rel).join('\n'), onclick: () => ns.length > 1 ? openDiff(d.ids) : focusNode(ns[0].id) },
        kindDot(ns[0].kind), h('span', { class: 'nm' }, label), h('span', { class: 'score' }, badge(d)), h('span', { class: 'tag' }, tag));
    }).filter(Boolean);
    appendCapped(list, items);
    c.append(list);
    return c;
  }

  // Show the first 12 items, with a button to reveal the rest.
  function appendCapped(list, items, cap = 12) {
    items.slice(0, cap).forEach(el => list.append(el));
    if (items.length > cap) {
      const more = h('button', { class: 'linkbtn', onclick: () => { more.replaceWith(...items.slice(cap)); } }, `Show ${items.length - cap} more`);
      list.append(more);
    }
  }

  function cycleCard() {
    const c = h('div', { class: 'card' });
    c.append(h('h3', null, 'Reference cycles', h('span', { class: 'count' }, String(A.cycles.length))));
    c.append(h('p', { class: 'hintp' }, 'Circular references (A → B → … → A) make orchestration ambiguous.'));
    const list = h('div', { class: 'itemlist' });
    if (!A.cycles.length) list.append(h('div', { class: 'empty-ok' }, '✓ None found'));
    const items = A.cycles.map((cyc) => {
      const names = cyc.map(id => (nodeById.get(id) || {}).name).filter(Boolean);
      if (!names.length) return null;
      const path = names.join(' → ') + ' → ' + names[0];
      return h('button', { class: 'item', title: path, onclick: () => focusNode(cyc[0]) },
        kindDot(nodeById.get(cyc[0]).kind), h('span', { class: 'nm' }, path));
    }).filter(Boolean);
    appendCapped(list, items);
    c.append(list);
    return c;
  }

  /* ================= hierarchy ================= */
  function renderHierarchy() {
    const root = document.getElementById('hierarchy');
    root.innerHTML = '';
    root.append(
      h('h2', null, 'Hierarchy'),
      h('p', { class: 'lead' }, 'Organizer skills expand into their children. Use this to confirm the tree you intended, spot shared helpers, and find skills stranded on their own.'),
    );

    const organizers = A.organizers.map(o => nodeById.get(o.id)).filter(Boolean);
    const childOf = new Set();
    for (const o of A.organizers) for (const c of o.children) childOf.add(c);

    if (!organizers.length) root.append(h('p', { class: 'hintp' }, 'No organizer skills (skills that reference 2+ others) found.'));

    root.append(h('div', { class: 'sec-title' }, 'Organizers'));
    const tree = h('div', { class: 'tree' });
    organizers.forEach((o, i) => tree.append(treeOrganizer(o, new Set(), i < 3)));
    root.append(tree);

    root.append(h('div', { class: 'sec-title' }, 'Agents → skills they reference'));
    const agents = N.filter(n => n.kind === 'agent').sort((a, b) => b.outDegree - a.outDegree);
    if (!agents.length) root.append(h('p', { class: 'hintp' }, 'No agents found.'));
    for (const a of agents) {
      const out = E.filter(e => e.source === a.id).map(e => nodeById.get(e.target)).filter(Boolean);
      if (!out.length) continue;
      const obj = h('div', { class: 'robj' });
      obj.append(h('div', { class: 'rhead' }, kindDot('agent'), h('span', { class: 'nm' }, a.name), h('span', { class: 'n' }, `(${a.scope})`)));
      for (const t of out) obj.append(leaf(t, () => focusNode(t.id)));
      root.append(obj);
    }

    const orphans = N.filter(n => n.kind === 'skill' && childOf.size && !childOf.has(n.id) && !n.isOrganizer && n.inDegree === 0);
    root.append(h('div', { class: 'sec-title' }, 'Stranded skills'));
    if (!orphans.length) root.append(h('p', { class: 'empty-ok' }, '✓ Every skill is either an organizer, a child, or referenced by something.'));
    else for (const n of orphans) root.append(leaf(n, () => focusNode(n.id)));
  }

  function treeOrganizer(o, path, open) {
    const det = h('details', { class: 'tnode' });
    if (open) det.open = true;
    const kids = o.children.map(c => nodeById.get(c)).filter(Boolean);
    det.append(h('summary', null, h('span', { class: 'caret' }, '▶'), kindDot(o.kind),
      h('span', { style: 'flex:1' }, o.name), h('span', { class: 'tag', style: 'color:var(--tx3);font-size:11px' }, `${kids.length} children`)));
    const wrap = h('div', { class: 'tchildren' });
    const nextPath = new Set(path).add(o.id);
    for (const k of kids) {
      if (k.isOrganizer && !nextPath.has(k.id)) wrap.append(treeOrganizer(k, nextPath, false));
      else wrap.append(leaf(k, () => focusNode(k.id)));
    }
    det.append(wrap);
    return det;
  }
  function leaf(n, onclick) {
    return h('div', { class: 'tleaf', role: 'button', tabindex: '0', title: n.rel, onclick, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onclick(); } } },
      kindDot(n.kind), h('span', { class: 'nm' }, n.name), h('span', { class: 'tag', style: 'color:var(--tx3);font-size:10.5px' }, n.scope));
  }

  /* ================= legend ================= */
  const legend = document.getElementById('legend');
  const legendBody = h('div', { class: 'legend-body', id: 'legendBody' },
    row(h('span', { class: 'sw', style: `background:${KIND_COLOR.skill}` }), 'Skill'),
    row(h('span', { class: 'sw', style: `background:${KIND_COLOR.agent}` }), 'Agent'),
    row(h('span', { class: 'sw', style: `background:${KIND_COLOR.instructions}` }), 'Instructions'),
    h('div', { style: 'height:4px' }),
    ...Object.keys(EDGE_LABEL).map(t => row(h('span', { class: 'ln', style: `background:${EDGE_COLOR[t]}` }), '→ ' + EDGE_LABEL[t])),
    h('div', { style: 'height:4px' }),
    row(h('span', { class: 'sw', style: 'border:2px solid #f87171;background:transparent' }), 'red outline = unused'),
    row(h('span', { class: 'sw', style: 'border:2px solid #fbbf24;background:transparent' }), 'amber ring = organizer (graph)'),
  );
  // Collapsible so it never hides cards on small screens; remembered per browser.
  let legendOpen = false;
  try { legendOpen = localStorage.getItem('skillmap.legend') === 'open'; } catch { legendOpen = false; }
  const legendToggle = h('button', { class: 'legend-toggle', 'aria-controls': 'legendBody', onclick: () => setLegend(!legendOpen) });
  function setLegend(open) {
    legendOpen = open;
    legendBody.hidden = !open;
    legendToggle.textContent = open ? 'Legend ▾' : 'Legend ▸';
    legendToggle.setAttribute('aria-expanded', String(open));
    try { localStorage.setItem('skillmap.legend', open ? 'open' : 'closed'); } catch { /* storage unavailable */ }
  }
  legend.append(legendToggle, legendBody);
  setLegend(legendOpen);
  function row(a, b) { return h('div', { class: 'row' }, a, b); }

  /* ================= runtime (session traces) ================= */
  const RT = DATA.runtime;
  const SPAN_COLOR = { agent: '#38bdf8', skill: '#a78bfa', read: '#64748b', search: '#64748b', edit: '#34d399', exec: '#f59e0b', web: '#f472b6', other: '#7c8aa3', think: '#e879f9' };
  const FLAG_LABEL = { failed: 'failed', cancelled: 'cancelled', trivial: 'trivial', lookup: 'simple lookup', redone: 'work redone', duplicate: 'duplicate' };
  const HOW_LABEL = { 'user-attached': 'you attached it', 'user-named': 'you named it', 'model-chose': 'model chose', 'subagent-chose': 'subagent chose' };
  const fmtMs = (ms) => ms >= 3600000 ? `${(ms / 3600000).toFixed(1)} h` : ms >= 60000 ? `${(ms / 60000).toFixed(1)} min` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
  const fmtTok = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n));
  const fmtPct = (x) => `${Math.round(x * 100)}%`;
  const fmtDate = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const fmtTime = (t) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const fmtClock = (ms) => {
    const s = Math.round(ms / 1000), hh = Math.floor(s / 3600), mm = Math.floor(s % 3600 / 60), ss = s % 60;
    return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
  };
  const tokTotal = (t) => t.input + t.output + t.reasoning + t.cacheRead + t.cacheWrite;
  const nodeByName = (name) => N.find(n => n.name === name || n.slug === name) || null;

  const rtTraces = new Map(), rtRootOf = new Map();
  if (RT) {
    const index = (t, root) => { rtTraces.set(t.id, t); rtRootOf.set(t.id, root); t.children.forEach(c => index(c, root)); };
    RT.traces.forEach(t => index(t, t.id));
  }
  const rtKey = (traceId, spanId) => traceId + '|' + spanId;
  const rtDecision = new Map(RT ? RT.analysis.decisions.map(d => [rtKey(d.traceId, d.spanId), d]) : []);
  const rtDelegation = new Map(RT ? RT.analysis.delegations.map(d => [rtKey(d.traceId, d.spanId), d]) : []);
  const rtSession = new Map(RT ? RT.analysis.sessions.map(x => [x.id, x]) : []);
  const rtState = { session: null, tab: 'overview', onlyKey: true, filter: '', sort: 'recent', focusSpan: null, stepFilter: 'all', lane: 'all' };
  const SESSION_SORT = {
    recent: ['Most recent', (a, b) => b.start - a.start],
    waste: ['Most wasted tokens', (a, b) => b.wasteTokens - a.wasteTokens || b.flagged - a.flagged],
    hotspots: ['Most hotspots', (a, b) => b.hotspots - a.hotspots],
    tokens: ['Most tokens', (a, b) => b.tokens - a.tokens],
    time: ['Longest', (a, b) => b.activeMs - a.activeMs],
    errors: ['Most errors', (a, b) => b.errors - a.errors],
  };
  function* walkRt(t) { yield t; for (const c of t.children) yield* walkRt(c); }
  const VARIANT_TIP = 'Reasoning level OpenCode sent with each call. “default” = no level sent, the provider decides.';
  function variantChip(v, mismatch) {
    if (!v) return null;
    return h('span', { class: 'rt-var v-' + v + (mismatch ? ' mismatch' : ''), title: VARIANT_TIP }, 'thinking: ' + v);
  }
  const median = (xs) => { const a = [...xs].sort((p, q) => p - q); return a.length ? a[Math.floor(a.length / 2)] : 0; };

  // How a step's time splits. The parent waiting on a subagent or on you is
  // shown, but not counted as agent work: the subagent's own steps hold that time.
  const TIME_PARTS = [
    ['waitMs', 'Waiting for the model', '#64748b', 'Nothing came back from the model yet: provider queue, network, or a long prompt to process.'],
    ['thinkMs', 'Thinking', SPAN_COLOR.think, 'The model reasoning before it acts.'],
    ['toolMs', 'Tools', SPAN_COLOR.exec, 'Running commands, reading, searching and editing files.'],
    ['writeMs', 'Writing', '#94a3b8', 'The model writing its answer or tool arguments.'],
  ];
  const WAIT_PARTS = [
    ['agentMs', 'Waiting on a subagent', SPAN_COLOR.agent, 'The agent sits idle while a subagent works. That work shows in the subagent’s own lane.'],
    ['userMs', 'Waiting on you', '#334155', 'The agent asked you a question and waited for the answer.'],
  ];
  const HOT_INFO = {
    'slow-thinking': ['Slow thinking', 'The model spent a long time reasoning in a single step before doing anything.'],
    'model-wait': ['Waiting for the model', 'Nothing came back from the model for a while: provider queue, network, or a very long prompt.'],
    'big-context': ['Huge context', 'The conversation got so long that every following step re-reads it. Each step gets slower and more expensive.'],
    'slow-tool': ['Slow tool', 'One tool call (a shell command, a fetch…) took over a minute.'],
    reread: ['File read again and again', 'The same file was read three or more times.'],
    'repeat-command': ['Repeated command', 'The exact same command ran more than once.'],
    'error-loop': ['Error loop', 'The same tool failed several times in a row.'],
    rumination: ['Second-guessing', 'The reasoning keeps doubting itself. Inferred from the model’s own words, so treat it as a hint, not a fact.'],
  };

  function stepTotals(steps) {
    const tot = Object.fromEntries([...TIME_PARTS, ...WAIT_PARTS].map(([k]) => [k, 0]));
    for (const st of steps) for (const k of Object.keys(tot)) tot[k] += st[k] || 0;
    tot.work = TIME_PARTS.reduce((n, [k]) => n + tot[k], 0);
    return tot;
  }

  /* ---------- Runtime tab: overview of every session ---------- */
  function renderRuntime() {
    const root = document.getElementById('runtime');
    root.innerHTML = '';
    root.append(h('h2', null, 'Runtime'));
    if (!RT) {
      document.getElementById('runtimeCount').textContent = '–';
      root.append(h('p', { class: 'lead' }, 'No OpenCode sessions were found for this folder, so there is nothing to trace yet. Run OpenCode here and regenerate the report (skillmap reads ~/.local/share/opencode/opencode.db; needs Node 22.5+). Use --since 365d to look further back.'));
      return;
    }
    const R = RT.analysis, c = R.counts, w = R.waste;
    document.getElementById('runtimeCount').textContent = String(w.delegations);
    root.append(h('p', { class: 'lead' }, `What actually happened when agents worked in this project — OpenCode sessions from the last ${RT.since}. Facts come straight from the runtime; anything inferred (like “unnecessary”) is labelled as a heuristic. Open a session below to replay it step by step.`));

    root.append(h('div', { class: 'kpis' },
      kpi('Sessions', c.sessions, `${c.subagentSessions} subagent sessions`),
      kpi('Tool calls', c.toolCalls, `${c.skillCalls} skill loads`),
      kpi('Delegations', c.delegations, `${R.agents.length} subagent types`),
      kpi('Flagged delegations', w.delegations, c.delegations ? `${fmtPct(w.delegations / c.delegations)} of all delegations` : '', w.delegations ? 'bad' : 'ok'),
      kpi('Time in flagged', fmtMs(w.durationMs), 'upper bound', w.durationMs ? 'warn' : 'ok'),
      kpi('Tokens in flagged', fmtTok(w.tokens), `≈ $${w.cost.toFixed(2)}`, w.tokens ? 'warn' : 'ok')));

    // sessions first: it is what people come here for
    root.append(h('div', { class: 'sec-title' }, 'Sessions'));
    root.append(sessionsTable());

    root.append(h('div', { class: 'sec-title' }, 'Delegations that look unnecessary'));
    root.append(h('p', { class: 'hintp rt-note' }, 'Heuristics: trivial = subagent made ≤ 2 tool calls · simple lookup = only a few reads/searches · work redone = the parent re-read files the subagent had read · duplicate = same subagent, near-identical prompt · failed/cancelled = time spent for nothing.'));
    const flagged = R.delegations.filter(d => d.flags.length).sort((a, b) => b.tokens - a.tokens);
    const fl = h('div', { class: 'rt-flagged' });
    if (!flagged.length) fl.append(h('div', { class: 'empty-ok' }, '✓ No delegation looks unnecessary'));
    appendCapped(fl, flagged.map(d => h('button', { class: 'item rt-deleg', onclick: () => openSession(rtRootOf.get(d.traceId), { span: d.spanId }) },
      h('span', { class: 'dot', style: `background:${SPAN_COLOR.agent}` }),
      h('span', { class: 'rt-dmain' },
        h('span', { class: 'nm' }, h('b', null, d.agent), ' — ', d.description || '(no description)'),
        h('span', { class: 'rt-why' }, d.flags.map(f => f.detail).join(' · '))),
      h('span', { class: 'rt-flags' }, d.flags.map(f => flagChip(f.type))),
      h('span', { class: 'rt-num' }, fmtMs(d.durationMs)),
      h('span', { class: 'rt-num' }, fmtTok(d.tokens) + ' tok'))), 6);
    root.append(fl);

    const grid = h('div', { class: 'rt-two' });
    grid.append(skillTable(R), agentTable(R));
    root.append(grid);

    const usedSkills = new Set(R.skills.map(s => s.name)), usedAgents = new Set(R.agents.map(a => a.name));
    const neverRan = N.filter(n => (n.kind === 'skill' && !usedSkills.has(n.name) && !usedSkills.has(n.slug)) || (n.kind === 'agent' && !usedAgents.has(n.name) && !usedAgents.has(n.slug)));
    if (N.length) {
      const grid2 = h('div', { class: 'grid', style: 'margin-top:16px' });
      grid2.append(card('Defined but never ran', neverRan.map(n => n.id), 'warn',
        `Skills and agents defined in this project that no OpenCode session used in the last ${RT.since}. Compare with “Unused skills” in Insights: that one is about references, this one is about real runs.`, false));
      root.append(grid2);
    }
  }

  function sessionsTable() {
    const wrap = h('div', { class: 'rt-stable' });
    const body = h('tbody');
    const fill = () => {
      body.innerHTML = '';
      const q = rtState.filter;
      const rows = [...RT.traces].sort((a, b) => SESSION_SORT[rtState.sort][1](rtSession.get(a.id), rtSession.get(b.id)))
        .filter(t => !q || (t.title || '').toLowerCase().includes(q) || t.prompts.some(p => p.text.toLowerCase().includes(q)));
      for (const t of rows) {
        const S = rtSession.get(t.id);
        const first = t.prompts[0]?.text || '';
        body.append(h('tr', { class: 'rt-srow', tabindex: '0', onclick: () => openSession(t.id), onkeydown: (e) => { if (e.key === 'Enter') openSession(t.id); } },
          h('td', { class: 'rt-scell' }, h('div', { class: 'rt-st' }, t.title || t.id), first ? h('div', { class: 'rt-sfirst', title: first }, first) : null),
          h('td', null, h('div', null, fmtDate(t.start)), h('span', { class: 'rt-out o-' + t.outcome }, t.outcome)),
          h('td', { class: 'num' }, fmtMs(t.activeMs)),
          h('td', null,
            S.agents.length ? h('span', { class: 'rt-mini a', title: S.agents.join(', ') }, `${S.delegations} delegation${S.delegations > 1 ? 's' : ''}`) : null,
            S.skills.length ? h('span', { class: 'rt-mini s', title: S.skills.join(', ') }, `${S.skills.length} skill${S.skills.length > 1 ? 's' : ''}`) : null,
            !S.agents.length && !S.skills.length ? h('span', { class: 'muted' }, '–') : null),
          h('td', { class: 'num' }, S.flagged ? h('span', { class: 'rt-mini f' }, `${S.flagged} flagged`) : h('span', { class: 'muted' }, '–')),
          h('td', { class: 'num' }, S.hotspots ? h('span', { class: 'rt-mini h' }, String(S.hotspots)) : h('span', { class: 'muted' }, '–')),
          h('td', { class: 'num' }, fmtTok(S.tokens)),
          h('td', { class: 'num' }, '$' + S.cost.toFixed(2)),
          h('td', { class: 'rt-go' }, '›')));
      }
      if (!rows.length) body.append(h('tr', null, h('td', { colspan: '9', class: 'muted' }, 'No session matches.')));
    };
    wrap.append(h('div', { class: 'rt-scontrols' },
      h('input', { type: 'search', class: 'rt-filter', placeholder: 'Filter by title or prompt…', value: rtState.filter, oninput: (e) => { rtState.filter = e.target.value.toLowerCase(); fill(); } }),
      h('select', { class: 'rt-filter', 'aria-label': 'Sort sessions', onchange: (e) => { rtState.sort = e.target.value; fill(); } },
        Object.entries(SESSION_SORT).map(([k, [label]]) => h('option', { value: k, ...(rtState.sort === k ? { selected: '' } : {}) }, 'Sort: ' + label)))));
    wrap.append(h('div', { class: 'rt-tscroll' }, h('table', { class: 'rt-table rt-sessions-t' },
      h('thead', null, h('tr', null, ['Session', 'When', 'Active', 'Agents & skills', 'Flagged', 'Hotspots', 'Tokens', 'Cost', ''].map(x => h('th', null, x)))),
      body)));
    fill();
    return wrap;
  }

  function kpi(label, value, sub, tone) {
    return h('div', { class: 'kpi' + (tone ? ' ' + tone : '') }, h('div', { class: 'kl' }, label), h('div', { class: 'kv' }, String(value)), sub ? h('div', { class: 'ks' }, sub) : null);
  }
  function flagChip(type) { return h('span', { class: 'rt-flag f-' + type }, FLAG_LABEL[type] || type); }
  function howChip(d) {
    if (!d) return null;
    return h('span', { class: 'rt-how h-' + d.how, title: d.note + (d.evidence ? `\n“${d.evidence}”` : '') }, HOW_LABEL[d.how] || d.how);
  }
  // A bar showing value vs the all-sessions baseline.
  function vsBar(v, base, better) {
    const good = better === 'high' ? v >= base : v <= base;
    return h('span', { class: 'rt-vs' },
      h('span', { class: 'rt-bar' }, h('i', { style: `width:${Math.min(100, v * 100)}%;background:${good ? 'var(--ok)' : 'var(--bad)'}` }), h('b', { style: `left:${Math.min(100, base * 100)}%`, title: `baseline ${fmtPct(base)}` })),
      h('span', null, fmtPct(v)));
  }
  function nameCell(name, kind) {
    const n = nodeByName(name);
    return h('td', { class: 'rt-name' }, h('span', { class: 'dot', style: `background:${SPAN_COLOR[kind]}` }), ' ',
      n ? h('button', { class: 'linkbtn', title: 'Show definition', onclick: () => focusNode(n.id) }, name) : h('span', { title: 'Not defined in this project (global or built-in)' }, name));
  }
  function skillTable(R) {
    const b = R.baseline;
    const c = h('div', { class: 'card' });
    c.append(h('h3', null, 'Skill effectiveness', h('span', { class: 'count' }, String(R.skills.length))));
    c.append(h('p', { class: 'hintp' }, `Sessions where the skill was loaded, against all sessions (marker on the bar). Done = session ended normally. Errors / retries are tool calls after the skill loaded.`));
    if (!R.skills.length) { c.append(h('div', { class: 'empty-ok' }, 'No skill was loaded in these sessions.')); return c; }
    c.append(h('div', { class: 'rt-tscroll' }, h('table', { class: 'rt-table' },
      h('tr', null, h('th', null, 'Skill'), h('th', null, 'Calls'), h('th', null, 'Done'), h('th', null, 'Errors'), h('th', null, 'Retries'), h('th', null, 'Avg time'), h('th', null, 'Avg tokens')),
      h('tr', { class: 'rt-base' }, h('td', null, 'all sessions'), h('td', null, '–'), h('td', null, fmtPct(b.completionRate)), h('td', null, fmtPct(b.errorRateAfter)), h('td', null, String(b.retriesAfter)), h('td', null, fmtMs(b.avgDurationMs)), h('td', null, fmtTok(b.avgTokens))),
      R.skills.map(s => h('tr', null, nameCell(s.name, 'skill'), h('td', null, String(s.invocations)),
        h('td', null, vsBar(s.completionRate, b.completionRate, 'high')),
        h('td', null, vsBar(s.errorRateAfter, b.errorRateAfter, 'low')),
        h('td', null, String(s.retriesAfter)), h('td', null, fmtMs(s.avgDurationMs)), h('td', null, fmtTok(s.avgTokens)))))));
    return c;
  }
  function agentTable(R) {
    const c = h('div', { class: 'card' });
    c.append(h('h3', null, 'Subagents', h('span', { class: 'count' }, String(R.agents.length))));
    c.append(h('p', { class: 'hintp' }, 'Every delegation, by subagent type. A high flagged share means the main agent often hands it work it could do itself.'));
    if (!R.agents.length) { c.append(h('div', { class: 'empty-ok' }, 'No subagent was used in these sessions.')); return c; }
    c.append(h('div', { class: 'rt-tscroll' }, h('table', { class: 'rt-table' },
      h('tr', null, h('th', null, 'Subagent'), h('th', null, 'Calls'), h('th', null, 'Flagged'), h('th', null, 'Failed'), h('th', null, 'Avg calls'), h('th', null, 'Avg time'), h('th', null, 'Tokens')),
      R.agents.map(a => h('tr', null, nameCell(a.name, 'agent'), h('td', null, String(a.delegations)),
        h('td', null, vsBar(a.flagged / a.delegations, 0, 'low')),
        h('td', null, String(a.failed)), h('td', null, (a.toolCalls / a.delegations).toFixed(1)),
        h('td', null, fmtMs(a.durationMs / a.delegations)), h('td', null, fmtTok(a.tokens)))))));
    return c;
  }

  /* ---------- session page (#session/<id>) ---------- */
  function openSession(id, opts = {}) {
    if (rtState.session !== id) { tl.cur = 0; rtState.lane = 'all'; }
    rtState.session = id;
    rtState.focusSpan = opts.span || null;
    if (opts.span) rtState.tab = 'tree';
    else if (opts.tab) rtState.tab = opts.tab;
    const hash = '#session/' + encodeURIComponent(id);
    if (location.hash !== hash) location.hash = hash; // → route()
    else route();
  }
  function route() {
    const m = /^#session\/(.+)$/.exec(location.hash);
    const id = m && decodeURIComponent(m[1]);
    if (id && rtTraces.has(id)) {
      if (rtState.session !== id) { tl.cur = 0; rtState.lane = 'all'; }
      rtState.session = id;
      setView('session');
      renderSession();
      document.getElementById('session').scrollTop = 0;
    } else if (state.view === 'session') setView('runtime');
  }
  window.addEventListener('hashchange', route);

  function renderSession() {
    stopPlay();
    const root = document.getElementById('session');
    root.innerHTML = '';
    const t = rtTraces.get(rtState.session);
    if (!t) return;
    const S = rtSession.get(t.id);
    const tree = [...walkRt(t)];
    root.append(h('div', { class: 'ss-top' },
      h('button', { class: 'chip ss-back', onclick: () => { location.hash = ''; setView('runtime'); } }, '← All sessions'),
      h('div', { class: 'ss-title' },
        h('h2', null, t.title || t.id),
        h('div', { class: 'ss-sub' },
          h('span', { class: 'rt-out o-' + t.outcome }, t.outcome), ' · ', fmtDate(t.start), ' · ',
          h('b', null, fmtMs(t.activeMs)), ' active · agent ', h('b', null, t.agent || '–'), ' · model ', h('b', null, t.model || '–'), ' ', variantChip(t.variant),
          ' · ', fmtTok(S.tokens), ' tokens · $', S.cost.toFixed(3),
          tree.length > 1 ? ` · ${tree.length - 1} subagent session${tree.length > 2 ? 's' : ''}` : '')),
      h('nav', { class: 'ss-tabs' },
        [['overview', 'Overview'], ['timeline', 'Timeline · replay'], ['tree', 'Call tree']].map(([k, l]) =>
          h('button', { class: 'stab' + (rtState.tab === k ? ' active' : ''), onclick: () => { rtState.tab = k; renderSession(); } }, l)))));
    const body = h('div', { class: 'ss-body' });
    root.append(body);
    if (rtState.tab === 'timeline') renderTimeline(t, body);
    else if (rtState.tab === 'tree') renderCallTree(t, body);
    else renderSessionOverview(t, S, body);
  }

  function renderSessionOverview(t, S, el) {
    const tree = [...walkRt(t)];
    const tot = stepTotals(tree.flatMap(x => x.steps || []));
    el.append(h('div', { class: 'kpis ss-kpis' },
      kpi('Agent work', fmtMs(tot.work), `${tree.reduce((n, x) => n + (x.steps || []).length, 0)} model steps`),
      kpi('Tool calls', S.toolCalls, `${S.errors} errors · ${S.retries} retries`, S.errors ? 'warn' : null),
      kpi('Delegations', S.delegations, S.delegations ? `${fmtMs(S.delegatedMs)} · ${fmtTok(S.delegatedTokens)} tok` : 'none'),
      kpi('Flagged', S.flagged, S.delegations ? `${fmtPct(S.flagged / S.delegations)} of delegations` : 'no delegations', S.flagged ? 'bad' : 'ok'),
      kpi('Hotspots', S.hotspots, 'places losing time', S.hotspots ? 'warn' : 'ok'),
      kpi('Cost', '$' + S.cost.toFixed(2), `${fmtTok(S.tokens)} tokens`)));

    // where the time went, explained
    const tc = h('section', { class: 'ss-card' }, h('h3', null, 'Where the time went'),
      h('p', { class: 'hintp' }, 'All model steps of this session and its subagents. Waiting on a subagent or on you is listed apart so nothing is counted twice.'));
    if (tot.work) {
      tc.append(h('div', { class: 'ss-bigbar' }, TIME_PARTS.map(([k, l, c]) => tot[k] ? h('i', { style: `width:${tot[k] / tot.work * 100}%;background:${c}`, title: `${l}: ${fmtMs(tot[k])}` }) : null)));
      tc.append(h('div', { class: 'ss-parts' },
        TIME_PARTS.map(([k, l, c, help]) => partRow(l, c, tot[k], tot.work, help)),
        WAIT_PARTS.filter(([k]) => tot[k]).map(([k, l, c, help]) => partRow(l, c, tot[k], null, help))));
    } else tc.append(h('div', { class: 'hintp' }, 'No model steps recorded.'));
    el.append(tc);

    // which model and reasoning level each agent ran with
    if (tree.some(x => x.variant || (x.steps || []).some(st => st.variant))) {
      const mainVar = t.variant;
      const mc = h('section', { class: 'ss-card' }, h('h3', null, 'Models & thinking level'),
        h('p', { class: 'hintp' }, VARIANT_TIP + ' Subagents normally inherit the session’s model and level; one that differs usually has its own `model:` in its definition.'));
      const delegOf = new Map(RT.analysis.delegations.filter(d => d.childTraceId).map(d => [d.childTraceId, d]));
      mc.append(h('div', { class: 'rt-tscroll' }, h('table', { class: 'rt-table' },
        h('tr', null, ['Agent', 'Model', 'Thinking level', 'Steps', 'Reasoning tokens / step', 'Time thinking', ''].map(x => h('th', null, x))),
        tree.map((x, i) => {
          const st = x.steps || [];
          const vars = [...new Set(st.map(z => z.variant).filter(Boolean))];
          const shown = vars.length ? vars.join(', ') : x.variant;
          const mismatch = i > 0 && mainVar && shown && shown !== mainVar;
          const work = st.reduce((n, z) => n + (z.thinkMs || 0) + (z.toolMs || 0) + (z.waitMs || 0) + (z.writeMs || 0), 0);
          const think = st.reduce((n, z) => n + (z.thinkMs || 0), 0);
          return h('tr', null,
            h('td', null, h('span', { class: 'dot', style: `background:${i ? SPAN_COLOR.agent : 'var(--accent)'}` }), ' ', h('b', null, x.agent || 'main'), i ? h('div', { class: 'hintp' }, delegOf.get(x.id)?.description || '') : h('div', { class: 'hintp' }, 'main agent')),
            h('td', null, x.model || '–'),
            h('td', null, shown ? shown.split(', ').map(v => variantChip(v, mismatch)) : '–'),
            h('td', { class: 'num' }, String(st.length)),
            h('td', { class: 'num' }, fmtTok(median(st.map(z => z.tokens.reasoning)))),
            h('td', { class: 'num' }, work ? `${fmtMs(think)} (${fmtPct(think / work)})` : '–'),
            h('td', { class: 'ss-wrap' }, mismatch ? h('span', { class: 'rt-why warn' }, `differs from the main agent (${mainVar})`) : null));
        }))));
      el.append(mc);
    }

    // hotspots
    const ids = new Set(tree.map(x => x.id));
    const hot = RT.analysis.hotspots.filter(f => ids.has(f.traceId));
    const hc = h('section', { class: 'ss-card' }, h('h3', null, 'Where this session loses time', h('span', { class: 'count' }, String(hot.length))),
      h('p', { class: 'hintp' }, 'Each one links to the exact step in the timeline.'));
    if (!hot.length) hc.append(h('div', { class: 'empty-ok' }, '✓ Nothing stands out'));
    const hg = h('div', { class: 'ss-hots' });
    appendCapped(hg, hot.map(f => hotCard(f, tree)), 8);
    hc.append(hg);
    el.append(hc);

    // delegations
    const dels = RT.analysis.delegations.filter(d => ids.has(d.traceId));
    if (dels.length) {
      const dc = h('section', { class: 'ss-card' }, h('h3', null, 'Delegations', h('span', { class: 'count' }, String(dels.length))),
        h('p', { class: 'hintp' }, 'Every subagent call, in order. Click one to see it in the call tree.'));
      dc.append(h('div', { class: 'rt-tscroll' }, h('table', { class: 'rt-table ss-dels' },
        h('tr', null, ['Subagent', 'Task', 'Why it ran', 'Time', 'Tokens', 'Result', ''].map(x => h('th', null, x))),
        dels.map(d => h('tr', { class: 'rt-srow', onclick: () => openSession(t.id, { span: d.spanId }) },
          h('td', null, h('span', { class: 'dot', style: `background:${SPAN_COLOR.agent}` }), ' ', h('b', null, d.agent)),
          h('td', { class: 'ss-wrap' }, d.description || '–', d.flags.length ? h('div', { class: 'rt-why' }, d.flags.map(f => f.detail).join(' · ')) : null),
          h('td', null, howChip(rtDecision.get(rtKey(d.traceId, d.spanId)))),
          h('td', { class: 'num' }, fmtMs(d.durationMs)),
          h('td', { class: 'num' }, fmtTok(d.tokens)),
          h('td', null, d.outcome),
          h('td', null, d.flags.map(f => flagChip(f.type))))))));
      el.append(dc);
    }

    // what was asked
    if (t.prompts.length) {
      const pc = h('section', { class: 'ss-card' }, h('h3', null, 'What you asked', h('span', { class: 'count' }, String(t.prompts.length))));
      for (const p of t.prompts) pc.append(h('div', { class: 'rt-prompt' }, h('span', { class: 'rt-plabel' }, fmtTime(p.at)),
        h('span', { class: 'rt-ptext' }, p.text.length > 500 ? p.text.slice(0, 500) + '…' : p.text),
        (p.attached || []).map(a => h('span', { class: 'rt-att' }, '@' + a))));
      el.append(pc);
    }
  }

  function partRow(label, color, ms, of, help) {
    return h('div', { class: 'ss-part' },
      h('span', { class: 'dot', style: `background:${color}` }),
      h('div', { class: 'ss-pl' }, h('b', null, label), h('div', { class: 'hintp' }, help)),
      h('div', { class: 'ss-pv' }, h('b', null, fmtMs(ms)), of ? h('span', null, fmtPct(ms / of)) : h('span', { class: 'muted' }, 'not counted')));
  }

  function hotCard(f, tree) {
    const [title, help] = HOT_INFO[f.type] || [f.type, ''];
    const lane = tree.find(x => x.id === f.traceId);
    return h('button', { class: 'ss-hot' + (f.inferred ? ' inferred' : ''), onclick: () => { rtState.tab = 'timeline'; rtState.pendingHot = f; renderSession(); } },
      h('div', { class: 'ss-hh' }, h('b', null, title), f.inferred ? h('span', { class: 'rt-flag f-inferred' }, 'inferred') : null, h('span', { class: 'ss-hms' }, fmtMs(f.ms))),
      h('div', { class: 'ss-hd' }, f.detail),
      h('div', { class: 'hintp' }, help),
      h('div', { class: 'ss-hl' }, (lane && lane.parentId ? 'subagent ' : '') + (lane?.agent || 'main'), f.step != null ? ` · step ${f.step + 1}` : '', ' · open in timeline →'));
  }

  function renderCallTree(t, el) {
    el.append(h('div', { class: 'ss-toolbar' },
      h('label', { class: 'rt-toggle' },
        h('input', { type: 'checkbox', ...(rtState.onlyKey ? { checked: '' } : {}), onchange: (e) => { rtState.onlyKey = e.target.checked; renderSession(); } }),
        ' Only skills, subagents and errors'),
      h('div', { class: 'rt-legend' }, Object.entries({ agent: 'subagent', skill: 'skill', think: 'thinking', read: 'read/search', edit: 'edit', exec: 'shell', web: 'web', other: 'other' })
        .map(([k, v]) => h('span', null, h('span', { class: 'dot', style: `background:${SPAN_COLOR[k]}` }), ' ', v)))));
    const all = [...walkRt(t)];
    el.append(h('section', { class: 'ss-card' }, traceBody(t, { start: t.start, end: Math.max(t.end, ...all.map(x => x.end)) }, rtState.focusSpan)));
    if (rtState.focusSpan) requestAnimationFrame(() => document.querySelector(`[data-span="${CSS.escape(rtState.focusSpan)}"]`)?.scrollIntoView({ block: 'center' }));
  }

  // One trace: turns (user prompts) with their tool calls; subagent calls expand into their own trace.
  function traceBody(t, range, focusSpan, onlyTurns) {
    const body = h('div', { class: 'rt-trace' });
    const turns = new Map();
    const thinks = (t.thinking || []).map((x, i) => ({ ...x, id: 'think-' + i, kind: 'think', tool: 'thinking', name: 'thinking', status: 'ok', input: {} }));
    for (const s of [...t.spans, ...thinks].sort((a, b) => a.start - b.start)) { if (!turns.has(s.turn)) turns.set(s.turn, []); turns.get(s.turn).push(s); }
    const turnIds = [...new Set([...t.prompts.map(p => p.turn), ...turns.keys()])].sort((a, b) => a - b)
      .filter(n => !onlyTurns || onlyTurns.includes(n));
    for (const turn of turnIds) {
      const p = t.prompts.find(x => x.turn === turn);
      if (p) {
        const txt = p.text.length > 280 ? p.text.slice(0, 280) + '…' : p.text;
        body.append(h('div', { class: 'rt-prompt', title: p.text },
          h('span', { class: 'rt-plabel' }, t.parentId ? 'task' : 'you'), h('span', { class: 'rt-ptext' }, txt),
          (p.attached || []).map(a => h('span', { class: 'rt-att' }, '@' + a))));
      }
      let hidden = [];
      const flush = () => {
        if (!hidden.length) return;
        const tools = hidden.filter(s => s.kind !== 'think'), th = hidden.filter(s => s.kind === 'think');
        const ms = (xs) => xs.reduce((n, s) => n + s.end - s.start, 0);
        const byKind = tools.reduce((m, s) => ({ ...m, [s.tool]: (m[s.tool] || 0) + 1 }), {});
        body.append(h('div', { class: 'rt-hidden' },
          th.length ? h('span', { class: 'rt-hthink' }, h('span', { class: 'dot', style: `background:${SPAN_COLOR.think}` }), ` thinking ${fmtMs(ms(th))}`) : null,
          th.length && tools.length ? ' · ' : null,
          tools.length ? `${tools.length} tool call${tools.length > 1 ? 's' : ''} (${fmtMs(ms(tools))}): ` + Object.entries(byKind).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' · ') : null));
        hidden = [];
      };
      for (const s of turns.get(turn) || []) {
        const key = s.kind === 'agent' || s.kind === 'skill' || s.status === 'error';
        if (rtState.onlyKey && !key) { hidden.push(s); continue; }
        flush();
        body.append(spanRow(t, s, range, focusSpan));
      }
      flush();
    }
    if (!turnIds.length) body.append(h('div', { class: 'rt-hidden' }, 'No tool calls.'));
    return body;
  }

  function spanRow(t, s, range, focusSpan) {
    const total = Math.max(1, range.end - range.start);
    const left = Math.max(0, Math.min(100, (s.start - range.start) / total * 100));
    const width = Math.max(0.4, Math.min(100 - left, (s.end - s.start) / total * 100));
    const detail = s.input.description || s.input.file || s.input.pattern || s.input.command || s.input.url || s.input.query || '';
    const dec = rtDecision.get(rtKey(t.id, s.id));
    const del = s.kind === 'agent' ? rtDelegation.get(rtKey(t.id, s.id)) : null;
    const node = (s.kind === 'skill' || s.kind === 'agent') ? nodeByName(s.name) : null;
    const row = h('div', { class: 'rt-span k-' + s.kind + (s.status === 'error' ? ' err' : '') + (del && del.flags.length ? ' flagged' : '') + (focusSpan === s.id ? ' focus' : ''), 'data-span': s.id },
      h('span', { class: 'dot', style: `background:${SPAN_COLOR[s.kind] || SPAN_COLOR.other}` }),
      h('span', { class: 'rt-sname' }, s.kind === 'agent' ? 'subagent ' : s.kind === 'skill' ? 'skill ' : '', h('b', null, s.name)),
      node ? h('button', { class: 'linkbtn', title: 'Show definition', onclick: (e) => { e.stopPropagation(); focusNode(node.id); } }, 'def') : null,
      h('span', { class: 'rt-sdetail', title: detail }, detail),
      howChip(dec),
      del ? del.flags.map(f => flagChip(f.type)) : null,
      s.status === 'error' ? h('span', { class: 'rt-err', title: s.error || '' }, s.error || 'error') : null,
      h('span', { class: 'rt-wf' }, h('i', { style: `left:${left}%;width:${width}%;background:${SPAN_COLOR[s.kind] || SPAN_COLOR.other}` })),
      h('span', { class: 'rt-num' }, fmtMs(s.end - s.start)));
    const child = s.childTraceId && rtTraces.get(s.childTraceId);
    if (!child) return row;
    const box = h('details', { class: 'rt-child' + (del && del.flags.length ? ' flagged' : ''), ...(focusSpan === s.id ? { open: '' } : {}) });
    box.append(h('summary', null, row));
    const shared = del && del.childTurns;
    box.append(h('div', { class: 'rt-childmeta' },
      del ? `${del.toolCalls} tool calls · ${fmtTok(del.tokens)} tokens · $${del.cost.toFixed(3)} · ${del.outcome}${shared ? ' · resumed subagent session (showing this delegation only)' : ''}`
        : `${child.spans.length} tool calls · ${fmtTok(tokTotal(child.tokens))} tokens · $${child.cost.toFixed(3)} · ${child.outcome}`,
      del && del.flags.length ? h('div', { class: 'rt-why' }, del.flags.map(f => `${FLAG_LABEL[f.type]}: ${f.detail}`).join(' · ')) : null));
    box.append(traceBody(child, range, focusSpan, shared || null));
    return box;
  }

  /* ---------- session timeline: replay step by step ---------- */
  const GAP_CAP = 15000; // idle gaps longer than this are squeezed on the timeline
  const SLOW_STEP_MS = 10000;
  const tl = { steps: [], lanes: [], x: null, cur: 0, timer: null, speed: 1000, zoom: 1, hot: [] };

  // Map wall-clock time to a position where idle stretches are squeezed.
  function makeAxis(intervals) {
    const iv = intervals.filter(([a, b]) => b >= a).sort((p, q) => p[0] - q[0]);
    const merged = [];
    for (const [a, b] of iv) { const last = merged[merged.length - 1]; if (last && a <= last[1]) last[1] = Math.max(last[1], b); else merged.push([a, b]); }
    const segs = []; let pos = 0;
    merged.forEach(([a, b], i) => {
      if (i) { const gap = a - merged[i - 1][1]; const g = Math.min(gap, GAP_CAP); segs.push({ gap: true, a: merged[i - 1][1], b: a, x0: pos, len: g, real: gap }); pos += g; }
      segs.push({ a, b, x0: pos, len: b - a }); pos += b - a;
    });
    const total = Math.max(1, pos);
    const x = (t) => {
      for (const s of segs) if (t <= s.b) return (s.x0 + (t < s.a ? 0 : (t - s.a) / Math.max(1, s.b - s.a) * s.len)) / total * 100;
      return 100;
    };
    return { x, gaps: segs.filter(s => s.gap && s.real > GAP_CAP), total };
  }

  // Steps' own work time: without waiting on a subagent or on the user.
  const workMs = (st) => Math.max(0, st.end - st.start - (st.agentMs || 0) - (st.userMs || 0));

  function stepSummary(s) {
    const counts = {};
    for (const it of s.st.items) {
      if (it.type === 'tool' || it.type === 'ask' || it.type === 'agent') {
        const sp = s.trace.spans.find(z => z.id === it.ref);
        const k = !sp ? 'tool' : sp.kind === 'agent' ? `→ ${sp.name}` : sp.kind === 'skill' ? `skill ${sp.name}` : sp.tool;
        counts[k] = (counts[k] || 0) + 1;
      }
    }
    const acts = Object.entries(counts).map(([k, n]) => n > 1 ? `${k} ×${n}` : k);
    const parts = [];
    if (s.st.thinkMs >= 1000) parts.push(`thinks ${fmtMs(s.st.thinkMs)}`);
    if (acts.length) parts.push(acts.join(', '));
    if (!acts.length && s.st.items.some(i => i.type === 'text')) parts.push('writes a reply');
    return parts.join(' → ') || 'no output';
  }

  function renderTimeline(t, el) {
    const lanes = [...walkRt(t)];
    const delegOf = new Map(RT.analysis.delegations.filter(d => d.childTraceId).map(d => [d.childTraceId, d]));
    tl.lanes = lanes.map((x, i) => ({ trace: x, label: i === 0 ? (x.agent || 'main agent') : (x.agent || 'subagent'), main: i === 0, sub: i === 0 ? 'main agent' : (delegOf.get(x.id)?.description || x.title || 'subagent') }));
    tl.steps = lanes.flatMap((x, li) => (x.steps || []).map(st => ({ st, lane: li, trace: x }))).sort((a, b) => a.st.start - b.st.start);
    const ids = new Set(lanes.map(x => x.id));
    tl.hot = RT.analysis.hotspots.filter(f => ids.has(f.traceId));
    if (!tl.steps.length) { el.append(h('section', { class: 'ss-card' }, h('div', { class: 'hintp' }, 'No model steps recorded for this session.'))); return; }
    if (rtState.pendingHot) { const g = hotStepIndex(rtState.pendingHot); if (g >= 0) tl.cur = g; rtState.pendingHot = null; }
    tl.cur = Math.min(tl.cur, tl.steps.length - 1);
    const axis = makeAxis(tl.steps.map(s => [s.st.start, s.st.end]));
    tl.x = axis.x;

    el.append(h('p', { class: 'lead ss-lead' }, 'Each block is one model step (one call to the LLM). Colours show what that step spent its time on. One row per agent: the main agent on top, each subagent below. Long idle stretches are squeezed (dashed lines). Click a block, a red marker or a row in the step list to inspect it.'));

    // ---- gantt ----
    const gc = h('section', { class: 'ss-card ss-gantt-card' });
    gc.append(h('div', { class: 'ss-toolbar' },
      h('div', { class: 'rt-legend' },
        TIME_PARTS.map(([, l, c, help]) => h('span', { title: help }, h('span', { class: 'dot', style: `background:${c}` }), ' ', l)),
        WAIT_PARTS.map(([, l, c, help]) => h('span', { title: help }, h('span', { class: 'dot', style: `background:${c}` }), ' ', l)),
        h('span', { style: 'color:var(--bad)' }, '▼ hotspot')),
      h('span', { class: 'spacer' }),
      h('span', { class: 'hintp' }, 'Zoom'),
      h('button', { class: 'chip', onclick: () => setZoom(tl.zoom / 1.6) }, '−'),
      h('button', { class: 'chip', onclick: () => setZoom(1) }, 'fit'),
      h('button', { class: 'chip', onclick: () => setZoom(tl.zoom * 1.6) }, '+')));
    const inner = h('div', { class: 'tl-inner', style: `width:${tl.zoom * 100}%` });
    // time axis (idle squeezed, so this is "agent clock", not wall clock)
    const axisTrack = h('div', { class: 'tl-track tl-axis', title: 'Elapsed time with idle stretches squeezed' });
    const stepMs = [10e3, 30e3, 60e3, 120e3, 300e3, 600e3, 900e3, 1800e3, 3600e3].find(s => axis.total / s <= 8 * tl.zoom) || 3600e3;
    for (let ms = 0; ms <= axis.total; ms += stepMs) axisTrack.append(h('span', { class: 'tl-tick', style: `left:${ms / axis.total * 100}%` }, fmtClock(ms)));
    inner.append(h('div', { class: 'tl-row' }, h('div', { class: 'tl-label' }), axisTrack));
    tl.lanes.forEach((ln, li) => {
      const track = h('div', { class: 'tl-track' });
      for (const g of axis.gaps) track.append(h('span', { class: 'tl-gap', style: `left:${axis.x(g.a)}%`, title: `idle ${fmtMs(g.real)} (squeezed)` }));
      tl.steps.forEach((s, gi) => {
        if (s.lane !== li) return;
        const st = s.st, x0 = axis.x(st.start), x1 = axis.x(st.end);
        const blk = h('span', { class: 'tl-step', 'data-g': gi, style: `left:${x0}%;width:${Math.max(0.12, x1 - x0)}%`, title: `step ${gi + 1} · ${fmtMs(workMs(st))} · ${stepSummary(s)}`, onclick: () => setStep(gi) });
        if (st.waitMs) blk.append(h('i', { style: `left:0;width:${Math.min(100, st.waitMs / Math.max(1, st.end - st.start) * 100)}%;background:#64748b` }));
        for (const it of st.items) {
          if (it.type === 'text') continue;
          const c = it.type === 'think' ? SPAN_COLOR.think : it.type === 'agent' ? SPAN_COLOR.agent : it.type === 'ask' ? '#334155' : SPAN_COLOR.exec;
          const a = axis.x(it.start), b = axis.x(it.end || it.start);
          const span = Math.max(0.0001, x1 - x0);
          blk.append(h('i', { style: `left:${(a - x0) / span * 100}%;width:${Math.max(1, (b - a) / span * 100)}%;background:${c}` }));
        }
        track.append(blk);
      });
      for (const f of tl.hot) if (f.traceId === ln.trace.id && f.step != null) {
        const st = ln.trace.steps[f.step]; if (!st) continue;
        track.append(h('span', { class: 'tl-hot', style: `left:${axis.x(st.start)}%`, title: `${(HOT_INFO[f.type] || [f.type])[0]}: ${f.detail}`, onclick: () => setStep(hotStepIndex(f)) }));
      }
      track.append(h('span', { class: 'tl-cur' }));
      inner.append(h('div', { class: 'tl-row' + (ln.main ? ' main' : '') },
        h('div', { class: 'tl-label', title: ln.sub },
          h('div', null, h('span', { class: 'dot', style: `background:${ln.main ? 'var(--accent)' : SPAN_COLOR.agent}` }), ' ', h('b', null, ln.label), ' ', variantChip(ln.trace.variant, !ln.main && t.variant && ln.trace.variant && ln.trace.variant !== t.variant)),
          h('small', null, ln.sub)),
        track));
    });
    gc.append(h('div', { class: 'tl-scroll' }, inner));
    el.append(gc);

    // ---- step list + detail ----
    const laneSel = h('select', { class: 'rt-filter', 'aria-label': 'Agent', onchange: (e) => { rtState.lane = e.target.value; fillSteps(); } },
      h('option', { value: 'all' }, 'All agents'),
      tl.lanes.map((ln, i) => h('option', { value: String(i), ...(rtState.lane === String(i) ? { selected: '' } : {}) }, `${ln.label}${ln.main ? ' (main)' : ' — ' + ln.sub.slice(0, 40)}`)));
    const filt = h('div', { class: 'ss-seg' }, [['all', 'All steps'], ['slow', `Slow (≥ ${SLOW_STEP_MS / 1000} s)`], ['hot', 'Hotspots']].map(([k, l]) =>
      h('button', { class: 'stab' + (rtState.stepFilter === k ? ' active' : ''), onclick: (e) => { rtState.stepFilter = k; filt.querySelectorAll('.stab').forEach(b => b.classList.toggle('active', b === e.currentTarget)); fillSteps(); } }, l)));
    const list = h('div', { class: 'tl-list', id: 'tl-list' });
    const left = h('section', { class: 'ss-card tl-left' }, h('h3', null, 'Steps'), h('div', { class: 'ss-toolbar' }, filt, laneSel), list);
    const right = h('section', { class: 'ss-card tl-right' },
      h('div', { class: 'rt-player' },
        h('button', { class: 'chip', title: 'First step (Home)', onclick: () => setStep(0) }, '⏮'),
        h('button', { class: 'chip', title: 'Previous step (←)', onclick: () => setStep(tl.cur - 1) }, '◀'),
        h('button', { class: 'chip', id: 'rt-play', title: 'Play (Space)', onclick: togglePlay }, '▶ Play'),
        h('button', { class: 'chip', title: 'Next step (→)', onclick: () => setStep(tl.cur + 1) }, '▶'),
        h('button', { class: 'chip', title: 'Last step (End)', onclick: () => setStep(tl.steps.length - 1) }, '⏭'),
        h('button', { class: 'chip', title: 'Next hotspot (N)', onclick: nextHot }, 'Next hotspot'),
        h('select', { class: 'rt-filter rt-speed', 'aria-label': 'Playback speed', onchange: (e) => { tl.speed = Number(e.target.value); if (tl.timer) { stopPlay(); togglePlay(); } } },
          [[2000, 'Slow'], [1000, 'Normal'], [400, 'Fast']].map(([v, l]) => h('option', { value: v, ...(tl.speed === v ? { selected: '' } : {}) }, l))),
        h('span', { class: 'rt-num', id: 'rt-stepno' })),
      h('input', { type: 'range', min: '0', max: String(tl.steps.length - 1), value: String(tl.cur), class: 'rt-slider', oninput: (e) => setStep(Number(e.target.value)) }),
      h('div', { class: 'hintp' }, 'Keys: ← → step · Space play · N next hotspot'),
      h('div', { class: 'rt-stepcard', id: 'rt-stepcard' }));
    el.append(h('div', { class: 'tl-split' }, left, right));
    fillSteps();
    setStep(tl.cur);
  }

  function setZoom(z) {
    tl.zoom = Math.max(1, Math.min(20, z));
    const g = tl.cur;
    renderSession();
    setStep(g);
    const blk = document.querySelector(`.tl-step[data-g="${g}"]`);
    blk?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  function fillSteps() {
    const list = document.getElementById('tl-list');
    if (!list) return;
    list.innerHTML = '';
    const hotSet = new Map();
    for (const f of tl.hot) { const g = hotStepIndex(f); if (g >= 0) { if (!hotSet.has(g)) hotSet.set(g, []); hotSet.get(g).push(f); } }
    let shown = 0;
    tl.steps.forEach((s, g) => {
      if (rtState.lane !== 'all' && String(s.lane) !== rtState.lane) return;
      if (rtState.stepFilter === 'slow' && workMs(s.st) < SLOW_STEP_MS) return;
      if (rtState.stepFilter === 'hot' && !hotSet.has(g)) return;
      shown++;
      const st = s.st, dur = Math.max(1, st.end - st.start), ln = tl.lanes[s.lane];
      list.append(h('button', { class: 'tl-item' + (g === tl.cur ? ' on' : ''), 'data-g': g, onclick: () => setStep(g) },
        h('span', { class: 'tl-n' }, '#' + (g + 1)),
        h('span', { class: 'tl-main' },
          h('span', { class: 'tl-who' }, h('span', { class: 'dot', style: `background:${ln.main ? 'var(--accent)' : SPAN_COLOR.agent}` }), ' ', ln.label, h('span', { class: 'muted' }, ' · ' + fmtTime(st.start))),
          h('span', { class: 'tl-what' }, stepSummary(s)),
          hotSet.has(g) ? h('span', { class: 'tl-hots' }, hotSet.get(g).map(f => h('span', { class: 'rt-flag ' + (f.inferred ? 'f-inferred' : 'f-redone') }, (HOT_INFO[f.type] || [f.type])[0]))) : null),
        h('span', { class: 'tl-dur' + (workMs(st) >= SLOW_STEP_MS ? ' slow' : '') },
          h('b', null, fmtMs(workMs(st))),
          h('span', { class: 'tl-mbar' }, [...TIME_PARTS, ...WAIT_PARTS].map(([k, , c]) => st[k] ? h('i', { style: `width:${st[k] / dur * 100}%;background:${c}` }) : null)))));
    });
    if (!shown) list.append(h('div', { class: 'hintp', style: 'padding:12px' }, 'No step matches this filter.'));
  }

  function hotStepIndex(f) {
    return tl.steps.findIndex(s => s.trace.id === f.traceId && s.st.index === f.step);
  }
  function nextHot() {
    const gs = tl.hot.map(hotStepIndex).filter(g => g > tl.cur).sort((a, b) => a - b);
    if (gs.length) setStep(gs[0]);
  }
  function togglePlay() {
    if (tl.timer) return stopPlay();
    const b = document.getElementById('rt-play'); if (b) b.textContent = '⏸ Pause';
    tl.timer = setInterval(() => { if (tl.cur >= tl.steps.length - 1) stopPlay(); else setStep(tl.cur + 1); }, tl.speed);
  }
  function stopPlay() {
    if (tl.timer) clearInterval(tl.timer);
    tl.timer = null;
    const b = document.getElementById('rt-play'); if (b) b.textContent = '▶ Play';
  }

  function setStep(g) {
    if (!tl.steps.length || g < 0) return;
    tl.cur = Math.max(0, Math.min(tl.steps.length - 1, g));
    const { st, lane, trace } = tl.steps[tl.cur];
    document.querySelectorAll('.tl-step.on, .tl-item.on').forEach(b => b.classList.remove('on'));
    document.querySelector(`.tl-step[data-g="${tl.cur}"]`)?.classList.add('on');
    const item = document.querySelector(`.tl-item[data-g="${tl.cur}"]`);
    if (item) { item.classList.add('on'); const list = item.parentElement; const r = item.getBoundingClientRect(), lr = list.getBoundingClientRect(); if (r.top < lr.top || r.bottom > lr.bottom) list.scrollTop += r.top - lr.top - lr.height / 2; }
    document.querySelectorAll('.tl-cur').forEach(c => { c.style.left = tl.x(st.start) + '%'; });
    const slider = document.querySelector('.rt-slider'); if (slider) slider.value = String(tl.cur);
    const no = document.getElementById('rt-stepno'); if (no) no.textContent = `step ${tl.cur + 1} of ${tl.steps.length}`;

    const card = document.getElementById('rt-stepcard');
    if (!card) return;
    card.innerHTML = '';
    const dur = Math.max(1, st.end - st.start);
    const ln = tl.lanes[lane];
    const prev = tl.steps.slice(0, tl.cur).reverse().find(s => s.trace === trace);
    const prompt = trace.prompts.find(p => p.turn === st.turn);
    const findings = tl.hot.filter(f => f.traceId === trace.id && f.step === st.index);
    card.append(h('div', { class: 'sc-head' },
      h('div', { class: 'sc-title' }, `Step ${tl.cur + 1}`),
      h('div', { class: 'sc-sub' }, h('span', { class: 'dot', style: `background:${ln.main ? 'var(--accent)' : SPAN_COLOR.agent}` }), ' ', h('b', null, ln.label), ln.main ? '' : ` — ${ln.sub}`,
        h('br'), `step ${st.index + 1} of this agent · ${fmtTime(st.start)}`, st.error ? h('span', { class: 'rt-err' }, ' · ' + st.error) : null),
      h('div', { class: 'sc-dur' }, fmtMs(workMs(st)), h('small', null, 'agent work'))));
    if (findings.length) card.append(h('div', { class: 'sc-find' }, findings.map(f => h('div', { class: 'sc-f' + (f.inferred ? ' inferred' : '') },
      h('b', null, (HOT_INFO[f.type] || [f.type])[0]), f.inferred ? ' (inferred)' : '', h('div', null, f.detail), h('div', { class: 'hintp' }, (HOT_INFO[f.type] || [, ''])[1])))));
    const parts = [...TIME_PARTS, ...WAIT_PARTS].filter(([k]) => st[k] >= 1);
    card.append(h('div', { class: 'sc-time' },
      h('div', { class: 'ss-bigbar sm' }, parts.map(([k, l, c]) => h('i', { style: `width:${st[k] / dur * 100}%;background:${c}`, title: `${l}: ${fmtMs(st[k])}` }))),
      h('div', { class: 'sc-parts' }, parts.map(([k, l, c]) => h('span', null, h('span', { class: 'dot', style: `background:${c}` }), ' ', l, ' ', h('b', null, fmtMs(st[k])))))));
    const ctxDelta = prev ? st.tokens.context - prev.st.tokens.context : 0;
    card.append(h('div', { class: 'sc-stats' },
      stat('Context read', fmtTok(st.tokens.context), prev ? `${ctxDelta >= 0 ? '+' : ''}${fmtTok(ctxDelta)} vs previous` : 'first step', 'Tokens the model had to read for this call. Grows as the conversation grows.'),
      stat('Output', fmtTok(st.tokens.output), 'tokens written'),
      stat('Reasoning', fmtTok(st.tokens.reasoning), 'thinking tokens'),
      stat('Cost', '$' + st.cost.toFixed(4), st.finish || ''),
      st.variant || st.model ? stat('Thinking level', st.variant || '–', st.model || '', VARIANT_TIP) : null));
    if (prompt && (!prev || prev.st.turn !== st.turn)) {
      card.append(h('div', { class: 'rt-prompt' }, h('span', { class: 'rt-plabel' }, trace.parentId ? 'task' : 'you asked'),
        h('span', { class: 'rt-ptext' }, prompt.text.length > 400 ? prompt.text.slice(0, 400) + '…' : prompt.text)));
    }
    card.append(h('div', { class: 'sc-label' }, 'What happened, in order'));
    const list = h('ol', { class: 'sc-items' });
    for (const it of st.items) {
      if (it.type === 'think') {
        const th = trace.thinking[it.ref] || {};
        list.append(h('li', { class: 'sc-item think' },
          h('div', { class: 'sc-ih' }, h('span', { class: 'dot', style: `background:${SPAN_COLOR.think}` }), h('b', null, 'Thinking'), h('span', { class: 'rt-num' }, fmtMs(it.end - it.start))),
          th.text ? h('details', { class: 'rt-think' }, h('summary', null, 'Read the reasoning (as written by the model — not a verified explanation)'), h('pre', null, th.text))
            : h('div', { class: 'hintp' }, RT.thinking ? 'No reasoning text stored for this block.' : 'Reasoning text not included — regenerate with --include-thinking to read it.')));
      } else if (it.type === 'tool' || it.type === 'agent' || it.type === 'ask') {
        const sp = trace.spans.find(z => z.id === it.ref);
        if (!sp) continue;
        const detail = sp.input.description || sp.input.file || sp.input.pattern || sp.input.command || sp.input.url || sp.input.query || '';
        const child = sp.childTraceId ? tl.lanes.findIndex(l => l.trace.id === sp.childTraceId) : -1;
        list.append(h('li', { class: 'sc-item' + (sp.status === 'error' ? ' err' : '') },
          h('div', { class: 'sc-ih' }, h('span', { class: 'dot', style: `background:${SPAN_COLOR[sp.kind] || SPAN_COLOR.other}` }),
            h('b', null, sp.kind === 'agent' ? 'Subagent ' + sp.name : sp.kind === 'skill' ? 'Skill ' + sp.name : it.type === 'ask' ? 'Asked you' : sp.tool),
            h('span', { class: 'rt-num' }, fmtMs(sp.end - sp.start))),
          detail ? h('div', { class: 'sc-detail' }, detail) : null,
          sp.status === 'error' ? h('div', { class: 'rt-err wrap' }, sp.error || 'error') : null,
          child > 0 ? h('button', { class: 'linkbtn', onclick: () => { const g = tl.steps.findIndex(s => s.lane === child && s.st.start >= sp.start); if (g >= 0) setStep(g); } }, 'Follow into the subagent →') : null));
      } else if (it.type === 'text') {
        list.append(h('li', { class: 'sc-item' },
          h('div', { class: 'sc-ih' }, h('span', { class: 'dot', style: 'background:#94a3b8' }), h('b', null, 'Wrote')),
          h('pre', { class: 'rt-out-text' }, it.text)));
      }
    }
    if (!st.items.length) list.append(h('li', { class: 'hintp' }, 'The model returned nothing in this step.'));
    card.append(list);
  }
  function stat(label, value, sub, title) {
    return h('div', { class: 'sc-stat', title: title || null }, h('div', { class: 'kl' }, label), h('div', { class: 'sv' }, value), sub ? h('div', { class: 'ks' }, sub) : null);
  }

  document.addEventListener('keydown', (ev) => {
    if (state.view !== 'session' || rtState.tab !== 'timeline' || !tl.steps.length) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const tg = ev.target;
    if (tg && ((tg.tagName === 'INPUT' && tg.type !== 'range') || tg.tagName === 'TEXTAREA' || tg.tagName === 'SELECT')) return;
    if (ev.key === 'ArrowRight') { setStep(tl.cur + 1); ev.preventDefault(); }
    else if (ev.key === 'ArrowLeft') { setStep(tl.cur - 1); ev.preventDefault(); }
    else if (ev.key === 'Home') { setStep(0); ev.preventDefault(); }
    else if (ev.key === 'End') { setStep(tl.steps.length - 1); ev.preventDefault(); }
    else if (ev.key === 'n' || ev.key === 'N') nextHot();
    else if (ev.key === ' ') { togglePlay(); ev.preventDefault(); }
  });

  /* ================= keyboard help ================= */
  const SHORTCUTS = [
    ['/', 'Search (Enter jumps to the first match, Esc clears)'],
    ['1 – 5', 'Diagram · Graph · Hierarchy · Insights · Runtime'],
    ['F', 'Fit everything into view'],
    ['+  −  0', 'Zoom in · out · 100%'],
    ['R', 'Re-layout'],
    ['G', 'Group by scope (Diagram)'],
    ['O', 'Read the selected definition'],
    ['Esc', 'Close dialog / clear selection'],
    ['?', 'This help'],
  ];
  function toggleHelp() {
    openOverlay('Keyboard shortcuts', (closeBtn) => h('div', { class: 'reader help' },
      h('div', { class: 'reader-head' }, h('span', { class: 'reader-title' }, 'Keyboard shortcuts'), h('span', { style: 'flex:1' }), closeBtn),
      h('div', { class: 'reader-body' },
        h('table', { class: 'md-fm' }, SHORTCUTS.map(([k, v]) => h('tr', null, h('th', null, h('kbd', null, k)), h('td', null, v)))),
        h('p', { class: 'hintp', style: 'margin-top:14px' }, 'Mouse: drag a card to move it, drag empty space to pan, scroll to zoom, double-click to zoom in, click a card for details.'))));
  }
  const helpBtn = document.getElementById('helpBtn');
  if (helpBtn) helpBtn.addEventListener('click', toggleHelp);

  /* ================= boot ================= */
  renderInsights();
  renderHierarchy();
  renderRuntime();
  renderDrawer();
  if (location.hash.startsWith('#session/')) route();
  resize();
  updateZoomLabel();
  if (!N.length) {
    document.getElementById('hint').textContent = 'No skills, agents or instruction files found in this folder.';
    drawer.innerHTML = '';
    drawer.append(h('div', { class: 'drawer-empty' },
      h('h2', null, 'Nothing to map'),
      h('p', null, 'SkillMap looked for SKILL.md files, agent definitions (.claude/agents, .opencode/agents) and AGENTS.md-style instruction files, but found none here.')));
  } else {
    relayout();
    laidOut.add('diagram');
  }
  window.__sm = () => ({ zoom, W, H, pan, groups: [...scopeGroups()].map(([s, ids]) => ({ s, n: ids.length, b: groupBounds(ids, 26, 30) })) });
  window.__smToggle = (scope) => toggleCollapse(scope);
  loop();
})();
