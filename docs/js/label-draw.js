// Shared label-class colors and shape rendering for LabelMe annotations.
// Used by the Review Annotations and Road Viewer tabs so classes look the same in both.

const COLOR_STORAGE_KEY = 'pavement_review_colors';
// Bright pastels — readable on dark imagery (asphalt) and the app's dark UI
const SHAPE_COLORS = ['#4ec9b0','#dcdcaa','#9cdcfe','#c586c0','#ce9178','#4fc1ff','#b5cea8'];
// Deep, saturated counterparts at the same indices — readable on light imagery (concrete, sun glare)
const SHAPE_COLORS_LIGHT_BG = ['#007a5e','#8a6a00','#0b4f9c','#86198f','#b3400a','#0055a5','#3f6b12'];
const SVG_NS = 'http://www.w3.org/2000/svg';

export const colorOverrides = {}; // className → hex color string

function classHash(label) {
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0;
  return h;
}

// mode: 'dark' (colors for dark backgrounds, the default) or 'light' (colors for light backgrounds)
export function classColor(label, mode = 'dark') {
  const override = colorOverrides[label];
  if (mode === 'light') return override ? darken(override, 0.45) : SHAPE_COLORS_LIGHT_BG[classHash(label) % SHAPE_COLORS_LIGHT_BG.length];
  return override || SHAPE_COLORS[classHash(label) % SHAPE_COLORS.length];
}

// Outline drawn under each shape so it stays visible against any part of the image
export function haloColor(mode = 'dark') {
  return mode === 'light' ? '#ffffff' : '#000000';
}

function darken(hex, amount) {
  const n = parseInt(hex.slice(1, 7), 16);
  const ch = (shift) => Math.round(((n >> shift) & 255) * (1 - amount)).toString(16).padStart(2, '0');
  return `#${ch(16)}${ch(8)}${ch(0)}`;
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

// Builds an SVG element for one LabelMe shape's geometry, in image-pixel coordinates.
// Colors are left to the caller (stylesheet); dataset.kind is 'line' or 'area' so it
// knows whether to fill.
export function shapeToSvg(shape) {
  const pts = shape.points || [];
  if (!pts.length) return null;
  const type = shape.shape_type || 'polygon';
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

  el.dataset.kind = el.tagName === 'polyline' ? 'line' : 'area';
  el.setAttribute('vector-effect', 'non-scaling-stroke');
  return el;
}
