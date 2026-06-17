import { getToken }            from './auth.js';
import { getCurrentProject }  from './project-manager.js';
import { getCurrentDataset }  from './dataset-manager.js';
import { toast }              from './utils.js';

// ── Module state ───────────────────────────────────────────────────────────────

let _state = { metrics: null };

// ── Entry point ────────────────────────────────────────────────────────────────

export function renderMetrics(container) {
  container.innerHTML = `
    <div style="max-width:700px;">
      <p class="section-title">Metrics</p>
      <p class="text-dim" style="font-size:13px;margin-bottom:1.5rem;">
        Compute and display overall distress metrics for the section.
      </p>

      <div class="pd-placeholder">
        <p class="pd-placeholder-icon">&#128200;</p>
        <p class="pd-placeholder-title">Coming Soon</p>
        <p class="pd-placeholder-sub">Distress metrics and reporting will be implemented here.</p>
      </div>

      <div class="flex-row" style="margin-top:1rem;">
        <button class="btn btn-primary btn-sm" id="pm-compute-btn" disabled>Compute Metrics</button>
      </div>
    </div>
  `;

  wireEvents(container);
}

// ── Events ─────────────────────────────────────────────────────────────────────

function wireEvents(container) {
  // TODO: wire pm-compute-btn and stat display (reuse .stat-row/.stat pattern)
}
