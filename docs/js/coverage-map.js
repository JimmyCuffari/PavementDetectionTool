import { getToken } from './auth.js';
import { listAllFiles, downloadFileContent, getFileMetadata } from './drive.js';
import { toast, makeSemaphore, haversineMeters } from './utils.js';
import { getCached, putCached, clearCache } from './coverage-cache.js';
import { COLLECTION_ROOT_FOLDER_ID } from './config.js';

// ── Module state ───────────────────────────────────────────────────────────────

const WORKER_POOL_SIZE = 2;
const PALETTE = ['#ff5f1f', '#1fb2ff', '#7cff1f', '#ff1f8f', '#ffd21f', '#1fffe0', '#b21fff', '#ff8f4d'];

const MATCH_RADIUS_M = 25;    // how close an OSM road point must be to a collected GPS point to count as "collected"
const GRID_CELL_DEG = 0.0003; // ~25-33m per cell — spatial index bucket size for the collected-point lookup
const DENSIFY_STEP_M = 30;    // max spacing between sample points along an OSM way before interpolating

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const STREET_HIGHWAY_TYPES = [
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
];

let _state = {
  rootFolder: null,   // { id, name }
  map: null,
  mapInited: false,
  layers: { coverage: null, boundary: null, uncollected: null },
  sessions: [],
  sectionLayers: new Map(),  // section name -> L.LayerGroup
  boundaryPlace: null,       // last geocoded Nominatim result (for uncollected-streets lookup)
  boundaryBounds: null,      // L.LatLngBounds of the boundary — cheap pre-filter before the polygon test
  scanning: false,
  findingGaps: false,
};

let _picker = { currentId: COLLECTION_ROOT_FOLDER_ID, currentName: 'Collection Data', path: [] };
const workerPool = [];

// ── Entry point ────────────────────────────────────────────────────────────────

export function renderCoverageMap(container) {
  container.innerHTML = `
    <div class="cm-wrap">
      <p class="section-title">Coverage Map</p>
      <p class="text-dim" style="font-size:13px;margin-bottom:1rem;">
        Point at a Google Drive folder to scan every subfolder for collection .db files, plot the
        collected streets on a satellite map, and outline any town, county, or state for reference.
      </p>

      <div class="flex-row" style="margin-bottom:0.75rem;flex-wrap:wrap;">
        <button class="btn btn-primary btn-sm" id="cm-pick-folder-btn">Choose Drive Folder…</button>
        <span id="cm-folder-path" class="text-dim" style="font-size:13px;">No folder selected</span>
        <button class="btn btn-primary btn-sm" id="cm-scan-btn" disabled>Scan for Collected Streets</button>
        <button class="btn btn-ghost btn-sm" id="cm-clear-cache-btn" title="Force re-parse of all files on next scan">Clear Cache</button>
      </div>

      <div id="cm-progress-wrap" class="progress-wrap hidden">
        <div class="progress-label">
          <span id="cm-progress-text">Scanning…</span>
          <span id="cm-progress-pct">0%</span>
        </div>
        <div class="progress-bar"><div class="progress-fill" id="cm-progress-fill"></div></div>
      </div>

      <div class="stat-row" id="cm-stat-row" style="display:none;"></div>

      <div id="cm-sections-wrap" class="cm-sections-wrap hidden">
        <div class="cm-sections-header">
          <span class="section-title" style="margin:0;">Collected Sections</span>
          <div class="flex-row" style="gap:0.4rem;">
            <button class="btn btn-ghost btn-sm" id="cm-sections-show-all">Show All</button>
            <button class="btn btn-ghost btn-sm" id="cm-sections-hide-all">Hide All</button>
          </div>
        </div>
        <div id="cm-sections-list" class="cm-sections-list"></div>
      </div>

      <div class="cm-search-row flex-row" style="margin:0.75rem 0;flex-wrap:wrap;">
        <input type="text" id="cm-location-input" placeholder="Town, county, or state (e.g. Glassboro, NJ)" />
        <button class="btn btn-ghost btn-sm" id="cm-location-btn">Outline</button>
        <button class="btn btn-ghost btn-sm" id="cm-location-clear-btn">Clear Outline</button>
        <button class="btn btn-ghost btn-sm" id="cm-uncollected-btn" disabled title="Search a location first">Show Uncollected Streets</button>
      </div>

      <div id="cm-coverage-progress-wrap" class="progress-wrap hidden">
        <div class="progress-label">
          <span id="cm-coverage-progress-label">Coverage</span>
          <span id="cm-coverage-progress-pct">0%</span>
        </div>
        <div class="progress-bar"><div class="progress-fill cm-coverage-fill" id="cm-coverage-progress-fill"></div></div>
        <p class="text-dim" id="cm-coverage-progress-sub" style="font-size:11px;margin-top:0.25rem;"></p>
      </div>

      <div id="cm-map" class="cm-map"></div>
    </div>

    <div id="cm-modal-overlay" class="cm-modal-overlay hidden">
      <div class="cm-modal">
        <div class="cm-modal-header">
          <span>Select a Drive folder</span>
          <button class="btn btn-ghost btn-sm" id="cm-modal-close">✕</button>
        </div>
        <div id="cm-modal-breadcrumb" class="cm-breadcrumb"></div>
        <div id="cm-modal-list" class="cm-folder-list"></div>
        <div class="cm-modal-footer">
          <button class="btn btn-primary btn-sm" id="cm-modal-select-btn">Use This Folder</button>
          <button class="btn btn-ghost btn-sm" id="cm-modal-cancel-btn">Cancel</button>
        </div>
      </div>
    </div>
  `;

  wireEvents(container);
  watchVisibility(container);

  if (!container.classList.contains('hidden')) {
    ensureMapInitialized();
  }
}

// ── Visibility (Leaflet needs a sized, visible container to init correctly) ────

function watchVisibility(container) {
  const observer = new MutationObserver(() => {
    if (!container.classList.contains('hidden')) {
      ensureMapInitialized();
      setTimeout(() => _state.map?.invalidateSize(), 50);
    }
  });
  observer.observe(container, { attributes: true, attributeFilter: ['class'] });
}

function ensureMapInitialized() {
  if (_state.mapInited) return;
  if (!document.getElementById('cm-map')) return;
  _state.mapInited = true;

  const satellite = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 19, attribution: 'Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics' }
  );
  const labels = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 19, attribution: 'Labels &copy; Esri' }
  );

  _state.map = L.map('cm-map', { center: [39.5, -98.35], zoom: 4, layers: [satellite, labels] });

  _state.layers.coverage = L.layerGroup().addTo(_state.map);
  _state.layers.boundary = L.layerGroup().addTo(_state.map);
  _state.layers.uncollected = L.layerGroup().addTo(_state.map);

  L.control.layers(
    { 'Satellite': satellite },
    {
      'Place labels': labels,
      'Collected streets': _state.layers.coverage,
      'Boundary outline': _state.layers.boundary,
      'Uncollected streets': _state.layers.uncollected,
    },
    { collapsed: true }
  ).addTo(_state.map);
}

// ── Events ─────────────────────────────────────────────────────────────────────

function wireEvents(container) {
  container.querySelector('#cm-pick-folder-btn').addEventListener('click', openFolderPicker);
  container.querySelector('#cm-modal-close').addEventListener('click', closeFolderPicker);
  container.querySelector('#cm-modal-cancel-btn').addEventListener('click', closeFolderPicker);
  container.querySelector('#cm-modal-select-btn').addEventListener('click', selectCurrentPickerFolder);
  container.querySelector('#cm-modal-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'cm-modal-overlay') closeFolderPicker();
  });

  container.querySelector('#cm-scan-btn').addEventListener('click', runScan);
  container.querySelector('#cm-clear-cache-btn').addEventListener('click', async () => {
    await clearCache();
    toast('Cache cleared — next scan will re-parse every file', 'success');
  });

  container.querySelector('#cm-location-btn').addEventListener('click', outlineLocation);
  container.querySelector('#cm-location-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') outlineLocation();
  });
  container.querySelector('#cm-location-clear-btn').addEventListener('click', () => {
    ensureMapInitialized();
    _state.layers.boundary.clearLayers();
    _state.layers.uncollected.clearLayers();
    _state.boundaryPlace = null;
    _state.boundaryBounds = null;
    document.getElementById('cm-uncollected-btn').disabled = true;
    document.getElementById('cm-coverage-progress-wrap').classList.add('hidden');
  });
  container.querySelector('#cm-uncollected-btn').addEventListener('click', computeUncollectedStreets);

  container.querySelector('#cm-sections-show-all').addEventListener('click', () => setAllSections(true));
  container.querySelector('#cm-sections-hide-all').addEventListener('click', () => setAllSections(false));
}

// ── Folder picker modal ──────────────────────────────────────────────────────────

async function openFolderPicker() {
  const token = getToken();
  if (!token) { toast('Not signed in', 'error'); return; }
  _picker = { currentId: COLLECTION_ROOT_FOLDER_ID, currentName: 'Collection Data', path: [] };
  document.getElementById('cm-modal-overlay').classList.remove('hidden');

  try {
    const meta = await getFileMetadata(token, COLLECTION_ROOT_FOLDER_ID, 'id,name');
    if (meta?.name) _picker.currentName = meta.name;
  } catch { /* fall back to default label */ }

  loadPickerFolder(token, _picker.currentId, _picker.currentName);
}

function closeFolderPicker() {
  document.getElementById('cm-modal-overlay').classList.add('hidden');
}

async function loadPickerFolder(token, folderId, folderName) {
  _picker.currentId = folderId;
  _picker.currentName = folderName;
  renderBreadcrumb();

  const list = document.getElementById('cm-modal-list');
  list.innerHTML = '<p class="text-dim" style="padding:0.5rem;">Loading…</p>';
  try {
    const folders = await listAllFiles(
      token,
      `'${folderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      'id,name'
    );
    folders.sort((a, b) => a.name.localeCompare(b.name));
    list.innerHTML = folders.length === 0
      ? '<p class="text-dim" style="padding:0.5rem;">No subfolders here</p>'
      : folders.map(f =>
          `<div class="cm-folder-row" data-folder-id="${f.id}" data-folder-name="${escHtml(f.name)}">📁 ${escHtml(f.name)}</div>`
        ).join('');

    list.querySelectorAll('.cm-folder-row').forEach(row => {
      row.addEventListener('click', () => {
        _picker.path.push({ id: _picker.currentId, name: _picker.currentName });
        loadPickerFolder(token, row.dataset.folderId, row.dataset.folderName);
      });
    });
  } catch (err) {
    list.innerHTML = `<p class="text-dim" style="padding:0.5rem;">Failed to load: ${escHtml(err.message)}</p>`;
  }
}

function renderBreadcrumb() {
  const bc = document.getElementById('cm-modal-breadcrumb');
  const trail = [..._picker.path, { id: _picker.currentId, name: _picker.currentName }];
  bc.innerHTML = trail.map((f, i) => `<span class="cm-crumb" data-idx="${i}">${escHtml(f.name)}</span>`)
    .join('<span class="cm-crumb-sep">/</span>');

  bc.querySelectorAll('.cm-crumb').forEach(el => {
    el.addEventListener('click', () => {
      const idx = Number(el.dataset.idx);
      const target = trail[idx];
      _picker.path = trail.slice(0, idx);
      loadPickerFolder(getToken(), target.id, target.name);
    });
  });
}

function selectCurrentPickerFolder() {
  const trail = [..._picker.path, { id: _picker.currentId, name: _picker.currentName }];
  _state.rootFolder = { id: _picker.currentId, name: _picker.currentName };
  document.getElementById('cm-folder-path').textContent = trail.map(f => f.name).join(' / ');
  document.getElementById('cm-scan-btn').disabled = false;
  closeFolderPicker();
}

// ── Recursive .db discovery ──────────────────────────────────────────────────────

async function findAllDbFiles(token, rootId, onProgress) {
  const dbFiles = [];
  const queue = [rootId];
  let foldersScanned = 0;

  while (queue.length > 0) {
    const batch = queue.splice(0, 5);
    const results = await Promise.all(batch.map(async (folderId) => {
      const [subfolders, files] = await Promise.all([
        listAllFiles(token, `'${folderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`, 'id,name'),
        listAllFiles(token, `'${folderId}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder' and name contains '.db'`, 'id,name,size,modifiedTime'),
      ]);
      return { subfolders, files };
    }));

    for (const { subfolders, files } of results) {
      foldersScanned++;
      for (const f of subfolders) queue.push(f.id);
      for (const f of files) {
        if (/\.db$/i.test(f.name)) dbFiles.push(f);
      }
    }
    onProgress?.(foldersScanned, dbFiles.length);
  }

  return dbFiles;
}

// ── Worker pool for parsing .db files ────────────────────────────────────────────

function getWorker(slot) {
  if (!workerPool[slot]) workerPool[slot] = new Worker('js/worker/coverage-worker.js');
  return workerPool[slot];
}

function parseInWorker(slot, fileId, buffer) {
  return new Promise((resolve, reject) => {
    const worker = getWorker(slot % WORKER_POOL_SIZE);
    function handler(e) {
      if (e.data.fileId !== fileId) return;
      worker.removeEventListener('message', handler);
      if (e.data.type === 'PARSED') resolve(e.data.sessions);
      else reject(new Error(e.data.message || 'Parse failed'));
    }
    worker.addEventListener('message', handler);
    worker.postMessage({ type: 'PARSE', fileId, buffer }, [buffer]);
  });
}

async function processDbFile(token, file, workerSlot) {
  const size = Number(file.size || 0);
  let sessions = await getCached(file.id, size, file.modifiedTime);
  if (!sessions) {
    const buffer = await downloadFileContent(token, file.id);
    sessions = await parseInWorker(workerSlot, file.id, buffer);
    await putCached(file.id, size, file.modifiedTime, sessions);
  }
  return sessions.map(s => ({ ...s, fileId: file.id, fileName: file.name }));
}

// ── Scan orchestration ────────────────────────────────────────────────────────────

async function runScan() {
  const token = getToken();
  if (!token) { toast('Not signed in', 'error'); return; }
  if (!_state.rootFolder) { toast('Choose a Drive folder first', 'error'); return; }
  if (_state.scanning) return;

  _state.scanning = true;
  setScanUi(true);
  showProgress(true, 0);
  setProgressText('Searching folders…');

  try {
    const dbFiles = await findAllDbFiles(token, _state.rootFolder.id, (foldersScanned, filesFound) => {
      setProgressText(`Searching folders… ${foldersScanned} scanned, ${filesFound} .db file${filesFound === 1 ? '' : 's'} found`);
    });

    if (dbFiles.length === 0) {
      toast('No .db files found in that folder (including subfolders)', 'error');
      return;
    }

    let done = 0, slot = 0, errors = 0;
    const allSessions = [];
    const sem = makeSemaphore(WORKER_POOL_SIZE);

    await Promise.all(dbFiles.map(file => sem(async () => {
      try {
        const sessions = await processDbFile(token, file, slot++);
        allSessions.push(...sessions);
      } catch (err) {
        errors++;
        console.warn(`Failed to parse ${file.name}:`, err);
      } finally {
        done++;
        const pct = Math.round((done / dbFiles.length) * 100);
        showProgress(true, pct);
        setProgressText(`Parsing ${done} of ${dbFiles.length} files…`);
      }
    })));

    _state.sessions = allSessions;
    renderSessionsOnMap(allSessions);
    updateStats(dbFiles.length, allSessions, errors);

    const errSuffix = errors ? ` (${errors} file${errors === 1 ? '' : 's'} failed)` : '';
    toast(`Scan complete: ${dbFiles.length} files, ${allSessions.length} street segments${errSuffix}`, errors ? 'error' : 'success');
  } catch (err) {
    toast(`Scan failed: ${err.message}`, 'error');
  } finally {
    _state.scanning = false;
    setScanUi(false);
    showProgress(false);
  }
}

// ── Map rendering ──────────────────────────────────────────────────────────────

function renderSessionsOnMap(sessions) {
  ensureMapInitialized();
  _state.layers.coverage.clearLayers();
  _state.sectionLayers.clear();

  const byName = groupByName(sessions);
  const allLatLngs = [];

  for (const [name, group] of byName) {
    const sectionLayer = L.layerGroup();
    for (const s of group) {
      allLatLngs.push(...s.points);
      const line = L.polyline(s.points, { color: colorForFile(s.fileId), weight: 3, opacity: 0.85 });
      const miles = (s.distanceM / 1609.34).toFixed(2);
      line.bindPopup(`<strong>${escHtml(s.name)}</strong><br/>${miles} mi &middot; ${escHtml(s.fileName)}`);
      line.addTo(sectionLayer);
    }
    sectionLayer.addTo(_state.layers.coverage);
    _state.sectionLayers.set(name, sectionLayer);
  }

  renderSectionList(byName);

  if (allLatLngs.length > 0) {
    _state.map.fitBounds(L.latLngBounds(allLatLngs), { padding: [30, 30] });
  }
}

function groupByName(sessions) {
  const map = new Map();
  for (const s of sessions) {
    if (!map.has(s.name)) map.set(s.name, []);
    map.get(s.name).push(s);
  }
  return new Map([...map.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

function colorForFile(fileId) {
  let h = 0;
  for (let i = 0; i < fileId.length; i++) h = (h * 31 + fileId.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

// ── Section show/hide list ────────────────────────────────────────────────────

function renderSectionList(byName) {
  const wrap = document.getElementById('cm-sections-wrap');
  const list = document.getElementById('cm-sections-list');

  if (byName.size === 0) {
    wrap.classList.add('hidden');
    list.innerHTML = '';
    return;
  }

  wrap.classList.remove('hidden');
  list.innerHTML = [...byName.entries()].map(([name, group]) => {
    const miles = (group.reduce((sum, s) => sum + s.distanceM, 0) / 1609.34).toFixed(2);
    return `
      <label class="cm-section-row">
        <input type="checkbox" checked data-section-name="${escHtml(name)}" />
        <span class="cm-section-swatch" style="background:${colorForName(name)};"></span>
        <span class="cm-section-name">${escHtml(name)}</span>
        <span class="cm-section-meta">${miles} mi</span>
      </label>`;
  }).join('');

  list.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => toggleSection(cb.dataset.sectionName, cb.checked));
  });
}

function toggleSection(name, visible) {
  const layer = _state.sectionLayers.get(name);
  if (!layer) return;
  if (visible) layer.addTo(_state.layers.coverage);
  else _state.layers.coverage.removeLayer(layer);
}

function setAllSections(visible) {
  document.querySelectorAll('#cm-sections-list input[type="checkbox"]').forEach(cb => {
    cb.checked = visible;
    toggleSection(cb.dataset.sectionName, visible);
  });
}

function colorForName(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function updateStats(fileCount, sessions, errors) {
  const totalMiles = sessions.reduce((sum, s) => sum + s.distanceM, 0) / 1609.34;
  const uniqueStreets = new Set(sessions.map(s => s.name.replace(/\s+[NSEW]$/i, ''))).size;
  const row = document.getElementById('cm-stat-row');
  row.style.display = 'flex';
  row.innerHTML = `
    <div class="stat"><div class="stat-label">DB Files</div><div class="stat-value">${fileCount}</div></div>
    <div class="stat"><div class="stat-label">Street Segments</div><div class="stat-value">${sessions.length}</div></div>
    <div class="stat"><div class="stat-label">Distinct Streets</div><div class="stat-value">${uniqueStreets}</div></div>
    <div class="stat"><div class="stat-label">Distance Covered</div><div class="stat-value">${totalMiles.toFixed(1)} mi</div></div>
    ${errors ? `<div class="stat"><div class="stat-label">Failed Files</div><div class="stat-value text-danger">${errors}</div></div>` : ''}
  `;
}

// ── Location outline (Nominatim) ────────────────────────────────────────────────

async function outlineLocation() {
  const input = document.getElementById('cm-location-input');
  const query = input.value.trim();
  if (!query) { toast('Enter a town, county, or state name', 'error'); return; }

  ensureMapInitialized();
  const btn = document.getElementById('cm-location-btn');
  btn.disabled = true;
  btn.textContent = 'Searching…';

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&polygon_geojson=1&limit=1&q=${encodeURIComponent(query)}`;
    const resp = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!resp.ok) throw new Error(`Lookup failed (${resp.status})`);
    const results = await resp.json();

    if (!results.length || !results[0].geojson) {
      toast(`No boundary found for "${query}"`, 'error');
      return;
    }

    const place = results[0];
    _state.layers.boundary.clearLayers();
    _state.layers.uncollected.clearLayers();
    const layer = L.geoJSON(place.geojson, {
      style: { color: '#000000', weight: 3, fillColor: '#000000', fillOpacity: 0.08 },
    });
    layer.addTo(_state.layers.boundary);
    const bounds = layer.getBounds();
    _state.map.fitBounds(bounds, { padding: [30, 30] });

    _state.boundaryPlace = place;
    _state.boundaryBounds = bounds;
    const uncollectedBtn = document.getElementById('cm-uncollected-btn');
    uncollectedBtn.disabled = false;
    uncollectedBtn.title = '';

    toast(`Outlined ${place.display_name}`, 'success');
  } catch (err) {
    toast(`Location lookup failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Outline';
  }
}

// ── Uncollected streets (Overpass road network minus collected GPS traces) ─────

function overpassAreaId(osmType, osmId) {
  if (osmType === 'relation') return 3600000000 + Number(osmId);
  if (osmType === 'way') return 2400000000 + Number(osmId);
  return null;
}

function buildCollectedIndex(sessions) {
  const grid = new Map();
  for (const s of sessions) {
    for (const [lat, lon] of s.points) {
      const key = cellKey(lat, lon);
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push([lat, lon]);
    }
  }
  return grid;
}

function cellKey(lat, lon) {
  return `${Math.floor(lat / GRID_CELL_DEG)},${Math.floor(lon / GRID_CELL_DEG)}`;
}

function isNearCollected(grid, lat, lon) {
  const cLat = Math.floor(lat / GRID_CELL_DEG);
  const cLon = Math.floor(lon / GRID_CELL_DEG);
  for (let dLat = -1; dLat <= 1; dLat++) {
    for (let dLon = -1; dLon <= 1; dLon++) {
      const bucket = grid.get(`${cLat + dLat},${cLon + dLon}`);
      if (!bucket) continue;
      for (const [plat, plon] of bucket) {
        if (haversineMeters(lat, lon, plat, plon) <= MATCH_RADIUS_M) return true;
      }
    }
  }
  return false;
}

// Interpolates extra points along long OSM way segments so sparse rural geometry
// still gets sampled at roughly DENSIFY_STEP_M intervals.
function densifyGeometry(geometry) {
  const out = [geometry[0]];
  for (let i = 1; i < geometry.length; i++) {
    const a = geometry[i - 1], b = geometry[i];
    const dist = haversineMeters(a.lat, a.lon, b.lat, b.lon);
    const steps = Math.ceil(dist / DENSIFY_STEP_M);
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      out.push({ lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t });
    }
  }
  return out;
}

// Ray-casting point-in-polygon test. GeoJSON rings are [lon, lat]; ring[0] is the
// outer boundary, any further rings are holes to subtract.
function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect = (yi > lat) !== (yj > lat) &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygonCoords(lon, lat, rings) {
  if (!pointInRing(lon, lat, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(lon, lat, rings[i])) return false; // inside a hole
  }
  return true;
}

function pointInGeojson(lat, lon, geojson) {
  if (geojson.type === 'Polygon') return pointInPolygonCoords(lon, lat, geojson.coordinates);
  if (geojson.type === 'MultiPolygon') return geojson.coordinates.some(poly => pointInPolygonCoords(lon, lat, poly));
  return true; // unexpected geometry type — don't filter
}

function isInsideBoundary(lat, lon) {
  if (!_state.boundaryBounds || !_state.boundaryPlace?.geojson) return true;
  if (!_state.boundaryBounds.contains([lat, lon])) return false; // cheap bbox rejection first
  return pointInGeojson(lat, lon, _state.boundaryPlace.geojson);
}

// Walks a way's sampled points as consecutive segments, classifying each by its midpoint
// (inside the boundary + near a collected GPS point, or not). Returns contiguous uncovered
// runs to draw in red, plus the total collected/uncollected distance for the coverage bar.
// Segments with a midpoint outside the boundary are excluded from both distances entirely.
function classifyWaySegments(points, grid) {
  const uncoveredRuns = [];
  let collectedM = 0, uncollectedM = 0;
  let current = [];

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const midLat = (a.lat + b.lat) / 2, midLon = (a.lon + b.lon) / 2;

    if (!isInsideBoundary(midLat, midLon)) {
      if (current.length >= 2) uncoveredRuns.push(current);
      current = [];
      continue;
    }

    const segLen = haversineMeters(a.lat, a.lon, b.lat, b.lon);
    if (isNearCollected(grid, midLat, midLon)) {
      collectedM += segLen;
      if (current.length >= 2) uncoveredRuns.push(current);
      current = [];
    } else {
      uncollectedM += segLen;
      if (current.length === 0) current.push([a.lat, a.lon]);
      current.push([b.lat, b.lon]);
    }
  }
  if (current.length >= 2) uncoveredRuns.push(current);

  return { uncoveredRuns, collectedM, uncollectedM };
}

async function computeUncollectedStreets() {
  if (!_state.boundaryPlace) { toast('Search and outline a location first', 'error'); return; }
  if (_state.findingGaps) return;

  const areaId = overpassAreaId(_state.boundaryPlace.osm_type, _state.boundaryPlace.osm_id);
  if (!areaId) { toast('Cannot compute uncollected streets for this type of place', 'error'); return; }

  if (_state.sessions.length === 0) {
    toast('No collected data loaded yet — scan a Drive folder first for a meaningful comparison', 'info');
  }

  _state.findingGaps = true;
  const btn = document.getElementById('cm-uncollected-btn');
  btn.disabled = true;
  btn.textContent = 'Finding gaps…';

  try {
    const query = `[out:json][timeout:60];
area(${areaId})->.searchArea;
way(area.searchArea)["highway"~"^(${STREET_HIGHWAY_TYPES.join('|')})$"];
out geom;`;

    const resp = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
    });
    if (!resp.ok) throw new Error(`Overpass query failed (${resp.status})`);
    const data = await resp.json();
    const ways = (data.elements || []).filter(e => e.type === 'way' && Array.isArray(e.geometry) && e.geometry.length >= 2);

    if (ways.length === 0) {
      toast('No streets found for this area', 'error');
      return;
    }

    const grid = buildCollectedIndex(_state.sessions);
    _state.layers.uncollected.clearLayers();

    let runCount = 0, totalCollectedM = 0, totalUncollectedM = 0;
    for (const way of ways) {
      const densified = densifyGeometry(way.geometry);
      const { uncoveredRuns, collectedM, uncollectedM } = classifyWaySegments(densified, grid);
      totalCollectedM += collectedM;
      totalUncollectedM += uncollectedM;
      for (const run of uncoveredRuns) {
        L.polyline(run, { color: '#ff2020', weight: 3, opacity: 0.85 }).addTo(_state.layers.uncollected);
        runCount++;
      }
    }

    updateCoverageProgress(_state.boundaryPlace.display_name, totalCollectedM, totalUncollectedM);

    toast(
      runCount > 0
        ? `Found ${runCount} uncollected street segment${runCount === 1 ? '' : 's'} in ${_state.boundaryPlace.display_name}`
        : `Every street in ${_state.boundaryPlace.display_name} appears to be collected`,
      'success'
    );
  } catch (err) {
    toast(`Failed to compute uncollected streets: ${err.message}`, 'error');
  } finally {
    _state.findingGaps = false;
    btn.disabled = false;
    btn.textContent = 'Show Uncollected Streets';
  }
}

function updateCoverageProgress(placeName, collectedM, uncollectedM) {
  const wrap = document.getElementById('cm-coverage-progress-wrap');
  const totalM = collectedM + uncollectedM;
  const pct = totalM > 0 ? Math.round((collectedM / totalM) * 100) : 0;
  const collectedMi = (collectedM / 1609.34).toFixed(1);
  const totalMi = (totalM / 1609.34).toFixed(1);

  wrap.classList.remove('hidden');
  document.getElementById('cm-coverage-progress-label').textContent = `Coverage in ${placeName}`;
  document.getElementById('cm-coverage-progress-pct').textContent = `${pct}%`;
  document.getElementById('cm-coverage-progress-fill').style.width = `${pct}%`;
  document.getElementById('cm-coverage-progress-sub').textContent =
    totalM > 0 ? `${collectedMi} mi collected of ${totalMi} mi total` : 'No streets found in this area';
}

// ── UI helpers ─────────────────────────────────────────────────────────────────

function setScanUi(scanning) {
  document.getElementById('cm-scan-btn').disabled = scanning || !_state.rootFolder;
  document.getElementById('cm-pick-folder-btn').disabled = scanning;
}

function showProgress(show, pct = 0) {
  document.getElementById('cm-progress-wrap').classList.toggle('hidden', !show);
  document.getElementById('cm-progress-fill').style.width = `${pct}%`;
  document.getElementById('cm-progress-pct').textContent = `${pct}%`;
}

function setProgressText(text) {
  const el = document.getElementById('cm-progress-text');
  if (el) el.textContent = text;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
