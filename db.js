/**
 * db.js — PostgreSQL database schema and query helpers
 *
 * Multi-family foundation: all patient data is scoped to a default family and
 * patient today. Account linking/user membership can layer onto this schema.
 */

'use strict';

const { Pool } = require('pg');

const DEFAULT_FAMILY_ID = process.env.DEFAULT_FAMILY_ID || '00000000-0000-4000-8000-000000000001';
const DEFAULT_PATIENT_ID = process.env.DEFAULT_PATIENT_ID || '00000000-0000-4000-8000-000000000101';
const DEFAULT_FAMILY_NAME = process.env.DEFAULT_FAMILY_NAME || 'Touma Family';
const DEFAULT_PATIENT_NAME = process.env.DEFAULT_PATIENT_NAME || 'Elina';

const DEFAULT_SETTINGS = {
  child_name: DEFAULT_PATIENT_NAME,
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

const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL or POSTGRES_URL is required for Postgres-backed Glide Beside');
}

const pool = new Pool({
  connectionString,
  ssl: process.env.PGSSLMODE === 'disable' || /localhost|127\.0\.0\.1/.test(connectionString)
    ? false
    : { rejectUnauthorized: false },
});

const settingsCache = new Map(Object.entries(DEFAULT_SETTINGS));

function normalizeRow(row) {
  if (!row) return row;
  for (const key of ['id', 'timestamp', 'expires']) {
    if (row[key] !== undefined && row[key] !== null) row[key] = Number(row[key]);
  }
  for (const key of ['amount_ml', 'weight_kg']) {
    if (row[key] !== undefined && row[key] !== null) row[key] = Number(row[key]);
  }
  return row;
}

function scopeIds(scope = {}) {
  return {
    familyId: scope.familyId || scope.family_id || DEFAULT_FAMILY_ID,
    patientId: scope.patientId || scope.patient_id || DEFAULT_PATIENT_ID,
  };
}

async function query(text, params = []) {
  await ready;
  return pool.query(text, params);
}

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS families (
      id          UUID PRIMARY KEY,
      name        TEXT NOT NULL,
      clerk_org_id TEXT UNIQUE,
      created_by_clerk_user_id TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS patients (
      id          UUID PRIMARY KEY,
      family_id   UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      pronouns    TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS users (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      family_id   UUID REFERENCES families(id) ON DELETE CASCADE,
      email       TEXT UNIQUE,
      display_name TEXT,
      role        TEXT NOT NULL DEFAULT 'caregiver',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS family_memberships (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      family_id   UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
      clerk_user_id TEXT NOT NULL,
      email       TEXT,
      display_name TEXT,
      role        TEXT NOT NULL DEFAULT 'caregiver',
      status      TEXT NOT NULL DEFAULT 'active',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (family_id, clerk_user_id)
    );

    CREATE TABLE IF NOT EXISTS family_invitations (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      family_id   UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
      email       TEXT NOT NULL,
      role        TEXT NOT NULL DEFAULT 'caregiver',
      invited_by_clerk_user_id TEXT,
      status      TEXT NOT NULL DEFAULT 'pending',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      accepted_at TIMESTAMPTZ,
      UNIQUE (family_id, email)
    );

    CREATE TABLE IF NOT EXISTS alexa_account_links (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      family_id   UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
      patient_id  UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      alexa_user_id TEXT UNIQUE,
      auth_subject TEXT UNIQUE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS fluid_logs (
      id          BIGSERIAL PRIMARY KEY,
      family_id   UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
      patient_id  UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      timestamp   BIGINT NOT NULL,
      day_key     TEXT NOT NULL,
      entry_type  TEXT NOT NULL,
      fluid_type  TEXT NOT NULL,
      amount_ml   DOUBLE PRECISION,
      subtype     TEXT,
      notes       TEXT,
      source      TEXT DEFAULT 'telegram'
    );

    CREATE TABLE IF NOT EXISTS wellness_checks (
      id          BIGSERIAL PRIMARY KEY,
      family_id   UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
      patient_id  UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      timestamp   BIGINT NOT NULL,
      day_key     TEXT NOT NULL,
      check_time  TEXT NOT NULL,
      appetite    INTEGER,
      energy      INTEGER,
      mood        INTEGER,
      cyanosis    INTEGER
    );

    CREATE TABLE IF NOT EXISTS gag_events (
      id          BIGSERIAL PRIMARY KEY,
      family_id   UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
      patient_id  UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      timestamp   BIGINT NOT NULL,
      day_key     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      family_id   UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
      patient_id  UUID REFERENCES patients(id) ON DELETE CASCADE,
      key         TEXT NOT NULL,
      value       TEXT NOT NULL,
      PRIMARY KEY (family_id, patient_id, key)
    );

    CREATE TABLE IF NOT EXISTS weight_logs (
      id          BIGSERIAL PRIMARY KEY,
      family_id   UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
      patient_id  UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
      date        TEXT NOT NULL,
      weight_kg   DOUBLE PRECISION NOT NULL,
      logged_at   TEXT NOT NULL,
      notes       TEXT,
      UNIQUE (family_id, patient_id, date)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      sid     TEXT PRIMARY KEY,
      expires BIGINT NOT NULL,
      data    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_fluid_logs_patient_day ON fluid_logs (family_id, patient_id, day_key, timestamp);
    CREATE INDEX IF NOT EXISTS idx_wellness_patient_day ON wellness_checks (family_id, patient_id, day_key, timestamp);
    CREATE INDEX IF NOT EXISTS idx_gag_patient_day ON gag_events (family_id, patient_id, day_key, timestamp);
    CREATE INDEX IF NOT EXISTS idx_weight_patient_date ON weight_logs (family_id, patient_id, date DESC);
    CREATE INDEX IF NOT EXISTS idx_family_memberships_clerk_user ON family_memberships (clerk_user_id) WHERE status='active';
    CREATE INDEX IF NOT EXISTS idx_family_invitations_email ON family_invitations (lower(email)) WHERE status='pending';
  `);

  await pool.query(`ALTER TABLE families ADD COLUMN IF NOT EXISTS clerk_org_id TEXT`);
  await pool.query(`ALTER TABLE families ADD COLUMN IF NOT EXISTS created_by_clerk_user_id TEXT`);
  await pool.query(`ALTER TABLE patients ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`);

  await pool.query(
    `INSERT INTO families (id, name) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
    [DEFAULT_FAMILY_ID, DEFAULT_FAMILY_NAME]
  );
  await pool.query(
    `INSERT INTO patients (id, family_id, name, pronouns) VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET family_id = EXCLUDED.family_id, name = EXCLUDED.name, pronouns = EXCLUDED.pronouns`,
    [DEFAULT_PATIENT_ID, DEFAULT_FAMILY_ID, DEFAULT_PATIENT_NAME, DEFAULT_SETTINGS.child_pronouns]
  );

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await pool.query(
      `INSERT INTO settings (family_id, patient_id, key, value) VALUES ($1, $2, $3, $4)
       ON CONFLICT (family_id, patient_id, key) DO NOTHING`,
      [DEFAULT_FAMILY_ID, DEFAULT_PATIENT_ID, key, value]
    );
  }

  await reloadSettings();
}

async function reloadSettings() {
  const { rows } = await pool.query(
    'SELECT key, value FROM settings WHERE family_id = $1 AND patient_id = $2',
    [DEFAULT_FAMILY_ID, DEFAULT_PATIENT_ID]
  );
  settingsCache.clear();
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) settingsCache.set(key, value);
  for (const row of rows) settingsCache.set(row.key, row.value);
}

function settingsForRows(rows) {
  const settings = new Map(Object.entries(DEFAULT_SETTINGS));
  for (const row of rows || []) settings.set(row.key, row.value);
  return settings;
}

async function getSettings(scope = {}) {
  const { familyId, patientId } = scopeIds(scope);
  const { rows } = await query(
    'SELECT key, value FROM settings WHERE family_id = $1 AND patient_id = $2',
    [familyId, patientId]
  );
  return Object.fromEntries(settingsForRows(rows).entries());
}

async function getSettingForScope(key, scope = {}) {
  const { familyId, patientId } = scopeIds(scope);
  const { rows } = await query(
    'SELECT value FROM settings WHERE family_id = $1 AND patient_id = $2 AND key = $3',
    [familyId, patientId, key]
  );
  return rows[0]?.value ?? DEFAULT_SETTINGS[key] ?? null;
}

async function setSettingForScope(key, value, scope = {}) {
  const { familyId, patientId } = scopeIds(scope);
  await query(
    `INSERT INTO settings (family_id, patient_id, key, value) VALUES ($1,$2,$3,$4)
     ON CONFLICT (family_id, patient_id, key) DO UPDATE SET value=EXCLUDED.value`,
    [familyId, patientId, key, String(value)]
  );
  if (familyId === DEFAULT_FAMILY_ID && patientId === DEFAULT_PATIENT_ID) settingsCache.set(key, String(value));
}

async function seedDefaultSettingsForPatient(familyId, patientId, overrides = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...overrides };
  for (const [key, value] of Object.entries(settings)) {
    await query(
      `INSERT INTO settings (family_id, patient_id, key, value) VALUES ($1,$2,$3,$4)
       ON CONFLICT (family_id, patient_id, key) DO NOTHING`,
      [familyId, patientId, key, String(value)]
    );
  }
}

async function getPrimaryPatientForFamily(familyId) {
  const { rows } = await query(
    'SELECT * FROM patients WHERE family_id=$1 AND archived_at IS NULL ORDER BY created_at ASC, id ASC LIMIT 1',
    [familyId]
  );
  return rows[0] || null;
}

async function getFamilyMembershipsByClerkUserId(clerkUserId) {
  if (!clerkUserId) return [];
  const { rows } = await query(
    `SELECT fm.*, f.name AS family_name
       FROM family_memberships fm
       JOIN families f ON f.id = fm.family_id
      WHERE fm.clerk_user_id=$1 AND fm.status='active'
      ORDER BY fm.created_at ASC`,
    [clerkUserId]
  );
  return rows;
}

async function getFamilyMembershipByEmail(email) {
  if (!email) return [];
  const { rows } = await query(
    `SELECT fm.*, f.name AS family_name
       FROM family_memberships fm
       JOIN families f ON f.id = fm.family_id
      WHERE lower(fm.email)=lower($1) AND fm.status='active'
      ORDER BY fm.created_at ASC`,
    [email]
  );
  return rows;
}

async function upsertFamilyMembership({ familyId, clerkUserId, email, displayName, role = 'caregiver', status = 'active' }) {
  if (!familyId || !clerkUserId) throw new Error('familyId and clerkUserId are required');
  const { rows } = await query(
    `INSERT INTO family_memberships (family_id, clerk_user_id, email, display_name, role, status, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,now())
     ON CONFLICT (family_id, clerk_user_id) DO UPDATE SET
       email=COALESCE(EXCLUDED.email, family_memberships.email),
       display_name=COALESCE(EXCLUDED.display_name, family_memberships.display_name),
       role=EXCLUDED.role,
       status=EXCLUDED.status,
       updated_at=now()
     RETURNING *`,
    [familyId, clerkUserId, email || null, displayName || null, role, status]
  );
  return rows[0];
}

async function acceptPendingInvitations({ clerkUserId, email, displayName }) {
  if (!clerkUserId || !email) return [];
  const { rows: invitations } = await query(
    `UPDATE family_invitations SET status='accepted', accepted_at=now()
      WHERE lower(email)=lower($1) AND status='pending'
      RETURNING *`,
    [email]
  );
  const memberships = [];
  for (const invite of invitations) {
    memberships.push(await upsertFamilyMembership({
      familyId: invite.family_id,
      clerkUserId,
      email,
      displayName,
      role: invite.role || 'caregiver',
      status: 'active',
    }));
  }
  return memberships;
}

async function createFamilyInvitation({ familyId, email, role = 'caregiver', invitedByClerkUserId = null }) {
  if (!familyId || !email) throw new Error('familyId and email are required');
  const { rows } = await query(
    `INSERT INTO family_invitations (family_id, email, role, invited_by_clerk_user_id, status)
     VALUES ($1, lower($2), $3, $4, 'pending')
     ON CONFLICT (family_id, email) DO UPDATE SET
       role=EXCLUDED.role,
       invited_by_clerk_user_id=EXCLUDED.invited_by_clerk_user_id,
       status='pending',
       created_at=now(),
       accepted_at=NULL
     RETURNING *`,
    [familyId, email, role, invitedByClerkUserId]
  );
  return rows[0];
}

async function createFamilyWithPatient({ familyName, patientName, pronouns = 'she/her', clerkUserId, email, displayName }) {
  if (!familyName || !patientName || !clerkUserId) throw new Error('familyName, patientName, and clerkUserId are required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const family = (await client.query(
      `INSERT INTO families (id, name, created_by_clerk_user_id)
       VALUES (gen_random_uuid(), $1, $2) RETURNING *`,
      [familyName, clerkUserId]
    )).rows[0];
    const patient = (await client.query(
      `INSERT INTO patients (id, family_id, name, pronouns)
       VALUES (gen_random_uuid(), $1, $2, $3) RETURNING *`,
      [family.id, patientName, pronouns]
    )).rows[0];
    await client.query(
      `INSERT INTO family_memberships (family_id, clerk_user_id, email, display_name, role, status)
       VALUES ($1,$2,$3,$4,'owner','active')`,
      [family.id, clerkUserId, email || null, displayName || null]
    );
    const settings = { ...DEFAULT_SETTINGS, child_name: patientName, child_pronouns: pronouns };
    for (const [key, value] of Object.entries(settings)) {
      await client.query(
        `INSERT INTO settings (family_id, patient_id, key, value) VALUES ($1,$2,$3,$4)`,
        [family.id, patient.id, key, String(value)]
      );
    }
    await client.query('COMMIT');
    return { family, patient };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const ready = initSchema();

function getDayKey(date = new Date()) {
  const tz = getSetting('timezone') || process.env.TZ || 'America/New_York';
  const localStr = date.toLocaleString('en-CA', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const [datePart, timePart] = localStr.split(', ');
  const [hStr] = timePart.split(':');
  const hour = parseInt(hStr, 10);
  const [year, month, day] = datePart.split('-').map(Number);
  const dateObj = new Date(year, month - 1, day);
  const dayStartHour = parseInt(getSetting('day_start_hour'), 10) || 7;
  if (hour < dayStartHour) dateObj.setDate(dateObj.getDate() - 1);
  return dateObj.toISOString().slice(0, 10);
}

async function logEntry(entry) {
  const { familyId, patientId } = scopeIds(entry);
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
  const { rows } = await query(
    `INSERT INTO fluid_logs (family_id, patient_id, timestamp, day_key, entry_type, fluid_type, amount_ml, subtype, notes, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [familyId, patientId, row.timestamp, row.day_key, row.entry_type, row.fluid_type, row.amount_ml, row.subtype, row.notes, row.source]
  );
  return normalizeRow(rows[0]);
}

async function getLogsByDay(dayKey, scope = {}) {
  const { familyId, patientId } = scopeIds(scope);
  const { rows } = await query(
    'SELECT * FROM fluid_logs WHERE family_id=$1 AND patient_id=$2 AND day_key=$3 ORDER BY timestamp ASC, id ASC',
    [familyId, patientId, dayKey]
  );
  return rows.map(normalizeRow);
}

async function getLastLog() {
  const { rows } = await query(
    'SELECT * FROM fluid_logs WHERE family_id=$1 AND patient_id=$2 ORDER BY id DESC LIMIT 1',
    [DEFAULT_FAMILY_ID, DEFAULT_PATIENT_ID]
  );
  return normalizeRow(rows[0]) || null;
}

async function getLogById(id, scope = {}) {
  const { familyId, patientId } = scopeIds(scope);
  const { rows } = await query(
    'SELECT * FROM fluid_logs WHERE family_id=$1 AND patient_id=$2 AND id=$3',
    [familyId, patientId, id]
  );
  return normalizeRow(rows[0]) || null;
}

async function updateLog(entry) {
  const { familyId, patientId } = scopeIds(entry);
  const result = await query(
    `UPDATE fluid_logs SET timestamp=$4, day_key=$5, entry_type=$6, fluid_type=$7, amount_ml=$8, subtype=$9, notes=$10
     WHERE family_id=$1 AND patient_id=$2 AND id=$3`,
    [familyId, patientId, entry.id, entry.timestamp, entry.day_key, entry.entry_type, entry.fluid_type, entry.amount_ml ?? null, entry.subtype ?? null, entry.notes ?? null]
  );
  return { changes: result.rowCount };
}

async function deleteLog(id, scope = {}) {
  const { familyId, patientId } = scopeIds(scope);
  const result = await query('DELETE FROM fluid_logs WHERE family_id=$1 AND patient_id=$2 AND id=$3', [familyId, patientId, id]);
  return { changes: result.rowCount };
}

async function getLogsForDays(days) {
  const keys = [];
  const d = new Date();
  for (let i = 0; i < days; i++) {
    const shifted = new Date(d);
    shifted.setDate(shifted.getDate() - i);
    keys.push(getDayKey(shifted));
  }
  const unique = [...new Set(keys)];
  const { rows } = await query(
    'SELECT * FROM fluid_logs WHERE family_id=$1 AND patient_id=$2 AND day_key = ANY($3) ORDER BY timestamp ASC, id ASC',
    [DEFAULT_FAMILY_ID, DEFAULT_PATIENT_ID, unique]
  );
  return rows.map(normalizeRow);
}

async function logWellness(entry) {
  const { familyId, patientId } = scopeIds(entry);
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
  const { rows } = await query(
    `INSERT INTO wellness_checks (family_id, patient_id, timestamp, day_key, check_time, appetite, energy, mood, cyanosis)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [familyId, patientId, row.timestamp, row.day_key, row.check_time, row.appetite, row.energy, row.mood, row.cyanosis]
  );
  return normalizeRow(rows[0]);
}

async function getWellnessByDay(dayKey, scope = {}) {
  const { familyId, patientId } = scopeIds(scope);
  const { rows } = await query(
    'SELECT * FROM wellness_checks WHERE family_id=$1 AND patient_id=$2 AND day_key=$3 ORDER BY timestamp ASC, id ASC',
    [familyId, patientId, dayKey]
  );
  return rows.map(normalizeRow);
}

async function getLastWellness() {
  const { rows } = await query(
    'SELECT * FROM wellness_checks WHERE family_id=$1 AND patient_id=$2 ORDER BY id DESC LIMIT 1',
    [DEFAULT_FAMILY_ID, DEFAULT_PATIENT_ID]
  );
  return normalizeRow(rows[0]) || null;
}

async function getWellnessForDays(days) {
  const keys = [];
  const d = new Date();
  for (let i = 0; i < days; i++) {
    const shifted = new Date(d);
    shifted.setDate(shifted.getDate() - i);
    keys.push(getDayKey(shifted));
  }
  const unique = [...new Set(keys)];
  const { rows } = await query(
    'SELECT * FROM wellness_checks WHERE family_id=$1 AND patient_id=$2 AND day_key = ANY($3) ORDER BY timestamp ASC, id ASC',
    [DEFAULT_FAMILY_ID, DEFAULT_PATIENT_ID, unique]
  );
  return rows.map(normalizeRow);
}

async function getLatestWellnessEntry(dayKey, checkTime, scope = {}) {
  const { familyId, patientId } = scopeIds(scope);
  const { rows } = await query(
    `SELECT * FROM wellness_checks WHERE family_id=$1 AND patient_id=$2 AND day_key=$3 AND check_time=$4
     ORDER BY timestamp DESC, id DESC LIMIT 1`,
    [familyId, patientId, dayKey, checkTime]
  );
  return normalizeRow(rows[0]) || null;
}

async function upsertWellness(entry) {
  const { familyId, patientId } = scopeIds(entry);
  const now = entry.timestamp || Date.now();
  const dayKey = entry.day_key || getDayKey(new Date(now));
  const checkTime = entry.check_time || '5pm';
  const existing = await getLatestWellnessEntry(dayKey, checkTime, entry);
  if (existing) {
    const result = await query(
      `UPDATE wellness_checks SET timestamp=$4, day_key=$5, check_time=$6, appetite=$7, energy=$8, mood=$9, cyanosis=$10
       WHERE family_id=$1 AND patient_id=$2 AND id=$3 RETURNING *`,
      [familyId, patientId, existing.id, now, dayKey, checkTime, entry.appetite ?? null, entry.energy ?? null, entry.mood ?? null, entry.cyanosis ?? null]
    );
    return normalizeRow(result.rows[0]);
  }
  return logWellness({ timestamp: now, day_key: dayKey, check_time: checkTime, appetite: entry.appetite ?? null, energy: entry.energy ?? null, mood: entry.mood ?? null, cyanosis: entry.cyanosis ?? null, familyId, patientId });
}

async function deleteWellness(dayKey, checkTime, scope = {}) {
  const { familyId, patientId } = scopeIds(scope);
  const result = await query('DELETE FROM wellness_checks WHERE family_id=$1 AND patient_id=$2 AND day_key=$3 AND check_time=$4', [familyId, patientId, dayKey, checkTime]);
  return { changes: result.rowCount };
}

async function logGag(count = 1, timestamp = Date.now(), dayKeyOverride = null, scope = {}) {
  const { familyId, patientId } = scopeIds(scope);
  const dayKey = dayKeyOverride || getDayKey(new Date(timestamp));
  const results = [];
  for (let i = 0; i < count; i++) {
    const { rows } = await query(
      'INSERT INTO gag_events (family_id, patient_id, timestamp, day_key) VALUES ($1,$2,$3,$4) RETURNING *',
      [familyId, patientId, timestamp + i, dayKey]
    );
    results.push(normalizeRow(rows[0]));
  }
  return results;
}

async function getGagsByDay(dayKey, scope = {}) {
  const { familyId, patientId } = scopeIds(scope);
  const { rows } = await query(
    'SELECT * FROM gag_events WHERE family_id=$1 AND patient_id=$2 AND day_key=$3 ORDER BY timestamp ASC, id ASC',
    [familyId, patientId, dayKey]
  );
  return rows.map(normalizeRow);
}

async function getGagById(id, scope = {}) {
  const { familyId, patientId } = scopeIds(scope);
  const { rows } = await query('SELECT * FROM gag_events WHERE family_id=$1 AND patient_id=$2 AND id=$3', [familyId, patientId, id]);
  return normalizeRow(rows[0]) || null;
}

async function updateGag(entry) {
  const { familyId, patientId } = scopeIds(entry);
  const result = await query('UPDATE gag_events SET timestamp=$4, day_key=$5 WHERE family_id=$1 AND patient_id=$2 AND id=$3', [familyId, patientId, entry.id, entry.timestamp, entry.day_key]);
  return { changes: result.rowCount };
}

async function deleteLastGag() {
  const last = await query('SELECT id FROM gag_events WHERE family_id=$1 AND patient_id=$2 ORDER BY id DESC LIMIT 1', [DEFAULT_FAMILY_ID, DEFAULT_PATIENT_ID]);
  if (last.rows[0]) await deleteGag(last.rows[0].id);
  return last.rows[0] || null;
}

async function deleteGag(id, scope = {}) {
  const { familyId, patientId } = scopeIds(scope);
  const result = await query('DELETE FROM gag_events WHERE family_id=$1 AND patient_id=$2 AND id=$3', [familyId, patientId, id]);
  return { changes: result.rowCount };
}

async function getDaySummary(dayKey, scope = {}) {
  const logs = await getLogsByDay(dayKey, scope);
  const wellness = collapseLatestWellnessRows(await getWellnessByDay(dayKey, scope));
  const gags = await getGagsByDay(dayKey, scope);
  const inputs = logs.filter((l) => l.entry_type === 'input');
  const outputs = logs.filter((l) => l.entry_type === 'output');
  const totalIntake = inputs.reduce((sum, l) => sum + (l.amount_ml || 0), 0);
  const intakeByType = {};
  for (const l of inputs) intakeByType[l.fluid_type] = (intakeByType[l.fluid_type] || 0) + (l.amount_ml || 0);
  return { dayKey, totalIntake, intakeByType, inputs, outputs, wellness, gags, gagCount: gags.length };
}

function collapseLatestWellnessRows(rows) {
  const byCheckTime = new Map();
  for (const row of rows || []) {
    const existing = byCheckTime.get(row.check_time);
    if (!existing || row.timestamp > existing.timestamp || (row.timestamp === existing.timestamp && row.id > existing.id)) byCheckTime.set(row.check_time, row);
  }
  return [...byCheckTime.values()].sort((a, b) => (a.timestamp !== b.timestamp ? a.timestamp - b.timestamp : a.id - b.id));
}

function getSetting(key) {
  return settingsCache.get(key) ?? DEFAULT_SETTINGS[key] ?? null;
}

function getAllSettings() {
  return Object.fromEntries(settingsCache.entries());
}

async function setSetting(key, value, scope = {}) {
  await setSettingForScope(key, value, scope);
}

async function initDefaultSettings() {
  await ready;
  return reloadSettings();
}

async function logWeight(date, weight_kg, notes, scope = {}) {
  const { familyId, patientId } = scopeIds(scope);
  const logged_at = new Date().toISOString();
  const { rows } = await query(
    `INSERT INTO weight_logs (family_id, patient_id, date, weight_kg, logged_at, notes)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (family_id, patient_id, date) DO UPDATE SET weight_kg=EXCLUDED.weight_kg, logged_at=EXCLUDED.logged_at, notes=EXCLUDED.notes
     RETURNING *`,
    [familyId, patientId, date, weight_kg, logged_at, notes ?? null]
  );
  return normalizeRow(rows[0]);
}

async function getWeightForDate(date, scope = {}) {
  const { familyId, patientId } = scopeIds(scope);
  const { rows } = await query('SELECT * FROM weight_logs WHERE family_id=$1 AND patient_id=$2 AND date=$3', [familyId, patientId, date]);
  return normalizeRow(rows[0]) || null;
}

async function getWeightHistory(days, scope = {}) {
  const { familyId, patientId } = scopeIds(scope);
  const { rows } = await query('SELECT * FROM weight_logs WHERE family_id=$1 AND patient_id=$2 ORDER BY date DESC LIMIT $3', [familyId, patientId, days]);
  return rows.map(normalizeRow);
}

async function getWeightHistoryUpTo(date, days, scope = {}) {
  const { familyId, patientId } = scopeIds(scope);
  const { rows } = await query('SELECT * FROM weight_logs WHERE family_id=$1 AND patient_id=$2 AND date <= $3 ORDER BY date DESC LIMIT $4', [familyId, patientId, date, days]);
  return rows.map(normalizeRow);
}

async function deleteWeight(date, scope = {}) {
  const { familyId, patientId } = scopeIds(scope);
  const result = await query('DELETE FROM weight_logs WHERE family_id=$1 AND patient_id=$2 AND date=$3', [familyId, patientId, date]);
  return { changes: result.rowCount };
}

async function exportAllData() {
  const tables = ['families', 'patients', 'users', 'family_memberships', 'family_invitations', 'alexa_account_links', 'settings', 'fluid_logs', 'wellness_checks', 'gag_events', 'weight_logs', 'sessions'];
  const data = {};
  for (const table of tables) {
    const { rows } = await query(`SELECT * FROM ${table}`);
    data[table] = rows.map(normalizeRow);
  }
  return { exportedAt: new Date().toISOString(), defaultFamilyId: DEFAULT_FAMILY_ID, defaultPatientId: DEFAULT_PATIENT_ID, tables: data };
}

async function getAlexaAccountLinkBySubject(authSubject) {
  const { rows } = await query('SELECT * FROM alexa_account_links WHERE auth_subject=$1', [authSubject]);
  return rows[0] || null;
}

async function getAlexaAccountLinkByAlexaUserId(alexaUserId) {
  if (!alexaUserId) return null;
  const { rows } = await query('SELECT * FROM alexa_account_links WHERE alexa_user_id=$1', [alexaUserId]);
  return rows[0] || null;
}

async function upsertAlexaAccountLink({ alexaUserId, authSubject, familyId = DEFAULT_FAMILY_ID, patientId = DEFAULT_PATIENT_ID }) {
  if (!authSubject) throw new Error('authSubject is required for Alexa account linking');
  const { rows } = await query(
    `INSERT INTO alexa_account_links (family_id, patient_id, alexa_user_id, auth_subject, updated_at)
     VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (auth_subject) DO UPDATE SET
       family_id=EXCLUDED.family_id,
       patient_id=EXCLUDED.patient_id,
       alexa_user_id=COALESCE(EXCLUDED.alexa_user_id, alexa_account_links.alexa_user_id),
       updated_at=now()
     RETURNING *`,
    [familyId, patientId, alexaUserId || null, authSubject]
  );
  return rows[0];
}

async function setAlexaAccountLinkUserId(authSubject, alexaUserId) {
  if (!authSubject || !alexaUserId) return null;
  const { rows } = await query(
    `UPDATE alexa_account_links SET alexa_user_id=$2, updated_at=now()
     WHERE auth_subject=$1 AND alexa_user_id IS NULL
     RETURNING *`,
    [authSubject, alexaUserId]
  );
  return rows[0] || null;
}

async function sessionGet(sid) {
  const { rows } = await query('SELECT data, expires FROM sessions WHERE sid=$1', [sid]);
  return normalizeRow(rows[0]) || null;
}
async function sessionSet(sid, expires, data) {
  await query('INSERT INTO sessions (sid, expires, data) VALUES ($1,$2,$3) ON CONFLICT (sid) DO UPDATE SET expires=EXCLUDED.expires, data=EXCLUDED.data', [sid, expires, data]);
}
async function sessionDestroy(sid) {
  await query('DELETE FROM sessions WHERE sid=$1', [sid]);
}
async function sessionTouch(sid, expires) {
  await query('UPDATE sessions SET expires=$2 WHERE sid=$1', [sid, expires]);
}
async function sessionPrune(nowSeconds) {
  await query('DELETE FROM sessions WHERE expires < $1', [nowSeconds]);
}

module.exports = {
  pool,
  ready,
  db: { query: (text, params) => query(text, params) },
  DEFAULT_FAMILY_ID,
  DEFAULT_PATIENT_ID,
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
  getSettings,
  getSettingForScope,
  setSetting,
  setSettingForScope,
  seedDefaultSettingsForPatient,
  getPrimaryPatientForFamily,
  getFamilyMembershipsByClerkUserId,
  getFamilyMembershipByEmail,
  upsertFamilyMembership,
  acceptPendingInvitations,
  createFamilyInvitation,
  createFamilyWithPatient,
  initDefaultSettings,
  logWeight,
  getWeightForDate,
  getWeightHistory,
  getWeightHistoryUpTo,
  deleteWeight,
  exportAllData,
  getAlexaAccountLinkBySubject,
  getAlexaAccountLinkByAlexaUserId,
  upsertAlexaAccountLink,
  setAlexaAccountLinkUserId,
  sessionGet,
  sessionSet,
  sessionDestroy,
  sessionTouch,
  sessionPrune,
};
