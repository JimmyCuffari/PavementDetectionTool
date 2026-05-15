import { getToken, getUser } from './auth.js';
import { ensureFolderPath, upsertFile, indexFolderFiles, appendTracking, findRootFolder, listAllFiles } from './drive.js';
import { collectFilesFromDrop, toast } from './utils.js';

// 'paired' | 'frames' | 'labels'
let uploadMode = 'paired';

const MODE_CONFIG = {
  paired: {
    label: 'Drop your LabelMe output folder here',
    sub:   'Should contain image files (.jpg/.png) and matching JSON files',
  },
  frames: {
    label: 'Drop a folder of image files here',
    sub:   'Uploads images to the frames/ subfolder on Drive',
  },
  labels: {
    label: 'Drop a folder of LabelMe JSON files here',
    sub:   'Uploads JSONs to the labels/ subfolder on Drive',
  },
};

export function renderUploader(container) {
  container.innerHTML = `
    <div style="max-width:700px;">
      <div class="ul-mode-bar">
        <button class="ul-mode-btn active" data-mode="paired">Paired</button>
        <button class="ul-mode-btn" data-mode="frames">Frames Only</button>
        <button class="ul-mode-btn" data-mode="labels">Labels Only</button>
      </div>

      <p class="section-title" style="margin-top:1rem;">1. Drop Your Files</p>
      <div class="file-pick-area" id="ul-drop">
        <div class="pick-icon">📂</div>
        <div class="pick-label" id="ul-drop-label">${MODE_CONFIG.paired.label}</div>
        <div class="pick-sub"   id="ul-drop-sub">${MODE_CONFIG.paired.sub}</div>
      </div>

      <div id="ul-summary" class="hidden">
        <p class="section-title">2. Review</p>
        <div class="stat-row" id="ul-stat-row"></div>

        <div class="form-group mt-2">
          <label>Drive folder name (where frames &amp; labels will be stored)</label>
          <select id="ul-folder-select"
            style="width:100%;padding:0.4rem 0.6rem;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-family:var(--font);margin-bottom:0.4rem;">
            <option value="">— loading existing roads… —</option>
          </select>
          <input type="text" id="ul-folder-name" placeholder="or type a new folder name"
            style="width:100%;padding:0.4rem 0.6rem;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-family:var(--font);" />
        </div>

        <div class="flex-row mt-2">
          <button class="btn btn-primary" id="ul-upload-btn">Upload to Drive</button>
          <button class="btn btn-ghost" id="ul-reset-btn">Start Over</button>
        </div>

        <div id="ul-progress-wrap" class="progress-wrap hidden">
          <div class="progress-label">
            <span id="ul-progress-text">Uploading…</span>
            <span id="ul-progress-pct">0%</span>
          </div>
          <div class="progress-bar"><div class="progress-fill" id="ul-progress-fill"></div></div>
        </div>
      </div>
    </div>
  `;

  const dropArea = document.getElementById('ul-drop');

  // Mode selector
  container.querySelectorAll('.ul-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      uploadMode = btn.dataset.mode;
      container.querySelectorAll('.ul-mode-btn').forEach(b => b.classList.toggle('active', b === btn));
      const cfg = MODE_CONFIG[uploadMode];
      document.getElementById('ul-drop-label').textContent = cfg.label;
      document.getElementById('ul-drop-sub').textContent   = cfg.sub;
      resetUploader();
    });
  });

  dropArea.addEventListener('dragover', (e) => { e.preventDefault(); dropArea.classList.add('drag-over'); });
  dropArea.addEventListener('dragleave', () => dropArea.classList.remove('drag-over'));
  dropArea.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropArea.classList.remove('drag-over');
    const items = [...e.dataTransfer.items];
    if (items.length === 0) return;

    toast('Reading files…', 'info');
    const files = await collectFilesFromDrop(items);
    processFiles(files, items[0]);
  });

  document.getElementById('ul-reset-btn')?.addEventListener('click', resetUploader);
}

function inferName(firstItem) {
  try {
    const entry = firstItem.webkitGetAsEntry();
    if (entry && entry.isDirectory) return entry.name;
  } catch {}
  return '';
}

function processFiles(files, firstItem) {
  const name = inferName(firstItem);

  if (uploadMode === 'frames') {
    const images = files.filter(f => /\.(jpg|jpeg|png)$/i.test(f.name));
    renderSummarySimple(images, name, 'frames');
    return;
  }

  if (uploadMode === 'labels') {
    const jsons = files.filter(f => f.name.toLowerCase().endsWith('.json'));
    renderSummarySimple(jsons, name, 'labels');
    return;
  }

  // Paired mode
  const imageMap = new Map();
  for (const file of files) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (['jpg', 'jpeg', 'png'].includes(ext)) imageMap.set(file.name, file);
  }

  const jsonFiles = files.filter(f => f.name.toLowerCase().endsWith('.json'));
  Promise.all(jsonFiles.map(parseJson)).then((results) => {
    const jsonMap = new Map();
    for (const result of results) {
      if (!result) continue;
      const { file, parsed } = result;
      if (!Array.isArray(parsed.shapes) || parsed.shapes.length === 0) continue;
      const raw      = parsed.imagePath || '';
      const basename = raw.split(/[/\\]/).pop();
      if (basename) {
        jsonMap.set(basename, { file, parsed });
        const stem = basename.replace(/\.[^.]+$/, '');
        if (!jsonMap.has(stem)) jsonMap.set(stem, { file, parsed });
      }
    }

    const pairs = [];
    for (const [imgName, imgFile] of imageMap) {
      const stem  = imgName.replace(/\.[^.]+$/, '');
      const match = jsonMap.get(imgName) || jsonMap.get(stem);
      if (match) pairs.push({ image: imgFile, json: match.file });
    }

    renderSummaryPaired(imageMap.size, pairs, name);
  });
}

async function parseJson(file) {
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    return { file, parsed };
  } catch {
    return null;
  }
}

function renderSummaryPaired(totalImages, pairs, inferredName) {
  document.getElementById('ul-stat-row').innerHTML = `
    <div class="stat"><div class="stat-label">Images Found</div><div class="stat-value">${totalImages}</div></div>
    <div class="stat"><div class="stat-label">Labeled (will upload)</div><div class="stat-value text-success">${pairs.length}</div></div>
    <div class="stat"><div class="stat-label">Skipped (no label)</div><div class="stat-value text-dim">${totalImages - pairs.length}</div></div>
  `;
  const skipped = totalImages - pairs.length;
  showSummary(inferredName, () => startUpload(pairs, document.getElementById('ul-folder-name').value.trim(), skipped));
}

function renderSummarySimple(files, inferredName, type) {
  const label = type === 'frames' ? 'Images' : 'JSON Files';
  document.getElementById('ul-stat-row').innerHTML = `
    <div class="stat"><div class="stat-label">${label} Found</div><div class="stat-value">${files.length}</div></div>
    <div class="stat"><div class="stat-label">Will Upload</div><div class="stat-value text-success">${files.length}</div></div>
  `;
  showSummary(inferredName, () => startUploadSingle(files, document.getElementById('ul-folder-name').value.trim(), type));
}

function showSummary(inferredName, onUpload) {
  document.getElementById('ul-summary').classList.remove('hidden');

  const folderInput  = document.getElementById('ul-folder-name');
  const folderSelect = document.getElementById('ul-folder-select');
  if (inferredName) folderInput.value = inferredName;

  folderSelect.onchange = () => { if (folderSelect.value) folderInput.value = folderSelect.value; };
  folderInput.oninput   = () => { folderSelect.value = ''; };
  populateFolderDropdown(folderSelect);

  document.getElementById('ul-upload-btn').onclick = onUpload;
}

async function populateFolderDropdown(select) {
  const token = getToken();
  if (!token) {
    select.innerHTML = '<option value="">— sign in to load existing roads —</option>';
    return;
  }
  try {
    const root = await findRootFolder(token);
    if (!root) {
      select.innerHTML = '<option value="">— no existing roads found —</option>';
      return;
    }
    const folders = await listAllFiles(
      token,
      `'${root.id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      'id,name'
    );
    folders.sort((a, b) => a.name.localeCompare(b.name));
    select.innerHTML = `<option value="">— select an existing road —</option>` +
      folders.map(f => `<option value="${f.name}">${f.name}</option>`).join('');
  } catch {
    select.innerHTML = '<option value="">— could not load roads —</option>';
  }
}

async function startUploadSingle(files, folderName, type) {
  const token = getToken();
  const user  = getUser();
  if (!token || !user) { toast('Not signed in', 'error'); return; }
  if (!folderName)     { toast('Enter a folder name', 'error'); return; }
  if (!files.length)   { toast('No files to upload', 'error'); return; }

  const uploadBtn = document.getElementById('ul-upload-btn');
  const resetBtn  = document.getElementById('ul-reset-btn');
  const progWrap  = document.getElementById('ul-progress-wrap');
  uploadBtn.disabled = true;
  resetBtn.disabled  = true;
  progWrap.classList.remove('hidden');

  toast('Setting up Drive folders…', 'info');
  let folders;
  try {
    folders = await ensureFolderPath(token, folderName);
  } catch (err) {
    toast(`Drive error: ${err.message}`, 'error');
    uploadBtn.disabled = false;
    resetBtn.disabled  = false;
    return;
  }

  const folderId = type === 'frames' ? folders.framesId : folders.labelsId;
  const mimeType = type === 'frames' ? 'image/jpeg' : 'application/json';

  toast('Checking existing files…', 'info');
  let existing = new Map();
  try { existing = await indexFolderFiles(token, folderId); } catch {}

  let done = 0, errors = 0;
  const setProgress = (n) => {
    const pct = Math.round((n / files.length) * 100);
    document.getElementById('ul-progress-fill').style.width = `${pct}%`;
    document.getElementById('ul-progress-pct').textContent  = `${pct}%`;
    document.getElementById('ul-progress-text').textContent = `Uploading file ${n} of ${files.length}`;
  };

  await Promise.allSettled(files.map(async (file) => {
    try {
      const buf = await file.arrayBuffer();
      await upsertFile(token, folderId, file.name, mimeType, new Blob([buf], { type: mimeType }), existing.get(file.name));
      done++;
    } catch (e) {
      errors++;
      console.warn(e);
    }
    setProgress(done + errors);
  }));

  const noun      = type === 'frames' ? 'frame' : 'label';
  const errSuffix = errors ? ` (${errors} errors)` : '';
  toast(`Uploaded ${done} ${noun}${done === 1 ? '' : 's'}${errSuffix}`, errors ? 'error' : 'success');

  try {
    await appendTracking(token, folders.rootId, {
      user:       user.email,
      action:     `${type}_upload`,
      folder_name: folderName,
      file_count:  done,
    });
  } catch {}

  uploadBtn.disabled = false;
  resetBtn.disabled  = false;
}

async function startUpload(pairs, folderName, skippedCount = 0) {
  const token = getToken();
  const user  = getUser();
  if (!token || !user) { toast('Not signed in', 'error'); return; }
  if (!folderName)     { toast('Enter a folder name', 'error'); return; }
  if (pairs.length === 0) { toast('No labeled frames to upload', 'error'); return; }

  const uploadBtn  = document.getElementById('ul-upload-btn');
  const resetBtn   = document.getElementById('ul-reset-btn');
  const progWrap   = document.getElementById('ul-progress-wrap');
  uploadBtn.disabled = true;
  resetBtn.disabled  = true;
  progWrap.classList.remove('hidden');

  toast('Setting up Drive folders…', 'info');

  let folders;
  try {
    folders = await ensureFolderPath(token, folderName);
  } catch (err) {
    toast(`Drive error: ${err.message}`, 'error');
    uploadBtn.disabled = false;
    resetBtn.disabled  = false;
    return;
  }

  toast('Checking existing files…', 'info');
  let existingFrames = new Map();
  let existingLabels = new Map();
  try {
    [existingFrames, existingLabels] = await Promise.all([
      indexFolderFiles(token, folders.framesId),
      indexFolderFiles(token, folders.labelsId),
    ]);
  } catch { /* proceed without index — all files will be treated as new */ }

  const total = pairs.length * 2;
  let done = 0;
  let errors = 0;

  const setProgress = (n) => {
    const pct = Math.round((n / total) * 100);
    document.getElementById('ul-progress-fill').style.width = `${pct}%`;
    document.getElementById('ul-progress-pct').textContent = `${pct}%`;
    document.getElementById('ul-progress-text').textContent = `Uploading file ${n} of ${total}`;
  };

  const uploads = pairs.flatMap(({ image, json }) => [
    async () => {
      const buf = await image.arrayBuffer();
      await upsertFile(token, folders.framesId, image.name, 'image/jpeg',
        new Blob([buf], { type: 'image/jpeg' }), existingFrames.get(image.name));
      done++;
      setProgress(done);
    },
    async () => {
      const text = await json.text();
      await upsertFile(token, folders.labelsId, json.name, 'application/json',
        new Blob([text], { type: 'application/json' }), existingLabels.get(json.name));
      done++;
      setProgress(done);
    },
  ]);

  await Promise.allSettled(uploads.map(fn => fn().catch(e => { errors++; console.warn(e); })));

  const pairWord    = pairs.length === 1 ? 'pair' : 'pairs';
  const errorSuffix = errors ? ` (${errors} errors)` : '';
  toast(
    `Uploaded ${pairs.length} image+label ${pairWord}.${errorSuffix}`,
    errors ? 'error' : 'success'
  );

  // Write tracking entry
  try {
    await appendTracking(token, folders.rootId, {
      user: user.email,
      action: 'label_upload',
      folder_name: folderName,
      file_count: pairs.length * 2,
      annotated_count: pairs.length,
      skipped_count: skippedCount,
      labels_folder_id: folders.labelsId,
    });
  } catch (err) {
    console.warn('Failed to write tracking entry:', err);
  }

  uploadBtn.disabled = false;
  resetBtn.disabled  = false;
}

function resetUploader() {
  const summary = document.getElementById('ul-summary');
  summary.classList.add('hidden');
  document.getElementById('ul-progress-wrap').classList.add('hidden');
  document.getElementById('ul-progress-fill').style.width = '0%';
}
