/**
 * app.js — mobile-first Day view for Glide Bedside
 */

'use strict';

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

const INPUT_OPTIONS = [
  { value: 'water', label: 'Water' },
  { value: 'pediasure', label: 'PediaSure' },
  { value: 'milk', label: 'Milk' },
  { value: 'juice', label: 'Juice' },
  { value: 'yogurt_drink', label: 'Yogurt Drink' },
];

const OUTPUT_OPTIONS = [
  { value: 'urine', label: 'Urine' },
  { value: 'poop', label: 'Poop' },
  { value: 'vomit', label: 'Vomit' },
];

const POOP_SUBTYPE_OPTIONS = [
  { value: 'normal', label: 'Normal' },
  { value: 'diarrhea', label: 'Diarrhea' },
  { value: 'undigested', label: 'Undigested' },
];

const CYANOSIS_OPTIONS = [
  { value: 1, label: 'None' },
  { value: 3, label: 'Mild' },
  { value: 6, label: 'Moderate' },
  { value: 9, label: 'Severe' },
];

const state = {
  data: null,
  selectedDayKey: null,
  todayDayKey: null,
  weight: null,
  weightPreviousKg: null,
  pendingQuickLog: null,
  sheet: null,
};

function shiftDayKey(dayKey, deltaDays) {
  if (!dayKey) return null;
  const [year, month, day] = dayKey.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  shifted.setUTCDate(shifted.getUTCDate() + deltaDays);
  return shifted.toISOString().slice(0, 10);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function getCurrentTimeInputValue() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function isTodaySelected() {
  return !!state.todayDayKey && state.selectedDayKey === state.todayDayKey;
}

function formatChipLabel(dayKey) {
  if (!dayKey) return 'Pick a day';
  if (dayKey === state.todayDayKey) return 'Today';
  if (dayKey === shiftDayKey(state.todayDayKey, -1)) return 'Yesterday';
  const [year, month, day] = dayKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function formatLongDay(dayKey) {
  if (!dayKey) return '';
  const [year, month, day] = dayKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function updateUrlForSelectedDay() {
  if (!state.selectedDayKey || !state.todayDayKey) return;
  const url = new URL(window.location.href);
  if (state.selectedDayKey === state.todayDayKey) url.searchParams.delete('date');
  else url.searchParams.set('date', state.selectedDayKey);
  window.history.replaceState({}, '', `${url.pathname}${url.search}`);
}

function getWellnessMap() {
  const map = { '5pm': null, '10pm': null };
  for (const row of state.data?.wellness || []) {
    if (row && row.check_time) map[row.check_time] = row;
  }
  return map;
}

function getWeightTrendMeta() {
  let label = 'No previous weight yet';
  let className = 'weight-trend-flat';

  if (typeof state.weightPreviousKg === 'number' && state.weight) {
    const diff = Math.round((state.weight.weight_kg - state.weightPreviousKg) * 10) / 10;
    if (diff > 0.1) {
      label = `↑ +${diff} kg vs previous`;
      className = 'weight-trend-up';
    } else if (diff < -0.1) {
      label = `↓ ${diff} kg vs previous`;
      className = 'weight-trend-down';
    } else {
      label = '→ stable vs previous';
    }
  }

  return { label, className };
}


function showAppAlert(message, options = {}) {
  const alert = document.getElementById('app-alert');
  if (!alert) return;
  const canonicalUrl = options.canonicalUrl;
  alert.innerHTML = canonicalUrl
    ? `${escapeHtml(message)} <a href="${escapeHtml(canonicalUrl)}">Open Glide Bedside</a>`
    : escapeHtml(message);
  alert.style.display = 'block';
}

async function parseWriteError(res) {
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (data?.error === 'wrong_app_domain' && data?.canonicalUrl) {
    return { message: 'This saved app shortcut is using an old domain.', canonicalUrl: data.canonicalUrl };
  }
  if (res.status === 401) {
    return { message: 'Your sign-in session expired or this shortcut is using an old app domain. Please open Glide Bedside and sign in again.', canonicalUrl: 'https://bedside.glidechart.com' };
  }
  return { message: data?.error || `Save failed (HTTP ${res.status}). Please try again.` };
}

async function requireWriteOk(res) {
  if (res.ok) return;
  const err = await parseWriteError(res);
  const error = new Error(err.message);
  error.canonicalUrl = err.canonicalUrl;
  throw error;
}

function updateClock() {
  const now = new Date();
  document.getElementById('current-time').textContent = now.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  document.getElementById('current-date').textContent = now.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    if (!res.ok) return;
    const settings = await res.json();
    if (settings.child_name) {
      document.getElementById('child-name').textContent = settings.child_name;
    }
  } catch (_) {}
}

async function loadSelectedDayWeight() {
  if (!state.selectedDayKey) return;

  state.weight = null;
  state.weightPreviousKg = null;

  try {
    const [weightRes, historyRes] = await Promise.all([
      fetch(`/api/weight/today?date=${encodeURIComponent(state.selectedDayKey)}`),
      fetch(`/api/weight/history?days=2&throughDate=${encodeURIComponent(state.selectedDayKey)}`),
    ]);

    if (weightRes.ok) {
      const weightData = await weightRes.json();
      state.weight = weightData.weight || null;
    }

    if (historyRes.ok) {
      const historyData = await historyRes.json();
      if (state.weight && Array.isArray(historyData.entries)) {
        const currentIndex = historyData.entries.findIndex((entry) => entry.date === state.selectedDayKey);
        if (currentIndex !== -1 && historyData.entries[currentIndex + 1]) {
          state.weightPreviousKg = historyData.entries[currentIndex + 1].weight_kg;
        }
      }
    }
  } catch (err) {
    console.error('[weight] Load error:', err.message);
  }
}

async function refreshDay() {
  try {
    const url = new URL('/api/day', window.location.origin);
    if (state.selectedDayKey) url.searchParams.set('date', state.selectedDayKey);
    const res = await fetch(url);
    await requireWriteOk(res);

    const data = await res.json();
    state.data = data;
    state.selectedDayKey = data.dayKey;
    state.todayDayKey = data.todayDayKey || data.dayKey;
    updateUrlForSelectedDay();

    await loadSelectedDayWeight();
    renderAll();

    document.getElementById('last-updated').textContent = new Date().toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
    });
    document.querySelectorAll('.day-picker-input').forEach((input) => {
      input.max = state.todayDayKey || '';
    });
  } catch (err) {
    console.error('[day] Fetch error:', err.message);
  }
}

function renderAll() {
  renderDayController();
  renderIntake();
  renderOutputs();
  renderGags();
  renderWeight();
  renderWellness();
}

function renderDayController() {
  document.getElementById('day-date-chip').textContent = formatChipLabel(state.selectedDayKey);
  document.querySelectorAll('.day-picker-input').forEach((input) => {
    input.value = state.selectedDayKey || '';
  });

  const banner = document.getElementById('day-context-banner');
  const backBtn = document.getElementById('back-to-today');
  const nextBtn = document.getElementById('day-next');

  if (isTodaySelected()) {
    banner.style.display = 'none';
    backBtn.style.display = 'none';
  } else {
    banner.style.display = 'block';
    banner.textContent = `Editing and logging entries for ${formatLongDay(state.selectedDayKey)}`;
    backBtn.style.display = 'inline';
  }

  nextBtn.disabled = isTodaySelected();
}

function renderIntake() {
  const total = state.data?.totalIntake || 0;
  const limit = state.data?.limit_ml || 1200;
  const pct = limit > 0 ? Math.round((total / limit) * 100) : 0;

  document.getElementById('intake-amount').textContent = `${total} ml`;
  document.getElementById('intake-limit').textContent = `/ ${limit} ml`;
  document.getElementById('intake-pct').textContent = `${pct}%`;

  const bar = document.getElementById('progress-bar');
  bar.style.width = `${Math.min(pct, 100)}%`;
  bar.setAttribute('aria-valuenow', String(Math.min(pct, 100)));
  bar.classList.remove('yellow', 'red', 'over-limit');

  if (total > limit) bar.classList.add('over-limit');
  else if (pct >= 90) bar.classList.add('red');
  else if (pct >= 70) bar.classList.add('yellow');

  document.getElementById('over-limit-warning').style.display = total > limit ? 'block' : 'none';

  const container = document.getElementById('fluid-types');
  const inputs = state.data?.inputs || [];
  const intakeByType = state.data?.intakeByType || {};
  const entries = Object.entries(intakeByType).filter(([, ml]) => ml > 0);

  if (entries.length === 0) {
    container.innerHTML = `<div class="empty-state">No intake logged for ${escapeHtml(formatChipLabel(state.selectedDayKey).toLowerCase())}</div>`;
    return;
  }

  const inputsByType = inputs.reduce((map, entry) => {
    if (!entry?.fluid_type) return map;
    if (!map[entry.fluid_type]) map[entry.fluid_type] = [];
    map[entry.fluid_type].push(entry);
    return map;
  }, {});

  container.innerHTML = entries.map(([type, amount]) => {
    const items = inputsByType[type] || [];
    const detailHtml = items.map((entry) => {
      return `
        <div class="fluid-type-detail-row">
          <button class="entry-row-button" data-entry-kind="fluid" data-entry-id="${entry.id}">
            <span class="output-time">${escapeHtml(entry.time || '--')}</span>
            <span class="entry-row-spacer"></span>
            <span class="entry-row-amount">${escapeHtml(entry.amount_ml || 0)} ml</span>
          </button>
        </div>
      `;
    }).join('');

    return `
      <div class="fluid-type-card">
        <div class="fluid-type-static-header">
          <div class="fluid-type-summary">
            <div class="fluid-type-name">${escapeHtml(FLUID_LABELS[type] || type)}</div>
            <div class="fluid-type-amount">${escapeHtml(amount)} ml</div>
          </div>
        </div>
        <div class="fluid-type-details">
          ${detailHtml || '<div class="fluid-type-detail-empty">No individual entries found</div>'}
        </div>
      </div>
    `;
  }).join('');
}

function renderOutputs() {
  const outputs = state.data?.outputs || [];
  const list = document.getElementById('output-list');
  const totalAmount = outputs.reduce((sum, entry) => sum + (Number(entry.amount_ml) || 0), 0);

  document.getElementById('output-count').textContent = outputs.length;
  document.getElementById('output-total-amount').textContent = `${totalAmount} g`;
  document.getElementById('output-total-events').textContent = `${outputs.length} ${outputs.length === 1 ? 'event' : 'events'}`;

  if (!outputs.length) {
    list.innerHTML = '<li class="empty-state">No outputs logged for this day</li>';
    return;
  }

  list.innerHTML = outputs.map((entry) => {
    const subtypeLabel = entry.fluid_type === 'poop' && entry.subtype
      ? `Subtype: ${entry.subtype}`
      : '';
    const amount = entry.amount_ml ? `${entry.amount_ml} g` : 'No amount';
    return `
      <li class="output-item">
        <button class="entry-row-button" data-entry-kind="fluid" data-entry-id="${entry.id}">
          <span class="output-time">${escapeHtml(entry.time || '--')}</span>
          <span class="output-type-icon">${entry.fluid_type === 'poop' ? '💩' : entry.fluid_type === 'vomit' ? '🤮' : '🚽'}</span>
          <span class="entry-row-main">
            <span class="entry-row-title">${escapeHtml(entry.fluid_type_label || FLUID_LABELS[entry.fluid_type] || entry.fluid_type)}</span>
            ${subtypeLabel ? `<span class="entry-row-subtitle">${escapeHtml(subtypeLabel)}</span>` : ''}
          </span>
          <span class="entry-row-amount">${escapeHtml(amount)}</span>
        </button>
      </li>
    `;
  }).join('');
}

function renderGags() {
  const gags = state.data?.gags || [];
  const list = document.getElementById('gag-list');
  document.getElementById('gag-count').textContent = state.data?.gagCount || gags.length;

  if (!gags.length) {
    list.innerHTML = '<li class="empty-state">No gag episodes logged for this day</li>';
    return;
  }

  list.innerHTML = gags.map((entry) => `
    <li class="gag-item">
      <button class="entry-row-button" data-entry-kind="gag" data-entry-id="${entry.id}">
        <span class="gag-time">${escapeHtml(entry.time || '--')}</span>
        <span class="entry-row-main">
          <span class="entry-row-title">Gag episode</span>
        </span>
      </button>
    </li>
  `).join('');
}

function renderWeight() {
  const actionBtn = document.getElementById('weight-action-btn');
  const container = document.getElementById('weight-summary');

  if (!state.weight) {
    actionBtn.textContent = 'Add';
    container.innerHTML = '<div class="empty-state" style="text-align:left;">No weight logged for this day</div>';
    return;
  }

  actionBtn.textContent = 'Edit';

  const { label: trendLabel, className: trendClass } = getWeightTrendMeta();

  container.innerHTML = `
    <div class="weight-summary-card">
      <div class="weight-summary-top">
        <div>
          <div class="weight-value">${escapeHtml(state.weight.weight_kg)} kg</div>
          <div class="weight-meta">Logged for ${escapeHtml(formatLongDay(state.selectedDayKey))}</div>
        </div>
        <div id="weight-trend" class="${trendClass}">${escapeHtml(trendLabel)}</div>
      </div>
      <div class="weight-actions">
        <button class="inline-action-btn" data-weight-action="edit">Edit</button>
        <button class="inline-action-btn inline-action-btn--danger" data-weight-action="delete">Delete</button>
      </div>
    </div>
  `;
}

function renderWellness() {
  const wellnessMap = getWellnessMap();
  const container = document.getElementById('wellness-period-list');

  container.innerHTML = ['5pm', '10pm'].map((period) => {
    const entry = wellnessMap[period];
    const label = period === '5pm' ? 'Afternoon' : 'Evening';
    const status = entry ? 'Logged' : 'Not logged';
    const pills = entry ? [
      ['Cyanosis', entry.cyanosis ?? '—'],
      ['Energy', entry.energy ?? '—'],
      ['Appetite', entry.appetite ?? '—'],
      ['Mood', entry.mood ?? '—'],
    ].map(([name, value]) => `
      <div class="wellness-summary-pill">
        <span class="wellness-summary-label">${escapeHtml(name)}</span>
        <span class="wellness-summary-value">${escapeHtml(value)}</span>
      </div>
    `).join('') : '<div class="empty-state" style="padding:4px 0 0;text-align:left;">Tap to add this period.</div>';

    return `
      <button class="wellness-period-card" data-wellness-period="${period}" type="button">
        <div class="wellness-period-header">
          <span class="wellness-period-title">${escapeHtml(label)} (${escapeHtml(period)})</span>
          <span class="wellness-period-status ${entry ? 'logged' : ''}">${escapeHtml(status)}</span>
        </div>
        <div class="wellness-summary-grid">
          ${pills}
        </div>
      </button>
    `;
  }).join('');
}

function findFluidEntry(id) {
  const all = [...(state.data?.inputs || []), ...(state.data?.outputs || [])];
  return all.find((entry) => entry.id === id) || null;
}

function findGagEntry(id) {
  return (state.data?.gags || []).find((entry) => entry.id === id) || null;
}

function showPoopSubtypePopup(anchorBtn) {
  const popup = document.getElementById('poop-subtype-popup');
  popup.dataset.anchor = anchorBtn?.textContent || '';
  popup.style.display = 'block';
}

function hidePoopSubtypePopup() {
  document.getElementById('poop-subtype-popup').style.display = 'none';
}

function showQuickLogModal() {
  const isGag = state.pendingQuickLog?.type === 'gag';
  const isOutput = state.pendingQuickLog?.type === 'output';
  const amountInput = document.getElementById('amount-input');
  const label = document.getElementById('modal-amount-label');
  const timeWrap = document.getElementById('modal-time-wrap');
  const timeInput = document.getElementById('modal-time-input');

  label.textContent = isGag ? 'Confirm gag entry' : isOutput ? 'Enter amount (g)' : 'Enter amount (ml)';
  amountInput.style.display = isGag ? 'none' : 'block';
  amountInput.value = state.pendingQuickLog?.amount_ml ? String(state.pendingQuickLog.amount_ml) : '';
  timeWrap.style.display = isTodaySelected() ? 'none' : 'flex';
  timeInput.value = getCurrentTimeInputValue();
  document.getElementById('amount-modal').style.display = 'flex';

  setTimeout(() => {
    if (!isGag) amountInput.focus();
    else if (!isTodaySelected()) timeInput.focus();
  }, 0);
}

function hideQuickLogModal() {
  document.getElementById('amount-modal').style.display = 'none';
  document.getElementById('amount-input').value = '';
  document.getElementById('modal-time-input').value = '';
  document.getElementById('amount-input').style.display = 'block';
  state.pendingQuickLog = null;
}

async function submitQuickLog(payload, btn = null) {
  const body = payload.type === 'gag'
    ? { type: 'gag', count: payload.count || 1, date: state.selectedDayKey }
    : {
        entry_type: payload.type,
        fluid_type: payload.fluid_type,
        amount_ml: payload.amount_ml ?? null,
        subtype: payload.subtype ?? null,
        date: state.selectedDayKey,
      };

  if (payload.time) body.time = payload.time;

  const original = btn ? btn.textContent : '';
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
    await requireWriteOk(res);

    if (btn) {
      btn.textContent = '✅';
      setTimeout(() => {
        btn.textContent = original;
        btn.disabled = false;
      }, 1200);
    }

    await refreshDay();
  } catch (err) {
    console.error('[quick-log] Error:', err.message);
    showAppAlert(err.message, { canonicalUrl: err.canonicalUrl });
    if (btn) {
      btn.textContent = '❌';
      setTimeout(() => {
        btn.textContent = original;
        btn.disabled = false;
      }, 1500);
    }
  }
}

function buildFluidOptions(entryType, selectedValue) {
  const options = (entryType === 'input' ? INPUT_OPTIONS : OUTPUT_OPTIONS)
    .map((option) => `<option value="${option.value}" ${option.value === selectedValue ? 'selected' : ''}>${option.label}</option>`)
    .join('');
  return options;
}

function renderSheet() {
  if (!state.sheet) return;

  const titleEl = document.getElementById('entry-sheet-title');
  const subtitleEl = document.getElementById('entry-sheet-subtitle');
  const fieldsEl = document.getElementById('entry-sheet-fields');
  const deleteBtn = document.getElementById('entry-sheet-delete');

  const dayLabel = formatLongDay(state.selectedDayKey);
  subtitleEl.textContent = dayLabel;
  deleteBtn.style.display = state.sheet.mode === 'edit' ? 'inline-flex' : 'none';

  if (state.sheet.kind === 'fluid') {
    const entry = state.sheet.entry;
    const entryType = state.sheet.entryType || entry?.entry_type || 'input';
    const fluidType = entry?.fluid_type || (entryType === 'input' ? 'water' : 'urine');
    const amountValue = entry?.amount_ml ?? '';
    const timeValue = entry?.time24 || getCurrentTimeInputValue();
    const subtypeValue = entry?.subtype || 'normal';
    const amountLabel = entryType === 'output' ? 'Amount (g)' : 'Amount (ml)';

    titleEl.textContent = state.sheet.mode === 'edit' ? 'Edit entry' : `Add ${entryType === 'input' ? 'intake' : 'output'}`;
    fieldsEl.innerHTML = `
      <div class="form-field">
        <label for="sheet-fluid-type">Type</label>
        <select id="sheet-fluid-type" name="fluid_type">${buildFluidOptions(entryType, fluidType)}</select>
      </div>
      <div class="form-field" id="sheet-amount-wrap">
        <label for="sheet-amount-input" id="sheet-amount-label">${amountLabel}</label>
        <input id="sheet-amount-input" name="amount_ml" type="number" min="0" step="0.1" value="${escapeHtml(amountValue)}" placeholder="Enter amount" inputmode="decimal" />
      </div>
      <div class="form-field" id="sheet-subtype-wrap" style="display:${fluidType === 'poop' ? 'flex' : 'none'};">
        <label for="sheet-subtype-select">Poop type</label>
        <select id="sheet-subtype-select" name="subtype">
          ${POOP_SUBTYPE_OPTIONS.map((option) => `<option value="${option.value}" ${option.value === subtypeValue ? 'selected' : ''}>${option.label}</option>`).join('')}
        </select>
      </div>
      <div class="form-field">
        <label for="sheet-time-input">Time</label>
        <input id="sheet-time-input" name="time" type="time" value="${escapeHtml(timeValue)}" required />
      </div>
    `;
  } else if (state.sheet.kind === 'gag') {
    const entry = state.sheet.entry;
    titleEl.textContent = state.sheet.mode === 'edit' ? 'Edit gag episode' : 'Add gag episode';
    fieldsEl.innerHTML = `
      <div class="form-field">
        <label for="sheet-time-input">Time</label>
        <input id="sheet-time-input" name="time" type="time" value="${escapeHtml(entry?.time24 || getCurrentTimeInputValue())}" required />
      </div>
    `;
  } else if (state.sheet.kind === 'weight') {
    titleEl.textContent = state.weight ? 'Edit weight' : 'Add weight';
    fieldsEl.innerHTML = `
      <div class="form-field">
        <label for="sheet-weight-input">Weight (kg)</label>
        <input id="sheet-weight-input" name="weight_kg" type="number" min="0" step="0.1" value="${escapeHtml(state.weight?.weight_kg ?? '')}" placeholder="e.g. 14.2" inputmode="decimal" required />
      </div>
    `;
  } else if (state.sheet.kind === 'wellness') {
    const period = state.sheet.period;
    const entry = state.sheet.entry || {};
    titleEl.textContent = `${period === '5pm' ? 'Afternoon' : 'Evening'} wellness`;

    const cyanosisGroup = CYANOSIS_OPTIONS.map((option) => `
      <label class="wellness-radio-option">
        <input type="radio" name="cyanosis" value="${option.value}" ${Number(entry.cyanosis || 1) === option.value ? 'checked' : ''} />
        <span>${option.label}</span>
      </label>
    `).join('');

    const rangeField = (name, label, value) => `
      <div class="range-field">
        <div class="range-field-top">
          <label for="sheet-${name}-input">${label}</label>
          <span class="range-field-value" id="sheet-${name}-value">${value}</span>
        </div>
        <input id="sheet-${name}-input" name="${name}" type="range" min="1" max="10" step="1" value="${value}" />
      </div>
    `;

    fieldsEl.innerHTML = `
      <div class="form-field">
        <label>Cyanosis</label>
        <div class="wellness-radio-group">${cyanosisGroup}</div>
      </div>
      <div class="wellness-editor-grid">
        ${rangeField('energy', 'Energy', Number(entry.energy || 5))}
        ${rangeField('appetite', 'Appetite', Number(entry.appetite || 5))}
        ${rangeField('mood', 'Mood', Number(entry.mood || 5))}
      </div>
    `;
  }

  document.getElementById('entry-sheet').style.display = 'flex';
}

function openEntrySheet(config) {
  state.sheet = config;
  renderSheet();
}

function closeEntrySheet() {
  state.sheet = null;
  document.getElementById('entry-sheet').style.display = 'none';
}

async function handleSheetSubmit(event) {
  event.preventDefault();
  if (!state.sheet) return;

  const saveBtn = document.getElementById('entry-sheet-save');
  const original = saveBtn.textContent;
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  try {
    if (state.sheet.kind === 'fluid') {
      const typeSelect = document.getElementById('sheet-fluid-type');
      const amountInput = document.getElementById('sheet-amount-input');
      const timeInput = document.getElementById('sheet-time-input');
      const subtypeSelect = document.getElementById('sheet-subtype-select');
      const fluidType = typeSelect.value;
      const entryType = state.sheet.entryType || state.sheet.entry?.entry_type || 'input';
      const isPoop = fluidType === 'poop';
      const amountVal = amountInput.value === '' ? null : parseFloat(amountInput.value);

      const body = {
        entry_type: entryType,
        fluid_type: fluidType,
        amount_ml: isPoop ? amountVal : amountVal,
        subtype: isPoop ? subtypeSelect?.value || 'normal' : null,
        time: timeInput.value,
        date: state.selectedDayKey,
      };

      const url = state.sheet.mode === 'edit' ? `/api/log/${state.sheet.entry.id}` : '/api/log';
      const method = state.sheet.mode === 'edit' ? 'PATCH' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      await requireWriteOk(res);
    } else if (state.sheet.kind === 'gag') {
      const time = document.getElementById('sheet-time-input').value;
      const url = state.sheet.mode === 'edit' ? `/api/gag/${state.sheet.entry.id}` : '/api/log';
      const method = state.sheet.mode === 'edit' ? 'PATCH' : 'POST';
      const body = state.sheet.mode === 'edit'
        ? { time, date: state.selectedDayKey }
        : { type: 'gag', count: 1, time, date: state.selectedDayKey };
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      await requireWriteOk(res);
    } else if (state.sheet.kind === 'weight') {
      const weightVal = parseFloat(document.getElementById('sheet-weight-input').value);
      const res = await fetch('/api/weight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ weight_kg: weightVal, date: state.selectedDayKey }),
      });
      await requireWriteOk(res);
    } else if (state.sheet.kind === 'wellness') {
      const cyanosis = parseInt(document.querySelector('input[name="cyanosis"]:checked')?.value || '1', 10);
      const energy = parseInt(document.getElementById('sheet-energy-input').value, 10);
      const appetite = parseInt(document.getElementById('sheet-appetite-input').value, 10);
      const mood = parseInt(document.getElementById('sheet-mood-input').value, 10);
      const res = await fetch('/api/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'wellness',
          check_time: state.sheet.period,
          cyanosis,
          energy,
          appetite,
          mood,
          date: state.selectedDayKey,
        }),
      });
      await requireWriteOk(res);
    }

    closeEntrySheet();
    await refreshDay();
  } catch (err) {
    console.error('[sheet] Save error:', err.message);
    showAppAlert(err.message, { canonicalUrl: err.canonicalUrl });
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = original;
  }
}

async function handleSheetDelete() {
  if (!state.sheet) return;
  if (!window.confirm('Delete this entry?')) return;

  try {
    if (state.sheet.kind === 'fluid') {
      const res = await fetch(`/api/log/${state.sheet.entry.id}`, { method: 'DELETE' });
      await requireWriteOk(res);
    } else if (state.sheet.kind === 'gag') {
      const res = await fetch(`/api/gag/${state.sheet.entry.id}`, { method: 'DELETE' });
      await requireWriteOk(res);
    } else if (state.sheet.kind === 'weight') {
      const res = await fetch(`/api/weight/${encodeURIComponent(state.selectedDayKey)}`, { method: 'DELETE' });
      await requireWriteOk(res);
    } else if (state.sheet.kind === 'wellness') {
      const url = `/api/wellness?date=${encodeURIComponent(state.selectedDayKey)}&check_time=${encodeURIComponent(state.sheet.period)}`;
      const res = await fetch(url, { method: 'DELETE' });
      await requireWriteOk(res);
    }

    closeEntrySheet();
    await refreshDay();
  } catch (err) {
    console.error('[sheet] Delete error:', err.message);
    showAppAlert(err.message, { canonicalUrl: err.canonicalUrl });
  }
}

function hydrateEntryForEdit(entry) {
  const time24 = entry?.time24
    || (entry?.timestamp
      ? new Date(entry.timestamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
      : getCurrentTimeInputValue());
  return { ...entry, time24 };
}

async function handleUndoCurrentDay() {
  const allEntries = [
    ...(state.data?.inputs || []).map((entry) => ({ ...entry, _kind: 'fluid' })),
    ...(state.data?.outputs || []).map((entry) => ({ ...entry, _kind: 'fluid' })),
    ...(state.data?.gags || []).map((entry) => ({ ...entry, _kind: 'gag' })),
  ].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  const btn = document.getElementById('undo-btn');
  if (!allEntries.length) {
    const original = btn.textContent;
    btn.textContent = '⚠️ Nothing to undo';
    setTimeout(() => { btn.textContent = original; }, 1500);
    return;
  }

  const latest = allEntries[0];
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ Undoing...';

  try {
    const url = latest._kind === 'gag' ? `/api/gag/${latest.id}` : `/api/log/${latest.id}`;
    const res = await fetch(url, { method: 'DELETE' });
    await requireWriteOk(res);
    btn.textContent = '✅ Undone';
    await refreshDay();
  } catch (err) {
    console.error('[undo] Error:', err.message);
    showAppAlert(err.message, { canonicalUrl: err.canonicalUrl });
    btn.textContent = '❌ Failed';
  } finally {
    setTimeout(() => {
      btn.textContent = original;
      btn.disabled = false;
    }, 1400);
  }
}

function initEventListeners() {
  document.getElementById('day-prev').addEventListener('click', async () => {
    state.selectedDayKey = shiftDayKey(state.selectedDayKey || state.todayDayKey, -1);
    await refreshDay();
  });

  document.getElementById('day-next').addEventListener('click', async () => {
    if (isTodaySelected()) return;
    state.selectedDayKey = shiftDayKey(state.selectedDayKey || state.todayDayKey, 1);
    await refreshDay();
  });

  document.querySelectorAll('.day-picker-input').forEach((input) => {
    input.addEventListener('change', async (event) => {
      if (!event.target.value) return;
      state.selectedDayKey = event.target.value;
      await refreshDay();
    });
  });
  document.getElementById('back-to-today').addEventListener('click', async () => {
    state.selectedDayKey = state.todayDayKey;
    await refreshDay();
  });

  document.querySelectorAll('.quick-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const type = btn.dataset.type;
      const fluid = btn.dataset.fluid;
      if (type === 'output' && fluid === 'poop') {
        state.pendingQuickLog = { type: 'output', fluid_type: 'poop' };
        showPoopSubtypePopup(btn);
        return;
      }
      if (type === 'gag' && isTodaySelected()) {
        await submitQuickLog({ type: 'gag', count: 1 }, btn);
        return;
      }
      state.pendingQuickLog = type === 'gag'
        ? { type: 'gag', count: 1 }
        : { type, fluid_type: fluid, subtype: null, amount_ml: null };
      showQuickLogModal();
    });
  });

  document.querySelectorAll('.poop-subtype-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.pendingQuickLog = { ...state.pendingQuickLog, subtype: btn.dataset.subtype };
      hidePoopSubtypePopup();
      showQuickLogModal();
    });
  });

  document.getElementById('modal-cancel').addEventListener('click', hideQuickLogModal);
  document.getElementById('amount-modal').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) hideQuickLogModal();
  });
  document.getElementById('modal-confirm').addEventListener('click', async () => {
    if (!state.pendingQuickLog) return;
    const amountInput = document.getElementById('amount-input');
    const timeInput = document.getElementById('modal-time-input');
    const isGag = state.pendingQuickLog.type === 'gag';
    const amountVal = amountInput.value === '' ? null : parseFloat(amountInput.value);
    const payload = {
      ...state.pendingQuickLog,
      amount_ml: isGag ? null : amountVal,
      time: isTodaySelected() ? undefined : (timeInput.value || getCurrentTimeInputValue()),
    };
    hideQuickLogModal();
    await submitQuickLog(payload);
  });

  document.addEventListener('click', (event) => {
    const popup = document.getElementById('poop-subtype-popup');
    if (popup.style.display === 'none') return;
    if (popup.contains(event.target) || event.target.closest('.quick-btn[data-fluid="poop"]')) return;
    hidePoopSubtypePopup();
  });

  document.getElementById('undo-btn').addEventListener('click', handleUndoCurrentDay);

  document.getElementById('add-intake-btn').addEventListener('click', () => openEntrySheet({ mode: 'add', kind: 'fluid', entryType: 'input' }));
  document.getElementById('add-output-btn').addEventListener('click', () => openEntrySheet({ mode: 'add', kind: 'fluid', entryType: 'output' }));
  document.getElementById('add-gag-btn').addEventListener('click', () => openEntrySheet({ mode: 'add', kind: 'gag' }));
  document.getElementById('weight-action-btn').addEventListener('click', () => openEntrySheet({ mode: state.weight ? 'edit' : 'add', kind: 'weight' }));

  ['fluid-types', 'output-list', 'gag-list'].forEach((id) => {
    document.getElementById(id).addEventListener('click', (event) => {
      const button = event.target.closest('.entry-row-button');
      if (!button) return;
      const kind = button.dataset.entryKind;
      const entryId = parseInt(button.dataset.entryId, 10);
      if (kind === 'fluid') {
        const entry = hydrateEntryForEdit(findFluidEntry(entryId));
        if (entry) openEntrySheet({ mode: 'edit', kind: 'fluid', entryType: entry.entry_type, entry });
      } else if (kind === 'gag') {
        const entry = hydrateEntryForEdit(findGagEntry(entryId));
        if (entry) openEntrySheet({ mode: 'edit', kind: 'gag', entry });
      }
    });
  });

  document.getElementById('weight-summary').addEventListener('click', async (event) => {
    const action = event.target.closest('[data-weight-action]')?.dataset.weightAction;
    if (!action) return;
    if (action === 'edit') openEntrySheet({ mode: 'edit', kind: 'weight' });
    if (action === 'delete') {
      if (!window.confirm('Delete this weight entry?')) return;
      const res = await fetch(`/api/weight/${encodeURIComponent(state.selectedDayKey)}`, { method: 'DELETE' });
      if (res.ok) await refreshDay();
    }
  });

  document.getElementById('wellness-period-list').addEventListener('click', (event) => {
    const card = event.target.closest('[data-wellness-period]');
    if (!card) return;
    const period = card.dataset.wellnessPeriod;
    const entry = getWellnessMap()[period];
    openEntrySheet({ mode: entry ? 'edit' : 'add', kind: 'wellness', period, entry });
  });

  document.getElementById('entry-sheet-form').addEventListener('submit', handleSheetSubmit);
  document.getElementById('entry-sheet-delete').addEventListener('click', handleSheetDelete);
  document.getElementById('entry-sheet-close').addEventListener('click', closeEntrySheet);
  document.getElementById('entry-sheet').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeEntrySheet();
  });

  document.getElementById('entry-sheet-fields').addEventListener('change', (event) => {
    if (event.target.id === 'sheet-fluid-type') {
      const fluidType = event.target.value;
      const subtypeWrap = document.getElementById('sheet-subtype-wrap');
      const amountLabel = document.getElementById('sheet-amount-label');
      const amountInput = document.getElementById('sheet-amount-input');
      const isOutput = (state.sheet?.entryType || state.sheet?.entry?.entry_type) === 'output';
      if (amountLabel) amountLabel.textContent = isOutput ? 'Amount (g)' : 'Amount (ml)';
      if (subtypeWrap) subtypeWrap.style.display = fluidType === 'poop' ? 'flex' : 'none';
      if (amountInput && fluidType === 'poop') amountInput.placeholder = 'Optional';
      if (amountInput && fluidType !== 'poop') amountInput.placeholder = 'Enter amount';
    }
  });

  document.getElementById('entry-sheet-fields').addEventListener('input', (event) => {
    if (event.target.type === 'range') {
      const valueEl = document.getElementById(`${event.target.id.replace('-input', '')}-value`);
      if (valueEl) valueEl.textContent = event.target.value;
    }
  });
}

function applyInitialDateFromUrl() {
  const url = new URL(window.location.href);
  const date = url.searchParams.get('date');
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    state.selectedDayKey = date;
  }
}

setInterval(updateClock, 1000);
setInterval(refreshDay, 30000);
updateClock();
applyInitialDateFromUrl();
loadSettings();
initEventListeners();
refreshDay();


async function loadAppVersion() {
  const el = document.getElementById('app-version');
  if (!el) return;
  try {
    const res = await fetch('/api/version');
    if (!res.ok) throw new Error('version request failed');
    const info = await res.json();
    el.textContent = `Glide Bedside v${info.version}`;
  } catch (_) {
    el.textContent = 'Glide Bedside';
  }
}

loadAppVersion();
