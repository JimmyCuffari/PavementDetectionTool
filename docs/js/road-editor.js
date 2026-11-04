import { getToken } from './auth.js';
import { listAllFiles, downloadFileContent, upsertFile, findOrCreateFolder } from './drive.js';
import { getDatasetRawDataFolder } from './dataset-manager.js';
import { makeSemaphore, toast } from './utils.js';
import { shapeToSvg } from './label-draw.js';
import { clamp, roundPoint, shapeArea, clipShapeToFrame, movePointsWithin, nearestEdge } from './road-edit-geometry.js';

// Road Viewer edit mode: select, relabel, delete, reshape and draw labels, including across frame
// seams. Edits stay in memory, with undo/redo, until Save writes the changed frames to Drive.

const SVG_NS         = 'http://www.w3.org/2000/svg';
const HISTORY_LIMIT  = 200;
const HANDLE_PX      = 5;    // handle radius on screen
const CLOSE_PX       = 8;    // click this close to a polygon's first point to close it
const EDGE_PX        = 8;    // double-click this close to an edge to add a vertex
const DRAG_PX        = 3;    // pointer travel before a press counts as a drag
const LABELME_VERSION = '5.5.0';
const NEW_CLASS      = '__new__';

const TOOLS = [
  { value: 'select',    key: 'v', label: 'Select',    title: 'Select, move and reshape labels (V)' },
  { value: 'polygon',   key: 'p', label: 'Polygon',   title: 'Click to add points. Enter, double-click or the first point finishes (P)' },
  { value: 'rectangle', key: 'r', label: 'Rectangle', title: 'Drag to draw a rectangle (R)' },
  { value: 'linestrip', key: 'l', label: 'Line',      title: 'Click to add points, Enter or double-click finishes (L). Lines only export in detect mode; segment mode skips them.' },
];

let ctx          = null;   // accessors supplied by road-viewer.js
let bar          = null;
let road         = null;
let editing      = false;
let tool         = 'select';
let currentClass = '';
let extraClasses = [];     // created with "New class…" but not used by a shape yet
let selection    = null;   // { frame, idx }
let draft        = null;   // { type, frame, points, cursor }
let drag         = null;   // press in progress, see startDrag
let undoStack    = [];
let redoStack    = [];
let saving       = false;
let saveProgress = '';
let reviewedKeys = new Set();   // "street/label.json" entries with a review decision
let warnedFrames = new Set();
let reviewToken  = 0;

// ── Setup ─────────────────────────────────────────────────────────────────────

export function initRoadEditor(barEl, roadEl, context) {
  bar  = barEl;
  road = roadEl;
  ctx  = context;

  bar.innerHTML = `
    <div class="rdv-seg" role="group" aria-label="Mode">
      <button class="rdv-seg-btn" data-edit-mode="view">View</button>
      <button class="rdv-seg-btn" data-edit-mode="edit">Edit</button>
    </div>
    <div class="rdv-edit-group" id="rdv-edit-tools">
      <div class="rdv-seg" role="group" aria-label="Tool">
        ${TOOLS.map(t => `<button class="rdv-seg-btn" data-tool="${t.value}" title="${t.title}">${t.label}</button>`).join('')}
      </div>
      <div class="rdv-field">
        <label for="rdv-class">Class</label>
        <select id="rdv-class" class="rdv-class-select"></select>
      </div>
      <button class="btn btn-ghost btn-sm" id="rdv-delete" title="Delete the selected label (Del)">Delete</button>
      <button class="btn btn-ghost btn-sm" id="rdv-undo" title="Undo (Ctrl+Z)">Undo</button>
      <button class="btn btn-ghost btn-sm" id="rdv-redo" title="Redo (Ctrl+Y)">Redo</button>
    </div>
    <div class="rdv-edit-group" id="rdv-edit-actions">
      <span id="rdv-unsaved" class="rdv-unsaved"></span>
      <button class="btn btn-primary btn-sm" id="rdv-save" title="Save changed frames to Drive (Ctrl+S)">Save</button>
      <button class="btn btn-ghost btn-sm" id="rdv-discard">Discard</button>
    </div>
  `;

  bar.querySelectorAll('[data-edit-mode]').forEach(btn =>
    btn.addEventListener('click', () => setEditing(btn.dataset.editMode === 'edit')));
  bar.querySelectorAll('[data-tool]').forEach(btn =>
    btn.addEventListener('click', () => setTool(btn.dataset.tool)));
  bar.querySelector('#rdv-class').addEventListener('change', onClassChange);
  bar.querySelector('#rdv-delete').addEventListener('click', deleteSelection);
  bar.querySelector('#rdv-undo').addEventListener('click', undo);
  bar.querySelector('#rdv-redo').addEventListener('click', redo);
  bar.querySelector('#rdv-save').addEventListener('click', () => save());
  bar.querySelector('#rdv-discard').addEventListener('click', discard);

  road.addEventListener('pointerdown', onPointerDown);
  road.addEventListener('pointermove', onPointerMove);
  road.addEventListener('click', onClick);
  road.addEventListener('dblclick', onDoubleClick);
  road.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);
  document.addEventListener('keydown', onKeyDown);
  window.addEventListener('beforeunload', (e) => {
    if (!dirtyCount()) return;
    e.preventDefault();
    e.returnValue = '';
  });

  updateBar();
}

// A new street was built: forget everything tied to the old one
export function resetEditor() {
  selection = null;
  draft     = null;
  drag      = null;
  undoStack = [];
  redoStack = [];
  extraClasses = [];
  warnedFrames = new Set();
  reviewedKeys = new Set();
  reviewToken++;
  updateBar();
}

export function onStreetLoaded() {
  loadReviewDecisions();
  updateBar();
}

export function dirtyCount() {
  return ctx ? ctx.frames().filter(f => f.dirty).length : 0;
}

// ── Mode and tool ─────────────────────────────────────────────────────────────

function setEditing(next) {
  editing = next;
  cancelDraft();
  if (!editing) setSelection(null);
  updateBar();
}

function setTool(next) {
  tool = next;
  cancelDraft();
  if (tool !== 'select') setSelection(null);
  updateBar();
}

function updateBar() {
  if (!bar) return;
  const frames  = ctx.frames();
  const dirty   = frames.filter(f => f.dirty).length;
  const hasRoad = frames.length > 0;

  road.classList.toggle('rdv-editing', editing && hasRoad);
  road.classList.toggle('rdv-tool-draw', editing && tool !== 'select');
  bar.querySelectorAll('[data-edit-mode]').forEach(btn =>
    btn.classList.toggle('active', (btn.dataset.editMode === 'edit') === editing));
  bar.querySelectorAll('[data-tool]').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.tool === tool));

  bar.querySelector('#rdv-edit-tools').classList.toggle('hidden', !editing);
  bar.querySelector('#rdv-edit-actions').classList.toggle('hidden', !editing && !dirty);
  bar.querySelector('#rdv-delete').disabled  = !selection;
  bar.querySelector('#rdv-undo').disabled    = !undoStack.length;
  bar.querySelector('#rdv-redo').disabled    = !redoStack.length;
  bar.querySelector('#rdv-save').disabled    = !dirty || saving;
  bar.querySelector('#rdv-discard').disabled = !dirty || saving;
  bar.querySelector('#rdv-unsaved').textContent = saving
    ? saveProgress
    : dirty ? `${dirty} frame${dirty === 1 ? '' : 's'} unsaved` : 'All changes saved';
  renderClassOptions();
}

function renderClassOptions() {
  const select = bar.querySelector('#rdv-class');
  const names = [...new Set([...ctx.classes().map(c => c.name), ...extraClasses])];
  if (!names.includes(currentClass)) currentClass = names[0] ?? '';
  const options = [
    ...names.map(n => {
      const opt = document.createElement('option');
      opt.value = n;
      opt.textContent = n;
      return opt;
    }),
  ];
  const create = document.createElement('option');
  create.value = NEW_CLASS;
  create.textContent = 'New class…';
  select.replaceChildren(...options, create);
  select.value = currentClass || NEW_CLASS;
}

function onClassChange(e) {
  const select = e.target;
  select.blur();   // hand keyboard shortcuts back to the road
  let name = select.value;
  if (name === NEW_CLASS) {
    name = promptForClass();
    if (!name) { renderClassOptions(); return; }
  }
  currentClass = name;
  if (selection && selectedShape().label !== name) {
    edit([selection.frame], () => { selectedShape().label = name; });
    ctx.showClass(name);
  }
  updateBar();
}

function promptForClass() {
  const name = (prompt('Name for the new class:') ?? '').trim();
  if (!name) return '';
  if (!extraClasses.includes(name) && !ctx.classes().some(c => c.name === name)) extraClasses.push(name);
  return name;
}

// ── Coordinates ───────────────────────────────────────────────────────────────

function clientToFrame(f, cx, cy) {
  const r = f.inner.getBoundingClientRect();
  const s = ctx.scale();
  return ctx.orientation() === 'vertical'
    ? [(cx - r.left) / s, (cy - r.top) / s]
    : [(r.bottom - cy) / s, (cx - r.left) / s];
}

function frameToClient(f, [x, y]) {
  const r = f.inner.getBoundingClientRect();
  const s = ctx.scale();
  return ctx.orientation() === 'vertical'
    ? [r.left + x * s, r.top + y * s]
    : [r.left + y * s, r.bottom - x * s];
}

function frameAt(target) {
  const el = target.closest?.('.rdv-frame');
  return el ? ctx.frames()[Number(el.dataset.idx)] : null;
}

function onScrollbar(e) {
  const r = road.getBoundingClientRect();
  return e.clientX - r.left >= road.clientWidth || e.clientY - r.top >= road.clientHeight;
}

// ── Edits and history ─────────────────────────────────────────────────────────

// Runs `change`, which mutates the shapes of `touched`, as one undoable step
function edit(touched, change) {
  const before = touched.map(f => JSON.stringify(f.shapes));
  change();
  recordStep(touched, before);
}

function recordStep(touched, before) {
  const entries = [];
  touched.forEach((f, i) => {
    const after = JSON.stringify(f.shapes);
    if (after !== before[i]) entries.push({ frame: f, before: before[i], after });
  });
  if (entries.length) {
    undoStack.push(entries);
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack = [];
    warnIfReviewed(entries.map(e => e.frame));
  }
  afterChange(touched);
}

function afterChange(touched) {
  for (const f of touched) f.dirty = JSON.stringify(f.shapes) !== f.savedShapes;
  ctx.refreshClasses();
  touched.forEach(f => ctx.renderFrameShapes(f));
  updateBar();
}

function applyHistory(from, to, side) {
  const entries = from.pop();
  if (!entries) return;
  to.push(entries);
  setSelection(null);
  for (const e of entries) e.frame.shapes = JSON.parse(e[side]);
  afterChange(entries.map(e => e.frame));
}

function undo() {
  if (draft) { popDraftPoint(); return; }
  applyHistory(undoStack, redoStack, 'before');
}

function redo() {
  if (!draft) applyHistory(redoStack, undoStack, 'after');
}

function discard() {
  const dirty = ctx.frames().filter(f => f.dirty);
  if (!dirty.length) return;
  if (!confirm(`Discard unsaved edits on ${dirty.length} frame${dirty.length === 1 ? '' : 's'}?`)) return;
  setSelection(null);
  cancelDraft();
  undoStack = [];
  redoStack = [];
  for (const f of dirty) f.shapes = JSON.parse(f.savedShapes);
  afterChange(dirty);
}

// ── Selection and handles ─────────────────────────────────────────────────────

function selectedShape() {
  return selection ? selection.frame.shapes[selection.idx] : null;
}

function setSelection(next) {
  const prev = selection?.frame;
  selection = next;
  if (prev && prev !== next?.frame) { prev.el.classList.remove('rdv-frame-active'); ctx.renderFrameShapes(prev); }
  if (next) {
    next.frame.el.classList.add('rdv-frame-active');
    ctx.renderFrameShapes(next.frame);
    currentClass = selectedShape().label || currentClass;
  }
  updateBar();
}

// Called by road-viewer.js after it redraws a frame's shapes
export function decorateFrame(f) {
  if (selection?.frame === f) {
    const g = f.svg.querySelector(`g[data-shape-idx="${selection.idx}"]`);
    g?.classList.add('rdv-selected');
    const shape = selectedShape();
    if (shape) f.svg.appendChild(buildHandles(shape));
  }
  if (draft?.frame === f) f.svg.appendChild(buildDraft());
}

function buildHandles(shape) {
  const group = document.createElementNS(SVG_NS, 'g');
  group.setAttribute('class', 'rdv-handles');
  const r = HANDLE_PX / ctx.scale();
  shape.points.forEach(([x, y], i) => {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('class', 'rdv-handle');
    c.setAttribute('cx', x);
    c.setAttribute('cy', y);
    c.setAttribute('r', r);
    c.setAttribute('vector-effect', 'non-scaling-stroke');
    c.dataset.vertex = i;
    group.appendChild(c);
  });
  return group;
}

function buildDraft() {
  const group = document.createElementNS(SVG_NS, 'g');
  group.setAttribute('class', 'rdv-draft');
  const pts = draft.cursor ? [...draft.points, draft.cursor] : draft.points;
  const preview = draft.type === 'rectangle'
    ? { shape_type: 'rectangle', points: pts.slice(0, 2) }
    : { shape_type: 'linestrip', points: draft.type === 'polygon' && pts.length > 2 ? [...pts, pts[0]] : pts };
  if (preview.points.length >= 2) {
    const node = shapeToSvg(preview);
    if (node) group.appendChild(node);
  }
  const r = (HANDLE_PX - 1) / ctx.scale();
  for (const [x, y] of draft.points) {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('class', 'rdv-draft-point');
    c.setAttribute('cx', x);
    c.setAttribute('cy', y);
    c.setAttribute('r', r);
    c.setAttribute('vector-effect', 'non-scaling-stroke');
    group.appendChild(c);
  }
  return group;
}

// Zoom changed: handles and draft points must keep their size on screen
export function onLayoutChanged() {
  if (selection) ctx.renderFrameShapes(selection.frame);
  if (draft && draft.frame !== selection?.frame) ctx.renderFrameShapes(draft.frame);
}

export function onOrientationChanged() {
  cancelDraft();
}

export function onClassVisibilityChanged() {
  const shape = selectedShape();
  if (shape && ctx.isClassHidden(shape.label || '?')) setSelection(null);
}

// Smallest visible shape under the point, so a small label inside a big polygon stays clickable
function hitTest(cx, cy) {
  let best = null;
  for (const el of document.elementsFromPoint(cx, cy)) {
    if (el.classList.contains('rdv-handle')) return { handle: Number(el.dataset.vertex) };
    const g = el.closest?.('g[data-shape-idx]');
    const frame = g && frameAt(g);
    if (!frame) continue;
    const idx = Number(g.dataset.shapeIdx);
    const area = shapeArea(frame.shapes[idx]);
    if (!best || area < best.area) best = { frame, idx, area };
  }
  return best;
}

function deleteSelection() {
  if (!selection) return;
  const { frame, idx } = selection;
  setSelection(null);
  edit([frame], () => { frame.shapes.splice(idx, 1); });
}

// ── Pointer handling ──────────────────────────────────────────────────────────

function onPointerDown(e) {
  if (!editing || e.button !== 0 || onScrollbar(e)) return;
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();

  if (tool === 'select') {
    const hit = hitTest(e.clientX, e.clientY);
    if (hit?.handle !== undefined) {
      startDrag(e, { kind: 'vertex', vertex: hit.handle });
    } else if (hit) {
      if (selection?.frame !== hit.frame || selection.idx !== hit.idx) setSelection({ frame: hit.frame, idx: hit.idx });
      startDrag(e, { kind: 'body' });
    } else {
      setSelection(null);
    }
    return;
  }

  if (tool === 'rectangle') {
    const frame = frameAt(e.target);
    if (!frame || !ensureDrawable(frame)) return;
    const start = clientToFrame(frame, e.clientX, e.clientY);
    beginDraft('rectangle', frame, [start]);
    road.setPointerCapture(e.pointerId);
    drag = { kind: 'rectangle' };
  }
}

function startDrag(e, details) {
  const { frame } = selection;
  drag = {
    ...details,
    frame,
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    started: false,
    before: JSON.stringify(frame.shapes),
    startPoints: selectedShape().points.map(p => [...p]),
    startFrame: clientToFrame(frame, e.clientX, e.clientY),
  };
}

function onPointerMove(e) {
  if (!editing) return;
  if (drag?.kind === 'rectangle') {
    draft.cursor = clientToFrame(draft.frame, e.clientX, e.clientY);
    ctx.renderFrameShapes(draft.frame);
    return;
  }
  if (drag) {
    if (!drag.started) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_PX) return;
      drag.started = true;
      road.setPointerCapture(drag.pointerId);
    }
    applyDrag(clientToFrame(drag.frame, e.clientX, e.clientY));
    ctx.renderFrameShapes(drag.frame);
    return;
  }
  if (draft) {
    draft.cursor = clientToFrame(draft.frame, e.clientX, e.clientY);
    ctx.renderFrameShapes(draft.frame);
  }
}

function applyDrag(p) {
  const shape = selectedShape();
  const { frame, startPoints, startFrame } = drag;
  const dx = p[0] - startFrame[0];
  const dy = p[1] - startFrame[1];
  const type = shape.shape_type || 'polygon';
  if (drag.kind === 'body' || (type === 'circle' && drag.vertex === 0)) {
    shape.points = movePointsWithin(startPoints, dx, dy, frame.w, frame.h);
  } else {
    shape.points[drag.vertex] = roundPoint([clamp(p[0], 0, frame.w), clamp(p[1], 0, frame.h)]);
  }
}

function onPointerUp(e) {
  if (!drag) return;
  const current = drag;
  drag = null;
  if (current.kind === 'rectangle') {
    if (road.hasPointerCapture(e.pointerId)) road.releasePointerCapture(e.pointerId);
    draft.points.push(clientToFrame(draft.frame, e.clientX, e.clientY));
    finishDraft();
    return;
  }
  if (current.started) recordStep([current.frame], [current.before]);
}

function onPointerCancel() {
  if (!drag) return;
  const current = drag;
  drag = null;
  if (current.kind === 'rectangle') { cancelDraft(); return; }
  if (current.started) {
    current.frame.shapes = JSON.parse(current.before);
    ctx.renderFrameShapes(current.frame);
  }
}

// Polygon and line vertices go on click, so a double-click adds one point and then finishes
function onClick(e) {
  if (!editing || (tool !== 'polygon' && tool !== 'linestrip') || onScrollbar(e)) return;
  if (e.detail >= 2) { finishDraft(); return; }

  if (!draft) {
    const frame = frameAt(e.target);
    if (!frame || !ensureDrawable(frame)) return;
    beginDraft(tool, frame, [clientToFrame(frame, e.clientX, e.clientY)]);
    return;
  }

  if (draft.type === 'polygon' && draft.points.length >= 3) {
    const [fx, fy] = frameToClient(draft.frame, draft.points[0]);
    if (Math.hypot(e.clientX - fx, e.clientY - fy) <= CLOSE_PX) { finishDraft(); return; }
  }
  draft.points.push(clientToFrame(draft.frame, e.clientX, e.clientY));
  ctx.renderFrameShapes(draft.frame);
}

function onDoubleClick(e) {
  if (!editing || tool !== 'select' || !selection) return;
  const shape = selectedShape();
  const type = shape.shape_type || 'polygon';
  if (type !== 'polygon' && type !== 'linestrip' && type !== 'line') return;
  if (hitTest(e.clientX, e.clientY)?.handle !== undefined) return;
  const p = clientToFrame(selection.frame, e.clientX, e.clientY);
  const near = nearestEdge(shape.points, p, type === 'polygon');
  if (!near || near.dist * ctx.scale() > EDGE_PX) return;
  const { frame } = selection;
  edit([frame], () => {
    shape.points.splice(near.index + 1, 0, roundPoint([clamp(near.point[0], 0, frame.w), clamp(near.point[1], 0, frame.h)]));
    if (type === 'line') shape.shape_type = 'linestrip';   // a "line" only ever has two points
  });
}

function onContextMenu(e) {
  if (!editing || !selection || !e.target.classList?.contains('rdv-handle')) return;
  e.preventDefault();
  const shape = selectedShape();
  const type = shape.shape_type || 'polygon';
  const minimum = type === 'polygon' ? 3 : type === 'linestrip' || type === 'line' ? 2 : Infinity;
  if (shape.points.length <= minimum) {
    toast(minimum === Infinity ? 'This label has a fixed number of points' : `A ${type} needs at least ${minimum} points`, 'info');
    return;
  }
  const vertex = Number(e.target.dataset.vertex);
  edit([selection.frame], () => { shape.points.splice(vertex, 1); });
}

// ── Drawing ───────────────────────────────────────────────────────────────────

function ensureDrawable(frame) {
  if (frame.labelLoadFailed) {
    toast(`${frame.name}: its label file failed to load, so it's locked. Refresh to try again.`, 'error');
    return false;
  }
  if (!currentClass) {
    const name = promptForClass();
    if (!name) return false;
    currentClass = name;
    updateBar();
  }
  return true;
}

function beginDraft(type, frame, points) {
  draft = { type, frame, points, cursor: null };
  frame.el.classList.add('rdv-frame-active');
  ctx.renderFrameShapes(frame);
}

function popDraftPoint() {
  draft.points.pop();
  if (!draft.points.length) cancelDraft();
  else ctx.renderFrameShapes(draft.frame);
}

function cancelDraft() {
  if (!draft) return;
  const { frame } = draft;
  draft = null;
  if (drag?.kind === 'rectangle') drag = null;
  if (selection?.frame !== frame) frame.el.classList.remove('rdv-frame-active');
  ctx.renderFrameShapes(frame);
}

function finishDraft() {
  if (!draft) return;
  const { type, frame: anchor, points } = draft;
  const required = type === 'polygon' ? 3 : 2;
  if (points.length < required) {
    // Keep the points, so a stray double-click or Enter doesn't lose work. Esc still cancels.
    toast(`A ${type === 'linestrip' ? 'line' : type} needs at least ${required} points`, 'info');
    return;
  }

  // Work out each overlapped frame's piece, walking outward from the frame drawing started in
  const clientPts = points.map(p => frameToClient(anchor, p));
  const frames = ctx.frames();
  const anchorIdx = frames.indexOf(anchor);
  const pieces = [];
  const visit = (f) => {
    const local = clientPts.map(([cx, cy]) => clientToFrame(f, cx, cy));
    const ys = local.map(p => p[1]);
    if (Math.max(...ys) < 0 || Math.min(...ys) > f.h) return false;
    for (const pts of clipShapeToFrame(type, local, f.w, f.h)) pieces.push({ frame: f, pts });
    return true;
  };
  for (let i = anchorIdx; i < frames.length && visit(frames[i]); i++);
  for (let i = anchorIdx - 1; i >= 0 && visit(frames[i]); i--);

  cancelDraft();

  const usable = pieces.filter(p => !p.frame.labelLoadFailed);
  if (usable.length < pieces.length) {
    toast('Skipped the part of the label on a locked frame (its label file failed to load)', 'error', 6000);
  }
  if (!usable.length) {
    if (!pieces.length) toast('That shape is too small to keep', 'info');
    return;
  }

  const touched = [...new Set(usable.map(p => p.frame))];
  edit(touched, () => {
    for (const { frame, pts } of usable) {
      frame.shapes.push({ label: currentClass, points: pts, group_id: null, description: '', shape_type: type, flags: {} });
    }
  });
  ctx.showClass(currentClass);
}

// ── Keyboard ──────────────────────────────────────────────────────────────────

function onKeyDown(e) {
  if (!editing || !ctx.isVisible()) return;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
  if (drag && drag.kind !== 'rectangle') return;   // a shape is mid-drag and still selected
  const key = e.key.toLowerCase();

  if (e.ctrlKey || e.metaKey) {
    const action = key === 'z' ? (e.shiftKey ? redo : undo)
      : key === 'y' ? redo
      : key === 's' ? () => save()
      : null;
    if (action) { e.preventDefault(); action(); }
    return;
  }
  if (e.altKey) return;

  if (draft) {
    if (e.key === 'Enter')     { e.preventDefault(); finishDraft(); return; }
    if (e.key === 'Escape')    { e.preventDefault(); cancelDraft(); return; }
    if (e.key === 'Backspace') { e.preventDefault(); popDraftPoint(); return; }
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (selection) { e.preventDefault(); deleteSelection(); }
    return;
  } else if (e.key === 'Escape') {
    setSelection(null);
    return;
  }

  const next = TOOLS.find(t => t.key === key);
  if (next) { e.preventDefault(); setTool(next.value); }
}

// ── Review decisions ──────────────────────────────────────────────────────────

// Read-only. Indexed by each entry's own fields so older files, keyed by label id, still match.
async function loadReviewDecisions() {
  const myToken = ++reviewToken;
  const token = getToken();
  if (!token) return;
  try {
    const rawData = await getDatasetRawDataFolder(token);
    if (!rawData) return;
    const files = await listAllFiles(
      token,
      `name='review_decisions.json' and '${rawData.id}' in parents and trashed=false`,
      'id,name'
    );
    if (!files.length) return;
    const parsed = JSON.parse(new TextDecoder().decode(await downloadFileContent(token, files[0].id)));
    if (myToken !== reviewToken) return;
    reviewedKeys = new Set(Object.values(parsed)
      .filter(d => d?.videoSlug && d?.labelName)
      .map(d => `${d.videoSlug}/${d.labelName}`));
  } catch (err) {
    console.warn('[road-editor] could not read review decisions:', err);
  }
}

function labelFileName(f) {
  return `${f.name.replace(/\.[^.]+$/, '')}.json`;
}

function isReviewed(f, street, keys = reviewedKeys) {
  return keys.has(`${street.name}/${labelFileName(f)}`);
}

function warnIfReviewed(touched) {
  const street = ctx.street();
  if (!street) return;
  for (const f of touched) {
    if (warnedFrames.has(f) || !isReviewed(f, street)) continue;
    warnedFrames.add(f);
    toast(`${labelFileName(f)} already has a review decision. It stays as it is, so it may need another look.`, 'info', 6000);
  }
}

// ── Saving ────────────────────────────────────────────────────────────────────

// Saves the current street's edits. Returns once finished; never throws. Safe to call just before
// the road is cleared, because everything it needs is captured before its first await.
export function save() {
  const dirty = ctx.frames().filter(f => f.dirty);
  if (!dirty.length || saving) return Promise.resolve();
  return saveFrames(dirty, ctx.street(), reviewedKeys);
}

async function saveFrames(dirty, street, reviewed) {
  const token = getToken();
  if (!token) { toast('Not signed in', 'error'); return; }
  saving = true;
  saveProgress = 'Saving…';
  updateBar();

  const failures = [];
  const written = [];
  try {
    // findOrCreateFolder would create a second folder if its lookup hit an error, so it's only
    // used when the street had no labels folder when it was loaded
    const labelsFolderId = street.labelsFolderId ?? (await findOrCreateFolder(token, 'labels', street.id)).id;
    if (!labelsFolderId) throw new Error('could not open the labels folder');
    street.labelsFolderId = labelsFolderId;

    const remote = await listLabelFiles(token, labelsFolderId);
    const conflicts = [];
    const ready = [];
    for (const f of dirty) {
      const existing = remote.get(labelFileName(f));
      if (!existing && f.labelId) {
        // Could be a real deletion, or a listing that failed (listAllFiles returns [] on errors).
        // Either way, creating a new file here risks a duplicate.
        failures.push({ frame: f, message: 'its label file was not found in Drive. Refresh the street and try again.' });
      } else if (existing && existing.modifiedTime !== f.labelModified) {
        conflicts.push({ frame: f, existing });
      } else {
        ready.push({ frame: f, existing });
      }
    }

    if (conflicts.length) {
      const n = conflicts.length;
      const overwrite = confirm(`${n} frame${n === 1 ? ' was' : 's were'} changed by someone else since this street loaded:\n\n`
        + conflicts.slice(0, 8).map(c => c.frame.name).join('\n')
        + (n > 8 ? `\n…and ${n - 8} more` : '')
        + '\n\nOverwrite with your version? Cancel keeps your edits unsaved.');
      if (overwrite) ready.push(...conflicts);
    }

    const writeSem = makeSemaphore(4);
    let done = 0;
    await Promise.all(ready.map(({ frame, existing }) => writeSem(async () => {
      try {
        written.push({ frame, ...(await writeFrame(getToken() ?? token, labelsFolderId, frame, existing)) });
      } catch (err) {
        failures.push({ frame, message: err.message });
      }
      done++;
      saveProgress = `Saving ${done}/${ready.length}…`;
      updateBar();
    })));

    if (written.length) {
      // Record the new modified times, so the next save doesn't see our own writes as conflicts
      const updated = await listLabelFiles(token, labelsFolderId);
      for (const { frame, snapshot, id } of written) {
        frame.savedShapes = snapshot;
        frame.dirty = JSON.stringify(frame.shapes) !== snapshot;
        frame.labelId = id;
        frame.hasLabel = true;
        frame.labelModified = updated.get(labelFileName(frame))?.modifiedTime ?? frame.labelModified;
      }
    }

    const skipped = conflicts.length && !ready.some(r => conflicts.includes(r)) ? conflicts.length : 0;
    reportSave(written, failures, skipped, street, reviewed);
  } catch (err) {
    toast(`Save failed: ${err.message}. Your edits are still here.`, 'error', 8000);
  } finally {
    saving = false;
    updateBar();
    ctx.refreshStatus();
  }
}

async function listLabelFiles(token, folderId) {
  const files = await listAllFiles(token, `'${folderId}' in parents and trashed=false`, 'id,name,modifiedTime');
  return new Map(files.map(f => [f.name, f]));
}

// Re-reads an existing file and replaces only `shapes`, so imageData and every other field survive
async function writeFrame(token, folderId, f, existing) {
  const snapshot = JSON.stringify(f.shapes);
  const shapes = JSON.parse(snapshot);
  let json;
  if (existing) {
    json = JSON.parse(new TextDecoder().decode(await downloadFileContent(token, existing.id)));
    json.shapes = shapes;
  } else {
    const { width, height } = await imageSize(token, f);
    json = {
      version: LABELME_VERSION,
      flags: {},
      shapes,
      imagePath: f.name,
      imageData: null,
      imageHeight: height,
      imageWidth: width,
    };
  }
  const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
  // upsertFile doesn't check the HTTP status, so a refused write only shows up in the response body
  const result = await upsertFile(token, folderId, labelFileName(f), 'application/json', blob, existing?.id);
  if (result?.error || !result?.id) throw new Error(result?.error?.message || 'Drive rejected the write');
  return { snapshot, id: result.id };
}

async function imageSize(token, f) {
  if (f.dimsKnown) return { width: f.w, height: f.h };
  const bitmap = await createImageBitmap(new Blob([await downloadFileContent(token, f.imageId)]));
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
}

function reportSave(written, failures, skipped, street, reviewed) {
  if (written.length) {
    const reviewedCount = written.filter(w => isReviewed(w.frame, street, reviewed)).length;
    toast(`Saved ${written.length} frame${written.length === 1 ? '' : 's'}`
      + (reviewedCount ? ` (${reviewedCount} already reviewed, decisions unchanged)` : ''), 'success', 6000);
  }
  if (failures.length) {
    toast(`${failures.length} frame${failures.length === 1 ? '' : 's'} not saved. ${failures[0].frame.name}: ${failures[0].message}`, 'error', 10000);
  }
  if (skipped) {
    toast(`${skipped} changed frame${skipped === 1 ? '' : 's'} left unsaved`, 'info', 6000);
  }
}
