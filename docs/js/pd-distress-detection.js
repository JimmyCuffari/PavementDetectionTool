import { getToken }                                   from './auth.js';
import { getCurrentProject }                          from './project-manager.js';
import { getCurrentDataset, getDatasetRawDataFolder } from './dataset-manager.js';
import { toast }                                      from './utils.js';

// ── Module state ───────────────────────────────────────────────────────────────

let _state = { showMasks: true, showBoxes: true, detections: [] };

// ── Entry point ────────────────────────────────────────────────────────────────

export function renderDistressDetection(container) {
  container.innerHTML = `
    <div style="max-width:700px;">
      <p class="section-title">Distress Detection</p>
      <p class="text-dim" style="font-size:13px;margin-bottom:1.5rem;">
        Detect and measure distresses; toggle segmentation masks and bounding boxes.
      </p>

      <div class="pd-placeholder">
        <p class="pd-placeholder-icon">&#128269;</p>
        <p class="pd-placeholder-title">Coming Soon</p>
        <p class="pd-placeholder-sub">Distress detection and measurement will be implemented here.</p>
      </div>

      <div class="flex-row" style="margin-top:1rem;gap:0.5rem;">
        <button class="btn btn-ghost btn-sm" id="pdd-toggle-masks-btn" disabled>Hide Masks</button>
        <button class="btn btn-ghost btn-sm" id="pdd-toggle-boxes-btn" disabled>Hide Boxes</button>
        <button class="btn btn-primary btn-sm" id="pdd-detect-btn" disabled>Run Detection</button>
      </div>
    </div>
  `;

  wireEvents(container);
}

// ── Events ─────────────────────────────────────────────────────────────────────

function wireEvents(container) {
  // TODO: wire pdd-detect-btn, pdd-toggle-masks-btn, pdd-toggle-boxes-btn
  // Toggle example:
  // container.querySelector('#pdd-toggle-masks-btn').addEventListener('click', () => {
  //   _state.showMasks = !_state.showMasks;
  // });
}
