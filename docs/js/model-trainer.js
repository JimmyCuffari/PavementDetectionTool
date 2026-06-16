import { getToken, refreshToken } from './auth.js';
import { findFolder, listAllFiles, upsertFile, deleteFile, renameFile } from './drive.js';
import { getCurrentProject, getProjectModelsFolder } from './project-manager.js';
import { getDatasetsForProject } from './dataset-manager.js';
import { makeSemaphore, toast } from './utils.js';

const LAUNCHER_PATH_KEY     = 'pavement_launcher_path';
const LAUNCHER_PROTOCOL_KEY = 'pavement_launcher_protocol_registered';
const GPU_DETECTED_KEY      = 'pavement_trainer_gpu_detected';

let _serverUrl    = 'http://localhost:7860';
let _connected    = false;
let _pollTimer    = null;
let _lastTokenRefresh = 0;
const _TOKEN_REFRESH_MS = 25 * 60 * 1000; // refresh drive token every 25 min
let _installTimer = null;
const _charts     = {};

let _configs     = [];
let _activeIdx   = 0;
let _trainQueue  = [];
let _trainingIdx = null;

let _modelRegistry     = [];
let _modelMetricsCache = {};
let _selectedModelIds  = new Set();
let _editingMetricsId  = null;
const _cmpCharts       = {};
const _MODEL_COLORS    = ['#007acc','#4ec9b0','#f44747','#dcdcaa','#c792ea','#89ddff','#ff9d00','#80ff80'];

const _PARAMS = [
  { id:'epochs',          label:'Epochs',          min:1,      max:1000,  step:1,      def:100,    group:'Training Basics' },
  { id:'imgsz',           label:'Image Size',      min:32,     max:1920,  step:32,     def:640,    group:'Training Basics' },
  { id:'batch',           label:'Batch',           min:1,      max:128,   step:1,      def:16,     group:'Training Basics' },
  { id:'lr0',             label:'LR (lr0)',        min:0.0001, max:0.1,   step:0.0001, def:0.01,   group:'Training Basics' },
  { id:'lrf',             label:'LR Final',        min:0.0001, max:0.1,   step:0.0001, def:0.01,   group:'Training Basics' },
  { id:'warmup_epochs',   label:'Warmup Epochs',   min:0,      max:10,    step:0.1,    def:3,      group:'Training Basics' },
  { id:'patience',        label:'Patience',        min:0,      max:500,   step:1,      def:50,     group:'Training Basics' },
  { id:'momentum',        label:'Momentum',        min:0,      max:1,     step:0.001,  def:0.937,  group:'Optimizer' },
  { id:'weight_decay',    label:'Weight Decay',    min:0,      max:0.01,  step:0.0001, def:0.0005, group:'Optimizer' },
  { id:'warmup_momentum', label:'Warmup Momentum', min:0,      max:1,     step:0.001,  def:0.8,    group:'Optimizer' },
  { id:'warmup_bias_lr',  label:'Warmup Bias LR',  min:0,      max:0.2,   step:0.001,  def:0.1,    group:'Optimizer' },
  { id:'nbs',             label:'Nominal Batch',   min:1,      max:512,   step:1,      def:64,     group:'Optimizer' },
  { id:'dropout',         label:'Dropout',         min:0,      max:1,     step:0.01,   def:0,      group:'Optimizer' },
  { id:'label_smoothing', label:'Label Smoothing', min:0,      max:1,     step:0.01,   def:0,      group:'Optimizer' },
  { id:'box',             label:'Box Loss',        min:0,      max:20,    step:0.1,    def:7.5,    group:'Loss Weights' },
  { id:'cls',             label:'Cls Loss',        min:0,      max:20,    step:0.1,    def:0.5,    group:'Loss Weights' },
  { id:'dfl',             label:'DFL Loss',        min:0,      max:10,    step:0.1,    def:1.5,    group:'Loss Weights' },
  { id:'hsv_h',           label:'HSV-H',           min:0,      max:1,     step:0.001,  def:0.015,  group:'Augmentation' },
  { id:'hsv_s',           label:'HSV-S',           min:0,      max:1,     step:0.001,  def:0.7,    group:'Augmentation' },
  { id:'hsv_v',           label:'HSV-V',           min:0,      max:1,     step:0.001,  def:0.4,    group:'Augmentation' },
  { id:'degrees',         label:'Degrees',         min:0,      max:180,   step:0.1,    def:0,      group:'Augmentation' },
  { id:'translate',       label:'Translate',       min:0,      max:0.9,   step:0.01,   def:0.1,    group:'Augmentation' },
  { id:'scale',           label:'Scale',           min:0,      max:0.9,   step:0.01,   def:0.5,    group:'Augmentation' },
  { id:'shear',           label:'Shear',           min:0,      max:180,   step:0.1,    def:0,      group:'Augmentation' },
  { id:'perspective',     label:'Perspective',     min:0,      max:0.001, step:0.0001, def:0,      group:'Augmentation' },
  { id:'flipud',          label:'Flip Up-Down',    min:0,      max:1,     step:0.01,   def:0,      group:'Augmentation' },
  { id:'fliplr',          label:'Flip Left-Right', min:0,      max:1,     step:0.01,   def:0.5,    group:'Augmentation' },
  { id:'mosaic',          label:'Mosaic',          min:0,      max:1,     step:0.01,   def:1,      group:'Augmentation' },
  { id:'mixup',           label:'Mixup',           min:0,      max:1,     step:0.01,   def:0,      group:'Augmentation' },
];

const _OPT_DESCS = {
  'auto':  'Auto — YOLO selects the best optimizer for the task.',
  'SGD':   'SGD — Stochastic Gradient Descent with Nesterov momentum. Good for large datasets.',
  'Adam':  'Adam — Adaptive Moment Estimation. Good default for most tasks.',
  'AdamW': 'AdamW — Adam with decoupled weight decay. Often best for fine-tuning.',
};

// ── Render ────────────────────────────────────────────────────────────────────

export function renderTrainer(container) {
  container.innerHTML = buildHTML();
  wireEvents();
  _initConfigs();
  restoreState();
}

function buildHTML() {
  return `
    <div id="mt-error-box" class="mt-error-box hidden" style="margin:0.75rem 1rem 0;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;">
        <span style="font-weight:600;font-size:13px;color:var(--danger);">&#9888; Server Error</span>
        <div class="flex-row" style="gap:0.4rem;">
          <button class="btn btn-ghost btn-sm" id="mt-error-copy-btn">&#9108; Copy</button>
          <button class="btn btn-ghost btn-sm" id="mt-error-dismiss-btn">&#10005;</button>
        </div>
      </div>
      <pre id="mt-error-text" class="mt-error-pre"></pre>
    </div>

    <div class="mt-toolbar">
      <span style="display:flex;align-items:center;gap:0.3rem;font-size:12px;">
        <span class="mt-status-dot grey" id="mt-conn-dot"></span>
        <span id="mt-conn-text" class="text-dim">Not connected</span>
      </span>
      <button class="btn btn-primary btn-sm" id="mt-launch-btn">&#9654; Launch Server</button>
      <button class="btn btn-danger btn-sm hidden" id="mt-disconnect-btn">&#9632; Disconnect</button>
    </div>
    <p id="mt-python-path" class="text-dim hidden" style="font-size:11px;padding:0.2rem 1rem;word-break:break-all;border-bottom:1px solid var(--border);background:var(--bg-surface);margin:0;"></p>

    <nav class="subtab-nav" id="mt-subpage-nav">
      <button class="subtab-btn active" data-mt-page="setup">Setup</button>
      <button class="subtab-btn"        data-mt-page="training">Training</button>
      <button class="subtab-btn"        data-mt-page="models">Models</button>
    </nav>

    <div id="mt-page-setup" class="subtab-panel mt-setup-page">
      ${_buildSetupHTML()}
    </div>

    <div id="mt-page-training" class="subtab-panel hidden" style="padding:0;">
      ${_buildTrainingHTML()}
    </div>

    <div id="mt-page-models" class="subtab-panel hidden" style="padding:0;">
      ${_buildModelsHTML()}
    </div>
  `;
}

// ── Setup page ────────────────────────────────────────────────────────────────

function _buildSetupHTML() {
  return `
    <div class="mode-card mt-setup-card" id="mt-setup-card">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div style="display:flex;align-items:center;gap:0.6rem;">
          <p class="section-title" style="margin:0;">First Time Setup</p>
          <span class="badge badge-success hidden" id="mt-setup-badge">&#10003; Setup Complete</span>
        </div>
        <button class="btn btn-ghost btn-sm" id="mt-setup-toggle" style="font-size:11px;padding:0.2rem 0.5rem;">&#9660; Collapse</button>
      </div>

      <div id="mt-setup-body" style="margin-top:1rem;">
        <p class="text-dim" style="font-size:12px;margin-bottom:1.25rem;">
          Complete these steps once. After setup, click <strong style="color:var(--text);">Launch Server</strong> at the top of the page each session.
        </p>

        <!-- Step 1: Download -->
        <div class="mt-step-row">
          <div class="mt-step-num">1</div>
          <div class="mt-step-body">
            <div class="mt-step-title">Download the server script</div>
            <p class="text-dim" style="font-size:12px;margin:0.2rem 0 0.6rem;">Save <code style="background:var(--bg-elevated);padding:0.1rem 0.3rem;border-radius:3px;font-size:11px;">trainer_server.py</code> anywhere on your machine.</p>
            <a class="btn btn-primary btn-sm" href="./trainer_server.py" download="trainer_server.py">&#8595; Download trainer_server.py</a>
          </div>
          <div class="mt-step-ind" id="mt-step1-ind"><span class="mt-ind-pending">—</span></div>
        </div>

        <!-- Step 2: Launcher location -->
        <div class="mt-step-row">
          <div class="mt-step-num">2</div>
          <div class="mt-step-body">
            <div class="mt-step-title">Set the launcher location</div>
            <p class="text-dim" style="font-size:12px;margin:0.2rem 0 0.5rem;">Tell the app where you saved the script. It will also auto-detect on first server connection.</p>
            <div id="mt-launcher-display" class="mt-launcher-row">
              <span id="mt-launcher-path-text" class="mt-launcher-path text-dim">Not set — will auto-detect on first connection</span>
              <button class="btn btn-ghost btn-sm" id="mt-launcher-edit-btn">Set Location</button>
              <button class="btn btn-ghost btn-sm hidden" id="mt-launcher-clear-btn">Clear</button>
            </div>
            <div id="mt-launcher-input-row" class="folder-input-row hidden" style="margin-top:0.4rem;">
              <input type="text" id="mt-launcher-path-input"
                placeholder="e.g. C:\\Users\\you\\trainer_server.py"
                style="flex:1;padding:0.4rem 0.6rem;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-family:var(--font);font-size:13px;" />
              <button class="btn btn-primary btn-sm" id="mt-launcher-save-btn">Save</button>
              <button class="btn btn-ghost btn-sm" id="mt-launcher-cancel-btn">Cancel</button>
            </div>
          </div>
          <div class="mt-step-ind" id="mt-step2-ind"><span class="mt-ind-pending">—</span></div>
        </div>

        <!-- Step 3: Run server once -->
        <div class="mt-step-row">
          <div class="mt-step-num">3</div>
          <div class="mt-step-body">
            <div class="mt-step-title">Run the server once to enable quick-launch</div>
            <p class="text-dim" style="font-size:12px;margin:0.2rem 0 0.5rem;">Open a terminal and run the command below. This registers a quick-launch shortcut so future sessions start automatically.</p>
            <div id="mt-first-run-cmd" class="mt-cmd-row hidden">
              <code id="mt-cmd-text" style="font-size:12px;color:var(--text);flex:1;word-break:break-all;"></code>
              <button class="btn btn-ghost btn-sm" id="mt-copy-cmd-btn" style="flex-shrink:0;">&#9108; Copy</button>
            </div>
            <p id="mt-step4-hint" class="text-dim" style="font-size:12px;margin:0.4rem 0 0;font-style:italic;">Set your launcher location (Step 2) to see the command.</p>
            <div style="display:flex;align-items:center;gap:0.4rem;margin-top:0.5rem;">
              <span class="mt-status-dot grey" id="mt-protocol-dot"></span>
              <span id="mt-protocol-text" class="text-dim" style="font-size:12px;">Run server once to activate</span>
            </div>
          </div>
          <div class="mt-step-ind" id="mt-step3-ind"><span class="mt-ind-pending">—</span></div>
        </div>

        <!-- Step 4: Detect GPU & Install PyTorch -->
        <div class="mt-step-row">
          <div class="mt-step-num">4</div>
          <div class="mt-step-body">
            <div class="mt-step-title">Detect GPU &amp; recommend PyTorch</div>
            <p class="text-dim" style="font-size:12px;margin:0.2rem 0 0.75rem;">Connect to the server first for accurate CUDA detection, or click without a connection for a GPU name estimate.</p>
            <div class="flex-row" style="gap:0.5rem;margin-bottom:0.75rem;flex-wrap:wrap;">
              <button class="btn btn-ghost btn-sm" id="mt-gpu-detect-btn">Detect GPU &amp; Recommend PyTorch</button>
              <button class="btn btn-ghost btn-sm" id="mt-device-btn">Check GPU / CPU</button>
            </div>
            <div id="mt-gpu-result" class="hidden">
              <div class="stat-row" style="margin:0 0 0.75rem;">
                <div class="stat">
                  <div class="stat-label">GPU</div>
                  <div class="stat-value" id="mt-gpu-name" style="font-size:13px;word-break:break-word;">—</div>
                </div>
                <div class="stat">
                  <div class="stat-label">Max CUDA (Driver)</div>
                  <div class="stat-value" id="mt-gpu-cuda" style="font-size:13px;">—</div>
                </div>
              </div>
              <p style="font-size:12px;font-weight:600;margin:0 0 0.3rem;" id="mt-gpu-cmd-label"></p>
              <div class="mt-cmd-row" style="margin-bottom:0.4rem;">
                <code id="mt-gpu-cmd-text" style="font-size:11px;color:var(--text);flex:1;word-break:break-all;"></code>
                <button class="btn btn-ghost btn-sm" id="mt-gpu-cmd-copy" style="flex-shrink:0;">&#9108; Copy</button>
              </div>
              <p id="mt-gpu-note" class="text-dim" style="font-size:11px;margin:0 0 0.4rem;"></p>
              <p class="text-dim" style="font-size:11px;margin:0 0 0.75rem;">
                If PyTorch is already installed, uninstall it first:
                <code style="background:var(--bg-elevated);padding:0.1rem 0.3rem;border-radius:3px;font-size:10px;">pip uninstall torch torchvision torchaudio -y</code>
              </p>
              <button class="btn btn-primary btn-sm" id="mt-gpu-install-btn" style="margin-bottom:0.5rem;">&#8595; Install PyTorch</button>
              <div id="mt-install-log-box" class="mt-log-box hidden" style="height:150px;"></div>
            </div>
            <div id="mt-device-result" class="hidden" style="margin-top:0.75rem;">
              <div class="stat-row" style="margin:0;">
                <div class="stat">
                  <div class="stat-label">Device</div>
                  <div class="stat-value" id="mt-device-name" style="font-size:16px;">—</div>
                </div>
                <div class="stat">
                  <div class="stat-label">CUDA</div>
                  <div class="stat-value" id="mt-device-cuda" style="font-size:16px;">—</div>
                </div>
                <div class="stat">
                  <div class="stat-label">CUDA Version</div>
                  <div class="stat-value" id="mt-device-ver" style="font-size:16px;">—</div>
                </div>
              </div>
              <p id="mt-device-note" class="text-dim" style="font-size:12px;margin-top:0.5rem;"></p>
            </div>
          </div>
          <div class="mt-step-ind" id="mt-step4-ind"><span class="mt-ind-pending">—</span></div>
        </div>

        <!-- Step 5: Verify requirements -->
        <div class="mt-step-row mt-step-last">
          <div class="mt-step-num">5</div>
          <div class="mt-step-body">
            <div class="mt-step-title">Verify Python requirements</div>
            <p class="text-dim" style="font-size:12px;margin:0.2rem 0 0.4rem;">Install missing packages, then click Check to confirm everything is ready.</p>
            <p style="margin:0 0 0.6rem;"><code style="background:var(--bg-elevated);padding:0.15rem 0.5rem;border-radius:3px;font-size:11px;color:var(--text-dim);">pip install ultralytics flask flask-cors requests</code></p>
            <button class="btn btn-ghost btn-sm" id="mt-req-btn">Check Requirements</button>
            <div id="mt-req-results" class="hidden" style="margin-top:0.75rem;"></div>
          </div>
          <div class="mt-step-ind" id="mt-step5-ind"><span class="mt-ind-pending">—</span></div>
        </div>
      </div>
    </div>
  `;
}

// ── Training page ─────────────────────────────────────────────────────────────

function _buildTrainingHTML() {
  return `
    <div class="mt-toolbar">
      <button class="btn btn-ghost btn-sm" id="mt-queue-new-btn" title="New config">+ New</button>
      <button class="btn btn-ghost btn-sm" id="mt-queue-clone-btn" title="Clone selected">Clone</button>
      <button class="btn btn-ghost btn-sm" id="mt-queue-remove-btn" title="Remove selected" style="color:var(--danger);">&#128465;</button>
      <button class="btn btn-ghost btn-sm" id="mt-queue-up-btn" title="Move up">&#9650;</button>
      <button class="btn btn-ghost btn-sm" id="mt-queue-down-btn" title="Move down">&#9660;</button>
      <button class="btn btn-ghost btn-sm" id="mt-queue-reset-btn" title="Reset selected config to pending">&#8635; Reset</button>
      <div class="mt-toolbar-sep"></div>
      <button class="btn btn-primary btn-sm" id="mt-train-all-btn">&#9654;&#9654; Train All</button>
      <button class="btn btn-ghost btn-sm" id="mt-train-sel-btn">&#9654; Train Selected</button>
      <button class="btn btn-ghost btn-sm hidden" id="mt-pause-btn">&#9646;&#9646; Pause</button>
      <button class="btn btn-primary btn-sm hidden" id="mt-resume-btn">&#9654; Resume</button>
      <button class="btn btn-danger btn-sm hidden" id="mt-stop-btn">&#9632; Stop</button>
    </div>

    <div class="mt-trn-tabbar">
      <button class="mt-trn-tab active" data-trn-tab="config">Config</button>
      <button class="mt-trn-tab"        data-trn-tab="livemetrics">Live Metrics</button>
      <button class="mt-trn-tab"        data-trn-tab="postmetrics">Post Metrics</button>
    </div>

    <div id="mt-trn-panel-config" class="mt-trn-panel">
      <div class="mt-split">
        <div class="mt-queue-panel">
          <div class="mt-queue-header">Configs</div>
          <div class="mt-queue-list" id="mt-queue-list"></div>
        </div>

        <div class="mt-right-panel">
          <div class="mt-config-tabbar" id="mt-config-tabbar">
            <button class="mt-config-tab-btn active" data-cfg-tab="general">General</button>
            <button class="mt-config-tab-btn" data-cfg-tab="dataset">Dataset</button>
            <button class="mt-config-tab-btn" data-cfg-tab="hyperparams">Hyperparams</button>
            <button class="mt-config-tab-btn" data-cfg-tab="preprocessing">Preprocessing</button>
          </div>

          <div class="mt-config-body" id="mt-config-body">
            <div class="mt-config-panel active" id="mt-cfgtab-general">
              ${_buildGeneralTabHTML()}
            </div>
            <div class="mt-config-panel" id="mt-cfgtab-dataset">
              ${_buildDatasetTabHTML()}
            </div>
            <div class="mt-config-panel" id="mt-cfgtab-hyperparams">
              ${_buildHyperparamsTabHTML()}
            </div>
            <div class="mt-config-panel" id="mt-cfgtab-preprocessing">
              ${_buildPreprocessingTabHTML()}
            </div>
          </div>

          <div class="mt-console-section">
            <div class="mt-console-header">
              <span class="mt-console-title">Training Console</span>
              <button class="btn btn-ghost btn-sm" id="mt-copy-log-btn" style="font-size:11px;">&#9108; Copy</button>
            </div>
            <div class="mt-console-progress-row">
              <div class="progress-bar" style="flex:1;"><div class="progress-fill" id="mt-progress-fill" style="width:0%"></div></div>
              <span class="mt-console-pct" id="mt-progress-pct">0%</span>
              <span class="mt-console-run-label" id="mt-progress-text"></span>
            </div>
            <div class="mt-console-progress-row hidden" id="mt-batch-progress-row">
              <div class="progress-bar" style="flex:1;"><div class="progress-fill" id="mt-batch-fill" style="width:0%;background:var(--success);opacity:0.7;"></div></div>
              <span class="mt-console-pct" id="mt-batch-pct" style="color:var(--text-dim);"></span>
              <span class="mt-console-run-label" id="mt-batch-text" style="color:var(--text-dim);"></span>
            </div>
            <div class="mt-console-log" id="mt-console-log"></div>
          </div>
        </div>
      </div>
    </div>

    <div id="mt-trn-panel-livemetrics" class="mt-trn-panel hidden">
      ${_buildLiveMetricsHTML()}
    </div>

    <div id="mt-trn-panel-postmetrics" class="mt-trn-panel hidden">
      ${_buildPostMetricsHTML()}
    </div>
  `;
}

function _buildModelsHTML() {
  return `
    <div class="mt-toolbar">
      <button class="btn btn-ghost btn-sm" id="mm-refresh-btn">&#8635; Refresh</button>
      <button class="btn btn-ghost btn-sm" id="mm-upload-btn">&#8593; Upload .pt</button>
      <button class="btn btn-ghost btn-sm" id="mm-upload-run-btn">&#8593; Upload from Run Folder</button>
      <div class="mt-toolbar-sep"></div>
      <button class="btn btn-ghost btn-sm" id="mm-clear-btn">&#10005; Clear Selection</button>
    </div>
    <div class="mm-table-section">
      <table class="summary-table">
        <thead>
          <tr>
            <th style="width:28px;"></th>
            <th>Model Name</th>
            <th>Date</th>
            <th>Size</th>
            <th>mAP50</th>
            <th>mAP50-95</th>
            <th>mask mAP50</th>
            <th>mask mAP50-95</th>
            <th>Precision</th>
            <th>Recall</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="mt-models-table-body">
          <tr><td colspan="11" class="mm-placeholder">Open a project and click Refresh to list models.</td></tr>
        </tbody>
      </table>
    </div>
    <div class="mm-cmp-section">
      <div class="mm-cmp-header">
        <span class="mm-cmp-title">Metrics Comparison</span>
        <span id="mm-sel-badge" class="badge badge-info hidden"></span>
      </div>
      <div id="mm-cmp-placeholder" class="mm-placeholder">Select models above to compare their metrics.</div>
      <div id="mm-cmp-charts" class="hidden">
        <div class="mm-cmp-grid">
          <div class="mt-chart-wrap"><p class="mt-chart-title">mAP50</p>
            <div style="position:relative;height:140px;"><canvas id="mt-cmp-map50"></canvas></div></div>
          <div class="mt-chart-wrap"><p class="mt-chart-title">mAP50-95</p>
            <div style="position:relative;height:140px;"><canvas id="mt-cmp-map95"></canvas></div></div>
          <div class="mt-chart-wrap"><p class="mt-chart-title">Mask mAP50</p>
            <div style="position:relative;height:140px;"><canvas id="mt-cmp-segmap50"></canvas></div></div>
          <div class="mt-chart-wrap"><p class="mt-chart-title">Mask mAP50-95</p>
            <div style="position:relative;height:140px;"><canvas id="mt-cmp-segmap95"></canvas></div></div>
          <div class="mt-chart-wrap"><p class="mt-chart-title">Precision</p>
            <div style="position:relative;height:140px;"><canvas id="mt-cmp-prec"></canvas></div></div>
          <div class="mt-chart-wrap"><p class="mt-chart-title">Recall</p>
            <div style="position:relative;height:140px;"><canvas id="mt-cmp-rec"></canvas></div></div>
          <div class="mt-chart-wrap"><p class="mt-chart-title">Train Loss</p>
            <div style="position:relative;height:140px;"><canvas id="mt-cmp-tloss"></canvas></div></div>
          <div class="mt-chart-wrap"><p class="mt-chart-title">Val Loss</p>
            <div style="position:relative;height:140px;"><canvas id="mt-cmp-vloss"></canvas></div></div>
        </div>
      </div>
    </div>
  `;
}

function _buildGeneralTabHTML() {
  return `
    <div class="mt-cfg-field">
      <label class="mt-cfg-label">Config Name</label>
      <input type="text" class="mt-cfg-input" id="mt-cfg-name" placeholder="e.g. baseline_v1" />
    </div>
    <div class="mt-cfg-grid-2">
      <div class="mt-cfg-field">
        <label class="mt-cfg-label">Task</label>
        <select class="mt-cfg-select" id="mt-cfg-task">
          <option value="detect">detect</option>
          <option value="segment">segment</option>
        </select>
      </div>
      <div class="mt-cfg-field">
        <label class="mt-cfg-label">Device</label>
        <select class="mt-cfg-select" id="mt-cfg-device">
          <option value="auto">auto</option>
          <option value="CPU">CPU</option>
          <option value="0">GPU 0</option>
        </select>
      </div>
    </div>
    <div class="mt-cfg-field">
      <label class="mt-cfg-label">Base Model</label>
      <select class="mt-cfg-select" id="mt-cfg-base-model">
        <optgroup label="YOLO26">
          <option value="yolo26n">yolo26n — Nano (fastest)</option>
          <option value="yolo26s">yolo26s — Small</option>
          <option value="yolo26m" selected>yolo26m — Medium</option>
          <option value="yolo26l">yolo26l — Large</option>
          <option value="yolo26x">yolo26x — XL (most accurate)</option>
        </optgroup>
        <optgroup label="YOLO11">
          <option value="yolo11n">yolo11n — Nano (fastest)</option>
          <option value="yolo11s">yolo11s — Small</option>
          <option value="yolo11m">yolo11m — Medium</option>
          <option value="yolo11l">yolo11l — Large</option>
          <option value="yolo11x">yolo11x — XL (most accurate)</option>
        </optgroup>
      </select>
    </div>
    <div class="mt-cfg-field">
      <label class="mt-cfg-label">Resume From Model (optional)</label>
      <div style="display:flex;gap:0.4rem;">
        <input type="text" class="mt-cfg-input" id="mt-cfg-resume-model" style="flex:1;"
          placeholder="Leave blank to start from Base Model above" />
        <button class="btn btn-ghost btn-sm" id="mt-cfg-resume-model-browse" title="Browse for .pt file">&#128194;</button>
      </div>
      <p class="text-dim" style="font-size:11px;margin:.2rem 0 0;">
        If set, training continues from this checkpoint's weights instead of downloading the Base Model.
      </p>
    </div>
    <div class="mt-cfg-field">
      <label class="mt-cfg-label">Optimizer</label>
      <select class="mt-cfg-select" id="mt-cfg-optimizer">
        <option value="auto">Auto</option>
        <option value="SGD">SGD</option>
        <option value="Adam">Adam</option>
        <option value="AdamW">AdamW</option>
      </select>
      <div class="mt-optimizer-desc" id="mt-cfg-optimizer-desc">Auto — YOLO selects the best optimizer for the task.</div>
    </div>
    <div class="mt-cfg-field">
      <label class="mt-cfg-label">Run Name</label>
      <input type="text" class="mt-cfg-input" id="mt-cfg-run-name" placeholder="e.g. main_street_v1" />
    </div>
  `;
}

function _buildDatasetTabHTML() {
  return `
    <div class="mt-cfg-field">
      <label class="mt-cfg-label">Dataset Source</label>
      <div class="mt-kfold-row" style="gap:1rem;">
        <label style="cursor:pointer;display:flex;align-items:center;gap:.4rem;">
          <input type="radio" name="mt-cfg-dataset-source" id="mt-cfg-source-local" value="local" /> Local folder
        </label>
        <label style="cursor:pointer;display:flex;align-items:center;gap:.4rem;">
          <input type="radio" name="mt-cfg-dataset-source" id="mt-cfg-source-registry" value="registry" /> Registry dataset
        </label>
      </div>
    </div>
    <div id="mt-cfg-local-source-fields">
      <div class="mt-cfg-field">
        <label class="mt-cfg-label">Dataset Folder</label>
        <div style="display:flex;gap:0.4rem;">
          <input type="text" class="mt-cfg-input" id="mt-cfg-data-dir" style="flex:1;"
            placeholder="e.g. C:\\Users\\you\\datasets\\my_split" />
          <button class="btn btn-ghost btn-sm" id="mt-cfg-data-dir-browse" title="Browse for folder">&#128194;</button>
        </div>
        <p class="text-dim" style="font-size:11px;margin:.2rem 0 0;">
          Full path to the folder containing <code>images/</code> and <code>labels/</code>.
        </p>
      </div>
      <div class="mt-cfg-field">
        <label class="mt-cfg-label">YAML Config File</label>
        <div style="display:flex;gap:0.4rem;">
          <input type="text" class="mt-cfg-input" id="mt-cfg-yaml-path" style="flex:1;"
            placeholder="Leave blank to auto-detect data.yaml in the folder above" />
          <button class="btn btn-ghost btn-sm" id="mt-cfg-yaml-browse" title="Browse for YAML file">&#128194;</button>
          <button class="btn btn-ghost btn-sm" id="mt-cfg-yaml-detect-btn" title="Auto-detect yaml in folder">&#128269;</button>
        </div>
      </div>
    </div>
    <div id="mt-cfg-registry-source-fields" class="mt-cfg-field hidden">
      <label class="mt-cfg-label">Split Dataset</label>
      <select class="mt-cfg-select" id="mt-cfg-registry-split">
        <option value="">— select a split —</option>
      </select>
      <p class="text-dim" style="font-size:11px;margin:.2rem 0 0;">
        Downloaded to a temporary cache and removed automatically when training finishes or fails.
      </p>
    </div>
    <div class="mt-kfold-row">
      <input type="checkbox" id="mt-cfg-kfold-enable" style="cursor:pointer;" />
      <label for="mt-cfg-kfold-enable" style="cursor:pointer;">K-Fold Cross Validation</label>
      <input type="number" class="mt-kfold-spinner" id="mt-cfg-kfold-k" value="5" min="2" max="20" disabled />
      <span>folds</span>
    </div>
  `;
}

function _buildHyperparamsTabHTML() {
  const groups = [...new Set(_PARAMS.map(p => p.group))];
  return groups.map(g => {
    const params = _PARAMS.filter(p => p.group === g);
    return `
      <div class="mt-param-group-title">${g}</div>
      ${params.map(p => `
        <div class="mt-param-row">
          <span class="mt-param-label" title="${p.label}">${p.label}</span>
          <input type="range" class="mt-param-slider" id="mt-s-${p.id}"
            min="${p.min}" max="${p.max}" step="${p.step}" value="${p.def}" />
          <input type="number" class="mt-param-num" id="mt-n-${p.id}"
            min="${p.min}" max="${p.max}" step="${p.step}" value="${p.def}" />
        </div>`).join('')}
    `;
  }).join('');
}

function _ppSlider(id, label, min, max, step, def) {
  return `
    <div class="mt-param-row">
      <span class="mt-param-label" title="${label}">${label}</span>
      <input type="range" class="mt-param-slider" id="${id}" min="${min}" max="${max}" step="${step}" value="${def}" />
      <input type="number" class="mt-param-num" id="${id}-num" min="${min}" max="${max}" step="${step}" value="${def}" />
    </div>`;
}

function _buildPreprocessingTabHTML() {
  return `
    <div class="mt-pp-header">
      <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;font-size:12px;">
        <input type="checkbox" id="mt-pp-enable" />
        <strong>Enable Preprocessing</strong>
      </label>
      <button class="btn btn-ghost btn-sm" id="mt-pp-reset-btn" style="margin-left:auto;">Reset Defaults</button>
    </div>
    <div id="mt-pp-controls" class="mt-pp-disabled">
      <div class="mt-pp-group">
        <div class="mt-pp-group-title">Color</div>
        <label style="display:flex;align-items:center;gap:0.5rem;font-size:12px;cursor:pointer;">
          <input type="checkbox" id="mt-pp-grayscale" />
          Convert to Grayscale (then back to BGR)
        </label>
      </div>
      <div class="mt-pp-group">
        <div class="mt-pp-group-title">Brightness / Contrast</div>
        ${_ppSlider('mt-pp-brightness',  'Brightness', -100, 100, 1,    0)}
        ${_ppSlider('mt-pp-contrast',    'Contrast',   -100, 100, 1,    0)}
        ${_ppSlider('mt-pp-saturation',  'Saturation', -100, 100, 1,    0)}
        ${_ppSlider('mt-pp-gamma',       'Gamma',       0.1, 3.0, 0.01, 1.0)}
      </div>
      <div class="mt-pp-group">
        <div class="mt-pp-group-title">Noise Reduction</div>
        <p class="text-dim" style="font-size:11px;margin-bottom:0.4rem;">Set kernel to 1 to disable. Value must be odd.</p>
        ${_ppSlider('mt-pp-gaussian-kernel', 'Gaussian Kernel', 1, 31, 2, 1)}
        ${_ppSlider('mt-pp-median-kernel',   'Median Kernel',   1, 31, 2, 1)}
      </div>
      <div class="mt-pp-group">
        <div class="mt-pp-group-title">Enhancement</div>
        ${_ppSlider('mt-pp-sharpen',    'Sharpen Strength', 0, 2.0, 0.1, 0)}
        ${_ppSlider('mt-pp-clahe-clip', 'CLAHE Clip Limit', 0, 8.0, 0.1, 0)}
        <p class="text-dim" style="font-size:11px;margin-top:0.25rem;">Set CLAHE to 0 to disable.</p>
      </div>
      <div class="mt-pp-group">
        <div class="mt-pp-group-title">Edge Overlay (Canny)</div>
        <label style="display:flex;align-items:center;gap:0.5rem;font-size:12px;cursor:pointer;margin-bottom:0.4rem;">
          <input type="checkbox" id="mt-pp-canny-enable" /> Enable Canny edge overlay
        </label>
        ${_ppSlider('mt-pp-canny-low',  'Low Threshold',  0, 255, 1, 50)}
        ${_ppSlider('mt-pp-canny-high', 'High Threshold', 0, 255, 1, 150)}
      </div>
      <div class="mt-pp-group">
        <div class="mt-pp-group-title">Frangi Vessel Filter (requires scikit-image)</div>
        <label style="display:flex;align-items:center;gap:0.5rem;font-size:12px;cursor:pointer;margin-bottom:0.4rem;">
          <input type="checkbox" id="mt-pp-frangi-enable" /> Enable Frangi filter
        </label>
        ${_ppSlider('mt-pp-frangi-scale-min', 'Scale Min', 1,  10, 0.5, 1)}
        ${_ppSlider('mt-pp-frangi-scale-max', 'Scale Max', 10, 50, 1,   10)}
      </div>
    </div>

    <div style="margin-top:0.75rem;padding-top:0.75rem;border-top:1px solid var(--border);">
      <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.5rem;">
        <span style="font-size:12px;font-weight:600;color:var(--text-dim);text-transform:uppercase;">Preview</span>
        <button class="btn btn-ghost btn-sm" id="mt-pp-upload-btn">Upload Test Image</button>
        <button class="btn btn-primary btn-sm hidden" id="mt-pp-preview-btn">Preview</button>
        <input type="file" id="mt-pp-file-input" accept="image/*" class="hidden" />
      </div>
      <div class="mt-pp-preview-grid hidden" id="mt-pp-preview-grid">
        <div>
          <img id="mt-pp-orig-img" src="" alt="Original" />
          <p class="mt-pp-img-label">Original</p>
        </div>
        <div>
          <img id="mt-pp-proc-img" src="" alt="Processed" />
          <p class="mt-pp-img-label">Processed</p>
        </div>
      </div>
    </div>
  `;
}

function _buildChartWraps() {
  return [
    { id: 'mt-chart-train-loss', title: 'Train Loss' },
    { id: 'mt-chart-val-loss',   title: 'Val Loss' },
    { id: 'mt-chart-map',        title: 'mAP' },
    { id: 'mt-chart-pr',         title: 'Precision / Recall' },
    { id: 'mt-chart-lr',         title: 'Learning Rate' },
  ].map(c => `
    <div class="mt-chart-wrap">
      <p class="mt-chart-title">${c.title}</p>
      <div style="position:relative;height:140px;"><canvas id="${c.id}"></canvas></div>
    </div>`).join('');
}

function _buildLiveMetricsHTML() {
  const chart = (id, title) => `
    <div class="mt-chart-wrap">
      <p class="mt-chart-title">${title}</p>
      <div class="mt-chart-canvas-wrap"><canvas id="${id}"></canvas></div>
    </div>`;
  return `
    <div class="mt-lm-page">
      <div class="mt-lm-prog-section">
        <div class="mt-lm-prog-row">
          <span class="mt-lm-prog-label">Total</span>
          <div class="progress-bar" style="flex:1;"><div class="progress-fill" id="mt-lm-epoch-fill" style="width:0%"></div></div>
          <span class="mt-console-pct" id="mt-lm-epoch-pct">0%</span>
          <span class="mt-lm-prog-text" id="mt-lm-epoch-label">—</span>
        </div>
        <div class="mt-lm-prog-row">
          <span class="mt-lm-prog-label">Epoch</span>
          <div class="progress-bar" style="flex:1;"><div class="progress-fill" id="mt-lm-batch-fill" style="width:0%;background:var(--success);opacity:0.75;"></div></div>
          <span class="mt-console-pct" id="mt-lm-batch-pct">0%</span>
          <span class="mt-lm-prog-text" id="mt-lm-batch-label">—</span>
        </div>
      </div>
      <div class="mt-lm-stats-row" id="mt-lm-stats-row">
        <div class="mt-lm-stat-tile"><span class="mt-lm-stat-label">Epoch</span>
          <span class="mt-lm-stat-val" id="mt-lm-epoch">—</span></div>
        <div class="mt-lm-stat-tile"><span class="mt-lm-stat-label">BBox mAP50</span>
          <span class="mt-lm-stat-val" id="mt-lm-map50">—</span></div>
        <div class="mt-lm-stat-tile"><span class="mt-lm-stat-label">BBox mAP50-95</span>
          <span class="mt-lm-stat-val" id="mt-lm-map95">—</span></div>
        <div class="mt-lm-stat-tile"><span class="mt-lm-stat-label">Mask mAP50</span>
          <span class="mt-lm-stat-val" id="mt-lm-seg50">—</span></div>
        <div class="mt-lm-stat-tile"><span class="mt-lm-stat-label">Mask mAP50-95</span>
          <span class="mt-lm-stat-val" id="mt-lm-seg95">—</span></div>
        <div class="mt-lm-stat-tile"><span class="mt-lm-stat-label">Precision</span>
          <span class="mt-lm-stat-val" id="mt-lm-prec">—</span></div>
        <div class="mt-lm-stat-tile"><span class="mt-lm-stat-label">Recall</span>
          <span class="mt-lm-stat-val" id="mt-lm-recall">—</span></div>
        <div class="mt-lm-stat-tile"><span class="mt-lm-stat-label">Train Loss</span>
          <span class="mt-lm-stat-val" id="mt-lm-tloss">—</span></div>
        <div class="mt-lm-stat-tile"><span class="mt-lm-stat-label">Val Loss</span>
          <span class="mt-lm-stat-val" id="mt-lm-vloss">—</span></div>
      </div>
      <div class="mt-lm-charts">
        ${chart('mt-chart-train-loss', 'Train Loss (box / cls / dfl / seg)')}
        ${chart('mt-chart-val-loss',   'Validation Loss (box / cls / dfl / seg)')}
        ${chart('mt-chart-map',        'mAP — Bounding Box')}
        ${chart('mt-chart-seg-map',    'mAP — Segmentation Mask')}
        ${chart('mt-chart-pr',         'Precision / Recall')}
        ${chart('mt-chart-lr',         'Learning Rate')}
      </div>
      <div class="mt-lm-class-section">
        <div class="mt-lm-section-title">Per-Class Metrics (Last Epoch)</div>
        <div id="mt-lm-class-wrap">
          <p class="text-dim" style="font-size:13px;padding:.5rem 0;">
            No per-class data yet. Populates during training.
          </p>
        </div>
      </div>
    </div>
  `;
}

function _buildPostMetricsHTML() {
  return `
    <div class="mt-pm-page">
      <div class="mt-pm-toolbar">
        <button class="btn btn-ghost btn-sm" id="mt-pm-refresh-btn">↻ Refresh</button>
        <span id="mt-pm-run-label" class="text-dim" style="font-size:12px;margin-left:.6rem;"></span>
      </div>
      <div id="mt-pm-content" class="mt-pm-content">
        <p class="text-dim mt-pm-placeholder">Complete a training run to see post-training metrics.</p>
      </div>
    </div>
  `;
}

// ── Wire events ───────────────────────────────────────────────────────────────

function wireEvents() {
  // Error box
  document.getElementById('mt-error-copy-btn').addEventListener('click', () => {
    const txt = document.getElementById('mt-error-text')?.textContent ?? '';
    navigator.clipboard.writeText(txt).then(() => toast('Error copied', 'success'))
      .catch(() => toast('Copy failed — select text manually', 'error'));
  });
  document.getElementById('mt-error-dismiss-btn').addEventListener('click', dismissError);

  // Subpage nav
  document.querySelectorAll('[data-mt-page]').forEach(btn => {
    btn.addEventListener('click', () => _switchTrainerPage(btn.dataset.mtPage));
  });

  // Internal training sub-tabs (Config / Live Metrics / Post Metrics)
  document.querySelectorAll('[data-trn-tab]').forEach(btn => {
    btn.addEventListener('click', () => _switchTrnTab(btn.dataset.trnTab));
  });

  document.getElementById('mt-pm-refresh-btn').addEventListener('click', _loadPostMetrics);

  // Setup collapse toggle
  document.getElementById('mt-setup-toggle').addEventListener('click', () => {
    const body   = document.getElementById('mt-setup-body');
    const toggle = document.getElementById('mt-setup-toggle');
    if (!body || !toggle) return;
    const isHidden = body.classList.toggle('hidden');
    toggle.textContent = isHidden ? '▶ Expand' : '▼ Collapse';
  });

  // Launcher
  document.getElementById('mt-launcher-edit-btn').addEventListener('click', () => {
    document.getElementById('mt-launcher-path-input').value = localStorage.getItem(LAUNCHER_PATH_KEY) ?? '';
    document.getElementById('mt-launcher-display').classList.add('hidden');
    document.getElementById('mt-launcher-input-row').classList.remove('hidden');
    document.getElementById('mt-launcher-path-input').focus();
  });
  document.getElementById('mt-launcher-save-btn').addEventListener('click', () => {
    const val = document.getElementById('mt-launcher-path-input').value.trim();
    if (val) saveLauncherPath(val);
    document.getElementById('mt-launcher-input-row').classList.add('hidden');
    document.getElementById('mt-launcher-display').classList.remove('hidden');
  });
  document.getElementById('mt-launcher-cancel-btn').addEventListener('click', () => {
    document.getElementById('mt-launcher-input-row').classList.add('hidden');
    document.getElementById('mt-launcher-display').classList.remove('hidden');
  });
  document.getElementById('mt-launcher-path-input').addEventListener('keydown', e => {
    if (e.key === 'Enter')  document.getElementById('mt-launcher-save-btn').click();
    if (e.key === 'Escape') document.getElementById('mt-launcher-cancel-btn').click();
  });
  document.getElementById('mt-launcher-clear-btn').addEventListener('click', () => {
    localStorage.removeItem(LAUNCHER_PATH_KEY);
    localStorage.removeItem(LAUNCHER_PROTOCOL_KEY);
    updateLauncherUI();
    toast('Launcher cleared', 'info');
  });
  document.getElementById('mt-copy-cmd-btn').addEventListener('click', copyLaunchCommand);

  // Step 4: GPU & device
  document.getElementById('mt-gpu-detect-btn').addEventListener('click', detectGPU);
  document.getElementById('mt-gpu-install-btn').addEventListener('click', installTorch);
  document.getElementById('mt-gpu-cmd-copy').addEventListener('click', () => {
    const cmd = document.getElementById('mt-gpu-cmd-text')?.textContent ?? '';
    navigator.clipboard.writeText(cmd).then(() => toast('Install command copied', 'success'))
      .catch(() => toast('Copy failed — select text manually', 'error'));
  });
  document.getElementById('mt-device-btn').addEventListener('click', checkDevice);

  // Step 5: requirements
  document.getElementById('mt-req-btn').addEventListener('click', checkRequirements);

  // Training toolbar: server
  document.getElementById('mt-launch-btn').addEventListener('click', launchServer);
  document.getElementById('mt-disconnect-btn').addEventListener('click', disconnectServer);

  // Training toolbar: queue management
  document.getElementById('mt-queue-new-btn').addEventListener('click', () => {
    const cfg = _defaultConfig(_configs.length + 1);
    _configs.push(cfg);
    _selectConfig(_configs.length - 1);
    _renderQueue();
  });
  document.getElementById('mt-queue-clone-btn').addEventListener('click', () => {
    if (!_configs.length) return;
    _saveEditorToConfig();
    const clone = JSON.parse(JSON.stringify(_configs[_activeIdx]));
    clone.id = _configs.length + 1;
    clone.name = clone.name + ' (copy)';
    clone.status = 'pending';
    clone.metricsHistory = [];
    _configs.push(clone);
    _selectConfig(_configs.length - 1);
    _renderQueue();
  });
  document.getElementById('mt-queue-remove-btn').addEventListener('click', () => {
    if (_configs.length <= 1) { toast('Must keep at least one config', 'error'); return; }
    _configs.splice(_activeIdx, 1);
    const newIdx = Math.min(_activeIdx, _configs.length - 1);
    _activeIdx = newIdx;
    _renderQueue();
    _loadConfigIntoEditor(newIdx);
  });
  document.getElementById('mt-queue-up-btn').addEventListener('click', () => {
    if (_activeIdx === 0) return;
    _saveEditorToConfig();
    [_configs[_activeIdx - 1], _configs[_activeIdx]] = [_configs[_activeIdx], _configs[_activeIdx - 1]];
    _activeIdx--;
    _renderQueue();
    _loadConfigIntoEditor(_activeIdx);
  });
  document.getElementById('mt-queue-down-btn').addEventListener('click', () => {
    if (_activeIdx >= _configs.length - 1) return;
    _saveEditorToConfig();
    [_configs[_activeIdx], _configs[_activeIdx + 1]] = [_configs[_activeIdx + 1], _configs[_activeIdx]];
    _activeIdx++;
    _renderQueue();
    _loadConfigIntoEditor(_activeIdx);
  });
  document.getElementById('mt-queue-reset-btn').addEventListener('click', () => {
    const cfg = _configs[_activeIdx];
    if (!cfg) return;
    if (cfg.status === 'running') { toast('Cannot reset a running config — stop training first', 'error'); return; }
    cfg.status = 'pending';
    cfg.metricsHistory = [];
    _renderQueue();
    _resetCharts();
    toast(`"${cfg.name}" reset to pending`, 'info');
  });

  // Config tabs
  document.querySelectorAll('[data-cfg-tab]').forEach(btn => {
    btn.addEventListener('click', () => _switchConfigTab(btn.dataset.cfgTab));
  });

  // Dataset tab — browse buttons
  document.getElementById('mt-cfg-data-dir-browse')?.addEventListener('click', async () => {
    if (!_connected) { toast('Connect to server first to use folder browser', 'error'); return; }
    try {
      const res  = await serverFetch(`${_serverUrl}/browse-folder`);
      const data = await res.json();
      if (data.path) {
        document.getElementById('mt-cfg-data-dir').value = data.path;
        _saveEditorToConfig();
      }
    } catch (err) { toast(`Browse failed: ${err.message}`, 'error'); }
  });
  document.getElementById('mt-cfg-yaml-browse')?.addEventListener('click', async () => {
    if (!_connected) { toast('Connect to server first to use file browser', 'error'); return; }
    try {
      const res  = await serverFetch(`${_serverUrl}/browse-file?ext=yaml`);
      const data = await res.json();
      if (data.path) {
        document.getElementById('mt-cfg-yaml-path').value = data.path;
        _saveEditorToConfig();
      }
    } catch (err) { toast(`Browse failed: ${err.message}`, 'error'); }
  });
  document.getElementById('mt-cfg-resume-model-browse')?.addEventListener('click', async () => {
    if (!_connected) { toast('Connect to server first to use file browser', 'error'); return; }
    try {
      const res  = await serverFetch(`${_serverUrl}/browse-file?ext=pt`);
      const data = await res.json();
      if (data.path) {
        document.getElementById('mt-cfg-resume-model').value = data.path;
        _saveEditorToConfig();
      }
    } catch (err) { toast(`Browse failed: ${err.message}`, 'error'); }
  });

  // Dataset tab
  document.getElementById('mt-cfg-yaml-detect-btn')?.addEventListener('click', async () => {
    const dir = document.getElementById('mt-cfg-data-dir')?.value?.trim();
    if (!dir) { toast('Enter a dataset folder path first', 'error'); return; }
    try {
      const res  = await serverFetch(`${_serverUrl}/find-yaml?dir=${encodeURIComponent(dir)}`);
      const data = await res.json();
      if (data.yaml_path) {
        document.getElementById('mt-cfg-yaml-path').value = data.yaml_path;
        _saveEditorToConfig();
        toast('YAML detected', 'success');
      } else {
        toast('No .yaml file found in that folder', 'error');
      }
    } catch (err) {
      toast(`Find-yaml error: ${err.message}`, 'error');
    }
  });
  document.getElementById('mt-cfg-kfold-enable').addEventListener('change', e => {
    document.getElementById('mt-cfg-kfold-k').disabled = !e.target.checked;
  });

  // Dataset source toggle (local folder vs registry dataset)
  document.querySelectorAll('[name="mt-cfg-dataset-source"]').forEach(radio => {
    radio.addEventListener('change', () => {
      _updateDatasetSourceVisibility();
      if (radio.value === 'registry' && radio.checked) {
        const select = document.getElementById('mt-cfg-registry-split');
        if (select && select.options.length <= 1) _fetchSplits(select);
      }
      _saveEditorToConfig();
    });
  });
  document.getElementById('mt-cfg-registry-split')?.addEventListener('change', _saveEditorToConfig);

  // General tab — optimizer desc
  document.getElementById('mt-cfg-optimizer').addEventListener('change', _updateOptimizerDesc);

  // Hyperparams sliders
  _PARAMS.forEach(p => _wireSliderPair(`mt-s-${p.id}`, `mt-n-${p.id}`, p.min, p.max, p.step));

  // Preprocessing toggle & reset
  document.getElementById('mt-pp-enable').addEventListener('change', e => {
    document.getElementById('mt-pp-controls').classList.toggle('mt-pp-disabled', !e.target.checked);
    _saveEditorToConfig();
  });
  document.getElementById('mt-pp-reset-btn').addEventListener('click', _resetPPDefaults);

  // PP slider pairs
  [
    ['mt-pp-brightness',       -100, 100,  1   ],
    ['mt-pp-contrast',         -100, 100,  1   ],
    ['mt-pp-saturation',       -100, 100,  1   ],
    ['mt-pp-gamma',             0.1, 3.0,  0.01],
    ['mt-pp-gaussian-kernel',   1,   31,   2   ],
    ['mt-pp-median-kernel',     1,   31,   2   ],
    ['mt-pp-sharpen',           0,   2.0,  0.1 ],
    ['mt-pp-clahe-clip',        0,   8.0,  0.1 ],
    ['mt-pp-canny-low',         0,   255,  1   ],
    ['mt-pp-canny-high',        0,   255,  1   ],
    ['mt-pp-frangi-scale-min',  1,   10,   0.5 ],
    ['mt-pp-frangi-scale-max',  10,  50,   1   ],
  ].forEach(([id, min, max, step]) => _wireSliderPair(id, `${id}-num`, min, max, step));

  // Odd-number enforcement for blur kernels
  ['mt-pp-gaussian-kernel', 'mt-pp-median-kernel'].forEach(id => {
    const enforceOdd = el => {
      let v = parseInt(el.value, 10);
      if (isNaN(v) || v < 1) v = 1;
      if (v > 1 && v % 2 === 0) v += 1;
      el.value = v;
    };
    const slider = document.getElementById(id);
    const num    = document.getElementById(`${id}-num`);
    if (slider) slider.addEventListener('change', () => { enforceOdd(slider); if (num) num.value = slider.value; });
    if (num)    num.addEventListener('change',    () => { enforceOdd(num);    if (slider) slider.value = num.value; });
  });

  // Preview
  document.getElementById('mt-pp-upload-btn').addEventListener('click', () => {
    document.getElementById('mt-pp-file-input').click();
  });
  document.getElementById('mt-pp-file-input').addEventListener('change', e => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const orig = document.getElementById('mt-pp-orig-img');
      if (orig) orig.src = ev.target.result;
      document.getElementById('mt-pp-preview-btn').classList.remove('hidden');
      document.getElementById('mt-pp-preview-grid').classList.remove('hidden');
    };
    reader.readAsDataURL(file);
  });
  document.getElementById('mt-pp-preview-btn').addEventListener('click', previewPreprocessing);

  // Training controls
  document.getElementById('mt-train-all-btn').addEventListener('click', _startTrainAll);
  document.getElementById('mt-train-sel-btn').addEventListener('click', _startTrainSelected);
  document.getElementById('mt-pause-btn').addEventListener('click', pauseTraining);
  document.getElementById('mt-resume-btn').addEventListener('click', resumeTraining);
  document.getElementById('mt-stop-btn').addEventListener('click', stopTraining);

  // Console copy
  document.getElementById('mt-copy-log-btn').addEventListener('click', () => {
    const txt = document.getElementById('mt-console-log')?.textContent ?? '';
    navigator.clipboard.writeText(txt).then(() => toast('Log copied', 'success'))
      .catch(() => toast('Copy failed — select text manually', 'error'));
  });

  // Model registry (Training tab) — elements may not exist if section was removed
  document.getElementById('mt-registry-refresh-btn')?.addEventListener('click', loadModelRegistry);
  document.getElementById('mt-upload-model-btn')?.addEventListener('click', uploadModel);

  // Models page toolbar
  document.getElementById('mm-refresh-btn').addEventListener('click', _loadModelsPage);
  document.getElementById('mm-upload-btn').addEventListener('click', () => {
    const token   = getToken();
    const project = getCurrentProject();
    if (!token || !project) { toast('Sign in and open a project first', 'error'); return; }
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.pt';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const modelsFolder = await getProjectModelsFolder(token);
        if (!modelsFolder) { toast('Could not access models folder', 'error'); return; }
        await upsertFile(token, modelsFolder.id, file.name, 'application/octet-stream', file);
        toast(`${file.name} uploaded`, 'success');
        _loadModelsPage();
      } catch (err) { toast(`Upload failed: ${err.message}`, 'error'); }
    };
    input.click();
  });
  document.getElementById('mm-upload-run-btn')?.addEventListener('click', async () => {
    if (!_connected) { toast('Connect to server first', 'error'); return; }
    const token   = getToken();
    const project = getCurrentProject();
    if (!token || !project) { toast('Sign in and open a project first', 'error'); return; }

    const res  = await serverFetch(`${_serverUrl}/browse-folder`);
    const data = await res.json();
    if (!data.path) return;

    const defaultName = data.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    const runName = prompt('Model registry name for this run:', defaultName);
    if (!runName) return;

    const modelsFolder = await getProjectModelsFolder(token).catch(() => null);
    if (!modelsFolder) { toast('Could not access models folder', 'error'); return; }

    await serverFetch(`${_serverUrl}/upload-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ run_dir: data.path, run_name: runName, drive_token: token, models_folder_id: modelsFolder.id }),
    });
    toast('Uploading run to model registry...', 'info');
    _pollUploadRun();
  });
  document.getElementById('mm-clear-btn').addEventListener('click', () => {
    _selectedModelIds.clear();
    _renderModelsTable(_modelRegistry);
    _updateCmpCharts();
  });

  // Auto-save config on editor changes
  ['mt-cfg-name','mt-cfg-task','mt-cfg-base-model','mt-cfg-resume-model','mt-cfg-device','mt-cfg-run-name'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', _saveEditorToConfig);
  });
  document.getElementById('mt-cfg-data-dir')?.addEventListener('change', _saveEditorToConfig);
  document.getElementById('mt-cfg-yaml-path')?.addEventListener('change', _saveEditorToConfig);
  document.getElementById('mt-cfg-kfold-k')?.addEventListener('change', _saveEditorToConfig);
  _PARAMS.forEach(p => {
    document.getElementById(`mt-n-${p.id}`)?.addEventListener('change', _saveEditorToConfig);
  });
}

function _switchTrainerPage(page) {
  document.querySelectorAll('[data-mt-page]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mtPage === page);
  });
  document.getElementById('mt-page-setup').classList.toggle('hidden',   page !== 'setup');
  document.getElementById('mt-page-training').classList.toggle('hidden', page !== 'training');
  document.getElementById('mt-page-models').classList.toggle('hidden',   page !== 'models');
  if (page === 'models') _loadModelsPage();
}

function _switchTrnTab(tab) {
  document.querySelectorAll('[data-trn-tab]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.trnTab === tab);
  });
  document.getElementById('mt-trn-panel-config').classList.toggle('hidden',       tab !== 'config');
  document.getElementById('mt-trn-panel-livemetrics').classList.toggle('hidden',  tab !== 'livemetrics');
  document.getElementById('mt-trn-panel-postmetrics').classList.toggle('hidden',  tab !== 'postmetrics');
  if (tab === 'postmetrics') _loadPostMetrics();
}

function restoreState() {
  const savedUrl = localStorage.getItem('pavement_trainer_server_url');
  if (savedUrl) _serverUrl = savedUrl;
  _connected = false;
  updateConnectButton();
  updateSetupState();

  const path          = localStorage.getItem(LAUNCHER_PATH_KEY);
  const protocolReady = localStorage.getItem(LAUNCHER_PROTOCOL_KEY) === 'true';
  if (path && protocolReady) {
    const body   = document.getElementById('mt-setup-body');
    const toggle = document.getElementById('mt-setup-toggle');
    if (body)   body.classList.add('hidden');
    if (toggle) toggle.textContent = '▶ Expand';
  }

}

// ── Error display ─────────────────────────────────────────────────────────────

function showError(msg) {
  const box  = document.getElementById('mt-error-box');
  const text = document.getElementById('mt-error-text');
  if (!box || !text) return;
  text.textContent = msg;
  box.classList.remove('hidden');
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function dismissError() {
  document.getElementById('mt-error-box')?.classList.add('hidden');
}

async function serverFetch(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    if (res.status === 404) {
      const endpoint = new URL(url).pathname;
      throw new Error(
        `Endpoint ${endpoint} not found (404).\n\n` +
        `Your running server is an older version that does not have this feature.\n` +
        `Click Disconnect, then re-download trainer_server.py from the Setup tab and restart it.`
      );
    }
    let msg = `HTTP ${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      msg = body.traceback || body.error || JSON.stringify(body, null, 2);
    } catch {
      try { msg = await res.text(); } catch { /* keep default */ }
    }
    throw new Error(msg);
  }
  return res;
}

// ── Connect / Disconnect ──────────────────────────────────────────────────────

function updateConnectButton() {
  const launchBtn = document.getElementById('mt-launch-btn');
  const discBtn   = document.getElementById('mt-disconnect-btn');
  if (_connected) {
    launchBtn?.classList.add('hidden');
    if (discBtn) { discBtn.classList.remove('hidden'); discBtn.disabled = false; discBtn.textContent = '■ Disconnect'; }
  } else {
    if (launchBtn) { launchBtn.classList.remove('hidden'); launchBtn.disabled = false; launchBtn.textContent = '▶ Launch Server'; }
    discBtn?.classList.add('hidden');
  }
}

async function disconnectServer() {
  const btn = document.getElementById('mt-disconnect-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Disconnecting…'; }
  try {
    await fetch(`${_serverUrl}/shutdown`, { method: 'POST', signal: AbortSignal.timeout(3000) });
  } catch { /* server closes before responding — expected */ }
  _connected = false;
  stopPolling();
  setConnStatus(false, 'Disconnected');
  updateConnectButton();
  document.getElementById('mt-python-path')?.classList.add('hidden');
  toast('Server shut down', 'info');
}

// ── GPU Setup ─────────────────────────────────────────────────────────────────

async function detectGPU() {
  const btn = document.getElementById('mt-gpu-detect-btn');
  btn.disabled = true;
  btn.textContent = 'Detecting…';
  try {
    let gpuName = '';
    let cudaVer = '';

    if (_connected) {
      const res  = await serverFetch(`${_serverUrl}/gpu-info`, { signal: AbortSignal.timeout(15000) });
      const data = await res.json();
      gpuName = data.gpu_name || (data.has_nvidia ? 'NVIDIA GPU detected' : 'No NVIDIA GPU detected');
      cudaVer = data.cuda_driver_version || '';
      if (data.error) showError(data.error);
    } else {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (gl) {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        gpuName = (dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
                + ' (browser estimate — connect server for CUDA version)';
      } else {
        gpuName = 'Unknown — WebGL not available';
      }
    }

    document.getElementById('mt-gpu-name').textContent = gpuName || '—';
    document.getElementById('mt-gpu-cuda').textContent = cudaVer || (_connected ? 'Not detected' : '— (requires server)');

    const { cmd, label, note } = getTorchInstallCommand(cudaVer, _connected);
    document.getElementById('mt-gpu-cmd-label').textContent = `Recommended: ${label}`;
    document.getElementById('mt-gpu-cmd-text').textContent  = cmd;
    const noteEl = document.getElementById('mt-gpu-note');
    noteEl.textContent  = note;
    noteEl.style.display = note ? '' : 'none';
    document.getElementById('mt-gpu-result').classList.remove('hidden');

    localStorage.setItem(GPU_DETECTED_KEY, 'true');
    updateSetupState();
  } catch (err) {
    showError(err.message);
    toast('GPU detection failed — see error box', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Detect GPU & Recommend PyTorch';
  }
}

async function installTorch() {
  if (!_connected) { toast('Connect to the server before installing', 'error'); return; }
  const cmd = document.getElementById('mt-gpu-cmd-text')?.textContent?.trim();
  if (!cmd || !cmd.startsWith('pip install torch')) {
    toast('Run "Detect GPU" first to get the install command', 'error');
    return;
  }
  const btn    = document.getElementById('mt-gpu-install-btn');
  const logBox = document.getElementById('mt-install-log-box');
  btn.disabled    = true;
  btn.textContent = 'Installing…';
  logBox.textContent = '';
  logBox.classList.remove('hidden');

  const args = cmd.replace(/^pip install\s+/, '');
  try {
    const res = await serverFetch(`${_serverUrl}/install-torch`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ args }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    _installTimer = setInterval(pollInstallStatus, 2000);
  } catch (err) {
    btn.disabled    = false;
    btn.textContent = '↓ Install PyTorch';
    showError(err.message);
    toast('Failed to start installation — see error box', 'error');
  }
}

async function pollInstallStatus() {
  try {
    const res  = await serverFetch(`${_serverUrl}/install-status`);
    const data = await res.json();
    const logBox = document.getElementById('mt-install-log-box');
    if (logBox && data.log) {
      logBox.textContent = data.log.join('\n');
      logBox.scrollTop   = logBox.scrollHeight;
    }
    if (data.state === 'done' || data.state === 'error') {
      clearInterval(_installTimer);
      _installTimer = null;
      const btn = document.getElementById('mt-gpu-install-btn');
      if (btn) { btn.disabled = false; btn.textContent = '↓ Install PyTorch'; }
      if (data.state === 'done') toast('PyTorch installed successfully', 'success');
      else                       toast('Installation failed — check the log above', 'error');
    }
  } catch {
    clearInterval(_installTimer);
    _installTimer = null;
    const btn = document.getElementById('mt-gpu-install-btn');
    if (btn) { btn.disabled = false; btn.textContent = '↓ Install PyTorch'; }
    toast('Lost connection during install', 'error');
  }
}

function getTorchInstallCommand(cudaVerStr, serverConnected) {
  const base = 'pip install torch torchvision torchaudio';
  if (!cudaVerStr || !serverConnected) {
    return {
      cmd:   `${base} --index-url https://download.pytorch.org/whl/cu124`,
      label: 'CUDA 12.4 (recommended default)',
      note:  serverConnected
        ? 'CUDA version not detected — ensure NVIDIA drivers are installed. Defaulting to CUDA 12.4.'
        : 'Connect to the server for accurate CUDA detection. Showing CUDA 12.4 as a safe default.',
    };
  }
  const [major, minor = 0] = cudaVerStr.split('.').map(Number);
  const v = major * 10 + minor;
  if (v >= 128) return { cmd: `${base} --index-url https://download.pytorch.org/whl/cu128`, label: 'CUDA 12.8', note: '' };
  if (v >= 126) return { cmd: `${base} --index-url https://download.pytorch.org/whl/cu126`, label: 'CUDA 12.6', note: '' };
  if (v >= 124) return { cmd: `${base} --index-url https://download.pytorch.org/whl/cu124`, label: 'CUDA 12.4', note: '' };
  if (v >= 121) return { cmd: `${base} --index-url https://download.pytorch.org/whl/cu121`, label: 'CUDA 12.1', note: '' };
  if (v >= 118) return { cmd: `${base} --index-url https://download.pytorch.org/whl/cu118`, label: 'CUDA 11.8', note: '' };
  return {
    cmd:   base,
    label: 'CPU-only (CUDA version too old)',
    note:  `Your driver supports CUDA ${cudaVerStr}, which is below 11.8. Update your NVIDIA drivers to enable GPU training.`,
  };
}

// ── Server connection ─────────────────────────────────────────────────────────

function setConnStatus(connected, text) {
  const dot  = document.getElementById('mt-conn-dot');
  const span = document.getElementById('mt-conn-text');
  if (!dot || !span) return;
  dot.className    = `mt-status-dot ${connected ? 'green' : 'red'}`;
  span.textContent = text;
  span.className   = connected ? 'text-success' : 'text-dim';
}

function showPythonPath(exePath, version) {
  const el = document.getElementById('mt-python-path');
  if (!el) return;
  el.textContent = `Server Python ${version ?? ''}: ${exePath}`;
  el.classList.remove('hidden');
}

function launchServer() {
  const protocolReady = localStorage.getItem(LAUNCHER_PROTOCOL_KEY) === 'true';
  const btn = document.getElementById('mt-launch-btn');

  if (protocolReady) {
    window.open('trainertool://start');
    toast('Launching server…', 'info');
  } else {
    copyLaunchCommand();
    toast('Command copied — run it in your terminal, then the app will connect automatically…', 'info', 6000);
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Connecting…'; }
  let tries = 0;
  const poll = setInterval(async () => {
    tries++;
    try {
      const res  = await fetch(`${_serverUrl}/ping`, { signal: AbortSignal.timeout(2000) });
      const data = await res.json();
      clearInterval(poll);
      _connected = true;
      setConnStatus(true, 'Connected');
      updateConnectButton();
      if (data.server_path) saveLauncherPath(data.server_path);
      if (data.protocol_registered) {
        localStorage.setItem(LAUNCHER_PROTOCOL_KEY, 'true');
        updateSetupState();
      }
      if (data.python_exe) showPythonPath(data.python_exe, data.python_version);
      updateLauncherUI();
      toast('Server connected', 'success');
    } catch {
      if (tries >= 15) {
        clearInterval(poll);
        updateConnectButton();
        toast('Server did not respond — check that it is running and try again', 'error');
      }
    }
  }, 2000);
}

// ── Requirements check ────────────────────────────────────────────────────────

async function checkRequirements() {
  if (!_connected) { toast('Connect to server first', 'error'); return; }
  const btn = document.getElementById('mt-req-btn');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    const res  = await serverFetch(`${_serverUrl}/requirements`, { signal: AbortSignal.timeout(10000) });
    const pkgs = await res.json();
    const allInstalled = pkgs.every(p => p.installed);
    if (allInstalled) localStorage.setItem('pavement_trainer_reqs_ok', 'true');
    else              localStorage.removeItem('pavement_trainer_reqs_ok');
    const rows = pkgs.map(p => `
      <tr>
        <td>${escHtml(p.package)}</td>
        <td>
          ${p.installed
            ? `<span class="badge badge-success">&#10003; Installed</span>`
            : `<span class="badge badge-danger">&#10007; Missing</span>`}
          ${p.note ? `<span class="badge badge-warn" style="margin-left:0.25rem;" title="${escHtml(p.note)}">&#9888;</span>` : ''}
        </td>
        <td style="font-size:12px;">
          <span style="color:var(--text-dim);">${escHtml(p.version)}</span>
          ${p.note ? `<br><span style="color:var(--warning);font-size:11px;">${escHtml(p.note)}</span>` : ''}
        </td>
      </tr>`).join('');
    const div = document.getElementById('mt-req-results');
    div.innerHTML = `
      <table class="summary-table">
        <thead><tr><th>Package</th><th>Status</th><th>Version</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    div.classList.remove('hidden');
    updateSetupState();
  } catch (err) {
    showError(err.message);
    toast('Requirements check failed — see error box', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Check Requirements';
  }
}

// ── Launcher / Setup state ────────────────────────────────────────────────────

function saveLauncherPath(path) {
  if (!path) return;
  if (localStorage.getItem(LAUNCHER_PATH_KEY) === path) return;
  localStorage.setItem(LAUNCHER_PATH_KEY, path);
  updateLauncherUI();
}

function updateLauncherUI() {
  updateSetupState();
}

function updateSetupState() {
  const path          = localStorage.getItem(LAUNCHER_PATH_KEY);
  const protocolReady = localStorage.getItem(LAUNCHER_PROTOCOL_KEY) === 'true';
  const gpuDetected   = localStorage.getItem(GPU_DETECTED_KEY) === 'true';
  const reqsOk        = localStorage.getItem('pavement_trainer_reqs_ok') === 'true';

  const pathText = document.getElementById('mt-launcher-path-text');
  const clearBtn = document.getElementById('mt-launcher-clear-btn');
  if (pathText) {
    if (path) {
      pathText.textContent = path;
      pathText.classList.remove('text-dim');
      clearBtn?.classList.remove('hidden');
    } else {
      pathText.textContent = 'Not set — will auto-detect on first connection';
      pathText.classList.add('text-dim');
      clearBtn?.classList.add('hidden');
    }
  }

  const firstRunCmd = document.getElementById('mt-first-run-cmd');
  const cmdText     = document.getElementById('mt-cmd-text');
  const step4Hint   = document.getElementById('mt-step4-hint');
  if (path) {
    if (cmdText) cmdText.textContent = `python "${path}"`;
    firstRunCmd?.classList.remove('hidden');
    if (step4Hint) step4Hint.style.display = 'none';
  } else {
    firstRunCmd?.classList.add('hidden');
    if (step4Hint) step4Hint.style.display = '';
  }

  const protDot  = document.getElementById('mt-protocol-dot');
  const protText = document.getElementById('mt-protocol-text');
  if (protDot && protText) {
    if (protocolReady) {
      protDot.className    = 'mt-status-dot green';
      protText.textContent = 'Quick-launch active';
      protText.className   = 'text-success';
    } else {
      protDot.className    = 'mt-status-dot grey';
      protText.textContent = 'Run server once to activate';
      protText.className   = 'text-dim';
    }
  }

  setStepInd('mt-step1-ind', !!path);
  setStepInd('mt-step2-ind', !!path);
  setStepInd('mt-step3-ind', protocolReady);
  setStepInd('mt-step4-ind', gpuDetected);
  setStepInd('mt-step5-ind', reqsOk);

  document.getElementById('mt-setup-badge')?.classList.toggle('hidden', !(path && protocolReady && reqsOk));
}

function setStepInd(id, done) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = done
    ? '<span class="mt-ind-done">&#10003;</span>'
    : '<span class="mt-ind-pending">—</span>';
}

function copyLaunchCommand() {
  const path = localStorage.getItem(LAUNCHER_PATH_KEY);
  if (!path) { toast('No launcher path set', 'error'); return; }
  const cmd = `python "${path}"`;
  navigator.clipboard.writeText(cmd)
    .then(() => toast('Launch command copied — paste into your terminal', 'success'))
    .catch(() => toast(`Command: ${cmd}`, 'info', 8000));
}

// ── Device check ──────────────────────────────────────────────────────────────

async function checkDevice() {
  const btn = document.getElementById('mt-device-btn');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    if (_connected) {
      const res  = await serverFetch(`${_serverUrl}/device`, { signal: AbortSignal.timeout(10000) });
      const data = await res.json();
      showDeviceResult(data.device, data.cuda, data.cuda_version, data.note || '');
    } else {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (gl) {
        const dbgInfo  = gl.getExtension('WEBGL_debug_renderer_info');
        const renderer = dbgInfo
          ? gl.getParameter(dbgInfo.UNMASKED_RENDERER_WEBGL)
          : gl.getParameter(gl.RENDERER);
        showDeviceResult(renderer, null, '', 'Browser estimate — connect server for accurate GPU detection');
      } else {
        showDeviceResult('Unknown', null, '', 'WebGL not available in this browser');
      }
    }
  } catch (err) {
    showError(err.message);
    toast('Device check failed — see error box', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Check GPU / CPU';
  }
}

function showDeviceResult(device, cuda, cudaVer, note) {
  document.getElementById('mt-device-name').textContent = device || '—';
  document.getElementById('mt-device-cuda').textContent = cuda === null ? '—' : (cuda ? 'Yes' : 'No');
  document.getElementById('mt-device-ver').textContent  = cudaVer || (cuda === false ? 'N/A' : '—');
  document.getElementById('mt-device-note').textContent = note;
  document.getElementById('mt-device-result').classList.remove('hidden');
}

// ── Split datasets ────────────────────────────────────────────────────────────

function _updateDatasetSourceVisibility() {
  const registrySelected = document.getElementById('mt-cfg-source-registry')?.checked;
  document.getElementById('mt-cfg-local-source-fields')?.classList.toggle('hidden', !!registrySelected);
  document.getElementById('mt-cfg-registry-source-fields')?.classList.toggle('hidden', !registrySelected);
}

async function _fetchSplits(select) {
  if (!select) return;
  const token   = getToken();
  const project = getCurrentProject();
  if (!token || !project) {
    select.innerHTML = '<option value="">— open a project first —</option>';
    return;
  }
  select.innerHTML = '<option value="">— loading… —</option>';

  const datasets = getDatasetsForProject(project.id);
  if (!datasets.length) {
    select.innerHTML = '<option value="">— no datasets in project —</option>';
    return;
  }

  const allSplits = [];
  const sem = makeSemaphore(4);
  await Promise.all(datasets.map(ds =>
    sem(async () => {
      try {
        const splitFolder = await findFolder(token, 'split datasets', ds.driveFolderId);
        if (!splitFolder) return;
        const splits = await listAllFiles(
          token,
          `'${splitFolder.id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
          'id,name'
        );
        for (const s of splits) allSplits.push({ id: s.id, label: `${ds.name} / ${s.name}` });
      } catch { /* skip inaccessible */ }
    })
  ));

  allSplits.sort((a, b) => a.label.localeCompare(b.label));
  select.innerHTML = allSplits.length
    ? '<option value="">— select a split —</option>' +
      allSplits.map(s => `<option value="${escHtml(s.id)}">${escHtml(s.label)}</option>`).join('')
    : '<option value="">— no split datasets found —</option>';
}

// ── Dataset cache ─────────────────────────────────────────────────────────────

let _pdlTimer = null;

async function _checkSplitCache(folderId) {
  const row    = document.getElementById('mt-cfg-cache-row');
  const badge  = document.getElementById('mt-cfg-cache-badge');
  const dlBtn  = document.getElementById('mt-cfg-predownload-btn');
  const status = document.getElementById('mt-cfg-predownload-status');
  if (!row || !badge) return;

  if (!folderId) { row.classList.add('hidden'); return; }
  row.classList.remove('hidden');
  badge.textContent  = 'Checking…';
  badge.className    = 'badge badge-info';
  dlBtn?.classList.add('hidden');
  if (status) { status.textContent = ''; status.classList.add('hidden'); }

  if (!_connected) {
    badge.textContent = 'Connect server to check cache';
    badge.className   = 'badge badge-warn';
    return;
  }
  try {
    const res  = await serverFetch(`${_serverUrl}/cache-status?folder_id=${encodeURIComponent(folderId)}`);
    const data = await res.json();
    if (data.cached) {
      const size = data.size ? ` · ${formatSize(data.size)}` : '';
      const cnt  = data.file_count ? ` · ${data.file_count} files` : '';
      badge.textContent = `✓ Cached${cnt}${size}`;
      badge.className   = 'badge badge-success';
      dlBtn?.classList.add('hidden');
    } else {
      badge.textContent = 'Not cached';
      badge.className   = 'badge badge-warn';
      dlBtn?.classList.remove('hidden');
    }
  } catch (err) {
    const stale = err.message?.includes('not found (404)');
    badge.textContent = stale ? 'Re-download server script to enable caching' : 'Cache check failed';
    badge.className   = 'badge badge-warn';
  }
}

async function _startPreDownload(folderId) {
  const token = getToken();
  if (!token) { toast('Not signed in', 'error'); return; }
  if (!_connected) { toast('Connect to server first', 'error'); return; }

  const dlBtn  = document.getElementById('mt-cfg-predownload-btn');
  const status = document.getElementById('mt-cfg-predownload-status');
  const badge  = document.getElementById('mt-cfg-cache-badge');
  if (dlBtn) { dlBtn.disabled = true; dlBtn.textContent = 'Downloading…'; }
  if (status) { status.textContent = 'Starting…'; status.classList.remove('hidden'); }

  try {
    const res = await serverFetch(`${_serverUrl}/pre-download`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder_id: folderId, drive_token: token }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    if (_pdlTimer) clearInterval(_pdlTimer);
    _pdlTimer = setInterval(() => _pollPreDownload(folderId), 3000);
  } catch (err) {
    if (dlBtn) { dlBtn.disabled = false; dlBtn.textContent = '↓ Pre-download'; }
    if (status) { status.textContent = ''; status.classList.add('hidden'); }
    showError(err.message);
    toast('Pre-download failed — see error box', 'error');
  }
}

async function _pollPreDownload(folderId) {
  const dlBtn  = document.getElementById('mt-cfg-predownload-btn');
  const status = document.getElementById('mt-cfg-predownload-status');
  try {
    const res  = await serverFetch(`${_serverUrl}/pre-download-status`);
    const data = await res.json();
    const last = data.log?.at(-1) ?? '';
    if (status && last) status.textContent = last;

    if (data.state === 'done' || data.state === 'error') {
      clearInterval(_pdlTimer); _pdlTimer = null;
      if (dlBtn) { dlBtn.disabled = false; dlBtn.textContent = '↓ Pre-download'; }
      if (data.state === 'done') {
        toast('Dataset cached — training will skip the download next time', 'success');
        _checkSplitCache(folderId);
      } else {
        showError(data.log?.join('\n') || 'Pre-download failed');
        toast('Pre-download failed — see error box', 'error');
      }
    }
  } catch {
    clearInterval(_pdlTimer); _pdlTimer = null;
    if (dlBtn) { dlBtn.disabled = false; dlBtn.textContent = '↓ Pre-download'; }
  }
}

// ── Config management ─────────────────────────────────────────────────────────

function _defaultConfig(id) {
  const cfg = {
    id,
    name:           `Config ${id}`,
    status:         'pending',
    metricsHistory: [],
    task:           'detect',
    base_model:     'yolo26m',
    device:         'auto',
    optimizer:      'auto',
    run_name:        '',
    local_data_dir:  '',
    local_yaml_path: '',
    dataset_source:       'local',
    registry_split_id:    '',
    registry_split_label: '',
    kfold_enabled:   false,
    kfold_k:        5,
    pp_enabled:          false,
    pp_grayscale:        false,
    pp_brightness:       0,
    pp_contrast:         0,
    pp_saturation:       0,
    pp_gamma:            1.0,
    pp_gaussian_kernel:  1,
    pp_median_kernel:    1,
    pp_sharpen:          0,
    pp_clahe_clip:       0,
    pp_canny_enable:     false,
    pp_canny_low:        50,
    pp_canny_high:       150,
    pp_frangi_enable:    false,
    pp_frangi_scale_min: 1,
    pp_frangi_scale_max: 10,
  };
  for (const p of _PARAMS) cfg[p.id] = p.def;
  return cfg;
}

function _initConfigs() {
  _configs   = [_defaultConfig(1)];
  _activeIdx = 0;
  _renderQueue();
  _loadConfigIntoEditor(0);
}

function _renderQueue() {
  const list = document.getElementById('mt-queue-list');
  if (!list) return;
  list.innerHTML = _configs.map((cfg, i) => `
    <div class="mt-queue-item${i === _activeIdx ? ' active' : ''}" data-cfg-idx="${i}">
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(cfg.name)}</span>
      <span class="mt-q-badge ${cfg.status}">${cfg.status}</span>
    </div>`).join('');
  list.querySelectorAll('[data-cfg-idx]').forEach(el => {
    el.addEventListener('click', () => _selectConfig(parseInt(el.dataset.cfgIdx, 10)));
  });
}

function _selectConfig(idx) {
  _saveEditorToConfig();
  _activeIdx = idx;
  _renderQueue();
  _loadConfigIntoEditor(idx);
  const cfg = _configs[idx];
  if (cfg?.status === 'done' && cfg.metricsHistory?.length) {
    _resetCharts();
    updateMetricsCharts(cfg.metricsHistory);
  }
}

function _loadConfigIntoEditor(idx) {
  const cfg = _configs[idx];
  if (!cfg) return;

  const set    = (id, val) => { const el = document.getElementById(id); if (el) el.value   = val; };
  const setChk = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };

  set('mt-cfg-name',         cfg.name);
  set('mt-cfg-task',         cfg.task);
  set('mt-cfg-base-model',   cfg.base_model);
  set('mt-cfg-resume-model', cfg.local_model_path || '');
  set('mt-cfg-device',       cfg.device);
  set('mt-cfg-optimizer',    cfg.optimizer);
  set('mt-cfg-run-name',     cfg.run_name);
  set('mt-cfg-data-dir',    cfg.local_data_dir  || '');
  set('mt-cfg-yaml-path',   cfg.local_yaml_path || '');

  setChk('mt-cfg-source-local',    (cfg.dataset_source || 'local') === 'local');
  setChk('mt-cfg-source-registry', cfg.dataset_source === 'registry');
  _updateDatasetSourceVisibility();
  if (cfg.dataset_source === 'registry') {
    const select = document.getElementById('mt-cfg-registry-split');
    if (select && select.options.length <= 1) {
      _fetchSplits(select).then(() => { if (cfg.registry_split_id) select.value = cfg.registry_split_id; });
    } else if (select) {
      select.value = cfg.registry_split_id || '';
    }
  }

  set('mt-cfg-kfold-k',     cfg.kfold_k);
  setChk('mt-cfg-kfold-enable', cfg.kfold_enabled);
  const kEl = document.getElementById('mt-cfg-kfold-k');
  if (kEl) kEl.disabled = !cfg.kfold_enabled;

  for (const p of _PARAMS) {
    const val = cfg[p.id] ?? p.def;
    set(`mt-s-${p.id}`, val);
    set(`mt-n-${p.id}`, val);
  }

  setChk('mt-pp-enable', cfg.pp_enabled);
  document.getElementById('mt-pp-controls')?.classList.toggle('mt-pp-disabled', !cfg.pp_enabled);
  setChk('mt-pp-grayscale',     cfg.pp_grayscale);
  setChk('mt-pp-canny-enable',  cfg.pp_canny_enable);
  setChk('mt-pp-frangi-enable', cfg.pp_frangi_enable);

  const ppNums = [
    ['mt-pp-brightness',       cfg.pp_brightness],
    ['mt-pp-contrast',         cfg.pp_contrast],
    ['mt-pp-saturation',       cfg.pp_saturation],
    ['mt-pp-gamma',            cfg.pp_gamma],
    ['mt-pp-gaussian-kernel',  cfg.pp_gaussian_kernel],
    ['mt-pp-median-kernel',    cfg.pp_median_kernel],
    ['mt-pp-sharpen',          cfg.pp_sharpen],
    ['mt-pp-clahe-clip',       cfg.pp_clahe_clip],
    ['mt-pp-canny-low',        cfg.pp_canny_low],
    ['mt-pp-canny-high',       cfg.pp_canny_high],
    ['mt-pp-frangi-scale-min', cfg.pp_frangi_scale_min],
    ['mt-pp-frangi-scale-max', cfg.pp_frangi_scale_max],
  ];
  for (const [id, val] of ppNums) { set(id, val); set(`${id}-num`, val); }

  _updateOptimizerDesc();
}

function _saveEditorToConfig() {
  const cfg = _configs[_activeIdx];
  if (!cfg) return;

  const get    = id => { const el = document.getElementById(id); return el ? el.value : ''; };
  const getN   = (id, fb) => { const v = parseFloat(get(id)); return isNaN(v) ? fb : v; };
  const getI   = (id, fb) => { const v = parseInt(get(id), 10); return isNaN(v) ? fb : v; };
  const getChk = id => { const el = document.getElementById(id); return el ? el.checked : false; };

  cfg.name          = get('mt-cfg-name')         || cfg.name;
  cfg.task          = get('mt-cfg-task');
  cfg.base_model    = get('mt-cfg-base-model');
  cfg.local_model_path = get('mt-cfg-resume-model');
  cfg.device        = get('mt-cfg-device');
  cfg.optimizer     = get('mt-cfg-optimizer');
  cfg.run_name        = get('mt-cfg-run-name');
  cfg.local_data_dir  = get('mt-cfg-data-dir');
  cfg.local_yaml_path = get('mt-cfg-yaml-path');

  cfg.dataset_source = getChk('mt-cfg-source-registry') ? 'registry' : 'local';
  const regSelect = document.getElementById('mt-cfg-registry-split');
  cfg.registry_split_id    = regSelect?.value || '';
  cfg.registry_split_label = regSelect?.selectedOptions?.[0]?.textContent || '';

  cfg.kfold_enabled   = getChk('mt-cfg-kfold-enable');
  cfg.kfold_k       = getI('mt-cfg-kfold-k', 5);

  for (const p of _PARAMS) cfg[p.id] = getN(`mt-n-${p.id}`, p.def);

  cfg.pp_enabled          = getChk('mt-pp-enable');
  cfg.pp_grayscale        = getChk('mt-pp-grayscale');
  cfg.pp_brightness       = getN('mt-pp-brightness-num',       0);
  cfg.pp_contrast         = getN('mt-pp-contrast-num',         0);
  cfg.pp_saturation       = getN('mt-pp-saturation-num',       0);
  cfg.pp_gamma            = getN('mt-pp-gamma-num',            1.0);
  cfg.pp_gaussian_kernel  = getI('mt-pp-gaussian-kernel-num',  1);
  cfg.pp_median_kernel    = getI('mt-pp-median-kernel-num',    1);
  cfg.pp_sharpen          = getN('mt-pp-sharpen-num',          0);
  cfg.pp_clahe_clip       = getN('mt-pp-clahe-clip-num',       0);
  cfg.pp_canny_enable     = getChk('mt-pp-canny-enable');
  cfg.pp_canny_low        = getI('mt-pp-canny-low-num',        50);
  cfg.pp_canny_high       = getI('mt-pp-canny-high-num',       150);
  cfg.pp_frangi_enable    = getChk('mt-pp-frangi-enable');
  cfg.pp_frangi_scale_min = getN('mt-pp-frangi-scale-min-num', 1);
  cfg.pp_frangi_scale_max = getN('mt-pp-frangi-scale-max-num', 10);

  _renderQueue();
}

function _wireSliderPair(sliderId, numId, min, max, step) {
  const slider = document.getElementById(sliderId);
  const num    = document.getElementById(numId);
  if (!slider || !num) return;
  slider.addEventListener('input', () => { num.value = slider.value; });
  num.addEventListener('input', () => {
    let v = parseFloat(num.value);
    if (isNaN(v)) return;
    v = Math.min(max, Math.max(min, v));
    slider.value = v;
    num.value    = v;
  });
}

function _updateOptimizerDesc() {
  const sel  = document.getElementById('mt-cfg-optimizer');
  const desc = document.getElementById('mt-cfg-optimizer-desc');
  if (!sel || !desc) return;
  desc.textContent = _OPT_DESCS[sel.value] || '';
}

function _switchConfigTab(tab) {
  document.querySelectorAll('[data-cfg-tab]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.cfgTab === tab);
  });
  document.querySelectorAll('.mt-config-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `mt-cfgtab-${tab}`);
  });
  // (dataset tab needs no dynamic fetch — paths are user-entered)
}

function _resetPPDefaults() {
  const set    = (id, v) => { const el = document.getElementById(id); if (el) el.value   = v; };
  const setChk = (id, v) => { const el = document.getElementById(id); if (el) el.checked = v; };
  setChk('mt-pp-grayscale', false);
  setChk('mt-pp-canny-enable', false);
  setChk('mt-pp-frangi-enable', false);
  const defaults = [
    ['mt-pp-brightness', 0], ['mt-pp-contrast', 0], ['mt-pp-saturation', 0],
    ['mt-pp-gamma', 1.0], ['mt-pp-gaussian-kernel', 1], ['mt-pp-median-kernel', 1],
    ['mt-pp-sharpen', 0], ['mt-pp-clahe-clip', 0],
    ['mt-pp-canny-low', 50], ['mt-pp-canny-high', 150],
    ['mt-pp-frangi-scale-min', 1], ['mt-pp-frangi-scale-max', 10],
  ];
  for (const [id, v] of defaults) { set(id, v); set(`${id}-num`, v); }
  _saveEditorToConfig();
}

// ── Training flow ─────────────────────────────────────────────────────────────

function _startTrainAll() {
  _saveEditorToConfig();
  const pending = _configs
    .map((cfg, i) => ({ cfg, i }))
    .filter(({ cfg }) => cfg.status !== 'running');
  if (!pending.length) { toast('No configs to train', 'info'); return; }
  _trainQueue = pending.map(({ i }) => i);
  _advanceQueue();
}

function _startTrainSelected() {
  _saveEditorToConfig();
  const cfg = _configs[_activeIdx];
  if (!cfg) return;
  if (cfg.status === 'running') { toast('Config already running', 'info'); return; }
  _trainQueue = [_activeIdx];
  _advanceQueue();
}

async function _advanceQueue() {
  if (!_trainQueue.length) { _trainingIdx = null; return; }
  const idx = _trainQueue.shift();
  await _startConfig(idx);
}

async function _startConfig(idx) {
  if (!_connected) { toast('Connect to server first', 'error'); _trainQueue = []; return; }
  const cfg = _configs[idx];
  if (!cfg) return;
  if (cfg.dataset_source === 'registry') {
    if (!cfg.registry_split_id) { toast(`Config "${cfg.name}": select a registry dataset in the Dataset tab`, 'error'); _trainQueue = []; return; }
  } else if (!cfg.local_data_dir) {
    toast(`Config "${cfg.name}": set a Dataset Folder in the Dataset tab`, 'error'); _trainQueue = []; return;
  }
  if (!cfg.run_name) cfg.run_name = cfg.name.toLowerCase().replace(/\s+/g, '_');

  const token = getToken();
  if (!token) { toast('Not signed in', 'error'); return; }
  const project = getCurrentProject();
  if (!project) { toast('No project open', 'error'); return; }
  const modelsFolder = await getProjectModelsFolder(token).catch(() => null);
  if (!modelsFolder) { toast('Could not access models folder', 'error'); return; }

  cfg.status         = 'running';
  cfg.metricsHistory = [];
  _trainingIdx       = idx;
  _renderQueue();
  if (_activeIdx === idx) _loadConfigIntoEditor(idx);

  const consoleLog   = document.getElementById('mt-console-log');
  const progressFill = document.getElementById('mt-progress-fill');
  const progressPct  = document.getElementById('mt-progress-pct');
  const progressText = document.getElementById('mt-progress-text');
  if (consoleLog)   consoleLog.textContent   = '';
  if (progressFill) progressFill.style.width = '0%';
  if (progressPct)  progressPct.textContent  = '0%';
  if (progressText) progressText.textContent = `Training: ${cfg.name}`;

  // Reset batch progress bar
  const bfill  = document.getElementById('mt-batch-fill');
  const bpctEl = document.getElementById('mt-batch-pct');
  const btextEl = document.getElementById('mt-batch-text');
  if (bfill)   bfill.style.width   = '0%';
  if (bpctEl)  bpctEl.textContent  = '0%';
  if (btextEl) btextEl.textContent = 'Batch 0 / 0';

  // Reset Live Metrics tab epoch and batch bars
  const lmEpFill  = document.getElementById('mt-lm-epoch-fill');
  const lmEpPct   = document.getElementById('mt-lm-epoch-pct');
  const lmEpLabel = document.getElementById('mt-lm-epoch-label');
  if (lmEpFill)  lmEpFill.style.width   = '0%';
  if (lmEpPct)   lmEpPct.textContent    = '0%';
  if (lmEpLabel) lmEpLabel.textContent  = 'Epoch 0 / 0';
  const lmBFill  = document.getElementById('mt-lm-batch-fill');
  const lmBPct   = document.getElementById('mt-lm-batch-pct');
  const lmBLabel = document.getElementById('mt-lm-batch-label');
  if (lmBFill)  lmBFill.style.width   = '0%';
  if (lmBPct)   lmBPct.textContent    = '0%';
  if (lmBLabel) lmBLabel.textContent  = 'Batch 0 / 0';

  document.getElementById('mt-stop-btn')?.classList.remove('hidden');
  document.getElementById('mt-pause-btn')?.classList.remove('hidden');
  document.getElementById('mt-resume-btn')?.classList.add('hidden');
  document.getElementById('mt-batch-progress-row')?.classList.remove('hidden');
  _resetCharts();

  try {
    await serverFetch(`${_serverUrl}/train`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config:           _buildServerConfig(cfg),
        drive_token:      token,
        models_folder_id: modelsFolder.id,
      }),
      signal: AbortSignal.timeout(10000),
    });
    dismissError();
    startPolling();
    toast(`Training started: ${cfg.name}`, 'success');
  } catch (err) {
    cfg.status   = 'failed';
    _trainingIdx = null;
    _renderQueue();
    document.getElementById('mt-stop-btn')?.classList.add('hidden');
    showError(err.message);
    toast('Failed to start training — see error box', 'error');
    _advanceQueue();
  }
}

function _buildServerConfig(cfg) {
  const deviceMap = { auto: null, CPU: 'cpu', '0': 0 };
  return {
    base_model:      cfg.base_model, task: cfg.task,
    run_name:        cfg.run_name || cfg.name,
    device:          deviceMap[cfg.device] ?? null,
    optimizer:       cfg.optimizer,
    local_data_dir:  cfg.local_data_dir  || '',
    local_yaml_path: cfg.local_yaml_path || '',
    registry_folder_id: cfg.dataset_source === 'registry' ? (cfg.registry_split_id || '') : '',
    local_model_path: cfg.local_model_path || '',
    epochs: cfg.epochs, imgsz: cfg.imgsz, batch: cfg.batch,
    lr0: cfg.lr0, lrf: cfg.lrf, warmup_epochs: cfg.warmup_epochs, patience: cfg.patience,
    momentum: cfg.momentum, weight_decay: cfg.weight_decay,
    warmup_momentum: cfg.warmup_momentum, warmup_bias_lr: cfg.warmup_bias_lr,
    nbs: cfg.nbs, dropout: cfg.dropout, label_smoothing: cfg.label_smoothing,
    box: cfg.box, cls: cfg.cls, dfl: cfg.dfl,
    hsv_h: cfg.hsv_h, hsv_s: cfg.hsv_s, hsv_v: cfg.hsv_v,
    degrees: cfg.degrees, translate: cfg.translate, scale: cfg.scale,
    shear: cfg.shear, perspective: cfg.perspective,
    flipud: cfg.flipud, fliplr: cfg.fliplr, mosaic: cfg.mosaic, mixup: cfg.mixup,
    pp: {
      enabled:          cfg.pp_enabled,
      grayscale:        cfg.pp_grayscale,
      brightness:       cfg.pp_brightness,
      contrast:         cfg.pp_contrast,
      saturation:       cfg.pp_saturation,
      gamma:            cfg.pp_gamma,
      gaussian_kernel:  cfg.pp_gaussian_kernel,
      median_kernel:    cfg.pp_median_kernel,
      sharpen:          cfg.pp_sharpen,
      clahe_clip:       cfg.pp_clahe_clip,
      canny_enable:     cfg.pp_canny_enable,
      canny_low:        cfg.pp_canny_low,
      canny_high:       cfg.pp_canny_high,
      frangi_enable:    cfg.pp_frangi_enable,
      frangi_scale_min: cfg.pp_frangi_scale_min,
      frangi_scale_max: cfg.pp_frangi_scale_max,
    },
  };
}

async function pauseTraining() {
  try {
    await fetch(`${_serverUrl}/pause`, { method: 'POST', signal: AbortSignal.timeout(5000) });
    toast('Pausing after current epoch…', 'info');
  } catch {
    toast('Could not reach server', 'error');
  }
}

async function resumeTraining() {
  try {
    await fetch(`${_serverUrl}/resume`, { method: 'POST', signal: AbortSignal.timeout(5000) });
    toast('Training resumed', 'success');
  } catch {
    toast('Could not reach server', 'error');
  }
}

async function stopTraining() {
  _trainQueue = [];
  try {
    await fetch(`${_serverUrl}/stop`, { method: 'POST', signal: AbortSignal.timeout(5000) });
    toast('Training stopped', 'info');
  } catch {
    toast('Could not reach server', 'error');
  }
}

// ── Status polling ────────────────────────────────────────────────────────────

function startPolling() {
  if (_pollTimer) return;
  _pollTimer = setInterval(pollStatus, 2000);
}

function stopPolling() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

async function pollStatus() {
  try {
    const res  = await fetch(`${_serverUrl}/status`, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    const { state, epoch, total, batch, total_batches, log } = data;

    // Config tab epoch progress bar
    if (total > 0) {
      const pct = Math.round((epoch / total) * 100);
      document.getElementById('mt-progress-fill').style.width = `${pct}%`;
      document.getElementById('mt-progress-pct').textContent  = `${pct}%`;
      const pauseLabel = state === 'paused' ? ' · Paused' : '';
      document.getElementById('mt-progress-text').textContent = `Epoch ${epoch} / ${total}${pauseLabel}`;

      // Live Metrics tab — total training progress
      const lmEpFill  = document.getElementById('mt-lm-epoch-fill');
      const lmEpPct   = document.getElementById('mt-lm-epoch-pct');
      const lmEpLabel = document.getElementById('mt-lm-epoch-label');
      if (lmEpFill)  lmEpFill.style.width   = `${pct}%`;
      if (lmEpPct)   lmEpPct.textContent    = `${pct}%`;
      if (lmEpLabel) lmEpLabel.textContent  = `Epoch ${epoch} / ${total}${pauseLabel}`;
    }

    // Config tab batch progress bar
    if (total_batches > 0) {
      const bpct = Math.round((batch / total_batches) * 100);
      const bfill = document.getElementById('mt-batch-fill');
      const bpctEl = document.getElementById('mt-batch-pct');
      const btextEl = document.getElementById('mt-batch-text');
      if (bfill)   bfill.style.width    = `${bpct}%`;
      if (bpctEl)  bpctEl.textContent   = `${bpct}%`;
      if (btextEl) btextEl.textContent  = `Batch ${batch} / ${total_batches}`;

      // Live Metrics tab — per-epoch batch progress
      const lmBFill  = document.getElementById('mt-lm-batch-fill');
      const lmBPct   = document.getElementById('mt-lm-batch-pct');
      const lmBLabel = document.getElementById('mt-lm-batch-label');
      if (lmBFill)  lmBFill.style.width   = `${bpct}%`;
      if (lmBPct)   lmBPct.textContent    = `${bpct}%`;
      if (lmBLabel) lmBLabel.textContent  = `Batch ${batch} / ${total_batches}`;
    }

    const consoleLog = document.getElementById('mt-console-log');
    if (consoleLog && Array.isArray(log)) {
      consoleLog.textContent = log.join('\n');
      consoleLog.scrollTop   = consoleLog.scrollHeight;
    }

    if (Array.isArray(data.metrics_history)) {
      if (_trainingIdx !== null && _configs[_trainingIdx]) {
        _configs[_trainingIdx].metricsHistory = data.metrics_history;
      }
      updateMetricsCharts(data.metrics_history);
    }

    // Keep the server's drive token fresh — Google tokens expire after 1 hour.
    // Use refreshToken() (GIS silent refresh) so the server gets a genuinely new
    // token rather than the cached (potentially near-expiry) one from getToken().
    if (state === 'running' || state === 'paused') {
      const now = Date.now();
      if (now - _lastTokenRefresh > _TOKEN_REFRESH_MS) {
        _lastTokenRefresh = now;
        refreshToken().then(freshToken => {
          if (freshToken) {
            fetch(`${_serverUrl}/refresh-token`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ drive_token: freshToken }),
            }).catch(() => {});
          }
        }).catch(() => {});
      }
    }

    // Update pause/resume button visibility
    document.getElementById('mt-pause-btn')?.classList.toggle('hidden',  state !== 'running');
    document.getElementById('mt-resume-btn')?.classList.toggle('hidden', state !== 'paused');

    if (state !== 'running' && state !== 'paused') {
      stopPolling();
      document.getElementById('mt-stop-btn')?.classList.add('hidden');
      document.getElementById('mt-pause-btn')?.classList.add('hidden');
      document.getElementById('mt-resume-btn')?.classList.add('hidden');
      document.getElementById('mt-batch-progress-row')?.classList.add('hidden');

      if (_trainingIdx !== null && _configs[_trainingIdx]) {
        const cfg = _configs[_trainingIdx];
        if (state === 'done') {
          cfg.status = 'done';
          toast(`Training complete: ${cfg.name}`, 'success');
          loadModelRegistry();
          _switchTrnTab('postmetrics');
        } else if (state === 'stopped') {
          cfg.status = 'stopped';
          toast(`Stopped: ${cfg.name}`, 'info');
        } else if (state === 'error') {
          cfg.status = 'failed';
          const logContent = Array.isArray(data.log) ? data.log.join('\n') : '';
          showError(logContent || 'Training failed — no error details available');
          toast('Training error — see error box', 'error');
        }
        _renderQueue();
        _trainingIdx = null;
      }

      const progressText = document.getElementById('mt-progress-text');
      if (progressText) {
        progressText.textContent = state === 'done' ? 'Complete' : state === 'stopped' ? 'Stopped' : 'Error';
      }

      _advanceQueue();
    }
  } catch { /* server temporarily unreachable */ }
}

// ── Preprocessing preview ─────────────────────────────────────────────────────

async function previewPreprocessing() {
  if (!_connected) { toast('Connect to server first', 'error'); return; }
  const fileInput = document.getElementById('mt-pp-file-input');
  const file = fileInput?.files?.[0];
  if (!file) { toast('Upload an image first', 'error'); return; }

  _saveEditorToConfig();
  const cfg = _configs[_activeIdx];
  const pp = {
    enabled:          true,
    grayscale:        cfg.pp_grayscale,
    brightness:       cfg.pp_brightness,
    contrast:         cfg.pp_contrast,
    saturation:       cfg.pp_saturation,
    gamma:            cfg.pp_gamma,
    gaussian_kernel:  cfg.pp_gaussian_kernel,
    median_kernel:    cfg.pp_median_kernel,
    sharpen:          cfg.pp_sharpen,
    clahe_clip:       cfg.pp_clahe_clip,
    canny_enable:     cfg.pp_canny_enable,
    canny_low:        cfg.pp_canny_low,
    canny_high:       cfg.pp_canny_high,
    frangi_enable:    cfg.pp_frangi_enable,
    frangi_scale_min: cfg.pp_frangi_scale_min,
    frangi_scale_max: cfg.pp_frangi_scale_max,
  };

  const btn = document.getElementById('mt-pp-preview-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Processing…'; }

  try {
    const formData = new FormData();
    formData.append('image', file);
    formData.append('pp', JSON.stringify(pp));
    const res  = await serverFetch(`${_serverUrl}/preprocess-preview`, { method: 'POST', body: formData });
    const data = await res.json();
    const procImg = document.getElementById('mt-pp-proc-img');
    if (procImg && data.processed) procImg.src = `data:image/jpeg;base64,${data.processed}`;
    if (data.original) {
      const origImg = document.getElementById('mt-pp-orig-img');
      if (origImg) origImg.src = `data:image/jpeg;base64,${data.original}`;
    }
    document.getElementById('mt-pp-preview-grid')?.classList.remove('hidden');
    toast('Preview ready', 'success');
  } catch (err) {
    showError(err.message);
    toast('Preview failed — see error box', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Preview'; }
  }
}

// ── Model registry ────────────────────────────────────────────────────────────

async function loadModelRegistry() {
  const token   = getToken();
  const project = getCurrentProject();
  const listEl  = document.getElementById('mt-registry-list');
  if (!listEl) return;

  if (!token || !project) {
    listEl.innerHTML = '<p class="text-dim" style="font-size:13px;">Open a project to view models.</p>';
    return;
  }
  listEl.innerHTML = '<p class="text-dim" style="font-size:13px;">Loading…</p>';

  try {
    const modelsFolder = await getProjectModelsFolder(token);
    if (!modelsFolder) { listEl.innerHTML = '<p class="text-dim" style="font-size:13px;">Models folder not found.</p>'; return; }

    const all    = await listAllFiles(token, `'${modelsFolder.id}' in parents and trashed=false`, 'id,name,size,createdTime');
    const models = all.filter(f => f.name.endsWith('.pt'));

    if (!models.length) {
      listEl.innerHTML = '<p class="text-dim" style="font-size:13px;">No models yet. Train a model to see it here.</p>';
      return;
    }

    models.sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime));
    listEl.innerHTML = `
      <table class="summary-table">
        <thead><tr><th>Name</th><th>Uploaded</th><th>Size</th><th></th></tr></thead>
        <tbody>
          ${models.map(m => `
            <tr>
              <td style="font-family:monospace;font-size:12px;">${escHtml(m.name)}</td>
              <td style="color:var(--text-dim);font-size:12px;">${formatDate(m.createdTime)}</td>
              <td style="color:var(--text-dim);font-size:12px;">${formatSize(m.size)}</td>
              <td><button class="btn btn-ghost btn-sm" style="color:var(--danger);"
                data-delete-model="${escHtml(m.id)}" data-model-name="${escHtml(m.name)}">Delete</button></td>
            </tr>`).join('')}
        </tbody>
      </table>`;
    listEl.querySelectorAll('[data-delete-model]').forEach(btn => {
      btn.addEventListener('click', () => deleteModel(btn.dataset.deleteModel, btn.dataset.modelName));
    });
  } catch (err) {
    listEl.innerHTML = `<p class="text-dim" style="font-size:13px;">Error: ${escHtml(err.message)}</p>`;
  }
}

async function deleteModel(fileId, name) {
  const token = getToken();
  if (!token) { toast('Not signed in', 'error'); return; }
  try {
    await deleteFile(token, fileId);
    toast(`${name} deleted`, 'success');
    loadModelRegistry();
  } catch (err) {
    toast(`Delete failed: ${err.message}`, 'error');
  }
}

async function uploadModel() {
  const token   = getToken();
  const project = getCurrentProject();
  if (!token || !project) { toast('Sign in and open a project first', 'error'); return; }
  const input = document.createElement('input');
  input.type   = 'file';
  input.accept = '.pt';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const modelsFolder = await getProjectModelsFolder(token);
      if (!modelsFolder) { toast('Could not access models folder', 'error'); return; }
      await upsertFile(token, modelsFolder.id, file.name, 'application/octet-stream', file);
      toast(`${file.name} uploaded`, 'success');
      loadModelRegistry();
    } catch (err) {
      toast(`Upload failed: ${err.message}`, 'error');
    }
  };
  input.click();
}

// ── Models page ───────────────────────────────────────────────────────────────

async function _pollUploadRun() {
  const res  = await fetch(`${_serverUrl}/upload-run-status`);
  const data = await res.json();
  if (data.state === 'running') { setTimeout(_pollUploadRun, 1500); return; }
  if (data.state === 'done') { toast('Run added to model registry', 'success'); _loadModelsPage(); }
  else { toast(`Upload failed: ${data.error || 'unknown error'}`, 'error'); }
}

async function _loadModelsPage() {
  const tbody = document.getElementById('mt-models-table-body');
  if (!tbody) return;
  const token   = getToken();
  const project = getCurrentProject();
  if (!token || !project) {
    tbody.innerHTML = `<tr><td colspan="11" class="mm-placeholder">Open a project first.</td></tr>`;
    return;
  }
  tbody.innerHTML = `<tr><td colspan="11" class="mm-placeholder">Loading…</td></tr>`;
  try {
    const modelsFolder = await getProjectModelsFolder(token);
    if (!modelsFolder) {
      tbody.innerHTML = `<tr><td colspan="11" class="mm-placeholder">Models folder not found.</td></tr>`;
      return;
    }
    const all = await listAllFiles(token, `'${modelsFolder.id}' in parents and trashed=false`, 'id,name,size,createdTime');

    const ptFiles   = all.filter(f => f.name.endsWith('.pt'));
    const jsonFiles = all.filter(f => f.name.endsWith('_metrics.json'));

    const metricsMap = {};
    for (const f of jsonFiles) {
      const runName = f.name.replace(/_metrics\.json$/, '');
      metricsMap[runName] = f.id;
    }

    const models = ptFiles.map(f => {
      const runName = f.name.replace(/_best\.pt$/, '').replace(/\.pt$/, '');
      return { id: f.id, name: f.name, size: f.size, createdTime: f.createdTime,
               runName, metricsFileId: metricsMap[runName] || null, summary: null };
    });
    models.sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime));

    const sem = makeSemaphore(4);
    await Promise.all(models.map(m => {
      if (!m.metricsFileId) return Promise.resolve();
      if (_modelMetricsCache[m.metricsFileId]) {
        m.summary = _modelMetricsCache[m.metricsFileId].summary;
        return Promise.resolve();
      }
      return sem(async () => {
        try {
          const res = await fetch(`https://www.googleapis.com/drive/v3/files/${m.metricsFileId}?alt=media`,
            { headers: { Authorization: `Bearer ${token}` } });
          if (!res.ok) return;
          const data = await res.json();
          _modelMetricsCache[m.metricsFileId] = data;
          m.summary = data.summary;
        } catch { /* skip bad files */ }
      });
    }));

    _modelRegistry = models;
    _renderModelsTable(models);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="11" class="mm-placeholder">Error: ${escHtml(err.message)}</td></tr>`;
  }
}

function _renderModelsTable(models) {
  const tbody = document.getElementById('mt-models-table-body');
  if (!tbody) return;
  if (!models.length) {
    tbody.innerHTML = `<tr><td colspan="11" class="mm-placeholder">No models yet. Train a model to see it here.</td></tr>`;
    return;
  }
  const fmt = v => (v != null ? Number(v).toFixed(4) : '—');
  const METRIC_FIELDS = ['best_map50', 'best_map50_95', 'best_mask_map50', 'best_mask_map50_95', 'final_precision', 'final_recall'];
  tbody.innerHTML = models.map(m => {
    const s       = m.summary || {};
    const sel     = _selectedModelIds.has(m.id);
    const editing = m.id === _editingMetricsId;

    const metricCells = editing
      ? METRIC_FIELDS.map(f => `
          <td style="font-size:12px;">
            <input type="number" step="0.0001" class="mt-cfg-input" style="width:70px;"
              data-metric-field="${f}" value="${s[f] != null ? s[f] : ''}" />
          </td>`).join('')
      : METRIC_FIELDS.map(f => `<td style="font-size:12px;">${fmt(s[f])}</td>`).join('');

    const actionCell = editing
      ? `<td style="display:flex;gap:0.25rem;">
          <button class="btn btn-primary btn-sm" data-save-metrics="${escHtml(m.id)}">Save</button>
          <button class="btn btn-ghost btn-sm" data-cancel-metrics="${escHtml(m.id)}">Cancel</button>
        </td>`
      : `<td style="display:flex;gap:0.25rem;flex-wrap:wrap;">
          <button class="btn btn-primary btn-sm" title="Download model"
            data-download-model="${escHtml(m.id)}" data-model-name="${escHtml(m.name)}">Download</button>
          <button class="btn btn-ghost btn-sm" title="Rename model"
            data-rename-model="${escHtml(m.id)}" data-model-name="${escHtml(m.name)}"
            data-run-name="${escHtml(m.runName || '')}" data-metrics-file="${escHtml(m.metricsFileId || '')}">Rename</button>
          <button class="btn btn-ghost btn-sm" title="Edit metrics" data-edit-metrics="${escHtml(m.id)}">Edit</button>
          <button class="btn btn-ghost btn-sm" style="color:var(--danger);"
            data-delete-model="${escHtml(m.id)}" data-model-name="${escHtml(m.name)}">Delete</button>
        </td>`;

    return `
      <tr class="${sel ? 'mm-row-selected' : ''}" data-model-id="${escHtml(m.id)}">
        <td style="text-align:center;">
          <input type="checkbox" data-cmp-model="${escHtml(m.id)}"
            data-metrics-file="${escHtml(m.metricsFileId || '')}"
            ${sel ? 'checked' : ''} />
        </td>
        <td style="font-family:monospace;font-size:12px;">${escHtml(m.name)}</td>
        <td style="color:var(--text-dim);font-size:12px;">${formatDate(m.createdTime)}</td>
        <td style="color:var(--text-dim);font-size:12px;">${formatSize(m.size)}</td>
        ${metricCells}
        ${actionCell}
      </tr>`;
  }).join('');

  tbody.querySelectorAll('[data-cmp-model]').forEach(chk => {
    chk.addEventListener('change', () => _toggleModelSelection(chk.dataset.cmpModel, chk.dataset.metricsFile));
  });
  tbody.querySelectorAll('[data-download-model]').forEach(btn => {
    btn.addEventListener('click', () => _downloadModel(btn.dataset.downloadModel, btn.dataset.modelName));
  });
  tbody.querySelectorAll('[data-rename-model]').forEach(btn => {
    btn.addEventListener('click', () => _renameModel(btn.dataset.renameModel, btn.dataset.modelName, btn.dataset.runName, btn.dataset.metricsFile));
  });
  tbody.querySelectorAll('[data-edit-metrics]').forEach(btn => {
    btn.addEventListener('click', () => {
      _editingMetricsId = btn.dataset.editMetrics;
      _renderModelsTable(_modelRegistry);
    });
  });
  tbody.querySelectorAll('[data-cancel-metrics]').forEach(btn => {
    btn.addEventListener('click', () => {
      _editingMetricsId = null;
      _renderModelsTable(_modelRegistry);
    });
  });
  tbody.querySelectorAll('[data-save-metrics]').forEach(btn => {
    btn.addEventListener('click', () => _saveModelMetrics(btn.dataset.saveMetrics));
  });
  tbody.querySelectorAll('[data-delete-model]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await deleteModel(btn.dataset.deleteModel, btn.dataset.modelName);
      _loadModelsPage();
    });
  });
}

async function _renameModel(modelId, currentName, runName, metricsFileId) {
  const token = getToken();
  if (!token) { toast('Not signed in', 'error'); return; }

  const defaultName = runName || currentName.replace(/\.pt$/, '');
  const newName = prompt('New name for this model:', defaultName);
  if (!newName || newName === defaultName) return;

  const isBest    = /_best\.pt$/.test(currentName);
  const newPtName = isBest ? `${newName}_best.pt` : `${newName}.pt`;

  try {
    await renameFile(token, modelId, newPtName);
    if (metricsFileId) {
      await renameFile(token, metricsFileId, `${newName}_metrics.json`);
    }
    if (runName) {
      const modelsFolder = await getProjectModelsFolder(token).catch(() => null);
      if (modelsFolder) {
        const artifacts = await listAllFiles(token,
          `'${modelsFolder.id}' in parents and trashed=false and name contains '${runName}__'`, 'id,name');
        for (const f of artifacts) {
          if (!f.name.startsWith(`${runName}__`)) continue;
          await renameFile(token, f.id, newName + f.name.slice(runName.length));
        }
      }
    }
    toast('Renamed', 'success');
    _loadModelsPage();
  } catch (err) {
    toast(`Rename failed: ${err.message}`, 'error');
  }
}

async function _saveModelMetrics(modelId) {
  const token = getToken();
  if (!token) { toast('Not signed in', 'error'); return; }
  const m = _modelRegistry.find(x => x.id === modelId);
  if (!m) return;

  const row    = document.querySelector(`tr[data-model-id="${modelId}"]`);
  const edited = {};
  row?.querySelectorAll('[data-metric-field]').forEach(input => {
    const v = input.value.trim();
    edited[input.dataset.metricField] = v === '' ? null : Number(v);
  });

  const existing = (m.metricsFileId && _modelMetricsCache[m.metricsFileId]) || {};
  const payload  = {
    ...existing,
    run_name: existing.run_name || m.runName,
    summary:  { ...(existing.summary || {}), ...edited },
  };

  try {
    const modelsFolder = await getProjectModelsFolder(token);
    if (!modelsFolder) { toast('Could not access models folder', 'error'); return; }

    const blob   = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const result = await upsertFile(token, modelsFolder.id, `${m.runName}_metrics.json`,
      'application/json', blob, m.metricsFileId || undefined);

    _modelMetricsCache[result.id] = payload;
    m.metricsFileId   = result.id;
    m.summary         = payload.summary;
    _editingMetricsId = null;
    _renderModelsTable(_modelRegistry);
    toast('Metrics updated', 'success');
  } catch (err) {
    toast(`Save failed: ${err.message}`, 'error');
  }
}

function _toggleModelSelection(modelId) {
  const row = document.querySelector(`tr[data-model-id="${modelId}"]`);
  if (_selectedModelIds.has(modelId)) {
    _selectedModelIds.delete(modelId);
    row?.classList.remove('mm-row-selected');
  } else {
    _selectedModelIds.add(modelId);
    row?.classList.add('mm-row-selected');
  }
  _updateCmpCharts();
}

function _destroyCmpCharts() {
  for (const key of Object.keys(_cmpCharts)) {
    if (_cmpCharts[key]) { _cmpCharts[key].destroy(); delete _cmpCharts[key]; }
  }
}

function _updateCmpCharts() {
  const placeholder = document.getElementById('mm-cmp-placeholder');
  const chartsDiv   = document.getElementById('mm-cmp-charts');
  const selBadge    = document.getElementById('mm-sel-badge');

  const count = _selectedModelIds.size;
  if (selBadge) {
    selBadge.textContent = `${count} selected`;
    selBadge.classList.toggle('hidden', count === 0);
  }

  if (count === 0) {
    placeholder?.classList.remove('hidden');
    chartsDiv?.classList.add('hidden');
    _destroyCmpCharts();
    return;
  }

  placeholder?.classList.add('hidden');
  chartsDiv?.classList.remove('hidden');

  _destroyCmpCharts();
  _cmpCharts.map50   = _makeChart('mt-cmp-map50',   []);
  _cmpCharts.map95   = _makeChart('mt-cmp-map95',   []);
  _cmpCharts.segmap50 = _makeChart('mt-cmp-segmap50', []);
  _cmpCharts.segmap95 = _makeChart('mt-cmp-segmap95', []);
  _cmpCharts.prec    = _makeChart('mt-cmp-prec',    []);
  _cmpCharts.rec     = _makeChart('mt-cmp-rec',     []);
  _cmpCharts.tloss   = _makeChart('mt-cmp-tloss',   []);
  _cmpCharts.vloss   = _makeChart('mt-cmp-vloss',   []);

  const pick = (m, ...keys) => { for (const k of keys) if (m[k] != null) return m[k]; return null; };

  let colorIdx = 0;
  for (const modelId of _selectedModelIds) {
    const entry = _modelRegistry.find(m => m.id === modelId);
    if (!entry?.metricsFileId) continue;
    const cached = _modelMetricsCache[entry.metricsFileId];
    if (!cached) continue;

    const history = cached.metrics_history || [];
    if (!history.length) continue;

    const modelName = cached.run_name || entry.name;
    const color     = _MODEL_COLORS[colorIdx % _MODEL_COLORS.length];
    colorIdx++;

    const epochs = history.map((_, i) => i + 1);

    const addDs = (chart, seriesData) => {
      if (!chart) return;
      if (!chart.data.labels.length) chart.data.labels = epochs;
      const ds = _ds(modelName, color);
      ds.data = seriesData;
      chart.data.datasets.push(ds);
    };

    const trainLoss = history.map(m => {
      const box = pick(m, 'train/box_loss') ?? 0;
      const cls = pick(m, 'train/cls_loss') ?? 0;
      const dfl = pick(m, 'train/dfl_loss') ?? 0;
      return (box + cls + dfl) || null;
    });
    const valLoss = history.map(m => {
      const box = pick(m, 'val/box_loss') ?? 0;
      const cls = pick(m, 'val/cls_loss') ?? 0;
      const dfl = pick(m, 'val/dfl_loss') ?? 0;
      return (box + cls + dfl) || null;
    });

    addDs(_cmpCharts.map50,    history.map(m => pick(m, 'metrics/mAP50(B)', 'metrics/mAP_0.5')));
    addDs(_cmpCharts.map95,    history.map(m => pick(m, 'metrics/mAP50-95(B)', 'metrics/mAP_0.5:0.95')));
    addDs(_cmpCharts.segmap50, history.map(m => pick(m, 'metrics/mAP50(M)', 'metrics/mask_mAP50')));
    addDs(_cmpCharts.segmap95, history.map(m => pick(m, 'metrics/mAP50-95(M)', 'metrics/mask_mAP50-95')));
    addDs(_cmpCharts.prec,     history.map(m => pick(m, 'metrics/precision(B)', 'metrics/precision')));
    addDs(_cmpCharts.rec,      history.map(m => pick(m, 'metrics/recall(B)', 'metrics/recall')));
    addDs(_cmpCharts.tloss,    trainLoss);
    addDs(_cmpCharts.vloss,    valLoss);
  }

  Object.values(_cmpCharts).forEach(c => c?.update('none'));
}

// ── Metrics charts ────────────────────────────────────────────────────────────

function _makeChart(canvasId, datasets) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !window.Chart) return null;
  return new window.Chart(canvas, {
    type: 'line',
    data: { labels: [], datasets },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#888', font: { size: 11 }, boxWidth: 12, padding: 8 } },
        datalabels: { display: false },
        tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y?.toFixed(4) ?? '—'}` } },
      },
      scales: {
        x: {
          ticks: { color: '#888', font: { size: 10 }, maxTicksLimit: 10 },
          grid:  { color: '#3e3e42' },
          title: { display: true, text: 'Epoch', color: '#666', font: { size: 10 } },
        },
        y: {
          ticks: { color: '#888', font: { size: 10 } },
          grid:  { color: '#3e3e42' },
        },
      },
    },
  });
}

function _ds(label, color, dash = false) {
  return {
    label, data: [], borderColor: color, backgroundColor: 'transparent',
    borderWidth: 2, borderDash: dash ? [4, 3] : [],
    pointRadius: 2, pointHoverRadius: 4, tension: 0.3, spanGaps: true,
  };
}

function _initMetricsCharts() {
  _charts.trainLoss = _makeChart('mt-chart-train-loss', [
    _ds('box_loss', '#007acc'), _ds('cls_loss', '#4ec9b0'),
    _ds('dfl_loss', '#dcdcaa'), _ds('seg_loss', '#c792ea'),
  ]);
  _charts.valLoss = _makeChart('mt-chart-val-loss', [
    _ds('box_loss', '#007acc'), _ds('cls_loss', '#4ec9b0'),
    _ds('dfl_loss', '#dcdcaa'), _ds('seg_loss', '#c792ea'),
  ]);
  _charts.map = _makeChart('mt-chart-map', [
    _ds('mAP50', '#4ec9b0'), _ds('mAP50-95', '#dcdcaa'),
  ]);
  _charts.segMap = _makeChart('mt-chart-seg-map', [
    _ds('mask mAP50', '#c792ea'), _ds('mask mAP50-95', '#89ddff'),
  ]);
  _charts.pr = _makeChart('mt-chart-pr', [
    _ds('Precision', '#007acc'), _ds('Recall', '#f44747'),
  ]);
  _charts.lr = _makeChart('mt-chart-lr', [
    _ds('pg0', '#007acc'), _ds('pg1', '#4ec9b0'), _ds('pg2', '#dcdcaa'),
  ]);
}

function _resetCharts() {
  for (const key of Object.keys(_charts)) {
    if (_charts[key]) { _charts[key].destroy(); _charts[key] = null; }
  }
}

// ── Post Metrics tab ──────────────────────────────────────────────────────────

const _PM_IMAGE_LABELS = {
  'confusion_matrix_normalized.png': 'Confusion Matrix (Normalized)',
  'confusion_matrix.png':            'Confusion Matrix',
  'results.png':                     'Training Results',
  'PR_curve.png':                    'Precision-Recall Curve',
  'F1_curve.png':                    'F1 Score Curve',
  'P_curve.png':                     'Precision Curve',
  'R_curve.png':                     'Recall Curve',
  'labels.jpg':                      'Label Distribution',
  'labels_correlogram.jpg':          'Label Correlogram',
};

async function _loadPostMetrics() {
  const content = document.getElementById('mt-pm-content');
  const label   = document.getElementById('mt-pm-run-label');
  if (!content) return;

  if (!_connected) {
    content.innerHTML = '<p class="text-dim mt-pm-placeholder">Connect to the server first.</p>';
    return;
  }

  content.innerHTML = '<p class="text-dim mt-pm-placeholder">Loading…</p>';

  try {
    const res  = await serverFetch(`${_serverUrl}/post-metrics`);
    const data = await res.json();

    if (!data.ready) {
      content.innerHTML = '<p class="text-dim mt-pm-placeholder">Complete a training run to see post-training metrics.</p>';
      if (label) label.textContent = '';
      return;
    }

    if (label) {
      const parts = [data.run_name, data.base_model, data.epochs_completed ? `${data.epochs_completed} epochs` : ''].filter(Boolean);
      label.textContent = parts.join(' · ');
    }

    const fmt = v => v != null ? v.toFixed(4) : '—';
    const s   = data.summary || {};

    // ── Summary tiles ──────────────────────────────────────────────────────
    const tileDefs = [
      { label: 'BBox mAP50',    val: fmt(s.best_map50),      highlight: true },
      { label: 'BBox mAP50-95', val: fmt(s.best_map50_95),   highlight: true },
      { label: 'Best Epoch',    val: s.best_map50_epoch ?? '—' },
      { label: 'Precision',     val: fmt(s.final_precision) },
      { label: 'Recall',        val: fmt(s.final_recall) },
    ];
    if (s.best_mask_map50    != null) tileDefs.push({ label: 'Mask mAP50',    val: fmt(s.best_mask_map50),    highlight: true });
    if (s.best_mask_map50_95 != null) tileDefs.push({ label: 'Mask mAP50-95', val: fmt(s.best_mask_map50_95), highlight: true });

    const tilesHTML = tileDefs.map(t => `
      <div class="mt-lm-stat-tile${t.highlight ? ' mt-pm-tile-accent' : ''}">
        <span class="mt-lm-stat-label">${t.label}</span>
        <span class="mt-lm-stat-val">${t.val}</span>
      </div>`).join('');

    // ── Per-class tables ───────────────────────────────────────────────────
    const makeClassTable = (obj) => {
      if (!obj || !Object.keys(obj).length) return '';
      const rows = Object.entries(obj).map(([name, m]) =>
        `<tr><td>${escHtml(name)}</td><td>${m.p.toFixed(4)}</td><td>${m.r.toFixed(4)}</td>` +
        `<td>${m.ap50.toFixed(4)}</td><td>${m.ap.toFixed(4)}</td></tr>`
      ).join('');
      return `<table class="summary-table">
        <thead><tr><th>Class</th><th>Precision</th><th>Recall</th><th>mAP50</th><th>mAP50-95</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    };

    let classHTML = '';
    const hasBbox = data.class_metrics     && Object.keys(data.class_metrics).length;
    const hasSeg  = data.class_metrics_seg && Object.keys(data.class_metrics_seg).length;
    if (hasBbox || hasSeg) {
      classHTML = `<div class="mt-pm-section">`;
      if (hasBbox) classHTML += `<div class="mt-lm-section-title">Per-Class — Bounding Box</div>${makeClassTable(data.class_metrics)}`;
      if (hasSeg)  classHTML += `<div class="mt-lm-section-title" style="margin-top:.75rem;">Per-Class — Segmentation Mask</div>${makeClassTable(data.class_metrics_seg)}`;
      classHTML += `</div>`;
    }

    // ── Result images ──────────────────────────────────────────────────────
    const imgEntries = Object.entries(data.images || {});
    const imagesHTML = imgEntries.length
      ? imgEntries.map(([name, src]) => `
          <div class="mt-pm-img-wrap">
            <p class="mt-chart-title">${_PM_IMAGE_LABELS[name] || name}</p>
            <img src="${src}" alt="${escHtml(name)}" class="mt-pm-img" loading="lazy" />
          </div>`).join('')
      : '<p class="text-dim mt-pm-placeholder" style="grid-column:1/-1;">No result images found in run directory.</p>';

    content.innerHTML = `
      <div class="mt-lm-stats-row">${tilesHTML}</div>
      ${classHTML}
      <div class="mt-pm-img-grid">${imagesHTML}</div>`;

  } catch (err) {
    content.innerHTML = `<p class="text-dim mt-pm-placeholder">Error: ${escHtml(err.message)}</p>`;
  }
}

function updateMetricsCharts(history) {
  if (!history?.length) return;
  if (!_charts.trainLoss) _initMetricsCharts();

  const epochs = history.map((_, i) => i + 1);
  const pick = (m, ...keys) => { for (const k of keys) if (m[k] != null) return m[k]; return null; };

  _setChartData(_charts.trainLoss, epochs, [
    history.map(m => pick(m, 'train/box_loss')),
    history.map(m => pick(m, 'train/cls_loss')),
    history.map(m => pick(m, 'train/dfl_loss')),
    history.map(m => pick(m, 'train/seg_loss')),
  ]);
  _setChartData(_charts.valLoss, epochs, [
    history.map(m => pick(m, 'val/box_loss')),
    history.map(m => pick(m, 'val/cls_loss')),
    history.map(m => pick(m, 'val/dfl_loss')),
    history.map(m => pick(m, 'val/seg_loss')),
  ]);
  _setChartData(_charts.map, epochs, [
    history.map(m => pick(m, 'metrics/mAP50(B)', 'metrics/mAP_0.5')),
    history.map(m => pick(m, 'metrics/mAP50-95(B)', 'metrics/mAP_0.5:0.95')),
  ]);
  _setChartData(_charts.segMap, epochs, [
    history.map(m => pick(m, 'metrics/mAP50(M)',    'metrics/mask_mAP50',    'metrics/seg_mAP50')),
    history.map(m => pick(m, 'metrics/mAP50-95(M)', 'metrics/mask_mAP50-95', 'metrics/seg_mAP50-95')),
  ]);
  _setChartData(_charts.pr, epochs, [
    history.map(m => pick(m, 'metrics/precision(B)', 'metrics/precision')),
    history.map(m => pick(m, 'metrics/recall(B)', 'metrics/recall')),
  ]);
  _setChartData(_charts.lr, epochs, [
    history.map(m => pick(m, 'lr/pg0')),
    history.map(m => pick(m, 'lr/pg1')),
    history.map(m => pick(m, 'lr/pg2')),
  ]);

  // Update stat tiles
  const last = history[history.length - 1];
  const bestM50 = history.reduce((best, m) => {
    const v = pick(m, 'metrics/mAP50(B)', 'metrics/mAP_0.5');
    return (v != null && (best == null || v > best)) ? v : best;
  }, null);
  const fmt = v => v != null ? v.toFixed(4) : '—';
  const sumLoss = (m, prefix) => {
    const b = pick(m, `${prefix}/box_loss`) ?? 0;
    const c = pick(m, `${prefix}/cls_loss`) ?? 0;
    const d = pick(m, `${prefix}/dfl_loss`) ?? 0;
    const s = pick(m, `${prefix}/seg_loss`) ?? 0;
    const total = b + c + d + s;
    return total > 0 ? total.toFixed(4) : null;
  };
  const setEl = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  const bestM95 = history.reduce((best, m) => {
    const v = pick(m, 'metrics/mAP50-95(B)', 'metrics/mAP_0.5:0.95');
    return (v != null && (best == null || v > best)) ? v : best;
  }, null);
  const bestSeg50 = history.reduce((best, m) => {
    const v = pick(m, 'metrics/mAP50(M)', 'metrics/mask_mAP50');
    return (v != null && (best == null || v > best)) ? v : best;
  }, null);
  const bestSeg95 = history.reduce((best, m) => {
    const v = pick(m, 'metrics/mAP50-95(M)', 'metrics/mask_mAP50-95');
    return (v != null && (best == null || v > best)) ? v : best;
  }, null);
  setEl('mt-lm-epoch',  `${history.length}`);
  setEl('mt-lm-map50',  fmt(bestM50));
  setEl('mt-lm-map95',  fmt(bestM95));
  setEl('mt-lm-seg50',  bestSeg50 != null ? fmt(bestSeg50) : '—');
  setEl('mt-lm-seg95',  bestSeg95 != null ? fmt(bestSeg95) : '—');
  setEl('mt-lm-prec',   fmt(pick(last, 'metrics/precision(B)', 'metrics/precision')));
  setEl('mt-lm-recall', fmt(pick(last, 'metrics/recall(B)', 'metrics/recall')));
  setEl('mt-lm-tloss',  sumLoss(last, 'train') ?? '—');
  setEl('mt-lm-vloss',  sumLoss(last, 'val')   ?? '—');

  // Update per-class table
  const wrap = document.getElementById('mt-lm-class-wrap');
  if (wrap) {
    const bboxData = last?.class_metrics;
    const segData  = last?.class_metrics_seg;
    const hasBbox  = bboxData && Object.keys(bboxData).length;
    const hasSeg   = segData  && Object.keys(segData).length;

    if (hasBbox || hasSeg) {
      const makeTable = (data) => {
        const rows = Object.entries(data).map(([name, m]) =>
          `<tr><td>${escHtml(name)}</td><td>${m.p.toFixed(4)}</td><td>${m.r.toFixed(4)}</td>` +
          `<td>${m.ap50.toFixed(4)}</td><td>${m.ap.toFixed(4)}</td></tr>`
        ).join('');
        return `
          <table class="summary-table" style="margin-top:.35rem;margin-bottom:.5rem;">
            <thead><tr><th>Class</th><th>Precision</th><th>Recall</th><th>mAP50</th><th>mAP50-95</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>`;
      };
      let html = '';
      if (hasBbox) html += `<div class="mt-lm-section-title" style="margin-top:.3rem;">Bounding Box</div>${makeTable(bboxData)}`;
      if (hasSeg)  html += `<div class="mt-lm-section-title" style="margin-top:.5rem;">Segmentation Mask</div>${makeTable(segData)}`;
      wrap.innerHTML = html;
    }
  }
}

function _setChartData(chart, labels, seriesArrays) {
  if (!chart) return;
  chart.data.labels = labels;
  seriesArrays.forEach((data, i) => {
    const ds = chart.data.datasets[i];
    if (!ds) return;
    ds.data = data;
    // hide the series entirely if it has no real values (all null) so it
    // doesn't draw a flat zero baseline
    const hasData = data.some(v => v != null);
    ds.hidden = !hasData;
  });
  chart.update('none');
}

async function _downloadModel(fileId, fileName) {
  const token = getToken();
  if (!token) { toast('Not signed in', 'error'); return; }
  toast(`Downloading ${fileName}…`, 'info');
  try {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = fileName; a.click();
    URL.revokeObjectURL(url);
    toast(`Downloaded ${fileName}`, 'success');
  } catch (err) {
    toast(`Download failed: ${err.message}`, 'error');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatSize(bytes) {
  const n = parseInt(bytes || '0', 10);
  if (n === 0) return '—';
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString();
}
