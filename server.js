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
const multer = require('multer');
const fs = require('fs');
const db = require('./db');
const { parseMessage } = require('./parser');

const app = express();
const PORT = process.env.PORT || 3000;

// Railway (and most PaaS) sit behind a reverse proxy — needed for
// secure cookies and correct req.ip / req.protocol values.
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ---------------------------------------------------------------------------
// Session + Auth
// ---------------------------------------------------------------------------

const session = require('express-session');

// ---------------------------------------------------------------------------
// SQLiteSessionStore — persists sessions in the existing better-sqlite3 DB.
// Zero extra dependencies; sessions survive server restarts.
// ---------------------------------------------------------------------------
class SQLiteSessionStore extends session.Store {
  constructor(database, ttlSeconds = 7 * 24 * 60 * 60) {
    super();
    this._db = database;
    this._ttl = ttlSeconds;

    // Create sessions table if it doesn't exist
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid     TEXT    PRIMARY KEY,
        expires INTEGER NOT NULL,
        data    TEXT    NOT NULL
      )
    `);

    // Prepare statements once for performance
    this._get     = this._db.prepare('SELECT data, expires FROM sessions WHERE sid = ?');
    this._set     = this._db.prepare('INSERT OR REPLACE INTO sessions (sid, expires, data) VALUES (?, ?, ?)');
    this._destroy = this._db.prepare('DELETE FROM sessions WHERE sid = ?');
    this._touch   = this._db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?');
    this._prune   = this._db.prepare('DELETE FROM sessions WHERE expires < ?');

    // Prune expired sessions hourly
    setInterval(() => {
      try { this._prune.run(Math.floor(Date.now() / 1000)); } catch (_) {}
    }, 60 * 60 * 1000).unref();
  }

  get(sid, cb) {
    try {
      const row = this._get.get(sid);
      if (!row) return cb(null, null);
      if (row.expires < Math.floor(Date.now() / 1000)) {
        this._destroy.run(sid);
        return cb(null, null);
      }
      cb(null, JSON.parse(row.data));
    } catch (err) { cb(err); }
  }

  set(sid, sess, cb) {
    try {
      const expires = Math.floor(Date.now() / 1000) + this._ttl;
      this._set.run(sid, expires, JSON.stringify(sess));
      cb(null);
    } catch (err) { cb(err); }
  }

  destroy(sid, cb) {
    try { this._destroy.run(sid); cb(null); } catch (err) { cb(err); }
  }

  touch(sid, sess, cb) {
    try {
      const expires = Math.floor(Date.now() / 1000) + this._ttl;
      this._touch.run(expires, sid);
      cb(null);
    } catch (err) { cb(err); }
  }
}

app.use(session({
  store: new SQLiteSessionStore(db.db),
  secret: process.env.SESSION_SECRET || 'dev-secret-please-set-SESSION_SECRET-in-env',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production', // HTTPS-only cookies in prod
    sameSite: 'lax',
  },
}));

// Health check (public — used by Railway to verify the container is up)
app.get('/health', (req, res) => res.json({ ok: true }));

// PWA assets — must be public so iOS/Android can fetch them without a session
app.get('/apple-touch-icon.png', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'apple-touch-icon.png'))
);
app.get('/manifest.json', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'manifest.json'))
);

// Login page (public — no auth required)
app.get('/login', (req, res) => {
  if (req.session && req.session.authenticated) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Login form submission
app.post('/login', (req, res) => {
  const { password } = req.body;
  const correct = process.env.DASHBOARD_PASSWORD;
  if (!correct) {
    return res.status(500).send('Server misconfiguration: DASHBOARD_PASSWORD not set.');
  }
  if (password === correct) {
    req.session.authenticated = true;
    // Explicitly save before redirecting — guarantees the session is
    // committed to the store before the browser follows the redirect.
    return req.session.save((err) => {
      if (err) {
        console.error('[auth] Session save error:', err);
        return res.status(500).send('Session error — please try again.');
      }
      res.redirect('/');
    });
  }
  res.redirect('/login?error=1');
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ---------------------------------------------------------------------------
// Alexa Skill endpoint (public — authenticated via Skill ID, not session)
// ---------------------------------------------------------------------------

/**
 * Build an Alexa JSON response with SSML speech output.
 */
function alexaResponse(ssml, shouldEndSession = true, repromptSsml = null, directives = []) {
  const resp = {
    version: '1.0',
    response: {
      outputSpeech: { type: 'SSML', ssml: `<speak>${ssml}</speak>` },
      shouldEndSession,
    },
  };
  if (repromptSsml) {
    resp.response.reprompt = {
      outputSpeech: { type: 'SSML', ssml: `<speak>${repromptSsml}</speak>` },
    };
  }
  if (directives.length > 0) resp.response.directives = directives;
  return resp;
}

function supportsApl(req) {
  // Per Amazon docs: ONLY send APL when supportedInterfaces declares it.
  // Viewport presence alone is not enough — Amazon's service uses supportedInterfaces
  // to signal that APL is cleared for this skill+device combination.
  // Sending APL without this signal causes "problem with skill response" errors.
  return !!(req.body?.context?.System?.device?.supportedInterfaces?.['Alexa.Presentation.APL']);
}

function aplButton(label, args) {
  // A single tappable button: TouchWrapper > Frame > Text
  // Uses item (singular) per APL spec for Frame and TouchWrapper.
  return {
    type: 'TouchWrapper',
    onPress: { type: 'SendEvent', arguments: args },
    item: {
      type: 'Frame',
      backgroundColor: '#2a3a5e',
      borderRadius: 8,
      paddingTop: '8dp',
      paddingBottom: '8dp',
      paddingLeft: '10dp',
      paddingRight: '10dp',
      item: { type: 'Text', text: label, color: 'white', fontSize: '14dp', textAlign: 'center' },
    },
  };
}

function aplSelectedButton(label, args, selected) {
  // Button that highlights blue when selected
  return {
    type: 'TouchWrapper',
    onPress: { type: 'SendEvent', arguments: args },
    item: {
      type: 'Frame',
      backgroundColor: selected ? '#4a9eff' : '#2a3a5e',
      borderRadius: 8,
      paddingTop: '8dp',
      paddingBottom: '8dp',
      paddingLeft: '10dp',
      paddingRight: '10dp',
      item: { type: 'Text', text: label, color: 'white', fontSize: '14dp', textAlign: 'center' },
    },
  };
}

// DIAGNOSTIC: minimal APL with correct mainTemplate.items (array) for Layout type.
// mainTemplate is a Layout — uses items[], not item (item is for Frame/TouchWrapper).
function buildAplDirective(intakeMl, limitMl, mode, selectedFluid) {
  return {
    type: 'Alexa.Presentation.APL.RenderDocument',
    version: '1.0',   // required directive schema version (separate from APL doc version)
    token: 'tracker-ui',
    document: {
      type: 'APL',
      version: '1.5',
      mainTemplate: {
        parameters: [],
        items: [
          {
            type: 'Text',
            text: 'Wellness Tracker',
            color: 'white',
            fontSize: '24dp',
            textAlign: 'center',
          },
        ],
      },
    },
  };
}

/**
 * Convert a day summary into a spoken confirmation string.
 */
function buildAlexaSpeech(summary) {
  const limit = getDailyLimit();
  const pct = Math.round((summary.totalIntake / limit) * 100);
  const totalOut = summary.outputs.reduce((sum, o) => sum + (o.amount_ml || 0), 0);
  let speech = `Logged. Total in: ${summary.totalIntake} of ${limit} milliliters, ${pct} percent.`;
  if (totalOut > 0) speech += ` Total out: ${totalOut} milliliters.`;
  return speech;
}

app.post('/api/alexa', async (req, res) => {
  try {
    // Verify the request came from our skill (set ALEXA_SKILL_ID in Railway env)
    const skillId = process.env.ALEXA_SKILL_ID;
    const incomingId =
      req.body?.session?.application?.applicationId ||
      req.body?.context?.System?.application?.applicationId;
    if (skillId && incomingId !== skillId) {
      console.warn('[alexa] Rejected request from unknown skill ID:', incomingId);
      return res.status(403).json({ error: 'Forbidden' });
    }

    const request = req.body?.request;
    if (!request) return res.status(400).json({ error: 'Invalid Alexa request' });

    // -- LaunchRequest: skill opened with no command
    if (request.type === 'LaunchRequest') {
      const supportedInterfaces = req.body?.context?.System?.device?.supportedInterfaces || {};
      const viewport = req.body?.context?.Viewport || null;
      const deviceId = req.body?.context?.System?.device?.deviceId || 'unknown';
      const aplSupported = supportsApl(req);
      console.log('[alexa] LaunchRequest — deviceId:', deviceId);
      console.log('[alexa] LaunchRequest — supportedInterfaces:', JSON.stringify(supportedInterfaces));
      console.log('[alexa] LaunchRequest — viewport:', JSON.stringify(viewport));
      console.log('[alexa] LaunchRequest — supportsApl:', aplSupported);
      if (aplSupported) {
        // APL response: include speech + directive, but NO reprompt
        // (reprompt conflicts with APL touch sessions on screen devices)
        const summary = db.getDaySummary(db.getDayKey());
        const limit = getDailyLimit();
        const aplDirective = buildAplDirective(summary.totalIntake, limit, 'input', null);
        console.log('[alexa] APL full directive JSON:', JSON.stringify(aplDirective));
        return res.json({
          version: '1.0',
          response: {
            outputSpeech: { type: 'SSML', ssml: '<speak>Wellness tracker ready.</speak>' },
            shouldEndSession: false,
            directives: [aplDirective],
          },
        });
      }
      return res.json(alexaResponse(
        'Wellness tracker ready. What would you like to log?',
        false,
        'You can say things like: log 120 milliliters pediasure, or log pee 85 milliliters.'
      ));
    }

    // -- APL UserEvent: touch interactions from the screen
    if (request.type === 'Alexa.Presentation.APL.UserEvent') {
      const args = request.arguments || [];
      const action = args[0];

      if (action === 'mode') {
        const newMode = args[1] || 'input';
        const summary = db.getDaySummary(db.getDayKey());
        const limit = getDailyLimit();
        const apl = buildAplDirective(summary.totalIntake, limit, newMode, null);
        const modeLabel = newMode === 'output' ? 'Output mode.' : 'Input mode.';
        return res.json(alexaResponse(modeLabel, false, null, supportsApl(req) ? [apl] : []));
      }

      if (action === 'select') {
        const fluid = args[1];
        const mode = args[2] || 'input';
        const summary = db.getDaySummary(db.getDayKey());
        const limit = getDailyLimit();
        const fluidLabel = formatFluidType(fluid) || fluid;
        const apl = buildAplDirective(summary.totalIntake, limit, mode, fluid);
        return res.json(alexaResponse(`${fluidLabel} selected.`, false, null, supportsApl(req) ? [apl] : []));
      }

      if (action === 'log') {
        const fluid = args[1];
        const amount = Number(args[2]);
        const mode = args[3] || 'input';

        if (!fluid || fluid === 'null' || fluid === 'undefined') {
          const summary = db.getDaySummary(db.getDayKey());
          const limit = getDailyLimit();
          const apl = buildAplDirective(summary.totalIntake, limit, mode, null);
          return res.json(alexaResponse('Please select a fluid type first.', false, 'What would you like to log?', supportsApl(req) ? [apl] : []));
        }

        const entryType = (mode === 'output') ? 'output' : 'input';
        db.logEntry({
          timestamp: Date.now(),
          day_key: db.getDayKey(),
          entry_type: entryType,
          fluid_type: fluid,
          amount_ml: amount,
          source: 'alexa',
        });

        const summary = db.getDaySummary(db.getDayKey());
        const limit = getDailyLimit();
        const apl = buildAplDirective(summary.totalIntake, limit, mode, fluid);
        const speech = buildAlexaSpeech(summary);
        return res.json(alexaResponse(speech, false, null, supportsApl(req) ? [apl] : []));
      }

      // Unknown UserEvent — refresh display
      const summary = db.getDaySummary(db.getDayKey());
      const limit = getDailyLimit();
      const apl = buildAplDirective(summary.totalIntake, limit, 'input', null);
      return res.json(alexaResponse('', false, null, supportsApl(req) ? [apl] : []));
    }

    // -- SessionEndedRequest: Alexa closed the session
    if (request.type === 'SessionEndedRequest') {
      return res.json({ version: '1.0', response: {} });
    }

    if (request.type !== 'IntentRequest') {
      return res.json(alexaResponse("Sorry, I didn't understand that."));
    }

    const intentName = request.intent?.name;

    // Built-in intents
    if (intentName === 'AMAZON.HelpIntent') {
      return res.json(alexaResponse(
        'To log fluid intake, say: log 120 milliliters pediasure. ' +
        'To log output, say: log pee 80 milliliters. ' +
        'To log a gag episode, say: log gag. ' +
        'What would you like to log?',
        false,
        'What would you like to log?'
      ));
    }

    if (intentName === 'AMAZON.StopIntent' || intentName === 'AMAZON.CancelIntent') {
      return res.json(alexaResponse('Goodbye.'));
    }

    if (intentName === 'AMAZON.FallbackIntent') {
      return res.json(alexaResponse(
        "I didn't catch that. Try saying: log 120 milliliters pediasure.",
        false,
        'What would you like to log?'
      ));
    }

    // -- LogEntryIntent: the main logging command
    if (intentName === 'LogEntryIntent') {
      const entryText = request.intent?.slots?.entry?.value;

      if (!entryText) {
        return res.json(alexaResponse(
          "I didn't catch what you wanted to log. Try saying: log 120 milliliters pediasure.",
          false,
          'What would you like to log?'
        ));
      }

      // Parse via existing NLP pipeline
      let parsed;
      try {
        parsed = await parseMessage(entryText);
      } catch (err) {
        console.error('[alexa] Parser error:', err.message);
        return res.json(alexaResponse('Sorry, I had trouble processing that. Please try again.'));
      }

      if (parsed.unparseable || parsed.actions.length === 0) {
        return res.json(alexaResponse(
          "I couldn't understand that entry. Try saying things like: " +
          '120 milliliters pediasure, or pee 80 milliliters.',
          false,
          'What would you like to log?'
        ));
      }

      // Reject if any input/output is missing an amount
      const missingAmount = parsed.actions.find(
        (a) => (a.type === 'input' || a.type === 'output') && !a.amount_ml
      );
      if (missingAmount) {
        const label = formatFluidType(missingAmount.fluid_type);
        return res.json(alexaResponse(
          `I need a measurement for ${label}. How many milliliters was it?`,
          false,
          `How many milliliters of ${label}?`
        ));
      }

      // Persist all actions
      const now = Date.now();
      const dayKey = db.getDayKey();
      let weightLogged = null;
      for (const action of parsed.actions) {
        if (action.type === 'input' || action.type === 'output') {
          db.logEntry({
            timestamp: now,
            day_key: dayKey,
            entry_type: action.type,
            fluid_type: action.fluid_type,
            amount_ml: action.amount_ml,
            source: 'alexa',
          });
        } else if (action.type === 'wellness') {
          db.logWellness({
            timestamp: now,
            day_key: dayKey,
            check_time: action.check_time,
            appetite: action.appetite,
            energy: action.energy,
            mood: action.mood,
            cyanosis: action.cyanosis,
            source: 'alexa',
          });
        } else if (action.type === 'gag') {
          db.logGag(action.count, now);
        } else if (action.type === 'weight') {
          db.logWeight(dayKey, action.weight_kg, null);
          weightLogged = action.weight_kg;
        }
      }

      // If weight was the only/primary action, return a weight-specific response
      if (weightLogged !== null && parsed.actions.every((a) => a.type === 'weight')) {
        return res.json(alexaResponse(`Weight logged. ${weightLogged} kilograms.`));
      }

      const summary = db.getDaySummary(dayKey);
      const aplDirs = [];
      if (supportsApl(req)) {
        aplDirs.push(buildAplDirective(summary.totalIntake, getDailyLimit(), 'input', null));
      }
      return res.json(alexaResponse(buildAlexaSpeech(summary), false, null, aplDirs));
    }

    // Unknown intent fallback
    return res.json(alexaResponse(
      "I didn't understand that. Try saying: log 120 milliliters pediasure."
    ));

  } catch (err) {
    console.error('[alexa] Unhandled error:', err);
    return res.json(alexaResponse('Something went wrong. Please try again.'));
  }
});

// Auth gate — everything below this line requires a valid session
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  res.redirect('/login');
}
app.use(requireAuth);

// Static files (served after auth check)
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/**
 * Returns yesterday's fluid-day key string "YYYY-MM-DD".
 * Derived from today's key so timezone logic is consistent.
 */
function getYesterdayKey() {
  const todayKey = db.getDayKey();
  const [y, m, d] = todayKey.split('-').map(Number);
  const yesterday = new Date(y, m - 1, d);
  yesterday.setDate(yesterday.getDate() - 1);
  return yesterday.toISOString().slice(0, 10);
}

/**
 * Validates an optional date field from a request body.
 * Only today and yesterday are allowed.
 * Returns { ok: true, date } or { ok: false, error }.
 */
function validateLogDate(bodyDate) {
  const todayKey = db.getDayKey();
  if (!bodyDate) return { ok: true, date: todayKey };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(bodyDate)) {
    return { ok: false, error: 'Invalid date format. Use YYYY-MM-DD.' };
  }
  const yesterdayKey = getYesterdayKey();
  if (bodyDate === todayKey || bodyDate === yesterdayKey) {
    return { ok: true, date: bodyDate };
  }
  return { ok: false, error: 'Only today or yesterday entries are allowed' };
}

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

function getDailyLimit() {
  return parseInt(db.getSetting('daily_limit_ml'), 10) || 1200;
}

function getChildName() {
  return db.getSetting('child_name') || 'Elina';
}

function getWarnYellow() {
  return parseInt(db.getSetting('warn_threshold_yellow'), 10) || 70;
}

function getWarnRed() {
  return parseInt(db.getSetting('warn_threshold_red'), 10) || 90;
}

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

function getTimezone() {
  return db.getSetting('timezone') || process.env.TZ || 'America/New_York';
}

function formatTimestamp(tsMs) {
  return new Date(tsMs).toLocaleTimeString('en-US', {
    timeZone: getTimezone(),
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
      limit_ml: getDailyLimit(),
      totalIntake: summary.totalIntake,
      percent: Math.round((summary.totalIntake / getDailyLimit()) * 100),
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

    // Validate optional date field
    const dateResult = validateLogDate(body.date);
    if (!dateResult.ok) {
      return res.status(400).json({ ok: false, error: dateResult.error });
    }
    const dayKey = dateResult.date;

    const results = [];

    // Require amount_ml for all fluid inputs and outputs (poop is optional — no measurable amount)
    if (body.type !== 'wellness' && body.type !== 'gag') {
      const isPoop = body.fluid_type === 'poop';
      if (!isPoop && (!body.amount_ml || typeof body.amount_ml !== 'number' || body.amount_ml <= 0)) {
        return res.status(400).json({ ok: false, error: 'amount_ml is required for input and output entries' });
      }
    }

    if (body.type === 'wellness') {
      const w = db.logWellness({
        day_key: dayKey,
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
      const gags = db.logGag(count, Date.now(), dayKey);
      results.push({ kind: 'gag', count, data: gags });
    } else {
      // Fluid input or output
      const entry = db.logEntry({
        day_key: dayKey,
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
 * Returns a richer per-day summary for the last N fluid days.
 */
app.get('/api/history', (req, res) => {
  try {
    const days = Math.min(30, Math.max(1, parseInt(req.query.days, 10) || 7));
    const todayKey = db.getDayKey();
    const tz = getTimezone();

    // Build list of unique day keys (most recent first)
    const dayKeys = [];
    const now = new Date();
    for (let i = 0; i < days; i++) {
      const shifted = new Date(now);
      shifted.setDate(shifted.getDate() - i);
      dayKeys.push(db.getDayKey(shifted));
    }
    const uniqueKeys = [...new Set(dayKeys)].slice(0, days);

    const dayData = uniqueKeys.map((dayKey) => {
      const summary = db.getDaySummary(dayKey);

      // Build a readable label from the dayKey string
      const [year, month, day] = dayKey.split('-').map(Number);
      const dateObj = new Date(year, month - 1, day, 12, 0, 0);
      const label = dateObj.toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'short',
        day: 'numeric',
      });

      const total_ml = summary.totalIntake;
      const limit_ml = getDailyLimit();
      const percent = Math.round((total_ml / limit_ml) * 100);

      const outputs = summary.outputs.map((o) => ({
        id: o.id,
        fluid_type: o.fluid_type,
        amount_ml: o.amount_ml,
        time: formatTimestamp(o.timestamp),
      }));
      const inputs = summary.inputs.map((l) => ({
        id: l.id,
        time: formatTimestamp(l.timestamp),
        fluid_type: l.fluid_type,
        fluid_type_label: formatFluidType(l.fluid_type),
        amount_ml: l.amount_ml,
      }));
      const gags = summary.gags.map((g) => ({
        id: g.id,
        time: formatTimestamp(g.timestamp),
      }));

      // Split wellness into afternoon (5pm) and evening (10pm)
      const afternoonRow = summary.wellness.find((w) => w.check_time === '5pm') || null;
      const eveningRow = summary.wellness.find((w) => w.check_time === '10pm') || null;

      const pickWellness = (row) => row ? {
        check_time: row.check_time,
        appetite: row.appetite,
        energy: row.energy,
        mood: row.mood,
        cyanosis: row.cyanosis,
      } : null;

      return {
        dayKey,
        label,
        isToday: dayKey === todayKey,
        intake: { total_ml, limit_ml, percent, byType: summary.intakeByType },
        inputs,
        outputs,
        gags,
        gagCount: summary.gagCount,
        wellness: {
          afternoon: pickWellness(afternoonRow),
          evening: pickWellness(eveningRow),
        },
      };
    });

    res.json({ ok: true, days: dayData });
  } catch (err) {
    console.error('[GET /api/history]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * DELETE /api/gag/:id
 * Remove a specific gag event by ID.
 */
app.delete('/api/gag/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) {
      return res.status(400).json({ ok: false, error: 'Invalid ID' });
    }
    const result = db.deleteGag(id);
    if (result.changes === 0) {
      return res.status(404).json({ ok: false, error: 'Gag entry not found' });
    }
    res.json({ ok: true, deleted: id });
  } catch (err) {
    console.error('[DELETE /api/gag/:id]', err);
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

// ---------------------------------------------------------------------------
// Weight API
// ---------------------------------------------------------------------------

/**
 * POST /api/weight
 * Body: { weight_kg, notes? }
 * Logs weight for today's fluid day key. Returns { ok, weight_kg, date, replaced }.
 */
app.post('/api/weight', (req, res) => {
  try {
    const { weight_kg, notes } = req.body;
    if (typeof weight_kg !== 'number' || weight_kg <= 0) {
      return res.status(400).json({ ok: false, error: 'weight_kg must be a positive number' });
    }

    // Validate optional date field
    const dateResult = validateLogDate(req.body.date);
    if (!dateResult.ok) {
      return res.status(400).json({ ok: false, error: dateResult.error });
    }
    const date = dateResult.date;

    const existing = db.getWeightForDate(date);
    db.logWeight(date, weight_kg, notes ?? null);
    res.json({ ok: true, weight_kg, date, replaced: !!existing });
  } catch (err) {
    console.error('[POST /api/weight]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/weight/today
 * Returns today's weight entry or { ok, weight: null }.
 */
app.get('/api/weight/today', (req, res) => {
  try {
    const date = db.getDayKey();
    const entry = db.getWeightForDate(date);
    res.json({ ok: true, weight: entry || null });
  } catch (err) {
    console.error('[GET /api/weight/today]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/weight/history?days=7
 * Returns last N weight entries ordered by date desc.
 */
app.get('/api/weight/history', (req, res) => {
  try {
    const days = Math.min(30, Math.max(1, parseInt(req.query.days, 10) || 7));
    const entries = db.getWeightHistory(days);
    res.json({ ok: true, entries });
  } catch (err) {
    console.error('[GET /api/weight/history]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// /api/chat — NLP text logging (same pipeline as Telegram bot)
// ---------------------------------------------------------------------------

/**
 * Builds a short confirmation message listing what was just logged,
 * with a brief intake + output summary.
 */
function buildChatConfirmation(actions, summary) {
  const parts = [];
  for (const action of actions) {
    if (action.type === 'input') {
      const label = formatFluidType(action.fluid_type);
      const amount = action.amount_ml ? `${action.amount_ml}ml` : '(no amount)';
      parts.push(`${amount} ${label}`);
    } else if (action.type === 'output') {
      const label = formatFluidType(action.fluid_type);
      const amount = action.amount_ml ? ` ${action.amount_ml}ml` : '';
      parts.push(`${label}${amount} (output)`);
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
  const outStr = totalOut > 0 ? `${totalOut}ml` : `${summary.outputs.length} event${summary.outputs.length !== 1 ? 's' : ''}`;

  return `✅ Logged: ${logged} | 💧 Total In: ${summary.totalIntake}/${limit}ml (${pct}%) · 🚽 Total Out: ${outStr}`;
}

app.post('/api/chat', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ ok: false, error: 'Missing or empty text' });
    }

    let parsed;
    try {
      parsed = await parseMessage(text.trim());
    } catch (err) {
      console.error('[POST /api/chat] Parser error:', err.message);
      return res.status(500).json({ ok: false, error: 'Parser error: ' + err.message });
    }

    if (parsed.unparseable || parsed.actions.length === 0) {
      return res.json({
        ok: false,
        message: "🤔 I couldn't understand that. Try something like: \"120ml pediasure\" or \"pee 80ml\" or \"gag x2\".",
        entries: [],
      });
    }

    // Require a measurement for every input and output
    const missingAmount = parsed.actions.find(
      (a) => (a.type === 'input' || a.type === 'output') && !a.amount_ml
    );
    if (missingAmount) {
      const label = formatFluidType(missingAmount.fluid_type);
      return res.json({
        ok: false,
        message: `⚠️ I need a measurement for ${label}. How many ml was it? (e.g. "${label} 80ml")`,
        entries: [],
      });
    }

    // Persist all actions (same as bot)
    const now = Date.now();
    const dayKey = db.getDayKey();
    const entries = [];

    for (const action of parsed.actions) {
      if (action.type === 'input' || action.type === 'output') {
        const entry = db.logEntry({
          timestamp: now,
          day_key: dayKey,
          entry_type: action.type,
          fluid_type: action.fluid_type,
          amount_ml: action.amount_ml,
          source: 'chat',
        });
        entries.push({ kind: action.type, ...action, id: entry?.lastInsertRowid });
      } else if (action.type === 'wellness') {
        db.logWellness({
          timestamp: now,
          day_key: dayKey,
          check_time: action.check_time,
          appetite: action.appetite,
          energy: action.energy,
          mood: action.mood,
          cyanosis: action.cyanosis,
        });
        entries.push({ kind: 'wellness', ...action });
      } else if (action.type === 'gag') {
        db.logGag(action.count, now);
        entries.push({ kind: 'gag', count: action.count });
      }
    }

    const summary = db.getDaySummary(dayKey);
    const message = buildChatConfirmation(parsed.actions, summary);

    res.json({ ok: true, message, entries });
  } catch (err) {
    console.error('[POST /api/chat]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// /api/transcribe — Whisper audio transcription
// ---------------------------------------------------------------------------

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB max
});

app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'No audio file provided' });
    }

    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // Determine file extension from mimetype
    const mime = req.file.mimetype || 'audio/webm';
    let ext = 'webm';
    if (mime.includes('ogg')) ext = 'ogg';
    else if (mime.includes('mp4')) ext = 'mp4';
    else if (mime.includes('wav')) ext = 'wav';
    else if (mime.includes('mpeg') || mime.includes('mp3')) ext = 'mp3';

    // Write temp file (Whisper API needs a file stream)
    const tmpPath = `/tmp/elina-audio-${Date.now()}.${ext}`;
    fs.writeFileSync(tmpPath, req.file.buffer);

    let transcription;
    try {
      transcription = await openai.audio.transcriptions.create({
        model: 'whisper-1',
        file: fs.createReadStream(tmpPath),
        language: 'en',
      });
    } finally {
      // Clean up temp file
      try { fs.unlinkSync(tmpPath); } catch (_) {}
    }

    const text = (transcription.text || '').trim();
    if (!text) {
      return res.json({ ok: false, error: 'Transcription returned empty result' });
    }

    res.json({ ok: true, text });
  } catch (err) {
    console.error('[POST /api/transcribe]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Settings API
// ---------------------------------------------------------------------------

/**
 * GET /api/settings
 * Returns all settings as a flat object.
 */
app.get('/api/settings', (req, res) => {
  try {
    const settings = db.getAllSettings();
    res.json({ ok: true, ...settings });
  } catch (err) {
    console.error('[GET /api/settings]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/settings
 * Accepts partial object, updates provided keys, returns updated settings.
 */
app.post('/api/settings', (req, res) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ ok: false, error: 'Invalid request body' });
    }
    for (const [key, value] of Object.entries(body)) {
      if (value !== undefined && value !== null) {
        db.setSetting(key, value);
      }
    }
    const settings = db.getAllSettings();
    res.json({ ok: true, ...settings });
  } catch (err) {
    console.error('[POST /api/settings]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Settings page
app.get('/settings', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});

// History page
app.get('/history', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'history.html'));
});

// Chat page
app.get('/chat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chat.html'));
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
  const tz = getTimezone();
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true });

  const percent = Math.round((summary.totalIntake / getDailyLimit()) * 100);

  const childName = getChildName();
  let report = `📊 ${childName}'s Report — ${dateStr} ${timeStr}\n`;
  report += `━━━━━━━━━━━━━━━━━━━━━━━\n`;
  report += `\n💧 FLUID INTAKE: ${summary.totalIntake}ml / ${getDailyLimit()}ml (${percent}%)\n`;

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
module.exports.getDailyLimit = getDailyLimit;

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`[server] Smart Patient Wellness Tracker running on port ${PORT}`);
  console.log(`[server] Dashboard: http://localhost:${PORT}`);
  console.log(`[server] Fluid day TZ: ${getTimezone()}`);
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
