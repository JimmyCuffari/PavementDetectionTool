import { getToken } from './auth.js';
import { listAllFiles, findFolder } from './drive.js';
import { getCurrentDataset, getDatasetsForProject } from './dataset-manager.js';
import { getCurrentProject } from './project-manager.js';
import { makeSemaphore, toast } from './utils.js';
import {
  buckets, bucketKey, bucketLabel, fileEvents, frameRanges, formatRanges, aggregate, mergeCells,
} from './progress-calc.js';

// Admin-only Progress tab: how many frames each person labelled or edited per week or month, with
// the streets and frame ranges behind each count. Built from Google Drive's record of who created
// and who last changed each label file, so it covers every way labels get into Drive.

const FOLDER = 'application/vnd.google-apps.folder';
const PARENT_BATCH = 40;   // folder ids per Drive query
const LABEL_FIELDS = 'id,name,parents,createdTime,modifiedTime,owners(emailAddress,displayName),lastModifyingUser(emailAddress,displayName)';
const SPANS = { week: [4, 8, 12], month: [3, 6, 12] };
const DEFAULT_SPAN = { week: 8, month: 6 };

let root = null;
let data = null;       // last scan: { scopeKey, since, files: [...], streets: Map(streetKey -> street) }
let result = null;     // last aggregate, with its columns
let selected = null;   // { email, key } — key null for the whole range
let scanning = false;

export function renderProgress(container) {
  root = container;
  container.innerHTML = `
    <div class="pg">
      <p class="section-title">Annotation Progress</p>
      <p class="text-dim pg-intro">
        Frames each person labelled or edited, from Google Drive's record of who created and who last
        changed each label file. Click a count to see the streets and frames behind it.
      </p>
      <div class="pg-controls">
        <label class="pg-field">Dataset <select id="pg-scope"></select></label>
        <label class="pg-field">Group by
          <select id="pg-unit"><option value="week">Week</option><option value="month">Month</option></select>
        </label>
        <label class="pg-field">Show <select id="pg-span"></select></label>
        <label class="pg-field">Count
          <select id="pg-kind">
            <option value="both">New labels + edits</option>
            <option value="new">New labels</option>
            <option value="edited">Edits</option>
          </select>
        </label>
        <label class="pg-field">Person <select id="pg-person"><option value="">Everyone</option></select></label>
        <button class="btn btn-primary btn-sm" id="pg-scan">Scan</button>
        <button class="btn btn-ghost btn-sm hidden" id="pg-csv">Copy CSV</button>
      </div>
      <div id="pg-progress" class="progress-wrap hidden">
        <div class="progress-label"><span id="pg-progress-text">Scanning…</span><span id="pg-progress-pct"></span></div>
        <div class="progress-bar"><div class="progress-fill" id="pg-progress-fill"></div></div>
      </div>
      <div id="pg-status" class="text-dim pg-status">Press Scan to load progress for the open dataset.</div>
      <div id="pg-grid" class="pg-grid-wrap"></div>
      <div id="pg-detail" class="pg-detail hidden"></div>
      <p class="text-dim pg-note">
        Only the most recent editor of a frame is credited with its edit. Label Refactor renames and
        re-uploads through Upload Labels count as edits by whoever ran them. Times are in your time zone,
        and weeks start on Monday.
      </p>
    </div>`;

  const unit = root.querySelector('#pg-unit');
  unit.addEventListener('change', () => { fillSpans(); onControlsChanged(true); });
  root.querySelector('#pg-span').addEventListener('change', () => onControlsChanged(true));
  root.querySelector('#pg-scope').addEventListener('change', () => onControlsChanged(true));
  root.querySelector('#pg-kind').addEventListener('change', () => onControlsChanged(false));
  root.querySelector('#pg-person').addEventListener('change', () => onControlsChanged(false));
  root.querySelector('#pg-scan').addEventListener('click', () => runScan(true));
  root.querySelector('#pg-csv').addEventListener('click', copyCsv);
  root.querySelector('#pg-grid').addEventListener('click', (e) => {
    const target = e.target.closest('[data-email]');
    if (!target) return;
    selected = { email: target.dataset.email, key: target.dataset.key || null };
    renderGrid();
    renderDetail();
  });
  fillSpans();
  refreshProgress();
}

// Called when the dataset or project changes, and when the tab is shown
export function refreshProgress() {
  if (!root) return;
  const select = root.querySelector('#pg-scope');
  const current = getCurrentDataset();
  const all = projectDatasets();
  const previous = select.value;
  select.innerHTML = (current ? `<option value="current">${escapeHtml(current.name)}</option>` : '')
    + (all.length > 1 ? `<option value="all">All datasets in this project (${all.length})</option>` : '');
  select.value = [...select.options].some(o => o.value === previous) ? previous : (current ? 'current' : 'all');
  if (data && data.scopeKey !== scopeKey()) {
    data = null;
    result = null;
    selected = null;
    root.querySelector('#pg-grid').innerHTML = '';
    root.querySelector('#pg-detail').classList.add('hidden');
    root.querySelector('#pg-csv').classList.add('hidden');
    setStatus('Press Scan to load progress for this dataset.');
  }
}

function projectDatasets() {
  const project = getCurrentProject();
  return project ? getDatasetsForProject(project.id) : [];
}

function scopeDatasets() {
  return root.querySelector('#pg-scope').value === 'all' ? projectDatasets() : [getCurrentDataset()].filter(Boolean);
}

function scopeKey() {
  return scopeDatasets().map(d => d.driveFolderId).sort().join(',');
}

function fillSpans() {
  const unit = root.querySelector('#pg-unit').value;
  const span = root.querySelector('#pg-span');
  span.innerHTML = SPANS[unit].map(n => `<option value="${n}">Last ${n} ${unit}s</option>`).join('');
  span.value = String(DEFAULT_SPAN[unit]);
}

function columns() {
  const unit = root.querySelector('#pg-unit').value;
  return buckets(Number(root.querySelector('#pg-span').value), unit);
}

// Grouping, count and person only redraw. A longer range or another dataset needs a new scan,
// done straight away once a first scan has shown the user wants this data.
function onControlsChanged(mayNeedScan) {
  if (mayNeedScan && data && (data.scopeKey !== scopeKey() || columns()[0] < data.since)) {
    runScan(false);
    return;
  }
  if (data) render();
}

function setStatus(text) {
  root.querySelector('#pg-status').textContent = text;
}

function setProgress(text, fraction) {
  root.querySelector('#pg-progress').classList.toggle('hidden', fraction === null);
  root.querySelector('#pg-progress-text').textContent = text;
  root.querySelector('#pg-progress-pct').textContent = fraction === null ? '' : `${Math.round(fraction * 100)}%`;
  root.querySelector('#pg-progress-fill').style.width = `${(fraction ?? 0) * 100}%`;
}

// ── Drive scan ──────────────────────────────────────────────────────────────

async function runScan() {
  if (scanning) return;
  const token = getToken();
  if (!token) { toast('Not signed in', 'error'); return; }
  const datasets = scopeDatasets();
  if (!datasets.length) { setStatus('Open a dataset in the Datasets tab first.'); return; }
  const since = columns()[0];
  scanning = true;
  root.querySelector('#pg-scan').disabled = true;
  setStatus('');
  try {
    const scanned = await scan(token, datasets, since);
    data = { scopeKey: datasets.map(d => d.driveFolderId).sort().join(','), since, ...scanned };
    root.querySelector('#pg-scan').textContent = 'Refresh';
    refreshPersonOptions();
    render();
  } catch (err) {
    toast(`Progress scan failed: ${err.message}`, 'error', 8000);
    setStatus('The scan failed. Press Scan to try again.');
  } finally {
    scanning = false;
    root.querySelector('#pg-scan').disabled = false;
    setProgress('', null);
  }
}

const inParents = ids => `(${ids.map(id => `'${id}' in parents`).join(' or ')})`;

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function scan(token, datasets, since) {
  const sem = makeSemaphore(6);
  const multi = datasets.length > 1;

  // Streets in each dataset's raw data folder
  setProgress('Finding streets…', 0);
  const streetLists = await Promise.all(datasets.map(ds => sem(async () => {
    const raw = await findFolder(token, 'raw data', ds.driveFolderId);
    if (!raw) return [];
    const folders = await listAllFiles(token, `'${raw.id}' in parents and mimeType='${FOLDER}' and trashed=false`, 'id,name');
    return folders.map(f => ({ id: f.id, name: f.name, dataset: ds.name, label: multi ? `${ds.name} / ${f.name}` : f.name }));
  })));
  const streets = new Map(streetLists.flat().map(s => [s.id, s]));
  if (!streets.size) return { files: [], streets };

  // Each street's labels and frames folders
  setProgress('Finding label folders…', 0.1);
  const labelsFolders = new Map();   // labels folder id -> street id
  await Promise.all(chunks([...streets.keys()], PARENT_BATCH).map(ids => sem(async () => {
    const subs = await listAllFiles(token,
      `${inParents(ids)} and mimeType='${FOLDER}' and (name='labels' or name='frames') and trashed=false`, 'id,name,parents');
    for (const sub of subs) {
      const street = streets.get(sub.parents?.find(p => streets.has(p)));
      if (!street) continue;
      if (sub.name === 'labels') { street.labelsId = sub.id; labelsFolders.set(sub.id, street.id); }
      else street.framesId = sub.id;
    }
  })));

  // Label files changed since the range began (this includes every file created since then)
  const batches = chunks([...labelsFolders.keys()], PARENT_BATCH);
  let done = 0;
  const files = [];
  await Promise.all(batches.map(ids => sem(async () => {
    const found = await listAllFiles(token,
      `${inParents(ids)} and trashed=false and modifiedTime >= '${since.toISOString()}'`, LABEL_FIELDS);
    for (const f of found) {
      if (!/\.json$/i.test(f.name)) continue;
      const streetId = labelsFolders.get(f.parents?.find(p => labelsFolders.has(p)));
      if (streetId) files.push({ ...f, streetId });
    }
    done++;
    setProgress('Reading label files…', 0.2 + 0.5 * done / batches.length);
  })));

  // Frame order and totals, only for streets with activity
  const active = [...new Set(files.map(f => f.streetId))].map(id => streets.get(id));
  done = 0;
  await Promise.all(active.map(street => sem(async () => {
    const [images, labels] = await Promise.all([
      street.framesId ? listAllFiles(token, `'${street.framesId}' in parents and trashed=false`, 'name,mimeType') : [],
      listAllFiles(token, `'${street.labelsId}' in parents and trashed=false`, 'name'),
    ]);
    street.frames = images
      .filter(f => f.mimeType?.startsWith('image/') || /\.(jpe?g|png|bmp|webp)$/i.test(f.name))
      .map(f => f.name.replace(/\.[^.]+$/, ''))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    street.labelled = labels.filter(f => /\.json$/i.test(f.name)).length;
    done++;
    setProgress('Reading frame lists…', 0.7 + 0.3 * done / active.length);
  })));

  return { files, streets };
}

// ── Grid ────────────────────────────────────────────────────────────────────

function refreshPersonOptions() {
  const select = root.querySelector('#pg-person');
  const previous = select.value;
  const people = new Map();
  for (const f of data.files) {
    for (const u of [f.owners?.[0], f.lastModifyingUser]) {
      if (u?.emailAddress) people.set(u.emailAddress.toLowerCase(), u.displayName || u.emailAddress);
    }
  }
  const sorted = [...people].sort((a, b) => a[1].localeCompare(b[1]));
  select.innerHTML = '<option value="">Everyone</option>'
    + sorted.map(([email, name]) => `<option value="${escapeHtml(email)}">${escapeHtml(name)}</option>`).join('');
  select.value = people.has(previous) ? previous : '';
}

function render() {
  const unit = root.querySelector('#pg-unit').value;
  const kind = root.querySelector('#pg-kind').value;
  const cols = columns();
  const events = data.files.flatMap(f => fileEvents(f, unit).map(e => ({ ...e, streetKey: f.streetId })));
  result = {
    unit, cols,
    ...aggregate(events, {
      unit, columns: cols,
      kinds: kind === 'both' ? ['new', 'edited'] : [kind],
      person: root.querySelector('#pg-person').value,
    }),
  };
  if (selected && !result.people.some(p => p.email === selected.email)) selected = null;
  if (selected?.key && !cols.some(c => bucketKey(c) === selected.key)) selected = null;

  const streetCount = data.streets.size;
  setStatus(result.people.length
    ? `${result.grand.toLocaleString()} frame${result.grand === 1 ? '' : 's'} by ${result.people.length} `
      + `${result.people.length === 1 ? 'person' : 'people'} across ${streetCount} street${streetCount === 1 ? '' : 's'}.`
    : `No labelling activity in this range across ${streetCount} street${streetCount === 1 ? '' : 's'}.`);
  root.querySelector('#pg-csv').classList.toggle('hidden', !result.people.length);
  renderGrid();
  renderDetail();
}

function cellHtml(person, key, n) {
  const shade = result.max ? 0.12 + 0.6 * (n / result.max) : 0;
  const isSel = selected?.email === person.email && selected.key === key;
  const breakdown = person.cells.get(key);
  const title = breakdown ? `${breakdown.new} new, ${breakdown.edited} edited` : '';
  return n
    ? `<td><button class="pg-cell${isSel ? ' pg-selected' : ''}" data-email="${escapeHtml(person.email)}" data-key="${key}"
        style="--shade:${shade.toFixed(3)}" title="${title}">${n.toLocaleString()}</button></td>`
    : '<td class="pg-empty">–</td>';
}

function renderGrid() {
  const grid = root.querySelector('#pg-grid');
  if (!result?.people.length) { grid.innerHTML = ''; return; }
  const { cols, unit, people, totals, grand } = result;
  const keys = cols.map(bucketKey);
  grid.innerHTML = `
    <table class="pg-table">
      <thead><tr>
        <th class="pg-person-col">Person</th>
        ${cols.map(c => `<th>${bucketLabel(c, unit)}</th>`).join('')}
        <th class="pg-total-col">Total</th>
      </tr></thead>
      <tbody>
        ${people.map(p => `<tr>
          <th class="pg-person-col"><button class="pg-person${selected?.email === p.email && !selected.key ? ' pg-selected' : ''}"
            data-email="${escapeHtml(p.email)}" title="${escapeHtml(p.email)}">${escapeHtml(p.name)}</button></th>
          ${keys.map(k => cellHtml(p, k, p.cells.get(k)?.total ?? 0)).join('')}
          <td class="pg-total-col">${p.total.toLocaleString()}</td>
        </tr>`).join('')}
      </tbody>
      <tfoot><tr>
        <th class="pg-person-col">Total</th>
        ${keys.map(k => `<td>${totals.get(k) ? totals.get(k).toLocaleString() : '–'}</td>`).join('')}
        <td class="pg-total-col">${grand.toLocaleString()}</td>
      </tr></tfoot>
    </table>`;
}

function renderDetail() {
  const panel = root.querySelector('#pg-detail');
  const person = selected && result?.people.find(p => p.email === selected.email);
  if (!person) { panel.classList.add('hidden'); return; }
  const cell = selected.key ? person.cells.get(selected.key) : mergeCells([...person.cells.values()]);
  if (!cell) { panel.classList.add('hidden'); return; }
  const col = result.cols.find(c => bucketKey(c) === selected.key);
  const period = col
    ? (result.unit === 'month' ? bucketLabel(col, 'month') : `week of ${bucketLabel(col, 'week')}`)
    : `the last ${result.cols.length} ${result.unit}s`;

  const streets = [...cell.streets].map(([id, s]) => ({ street: data.streets.get(id), ...s }))
    .sort((a, b) => a.street.label.localeCompare(b.street.label, undefined, { numeric: true }));
  const line = (label, frames, street) => frames.length
    ? `<div class="pg-line"><span class="pg-kind">${frames.length} ${label}</span>
        <span class="pg-ranges">${escapeHtml(formatRanges(frameRanges(frames, street.frames)))}</span></div>`
    : '';
  panel.innerHTML = `
    <div class="pg-detail-head">
      <strong>${escapeHtml(person.name)}</strong>
      <span class="text-dim">${escapeHtml(person.email)} · ${period} · ${cell.new} new, ${cell.edited} edited</span>
      <button class="btn btn-ghost btn-sm" id="pg-detail-close">Close</button>
    </div>
    ${streets.map(s => `
      <div class="pg-street">
        <div class="pg-street-name">${escapeHtml(s.street.label)}
          <span class="text-dim">· ${s.street.labelled ?? '?'} of ${s.street.frames?.length || '?'} frames labelled</span>
        </div>
        ${line('new', s.new, s.street)}
        ${line('edited', s.edited, s.street)}
      </div>`).join('')}`;
  panel.classList.remove('hidden');
  panel.querySelector('#pg-detail-close').addEventListener('click', () => {
    selected = null;
    renderGrid();
    renderDetail();
  });
}

function copyCsv() {
  if (!result?.people.length) return;
  const quote = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  const rows = [['Person', 'Email', result.unit === 'month' ? 'Month' : 'Week starting', 'New', 'Edited', 'Total']];
  for (const p of result.people) {
    for (const c of result.cols) {
      const cell = p.cells.get(bucketKey(c));
      if (cell) rows.push([p.name, p.email, bucketKey(c), cell.new, cell.edited, cell.total]);
    }
  }
  navigator.clipboard.writeText(rows.map(r => r.map(quote).join(',')).join('\n'))
    .then(() => toast(`Copied ${rows.length - 1} rows`, 'success'))
    .catch(() => toast('Could not copy to the clipboard', 'error'));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
