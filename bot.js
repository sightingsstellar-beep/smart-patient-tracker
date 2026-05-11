/**
 * bot.js — Telegram bot logic
 *
 * Handles incoming messages from authorized users, parses them via OpenAI,
 * logs entries to the database, and sends confirmation messages.
 */

'use strict';

const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');
const { parseMessage } = require('./parser');
const { buildReport, formatFluidType, getDailyLimit } = require('./server');

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  throw new Error('TELEGRAM_BOT_TOKEN is not set in environment');
}

// Parse authorized user IDs from env
const AUTHORIZED_IDS = (process.env.AUTHORIZED_USER_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => parseInt(s, 10));

console.log(`[bot] Starting with ${AUTHORIZED_IDS.length} authorized user(s): ${AUTHORIZED_IDS.join(', ')}`);

// Use polling (works everywhere, no webhook setup needed)
const bot = new TelegramBot(token, { polling: true });

// ---------------------------------------------------------------------------
// Authorization middleware
// ---------------------------------------------------------------------------

function isAuthorized(userId) {
  return AUTHORIZED_IDS.includes(userId);
}

function rejectUnauthorized(chatId) {
  bot.sendMessage(
    chatId,
    "⛔ Sorry, you're not authorized to use this bot.\n\n" +
      'This is a private medical tracker for Elina. If you need access, please contact the administrator.'
  );
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatIntakeSummary(totalIntake) {
  const limit = getDailyLimit();
  const pct = Math.round((totalIntake / limit) * 100);
  const bar = buildProgressBar(pct);
  return `${bar} ${totalIntake}ml / ${limit}ml (${pct}%)`;
}

function buildProgressBar(percent) {
  const filled = Math.round(percent / 10);
  const empty = 10 - filled;
  return '🟦'.repeat(filled) + '⬜'.repeat(empty);
}

function titleCase(str) {
  return str.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatPoopSubtypeLabel(subtype) {
  const map = {
    normal: 'normal',
    diarrhea: 'diarrhea',
    undigested: 'undigested',
  };
  return map[subtype] || subtype;
}

/**
 * Builds a short confirmation message listing what was just logged,
 * with a brief intake + output summary.
 */
function buildConfirmation(actions, summary) {
  const parts = [];

  for (const action of actions) {
    if (action.type === 'input') {
      const label = formatFluidType(action.fluid_type);
      const amount = action.amount_ml ? `${action.amount_ml}ml` : '(no amount)';
      parts.push(`${amount} ${label}`);
    } else if (action.type === 'output') {
      const label = formatFluidType(action.fluid_type);
      const amount = action.amount_ml ? ` ${action.amount_ml}ml` : '';
      if (action.fluid_type === 'poop' && action.subtype) {
        parts.push(`${label} (${formatPoopSubtypeLabel(action.subtype)})${amount} (output)`);
      } else {
        parts.push(`${label}${amount} (output)`);
      }
    } else if (action.type === 'wellness') {
      parts.push(`Wellness check (${action.check_time})`);
    } else if (action.type === 'gag') {
      parts.push(`Gag ×${action.count}`);
    }
  }

  const logged = parts.length > 0 ? parts.join(' + ') : 'entry';
  const limit = getDailyLimit();
  const pct = Math.round((summary.totalIntake / limit) * 100);

  const totalOut = summary.outputs.reduce((sum, o) => sum + (o.amount_ml || 0), 0);
  const outStr = totalOut > 0 ? `${totalOut}g` : `${summary.outputs.length} event${summary.outputs.length !== 1 ? 's' : ''}`;

  return `✅ Logged: ${logged}\n💧 Total In: ${summary.totalIntake}/${limit}ml (${pct}%) · 🚽 Total Out: ${outStr}`;
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

// /start
bot.onText(/^\/start$/, (msg) => {
  if (!isAuthorized(msg.from.id)) return rejectUnauthorized(msg.chat.id);
  bot.sendMessage(
    msg.chat.id,
    `💙 *Elina Tracker* is ready!\n\n` +
      `Just send me natural language to log:\n` +
      `• *"120ml pediasure"* — log intake\n` +
      `• *"pee 85ml"* — log output\n` +
      `• *"gag x2"* — log gag episodes\n` +
      `• *"wellness: appetite 7, energy 4, mood 8, cyan 3"*\n\n` +
      `Commands: /today /status /report /undo`,
    { parse_mode: 'Markdown' }
  );
});

// /today — summary of current day
bot.onText(/^\/today$/, async (msg) => {
  if (!isAuthorized(msg.from.id)) return rejectUnauthorized(msg.chat.id);
  try {
    const dayKey = db.getDayKey();
    const summary = await db.getDaySummary(dayKey);
    const limit = getDailyLimit();
    const pct = Math.round((summary.totalIntake / limit) * 100);

    let text = `📅 *Today (${dayKey})*\n\n`;
    text += `💧 *Intake:* ${summary.totalIntake}ml / ${limit}ml (${pct}%)\n`;

    if (Object.keys(summary.intakeByType).length > 0) {
      for (const [type, ml] of Object.entries(summary.intakeByType)) {
        text += `  • ${formatFluidType(type)}: ${ml}ml\n`;
      }
    }

    text += `\n🚽 *Outputs:* ${summary.outputs.length}\n`;
    for (const o of summary.outputs) {
      const t = new Date(o.timestamp).toLocaleTimeString('en-US', {
        timeZone: process.env.TZ || 'America/New_York',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
      const amt = o.amount_ml ? ` ${o.amount_ml}ml` : '';
      const poopSubtype = o.fluid_type === 'poop' && o.subtype ? ` (${formatPoopSubtypeLabel(o.subtype)})` : '';
      text += `  • ${t} — ${formatFluidType(o.fluid_type)}${poopSubtype}${amt}\n`;
    }

    text += `\n🤢 *Gags:* ${summary.gagCount}\n`;

    if (summary.wellness.length > 0) {
      const w = summary.wellness[summary.wellness.length - 1];
      text += `\n❤️ *Wellness (${w.check_time}):*\n`;
      if (w.appetite !== null) text += `  Appetite: ${w.appetite}/10\n`;
      if (w.energy !== null) text += `  Energy: ${w.energy}/10\n`;
      if (w.mood !== null) text += `  Mood: ${w.mood}/10\n`;
      if (w.cyanosis !== null) text += `  Cyanosis: ${w.cyanosis}/10\n`;
    }

    bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('[bot /today]', err);
    bot.sendMessage(msg.chat.id, '❌ Error fetching today\'s data: ' + err.message);
  }
});

// /status — quick intake status
bot.onText(/^\/status$/, async (msg) => {
  if (!isAuthorized(msg.from.id)) return rejectUnauthorized(msg.chat.id);
  try {
    const dayKey = db.getDayKey();
    const summary = await db.getDaySummary(dayKey);
    const text = `💧 *Current intake:* ${formatIntakeSummary(summary.totalIntake)}`;
    bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(msg.chat.id, '❌ Error: ' + err.message);
  }
});

// /report — full nurse handoff report
bot.onText(/^\/report$/, async (msg) => {
  if (!isAuthorized(msg.from.id)) return rejectUnauthorized(msg.chat.id);
  try {
    const dayKey = db.getDayKey();
    const report = await buildReport(dayKey);
    bot.sendMessage(msg.chat.id, report);
  } catch (err) {
    console.error('[bot /report]', err);
    bot.sendMessage(msg.chat.id, '❌ Error generating report: ' + err.message);
  }
});

// /undo — remove last log entry
bot.onText(/^\/undo$/, async (msg) => {
  if (!isAuthorized(msg.from.id)) return rejectUnauthorized(msg.chat.id);
  try {
    const last = await db.getLastLog();
    if (!last) {
      return bot.sendMessage(msg.chat.id, '⚠️ Nothing to undo — no entries logged today.');
    }
    await db.deleteLog(last.id);
    const dayKey = db.getDayKey();
    const summary = await db.getDaySummary(dayKey);
    const label = formatFluidType(last.fluid_type);
    const amount = last.amount_ml ? ` ${last.amount_ml}ml` : '';
    bot.sendMessage(
      msg.chat.id,
      `↩️ Undone: ${label}${amount}\n` +
        `Total intake now: ${summary.totalIntake}ml / ${getDailyLimit()}ml`
    );
  } catch (err) {
    console.error('[bot /undo]', err);
    bot.sendMessage(msg.chat.id, '❌ Error: ' + err.message);
  }
});

// /help
bot.onText(/^\/help$/, (msg) => {
  if (!isAuthorized(msg.from.id)) return rejectUnauthorized(msg.chat.id);
  bot.sendMessage(
    msg.chat.id,
    `*Elina Tracker — Help*\n\n` +
      `*Log entries (just type naturally):*\n` +
      `• "120ml pediasure" — intake\n` +
      `• "pee 85ml" or "urine 85ml" — output\n` +
      `• "vomit, roughly 60ml" — output\n` +
      `• "pooped" — poop (no amount needed)\n` +
      `• "diarrhea" or "undigested poop" — poop subtype\n` +
      `• "gag x2" or "she gagged once"\n` +
      `• "wellness: appetite 7, energy 4, mood 8, cyan 3"\n\n` +
      `*Commands:*\n` +
      `/today — today's full summary\n` +
      `/status — quick intake total\n` +
      `/report — nurse handoff report\n` +
      `/undo — remove last entry\n` +
      `/help — this message`,
    { parse_mode: 'Markdown' }
  );
});

// ---------------------------------------------------------------------------
// Main message handler — NLP parsing
// ---------------------------------------------------------------------------

bot.on('message', async (msg) => {
  // Ignore commands (handled above) and non-text messages
  if (!msg.text || msg.text.startsWith('/')) return;
  if (!isAuthorized(msg.from.id)) return rejectUnauthorized(msg.chat.id);

  const chatId = msg.chat.id;

  // Send "typing" indicator while processing
  bot.sendChatAction(chatId, 'typing');

  let parsed;
  try {
    parsed = await parseMessage(msg.text);
  } catch (err) {
    console.error('[bot] Parser error:', err.message);
    return bot.sendMessage(
      chatId,
      '❌ Sorry, I couldn\'t process that — OpenAI API error.\n' +
        'Please try again or use the dashboard to log manually.'
    );
  }

  if (parsed.unparseable || parsed.actions.length === 0) {
    return bot.sendMessage(
      chatId,
      "🤔 I couldn't understand that entry.\n\n" +
        'Try something like:\n' +
        '• "120ml pediasure"\n' +
        '• "pee 85ml"\n' +
        '• "gag x2"\n' +
        '• "wellness: appetite 7, energy 4, mood 8, cyan 3"\n\n' +
        'Or type /help for more examples.'
    );
  }

  // Require a measurement for every input and output
  const missingAmount = parsed.actions.find((a) => {
    if (a.type === 'input') return !a.amount_ml;
    if (a.type === 'output') return a.fluid_type !== 'poop' && !a.amount_ml;
    return false;
  });
  if (missingAmount) {
    const label = formatFluidType(missingAmount.fluid_type);
    return bot.sendMessage(
      chatId,
      `⚠️ I need a measurement for *${label}*. How many ml was it?\n\nExample: _"${label} 80ml"_`,
      { parse_mode: 'Markdown' }
    );
  }

  // Persist all actions
  const now = Date.now();

  // Support "yesterday:" prefix via date_offset
  let dayKey;
  if (parsed.date_offset === -1) {
    const todayKey = db.getDayKey();
    const [y, m, d] = todayKey.split('-').map(Number);
    const yesterday = new Date(y, m - 1, d);
    yesterday.setDate(yesterday.getDate() - 1);
    dayKey = yesterday.toISOString().slice(0, 10);
  } else {
    dayKey = db.getDayKey();
  }

  let weightAction = null;

  for (const action of parsed.actions) {
    try {
      if (action.type === 'input' || action.type === 'output') {
        await db.logEntry({
          timestamp: now,
          day_key: dayKey,
          entry_type: action.type,
          fluid_type: action.fluid_type,
          amount_ml: action.amount_ml,
          subtype: action.subtype ?? null,
          source: 'telegram',
        });
      } else if (action.type === 'wellness') {
        await db.logWellness({
          timestamp: now,
          day_key: dayKey,
          check_time: action.check_time,
          appetite: action.appetite,
          energy: action.energy,
          mood: action.mood,
          cyanosis: action.cyanosis,
        });
      } else if (action.type === 'gag') {
        await db.logGag(action.count, now, dayKey);
      } else if (action.type === 'weight') {
        await db.logWeight(dayKey, action.weight_kg, null);
        weightAction = action;
      }
    } catch (dbErr) {
      console.error('[bot] DB error logging action:', dbErr.message, action);
    }
  }

  // If weight was logged, send a dedicated weight confirmation with trend
  if (weightAction !== null) {
    try {
      // Look up yesterday's weight for trend
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayKey = db.getDayKey(yesterday);
      const prevEntry = await db.getWeightForDate(yesterdayKey);

      let trendStr = '';
      if (prevEntry && typeof prevEntry.weight_kg === 'number') {
        const diff = Math.round((weightAction.weight_kg - prevEntry.weight_kg) * 10) / 10;
        if (diff > 0.1) {
          trendStr = ` (↑ ${diff} kg vs yesterday)`;
        } else if (diff < -0.1) {
          trendStr = ` (↓ ${Math.abs(diff)} kg vs yesterday)`;
        } else {
          trendStr = ' (→ stable vs yesterday)';
        }
      }

      bot.sendMessage(chatId, `⚖️ Weight logged: ${weightAction.weight_kg} kg${trendStr}`);
    } catch (weightErr) {
      console.error('[bot] Weight confirmation error:', weightErr.message);
      bot.sendMessage(chatId, `⚖️ Weight logged: ${weightAction.weight_kg} kg`);
    }

    // If weight was the only action, skip the standard fluid confirmation
    if (parsed.actions.every((a) => a.type === 'weight')) return;
  }

  // Build and send confirmation
  const summary = await db.getDaySummary(dayKey);
  const confirmation = buildConfirmation(parsed.actions, summary) +
    (parsed.date_offset === -1 ? '\n📅 _Logged for yesterday_' : '');
  bot.sendMessage(chatId, confirmation, { parse_mode: 'Markdown' });

  // Warn if over daily limit
  const dailyLimit = getDailyLimit();
  if (summary.totalIntake > dailyLimit) {
    const over = summary.totalIntake - dailyLimit;
    bot.sendMessage(
      chatId,
      `⚠️ *Daily limit exceeded!* Elina is ${over}ml over the ${dailyLimit}ml limit.`,
      { parse_mode: 'Markdown' }
    );
  }
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

bot.on('polling_error', (err) => {
  // Log but don't crash — polling errors are often transient
  console.error('[bot] Polling error:', err.code, err.message);
});

bot.on('error', (err) => {
  console.error('[bot] Bot error:', err.message);
});

// Graceful shutdown — stop polling before process exits.
// Prevents the 409 Conflict error during Railway rolling deploys
// (old container and new container briefly overlap).
process.on('SIGTERM', () => {
  console.log('[bot] SIGTERM received — stopping polling gracefully');
  bot.stopPolling()
    .then(() => {
      console.log('[bot] Polling stopped');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[bot] Error stopping polling:', err.message);
      process.exit(1);
    });
});

console.log('[bot] Telegram bot started and polling for messages');

module.exports = bot;
