// Progress report calculations: who created or last edited which label files, grouped into weeks or
// months, and frame names turned into start–end ranges. Pure functions, so they run in Node too.

const UPLOAD_GRACE_MS = 2 * 60 * 1000;   // an upload sets modifiedTime a moment after createdTime

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Start of the week (Monday 00:00, local time) or month containing `date`
export function bucketStart(date, unit) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  if (unit === 'month') d.setDate(1);
  else d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

// Local-date key for a bucket start, e.g. '2026-11-23'
export function bucketKey(start) {
  const pad = n => String(n).padStart(2, '0');
  return `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
}

export function bucketLabel(start, unit) {
  return unit === 'month'
    ? `${MONTHS[start.getMonth()]} ${start.getFullYear()}`
    : `${MONTHS[start.getMonth()]} ${start.getDate()}`;
}

// The last `count` buckets up to and including the one containing `now`, oldest first
export function buckets(count, unit, now = new Date()) {
  const out = [];
  let start = bucketStart(now, unit);
  for (let i = 0; i < count; i++) {
    out.unshift(start);
    const prev = new Date(start);
    if (unit === 'month') prev.setMonth(prev.getMonth() - 1);
    else prev.setDate(prev.getDate() - 7);
    start = bucketStart(prev, unit);   // re-normalised, so a daylight-saving change can't drift it
  }
  return out;
}

function person(user) {
  if (!user?.emailAddress) return null;
  return { email: user.emailAddress.toLowerCase(), name: user.displayName || user.emailAddress };
}

// A label file's activity: a 'new' event for whoever created it, and an 'edited' event for whoever
// changed it last. The edit is left out when it's really the upload itself (within a couple of
// minutes of creation), or when the creator changed it again in the same period, so a frame
// counts once per person per period.
// file: { name, createdTime, modifiedTime, owners, lastModifyingUser }
export function fileEvents(file, unit) {
  const frame = file.name.replace(/\.json$/i, '');
  const created = new Date(file.createdTime);
  const modified = new Date(file.modifiedTime);
  const creator = person(file.owners?.[0]) ?? person(file.lastModifyingUser);
  const editor = person(file.lastModifyingUser);
  const events = [];
  if (creator && !Number.isNaN(created.getTime())) events.push({ kind: 'new', user: creator, time: created, frame });
  if (editor && !Number.isNaN(modified.getTime()) && modified - created > UPLOAD_GRACE_MS) {
    const samePeriod = bucketKey(bucketStart(created, unit)) === bucketKey(bucketStart(modified, unit));
    if (!(creator && creator.email === editor.email && samePeriod)) {
      events.push({ kind: 'edited', user: editor, time: modified, frame });
    }
  }
  return events;
}

// Frame names to runs of consecutive frames, in the street's frame order. Names missing from the
// order (or no order at all) are placed by name, and count as consecutive when their trailing
// numbers are. Returns [{ first, last, count }].
export function frameRanges(names, orderedFrames = []) {
  const unique = [...new Set(names)];
  const index = new Map(orderedFrames.map((n, i) => [n, i]));
  const known = unique.every(n => index.has(n));
  const sorted = unique.sort((a, b) => known
    ? index.get(a) - index.get(b)
    : a.localeCompare(b, undefined, { numeric: true }));
  const trailing = n => { const m = n.match(/(\d+)\D*$/); return m ? Number(m[1]) : NaN; };
  const next = (a, b) => known ? index.get(b) === index.get(a) + 1 : trailing(b) === trailing(a) + 1;
  const runs = [];
  for (const name of sorted) {
    const run = runs[runs.length - 1];
    if (run && next(run.last, name)) { run.last = name; run.count++; }
    else runs.push({ first: name, last: name, count: 1 });
  }
  return runs;
}

export function formatRanges(runs) {
  return runs.map(r => r.count === 1 ? r.first : `${r.first} – ${r.last}`).join(', ');
}

// events: [{ kind, user, time, frame, streetKey }]
// options: { unit, columns (bucket starts), kinds: ['new', 'edited'], person (email or '') }
// Returns { people: [{ email, name, total, cells: Map(key -> cell) }], totals: Map(key -> n), max, grand }
// cell: { new, edited, total, streets: Map(streetKey -> { new: [frames], edited: [frames] }) }
export function aggregate(events, { unit, columns, kinds = ['new', 'edited'], person: only = '' }) {
  const keys = new Set(columns.map(bucketKey));
  const byEmail = new Map();
  for (const e of events) {
    if (!kinds.includes(e.kind)) continue;
    if (only && e.user.email !== only) continue;
    const key = bucketKey(bucketStart(e.time, unit));
    if (!keys.has(key)) continue;
    let p = byEmail.get(e.user.email);
    if (!p) byEmail.set(e.user.email, p = { email: e.user.email, name: e.user.name, total: 0, cells: new Map() });
    let cell = p.cells.get(key);
    if (!cell) p.cells.set(key, cell = { new: 0, edited: 0, total: 0, streets: new Map() });
    let street = cell.streets.get(e.streetKey);
    if (!street) cell.streets.set(e.streetKey, street = { new: [], edited: [] });
    street[e.kind].push(e.frame);
    cell[e.kind]++;
    cell.total++;
    p.total++;
  }
  const people = [...byEmail.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  const totals = new Map(columns.map(c => [bucketKey(c), 0]));
  let max = 0;
  for (const p of people) {
    for (const [key, cell] of p.cells) {
      totals.set(key, totals.get(key) + cell.total);
      max = Math.max(max, cell.total);
    }
  }
  return { people, totals, max, grand: people.reduce((n, p) => n + p.total, 0) };
}

// Merges a person's cells (all periods) into one, for the whole-range detail view
export function mergeCells(cells) {
  const merged = { new: 0, edited: 0, total: 0, streets: new Map() };
  for (const cell of cells) {
    merged.new += cell.new; merged.edited += cell.edited; merged.total += cell.total;
    for (const [key, s] of cell.streets) {
      const m = merged.streets.get(key) ?? { new: [], edited: [] };
      m.new.push(...s.new); m.edited.push(...s.edited);
      merged.streets.set(key, m);
    }
  }
  return merged;
}
