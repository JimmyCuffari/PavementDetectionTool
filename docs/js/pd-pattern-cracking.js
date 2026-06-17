import { getToken }                                   from './auth.js';
import { getCurrentProject }                          from './project-manager.js';
import { getCurrentDataset, getDatasetRawDataFolder } from './dataset-manager.js';
import { toast }                                      from './utils.js';

// ── Module state ───────────────────────────────────────────────────────────────

let _state = { crackingResult: null };

// ── Entry point ────────────────────────────────────────────────────────────────

export function renderPatternCracking(container) {
  container.innerHTML = `
    <div style="max-width:700px;">
      <p class="section-title">Pattern Cracking</p>
      <p class="text-dim" style="font-size:13px;margin-bottom:1.5rem;">
        Determine pattern cracking classification from detected cracks.
      </p>

      <div class="pd-placeholder">
        <p class="pd-placeholder-icon">&#9762;</p>
        <p class="pd-placeholder-title">Coming Soon</p>
        <p class="pd-placeholder-sub">Pattern cracking analysis will be implemented here.</p>
      </div>

      <div class="flex-row" style="margin-top:1rem;">
        <button class="btn btn-primary btn-sm" id="ppc-analyze-btn" disabled>Analyze Cracking</button>
      </div>
    </div>
  `;

  wireEvents(container);
}

// ── Events ─────────────────────────────────────────────────────────────────────

function wireEvents(container) {
  // TODO: wire ppc-analyze-btn and results display
}
