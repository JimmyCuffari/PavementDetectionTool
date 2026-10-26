import { getToken } from './auth.js';
import { listAllFiles, downloadFileContent } from './drive.js';
import { getDatasetRawDataFolder, getCurrentDataset } from './dataset-manager.js';
import { makeSemaphore, toast } from './utils.js';
import { classColor, loadColorOverrides, shapeToSvg } from './label-draw.js';

// Road Viewer — lays a street's frames edge-to-edge as one continuous road,
// with LabelMe annotations overlaid and per-class visibility toggles.

const ORIENT_KEY = 'pavement_road_viewer_orientation';
const SVG_NS     = 'http://www.w3.org/2000/svg';

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
let orientation = readOrientation();
let observer    = null;
const imageSem  = makeSemaphore(6);

function readOrientation() {
  try { return localStorage.getItem(ORIENT_KEY) === 'horizontal' ? 'horizontal' : 'vertical'; }
  catch { return 'vertical'; }
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

        <div class="rdv-field rdv-zoom">
          <label for="rdv-zoom">Zoom</label>
          <input type="range" id="rdv-zoom" min="25" max="400" step="5" value="100" />
          <span id="rdv-zoom-val">100%</span>
          <button class="btn btn-ghost btn-sm" id="rdv-fit">Fit</button>
        </div>

        <span id="rdv-status" class="text-dim rdv-status"></span>
      </div>

      <div id="rdv-labels" class="rdv-labels hidden"></div>
      <div id="rdv-empty" class="rdv-empty text-dim hidden"></div>
      <div id="rdv-road" class="rdv-road"></div>
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
  container.querySelector('#rdv-fit').addEventListener('click', () => setZoom(100));

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

  // Mouse wheel scrolls along the road in horizontal mode
  road.addEventListener('wheel', (e) => {
    if (orientation !== 'horizontal' || e.ctrlKey) return;
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

  updateOrientationButtons();
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
      const color = classColor(c.name);
      return `
        <label class="rdv-label-chip" style="border-color:${color}55;">
          <input type="checkbox" data-class-idx="${i}" checked />
          <span class="rdv-swatch" style="background:${color};"></span>
          ${escapeHtml(c.name)} <span class="text-dim">(${c.count})</span>
        </label>`;
    }).join('')}
    <button class="btn btn-ghost btn-sm" data-labels-action="all">All</button>
    <button class="btn btn-ghost btn-sm" data-labels-action="none">None</button>
  `;
  wrap.classList.remove('hidden');
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
    el.title = f.name;
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
        const g = document.createElementNS(SVG_NS, 'g');
        g.dataset.classIdx = classIdx.get(shape.label || '?');
        g.appendChild(node);
        svg.appendChild(g);
      }
      inner.appendChild(svg);
    }

    el.appendChild(inner);
    f.el = el;
    f.inner = inner;
    frag.appendChild(el);
  });

  road.appendChild(frag);
  road.scrollTop = 0;
  road.scrollLeft = 0;
  relayout();
  frames.forEach(f => observer.observe(f.el));
}

function crossSize() {
  if (!road) return 0;
  return orientation === 'vertical' ? road.clientWidth : road.clientHeight;
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

// Re-sizes every frame while keeping the frame in view anchored in place
function relayout() {
  if (!frames.length || !frames[0].el) return;
  const anchor = getAnchor();
  road.classList.toggle('rdv-horizontal', orientation === 'horizontal');
  const scale = currentScale();
  frames.forEach(f => sizeFrame(f, scale));
  restoreAnchor(anchor);
}

function getAnchor() {
  const vertical = road.classList.contains('rdv-horizontal') === false;
  const pos = vertical ? road.scrollTop : road.scrollLeft;
  for (let i = 0; i < frames.length; i++) {
    const el    = frames[i].el;
    const start = vertical ? el.offsetTop : el.offsetLeft;
    const size  = vertical ? el.offsetHeight : el.offsetWidth;
    if (pos < start + size) return { idx: i, frac: size ? Math.max(0, (pos - start) / size) : 0 };
  }
  return { idx: frames.length - 1, frac: 0 };
}

function restoreAnchor({ idx, frac }) {
  const el = frames[idx]?.el;
  if (!el) return;
  if (orientation === 'vertical') {
    road.scrollTop  = el.offsetTop + frac * el.offsetHeight;
    road.scrollLeft = 0;
  } else {
    road.scrollLeft = el.offsetLeft + frac * el.offsetWidth;
    road.scrollTop  = 0;
  }
}

function setOrientation(next) {
  if (next === orientation) return;
  orientation = next;
  try { localStorage.setItem(ORIENT_KEY, next); } catch { /* ignore */ }
  updateOrientationButtons();
  relayout();
}

function updateOrientationButtons() {
  root.querySelectorAll('[data-orient]').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.orient === orientation));
}

function setZoom(value) {
  zoom = value;
  root.querySelector('#rdv-zoom').value = value;
  root.querySelector('#rdv-zoom-val').textContent = `${value}%`;
  relayout();
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
