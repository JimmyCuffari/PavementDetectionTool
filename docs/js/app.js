import { initAuth, signIn, signOut } from './auth.js';
import { MASTER_USERS } from './config.js';
import { renderUploader }   from './label-uploader.js';
import { renderDownloader } from './dataset-downloader.js';
import { renderReviewer }   from './annotation-reviewer.js';
import { renderRefactor }   from './label-refactor.js';

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

renderUploader(document.getElementById('tab-uploader'));
renderDownloader(document.getElementById('tab-downloader'));
renderReviewer(document.getElementById('tab-reviewer'));
renderRefactor(document.getElementById('tab-refactor'));

// ── Auth ───────────────────────────────────────────────────────────────────────

function onSignedIn(user) {
  document.getElementById('user-email').textContent = user.email;
  document.getElementById('user-avatar').src         = user.picture || '';
  document.getElementById('user-badge').classList.remove('hidden');
  document.getElementById('sign-in-btn').classList.add('hidden');
  document.getElementById('auth-wall').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');

  if (MASTER_USERS.includes(user.email.toLowerCase())) {
    document.getElementById('reviewer-tab-btn').classList.remove('hidden');
    document.getElementById('refactor-tab-btn').classList.remove('hidden');
  }
}

function showAuthWall() {
  document.getElementById('user-badge').classList.add('hidden');
  document.getElementById('sign-in-btn').classList.remove('hidden');
  document.getElementById('auth-wall').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
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
