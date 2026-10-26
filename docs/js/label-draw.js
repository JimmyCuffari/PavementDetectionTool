// Shared label-class colors and shape rendering for LabelMe annotations.
// Used by the Review Annotations and Road Viewer tabs so classes look the same in both.

const COLOR_STORAGE_KEY = 'pavement_review_colors';
const SHAPE_COLORS = ['#4ec9b0','#dcdcaa','#9cdcfe','#c586c0','#ce9178','#4fc1ff','#b5cea8'];
const SVG_NS = 'http://www.w3.org/2000/svg';

export const colorOverrides = {}; // className → hex color string

export function classColor(label) {
  if (colorOverrides[label]) return colorOverrides[label];
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0;
  return SHAPE_COLORS[h % SHAPE_COLORS.length];
}

export function saveColorOverrides() {
  try { localStorage.setItem(COLOR_STORAGE_KEY, JSON.stringify(colorOverrides)); } catch { /* quota */ }
}

export function loadColorOverrides() {
  try {
    const saved = localStorage.getItem(COLOR_STORAGE_KEY);
    if (saved) Object.assign(colorOverrides, JSON.parse(saved));
  } catch { /* ignore */ }
}

// Builds an SVG element for one LabelMe shape, in image-pixel coordinates.
// Styling matches the reviewer's canvas drawShape (solid stroke, 25% fill).
export function shapeToSvg(shape) {
  const pts = shape.points || [];
  if (!pts.length) return null;
  const color = classColor(shape.label || '?');
  const type  = shape.shape_type || 'polygon';
  let el;

  if (type === 'rectangle' && pts.length >= 2) {
    const [[x1, y1], [x2, y2]] = pts;
    el = document.createElementNS(SVG_NS, 'rect');
    el.setAttribute('x', Math.min(x1, x2));
    el.setAttribute('y', Math.min(y1, y2));
    el.setAttribute('width',  Math.abs(x2 - x1));
    el.setAttribute('height', Math.abs(y2 - y1));
  } else if (type === 'circle' && pts.length >= 2) {
    el = document.createElementNS(SVG_NS, 'circle');
    el.setAttribute('cx', pts[0][0]);
    el.setAttribute('cy', pts[0][1]);
    el.setAttribute('r', Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]));
  } else if (type === 'point') {
    el = document.createElementNS(SVG_NS, 'circle');
    el.setAttribute('cx', pts[0][0]);
    el.setAttribute('cy', pts[0][1]);
    el.setAttribute('r', 4);
  } else {
    el = document.createElementNS(SVG_NS, type === 'line' || type === 'linestrip' ? 'polyline' : 'polygon');
    el.setAttribute('points', pts.map(([x, y]) => `${x},${y}`).join(' '));
  }

  const isLine = el.tagName === 'polyline';
  el.setAttribute('stroke', color);
  el.setAttribute('fill', isLine ? 'none' : color + '40');
  el.setAttribute('stroke-width', '2');
  el.setAttribute('vector-effect', 'non-scaling-stroke');
  return el;
}
