/**
 * scheduler.js — Cron jobs for automated reports and day resets
 *
 * Schedule (all times in TZ configured by env):
 *   7:00 AM  — Fluid day rolls over (DB handles this via getDayKey)
 *   7:00 PM  — Send evening report to all authorized users
 *  10:00 PM  — Send night report to all authorized users
 */

'use strict';

const cron = require('node-cron');
const db = require('./db');
const { buildReport } = require('./server');

// We lazy-require the bot to avoid circular dependency issues at startup
function getBot() {
  return require('./bot');
}

const AUTHORIZED_IDS = (process.env.AUTHORIZED_USER_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => parseInt(s, 10));

const tz = process.env.TZ || 'America/New_York';

/**
 * Send a report to all authorized users.
 */
async function sendScheduledReport(label) {
  if (AUTHORIZED_IDS.length === 0) {
    console.warn('[scheduler] No authorized users configured — skipping report send');
    return;
  }

  let bot;
  try {
    bot = getBot();
  } catch (err) {
    console.error('[scheduler] Could not get bot instance:', err.message);
    return;
  }

  const dayKey = db.getDayKey();
  let report;
  try {
    report = buildReport(dayKey);
  } catch (err) {
    console.error('[scheduler] Error building report:', err.message);
    report = `❌ Error generating ${label} report: ${err.message}`;
  }

  for (const userId of AUTHORIZED_IDS) {
    try {
      await bot.sendMessage(userId, report);
      console.log(`[scheduler] ${label} report sent to user ${userId}`);
    } catch (err) {
      // Common cause: user hasn't started the bot yet (403 Forbidden)
      console.error(`[scheduler] Failed to send report to ${userId}:`, err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Cron schedules
// ---------------------------------------------------------------------------

// 7:00 PM daily — evening handoff report
cron.schedule(
  '0 19 * * *',
  () => {
    console.log('[scheduler] Triggering 7pm report');
    sendScheduledReport('7pm').catch(console.error);
  },
  { timezone: tz }
);

// 10:00 PM daily — night report
cron.schedule(
  '0 22 * * *',
  () => {
    console.log('[scheduler] Triggering 10pm report');
    sendScheduledReport('10pm').catch(console.error);
  },
  { timezone: tz }
);

console.log(`[scheduler] Cron jobs scheduled (TZ: ${tz})`);
console.log('[scheduler] Reports will auto-send at 7pm and 10pm');

module.exports = { sendScheduledReport };
