#!/usr/bin/env node
'use strict';

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const SQLite = require('better-sqlite3');

function parseArgs(argv) {
  const options = {
    sqlitePath: null,
    confirmDestination: null,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--confirm-destination') {
      if (!argv[index + 1] || argv[index + 1].startsWith('--')) {
        throw new Error('--confirm-destination requires a value');
      }
      options.confirmDestination = argv[index + 1];
      index += 1;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (!arg.startsWith('--') && !options.sqlitePath) {
      options.sqlitePath = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function destinationIdentity(databaseUrl) {
  if (!databaseUrl) return 'DATABASE_URL or POSTGRES_URL is not set';

  try {
    const url = new URL(databaseUrl);
    return `${url.hostname}${url.port ? `:${url.port}` : ''}${url.pathname}`;
  } catch {
    return 'unparseable DATABASE_URL';
  }
}

const options = parseArgs(process.argv.slice(2));
const sqlitePath = options.sqlitePath || path.join(__dirname, '..', 'data', 'elina.db');
if (!fs.existsSync(sqlitePath)) {
  console.error(`SQLite source not found: ${sqlitePath}`);
  process.exit(1);
}

const destination = destinationIdentity(process.env.DATABASE_URL || process.env.POSTGRES_URL);
if (!options.dryRun && (!options.confirmDestination || !destination.includes(options.confirmDestination))) {
  console.error('Refusing to run destructive migration without destination confirmation.');
  console.error(`Destination: ${destination}`);
  console.error('Pass --confirm-destination <substring-of-destination> after verifying this is the intended database.');
  process.exit(1);
}

function rows(sqlite, table) {
  const exists = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!exists) return [];
  return sqlite.prepare(`SELECT * FROM ${table}`).all();
}

async function main() {
  const sqlite = new SQLite(sqlitePath, { readonly: true });
  const sourceCounts = {};
  for (const table of ['settings', 'fluid_logs', 'wellness_checks', 'gag_events', 'weight_logs', 'sessions']) {
    sourceCounts[table] = rows(sqlite, table).length;
  }

  if (options.dryRun) {
    console.log(JSON.stringify({ ok: true, dryRun: true, sqlitePath, destination, sourceCounts }, null, 2));
    sqlite.close();
    return;
  }

  console.error(`Destructive migration confirmed for destination: ${destination}`);

  const db = require('../db');
  const FAMILY_ID = db.DEFAULT_FAMILY_ID;
  const PATIENT_ID = db.DEFAULT_PATIENT_ID;
  await db.ready;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE sessions, fluid_logs, wellness_checks, gag_events, weight_logs, settings RESTART IDENTITY CASCADE');

    await client.query(
      `INSERT INTO families (id, name) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name`,
      [FAMILY_ID, 'Touma Family']
    );
    await client.query(
      `INSERT INTO patients (id, family_id, name, pronouns) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET family_id=EXCLUDED.family_id, name=EXCLUDED.name, pronouns=EXCLUDED.pronouns`,
      [PATIENT_ID, FAMILY_ID, 'Elina', 'she/her']
    );

    const settings = rows(sqlite, 'settings');
    for (const r of settings) {
      await client.query(
        'INSERT INTO settings (family_id, patient_id, key, value) VALUES ($1,$2,$3,$4)',
        [FAMILY_ID, PATIENT_ID, r.key, String(r.value)]
      );
    }

    const fluidLogs = rows(sqlite, 'fluid_logs');
    for (const r of fluidLogs) {
      await client.query(
        `INSERT INTO fluid_logs (id, family_id, patient_id, timestamp, day_key, entry_type, fluid_type, amount_ml, subtype, notes, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [r.id, FAMILY_ID, PATIENT_ID, r.timestamp, r.day_key, r.entry_type, r.fluid_type, r.amount_ml, r.subtype ?? null, r.notes ?? null, r.source ?? 'telegram']
      );
    }

    const wellness = rows(sqlite, 'wellness_checks');
    for (const r of wellness) {
      await client.query(
        `INSERT INTO wellness_checks (id, family_id, patient_id, timestamp, day_key, check_time, appetite, energy, mood, cyanosis)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [r.id, FAMILY_ID, PATIENT_ID, r.timestamp, r.day_key, r.check_time, r.appetite, r.energy, r.mood, r.cyanosis]
      );
    }

    const gags = rows(sqlite, 'gag_events');
    for (const r of gags) {
      await client.query(
        'INSERT INTO gag_events (id, family_id, patient_id, timestamp, day_key) VALUES ($1,$2,$3,$4,$5)',
        [r.id, FAMILY_ID, PATIENT_ID, r.timestamp, r.day_key]
      );
    }

    const weights = rows(sqlite, 'weight_logs');
    for (const r of weights) {
      await client.query(
        `INSERT INTO weight_logs (id, family_id, patient_id, date, weight_kg, logged_at, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [r.id, FAMILY_ID, PATIENT_ID, r.date, r.weight_kg, r.logged_at, r.notes ?? null]
      );
    }

    const sessions = rows(sqlite, 'sessions');
    for (const r of sessions) {
      await client.query(
        'INSERT INTO sessions (sid, expires, data) VALUES ($1,$2,$3) ON CONFLICT (sid) DO UPDATE SET expires=EXCLUDED.expires, data=EXCLUDED.data',
        [r.sid, r.expires, r.data]
      );
    }

    for (const table of ['fluid_logs', 'wellness_checks', 'gag_events', 'weight_logs']) {
      await client.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1), true)`);
    }

    await client.query('COMMIT');
    await db.initDefaultSettings();

    const counts = {};
    for (const table of ['families', 'patients', 'settings', 'fluid_logs', 'wellness_checks', 'gag_events', 'weight_logs', 'sessions']) {
      const result = await db.pool.query(`SELECT count(*)::int AS count FROM ${table}`);
      counts[table] = result.rows[0].count;
    }
    console.log(JSON.stringify({ ok: true, sqlitePath, familyId: FAMILY_ID, patientId: PATIENT_ID, counts }, null, 2));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    sqlite.close();
    await db.pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
