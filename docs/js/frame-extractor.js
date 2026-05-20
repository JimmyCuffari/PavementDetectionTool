import { toast } from './utils.js';

let ffmpegPromise = null; // cached across extractions in the same session
let activeFFmpeg  = null; // reference held for cancel
let cancelled     = false;

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
    toast('Cancelling…', 'info');
    if (activeFFmpeg) {
      activeFFmpeg.terminate();
      ffmpegPromise = null; // force fresh load next time
      activeFFmpeg  = null;
    }
    resetUI();
  });
}

// ── FFmpeg loader (lazy, cached) ───────────────────────────────────────────────

function ensureFFmpeg() {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const { toBlobURL } = await import('https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm/index.js');

      const ffBase   = 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm';
      const coreBase = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core-st@0.12.6/dist/esm';

      // worker.js must be a same-origin blob URL — module workers block cross-origin scripts
      const workerBlobURL = await toBlobURL(`${ffBase}/worker.js`, 'text/javascript');

      // Patch index.js to reference the blob worker URL, then import from a blob
      const indexSrc = await (await fetch(`${ffBase}/index.js`)).text();
      const patched  = indexSrc.replaceAll('./worker.js', workerBlobURL);
      const { FFmpeg } = await import(
        URL.createObjectURL(new Blob([patched], { type: 'text/javascript' }))
      );

      const ff = new FFmpeg();
      await ff.load({
        coreURL: await toBlobURL(`${coreBase}/ffmpeg-core.js`,  'text/javascript'),
        wasmURL: await toBlobURL(`${coreBase}/ffmpeg-core.wasm`, 'application/wasm'),
      });
      return ff;
    })();
  }
  return ffmpegPromise;
}

// ── Extraction ─────────────────────────────────────────────────────────────────

async function startExtraction(file) {
  if (!window.JSZip) { toast('ZIP library not loaded — try refreshing', 'error'); return; }

  const videoName  = file.name.replace(/\.[^.]+$/, '');
  const startBtn   = document.getElementById('ex-start-btn');
  const cancelBtn  = document.getElementById('ex-cancel-btn');
  const progWrap   = document.getElementById('ex-progress-wrap');
  const thumbStrip = document.getElementById('ex-thumb-strip');

  startBtn.disabled = true;
  cancelBtn.classList.remove('hidden');
  progWrap.classList.remove('hidden');
  thumbStrip.innerHTML = '';
  cancelled = false;

  setProgress(0, '–', 'Loading FFmpeg…');
  toast('Loading FFmpeg — first use downloads ~15 MB, then cached', 'info', 7000);

  let ffmpeg;
  try {
    ffmpeg = await ensureFFmpeg();
  } catch (err) {
    toast(`Failed to load FFmpeg: ${err.message}`, 'error');
    resetUI();
    return;
  }

  if (cancelled) { resetUI(); return; }

  activeFFmpeg = ffmpeg;

  const onProgress = ({ progress }) => {
    setProgress(0.1 + Math.min(progress, 1) * 0.74, '–', 'Extracting frames…');
  };
  ffmpeg.on('progress', onProgress);

  try {
    setProgress(0.05, '–', 'Writing video to memory…');
    await ffmpeg.writeFile('input.mp4', new Uint8Array(await file.arrayBuffer()));

    if (cancelled) return;

    setProgress(0.1, '–', 'Extracting frames…');
    // Equivalent to: ffmpeg -i input.mp4 {videoName}_frame%04d.jpg
    await ffmpeg.exec(['-i', 'input.mp4', `${videoName}_frame%04d.jpg`]);

    if (cancelled) return;

    const entries    = await ffmpeg.listDir('/');
    const frameFiles = entries
      .filter(e => !e.isDir && e.name.startsWith(`${videoName}_frame`) && e.name.endsWith('.jpg'))
      .sort((a, b) => a.name.localeCompare(b.name));

    if (frameFiles.length === 0) {
      toast('No frames extracted — check video format', 'error');
      return;
    }

    const zip = new window.JSZip();

    for (let i = 0; i < frameFiles.length; i++) {
      const data = await ffmpeg.readFile(frameFiles[i].name);
      zip.file(frameFiles[i].name, data);

      if (i % 10 === 0) addThumb(data);

      setProgress(0.84 + (i / frameFiles.length) * 0.06, `${i + 1} / ${frameFiles.length}`, 'Packaging…');
    }

    setProgress(0.9, `${frameFiles.length} frames`, 'Generating ZIP…');
    const zipBlob = await zip.generateAsync(
      { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
      ({ percent }) => setProgress(0.9 + (percent / 100) * 0.1, `${frameFiles.length} frames`, 'Compressing…')
    );

    const url = URL.createObjectURL(zipBlob);
    const a   = document.createElement('a');
    a.href     = url;
    a.download = `${videoName}_frames.zip`;
    a.click();
    URL.revokeObjectURL(url);

    setProgress(1, `${frameFiles.length} frames`, 'Done');
    toast(`Downloaded ${frameFiles.length} frames as ${videoName}_frames.zip`, 'success');

    // Free virtual FS
    try { await ffmpeg.deleteFile('input.mp4'); } catch {}
    for (const f of frameFiles) { try { await ffmpeg.deleteFile(f.name); } catch {} }

  } catch (err) {
    if (!cancelled) toast(`Extraction failed: ${err.message}`, 'error');
  } finally {
    ffmpeg.off('progress', onProgress);
    activeFFmpeg = null;
    resetUI();
  }
}

// ── UI helpers ─────────────────────────────────────────────────────────────────

function addThumb(data) {
  const strip = document.getElementById('ex-thumb-strip');
  if (!strip) return;
  const blob = new Blob([data], { type: 'image/jpeg' });
  const url  = URL.createObjectURL(blob);
  const img  = document.createElement('img');
  img.onload = () => URL.revokeObjectURL(url);
  img.src    = url;
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
