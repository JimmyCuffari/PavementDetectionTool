import { toast } from './utils.js';

let cancelled = false;

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

      <div class="flex-row mt-2">
        <button class="btn btn-primary" id="ex-start-btn" disabled>Extract &amp; Download</button>
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

  const fileInput = document.getElementById('ex-file-input');
  const dropArea  = document.getElementById('ex-drop');
  const fileName  = document.getElementById('ex-file-name');
  const startBtn  = document.getElementById('ex-start-btn');
  const cancelBtn = document.getElementById('ex-cancel-btn');

  let selectedFile = null;

  dropArea.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) setFile(fileInput.files[0]);
  });

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
    fileName.textContent = file.name;
    startBtn.disabled = false;
  }

  startBtn.addEventListener('click', () => {
    if (!selectedFile) return;
    startExtraction(selectedFile);
  });

  cancelBtn.addEventListener('click', () => {
    cancelled = true;
    cancelBtn.classList.add('hidden');
    toast('Cancelling after current frame…', 'info');
  });
}

async function startExtraction(file) {
  if (!window.JSZip) { toast('ZIP library not loaded — try refreshing', 'error'); return; }
  if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) {
    toast('Frame-accurate extraction requires Chrome or Edge.', 'error');
    return;
  }

  const videoName  = file.name.replace(/\.mp4$/i, '');
  const startBtn   = document.getElementById('ex-start-btn');
  const cancelBtn  = document.getElementById('ex-cancel-btn');
  const progWrap   = document.getElementById('ex-progress-wrap');
  const thumbStrip = document.getElementById('ex-thumb-strip');

  startBtn.disabled = true;
  cancelBtn.classList.remove('hidden');
  progWrap.classList.remove('hidden');
  thumbStrip.innerHTML = '';
  cancelled = false;

  const video = document.createElement('video');
  video.src     = URL.createObjectURL(file);
  video.muted   = true;
  video.preload = 'auto';
  await new Promise((res) => video.addEventListener('loadedmetadata', res, { once: true }));

  const canvas  = document.createElement('canvas');
  canvas.width  = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx     = canvas.getContext('2d');

  const zip = new window.JSZip();
  let frameIndex = 0;

  setProgress(0, '–', 'Extracting frames…');

  // requestVideoFrameCallback fires once per frame as it is presented.
  // We pause on each callback, draw to canvas while the frame is frozen,
  // then resume — no time math, no fps assumptions.
  await new Promise((resolve) => {
    const onFrame = async () => {
      if (cancelled) { video.pause(); resolve(); return; }

      video.pause();
      ctx.drawImage(video, 0, 0);

      if (frameIndex % 10 === 0) addThumb(canvas);

      const frameNum = String(frameIndex).padStart(4, '0');
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
      zip.file(`${videoName}_frame${frameNum}.jpg`, blob);
      frameIndex++;

      const pct = video.duration > 0 ? video.currentTime / video.duration : 0;
      setProgress(Math.min(pct * 0.88, 0.88), `Frame ${frameIndex}`, 'Extracting…');

      if (cancelled) { resolve(); return; }

      video.requestVideoFrameCallback(onFrame);
      video.play().catch(() => {});
    };

    video.addEventListener('ended', resolve, { once: true });
    video.playbackRate = 16;
    video.requestVideoFrameCallback(onFrame);
    video.play().catch(() => {});
  });

  video.pause();
  URL.revokeObjectURL(video.src);

  if (frameIndex === 0) {
    toast('No frames extracted', 'error');
    resetUI();
    return;
  }

  setProgress(0.9, `${frameIndex} frames`, 'Generating ZIP…');

  const zipBlob = await zip.generateAsync(
    { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
    ({ percent }) => setProgress(0.9 + (percent / 100) * 0.1, `${frameIndex} frames`, 'Compressing…')
  );

  const url = URL.createObjectURL(zipBlob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = `${videoName}_frames.zip`;
  a.click();
  URL.revokeObjectURL(url);

  setProgress(1, `${frameIndex} frames`, 'Done');
  toast(`Downloaded ${frameIndex} frames as ${videoName}_frames.zip`, 'success');
  resetUI();
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

function resetUI() {
  const startBtn  = document.getElementById('ex-start-btn');
  const cancelBtn = document.getElementById('ex-cancel-btn');
  if (startBtn)  startBtn.disabled = false;
  if (cancelBtn) cancelBtn.classList.add('hidden');
}
