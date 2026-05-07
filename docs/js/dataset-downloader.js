import { getToken } from './auth.js';
import { findRootFolder, listAllFiles, downloadFileContent } from './drive.js';
import { makeSemaphore, toast } from './utils.js';

const FETCH_CONCURRENCY = 8;

let scannedPairs = [];   // [{ videoSlug, imageName, imageId, labelName, labelId, classes[] }]
let classBreakdown = {}; // { className: imageCount }

export function renderDownloader(container) {
  container.innerHTML = `
    <div style="max-width:700px;">
      <p class="section-title">Dataset Overview</p>
      <button class="btn btn-primary" id="dl-scan-btn">Scan Drive</button>

      <div id="dl-scan-progress" class="progress-wrap hidden">
        <div class="progress-label">
          <span id="dl-scan-text">Scanning…</span>
          <span id="dl-scan-pct">0%</span>
        </div>
        <div class="progress-bar"><div class="progress-fill" id="dl-scan-fill"></div></div>
      </div>

      <div id="dl-results" class="hidden">
        <div class="stat-row" id="dl-stats"></div>

        <p class="section-title" style="margin-top:1.5rem;">Filter by Class</p>
        <div class="flex-row" style="gap:0.5rem;margin-bottom:0.75rem;">
          <button class="btn btn-ghost btn-sm" id="dl-select-all">Select All</button>
          <button class="btn btn-ghost btn-sm" id="dl-deselect-all">Deselect All</button>
        </div>
        <div id="dl-class-list"></div>

        <div class="flex-row mt-2">
          <button class="btn btn-primary" id="dl-download-btn">Download as ZIP</button>
          <span class="text-dim" id="dl-pair-count" style="font-size:13px;"></span>
        </div>

        <div id="dl-dl-progress" class="progress-wrap hidden">
          <div class="progress-label">
            <span id="dl-dl-text">Preparing…</span>
            <span id="dl-dl-pct">0%</span>
          </div>
          <div class="progress-bar"><div class="progress-fill" id="dl-dl-fill"></div></div>
        </div>
      </div>
    </div>
  `;

  document.getElementById('dl-scan-btn').addEventListener('click', startScan);
}

async function startScan() {
  const token = getToken();
  if (!token) { toast('Not signed in', 'error'); return; }

  const scanBtn = document.getElementById('dl-scan-btn');
  scanBtn.disabled = true;
  document.getElementById('dl-scan-progress').classList.remove('hidden');
  document.getElementById('dl-results').classList.add('hidden');

  try {
    setScanProgress(0, 'Finding PavementDataset folder…');
    const root = await findRootFolder(token);
    if (!root) {
      toast('PavementDataset folder not found in Drive. Upload some data first.', 'info');
      return;
    }

    setScanProgress(0.05, 'Listing video folders…');
    const videoFolders = await listAllFiles(
      token,
      `'${root.id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      'id,name'
    );

    if (videoFolders.length === 0) {
      toast('No video folders found. Upload some data first.', 'info');
      return;
    }

    setScanProgress(0.1, `Found ${videoFolders.length} video folder(s). Listing files…`);

    const folderSem = makeSemaphore(4);
    const allPairs = [];
    let foldersScanned = 0;

    await Promise.all(videoFolders.map(videoFolder =>
      folderSem(async () => {
        const subfolders = await listAllFiles(
          token,
          `'${videoFolder.id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
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
        for (const labelFile of labelFiles) {
          if (!labelFile.name.endsWith('.json')) continue;
          const stem = labelFile.name.replace(/\.json$/, '');
          const imageFile = imageMap.get(stem);
          if (!imageFile) continue;
          allPairs.push({
            videoSlug: videoFolder.name,
            imageName: imageFile.name,
            imageId: imageFile.id,
            labelName: labelFile.name,
            labelId: labelFile.id,
            classes: [],
          });
        }

        foldersScanned++;
        setScanProgress(
          0.1 + (foldersScanned / videoFolders.length) * 0.3,
          `Scanned ${foldersScanned}/${videoFolders.length} folders (${allPairs.length} pairs found)…`
        );
      })
    ));

    if (allPairs.length === 0) {
      toast('No matched image+label pairs found.', 'info');
      return;
    }

    setScanProgress(0.4, `Reading class labels from ${allPairs.length} files…`);

    const fetchSem = makeSemaphore(FETCH_CONCURRENCY);
    let fetched = 0;

    await Promise.all(allPairs.map(pair =>
      fetchSem(async () => {
        try {
          const buf = await downloadFileContent(token, pair.labelId);
          const json = JSON.parse(new TextDecoder().decode(buf));
          if (Array.isArray(json.shapes)) {
            pair.classes = [...new Set(json.shapes.map(s => s.label).filter(Boolean))];
          }
        } catch { /* leave classes empty on parse error */ }
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
        classBreakdown[cls] = (classBreakdown[cls] || 0) + 1;
      }
    }

    setScanProgress(1, 'Scan complete');
    document.getElementById('dl-scan-progress').classList.add('hidden');
    renderResults(videoFolders.length);

  } catch (err) {
    toast(`Scan failed: ${err.message}`, 'error');
  } finally {
    scanBtn.disabled = false;
  }
}

function renderResults(videoCount) {
  document.getElementById('dl-results').classList.remove('hidden');

  document.getElementById('dl-stats').innerHTML = `
    <div class="stat"><div class="stat-label">Labeled Pairs</div><div class="stat-value">${scannedPairs.length}</div></div>
    <div class="stat"><div class="stat-label">Video Folders</div><div class="stat-value">${videoCount}</div></div>
    <div class="stat"><div class="stat-label">Classes</div><div class="stat-value">${Object.keys(classBreakdown).length}</div></div>
  `;

  const sorted = Object.entries(classBreakdown).sort((a, b) => b[1] - a[1]);
  const classList = document.getElementById('dl-class-list');
  classList.innerHTML = sorted.map(([cls, count]) => `
    <label class="class-row">
      <input type="checkbox" class="dl-class-check" value="${cls}" checked />
      <span class="class-name">${cls}</span>
      <span class="class-count text-dim">${count} image${count !== 1 ? 's' : ''}</span>
    </label>
  `).join('');

  document.getElementById('dl-select-all').onclick = () => {
    document.querySelectorAll('.dl-class-check').forEach(cb => { cb.checked = true; });
    updateCount();
  };
  document.getElementById('dl-deselect-all').onclick = () => {
    document.querySelectorAll('.dl-class-check').forEach(cb => { cb.checked = false; });
    updateCount();
  };
  classList.addEventListener('change', updateCount);
  updateCount();

  document.getElementById('dl-download-btn').addEventListener('click', startDownload);
}

function getSelectedPairs() {
  const selected = new Set([...document.querySelectorAll('.dl-class-check:checked')].map(cb => cb.value));
  if (selected.size === 0) return [];
  return scannedPairs.filter(p => p.classes.some(cls => selected.has(cls)));
}

function updateCount() {
  const n = getSelectedPairs().length;
  document.getElementById('dl-pair-count').textContent = `${n} image${n !== 1 ? 's' : ''} selected`;
}

async function startDownload() {
  const token = getToken();
  if (!token) { toast('Not signed in', 'error'); return; }

  const selected = getSelectedPairs();
  if (selected.length === 0) { toast('No classes selected', 'error'); return; }

  if (!window.JSZip) { toast('ZIP library not loaded — try refreshing the page', 'error'); return; }

  const downloadBtn = document.getElementById('dl-download-btn');
  const progWrap    = document.getElementById('dl-dl-progress');
  downloadBtn.disabled = true;
  progWrap.classList.remove('hidden');

  try {
    const zip     = new window.JSZip();
    const imgDir  = zip.folder('images');
    const lblDir  = zip.folder('labels');

    const total = selected.length * 2;
    let done = 0;
    const setDlProg = () => {
      const pct = Math.round((done / total) * 100);
      document.getElementById('dl-dl-fill').style.width = `${pct}%`;
      document.getElementById('dl-dl-pct').textContent  = `${pct}%`;
      document.getElementById('dl-dl-text').textContent = `Downloading… ${done}/${total} files`;
    };

    const sem = makeSemaphore(4);
    await Promise.all(selected.flatMap(pair => [
      sem(async () => {
        const buf = await downloadFileContent(token, pair.imageId);
        imgDir.file(pair.imageName, buf);
        done++; setDlProg();
      }),
      sem(async () => {
        const buf = await downloadFileContent(token, pair.labelId);
        lblDir.file(pair.labelName, buf);
        done++; setDlProg();
      }),
    ]));

    document.getElementById('dl-dl-text').textContent = 'Generating ZIP…';
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pavement_dataset_${new Date().toISOString().slice(0, 10)}.zip`;
    a.click();
    URL.revokeObjectURL(url);

    toast(`Downloaded ${selected.length} image+label pairs`, 'success');
  } catch (err) {
    toast(`Download failed: ${err.message}`, 'error');
  } finally {
    downloadBtn.disabled = false;
    progWrap.classList.add('hidden');
  }
}

function setScanProgress(fraction, text) {
  const fill = document.getElementById('dl-scan-fill');
  if (!fill) return;
  fill.style.width = `${Math.round(fraction * 100)}%`;
  document.getElementById('dl-scan-pct').textContent  = `${Math.round(fraction * 100)}%`;
  document.getElementById('dl-scan-text').textContent = text;
}
