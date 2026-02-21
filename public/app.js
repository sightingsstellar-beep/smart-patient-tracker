/**
 * app.js — Dashboard frontend
 *
 * Polls /api/today every 30 seconds and updates the UI.
 * Also handles quick-log button actions, date toggle,
 * and the redesigned Vitals & Wellness section.
 */

'use strict';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let lastData = null;
let pendingQuickLog = null; // { type, fluid_type, amount_ml }

// Date toggle: 'today' or 'yesterday'
let logDay = 'today';

// Wellness state: stores already-logged data per period and edit mode
let wellnessPeriod = 'afternoon'; // 'afternoon' | 'evening'
let wellnessLogged = { afternoon: null, evening: null }; // loaded from API
let wellnessEditMode = { afternoon: false, evening: false };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getYesterdayDateStr() {
  // Build the yesterday key client-side using the same day-boundary logic
  // (just date math on current date — timezone offset doesn't affect YYYY-MM-DD)
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  return yesterday.toISOString().slice(0, 10);
}

/**
 * Returns the date string to submit with the current logDay state,
 * or undefined when logging for today (server defaults to today).
 */
function getLogDateParam() {
  if (logDay === 'yesterday') {
    return getYesterdayDateStr();
  }
  return undefined; // omit — server uses today
}

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

  // Update wellness state from API data and re-render
  const wellness = data.wellness || [];
  wellnessLogged.afternoon = wellness.find((w) => w.check_time === '5pm') || null;
  wellnessLogged.evening   = wellness.find((w) => w.check_time === '10pm') || null;
  renderWellnessCard();
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

// ---------------------------------------------------------------------------
// Vitals & Wellness — redesigned section
// ---------------------------------------------------------------------------

// Maps metric name → array of { label, value } options
const WELLNESS_OPTIONS = {
  cyanosis: [
    { label: 'None',     value: 1 },
    { label: 'Mild',     value: 3 },
    { label: 'Moderate', value: 6 },
    { label: 'Severe',   value: 9 },
  ],
  energy: [
    { label: 'High',     value: 9 },
    { label: 'Normal',   value: 7 },
    { label: 'Low',      value: 4 },
    { label: 'Very Low', value: 2 },
  ],
  appetite: [
    { label: 'Great', value: 9 },
    { label: 'Good',  value: 7 },
    { label: 'Fair',  value: 4 },
    { label: 'Poor',  value: 2 },
  ],
  mood: [
    { label: 'Happy',     value: 9 },
    { label: 'Content',   value: 7 },
    { label: 'Irritable', value: 4 },
    { label: 'Upset',     value: 2 },
  ],
};

/**
 * Given a numeric score (1-10) and the options array for a metric,
 * return the option value closest to the score.
 */
function closestWellnessValue(score, options) {
  if (score === null || score === undefined) return null;
  let best = options[0].value;
  let bestDist = Math.abs(score - best);
  for (const opt of options) {
    const dist = Math.abs(score - opt.value);
    if (dist < bestDist) {
      bestDist = dist;
      best = opt.value;
    }
  }
  return best;
}

/**
 * Auto-select the period based on current time:
 * Before 8pm local time → Afternoon; 8pm or later → Evening.
 */
function autoSelectPeriod() {
  const hour = new Date().getHours();
  return hour >= 20 ? 'evening' : 'afternoon';
}

/**
 * Initialize the wellness period on page load.
 */
function initWellnessPeriod() {
  wellnessPeriod = autoSelectPeriod();
  updatePeriodToggleUI();
}

/**
 * Update the period toggle buttons to reflect current period.
 */
function updatePeriodToggleUI() {
  document.getElementById('period-afternoon').classList.toggle('active', wellnessPeriod === 'afternoon');
  document.getElementById('period-evening').classList.toggle('active', wellnessPeriod === 'evening');
}

/**
 * Render the full wellness card based on current state.
 * Handles: period toggle, button selection, read-only indicator, edit mode.
 */
function renderWellnessCard() {
  updatePeriodToggleUI();

  const isLogged = wellnessLogged[wellnessPeriod] !== null;
  const isEditing = wellnessEditMode[wellnessPeriod];
  const loggedData = wellnessLogged[wellnessPeriod];
  const isReadOnly = isLogged && !isEditing;

  // Show/hide logged indicator
  const indicator = document.getElementById('wellness-logged-indicator');
  indicator.style.display = isLogged ? 'flex' : 'none';

  // Show/hide save button (hidden when read-only)
  const saveBtn = document.getElementById('save-wellness-btn');
  saveBtn.style.display = isReadOnly ? 'none' : 'block';

  // Clear save result
  const resultEl = document.getElementById('wellness-save-result');
  resultEl.style.display = 'none';

  // Render button groups
  const groups = document.querySelectorAll('.wellness-btn-group');
  groups.forEach((group) => {
    const metric = group.dataset.metric;
    const options = WELLNESS_OPTIONS[metric] || [];
    const buttons = group.querySelectorAll('.wellness-choice-btn');

    // Determine which value should be selected
    let selectedValue = null;
    if (isLogged) {
      const storedScore = loggedData[metric];
      selectedValue = closestWellnessValue(storedScore, options);
    } else {
      // Look for already-active button (user's current selection)
      const activeBtn = group.querySelector('.wellness-choice-btn.active');
      if (activeBtn) selectedValue = parseFloat(activeBtn.dataset.value);
    }

    buttons.forEach((btn) => {
      const val = parseFloat(btn.dataset.value);
      btn.classList.toggle('active', val === selectedValue);
      btn.disabled = isReadOnly;
      btn.classList.toggle('wellness-choice-btn--readonly', isReadOnly);
    });
  });
}

/**
 * Get current wellness selections from button groups.
 * Returns { cyanosis, energy, appetite, mood } as numeric scores.
 */
function getWellnessSelections() {
  const result = {};
  const groups = document.querySelectorAll('.wellness-btn-group');
  groups.forEach((group) => {
    const metric = group.dataset.metric;
    const activeBtn = group.querySelector('.wellness-choice-btn.active');
    result[metric] = activeBtn ? parseFloat(activeBtn.dataset.value) : null;
  });
  return result;
}

// Wire up period toggle buttons
document.getElementById('period-afternoon').addEventListener('click', () => {
  wellnessPeriod = 'afternoon';
  renderWellnessCard();
});

document.getElementById('period-evening').addEventListener('click', () => {
  wellnessPeriod = 'evening';
  renderWellnessCard();
});

// Wire up Edit button
document.getElementById('wellness-edit-btn').addEventListener('click', () => {
  wellnessEditMode[wellnessPeriod] = true;
  renderWellnessCard();
});

// Wire up wellness choice buttons (delegation)
document.getElementById('wellness-metrics').addEventListener('click', (e) => {
  const btn = e.target.closest('.wellness-choice-btn');
  if (!btn || btn.disabled) return;
  const group = btn.closest('.wellness-btn-group');
  if (!group) return;
  // Deselect others in group, select this one
  group.querySelectorAll('.wellness-choice-btn').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
});

// Wire up Save Wellness button
document.getElementById('save-wellness-btn').addEventListener('click', async () => {
  const btn = document.getElementById('save-wellness-btn');
  const resultEl = document.getElementById('wellness-save-result');

  const selections = getWellnessSelections();
  const checkTime = wellnessPeriod === 'afternoon' ? '5pm' : '10pm';

  const original = btn.textContent;
  btn.textContent = '⏳ Saving…';
  btn.disabled = true;

  try {
    const res = await fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'wellness',
        check_time: checkTime,
        appetite: selections.appetite,
        energy: selections.energy,
        mood: selections.mood,
        cyanosis: selections.cyanosis,
      }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    btn.textContent = '✅ Saved';
    resultEl.textContent = '✓ Wellness check saved!';
    resultEl.className = 'wellness-save-result wellness-save-result--ok';
    resultEl.style.display = 'block';

    // Refresh data to update state
    await fetchToday();

    setTimeout(() => {
      btn.textContent = original;
      btn.disabled = false;
      wellnessEditMode[wellnessPeriod] = false;
      renderWellnessCard();
    }, 2000);
  } catch (err) {
    console.error('[wellness] Save error:', err.message);
    btn.textContent = '❌ Error';
    resultEl.textContent = '⚠️ Failed to save. Please try again.';
    resultEl.className = 'wellness-save-result wellness-save-result--err';
    resultEl.style.display = 'block';
    setTimeout(() => {
      btn.textContent = original;
      btn.disabled = false;
    }, 2000);
  }
});

// Initialize wellness period on load
initWellnessPeriod();

// ---------------------------------------------------------------------------
// Daily Weight section
// ---------------------------------------------------------------------------

let weightYesterdayKg = null; // cached for trend comparison

async function loadTodayWeight() {
  try {
    const res = await fetch('/api/weight/today');
    if (!res.ok) return;
    const data = await res.json();
    renderWeightStatus(data.weight);

    // Also fetch yesterday's weight for trend display
    const histRes = await fetch('/api/weight/history?days=2');
    if (histRes.ok) {
      const histData = await histRes.json();
      // entries are ordered desc by date — second entry is yesterday
      if (histData.entries && histData.entries.length >= 2) {
        weightYesterdayKg = histData.entries[1].weight_kg;
      } else if (histData.entries && histData.entries.length === 1 && data.weight) {
        // Only one entry exists (today's) — no yesterday
        weightYesterdayKg = null;
      }
      // Re-render with trend now that we have yesterday
      renderWeightStatus(data.weight);
    }
  } catch (err) {
    console.error('[weight] Load error:', err.message);
  }
}

function renderWeightStatus(entry) {
  const statusEl = document.getElementById('weight-status');
  const todayLabel = document.getElementById('weight-today-label');
  const trendEl = document.getElementById('weight-trend');
  const inputEl = document.getElementById('weight-input');

  if (!entry) {
    statusEl.style.display = 'none';
    if (inputEl) inputEl.value = '';
    return;
  }

  todayLabel.textContent = `Today: ${entry.weight_kg} kg`;

  // Trend vs yesterday
  trendEl.textContent = '';
  trendEl.className = '';
  if (weightYesterdayKg !== null && typeof weightYesterdayKg === 'number') {
    const diff = Math.round((entry.weight_kg - weightYesterdayKg) * 10) / 10;
    if (diff > 0.1) {
      trendEl.textContent = `↑ +${diff} kg`;
      trendEl.className = 'weight-trend-up';
    } else if (diff < -0.1) {
      trendEl.textContent = `↓ ${diff} kg`;
      trendEl.className = 'weight-trend-down';
    } else {
      trendEl.textContent = '→ stable';
      trendEl.className = 'weight-trend-flat';
    }
  }

  statusEl.style.display = 'flex';
}

document.getElementById('weight-log-btn').addEventListener('click', async () => {
  const inputEl = document.getElementById('weight-input');
  const btn = document.getElementById('weight-log-btn');
  const val = parseFloat(inputEl.value);

  if (isNaN(val) || val <= 0) {
    inputEl.focus();
    return;
  }

  const originalText = btn.textContent;
  btn.textContent = '⏳';
  btn.disabled = true;

  try {
    const body = { weight_kg: val };
    const dateParam = getLogDateParam();
    if (dateParam) body.date = dateParam;

    const res = await fetch('/api/weight', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    btn.textContent = '✅ Saved';
    inputEl.value = '';
    await loadTodayWeight();

    setTimeout(() => {
      btn.textContent = originalText;
      btn.disabled = false;
    }, 1500);
  } catch (err) {
    console.error('[weight] Log error:', err.message);
    btn.textContent = '❌ Error';
    setTimeout(() => {
      btn.textContent = originalText;
      btn.disabled = false;
    }, 2000);
  }
});

document.getElementById('weight-update-btn').addEventListener('click', () => {
  const inputEl = document.getElementById('weight-input');
  inputEl.focus();
  // Scroll to weight card
  document.getElementById('weight-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

// Load weight on startup
loadTodayWeight();

// ---------------------------------------------------------------------------
// Date toggle (Today / Yesterday)
// ---------------------------------------------------------------------------

function setLogDay(day) {
  logDay = day;

  document.getElementById('toggle-today').classList.toggle('active', day === 'today');
  document.getElementById('toggle-yesterday').classList.toggle('active', day === 'yesterday');

  const banner = document.getElementById('yesterday-banner');
  banner.style.display = day === 'yesterday' ? 'block' : 'none';
}

document.getElementById('toggle-today').addEventListener('click', () => setLogDay('today'));
document.getElementById('toggle-yesterday').addEventListener('click', () => setLogDay('yesterday'));

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

  // Include date when logging for yesterday
  const dateParam = getLogDateParam();
  if (dateParam) body.date = dateParam;

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
