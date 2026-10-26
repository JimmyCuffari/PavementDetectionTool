import { getToken } from './auth.js';
import { listAllFiles, downloadFileContent } from './drive.js';
import { getDatasetRawDataFolder, getCurrentDataset } from './dataset-manager.js';
import { makeSemaphore, toast } from './utils.js';
import { classColor, haloColor, loadColorOverrides, shapeToSvg } from './label-draw.js';

// Road Viewer — lays a street's frames edge-to-edge as one continuous road,
// with LabelMe annotations overlaid and per-class visibility toggles.

const ORIENT_KEY  = 'pavement_road_viewer_orientation';
const LABEL_KEY   = 'pavement_road_viewer_label_mode';
const SECTION_KEY = 'pavement_road_viewer_section_mode';
const SVG_NS      = 'http://www.w3.org/2000/svg';
const ZOOM_MIN    = 25;
const ZOOM_MAX    = 800;
const ZOOM_STEP   = 1.25;   // factor per +/- click

const SECTION_MODES = [
  { value: 'hover', label: 'On hover' },
  { value: 'tag',   label: 'Tag on each image' },
  { value: 'ruler', label: 'Ruler beside road' },
  { value: 'off',   label: 'Hidden' },
];

let root        = null;   // tab container
let road        = null;   // scrollable road element
let streets     = [];     // [{ id, name }]
let streetsStale = true;
let frames      = [];     // [{ name, imageId, shapes, w, h, dimsKnown, el, inner, loaded }]
let classes     = [];     // [{ name, count }]
let hidden      = new Set();
let blobUrls    = [];
let loadToken   = 0;      // bumped on every street load; stale async work checks it
let refDims     = { w: 1, h: 1 };
let zoom        = 100;    // percent of fit
let orientation = readPref(ORIENT_KEY, ['vertical', 'horizontal']);
let labelMode   = readPref(LABEL_KEY, ['dark', 'light']);          // label colors tuned for dark or light imagery
let sectionMode = readPref(SECTION_KEY, SECTION_MODES.map(m => m.value));
let observer    = null;
const imageSem  = makeSemaphore(6);

// Returns the saved value if it's one of `allowed`, else the first allowed value
function readPref(key, allowed) {
  try {
    const saved = localStorage.getItem(key);
    return allowed.includes(saved) ? saved : allowed[0];
  } catch { return allowed[0]; }
}

function writePref(key, value) {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

// ── Render shell ──────────────────────────────────────────────────────────────

export function renderRoadViewer(container) {
  root = container;
  container.innerHTML = `
    <div class="rdv">
      <div class="rdv-toolbar">
        <div class="rdv-field">
          <label for="rdv-street">Street</label>
          <select id="rdv-street" disabled><option>Loading…</option></select>
        </div>
        <button class="btn btn-ghost btn-sm" id="rdv-refresh">Refresh</button>

        <div class="rdv-seg" role="group" aria-label="Orientation">
          <button class="rdv-seg-btn" data-orient="vertical">Vertical</button>
          <button class="rdv-seg-btn" data-orient="horizontal">Horizontal</button>
        </div>

        <div class="rdv-field rdv-zoom" title="Tip: Ctrl + scroll (or pinch) to zoom at the cursor">
          <label for="rdv-zoom">Zoom</label>
          <button class="btn btn-ghost btn-sm rdv-zoom-btn" id="rdv-zoom-out" aria-label="Zoom out">&minus;</button>
          <input type="range" id="rdv-zoom" min="${ZOOM_MIN}" max="${ZOOM_MAX}" step="5" value="100" />
          <button class="btn btn-ghost btn-sm rdv-zoom-btn" id="rdv-zoom-in" aria-label="Zoom in">+</button>
          <span id="rdv-zoom-val">100%</span>
          <button class="btn btn-ghost btn-sm" id="rdv-fit">Fit</button>
        </div>

        <span id="rdv-status" class="text-dim rdv-status"></span>
      </div>

      <div class="rdv-toolbar">
        <div class="rdv-field">
          <span>Label colors for</span>
          <div class="rdv-seg" role="group" aria-label="Label colors">
            <button class="rdv-seg-btn" data-label-mode="dark"  title="Bright colors with a dark outline — for asphalt and darker images">Dark images</button>
            <button class="rdv-seg-btn" data-label-mode="light" title="Deep colors with a white outline — for concrete and brighter images">Light images</button>
          </div>
        </div>

        <div class="rdv-field">
          <label for="rdv-section-mode">Section names</label>
          <select id="rdv-section-mode">
            ${SECTION_MODES.map(m => `<option value="${m.value}">${m.label}</option>`).join('')}
          </select>
        </div>
      </div>

      <div id="rdv-labels" class="rdv-labels hidden"></div>
      <div id="rdv-empty" class="rdv-empty text-dim hidden"></div>
      <div id="rdv-road" class="rdv-road"></div>
      <style id="rdv-color-style"></style>
      <style id="rdv-hide-style"></style>
    </div>
  `;

  road = container.querySelector('#rdv-road');

  container.querySelector('#rdv-street').addEventListener('change', (e) => loadStreet(e.target.value));
  container.querySelector('#rdv-refresh').addEventListener('click', () => listStreets(true));

  container.querySelectorAll('[data-orient]').forEach(btn =>
    btn.addEventListener('click', () => setOrientation(btn.dataset.orient)));

  const zoomInput = container.querySelector('#rdv-zoom');
  zoomInput.addEventListener('input', () => setZoom(Number(zoomInput.value)));
  container.querySelector('#rdv-zoom-in').addEventListener('click',  () => setZoom(zoom * ZOOM_STEP));
  container.querySelector('#rdv-zoom-out').addEventListener('click', () => setZoom(zoom / ZOOM_STEP));
  container.querySelector('#rdv-fit').addEventListener('click', () => setZoom(100));

  container.querySelectorAll('[data-label-mode]').forEach(btn =>
    btn.addEventListener('click', () => {
      labelMode = btn.dataset.labelMode;
      writePref(LABEL_KEY, labelMode);
      updateSegButtons();
      applyColors();
      renderLabelToggles();
    }));

  const sectionSelect = container.querySelector('#rdv-section-mode');
  sectionSelect.value = sectionMode;
  sectionSelect.addEventListener('change', () => {
    sectionMode = sectionSelect.value;
    writePref(SECTION_KEY, sectionMode);
    relayout();   // the ruler adds a gutter, which changes the fit size
  });

  container.querySelector('#rdv-labels').addEventListener('change', (e) => {
    const idx = e.target.dataset?.classIdx;
    if (idx === undefined) return;
    if (e.target.checked) hidden.delete(Number(idx)); else hidden.add(Number(idx));
    applyHidden();
  });
  container.querySelector('#rdv-labels').addEventListener('click', (e) => {
    const action = e.target.dataset?.labelsAction;
    if (!action) return;
    hidden = action === 'none' ? new Set(classes.map((_, i) => i)) : new Set();
    root.querySelectorAll('[data-class-idx]').forEach(cb => { cb.checked = !hidden.has(Number(cb.dataset.classIdx)); });
    applyHidden();
  });

  road.addEventListener('wheel', (e) => {
    // Ctrl + wheel (and trackpad pinch, which the browser reports as ctrl + wheel) zooms at the cursor
    if (e.ctrlKey) {
      e.preventDefault();
      const rect = road.getBoundingClientRect();
      setZoom(zoom * Math.exp(-e.deltaY * 0.002), { x: e.clientX - rect.left, y: e.clientY - rect.top });
      return;
    }
    // Plain wheel scrolls along the road in horizontal mode
    if (orientation !== 'horizontal') return;
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    road.scrollLeft += e.deltaY;
    e.preventDefault();
  }, { passive: false });

  let lastCross = 0;
  new ResizeObserver(() => {
    const cross = crossSize();
    if (!cross || cross === lastCross) return;
    lastCross = cross;
    relayout();
  }).observe(road);

  observer = new IntersectionObserver(onIntersect, { root: road, rootMargin: '200%' });

  document.getElementById('road-viewer-tab-btn')?.addEventListener('click', () => {
    if (streetsStale) listStreets(false);
  });

  updateSegButtons();
  showEmpty('Open a dataset in the Datasets tab first.');
}

// Called by app.js when the active project/dataset changes
export function refreshRoadViewer() {
  if (!root) return;
  streetsStale = true;
  clearRoad();
  streets = [];
  const select = root.querySelector('#rdv-street');
  select.innerHTML = '<option>Loading…</option>';
  select.disabled = true;
  if (!root.classList.contains('hidden')) listStreets(false);
  else showEmpty(getCurrentDataset() ? 'Loading streets…' : 'Open a dataset in the Datasets tab first.');
}

// ── Street list ───────────────────────────────────────────────────────────────

async function listStreets(force) {
  const select = root.querySelector('#rdv-street');
  if (!getCurrentDataset()) {
    select.innerHTML = '<option>No dataset open</option>';
    select.disabled = true;
    clearRoad();
    showEmpty('Open a dataset in the Datasets tab first.');
    return;
  }
  const token = getToken();
  if (!token) { toast('Not signed in', 'error'); return; }

  const previous = select.value;
  select.disabled = true;
  select.innerHTML = '<option>Loading…</option>';
  try {
    const rawData = await getDatasetRawDataFolder(token);
    if (!rawData) { showEmpty('Open a dataset in the Datasets tab first.'); return; }
    streets = (await listAllFiles(
      token,
      `'${rawData.id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      'id,name'
    )).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    streetsStale = false;

    if (!streets.length) {
      select.innerHTML = '<option>No streets found</option>';
      clearRoad();
      showEmpty('This dataset has no street folders yet.');
      return;
    }
    select.innerHTML = '<option value="">Select a street…</option>' +
      streets.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
    select.disabled = false;

    if (!force) showEmpty('Select a street to view the whole road.');
    if (force && streets.some(s => s.id === previous)) {
      select.value = previous;
      loadStreet(previous);
    } else if (force) {
      clearRoad();
      showEmpty('Select a street to view the whole road.');
    }
  } catch (err) {
    select.innerHTML = '<option>Failed to load</option>';
    toast(`Could not list streets: ${err.message}`, 'error');
  }
}

// ── Street loading ────────────────────────────────────────────────────────────

async function loadStreet(streetId) {
  clearRoad();
  if (!streetId) { showEmpty('Select a street to view the whole road.'); return; }
  const token = getToken();
  if (!token) { toast('Not signed in', 'error'); return; }
  const myToken = loadToken;
  const status  = root.querySelector('#rdv-status');
  showEmpty('Loading street…');
  loadColorOverrides();

  try {
    const subfolders = await listAllFiles(
      token,
      `'${streetId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      'id,name'
    );
    const framesFolder = subfolders.find(f => f.name === 'frames');
    const labelsFolder = subfolders.find(f => f.name === 'labels');
    if (!framesFolder) { showEmpty('This street has no frames/ folder.'); return; }

    const [imageFiles, labelFiles] = await Promise.all([
      listAllFiles(token, `'${framesFolder.id}' in parents and trashed=false`, 'id,name'),
      labelsFolder ? listAllFiles(token, `'${labelsFolder.id}' in parents and trashed=false`, 'id,name') : [],
    ]);
    if (myToken !== loadToken) return;

    const images = imageFiles
      .filter(f => /\.(jpe?g|png)$/i.test(f.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (!images.length) { showEmpty('This street has no frame images.'); return; }

    const labelByStem = new Map(labelFiles
      .filter(f => f.name.endsWith('.json'))
      .map(f => [f.name.replace(/\.json$/, ''), f]));

    // Label JSONs are small — fetch them all up front to build the class list
    let done = 0;
    const labelSem = makeSemaphore(6);
    const labelled = await Promise.all(images.map(img => {
      const lf = labelByStem.get(img.name.replace(/\.[^.]+$/, ''));
      if (!lf) return null;
      return labelSem(async () => {
        if (myToken !== loadToken) return null;
        try {
          const json = JSON.parse(new TextDecoder().decode(await downloadFileContent(token, lf.id)));
          return json;
        } catch {
          return null;
        } finally {
          done++;
          status.textContent = `Loading labels ${done}/${labelByStem.size}…`;
        }
      });
    }));
    if (myToken !== loadToken) return;

    const classCounts = new Map();
    frames = images.map((img, i) => {
      const json   = labelled[i];
      const shapes = Array.isArray(json?.shapes) ? json.shapes : [];
      for (const s of shapes) {
        const name = s.label || '?';
        classCounts.set(name, (classCounts.get(name) || 0) + 1);
      }
      const dimsKnown = json?.imageWidth > 0 && json?.imageHeight > 0;
      return {
        name: img.name, imageId: img.id, shapes, hasLabel: !!json,
        w: dimsKnown ? json.imageWidth : 0, h: dimsKnown ? json.imageHeight : 0,
        dimsKnown, el: null, inner: null, loaded: false,
      };
    });
    classes = [...classCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Reference size for frames whose dimensions aren't known until their image loads
    const known = frames.find(f => f.dimsKnown);
    if (known) {
      refDims = { w: known.w, h: known.h };
    } else {
      const img = await fetchImage(token, frames[0].imageId, myToken);
      if (!img) return;
      refDims = { w: img.naturalWidth, h: img.naturalHeight };
    }
    for (const f of frames) if (!f.dimsKnown) { f.w = refDims.w; f.h = refDims.h; }

    renderLabelToggles();
    buildRoad();
    const labelledCount = frames.filter(f => f.hasLabel).length;
    const shapeCount = classes.reduce((n, c) => n + c.count, 0);
    status.textContent = `${frames.length} frames · ${labelledCount} labeled · ${shapeCount} labels`;
  } catch (err) {
    if (myToken !== loadToken) return;
    showEmpty(`Failed to load street: ${err.message}`);
    toast(`Failed to load street: ${err.message}`, 'error');
  }
}

function clearRoad() {
  loadToken++;
  observer?.disconnect();
  blobUrls.forEach(u => URL.revokeObjectURL(u));
  blobUrls = [];
  frames = [];
  classes = [];
  hidden = new Set();
  if (!root) return;
  road.innerHTML = '';
  root.querySelector('#rdv-labels').innerHTML = '';
  root.querySelector('#rdv-labels').classList.add('hidden');
  root.querySelector('#rdv-status').textContent = '';
  applyHidden();
}

function showEmpty(message) {
  const el = root.querySelector('#rdv-empty');
  el.textContent = message;
  el.classList.remove('hidden');
  road.classList.add('hidden');
}

// ── Label toggles ─────────────────────────────────────────────────────────────

function renderLabelToggles() {
  const wrap = root.querySelector('#rdv-labels');
  if (!classes.length) {
    wrap.innerHTML = '<span class="text-dim">No labels on this street.</span>';
    wrap.classList.remove('hidden');
    return;
  }
  wrap.innerHTML = `
    <span class="rdv-labels-title">Labels</span>
    ${classes.map((c, i) => {
      const color = classColor(c.name, labelMode);
      return `
        <label class="rdv-label-chip" style="border-color:${color}88;">
          <input type="checkbox" data-class-idx="${i}" ${hidden.has(i) ? '' : 'checked'} />
          <span class="rdv-swatch" style="background:${color};"></span>
          ${escapeHtml(c.name)} <span class="text-dim">(${c.count})</span>
        </label>`;
    }).join('')}
    <button class="btn btn-ghost btn-sm" data-labels-action="all">All</button>
    <button class="btn btn-ghost btn-sm" data-labels-action="none">None</button>
  `;
  wrap.classList.remove('hidden');
}

// Label colors live in a stylesheet keyed by class index, so switching
// dark/light mode recolors every frame without touching the SVGs
function applyColors() {
  const style = root?.querySelector('#rdv-color-style');
  if (!style) return;
  const rules = classes.map((c, i) => {
    const color = classColor(c.name, labelMode);
    return `.rdv-road g[data-class-idx="${i}"] .rdv-shape { stroke: ${color}; }
.rdv-road g[data-class-idx="${i}"] .rdv-shape[data-kind="area"] { fill: ${color}40; }`;
  });
  rules.push(`.rdv-road .rdv-halo { stroke: ${haloColor(labelMode)}; }`);
  style.textContent = rules.join('\n');
}

function applyHidden() {
  const style = root?.querySelector('#rdv-hide-style');
  if (!style) return;
  style.textContent = [...hidden]
    .map(i => `.rdv-road g[data-class-idx="${i}"] { display: none; }`)
    .join('\n');
}

// ── Road layout ───────────────────────────────────────────────────────────────

function buildRoad() {
  root.querySelector('#rdv-empty').classList.add('hidden');
  road.classList.remove('hidden');
  road.innerHTML = '';
  const classIdx = new Map(classes.map((c, i) => [c.name, i]));
  const frag = document.createDocumentFragment();

  frames.forEach((f, i) => {
    const el = document.createElement('div');
    el.className = 'rdv-frame';
    el.dataset.idx = i;
    const inner = document.createElement('div');
    inner.className = 'rdv-inner';
    const img = document.createElement('img');
    img.alt = f.name;
    img.draggable = false;
    inner.appendChild(img);

    if (f.shapes.length) {
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', `0 0 ${f.w} ${f.h}`);
      svg.setAttribute('preserveAspectRatio', 'none');
      for (const shape of f.shapes) {
        const node = shapeToSvg(shape);
        if (!node) continue;
        // A wider contrasting copy underneath keeps the shape visible on any background
        const halo = node.cloneNode();
        halo.setAttribute('class', 'rdv-halo');
        node.setAttribute('class', 'rdv-shape');
        const g = document.createElementNS(SVG_NS, 'g');
        g.dataset.classIdx = classIdx.get(shape.label || '?');
        g.append(halo, node);
        svg.appendChild(g);
      }
      inner.appendChild(svg);
    }

    // Section name sits outside the rotated inner box so it always reads upright
    const section = document.createElement('div');
    section.className = 'rdv-section';
    section.textContent = f.name.replace(/\.[^.]+$/, '');
    el.append(inner, section);
    f.el = el;
    f.inner = inner;
    frag.appendChild(el);
  });

  road.appendChild(frag);
  applyColors();
  road.scrollTop = 0;
  road.scrollLeft = 0;
  relayout();
  frames.forEach(f => observer.observe(f.el));
}

// Space available across the road (width when vertical, height when horizontal), minus any ruler gutter
function crossSize() {
  if (!road) return 0;
  const cs = getComputedStyle(road);
  return orientation === 'vertical'
    ? road.clientWidth  - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
    : road.clientHeight - parseFloat(cs.paddingTop)  - parseFloat(cs.paddingBottom);
}

function currentScale() {
  return (crossSize() / refDims.w) * (zoom / 100);
}

function sizeFrame(f, scale) {
  const W = f.w * scale;   // road width on screen
  const H = f.h * scale;   // length along the road
  f.inner.style.width  = `${W}px`;
  f.inner.style.height = `${H}px`;
  if (orientation === 'vertical') {
    f.el.style.width  = `${W}px`;
    f.el.style.height = `${H}px`;
    f.inner.style.transform = '';
  } else {
    // Rotate 90° counter-clockwise: the frame's top edge faces left, so frame order runs left→right
    f.el.style.width  = `${H}px`;
    f.el.style.height = `${W}px`;
    f.inner.style.transform = `translateY(${W}px) rotate(-90deg)`;
  }
}

// Re-sizes every frame while keeping the point at `focus` (px from the road's top-left;
// defaults to the top-left corner) over the same spot of the same frame
function relayout(focus = { x: 0, y: 0 }) {
  if (!frames.length || !frames[0].el) return;
  const anchor = getAnchor(focus);
  road.classList.toggle('rdv-horizontal', orientation === 'horizontal');
  SECTION_MODES.forEach(m => road.classList.toggle(`rdv-sec-${m.value}`, m.value === sectionMode));
  const scale = currentScale();
  frames.forEach(f => sizeFrame(f, scale));
  restoreAnchor(anchor, focus);
}

function getAnchor(focus) {
  const vertical = !road.classList.contains('rdv-horizontal');
  const along  = vertical ? focus.y : focus.x;
  const cross  = vertical ? focus.x : focus.y;
  const pos    = (vertical ? road.scrollTop : road.scrollLeft) + along;
  const crossScroll = vertical ? road.scrollLeft : road.scrollTop;
  const crossTotal  = vertical ? road.scrollWidth : road.scrollHeight;
  const anchor = {
    vertical,
    idx: frames.length - 1, frac: 0,
    crossFrac: crossTotal ? (crossScroll + cross) / crossTotal : 0,
  };
  for (let i = 0; i < frames.length; i++) {
    const el    = frames[i].el;
    const start = vertical ? el.offsetTop : el.offsetLeft;
    const size  = vertical ? el.offsetHeight : el.offsetWidth;
    if (pos < start + size) {
      anchor.idx  = i;
      anchor.frac = size ? Math.max(0, (pos - start) / size) : 0;
      break;
    }
  }
  return anchor;
}

function restoreAnchor({ vertical: wasVertical, idx, frac, crossFrac }, focus) {
  const el = frames[idx]?.el;
  if (!el) return;
  const vertical = orientation === 'vertical';
  const along = vertical ? focus.y : focus.x;
  const cross = vertical ? focus.x : focus.y;
  // Sideways position only carries over within the same orientation
  const crossPos = wasVertical === vertical
    ? crossFrac * (vertical ? road.scrollWidth : road.scrollHeight) - cross
    : 0;
  if (vertical) {
    road.scrollTop  = el.offsetTop + frac * el.offsetHeight - along;
    road.scrollLeft = crossPos;
  } else {
    road.scrollLeft = el.offsetLeft + frac * el.offsetWidth - along;
    road.scrollTop  = crossPos;
  }
}

function setOrientation(next) {
  if (next === orientation) return;
  orientation = next;
  writePref(ORIENT_KEY, next);
  updateSegButtons();
  relayout();
}

function updateSegButtons() {
  root.querySelectorAll('[data-orient]').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.orient === orientation));
  root.querySelectorAll('[data-label-mode]').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.labelMode === labelMode));
}

// focus: point (px from the road's top-left) that stays put while zooming; defaults to the view's center
function setZoom(value, focus) {
  zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));   // unrounded so small pinch steps accumulate
  root.querySelector('#rdv-zoom').value = Math.round(zoom);
  root.querySelector('#rdv-zoom-val').textContent = `${Math.round(zoom)}%`;
  relayout(focus ?? { x: road.clientWidth / 2, y: road.clientHeight / 2 });
}

// ── Lazy image loading ────────────────────────────────────────────────────────

function onIntersect(entries) {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    observer.unobserve(entry.target);
    const f = frames[Number(entry.target.dataset.idx)];
    if (f && !f.loaded) loadFrameImage(f);
  }
}

async function loadFrameImage(f) {
  f.loaded = true;
  const myToken = loadToken;
  const img = await fetchImage(getToken(), f.imageId, myToken);
  if (!img || myToken !== loadToken) return;
  const el = f.inner.querySelector('img');
  el.src = img.src;
  if (!f.dimsKnown && (img.naturalWidth !== f.w || img.naturalHeight !== f.h)) {
    f.w = img.naturalWidth;
    f.h = img.naturalHeight;
    f.dimsKnown = true;
    sizeFrame(f, currentScale());
  }
}

function fetchImage(token, fileId, myToken) {
  return imageSem(async () => {
    if (myToken !== loadToken) return null;
    try {
      const buf = await downloadFileContent(token, fileId);
      if (myToken !== loadToken) return null;
      const url = URL.createObjectURL(new Blob([buf]));
      blobUrls.push(url);
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } catch {
      return null;
    }
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
