// Colour-based region picking for the Road Viewer's Color tool: grow a region of similar colour from
// a clicked pixel and trace it as a polygon. Pure functions on { data, width, height } RGBA buffers
// (an ImageData works), so they run in Node as well as the browser.
//
// A box is { x0, y0, x1, y1 } in whole pixels, x1/y1 exclusive. Polygon points are pixel corners in
// image coordinates, so a lone pixel at (3, 4) traces to [[3, 4], [4, 4], [4, 5], [3, 5]].

const MAX_POINTS = 150;

export function fullBox(pixels) {
  return { x0: 0, y0: 0, x1: pixels.width, y1: pixels.height };
}

// Slider 0–100 to an RGB distance (0–441). Curved, so the low end gives fine control.
export function toleranceFor(sensitivity) {
  const s = Math.min(100, Math.max(0, sensitivity)) / 100;
  return 2 + 220 * s ** 1.6;
}

// The clicked pixel averaged with those of its 8 neighbours already within tolerance of it. That
// smooths out noise without mixing in the road beside a crack only 1–3px wide.
function seedColor({ data, width }, [sx, sy], box, limit) {
  const c = (sy * width + sx) * 4;
  const sum = [0, 0, 0];
  let n = 0;
  for (let y = Math.max(box.y0, sy - 1); y <= Math.min(box.y1 - 1, sy + 1); y++) {
    for (let x = Math.max(box.x0, sx - 1); x <= Math.min(box.x1 - 1, sx + 1); x++) {
      const i = (y * width + x) * 4;
      const dr = data[i] - data[c], dg = data[i + 1] - data[c + 1], db = data[i + 2] - data[c + 2];
      if (dr * dr + dg * dg + db * db > limit) continue;
      sum[0] += data[i]; sum[1] += data[i + 1]; sum[2] += data[i + 2];
      n++;
    }
  }
  return sum.map(v => v / n);
}

// 4-connected flood fill from the seed. A pixel joins when its colour is within `tolerance` of the
// seed colour. Measuring from the seed, not from each neighbour, stops the region creeping across a
// gradual change into something else. Returns a mask the size of the image: 1 inside, 0 outside.
export function growRegion(pixels, seed, tolerance, box = fullBox(pixels)) {
  const { data, width, height } = pixels;
  const mask = new Uint8Array(width * height);
  const [sx, sy] = seed;
  if (sx < box.x0 || sx >= box.x1 || sy < box.y0 || sy >= box.y1) return mask;
  const limit = tolerance * tolerance;
  const [r, g, b] = seedColor(pixels, seed, box, limit);
  const close = (p) => {
    const i = p * 4;
    const dr = data[i] - r, dg = data[i + 1] - g, db = data[i + 2] - b;
    return dr * dr + dg * dg + db * db <= limit;
  };
  // Every pixel is pushed at most once, because it's marked when pushed
  const stack = new Int32Array((box.x1 - box.x0) * (box.y1 - box.y0));
  let top = 0;
  const start = sy * width + sx;
  mask[start] = 1;
  stack[top++] = start;
  while (top) {
    const p = stack[--top];
    const x = p % width;
    const y = (p - x) / width;
    if (x > box.x0     && !mask[p - 1]     && close(p - 1))     { mask[p - 1] = 1;     stack[top++] = p - 1; }
    if (x < box.x1 - 1 && !mask[p + 1]     && close(p + 1))     { mask[p + 1] = 1;     stack[top++] = p + 1; }
    if (y > box.y0     && !mask[p - width] && close(p - width)) { mask[p - width] = 1; stack[top++] = p - width; }
    if (y < box.y1 - 1 && !mask[p + width] && close(p + width)) { mask[p + width] = 1; stack[top++] = p + width; }
  }
  return mask;
}

// Marks enclosed gaps as inside: anything the box's border can't reach without crossing the region.
// LabelMe polygons have no holes, so the outline would ignore them anyway; this keeps area honest.
export function fillHoles(mask, width, box) {
  const outside = new Uint8Array(mask.length);
  const stack = [];
  const push = (x, y) => {
    const p = y * width + x;
    if (!mask[p] && !outside[p]) { outside[p] = 1; stack.push(p); }
  };
  for (let x = box.x0; x < box.x1; x++) { push(x, box.y0); push(x, box.y1 - 1); }
  for (let y = box.y0; y < box.y1; y++) { push(box.x0, y); push(box.x1 - 1, y); }
  while (stack.length) {
    const p = stack.pop();
    const x = p % width;
    const y = (p - x) / width;
    if (x > box.x0)     push(x - 1, y);
    if (x < box.x1 - 1) push(x + 1, y);
    if (y > box.y0)     push(x, y - 1);
    if (y < box.y1 - 1) push(x, y + 1);
  }
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      const p = y * width + x;
      if (!outside[p]) mask[p] = 1;
    }
  }
  return mask;
}

// Follows the region's outer edge along pixel borders, keeping the region on the right-hand side,
// starting from the top-left corner of its first pixel. Returns only the corners where it turns.
export function traceOutline(mask, width, box) {
  let start = null;
  for (let y = box.y0; y < box.y1 && !start; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      if (mask[y * width + x]) { start = [x, y]; break; }
    }
  }
  if (!start) return [];

  const inside = (x, y) => x >= box.x0 && x < box.x1 && y >= box.y0 && y < box.y1 && mask[y * width + x] === 1;
  // Heading east, south, west, north. For each: the pixel ahead on the left, then ahead on the right,
  // as offsets from the current corner.
  const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  const AHEAD = [
    [[0, -1], [0, 0]],
    [[0, 0], [-1, 0]],
    [[-1, 0], [-1, -1]],
    [[-1, -1], [0, -1]],
  ];
  const points = [];
  let [x, y] = start;
  let dir = 0;
  const limit = 4 * (box.x1 - box.x0 + 1) * (box.y1 - box.y0 + 1);
  for (let steps = 0; steps < limit; steps++) {
    const [[lx, ly], [rx, ry]] = AHEAD[dir];
    let next;
    if (inside(x + lx, y + ly))      next = (dir + 3) % 4;   // turn left
    else if (inside(x + rx, y + ry)) next = dir;             // straight on
    else                             next = (dir + 1) % 4;   // turn right
    if (next !== dir || steps === 0) points.push([x, y]);
    dir = next;
    x += DIRS[dir][0];
    y += DIRS[dir][1];
    if (x === start[0] && y === start[1] && dir === 3) break;   // back where it began, closing the loop
  }
  return points;
}

function distanceToSegment([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

function douglasPeucker(pts, epsilon) {
  if (pts.length < 3) return pts;
  let index = 0, furthest = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = distanceToSegment(pts[i], pts[0], pts[pts.length - 1]);
    if (d > furthest) { furthest = d; index = i; }
  }
  if (furthest <= epsilon) return [pts[0], pts[pts.length - 1]];
  const left = douglasPeucker(pts.slice(0, index + 1), epsilon);
  const right = douglasPeucker(pts.slice(index), epsilon);
  return [...left.slice(0, -1), ...right];
}

// Douglas–Peucker for a closed outline: split at the point furthest from the first, simplify both
// halves. Epsilon grows until the polygon is down to maxPoints.
export function simplify(points, epsilon = 1, maxPoints = MAX_POINTS) {
  if (points.length <= 4) return points;
  let far = 0, best = -1;
  points.forEach(([x, y], i) => {
    const d = Math.hypot(x - points[0][0], y - points[0][1]);
    if (d > best) { best = d; far = i; }
  });
  let eps = epsilon;
  for (;;) {
    const a = douglasPeucker(points.slice(0, far + 1), eps);
    const b = douglasPeucker([...points.slice(far), points[0]], eps);
    const result = [...a.slice(0, -1), ...b.slice(0, -1)];
    if (result.length <= maxPoints || eps > 1e6) return result;
    eps *= 1.5;
  }
}

// The whole Color tool step: region from the seed, holes filled, outline traced and simplified.
// Returns null when the seed is outside the box.
export function colorRegionPolygon(pixels, seed, sensitivity, box = fullBox(pixels)) {
  const [sx, sy] = seed;
  if (sx < box.x0 || sx >= box.x1 || sy < box.y0 || sy >= box.y1) return null;
  const mask = fillHoles(growRegion(pixels, seed, toleranceFor(sensitivity), box), pixels.width, box);
  let area = 0;
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) area += mask[y * pixels.width + x];
  }
  const points = simplify(traceOutline(mask, pixels.width, box));
  return { points, area, coverage: area / ((box.x1 - box.x0) * (box.y1 - box.y0)) };
}
