import { getToken, getUser, refreshToken } from './auth.js';
import { ensureFolderPath, appendTracking } from './drive.js';
import { toast } from './utils.js';

let worker = null;
let cancelled = false;
let pendingFrames = 0;
let doneFrames = 0;
let errorFrames = 0;

export function renderExtractor(container) {
  container.innerHTML = `
    <div style="max-width:700px;">
      <p class="section-title">1. Select Video File</p>
      <div class="file-pick-area" id="ex-drop">
        <input type="file" id="ex-file-input" accept="video/mp4,video/*" />
        <div class="pick-icon">🎬</div>
        <div class="pick-label">Click to select an MP4, or drag and drop here</div>
        <div class="pick-sub" id="ex-file-name">No file selected</div>
      </div>

      <p class="section-title">2. Configure Extraction</p>
      <div class="form-group">
        <label>Drive folder name (auto-filled from video filename)</label>
        <input type="text" id="ex-folder-name" placeholder="e.g. road_survey_01"
          style="width:100%;padding:0.4rem 0.6rem;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-family:var(--font);" />
      </div>

      <div class="flex-row mt-2">
        <button class="btn btn-primary" id="ex-start-btn" disabled>Extract &amp; Upload</button>
        <button class="btn btn-ghost hidden" id="ex-cancel-btn">Cancel</button>
      </div>

      <div id="ex-progress-wrap" class="progress-wrap hidden">
        <div class="progress-label">
          <span id="ex-progress-text">Starting…</span>
          <span id="ex-progress-pct">0%</span>
        </div>
        <div class="progress-bar"><div class="progress-fill" id="ex-progress-fill"></div></div>
      </div>

      <div class="thumb-strip" id="ex-thumb-strip"></div>
    </div>
  `;

  const fileInput   = document.getElementById('ex-file-input');
  const dropArea    = document.getElementById('ex-drop');
  const fileName    = document.getElementById('ex-file-name');
  const folderInput = document.getElementById('ex-folder-name');
  const startBtn  = document.getElementById('ex-start-btn');
  const cancelBtn = document.getElementById('ex-cancel-btn');

  let selectedFile = null;

  // File picker click
  dropArea.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) setFile(fileInput.files[0]);
  });

  // Drag-and-drop
  dropArea.addEventListener('dragover', (e) => { e.preventDefault(); dropArea.classList.add('drag-over'); });
  dropArea.addEventListener('dragleave', () => dropArea.classList.remove('drag-over'));
  dropArea.addEventListener('drop', (e) => {
    e.preventDefault();
    dropArea.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('video/')) setFile(file);
    else toast('Please drop a video file', 'error');
  });

  function setFile(file) {
    selectedFile = file;
    const baseName = file.name.replace(/\.mp4$/i, '');
    fileName.textContent = file.name;
    folderInput.value = baseName;
    startBtn.disabled = false;
  }

  startBtn.addEventListener('click', () => {
    if (!selectedFile) return;
    startExtraction(selectedFile, 1);
  });

  cancelBtn.addEventListener('click', () => {
    cancelled = true;
    cancelBtn.classList.add('hidden');
    toast('Cancelling after current frame…', 'info');
  });
}

async function startExtraction(file, frameSkip) {
  const token = getToken();
  const user  = getUser();
  if (!token || !user) { toast('Not signed in', 'error'); return; }

  const videoName = file.name.replace(/\.mp4$/i, '');
  const folderNameInput = document.getElementById('ex-folder-name');
  const displayName = folderNameInput.value.trim() || videoName;

  const startBtn  = document.getElementById('ex-start-btn');
  const cancelBtn = document.getElementById('ex-cancel-btn');
  const progWrap  = document.getElementById('ex-progress-wrap');
  const thumbStrip = document.getElementById('ex-thumb-strip');

  startBtn.disabled = true;
  cancelBtn.classList.remove('hidden');
  progWrap.classList.remove('hidden');
  thumbStrip.innerHTML = '';
  cancelled = false;
  pendingFrames = 0;
  doneFrames = 0;
  errorFrames = 0;

  toast('Setting up Drive folders…', 'info');

  let folders;
  try {
    folders = await ensureFolderPath(token, displayName);
  } catch (err) {
    toast(`Drive error: ${err.message}`, 'error');
    resetUI();
    return;
  }

  // Spin up worker
  if (worker) worker.terminate();
  worker = new Worker('js/worker/extractor-worker.js');
  worker.postMessage({ type: 'INIT', token, folderId: folders.framesId });

  worker.onmessage = (e) => {
    if (e.data.type === 'FRAME_DONE') {
      doneFrames++;
      updateProgress();
    } else if (e.data.type === 'FRAME_ERROR') {
      errorFrames++;
      console.warn('Frame upload error:', e.data.message);
      updateProgress();
    } else if (e.data.type === 'NEED_TOKEN') {
      // Token expired during upload — refresh and send back
      refreshToken().then(newToken => {
        worker.postMessage({ type: 'UPDATE_TOKEN', token: newToken });
      });
    }
  };

  toast(`Extracting frames from "${file.name}"…`, 'info');

  const video = document.createElement('video');
  video.src = URL.createObjectURL(file);
  video.preload = 'auto';
  await new Promise((res) => video.addEventListener('loadedmetadata', res, { once: true }));

  const canvas = document.createElement('canvas');
  canvas.width  = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');

  // Count total frames by stepping through (approximate via duration × fps)
  // We track via frameIndex so the total is just what we attempt
  let frameIndex = 0;
  let uploadedCount = 0;

  setProgress(0, '–', 'Extracting frames…');

  // Seek-based frame loop (one frame at a time, every `frameSkip` frames)
  // We use video.currentTime stepping since we don't have direct frame count access in browsers
  const duration = video.duration;

  // Estimate FPS by reading a few frames (or default to 30)
  let fps = 30;
  try {
    // Some browsers expose this via the video element; otherwise stick with 30
    if (video.getVideoPlaybackQuality) {
      fps = 30; // safe fallback
    }
  } catch {}

  const frameDuration = 1 / fps; // seconds per frame
  const totalEstimated = Math.floor(duration * fps / frameSkip);

  for (let i = 0; ; i++) {
    if (cancelled) break;

    const t = i * frameSkip * frameDuration;
    if (t >= duration) break;

    video.currentTime = t;
    await new Promise((res) => video.addEventListener('seeked', res, { once: true }));

    if (cancelled) break;

    ctx.drawImage(video, 0, 0);

    // Render thumbnail preview (every 10th frame to keep UI snappy)
    if (frameIndex % 10 === 0) addThumb(canvas);

    const frameNum = String(frameIndex).padStart(4, '0');
    const filename = `${videoName}_frame${frameNum}.jpg`;

    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.92));
    const arrayBuffer = await blob.arrayBuffer();

    pendingFrames++;
    worker.postMessage({ type: 'UPLOAD_FRAME', frameIndex, arrayBuffer, filename }, [arrayBuffer]);
    uploadedCount++;
    frameIndex++;

    setProgress(
      Math.min(frameIndex / Math.max(totalEstimated, 1), 0.99),
      `Frame ${frameIndex}`,
      `Extracting & uploading…`
    );

    // Yield to keep UI responsive
    await new Promise((res) => setTimeout(res, 0));
  }

  URL.revokeObjectURL(video.src);

  // Wait for all worker uploads to finish
  await waitForWorkerDone();

  setProgress(1, `${uploadedCount} frames`, 'Done');
  toast(`Done! ${uploadedCount} frames uploaded to Drive.${errorFrames ? ` (${errorFrames} errors)` : ''}`, errorFrames ? 'error' : 'success');

  // Write tracking entry
  try {
    const currentToken = getToken();
    await appendTracking(currentToken, folders.rootId, {
      user: user.email,
      action: 'frame_extraction',
      video_name: file.name,
      display_name: displayName,
      file_count: uploadedCount,
      frame_skip: frameSkip,
      frames_folder_id: folders.framesId,
    });
  } catch (err) {
    console.warn('Failed to write tracking entry:', err);
  }

  resetUI();
}

function waitForWorkerDone() {
  return new Promise((resolve) => {
    const check = () => {
      if (doneFrames + errorFrames >= pendingFrames) resolve();
      else setTimeout(check, 200);
    };
    check();
  });
}

function addThumb(canvas) {
  const strip = document.getElementById('ex-thumb-strip');
  if (!strip) return;
  const img = document.createElement('img');
  img.src = canvas.toDataURL('image/jpeg', 0.5);
  strip.appendChild(img);
}

function setProgress(fraction, label, statusText) {
  const fill = document.getElementById('ex-progress-fill');
  const pct  = document.getElementById('ex-progress-pct');
  const text = document.getElementById('ex-progress-text');
  if (!fill) return;
  fill.style.width = `${Math.round(fraction * 100)}%`;
  pct.textContent  = `${Math.round(fraction * 100)}%`;
  text.textContent = `${statusText} — ${label}`;
}

function updateProgress() {
  const finished = doneFrames + errorFrames;
  setProgress(
    pendingFrames > 0 ? finished / pendingFrames : 0,
    `${finished} / ${pendingFrames}`,
    'Uploading…'
  );
}

function resetUI() {
  const startBtn  = document.getElementById('ex-start-btn');
  const cancelBtn = document.getElementById('ex-cancel-btn');
  if (startBtn)  startBtn.disabled = false;
  if (cancelBtn) cancelBtn.classList.add('hidden');
}
