/**
 * seed-sample-data.js
 * Populates the last 5 days with realistic sample data for a
 * paediatric cardiac patient (Elina).
 *
 * Run once: node seed-sample-data.js
 * Safe to re-run — checks for existing entries before inserting.
 */

'use strict';

require('dotenv').config();
const db = require('./db');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Eastern Time is UTC-5 in February (EST)
const ET_OFFSET_MS = 5 * 60 * 60 * 1000;

/** Returns a UTC timestamp (ms) for a given day key + hour/minute in ET */
function ts(dayKey, hour, minute = 0) {
  const [y, m, d] = dayKey.split('-').map(Number);
  // Midnight ET = midnight local + 5h UTC
  const midnightUTC = Date.UTC(y, m - 1, d) + ET_OFFSET_MS;
  return midnightUTC + hour * 3600_000 + minute * 60_000;
}

function log(msg) { console.log(' ', msg); }

// ---------------------------------------------------------------------------
// Sample data — 5 days
// ---------------------------------------------------------------------------

const today = new Date();
const days = [];
for (let i = 5; i >= 1; i--) {
  const d = new Date(today);
  d.setDate(d.getDate() - i);
  const key = d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
  days.push(key);
}

console.log(`\nSeeding sample data for: ${days.join(', ')}\n`);

// ---------------------------------------------------------------------------
// Check: skip days that already have data
// ---------------------------------------------------------------------------
const toSeed = days.filter((dayKey) => {
  const summary = db.getDaySummary(dayKey);
  if (summary.inputs.length > 0 || summary.outputs.length > 0) {
    log(`⏭  ${dayKey} — already has data, skipping`);
    return false;
  }
  return true;
});

if (toSeed.length === 0) {
  console.log('\nAll days already have data. Nothing to do.\n');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Per-day data definitions
// ---------------------------------------------------------------------------

const sampleDays = [
  // Day 1 — decent day, 78% intake
  {
    inputs: [
      { hour: 8,  fluid_type: 'pediasure',    amount_ml: 120 },
      { hour: 10, fluid_type: 'water',         amount_ml: 60  },
      { hour: 12, fluid_type: 'pediasure',    amount_ml: 100 },
      { hour: 14, fluid_type: 'juice',         amount_ml: 80  },
      { hour: 16, fluid_type: 'pediasure',    amount_ml: 120 },
      { hour: 20, fluid_type: 'yogurt_drink', amount_ml: 90  },
      { hour: 21, fluid_type: 'water',         amount_ml: 30  },  // 600 total — under limit
    ],
    outputs: [
      { hour: 9,  fluid_type: 'urine', amount_ml: 80  },
      { hour: 13, fluid_type: 'urine', amount_ml: 65  },
      { hour: 17, fluid_type: 'urine', amount_ml: 90  },
      { hour: 21, fluid_type: 'poop',  amount_ml: 40  },
    ],
    gags: [],
    wellness: [
      { check_time: '5pm',  appetite: 6, energy: 5, mood: 7, cyanosis: 3 },
      { check_time: '10pm', appetite: 5, energy: 4, mood: 6, cyanosis: 4 },
    ],
  },
  // Day 2 — rough day, vomiting, low intake
  {
    inputs: [
      { hour: 9,  fluid_type: 'pediasure', amount_ml: 80  },
      { hour: 11, fluid_type: 'water',      amount_ml: 40  },
      { hour: 14, fluid_type: 'pediasure', amount_ml: 60  },
      { hour: 18, fluid_type: 'pediasure', amount_ml: 80  },
      { hour: 21, fluid_type: 'water',      amount_ml: 30  },  // 290 — well under
    ],
    outputs: [
      { hour: 10, fluid_type: 'urine',  amount_ml: 50  },
      { hour: 12, fluid_type: 'vomit',  amount_ml: 70  },
      { hour: 15, fluid_type: 'urine',  amount_ml: 40  },
      { hour: 19, fluid_type: 'vomit',  amount_ml: 45  },
      { hour: 22, fluid_type: 'urine',  amount_ml: 35  },
    ],
    gags: [
      { hour: 12, count: 2 },
      { hour: 19, count: 1 },
    ],
    wellness: [
      { check_time: '5pm',  appetite: 3, energy: 3, mood: 4, cyanosis: 6 },
      { check_time: '10pm', appetite: 2, energy: 2, mood: 3, cyanosis: 7 },
    ],
  },
  // Day 3 — recovery, moderate intake
  {
    inputs: [
      { hour: 8,  fluid_type: 'water',         amount_ml: 50  },
      { hour: 10, fluid_type: 'pediasure',    amount_ml: 100 },
      { hour: 12, fluid_type: 'juice',         amount_ml: 60  },
      { hour: 14, fluid_type: 'pediasure',    amount_ml: 100 },
      { hour: 16, fluid_type: 'vitamin_water', amount_ml: 80  },
      { hour: 19, fluid_type: 'pediasure',    amount_ml: 120 },
      { hour: 21, fluid_type: 'water',         amount_ml: 40  },  // 550 total
    ],
    outputs: [
      { hour: 9,  fluid_type: 'urine', amount_ml: 60  },
      { hour: 13, fluid_type: 'urine', amount_ml: 75  },
      { hour: 18, fluid_type: 'urine', amount_ml: 55  },
      { hour: 22, fluid_type: 'poop',  amount_ml: 35  },
    ],
    gags: [
      { hour: 15, count: 1 },
    ],
    wellness: [
      { check_time: '5pm',  appetite: 5, energy: 5, mood: 6, cyanosis: 4 },
      { check_time: '10pm', appetite: 5, energy: 4, mood: 6, cyanosis: 4 },
    ],
  },
  // Day 4 — good day, near limit
  {
    inputs: [
      { hour: 8,  fluid_type: 'pediasure',    amount_ml: 120 },
      { hour: 10, fluid_type: 'vitamin_water', amount_ml: 80  },
      { hour: 12, fluid_type: 'pediasure',    amount_ml: 120 },
      { hour: 14, fluid_type: 'juice',         amount_ml: 100 },
      { hour: 16, fluid_type: 'yogurt_drink', amount_ml: 100 },
      { hour: 19, fluid_type: 'pediasure',    amount_ml: 120 },
      { hour: 21, fluid_type: 'water',         amount_ml: 60  },  // 700 total
    ],
    outputs: [
      { hour: 9,  fluid_type: 'urine', amount_ml: 90  },
      { hour: 12, fluid_type: 'urine', amount_ml: 80  },
      { hour: 16, fluid_type: 'urine', amount_ml: 70  },
      { hour: 20, fluid_type: 'urine', amount_ml: 85  },
    ],
    gags: [],
    wellness: [
      { check_time: '5pm',  appetite: 7, energy: 6, mood: 8, cyanosis: 3 },
      { check_time: '10pm', appetite: 7, energy: 6, mood: 7, cyanosis: 3 },
    ],
  },
  // Day 5 — yesterday, mixed day
  {
    inputs: [
      { hour: 8,  fluid_type: 'pediasure',    amount_ml: 100 },
      { hour: 10, fluid_type: 'water',         amount_ml: 50  },
      { hour: 12, fluid_type: 'pediasure',    amount_ml: 100 },
      { hour: 15, fluid_type: 'juice',         amount_ml: 80  },
      { hour: 18, fluid_type: 'pediasure',    amount_ml: 120 },
      { hour: 20, fluid_type: 'vitamin_water', amount_ml: 70  },  // 520 total
    ],
    outputs: [
      { hour: 9,  fluid_type: 'urine', amount_ml: 70  },
      { hour: 13, fluid_type: 'urine', amount_ml: 60  },
      { hour: 17, fluid_type: 'vomit', amount_ml: 35  },
      { hour: 20, fluid_type: 'urine', amount_ml: 65  },
    ],
    gags: [
      { hour: 17, count: 1 },
    ],
    wellness: [
      { check_time: '5pm',  appetite: 5, energy: 5, mood: 6, cyanosis: 5 },
      { check_time: '10pm', appetite: 6, energy: 5, mood: 7, cyanosis: 4 },
    ],
  },
];

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

toSeed.forEach((dayKey, idx) => {
  // Find the matching sample day (align from end so yesterday = sampleDays[4])
  const sampleIdx = sampleDays.length - toSeed.length + idx;
  const data = sampleDays[sampleIdx];

  console.log(`📅 ${dayKey}`);

  let totalIn = 0;
  for (const e of data.inputs) {
    db.logEntry({
      timestamp: ts(dayKey, e.hour),
      day_key: dayKey,
      entry_type: 'input',
      fluid_type: e.fluid_type,
      amount_ml: e.amount_ml,
      source: 'seed',
    });
    totalIn += e.amount_ml;
  }

  let totalOut = 0;
  for (const e of data.outputs) {
    db.logEntry({
      timestamp: ts(dayKey, e.hour),
      day_key: dayKey,
      entry_type: 'output',
      fluid_type: e.fluid_type,
      amount_ml: e.amount_ml,
      source: 'seed',
    });
    totalOut += e.amount_ml;
  }

  for (const g of data.gags) {
    db.logGag(g.count, ts(dayKey, g.hour));
  }

  for (const w of data.wellness) {
    const wHour = w.check_time === '5pm' ? 17 : 22;
    db.logWellness({
      timestamp: ts(dayKey, wHour),
      day_key: dayKey,
      check_time: w.check_time,
      appetite: w.appetite,
      energy: w.energy,
      mood: w.mood,
      cyanosis: w.cyanosis,
      source: 'seed',
    });
  }

  const pct = Math.round((totalIn / 1200) * 100);
  const gagCount = data.gags.reduce((s, g) => s + g.count, 0);
  log(`💧 In: ${totalIn}ml (${pct}%)  🚽 Out: ${totalOut}ml  🤢 Gags: ${gagCount}  ❤️ Wellness: ${data.wellness.length} checks`);
});

console.log('\n✅ Done.\n');
process.exit(0);
