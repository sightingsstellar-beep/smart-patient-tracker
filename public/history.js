/**
 * history.js — 7-day history dashboard
 *
 * Fetches /api/history?days=7 on load and renders day cards.
 * Clock ticks every second. No auto-refresh (user can tap 🔄).
 */

'use strict';

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

function updateClock() {
  const now = new Date();
  const timeEl = document.getElementById('current-time');
  const dateEl = document.getElementById('current-date');

  timeEl.textContent = now.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  dateEl.textContent = now.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

setInterval(updateClock, 1000);
updateClock();

// ---------------------------------------------------------------------------
// Fluid type labels
// ---------------------------------------------------------------------------

const FLUID_LABELS = {
  water: 'Water',
  juice: 'Juice',
  vitamin_water: 'Vitamin Water',
  milk: 'Milk',
  pediasure: 'PediaSure',
  yogurt_drink: 'Yogurt Drink',
  urine: 'Urine',
  poop: 'Poop',
  vomit: 'Vomit',
};

const OUTPUT_ICONS = { urine: '💛', poop: '💩', vomit: '🤢' };

function fluidLabel(type) {
  return FLUID_LABELS[type] || type;
}

// ---------------------------------------------------------------------------
// Data fetch
// ---------------------------------------------------------------------------

async function loadHistory() {
  const container = document.getElementById('history-container');
  container.innerHTML = '<div class="h-loading">Loading history…</div>';

  try {
    const res = await fetch('/api/history?days=7');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (!data.ok || !Array.isArray(data.days)) {
      throw new Error('Invalid response from server');
    }

    renderHistory(data.days);

    document.getElementById('last-updated').textContent = new Date().toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
    });
  } catch (err) {
    console.error('[history] Fetch error:', err.message);
    container.innerHTML = `<div class="h-error">⚠️ Failed to load history: ${err.message}</div>`;
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderHistory(days) {
  const container = document.getElementById('history-container');
  container.innerHTML = '';

  if (!days || days.length === 0) {
    container.innerHTML = '<div class="h-loading">No history found.</div>';
    return;
  }

  days.forEach((day, index) => {
    const prevDay = days[index + 1] || null; // previous day (older)
    const card = buildDayCard(day, prevDay);
    container.appendChild(card);
  });
}

// ---------------------------------------------------------------------------
// Day card builder
// ---------------------------------------------------------------------------

function buildDayCard(day, prevDay) {
  const card = document.createElement('div');
  card.className = 'day-card card' + (day.isToday ? ' is-today' : '');

  // ---- Header ----
  const header = document.createElement('div');
  header.className = 'day-card-header';
  header.innerHTML = `
    <span class="day-label">${day.label}</span>
    ${day.isToday ? '<span class="today-badge">Today</span>' : ''}
  `;
  card.appendChild(header);

  // Check if the day is completely empty
  const hasAnyData = (
    day.intake.total_ml > 0 ||
    day.outputs.length > 0 ||
    day.gagCount > 0 ||
    day.wellness.afternoon !== null ||
    day.wellness.evening !== null
  );

  if (!hasAnyData && !day.isToday) {
    card.classList.add('day-card-empty');
    const emptyBody = document.createElement('div');
    emptyBody.className = 'h-empty-body';
    emptyBody.textContent = 'No data logged for this day.';
    card.appendChild(emptyBody);
    return card;
  }

  // ---- Sections: Intake → Outputs → Gags → Wellness ----
  card.appendChild(buildIntakeSection(day.intake, day.inputs));
  card.appendChild(buildOutputsSection(day.outputs));
  card.appendChild(buildGagSection(day.gagCount, day.gags));
  card.appendChild(buildWellnessSection(day.wellness, prevDay ? prevDay.wellness : null));

  // ---- Wire up accordion toggle ----
  setupAccordion(card);

  return card;
}

// ---------------------------------------------------------------------------
// Accordion setup
// ---------------------------------------------------------------------------

function setupAccordion(card) {
  card.querySelectorAll('.section-header').forEach((header) => {
    header.addEventListener('click', () => {
      const section = header.closest('.accordion-section');
      const isOpen = section.classList.contains('open');

      // Close all sections in this card
      card.querySelectorAll('.accordion-section').forEach((s) => {
        s.classList.remove('open');
        s.querySelector('.section-header').setAttribute('aria-expanded', 'false');
        s.querySelector('.section-detail').setAttribute('aria-hidden', 'true');
      });

      // Open the tapped section if it was closed
      if (!isOpen) {
        section.classList.add('open');
        header.setAttribute('aria-expanded', 'true');
        section.querySelector('.section-detail').setAttribute('aria-hidden', 'false');
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Section builder helpers
// ---------------------------------------------------------------------------

/**
 * Creates a standard accordion day-section element.
 * @param {string} labelText  — plain text for the small all-caps label
 * @param {string} summaryHTML — HTML rendered in the always-visible summary row
 * @param {string} detailHTML  — HTML rendered inside the expand/collapse panel
 */
function createAccordionSection(labelText, summaryHTML, detailHTML) {
  const section = document.createElement('div');
  section.className = 'day-section accordion-section';
  section.innerHTML = `
    <div class="section-header" role="button" tabindex="0" aria-expanded="false">
      <div class="section-header-content">
        <div class="day-section-label">${labelText}</div>
        <div class="section-summary">${summaryHTML}</div>
      </div>
      <span class="section-chevron" aria-hidden="true">▶</span>
    </div>
    <div class="section-detail" aria-hidden="true">
      <div class="section-detail-inner">
        ${detailHTML}
      </div>
    </div>
  `;
  return section;
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

// --- Intake section ---

function buildIntakeSection(intake, inputs) {
  const { total_ml, limit_ml, percent } = intake;

  // Progress bar
  const barWidth = Math.min(percent, 100);
  let colorClass = '';
  if (total_ml > limit_ml)   colorClass = 'over';
  else if (percent >= 90)    colorClass = 'red';
  else if (percent >= 70)    colorClass = 'yellow';

  const summaryHTML = `
    <div class="h-intake-row">
      <span class="h-intake-numbers">${total_ml} / ${limit_ml}ml</span>
      <div class="h-progress-wrap">
        <div class="h-progress-bar ${colorClass}" style="width:${barWidth}%"></div>
      </div>
      <span class="h-intake-pct">${percent}%</span>
    </div>
  `;

  // Detail: full timestamped list
  const entries = inputs || [];
  let detailHTML;
  if (entries.length === 0) {
    detailHTML = '<p class="h-detail-empty">No intake logged</p>';
  } else {
    const rows = entries.map((input) => {
      const amount = input.amount_ml ? `${input.amount_ml}ml` : '';
      const label = [fluidLabel(input.fluid_type), amount].filter(Boolean).join(' ');
      return `<div class="h-detail-row">
        <span class="h-detail-time">${input.time}</span>
        <span class="h-detail-label">— ${label}</span>
      </div>`;
    }).join('');
    detailHTML = `<div class="h-detail-list">${rows}</div>`;
  }

  return createAccordionSection('💧 Intake', summaryHTML, detailHTML);
}

// --- Outputs section ---

function buildOutputsSection(outputs) {
  // Summary: type counts
  let summaryHTML;
  if (outputs.length === 0) {
    summaryHTML = '<span class="h-none">None logged</span>';
  } else {
    const counts = {};
    outputs.forEach((o) => {
      counts[o.fluid_type] = (counts[o.fluid_type] || 0) + 1;
    });
    const parts = Object.entries(counts).map(([type, cnt]) => {
      const icon = OUTPUT_ICONS[type] || '🚽';
      return `${icon}\u2009${fluidLabel(type)}${cnt > 1 ? ' \xd7' + cnt : ''}`;
    });
    summaryHTML = `<span class="h-output-summary">${parts.join('<span class="h-dot"> · </span>')}</span>`;
  }

  // Detail: full timestamped list
  let detailHTML;
  if (outputs.length === 0) {
    detailHTML = '<p class="h-detail-empty">No outputs logged</p>';
  } else {
    const rows = outputs.map((o) => {
      const icon = OUTPUT_ICONS[o.fluid_type] || '🚽';
      const amount = o.amount_ml ? `<span class="h-detail-value">${o.amount_ml}ml</span>` : '';
      return `<div class="h-detail-row">
        <span class="h-detail-time">${o.time}</span>
        <span class="h-detail-icon">${icon}</span>
        <span class="h-detail-label">${fluidLabel(o.fluid_type)}</span>
        ${amount}
      </div>`;
    }).join('');
    detailHTML = `<div class="h-detail-list">${rows}</div>`;
  }

  return createAccordionSection('🚽 Outputs', summaryHTML, detailHTML);
}

// --- Gag section ---

function buildGagSection(gagCount, gags) {
  const summaryHTML = gagCount > 0
    ? `<span class="h-gag-count">🤢 ${gagCount} gag episode${gagCount !== 1 ? 's' : ''}</span>`
    : '<span class="h-gag-none">None</span>';

  let detailHTML;
  const entries = gags || [];
  if (entries.length === 0) {
    detailHTML = '<p class="h-detail-empty">No gag episodes</p>';
  } else {
    const items = entries.map((gag) =>
      `<div class="h-detail-row h-gag-detail-row">
        <span class="h-detail-time">${gag.time}</span>
        <span class="h-detail-label">— Gag episode</span>
      </div>`
    ).join('');
    detailHTML = `<div class="h-detail-list">${items}</div>`;
  }

  return createAccordionSection('🤢 Gags', summaryHTML, detailHTML);
}

// --- Wellness section ---

function buildWellnessSection(wellness, prevWellness) {
  const { afternoon, evening } = wellness;

  // Summary
  let summaryHTML;
  if (!afternoon && !evening) {
    summaryHTML = '<span class="h-wellness-none">No wellness check logged</span>';
  } else if (afternoon && evening) {
    summaryHTML = '<span class="h-wellness-ok">✓ Both checks logged</span>';
  } else if (afternoon) {
    summaryHTML = '<span class="h-wellness-partial">Afternoon check only</span>';
  } else {
    summaryHTML = '<span class="h-wellness-partial">Evening check only</span>';
  }

  // Trend helpers — compare this evening vs previous day's evening
  const prevEvening = prevWellness ? prevWellness.evening : null;

  function trendIcon(field) {
    const curr = evening ? evening[field] : null;
    const prev = prevEvening ? prevEvening[field] : null;
    if (curr === null || curr === undefined || prev === null || prev === undefined) return '';
    if (curr > prev) return '<span class="h-trend h-trend-up" title="Improved vs yesterday">↑</span>';
    if (curr < prev) return '<span class="h-trend h-trend-down" title="Declined vs yesterday">↓</span>';
    return '<span class="h-trend h-trend-flat" title="Same as yesterday">→</span>';
  }

  const FIELD_LABELS = { appetite: 'Appetite', energy: 'Energy', mood: 'Mood', cyanosis: 'Cyanosis' };
  const FIELDS = ['appetite', 'energy', 'mood', 'cyanosis'];

  function wellnessCheckHTML(check, label, showTrend) {
    if (!check) {
      return `<div class="h-wellness-check">
        <div class="h-wellness-check-label">${label}</div>
        <div class="h-wellness-check-none">Not logged</div>
      </div>`;
    }
    const scores = FIELDS.map((f) => {
      const v = (check[f] !== null && check[f] !== undefined) ? check[f] : '—';
      const trend = showTrend ? trendIcon(f) : '';
      return `<div class="h-wellness-score">
        <span class="h-score-label">${FIELD_LABELS[f]}</span>
        <span class="h-score-val">${v}${trend}</span>
      </div>`;
    }).join('');
    return `<div class="h-wellness-check">
      <div class="h-wellness-check-label">${label}</div>
      <div class="h-wellness-scores">${scores}</div>
    </div>`;
  }

  let detailHTML;
  if (!afternoon && !evening) {
    detailHTML = '<p class="h-detail-empty">No wellness checks logged</p>';
  } else {
    detailHTML =
      wellnessCheckHTML(afternoon, 'Afternoon (5pm)', false) +
      wellnessCheckHTML(evening, 'Evening (10pm)', true);
  }

  return createAccordionSection('❤️ Wellness', summaryHTML, detailHTML);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

loadHistory();

document.getElementById('refresh-btn').addEventListener('click', loadHistory);
