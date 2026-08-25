import { getToken }        from './auth.js';
import { findRootFolder, listAllFiles } from './drive.js';
import { toast }           from './utils.js';
import { pdState }         from './pd-state.js';

export function renderImageUpload(container) {
  container.innerHTML = `
    <div style="max-width:700px;">
      <p class="section-title">Select Frames Folder</p>
      <p class="text-dim" style="font-size:13px;margin-bottom:1rem;">
        Choose a local folder of frames (JPGs) on the machine running the server,
        or pick a folder already uploaded to Drive.
      </p>

      <p class="section-title">Option 1 — Local Folder</p>
      <div class="flex-row" style="gap:0.5rem;margin-bottom:1rem;">
        <input type="text" id="piu-local-path" placeholder="C:/path/to/frames"
          style="flex:1;padding:0.4rem 0.6rem;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-family:var(--font);" />
        <button class="btn btn-ghost btn-sm" id="piu-browse-btn">Browse…</button>
      </div>

      <p class="section-title">Option 2 — Drive Folder</p>
      <div class="form-group">
        <div class="flex-row" style="gap:0.5rem;">
          <select id="piu-folder-select"
            style="flex:1;padding:0.4rem 0.6rem;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-family:var(--font);">
            <option value="">— click Load to populate —</option>
          </select>
          <button class="btn btn-ghost btn-sm" id="piu-load-btn">Load Folders</button>
        </div>
      </div>

      <div id="piu-frame-range" class="hidden">
        <p class="section-title" style="margin-top:1rem;">Frame Range (optional)</p>
        <div class="flex-row" style="gap:1rem;align-items:flex-end;">
          <div class="form-group" style="flex:1;margin-bottom:0;">
            <label>Start frame</label>
            <input type="number" id="piu-start" min="0" value="0"
              style="width:100%;padding:0.4rem 0.6rem;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-family:var(--font);" />
          </div>
          <div class="form-group" style="flex:1;margin-bottom:0;">
            <label>End frame <span class="text-dim">(blank = all)</span></label>
            <input type="number" id="piu-end" min="0" placeholder="all"
              style="width:100%;padding:0.4rem 0.6rem;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-family:var(--font);" />
          </div>
        </div>
        <p id="piu-frame-count" class="text-dim" style="font-size:12px;margin-top:0.4rem;"></p>
      </div>

      <div class="flex-row mt-2">
        <button class="btn btn-primary btn-sm" id="piu-confirm-btn" disabled>Confirm Selection</button>
        <span id="piu-selected" class="text-dim" style="font-size:13px;"></span>
      </div>
    </div>
  `;

  wireEvents(container);
}

function wireEvents(container) {
  const select     = container.querySelector('#piu-folder-select');
  const loadBtn    = container.querySelector('#piu-load-btn');
  const localInput = container.querySelector('#piu-local-path');
  const browseBtn  = container.querySelector('#piu-browse-btn');
  const confirm    = container.querySelector('#piu-confirm-btn');
  const rangeDiv   = container.querySelector('#piu-frame-range');

  // Enable confirm when either source is filled
  const refreshConfirm = () => {
    confirm.disabled = !localInput.value.trim() && !select.value;
  };

  localInput.oninput = () => {
    if (localInput.value.trim()) {
      select.value = '';
      rangeDiv.classList.remove('hidden');
    } else {
      rangeDiv.classList.add('hidden');
    }
    refreshConfirm();
  };

  browseBtn.onclick = async () => {
    const url = pdState.serverUrl || 'http://localhost:7860';
    try {
      const r = await fetch(`${url}/browse-folder`);
      if (!r.ok) { toast('Browse failed', 'error'); return; }
      const { path } = await r.json();
      if (path) {
        localInput.value = path;
        select.value = '';
        rangeDiv.classList.remove('hidden');
        refreshConfirm();
      }
    } catch { toast('Could not reach server — is trainer_server.py running?', 'error'); }
  };

  const loadFolders = async () => {
    const token = getToken();
    if (!token) { toast('Sign in first', 'error'); return; }

    loadBtn.disabled = true;
    select.innerHTML = '<option value="">— loading… —</option>';
    try {
      const root = await findRootFolder(token);
      if (!root) { select.innerHTML = '<option value="">— no data found —</option>'; return; }

      const videoFolders = await listAllFiles(
        token,
        `'${root.id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        'id,name'
      );

      const withFrames = (await Promise.all(videoFolders.map(async vf => {
        const subs = await listAllFiles(
          token,
          `'${vf.id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
          'id,name'
        );
        const framesFolder = subs.find(f => f.name === 'frames');
        return framesFolder ? { ...vf, framesFolderId: framesFolder.id } : null;
      }))).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));

      if (!withFrames.length) {
        select.innerHTML = '<option value="">— no frame folders found —</option>';
        return;
      }

      select.innerHTML = '<option value="">— select a folder —</option>' +
        withFrames.map(vf => `<option value="${vf.framesFolderId}" data-name="${vf.name}">${vf.name}</option>`).join('');

      select.onchange = async () => {
        if (!select.value) { rangeDiv.classList.add('hidden'); refreshConfirm(); return; }
        localInput.value = '';
        rangeDiv.classList.remove('hidden');
        refreshConfirm();
        try {
          const files = await listAllFiles(token, `'${select.value}' in parents and trashed=false`, 'id,name');
          const jpgs  = files.filter(f => f.name.toLowerCase().endsWith('.jpg'));
          container.querySelector('#piu-frame-count').textContent =
            `${jpgs.length} frame${jpgs.length === 1 ? '' : 's'} in this folder`;
        } catch { /* non-fatal */ }
      };
    } catch (err) {
      select.innerHTML = '<option value="">— failed to load —</option>';
      toast(`Could not load folders: ${err.message}`, 'error');
    } finally {
      loadBtn.disabled = false;
    }
  };

  loadBtn.onclick = loadFolders;

  confirm.onclick = () => {
    const localPath = localInput.value.trim();
    if (!localPath && !select.value) return;

    pdState.startFrame  = Number.parseInt(container.querySelector('#piu-start').value || '0', 10);
    const endVal        = container.querySelector('#piu-end').value;
    pdState.endFrame    = endVal ? Number.parseInt(endVal, 10) : null;

    if (localPath) {
      pdState.framesLocalPath = localPath;
      pdState.framesFolderId  = null;
      pdState.framesFolder    = localPath.split(/[\\/]/).at(-1) || localPath;
    } else {
      pdState.framesLocalPath = null;
      pdState.framesFolderId  = select.value;
      pdState.framesFolder    = select.selectedOptions[0].dataset.name;
    }

    container.querySelector('#piu-selected').textContent =
      `Selected: ${pdState.framesFolder}` +
      (pdState.endFrame != null ? ` (frames ${pdState.startFrame}–${pdState.endFrame})` : '');
    toast(`Folder set: ${pdState.framesFolder}`, 'success');
  };
}
