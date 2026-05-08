import { getToken } from './auth.js';
import { findRootFolder, listAllFiles, downloadFileContent } from './drive.js';
import { makeSemaphore, toast, slugify } from './utils.js';
import { MASTER_USERS } from './config.js';

let items        = [];      // [{ videoSlug, imageName, imageId, labelName, labelId, uploader }]
let currentIdx   = 0;
let decisions    = {};      // { labelId: { status, note, labelName, imageName, videoSlug, uploader } }
let contentCache = new Map(); // fileId → ArrayBuffer

const STORAGE_KEY = 'pavement_review_decisions';

const SHAPE_COLORS = ['#4ec9b0','#dcdcaa','#9cdcfe','#c586c0','#ce9178','#4fc1ff','#b5cea8'];

function classColor(label) {
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0;
  return SHAPE_COLORS[h % SHAPE_COLORS.length];
}

// ── Render shell ──────────────────────────────────────────────────────────────

export function renderReviewer(container) {
  container.innerHTML = `
    <div style="max-width:820px;">
      <p class="section-title">Review Annotations</p>
      <button class="btn btn-primary" id="rv-scan-btn">Scan Drive</button>

      <div id="rv-scan-progress" class="progress-wrap hidden">
        <div class="progress-label">
          <span id="rv-scan-text">Scanning…</span>
          <span id="rv-scan-pct">0%</span>
        </div>
        <div class="progress-bar"><div class="progress-fill" id="rv-scan-fill"></div></div>
      </div>

      <div id="rv-main" class="hidden">
        <div class="rv-status-bar">
          <span id="rv-progress-label" class="text-dim" style="font-size:13px;"></span>
          <div class="flex-row" style="gap:1.25rem;">
            <span id="rv-count-valid"   style="font-size:13px;color:var(--success);">0 valid</span>
            <span id="rv-count-invalid" style="font-size:13px;color:var(--danger);">0 invalid</span>
            <span id="rv-count-pending" style="font-size:13px;color:var(--text-dim);">0 pending</span>
          </div>
        </div>

        <div class="rv-nav">
          <button class="btn btn-ghost btn-sm" id="rv-prev">&#8592; Prev</button>
          <span id="rv-item-label" class="text-dim" style="font-size:13px;"></span>
          <button class="btn btn-ghost btn-sm" id="rv-next">Next &#8594;</button>
        </div>

        <div class="rv-canvas-wrap">
          <canvas id="rv-canvas"></canvas>
          <div id="rv-loading" class="rv-loading hidden">Loading…</div>
        </div>

        <div id="rv-shapes"></div>

        <div class="rv-decision-row">
          <button class="btn rv-btn-valid"   id="rv-valid-btn">&#10003; Valid <kbd>V</kbd></button>
          <button class="btn rv-btn-invalid" id="rv-invalid-btn">&#10007; Invalid <kbd>X</kbd></button>
        </div>

        <div id="rv-note-wrap" class="hidden" style="margin-top:0.75rem;">
          <label style="font-size:13px;color:var(--text-dim);display:block;margin-bottom:0.3rem;">
            Note (optional — included in notification email)
          </label>
          <textarea id="rv-note" rows="2"
            style="width:100%;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);padding:0.4rem 0.6rem;font-family:var(--font);font-size:13px;resize:vertical;"></textarea>
        </div>

        <div class="rv-shortcut-hint text-dim">
          Keyboard: <kbd>&#8592;</kbd><kbd>&#8594;</kbd> navigate &nbsp;·&nbsp; <kbd>V</kbd> valid &nbsp;·&nbsp; <kbd>X</kbd> invalid
        </div>

        <div style="margin-top:1.5rem;border-top:1px solid var(--border);padding-top:1rem;" class="flex-row">
          <button class="btn btn-primary" id="rv-save-btn">Save &amp; Send Notifications</button>
          <span class="text-dim" id="rv-save-hint" style="font-size:13px;"></span>
        </div>

        <div id="rv-email-panel" class="hidden" style="margin-top:1.25rem;">
          <p class="section-title">Notification Drafts</p>
          <div id="rv-email-list"></div>
        </div>
      </div>
    </div>
  `;

  document.getElementById('rv-scan-btn').addEventListener('click', startScan);
}

// ── Scan ──────────────────────────────────────────────────────────────────────

function isMaster() {
  const token = getToken();
  if (!token) return false;
  // getUser() email check — import lazily to avoid circular deps
  const el = document.getElementById('user-email');
  const email = el ? el.textContent.trim().toLowerCase() : '';
  return MASTER_USERS.includes(email);
}

async function startScan() {
  if (!isMaster()) { toast('Access restricted to master reviewers', 'error'); return; }
  const token = getToken();
  if (!token) { toast('Not signed in', 'error'); return; }

  const scanBtn = document.getElementById('rv-scan-btn');
  scanBtn.disabled = true;
  document.getElementById('rv-scan-progress').classList.remove('hidden');
  document.getElementById('rv-main').classList.add('hidden');

  try {
    setScanProgress(0, 'Finding PavementDataset folder…');
    const root = await findRootFolder(token);
    if (!root) { toast('PavementDataset folder not found. Upload some data first.', 'info'); return; }

    setScanProgress(0.05, 'Loading uploader info…');
    const uploaderMap = await buildUploaderMap(token, root.id);

    setScanProgress(0.1, 'Listing video folders…');
    const videoFolders = await listAllFiles(
      token,
      `'${root.id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      'id,name'
    );
    if (videoFolders.length === 0) { toast('No video folders found.', 'info'); return; }

    const folderSem = makeSemaphore(4);
    const allItems  = [];
    let scanned     = 0;

    await Promise.all(videoFolders.map(vf =>
      folderSem(async () => {
        const subfolders = await listAllFiles(
          token,
          `'${vf.id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
          'id,name'
        );
        const framesFolder = subfolders.find(f => f.name === 'frames');
        const labelsFolder = subfolders.find(f => f.name === 'labels');
        if (!framesFolder || !labelsFolder) { scanned++; return; }

        const [imageFiles, labelFiles] = await Promise.all([
          listAllFiles(token, `'${framesFolder.id}' in parents and trashed=false`, 'id,name'),
          listAllFiles(token, `'${labelsFolder.id}' in parents and trashed=false`, 'id,name'),
        ]);

        const imageMap = new Map(imageFiles.map(f => [f.name.replace(/\.[^.]+$/, ''), f]));
        for (const lf of labelFiles) {
          if (!lf.name.endsWith('.json')) continue;
          const stem = lf.name.replace(/\.json$/, '');
          const imgFile = imageMap.get(stem);
          if (!imgFile) continue;
          allItems.push({
            videoSlug: vf.name,
            imageName: imgFile.name,
            imageId:   imgFile.id,
            labelName: lf.name,
            labelId:   lf.id,
            uploader:  uploaderMap[vf.name] || '',
          });
        }
        scanned++;
        setScanProgress(0.1 + (scanned / videoFolders.length) * 0.9,
          `Scanned ${scanned}/${videoFolders.length} folders (${allItems.length} pairs)…`);
      })
    ));

    items = allItems;
    contentCache.clear();
    decisions = {};
    loadDecisions();

    setScanProgress(1, 'Scan complete');
    document.getElementById('rv-scan-progress').classList.add('hidden');
    if (items.length === 0) { toast('No annotation pairs found.', 'info'); return; }

    initReviewUI(token);

  } catch (err) {
    toast(`Scan failed: ${err.message}`, 'error');
  } finally {
    scanBtn.disabled = false;
  }
}

async function buildUploaderMap(token, rootId) {
  const map = {};
  try {
    const files = await listAllFiles(token, `name='tracking.json' and '${rootId}' in parents and trashed=false`, 'id');
    if (!files.length) return map;
    const buf     = await downloadFileContent(token, files[0].id);
    const entries = JSON.parse(new TextDecoder().decode(buf));
    if (!Array.isArray(entries)) return map;
    for (const entry of entries) {
      if (entry.action === 'label_upload' && entry.folder_name && entry.user) {
        map[slugify((entry.folder_name || '').replace(/\.mp4$/i, ''))] = entry.user;
      }
    }
  } catch { /* no tracking.json — uploaders will be unknown */ }
  return map;
}

// ── Review UI ─────────────────────────────────────────────────────────────────

function initReviewUI(token) {
  document.getElementById('rv-main').classList.remove('hidden');
  document.getElementById('rv-email-panel').classList.add('hidden');

  // Start at first pending item
  currentIdx = 0;
  const firstPending = items.findIndex(it => getStatus(it) === 'pending');
  if (firstPending >= 0) currentIdx = firstPending;

  document.getElementById('rv-prev').onclick       = () => navigate(-1, token);
  document.getElementById('rv-next').onclick       = () => navigate(1, token);
  document.getElementById('rv-valid-btn').onclick  = () => markDecision('valid', token);
  document.getElementById('rv-invalid-btn').onclick= () => markDecision('invalid', token);
  document.getElementById('rv-note').oninput       = saveCurrentNote;
  document.getElementById('rv-save-btn').onclick   = buildEmailDrafts;

  document.addEventListener('keydown', (e) => {
    if (!document.getElementById('rv-main').classList.contains('hidden')) {
      handleKey(e, token);
    }
  });

  renderItem(token);
  updateStats();
}

function handleKey(e, token) {
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowLeft')            navigate(-1, token);
  else if (e.key === 'ArrowRight')      navigate(1, token);
  else if (e.key === 'v' || e.key === 'V') markDecision('valid', token);
  else if (e.key === 'x' || e.key === 'X') markDecision('invalid', token);
}

function navigate(delta, token) {
  currentIdx = Math.max(0, Math.min(items.length - 1, currentIdx + delta));
  renderItem(token);
}

// ── Render current item ───────────────────────────────────────────────────────

async function renderItem(token) {
  const item = items[currentIdx];
  if (!item) return;

  const dec = decisions[item.labelId];

  document.getElementById('rv-item-label').textContent =
    `${item.videoSlug} — ${item.imageName}  (${currentIdx + 1} / ${items.length})`;

  // Note textarea
  const noteWrap = document.getElementById('rv-note-wrap');
  const noteEl   = document.getElementById('rv-note');
  if (dec?.status === 'invalid') {
    noteWrap.classList.remove('hidden');
    noteEl.value = dec.note || '';
  } else {
    noteWrap.classList.add('hidden');
  }

  // Button state
  setButtonState(dec?.status ?? 'pending');

  // Canvas
  const canvas  = document.getElementById('rv-canvas');
  const ctx     = canvas.getContext('2d');
  canvas.width  = 10;
  canvas.height = 10;
  document.getElementById('rv-loading').classList.remove('hidden');
  document.getElementById('rv-shapes').innerHTML = '';

  try {
    const [imgBuf, lblBuf] = await Promise.all([
      getCached(token, item.imageId),
      getCached(token, item.labelId),
    ]);

    const imgBlob = new Blob([imgBuf], { type: 'image/jpeg' });
    const imgUrl  = URL.createObjectURL(imgBlob);
    const img     = new Image();
    img.src = imgUrl;
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
    URL.revokeObjectURL(imgUrl);

    const json   = JSON.parse(new TextDecoder().decode(lblBuf));
    const maxW   = document.getElementById('rv-canvas').parentElement.clientWidth - 4;
    const scale  = Math.min(maxW / img.naturalWidth, 600 / img.naturalHeight, 1);
    canvas.width  = Math.round(img.naturalWidth  * scale);
    canvas.height = Math.round(img.naturalHeight * scale);

    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const shapes = Array.isArray(json.shapes) ? json.shapes : [];
    for (const shape of shapes) drawShape(ctx, shape, scale);
    renderShapes(shapes);

  } catch (err) {
    canvas.width = 500; canvas.height = 140;
    ctx.fillStyle = 'var(--bg-surface)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'var(--danger)';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`Failed to load: ${err.message}`, canvas.width / 2, canvas.height / 2);
  } finally {
    document.getElementById('rv-loading').classList.add('hidden');
  }
}

// ── Canvas drawing ────────────────────────────────────────────────────────────

function drawShape(ctx, shape, scale) {
  const pts = (shape.points || []).map(([x, y]) => [x * scale, y * scale]);
  if (!pts.length) return;
  const color = classColor(shape.label || '?');

  ctx.strokeStyle = color;
  ctx.fillStyle   = color + '40'; // 25% opacity
  ctx.lineWidth   = 2;

  const type = shape.shape_type || 'polygon';

  if (type === 'rectangle' && pts.length >= 2) {
    const [x1, y1] = pts[0], [x2, y2] = pts[1];
    ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
  } else if (type === 'circle' && pts.length >= 2) {
    const r = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
    ctx.beginPath();
    ctx.arc(pts[0][0], pts[0][1], r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else if (type === 'line') {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
  } else if (type === 'point') {
    ctx.beginPath();
    ctx.arc(pts[0][0], pts[0][1], 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else {
    // polygon
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  // Label tag
  const [lx, ly] = pts[0];
  const text  = shape.label || '?';
  ctx.font = 'bold 11px sans-serif';
  const tw  = ctx.measureText(text).width;
  ctx.fillStyle = color;
  ctx.fillRect(lx, ly - 14, tw + 6, 15);
  ctx.fillStyle = '#000';
  ctx.fillText(text, lx + 3, ly - 2);
}

function renderShapes(shapes) {
  const el = document.getElementById('rv-shapes');
  if (!shapes.length) {
    el.innerHTML = '<p class="text-dim" style="font-size:12px;margin-top:0.5rem;">No shapes in this annotation</p>';
    return;
  }
  el.innerHTML = `
    <div style="margin:0.6rem 0 0.4rem;font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.05em;">
      ${shapes.length} shape${shapes.length === 1 ? '' : 's'}
    </div>
    ${shapes.map(s => {
      const c = classColor(s.label || '?');
      return `<span style="display:inline-block;margin:0.15rem 0.25rem;padding:0.15rem 0.45rem;border-radius:3px;font-size:12px;background:${c}22;color:${c};border:1px solid ${c}55;">
        ${s.label || '(unlabeled)'} <span style="opacity:0.55;">${s.shape_type || 'polygon'}</span>
      </span>`;
    }).join('')}
  `;
}

// ── Decisions ─────────────────────────────────────────────────────────────────

function markDecision(status, token) {
  const item = items[currentIdx];
  if (!item) return;

  decisions[item.labelId] = {
    status,
    note:      status === 'invalid' ? (document.getElementById('rv-note').value || '') : '',
    labelName: item.labelName,
    imageName: item.imageName,
    videoSlug: item.videoSlug,
    uploader:  item.uploader,
  };

  saveDecisions();
  setButtonState(status);
  updateStats();

  const noteWrap = document.getElementById('rv-note-wrap');
  if (status === 'invalid') {
    noteWrap.classList.remove('hidden');
    document.getElementById('rv-note').focus();
  } else {
    noteWrap.classList.add('hidden');
  }

  // Auto-advance to next pending after marking valid
  if (status === 'valid') {
    const next = items.findIndex((it, i) => i > currentIdx && getStatus(it) === 'pending');
    setTimeout(() => {
      if (next >= 0) { currentIdx = next; renderItem(token); }
      else navigate(1, token);
    }, 250);
  }
}

function saveCurrentNote() {
  const item = items[currentIdx];
  if (!item || decisions[item.labelId]?.status !== 'invalid') return;
  decisions[item.labelId].note = document.getElementById('rv-note').value;
  saveDecisions();
}

function setButtonState(status) {
  document.getElementById('rv-valid-btn').classList.toggle('rv-btn-active',   status === 'valid');
  document.getElementById('rv-invalid-btn').classList.toggle('rv-btn-active', status === 'invalid');
}

function getStatus(item) {
  return decisions[item.labelId]?.status ?? 'pending';
}

// ── Stats ─────────────────────────────────────────────────────────────────────

function updateStats() {
  const counts = { valid: 0, invalid: 0, pending: 0 };
  for (const item of items) counts[getStatus(item)]++;
  document.getElementById('rv-count-valid').textContent   = `${counts.valid} valid`;
  document.getElementById('rv-count-invalid').textContent = `${counts.invalid} invalid`;
  document.getElementById('rv-count-pending').textContent = `${counts.pending} pending`;
  document.getElementById('rv-progress-label').textContent =
    `${counts.valid + counts.invalid} / ${items.length} reviewed`;

  const invalidCount = counts.invalid;
  document.getElementById('rv-save-hint').textContent =
    invalidCount > 0 ? `${invalidCount} invalid annotation${invalidCount === 1 ? '' : 's'} will trigger notifications` : '';
}

// ── Email drafts ──────────────────────────────────────────────────────────────

function buildEmailDrafts() {
  const invalid = Object.values(decisions).filter(d => d.status === 'invalid');
  if (invalid.length === 0) {
    toast('No invalid annotations — nothing to notify', 'info');
    return;
  }

  // Group by uploader email
  const byEmail = {};
  for (const dec of invalid) {
    const key = dec.uploader || '(unknown uploader)';
    if (!byEmail[key]) byEmail[key] = [];
    byEmail[key].push(dec);
  }

  const emailPanel = document.getElementById('rv-email-panel');
  const emailList  = document.getElementById('rv-email-list');
  emailPanel.classList.remove('hidden');
  emailList.innerHTML = '';

  for (const [email, issues] of Object.entries(byEmail)) {
    const lines = issues.map(d => {
      let line = `  - ${d.videoSlug}/${d.imageName}`;
      if (d.note) line += `\n    Note: ${d.note}`;
      return line;
    }).join('\n');

    const bodyText =
      `Hi,\n\nThe following annotations were marked as invalid during review and need to be corrected:\n\n${lines}\n\nPlease fix and re-upload the corrected labels.\n\nThank you.`;

    const subject = 'Pavement Dataset — Annotation Review Issues';
    const mailto  = `mailto:${email.includes('@') ? email : ''}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(bodyText)}`;

    const item = document.createElement('div');
    item.className = 'rv-email-item';
    item.innerHTML = `
      <div class="flex-row" style="margin-bottom:0.4rem;">
        <span style="flex:1;font-size:13px;color:var(--text);">To: <strong>${email}</strong> &nbsp;<span class="text-dim">(${issues.length} issue${issues.length === 1 ? '' : 's'})</span></span>
        <a href="${mailto}" class="btn btn-ghost btn-sm">Open in Email</a>
        <button class="btn btn-ghost btn-sm rv-copy-btn">Copy</button>
      </div>
      <pre class="rv-email-preview">${escHtml(bodyText)}</pre>
    `;
    item.querySelector('.rv-copy-btn').addEventListener('click', () => {
      navigator.clipboard.writeText(bodyText)
        .then(() => toast('Copied to clipboard', 'success'))
        .catch(() => toast('Copy failed — select text manually', 'error'));
    });
    emailList.appendChild(item);
  }

  emailPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast(`${Object.keys(byEmail).length} email draft${Object.keys(byEmail).length === 1 ? '' : 's'} ready`, 'success');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getCached(token, fileId) {
  if (contentCache.has(fileId)) return contentCache.get(fileId);
  const buf = await downloadFileContent(token, fileId);
  contentCache.set(fileId, buf);
  return buf;
}

function saveDecisions() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(decisions)); } catch { /* quota */ }
}

function loadDecisions() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      // Only restore decisions whose labelId exists in the current scan
      const validIds = new Set(items.map(it => it.labelId));
      for (const [id, dec] of Object.entries(parsed)) {
        if (validIds.has(id)) decisions[id] = dec;
      }
    }
  } catch { /* ignore */ }
}

function setScanProgress(fraction, text) {
  const fill = document.getElementById('rv-scan-fill');
  if (!fill) return;
  fill.style.width = `${Math.round(fraction * 100)}%`;
  document.getElementById('rv-scan-pct').textContent  = `${Math.round(fraction * 100)}%`;
  document.getElementById('rv-scan-text').textContent = text;
}

function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
