import { toast }   from './utils.js';
import { pdState } from './pd-state.js';

export function renderHomography(container) {
  container.innerHTML = `
    <div style="max-width:700px;">
      <p class="section-title">Homography Calibration</p>
      <p class="text-dim" style="font-size:13px;margin-bottom:1rem;">
        Upload the homography JSON file produced by the calibration tool.
        It must contain an <code style="background:var(--bg-elevated);padding:0.1rem 0.3rem;border-radius:3px;font-size:11px;">H</code>
        matrix and <code style="background:var(--bg-elevated);padding:0.1rem 0.3rem;border-radius:3px;font-size:11px;">calibration_points</code> array.
      </p>

      <label class="file-pick-area" id="ph-drop" style="display:block;cursor:pointer;">
        <input type="file" id="ph-file-input" accept=".json" />
        <div class="pick-icon">&#128196;</div>
        <div class="pick-label">Drop homography JSON here, or click to browse</div>
        <div class="pick-sub" id="ph-file-name">No file selected</div>
      </label>

      <div id="ph-preview" class="hidden" style="margin-top:1rem;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);padding:0.75rem;">
        <p class="section-title" style="margin-bottom:0.5rem;">Loaded</p>
        <div id="ph-preview-content" style="font-size:12px;color:var(--text-dim);font-family:monospace;"></div>
      </div>
    </div>
  `;

  wireEvents(container);
}

function wireEvents(container) {
  const input   = container.querySelector('#ph-file-input');
  const drop    = container.querySelector('#ph-drop');
  const nameEl  = container.querySelector('#ph-file-name');
  const preview = container.querySelector('#ph-preview');
  const previewContent = container.querySelector('#ph-preview-content');

  const loadFile = async (file) => {
    if (!file || !file.name.endsWith('.json')) {
      toast('Please select a JSON file', 'error');
      return;
    }
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed.H) || !Array.isArray(parsed.calibration_points)) {
        toast('JSON must contain "H" matrix and "calibration_points" array', 'error');
        return;
      }
      pdState.homography = parsed;
      nameEl.textContent = file.name;
      const pts = parsed.calibration_points.length;
      const unit = parsed.unit || 'in';
      previewContent.textContent =
        `H matrix: 3×3  |  ${pts} calibration point${pts === 1 ? '' : 's'}  |  unit: ${unit}`;
      preview.classList.remove('hidden');
      toast('Homography loaded', 'success');
    } catch (err) {
      toast(`Failed to parse JSON: ${err.message}`, 'error');
    }
  };

  input.onchange = () => loadFile(input.files?.[0]);

  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) loadFile(file);
  });
}
