/**
 * app.js — Dashboard frontend
 *
 * Polls /api/today every 30 seconds and updates the UI.
 * Also handles quick-log button actions.
 */

'use strict';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let lastData = null;
let pendingQuickLog = null; // { type, fluid_type, amount_ml }

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
// Data fetching
// ---------------------------------------------------------------------------

async function fetchToday() {
  try {
    const res = await fetch('/api/today');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    lastData = data;
    renderAll(data);
    document.getElementById('last-updated').textContent = new Date().toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
    });
    document.getElementById('refresh-badge').style.opacity = '1';
  } catch (err) {
    console.error('[dashboard] Fetch error:', err.message);
    document.getElementById('refresh-badge').style.opacity = '0.3';
  }
}

// Load child name from settings on page load
async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    if (!res.ok) return;
    const settings = await res.json();
    const nameEl = document.getElementById('child-name');
    if (nameEl && settings.child_name) {
      nameEl.textContent = settings.child_name;
    }
  } catch (_) {}
}

// Auto-refresh every 30 seconds
setInterval(fetchToday, 30000);
loadSettings();
fetchToday();

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function renderAll(data) {
  renderIntake(data);
  renderOutputs(data.outputs || []);
  renderGags(data.gags || [], data.gagCount || 0);
  renderWellness(data.wellness || []);
}

// --- Intake section ---

function renderIntake(data) {
  const total = data.totalIntake || 0;
  const limit = data.limit_ml || 1200;
  const pct = Math.min(Math.round((total / limit) * 100), 150); // cap display at 150%

  document.getElementById('intake-amount').textContent = `${total} ml`;
  document.getElementById('intake-pct').textContent = `${Math.round((total / limit) * 100)}%`;
  const limitEl = document.getElementById('intake-limit');
  if (limitEl) limitEl.textContent = `/ ${limit} ml`;

  const bar = document.getElementById('progress-bar');
  bar.style.width = `${Math.min(pct, 100)}%`;
  bar.setAttribute('aria-valuenow', pct);

  // Color coding
  bar.classList.remove('yellow', 'red', 'over-limit');
  const warning = document.getElementById('over-limit-warning');

  if (total > limit) {
    bar.classList.add('over-limit');
    warning.style.display = 'block';
  } else if (pct >= 90) {
    bar.classList.add('red');
    warning.style.display = 'none';
  } else if (pct >= 70) {
    bar.classList.add('yellow');
    warning.style.display = 'none';
  } else {
    warning.style.display = 'none';
  }

  // Intake by type
  renderFluidTypes(data.intakeByType || {});
}

const FLUID_LABELS = {
  water: 'Water',
  juice: 'Juice',
  vitamin_water: 'Vitamin Water',
  milk: 'Milk',
  pediasure: 'PediaSure',
  yogurt_drink: 'Yogurt Drink',
};

function renderFluidTypes(intakeByType) {
  const container = document.getElementById('fluid-types');
  container.innerHTML = '';

  const entries = Object.entries(intakeByType).filter(([, ml]) => ml > 0);

  if (entries.length === 0) {
    container.innerHTML = '<div class="empty-state" style="text-align:left;font-style:normal;color:#5f6368;">No intake logged yet</div>';
    return;
  }

  for (const [type, ml] of entries) {
    const card = document.createElement('div');
    card.className = 'fluid-type-card';
    card.innerHTML = `
      <div class="fluid-type-name">${FLUID_LABELS[type] || type}</div>
      <div class="fluid-type-amount">${ml}ml</div>
    `;
    container.appendChild(card);
  }
}

// --- Outputs ---

const OUTPUT_ICONS = { urine: '💛', poop: '💩', vomit: '🤢' };
const OUTPUT_LABELS = { urine: 'Urine', poop: 'Poop', vomit: 'Vomit' };

function renderOutputs(outputs) {
  const list = document.getElementById('output-list');
  const badge = document.getElementById('output-count');

  badge.textContent = outputs.length;
  list.innerHTML = '';

  if (outputs.length === 0) {
    list.innerHTML = '<li class="empty-state">No outputs logged today</li>';
    return;
  }

  for (const o of outputs) {
    const li = document.createElement('li');
    li.className = 'output-item';
    const amount = o.amount_ml ? `${o.amount_ml}ml` : '';
    li.innerHTML = `
      <span class="output-time">${o.time}</span>
      <span class="output-type-icon">${OUTPUT_ICONS[o.fluid_type] || '🚽'}</span>
      <span class="output-type">${OUTPUT_LABELS[o.fluid_type] || o.fluid_type}</span>
      <span class="output-amount">${amount}</span>
    `;
    list.appendChild(li);
  }
}

// --- Gags ---

function renderGags(gags, count) {
  const list = document.getElementById('gag-list');
  const badge = document.getElementById('gag-count');

  badge.textContent = count;
  list.innerHTML = '';

  if (gags.length === 0) {
    list.innerHTML = '<li class="empty-state">No gag episodes today</li>';
    return;
  }

  for (const g of gags) {
    const li = document.createElement('li');
    li.className = 'gag-item';
    li.innerHTML = `
      <span class="gag-time">${g.time}</span>
      <span>Gag episode</span>
    `;
    list.appendChild(li);
  }
}

// --- Wellness ---

const WELLNESS_FIELDS = [
  { key: 'appetite', label: 'Appetite' },
  { key: 'energy',   label: 'Energy' },
  { key: 'mood',     label: 'Mood' },
  { key: 'cyanosis', label: 'Cyanosis' },
];

function gaugeColor(value) {
  if (value <= 3) return 'gauge-low';
  if (value <= 6) return 'gauge-mid';
  return 'gauge-high';
}

function renderWellness(wellnessArr) {
  const grid = document.getElementById('wellness-grid');
  const emptyEl = document.getElementById('wellness-empty');
  const labelEl = document.getElementById('wellness-label');

  grid.innerHTML = '';

  if (!wellnessArr || wellnessArr.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'wellness-empty';
    empty.textContent = 'No wellness check logged yet';
    grid.appendChild(empty);
    labelEl.textContent = '--';
    return;
  }

  const latest = wellnessArr[wellnessArr.length - 1];
  labelEl.textContent = latest.check_time + ' check';

  for (const field of WELLNESS_FIELDS) {
    const value = latest[field.key];
    if (value === null || value === undefined) continue;

    const gauge = document.createElement('div');
    gauge.className = 'wellness-gauge';
    const colorClass = gaugeColor(value);
    const widthPct = (value / 10) * 100;

    gauge.innerHTML = `
      <div class="wellness-gauge-label">${field.label}</div>
      <div>
        <span class="wellness-gauge-value">${value}</span>
        <span class="wellness-gauge-max">/10</span>
      </div>
      <div class="wellness-gauge-bar">
        <div class="wellness-gauge-fill ${colorClass}" style="width: ${widthPct}%"></div>
      </div>
    `;
    grid.appendChild(gauge);
  }
}

// ---------------------------------------------------------------------------
// Quick Log buttons
// ---------------------------------------------------------------------------

document.querySelectorAll('.quick-btn').forEach((btn) => {
  btn.addEventListener('click', () => handleQuickLog(btn));
});

function handleQuickLog(btn) {
  const type = btn.dataset.type;
  const fluid = btn.dataset.fluid;
  const amount = btn.dataset.amount ? parseFloat(btn.dataset.amount) : null;
  const count = btn.dataset.count ? parseInt(btn.dataset.count, 10) : null;

  if (type === 'gag') {
    submitQuickLog({ type: 'gag', count: count || 1 }, btn);
    return;
  }

  if (!amount) {
    // Ask for amount — applies to inputs and outputs without a preset amount
    pendingQuickLog = { type, fluid_type: fluid };
    showModal();
    return;
  }

  submitQuickLog({ type, fluid_type: fluid, amount_ml: amount }, btn);
}

async function submitQuickLog(payload, btn) {
  // Build the API payload
  let body;
  if (payload.type === 'gag') {
    body = { type: 'gag', count: payload.count };
  } else {
    body = {
      entry_type: payload.type,
      fluid_type: payload.fluid_type,
      amount_ml: payload.amount_ml || null,
    };
  }

  const originalText = btn ? btn.textContent : '';
  if (btn) {
    btn.textContent = '⏳';
    btn.disabled = true;
  }

  try {
    const res = await fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    if (btn) {
      btn.classList.add('success');
      btn.textContent = '✅';
      setTimeout(() => {
        btn.textContent = originalText;
        btn.classList.remove('success');
        btn.disabled = false;
      }, 1500);
    }

    // Refresh data
    await fetchToday();
  } catch (err) {
    console.error('[quick-log] Error:', err.message);
    if (btn) {
      btn.textContent = '❌';
      setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
      }, 2000);
    }
  }
}

// Amount modal
function showModal() {
  document.getElementById('amount-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('amount-input').focus(), 100);
}

function hideModal() {
  document.getElementById('amount-modal').style.display = 'none';
  document.getElementById('amount-input').value = '';
  pendingQuickLog = null;
}

document.getElementById('modal-cancel').addEventListener('click', hideModal);

document.getElementById('modal-confirm').addEventListener('click', () => {
  const val = parseFloat(document.getElementById('amount-input').value);
  if (pendingQuickLog) {
    const payload = { ...pendingQuickLog, amount_ml: isNaN(val) ? null : val };
    hideModal();
    submitQuickLog(payload, null);
  }
});

document.getElementById('amount-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('modal-confirm').click();
  if (e.key === 'Escape') hideModal();
});

// Close modal on backdrop click
document.getElementById('amount-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) hideModal();
});

// ---------------------------------------------------------------------------
// Undo last entry
// ---------------------------------------------------------------------------

document.getElementById('undo-btn').addEventListener('click', async () => {
  const btn = document.getElementById('undo-btn');

  // Find the most recent entry from lastData — tag each with its kind
  // so we can route the delete to the correct endpoint.
  const allEntries = [
    ...(lastData?.inputs  || []).map(e => ({ ...e, _kind: 'fluid' })),
    ...(lastData?.outputs || []).map(e => ({ ...e, _kind: 'fluid' })),
    ...(lastData?.gags    || []).map(e => ({ ...e, _kind: 'gag'   })),
  ].sort((a, b) => b.id - a.id);

  if (allEntries.length === 0) {
    btn.textContent = '⚠️ Nothing to undo';
    setTimeout(() => { btn.textContent = '↩️ Undo Last Entry'; }, 2000);
    return;
  }

  const lastEntry = allEntries[0];
  const original = btn.textContent;
  btn.textContent = '⏳ Undoing...';
  btn.disabled = true;

  try {
    const url = lastEntry._kind === 'gag'
      ? `/api/gag/${lastEntry.id}`
      : `/api/log/${lastEntry.id}`;
    const res = await fetch(url, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    btn.textContent = '✅ Undone';
    setTimeout(() => {
      btn.textContent = original;
      btn.disabled = false;
    }, 1500);

    await fetchToday();
  } catch (err) {
    console.error('[undo] Error:', err.message);
    btn.textContent = '❌ Failed';
    setTimeout(() => {
      btn.textContent = original;
      btn.disabled = false;
    }, 2000);
  }
});
