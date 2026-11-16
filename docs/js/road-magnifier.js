// Road Viewer magnifier: a round loupe beside the cursor showing the road under it enlarged, labels
// and edits included, for placing points precisely. It shows copies of the frames under the cursor,
// kept up to date by watching the road for changes, so it needs no hooks in the drawing code.

const SIZE = 220;   // loupe diameter, px
const GAP  = 24;    // space between the cursor and the loupe, so the spot being worked on stays in view

let road     = null;
let loupe    = null;
let view     = null;   // holds the copies; its origin is the loupe's centre, which shows the cursor's spot
let ctx      = null;   // { frames(), scale() }
let enabled  = false;
let power    = 3;
let pointer  = null;   // last cursor position over the road, in client px
let pending  = 0;      // requestAnimationFrame id
let watcher  = null;
const copies = new Map();   // frame element -> { el, img, dirty }

export function initMagnifier(roadEl, context) {
  road = roadEl;
  ctx = context;
  loupe = document.createElement('div');
  loupe.className = 'rdv-loupe';
  loupe.setAttribute('aria-hidden', 'true');
  view = document.createElement('div');
  view.className = 'rdv-loupe-view';
  loupe.appendChild(view);
  document.body.appendChild(loupe);

  road.addEventListener('pointermove', (e) => {
    pointer = e.pointerType === 'touch' ? null : { x: e.clientX, y: e.clientY };
    schedule();
  });
  road.addEventListener('pointerleave', () => { pointer = null; schedule(); });
  road.addEventListener('scroll', schedule);
  watcher = new MutationObserver(onRoadChanged);
}

export function setMagnifier(on) {
  enabled = on;
  if (on) {
    watcher.observe(road, { subtree: true, childList: true, attributes: true });
  } else {
    watcher.disconnect();
    copies.clear();
    view.replaceChildren();
  }
  schedule();
}

export function setMagnifierPower(value) {
  power = value;
  for (const copy of copies.values()) copy.dirty = true;   // handle sizes depend on the power
  schedule();
}

function schedule() {
  if (!pending) pending = requestAnimationFrame(update);
}

// Marks the copy of whichever frame changed. A change to the road itself (a new street, a mode
// class) marks them all.
function onRoadChanged(records) {
  for (const { target } of records) {
    const node = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
    const frameEl = node && node !== road ? node.closest('.rdv-frame') : null;
    if (frameEl) {
      const copy = copies.get(frameEl);
      if (copy) copy.dirty = true;
    } else {
      for (const copy of copies.values()) copy.dirty = true;
    }
  }
  schedule();
}

function hide() {
  loupe.style.display = 'none';
}

function update() {
  pending = 0;
  if (!enabled || !pointer || !road.getClientRects().length) return hide();
  const { x, y } = pointer;
  const bounds = road.getBoundingClientRect();
  if (x < bounds.left || x >= bounds.right || y < bounds.top || y >= bounds.bottom) return hide();

  // Frames overlapping the patch of road the loupe shows
  const reach = SIZE / 2 / power;
  const shown = [];
  for (const f of ctx.frames()) {
    if (!f.el) continue;
    const r = f.el.getBoundingClientRect();
    if (r.right > x - reach && r.left < x + reach && r.bottom > y - reach && r.top < y + reach) shown.push([f.el, r]);
  }
  if (!shown.length) return hide();

  const keep = new Set();
  for (const [frameEl, r] of shown) {
    let copy = copies.get(frameEl);
    if (!copy || copy.dirty) copy = copyFrame(frameEl, copy);
    copy.el.style.left = `${r.left - x}px`;
    copy.el.style.top  = `${r.top - y}px`;
    keep.add(copy.el);
  }
  for (const [frameEl, copy] of copies) {
    if (!keep.has(copy.el)) copies.delete(frameEl);
  }
  view.replaceChildren(...keep);
  view.style.transform = `scale(${power})`;
  loupe.style.setProperty('--m', power);
  // Show the picture's real pixels once each one is at least 2px across
  loupe.classList.toggle('rdv-loupe-pixels', ctx.scale() * power >= 2);

  // Below-right of the cursor, flipped to stay inside the window
  let left = x + GAP;
  let top  = y + GAP;
  if (left + SIZE > window.innerWidth  - 4) left = x - GAP - SIZE;
  if (top  + SIZE > window.innerHeight - 4) top  = y - GAP - SIZE;
  loupe.style.transform = `translate(${left}px, ${top}px)`;
  loupe.style.display = 'block';
}

// A fresh copy of the frame. The previous copy's picture is moved across when it's the same one,
// so the loupe doesn't flash while a new copy of the image decodes.
function copyFrame(frameEl, old) {
  const el = frameEl.cloneNode(true);
  el.querySelectorAll('.rdv-section, .rdv-locked-note').forEach(n => n.remove());
  // Handles keep their on-screen size, like on the road
  el.querySelectorAll('.rdv-handle, .rdv-draft-point').forEach(c => c.setAttribute('r', Number(c.getAttribute('r')) / power));
  let img = el.querySelector('img');
  if (old?.img && img && old.img.getAttribute('src') === img.getAttribute('src')) {
    img.replaceWith(old.img);
    img = old.img;
  }
  const copy = { el, img, dirty: false };
  copies.set(frameEl, copy);
  return copy;
}
