import { getToken }                                   from './auth.js';
import { getCurrentProject }                          from './project-manager.js';
import { getCurrentDataset, getDatasetRawDataFolder } from './dataset-manager.js';
import { toast }                                      from './utils.js';

// ── Module state ───────────────────────────────────────────────────────────────

let _state = { wheelPath: null };

// ── Entry point ────────────────────────────────────────────────────────────────

export function renderWheelPath(container) {
  container.innerHTML = `
    <div style="max-width:700px;">
      <p class="section-title">Wheel Path</p>
      <p class="text-dim" style="font-size:13px;margin-bottom:1.5rem;">
        Set the wheel path zone for the section.
      </p>

      <div class="pd-placeholder">
        <p class="pd-placeholder-icon">&#127963;</p>
        <p class="pd-placeholder-title">Coming Soon</p>
        <p class="pd-placeholder-sub">Wheel path definition will be implemented here.</p>
      </div>

      <div class="flex-row" style="margin-top:1rem;">
        <button class="btn btn-primary btn-sm" id="pwp-set-btn" disabled>Set Wheel Path</button>
      </div>
    </div>
  `;

  wireEvents(container);
}

// ── Events ─────────────────────────────────────────────────────────────────────

function wireEvents(container) {
  // TODO: wire pwp-set-btn and interactive overlay/canvas interactions
}
