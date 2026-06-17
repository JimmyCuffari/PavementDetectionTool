import { getToken }                                   from './auth.js';
import { getCurrentProject }                          from './project-manager.js';
import { getCurrentDataset, getDatasetRawDataFolder } from './dataset-manager.js';
import { toast }                                      from './utils.js';

// ── Module state ───────────────────────────────────────────────────────────────

let _state = { roadMapData: null };

// ── Entry point ────────────────────────────────────────────────────────────────

export function renderRoadMap(container) {
  container.innerHTML = `
    <div style="max-width:700px;">
      <p class="section-title">Road Map</p>
      <p class="text-dim" style="font-size:13px;margin-bottom:1.5rem;">
        Create a flattened road map using images and homography data.
      </p>

      <div class="pd-placeholder">
        <p class="pd-placeholder-icon">&#128506;</p>
        <p class="pd-placeholder-title">Coming Soon</p>
        <p class="pd-placeholder-sub">Flattened road map generation will be implemented here.</p>
      </div>

      <div class="flex-row" style="margin-top:1rem;">
        <button class="btn btn-primary btn-sm" id="prm-generate-btn" disabled>Generate Road Map</button>
      </div>
    </div>
  `;

  wireEvents(container);
}

// ── Events ─────────────────────────────────────────────────────────────────────

function wireEvents(container) {
  // TODO: wire prm-generate-btn and canvas/map display interactions
}
