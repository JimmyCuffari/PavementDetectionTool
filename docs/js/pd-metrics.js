import { pdState } from './pd-state.js';

export function renderMetrics(container) {
  container.innerHTML = `
    <div style="max-width:820px;">
      <p class="section-title">PSCI Metrics</p>
      <p class="text-dim" style="font-size:13px;margin-bottom:1rem;">
        Per-section Pavement Surface Condition Index, computed from dark-pixel
        crack detection on the stitched road map.
      </p>

      <div id="pm-no-results" class="text-dim" style="font-size:13px;margin-bottom:1rem;">
        Generate a road map first — results will appear here automatically.
      </div>

      <div id="pm-results" class="hidden">
        <div class="stat-row" id="pm-summary-stats"></div>

        <p class="section-title" style="margin-top:1.5rem;">Per-Section Breakdown</p>
        <div style="overflow-x:auto;">
          <table class="summary-table" id="pm-section-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Start (ft)</th>
                <th>End (ft)</th>
                <th>PSCI</th>
                <th>Condition</th>
                <th>Cracks</th>
                <th>Crack rate</th>
              </tr>
            </thead>
            <tbody id="pm-section-body"></tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  wireEvents(container);
}

function wireEvents(container) {
  // Poll pdState for results whenever this panel becomes visible
  // (the subtab click fires a DOM event we can observe via MutationObserver)
  const observer = new MutationObserver(() => {
    if (!container.closest('.pd-panel')?.classList.contains('pd-hidden')) {
      renderResults(container);
    }
  });
  const panel = container.closest('.pd-panel');
  if (panel) observer.observe(panel, { attributeFilter: ['class'] });

  // Also render immediately in case results already exist
  renderResults(container);
}

function psciLabel(psci) {
  if (psci >= 80) return { text: 'Good',     color: '#81C784' };
  if (psci >= 60) return { text: 'Fair',     color: '#FFD54F' };
  if (psci >= 40) return { text: 'Poor',     color: '#FFB74D' };
  return              { text: 'Very Poor', color: '#EF5350' };
}

function renderResults(container) {
  const { result } = pdState;
  const noResults = container.querySelector('#pm-no-results');
  const resultsEl = container.querySelector('#pm-results');

  if (!result?.sections?.length) {
    noResults.classList.remove('hidden');
    resultsEl.classList.add('hidden');
    return;
  }

  noResults.classList.add('hidden');
  resultsEl.classList.remove('hidden');

  const sections = result.sections;
  const avgPsci  = sections.reduce((s, r) => s + r.psci, 0) / sections.length;
  const minPsci  = Math.min(...sections.map(r => r.psci));
  const totalFt  = sections.at(-1)?.ft_end ?? 0;
  const badCount = sections.filter(s => s.psci < 60).length;

  const lbl = psciLabel(avgPsci);
  container.querySelector('#pm-summary-stats').innerHTML = `
    <div class="stat"><div class="stat-label">Sections</div><div class="stat-value">${sections.length}</div></div>
    <div class="stat"><div class="stat-label">Length</div><div class="stat-value">${totalFt.toFixed(0)} ft</div></div>
    <div class="stat"><div class="stat-label">Avg PSCI</div><div class="stat-value" style="color:${lbl.color}">${avgPsci.toFixed(1)}</div></div>
    <div class="stat"><div class="stat-label">Min PSCI</div><div class="stat-value" style="color:${psciLabel(minPsci).color}">${minPsci.toFixed(1)}</div></div>
    <div class="stat"><div class="stat-label">Below Fair</div><div class="stat-value" style="color:${badCount ? '#FFB74D' : 'inherit'}">${badCount}</div></div>
  `;

  container.querySelector('#pm-section-body').innerHTML = sections.map(s => {
    const { text, color } = psciLabel(s.psci);
    return `
      <tr>
        <td>${s.section}</td>
        <td>${s.ft_start}</td>
        <td>${s.ft_end}</td>
        <td style="font-weight:600;color:${color}">${s.psci.toFixed(1)}</td>
        <td><span class="badge" style="background:${color}22;color:${color}">${text}</span></td>
        <td>${s.crack_count}</td>
        <td>${s.crack_rate.toFixed(1)}%</td>
      </tr>
    `;
  }).join('');
}
