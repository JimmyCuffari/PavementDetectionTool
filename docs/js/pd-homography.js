import { getToken }                                   from './auth.js';
import { getCurrentProject }                          from './project-manager.js';
import { getCurrentDataset, getDatasetRawDataFolder } from './dataset-manager.js';
import { toast }                                      from './utils.js';

// ── Module state ───────────────────────────────────────────────────────────────

let _state = { calibrationFile: null };

// ── Entry point ────────────────────────────────────────────────────────────────

export function renderHomography(container) {
  container.innerHTML = `
    <div style="max-width:700px;">
      <p class="section-title">Homography</p>
      <p class="text-dim" style="font-size:13px;margin-bottom:1.5rem;">
        Select or upload a homography calibration JSON file.
      </p>

      <div class="pd-placeholder">
        <p class="pd-placeholder-icon">&#128196;</p>
        <p class="pd-placeholder-title">Coming Soon</p>
        <p class="pd-placeholder-sub">Homography calibration selection will be implemented here.</p>
      </div>

      <div class="flex-row" style="margin-top:1rem;">
        <button class="btn btn-primary btn-sm" id="ph-select-btn" disabled>Select Calibration File</button>
      </div>
    </div>
  `;

  wireEvents(container);
}

// ── Events ─────────────────────────────────────────────────────────────────────

function wireEvents(container) {
  // TODO: wire ph-select-btn and file input interactions
}
