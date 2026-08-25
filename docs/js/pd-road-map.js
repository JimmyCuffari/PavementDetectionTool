import { toast }   from './utils.js';
import { pdState } from './pd-state.js';

const POLL_MS = 1500;

export function renderRoadMap(container) {
  const savedUrl = localStorage.getItem('pavement_trainer_server_url') || 'http://localhost:7860';

  container.innerHTML = `
    <div style="max-width:820px;">
      <p class="section-title">Generate Road Map</p>
      <p class="text-dim" style="font-size:13px;margin-bottom:1rem;">
        Stitches the selected frames into a bird's-eye orthographic road map
        using ORB visual odometry and the loaded homography transform.
      </p>

      <!-- Server setup panel -->
      <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:1rem;">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:0.6rem 0.75rem;cursor:pointer;" id="prm-setup-header">
          <span style="font-weight:600;font-size:13px;">Server Setup</span>
          <span style="display:flex;align-items:center;gap:0.75rem;">
            <span class="badge badge-success hidden" id="prm-setup-badge">&#10003; Server Connected</span>
            <button class="btn btn-ghost btn-sm" id="prm-setup-toggle" style="font-size:11px;padding:0.2rem 0.5rem;">&#9660; Expand</button>
          </span>
        </div>

        <div id="prm-setup-body" class="hidden" style="padding:0 0.75rem 0.75rem;">
          <p class="text-dim" style="font-size:12px;margin:0 0 1rem;">
            Process Data uses the same <code style="background:var(--bg-surface);padding:0.1rem 0.3rem;border-radius:3px;font-size:11px;">trainer_server.py</code>
            as the Train Model tab. If you already have it running, skip to Step 3.
          </p>

          <!-- Step 1 -->
          <div class="mt-step-row">
            <div class="mt-step-num">1</div>
            <div class="mt-step-body">
              <div class="mt-step-title">Download the server script</div>
              <p class="text-dim" style="font-size:12px;margin:0.2rem 0 0.6rem;">Save it anywhere on your machine. Skip if already downloaded.</p>
              <a class="btn btn-primary btn-sm" href="./trainer_server.py" download="trainer_server.py">&#8595; Download trainer_server.py</a>
            </div>
          </div>

          <!-- Step 2 -->
          <div class="mt-step-row">
            <div class="mt-step-num">2</div>
            <div class="mt-step-body">
              <div class="mt-step-title">Install Python requirements</div>
              <p class="text-dim" style="font-size:12px;margin:0.2rem 0 0.5rem;">
                The stitching pipeline requires OpenCV and NumPy in addition to the base packages.
              </p>
              <div class="mt-cmd-row" style="margin-bottom:0.3rem;">
                <code style="font-size:11px;color:var(--text);flex:1;word-break:break-all;">pip install flask flask-cors requests opencv-python numpy scikit-image</code>
                <button class="btn btn-ghost btn-sm prm-copy-btn" data-copy="pip install flask flask-cors requests opencv-python numpy scikit-image" style="flex-shrink:0;">&#9108; Copy</button>
              </div>
              <p class="text-dim" style="font-size:11px;margin:0.2rem 0 0;">
                If you trained models too, you already have flask/requests — just add: <code style="background:var(--bg-surface);padding:0.1rem 0.3rem;border-radius:3px;font-size:10px;">pip install opencv-python numpy scikit-image</code>
              </p>
            </div>
          </div>

          <!-- Step 3 -->
          <div class="mt-step-row mt-step-last">
            <div class="mt-step-num">3</div>
            <div class="mt-step-body">
              <div class="mt-step-title">Start the server</div>
              <p class="text-dim" style="font-size:12px;margin:0.2rem 0 0.5rem;">Open a terminal in the folder where you saved the script and run:</p>
              <div class="mt-cmd-row" style="margin-bottom:0.5rem;">
                <code style="font-size:11px;color:var(--text);flex:1;">python trainer_server.py</code>
                <button class="btn btn-ghost btn-sm prm-copy-btn" data-copy="python trainer_server.py" style="flex-shrink:0;">&#9108; Copy</button>
              </div>
              <p class="text-dim" style="font-size:11px;margin:0;">Keep the terminal open while using Process Data. The server listens on port 7860 by default.</p>
            </div>
          </div>
        </div>
      </div>

      <div id="prm-prereqs" class="hidden" style="margin-bottom:1rem;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);padding:0.75rem;font-size:13px;color:var(--warning);">
        &#9888; Complete the <strong>Image Upload</strong> and <strong>Homography</strong> steps first.
      </div>

      <div class="flex-row" style="gap:1rem;margin-bottom:1rem;flex-wrap:wrap;">
        <div class="form-group" style="margin-bottom:0;flex:1;min-width:200px;">
          <label>Server URL</label>
          <input type="text" id="prm-server-url" value="${savedUrl}"
            style="width:100%;padding:0.4rem 0.6rem;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-family:var(--font);" />
        </div>
        <div style="display:flex;align-items:flex-end;padding-bottom:0;">
          <button class="btn btn-ghost btn-sm" id="prm-ping-btn">Test Connection</button>
        </div>
      </div>

      <div class="flex-row mt-1">
        <button class="btn btn-primary" id="prm-generate-btn" disabled>Generate Road Map</button>
        <button class="btn btn-ghost btn-sm" id="prm-stop-btn" disabled>Stop</button>
        <span id="prm-status-text" class="text-dim" style="font-size:13px;"></span>
      </div>

      <div id="prm-progress-wrap" class="progress-wrap hidden" style="margin-top:0.75rem;">
        <div class="progress-label">
          <span id="prm-progress-text">Working…</span>
          <span id="prm-progress-pct">0%</span>
        </div>
        <div class="progress-bar"><div class="progress-fill" id="prm-progress-fill"></div></div>
      </div>

      <div id="prm-log-wrap" class="hidden" style="margin-top:0.75rem;max-height:120px;overflow-y:auto;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);padding:0.5rem;">
        <div id="prm-log" style="font-size:11px;font-family:monospace;color:var(--text-dim);"></div>
      </div>

      <div id="prm-map-wrap" class="hidden" style="margin-top:1.25rem;">
        <p class="section-title">Stitched Road Map</p>
        <div style="overflow:auto;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-surface);max-height:600px;">
          <img id="prm-map-img" style="display:block;max-width:100%;height:auto;" alt="Road map" />
        </div>
        <div class="flex-row" style="margin-top:0.5rem;">
          <a id="prm-download-link" class="btn btn-ghost btn-sm" download="road_map.jpg">&#8595; Download Map</a>
        </div>
      </div>
    </div>
  `;

  wireEvents(container);
}

let _pollTimer = null;

function handleCopyClick(e) {
  const btn = e.target.closest('.prm-copy-btn');
  if (!btn) return;
  e.stopPropagation();
  navigator.clipboard.writeText(btn.dataset.copy).then(() => {
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  });
}

function wireEvents(container) {
  const genBtn      = container.querySelector('#prm-generate-btn');
  const stopBtn     = container.querySelector('#prm-stop-btn');
  const pingBtn     = container.querySelector('#prm-ping-btn');
  const serverInput = container.querySelector('#prm-server-url');
  const prereqs     = container.querySelector('#prm-prereqs');
  const statusText  = container.querySelector('#prm-status-text');
  const setupBody   = container.querySelector('#prm-setup-body');
  const setupToggle = container.querySelector('#prm-setup-toggle');
  const setupBadge  = container.querySelector('#prm-setup-badge');

  // Setup panel expand/collapse
  container.querySelector('#prm-setup-header').onclick = () => {
    const open = !setupBody.classList.contains('hidden');
    setupBody.classList.toggle('hidden', open);
    setupToggle.textContent = open ? '▼ Expand' : '▲ Collapse';
  };

  // Copy buttons inside setup panel — use event delegation to avoid deep nesting
  container.querySelector('#prm-setup-body').addEventListener('click', handleCopyClick);

  const setProgress = (pct, text) => {
    container.querySelector('#prm-progress-fill').style.width = `${pct}%`;
    container.querySelector('#prm-progress-pct').textContent  = `${pct}%`;
    container.querySelector('#prm-progress-text').textContent = text;
  };

  const appendLog = (lines) => {
    const logEl = container.querySelector('#prm-log');
    lines.forEach(l => {
      const div = document.createElement('div');
      div.textContent = l;
      logEl.appendChild(div);
    });
    logEl.parentElement.scrollTop = logEl.parentElement.scrollHeight;
  };

  serverInput.oninput = () => { pdState.serverUrl = serverInput.value.trim(); };

  pingBtn.onclick = async () => {
    const url = serverInput.value.trim();
    try {
      const r = await fetch(`${url}/ping`);
      if (r.ok) {
        toast('Server reachable', 'success');
        setupBadge.classList.remove('hidden');
      } else {
        toast(`Server returned ${r.status}`, 'error');
        setupBadge.classList.add('hidden');
      }
    } catch {
      toast('Could not reach server — is trainer_server.py running?', 'error');
      setupBadge.classList.add('hidden');
    }
  };

  genBtn.onclick = async () => {
    if ((!pdState.framesFolderId && !pdState.framesLocalPath) || !pdState.homography) {
      prereqs.classList.remove('hidden');
      return;
    }
    prereqs.classList.add('hidden');

    const url = serverInput.value.trim();
    pdState.serverUrl = url;

    try {
      const { getToken } = await import('./auth.js');
      const token = getToken();

      const body = {
        drive_token:        token,
        frames_folder_id:   pdState.framesFolderId  ?? null,
        frames_local_path:  pdState.framesLocalPath ?? null,
        homography:         pdState.homography,
        start_frame:        pdState.startFrame ?? 0,
        end_frame:          pdState.endFrame   ?? null,
        result_folder_id:   pdState.resultFolderId  ?? null,
      };

      const r = await fetch(`${url}/stitch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) { const e = await r.json(); toast(`Server error: ${e.error}`, 'error'); return; }

      genBtn.disabled = true;
      stopBtn.disabled = false;
      container.querySelector('#prm-progress-wrap').classList.remove('hidden');
      container.querySelector('#prm-log-wrap').classList.remove('hidden');
      container.querySelector('#prm-log').innerHTML = '';
      statusText.textContent = 'Running…';

      let lastLogLen = 0;
      _pollTimer = setInterval(async () => {
        try {
          const sr = await fetch(`${url}/stitch-status`);
          const job = await sr.json();

          setProgress(job.progress ?? 0, job.log?.at(-1) ?? 'Working…');
          const newLines = (job.log ?? []).slice(lastLogLen);
          if (newLines.length) { appendLog(newLines); lastLogLen = job.log.length; }

          if (job.state === 'done') {
            clearInterval(_pollTimer);
            genBtn.disabled  = false;
            stopBtn.disabled = true;
            statusText.textContent = `Done — ${job.sections?.length ?? 0} sections`;

            pdState.result = { pngB64: job.png_b64, sections: job.sections ?? [] };

            const img  = container.querySelector('#prm-map-img');
            const link = container.querySelector('#prm-download-link');
            img.src    = job.png_b64;
            link.href  = job.png_b64;
            container.querySelector('#prm-map-wrap').classList.remove('hidden');
            toast('Road map generated', 'success');
          } else if (job.state === 'error' || job.state === 'stopped') {
            clearInterval(_pollTimer);
            genBtn.disabled  = false;
            stopBtn.disabled = true;
            statusText.textContent = job.state === 'stopped' ? 'Stopped' : 'Error';
          }
        } catch { /* network hiccup — keep polling */ }
      }, POLL_MS);

    } catch (err) {
      toast(`Failed to start: ${err.message}`, 'error');
    }
  };

  stopBtn.onclick = async () => {
    const url = serverInput.value.trim();
    try { await fetch(`${url}/stitch-stop`, { method: 'POST' }); } catch { /* ignore */ }
    clearInterval(_pollTimer);
    stopBtn.disabled = true;
    genBtn.disabled  = false;
  };
}
