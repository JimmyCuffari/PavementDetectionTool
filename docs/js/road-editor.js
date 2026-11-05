import { getToken } from './auth.js';
import { listAllFiles, downloadFileContent, upsertFile, findOrCreateFolder } from './drive.js';
import { getDatasetRawDataFolder } from './dataset-manager.js';
import { makeSemaphore, toast } from './utils.js';
import { shapeToSvg } from './label-draw.js';
import {
  clamp, roundPoint, shapeArea, clipShapeToFrame, nearestEdge, moveLimits, intersectLimits,
  pointInBox, shapeInBox, fitShift,
} from './road-edit-geometry.js';

// Road Viewer edit mode: select, relabel, delete, reshape, copy and draw labels, including across
// frame seams. Edits stay in memory, with undo/redo, until Save writes the changed frames to Drive.

const SVG_NS         = 'http://www.w3.org/2000/svg';
const HISTORY_LIMIT  = 200;
const HANDLE_PX      = 5;    // handle radius on screen
const CLOSE_PX       = 8;    // click this close to a polygon's first point to close it
const EDGE_PX        = 8;    // double-click this close to an edge to add a vertex
const DRAG_PX        = 3;    // pointer travel before a press counts as a drag
const LABELME_VERSION = '5.5.0';
const NEW_CLASS      = '__new__';

const TOOLS = [
  { value: 'select',    key: 'v', label: 'Select',    title: 'Click a label, or drag a box around several, to move them. Shift+click adds or removes; Shift+drag starts a box on top of a label (V)' },
  { value: 'vertices',  key: 'a', label: 'Vertices',  title: 'Drag a box around vertices, then drag one to move them together or press Del. Shift adds to the selection (A)' },
  { value: 'polygon',  key: 'p', label: 'Polygon',   title: 'Click to add points. Enter, double-click or the first point finishes (P)' },
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
let selection    = [];     // [{ frame, idx, vertices }] — vertices is a Set with the Vertices tool, else null
let clipboard    = null;   // copied shapes, in one shared coordinate space. Survives changing street.
let pointer      = null;   // last pointer position over the road, in client coordinates
let draft        = null;   // { type, frame, points, cursor }
let drag         = null;   // press in progress: 'move', 'marquee' or 'rectangle'
let marqueeEl    = null;
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
      <button class="btn btn-ghost btn-sm" id="rdv-rename" title="Rename every label of this class on this street. Choosing an existing name merges the two.">Rename class</button>
      <button class="btn btn-ghost btn-sm" id="rdv-delete" title="Delete the selection (Del)">Delete</button>
      <button class="btn btn-ghost btn-sm" id="rdv-cut" title="Cut the selected labels (Ctrl+X)">Cut</button>
      <button class="btn btn-ghost btn-sm" id="rdv-copy" title="Copy the selected labels (Ctrl+C)">Copy</button>
      <button class="btn btn-ghost btn-sm" id="rdv-paste" title="Paste at the cursor, or mid-view from this button. Works on other frames and streets (Ctrl+V)">Paste</button>
      <button class="btn btn-ghost btn-sm" id="rdv-undo" title="Undo (Ctrl+Z)">Undo</button>
      <button class="btn btn-ghost btn-sm" id="rdv-redo" title="Redo (Ctrl+Y)">Redo</button>
      <span id="rdv-selinfo" class="rdv-selinfo"></span>
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
  bar.querySelector('#rdv-rename').addEventListener('click', renameClass);
  bar.querySelector('#rdv-delete').addEventListener('click', deleteSelection);
  bar.querySelector('#rdv-cut').addEventListener('click', cutSelection);
  bar.querySelector('#rdv-copy').addEventListener('click', copySelection);
  bar.querySelector('#rdv-paste').addEventListener('click', paste);
  bar.querySelector('#rdv-undo').addEventListener('click', undo);
  bar.querySelector('#rdv-redo').addEventListener('click', redo);
  bar.querySelector('#rdv-save').addEventListener('click', () => save());
  bar.querySelector('#rdv-discard').addEventListener('click', discard);

  road.addEventListener('pointerdown', onPointerDown);
  road.addEventListener('pointermove', onPointerMove);
  road.addEventListener('click', onClick);
  road.addEventListener('dblclick', onDoubleClick);
  road.addEventListener('contextmenu', onContextMenu);
  road.addEventListener('pointerleave', () => { if (!drag) pointer = null; });
  road.addEventListener('scroll', syncToPointer);
  // The browser would otherwise start dragging the frame's picture and take over the pointer
  road.addEventListener('dragstart', (e) => { if (editing) e.preventDefault(); });
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
  selection = [];
  draft     = null;
  drag      = null;
  removeMarquee();
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
  if (!editing) setSelection([]);
  updateBar();
  if (tool === 'vertices') renderAllFrames();
}

function setTool(next) {
  const changed = next !== tool;
  const handlesChange = changed && (tool === 'vertices' || next === 'vertices');
  tool = next;
  cancelDraft();
  if (changed) setSelection([]);
  updateBar();
  if (handlesChange) renderAllFrames();
}

function isSelectTool() {
  return tool === 'select' || tool === 'vertices';
}

function renderAllFrames() {
  ctx.frames().forEach(f => ctx.renderFrameShapes(f));
}

function selectionSummary() {
  if (!selection.length) return '';
  if (tool === 'vertices') {
    const n = selection.reduce((sum, s) => sum + s.vertices.size, 0);
    return `${n} ${n === 1 ? 'vertex' : 'vertices'} selected`;
  }
  return `${selection.length} label${selection.length === 1 ? '' : 's'} selected`;
}

function updateBar() {
  if (!bar) return;
  const frames  = ctx.frames();
  const dirty   = frames.filter(f => f.dirty).length;
  const hasRoad = frames.length > 0;

  road.classList.toggle('rdv-editing', editing && hasRoad);
  road.classList.toggle('rdv-tool-draw', editing && !isSelectTool());
  road.classList.toggle('rdv-tool-vertices', editing && tool === 'vertices');
  bar.querySelectorAll('[data-edit-mode]').forEach(btn =>
    btn.classList.toggle('active', (btn.dataset.editMode === 'edit') === editing));
  bar.querySelectorAll('[data-tool]').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.tool === tool));

  bar.querySelector('#rdv-edit-tools').classList.toggle('hidden', !editing);
  bar.querySelector('#rdv-edit-actions').classList.toggle('hidden', !editing && !dirty);
  bar.querySelector('#rdv-rename').disabled = !currentClassHasLabels();
  bar.querySelector('#rdv-delete').disabled = !selection.length;
  bar.querySelector('#rdv-cut').disabled    = !selection.length;
  bar.querySelector('#rdv-copy').disabled   = !selection.length;
  bar.querySelector('#rdv-paste').disabled  = !clipboard?.length || !hasRoad;
  bar.querySelector('#rdv-selinfo').textContent = selectionSummary();
  bar.querySelector('#rdv-undo').disabled   = !undoStack.length;
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
  if (selectedLabels().size > 1) {
    // No class is current, so picking any of them still counts as a change and relabels them all
    const mixed = document.createElement('option');
    mixed.value = '';
    mixed.textContent = 'Mixed';
    mixed.hidden = true;
    select.prepend(mixed);
    select.value = '';
  } else {
    select.value = currentClass || NEW_CLASS;
  }
}

// Classes of the selected labels. The Vertices tool edits points, so it never relabels.
function selectedLabels() {
  if (tool !== 'select') return new Set();
  return new Set(selection.map(s => s.frame.shapes[s.idx]?.label));
}

function currentClassHasLabels() {
  return !!currentClass && ctx.frames().some(f => f.shapes.some(s => s.label === currentClass));
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
  if (tool === 'select' && selection.length) {
    edit(selectedFrames(), () => {
      for (const { frame, idx } of selection) frame.shapes[idx].label = name;
    });
    ctx.showClass(name);
  }
  updateBar();
}

// Renames every label of the current class on this street as one undo step. Nothing reaches Drive
// until Save, and an existing name merges the two classes.
function renameClass() {
  const from = currentClass;
  const touched = ctx.frames().filter(f => f.shapes.some(s => s.label === from));
  const total = touched.reduce((sum, f) => sum + f.shapes.filter(s => s.label === from).length, 0);
  if (!total) return;
  const to = (prompt(`Rename all ${total} "${from}" label${total === 1 ? '' : 's'} on this street to:`, from) ?? '').trim();
  if (!to || to === from) return;
  const merging = ctx.classes().some(c => c.name === to) || extraClasses.includes(to);
  edit(touched, () => {
    for (const f of touched) for (const s of f.shapes) if (s.label === from) s.label = to;
  });
  currentClass = to;
  ctx.showClass(to);
  if (tool === 'vertices') renderAllFrames();
  updateBar();
  toast(`${merging ? 'Merged' : 'Renamed'} ${total} label${total === 1 ? '' : 's'} on ${touched.length} frame${touched.length === 1 ? '' : 's'} into "${to}". Save to keep it.`, 'success', 6000);
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
  setSelection([]);
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
  setSelection([]);
  cancelDraft();
  undoStack = [];
  redoStack = [];
  for (const f of dirty) f.shapes = JSON.parse(f.savedShapes);
  afterChange(dirty);
}

// ── Selection and handles ─────────────────────────────────────────────────────

function selectedFrames() {
  return [...new Set(selection.map(s => s.frame))];
}

function isShapeVisible(shape) {
  return !ctx.isClassHidden(shape.label || '?');
}

function setSelection(next) {
  const prev = selectedFrames();
  selection = next;
  const current = selectedFrames();
  for (const f of prev) if (!current.includes(f)) f.el.classList.remove('rdv-frame-active');
  for (const f of current) f.el.classList.add('rdv-frame-active');
  new Set([...prev, ...current]).forEach(f => ctx.renderFrameShapes(f));
  const labels = selectedLabels();
  if (labels.size === 1) currentClass = [...labels][0] || currentClass;
  updateBar();
}

// Called by road-viewer.js after it redraws a frame's shapes
export function decorateFrame(f) {
  const items = selection.filter(s => s.frame === f);
  for (const { idx } of items) f.svg.querySelector(`g[data-shape-idx="${idx}"]`)?.classList.add('rdv-selected');

  if (editing && tool === 'vertices') {
    const chosen = new Map(items.map(s => [s.idx, s.vertices]));
    f.shapes.forEach((shape, idx) => {
      if (isShapeVisible(shape)) f.svg.appendChild(buildHandles(shape, idx, chosen.get(idx)));
    });
  } else if (selection.length === 1 && items.length) {
    const { idx } = items[0];
    if (f.shapes[idx]) f.svg.appendChild(buildHandles(f.shapes[idx], idx));
  }
  if (draft?.frame === f) f.svg.appendChild(buildDraft());
}

function buildHandles(shape, shapeIdx, chosen) {
  const group = document.createElementNS(SVG_NS, 'g');
  group.setAttribute('class', 'rdv-handles');
  const r = HANDLE_PX / ctx.scale();
  shape.points.forEach(([x, y], i) => {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('class', chosen?.has(i) ? 'rdv-handle rdv-handle-selected' : 'rdv-handle');
    c.setAttribute('cx', x);
    c.setAttribute('cy', y);
    c.setAttribute('r', r);
    c.setAttribute('vector-effect', 'non-scaling-stroke');
    c.dataset.shape = shapeIdx;
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
  const r = HANDLE_PX / ctx.scale();
  road.querySelectorAll('.rdv-handle').forEach(c => c.setAttribute('r', r));
  if (draft) ctx.renderFrameShapes(draft.frame);
  syncToPointer();
}

export function onOrientationChanged() {
  cancelDraft();
}

export function onClassVisibilityChanged() {
  const visible = selection.filter(s => isShapeVisible(s.frame.shapes[s.idx]));
  if (visible.length !== selection.length) setSelection(visible);
  if (tool === 'vertices') renderAllFrames();
}

// Smallest visible shape under the point, so a small label inside a big polygon stays clickable.
// The Vertices tool's CSS makes shape bodies ignore the pointer, so only its handles can be hit.
function hitTest(cx, cy) {
  let best = null;
  for (const el of document.elementsFromPoint(cx, cy)) {
    if (el.classList.contains('rdv-handle')) {
      return { handle: { frame: frameAt(el), idx: Number(el.dataset.shape), vertex: Number(el.dataset.vertex) } };
    }
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
  if (!selection.length) return;
  if (tool === 'vertices') deleteVertices();
  else deleteShapes();
}

function deleteShapes() {
  const items = [...selection].sort((a, b) => b.idx - a.idx);   // later shapes first, so indexes hold
  const frames = selectedFrames();
  setSelection([]);
  edit(frames, () => {
    for (const { frame, idx } of items) frame.shapes.splice(idx, 1);
  });
}

function minimumPoints(shape) {
  const type = shape.shape_type || 'polygon';
  if (type === 'polygon') return 3;
  if (type === 'linestrip' || type === 'line') return 2;
  return type === 'rectangle' || type === 'circle' ? Infinity : 1;
}

// A shape with every vertex selected goes entirely. One left with too few points stays as it was,
// because deleting a whole label from a partial selection would be a surprise.
function deleteVertices() {
  const items = [...selection].sort((a, b) => b.idx - a.idx);
  const frames = selectedFrames();
  let kept = 0;
  setSelection([]);
  edit(frames, () => {
    for (const { frame, idx, vertices } of items) {
      const shape = frame.shapes[idx];
      if (vertices.size >= shape.points.length) frame.shapes.splice(idx, 1);
      else if (shape.points.length - vertices.size >= minimumPoints(shape)) shape.points = shape.points.filter((_, i) => !vertices.has(i));
      else kept++;
    }
  });
  if (kept) toast(`Kept ${kept} label${kept === 1 ? '' : 's'} that would have had too few points`, 'info');
}

// ── Copy and paste ────────────────────────────────────────────────────────────

// Where (x, y) in `anchor` lands in each frame: add the returned offset. Measured together, so a
// large paste or a long drawing reads the layout once.
function frameOffsets(anchor) {
  const origin = frameToClient(anchor, [0, 0]);
  return ctx.frames().map(f => {
    const [ox, oy] = clientToFrame(f, ...origin);
    return { frame: f, ox, oy };
  });
}

function copySelection() {
  if (!selection.length) return;
  const offsets = new Map(frameOffsets(selection[0].frame).map(o => [o.frame, o]));
  // Back from each frame to the first selected one, keeping labels from several frames in position
  clipboard = selection.map(({ frame, idx }) => {
    const { ox, oy } = offsets.get(frame);
    const shape = structuredClone(frame.shapes[idx]);
    shape.points = shape.points.map(([x, y]) => [x - ox, y - oy]);
    return shape;
  });
  updateBar();
  toast(`Copied ${clipboard.length} label${clipboard.length === 1 ? '' : 's'}`, 'info', 2000);
}

function cutSelection() {
  if (!selection.length) return;
  copySelection();
  deleteShapes();   // the whole labels, as copied, even when the selection was only some vertices
}

function pasteTarget() {
  const r = road.getBoundingClientRect();
  const inRoad = pointer && pointer.x >= r.left && pointer.x <= r.right && pointer.y >= r.top && pointer.y <= r.bottom;
  const cx = inRoad ? pointer.x : r.left + road.clientWidth / 2;
  const cy = inRoad ? pointer.y : r.top + road.clientHeight / 2;
  let best = null;
  for (const f of ctx.frames()) {
    const b = f.el.getBoundingClientRect();
    const dist = Math.hypot(cx - clamp(cx, b.left, b.right), cy - clamp(cy, b.top, b.bottom));
    if (!best || dist < best.dist) best = { frame: f, dist };
  }
  return { frame: best.frame, point: clientToFrame(best.frame, cx, cy) };
}

const CLIP_TYPES = { polygon: 'polygon', rectangle: 'rectangle', linestrip: 'linestrip', line: 'linestrip' };

// Lands one shape on the road: cut at seams when its type allows it, otherwise whole on the frame
// holding its centre (a circle or point has no sensible half, and a mask is tied to its box).
function placeShape(shape, points, offsets) {
  const clipType = CLIP_TYPES[shape.shape_type || 'polygon'];
  const placed = [];
  if (clipType) {
    for (const { frame, ox, oy } of offsets) {
      const local = points.map(([x, y]) => [x + ox, y + oy]);
      const ys = local.map(p => p[1]);
      if (Math.max(...ys) < 0 || Math.min(...ys) > frame.h) continue;
      for (const pts of clipShapeToFrame(clipType, local, frame.w, frame.h)) placed.push({ frame, pts });
    }
    return placed;
  }
  const cy = points.reduce((sum, p) => sum + p[1], 0) / points.length;
  const home = offsets.find(o => cy + o.oy >= 0 && cy + o.oy <= o.frame.h);
  if (!home) return placed;
  const local = points.map(([x, y]) => [x + home.ox, y + home.oy]);
  const { frame } = home;
  const sx = fitShift(Math.min(...local.map(p => p[0])), Math.max(...local.map(p => p[0])), 0, frame.w);
  const sy = fitShift(Math.min(...local.map(p => p[1])), Math.max(...local.map(p => p[1])), 0, frame.h);
  placed.push({ frame, pts: local.map(([x, y]) => roundPoint([x + sx, y + sy])) });
  return placed;
}

function dropLockedPieces(pieces) {
  const usable = pieces.filter(p => !p.frame.labelLoadFailed);
  if (usable.length < pieces.length) {
    toast('Skipped the part of the label on a locked frame (its label file failed to load)', 'error', 6000);
  }
  return usable;
}

// Centres the copied group on the cursor, shifted as needed so it stays across the frame's width
// and within the road's two ends. Pieces then land frame by frame, as a drawing across seams does.
function paste() {
  if (!clipboard?.length) return;
  const frames = ctx.frames();
  if (!frames.length || drag) return;
  const { frame: target, point } = pasteTarget();
  setTool('select');

  const offsets = frameOffsets(target);
  const roadTop = -offsets[0].oy;
  const roadBottom = frames[frames.length - 1].h - offsets[offsets.length - 1].oy;
  const all = clipboard.flatMap(s => s.points);
  const xs = all.map(p => p[0]);
  const ys = all.map(p => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  let dx = point[0] - (x0 + x1) / 2;
  let dy = point[1] - (y0 + y1) / 2;
  dx += fitShift(x0 + dx, x1 + dx, 0, target.w);
  dy += fitShift(y0 + dy, y1 + dy, roadTop, roadBottom);

  const pieces = dropLockedPieces(clipboard.flatMap(shape =>
    placeShape(shape, shape.points.map(([x, y]) => [x + dx, y + dy]), offsets).map(p => ({ ...p, shape }))));
  if (!pieces.length) {
    toast('Nothing to paste there', 'info');
    return;
  }

  const added = [];
  edit([...new Set(pieces.map(p => p.frame))], () => {
    for (const { frame, pts, shape } of pieces) {
      added.push({ frame, idx: frame.shapes.length, vertices: null });
      frame.shapes.push({ ...structuredClone(shape), points: pts });
    }
  });
  new Set(pieces.map(p => p.shape.label)).forEach(name => ctx.showClass(name));
  setSelection(added);
}

// ── Pointer handling ──────────────────────────────────────────────────────────

function onPointerDown(e) {
  if (!editing || e.button !== 0 || onScrollbar(e)) return;
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  pointer = { x: e.clientX, y: e.clientY };

  if (tool === 'vertices') { pressWithVerticesTool(e); return; }
  if (tool === 'select')   { pressWithSelectTool(e); return; }

  if (tool === 'rectangle') {
    const frame = frameAt(e.target);
    if (!frame || !ensureDrawable(frame)) return;
    const start = clientToFrame(frame, e.clientX, e.clientY);
    beginDraft('rectangle', frame, [start]);
    road.setPointerCapture(e.pointerId);
    drag = { kind: 'rectangle' };
  }
}

function pressWithSelectTool(e) {
  const additive = e.shiftKey || e.ctrlKey || e.metaKey;
  const hit = hitTest(e.clientX, e.clientY);
  if (hit?.handle) {
    const { frame, idx, vertex } = hit.handle;
    startMove(e, [{ frame, idx, vertices: new Set([vertex]) }]);
  } else if (additive) {
    startMarquee(e, true, hit);   // a click toggles the label under it, a drag draws a box
  } else if (hit) {
    const member = selection.some(s => s.frame === hit.frame && s.idx === hit.idx);
    if (!member) setSelection([{ frame: hit.frame, idx: hit.idx, vertices: null }]);
    startMove(e, selection);
    // Pressing one of several keeps them all for a drag. Releasing without one picks just that label.
    if (member && selection.length > 1) drag.collapseTo = { frame: hit.frame, idx: hit.idx, vertices: null };
  } else {
    startMarquee(e, false);
  }
}

function pressWithVerticesTool(e) {
  const additive = e.shiftKey || e.ctrlKey || e.metaKey;
  const handle = hitTest(e.clientX, e.clientY)?.handle;
  if (!handle) { startMarquee(e, additive); return; }
  const isChosen = selection.some(s => s.frame === handle.frame && s.idx === handle.idx && s.vertices.has(handle.vertex));
  if (additive) {
    toggleVertex(handle);
  } else {
    if (!isChosen) setSelection([{ frame: handle.frame, idx: handle.idx, vertices: new Set([handle.vertex]) }]);
    startMove(e, selection);
  }
}

function toggleVertex({ frame, idx, vertex }) {
  const item = selection.find(s => s.frame === frame && s.idx === idx);
  if (!item) { setSelection([...selection, { frame, idx, vertices: new Set([vertex]) }]); return; }
  const vertices = new Set(item.vertices);
  if (!vertices.delete(vertex)) vertices.add(vertex);
  setSelection(selection
    .map(s => (s === item ? { ...s, vertices } : s))
    .filter(s => s.vertices.size));
}

// Items with vertices: null move whole. Everything moves as one, stopping at the first frame edge
// any moving point reaches, so the group keeps its shape and pieces joined at a seam stay joined.
function startMove(e, items) {
  const anchor = items[0].frame;
  const frames = [...new Set(items.map(s => s.frame))];
  const moves = items.map(({ frame, idx, vertices }) => {
    const shape = frame.shapes[idx];
    const moved = new Set(vertices ?? shape.points.keys());
    if (shape.shape_type === 'circle' && moved.has(0)) moved.add(1);   // its centre carries the rim
    return { frame, shape, moved, start: shape.points.map(p => [...p]) };
  });
  let limits = { minDx: -Infinity, maxDx: Infinity, minDy: -Infinity, maxDy: Infinity };
  for (const f of frames) {
    const pts = moves.filter(m => m.frame === f).flatMap(m => m.start.filter((_, i) => m.moved.has(i)));
    limits = intersectLimits(limits, moveLimits(pts, f.w, f.h));
  }
  drag = {
    kind: 'move',
    anchor,
    frames,
    moves,
    limits,
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    started: false,
    before: frames.map(f => JSON.stringify(f.shapes)),
    startFrame: clientToFrame(anchor, e.clientX, e.clientY),
    collapseTo: null,
  };
}

function startMarquee(e, additive, clickHit = null) {
  if (!additive && selection.length) setSelection([]);
  drag = {
    kind: 'marquee',
    additive,
    clickHit,
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    originX: e.clientX + road.scrollLeft,   // stays on the same spot of the road while it scrolls
    originY: e.clientY + road.scrollTop,
    x: e.clientX,
    y: e.clientY,
    started: false,
  };
}

// A drag stops at the road's edge, so it can't reach frames scrolled out of view
function clampToRoad(cx, cy) {
  const r = road.getBoundingClientRect();
  return [clamp(cx, r.left, r.left + road.clientWidth), clamp(cy, r.top, r.top + road.clientHeight)];
}

function onPointerMove(e) {
  pointer = { x: e.clientX, y: e.clientY };
  if (editing) followPointer(e.clientX, e.clientY);
}

// The road moved under a still pointer, by scrolling or zooming: bring anything attached back to it
function syncToPointer() {
  if (editing && pointer && (drag || draft)) followPointer(pointer.x, pointer.y);
}

function followPointer(cx, cy) {
  if (drag?.kind === 'rectangle') {
    draft.cursor = clientToFrame(draft.frame, ...clampToRoad(cx, cy));
    ctx.renderFrameShapes(draft.frame);
  } else if (drag?.kind === 'marquee') {
    [drag.x, drag.y] = clampToRoad(cx, cy);
    if (!beginDragOnce(cx, cy)) return;
    drawMarquee();
  } else if (drag) {
    if (!beginDragOnce(cx, cy)) return;
    applyMove(clientToFrame(drag.anchor, cx, cy));
    drag.frames.forEach(f => ctx.renderFrameShapes(f));
  } else if (draft) {
    draft.cursor = clientToFrame(draft.frame, cx, cy);
    ctx.renderFrameShapes(draft.frame);
  }
}

function beginDragOnce(cx, cy) {
  if (drag.started) return true;
  if (Math.hypot(cx - drag.startX, cy - drag.startY) < DRAG_PX) return false;
  drag.started = true;
  road.setPointerCapture(drag.pointerId);
  return true;
}

// Moves by how far the pointer has travelled, so a handle grabbed off-centre doesn't jump to it
function applyMove(p) {
  const { limits, moves, startFrame } = drag;
  const dx = clamp(p[0] - startFrame[0], limits.minDx, limits.maxDx);
  const dy = clamp(p[1] - startFrame[1], limits.minDy, limits.maxDy);
  for (const { shape, moved, start } of moves) {
    shape.points = start.map((pt, i) => (moved.has(i) ? roundPoint([pt[0] + dx, pt[1] + dy]) : pt));
  }
}

function marqueeRect() {
  const x0 = drag.originX - road.scrollLeft;
  const y0 = drag.originY - road.scrollTop;
  return { left: Math.min(x0, drag.x), right: Math.max(x0, drag.x), top: Math.min(y0, drag.y), bottom: Math.max(y0, drag.y) };
}

function drawMarquee() {
  if (!marqueeEl) {
    marqueeEl = document.createElement('div');
    marqueeEl.className = 'rdv-marquee';
    document.body.appendChild(marqueeEl);
  }
  // The start may have scrolled out of view, so only the part over the road is drawn
  const rect = marqueeRect();
  const [left, top] = clampToRoad(rect.left, rect.top);
  const [right, bottom] = clampToRoad(rect.right, rect.bottom);
  Object.assign(marqueeEl.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
}

function removeMarquee() {
  marqueeEl?.remove();
  marqueeEl = null;
}

// Labels must be wholly inside the box, so a box can pick small labels sitting on a big polygon.
// Vertices just need to be inside. Hidden classes are never picked.
function finishMarquee(current) {
  const rect = current.rect;
  const found = [];
  for (const f of ctx.frames()) {
    if (!f.shapes.length) continue;
    const b = f.el.getBoundingClientRect();
    if (b.right < rect.left || b.left > rect.right || b.bottom < rect.top || b.top > rect.bottom) continue;
    const a = clientToFrame(f, rect.left, rect.top);
    const c = clientToFrame(f, rect.right, rect.bottom);
    const box = { x0: Math.min(a[0], c[0]), x1: Math.max(a[0], c[0]), y0: Math.min(a[1], c[1]), y1: Math.max(a[1], c[1]) };
    f.shapes.forEach((shape, idx) => {
      if (!isShapeVisible(shape)) return;
      if (tool === 'vertices') {
        const vertices = new Set(shape.points.flatMap((p, i) => (pointInBox(p, box) ? [i] : [])));
        if (vertices.size) found.push({ frame: f, idx, vertices });
      } else if (shapeInBox(shape, box)) {
        found.push({ frame: f, idx, vertices: null });
      }
    });
  }
  if (!current.additive) { setSelection(found); return; }
  const merged = selection.map(s => ({ ...s }));
  for (const item of found) {
    const existing = merged.find(s => s.frame === item.frame && s.idx === item.idx);
    if (!existing) merged.push(item);
    else if (item.vertices) existing.vertices = new Set([...existing.vertices, ...item.vertices]);
  }
  setSelection(merged);
}

function onPointerUp(e) {
  if (!drag) return;
  pointer = { x: e.clientX, y: e.clientY };
  const current = drag;
  if (current.kind === 'marquee') {
    if (current.started) current.rect = marqueeRect();
    drag = null;
    removeMarquee();
    if (current.started) finishMarquee(current);
    else if (current.clickHit) toggleLabel(current.clickHit);
    return;
  }
  drag = null;
  if (current.kind === 'rectangle') {
    if (road.hasPointerCapture(e.pointerId)) road.releasePointerCapture(e.pointerId);
    draft.points.push(clientToFrame(draft.frame, ...clampToRoad(e.clientX, e.clientY)));
    finishDraft();
    return;
  }
  if (current.started) recordStep(current.frames, current.before);
  else if (current.collapseTo) setSelection([current.collapseTo]);
}

function toggleLabel({ frame, idx }) {
  const rest = selection.filter(s => s.frame !== frame || s.idx !== idx);
  setSelection(rest.length < selection.length ? rest : [...selection, { frame, idx, vertices: null }]);
}

function onPointerCancel() {
  if (!drag) return;
  const current = drag;
  drag = null;
  if (current.kind === 'marquee') { removeMarquee(); return; }
  if (current.kind === 'rectangle') { cancelDraft(); return; }
  if (current.started) {
    current.frames.forEach((f, i) => {
      f.shapes = JSON.parse(current.before[i]);
      ctx.renderFrameShapes(f);
    });
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

// The Select tool adds to its one selected label. The Vertices tool has no selected label to go on,
// so it uses whichever visible label on this frame has the nearest edge.
function onDoubleClick(e) {
  if (!editing || !isSelectTool()) return;
  if (hitTest(e.clientX, e.clientY)?.handle) return;
  const frame = tool === 'vertices' ? frameAt(e.target) : selection.length === 1 ? selection[0].frame : null;
  if (!frame) return;
  const candidates = tool === 'vertices' ? frame.shapes.filter(isShapeVisible) : [frame.shapes[selection[0].idx]];
  const p = clientToFrame(frame, e.clientX, e.clientY);
  let best = null;
  for (const shape of candidates) {
    const type = shape.shape_type || 'polygon';
    if (type !== 'polygon' && type !== 'linestrip' && type !== 'line') continue;
    const near = nearestEdge(shape.points, p, type === 'polygon');
    if (near && (!best || near.dist < best.near.dist)) best = { shape, type, near };
  }
  if (!best || best.near.dist * ctx.scale() > EDGE_PX) return;
  const { shape, type, near } = best;
  if (tool === 'vertices') setSelection([]);   // vertex numbers are about to shift
  edit([frame], () => {
    shape.points.splice(near.index + 1, 0, roundPoint([clamp(near.point[0], 0, frame.w), clamp(near.point[1], 0, frame.h)]));
    if (type === 'line') shape.shape_type = 'linestrip';   // a "line" only ever has two points
  });
}

function onContextMenu(e) {
  if (!editing || !e.target.classList?.contains('rdv-handle')) return;
  e.preventDefault();
  const frame = frameAt(e.target);
  const shape = frame.shapes[Number(e.target.dataset.shape)];
  const type = shape.shape_type || 'polygon';
  const minimum = minimumPoints(shape);
  if (shape.points.length <= minimum) {
    toast(minimum === Infinity ? 'This label has a fixed number of points' : `A ${type} needs at least ${minimum} points`, 'info');
    return;
  }
  const vertex = Number(e.target.dataset.vertex);
  if (tool === 'vertices') setSelection([]);   // vertex numbers are about to shift
  edit([frame], () => { shape.points.splice(vertex, 1); });
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
  if (!selectedFrames().includes(frame)) frame.el.classList.remove('rdv-frame-active');
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

  const pieces = placeShape({ shape_type: type }, points, frameOffsets(anchor));

  cancelDraft();

  const usable = dropLockedPieces(pieces);
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
  if (drag && drag.kind !== 'rectangle') return;   // shapes are mid-drag and still selected
  const key = e.key.toLowerCase();

  if (e.ctrlKey || e.metaKey) {
    const action = key === 'z' ? (e.shiftKey ? redo : undo)
      : key === 'y' ? redo
      : key === 's' ? () => save()
      : key === 'c' && selection.length ? copySelection
      : key === 'x' && selection.length ? cutSelection
      : key === 'v' && clipboard?.length ? paste
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
    if (selection.length) { e.preventDefault(); deleteSelection(); }
    return;
  } else if (e.key === 'Escape') {
    setSelection([]);
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
  const fresh = touched.filter(f => !warnedFrames.has(f) && isReviewed(f, street));
  if (!fresh.length) return;
  fresh.forEach(f => warnedFrames.add(f));
  // A rename or a big paste can touch many frames at once, so this stays one message
  const subject = fresh.length === 1 ? `${labelFileName(fresh[0])} already has a review decision. It stays` : `${fresh.length} of these frames already have review decisions. They stay`;
  toast(`${subject} as ${fresh.length === 1 ? 'it is, so it' : 'they are, so they'} may need another look.`, 'info', 6000);
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
