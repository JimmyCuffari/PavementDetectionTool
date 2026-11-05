// Pure geometry for the Road Viewer editor. No DOM, so it can be exercised directly in Node.
// Points are [x, y] in image pixels of one frame.

const MIN_POLYGON_AREA = 4;   // px² — anything smaller is a sliver left over from clipping

export function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

export function roundPoint([x, y]) {
  return [Math.round(x * 100) / 100, Math.round(y * 100) / 100];
}

function dedupe(pts, closed) {
  const out = [];
  for (const p of pts) {
    const prev = out[out.length - 1];
    if (!prev || prev[0] !== p[0] || prev[1] !== p[1]) out.push(p);
  }
  if (closed && out.length > 1) {
    const [a, b] = [out[0], out[out.length - 1]];
    if (a[0] === b[0] && a[1] === b[1]) out.pop();
  }
  return out;
}

export function polygonArea(pts) {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

// Used to pick the smallest shape under the cursor; lines and points count as zero
export function shapeArea(shape) {
  const pts = shape.points || [];
  switch (shape.shape_type || 'polygon') {
    case 'rectangle':
      return pts.length < 2 ? 0 : Math.abs((pts[1][0] - pts[0][0]) * (pts[1][1] - pts[0][1]));
    case 'circle':
      return pts.length < 2 ? 0 : Math.PI * ((pts[1][0] - pts[0][0]) ** 2 + (pts[1][1] - pts[0][1]) ** 2);
    case 'polygon':
      return polygonArea(pts);
    default:
      return 0;
  }
}

function pointAtY([x1, y1], [x2, y2], y) {
  return [x1 + (x2 - x1) * ((y - y1) / (y2 - y1)), y];
}

// One Sutherland–Hodgman pass: keeps the part of a closed polygon where keep(y) holds
function clipPolygonAtY(pts, boundary, keep) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const aIn = keep(a[1]);
    const bIn = keep(b[1]);
    if (aIn) out.push(a);
    if (aIn !== bIn) out.push(pointAtY(a, b, boundary));
  }
  return out;
}

export function clipPolygonToBand(pts, y0, y1) {
  const upper = clipPolygonAtY(pts, y0, y => y >= y0);
  return clipPolygonAtY(upper, y1, y => y <= y1);
}

// Returns the runs of an open polyline inside y0..y1 — several if it leaves and comes back
export function clipPolylineToBand(pts, y0, y1) {
  const pieces = [];
  let run = [];
  const flush = () => {
    if (run.length) pieces.push(run);
    run = [];
  };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dy = b[1] - a[1];
    let t0 = 0;
    let t1 = 1;
    if (dy === 0) {
      if (a[1] < y0 || a[1] > y1) { flush(); continue; }
    } else {
      const ta = (y0 - a[1]) / dy;
      const tb = (y1 - a[1]) / dy;
      t0 = Math.max(0, Math.min(ta, tb));
      t1 = Math.min(1, Math.max(ta, tb));
      if (t0 > t1) { flush(); continue; }
    }
    const start = t0 === 0 ? a : [a[0] + (b[0] - a[0]) * t0, a[1] + dy * t0];
    const end   = t1 === 1 ? b : [a[0] + (b[0] - a[0]) * t1, a[1] + dy * t1];
    if (t0 > 0) flush();          // re-entering: starts a new piece
    if (!run.length) run.push(start);
    run.push(end);
    if (t1 < 1) flush();          // leaving
  }
  flush();
  return pieces;
}

// Cuts a drawn shape down to one frame. `pts` are in that frame's coordinates and may run past its
// edges. Returns the point lists to store on the frame: none if nothing usable lands in it.
export function clipShapeToFrame(type, pts, w, h) {
  const clampX = ([x, y]) => [clamp(x, 0, w), y];

  if (type === 'rectangle') {
    const [[x1, y1], [x2, y2]] = pts;
    const top    = Math.max(0, Math.min(y1, y2));
    const bottom = Math.min(h, Math.max(y1, y2));
    const left   = clamp(Math.min(x1, x2), 0, w);
    const right  = clamp(Math.max(x1, x2), 0, w);
    if ((bottom - top) * (right - left) < MIN_POLYGON_AREA || bottom <= top) return [];
    return [[[left, top], [right, bottom]].map(roundPoint)];
  }

  if (type === 'polygon') {
    const clipped = dedupe(clipPolygonToBand(pts, 0, h).map(clampX).map(roundPoint), true);
    if (clipped.length < 3 || polygonArea(clipped) < MIN_POLYGON_AREA) return [];
    return [clipped];
  }

  // linestrip
  return clipPolylineToBand(pts, 0, h)
    .map(piece => dedupe(piece.map(clampX).map(roundPoint), false))
    .filter(piece => piece.length >= 2);
}

// Moves a shape by (dx, dy), reducing the move so its points stay inside the frame. A shape that
// already pokes outside may move back in, but never further out.
export function movePointsWithin(pts, dx, dy, w, h) {
  const limits = moveLimits(pts, w, h);
  const cdx = clamp(dx, limits.minDx, limits.maxDx);
  const cdy = clamp(dy, limits.minDy, limits.maxDy);
  return pts.map(([x, y]) => roundPoint([x + cdx, y + cdy]));
}

// How far a set of points may move and stay inside the frame. The ranges always include zero.
export function moveLimits(pts, w, h) {
  const xs = pts.map(p => p[0]);
  const ys = pts.map(p => p[1]);
  return {
    minDx: Math.min(0, -Math.min(...xs)),
    maxDx: Math.max(0, w - Math.max(...xs)),
    minDy: Math.min(0, -Math.min(...ys)),
    maxDy: Math.max(0, h - Math.max(...ys)),
  };
}

// Combines limits, so that things moving together stop as soon as any one of them has to
export function intersectLimits(a, b) {
  return {
    minDx: Math.max(a.minDx, b.minDx),
    maxDx: Math.min(a.maxDx, b.maxDx),
    minDy: Math.max(a.minDy, b.minDy),
    maxDy: Math.min(a.maxDy, b.maxDy),
  };
}

export function pointInBox([x, y], box) {
  return x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1;
}

// True when the whole shape is inside the box. A circle stores only its centre and one rim point,
// so its extent comes from the radius.
export function shapeInBox(shape, box) {
  const pts = shape.points || [];
  if (!pts.length) return false;
  if (shape.shape_type === 'circle' && pts.length >= 2) {
    const [[cx, cy], [rx, ry]] = pts;
    const r = Math.hypot(rx - cx, ry - cy);
    return cx - r >= box.x0 && cx + r <= box.x1 && cy - r >= box.y0 && cy + r <= box.y1;
  }
  return pts.every(p => pointInBox(p, box));
}

// Shift that brings the span lo..hi inside min..max. A span too big to fit is centred instead.
export function fitShift(lo, hi, min, max) {
  if (hi - lo > max - min) return (min + max) / 2 - (lo + hi) / 2;
  if (lo < min) return min - lo;
  if (hi > max) return max - hi;
  return 0;
}

// Closest edge to p. Returns { index, dist, point } where a new vertex at `point` goes at index + 1.
export function nearestEdge(pts, p, closed) {
  let best = null;
  const count = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < count; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 ? clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2, 0, 1) : 0;
    const point = [a[0] + dx * t, a[1] + dy * t];
    const dist = Math.hypot(p[0] - point[0], p[1] - point[1]);
    if (!best || dist < best.dist) best = { index: i, dist, point };
  }
  return best;
}
