import { getToken, getUser } from './auth.js';
import { ensureFolderPath, upsertFile, indexFolderFiles, appendTracking, listAllFiles, downloadFileContent, writeJsonFile } from './drive.js';
import { collectFilesFromDrop, toast } from './utils.js';
import { getDatasetRawDataFolder } from './dataset-manager.js';

// Accumulated file pool — persists across drops until Start Over
let accumImages = new Map(); // basename → File
let accumJsons  = new Map(); // basename → { file, parsed }

export function renderUploader(container) {
  container.innerHTML = `
    <div style="max-width:700px;">
      <p class="section-title">1. Drop Your Files</p>
      <div class="file-pick-area" id="ul-drop">
        <div class="pick-icon">📂</div>
        <div class="pick-label">Drag and drop a folder here</div>
        <div class="pick-sub" id="ul-drop-sub">Drop multiple folders one at a time — images and labels accumulate across drops</div>
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
          <button class="btn btn-ghost"   id="ul-reset-btn">Start Over</button>
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

  document.getElementById('ul-reset-btn')?.addEventListener('click', () => {
    accumImages.clear();
    accumJsons.clear();
    document.getElementById('ul-drop-sub').textContent = 'Drop multiple folders one at a time — images and labels accumulate across drops';
    resetUploader();
  });
}

// ── File processing ───────────────────────────────────────────────────────────

function inferName(firstItem) {
  try {
    const entry = firstItem.webkitGetAsEntry();
    if (entry && entry.isDirectory) return entry.name;
  } catch {}
  return '';
}

function processFiles(files, firstItem) {
  processAccumulate(files, inferName(firstItem));
}

async function processAccumulate(files, inferredName) {
  // Add images to pool
  for (const file of files) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (['jpg', 'jpeg', 'png'].includes(ext)) accumImages.set(file.name, file);
  }

  // Parse and add JSONs to pool
  const jsonFiles = files.filter(f => f.name.toLowerCase().endsWith('.json'));
  const results   = await Promise.all(jsonFiles.map(parseJson));
  const newJsonMap = buildJsonMap(results);
  for (const [k, v] of newJsonMap) accumJsons.set(k, v);

  const pairs = buildPairs(accumImages, accumJsons);

  document.getElementById('ul-drop-sub').textContent =
    `${accumImages.size} image${accumImages.size === 1 ? '' : 's'}, ${accumJsons.size} JSON${accumJsons.size === 1 ? '' : 's'} accumulated — drop another folder to add more`;

  document.getElementById('ul-stat-row').innerHTML = `
    <div class="stat"><div class="stat-label">Images</div><div class="stat-value">${accumImages.size}</div></div>
    <div class="stat"><div class="stat-label">JSON Files</div><div class="stat-value">${accumJsons.size}</div></div>
    <div class="stat"><div class="stat-label">Matched Pairs</div><div class="stat-value text-success">${pairs.length}</div></div>
  `;

  const skipped = accumImages.size - pairs.length;
  // Use first drop's folder name as default; don't overwrite if already set
  const folderInput = document.getElementById('ul-folder-name');
  if (!folderInput?.value && inferredName) folderInput.value = inferredName;

  showSummary('', () => startUpload(pairs, document.getElementById('ul-folder-name').value.trim(), skipped));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function parseJson(file) {
  try {
    const text   = await file.text();
    const parsed = JSON.parse(text);
    return { file, parsed };
  } catch { return null; }
}

function buildJsonMap(results) {
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
  return jsonMap;
}

function buildPairs(imageMap, jsonMap) {
  const pairs = [];
  for (const [imgName, imgFile] of imageMap) {
    const stem  = imgName.replace(/\.[^.]+$/, '');
    const match = jsonMap.get(imgName) || jsonMap.get(stem);
    if (match) pairs.push({ image: imgFile, json: match.file });
  }
  return pairs;
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
  if (!token) { select.innerHTML = '<option value="">— sign in to load existing roads —</option>'; return; }
  const rawDataFolder = await getDatasetRawDataFolder(token);
  if (!rawDataFolder) { select.innerHTML = '<option value="">— open a project first —</option>'; return; }
  try {
    const folders = await listAllFiles(
      token,
      `'${rawDataFolder.id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      'id,name'
    );
    folders.sort((a, b) => a.name.localeCompare(b.name));
    select.innerHTML = `<option value="">— select an existing road —</option>` +
      folders.map(f => `<option value="${f.name}">${f.name}</option>`).join('');
  } catch {
    select.innerHTML = '<option value="">— could not load roads —</option>';
  }
}

// ── Upload ────────────────────────────────────────────────────────────────────

async function startUpload(pairs, folderName, skippedCount = 0) {
  const token = getToken();
  const user  = getUser();
  if (!token || !user) { toast('Not signed in', 'error'); return; }
  if (!folderName)     { toast('Enter a folder name', 'error'); return; }
  if (!pairs.length)   { toast('No matched pairs to upload', 'error'); return; }

  const uploadBtn = document.getElementById('ul-upload-btn');
  const resetBtn  = document.getElementById('ul-reset-btn');
  const progWrap  = document.getElementById('ul-progress-wrap');
  uploadBtn.disabled = true;
  resetBtn.disabled  = true;
  progWrap.classList.remove('hidden');

  const rawDataFolder = await getDatasetRawDataFolder(token);
  if (!rawDataFolder) { toast('No dataset open', 'error'); return; }

  toast('Setting up Drive folders…', 'info');
  let folders;
  try {
    folders = await ensureFolderPath(token, folderName, rawDataFolder.id);
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
  } catch { /* treat all as new */ }

  let reviewDecisions = {};
  let clearedAny = false;
  try {
    const rdFiles = await listAllFiles(
      token,
      `name='review_decisions.json' and '${rawDataFolder.id}' in parents and trashed=false`,
      'id'
    );
    if (rdFiles.length > 0) {
      const buf    = await downloadFileContent(token, rdFiles[0].id);
      const parsed = JSON.parse(new TextDecoder().decode(buf));
      if (parsed && typeof parsed === 'object') reviewDecisions = parsed;
    }
  } catch { /* no decisions file — nothing to clear */ }

  const total = pairs.length * 2;
  let done = 0, errors = 0;
  const setProgress = (n) => {
    const pct = Math.round((n / total) * 100);
    document.getElementById('ul-progress-fill').style.width = `${pct}%`;
    document.getElementById('ul-progress-pct').textContent  = `${pct}%`;
    document.getElementById('ul-progress-text').textContent = `Uploading file ${n} of ${total}`;
  };

  const uploads = pairs.flatMap(({ image, json }) => [
    async () => {
      const buf = await image.arrayBuffer();
      await upsertFile(token, folders.framesId, image.name, 'image/jpeg',
        new Blob([buf], { type: 'image/jpeg' }), existingFrames.get(image.name));
      done++; setProgress(done);
    },
    async () => {
      const existingId = existingLabels.get(json.name);
      const text = await json.text();
      await upsertFile(token, folders.labelsId, json.name, 'application/json',
        new Blob([text], { type: 'application/json' }), existingId);
      if (existingId && existingId in reviewDecisions) {
        delete reviewDecisions[existingId];
        clearedAny = true;
      }
      done++; setProgress(done);
    },
  ]);

  await Promise.allSettled(uploads.map(fn => fn().catch(e => { errors++; console.warn(e); })));

  if (clearedAny) {
    try {
      await writeJsonFile(token, rawDataFolder.id, 'review_decisions.json', reviewDecisions);
    } catch (err) { console.warn('Failed to update review decisions:', err); }
  }

  const pairWord  = pairs.length === 1 ? 'pair' : 'pairs';
  const errSuffix = errors ? ` (${errors} errors)` : '';
  toast(`Uploaded ${pairs.length} image+label ${pairWord}.${errSuffix}`, errors ? 'error' : 'success');

  try {
    await appendTracking(token, folders.rootId, {
      user:            user.email,
      action:          'label_upload',
      folder_name:     folderName,
      file_count:      pairs.length * 2,
      annotated_count: pairs.length,
      skipped_count:   skippedCount,
      labels_folder_id: folders.labelsId,
    });
  } catch (err) { console.warn('Failed to write tracking entry:', err); }

  uploadBtn.disabled = false;
  resetBtn.disabled  = false;
}

function resetUploader() {
  document.getElementById('ul-summary').classList.add('hidden');
  document.getElementById('ul-progress-wrap').classList.add('hidden');
  document.getElementById('ul-progress-fill').style.width = '0%';
}

