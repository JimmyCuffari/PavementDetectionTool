import { getToken } from './auth.js';
import { findOrCreateFolder, findFolder, deleteFile, renameFile, listAllFiles } from './drive.js';
import { toast } from './utils.js';
import { getCurrentProject, getProjectDatasetsFolder } from './project-manager.js';

const DS_ACTIVE_KEY = 'pavement_tool_active_dataset';
const dsKey = id  => `pavement_tool_datasets_${id}`;

// ── Persistent state ───────────────────────────────────────────────────────────

export function getDatasetsForProject(projectId) {
  try { return JSON.parse(localStorage.getItem(dsKey(projectId)) ?? '[]'); } catch { return []; }
}

// Silently syncs the datasets/ folder in Drive into localStorage and returns
// the up-to-date list. Safe to call from any tool before reading datasets.
export async function syncAndGetDatasets(token, project) {
  if (!token || !project) return getDatasetsForProject(project?.id ?? '');
  try {
    const datasetsFolder = await getProjectDatasetsFolder(token);
    if (!datasetsFolder) return getDatasetsForProject(project.id);

    const folders  = await listAllFiles(
      token,
      `'${datasetsFolder.id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      'id,name,createdTime'
    );
    const driveIds = new Set(folders.map(f => f.id));
    const existing = getDatasetsForProject(project.id);
    const kept     = existing.filter(d => driveIds.has(d.driveFolderId));
    const knownIds = new Set(kept.map(d => d.driveFolderId));
    let   changed  = existing.length !== kept.length;

    for (const folder of folders) {
      if (knownIds.has(folder.id)) continue;
      kept.push({
        id:            crypto.randomUUID(),
        name:          folder.name,
        description:   '',
        driveFolderId: folder.id,
        createdAt:     folder.createdTime ?? new Date().toISOString(),
      });
      changed = true;
    }

    if (changed) {
      const activeId = getCurrentDataset()?.id;
      if (activeId && !kept.find(d => d.id === activeId)) setCurrentDataset(null);
      saveDatasets(project.id, kept);
      localStorage.setItem('pavement_tool_last_sync', new Date().toISOString());
      window.dispatchEvent(new CustomEvent('drive-synced'));
    }
    return kept;
  } catch {
    return getDatasetsForProject(project.id);
  }
}

function saveDatasets(projectId, datasets) {
  localStorage.setItem(dsKey(projectId), JSON.stringify(datasets));
}

export function getCurrentDataset() {
  try { return JSON.parse(localStorage.getItem(DS_ACTIVE_KEY) ?? 'null'); } catch { return null; }
}

export function setCurrentDataset(dataset) {
  if (dataset) localStorage.setItem(DS_ACTIVE_KEY, JSON.stringify(dataset));
  else         localStorage.removeItem(DS_ACTIVE_KEY);
}

export function getCurrentDatasetFolderId() {
  return getCurrentDataset()?.driveFolderId ?? null;
}

export async function getDatasetRawDataFolder(token) {
  const datasetFolderId = getCurrentDatasetFolderId();
  if (!datasetFolderId) return null;
  return findOrCreateFolder(token, 'raw data', datasetFolderId);
}

// ── UI state ───────────────────────────────────────────────────────────────────

let _callbacks   = {};
let _container   = null;
let editingId    = null;
let confirmingId = null;

export function renderDatasetManager(container, callbacks) {
  _callbacks  = callbacks;
  _container  = container;
  rerender();
  const project = getCurrentProject();
  if (project) syncDatasetsFromDrive(project);
}

export function refreshDatasetManager() {
  editingId    = null;
  confirmingId = null;
  rerender();
  const project = getCurrentProject();
  if (project) syncDatasetsFromDrive(project);
}

function rerender() {
  const project  = getCurrentProject();
  const current  = getCurrentDataset();

  if (!project) {
    _container.innerHTML = `<p class="text-dim" style="font-size:13px;">Open a project first.</p>`;
    return;
  }

  const datasets = getDatasetsForProject(project.id);

  _container.innerHTML = `
    <div style="max-width:640px;">
      <div class="flex-row" style="justify-content:space-between;align-items:center;margin-bottom:1.25rem;">
        <p class="section-title" style="margin:0;">Datasets — ${escHtml(project.name)}</p>
        <div class="flex-row" style="gap:0.5rem;">
          <button class="btn btn-ghost btn-sm" id="dm-sync-btn" title="Re-import datasets from Drive">↻ Sync from Drive</button>
          <button class="btn btn-primary btn-sm" id="dm-new-btn">+ New Dataset</button>
        </div>
      </div>

      <div id="dm-form" class="pm-form hidden">
        <p class="section-title" style="margin-bottom:0.4rem;">New Dataset</p>
        <p class="text-dim" style="font-size:12px;margin-bottom:0.75rem;">
          A folder with this name will be created inside
          <strong style="color:var(--text);">${escHtml(project.name)}/datasets/</strong>.
        </p>
        <div class="folder-input-row" style="margin-bottom:0.5rem;">
          <label style="white-space:nowrap;min-width:120px;">Dataset name:</label>
          <input type="text" id="dm-name-input" placeholder="e.g. raw_v1" />
        </div>
        <div class="folder-input-row" style="margin-bottom:0.75rem;align-items:flex-start;">
          <label style="white-space:nowrap;min-width:120px;padding-top:0.3rem;">Description:</label>
          <textarea id="dm-desc-input" placeholder="Optional description" rows="2"
            style="flex:1;padding:0.4rem 0.6rem;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-family:var(--font);font-size:13px;resize:vertical;"></textarea>
        </div>
        <div class="flex-row" style="gap:0.5rem;">
          <button class="btn btn-primary btn-sm" id="dm-create-btn">Create Dataset</button>
          <button class="btn btn-ghost btn-sm" id="dm-cancel-btn">Cancel</button>
        </div>
      </div>

      <div id="dm-dataset-list">
        ${datasets.length === 0
          ? `<p class="text-dim" style="font-size:13px;margin-top:0.5rem;">No datasets yet. Create one to get started.</p>`
          : datasets.map(d => datasetCardHtml(d, current?.id)).join('')}
      </div>
    </div>
  `;

  wireForm(project);
  wireCards(project);
}

// ── Form wiring ────────────────────────────────────────────────────────────────

function wireForm(project) {
  document.getElementById('dm-sync-btn').addEventListener('click', () => syncDatasetsFromDrive(project));

  document.getElementById('dm-new-btn').addEventListener('click', () => {
    document.getElementById('dm-form').classList.toggle('hidden');
  });
  document.getElementById('dm-cancel-btn').addEventListener('click', () => {
    document.getElementById('dm-form').classList.add('hidden');
    document.getElementById('dm-name-input').value = '';
    document.getElementById('dm-desc-input').value = '';
  });
  document.getElementById('dm-create-btn').addEventListener('click', () => createDataset(project));
  document.getElementById('dm-name-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') createDataset(project);
  });
}

// ── Sync from Drive ────────────────────────────────────────────────────────────

async function syncDatasetsFromDrive(project) {
  const btn   = document.getElementById('dm-sync-btn');
  const token = getToken();
  if (!token) { toast('Not signed in', 'error'); return; }

  if (btn) { btn.disabled = true; btn.textContent = '↻ Syncing…'; }

  try {
    const before  = getDatasetsForProject(project.id);
    const updated = await syncAndGetDatasets(token, project);
    const added   = updated.filter(d => !before.find(b => b.id === d.id)).length;
    const removed = before.filter(b => !updated.find(u => u.id === b.id)).length;
    if (added > 0 || removed > 0) {
      const parts = [];
      if (added   > 0) parts.push(`imported ${added}`);
      if (removed > 0) parts.push(`removed ${removed}`);
      toast(`Sync complete: ${parts.join(', ')} dataset${added + removed > 1 ? 's' : ''}`, 'success');
      rerender();
    } else {
      toast('Datasets are up to date with Drive', 'success');
    }
  } catch (err) {
    toast(`Sync failed: ${err.message}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '↻ Sync from Drive'; }
  }
}

// ── Create ─────────────────────────────────────────────────────────────────────

async function createDataset(project) {
  const name  = document.getElementById('dm-name-input')?.value.trim();
  const desc  = document.getElementById('dm-desc-input')?.value.trim();
  const token = getToken();

  if (!name)  { toast('Enter a dataset name', 'error'); return; }
  if (!token) { toast('Not signed in', 'error'); return; }

  const existing = getDatasetsForProject(project.id);
  if (existing.some(d => d.name.toLowerCase() === name.toLowerCase())) {
    toast(`A dataset named "${name}" already exists in this project`, 'error');
    return;
  }

  const btn = document.getElementById('dm-create-btn');
  btn.disabled    = true;
  btn.textContent = 'Creating…';

  try {
    const datasetsFolder = await getProjectDatasetsFolder(token);
    if (!datasetsFolder) throw new Error('Could not access datasets folder');

    // Block if Drive folder already exists
    const conflict = await findFolder(token, name, datasetsFolder.id);
    if (conflict) {
      toast(`A folder named "${name}" already exists in datasets/`, 'error');
      btn.disabled = false; btn.textContent = 'Create Dataset';
      return;
    }

    const newFolder = await findOrCreateFolder(token, name, datasetsFolder.id);
    // Create standard subfolders inside the new dataset folder
    await Promise.all([
      findOrCreateFolder(token, 'raw data', newFolder.id),
      findOrCreateFolder(token, 'split datasets', newFolder.id),
    ]);

    const dataset = {
      id:            crypto.randomUUID(),
      name,
      description:   desc || '',
      driveFolderId: newFolder.id,
      createdAt:     new Date().toISOString(),
    };
    saveDatasets(project.id, [...existing, dataset]);

    toast(`Dataset "${name}" created`, 'success');
    document.getElementById('dm-form').classList.add('hidden');
    openDataset(dataset);

  } catch (err) {
    toast(`Failed to create dataset: ${err.message}`, 'error');
    btn.disabled = false; btn.textContent = 'Create Dataset';
  }
}

// ── Edit ───────────────────────────────────────────────────────────────────────

async function saveEdit(id, project) {
  const input   = document.getElementById(`dm-edit-input-${id}`);
  const newName = input?.value.trim();
  const newDesc = document.getElementById(`dm-edit-desc-${id}`)?.value.trim() ?? '';
  if (!newName) { toast('Enter a dataset name', 'error'); return; }

  const token    = getToken();
  if (!token) { toast('Not signed in', 'error'); return; }

  const datasets = getDatasetsForProject(project.id);
  const dataset  = datasets.find(d => d.id === id);
  if (!dataset) return;

  const nameChanged = newName !== dataset.name;
  const descChanged = newDesc !== (dataset.description ?? '');

  if (!nameChanged && !descChanged) { editingId = null; rerender(); return; }

  if (!nameChanged) {
    dataset.description = newDesc;
    saveDatasets(project.id, datasets);
    toast('Dataset updated', 'success');
    editingId = null;
    rerender();
    return;
  }

  // Local duplicate check (excluding self)
  if (datasets.some(d => d.id !== id && d.name.toLowerCase() === newName.toLowerCase())) {
    toast(`A dataset named "${newName}" already exists in this project`, 'error');
    return;
  }

  const saveBtn = document.getElementById(`dm-save-btn-${id}`);
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

  try {
    const datasetsFolder = await getProjectDatasetsFolder(token);
    if (datasetsFolder) {
      const conflict = await findFolder(token, newName, datasetsFolder.id);
      if (conflict && conflict.id !== dataset.driveFolderId) {
        toast(`A folder named "${newName}" already exists in datasets/`, 'error');
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
        return;
      }
    }

    await renameFile(token, dataset.driveFolderId, newName);

    dataset.name        = newName;
    dataset.description = newDesc;
    saveDatasets(project.id, datasets);

    // Update active dataset in localStorage if it was this one
    const active = getCurrentDataset();
    if (active?.id === id) {
      setCurrentDataset({ ...active, name: newName });
      _callbacks.onDatasetChange?.();
    }

    toast(`Dataset renamed to "${newName}"`, 'success');
    editingId = null;
    rerender();

  } catch (err) {
    toast(`Rename failed: ${err.message}`, 'error');
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
  }
}

// ── Delete ─────────────────────────────────────────────────────────────────────

async function deleteDataset(id, project) {
  const token    = getToken();
  const datasets = getDatasetsForProject(project.id);
  const dataset  = datasets.find(d => d.id === id);
  if (!dataset) return;

  const btn = document.getElementById(`dm-confirm-delete-btn-${id}`);
  if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }

  try {
    await deleteFile(token, dataset.driveFolderId);
  } catch { /* folder may already be gone */ }

  saveDatasets(project.id, datasets.filter(d => d.id !== id));

  const wasActive = getCurrentDataset()?.id === id;
  if (wasActive) {
    setCurrentDataset(null);
    _callbacks.onDatasetChange?.();
  }

  toast(`Dataset "${dataset.name}" deleted`, 'success');
  confirmingId = null;
  rerender();
}

// ── Card HTML ──────────────────────────────────────────────────────────────────

function datasetCardHtml(d, activeId) {
  const isActive = d.id === activeId;

  if (editingId === d.id) {
    return `
      <div class="pm-card pm-card-editing">
        <div style="flex:1;">
          <label style="font-size:12px;color:var(--text-dim);display:block;margin-bottom:0.3rem;">Dataset name</label>
          <input id="dm-edit-input-${d.id}" class="pm-edit-input" type="text" value="${escHtml(d.name)}" style="margin-bottom:0.5rem;" />
          <label style="font-size:12px;color:var(--text-dim);display:block;margin-bottom:0.3rem;">Description</label>
          <textarea id="dm-edit-desc-${d.id}" rows="2"
            style="width:100%;padding:0.4rem 0.6rem;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-family:var(--font);font-size:13px;resize:vertical;"
            >${escHtml(d.description ?? '')}</textarea>
        </div>
        <div class="pm-card-actions">
          <button class="btn btn-primary btn-sm" id="dm-save-btn-${d.id}" data-ds-save="${d.id}">Save</button>
          <button class="btn btn-ghost btn-sm" data-ds-cancel-edit="${d.id}">Cancel</button>
        </div>
      </div>`;
  }

  if (confirmingId === d.id) {
    return `
      <div class="pm-card pm-card-danger">
        <div class="pm-card-info">
          <div class="pm-card-name">Delete "${escHtml(d.name)}"?</div>
          <div class="pm-confirm-text">
            This will permanently delete <strong>datasets/${escHtml(d.name)}</strong>
            and all its contents from Google Drive. This cannot be undone.
          </div>
        </div>
        <div class="pm-card-actions">
          <button class="btn btn-danger btn-sm" id="dm-confirm-delete-btn-${d.id}" data-ds-confirm-delete="${d.id}">Confirm Delete</button>
          <button class="btn btn-ghost btn-sm" data-ds-cancel-confirm="${d.id}">Cancel</button>
        </div>
      </div>`;
  }

  return `
    <div class="pm-card ${isActive ? 'pm-card-active' : ''}">
      <div class="pm-card-info">
        <div class="pm-card-name">
          ${escHtml(d.name)}
          ${isActive ? '<span class="pm-badge-active">Active</span>' : ''}
        </div>
        ${d.description ? `<div class="pm-card-desc">${escHtml(d.description)}</div>` : ''}
        <div class="pm-card-meta">Drive: datasets/${escHtml(d.name)}</div>
        <div class="pm-card-meta">Created: ${new Date(d.createdAt).toLocaleDateString()}</div>
      </div>
      <div class="pm-card-actions">
        <button class="btn btn-primary btn-sm" data-ds-open="${d.id}">Open</button>
        <button class="btn btn-ghost btn-sm" data-ds-edit="${d.id}">Edit</button>
        <button class="btn btn-ghost btn-sm" data-ds-delete="${d.id}" disabled>Delete</button>
      </div>
    </div>`;
}

// ── Card wiring ────────────────────────────────────────────────────────────────

function wireCards(project) {
  _container.querySelectorAll('[data-ds-open]').forEach(btn => {
    btn.addEventListener('click', () => {
      const dataset = getDatasetsForProject(project.id).find(d => d.id === btn.dataset.dsOpen);
      if (dataset) openDataset(dataset);
    });
  });

  _container.querySelectorAll('[data-ds-edit]').forEach(btn => {
    btn.addEventListener('click', () => {
      editingId    = btn.dataset.dsEdit;
      confirmingId = null;
      rerender();
      document.getElementById(`dm-edit-input-${editingId}`)?.focus();
    });
  });

  _container.querySelectorAll('[data-ds-save]').forEach(btn => {
    btn.addEventListener('click', () => saveEdit(btn.dataset.dsSave, project));
  });

  _container.querySelectorAll('[data-ds-cancel-edit]').forEach(btn => {
    btn.addEventListener('click', () => { editingId = null; rerender(); });
  });

  _container.querySelectorAll('[data-ds-delete]').forEach(btn => {
    btn.addEventListener('click', () => {
      confirmingId = btn.dataset.dsDelete;
      editingId    = null;
      rerender();
    });
  });

  _container.querySelectorAll('[data-ds-confirm-delete]').forEach(btn => {
    btn.addEventListener('click', () => deleteDataset(btn.dataset.dsConfirmDelete, project));
  });

  _container.querySelectorAll('[data-ds-cancel-confirm]').forEach(btn => {
    btn.addEventListener('click', () => { confirmingId = null; rerender(); });
  });

  _container.querySelectorAll('.pm-edit-input').forEach(input => {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  saveEdit(editingId, project);
      if (e.key === 'Escape') { editingId = null; rerender(); }
    });
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function openDataset(dataset) {
  setCurrentDataset(dataset);
  _callbacks.onDatasetOpen?.(dataset);
  rerender();
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
