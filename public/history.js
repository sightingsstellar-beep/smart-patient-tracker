'use strict';

const state = {
  range: 7,
  days: [],
  weightByDate: {},
};

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

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
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

function shortDayLabel(dayKey) {
  const [year, month, day] = dayKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  return date.toLocaleDateString('en-US', {
    month: 'numeric',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function formatNumber(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return Math.round(value * 10) / 10;
}

function formatSignedValue(value, unit = '') {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const formatted = formatNumber(value);
  const sign = value > 0 ? '+' : '';
  return `${sign}${formatted}${unit}`;
}

function mean(values) {
  const nums = values.filter((value) => typeof value === 'number' && !Number.isNaN(value));
  if (!nums.length) return null;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function computeWellnessAverage(day) {
  const periods = [day.wellness?.afternoon, day.wellness?.evening].filter(Boolean);
  const scores = [];
  for (const period of periods) {
    if (typeof period.energy === 'number') scores.push(period.energy);
    if (typeof period.appetite === 'number') scores.push(period.appetite);
    if (typeof period.mood === 'number') scores.push(period.mood);
  }
  return mean(scores);
}

function buildTrendCard({ icon, title, subtitle, unit, points, colorClass, latestLabel, averageLabel, signed = false, negativeColorClass = 'trend-bar--red' }) {
  const validValues = points.map((point) => point.value).filter((value) => typeof value === 'number' && !Number.isNaN(value));
  const maxValue = signed
    ? (validValues.length ? Math.max(...validValues.map((value) => Math.abs(value))) : 1)
    : (validValues.length ? Math.max(...validValues) : 1);

  const bars = points.map((point) => {
    const isNumber = typeof point.value === 'number' && !Number.isNaN(point.value);
    const magnitude = isNumber ? Math.abs(point.value) : 0;
    const heightPct = isNumber && maxValue > 0
      ? Math.max(8, Math.round((magnitude / maxValue) * (signed ? 50 : 100)))
      : 8;
    const emptyClass = isNumber ? '' : ' trend-bar-btn--empty';
    const displayValue = isNumber
      ? (signed ? formatSignedValue(point.value, unit) : `${formatNumber(point.value)}${unit}`)
      : 'No data';
    const signedBarClass = signed
      ? ` trend-bar--signed ${point.value < 0 ? 'trend-bar--signed-negative' : 'trend-bar--signed-positive'} ${point.value < 0 ? negativeColorClass : colorClass}`
      : '';
    const barShellClass = signed ? 'trend-bar-shell trend-bar-shell--signed' : 'trend-bar-shell';
    const barHtml = signed
      ? `
          <span class="trend-bar-baseline"></span>
          <span class="trend-bar${signedBarClass}" style="height:${heightPct}%"></span>
        `
      : `<span class="trend-bar ${colorClass}" style="height:${heightPct}%"></span>`;
    return `
      <button class="trend-bar-btn${emptyClass}" data-day-key="${point.dayKey}" title="${escapeHtml(point.label)}: ${escapeHtml(displayValue)}">
        <span class="${barShellClass}">
          ${barHtml}
        </span>
        <span class="trend-bar-date">${escapeHtml(shortDayLabel(point.dayKey))}</span>
      </button>
    `;
  }).join('');

  return `
    <section class="trend-card card">
      <div class="trend-card-header">
        <div>
          <h3>${escapeHtml(icon)} ${escapeHtml(title)}</h3>
          <p>${escapeHtml(subtitle)}</p>
        </div>
      </div>
      <div class="trend-stats">
        <div class="trend-stat">
          <span class="trend-stat-label">Latest</span>
          <span class="trend-stat-value">${escapeHtml(latestLabel)}</span>
        </div>
        <div class="trend-stat">
          <span class="trend-stat-label">Average</span>
          <span class="trend-stat-value">${escapeHtml(averageLabel)}</span>
        </div>
      </div>
      <div class="trend-chart-scroll">
        <div class="trend-bars" style="grid-template-columns: repeat(${points.length}, minmax(28px, 1fr));">
          ${bars}
        </div>
      </div>
    </section>
  `;
}

function buildLineTrendCard({ icon, title, subtitle, unit, points, colorClass, latestLabel, averageLabel }) {
  const validPoints = points
    .map((point, index) => ({ ...point, index }))
    .filter((point) => typeof point.value === 'number' && !Number.isNaN(point.value));
  const values = validPoints.map((point) => point.value);
  const minValue = values.length ? Math.min(...values) : 0;
  const maxValue = values.length ? Math.max(...values) : 1;
  const range = maxValue - minValue || 1;
  const chartWidth = Math.max(points.length * 44, 220);

  const toX = (index) => (points.length <= 1 ? 50 : 4 + ((index / (points.length - 1)) * 92));
  const toY = (value) => {
    if (!values.length) return 50;
    const normalized = (value - minValue) / range;
    return 88 - (normalized * 76);
  };

  const polylinePoints = validPoints
    .map((point) => `${toX(point.index)},${toY(point.value)}`)
    .join(' ');

  const polylines = polylinePoints
    ? `<polyline class="trend-line-path ${colorClass}" points="${polylinePoints}" />`
    : '';

  const pointsHtml = validPoints.map((point) => {
    const x = toX(point.index);
    const y = toY(point.value);
    return `
      <button
        class="trend-line-point-btn"
        data-day-key="${point.dayKey}"
        title="${escapeHtml(point.label)}: ${escapeHtml(`${formatNumber(point.value)}${unit}`)}"
        style="left:${x}%; top:${y}%;"
      >
        <span class="trend-line-point ${colorClass}"></span>
      </button>
    `;
  }).join('');

  const labels = points.map((point) => {
    const isNumber = typeof point.value === 'number' && !Number.isNaN(point.value);
    const labelValue = isNumber ? `${formatNumber(point.value)}${unit}` : 'No data';
    return `
      <button class="trend-line-label-btn${isNumber ? '' : ' trend-line-label-btn--empty'}" data-day-key="${point.dayKey}" title="${escapeHtml(point.label)}: ${escapeHtml(labelValue)}">
        <span class="trend-line-label-date">${escapeHtml(shortDayLabel(point.dayKey))}</span>
      </button>
    `;
  }).join('');

  return `
    <section class="trend-card card">
      <div class="trend-card-header">
        <div>
          <h3>${escapeHtml(icon)} ${escapeHtml(title)}</h3>
          <p>${escapeHtml(subtitle)}</p>
        </div>
      </div>
      <div class="trend-stats">
        <div class="trend-stat">
          <span class="trend-stat-label">Latest</span>
          <span class="trend-stat-value">${escapeHtml(latestLabel)}</span>
        </div>
        <div class="trend-stat">
          <span class="trend-stat-label">Average</span>
          <span class="trend-stat-value">${escapeHtml(averageLabel)}</span>
        </div>
      </div>
      <div class="trend-chart-scroll">
        <div class="trend-line-card-inner" style="min-width:${chartWidth}px;">
          <div class="trend-line-shell">
            <div class="trend-line-plot">
              <div class="trend-line-grid">
                <span></span>
                <span></span>
                <span></span>
              </div>
              <svg class="trend-line-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                ${polylines}
              </svg>
              ${pointsHtml}
            </div>
          </div>
          <div class="trend-line-labels" style="grid-template-columns: repeat(${points.length}, minmax(44px, 1fr));">
            ${labels}
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderTrends() {
  const container = document.getElementById('trends-container');
  if (!state.days.length) {
    container.innerHTML = '<div class="h-loading">No history found.</div>';
    return;
  }

  const orderedDays = [...state.days].reverse();

  const intakePoints = orderedDays.map((day) => ({
    dayKey: day.dayKey,
    label: day.label,
    value: day.intake?.total_ml || 0,
  }));

  const outputPoints = orderedDays.map((day) => ({
    dayKey: day.dayKey,
    label: day.label,
    value: day.outputs?.length || 0,
  }));

  const balancePoints = orderedDays.map((day) => {
    const intakeTotal = day.intake?.total_ml || 0;
    const outputTotal = (day.outputs || []).reduce((sum, entry) => sum + (Number(entry.amount_ml) || 0), 0);
    return {
      dayKey: day.dayKey,
      label: day.label,
      value: intakeTotal - outputTotal,
    };
  });

  const gagPoints = orderedDays.map((day) => ({
    dayKey: day.dayKey,
    label: day.label,
    value: day.gagCount || 0,
  }));

  const weightPoints = orderedDays.map((day) => ({
    dayKey: day.dayKey,
    label: day.label,
    value: state.weightByDate[day.dayKey] ?? null,
  }));

  const wellnessPoints = orderedDays.map((day) => ({
    dayKey: day.dayKey,
    label: day.label,
    value: computeWellnessAverage(day),
  }));

  const cards = [
    buildTrendCard({
      icon: '⚖️',
      title: 'Fluid balance',
      subtitle: 'Daily intake minus measured output',
      unit: ' net',
      colorClass: 'trend-bar--green',
      negativeColorClass: 'trend-bar--red',
      signed: true,
      points: balancePoints,
      latestLabel: formatSignedValue(balancePoints[balancePoints.length - 1]?.value || 0, ' net'),
      averageLabel: formatSignedValue(mean(balancePoints.map((point) => point.value)) || 0, ' / day'),
    }),
    buildLineTrendCard({
      icon: '⚖️',
      title: 'Weight trend',
      subtitle: 'Recorded weight by day',
      unit: ' kg',
      colorClass: 'trend-line--purple',
      points: weightPoints,
      latestLabel: weightPoints[weightPoints.length - 1]?.value !== null ? `${formatNumber(weightPoints[weightPoints.length - 1].value)} kg` : 'No data',
      averageLabel: mean(weightPoints.map((point) => point.value)) !== null ? `${formatNumber(mean(weightPoints.map((point) => point.value)))} kg` : 'No data',
    }),
    buildTrendCard({
      icon: '💧',
      title: 'Intake over time',
      subtitle: 'Daily total intake',
      unit: ' ml',
      colorClass: 'trend-bar--blue',
      points: intakePoints,
      latestLabel: `${formatNumber(intakePoints[intakePoints.length - 1]?.value || 0)} ml`,
      averageLabel: `${formatNumber(mean(intakePoints.map((point) => point.value)) || 0)} ml`,
    }),
    buildTrendCard({
      icon: '🚽',
      title: 'Output events',
      subtitle: 'Daily count of output entries',
      unit: '',
      colorClass: 'trend-bar--green',
      points: outputPoints,
      latestLabel: `${formatNumber(outputPoints[outputPoints.length - 1]?.value || 0)} events`,
      averageLabel: `${formatNumber(mean(outputPoints.map((point) => point.value)) || 0)} / day`,
    }),
    buildTrendCard({
      icon: '🤢',
      title: 'Gag frequency',
      subtitle: 'Daily gag episodes',
      unit: '',
      colorClass: 'trend-bar--red',
      points: gagPoints,
      latestLabel: `${formatNumber(gagPoints[gagPoints.length - 1]?.value || 0)} episodes`,
      averageLabel: `${formatNumber(mean(gagPoints.map((point) => point.value)) || 0)} / day`,
    }),
    buildTrendCard({
      icon: '❤️',
      title: 'Wellness average',
      subtitle: 'Average of energy, appetite, and mood',
      unit: '',
      colorClass: 'trend-bar--orange',
      points: wellnessPoints,
      latestLabel: wellnessPoints[wellnessPoints.length - 1]?.value !== null ? `${formatNumber(wellnessPoints[wellnessPoints.length - 1].value)} / 10` : 'No data',
      averageLabel: mean(wellnessPoints.map((point) => point.value)) !== null ? `${formatNumber(mean(wellnessPoints.map((point) => point.value)))} / 10` : 'No data',
    }),
  ];

  container.innerHTML = cards.join('');
}

async function loadTrends() {
  const container = document.getElementById('trends-container');
  container.innerHTML = '<div class="h-loading">Loading trends…</div>';

  try {
    const [historyRes, weightRes] = await Promise.all([
      fetch(`/api/history?days=${state.range}`),
      fetch(`/api/weight/history?days=${state.range}`),
    ]);

    if (!historyRes.ok) throw new Error(`HTTP ${historyRes.status}`);
    const historyData = await historyRes.json();
    if (!historyData.ok || !Array.isArray(historyData.days)) {
      throw new Error('Invalid response from server');
    }

    state.days = historyData.days;
    state.weightByDate = {};

    if (weightRes.ok) {
      const weightData = await weightRes.json();
      if (weightData.ok && Array.isArray(weightData.entries)) {
        for (const entry of weightData.entries) {
          state.weightByDate[entry.date] = entry.weight_kg;
        }
      }
    }

    renderTrends();
    document.getElementById('last-updated').textContent = new Date().toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
    });
  } catch (err) {
    console.error('[trends] Load error:', err.message);
    container.innerHTML = `<div class="h-error">⚠️ Failed to load trends: ${escapeHtml(err.message)}</div>`;
  }
}

function initEvents() {
  document.getElementById('refresh-btn').addEventListener('click', loadTrends);
  document.getElementById('range-pills').addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-range]');
    if (!btn) return;
    state.range = parseInt(btn.dataset.range, 10) || 7;
    document.querySelectorAll('.range-pill').forEach((pill) => pill.classList.toggle('active', pill === btn));
    await loadTrends();
  });

  document.getElementById('trends-container').addEventListener('click', (event) => {
    const bar = event.target.closest('[data-day-key]');
    if (!bar) return;
    const dayKey = bar.dataset.dayKey;
    if (!dayKey) return;
    window.location.href = dayKey ? `/?date=${encodeURIComponent(dayKey)}` : '/';
  });
}

setInterval(updateClock, 1000);
updateClock();
loadSettings();
initEvents();
loadTrends();
