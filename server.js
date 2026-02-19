/**
 * server.js — Express API server + static dashboard
 *
 * Starts the web server, mounts API routes, serves the dashboard,
 * and kicks off the Telegram bot and cron scheduler.
 */

'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const DAILY_LIMIT_ML = 1200;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatFluidType(type) {
  const map = {
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
  return map[type] || type;
}

function formatTimestamp(tsMs) {
  const tz = process.env.TZ || 'America/New_York';
  return new Date(tsMs).toLocaleTimeString('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

// ---------------------------------------------------------------------------
// API Routes
// ---------------------------------------------------------------------------

/**
 * GET /api/today
 * Returns all data for the current fluid day.
 */
app.get('/api/today', (req, res) => {
  try {
    const dayKey = db.getDayKey();
    const summary = db.getDaySummary(dayKey);
    res.json({
      ok: true,
      dayKey,
      limit_ml: DAILY_LIMIT_ML,
      totalIntake: summary.totalIntake,
      percent: Math.round((summary.totalIntake / DAILY_LIMIT_ML) * 100),
      intakeByType: summary.intakeByType,
      inputs: summary.inputs.map((l) => ({
        ...l,
        time: formatTimestamp(l.timestamp),
        fluid_type_label: formatFluidType(l.fluid_type),
      })),
      outputs: summary.outputs.map((l) => ({
        ...l,
        time: formatTimestamp(l.timestamp),
        fluid_type_label: formatFluidType(l.fluid_type),
      })),
      wellness: summary.wellness,
      gags: summary.gags.map((g) => ({
        ...g,
        time: formatTimestamp(g.timestamp),
      })),
      gagCount: summary.gagCount,
    });
  } catch (err) {
    console.error('[GET /api/today]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/report
 * Returns the formatted nurse handoff report for today.
 */
app.get('/api/report', (req, res) => {
  try {
    const dayKey = db.getDayKey();
    const text = buildReport(dayKey);
    res.json({ ok: true, dayKey, report: text });
  } catch (err) {
    console.error('[GET /api/report]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/log
 * Log a fluid entry, wellness check, or gag event directly via API.
 * Body: { entry_type, fluid_type, amount_ml, notes, source }
 *   OR  { type: 'wellness', check_time, appetite, energy, mood, cyanosis }
 *   OR  { type: 'gag', count }
 */
app.post('/api/log', (req, res) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ ok: false, error: 'Invalid request body' });
    }

    const results = [];

    if (body.type === 'wellness') {
      const w = db.logWellness({
        check_time: body.check_time || '5pm',
        appetite: body.appetite ?? null,
        energy: body.energy ?? null,
        mood: body.mood ?? null,
        cyanosis: body.cyanosis ?? null,
        source: 'api',
      });
      results.push({ kind: 'wellness', data: w });
    } else if (body.type === 'gag') {
      const count = Math.max(1, parseInt(body.count, 10) || 1);
      const gags = db.logGag(count);
      results.push({ kind: 'gag', count, data: gags });
    } else {
      // Fluid input or output
      const entry = db.logEntry({
        entry_type: body.entry_type,
        fluid_type: body.fluid_type,
        amount_ml: body.amount_ml ?? null,
        notes: body.notes ?? null,
        source: 'api',
      });
      results.push({ kind: 'fluid', data: entry });
    }

    const summary = db.getDaySummary(db.getDayKey());
    res.json({ ok: true, results, totalIntake: summary.totalIntake });
  } catch (err) {
    console.error('[POST /api/log]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/history?days=7
 * Returns logs for the last N fluid days.
 */
app.get('/api/history', (req, res) => {
  try {
    const days = Math.min(30, Math.max(1, parseInt(req.query.days, 10) || 7));
    const logs = db.getLogsForDays(days);
    res.json({ ok: true, days, logs });
  } catch (err) {
    console.error('[GET /api/history]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * DELETE /api/log/:id
 * Remove a specific log entry by ID.
 */
app.delete('/api/log/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) {
      return res.status(400).json({ ok: false, error: 'Invalid ID' });
    }
    const result = db.deleteLog(id);
    if (result.changes === 0) {
      return res.status(404).json({ ok: false, error: 'Entry not found' });
    }
    res.json({ ok: true, deleted: id });
  } catch (err) {
    console.error('[DELETE /api/log/:id]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Fallback — serve dashboard for any unknown route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// Report builder (shared by API and scheduler)
// ---------------------------------------------------------------------------

function buildReport(dayKey) {
  const summary = db.getDaySummary(dayKey);
  const tz = process.env.TZ || 'America/New_York';
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true });

  const percent = Math.round((summary.totalIntake / DAILY_LIMIT_ML) * 100);

  let report = `📊 Elina's Report — ${dateStr} ${timeStr}\n`;
  report += `━━━━━━━━━━━━━━━━━━━━━━━\n`;
  report += `\n💧 FLUID INTAKE: ${summary.totalIntake}ml / ${DAILY_LIMIT_ML}ml (${percent}%)\n`;

  if (Object.keys(summary.intakeByType).length > 0) {
    for (const [type, ml] of Object.entries(summary.intakeByType)) {
      report += `  ${formatFluidType(type)}: ${ml}ml\n`;
    }
  } else {
    report += `  No intake logged\n`;
  }

  report += `\n🚽 OUTPUTS:\n`;
  if (summary.outputs.length > 0) {
    for (const o of summary.outputs) {
      const time = formatTimestamp(o.timestamp);
      const amount = o.amount_ml ? ` ${o.amount_ml}ml` : '';
      report += `  ${time} — ${formatFluidType(o.fluid_type)}${amount}\n`;
    }
  } else {
    report += `  No outputs logged\n`;
  }

  report += `\n🤢 Gag episodes: ${summary.gagCount}\n`;

  // Latest wellness check
  if (summary.wellness.length > 0) {
    const latest = summary.wellness[summary.wellness.length - 1];
    report += `\n❤️ WELLNESS (${latest.check_time} check):\n`;
    if (latest.appetite !== null) report += `  Appetite: ${latest.appetite}/10\n`;
    if (latest.energy !== null) report += `  Energy: ${latest.energy}/10\n`;
    if (latest.mood !== null) report += `  Mood: ${latest.mood}/10\n`;
    if (latest.cyanosis !== null) report += `  Cyanosis: ${latest.cyanosis}/10\n`;
  } else {
    report += `\n❤️ WELLNESS: No check logged yet\n`;
  }

  report += `━━━━━━━━━━━━━━━━━━━━━━━`;
  return report;
}

// Export for use by bot and scheduler
module.exports.buildReport = buildReport;
module.exports.formatFluidType = formatFluidType;
module.exports.DAILY_LIMIT_ML = DAILY_LIMIT_ML;

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`[server] Elina Tracker running on port ${PORT}`);
  console.log(`[server] Dashboard: http://localhost:${PORT}`);
  console.log(`[server] Fluid day TZ: ${process.env.TZ || 'America/New_York'}`);
});

// Start Telegram bot (non-fatal if token missing in dev)
try {
  require('./bot');
} catch (err) {
  console.warn('[server] Bot failed to start:', err.message);
}

// Start cron scheduler
try {
  require('./scheduler');
} catch (err) {
  console.warn('[server] Scheduler failed to start:', err.message);
}
