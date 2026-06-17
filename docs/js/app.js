import { initAuth, signIn, signOut } from './auth.js';
import { MASTER_USERS } from './config.js';
import { renderUploader }   from './label-uploader.js';
import { renderDownloader } from './dataset-downloader.js';
import { renderReviewer }   from './annotation-reviewer.js';
import { renderRefactor }   from './label-refactor.js';
import { renderTrainer }    from './model-trainer.js';
import { renderTester }     from './model-tester.js';
import { renderProcessData } from './process-data.js';
import {
  renderProjectManager,
  getCurrentProject,
  setCurrentProject,
  getProjects,
  syncFromDrive,
} from './project-manager.js';
import {
  renderDatasetManager,
  refreshDatasetManager,
  getCurrentDataset,
} from './dataset-manager.js';

let isMasterUser = false;

window.addEventListener('drive-synced', () => {
  updateProjectSwitcher();
  updateSyncTimestamp();
});

function updateSyncTimestamp() {
  const el  = document.getElementById('sync-timestamp');
  if (!el) return;
  const iso = localStorage.getItem('pavement_tool_last_sync');
  if (!iso) { el.textContent = ''; return; }
  const d   = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const date = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  const isToday = d.toDateString() === new Date().toDateString();
  el.textContent = `Synced ${isToday ? time : date + ' ' + time}`;
}

await waitForGoogleAPIs();

initAuth(onSignedIn);

document.getElementById('sign-in-btn').addEventListener('click', signIn);
document.getElementById('auth-wall-btn').addEventListener('click', signIn);
document.getElementById('sign-out-btn').addEventListener('click', () => {
  signOut();
  showAuthWall();
});

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

document.querySelectorAll('.subtab-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchSubTab(btn.dataset.subtab));
});

// Project switcher — header select
document.getElementById('project-select').addEventListener('change', (e) => {
  if (e.target.value === '__manage__') {
    e.target.value = getCurrentProject()?.id ?? '';
    switchTab('projects');
    return;
  }
  const project = getProjects().find(p => p.id === e.target.value);
  if (project) {
    setCurrentProject(project);
    localStorage.removeItem('pavement_tool_active_dataset');
    updateProjectSwitcher();
    hideToolSubtabs();
    updateDatasetIndicator();
    refreshDatasetManager();
    document.getElementById('train-model-tab-btn')?.classList.remove('hidden');
    document.getElementById('testing-tab-btn')?.classList.remove('hidden');
    document.getElementById('process-data-tab-btn')?.classList.remove('hidden');
    switchTab('projects');
  }
});

renderProjectManager(document.getElementById('tab-projects'), {
  onProjectOpen(project) {
    document.getElementById('datasets-tab-btn').classList.remove('hidden');
    document.getElementById('train-model-tab-btn')?.classList.remove('hidden');
    document.getElementById('testing-tab-btn')?.classList.remove('hidden');
    document.getElementById('process-data-tab-btn')?.classList.remove('hidden');
    updateProjectSwitcher();
    hideToolSubtabs();
    updateDatasetIndicator();
    refreshDatasetManager();
    switchSubTab('datasets-mgr');
    switchTab('datasets');
  },
  onProjectChange() {
    const stillActive = getCurrentProject();
    if (!stillActive) {
      document.getElementById('datasets-tab-btn').classList.add('hidden');
      document.getElementById('train-model-tab-btn')?.classList.add('hidden');
      document.getElementById('testing-tab-btn')?.classList.add('hidden');
      document.getElementById('process-data-tab-btn')?.classList.add('hidden');
      switchTab('projects');
    }
    hideToolSubtabs();
    updateDatasetIndicator();
    updateProjectSwitcher();
  },
});

renderDatasetManager(document.getElementById('tab-datasets-mgr'), {
  onDatasetOpen(dataset) {
    showToolSubtabs();
    updateDatasetIndicator();
    switchSubTab('uploader');
  },
  onDatasetChange() {
    hideToolSubtabs();
    updateDatasetIndicator();
    switchSubTab('datasets-mgr');
  },
});

renderUploader(document.getElementById('tab-uploader'));
renderDownloader(document.getElementById('tab-downloader'));
renderReviewer(document.getElementById('tab-reviewer'));
renderRefactor(document.getElementById('tab-refactor'));
renderTrainer(document.getElementById('tab-train-model'));
renderTester(document.getElementById('tab-testing'));
renderProcessData(document.getElementById('tab-process-data'));

// ── Auth ───────────────────────────────────────────────────────────────────────

function onSignedIn(user) {
  document.getElementById('user-email').textContent = user.email;
  document.getElementById('user-avatar').src         = user.picture || '';
  document.getElementById('user-badge').classList.remove('hidden');
  document.getElementById('sign-in-btn').classList.add('hidden');
  document.getElementById('auth-wall').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');

  isMasterUser = MASTER_USERS.includes(user.email.toLowerCase());
  const isMaster = isMasterUser;

  // Restore project
  const savedProject = getCurrentProject();
  if (savedProject) {
    document.getElementById('datasets-tab-btn').classList.remove('hidden');
    document.getElementById('train-model-tab-btn')?.classList.remove('hidden');
    document.getElementById('testing-tab-btn')?.classList.remove('hidden');
    document.getElementById('process-data-tab-btn')?.classList.remove('hidden');
    // Restore dataset if one was active
    const savedDataset = getCurrentDataset();
    if (savedDataset) {
      showToolSubtabs();
    }
  }

  if (isMaster) {
    document.getElementById('reviewer-tab-btn')?.classList.remove('hidden');
    document.getElementById('refactor-tab-btn')?.classList.remove('hidden');
  }

  document.getElementById('sync-timestamp').classList.remove('hidden');

  updateProjectSwitcher();
  updateDatasetIndicator();
  updateSyncTimestamp();
  syncFromDrive();
}

function showAuthWall() {
  document.getElementById('user-badge').classList.add('hidden');
  document.getElementById('sign-in-btn').classList.remove('hidden');
  document.getElementById('auth-wall').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
}

// ── Tool subtab visibility ─────────────────────────────────────────────────────

function showToolSubtabs() {
  document.getElementById('uploader-subtab-btn')?.classList.remove('hidden');
  document.getElementById('downloader-subtab-btn')?.classList.remove('hidden');
  if (isMasterUser) {
    document.getElementById('reviewer-tab-btn')?.classList.remove('hidden');
    document.getElementById('refactor-tab-btn')?.classList.remove('hidden');
  }
}

function hideToolSubtabs() {
  ['uploader-subtab-btn', 'downloader-subtab-btn',
   'reviewer-tab-btn', 'refactor-tab-btn'].forEach(id => {
    document.getElementById(id)?.classList.add('hidden');
  });
}

// ── Dataset indicator ──────────────────────────────────────────────────────────

function updateDatasetIndicator() {
  const el      = document.getElementById('dataset-indicator');
  const dataset = getCurrentDataset();
  if (!el) return;
  if (dataset) {
    el.innerHTML = `Active dataset: <strong>${dataset.name}</strong>
      <button class="btn btn-ghost btn-sm" style="margin-left:0.5rem;font-size:11px;" id="ds-switch-btn">Switch</button>`;
    el.classList.remove('hidden');
    document.getElementById('ds-switch-btn')?.addEventListener('click', () => {
      switchSubTab('datasets-mgr');
    });
  } else {
    el.classList.add('hidden');
  }
}

// ── Navigation ─────────────────────────────────────────────────────────────────

function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.toggle('hidden', panel.id !== `tab-${tabName}`);
    panel.classList.toggle('active', panel.id === `tab-${tabName}`);
  });
}

function switchSubTab(tabName) {
  document.querySelectorAll('.subtab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.subtab === tabName);
  });
  document.querySelectorAll('.subtab-panel').forEach((panel) => {
    panel.classList.toggle('hidden', panel.id !== `tab-${tabName}`);
  });
}

function updateProjectSwitcher() {
  const projects = getProjects();
  const current  = getCurrentProject();
  const switcher = document.getElementById('project-switcher');
  const select   = document.getElementById('project-select');

  if (projects.length === 0) {
    switcher.classList.add('hidden');
    return;
  }

  switcher.classList.remove('hidden');
  select.innerHTML =
    projects.map(p =>
      `<option value="${p.id}" ${p.id === current?.id ? 'selected' : ''}>${p.name}</option>`
    ).join('') +
    '<option value="__manage__">— Manage Projects —</option>';
}

// ── Google API loader ──────────────────────────────────────────────────────────

function waitForGoogleAPIs() {
  return new Promise((resolve) => {
    let gapiReady = false;
    let gisReady  = false;
    const check = () => { if (gapiReady && gisReady) resolve(); };

    globalThis.gapiLoaded = () => { gapiReady = true; check(); };
    globalThis.gisLoaded  = () => { gisReady  = true; check(); };

    const poll = setInterval(() => {
      if (typeof gapi !== 'undefined' && typeof google !== 'undefined') {
        gapiReady = true; gisReady = true;
        clearInterval(poll);
        check();
      }
    }, 100);
  });
}
