import { getToken } from './auth.js';
import { findOrCreateFolder, findFolder, deleteFile, renameFile, listAllFiles } from './drive.js';
import { toast } from './utils.js';

const DS_ACTIVE_KEY = 'pavement_tool_active_dataset';

const PROJECTS_KEY = 'pavement_tool_projects';
const ACTIVE_KEY   = 'pavement_tool_active_project';
const ROOT_FOLDER  = 'ModelTool';

// ── Persistent state ───────────────────────────────────────────────────────────

export function getProjects() {
  try { return JSON.parse(localStorage.getItem(PROJECTS_KEY) ?? '[]'); } catch { return []; }
}

function saveProjects(projects) {
  localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
}

export function getCurrentProject() {
  const id = localStorage.getItem(ACTIVE_KEY);
  if (!id) return null;
  return getProjects().find(p => p.id === id) ?? null;
}

export function setCurrentProject(project) {
  if (project) localStorage.setItem(ACTIVE_KEY, project.id);
  else         localStorage.removeItem(ACTIVE_KEY);
}

export function getCurrentProjectFolderId() {
  return getCurrentProject()?.driveFolderId ?? null;
}

// Returns the datasets/ subfolder for the current project, creating it if needed.
export async function getProjectDatasetsFolder(token) {
  const project = getCurrentProject();
  if (!project) return null;
  return findOrCreateFolder(token, 'datasets', project.driveFolderId);
}

// Returns the models/ subfolder for the current project, creating it if needed.
export async function getProjectModelsFolder(token) {
  const project = getCurrentProject();
  if (!project) return null;
  return findOrCreateFolder(token, 'models', project.driveFolderId);
}


// ── UI state ───────────────────────────────────────────────────────────────────

let _callbacks    = {};
let _container    = null;
let editingId     = null;  // card in edit mode
let confirmingId  = null;  // card in delete-confirm mode

export function renderProjectManager(container, callbacks) {
  _callbacks  = callbacks;
  _container  = container;
  rerender();
}

function rerender() {
  const projects = getProjects();
  const current  = getCurrentProject();

  _container.innerHTML = `
    <div style="max-width:640px;">
      <div class="flex-row" style="justify-content:space-between;align-items:center;margin-bottom:1.25rem;">
        <p class="section-title" style="margin:0;">Projects</p>
        <button class="btn btn-primary btn-sm" id="pm-new-btn">+ New Project</button>
      </div>

      <div id="pm-form" class="pm-form hidden">
        <p class="section-title" style="margin-bottom:0.5rem;">New Project</p>

        <div class="folder-input-row" style="margin-bottom:0.6rem;">
          <label style="white-space:nowrap;min-width:120px;">Project name:</label>
          <input type="text" id="pm-name-input" placeholder="e.g. Main Street Survey" />
        </div>
        <div class="folder-input-row" style="margin-bottom:0.6rem;align-items:flex-start;">
          <label style="white-space:nowrap;min-width:120px;padding-top:0.3rem;">Description:</label>
          <textarea id="pm-desc-input" placeholder="Optional description" rows="2"
            style="flex:1;padding:0.4rem 0.6rem;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-family:var(--font);font-size:13px;resize:vertical;"></textarea>
        </div>

        <div class="pm-radio-row" style="margin-bottom:0.6rem;">
          <label style="white-space:nowrap;min-width:120px;">Folder:</label>
          <div class="flex-row" style="gap:1rem;">
            <label class="pm-radio-label">
              <input type="radio" name="pm-folder-mode" value="new" checked /> Create new
            </label>
            <label class="pm-radio-label">
              <input type="radio" name="pm-folder-mode" value="existing" /> Link to existing
            </label>
          </div>
        </div>

        <div id="pm-existing-row" class="folder-input-row hidden" style="margin-bottom:0.6rem;">
          <label style="white-space:nowrap;min-width:120px;">ModelTool folder:</label>
          <select id="pm-folder-select"
            style="flex:1;padding:0.4rem 0.6rem;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-family:var(--font);font-size:13px;">
            <option value="">— loading… —</option>
          </select>
          <button class="btn btn-ghost btn-sm" id="pm-refresh-folders" title="Reload">↻</button>
        </div>

        <p class="text-dim" id="pm-form-hint" style="font-size:12px;margin-bottom:0.75rem;">
          A folder named after this project will be created inside <strong style="color:var(--text);">ModelTool</strong>.
        </p>

        <div class="flex-row" style="gap:0.5rem;">
          <button class="btn btn-primary btn-sm" id="pm-create-btn">Create Project</button>
          <button class="btn btn-ghost btn-sm" id="pm-cancel-btn">Cancel</button>
        </div>
      </div>

      <div id="pm-project-list">
        ${projects.length === 0
          ? `<p class="text-dim" style="font-size:13px;margin-top:0.5rem;">No projects yet. Create one to get started.</p>`
          : projects.map(p => projectCardHtml(p, current?.id)).join('')}
      </div>
    </div>
  `;

  wireForm();
  wireCards();
}

// ── Form wiring ────────────────────────────────────────────────────────────────

function wireForm() {
  document.getElementById('pm-new-btn').addEventListener('click', () => {
    const form = document.getElementById('pm-form');
    form.classList.toggle('hidden');
    if (!form.classList.contains('hidden')) resetForm();
  });

  document.getElementById('pm-cancel-btn').addEventListener('click', () => {
    document.getElementById('pm-form').classList.add('hidden');
  });

  document.getElementById('pm-create-btn').addEventListener('click', createProject);
  document.getElementById('pm-name-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') createProject();
  });

  document.getElementById('pm-refresh-folders').addEventListener('click', loadModelToolFolders);

  _container.querySelectorAll('input[name="pm-folder-mode"]').forEach(radio => {
    radio.addEventListener('change', onFolderModeChange);
  });
}

function resetForm() {
  document.getElementById('pm-name-input').value  = '';
  document.getElementById('pm-desc-input').value  = '';
  document.querySelector('input[name="pm-folder-mode"][value="new"]').checked = true;
  document.getElementById('pm-existing-row').classList.add('hidden');
  updateFormHint('new');
}

function onFolderModeChange(e) {
  const isExisting = e.target.value === 'existing';
  document.getElementById('pm-existing-row').classList.toggle('hidden', !isExisting);
  updateFormHint(e.target.value);
  if (isExisting) loadModelToolFolders();
}

function updateFormHint(mode) {
  const hint = document.getElementById('pm-form-hint');
  if (!hint) return;
  hint.innerHTML = mode === 'new'
    ? `A folder named after this project will be created inside <strong style="color:var(--text);">ModelTool</strong>.`
    : `The project will be linked to the selected folder inside <strong style="color:var(--text);">ModelTool</strong>.`;
}

async function loadModelToolFolders() {
  const select = document.getElementById('pm-folder-select');
  if (!select) return;
  select.innerHTML = '<option value="">— loading… —</option>';
  const token = getToken();
  if (!token) { select.innerHTML = '<option value="">— sign in first —</option>'; return; }
  try {
    const modelTool = await findFolder(token, ROOT_FOLDER, 'root');
    if (!modelTool) {
      select.innerHTML = `<option value="">— ModelTool folder not found in Drive —</option>`;
      return;
    }
    const folders = await listAllFiles(
      token,
      `'${modelTool.id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      'id,name'
    );
    folders.sort((a, b) => a.name.localeCompare(b.name));
    select.innerHTML = '<option value="">— select a folder —</option>' +
      folders.map(f => `<option value="${f.id}" data-name="${f.name}">${f.name}</option>`).join('');
  } catch {
    select.innerHTML = '<option value="">— could not load folders —</option>';
  }
}

// ── Create project ─────────────────────────────────────────────────────────────

async function createProject() {
  const name  = document.getElementById('pm-name-input')?.value.trim();
  const desc  = document.getElementById('pm-desc-input')?.value.trim();
  const mode  = document.querySelector('input[name="pm-folder-mode"]:checked')?.value ?? 'new';
  const token = getToken();

  if (!name)  { toast('Enter a project name', 'error'); return; }
  if (!token) { toast('Not signed in', 'error'); return; }

  const nameTaken = getProjects().some(p => p.name.toLowerCase() === name.toLowerCase());
  if (nameTaken) { toast(`A project named "${name}" already exists`, 'error'); return; }

  const btn = document.getElementById('pm-create-btn');
  btn.disabled    = true;
  btn.textContent = 'Creating…';

  try {
    let driveFolderId, driveFolderName;

    // Ensure ModelTool exists (always needed)
    const modelTool = await findOrCreateFolder(token, ROOT_FOLDER, 'root');

    if (mode === 'new') {
      // Block if folder already exists
      const existing = await findFolder(token, name, modelTool.id);
      if (existing) {
        toast(`A folder named "${name}" already exists in ModelTool`, 'error');
        btn.disabled    = false;
        btn.textContent = 'Create Project';
        return;
      }
      const newFolder  = await findOrCreateFolder(token, name, modelTool.id);
      driveFolderId    = newFolder.id;
      driveFolderName  = name;
    } else {
      const select = document.getElementById('pm-folder-select');
      driveFolderId   = select?.value;
      const opt       = select?.options[select.selectedIndex];
      driveFolderName = opt?.dataset.name ?? opt?.text ?? '';
      if (!driveFolderId) {
        toast('Select a folder to link', 'error');
        btn.disabled    = false;
        btn.textContent = 'Create Project';
        return;
      }
    }

    // Ensure datasets/ and models/ subfolders exist at project root
    await Promise.all([
      findOrCreateFolder(token, 'datasets', driveFolderId),
      findOrCreateFolder(token, 'models',   driveFolderId),
    ]);

    const project = {
      id:              crypto.randomUUID(),
      name,
      description:     desc || '',
      driveFolderId,
      driveFolderName,
      createdAt:       new Date().toISOString(),
    };
    const projects = getProjects();
    projects.push(project);
    saveProjects(projects);

    toast(`Project "${name}" created`, 'success');
    document.getElementById('pm-form').classList.add('hidden');
    openProject(project);

  } catch (err) {
    toast(`Failed to create project: ${err.message}`, 'error');
    btn.disabled    = false;
    btn.textContent = 'Create Project';
  }
}

// ── Edit project ───────────────────────────────────────────────────────────────

async function saveEdit(id) {
  const input    = document.getElementById(`pm-edit-input-${id}`);
  const newName  = input?.value.trim();
  const newDesc  = document.getElementById(`pm-edit-desc-${id}`)?.value.trim() ?? '';
  if (!newName) { toast('Enter a project name', 'error'); return; }

  const token    = getToken();
  if (!token) { toast('Not signed in', 'error'); return; }

  const projects = getProjects();
  const project  = projects.find(p => p.id === id);
  if (!project) return;

  if (newName === project.name) { editingId = null; rerender(); return; }

  const saveBtn = document.getElementById(`pm-save-btn-${id}`);
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

  try {
    // Check for name conflict in ModelTool
    const modelTool = await findFolder(token, ROOT_FOLDER, 'root');
    if (modelTool) {
      const conflict = await findFolder(token, newName, modelTool.id);
      if (conflict && conflict.id !== project.driveFolderId) {
        toast(`A folder named "${newName}" already exists in ModelTool`, 'error');
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
        return;
      }
    }

    // Rename the Drive folder
    await renameFile(token, project.driveFolderId, newName);

    // Update localStorage
    project.name            = newName;
    project.driveFolderName = newName;
    project.description     = newDesc;
    saveProjects(projects);

    // Notify app if this was the active project (switcher needs refresh)
    if (localStorage.getItem(ACTIVE_KEY) === id) {
      _callbacks.onProjectChange?.();
    }

    toast(`Project renamed to "${newName}"`, 'success');
    editingId = null;
    rerender();

  } catch (err) {
    toast(`Rename failed: ${err.message}`, 'error');
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
  }
}

// ── Delete project ─────────────────────────────────────────────────────────────

async function deleteProject(id) {
  const token    = getToken();
  const projects = getProjects();
  const project  = projects.find(p => p.id === id);
  if (!project) return;

  const btn = document.getElementById(`pm-confirm-delete-btn-${id}`);
  if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }

  try {
    await deleteFile(token, project.driveFolderId);
  } catch {
    // Folder may already be gone — continue removing from localStorage
  }

  const updated = projects.filter(p => p.id !== id);
  saveProjects(updated);

  const wasActive = localStorage.getItem(ACTIVE_KEY) === id;
  if (wasActive) {
    localStorage.removeItem(ACTIVE_KEY);
    localStorage.removeItem(DS_ACTIVE_KEY);
    _callbacks.onProjectChange?.();
  }

  toast(`Project "${project.name}" deleted`, 'success');
  confirmingId = null;
  rerender();
}

// ── Card HTML ──────────────────────────────────────────────────────────────────

function projectCardHtml(p, activeId) {
  const isActive = p.id === activeId;

  if (editingId === p.id) {
    return `
      <div class="pm-card pm-card-editing">
        <div style="flex:1;">
          <label style="font-size:12px;color:var(--text-dim);display:block;margin-bottom:0.3rem;">Project name</label>
          <input id="pm-edit-input-${p.id}" class="pm-edit-input" type="text" value="${escHtml(p.name)}" style="margin-bottom:0.5rem;" />
          <label style="font-size:12px;color:var(--text-dim);display:block;margin-bottom:0.3rem;">Description</label>
          <textarea id="pm-edit-desc-${p.id}" rows="2"
            style="width:100%;padding:0.4rem 0.6rem;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-family:var(--font);font-size:13px;resize:vertical;"
            >${escHtml(p.description ?? '')}</textarea>
        </div>
        <div class="pm-card-actions">
          <button class="btn btn-primary btn-sm" id="pm-save-btn-${p.id}" data-save="${p.id}">Save</button>
          <button class="btn btn-ghost btn-sm" data-cancel-edit="${p.id}">Cancel</button>
        </div>
      </div>`;
  }

  if (confirmingId === p.id) {
    return `
      <div class="pm-card pm-card-danger">
        <div class="pm-card-info">
          <div class="pm-card-name">Delete "${escHtml(p.name)}"?</div>
          <div class="pm-confirm-text">
            This will permanently delete <strong>ModelTool/${escHtml(p.driveFolderName)}</strong>
            and all its contents from Google Drive. This cannot be undone.
          </div>
        </div>
        <div class="pm-card-actions">
          <button class="btn btn-danger btn-sm" id="pm-confirm-delete-btn-${p.id}" data-confirm-delete="${p.id}">Confirm Delete</button>
          <button class="btn btn-ghost btn-sm" data-cancel-confirm="${p.id}">Cancel</button>
        </div>
      </div>`;
  }

  return `
    <div class="pm-card ${isActive ? 'pm-card-active' : ''}">
      <div class="pm-card-info">
        <div class="pm-card-name">
          ${escHtml(p.name)}
          ${isActive ? '<span class="pm-badge-active">Active</span>' : ''}
        </div>
        ${p.description ? `<div class="pm-card-desc">${escHtml(p.description)}</div>` : ''}
        <div class="pm-card-meta">Drive: ModelTool / ${escHtml(p.driveFolderName)}</div>
        <div class="pm-card-meta">Created: ${new Date(p.createdAt).toLocaleDateString()}</div>
      </div>
      <div class="pm-card-actions">
        <button class="btn btn-primary btn-sm" data-open-project="${p.id}">Open</button>
        <button class="btn btn-ghost btn-sm" data-edit-project="${p.id}">Edit</button>
        <button class="btn btn-ghost btn-sm" data-delete-project="${p.id}" disabled>Delete</button>
      </div>
    </div>`;
}

// ── Card wiring ────────────────────────────────────────────────────────────────

function wireCards() {
  _container.querySelectorAll('[data-open-project]').forEach(btn => {
    btn.addEventListener('click', () => {
      const project = getProjects().find(p => p.id === btn.dataset.openProject);
      if (project) openProject(project);
    });
  });

  _container.querySelectorAll('[data-edit-project]').forEach(btn => {
    btn.addEventListener('click', () => {
      editingId    = btn.dataset.editProject;
      confirmingId = null;
      rerender();
      document.getElementById(`pm-edit-input-${editingId}`)?.focus();
    });
  });

  _container.querySelectorAll('[data-save]').forEach(btn => {
    btn.addEventListener('click', () => saveEdit(btn.dataset.save));
  });

  _container.querySelectorAll('[data-cancel-edit]').forEach(btn => {
    btn.addEventListener('click', () => { editingId = null; rerender(); });
  });

  _container.querySelectorAll('[data-delete-project]').forEach(btn => {
    btn.addEventListener('click', () => {
      confirmingId = btn.dataset.deleteProject;
      editingId    = null;
      rerender();
    });
  });

  _container.querySelectorAll('[data-confirm-delete]').forEach(btn => {
    btn.addEventListener('click', () => deleteProject(btn.dataset.confirmDelete));
  });

  _container.querySelectorAll('[data-cancel-confirm]').forEach(btn => {
    btn.addEventListener('click', () => { confirmingId = null; rerender(); });
  });

  // Save edit on Enter key
  _container.querySelectorAll('.pm-edit-input').forEach(input => {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  saveEdit(editingId);
      if (e.key === 'Escape') { editingId = null; rerender(); }
    });
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function openProject(project) {
  setCurrentProject(project);
  localStorage.removeItem(DS_ACTIVE_KEY);
  _callbacks.onProjectOpen?.(project);
  rerender();
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
