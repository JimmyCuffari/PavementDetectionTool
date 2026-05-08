import { getToken } from './auth.js';
import { findRootFolder, listAllFiles, downloadFileContent, upsertFile } from './drive.js';
import { makeSemaphore, toast } from './utils.js';
import { MASTER_USERS } from './config.js';

const FETCH_CONCURRENCY  = 8;
const UPLOAD_CONCURRENCY = 4;

let fileIndex = []; // [{ videoSlug, labelName, labelId, classes[], annotationCounts{} }]
let classMap  = {}; // { className: { images, annotations } }

// ── Shell ─────────────────────────────────────────────────────────────────────

export function renderRefactor(container) {
  container.innerHTML = `
    <div style="max-width:700px;">
      <p class="section-title">Label Refactor</p>
      <p class="text-dim" style="font-size:13px;margin-bottom:1rem;">
        Rename or merge annotation class names across all label files in Drive.
      </p>
      <button class="btn btn-primary" id="rf-scan-btn">Scan Drive</button>

      <div id="rf-scan-progress" class="progress-wrap hidden">
        <div class="progress-label">
          <span id="rf-scan-text">Scanning…</span>
          <span id="rf-scan-pct">0%</span>
        </div>
        <div class="progress-bar"><div class="progress-fill" id="rf-scan-fill"></div></div>
      </div>

      <div id="rf-results" class="hidden">
        <p class="section-title" style="margin-top:1.5rem;">Classes Found</p>
        <div id="rf-class-table"></div>

        <p class="section-title" style="margin-top:1.5rem;">Rename / Merge</p>
        <div class="rf-rename-row">
          <div style="flex:1;">
            <label class="rf-field-label">From</label>
            <select id="rf-from-select" class="rf-field-input">
              <option value="">— pick a class —</option>
            </select>
          </div>
          <span class="rf-arrow">→</span>
          <div style="flex:1;">
            <label class="rf-field-label">To</label>
            <input type="text" id="rf-to-input" class="rf-field-input" placeholder="new class name" />
          </div>
        </div>

        <div id="rf-preview" class="text-dim" style="font-size:13px;margin-top:0.75rem;min-height:1.4em;"></div>

        <div class="flex-row mt-2">
          <button class="btn btn-primary" id="rf-apply-btn" disabled>Apply Rename</button>
        </div>

        <div id="rf-apply-progress" class="progress-wrap hidden">
          <div class="progress-label">
            <span id="rf-apply-text">Updating…</span>
            <span id="rf-apply-pct">0%</span>
          </div>
          <div class="progress-bar"><div class="progress-fill" id="rf-apply-fill"></div></div>
        </div>
      </div>
    </div>
  `;

  document.getElementById('rf-scan-btn').addEventListener('click', startScan);
}

// ── Scan ──────────────────────────────────────────────────────────────────────

function isMaster() {
  const el = document.getElementById('user-email');
  const email = el ? el.textContent.trim().toLowerCase() : '';
  return MASTER_USERS.includes(email);
}

async function startScan() {
  if (!isMaster()) { toast('Access restricted to master users', 'error'); return; }
  const token = getToken();
  if (!token) { toast('Not signed in', 'error'); return; }

  const scanBtn = document.getElementById('rf-scan-btn');
  scanBtn.disabled = true;
  document.getElementById('rf-scan-progress').classList.remove('hidden');
  document.getElementById('rf-results').classList.add('hidden');

  try {
    setScanProgress(0, 'Finding PavementDataset folder…');
    const root = await findRootFolder(token);
    if (!root) { toast('PavementDataset folder not found', 'info'); return; }

    setScanProgress(0.05, 'Listing video folders…');
    const videoFolders = await listAllFiles(
      token,
      `'${root.id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      'id,name'
    );
    if (videoFolders.length === 0) { toast('No video folders found', 'info'); return; }

    const folderSem = makeSemaphore(4);
    const allFiles  = [];
    let scanned     = 0;

    await Promise.all(videoFolders.map(vf =>
      folderSem(async () => {
        const subfolders = await listAllFiles(
          token,
          `'${vf.id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
          'id,name'
        );
        const labelsFolder = subfolders.find(f => f.name === 'labels');
        if (labelsFolder) {
          const labelFiles = await listAllFiles(
            token, `'${labelsFolder.id}' in parents and trashed=false`, 'id,name'
          );
          for (const lf of labelFiles) {
            if (lf.name.endsWith('.json')) {
              allFiles.push({ videoSlug: vf.name, labelName: lf.name, labelId: lf.id, classes: [], annotationCounts: {} });
            }
          }
        }
        scanned++;
        setScanProgress(0.1 + (scanned / videoFolders.length) * 0.3,
          `Scanned ${scanned}/${videoFolders.length} folders…`);
      })
    ));

    if (allFiles.length === 0) { toast('No label files found', 'info'); return; }

    setScanProgress(0.4, `Reading ${allFiles.length} label files…`);
    const fetchSem = makeSemaphore(FETCH_CONCURRENCY);
    let fetched = 0;

    await Promise.all(allFiles.map(file =>
      fetchSem(async () => {
        try {
          const buf = await downloadFileContent(token, file.labelId);
          const json = JSON.parse(new TextDecoder().decode(buf));
          if (Array.isArray(json.shapes)) {
            const labels = json.shapes.map(s => s.label).filter(Boolean);
            file.classes = [...new Set(labels)];
            for (const lbl of labels) {
              file.annotationCounts[lbl] = (file.annotationCounts[lbl] || 0) + 1;
            }
          }
        } catch { /* skip corrupt files */ }
        fetched++;
        setScanProgress(0.4 + (fetched / allFiles.length) * 0.6, `Reading labels… ${fetched}/${allFiles.length}`);
      })
    ));

    fileIndex = allFiles;
    rebuildClassMap();

    setScanProgress(1, 'Scan complete');
    document.getElementById('rf-scan-progress').classList.add('hidden');
    renderResults();

  } catch (err) {
    toast(`Scan failed: ${err.message}`, 'error');
  } finally {
    scanBtn.disabled = false;
  }
}

// ── Results ───────────────────────────────────────────────────────────────────

function renderResults() {
  document.getElementById('rf-results').classList.remove('hidden');

  const sorted = Object.entries(classMap).sort((a, b) => b[1].annotations - a[1].annotations);

  document.getElementById('rf-class-table').innerHTML = `
    <table class="summary-table">
      <thead><tr><th>Class</th><th>Images</th><th>Annotations</th></tr></thead>
      <tbody>
        ${sorted.map(([cls, { images, annotations }]) => `
          <tr>
            <td><span class="badge badge-warn">${cls}</span></td>
            <td>${images}</td>
            <td>${annotations}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  const fromSelect = document.getElementById('rf-from-select');
  fromSelect.innerHTML = `<option value="">— pick a class —</option>` +
    sorted.map(([cls]) => `<option value="${cls}">${cls}</option>`).join('');

  fromSelect.onchange = updatePreview;
  document.getElementById('rf-to-input').oninput = updatePreview;
  document.getElementById('rf-apply-btn').onclick = applyRename;
  document.getElementById('rf-apply-btn').disabled = true;
  document.getElementById('rf-to-input').value = '';
  document.getElementById('rf-preview').textContent = '';
}

function updatePreview() {
  const from     = document.getElementById('rf-from-select').value.trim();
  const to       = document.getElementById('rf-to-input').value.trim();
  const preview  = document.getElementById('rf-preview');
  const applyBtn = document.getElementById('rf-apply-btn');

  if (!from || !to) {
    preview.textContent = '';
    applyBtn.disabled = true;
    return;
  }
  if (from === to) {
    preview.textContent = 'Source and target are the same class — nothing to do.';
    applyBtn.disabled = true;
    return;
  }

  const { images = 0, annotations = 0 } = classMap[from] || {};
  const mergeNote = classMap[to]
    ? ` "${to}" already exists (${classMap[to].annotations} annotation${classMap[to].annotations === 1 ? '' : 's'}) — classes will be merged.`
    : '';
  preview.textContent =
    `Will rename ${annotations} annotation${annotations === 1 ? '' : 's'} across ${images} image${images === 1 ? '' : 's'}.${mergeNote}`;
  applyBtn.disabled = false;
}

// ── Apply ─────────────────────────────────────────────────────────────────────

async function applyRename() {
  const from  = document.getElementById('rf-from-select').value.trim();
  const to    = document.getElementById('rf-to-input').value.trim();
  const token = getToken();
  if (!from || !to || from === to || !token) return;

  const affected = fileIndex.filter(f => f.classes.includes(from));
  if (affected.length === 0) { toast(`No files with class "${from}" found`, 'info'); return; }

  const applyBtn = document.getElementById('rf-apply-btn');
  const progWrap = document.getElementById('rf-apply-progress');
  applyBtn.disabled = true;
  progWrap.classList.remove('hidden');

  let done = 0, errors = 0;
  const setApplyProg = () => {
    const pct = Math.round((done / affected.length) * 100);
    document.getElementById('rf-apply-fill').style.width = `${pct}%`;
    document.getElementById('rf-apply-pct').textContent  = `${pct}%`;
    document.getElementById('rf-apply-text').textContent = `Updating… ${done}/${affected.length}`;
  };

  const sem = makeSemaphore(UPLOAD_CONCURRENCY);
  await Promise.all(affected.map(file =>
    sem(async () => {
      try {
        const buf  = await downloadFileContent(token, file.labelId);
        const json = JSON.parse(new TextDecoder().decode(buf));
        if (Array.isArray(json.shapes)) {
          for (const shape of json.shapes) {
            if (shape.label === from) shape.label = to;
          }
        }
        const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
        await upsertFile(token, '', file.labelName, 'application/json', blob, file.labelId);

        // Update in-memory index
        const prevCount = file.annotationCounts[from] || 0;
        file.classes = file.classes.filter(c => c !== from);
        if (!file.classes.includes(to)) file.classes.push(to);
        file.annotationCounts[to] = (file.annotationCounts[to] || 0) + prevCount;
        delete file.annotationCounts[from];
      } catch {
        errors++;
      }
      done++;
      setApplyProg();
    })
  ));

  rebuildClassMap();
  const errNote = errors ? ` (${errors} errors)` : '';
  toast(`Renamed "${from}" → "${to}" in ${affected.length - errors} file${affected.length - errors === 1 ? '' : 's'}${errNote}`,
    errors ? 'error' : 'success');

  progWrap.classList.add('hidden');
  renderResults();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function rebuildClassMap() {
  classMap = {};
  for (const file of fileIndex) {
    for (const cls of file.classes) {
      if (!classMap[cls]) classMap[cls] = { images: 0, annotations: 0 };
      classMap[cls].images++;
      classMap[cls].annotations += file.annotationCounts[cls] || 0;
    }
  }
}

function setScanProgress(fraction, text) {
  const fill = document.getElementById('rf-scan-fill');
  if (!fill) return;
  fill.style.width = `${Math.round(fraction * 100)}%`;
  document.getElementById('rf-scan-pct').textContent  = `${Math.round(fraction * 100)}%`;
  document.getElementById('rf-scan-text').textContent = text;
}
