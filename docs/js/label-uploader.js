import { getToken, getUser } from './auth.js';
import { ensureFolderPath, upsertFile, indexFolderFiles, appendTracking, findRootFolder, listAllFiles } from './drive.js';
import { collectFilesFromDrop, toast } from './utils.js';

export function renderUploader(container) {
  container.innerHTML = `
    <div style="max-width:700px;">
      <p class="section-title">1. Drop Your Labeled Folder</p>
      <div class="file-pick-area" id="ul-drop">
        <div class="pick-icon">📂</div>
        <div class="pick-label">Drag and drop your LabelMe output folder here</div>
        <div class="pick-sub">Should contain image files (.jpg/.png) and LabelMe JSON files</div>
      </div>

      <div id="ul-summary" class="hidden">
        <p class="section-title">2. Review Matches</p>
        <div class="stat-row">
          <div class="stat">
            <div class="stat-label">Images Found</div>
            <div class="stat-value" id="ul-stat-total">0</div>
          </div>
          <div class="stat">
            <div class="stat-label">Labeled (will upload)</div>
            <div class="stat-value text-success" id="ul-stat-matched">0</div>
          </div>
          <div class="stat">
            <div class="stat-label">Skipped (no label)</div>
            <div class="stat-value text-dim" id="ul-stat-skipped">0</div>
          </div>
        </div>

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

function processFiles(files, firstItem) {
  // Try to infer a folder name from the first dropped item
  let inferredName = '';
  try {
    const entry = firstItem.webkitGetAsEntry();
    if (entry && entry.isDirectory) inferredName = entry.name;
  } catch {}

  const imageMap = new Map(); // basename → File
  const jsonMap  = new Map(); // imagePath basename → { file, parsed }

  for (const file of files) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (['jpg', 'jpeg', 'png'].includes(ext)) {
      imageMap.set(file.name, file);
    } else if (ext === 'json') {
      try {
        // We can't call .text() synchronously; queue async parsing
      } catch {}
    }
  }

  // Parse JSONs asynchronously then render summary
  const jsonFiles = files.filter(f => f.name.toLowerCase().endsWith('.json'));
  Promise.all(jsonFiles.map(parseJson)).then((results) => {
    for (const result of results) {
      if (!result) continue;
      const { file, parsed } = result;
      if (!Array.isArray(parsed.shapes) || parsed.shapes.length === 0) continue;

      // Normalize imagePath to basename
      const raw = parsed.imagePath || '';
      const basename = raw.split(/[/\\]/).pop();

      if (basename) {
        jsonMap.set(basename, { file, parsed });

        // Stem-only fallback: try matching without extension (handles .png vs .jpg mismatches)
        const stem = basename.replace(/\.[^.]+$/, '');
        if (!jsonMap.has(stem)) jsonMap.set(stem, { file, parsed });
      }
    }

    // Build matched pairs
    const pairs = [];
    for (const [imgName, imgFile] of imageMap) {
      const stem = imgName.replace(/\.[^.]+$/, '');
      const match = jsonMap.get(imgName) || jsonMap.get(stem);
      if (match) pairs.push({ image: imgFile, json: match.file });
    }

    renderSummary(imageMap.size, pairs, inferredName);
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

function renderSummary(totalImages, pairs, inferredName) {
  const summary = document.getElementById('ul-summary');
  summary.classList.remove('hidden');

  document.getElementById('ul-stat-total').textContent   = totalImages;
  document.getElementById('ul-stat-matched').textContent = pairs.length;
  document.getElementById('ul-stat-skipped').textContent = totalImages - pairs.length;

  const folderInput  = document.getElementById('ul-folder-name');
  const folderSelect = document.getElementById('ul-folder-select');
  if (inferredName) folderInput.value = inferredName;

  folderSelect.onchange = () => {
    if (folderSelect.value) folderInput.value = folderSelect.value;
  };

  folderInput.oninput = () => {
    folderSelect.value = '';
  };

  populateFolderDropdown(folderSelect);

  const uploadBtn = document.getElementById('ul-upload-btn');
  uploadBtn.onclick = () => startUpload(pairs, folderInput.value.trim());
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

async function startUpload(pairs, folderName) {
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
      skipped_count: parseInt(document.getElementById('ul-stat-skipped').textContent, 10) || 0,
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
