import { getToken } from './auth.js';
import {
  listAllFiles, downloadFileContent,
  uploadFile, findOrCreateFolder, copyFileToDrive,
} from './drive.js';
import { makeSemaphore, toast } from './utils.js';
import { getDatasetRawDataFolder } from './dataset-manager.js';
import { getCurrentDatasetFolderId } from './dataset-manager.js';

const FETCH_CONCURRENCY = 8;

// ── Module state ──────────────────────────────────────────────────────────────

// Create-split mode state
let scannedPairs          = [];  // [{ videoSlug, imageName, imageId, labelName, labelId, classes[], annotationCounts{}, imageWidth, imageHeight }]
let classBreakdown        = {};  // { className: { images, annotations } }
let excludeInvalid        = false;
let currentSplit          = null; // { train, val, test } — arrays of pair objects
let cachedReviewDecisions = {};   // loaded from review_decisions.json at scan time

// Download-split mode state
let dlScanData = null; // { folderName, folderId, splits: { train, val, test }, classNames, format }

// Shared Chart.js instance
let splitChart = null;

// ── Entry point ───────────────────────────────────────────────────────────────

export function renderDownloader(container) {
  container.innerHTML = `
    <div style="max-width:780px;">
      <p class="section-title">Dataset Manager</p>

      <div class="mode-selector">
        <button class="mode-btn active" id="dm-mode-create">Create Split Dataset</button>
        <button class="mode-btn" id="dm-mode-download">Download Split Dataset</button>
      </div>

      <!-- ── Panel A: Create Split ── -->
      <div id="dm-panel-create">
        <div class="mode-card">
          <p class="section-title" style="margin-bottom:0.6rem;">Active Dataset</p>
          <button class="btn btn-primary btn-sm" id="dm-scan-btn">Scan Dataset</button>

          <div id="dm-scan-progress" class="progress-wrap hidden">
            <div class="progress-label">
              <span id="dm-scan-text">Scanning…</span>
              <span id="dm-scan-pct">0%</span>
            </div>
            <div class="progress-bar"><div class="progress-fill" id="dm-scan-fill"></div></div>
          </div>
        </div>

        <div id="dm-create-results" class="hidden">
          <div class="mode-card">
            <p class="section-title" style="margin-bottom:0.6rem;">Dataset Overview</p>
            <div class="stat-row" id="dm-stats"></div>

            <p class="section-title" style="margin-top:1.25rem;margin-bottom:0.5rem;">Filter by Class</p>
            <div class="flex-row" style="gap:0.5rem;margin-bottom:0.5rem;">
              <button class="btn btn-ghost btn-sm" id="dm-select-all">Select All</button>
              <button class="btn btn-ghost btn-sm" id="dm-deselect-all">Deselect All</button>
            </div>
            <label class="dl-toggle-row" style="margin-bottom:0.75rem;">
              <input type="checkbox" id="dm-exclude-invalid" />
              <span>Exclude annotations marked invalid in Review</span>
              <span class="text-dim" id="dm-excluded-count" style="font-size:12px;"></span>
            </label>
            <div id="dm-class-list"></div>
          </div>

          <div class="mode-card">
            <p class="section-title" style="margin-bottom:0.75rem;">Split Configuration</p>

            <div class="folder-input-row" style="margin-bottom:0.75rem;">
              <label for="dm-output-subfolder" style="white-space:nowrap;">Split name:</label>
              <input type="text" id="dm-output-subfolder" placeholder="e.g. split_v1" />
            </div>
            <p class="text-dim" style="font-size:12px;margin-bottom:0.75rem;">
              Saved to <strong style="color:var(--text);">split datasets/</strong> inside the active dataset folder.
            </p>

            <div class="split-inputs" style="margin-bottom:0.5rem;">
              <label>Train <input type="number" id="dm-train-pct" value="70" min="1" max="98" /> %</label>
              <label>Val <input type="number" id="dm-val-pct" value="15" min="1" max="98" /> %</label>
              <label>Test <input type="number" id="dm-test-pct" value="15" min="1" max="98" readonly style="background:var(--bg);border-color:var(--border);color:var(--text-dim);" /> %</label>
            </div>
            <div id="dm-split-warning" class="split-warning hidden">Percentages must sum to 100</div>

            <label class="dl-toggle-row" style="margin-bottom:0.5rem;margin-top:0.5rem;">
              <input type="checkbox" id="dm-yolo-check" />
              <span>Convert labels to YOLO format</span>
            </label>
            <div id="dm-yolo-opts" class="hidden" style="margin-left:1.5rem;margin-bottom:0.75rem;">
              <div class="yolo-task-row">
                Task type:
                <select id="dm-yolo-task">
                  <option value="segment">Segmentation (polygons)</option>
                  <option value="detect">Detection (bounding boxes)</option>
                </select>
              </div>
            </div>

            <div class="flex-row" style="gap:0.75rem;margin-bottom:0.75rem;">
              <button class="btn btn-ghost" id="dm-preview-btn">Preview Distribution</button>
              <span class="text-dim" id="dm-pair-count" style="font-size:13px;"></span>
            </div>

            <div id="dm-chart-section" class="hidden">
              <div class="chart-container">
                <canvas id="dm-split-chart"></canvas>
              </div>
              <div class="split-summary" id="dm-split-summary"></div>
            </div>

            <div class="flex-row mt-2" style="gap:0.75rem;align-items:center;">
              <button class="btn btn-primary" id="dm-upload-btn">Upload to Drive</button>
            </div>

            <div id="dm-upload-progress" class="progress-wrap hidden">
              <div class="progress-label">
                <span id="dm-upload-text">Uploading…</span>
                <span id="dm-upload-pct">0%</span>
              </div>
              <div class="progress-bar"><div class="progress-fill" id="dm-upload-fill"></div></div>
            </div>
          </div>
        </div>
      </div>

      <!-- ── Panel B: Download Split ── -->
      <div id="dm-panel-download" class="hidden">
        <div class="mode-card">
          <p class="section-title" style="margin-bottom:0.6rem;">Split Dataset (Google Drive)</p>
          <div class="folder-input-row">
            <label for="dm-dl-folder">Split:</label>
            <select id="dm-dl-folder"
              style="flex:1;padding:0.4rem 0.6rem;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-family:var(--font);font-size:13px;">
              <option value="">— select a split —</option>
            </select>
            <button class="btn btn-ghost btn-sm" id="dm-dl-refresh-btn" title="Reload">↻</button>
            <button class="btn btn-primary btn-sm" id="dm-dl-scan-btn">Scan</button>
          </div>

          <div id="dm-dl-progress" class="progress-wrap hidden">
            <div class="progress-label">
              <span id="dm-dl-scan-text">Scanning…</span>
              <span id="dm-dl-scan-pct">0%</span>
            </div>
            <div class="progress-bar"><div class="progress-fill" id="dm-dl-scan-fill"></div></div>
          </div>
        </div>

        <div id="dm-dl-results" class="hidden">
          <div class="mode-card">
            <p class="section-title" style="margin-bottom:0.6rem;">Dataset Statistics</p>
            <div class="stat-row" id="dm-dl-stats"></div>
            <div class="chart-container" style="margin-top:1rem;">
              <canvas id="dm-dl-chart"></canvas>
            </div>
            <div class="split-summary" id="dm-dl-summary"></div>
          </div>
          <div class="mode-card">
            <div class="flex-row" style="gap:0.75rem;align-items:center;">
              <button class="btn btn-primary" id="dm-zip-btn">Download as ZIP</button>
            </div>
            <div id="dm-zip-progress" class="progress-wrap hidden">
              <div class="progress-label">
                <span id="dm-zip-text">Preparing…</span>
                <span id="dm-zip-pct">0%</span>
              </div>
              <div class="progress-bar"><div class="progress-fill" id="dm-zip-fill"></div></div>
            </div>
          </div>
        </div>
      </div>

    </div>
  `;

  // Mode toggle
  document.getElementById('dm-mode-create').addEventListener('click', () => switchMode('create'));
  document.getElementById('dm-mode-download').addEventListener('click', () => switchMode('download'));

  // Create-split wiring
  document.getElementById('dm-scan-btn').addEventListener('click', startCreateScan);
  document.getElementById('dm-train-pct').addEventListener('input', onSplitPctChange);
  document.getElementById('dm-val-pct').addEventListener('input', onSplitPctChange);
  document.getElementById('dm-yolo-check').addEventListener('change', (e) => {
    document.getElementById('dm-yolo-opts').classList.toggle('hidden', !e.target.checked);
  });
  document.getElementById('dm-preview-btn').addEventListener('click', runPreview);
  document.getElementById('dm-upload-btn').addEventListener('click', startUploadSplit);

  // Download-split wiring
  document.getElementById('dm-dl-scan-btn').addEventListener('click', startDownloadScan);
  document.getElementById('dm-dl-refresh-btn').addEventListener('click', loadSplitFolders);
  document.getElementById('dm-zip-btn').addEventListener('click', startDownloadZip);
}

// ── Mode switching ─────────────────────────────────────────────────────────────

function switchMode(mode) {
  const isCreate = mode === 'create';
  document.getElementById('dm-mode-create').classList.toggle('active', isCreate);
  document.getElementById('dm-mode-download').classList.toggle('active', !isCreate);
  document.getElementById('dm-panel-create').classList.toggle('hidden', !isCreate);
  document.getElementById('dm-panel-download').classList.toggle('hidden', isCreate);
  if (!isCreate) loadSplitFolders();
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

function getReviewDecisions() {
  return cachedReviewDecisions;
}

function getSelectedPairs() {
  const selected = new Set([...document.querySelectorAll('.dm-class-check:checked')].map(cb => cb.value));
  if (selected.size === 0) return [];
  let pairs = scannedPairs.filter(p => p.classes.some(cls => selected.has(cls)));
  if (excludeInvalid) {
    const decisions = getReviewDecisions();
    pairs = pairs.filter(p => decisions[`${p.videoSlug}/${p.labelName}`]?.status !== 'invalid');
  }
  return pairs;
}

function setScanProgress(fraction, text) {
  const fill = document.getElementById('dm-scan-fill');
  if (!fill) return;
  fill.style.width = `${Math.round(fraction * 100)}%`;
  document.getElementById('dm-scan-pct').textContent  = `${Math.round(fraction * 100)}%`;
  document.getElementById('dm-scan-text').textContent = text;
}

function setDlScanProgress(fraction, text) {
  const fill = document.getElementById('dm-dl-scan-fill');
  if (!fill) return;
  fill.style.width = `${Math.round(fraction * 100)}%`;
  document.getElementById('dm-dl-scan-pct').textContent  = `${Math.round(fraction * 100)}%`;
  document.getElementById('dm-dl-scan-text').textContent = text;
}

function getSplitPcts() {
  const train = parseInt(document.getElementById('dm-train-pct')?.value ?? 70, 10);
  const val   = parseInt(document.getElementById('dm-val-pct')?.value ?? 15, 10);
  const test  = 100 - train - val;
  return { train, val, test };
}

function onSplitPctChange() {
  const { train, val, test } = getSplitPcts();
  const testEl = document.getElementById('dm-test-pct');
  if (testEl) testEl.value = test;
  const warn = document.getElementById('dm-split-warning');
  if (warn) warn.classList.toggle('hidden', test >= 1 && train + val + test === 100);
  // Invalidate cached split
  currentSplit = null;
  document.getElementById('dm-chart-section')?.classList.add('hidden');
}

function orderedClasses() {
  return Object.entries(classBreakdown)
    .sort((a, b) => b[1].annotations - a[1].annotations)
    .map(([cls]) => cls);
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// ── Stratified split ───────────────────────────────────────────────────────────

function stratifiedSplit(pairs, trainPct, valPct) {
  const trainR = trainPct / 100;
  const valR   = valPct / 100;

  const classToIndices = {};
  const unannotatedIdx = [];

  for (let i = 0; i < pairs.length; i++) {
    const uniqueClasses = [...new Set(pairs[i].classes)];
    if (uniqueClasses.length === 0) {
      unannotatedIdx.push(i);
    } else {
      for (const cls of uniqueClasses) {
        if (!classToIndices[cls]) classToIndices[cls] = [];
        classToIndices[cls].push(i);
      }
    }
  }

  // Sort classes ascending by count so rarest are distributed first
  const sortedClasses = Object.keys(classToIndices).sort(
    (a, b) => classToIndices[a].length - classToIndices[b].length
  );

  const assigned = new Set();
  const train = [], val = [], test = [];

  for (const cls of sortedClasses) {
    const unassigned = classToIndices[cls].filter(i => !assigned.has(i));
    shuffleArray(unassigned);
    const n      = unassigned.length;
    const nTrain = Math.round(n * trainR);
    const nVal   = Math.round(n * valR);
    for (let i = 0; i < n; i++) {
      assigned.add(unassigned[i]);
      if (i < nTrain)           train.push(pairs[unassigned[i]]);
      else if (i < nTrain + nVal) val.push(pairs[unassigned[i]]);
      else                      test.push(pairs[unassigned[i]]);
    }
  }

  // Distribute unannotated round-robin
  unannotatedIdx.forEach((idx, i) => {
    if (!assigned.has(idx)) {
      if (i % 3 === 0) train.push(pairs[idx]);
      else if (i % 3 === 1) val.push(pairs[idx]);
      else test.push(pairs[idx]);
    }
  });

  return { train, val, test };
}

// ── Chart rendering ────────────────────────────────────────────────────────────

function renderSplitChart(splitResult, classes, canvasEl, knownCounts) {
  if (splitChart) { splitChart.destroy(); splitChart = null; }
  if (!window.Chart) return;
  // Ensure datalabels plugin is registered (CDN auto-registration is unreliable with Chart.js 4)
  if (window.ChartDataLabels) window.Chart.register(window.ChartDataLabels);

  // Build per-split annotation counts per class
  // knownCounts is optional — used for download-mode where we already have counts
  const countFor = (split, cls) => {
    if (knownCounts) return knownCounts[split]?.[cls] ?? 0;
    return splitResult[split].reduce((s, p) => s + (p.annotationCounts[cls] ?? 0), 0);
  };

  splitChart = new window.Chart(canvasEl, {
    type: 'bar',
    data: {
      labels: classes,
      datasets: [
        {
          label: 'Train',
          data: classes.map(cls => countFor('train', cls)),
          backgroundColor: '#4ec9b0',
        },
        {
          label: 'Val',
          data: classes.map(cls => countFor('val', cls)),
          backgroundColor: '#ce9178',
        },
        {
          label: 'Test',
          data: classes.map(cls => countFor('test', cls)),
          backgroundColor: '#c586c0',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 20 } },
      plugins: {
        legend: { labels: { color: '#d4d4d4', font: { size: 12 } } },
        datalabels: {
          anchor: 'end',
          align: 'end',
          color: '#d4d4d4',
          font: { size: 10, weight: '600' },
          formatter: (value) => value > 0 ? value : '',
        },
      },
      scales: {
        x: {
          ticks: { color: '#d4d4d4' },
          grid: { color: '#3f3f46' },
        },
        y: {
          ticks: { color: '#d4d4d4' },
          grid: { color: '#3f3f46' },
          title: { display: true, text: 'Annotations', color: '#888' },
        },
      },
    },
  });
}

// ── YOLO conversion helpers ────────────────────────────────────────────────────

async function getImageDimensions(arrayBuffer) {
  const blob = new Blob([arrayBuffer]);
  const bmp  = await createImageBitmap(blob);
  const dims = { width: bmp.width, height: bmp.height };
  bmp.close();
  return dims;
}

function buildDatasetYaml(classNames) {
  const names = classNames.map(n => `  - ${n}`).join('\n');
  return `# YOLO Dataset — exported from Pavement Dataset Tool\npath: .\ntrain: images/train\nval: images/val\ntest: images/test\nnc: ${classNames.length}\nnames:\n${names}\n`;
}

function jsonToYoloTxt(shapes, imgWidth, imgHeight, classIds, taskType) {
  const lines = [];
  for (const shape of shapes) {
    const classId = classIds[shape.label];
    if (classId === undefined) continue;
    const pts = shape.points ?? [];
    if (pts.length === 0) continue;

    if (taskType === 'segment') {
      let polyPts = [];
      if (shape.shape_type === 'polygon') {
        polyPts = pts;
      } else if (shape.shape_type === 'rectangle') {
        // pts = [[x1,y1],[x2,y2]] → 4-corner polygon
        const [[x1, y1], [x2, y2]] = pts;
        polyPts = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
      } else if (shape.shape_type === 'circle') {
        // pts = [[cx,cy],[rx,ry]] — approximate as 16-point polygon
        const [cx, cy] = pts[0];
        const r = Math.hypot(pts[1][0] - cx, pts[1][1] - cy);
        polyPts = Array.from({ length: 16 }, (_, i) => {
          const a = (i / 16) * 2 * Math.PI;
          return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
        });
      } else {
        continue; // line / point not supported in segment mode
      }
      const coords = polyPts.map(([x, y]) => `${(x / imgWidth).toFixed(6)} ${(y / imgHeight).toFixed(6)}`).join(' ');
      lines.push(`${classId} ${coords}`);
    } else {
      // detect — bounding box from all points
      let minX, minY, maxX, maxY;
      if (shape.shape_type === 'circle') {
        const [cx, cy] = pts[0];
        const r = Math.hypot(pts[1][0] - cx, pts[1][1] - cy);
        [minX, minY, maxX, maxY] = [cx - r, cy - r, cx + r, cy + r];
      } else {
        const xs = pts.map(p => p[0]);
        const ys = pts.map(p => p[1]);
        [minX, maxX] = [Math.min(...xs), Math.max(...xs)];
        [minY, maxY] = [Math.min(...ys), Math.max(...ys)];
      }
      const cx = ((minX + maxX) / 2 / imgWidth).toFixed(6);
      const cy = ((minY + maxY) / 2 / imgHeight).toFixed(6);
      const w  = ((maxX - minX) / imgWidth).toFixed(6);
      const h  = ((maxY - minY) / imgHeight).toFixed(6);
      lines.push(`${classId} ${cx} ${cy} ${w} ${h}`);
    }
  }
  return lines.join('\n');
}

// ── Mode 1: Create Split ───────────────────────────────────────────────────────

async function startCreateScan() {
  const token = getToken();
  if (!token) { toast('Not signed in', 'error'); return; }

  const datasetFolderId = getCurrentDatasetFolderId();
  if (!datasetFolderId) { toast('No dataset open', 'error'); return; }

  const scanBtn = document.getElementById('dm-scan-btn');
  scanBtn.disabled = true;
  document.getElementById('dm-scan-progress').classList.remove('hidden');
  document.getElementById('dm-create-results').classList.add('hidden');

  scannedPairs          = [];
  classBreakdown        = {};
  currentSplit          = null;
  cachedReviewDecisions = {};

  try {
    setScanProgress(0, 'Finding raw data folder…');

    const rawDataFolder = await getDatasetRawDataFolder(token);
    if (!rawDataFolder) { toast('No dataset open', 'error'); return; }
    const root = rawDataFolder;

    setScanProgress(0, 'Loading review decisions…');
    try {
      const rdFiles = await listAllFiles(
        token,
        `name='review_decisions.json' and '${root.id}' in parents and trashed=false`,
        'id'
      );
      let raw = null;
      if (rdFiles.length > 0) {
        const buf = await downloadFileContent(token, rdFiles[0].id);
        raw = JSON.parse(new TextDecoder().decode(buf));
      } else {
        try {
          const saved = localStorage.getItem('pavement_review_decisions');
          if (saved) raw = JSON.parse(saved);
        } catch { /* ignore */ }
      }
      if (raw && typeof raw === 'object') {
        // Normalise to path-keyed format (videoSlug/labelName) regardless of source
        const keys = Object.keys(raw);
        const isOldFormat = keys.length > 0 && keys.every(k => !k.includes('/'));
        if (isOldFormat) {
          for (const dec of Object.values(raw)) {
            if (dec.videoSlug && dec.labelName) {
              cachedReviewDecisions[`${dec.videoSlug}/${dec.labelName}`] = dec;
            }
          }
        } else {
          cachedReviewDecisions = raw;
        }
      }
    } catch { /* no file — treat all as unreviewed */ }

    setScanProgress(0.05, 'Listing video folders…');
    const videoFolders = await listAllFiles(
      token,
      `'${root.id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      'id,name'
    );

    if (videoFolders.length === 0) {
      toast('No video folders found in raw data. Upload some labeled data first.', 'info');
      return;
    }

    setScanProgress(0.1, `Found ${videoFolders.length} video folder(s). Listing files…`);

    const folderSem = makeSemaphore(4);
    const allPairs  = [];
    let foldersScanned = 0;

    await Promise.all(videoFolders.map(vf =>
      folderSem(async () => {
        const subfolders = await listAllFiles(
          token,
          `'${vf.id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
          'id,name'
        );
        const framesFolder = subfolders.find(f => f.name === 'frames');
        const labelsFolder = subfolders.find(f => f.name === 'labels');
        if (!framesFolder || !labelsFolder) { foldersScanned++; return; }

        const [imageFiles, labelFiles] = await Promise.all([
          listAllFiles(token, `'${framesFolder.id}' in parents and trashed=false`, 'id,name'),
          listAllFiles(token, `'${labelsFolder.id}' in parents and trashed=false`, 'id,name'),
        ]);

        const imageMap = new Map(imageFiles.map(f => [f.name.replace(/\.[^.]+$/, ''), f]));
        for (const lf of labelFiles) {
          if (!lf.name.endsWith('.json')) continue;
          const stem = lf.name.replace(/\.json$/, '');
          const img  = imageMap.get(stem);
          if (!img) continue;
          allPairs.push({
            videoSlug: vf.name,
            imageName: img.name,
            imageId:   img.id,
            labelName: lf.name,
            labelId:   lf.id,
            classes:   [],
            annotationCounts: {},
            imageWidth:  null,
            imageHeight: null,
          });
        }

        foldersScanned++;
        setScanProgress(
          0.1 + (foldersScanned / videoFolders.length) * 0.3,
          `Scanned ${foldersScanned}/${videoFolders.length} folders (${allPairs.length} pairs)…`
        );
      })
    ));

    if (allPairs.length === 0) {
      toast('No matched image+label pairs found in source folder.', 'info');
      return;
    }

    setScanProgress(0.4, `Reading class labels from ${allPairs.length} files…`);
    const fetchSem = makeSemaphore(FETCH_CONCURRENCY);
    let fetched = 0;

    await Promise.all(allPairs.map(pair =>
      fetchSem(async () => {
        try {
          const buf  = await downloadFileContent(token, pair.labelId);
          const json = JSON.parse(new TextDecoder().decode(buf));
          if (Array.isArray(json.shapes)) {
            const labels = json.shapes.map(s => s.label).filter(Boolean);
            pair.classes = [...new Set(labels)];
            for (const lbl of labels) {
              pair.annotationCounts[lbl] = (pair.annotationCounts[lbl] || 0) + 1;
            }
          }
          pair.imageWidth  = json.imageWidth  ?? null;
          pair.imageHeight = json.imageHeight ?? null;
        } catch { /* leave classes empty */ }
        fetched++;
        setScanProgress(
          0.4 + (fetched / allPairs.length) * 0.6,
          `Reading labels… ${fetched}/${allPairs.length}`
        );
      })
    ));

    scannedPairs = allPairs;
    classBreakdown = {};
    for (const pair of scannedPairs) {
      for (const cls of pair.classes) {
        if (!classBreakdown[cls]) classBreakdown[cls] = { images: 0, annotations: 0 };
        classBreakdown[cls].images++;
        classBreakdown[cls].annotations += pair.annotationCounts[cls] || 0;
      }
    }

    setScanProgress(1, 'Scan complete');
    document.getElementById('dm-scan-progress').classList.add('hidden');
    renderCreateResults(videoFolders.length);

  } catch (err) {
    toast(`Scan failed: ${err.message}`, 'error');
    console.error(err);
  } finally {
    scanBtn.disabled = false;
  }
}

function renderCreateResults(videoCount) {
  document.getElementById('dm-create-results').classList.remove('hidden');

  const totalAnnotations = Object.values(classBreakdown).reduce((s, v) => s + v.annotations, 0);
  document.getElementById('dm-stats').innerHTML = `
    <div class="stat"><div class="stat-label">Labeled Pairs</div><div class="stat-value" id="dm-labeled-pairs-count">${scannedPairs.length}</div></div>
    <div class="stat"><div class="stat-label">Annotations</div><div class="stat-value">${totalAnnotations}</div></div>
    <div class="stat"><div class="stat-label">Video Folders</div><div class="stat-value">${videoCount}</div></div>
    <div class="stat"><div class="stat-label">Classes</div><div class="stat-value">${Object.keys(classBreakdown).length}</div></div>
  `;

  const sorted    = Object.entries(classBreakdown).sort((a, b) => b[1].annotations - a[1].annotations);
  const classList = document.getElementById('dm-class-list');
  classList.innerHTML = sorted.map(([cls, { images, annotations }]) => `
    <label class="class-row">
      <input type="checkbox" class="dm-class-check" value="${cls}" checked />
      <span class="class-name">${cls}</span>
      <span class="class-count text-dim">${images} image${images === 1 ? '' : 's'} &middot; ${annotations} annotation${annotations === 1 ? '' : 's'}</span>
    </label>
  `).join('');

  document.getElementById('dm-select-all').onclick = () => {
    document.querySelectorAll('.dm-class-check').forEach(cb => { cb.checked = true; });
    onClassFilterChange();
  };
  document.getElementById('dm-deselect-all').onclick = () => {
    document.querySelectorAll('.dm-class-check').forEach(cb => { cb.checked = false; });
    onClassFilterChange();
  };
  classList.addEventListener('change', onClassFilterChange);

  document.getElementById('dm-exclude-invalid').checked = excludeInvalid;
  document.getElementById('dm-exclude-invalid').onchange = (e) => {
    excludeInvalid = e.target.checked;
    if (excludeInvalid) {
      const decisions = getReviewDecisions();
      const validClasses = new Set();
      for (const pair of scannedPairs) {
        if (decisions[`${pair.videoSlug}/${pair.labelName}`]?.status === 'invalid') continue;
        for (const cls of pair.classes) validClasses.add(cls);
      }
      document.querySelectorAll('.dm-class-check').forEach(cb => {
        if (!validClasses.has(cb.value)) cb.checked = false;
      });
    }
    onClassFilterChange();
  };

  updatePairCount();
}

function onClassFilterChange() {
  updatePairCount();
  currentSplit = null;
  // If chart was already shown, refresh it
  if (!document.getElementById('dm-chart-section').classList.contains('hidden')) {
    runPreview();
  }
}

function updatePairCount() {
  const active = getSelectedPairs();
  const n = active.length;
  document.getElementById('dm-pair-count').textContent = `${n} image${n !== 1 ? 's' : ''} selected`;
  const pairsStatEl = document.getElementById('dm-labeled-pairs-count');
  if (pairsStatEl) pairsStatEl.textContent = n;

  const excludedEl = document.getElementById('dm-excluded-count');
  if (excludedEl && excludeInvalid) {
    const selected  = new Set([...document.querySelectorAll('.dm-class-check:checked')].map(cb => cb.value));
    const decisions = getReviewDecisions();
    const excluded  = scannedPairs.filter(p =>
      p.classes.some(cls => selected.has(cls)) && decisions[`${p.videoSlug}/${p.labelName}`]?.status === 'invalid'
    ).length;
    excludedEl.textContent = excluded > 0 ? `(${excluded} excluded)` : '';
  } else if (excludedEl) {
    excludedEl.textContent = '';
  }
}

function runPreview() {
  const { train: trainPct, val: valPct, test: testPct } = getSplitPcts();
  if (trainPct + valPct + testPct !== 100 || testPct < 1) {
    toast('Split percentages must sum to 100 with at least 1% for each', 'error');
    return;
  }
  const active = getSelectedPairs();
  if (active.length === 0) { toast('No images selected', 'error'); return; }

  currentSplit = stratifiedSplit(active, trainPct, valPct);

  const classes = orderedClasses();
  const canvas  = document.getElementById('dm-split-chart');
  renderSplitChart(currentSplit, classes, canvas);

  document.getElementById('dm-chart-section').classList.remove('hidden');
  document.getElementById('dm-split-summary').innerHTML =
    `<span>Train: <strong>${currentSplit.train.length}</strong> images</span>` +
    `<span>Val: <strong>${currentSplit.val.length}</strong> images</span>` +
    `<span>Test: <strong>${currentSplit.test.length}</strong> images</span>`;
}


async function startUploadSplit() {
  const token = getToken();
  if (!token) { toast('Not signed in', 'error'); return; }

  const datasetFolderId = getCurrentDatasetFolderId();
  if (!datasetFolderId) { toast('No dataset open', 'error'); return; }

  const outputName = document.getElementById('dm-output-subfolder').value.trim();
  if (!outputName) { toast('Enter a split name', 'error'); return; }

  const { train: trainPct, val: valPct, test: testPct } = getSplitPcts();
  if (trainPct + valPct + testPct !== 100 || testPct < 1) {
    toast('Split percentages must sum to 100', 'error');
    return;
  }

  if (!currentSplit) {
    // Run split if not yet previewed
    const active = getSelectedPairs();
    if (active.length === 0) { toast('No images selected', 'error'); return; }
    currentSplit = stratifiedSplit(active, trainPct, valPct);
  }

  const yoloMode   = document.getElementById('dm-yolo-check').checked;
  const taskType   = document.getElementById('dm-yolo-task').value;
  const checkedSet = new Set([...document.querySelectorAll('.dm-class-check:checked')].map(cb => cb.value));
  // Only include checked classes that actually appear in the valid exported pairs.
  // Deriving from currentSplit (not classBreakdown) ensures classes with all-invalid
  // pairs are excluded from the YAML and label conversion even if their checkbox is on.
  const activeInSplit = new Set(
    Object.values(currentSplit).flat().flatMap(p => p.classes).filter(cls => checkedSet.has(cls))
  );
  const classes  = orderedClasses().filter(cls => activeInSplit.has(cls));
  const classIds = Object.fromEntries(classes.map((c, i) => [c, i]));

  const uploadBtn = document.getElementById('dm-upload-btn');
  const progWrap  = document.getElementById('dm-upload-progress');
  uploadBtn.disabled = true;
  progWrap.classList.remove('hidden');

  const totalPairs = currentSplit.train.length + currentSplit.val.length + currentSplit.test.length;
  let done = 0;
  const setUploadProg = () => {
    const pct = Math.round((done / (totalPairs * 2)) * 100);
    document.getElementById('dm-upload-fill').style.width = `${pct}%`;
    document.getElementById('dm-upload-pct').textContent  = `${pct}%`;
    document.getElementById('dm-upload-text').textContent = `Uploading… ${done}/${totalPairs * 2} files`;
  };

  try {
    toast('Setting up output folders in Drive…', 'info');

    // Place the split inside the "split datasets" folder of the active dataset
    const splitsParent = await findOrCreateFolder(token, 'split datasets', datasetFolderId);
    const outFolder    = await findOrCreateFolder(token, outputName, splitsParent.id);

    // Create images and labels with train/val/test subfolders
    const [imagesFolder, labelsFolder] = await Promise.all([
      findOrCreateFolder(token, 'images', outFolder.id),
      findOrCreateFolder(token, 'labels', outFolder.id),
    ]);
    const splitNames = ['train', 'val', 'test'];
    const [imgSubfolders, lblSubfolders] = await Promise.all([
      Promise.all(splitNames.map(s => findOrCreateFolder(token, s, imagesFolder.id))),
      Promise.all(splitNames.map(s => findOrCreateFolder(token, s, labelsFolder.id))),
    ]);
    const imgFolderIds = Object.fromEntries(splitNames.map((s, i) => [s, imgSubfolders[i].id]));
    const lblFolderIds = Object.fromEntries(splitNames.map((s, i) => [s, lblSubfolders[i].id]));

    // Process each split
    const sem = makeSemaphore(4);
    const allTasks = [];

    for (const [splitName, pairs] of Object.entries(currentSplit)) {
      const imgFid = imgFolderIds[splitName];
      const lblFid = lblFolderIds[splitName];

      for (const pair of pairs) {
        allTasks.push(sem(async () => {
          // Upload/copy image
          await copyFileToDrive(token, pair.imageId, pair.imageName, imgFid);
          done++; setUploadProg();

          // Upload label
          const selectedSet = new Set(Object.keys(classIds));
          const allSelected = selectedSet.size === checkedSet.size && checkedSet.size === orderedClasses().length;
          if (yoloMode) {
            // Download label JSON → convert → upload .txt
            // classIds only contains selected classes so jsonToYoloTxt already filters
            const buf  = await downloadFileContent(token, pair.labelId);
            const json = JSON.parse(new TextDecoder().decode(buf));
            let w = pair.imageWidth, h = pair.imageHeight;
            if (!w || !h) {
              const imgBuf = await downloadFileContent(token, pair.imageId);
              ({ width: w, height: h } = await getImageDimensions(imgBuf));
            }
            const txtContent = jsonToYoloTxt(json.shapes ?? [], w, h, classIds, taskType);
            const stem = pair.labelName.replace(/\.json$/, '');
            const blob = new Blob([txtContent], { type: 'text/plain' });
            await uploadFile(token, lblFid, `${stem}.txt`, 'text/plain', blob);
          } else if (allSelected) {
            // All classes selected — safe to copy the original file unchanged
            await copyFileToDrive(token, pair.labelId, pair.labelName, lblFid);
          } else {
            // Subset selected — download JSON, strip unselected shapes, upload filtered copy
            const buf  = await downloadFileContent(token, pair.labelId);
            const json = JSON.parse(new TextDecoder().decode(buf));
            const filtered = { ...json, shapes: (json.shapes ?? []).filter(s => selectedSet.has(s.label)) };
            const blob = new Blob([JSON.stringify(filtered)], { type: 'application/json' });
            await uploadFile(token, lblFid, pair.labelName, 'application/json', blob);
          }
          done++; setUploadProg();
        }));
      }
    }

    await Promise.all(allTasks);

    // Upload dataset.yaml if YOLO
    if (yoloMode) {
      const yamlContent = buildDatasetYaml(classes);
      const yamlBlob = new Blob([yamlContent], { type: 'text/plain' });
      await uploadFile(token, outFolder.id, 'dataset.yaml', 'text/plain', yamlBlob);
    }

    document.getElementById('dm-upload-text').textContent = 'Upload complete!';
    toast(`Split dataset uploaded to Drive folder "${outputName}"`, 'success');

  } catch (err) {
    toast(`Upload failed: ${err.message}`, 'error');
    console.error(err);
  } finally {
    uploadBtn.disabled = false;
    progWrap.classList.add('hidden');
  }
}

// ── Mode 2: Download Split ─────────────────────────────────────────────────────

async function loadSplitFolders() {
  const select = document.getElementById('dm-dl-folder');
  if (!select) return;
  select.innerHTML = '<option value="">— loading… —</option>';
  const token = getToken();
  if (!token) { select.innerHTML = '<option value="">— sign in first —</option>'; return; }
  const datasetFolderId = getCurrentDatasetFolderId();
  if (!datasetFolderId) { select.innerHTML = '<option value="">— open a dataset first —</option>'; return; }
  try {
    const splitDirs = await listAllFiles(
      token,
      `'${datasetFolderId}' in parents and name='split datasets' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      'id,name'
    );
    if (splitDirs.length === 0) {
      select.innerHTML = '<option value="">— no splits found —</option>';
      return;
    }
    const splits = await listAllFiles(
      token,
      `'${splitDirs[0].id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      'id,name'
    );
    splits.sort((a, b) => a.name.localeCompare(b.name));
    if (splits.length === 0) {
      select.innerHTML = '<option value="">— no splits found —</option>';
      return;
    }
    select.innerHTML = '<option value="">— select a split —</option>' +
      splits.map(f => `<option value="${f.id}">${f.name}</option>`).join('');
  } catch {
    select.innerHTML = '<option value="">— could not load splits —</option>';
  }
}

async function startDownloadScan() {
  const token = getToken();
  if (!token) { toast('Not signed in', 'error'); return; }

  const select = document.getElementById('dm-dl-folder');
  const folderId = select.value;
  const folderName = select.options[select.selectedIndex]?.text ?? '';
  if (!folderId) { toast('Select a split dataset', 'error'); return; }

  const scanBtn = document.getElementById('dm-dl-scan-btn');
  scanBtn.disabled = true;
  document.getElementById('dm-dl-progress').classList.remove('hidden');
  document.getElementById('dm-dl-results').classList.add('hidden');
  dlScanData = null;

  try {
    // Folder ID comes directly from the dropdown — no Drive lookup needed
    const rootFolder = { id: folderId, name: folderName };

    setDlScanProgress(0.1, 'Reading folder structure…');

    // Find images/ and labels/ subfolders
    const subfolders = await listAllFiles(
      token,
      `'${rootFolder.id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      'id,name'
    );
    const imagesFolder = subfolders.find(f => f.name === 'images');
    const labelsFolder = subfolders.find(f => f.name === 'labels');
    if (!imagesFolder || !labelsFolder) {
      toast('This folder does not have the expected images/ and labels/ structure.', 'error');
      return;
    }

    // Find train/val/test subfolders inside images/ and labels/
    const [imgSubs, lblSubs] = await Promise.all([
      listAllFiles(token, `'${imagesFolder.id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`, 'id,name'),
      listAllFiles(token, `'${labelsFolder.id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`, 'id,name'),
    ]);

    const splitNames = ['train', 'val', 'test'];
    const imgFolderMap = Object.fromEntries(imgSubs.filter(f => splitNames.includes(f.name)).map(f => [f.name, f.id]));
    const lblFolderMap = Object.fromEntries(lblSubs.filter(f => splitNames.includes(f.name)).map(f => [f.name, f.id]));

    if (Object.keys(imgFolderMap).length === 0) {
      toast('No train/val/test subfolders found inside images/.', 'error');
      return;
    }

    setDlScanProgress(0.2, 'Listing image files…');

    // List image and label files for all splits
    const splitData = {};
    for (const split of splitNames) {
      const imgFid = imgFolderMap[split];
      const lblFid = lblFolderMap[split];
      splitData[split] = {
        images:      imgFid ? await listAllFiles(token, `'${imgFid}' in parents and trashed=false`, 'id,name') : [],
        labelFiles:  lblFid ? await listAllFiles(token, `'${lblFid}' in parents and trashed=false`, 'id,name') : [],
        imgFolderId: imgFid ?? null,
        lblFolderId: lblFid ?? null,
      };
    }

    // Check for dataset.yaml to determine format + class names
    let classNames = null;
    const topFiles = await listAllFiles(token, `'${rootFolder.id}' in parents and trashed=false and name='dataset.yaml'`, 'id,name');
    if (topFiles.length > 0) {
      try {
        const buf  = await downloadFileContent(token, topFiles[0].id);
        const yaml = new TextDecoder().decode(buf);
        const match = yaml.match(/names:\s*\n((?:\s+-\s+.+\n?)+)/);
        if (match) {
          classNames = match[1].split('\n').map(l => l.replace(/^\s+-\s+/, '').trim()).filter(Boolean);
        }
      } catch { /* ignore */ }
    }

    setDlScanProgress(0.4, 'Reading label statistics…');

    // Detect format from label file extensions
    const allLabelFiles = Object.values(splitData).flatMap(s => s.labelFiles);
    const isYolo = allLabelFiles.some(f => f.name.endsWith('.txt'));
    const isJson = !isYolo && allLabelFiles.some(f => f.name.endsWith('.json'));

    // Download label files to extract class counts
    const fetchSem = makeSemaphore(FETCH_CONCURRENCY);
    let scanned = 0;
    const totalLabels = allLabelFiles.length;
    const splitClassCounts = { train: {}, val: {}, test: {} };

    await Promise.all(
      Object.entries(splitData).flatMap(([split, data]) =>
        data.labelFiles.map(lf =>
          fetchSem(async () => {
            try {
              const buf = await downloadFileContent(token, lf.id);
              if (isYolo) {
                const txt = new TextDecoder().decode(buf);
                for (const line of txt.split('\n')) {
                  const id = parseInt(line.trim().split(' ')[0], 10);
                  if (!isNaN(id)) {
                    const name = classNames?.[id] ?? `class_${id}`;
                    splitClassCounts[split][name] = (splitClassCounts[split][name] ?? 0) + 1;
                  }
                }
              } else if (isJson) {
                const json = JSON.parse(new TextDecoder().decode(buf));
                for (const shape of json.shapes ?? []) {
                  if (shape.label) {
                    splitClassCounts[split][shape.label] = (splitClassCounts[split][shape.label] ?? 0) + 1;
                  }
                }
              }
            } catch { /* skip bad file */ }
            scanned++;
            setDlScanProgress(0.4 + (scanned / totalLabels) * 0.6, `Reading labels… ${scanned}/${totalLabels}`);
          })
        )
      )
    );

    // Collect all class names across all splits
    const allClasses = [...new Set(
      Object.values(splitClassCounts).flatMap(c => Object.keys(c))
    )].sort((a, b) => {
      const totalA = Object.values(splitClassCounts).reduce((s, c) => s + (c[a] ?? 0), 0);
      const totalB = Object.values(splitClassCounts).reduce((s, c) => s + (c[b] ?? 0), 0);
      return totalB - totalA;
    });

    dlScanData = {
      folderName,
      folderId:   rootFolder.id,
      splits:     splitData,
      classNames: allClasses,
      classCounts: splitClassCounts,
      isYolo,
      hasYaml:    topFiles.length > 0,
      yamlFileId: topFiles[0]?.id ?? null,
    };

    setDlScanProgress(1, 'Scan complete');
    document.getElementById('dm-dl-progress').classList.add('hidden');
    renderDownloadResults();

  } catch (err) {
    toast(`Scan failed: ${err.message}`, 'error');
    console.error(err);
  } finally {
    scanBtn.disabled = false;
  }
}

function renderDownloadResults() {
  document.getElementById('dm-dl-results').classList.remove('hidden');

  const { splits, classNames, classCounts } = dlScanData;
  const trainN = splits.train?.images.length ?? 0;
  const valN   = splits.val?.images.length   ?? 0;
  const testN  = splits.test?.images.length  ?? 0;

  document.getElementById('dm-dl-stats').innerHTML = `
    <div class="stat"><div class="stat-label">Train Images</div><div class="stat-value">${trainN}</div></div>
    <div class="stat"><div class="stat-label">Val Images</div><div class="stat-value">${valN}</div></div>
    <div class="stat"><div class="stat-label">Test Images</div><div class="stat-value">${testN}</div></div>
    <div class="stat"><div class="stat-label">Classes</div><div class="stat-value">${classNames.length}</div></div>
  `;

  const canvas = document.getElementById('dm-dl-chart');
  splitChart?.destroy();
  splitChart = null;
  renderSplitChart(null, classNames, canvas, {
    train: classCounts.train,
    val:   classCounts.val,
    test:  classCounts.test,
  });

  document.getElementById('dm-dl-summary').innerHTML =
    `<span>Train: <strong>${trainN}</strong> images</span>` +
    `<span>Val: <strong>${valN}</strong> images</span>` +
    `<span>Test: <strong>${testN}</strong> images</span>` +
    `<span>Total: <strong>${trainN + valN + testN}</strong></span>`;
}

async function startDownloadZip() {
  const token = getToken();
  if (!token) { toast('Not signed in', 'error'); return; }
  if (!dlScanData) { toast('Scan a dataset first', 'error'); return; }
  if (!window.JSZip) { toast('ZIP library not loaded — try refreshing', 'error'); return; }

  const zipBtn   = document.getElementById('dm-zip-btn');
  const progWrap = document.getElementById('dm-zip-progress');
  zipBtn.disabled = true;
  progWrap.classList.remove('hidden');

  const { splits, folderName, hasYaml, yamlFileId } = dlScanData;
  const allFiles = Object.entries(splits).flatMap(([split, data]) => [
    ...data.images.map(f => ({ split, folder: 'images', file: f })),
    ...data.labelFiles.map(f => ({ split, folder: 'labels', file: f })),
  ]);
  const total = allFiles.length + (hasYaml ? 1 : 0);
  let done = 0;

  const setZipProg = () => {
    const pct = Math.round((done / total) * 100);
    document.getElementById('dm-zip-fill').style.width = `${pct}%`;
    document.getElementById('dm-zip-pct').textContent  = `${pct}%`;
    document.getElementById('dm-zip-text').textContent = `Downloading… ${done}/${total} files`;
  };

  try {
    const zip = new window.JSZip();
    const sem = makeSemaphore(4);

    await Promise.all(allFiles.map(({ split, folder, file }) =>
      sem(async () => {
        const buf = await downloadFileContent(token, file.id);
        zip.folder(folder).folder(split).file(file.name, buf);
        done++; setZipProg();
      })
    ));

    if (hasYaml && yamlFileId) {
      const buf = await downloadFileContent(token, yamlFileId);
      zip.file('dataset.yaml', buf);
      done++; setZipProg();
    }

    document.getElementById('dm-zip-text').textContent = 'Generating ZIP…';
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href     = url;
    a.download = `${folderName}_${new Date().toISOString().slice(0, 10)}.zip`;
    a.click();
    URL.revokeObjectURL(url);

    toast(`Downloaded ${folderName} dataset`, 'success');
  } catch (err) {
    toast(`Download failed: ${err.message}`, 'error');
    console.error(err);
  } finally {
    zipBtn.disabled = false;
    progWrap.classList.add('hidden');
  }
}
