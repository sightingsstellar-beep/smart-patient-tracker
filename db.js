/**
 * db.js — SQLite database schema and query helpers
 *
 * Schema overview:
 *   fluid_logs  — intake and output entries
 *   wellness_checks — 5pm / 10pm daily wellness scores
 *   gag_events  — individual gag episodes
 *   settings    — key-value app configuration
 */

'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Store DB in /data on Railway (persistent volume) or local ./data
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'elina.db');
const db = new Database(dbPath);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS fluid_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   INTEGER NOT NULL,          -- Unix ms (UTC)
    day_key     TEXT NOT NULL,             -- "YYYY-MM-DD" of the fluid day (starts 7am)
    entry_type  TEXT NOT NULL,             -- 'input' | 'output'
    fluid_type  TEXT NOT NULL,             -- e.g. 'water', 'urine', 'poop'
    amount_ml   REAL,                      -- nullable for outputs like poop
    subtype     TEXT,                      -- nullable poop subtype: normal | diarrhea | undigested
    notes       TEXT,
    source      TEXT DEFAULT 'telegram'    -- 'telegram' | 'api'
  );

  CREATE TABLE IF NOT EXISTS wellness_checks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   INTEGER NOT NULL,
    day_key     TEXT NOT NULL,
    check_time  TEXT NOT NULL,             -- '5pm' | '10pm'
    appetite    INTEGER,                   -- 1–10
    energy      INTEGER,
    mood        INTEGER,
    cyanosis    INTEGER
  );

  CREATE TABLE IF NOT EXISTS gag_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   INTEGER NOT NULL,
    day_key     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Backward-compatible migration for existing DBs
try { db.prepare('ALTER TABLE fluid_logs ADD COLUMN subtype TEXT').run(); } catch (e) {}

// Weight logs table — separate exec so it can be added independently
db.exec(`
  CREATE TABLE IF NOT EXISTS weight_logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    date       TEXT    NOT NULL UNIQUE,
    weight_kg  REAL    NOT NULL,
    logged_at  TEXT    NOT NULL,
    notes      TEXT
  );
`);

// ---------------------------------------------------------------------------
// Day key helper  —  fluid day starts at 7:00 AM
// ---------------------------------------------------------------------------

/**
 * Given a Date (or now), return the "fluid day" key string "YYYY-MM-DD".
 * If the time (in the configured TZ) is before day_start_hour we belong to the
 * previous calendar day's fluid day.
 */
function getDayKey(date = new Date()) {
  // Determine local time in the configured timezone
  // Use settings if available, fallback to env/default
  let tz;
  try {
    tz = (typeof getSetting === 'function' ? getSetting('timezone') : null) ||
         process.env.TZ || 'America/New_York';
  } catch (_) {
    tz = process.env.TZ || 'America/New_York';
  }

  const localStr = date.toLocaleString('en-CA', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  // en-CA gives "YYYY-MM-DD, HH:MM"
  const [datePart, timePart] = localStr.split(', ');
  const [hStr] = timePart.split(':');
  const hour = parseInt(hStr, 10);

  const [year, month, day] = datePart.split('-').map(Number);
  const dateObj = new Date(year, month - 1, day);

  // Before day_start_hour → belongs to the previous fluid day
  let dayStartHour = 7;
  try {
    if (typeof getSetting === 'function') {
      dayStartHour = parseInt(getSetting('day_start_hour'), 10) || 7;
    }
  } catch (_) {}

  if (hour < dayStartHour) {
    dateObj.setDate(dateObj.getDate() - 1);
  }

  return dateObj.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// fluid_logs queries
// ---------------------------------------------------------------------------

const insertLog = db.prepare(`
  INSERT INTO fluid_logs (timestamp, day_key, entry_type, fluid_type, amount_ml, subtype, notes, source)
  VALUES (@timestamp, @day_key, @entry_type, @fluid_type, @amount_ml, @subtype, @notes, @source)
`);

const getLogByIdStmt = db.prepare('SELECT * FROM fluid_logs WHERE id = ?');

const updateLogStmt = db.prepare(`
  UPDATE fluid_logs
     SET timestamp = @timestamp,
         day_key = @day_key,
         entry_type = @entry_type,
         fluid_type = @fluid_type,
         amount_ml = @amount_ml,
         subtype = @subtype,
         notes = @notes
   WHERE id = @id
`);

function logEntry(entry) {
  const now = Date.now();
  const row = {
    timestamp: entry.timestamp || now,
    day_key: entry.day_key || getDayKey(new Date(entry.timestamp || now)),
    entry_type: entry.entry_type,
    fluid_type: entry.fluid_type,
    amount_ml: entry.amount_ml ?? null,
    subtype: entry.subtype ?? null,
    notes: entry.notes ?? null,
    source: entry.source || 'telegram',
  };
  const result = insertLog.run(row);
  return { id: result.lastInsertRowid, ...row };
}

function getLogsByDay(dayKey) {
  return db
    .prepare('SELECT * FROM fluid_logs WHERE day_key = ? ORDER BY timestamp ASC')
    .all(dayKey);
}

function getLastLog() {
  return db.prepare('SELECT * FROM fluid_logs ORDER BY id DESC LIMIT 1').get();
}

function getLogById(id) {
  return getLogByIdStmt.get(id) || null;
}

function updateLog(entry) {
  const row = {
    id: entry.id,
    timestamp: entry.timestamp,
    day_key: entry.day_key,
    entry_type: entry.entry_type,
    fluid_type: entry.fluid_type,
    amount_ml: entry.amount_ml ?? null,
    subtype: entry.subtype ?? null,
    notes: entry.notes ?? null,
  };
  return updateLogStmt.run(row);
}

function deleteLog(id) {
  return db.prepare('DELETE FROM fluid_logs WHERE id = ?').run(id);
}

function getLogsForDays(days) {
  // Collect the day keys for the last N fluid days
  const keys = [];
  const d = new Date();
  for (let i = 0; i < days; i++) {
    const shifted = new Date(d);
    shifted.setDate(shifted.getDate() - i);
    keys.push(getDayKey(shifted));
  }
  const unique = [...new Set(keys)];
  const placeholders = unique.map(() => '?').join(',');
  return db
    .prepare(`SELECT * FROM fluid_logs WHERE day_key IN (${placeholders}) ORDER BY timestamp ASC`)
    .all(...unique);
}

function getWellnessForDays(days) {
  // Collect the day keys for the last N fluid days
  const keys = [];
  const d = new Date();
  for (let i = 0; i < days; i++) {
    const shifted = new Date(d);
    shifted.setDate(shifted.getDate() - i);
    keys.push(getDayKey(shifted));
  }
  const unique = [...new Set(keys)];
  const placeholders = unique.map(() => '?').join(',');
  return db
    .prepare(`SELECT * FROM wellness_checks WHERE day_key IN (${placeholders}) ORDER BY timestamp ASC`)
    .all(...unique);
}

// ---------------------------------------------------------------------------
// wellness_checks queries
// ---------------------------------------------------------------------------

const insertWellness = db.prepare(`
  INSERT INTO wellness_checks (timestamp, day_key, check_time, appetite, energy, mood, cyanosis)
  VALUES (@timestamp, @day_key, @check_time, @appetite, @energy, @mood, @cyanosis)
`);

const getLatestWellnessEntryStmt = db.prepare(`
  SELECT *
    FROM wellness_checks
   WHERE day_key = ? AND check_time = ?
   ORDER BY timestamp DESC, id DESC
   LIMIT 1
`);

const updateWellnessStmt = db.prepare(`
  UPDATE wellness_checks
     SET timestamp = @timestamp,
         day_key = @day_key,
         check_time = @check_time,
         appetite = @appetite,
         energy = @energy,
         mood = @mood,
         cyanosis = @cyanosis
   WHERE id = @id
`);

function logWellness(entry) {
  const now = Date.now();
  const row = {
    timestamp: entry.timestamp || now,
    day_key: entry.day_key || getDayKey(new Date(entry.timestamp || now)),
    check_time: entry.check_time || '5pm',
    appetite: entry.appetite ?? null,
    energy: entry.energy ?? null,
    mood: entry.mood ?? null,
    cyanosis: entry.cyanosis ?? null,
  };
  const result = insertWellness.run(row);
  return { id: result.lastInsertRowid, ...row };
}

function getWellnessByDay(dayKey) {
  return db
    .prepare('SELECT * FROM wellness_checks WHERE day_key = ? ORDER BY timestamp ASC')
    .all(dayKey);
}

function getLastWellness() {
  return db.prepare('SELECT * FROM wellness_checks ORDER BY id DESC LIMIT 1').get();
}

function getLatestWellnessEntry(dayKey, checkTime) {
  return getLatestWellnessEntryStmt.get(dayKey, checkTime) || null;
}

function upsertWellness(entry) {
  const now = entry.timestamp || Date.now();
  const dayKey = entry.day_key || getDayKey(new Date(now));
  const checkTime = entry.check_time || '5pm';
  const existing = getLatestWellnessEntry(dayKey, checkTime);

  if (existing) {
    const row = {
      id: existing.id,
      timestamp: now,
      day_key: dayKey,
      check_time: checkTime,
      appetite: entry.appetite ?? null,
      energy: entry.energy ?? null,
      mood: entry.mood ?? null,
      cyanosis: entry.cyanosis ?? null,
    };
    updateWellnessStmt.run(row);
    return { ...existing, ...row };
  }

  return logWellness({
    timestamp: now,
    day_key: dayKey,
    check_time: checkTime,
    appetite: entry.appetite ?? null,
    energy: entry.energy ?? null,
    mood: entry.mood ?? null,
    cyanosis: entry.cyanosis ?? null,
  });
}

function deleteWellness(dayKey, checkTime) {
  return db.prepare('DELETE FROM wellness_checks WHERE day_key = ? AND check_time = ?').run(dayKey, checkTime);
}

// ---------------------------------------------------------------------------
// gag_events queries
// ---------------------------------------------------------------------------

const insertGag = db.prepare(`
  INSERT INTO gag_events (timestamp, day_key) VALUES (@timestamp, @day_key)
`);

const getGagByIdStmt = db.prepare('SELECT * FROM gag_events WHERE id = ?');

const updateGagStmt = db.prepare(`
  UPDATE gag_events
     SET timestamp = @timestamp,
         day_key = @day_key
   WHERE id = @id
`);

function logGag(count = 1, timestamp = Date.now(), dayKeyOverride = null) {
  const dayKey = dayKeyOverride || getDayKey(new Date(timestamp));
  const results = [];
  for (let i = 0; i < count; i++) {
    const result = insertGag.run({ timestamp: timestamp + i, day_key: dayKey });
    results.push({ id: result.lastInsertRowid, timestamp: timestamp + i, day_key: dayKey });
  }
  return results;
}

function getGagsByDay(dayKey) {
  return db
    .prepare('SELECT * FROM gag_events WHERE day_key = ? ORDER BY timestamp ASC')
    .all(dayKey);
}

function getGagById(id) {
  return getGagByIdStmt.get(id) || null;
}

function updateGag(entry) {
  const row = {
    id: entry.id,
    timestamp: entry.timestamp,
    day_key: entry.day_key,
  };
  return updateGagStmt.run(row);
}

function deleteLastGag() {
  const last = db.prepare('SELECT id FROM gag_events ORDER BY id DESC LIMIT 1').get();
  if (last) db.prepare('DELETE FROM gag_events WHERE id = ?').run(last.id);
  return last;
}

function deleteGag(id) {
  return db.prepare('DELETE FROM gag_events WHERE id = ?').run(id);
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

/**
 * Returns a summary object for a given fluid day key.
 */
function getDaySummary(dayKey) {
  const logs = getLogsByDay(dayKey);
  const wellness = collapseLatestWellnessRows(getWellnessByDay(dayKey));
  const gags = getGagsByDay(dayKey);

  const inputs = logs.filter((l) => l.entry_type === 'input');
  const outputs = logs.filter((l) => l.entry_type === 'output');

  const totalIntake = inputs.reduce((sum, l) => sum + (l.amount_ml || 0), 0);

  // Break down by fluid type
  const intakeByType = {};
  for (const l of inputs) {
    intakeByType[l.fluid_type] = (intakeByType[l.fluid_type] || 0) + (l.amount_ml || 0);
  }

  return {
    dayKey,
    totalIntake,
    intakeByType,
    inputs,
    outputs,
    wellness,
    gags,
    gagCount: gags.length,
  };
}

function collapseLatestWellnessRows(rows) {
  const byCheckTime = new Map();
  for (const row of rows || []) {
    const existing = byCheckTime.get(row.check_time);
    if (!existing || row.timestamp > existing.timestamp || (row.timestamp === existing.timestamp && row.id > existing.id)) {
      byCheckTime.set(row.check_time, row);
    }
  }
  return [...byCheckTime.values()].sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    return a.id - b.id;
  });
}

// ---------------------------------------------------------------------------
// Settings queries
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = {
  child_name: 'Elina',
  child_pronouns: 'she/her',
  daily_limit_ml: '1200',
  day_start_hour: '7',
  report_time_1: '19:00',
  report_time_2: '22:00',
  wellness_check_1: '17:00',
  wellness_check_2: '22:00',
  warn_threshold_yellow: '70',
  warn_threshold_red: '90',
  timezone: 'America/New_York',
  units: 'ml',
};

const insertOrIgnoreSetting = db.prepare(
  'INSERT OR IGNORE INTO settings (key, value) VALUES (@key, @value)'
);

function initDefaultSettings() {
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    insertOrIgnoreSetting.run({ key, value });
  }
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (row) return row.value;
  return DEFAULT_SETTINGS[key] ?? null;
}

function getAllSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const result = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (@key, @value)').run({
    key,
    value: String(value),
  });
}

// Initialize default settings on startup
initDefaultSettings();

// ---------------------------------------------------------------------------
// weight_logs queries
// ---------------------------------------------------------------------------

function logWeight(date, weight_kg, notes) {
  const logged_at = new Date().toISOString();
  return db.prepare(
    'INSERT OR REPLACE INTO weight_logs (date, weight_kg, logged_at, notes) VALUES (?, ?, ?, ?)'
  ).run(date, weight_kg, logged_at, notes ?? null);
}

function getWeightForDate(date) {
  return db.prepare('SELECT * FROM weight_logs WHERE date = ?').get(date) || null;
}

function getWeightHistory(days) {
  return db.prepare(
    'SELECT * FROM weight_logs ORDER BY date DESC LIMIT ?'
  ).all(days);
}

function getWeightHistoryUpTo(date, days) {
  return db.prepare(
    'SELECT * FROM weight_logs WHERE date <= ? ORDER BY date DESC LIMIT ?'
  ).all(date, days);
}

function deleteWeight(date) {
  return db.prepare('DELETE FROM weight_logs WHERE date = ?').run(date);
}

module.exports = {
  db,
  getDayKey,
  logEntry,
  getLogsByDay,
  getLastLog,
  getLogById,
  updateLog,
  deleteLog,
  getLogsForDays,
  logWellness,
  getWellnessByDay,
  getLastWellness,
  getWellnessForDays,
  getLatestWellnessEntry,
  upsertWellness,
  deleteWellness,
  logGag,
  getGagsByDay,
  getGagById,
  updateGag,
  deleteLastGag,
  deleteGag,
  getDaySummary,
  getSetting,
  getAllSettings,
  setSetting,
  initDefaultSettings,
  logWeight,
  getWeightForDate,
  getWeightHistory,
  getWeightHistoryUpTo,
  deleteWeight,
};
