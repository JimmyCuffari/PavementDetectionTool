import { getToken }                     from './auth.js';
import { listAllFiles }                 from './drive.js';
import { getCurrentProject, getProjectModelsFolder } from './project-manager.js';
import { toast }                        from './utils.js';

// ── Module state ──────────────────────────────────────────────────────────────

let _serverUrl     = 'http://localhost:7860';
let _connected      = false;
let _container      = null;
let _registryModels = null;   // cached registry .pt files: [{id,name,...}]
let _results        = [];     // [{ name, metrics, class_metrics, class_metrics_seg, images }]
let _stopRequested  = false;
let _threshStopRequested = false;
let _threshChart    = null;

const _PM_IMAGE_LABELS = {
  'confusion_matrix_normalized.png': 'Confusion Matrix (Normalized)',
  'confusion_matrix.png':            'Confusion Matrix',
  'PR_curve.png':                    'Precision-Recall Curve',
  'F1_curve.png':                    'F1 Score Curve',
  'P_curve.png':                     'Precision Curve',
  'R_curve.png':                     'Recall Curve',
};

// Overall scalar metrics shown in the comparison table / CSV.
const _OVERALL_METRICS = [
  { label: 'BBox mAP50',     keys: ['box/mAP50',     'metrics/mAP50(B)',    'metrics/mAP_0.5']     },
  { label: 'BBox mAP50-95',  keys: ['box/mAP50-95',  'metrics/mAP50-95(B)', 'metrics/mAP_0.5:0.95'] },
  { label: 'BBox Precision', keys: ['box/precision', 'metrics/precision(B)','metrics/precision']    },
  { label: 'BBox Recall',    keys: ['box/recall',    'metrics/recall(B)',   'metrics/recall']       },
  { label: 'Mask mAP50',     keys: ['seg/mAP50',     'metrics/mAP50(M)'],     maskOnly: true },
  { label: 'Mask mAP50-95',  keys: ['seg/mAP50-95',  'metrics/mAP50-95(M)'],  maskOnly: true },
  { label: 'Mask Precision', keys: ['seg/precision', 'metrics/precision(M)'], maskOnly: true },
  { label: 'Mask Recall',    keys: ['seg/recall',    'metrics/recall(M)'],    maskOnly: true },
];

// ── Entry point ───────────────────────────────────────────────────────────────

export function renderTester(container) {
  _container = container;
  container.innerHTML = _buildHTML();
  _wireEvents();
  _restoreState();
}

// ── HTML ──────────────────────────────────────────────────────────────────────

function _buildHTML() {
  return `
    <div class="tst-root">

      <!-- Error box -->
      <div id="tst-error-box" class="mt-error-box hidden">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.4rem;">
          <span style="font-weight:600;color:var(--error);">Error</span>
          <button class="btn btn-ghost btn-sm" id="tst-error-close">✕</button>
        </div>
        <pre id="tst-error-text" class="mt-error-pre"></pre>
      </div>

      <!-- Server toolbar -->
      <div class="mt-toolbar tst-toolbar">
        <span class="text-dim" style="font-size:12px;">Server:</span>
        <input type="text" id="tst-server-url" class="mt-cfg-input"
               style="width:16rem;font-size:12px;" value="${escHtml(_serverUrl)}" />
        <button class="btn btn-ghost btn-sm" id="tst-connect-btn">Connect</button>
        <span id="tst-connect-status" class="tst-connect-status disconnected">● Disconnected</span>
        <div class="mt-toolbar-sep"></div>
        <button class="btn btn-primary btn-sm" id="tst-run-btn" disabled>▶ Run Evaluation</button>
        <button class="btn btn-ghost btn-sm hidden" id="tst-stop-btn">■ Stop</button>
      </div>

      <!-- Tab bar -->
      <div class="mt-trn-tabbar">
        <button class="mt-trn-tab active" data-tst-tab="config">Config</button>
        <button class="mt-trn-tab"        data-tst-tab="results">Results</button>
        <button class="mt-trn-tab"        data-tst-tab="threshold">Optimal Threshold</button>
      </div>

      <!-- Config panel -->
      <div id="tst-panel-config" class="mt-trn-panel tst-config-panel">
        <div class="tst-two-col">

          <!-- Left: configuration -->
          <div class="tst-config-col">

            <!-- Model source -->
            <div class="tst-section">
              <div class="tst-section-title" style="display:flex;align-items:center;justify-content:space-between;">
                <span>Models</span>
                <div style="display:flex;gap:.4rem;">
                  <button class="btn btn-ghost btn-sm" id="tst-registry-refresh-btn" title="Refresh registry">↻</button>
                  <button class="btn btn-ghost btn-sm" id="tst-add-model-btn" title="Add another model to compare">+ Add Model</button>
                </div>
              </div>
              <div id="tst-model-list" class="tst-model-list">
                ${_modelRowHTML()}
              </div>
              <p class="text-dim" style="font-size:11px;margin:.4rem 0 0;">
                Add multiple models to evaluate them all against the same test split and compare results.
              </p>
            </div>

            <!-- Dataset -->
            <div class="tst-section">
              <div class="tst-section-title">Test Dataset</div>
              <div class="mt-cfg-field">
                <label class="mt-cfg-label">Dataset Folder</label>
                <div style="display:flex;gap:.4rem;">
                  <input type="text" id="tst-data-dir" class="mt-cfg-input" style="flex:1;"
                         placeholder="Local path to dataset root" />
                  <button class="btn btn-ghost btn-sm" id="tst-data-dir-browse" title="Browse for folder">&#128194;</button>
                </div>
              </div>
              <div class="mt-cfg-field">
                <label class="mt-cfg-label">YAML Config File</label>
                <div style="display:flex;gap:.4rem;">
                  <input type="text" id="tst-yaml-path" class="mt-cfg-input" style="flex:1;"
                         placeholder="Auto-detected if blank" />
                  <button class="btn btn-ghost btn-sm" id="tst-yaml-browse" title="Browse for YAML">&#128194;</button>
                </div>
              </div>
            </div>

            <!-- Options -->
            <div class="tst-section">
              <div class="tst-section-title">Options</div>
              <div class="tst-options-grid">
                <div class="mt-cfg-field">
                  <label class="mt-cfg-label">Split</label>
                  <select id="tst-split" class="mt-cfg-input">
                    <option value="test">test</option>
                    <option value="val">val</option>
                  </select>
                </div>
                <div class="mt-cfg-field">
                  <label class="mt-cfg-label">Conf Threshold</label>
                  <input type="number" id="tst-conf" class="mt-cfg-input" value="0.001" min="0" max="1" step="0.001" />
                </div>
                <div class="mt-cfg-field">
                  <label class="mt-cfg-label">IoU Threshold</label>
                  <input type="number" id="tst-iou" class="mt-cfg-input" value="0.6" min="0" max="1" step="0.05" />
                </div>
              </div>
            </div>

          </div><!-- /left -->

          <!-- Right: console -->
          <div class="tst-console-col">
            <div class="tst-section" style="flex:1;display:flex;flex-direction:column;">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.4rem;">
                <span class="tst-section-title" style="margin:0;">Console</span>
                <button class="btn btn-ghost btn-sm" id="tst-copy-log-btn">Copy</button>
              </div>
              <div class="mt-console-progress-row hidden" id="tst-progress-row">
                <div class="progress-bar" style="flex:1;">
                  <div class="progress-fill" id="tst-progress-fill" style="width:0%;"></div>
                </div>
                <span id="tst-progress-text" class="mt-console-run-label">Running…</span>
              </div>
              <pre id="tst-console-log" class="mt-console-log" style="flex:1;min-height:200px;"></pre>
            </div>
          </div><!-- /right -->

        </div><!-- /two-col -->
      </div><!-- /config panel -->

      <!-- Results panel -->
      <div id="tst-panel-results" class="mt-trn-panel hidden tst-results-panel">
        <div id="tst-results-content" class="mt-pm-content">
          <p class="text-dim mt-pm-placeholder">Run an evaluation to see results.</p>
        </div>
      </div>

      <!-- Optimal Threshold panel -->
      <div id="tst-panel-threshold" class="mt-trn-panel hidden tst-threshold-panel">
        <div class="tst-thresh-layout">

          <div class="tst-section">
            <div class="tst-section-title">Model</div>
            <div class="mt-cfg-field">
              <label class="mt-cfg-label">From Registry (Drive)</label>
              <select id="tst-thresh-model-select" class="mt-cfg-input tst-model-select">
                <option value="">— load registry —</option>
              </select>
            </div>
            <div class="mt-cfg-field">
              <label class="mt-cfg-label">Or Local .pt File</label>
              <div style="display:flex;gap:.4rem;">
                <input type="text" id="tst-thresh-local-model" class="mt-cfg-input" style="flex:1;"
                       placeholder="Leave blank to use registry selection" />
                <button class="btn btn-ghost btn-sm" id="tst-thresh-local-model-browse" title="Browse for .pt file">&#128194;</button>
              </div>
            </div>
            <p class="text-dim" style="font-size:11px;margin:.4rem 0 0;">
              Uses the Dataset Folder, YAML, Split, and IoU Threshold from the Config tab. Runs a single
              validation pass to capture the full F1-vs-confidence curve and reports the confidence
              threshold that yields the highest F1 score.
            </p>
            <div style="display:flex;gap:.5rem;margin-top:.6rem;">
              <button class="btn btn-primary btn-sm" id="tst-thresh-run-btn" disabled>▶ Find Optimal Threshold</button>
              <button class="btn btn-ghost btn-sm hidden" id="tst-thresh-stop-btn">■ Stop</button>
            </div>
            <div class="mt-console-progress-row hidden" id="tst-thresh-progress-row" style="margin-top:.6rem;">
              <div class="progress-bar" style="flex:1;">
                <div class="progress-fill" id="tst-thresh-progress-fill" style="width:0%;"></div>
              </div>
              <span id="tst-thresh-progress-text" class="mt-console-run-label">Running…</span>
            </div>
            <pre id="tst-thresh-log" class="mt-console-log" style="margin-top:.4rem;max-height:120px;"></pre>
          </div>

          <div id="tst-thresh-results" class="mt-pm-content" style="padding:0;">
            <p class="text-dim mt-pm-placeholder">Run a search to see results.</p>
          </div>

        </div>
      </div>

    </div><!-- /tst-root -->
  `;
}

function _modelRowHTML() {
  return `
    <div class="tst-model-row">
      <div class="tst-model-row-fields">
        <div class="mt-cfg-field">
          <label class="mt-cfg-label">From Registry (Drive)</label>
          <select class="mt-cfg-input tst-model-select">
            <option value="">— load registry —</option>
          </select>
        </div>
        <div class="mt-cfg-field">
          <label class="mt-cfg-label">Or Local .pt File</label>
          <div style="display:flex;gap:.4rem;">
            <input type="text" class="mt-cfg-input tst-local-model" style="flex:1;"
                   placeholder="Leave blank to use registry selection" />
            <button class="btn btn-ghost btn-sm tst-local-model-browse" title="Browse for .pt file">&#128194;</button>
          </div>
        </div>
      </div>
      <button class="btn btn-ghost btn-sm tst-remove-model hidden" title="Remove model">✕</button>
    </div>`;
}

// ── Wire events ───────────────────────────────────────────────────────────────

function _wireEvents() {
  document.getElementById('tst-error-close').addEventListener('click', () => {
    document.getElementById('tst-error-box').classList.add('hidden');
  });

  document.querySelectorAll('[data-tst-tab]').forEach(btn => {
    btn.addEventListener('click', () => _switchTab(btn.dataset.tstTab));
  });

  document.getElementById('tst-connect-btn').addEventListener('click', _toggleConnect);

  document.getElementById('tst-run-btn').addEventListener('click', _runEvaluation);
  document.getElementById('tst-stop-btn').addEventListener('click', _stopEvaluation);

  document.getElementById('tst-registry-refresh-btn').addEventListener('click', _loadRegistry);

  document.getElementById('tst-copy-log-btn').addEventListener('click', () => {
    const txt = document.getElementById('tst-console-log')?.textContent ?? '';
    navigator.clipboard.writeText(txt)
      .then(() => toast('Log copied', 'success'))
      .catch(() => toast('Copy failed', 'error'));
  });

  // Model rows (add / remove / browse local .pt)
  document.getElementById('tst-add-model-btn').addEventListener('click', _addModelRow);
  document.getElementById('tst-model-list').addEventListener('click', async (e) => {
    const removeBtn = e.target.closest('.tst-remove-model');
    if (removeBtn) {
      const rows = document.querySelectorAll('#tst-model-list .tst-model-row');
      if (rows.length > 1) {
        removeBtn.closest('.tst-model-row').remove();
        _updateRemoveButtons();
      }
      return;
    }
    const browseBtn = e.target.closest('.tst-local-model-browse');
    if (browseBtn) {
      if (!_connected) { toast('Connect to server first', 'error'); return; }
      try {
        const res  = await _serverFetch(`${_serverUrl}/browse-file?ext=pt`);
        const data = await res.json();
        if (data.path) browseBtn.closest('.tst-model-row').querySelector('.tst-local-model').value = data.path;
      } catch (err) { toast(`Browse failed: ${err.message}`, 'error'); }
    }
  });
  _updateRemoveButtons();

  // Browse buttons (single fields)
  document.getElementById('tst-data-dir-browse').addEventListener('click', async () => {
    if (!_connected) { toast('Connect to server first', 'error'); return; }
    try {
      const res  = await _serverFetch(`${_serverUrl}/browse-folder`);
      const data = await res.json();
      if (data.path) document.getElementById('tst-data-dir').value = data.path;
    } catch (e) { toast(`Browse failed: ${e.message}`, 'error'); }
  });

  document.getElementById('tst-yaml-browse').addEventListener('click', async () => {
    if (!_connected) { toast('Connect to server first', 'error'); return; }
    try {
      const res  = await _serverFetch(`${_serverUrl}/browse-file?ext=yaml`);
      const data = await res.json();
      if (data.path) document.getElementById('tst-yaml-path').value = data.path;
    } catch (e) { toast(`Browse failed: ${e.message}`, 'error'); }
  });

  // Dynamic results-panel buttons (download CSV)
  document.getElementById('tst-results-content').addEventListener('click', (e) => {
    if (e.target.closest('#tst-download-csv-btn')) _downloadCSV();
  });

  // Optimal threshold tab
  document.getElementById('tst-thresh-run-btn').addEventListener('click', _runThresholdSearch);
  document.getElementById('tst-thresh-stop-btn').addEventListener('click', _stopThresholdSearch);
  document.getElementById('tst-thresh-local-model-browse').addEventListener('click', async () => {
    if (!_connected) { toast('Connect to server first', 'error'); return; }
    try {
      const res  = await _serverFetch(`${_serverUrl}/browse-file?ext=pt`);
      const data = await res.json();
      if (data.path) document.getElementById('tst-thresh-local-model').value = data.path;
    } catch (e) { toast(`Browse failed: ${e.message}`, 'error'); }
  });
}

// ── Model row management ─────────────────────────────────────────────────────

function _addModelRow() {
  const list = document.getElementById('tst-model-list');
  const wrap = document.createElement('div');
  wrap.innerHTML = _modelRowHTML();
  const row = wrap.firstElementChild;
  list.appendChild(row);
  _populateModelSelect(row.querySelector('.tst-model-select'));
  _updateRemoveButtons();
}

function _updateRemoveButtons() {
  const rows = document.querySelectorAll('#tst-model-list .tst-model-row');
  rows.forEach(row => {
    row.querySelector('.tst-remove-model').classList.toggle('hidden', rows.length <= 1);
  });
}

function _getModelEntries() {
  const rows    = document.querySelectorAll('#tst-model-list .tst-model-row');
  const entries = [];
  rows.forEach(row => {
    const sel       = row.querySelector('.tst-model-select');
    const local     = row.querySelector('.tst-local-model').value.trim();
    const modelId   = sel?.value ?? '';
    const modelName = sel?.selectedOptions[0]?.dataset.name ?? '';

    if (local) {
      const displayName = local.split(/[\\/]/).pop() || local;
      entries.push({ displayName, payload: { model_file_id: '', model_name: displayName, local_model: local } });
    } else if (modelId) {
      const displayName = modelName || 'model.pt';
      entries.push({ displayName, payload: { model_file_id: modelId, model_name: displayName, local_model: '' } });
    }
  });

  // Disambiguate duplicate display names so comparison columns stay distinct.
  const counts = {};
  entries.forEach(e => { counts[e.displayName] = (counts[e.displayName] || 0) + 1; });
  const seen = {};
  entries.forEach(e => {
    if (counts[e.displayName] > 1) {
      seen[e.displayName] = (seen[e.displayName] || 0) + 1;
      e.displayName = `${e.displayName} (#${seen[e.displayName]})`;
    }
  });

  return entries;
}

// ── Tab switching ─────────────────────────────────────────────────────────────

function _switchTab(tab) {
  document.querySelectorAll('[data-tst-tab]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tstTab === tab);
  });
  document.getElementById('tst-panel-config').classList.toggle('hidden',    tab !== 'config');
  document.getElementById('tst-panel-results').classList.toggle('hidden',   tab !== 'results');
  document.getElementById('tst-panel-threshold').classList.toggle('hidden', tab !== 'threshold');
}

// ── Server connection ─────────────────────────────────────────────────────────

async function _toggleConnect() {
  const urlInput = document.getElementById('tst-server-url');
  if (_connected) {
    _connected = false;
    _serverUrl = urlInput.value.trim().replace(/\/$/, '');
    _setConnectStatus(false);
    return;
  }
  _serverUrl = urlInput.value.trim().replace(/\/$/, '');
  localStorage.setItem('pavement_tester_server_url', _serverUrl);
  try {
    const res = await fetch(`${_serverUrl}/ping`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    _connected = true;
    _setConnectStatus(true);
    _loadRegistry();
  } catch {
    toast('Could not reach server — is trainer_server.py running?', 'error');
    _setConnectStatus(false);
  }
}

function _setConnectStatus(connected) {
  const el     = document.getElementById('tst-connect-status');
  const btn    = document.getElementById('tst-connect-btn');
  const run    = document.getElementById('tst-run-btn');
  const thresh = document.getElementById('tst-thresh-run-btn');
  el.textContent = connected ? '● Connected' : '● Disconnected';
  el.className   = `tst-connect-status ${connected ? 'connected' : 'disconnected'}`;
  btn.textContent = connected ? 'Disconnect' : 'Connect';
  run.disabled    = !connected;
  thresh.disabled = !connected;
}

// ── Registry ──────────────────────────────────────────────────────────────────

async function _loadRegistry() {
  const selects = document.querySelectorAll('.tst-model-select');
  if (!selects.length) return;
  selects.forEach(s => s.innerHTML = '<option value="">— loading… —</option>');

  const token   = getToken();
  const project = getCurrentProject();
  if (!token || !project) {
    selects.forEach(s => s.innerHTML = '<option value="">— sign in and open a project —</option>');
    return;
  }

  try {
    const folder = await getProjectModelsFolder(token);
    if (!folder) { selects.forEach(s => s.innerHTML = '<option value="">— models folder not found —</option>'); return; }

    const all    = await listAllFiles(token, `'${folder.id}' in parents and trashed=false`, 'id,name,size,createdTime');
    const models = all.filter(f => f.name.endsWith('.pt'))
                      .sort((a, b) => b.createdTime?.localeCompare(a.createdTime ?? '') ?? 0);

    _registryModels = models;
    if (!models.length) {
      selects.forEach(s => s.innerHTML = '<option value="">— no .pt models in registry —</option>');
      return;
    }
    selects.forEach(s => _populateModelSelect(s));
  } catch (err) {
    selects.forEach(s => s.innerHTML = '<option value="">— error loading registry —</option>');
    toast(`Registry load failed: ${err.message}`, 'error');
  }
}

function _populateModelSelect(sel) {
  if (!_registryModels) {
    sel.innerHTML = '<option value="">— load registry —</option>';
    return;
  }
  if (!_registryModels.length) {
    sel.innerHTML = '<option value="">— no .pt models in registry —</option>';
    return;
  }
  const current = sel.value;
  sel.innerHTML = '<option value="">— select a model —</option>' +
    _registryModels.map(m => `<option value="${escHtml(m.id)}" data-name="${escHtml(m.name)}">${escHtml(m.name)}</option>`).join('');
  if (current) sel.value = current;
}

// ── Run / Stop ────────────────────────────────────────────────────────────────

async function _runEvaluation() {
  _hideError();
  const token = getToken();
  if (!token) { toast('Not signed in', 'error'); return; }

  const testDataDir = document.getElementById('tst-data-dir').value.trim();
  if (!testDataDir) { toast('Enter a dataset folder path', 'error'); return; }

  const models = _getModelEntries();
  if (!models.length) { toast('Select a model from the registry or enter a local .pt path', 'error'); return; }

  const baseConfig = {
    drive_token:   token,
    test_data_dir: testDataDir,
    yaml_path:     document.getElementById('tst-yaml-path').value.trim(),
    split:         document.getElementById('tst-split').value,
    conf:          parseFloat(document.getElementById('tst-conf').value) || 0.001,
    iou:           parseFloat(document.getElementById('tst-iou').value)  || 0.6,
  };

  _results       = [];
  _stopRequested = false;

  const log         = document.getElementById('tst-console-log');
  const fill        = document.getElementById('tst-progress-fill');
  const progressTxt = document.getElementById('tst-progress-text');

  log.textContent = '';
  document.getElementById('tst-progress-row').classList.remove('hidden');
  fill.style.transition = 'none';
  fill.style.width = '0%';
  progressTxt.textContent = 'Starting…';
  document.getElementById('tst-results-content').innerHTML =
    '<p class="text-dim mt-pm-placeholder">Run an evaluation to see results.</p>';

  document.getElementById('tst-run-btn').classList.add('hidden');
  document.getElementById('tst-stop-btn').classList.remove('hidden');
  _setConfigBusy(true);
  _setGlobalBusy(true);

  let logSoFar = '';

  for (let i = 0; i < models.length; i++) {
    if (_stopRequested) break;
    const m = models[i];

    logSoFar += (logSoFar ? '\n' : '') + `=== [${i + 1}/${models.length}] ${m.displayName} ===\n`;
    log.textContent = logSoFar;
    progressTxt.textContent = `Model ${i + 1}/${models.length}: ${m.displayName} — Starting…`;
    fill.style.transition = 'none';
    fill.style.width = `${Math.round((i / models.length) * 100)}%`;

    try {
      await _serverFetch(`${_serverUrl}/test`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ...baseConfig, ...m.payload }),
        signal:  AbortSignal.timeout(10000),
      });
    } catch (err) {
      logSoFar += `Error: ${err.message}\n`;
      log.textContent = logSoFar;
      _showError(`${m.displayName}: ${err.message}`);
      continue;
    }

    const data = await _pollUntilDone(i, models.length, m.displayName, (lines) => {
      log.textContent = logSoFar + lines;
      log.scrollTop   = log.scrollHeight;
    });

    logSoFar += (Array.isArray(data.log) ? data.log.join('\n') : '') + '\n';
    log.textContent = logSoFar;

    if (data.state === 'done') {
      _results.push({
        name:              m.displayName,
        metrics:           data.metrics           || {},
        class_metrics:     data.class_metrics     || {},
        class_metrics_seg: data.class_metrics_seg || {},
        images:            data.images            || {},
      });
    } else if (data.state === 'stopped') {
      progressTxt.textContent = 'Stopped';
      break;
    } else if (data.state === 'error') {
      const errMsg = data.log?.find(l => l.startsWith('Error:')) ?? `${m.displayName}: evaluation failed`;
      _showError(errMsg);
    }
  }

  fill.style.transition = 'none';
  fill.style.width = '100%';
  if (!_stopRequested && progressTxt.textContent !== 'Stopped') progressTxt.textContent = 'Complete';
  _resetRunButtons();

  if (_results.length) {
    _renderResults();
    _switchTab('results');
    toast(`Evaluation complete (${_results.length}/${models.length} model${models.length > 1 ? 's' : ''})`, 'success');
  } else {
    toast('Evaluation finished with no successful results', 'error');
  }
}

async function _stopEvaluation() {
  _stopRequested = true;
  try {
    await fetch(`${_serverUrl}/test-stop`, { method: 'POST' });
  } catch { /* ignore */ }
}

// ── Polling ───────────────────────────────────────────────────────────────────

async function _pollUntilDone(idx, total, displayName, onLog) {
  const fill        = document.getElementById('tst-progress-fill');
  const progressTxt = document.getElementById('tst-progress-text');

  while (true) {
    if (_stopRequested) return { state: 'stopped', log: [] };

    await new Promise(r => setTimeout(r, 2000));

    let data;
    try {
      const res = await fetch(`${_serverUrl}/test-status`, { signal: AbortSignal.timeout(5000) });
      data = await res.json();
    } catch {
      continue; // server temporarily unreachable
    }

    if (Array.isArray(data.log)) onLog(data.log.join('\n'));

    if (data.state === 'running') {
      const base = (idx / total) * 100;
      const span = 100 / total;
      fill.style.transition = 'width 2s ease';
      fill.style.width = `${Math.min(base + span * 0.6, 100)}%`;
      progressTxt.textContent = `Model ${idx + 1}/${total}: ${displayName} — Running…`;
    }

    if (data.state === 'done') {
      progressTxt.textContent = `Model ${idx + 1}/${total}: ${displayName} — Done`;
      return data;
    }
    if (data.state === 'stopped' || data.state === 'error') {
      return data;
    }
  }
}

function _resetRunButtons() {
  document.getElementById('tst-run-btn').classList.remove('hidden');
  document.getElementById('tst-stop-btn').classList.add('hidden');
  _setConfigBusy(false);
  _setGlobalBusy(false);
}

function _setConfigBusy(busy) {
  const col = document.querySelector('.tst-config-col');
  if (!col) return;
  col.classList.toggle('tst-config-busy', busy);
  col.querySelectorAll('input, select, button').forEach(el => { el.disabled = busy; });
}

// Mutually-exclusive run buttons: evaluation and threshold search can't run at once.
function _setGlobalBusy(busy) {
  const run    = document.getElementById('tst-run-btn');
  const thresh = document.getElementById('tst-thresh-run-btn');
  if (run)    run.disabled    = busy || !_connected;
  if (thresh) thresh.disabled = busy || !_connected;
}

// ── Optimal threshold search ─────────────────────────────────────────────────

function _getThresholdModel() {
  const sel   = document.getElementById('tst-thresh-model-select');
  const local = document.getElementById('tst-thresh-local-model').value.trim();
  const modelId   = sel?.value ?? '';
  const modelName = sel?.selectedOptions[0]?.dataset.name ?? '';

  if (local) {
    const displayName = local.split(/[\\/]/).pop() || local;
    return { displayName, payload: { model_file_id: '', model_name: displayName, local_model: local } };
  }
  if (modelId) {
    return { displayName: modelName || 'model.pt', payload: { model_file_id: modelId, model_name: modelName || 'model.pt', local_model: '' } };
  }
  return null;
}

async function _runThresholdSearch() {
  _hideError();
  const token = getToken();
  if (!token) { toast('Not signed in', 'error'); return; }

  const testDataDir = document.getElementById('tst-data-dir').value.trim();
  if (!testDataDir) { toast('Enter a dataset folder path in the Config tab', 'error'); return; }

  const model = _getThresholdModel();
  if (!model) { toast('Select a model from the registry or enter a local .pt path', 'error'); return; }

  const payload = {
    drive_token:   token,
    test_data_dir: testDataDir,
    yaml_path:     document.getElementById('tst-yaml-path').value.trim(),
    split:         document.getElementById('tst-split').value,
    iou:           parseFloat(document.getElementById('tst-iou').value) || 0.6,
    ...model.payload,
  };

  const log         = document.getElementById('tst-thresh-log');
  const fill        = document.getElementById('tst-thresh-progress-fill');
  const progressTxt = document.getElementById('tst-thresh-progress-text');
  const resultsEl   = document.getElementById('tst-thresh-results');

  log.textContent = '';
  resultsEl.innerHTML = '<p class="text-dim mt-pm-placeholder">Run a search to see results.</p>';
  document.getElementById('tst-thresh-progress-row').classList.remove('hidden');
  fill.style.transition = 'none';
  fill.style.width = '0%';
  progressTxt.textContent = 'Starting…';

  document.getElementById('tst-thresh-run-btn').classList.add('hidden');
  document.getElementById('tst-thresh-stop-btn').classList.remove('hidden');
  _threshStopRequested = false;
  _setGlobalBusy(true);

  try {
    await _serverFetch(`${_serverUrl}/optimize-threshold`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      signal:  AbortSignal.timeout(10000),
    });
  } catch (err) {
    _showError(err.message);
    _resetThresholdButtons();
    return;
  }

  const data = await _pollThresholdUntilDone((lines) => {
    log.textContent = lines;
    log.scrollTop   = log.scrollHeight;
  });

  fill.style.transition = 'none';

  if (data.state === 'done') {
    fill.style.width = '100%';
    progressTxt.textContent = 'Complete';
    _renderThresholdResults(data);
    toast('Optimal threshold found', 'success');
  } else if (data.state === 'stopped') {
    progressTxt.textContent = 'Stopped';
  } else if (data.state === 'error') {
    progressTxt.textContent = 'Error';
    const errMsg = data.log?.find(l => l.startsWith('Error:')) ?? 'Threshold search failed';
    _showError(errMsg);
    toast('Threshold search error — see error box', 'error');
  }

  _resetThresholdButtons();
}

async function _stopThresholdSearch() {
  _threshStopRequested = true;
  try {
    await fetch(`${_serverUrl}/optimize-threshold-stop`, { method: 'POST' });
  } catch { /* ignore */ }
}

async function _pollThresholdUntilDone(onLog) {
  const fill        = document.getElementById('tst-thresh-progress-fill');
  const progressTxt = document.getElementById('tst-thresh-progress-text');

  while (true) {
    if (_threshStopRequested) return { state: 'stopped', log: [] };

    await new Promise(r => setTimeout(r, 2000));

    let data;
    try {
      const res = await fetch(`${_serverUrl}/optimize-threshold-status`, { signal: AbortSignal.timeout(5000) });
      data = await res.json();
    } catch {
      continue; // server temporarily unreachable
    }

    if (Array.isArray(data.log)) onLog(data.log.join('\n'));

    if (data.state === 'running') {
      fill.style.transition = 'width 2s ease';
      fill.style.width = '60%';
      progressTxt.textContent = 'Running…';
    }

    if (data.state === 'done' || data.state === 'stopped' || data.state === 'error') return data;
  }
}

function _resetThresholdButtons() {
  document.getElementById('tst-thresh-run-btn').classList.remove('hidden');
  document.getElementById('tst-thresh-stop-btn').classList.add('hidden');
  _setGlobalBusy(false);
}

function _renderThresholdResults(data) {
  const resultsEl = document.getElementById('tst-thresh-results');
  if (!resultsEl) return;

  const box = data.box;
  const seg = data.seg;
  if (!box) {
    resultsEl.innerHTML = '<p class="text-dim mt-pm-placeholder">No F1 curve data returned.</p>';
    return;
  }

  const fmt = v => v != null ? v.toFixed(4) : '—';

  const tiles = [
    { label: 'Optimal Confidence', val: fmt(box.best_conf), accent: true },
    { label: 'BBox F1',            val: fmt(box.best_f1) },
    { label: 'BBox Precision',     val: fmt(box.best_precision) },
    { label: 'BBox Recall',        val: fmt(box.best_recall) },
  ];
  if (seg) {
    tiles.push(
      { label: 'Mask F1',        val: fmt(seg.best_f1) },
      { label: 'Mask Precision', val: fmt(seg.best_precision) },
      { label: 'Mask Recall',    val: fmt(seg.best_recall) },
    );
  }
  const tilesHTML = tiles.map(t => `
    <div class="mt-lm-stat-tile${t.accent ? ' mt-pm-tile-accent' : ''}">
      <span class="mt-lm-stat-label">${t.label}</span>
      <span class="mt-lm-stat-val">${t.val}</span>
    </div>`).join('');

  const makeClassTable = (perClass) => {
    if (!perClass || !Object.keys(perClass).length) return '';
    const rows = Object.entries(perClass).map(([name, c]) =>
      `<tr><td>${escHtml(name)}</td><td>${c.precision.toFixed(4)}</td><td>${c.recall.toFixed(4)}</td><td>${c.f1.toFixed(4)}</td></tr>`
    ).join('');
    return `<table class="summary-table">
      <thead><tr><th>Class</th><th>Precision</th><th>Recall</th><th>F1</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  };

  let classHTML = '';
  if (Object.keys(box.per_class || {}).length) {
    classHTML += `<div class="mt-lm-section-title" style="margin-top:.75rem;">Per-Class — Bounding Box (at optimal threshold)</div>${makeClassTable(box.per_class)}`;
  }
  if (seg && Object.keys(seg.per_class || {}).length) {
    classHTML += `<div class="mt-lm-section-title" style="margin-top:.75rem;">Per-Class — Segmentation Mask (at optimal threshold)</div>${makeClassTable(seg.per_class)}`;
  }

  const imgEntries = Object.entries(data.images || {});
  const imagesHTML = imgEntries.length
    ? imgEntries.map(([name, src]) => `
        <div class="mt-pm-img-wrap">
          <p class="mt-chart-title">${_PM_IMAGE_LABELS[name] || name}</p>
          <img src="${src}" alt="${escHtml(name)}" class="mt-pm-img" loading="lazy" />
        </div>`).join('')
    : '';

  resultsEl.innerHTML = `
    <div class="mt-pm-section" style="border-top:none;padding-top:0;">
      <div class="mt-lm-stats-row">${tilesHTML}</div>
      <div class="mt-lm-section-title">F1 / Precision / Recall vs. Confidence</div>
      <div class="tst-thresh-chart-wrap"><canvas id="tst-thresh-chart"></canvas></div>
    </div>
    ${classHTML ? `<div class="mt-pm-section">${classHTML}</div>` : ''}
    ${imagesHTML ? `<div class="mt-pm-section"><div class="mt-pm-img-grid">${imagesHTML}</div></div>` : ''}
  `;

  _renderThresholdChart(box);
}

function _renderThresholdChart(box) {
  const canvas = document.getElementById('tst-thresh-chart');
  if (!canvas || !window.Chart) return;

  const { conf, f1, precision, recall } = box.curve || {};
  if (!conf?.length) return;

  let optIdx = 0;
  for (let i = 1; i < conf.length; i++) {
    if (Math.abs(conf[i] - box.best_conf) < Math.abs(conf[optIdx] - box.best_conf)) optIdx = i;
  }
  const marker = conf.map((_, i) => i === optIdx ? f1[optIdx] : null);

  if (_threshChart) { _threshChart.destroy(); _threshChart = null; }
  _threshChart = new window.Chart(canvas, {
    type: 'line',
    data: {
      labels: conf,
      datasets: [
        { label: 'F1',        data: f1,        borderColor: '#4ec9b0', borderWidth: 2,   pointRadius: 0, tension: 0.2 },
        { label: 'Precision', data: precision, borderColor: '#007acc', borderWidth: 1.5, pointRadius: 0, tension: 0.2, borderDash: [4, 3] },
        { label: 'Recall',    data: recall,    borderColor: '#f44747', borderWidth: 1.5, pointRadius: 0, tension: 0.2, borderDash: [4, 3] },
        {
          label: `Optimal (conf=${box.best_conf.toFixed(3)})`, data: marker, showLine: false,
          pointRadius: 6, pointBackgroundColor: '#dcdcaa', pointBorderColor: '#dcdcaa',
        },
      ],
    },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend:  { labels: { color: '#888', font: { size: 11 }, boxWidth: 12, padding: 8 } },
        tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y?.toFixed(4) ?? '—'}` } },
      },
      scales: {
        x: {
          ticks: { color: '#888', font: { size: 10 }, maxTicksLimit: 10 },
          grid:  { color: '#3e3e42' },
          title: { display: true, text: 'Confidence', color: '#666', font: { size: 10 } },
        },
        y: {
          ticks: { color: '#888', font: { size: 10 } },
          grid:  { color: '#3e3e42' },
          min: 0, max: 1,
          title: { display: true, text: 'Score', color: '#666', font: { size: 10 } },
        },
      },
    },
  });
}

// ── Render results ────────────────────────────────────────────────────────────

function _getMetricVal(metrics, keys) {
  for (const k of keys) if (metrics?.[k] != null) return metrics[k];
  return null;
}

function _renderResults() {
  const content = document.getElementById('tst-results-content');
  if (!content) return;

  if (!_results.length) {
    content.innerHTML = '<p class="text-dim mt-pm-placeholder">Run an evaluation to see results.</p>';
    return;
  }

  const cmpHTML     = _buildComparisonTable(_results);
  const detailsHTML = _results.map(r => _buildModelDetail(r)).join('');

  content.innerHTML = `
    <div class="mt-pm-section" style="border-top:none;padding-top:0;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.5rem;">
        <div class="mt-lm-section-title" style="margin:0;">Model Comparison</div>
        <button class="btn btn-primary btn-sm" id="tst-download-csv-btn">&#8595; Download CSV</button>
      </div>
      ${cmpHTML}
    </div>
    ${detailsHTML}`;
}

function _buildComparisonTable(results) {
  const fmt = v => v != null ? v.toFixed(4) : '—';

  const hasMask = results.some(r =>
    _OVERALL_METRICS.filter(m => m.maskOnly).some(m => _getMetricVal(r.metrics, m.keys) != null));
  const metricDefs = _OVERALL_METRICS.filter(m => !m.maskOnly || hasMask);

  const header = `<tr><th>Metric</th>${results.map(r => `<th>${escHtml(r.name)}</th>`).join('')}</tr>`;
  const body = metricDefs.map(def => {
    const cells = results.map(r => `<td>${fmt(_getMetricVal(r.metrics, def.keys))}</td>`).join('');
    return `<tr><td>${def.label}</td>${cells}</tr>`;
  }).join('');

  return `<div class="tst-cmp-table-wrap"><table class="summary-table tst-cmp-table">
    <thead>${header}</thead><tbody>${body}</tbody>
  </table></div>`;
}

function _buildModelDetail(r) {
  const makeTable = (obj) => {
    if (!obj || !Object.keys(obj).length) return '';
    const rows = Object.entries(obj).map(([name, c]) =>
      `<tr><td>${escHtml(name)}</td>` +
      `<td>${c.p.toFixed(4)}</td><td>${c.r.toFixed(4)}</td>` +
      `<td>${c.ap50.toFixed(4)}</td><td>${c.ap.toFixed(4)}</td></tr>`
    ).join('');
    return `<table class="summary-table">
      <thead><tr><th>Class</th><th>Precision</th><th>Recall</th><th>mAP50</th><th>mAP50-95</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  };

  const hasBbox = r.class_metrics     && Object.keys(r.class_metrics).length;
  const hasSeg  = r.class_metrics_seg && Object.keys(r.class_metrics_seg).length;
  let classHTML = '';
  if (hasBbox) classHTML += `<div class="mt-lm-section-title" style="margin-top:.75rem;">Per-Class — Bounding Box</div>${makeTable(r.class_metrics)}`;
  if (hasSeg)  classHTML += `<div class="mt-lm-section-title" style="margin-top:.75rem;">Per-Class — Segmentation Mask</div>${makeTable(r.class_metrics_seg)}`;

  const imgEntries = Object.entries(r.images || {});
  const imagesHTML = imgEntries.length
    ? imgEntries.map(([name, src]) => `
        <div class="mt-pm-img-wrap">
          <p class="mt-chart-title">${_PM_IMAGE_LABELS[name] || name}</p>
          <img src="${src}" alt="${escHtml(name)}" class="mt-pm-img" loading="lazy" />
        </div>`).join('')
    : '<p class="text-dim mt-pm-placeholder" style="grid-column:1/-1;">No result images generated.</p>';

  return `
    <details class="tst-model-detail mt-pm-section">
      <summary class="tst-model-summary">${escHtml(r.name)}</summary>
      ${classHTML}
      <div class="mt-pm-img-grid">${imagesHTML}</div>
    </details>`;
}

// ── CSV export ────────────────────────────────────────────────────────────────

function _downloadCSV() {
  if (!_results.length) return;

  const bboxClasses = new Set();
  const segClasses  = new Set();
  _results.forEach(r => {
    Object.keys(r.class_metrics     || {}).forEach(c => bboxClasses.add(c));
    Object.keys(r.class_metrics_seg || {}).forEach(c => segClasses.add(c));
  });
  const bboxClassList = [...bboxClasses].sort();
  const segClassList  = [...segClasses].sort();

  const hasMask = _results.some(r =>
    _OVERALL_METRICS.filter(m => m.maskOnly).some(m => _getMetricVal(r.metrics, m.keys) != null));
  const overallMetrics = _OVERALL_METRICS.filter(m => !m.maskOnly || hasMask);

  const header = ['Model', ...overallMetrics.map(m => m.label)];
  bboxClassList.forEach(c => header.push(
    `${c} (Box) Precision`, `${c} (Box) Recall`, `${c} (Box) mAP50`, `${c} (Box) mAP50-95`));
  segClassList.forEach(c => header.push(
    `${c} (Mask) Precision`, `${c} (Mask) Recall`, `${c} (Mask) mAP50`, `${c} (Mask) mAP50-95`));

  const rows = _results.map(r => {
    const row = [r.name];
    overallMetrics.forEach(m => row.push(_csvVal(_getMetricVal(r.metrics, m.keys))));
    bboxClassList.forEach(c => {
      const cm = r.class_metrics?.[c];
      row.push(_csvVal(cm?.p), _csvVal(cm?.r), _csvVal(cm?.ap50), _csvVal(cm?.ap));
    });
    segClassList.forEach(c => {
      const cm = r.class_metrics_seg?.[c];
      row.push(_csvVal(cm?.p), _csvVal(cm?.r), _csvVal(cm?.ap50), _csvVal(cm?.ap));
    });
    return row;
  });

  const csv = [header, ...rows].map(row => row.map(_csvEscape).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `model-comparison-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function _csvVal(v) {
  return v != null ? v : '';
}

function _csvEscape(val) {
  const s = String(val ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ── Error helpers ─────────────────────────────────────────────────────────────

function _showError(msg) {
  const box  = document.getElementById('tst-error-box');
  const text = document.getElementById('tst-error-text');
  if (!box || !text) return;
  text.textContent = msg;
  box.classList.remove('hidden');
}

function _hideError() {
  document.getElementById('tst-error-box')?.classList.add('hidden');
}

// ── Server fetch ──────────────────────────────────────────────────────────────

async function _serverFetch(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    let msg = `HTTP ${res.status} ${res.statusText}`;
    try { const b = await res.json(); msg = b.error || b.traceback || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res;
}

// ── Restore state ─────────────────────────────────────────────────────────────

function _restoreState() {
  const saved = localStorage.getItem('pavement_tester_server_url');
  if (saved) {
    _serverUrl = saved;
    const input = document.getElementById('tst-server-url');
    if (input) input.value = saved;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
