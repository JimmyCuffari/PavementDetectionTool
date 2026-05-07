import { initAuth, signIn, signOut } from './auth.js';
import { renderExtractor }  from './frame-extractor.js';
import { renderUploader }   from './label-uploader.js';
import { renderDownloader } from './dataset-downloader.js';
import { renderReviewer }   from './annotation-reviewer.js';

// Wait for both GIS and GAPI to load before initializing
function waitForGoogleAPIs() {
  return new Promise((resolve) => {
    let gapiReady = false;
    let gisReady  = false;
    const check = () => { if (gapiReady && gisReady) resolve(); };

    // GAPI fires onload callback
    window.gapiLoaded = () => { gapiReady = true; check(); };
    // GIS fires onload callback
    window.gisLoaded  = () => { gisReady  = true; check(); };

    // Poll as fallback in case callbacks already fired before this runs
    const poll = setInterval(() => {
      if (typeof gapi !== 'undefined' && typeof google !== 'undefined') {
        gapiReady = true;
        gisReady  = true;
        clearInterval(poll);
        check();
      }
    }, 100);
  });
}

async function main() {
  await waitForGoogleAPIs();

  initAuth(onSignedIn);

  // Sign-in buttons (header + auth wall)
  document.getElementById('sign-in-btn').addEventListener('click', signIn);
  document.getElementById('auth-wall-btn').addEventListener('click', signIn);
  document.getElementById('sign-out-btn').addEventListener('click', () => {
    signOut();
    showAuthWall();
  });

  // Tab switching
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Render view contents immediately (they are hidden until signed in)
  renderExtractor(document.getElementById('tab-extractor'));
  renderUploader(document.getElementById('tab-uploader'));
  renderDownloader(document.getElementById('tab-downloader'));
  renderReviewer(document.getElementById('tab-reviewer'));
}

function onSignedIn(user) {
  // Show user badge
  document.getElementById('user-email').textContent  = user.email;
  document.getElementById('user-avatar').src          = user.picture || '';
  document.getElementById('user-badge').classList.remove('hidden');
  document.getElementById('sign-in-btn').classList.add('hidden');

  // Hide auth wall, show app
  document.getElementById('auth-wall').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
}

function showAuthWall() {
  document.getElementById('user-badge').classList.add('hidden');
  document.getElementById('sign-in-btn').classList.remove('hidden');
  document.getElementById('auth-wall').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
}

function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.toggle('hidden', panel.id !== `tab-${tabName}`);
    panel.classList.toggle('active', panel.id === `tab-${tabName}`);
  });
}

main();
