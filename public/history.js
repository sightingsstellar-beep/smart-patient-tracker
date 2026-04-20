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

function buildTrendCard({ icon, title, subtitle, unit, points, colorClass, latestLabel, averageLabel }) {
  const validValues = points.map((point) => point.value).filter((value) => typeof value === 'number' && !Number.isNaN(value));
  const maxValue = validValues.length ? Math.max(...validValues) : 1;

  const bars = points.map((point) => {
    const heightPct = typeof point.value === 'number' && maxValue > 0
      ? Math.max(8, Math.round((point.value / maxValue) * 100))
      : 8;
    const emptyClass = typeof point.value === 'number' ? '' : ' trend-bar-btn--empty';
    const displayValue = typeof point.value === 'number' ? `${formatNumber(point.value)}${unit}` : 'No data';
    return `
      <button class="trend-bar-btn${emptyClass}" data-day-key="${point.dayKey}" title="${escapeHtml(point.label)}: ${escapeHtml(displayValue)}">
        <span class="trend-bar ${colorClass}" style="height:${heightPct}%"></span>
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
      icon: '⚖️',
      title: 'Weight trend',
      subtitle: 'Recorded weight by day',
      unit: ' kg',
      colorClass: 'trend-bar--purple',
      points: weightPoints,
      latestLabel: weightPoints[weightPoints.length - 1]?.value !== null ? `${formatNumber(weightPoints[weightPoints.length - 1].value)} kg` : 'No data',
      averageLabel: mean(weightPoints.map((point) => point.value)) !== null ? `${formatNumber(mean(weightPoints.map((point) => point.value)))} kg` : 'No data',
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
