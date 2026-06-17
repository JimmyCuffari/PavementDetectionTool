import { getToken }                                   from './auth.js';
import { getCurrentProject }                          from './project-manager.js';
import { getCurrentDataset, getDatasetRawDataFolder } from './dataset-manager.js';
import { toast }                                      from './utils.js';

// ── Module state ───────────────────────────────────────────────────────────────

let _state = { images: [] };

// ── Entry point ────────────────────────────────────────────────────────────────

export function renderImageUpload(container) {
  container.innerHTML = `
    <div style="max-width:700px;">
      <p class="section-title">Image Upload</p>
      <p class="text-dim" style="font-size:13px;margin-bottom:1.5rem;">
        Upload images collected from video for a section.
      </p>

      <div class="pd-placeholder">
        <p class="pd-placeholder-icon">&#128247;</p>
        <p class="pd-placeholder-title">Coming Soon</p>
        <p class="pd-placeholder-sub">Image upload functionality will be implemented here.</p>
      </div>

      <div class="flex-row" style="margin-top:1rem;">
        <button class="btn btn-primary btn-sm" id="pu-upload-btn" disabled>Upload Images</button>
      </div>
    </div>
  `;

  wireEvents(container);
}

// ── Events ─────────────────────────────────────────────────────────────────────

function wireEvents(container) {
  // TODO: wire pu-upload-btn and other interactions
}
