import { renderImageUpload }        from './pd-image-upload.js';
import { renderHomography }         from './pd-homography.js';
import { renderRoadMap }            from './pd-road-map.js';
import { renderDistressDetection }  from './pd-distress-detection.js';
import { renderPatternCracking }    from './pd-pattern-cracking.js';
import { renderWheelPath }          from './pd-wheel-path.js';
import { renderMetrics }            from './pd-metrics.js';

// ── Entry point ────────────────────────────────────────────────────────────────

export function renderProcessData(container) {
  container.innerHTML = `
    <nav class="subtab-nav" id="pd-nav">
      <button class="subtab-btn active" data-pd-step="upload">Image Upload</button>
      <button class="subtab-btn"        data-pd-step="homography">Homography</button>
      <button class="subtab-btn"        data-pd-step="road-map">Road Map</button>
      <button class="subtab-btn"        data-pd-step="detection">Distress Detection</button>
      <button class="subtab-btn"        data-pd-step="cracking">Pattern Cracking</button>
      <button class="subtab-btn"        data-pd-step="wheel-path">Wheel Path</button>
      <button class="subtab-btn"        data-pd-step="metrics">Metrics</button>
    </nav>

    <div id="pd-step-upload"      class="pd-panel"></div>
    <div id="pd-step-homography"  class="pd-panel pd-hidden"></div>
    <div id="pd-step-road-map"    class="pd-panel pd-hidden"></div>
    <div id="pd-step-detection"   class="pd-panel pd-hidden"></div>
    <div id="pd-step-cracking"    class="pd-panel pd-hidden"></div>
    <div id="pd-step-wheel-path"  class="pd-panel pd-hidden"></div>
    <div id="pd-step-metrics"     class="pd-panel pd-hidden"></div>
  `;

  // Private navigation — scoped to this container, does not touch global .subtab-panel elements
  container.querySelectorAll('[data-pd-step]').forEach(btn =>
    btn.addEventListener('click', () => switchPdStep(container, btn.dataset.pdStep))
  );

  // Render each component into its assigned container
  renderImageUpload(container.querySelector('#pd-step-upload'));
  renderHomography(container.querySelector('#pd-step-homography'));
  renderRoadMap(container.querySelector('#pd-step-road-map'));
  renderDistressDetection(container.querySelector('#pd-step-detection'));
  renderPatternCracking(container.querySelector('#pd-step-cracking'));
  renderWheelPath(container.querySelector('#pd-step-wheel-path'));
  renderMetrics(container.querySelector('#pd-step-metrics'));
}

// ── Internal navigation ────────────────────────────────────────────────────────

function switchPdStep(container, step) {
  container.querySelectorAll('[data-pd-step]').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.pdStep === step)
  );
  container.querySelectorAll('.pd-panel').forEach(panel =>
    panel.classList.toggle('pd-hidden', panel.id !== `pd-step-${step}`)
  );
}
