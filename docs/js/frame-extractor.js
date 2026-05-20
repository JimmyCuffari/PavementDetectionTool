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
    toast('Cancelling…', 'info');
    resetUI();
  });
}

// ── Extraction ─────────────────────────────────────────────────────────────────

async function startExtraction(file) {
  if (!window.JSZip)        { toast('ZIP library not loaded — try refreshing', 'error'); return; }
  if (!window.MP4Box)       { toast('MP4Box not loaded — try refreshing', 'error'); return; }
  if (!window.VideoDecoder) { toast('WebCodecs not supported — use Chrome 94+ or Edge 94+', 'error'); return; }

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

  setProgress(0.01, '–', 'Parsing video…');

  const zip    = new window.JSZip();
  const canvas = document.createElement('canvas');
  const ctx    = canvas.getContext('2d');

  let frameIndex  = 0;
  let totalFrames = 0;

  // Serialize frame rendering — one canvas.toBlob at a time
  const frameQueue  = [];
  let   queueBusy   = false;

  async function drainQueue() {
    if (queueBusy) return;
    queueBusy = true;
    while (frameQueue.length > 0 && !cancelled) {
      const frame = frameQueue.shift();
      const bmp   = await createImageBitmap(frame);
      frame.close();
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      bmp.close();

      if (frameIndex % 10 === 0) addThumb(canvas);

      const frameNum = String(frameIndex).padStart(4, '0');
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.92));
      zip.file(`${videoName}_frame${frameNum}.jpg`, blob);

      frameIndex++;
      const pct = totalFrames > 0 ? frameIndex / totalFrames : 0;
      setProgress(Math.min(pct * 0.85, 0.85), `${frameIndex}${totalFrames ? ' / ' + totalFrames : ''}`, 'Extracting…');
    }
    queueBusy = false;
  }

  const decoder = new VideoDecoder({
    output(frame) { frameQueue.push(frame); drainQueue(); },
    error(e)      { console.error('VideoDecoder:', e); },
  });

  try {
    await new Promise((resolve, reject) => {
      const mp4        = window.MP4Box.createFile();
      const allSamples = []; // collect before decoding so we can apply backpressure

      mp4.onError = (e) => reject(new Error(String(e)));

      mp4.onReady = (info) => {
        const track = info.videoTracks[0];
        if (!track) { reject(new Error('No video track found')); return; }

        totalFrames    = track.nb_samples;
        canvas.width   = track.video.width;
        canvas.height  = track.video.height;

        const config = {
          codec:       track.codec,
          codedWidth:  track.video.width,
          codedHeight: track.video.height,
        };
        const desc = getCodecDescription(mp4, track.id);
        if (desc) config.description = desc;

        decoder.configure(config);
        mp4.setExtractionOptions(track.id, null, { nbSamples: Infinity });
        mp4.start();
      };

      mp4.onSamples = (_, __, samples) => {
        for (const s of samples) allSamples.push(s);
      };

      mp4.onFlush = async () => {
        try {
          // Decode every sample in order with backpressure
          for (const sample of allSamples) {
            if (cancelled) break;
            while (decoder.decodeQueueSize > 20) {
              await new Promise(r => setTimeout(r, 5));
            }
            decoder.decode(new EncodedVideoChunk({
              type:      sample.is_sync ? 'key' : 'delta',
              timestamp: (sample.cts  * 1_000_000) / sample.timescale,
              duration:  (sample.duration * 1_000_000) / sample.timescale,
              data:      sample.data,
            }));
          }

          await decoder.flush();

          // Wait for the render queue to finish
          while (frameQueue.length > 0 || queueBusy) {
            await new Promise(r => setTimeout(r, 20));
          }
          resolve();
        } catch (e) { reject(e); }
      };

      // Feed entire file at once
      file.arrayBuffer().then(buf => {
        buf.fileStart = 0;
        mp4.appendBuffer(buf);
        mp4.flush();
      }).catch(reject);
    });
  } catch (err) {
    if (!cancelled) toast(`Extraction failed: ${err.message}`, 'error');
    resetUI();
    return;
  }

  if (cancelled || frameIndex === 0) {
    if (!cancelled) toast('No frames extracted — check video format', 'error');
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

// Extract the codec description box (avcC, hvcC, etc.) needed by VideoDecoder
function getCodecDescription(mp4boxFile, trackId) {
  const track = mp4boxFile.getTrackById(trackId);
  if (!track) return undefined;
  for (const entry of track.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC ?? entry.hvcC ?? entry.av1C ?? entry.vpcC;
    if (box) {
      const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
      box.write(stream);
      return new Uint8Array(stream.buffer, 8); // skip 4-byte size + 4-byte type
    }
  }
  return undefined;
}

// ── UI helpers ─────────────────────────────────────────────────────────────────

function addThumb(canvas) {
  const strip = document.getElementById('ex-thumb-strip');
  if (!strip) return;
  const img = document.createElement('img');
  img.src   = canvas.toDataURL('image/jpeg', 0.5);
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
