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
const { clerkMiddleware, getAuth, createClerkClient } = require('@clerk/express');
const { verifyMachineAuthToken } = require('@clerk/backend/internal');
const db = require('./db');
const { parseMessage } = require('./parser');
const { APP_VERSION, ALEXA_SKILL_VERSION, releaseInfo } = require('./app-version');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY; // Programmatic access (Mr. Stellar)
const truthy = (value) => ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());
const CLERK_AUTH_ENABLED = truthy(process.env.CLERK_AUTH_ENABLED);
const CLERK_SPIKE_ENABLED = truthy(process.env.CLERK_SPIKE_ENABLED);
const CLERK_PUBLISHABLE_KEY = process.env.CLERK_PUBLISHABLE_KEY || '';
const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY || '';
const ALEXA_ACCOUNT_LINKING_REQUIRED = truthy(process.env.ALEXA_ACCOUNT_LINKING_REQUIRED);
const clerkClient = CLERK_SECRET_KEY ? createClerkClient({ secretKey: CLERK_SECRET_KEY }) : null;
const CLERK_CONFIGURED = Boolean(CLERK_PUBLISHABLE_KEY && CLERK_SECRET_KEY && clerkClient);

// Railway (and most PaaS) sit behind a reverse proxy — needed for
// secure cookies and correct req.ip / req.protocol values.
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

if ((CLERK_AUTH_ENABLED || CLERK_SPIKE_ENABLED) && CLERK_CONFIGURED) {
  app.use(clerkMiddleware());
}

// ---------------------------------------------------------------------------
// Session + Auth
// ---------------------------------------------------------------------------

const session = require('express-session');

// ---------------------------------------------------------------------------
// PostgresSessionStore — persists sessions in the application Postgres DB.
// ---------------------------------------------------------------------------
class PostgresSessionStore extends session.Store {
  constructor(database, ttlSeconds = 7 * 24 * 60 * 60) {
    super();
    this._db = database;
    this._ttl = ttlSeconds;

    setInterval(() => {
      this._db.sessionPrune(Math.floor(Date.now() / 1000)).catch(() => {});
    }, 60 * 60 * 1000).unref();
  }

  async get(sid, cb) {
    try {
      const row = await this._db.sessionGet(sid);
      if (!row) return cb(null, null);
      if (row.expires < Math.floor(Date.now() / 1000)) {
        await this._db.sessionDestroy(sid);
        return cb(null, null);
      }
      cb(null, JSON.parse(row.data));
    } catch (err) { cb(err); }
  }

  async set(sid, sess, cb) {
    try {
      const expires = Math.floor(Date.now() / 1000) + this._ttl;
      await this._db.sessionSet(sid, expires, JSON.stringify(sess));
      cb(null);
    } catch (err) { cb(err); }
  }

  async destroy(sid, cb) {
    try { await this._db.sessionDestroy(sid); cb(null); } catch (err) { cb(err); }
  }

  async touch(sid, sess, cb) {
    try {
      const expires = Math.floor(Date.now() / 1000) + this._ttl;
      await this._db.sessionTouch(sid, expires);
      cb(null);
    } catch (err) { cb(err); }
  }
}

app.use(session({
  store: new PostgresSessionStore(db),
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
app.get('/health', (req, res) => res.json({ ok: true, version: APP_VERSION }));
app.get('/api/version', (req, res) => res.json(releaseInfo()));

// PWA assets — must be public so iOS/Android can fetch them without a session
app.get('/apple-touch-icon.png', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'apple-touch-icon.png'))
);
app.get('/manifest.json', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'manifest.json'))
);

function authStatus(req = null) {
  let clerkAuthenticated = false;
  if (req && CLERK_AUTH_ENABLED && CLERK_CONFIGURED) {
    try {
      const auth = getAuth(req);
      clerkAuthenticated = Boolean(auth?.isAuthenticated && auth?.userId);
    } catch (_) {
      clerkAuthenticated = false;
    }
  }
  return {
    mode: CLERK_AUTH_ENABLED ? 'clerk' : 'shared-password',
    clerkEnabled: CLERK_AUTH_ENABLED,
    clerkConfigured: CLERK_CONFIGURED,
    clerkAuthenticated,
    legacySessionAuthenticated: Boolean(req?.session?.authenticated),
    appVersion: APP_VERSION,
  };
}

function renderClerkLoginPage({ misconfigured = false } = {}) {
  const key = JSON.stringify(CLERK_PUBLISHABLE_KEY);
  let clerkScriptSrc = 'https://cdn.jsdelivr.net/npm/@clerk/clerk-js@latest/dist/clerk.browser.js';
  try {
    const encoded = CLERK_PUBLISHABLE_KEY.split('_').pop() || '';
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const clerkHost = decoded.replace(/\$$/, '');
    if (clerkHost) {
      clerkScriptSrc = `https://${clerkHost}/npm/@clerk/clerk-js@latest/dist/clerk.browser.js`;
    }
  } catch (_) {}
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Sign In — Glide Patient Tracker</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width:100%; max-width:100%; overflow-x:hidden; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background:#f0f4f8; min-height:100svh; display:flex; align-items:center; justify-content:center; padding:16px; }
    .card { background:#fff; border-radius:20px; box-shadow:0 4px 24px rgba(0,0,0,.10); padding:32px 18px 28px; width:100%; max-width:min(430px, 100%); text-align:center; overflow:hidden; }
    .icon { font-size:2.8rem; margin-bottom:12px; }
    h1 { font-size:clamp(1.15rem, 5vw, 1.3rem); font-weight:700; color:#202124; margin-bottom:6px; }
    .subtitle { font-size:.9rem; color:#5f6368; margin-bottom:20px; }
    .notice { background:#fff7e6; color:#7a4a00; border-radius:10px; padding:10px 14px; font-size:.88rem; margin-bottom:18px; text-align:left; }
    .button { display:block; width:100%; padding:14px; background:#1a73e8; color:#fff; border:none; border-radius:12px; font-size:1rem; font-weight:600; text-decoration:none; cursor:pointer; }
    .button:hover { background:#1558b0; }
    .muted { color:#5f6368; font-size:.86rem; line-height:1.4; margin-top:12px; }
    .version { margin-top:18px; font-size:.78rem; color:#8a94a6; }
    #sign-in { min-height:180px; width:100%; max-width:100%; overflow:hidden; }
    #sign-in :is(.cl-rootBox, .cl-card, .cl-cardBox, .cl-scrollBox, .cl-main, .cl-form, .cl-formField, .cl-formButtonPrimary, .cl-socialButtonsBlockButton, .cl-footer, .cl-footerAction) { width:100% !important; max-width:100% !important; min-width:0 !important; }
    #sign-in :is(.cl-card, .cl-cardBox) { box-shadow:none !important; border-radius:14px !important; }
    #sign-in :is(input, button) { max-width:100% !important; }
    @media (max-width: 380px) {
      body { padding:10px; align-items:flex-start; }
      .card { padding:24px 10px 22px; border-radius:16px; }
      .icon { font-size:2.2rem; }
      .subtitle { margin-bottom:14px; }
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">❤️</div>
    <h1>Glide Patient Tracker</h1>
    <p class="subtitle">Sign in with your Glide Patient Tracker account.</p>
    ${misconfigured ? '<div class="notice">Clerk login is enabled but not fully configured. Please contact support.</div>' : `<p class="muted" id="login-help">Loading secure sign-in…</p><div id="sign-in" aria-live="polite"></div>`}
    <div class="version" id="app-version">Version loading…</div>
  </div>
  ${misconfigured ? '' : `<script async crossorigin="anonymous" data-clerk-publishable-key=${key} src="${clerkScriptSrc}"></script>
  <script>
    window.addEventListener('load', async () => {
      const version = document.getElementById('app-version');
      fetch('/api/version').then((res) => res.json()).then((info) => {
        version.textContent = 'Glide Patient Tracker v' + info.version;
      }).catch(() => { version.textContent = 'Glide Patient Tracker'; });
      const signIn = document.getElementById('sign-in');
      const help = document.getElementById('login-help');
      try {
        if (!window.Clerk) throw new Error('Clerk browser library did not load.');
        await Promise.race([
          window.Clerk.load({ publishableKey: ${key} }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Clerk browser library timed out while loading.')), 8000)),
        ]);
        if (window.Clerk.user) {
          window.location.assign('/');
          return;
        }
        window.Clerk.mountSignIn(signIn, {
          afterSignInUrl: '/',
          afterSignUpUrl: '/',
          redirectUrl: '/',
        });
        help.textContent = 'Use the secure sign-in form below.';
      } catch (error) {
        signIn.innerHTML = '<div class="notice">Secure sign-in did not load. Please contact support; the app login is temporarily misconfigured.</div>';
        console.error('[auth] Clerk sign-in render failed:', error);
      }
    });
  </script>`}
</body>
</html>`;
}

app.get('/api/auth/status', (req, res) => res.json(authStatus(req)));

// Login page (public — no auth required)
app.get('/login', (req, res) => {
  if (CLERK_AUTH_ENABLED) {
    if (!CLERK_CONFIGURED) return res.status(503).type('html').send(renderClerkLoginPage({ misconfigured: true }));
    const auth = getAuth(req);
    if (auth?.isAuthenticated && auth?.userId) return res.redirect('/');
    return res.type('html').send(renderClerkLoginPage());
  }
  if (req.session && req.session.authenticated) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Login form submission
app.post('/login', (req, res) => {
  if (CLERK_AUTH_ENABLED) return res.redirect(303, '/login');
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
  if (CLERK_AUTH_ENABLED) {
    if (!CLERK_CONFIGURED) return res.redirect('/login');
    return res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><title>Signing out — Glide Patient Tracker</title></head>
<body><p>Signing out…</p>
<script async crossorigin="anonymous" data-clerk-publishable-key=${JSON.stringify(CLERK_PUBLISHABLE_KEY)} src="https://cdn.jsdelivr.net/npm/@clerk/clerk-js@latest/dist/clerk.browser.js"></script>
<script>window.addEventListener('load', async () => { await window.Clerk.load(); await window.Clerk.signOut(); window.location.assign('/login'); });</script>
</body></html>`);
  }
  req.session.destroy(() => res.redirect('/login'));
});

// ---------------------------------------------------------------------------
// Clerk auth spike (public, explicitly gated; does not replace shared login)
// ---------------------------------------------------------------------------

function clerkSpikeStatus() {
  return {
    enabled: CLERK_SPIKE_ENABLED,
    configured: Boolean(CLERK_PUBLISHABLE_KEY && CLERK_SECRET_KEY && clerkClient),
    appVersion: APP_VERSION,
  };
}

app.get('/clerk-spike', (req, res) => {
  const status = clerkSpikeStatus();
  if (!status.enabled || !status.configured) {
    return res.status(404).send('Clerk spike is disabled. Set CLERK_SPIKE_ENABLED=true plus Clerk keys to test it.');
  }

  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Clerk Auth Spike · Glide Patient Tracker</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; color: #172033; }
    code, pre { background: #f4f6fb; border-radius: 8px; padding: 0.75rem; }
    pre { white-space: pre-wrap; }
    .card { border: 1px solid #d9e0ef; border-radius: 14px; padding: 1rem; margin: 1rem 0; }
    button { border: 0; border-radius: 999px; padding: 0.7rem 1rem; background: #365cff; color: white; font-weight: 700; cursor: pointer; }
    button.secondary { background: #edf1ff; color: #24356a; }
  </style>
</head>
<body>
  <h1>Clerk Auth Spike</h1>
  <p>This isolated page validates Clerk login/session plumbing only. It does not replace the production shared-password login.</p>
  <div id="signed-out" class="card" hidden>
    <h2>Sign in</h2>
    <p>The embedded Clerk UI may not render for every Clerk development instance, so this spike uses Clerk's hosted redirect flow as the reliable path.</p>
    <p><button id="hosted-sign-in">Sign in with Clerk</button></p>
    <div id="sign-in"></div>
    <pre id="sign-in-output" hidden></pre>
  </div>
  <div id="signed-in" class="card" hidden>
    <h2>Signed in</h2>
    <p><button id="check-session">Check backend session</button> <button class="secondary" id="sign-out">Sign out</button></p>
    <pre id="session-output">Waiting…</pre>
  </div>
  <script async crossorigin="anonymous" data-clerk-publishable-key="${CLERK_PUBLISHABLE_KEY}" src="https://cdn.jsdelivr.net/npm/@clerk/clerk-js@latest/dist/clerk.browser.js"></script>
  <script>
    window.addEventListener('load', async () => {
      await window.Clerk.load();
      const signedIn = Boolean(window.Clerk.user);
      document.getElementById('signed-out').hidden = signedIn;
      document.getElementById('signed-in').hidden = !signedIn;
      if (!signedIn) {
        document.getElementById('hosted-sign-in').addEventListener('click', () => {
          window.Clerk.redirectToSignIn({ redirectUrl: window.location.href });
        });
        try {
          window.Clerk.mountSignIn(document.getElementById('sign-in'));
        } catch (error) {
          const output = document.getElementById('sign-in-output');
          output.hidden = false;
          output.textContent = 'Embedded sign-in unavailable; use the Sign in with Clerk button above. Detail: ' + error.message;
        }
        return;
      }
      const check = async () => {
        const response = await fetch('/api/clerk-spike/session');
        document.getElementById('session-output').textContent = JSON.stringify(await response.json(), null, 2);
      };
      document.getElementById('check-session').addEventListener('click', check);
      document.getElementById('sign-out').addEventListener('click', () => window.Clerk.signOut(() => location.reload()));
      await check();
    });
  </script>
</body>
</html>`);
});

app.get('/api/clerk-spike/status', (req, res) => {
  res.json(clerkSpikeStatus());
});

const clerkSpikeMiddleware = (req, res, next) => {
  const status = clerkSpikeStatus();
  if (!status.enabled || !status.configured) {
    return res.status(404).json({ error: 'clerk_spike_disabled', ...status });
  }
  return clerkMiddleware()(req, res, next);
};

app.get('/api/clerk-spike/session', clerkSpikeMiddleware, async (req, res) => {
  const auth = getAuth(req);
  if (!auth.isAuthenticated || !auth.userId) {
    return res.status(401).json({ authenticated: false });
  }

  const user = await clerkClient.users.getUser(auth.userId);
  res.json({
    authenticated: true,
    clerkUserId: auth.userId,
    sessionId: auth.sessionId,
    primaryEmail: user.primaryEmailAddress?.emailAddress || null,
    firstName: user.firstName || null,
    lastName: user.lastName || null,
    proposedInternalMapping: {
      familyId: process.env.DEFAULT_FAMILY_ID || '00000000-0000-4000-8000-000000000001',
      patientId: process.env.DEFAULT_PATIENT_ID || '00000000-0000-4000-8000-000000000101',
      role: 'caregiver',
    },
  });
});

// ---------------------------------------------------------------------------
// Alexa Skill endpoint (public — authenticated via Skill ID, not session)
// ---------------------------------------------------------------------------

/**
 * Build an Alexa JSON response with SSML speech output.
 */
function alexaResponse(ssml, shouldEndSession = true, repromptSsml = null, directives = [], sessionAttributes = {}, card = null) {
  const resp = {
    version: '1.0',
    sessionAttributes,
    response: {
      outputSpeech: { type: 'SSML', ssml: `<speak>${ssml}</speak>` },
    },
  };
  // null = omit shouldEndSession entirely — keeps session alive for APL touch
  // events without opening the microphone (touch-first mode).
  // false = keep session alive AND open the mic.
  // true  = end session.
  if (shouldEndSession !== null) {
    resp.response.shouldEndSession = shouldEndSession;
  }
  if (repromptSsml) {
    resp.response.reprompt = {
      outputSpeech: { type: 'SSML', ssml: `<speak>${repromptSsml}</speak>` },
    };
  }
  if (directives.length > 0) resp.response.directives = directives;
  if (card) resp.response.card = card;
  return resp;
}

function alexaLinkAccountResponse() {
  return alexaResponse(
    'Please use the Alexa app to link your Glide Patient Tracker account first.',
    true,
    null,
    [],
    {},
    { type: 'LinkAccount' }
  );
}

function getAlexaAccessToken(body) {
  return body?.context?.System?.user?.accessToken || body?.session?.user?.accessToken || '';
}

function getAlexaUserId(body) {
  return body?.context?.System?.user?.userId || body?.session?.user?.userId || null;
}

async function resolveAlexaAccountContext(body) {
  const accessToken = getAlexaAccessToken(body);
  if (!accessToken) return { ok: false, reason: 'missing_access_token' };
  if (!CLERK_SECRET_KEY) return { ok: false, reason: 'clerk_not_configured' };

  let verified;
  try {
    verified = await verifyMachineAuthToken(accessToken, { secretKey: CLERK_SECRET_KEY });
  } catch (err) {
    return { ok: false, reason: 'invalid_access_token', error: err.message || 'Token verification failed' };
  }
  const { data, errors } = verified;
  if (errors) return { ok: false, reason: 'invalid_access_token', error: errors[0]?.message || 'Token verification failed' };

  const subject = data?.subject || data?.sub;
  if (!subject) return { ok: false, reason: 'missing_subject' };

  const alexaUserId = getAlexaUserId(body);
  const link = await db.getAlexaAccountLinkBySubject(subject);
  if (!link) return { ok: false, reason: 'unmapped_subject' };
  if (alexaUserId && !link.alexa_user_id) {
    await db.setAlexaAccountLinkUserId(subject, alexaUserId);
    link.alexa_user_id = alexaUserId;
  }

  return {
    ok: true,
    tokenClaims: data,
    link,
    familyId: link.family_id,
    patientId: link.patient_id,
  };
}

function supportsApl(req) {
  // Per Amazon docs: ONLY send APL when supportedInterfaces declares it.
  // Viewport presence alone is not enough — Amazon's service uses supportedInterfaces
  // to signal that APL is cleared for this skill+device combination.
  // Sending APL without this signal causes "problem with skill response" errors.
  return !!(req.body?.context?.System?.device?.supportedInterfaces?.['Alexa.Presentation.APL']);
}

function getViewportProfile(req) {
  const px = req.body?.context?.Viewport?.pixelWidth || 0;
  if (px >= 1200) return 'hub_large';
  return 'hub_small';
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

// ── AVG Donut math helpers ────────────────────────────────────────────────────

function avgPolar(cx, cy, r, angleDeg) {
  const rad = angleDeg * Math.PI / 180;
  return { x: +(cx + r * Math.cos(rad)).toFixed(2), y: +(cy + r * Math.sin(rad)).toFixed(2) };
}

function avgArcPath(cx, cy, r, a1, a2) {
  const p1 = avgPolar(cx, cy, r, a1);
  const p2 = avgPolar(cx, cy, r, a2);
  const sweep = ((a2 - a1) + 360) % 360;
  return `M ${p1.x} ${p1.y} A ${r} ${r} 0 ${sweep > 180 ? 1 : 0} 1 ${p2.x} ${p2.y}`;
}

// Builds the AVG items array for a multi-segment donut ring.
function buildAvgDonutItems(cx, cy, r, sw, intakeByType, limit) {
  const COLORS = {
    water: '#2a8aff', pediasure: '#f08c00', milk: '#90aec8',
    juice: '#e03030', yogurt_drink: '#8a48cc',
  };
  // Full background ring (near-complete circle trick)
  const bgPath = `M ${cx} ${(cy - r).toFixed(2)} A ${r} ${r} 0 1 1 ${(cx - 0.01).toFixed(2)} ${(cy - r).toFixed(2)} Z`;
  const items = [{ type: 'path', pathData: bgPath, stroke: '#0f1e35', strokeWidth: sw, fill: 'none' }];

  const entries = Object.entries(intakeByType)
    .filter(([, ml]) => ml > 0)
    .sort((a, b) => b[1] - a[1]);
  if (!entries.length) return items;

  const GAP = entries.length > 1 ? 2 : 0;
  let angle = -90; // start from top (12 o'clock)
  let remaining = limit;

  for (const [type, rawMl] of entries) {
    const ml = Math.min(rawMl, remaining);
    if (ml <= 0) break;
    const sweep = (ml / limit) * 360;
    if (sweep >= 1) {
      items.push({
        type: 'path',
        pathData: avgArcPath(cx, cy, r, angle + GAP / 2, angle + sweep - GAP / 2),
        stroke: COLORS[type] || '#4a9eff',
        strokeWidth: sw,
        fill: 'none',
        strokeLinecap: 'round',
      });
    }
    angle += sweep;
    remaining -= ml;
  }
  return items;
}

function buildArchItems(cx, cy, r, sw, intakeByType, limit) {
  const COLORS = {
    water: '#2a8aff', pediasure: '#f08c00', milk: '#90aec8',
    juice: '#e03030', yogurt_drink: '#8a48cc',
  };
  const bgPath = `M ${(cx - r).toFixed(2)} ${cy.toFixed(2)} A ${r} ${r} 0 0 1 ${(cx + r).toFixed(2)} ${cy.toFixed(2)}`;
  const items = [{ type: 'path', pathData: bgPath, stroke: '#0f1e35', strokeWidth: sw, fill: 'none', strokeLinecap: 'round' }];

  const entries = Object.entries(intakeByType)
    .filter(([, ml]) => ml > 0)
    .sort((a, b) => b[1] - a[1]);
  if (!entries.length) return items;

  const GAP = entries.length > 1 ? 1.5 : 0;
  let angle = 180;
  let remaining = limit;

  for (const [type, rawMl] of entries) {
    const ml = Math.min(rawMl, remaining);
    if (ml <= 0) break;
    const sweep = (ml / limit) * 180;
    if (sweep >= 0.5) {
      items.push({
        type: 'path',
        pathData: avgArcPath(cx, cy, r, angle + GAP / 2, angle + sweep - GAP / 2),
        stroke: COLORS[type] || '#4a9eff',
        strokeWidth: sw,
        fill: 'none',
        strokeLinecap: 'round',
      });
    }
    angle += sweep;
    remaining -= ml;
  }
  return items;
}

// Aggregate output log rows into { type: { ml, count, display } }.
function computeOutputByType(outputs) {
  const map = {};
  for (const l of outputs) {
    if (!map[l.fluid_type]) map[l.fluid_type] = { ml: 0, count: 0 };
    map[l.fluid_type].ml    += (l.amount_ml || 0);
    map[l.fluid_type].count += 1;
  }
  for (const [type, d] of Object.entries(map)) {
    d.display = type === 'poop' ? `${d.count}×` : `${d.ml} ml`;
  }
  return map;
}

// ── APL directive builder ─────────────────────────────────────────────────────
// mode: 'display' = status view | 'input'/'output' = logging UI
// intakeByType / outputByType only needed for display mode.
function buildAplDirective(intakeMl, limitMl, mode, selectedFluid, outputMl, intakeByType, outputByType, allInputs, viewport, customDigits = '', displayDayOffset = 0) {
  const pct     = Math.min(100, Math.round(((intakeMl || 0) / (limitMl || 1200)) * 100));
  const outMl   = outputMl || 0;
  const inColor = pct >= 90 ? '#e74c3c' : pct >= 75 ? '#f39c12' : '#4a9eff';
  const displayDayLabel = displayDayOffset === -1 ? 'YESTERDAY' : 'TODAY';

  // ── Shared fluid palette ──────────────────────────────────────────────────
  const FLUID_LABELS = {
    water: 'Water', pediasure: 'PediaSure', milk: 'Milk',
    juice: 'Juice', yogurt_drink: 'Yogurt Drink', vitamin_water: 'Vitamin Water',
    urine: 'Urine', poop: 'Poop', vomit: 'Vomit',
  };
  const FLUID_COLORS = {
    water:         { dim: '#0d4a8a', bright: '#2a8aff', accent: '#2a8aff' },
    pediasure:     { dim: '#7a4800', bright: '#f08c00', accent: '#f08c00' },
    milk:          { dim: '#2a3a52', bright: '#6888aa', accent: '#90aec8' },
    juice:         { dim: '#6a0808', bright: '#d93030', accent: '#e03030' },
    yogurt_drink:  { dim: '#3a1260', bright: '#8a48cc', accent: '#8a48cc' },
    vitamin_water: { dim: '#0a3a4a', bright: '#00b4c8', accent: '#00c8d8' },
    urine:         { dim: '#5a5200', bright: '#d4b800', accent: '#d4b800' },
    poop:          { dim: '#3a1a06', bright: '#8b4513', accent: '#8b4513' },
    vomit:         { dim: '#0a4020', bright: '#25a060', accent: '#25a060' },
  };

  // ── Helper: tappable button ───────────────────────────────────────────────
  function btn(label, args, bg) {
    return {
      type: 'TouchWrapper',
      onPress: { type: 'SendEvent', arguments: args },
      marginRight: '12dp',
      item: {
        type: 'Frame',
        backgroundColor: bg || '#1a2a40',
        borderRadius: 12,
        paddingTop: '18dp',
        paddingBottom: '18dp',
        paddingLeft: '26dp',
        paddingRight: '26dp',
        item: {
          type: 'Text',
          text: label,
          color: 'white',
          fontSize: '24dp',
          fontWeight: 'bold',
          textAlign: 'center',
        },
      },
    };
  }

  // ── Shared header row (used by both display and logging) ──────────────────
  const patientName = db.getSetting('child_name') || null;
  const headerRow = {
    type: 'Container',
    direction: 'row',
    backgroundColor: '#d0e8ff',
    paddingTop: '12dp',
    paddingBottom: '12dp',
    paddingLeft: '24dp',
    paddingRight: '24dp',
    alignItems: 'center',
    items: [
      {
        type: 'Text',
        text: patientName ? `💧 ${patientName}` : '💧 Fluid Tracker',
        color: '#5a8abf',
        fontSize: '17dp',
      },
      {
        type: 'Container', grow: 1, direction: 'row', alignItems: 'center',
        items: [
          { type: 'Frame', grow: 1, height: '1dp', backgroundColor: 'transparent' },
          {
            type: 'Text',
            text: `${displayDayLabel} IN  ${intakeMl || 0} / ${limitMl} ml  (${pct}%)`,
            color: inColor,
            fontSize: '24dp',
            fontWeight: 'bold',
          },
          { type: 'Frame', width: '60dp', height: '1dp', backgroundColor: 'transparent' },
          {
            type: 'Text',
            text: `${displayDayLabel} OUT  ${outMl} ml`,
            color: '#b05800',
            fontSize: '24dp',
            fontWeight: 'bold',
          },
          { type: 'Frame', grow: 1, height: '1dp', backgroundColor: 'transparent' },
        ],
      },
    ],
  };
  const divider = { type: 'Frame', backgroundColor: '#a8c8e8', height: '2dp' };

  // ═══════════════════════════════════════════════════════════════════════════
  // DISPLAY MODE — 3-column status view with AVG donut
  // ═══════════════════════════════════════════════════════════════════════════
  if (mode === 'display') {
    const ibt = intakeByType || {};
    const tz = getTimezone ? getTimezone() : 'America/New_York';
    const isLarge = (viewport === 'hub_large');

    // Full circle donut params
    const donutR      = isLarge ? 132 : 105;
    const donutSw     = isLarge ? 36  : 30;
    const donutCx     = donutR + donutSw / 2;
    const donutCy     = donutR + donutSw / 2;
    const donutSize   = Math.round((donutR + donutSw / 2) * 2);
    const centerColW  = donutSize + 64;   // fixed center width; extra padding for breathing room

    // Entry row typography — 18dp minimum for medical readability at arm's length
    const entryFontSize     = '18dp';
    const entryTimeFontSize = '14dp';
    const entryPadV         = isLarge ? '9dp' : '8dp';
    const entryDotSize      = isLarge ? '9dp' : '8dp';

    // Gauge center text
    const donutBigFont  = isLarge ? '46dp' : '42dp';
    const donutSubFont  = isLarge ? '13dp' : '12dp';
    const donutPctFont  = isLarge ? '26dp' : '24dp';
    // Vertically center the text stack inside the circle
    const textStackH    = isLarge ? 94 : 74;   // approx: bigFont + sub + pct + gaps
    const donutTextTop  = `${Math.round(donutCy - textStackH / 2)}dp`;

    // Legend and labels
    const legendFont    = isLarge ? '17dp' : '16dp';
    const sectionFont   = isLarge ? '18dp' : '16dp';

    function entryRow(entry, fallbackColor) {
      const timeStr = new Date(entry.timestamp).toLocaleTimeString('en-US',
        { hour: 'numeric', minute: '2-digit', timeZone: tz });
      const amtStr = entry.amount_ml ? `${entry.amount_ml} ml` : '—';
      const color = FLUID_COLORS[entry.fluid_type]?.accent || fallbackColor;
      const label = FLUID_LABELS[entry.fluid_type] || entry.fluid_type;
      return {
        type: 'Container', direction: 'row', alignItems: 'center',
        paddingTop: entryPadV, paddingBottom: entryPadV,
        paddingLeft: '12dp', paddingRight: '12dp',
        items: [
          { type: 'Frame', width: entryDotSize, height: entryDotSize, borderRadius: 5,
            backgroundColor: color, marginRight: '8dp', alignSelf: 'center' },
          { type: 'Text', text: label, color: '#c0d0e8', fontSize: entryFontSize, grow: 1 },
          { type: 'Container', alignItems: 'flexEnd', items: [
            { type: 'Text', text: amtStr, color: 'white',
              fontSize: entryFontSize, fontWeight: 'bold', textAlign: 'right' },
            { type: 'Text', text: timeStr, color: '#4a6a8a',
              fontSize: entryTimeFontSize, textAlign: 'right' },
          ] },
        ],
      };
    }
    const entryDivider = { type: 'Frame', height: '1dp', backgroundColor: '#0f1e35',
      marginLeft: '12dp', marginRight: '12dp' };

    const sortedInputs = Array.isArray(allInputs) ? [...allInputs].sort((a, b) => b.timestamp - a.timestamp) : [];
    const sortedOutputs = Array.isArray(outputByType) ? [...outputByType].sort((a, b) => b.timestamp - a.timestamp) : [];

    const inputListItems = sortedInputs.length > 0
      ? sortedInputs.flatMap((e, i) => i === 0 ? [entryRow(e, '#4a9eff')] : [entryDivider, entryRow(e, '#4a9eff')])
      : [{ type: 'Text', text: 'No intake yet', color: '#243550', fontSize: entryFontSize,
           paddingTop: '14dp', paddingLeft: '14dp' }];

    const outputListItems = sortedOutputs.length > 0
      ? sortedOutputs.flatMap((e, i) => i === 0 ? [entryRow(e, '#f08c00')] : [entryDivider, entryRow(e, '#f08c00')])
      : [{ type: 'Text', text: 'No output yet', color: '#243550', fontSize: entryFontSize,
           paddingTop: '14dp', paddingLeft: '14dp' }];

    const donutItems = buildAvgDonutItems(donutCx, donutCy, donutR, donutSw, ibt, limitMl);

    const legendItems = Object.entries(ibt)
      .filter(([, ml]) => ml > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([t]) => ({
        color: FLUID_COLORS[t]?.accent || '#4a9eff',
        label: FLUID_LABELS[t] || t,
      }));

    const legendRows = [];
    for (let i = 0; i < legendItems.length; i += 2) {
      const rowItems = [legendItems[i], legendItems[i + 1]].filter(Boolean).map((li) => ({
        type: 'Container', direction: 'row', alignItems: 'center',
        grow: 1, paddingRight: '6dp',
        items: [
          { type: 'Frame', width: '7dp', height: '7dp', borderRadius: 4,
            backgroundColor: li.color, marginRight: '5dp' },
          { type: 'Text', text: li.label, color: '#8ab4cc', fontSize: legendFont },
        ],
      }));
      legendRows.push({
        type: 'Container', direction: 'row',
        paddingTop: '3dp', paddingBottom: '1dp',
        paddingLeft: '4dp', paddingRight: '4dp',
        items: rowItems,
      });
    }

    const legendSection = legendRows.length > 0
      ? { type: 'Container', direction: 'column', paddingTop: '8dp', items: legendRows }
      : { type: 'Frame', height: '1dp', backgroundColor: 'transparent' };

    const toggleDayOffset = displayDayOffset === -1 ? 0 : -1;
    const toggleDayLabel = displayDayOffset === -1 ? 'Today' : 'Yesterday';

    const centerCol = {
      type: 'Container',
      width: `${centerColW}dp`,
      direction: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      paddingTop: '12dp',
      paddingLeft: '24dp',
      paddingRight: '24dp',
      items: [
        {
          type: 'Container',
          width: `${donutSize}dp`,
          height: `${donutSize}dp`,
          items: [
            {
              type: 'VectorGraphic',
              source: 'donut',
              width: `${donutSize}dp`,
              height: `${donutSize}dp`,
              position: 'absolute',
              top: '0dp',
              left: '0dp',
            },
            {
              type: 'Container',
              position: 'absolute',
              top: donutTextTop,
              left: '0dp',
              right: '0dp',
              direction: 'column',
              alignItems: 'center',
              items: [
                {
                  type: 'Text',
                  text: String(intakeMl || 0),
                  color: 'white',
                  fontSize: donutBigFont,
                  fontWeight: 'bold',
                },
                {
                  type: 'Text',
                  text: `ml of ${limitMl}`,
                  color: '#2a4a6a',
                  fontSize: donutSubFont,
                },
                {
                  type: 'Text',
                  text: `${pct}%`,
                  color: inColor,
                  fontSize: donutPctFont,
                  fontWeight: 'bold',
                },
              ],
            },
          ],
        },
        legendSection,
      ],
    };

    function colLabel(text, color) {
      return {
        type: 'Text', text,
        color,
        fontSize: sectionFont,
        fontWeight: 'bold',
        paddingLeft: '12dp',
        paddingBottom: '4dp',
      };
    }
    const colDividerLine = { type: 'Frame', height: '1dp', backgroundColor: '#0f1e35',
      marginLeft: '12dp', marginRight: '12dp', marginBottom: '2dp' };

    return {
      type: 'Alexa.Presentation.APL.RenderDocument',
      version: '1.0',
      token: 'tracker-ui',
      document: {
        type: 'APL',
        version: '1.5',
        theme: 'dark',
        settings: { idleTimeoutInMilliseconds: 2147483647 },
        onMount: [
          {
            type: 'Sequential',
            repeatCount: -1,
            commands: [
              { type: 'Idle', delay: 29000, screenLock: true },
              { type: 'SendEvent', arguments: ['refresh', 'display', String(displayDayOffset)],
                flags: { interactionMode: 'auto' } },
            ],
          },
        ],
        graphics: {
          donut: { type: 'AVG', version: '1.2',
            width: donutSize, height: donutSize, items: donutItems },
        },
        mainTemplate: {
          parameters: [],
          items: [{
            type: 'Container', width: '100vw', height: '100vh',
            backgroundColor: '#080f1e', direction: 'column',
            items: [
              headerRow,
              divider,
              {
                type: 'Container', direction: 'row', grow: 1,
                paddingBottom: '72dp',
                items: [
                  {
                    type: 'Container', grow: 1, shrink: 1, width: '0dp', direction: 'column',
                    paddingTop: '10dp',
                    items: [
                      colLabel('INTAKE', '#4a9eff'),
                      colDividerLine,
                      { type: 'Sequence', grow: 1, scrollDirection: 'vertical',
                        items: inputListItems },
                    ],
                  },
                  { type: 'Frame', width: '2dp', backgroundColor: '#0a1830' },
                  centerCol,
                  { type: 'Frame', width: '2dp', backgroundColor: '#0a1830' },
                  {
                    type: 'Container', grow: 1, shrink: 1, width: '0dp', direction: 'column',
                    paddingTop: '10dp',
                    items: [
                      colLabel('OUTPUT', '#f08c00'),
                      colDividerLine,
                      { type: 'Sequence', grow: 1, scrollDirection: 'vertical',
                        items: outputListItems },
                    ],
                  },
                ],
              },
              {
                type: 'Container',
                position: 'absolute',
                bottom: '0dp', left: '0dp', right: '0dp',
                direction: 'column',
                items: [
                  { type: 'Frame', backgroundColor: '#a8c8e8', height: '2dp' },
                  {
                    type: 'Container', direction: 'row',
                    backgroundColor: '#d0e8ff',
                    height: '72dp',
                    paddingLeft: '16dp', paddingRight: '16dp',
                    alignItems: 'center',
                    items: [
                      {
                        type: 'TouchWrapper', grow: 1, marginRight: '10dp',
                        onPress: { type: 'SendEvent', arguments: ['day', String(toggleDayOffset)] },
                        item: {
                          type: 'Frame', backgroundColor: '#35506f', borderRadius: 10,
                          alignSelf: 'stretch', width: '100%',
                          paddingTop: '14dp', paddingBottom: '14dp',
                          item: { type: 'Text', text: toggleDayLabel, color: 'white',
                            width: '100%', fontSize: '18dp', fontWeight: 'bold',
                            textAlign: 'center', textAlignVertical: 'center' },
                        },
                      },
                      {
                        type: 'TouchWrapper', grow: 3, marginRight: '10dp',
                        onPress: { type: 'SendEvent', arguments: ['mode', 'input'] },
                        item: {
                          type: 'Frame', backgroundColor: '#0d3a7a', borderRadius: 10,
                          alignSelf: 'stretch', width: '100%',
                          paddingTop: '14dp', paddingBottom: '14dp',
                          item: { type: 'Text', text: 'Log by Tap', color: 'white',
                            width: '100%', fontSize: '20dp', fontWeight: 'bold',
                            textAlign: 'center', textAlignVertical: 'center' },
                        },
                      },
                      {
                        type: 'TouchWrapper', grow: 3, marginRight: '10dp',
                        onPress: { type: 'SendEvent', arguments: ['voice'] },
                        item: {
                          type: 'Frame', backgroundColor: '#0d1a40', borderRadius: 10,
                          alignSelf: 'stretch', width: '100%',
                          paddingTop: '14dp', paddingBottom: '14dp',
                          item: { type: 'Text', text: '🎤  Log by Voice', color: '#8ab4f8',
                            width: '100%', fontSize: '20dp', fontWeight: 'bold',
                            textAlign: 'center', textAlignVertical: 'center' },
                        },
                      },
                      {
                        type: 'TouchWrapper', grow: 1,
                        onPress: { type: 'SendEvent', arguments: ['quit'] },
                        item: {
                          type: 'Frame', backgroundColor: '#5a0808', borderRadius: 10,
                          alignSelf: 'stretch', width: '100%',
                          paddingTop: '14dp', paddingBottom: '14dp',
                          item: { type: 'Text', text: 'Quit', color: '#ffaaaa',
                            width: '100%', fontSize: '20dp', fontWeight: 'bold',
                            textAlign: 'center', textAlignVertical: 'center' },
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          }],
        },
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FULL LOG MODE — inputs left column, outputs right column
  // ═══════════════════════════════════════════════════════════════════════════
  if (mode === 'fulllog') {
    const tz = getTimezone ? getTimezone() : 'America/New_York';
    const rawInputs  = Array.isArray(allInputs)   ? [...allInputs].sort((a,b)  => b.timestamp - a.timestamp) : [];
    const rawOutputs = Array.isArray(outputByType) ? [...outputByType].sort((a,b) => b.timestamp - a.timestamp) : [];

    // Build a row for a single entry within its column (no type tag needed — already grouped)
    function logCol(entry) {
      const timeStr = new Date(entry.timestamp).toLocaleTimeString('en-US',
        { hour: 'numeric', minute: '2-digit', timeZone: tz });
      const amtStr = entry.amount_ml ? `${entry.amount_ml} ml` : '—';
      const color  = FLUID_COLORS[entry.fluid_type]?.accent
        || (entry.entry_type === 'input' ? '#4a9eff' : '#f08c00');
      const label  = FLUID_LABELS[entry.fluid_type] || entry.fluid_type;
      return {
        type: 'Container', direction: 'row', alignItems: 'center',
        paddingTop: '11dp', paddingBottom: '11dp',
        paddingLeft: '16dp', paddingRight: '16dp',
        items: [
          { type: 'Frame', width: '10dp', height: '10dp', borderRadius: 5,
            backgroundColor: color, marginRight: '10dp', alignSelf: 'center' },
          { type: 'Text', text: label, color: '#c0d0e8', fontSize: '22dp', grow: 1 },
          { type: 'Container', direction: 'column', alignItems: 'flexEnd',
            items: [
              { type: 'Text', text: amtStr, color: 'white',
                fontSize: '22dp', fontWeight: 'bold' },
              { type: 'Text', text: timeStr, color: '#4a6a8a', fontSize: '17dp' },
            ],
          },
        ],
      };
    }

    const colDivider = { type: 'Frame', height: '1dp', backgroundColor: '#0f1e35',
      marginLeft: '16dp', marginRight: '16dp' };

    function buildColItems(entries, emptyText) {
      if (entries.length === 0) {
        return [{ type: 'Text', text: emptyText, color: '#243550',
          fontSize: '20dp', paddingTop: '16dp', paddingLeft: '16dp' }];
      }
      return entries.flatMap((e, i) => i === 0 ? [logCol(e)] : [colDivider, logCol(e)]);
    }

    const inputColItems  = buildColItems(rawInputs,  'No inputs yet');
    const outputColItems = buildColItems(rawOutputs, 'No outputs yet');

    // Vertical center divider between columns
    const centerDivider = {
      type: 'Frame', width: '2dp', backgroundColor: '#0a1830',
      marginTop: '8dp', marginBottom: '8dp',
    };

    return {
      type: 'Alexa.Presentation.APL.RenderDocument',
      version: '1.0',
      token: 'tracker-ui',
      document: {
        type: 'APL',
        version: '1.5',
        theme: 'dark',
        settings: { idleTimeoutInMilliseconds: 2147483647 },
        mainTemplate: {
          parameters: [],
          items: [{
            type: 'Container', width: '100vw', height: '100vh',
            backgroundColor: '#080f1e', direction: 'column',
            items: [
              headerRow,
              divider,
              // Back button row
              {
                type: 'Container', direction: 'row',
                paddingTop: '10dp', paddingBottom: '8dp', paddingLeft: '20dp',
                items: [
                  btn('← STATUS', ['mode', 'display'], '#0a1a2a'),
                ],
              },
              { type: 'Frame', backgroundColor: '#0a1830', height: '2dp' },
              // Two-column body
              {
                type: 'Container', direction: 'row', grow: 1,
                items: [
                  // ── Left: INPUTS ──────────────────────────────────────
                  {
                    type: 'Container', grow: 1, direction: 'column',
                    paddingTop: '10dp',
                    items: [
                      { type: 'Text', text: 'INPUTS', color: '#4a9eff',
                        fontSize: '22dp', fontWeight: 'bold',
                        paddingLeft: '16dp', paddingBottom: '8dp' },
                      { type: 'Frame', backgroundColor: '#0f1e35', height: '2dp',
                        marginLeft: '16dp', marginRight: '16dp', marginBottom: '4dp' },
                      {
                        type: 'ScrollView', grow: 1,
                        item: {
                          type: 'Container', direction: 'column',
                          items: inputColItems,
                        },
                      },
                    ],
                  },
                  centerDivider,
                  // ── Right: OUTPUTS ─────────────────────────────────────
                  {
                    type: 'Container', grow: 1, direction: 'column',
                    paddingTop: '10dp',
                    items: [
                      { type: 'Text', text: 'OUTPUTS', color: '#f08c00',
                        fontSize: '22dp', fontWeight: 'bold',
                        paddingLeft: '16dp', paddingBottom: '8dp' },
                      { type: 'Frame', backgroundColor: '#0f1e35', height: '2dp',
                        marginLeft: '16dp', marginRight: '16dp', marginBottom: '4dp' },
                      {
                        type: 'ScrollView', grow: 1,
                        item: {
                          type: 'Container', direction: 'column',
                          items: outputColItems,
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          }],
        },
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LOGGING MODE — full-screen fluid picker + amount grid
  // ═══════════════════════════════════════════════════════════════════════════

  const FLUID_EMOJI = {
    water: '💧', pediasure: '🍼', milk: '🥛', juice: '🧃',
    yogurt_drink: '🥣', vitamin_water: '💦',
    urine: '🚽', poop: '💩', vomit: '🤮',
  };

  // Big fluid tile for the log grid
  function fluidTile(f, selFluid, tileMode) {
    const c = FLUID_COLORS[f] || { dim: '#1a2a40', bright: '#4a9eff', accent: '#4a9eff' };
    const selected = selFluid === f;
    return {
      type: 'TouchWrapper', grow: 1, marginRight: '10dp', marginBottom: '10dp',
      onPress: { type: 'SendEvent', arguments: ['select', f, tileMode] },
      item: {
        type: 'Frame',
        backgroundColor: selected ? c.bright : c.dim,
        borderRadius: 16,
        borderWidth: selected ? '3dp' : '0dp',
        borderColor: c.accent,
        alignSelf: 'stretch', width: '100%',
        paddingTop: '18dp', paddingBottom: '18dp',
        item: {
          type: 'Container', direction: 'column',
          alignItems: 'center', justifyContent: 'center', width: '100%',
          items: [
            { type: 'Text', text: FLUID_EMOJI[f] || '', fontSize: '34dp',
              width: '100%', textAlign: 'center', textAlignVertical: 'center' },
            { type: 'Text', text: FLUID_LABELS[f] || f, color: 'white',
              fontSize: '19dp', fontWeight: 'bold',
              width: '100%', textAlign: 'center', textAlignVertical: 'center' },
          ],
        },
      },
    };
  }

  // Amount tile
  function amountTile(a, selFluid, tileMode) {
    return {
      type: 'TouchWrapper', grow: 1, marginRight: '10dp', marginBottom: '10dp',
      onPress: { type: 'SendEvent', arguments: ['log', selFluid, a, tileMode] },
      item: {
        type: 'Frame', backgroundColor: '#0f5028', borderRadius: 12,
        alignSelf: 'stretch', width: '100%',
        paddingTop: '14dp', paddingBottom: '10dp',
        item: {
          type: 'Container', direction: 'column',
          alignItems: 'center', justifyContent: 'center', width: '100%',
          items: [
            { type: 'Text', text: `${a}`, color: 'white', fontSize: '26dp', fontWeight: 'bold',
              width: '100%', textAlign: 'center', textAlignVertical: 'center' },
            { type: 'Text', text: 'ml', color: '#7adaaa', fontSize: '15dp',
              width: '100%', textAlign: 'center', textAlignVertical: 'center' },
          ],
        },
      },
    };
  }

  // Nav button
  function navBtn(label, args, active) {
    return {
      type: 'TouchWrapper', marginRight: '10dp',
      onPress: { type: 'SendEvent', arguments: args },
      item: {
        type: 'Frame',
        backgroundColor: active ? '#1a4a8a' : '#0a1a2a',
        borderRadius: 10, alignSelf: 'stretch', width: '100%',
        paddingTop: '12dp', paddingBottom: '12dp',
        paddingLeft: '22dp', paddingRight: '22dp',
        item: { type: 'Text', text: label, color: active ? 'white' : '#5a7aaa',
          fontSize: '18dp', fontWeight: 'bold',
          width: '100%', textAlign: 'center', textAlignVertical: 'center' },
      },
    };
  }

  const inputFluids  = ['water', 'pediasure', 'milk', 'juice', 'yogurt_drink', 'vitamin_water'];
  const outputFluids = ['urine', 'poop', 'vomit'];
  const fluids = mode === 'output' ? outputFluids : inputFluids;

  const inputAmounts  = [10, 20, 30, 45, 60, 90, 120, 150, 180, 200, 250, 300];
  const outputAmounts = [25, 50, 75, 100, 125, 150, 175, 200, 250, 300, 350, 400];
  const amounts = mode === 'output' ? outputAmounts : inputAmounts;

  // Split fluids into rows of 3
  const fluidRows = [];
  for (let i = 0; i < fluids.length; i += 3) {
    const rowFluids = fluids.slice(i, i + 3);
    // Pad to 3 with invisible spacers if needed
    while (rowFluids.length < 3) rowFluids.push(null);
    fluidRows.push(rowFluids);
  }

  const showAmounts = selectedFluid && selectedFluid !== 'gag';
  // Split amounts into rows of 6
  const amountRows = [];
  for (let i = 0; i < amounts.length; i += 6) {
    amountRows.push(amounts.slice(i, i + 6));
  }

  // Fluid grid rows
  const fluidGridRows = fluidRows.map((row) => ({
    type: 'Container', direction: 'row',
    paddingLeft: '20dp', paddingRight: '20dp',
    items: row.map((f) => f
      ? fluidTile(f, selectedFluid, mode)
      : { type: 'Frame', grow: 1, marginRight: '10dp', marginBottom: '10dp', backgroundColor: 'transparent' }
    ),
  }));

  // Amount grid rows
  const amountGridRows = showAmounts
    ? amountRows.map((row) => ({
        type: 'Container', direction: 'row',
        paddingLeft: '20dp', paddingRight: '20dp',
        items: row.map((a) => amountTile(a, selectedFluid, mode)),
      }))
    : [];

  // Gag button (input mode only)
  const gagRow = mode === 'input' ? [{
    type: 'Container', direction: 'row',
    paddingLeft: '20dp', paddingRight: '20dp',
    items: [{
      type: 'TouchWrapper', grow: 1,
      onPress: { type: 'SendEvent', arguments: ['gag'] },
      item: {
        type: 'Frame', backgroundColor: '#3a0a0a', borderRadius: 12,
        alignSelf: 'stretch', width: '100%',
        paddingTop: '14dp', paddingBottom: '14dp',
        item: { type: 'Text', text: '🤢  Gag Episode  ×1', color: '#ff8888',
          fontSize: '20dp', fontWeight: 'bold',
          width: '100%', textAlign: 'center', textAlignVertical: 'center' },
      },
    }],
  }] : [];

  // Section label
  const sectionLabel = selectedFluid
    ? { type: 'Text',
        text: `${FLUID_EMOJI[selectedFluid] || ''}  ${FLUID_LABELS[selectedFluid] || selectedFluid} — tap quick amount or enter custom below:`,
        color: FLUID_COLORS[selectedFluid]?.accent || '#4a9eff',
        fontSize: '20dp', fontWeight: 'bold',
        paddingLeft: '22dp', paddingBottom: '8dp', paddingTop: '4dp' }
    : { type: 'Text',
        text: mode === 'output' ? 'Select output type:' : 'Select fluid type:',
        color: '#5a7aaa', fontSize: '20dp',
        paddingLeft: '22dp', paddingBottom: '10dp', paddingTop: '4dp' };

  const hasCustomDigits = customDigits && customDigits.length > 0;
  const displayText  = hasCustomDigits ? `${customDigits} ml` : 'Enter amount';
  const displayColor = hasCustomDigits ? '#111111' : '#888888';

  // ── Compact amount tile (shares screen with keypad) ───────────────────────
  // Uses the official APL `spacing` property for horizontal gaps between tiles.
  // First tile in each row has no spacing (APL ignores spacing on first child).
  function compactAmountTile(a, selFluid, tileMode, isFirst) {
    return {
      type: 'TouchWrapper', grow: 1,
      ...(isFirst ? {} : { spacing: '8dp' }),
      onPress: { type: 'SendEvent', arguments: ['log', selFluid, a, tileMode] },
      item: {
        type: 'Frame', backgroundColor: '#0f5028', borderRadius: 10,
        alignSelf: 'stretch', width: '100%',
        paddingTop: '7dp', paddingBottom: '7dp',
        item: {
          type: 'Text', text: `${a} ml`, color: 'white',
          fontSize: '17dp', fontWeight: 'bold',
          width: '100%', textAlign: 'center', textAlignVertical: 'center',
        },
      },
    };
  }

  // ── Custom keypad ─────────────────────────────────────────────────────────
  // Official APL spacing technique (from APL Container docs):
  //   `spacing` on a Container child adds space between that child and the
  //   previous sibling on the parent's main axis. First child ignores it.
  //   This is the APL-native equivalent of CSS `gap`.
  //
  // Official Alexa spacing scale (alexa-styles): spacingXSmall = 16dp.
  // We use 16dp for both horizontal (between buttons) and vertical (between rows)
  // so all gaps are identical.
  //
  // Each row has grow:1 → 4 rows divide the column height equally.
  // Buttons use alignSelf:stretch → fill row height (no fixed padding needed).
  // Total layout: (column height − 3×16dp spacing) / 4 per row, buttons fill each row.

  // Gap constants — same value both axes for true equal spacing.
  // Rows are NOT grow:1 (natural height from paddingTop/Bottom on Frame),
  // so the vertical gap is a real equal fraction of button height.
  const KP_GAP = '10dp';

  // Official APL button pattern (per Frame docs + community examples):
  //   Frame docs: "Include height and width in your Frame definition."
  //   Community pattern: Frame(width:100%, paddingTop/Bottom) →
  //     Container(width:100%, justifyContent:center, alignItems:center) → Text
  //
  // paddingTop/paddingBottom define the button height explicitly.
  // width:'100%' on Frame resolves against the TouchWrapper's width,
  // which is well-defined from grow:1 in the row container.
  // Inner Container centers the label in both axes.
  function kBtn(label, digit, isFirst) {
    return {
      type: 'TouchWrapper', grow: 1,
      ...(isFirst ? {} : { spacing: KP_GAP }),
      onPress: { type: 'SendEvent', arguments: ['digit', digit, selectedFluid, mode] },
      item: {
        type: 'Frame', backgroundColor: 'white', borderRadius: 12,
        width: '100%', paddingTop: '8dp', paddingBottom: '8dp',
        item: {
          type: 'Text', text: label, color: '#111111',
          fontSize: '28dp', fontWeight: 'bold',
          width: '100%', textAlign: 'center', textAlignVertical: 'center',
        },
      },
    };
  }

  // Display box — fixed height, shows accumulated digits or placeholder
  const keypadDisplayBox = {
    type: 'Frame',
    backgroundColor: 'white', borderRadius: 10,
    borderWidth: '1dp', borderColor: hasCustomDigits ? '#2a7aff' : '#cccccc',
    paddingTop: '10dp', paddingBottom: '10dp',
    paddingLeft: '16dp', paddingRight: '16dp',
    item: {
      type: 'Container', direction: 'row', alignItems: 'center',
      items: [
        { type: 'Text', text: 'Custom:', color: '#888888',
          fontSize: '14dp', fontWeight: 'bold' },
        { type: 'Text', text: displayText, color: displayColor,
          fontSize: '28dp', fontWeight: 'bold', grow: 1, spacing: '12dp' },
      ],
    },
  };

  // 4 rows — natural height from Frame paddingTop/Bottom (no grow:1 on rows).
  // spacing:KP_GAP between rows = same as between buttons → equal gaps both axes.
  // All Frames use width:'100%' + paddingTop/Bottom (official APL pattern).
  const keypadRows = [
    {
      type: 'Container', direction: 'row',
      items: [ kBtn('1','1',true), kBtn('2','2',false), kBtn('3','3',false) ],
    },
    {
      type: 'Container', direction: 'row', spacing: KP_GAP,
      items: [ kBtn('4','4',true), kBtn('5','5',false), kBtn('6','6',false) ],
    },
    {
      type: 'Container', direction: 'row', spacing: KP_GAP,
      items: [ kBtn('7','7',true), kBtn('8','8',false), kBtn('9','9',false) ],
    },
    {
      type: 'Container', direction: 'row', spacing: KP_GAP,
      items: [
        // ⌫ backspace — first in row, no spacing
        {
          type: 'TouchWrapper', grow: 1,
          onPress: { type: 'SendEvent', arguments: ['backspace', selectedFluid, mode] },
          item: {
            type: 'Frame', backgroundColor: '#fff0ed', borderRadius: 12,
            borderWidth: '1dp', borderColor: '#ffccbc',
            width: '100%', paddingTop: '8dp', paddingBottom: '8dp',
            item: {
              type: 'Text', text: '⌫', color: '#cc3300',
              fontSize: '26dp', fontWeight: 'bold',
              width: '100%', textAlign: 'center', textAlignVertical: 'center',
            },
          },
        },
        // 0 — spacing:KP_GAP
        kBtn('0', '0', false),
        // ✓ Log — spacing:KP_GAP
        {
          type: 'TouchWrapper', grow: 1, spacing: KP_GAP,
          onPress: { type: 'SendEvent', arguments: ['custom_log', selectedFluid, mode] },
          item: {
            type: 'Frame',
            backgroundColor: hasCustomDigits ? '#1a7a40' : '#e8e8e8',
            borderRadius: 12,
            width: '100%', paddingTop: '8dp', paddingBottom: '8dp',
            item: {
              type: 'Text', text: '✓ Log',
              color: hasCustomDigits ? 'white' : '#aaaaaa',
              fontSize: '22dp', fontWeight: 'bold',
              width: '100%', textAlign: 'center', textAlignVertical: 'center',
            },
          },
        },
      ],
    },
  ];

  return {
    type: 'Alexa.Presentation.APL.RenderDocument',
    version: '1.0',
    token: 'tracker-ui',
    document: {
      type: 'APL',
      version: '1.5',
      theme: 'dark',
      settings: { idleTimeoutInMilliseconds: 2147483647 },
      mainTemplate: {
        parameters: [],
        items: [{
          type: 'Container', width: '100vw', height: '100vh',
          backgroundColor: '#080f1e', direction: 'column',
          items: [
            headerRow,
            divider,
            // ── Nav bar ──────────────────────────────────────────────────
            {
              type: 'Container', direction: 'row',
              paddingTop: '12dp', paddingBottom: '10dp', paddingLeft: '20dp',
              alignItems: 'center',
              items: [
                navBtn('← Status', ['mode', 'display'], false),
                navBtn('↑ Intake',  ['mode', 'input'],   mode === 'input'),
                navBtn('↓ Output',  ['mode', 'output'],  mode === 'output'),
              ],
            },
            { type: 'Frame', backgroundColor: '#0a1830', height: '2dp' },
            // ── Body: grow:1 fills all remaining vertical space ───────────
            // Two modes:
            //   !showAmounts → fluid picker (section label + fluid tiles)
            //    showAmounts → split layout: compact amounts top +
            //                  keypad (grow:1) fills the rest. No scroll.
            {
              type: 'Container', grow: 1, direction: 'column',
              items: showAmounts ? [
                // ── Fluid selected: compact section label ─────────────────
                {
                  type: 'Text',
                  text: `${FLUID_EMOJI[selectedFluid] || ''}  ${FLUID_LABELS[selectedFluid] || selectedFluid} — tap amount or enter custom:`,
                  color: FLUID_COLORS[selectedFluid]?.accent || '#4a9eff',
                  fontSize: '16dp', fontWeight: 'bold',
                  paddingLeft: '20dp', paddingTop: '4dp', paddingBottom: '4dp',
                },
                // ── Compact quick-amount rows ─────────────────────────────
                ...amountRows.map((row, ri) => ({
                  type: 'Container', direction: 'row',
                  paddingLeft: '20dp', paddingRight: '20dp',
                  ...(ri > 0 ? { spacing: '8dp' } : {}),
                  items: row.map((a, i) => compactAmountTile(a, selectedFluid, mode, i === 0)),
                })),
                // ── Compact gag button (input mode only) ─────────────────
                ...(mode === 'input' ? [{
                  type: 'Container', direction: 'row',
                  paddingLeft: '20dp', paddingRight: '20dp', marginTop: '5dp',
                  items: [{
                    type: 'TouchWrapper', grow: 1,
                    onPress: { type: 'SendEvent', arguments: ['gag'] },
                    item: {
                      type: 'Frame', backgroundColor: '#3a0a0a', borderRadius: 10,
                      alignSelf: 'stretch', width: '100%',
                      paddingTop: '7dp', paddingBottom: '7dp',
                      item: { type: 'Text', text: '🤢  Gag Episode  ×1', color: '#ff8888',
                        fontSize: '16dp', fontWeight: 'bold',
                        width: '100%', textAlign: 'center', textAlignVertical: 'center' },
                    },
                  }],
                }] : []),
                // ── Separator ─────────────────────────────────────────────
                { type: 'Frame', backgroundColor: '#c0ccd8', height: '1dp',
                  marginLeft: '20dp', marginRight: '20dp',
                  marginTop: '6dp', marginBottom: '0dp' },
                // ── Keypad section: grow:1 fills remaining space ──────────
                {
                  type: 'Container', grow: 1, direction: 'column',
                  paddingLeft: '20dp', paddingRight: '20dp',
                  paddingTop: '6dp', paddingBottom: '8dp',
                  items: [
                    // Display box — fixed height; rows container below uses
                    // spacing:KP_GAP to create gap between display and row 1.
                    keypadDisplayBox,
                    // Official APL spacing technique: `spacing` on each child
                    // adds a gap between siblings on the parent's main axis.
                    // grow:1 on each row → rows divide column height equally.
                    // Vertical gap (spacing on rows) = horizontal gap (spacing
                    // on buttons) = 16dp (Alexa spacingXSmall). Equal both axes.
                    // Rows at natural height (padding defines button height).
                    // spacing:KP_GAP = gap between display box and row 1.
                    {
                      type: 'Container', direction: 'column',
                      spacing: KP_GAP,
                      items: keypadRows,
                    },
                  ],
                },
              ] : [
                // ── No fluid selected: fluid picker ───────────────────────
                sectionLabel,
                ...fluidGridRows,
              ],
            },
          ],
        }],
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
  if (totalOut > 0) speech += ` Total out: ${totalOut} grams.`;
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

    const accountContext = await resolveAlexaAccountContext(req.body);
    if (!accountContext.ok) {
      const hasAlexaToken = Boolean(getAlexaAccessToken(req.body));
      if (ALEXA_ACCOUNT_LINKING_REQUIRED || hasAlexaToken) {
        console.warn('[alexa] Account linking required or invalid:', accountContext.reason);
        return res.json(alexaLinkAccountResponse());
      }
    }
    req.alexaAccountContext = accountContext.ok ? accountContext : null;
    const alexaScope = accountContext.ok ? { familyId: accountContext.familyId, patientId: accountContext.patientId } : {};

    // Helper: build fresh display APL with current DB state.
    // displayDayOffset is intentionally limited to 0 (today) or -1 (yesterday)
    // because the Echo Show footer is a simple today/yesterday toggle.
    async function freshDisplayApl(displayDayOffset = 0) {
      const offset = Number(displayDayOffset) === -1 ? -1 : 0;
      const dayKey = offset === -1 ? shiftDayKey(db.getDayKey(), -1) : db.getDayKey();
      const s   = await db.getDaySummary(dayKey, alexaScope);
      const lim = getDailyLimit();
      const oMl = s.outputs.reduce((acc, o) => acc + (o.amount_ml || 0), 0);
      // 7th param = raw outputs array (right panel), 8th = raw inputs array (fulllog mode)
      return buildAplDirective(s.totalIntake, lim, 'display', null, oMl, s.intakeByType, s.outputs, s.inputs, getViewportProfile(req), '', offset);
    }

    // Helper: build full log APL with current DB state
    async function freshFullLogApl() {
      const s   = await db.getDaySummary(db.getDayKey(), alexaScope);
      const lim = getDailyLimit();
      const oMl = s.outputs.reduce((acc, o) => acc + (o.amount_ml || 0), 0);
      return buildAplDirective(s.totalIntake, lim, 'fulllog', null, oMl, null, s.outputs, s.inputs);
    }

    // -- LaunchRequest: show fluid status display (mic closed — touch-first)
    if (request.type === 'LaunchRequest') {
      const summary = await db.getDaySummary(db.getDayKey(), alexaScope);
      const limit   = getDailyLimit();
      const outputMl  = summary.outputs.reduce((s, o) => s + (o.amount_ml || 0), 0);
      const dirs = supportsApl(req)
        ? [buildAplDirective(summary.totalIntake, limit, 'display', null, outputMl, summary.intakeByType, summary.outputs, summary.inputs, getViewportProfile(req), '', 0)]
        : [];
      const pn = db.getSetting('child_name');
      return res.json(alexaResponse(
        pn ? `${pn} fluid status.` : 'Wellness tracker ready.',
        null,   // omit shouldEndSession — display stays up, mic stays closed
        null,
        dirs
      ));
    }

    // -- APL UserEvent: touch interactions from the screen
    if (request.type === 'Alexa.Presentation.APL.UserEvent') {
      const args = request.arguments || [];
      const action = args[0];

      if (action === 'mode') {
        const newMode = args[1] || 'input';
        if (newMode === 'display') {
          const apl = await freshDisplayApl();
          return res.json(alexaResponse('', null, null,
            supportsApl(req) ? [apl] : []));
        }
        if (newMode === 'fulllog') {
          const apl = await freshFullLogApl();
          return res.json(alexaResponse('', null, null,
            supportsApl(req) ? [apl] : []));
        }
        const summary = await db.getDaySummary(db.getDayKey(), alexaScope);
        const limit   = getDailyLimit();
        const outputMl = summary.outputs.reduce((s, o) => s + (o.amount_ml || 0), 0);
        // Clear customDigits on mode switch
        const apl = buildAplDirective(summary.totalIntake, limit, newMode, null, outputMl, null, null, null, null, '');
        return res.json(alexaResponse('', null, null,
          supportsApl(req) ? [apl] : [],
          { customDigits: '' }
        ));
      }

      if (action === 'select') {
        const fluid = args[1];
        const mode  = args[2] || 'input';
        const summary  = await db.getDaySummary(db.getDayKey(), alexaScope);
        const limit    = getDailyLimit();
        const outputMl = summary.outputs.reduce((s, o) => s + (o.amount_ml || 0), 0);
        // Clear customDigits on new fluid selection
        const apl = buildAplDirective(summary.totalIntake, limit, mode, fluid, outputMl, null, null, null, null, '');
        // Mic stays closed — amount is selected via touch buttons
        return res.json(alexaResponse('', null, null,
          supportsApl(req) ? [apl] : [],
          { pendingFluid: fluid, pendingMode: mode, customDigits: '' }
        ));
      }

      // ── Custom keypad: digit pressed ──────────────────────────────────────
      if (action === 'digit') {
        const digit       = String(args[1] || '');
        const fluid       = args[2];
        const mode        = args[3] || 'input';
        const sessionAttrs = req.body?.session?.attributes || {};
        const current     = sessionAttrs.customDigits || '';
        // Max 4 digits (9999 ml is a reasonable upper bound)
        const newDigits   = current.length < 4 ? current + digit : current;
        const summary  = await db.getDaySummary(db.getDayKey(), alexaScope);
        const limit    = getDailyLimit();
        const outputMl = summary.outputs.reduce((s, o) => s + (o.amount_ml || 0), 0);
        const apl = buildAplDirective(summary.totalIntake, limit, mode, fluid, outputMl, null, null, null, null, newDigits);
        return res.json(alexaResponse('', null, null,
          supportsApl(req) ? [apl] : [],
          { pendingFluid: fluid, pendingMode: mode, customDigits: newDigits }
        ));
      }

      // ── Custom keypad: backspace ───────────────────────────────────────────
      if (action === 'backspace') {
        const fluid       = args[1];
        const mode        = args[2] || 'input';
        const sessionAttrs = req.body?.session?.attributes || {};
        const current     = sessionAttrs.customDigits || '';
        const newDigits   = current.slice(0, -1);
        const summary  = await db.getDaySummary(db.getDayKey(), alexaScope);
        const limit    = getDailyLimit();
        const outputMl = summary.outputs.reduce((s, o) => s + (o.amount_ml || 0), 0);
        const apl = buildAplDirective(summary.totalIntake, limit, mode, fluid, outputMl, null, null, null, null, newDigits);
        return res.json(alexaResponse('', null, null,
          supportsApl(req) ? [apl] : [],
          { pendingFluid: fluid, pendingMode: mode, customDigits: newDigits }
        ));
      }

      // ── Custom keypad: log custom amount ──────────────────────────────────
      if (action === 'custom_log') {
        const fluid       = args[1];
        const mode        = args[2] || 'input';
        const sessionAttrs = req.body?.session?.attributes || {};
        const digits      = sessionAttrs.customDigits || '';
        const amount      = parseInt(digits, 10);

        if (!fluid || fluid === 'null' || fluid === 'undefined') {
          const summary  = await db.getDaySummary(db.getDayKey(), alexaScope);
          const limit    = getDailyLimit();
          const outputMl = summary.outputs.reduce((s, o) => s + (o.amount_ml || 0), 0);
          const apl = buildAplDirective(summary.totalIntake, limit, mode, null, outputMl, null, null, null, null, '');
          return res.json(alexaResponse('Please select a fluid type first.',
            null, null, supportsApl(req) ? [apl] : [],
            { customDigits: '' }
          ));
        }

        if (!amount || amount <= 0 || amount > 9999) {
          const summary  = await db.getDaySummary(db.getDayKey(), alexaScope);
          const limit    = getDailyLimit();
          const outputMl = summary.outputs.reduce((s, o) => s + (o.amount_ml || 0), 0);
          const apl = buildAplDirective(summary.totalIntake, limit, mode, fluid, outputMl, null, null, null, null, digits);
          return res.json(alexaResponse('Enter a valid amount using the keypad.',
            null, null, supportsApl(req) ? [apl] : [],
            { pendingFluid: fluid, pendingMode: mode, customDigits: digits }
          ));
        }

        await db.logEntry({
          timestamp: Date.now(), day_key: db.getDayKey(),
          entry_type: mode === 'output' ? 'output' : 'input',
          fluid_type: fluid, amount_ml: amount, source: 'alexa',
          ...alexaScope,
        });

        const apl    = await freshDisplayApl();
        const s2     = await db.getDaySummary(db.getDayKey(), alexaScope);
        const speech = buildAlexaSpeech(s2);
        return res.json(alexaResponse(speech, null, null,
          supportsApl(req) ? [apl] : []));
      }

      if (action === 'day') {
        const offset = Number(args[1]) === -1 ? -1 : 0;
        const apl = await freshDisplayApl(offset);
        return res.json(alexaResponse('', null, null,
          supportsApl(req) ? [apl] : [],
          { displayDayOffset: offset }
        ));
      }

      if (action === 'gag') {
        await db.logGag(1, Date.now(), null, alexaScope);
        const apl = await freshDisplayApl();
        return res.json(alexaResponse('Gag logged.', null, null,
          supportsApl(req) ? [apl] : []));
      }

      if (action === 'log') {
        const fluid  = args[1];
        const amount = Number(args[2]);
        const mode   = args[3] || 'input';

        if (!fluid || fluid === 'null' || fluid === 'undefined') {
          const summary  = await db.getDaySummary(db.getDayKey(), alexaScope);
          const limit    = getDailyLimit();
          const outputMl = summary.outputs.reduce((s, o) => s + (o.amount_ml || 0), 0);
          const apl = buildAplDirective(summary.totalIntake, limit, mode, null, outputMl);
          return res.json(alexaResponse('Please select a fluid type first.',
            null, null, supportsApl(req) ? [apl] : []));
        }

        await db.logEntry({
          timestamp: Date.now(), day_key: db.getDayKey(),
          entry_type: mode === 'output' ? 'output' : 'input',
          fluid_type: fluid, amount_ml: amount, source: 'alexa',
          ...alexaScope,
        });

        // Return to display after logging so totals are visible immediately
        const apl    = await freshDisplayApl();
        const s2     = await db.getDaySummary(db.getDayKey(), alexaScope);
        const speech = buildAlexaSpeech(s2);
        return res.json(alexaResponse(speech, null, null,
          supportsApl(req) ? [apl] : []));
      }

      // Quit button tapped — end the session gracefully
      if (action === 'quit') {
        return res.json(alexaResponse('Goodbye.', true));
      }

      // Voice log button tapped — open the mic for a spoken log entry
      if (action === 'voice') {
        return res.json(alexaResponse(
          'Say log, then your entry. For example: log 120 pediasure, or log pee 80.',
          false,  // shouldEndSession: false — this opens the microphone
          'Say log, then your entry.',
          []
        ));
      }

      if (action === 'refresh') {
        // Auto-refresh from onMount animation loop (or manual), preserving
        // the current today/yesterday display selection.
        const sessionAttrs = req.body?.session?.attributes || {};
        const offsetArg = args.length > 2 ? args[2] : sessionAttrs.displayDayOffset;
        const offset = Number(offsetArg) === -1 ? -1 : 0;
        const apl = await freshDisplayApl(offset);
        return res.json(alexaResponse('', null, null,
          supportsApl(req) ? [apl] : [],
          { ...sessionAttrs, displayDayOffset: offset }
        ));
      }

      // Unknown UserEvent — refresh display
      {
        const apl = await freshDisplayApl();
        return res.json(alexaResponse('', null, null,
          supportsApl(req) ? [apl] : []));
      }
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
    if (intentName === 'VersionIntent') {
      return res.json(alexaResponse(
        `Glide Patient Tracker is running version ${ALEXA_SKILL_VERSION}.`
      ));
    }

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

      // If a fluid was pre-selected via touch, check if this utterance is just a number (amount response)
      const sessionAttrs = req.body?.session?.attributes || {};
      const pendingFluid = sessionAttrs.pendingFluid;
      const pendingMode  = sessionAttrs.pendingMode || 'input';
      if (pendingFluid) {
        const numMatch = entryText.match(/^(\d+(?:\.\d+)?)(?:\s*(?:ml|milliliters?))?$/i);
        if (numMatch) {
          const amount = Math.round(parseFloat(numMatch[1]));
          const entryType = pendingMode === 'output' ? 'output' : 'input';
          await db.logEntry({
            timestamp: Date.now(),
            day_key: db.getDayKey(),
            entry_type: entryType,
            fluid_type: pendingFluid,
            amount_ml: amount,
            source: 'alexa',
            ...alexaScope,
          });
          const summary = await db.getDaySummary(db.getDayKey(), alexaScope);
          const outputMl = summary.outputs.reduce((s, o) => s + (o.amount_ml || 0), 0);
          const dirs = supportsApl(req)
            ? [buildAplDirective(summary.totalIntake, getDailyLimit(), pendingMode, null, outputMl)]
            : [];
          // Clear pending fluid from session attributes; return to display, mic closed
          const dispApl = supportsApl(req) ? [await freshDisplayApl()] : [];
          return res.json(alexaResponse(buildAlexaSpeech(summary), null, null, dispApl, {}));
        }
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
          false,                          // keep mic open to retry
          'What would you like to log?'
        ));
      }

      // Reject if any input/output is missing an amount
      const missingAmount = parsed.actions.find((a) => {
        if (a.type === 'input') return !a.amount_ml;
        if (a.type === 'output') return !a.amount_ml;  // poop included — amount always required
        return false;
      });
      if (missingAmount) {
        const label = formatFluidType(missingAmount.fluid_type);
        return res.json(alexaResponse(
          `I need a measurement for ${label}. How many milliliters was it?`,
          false,                          // keep mic open for amount follow-up
          `How many milliliters of ${label}?`
        ));
      }

      // Persist all actions
      const dateOffset = parsed.date_offset || 0;
      const now = Date.now() + (dateOffset * 86400000);
      const dayKey = db.getDayKey(new Date(now));
      let weightLogged = null;
      for (const action of parsed.actions) {
        if (action.type === 'input' || action.type === 'output') {
          await db.logEntry({
            timestamp: now,
            day_key: dayKey,
            entry_type: action.type,
            fluid_type: action.fluid_type,
            amount_ml: action.amount_ml,
            subtype: action.subtype ?? null,
            source: 'alexa',
            ...alexaScope,
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
            source: 'alexa',
            ...alexaScope,
          });
        } else if (action.type === 'gag') {
          await db.logGag(action.count, now, dayKey, alexaScope);
        } else if (action.type === 'weight') {
          await db.logWeight(dayKey, action.weight_kg, null, alexaScope);
          weightLogged = action.weight_kg;
        }
      }

      // If weight was the only/primary action, return a weight-specific response
      if (weightLogged !== null && parsed.actions.every((a) => a.type === 'weight')) {
        return res.json(alexaResponse(`Weight logged. ${weightLogged} kilograms.`));
      }

      const summary  = await db.getDaySummary(dayKey, alexaScope);
      const aplDirs  = supportsApl(req) ? [await freshDisplayApl()] : [];
      // Logged successfully — return to display, mic closed
      return res.json(alexaResponse(buildAlexaSpeech(summary), null, null, aplDirs));
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

// ---------------------------------------------------------------------------
// Display kiosk — token-authenticated, no login required
// ---------------------------------------------------------------------------

app.get('/display', (req, res) => {
  const displayToken = process.env.DISPLAY_TOKEN;
  if (!displayToken || req.query.token !== displayToken) {
    return res.status(401).send('Unauthorized');
  }
  res.sendFile(path.join(__dirname, 'public', 'display.html'));
});

app.get('/api/display-data', async (req, res) => {
  const displayToken = process.env.DISPLAY_TOKEN;
  if (!displayToken || req.query.token !== displayToken) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const summary = await db.getDaySummary(db.getDayKey());
  const limit = getDailyLimit();

  // Output breakdown by type (ml + count for poop)
  const outputByType = {};
  for (const l of summary.outputs) {
    if (!outputByType[l.fluid_type]) outputByType[l.fluid_type] = { ml: 0, count: 0 };
    outputByType[l.fluid_type].ml    += (l.amount_ml || 0);
    outputByType[l.fluid_type].count += 1;
  }
  // Format display string per type
  for (const [type, data] of Object.entries(outputByType)) {
    data.display = type === 'poop' ? `${data.count}×` : `${data.ml} ml`;
  }

  return res.json({
    totalIntake:  summary.totalIntake,
    dailyLimit:   limit,
    intakeByType: summary.intakeByType,
    outputByType,
    patientName:  db.getSetting('child_name') || null,
  });
});

// Auth gate — everything below this line requires a valid session or API key
function requireAuth(req, res, next) {
  // API key auth (programmatic access — Mr. Stellar)
  if (API_KEY && req.headers['x-api-key'] === API_KEY) return next();

  // Clerk auth (production browser/reviewer access)
  if (CLERK_AUTH_ENABLED) {
    if (!CLERK_CONFIGURED) {
      if (req.path.startsWith('/api/')) {
        return res.status(503).json({ ok: false, error: 'clerk_not_configured' });
      }
      return res.redirect('/login');
    }
    try {
      const auth = getAuth(req);
      if (auth?.isAuthenticated && auth?.userId) {
        req.clerkAuth = auth;
        return next();
      }
    } catch (err) {
      console.error('[auth] Clerk auth check failed:', err.message);
    }
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    return res.redirect('/login');
  }

  // Session auth (browser access)
  if (req.session && req.session.authenticated) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  res.redirect('/login');
}
app.use(requireAuth);

// ---------------------------------------------------------------------------
// Database backup endpoint (API key only — for automated backups)
// ---------------------------------------------------------------------------
app.get('/api/backup', async (req, res) => {
  // Restrict to API key auth only (not browser sessions)
  if (!API_KEY || req.headers['x-api-key'] !== API_KEY) {
    return res.status(403).json({ ok: false, error: 'API key required for backup' });
  }
  try {
    const datestamp = new Date().toISOString().slice(0, 10);
    const data = await db.exportAllData();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=elina-postgres-backup-${datestamp}.json`);
    res.send(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[GET /api/backup]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Static files (served after auth check)
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/**
 * Shift a fluid-day key string "YYYY-MM-DD" by N calendar days.
 */
function shiftDayKey(dayKey, deltaDays) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  shifted.setUTCDate(shifted.getUTCDate() + deltaDays);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Resolve a day key from either an explicit date or a relative selector.
 * Supports relative=today|yesterday for the dashboard day switcher.
 */
function resolveRequestedDayKey({ date, relative } = {}) {
  if (relative) {
    if (relative === 'today') {
      return { ok: true, date: db.getDayKey() };
    }
    if (relative === 'yesterday') {
      return { ok: true, date: shiftDayKey(db.getDayKey(), -1) };
    }
    return { ok: false, error: 'Invalid relative date. Use today or yesterday.' };
  }

  return validateLogDate(date);
}

/**
 * Validates an optional date field from a request body.
 * Accepts any past or present date (no future dates).
 * Returns { ok: true, date } or { ok: false, error }.
 */
function validateLogDate(bodyDate) {
  const todayKey = db.getDayKey();
  if (!bodyDate) return { ok: true, date: todayKey };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(bodyDate)) {
    return { ok: false, error: 'Invalid date format. Use YYYY-MM-DD.' };
  }
  if (bodyDate > todayKey) {
    return { ok: false, error: 'Cannot log entries for future dates.' };
  }
  return { ok: true, date: bodyDate };
}

function validateLogTime(bodyTime) {
  if (!bodyTime) return { ok: true, time: null };
  if (!/^\d{2}:\d{2}$/.test(bodyTime)) {
    return { ok: false, error: 'Invalid time format. Use HH:MM.' };
  }
  const [hour, minute] = bodyTime.split(':').map(Number);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return { ok: false, error: 'Invalid time value.' };
  }
  return { ok: true, time: bodyTime };
}

function zonedDateTimeToTimestamp(dateKey, timeValue, tz) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const [hour, minute] = timeValue.split(':').map(Number);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  let guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const target = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  for (let i = 0; i < 4; i += 1) {
    const parts = formatter.formatToParts(new Date(guess));
    const part = (type) => parts.find((p) => p.type === type)?.value;
    const localAsUtc = Date.UTC(
      Number(part('year')),
      Number(part('month')) - 1,
      Number(part('day')),
      Number(part('hour')),
      Number(part('minute')),
      0,
      0
    );
    const diff = target - localAsUtc;
    guess += diff;
    if (diff === 0) break;
  }

  return guess;
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

function formatPoopSubtype(subtype) {
  const map = {
    normal: 'Normal',
    diarrhea: 'Diarrhea',
    undigested: 'Undigested',
  };
  return map[subtype] || null;
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

function formatTimeInput(tsMs) {
  return new Date(tsMs).toLocaleTimeString('en-GB', {
    timeZone: getTimezone(),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

// ---------------------------------------------------------------------------
// API Routes
// ---------------------------------------------------------------------------

/**
 * GET /api/today and /api/day
 * Returns all data for the requested fluid day.
 */
app.get(['/api/today', '/api/day'], async (req, res) => {
  try {
    const dayResult = resolveRequestedDayKey({
      date: req.query.date,
      relative: req.query.relative,
    });
    if (!dayResult.ok) {
      return res.status(400).json({ ok: false, error: dayResult.error });
    }

    const dayKey = dayResult.date;
    const summary = await db.getDaySummary(dayKey);
    res.json({
      ok: true,
      dayKey,
      todayDayKey: db.getDayKey(),
      limit_ml: getDailyLimit(),
      totalIntake: summary.totalIntake,
      percent: Math.round((summary.totalIntake / getDailyLimit()) * 100),
      intakeByType: summary.intakeByType,
      inputs: summary.inputs.map((l) => ({
        ...l,
        time: formatTimestamp(l.timestamp),
        time24: formatTimeInput(l.timestamp),
        fluid_type_label: formatFluidType(l.fluid_type),
      })),
      outputs: summary.outputs.map((l) => ({
        ...l,
        time: formatTimestamp(l.timestamp),
        time24: formatTimeInput(l.timestamp),
        fluid_type_label: formatFluidType(l.fluid_type),
      })),
      wellness: summary.wellness,
      gags: summary.gags.map((g) => ({
        ...g,
        time: formatTimestamp(g.timestamp),
        time24: formatTimeInput(g.timestamp),
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
app.get('/api/report', async (req, res) => {
  try {
    const dayKey = db.getDayKey();
    const text = await buildReport(dayKey);
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
app.post('/api/log', async (req, res) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ ok: false, error: 'Invalid request body' });
    }

    // Validate optional date/time fields
    const dateResult = validateLogDate(body.date);
    if (!dateResult.ok) {
      return res.status(400).json({ ok: false, error: dateResult.error });
    }
    const timeResult = validateLogTime(body.time);
    if (!timeResult.ok) {
      return res.status(400).json({ ok: false, error: timeResult.error });
    }
    const dayKey = dateResult.date;
    const tz = getTimezone();
    const overrideTimestamp = timeResult.time
      ? zonedDateTimeToTimestamp(dayKey, timeResult.time, tz)
      : null;

    const results = [];

    // Require amount_ml for all fluid inputs and outputs (poop is optional — no measurable amount)
    if (body.type !== 'wellness' && body.type !== 'gag') {
      const isPoop = body.fluid_type === 'poop';
      if (!isPoop && (!body.amount_ml || typeof body.amount_ml !== 'number' || body.amount_ml <= 0)) {
        return res.status(400).json({ ok: false, error: 'amount_ml is required for input and output entries' });
      }
    }

    if (body.type === 'wellness') {
      const w = await db.upsertWellness({
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
      const gags = await db.logGag(count, overrideTimestamp || Date.now(), dayKey);
      results.push({ kind: 'gag', count, data: gags });
    } else {
      // Fluid input or output
      const entry = await db.logEntry({
        timestamp: overrideTimestamp || Date.now(),
        day_key: dayKey,
        entry_type: body.entry_type,
        fluid_type: body.fluid_type,
        amount_ml: body.amount_ml ?? null,
        subtype: body.subtype ?? null,
        notes: body.notes ?? null,
        source: 'api',
      });
      results.push({ kind: 'fluid', data: entry });
    }

    const summary = await db.getDaySummary(db.getDayKey());
    res.json({ ok: true, results, totalIntake: summary.totalIntake });
  } catch (err) {
    console.error('[POST /api/log]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * PATCH /api/log/:id
 * Update a specific fluid input/output entry.
 */
app.patch('/api/log/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) {
      return res.status(400).json({ ok: false, error: 'Invalid ID' });
    }

    const existing = await db.getLogById(id);
    if (!existing) {
      return res.status(404).json({ ok: false, error: 'Entry not found' });
    }

    const body = req.body || {};
    const entryType = body.entry_type || existing.entry_type;
    const fluidType = body.fluid_type || existing.fluid_type;
    const dateResult = validateLogDate(body.date || existing.day_key);
    if (!dateResult.ok) {
      return res.status(400).json({ ok: false, error: dateResult.error });
    }
    const timeResult = validateLogTime(body.time || formatTimeInput(existing.timestamp));
    if (!timeResult.ok) {
      return res.status(400).json({ ok: false, error: timeResult.error });
    }

    const isPoop = fluidType === 'poop';
    const hasAmount = Object.prototype.hasOwnProperty.call(body, 'amount_ml');
    const amountMl = hasAmount ? body.amount_ml : existing.amount_ml;
    if (!isPoop && (typeof amountMl !== 'number' || amountMl <= 0)) {
      return res.status(400).json({ ok: false, error: 'amount_ml is required for input and output entries' });
    }

    const timestamp = zonedDateTimeToTimestamp(dateResult.date, timeResult.time, getTimezone());

    await db.updateLog({
      id,
      timestamp,
      day_key: dateResult.date,
      entry_type: entryType,
      fluid_type: fluidType,
      amount_ml: isPoop ? (amountMl ?? null) : amountMl,
      subtype: body.subtype ?? existing.subtype ?? null,
      notes: body.notes ?? existing.notes ?? null,
    });

    const updated = await db.getLogById(id);
    res.json({
      ok: true,
      entry: {
        ...updated,
        time: formatTimestamp(updated.timestamp),
        time24: formatTimeInput(updated.timestamp),
        fluid_type_label: formatFluidType(updated.fluid_type),
      },
    });
  } catch (err) {
    console.error('[PATCH /api/log/:id]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * PATCH /api/gag/:id
 * Update a specific gag event time/day.
 */
app.patch('/api/gag/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) {
      return res.status(400).json({ ok: false, error: 'Invalid ID' });
    }

    const existing = await db.getGagById(id);
    if (!existing) {
      return res.status(404).json({ ok: false, error: 'Gag entry not found' });
    }

    const body = req.body || {};
    const dateResult = validateLogDate(body.date || existing.day_key);
    if (!dateResult.ok) {
      return res.status(400).json({ ok: false, error: dateResult.error });
    }
    const timeResult = validateLogTime(body.time || formatTimeInput(existing.timestamp));
    if (!timeResult.ok) {
      return res.status(400).json({ ok: false, error: timeResult.error });
    }

    const timestamp = zonedDateTimeToTimestamp(dateResult.date, timeResult.time, getTimezone());
    await db.updateGag({ id, timestamp, day_key: dateResult.date });

    const updated = await db.getGagById(id);
    res.json({ ok: true, entry: { ...updated, time: formatTimestamp(updated.timestamp), time24: formatTimeInput(updated.timestamp) } });
  } catch (err) {
    console.error('[PATCH /api/gag/:id]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/history?days=7
 * Returns a richer per-day summary for the last N fluid days.
 */
app.get('/api/history', async (req, res) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));
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

    const dayData = await Promise.all(uniqueKeys.map(async (dayKey) => {
      const summary = await db.getDaySummary(dayKey);

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
        subtype: o.subtype ?? null,
        amount_ml: o.amount_ml,
        time: formatTimestamp(o.timestamp),
        time24: formatTimeInput(o.timestamp),
      }));
      const inputs = summary.inputs.map((l) => ({
        id: l.id,
        time: formatTimestamp(l.timestamp),
        time24: formatTimeInput(l.timestamp),
        fluid_type: l.fluid_type,
        fluid_type_label: formatFluidType(l.fluid_type),
        amount_ml: l.amount_ml,
      }));
      const gags = summary.gags.map((g) => ({
        id: g.id,
        time: formatTimestamp(g.timestamp),
        time24: formatTimeInput(g.timestamp),
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
    }));

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
app.delete('/api/gag/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) {
      return res.status(400).json({ ok: false, error: 'Invalid ID' });
    }
    const result = await db.deleteGag(id);
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
app.delete('/api/log/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) {
      return res.status(400).json({ ok: false, error: 'Invalid ID' });
    }
    const result = await db.deleteLog(id);
    if (result.changes === 0) {
      return res.status(404).json({ ok: false, error: 'Entry not found' });
    }
    res.json({ ok: true, deleted: id });
  } catch (err) {
    console.error('[DELETE /api/log/:id]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * DELETE /api/wellness?date=YYYY-MM-DD&check_time=5pm|10pm
 * Remove a specific wellness entry for the day/period.
 */
app.delete('/api/wellness', async (req, res) => {
  try {
    const dateResult = validateLogDate(req.query.date);
    if (!dateResult.ok) {
      return res.status(400).json({ ok: false, error: dateResult.error });
    }

    const checkTime = req.query.check_time;
    if (!['5pm', '10pm'].includes(checkTime)) {
      return res.status(400).json({ ok: false, error: 'Invalid check_time. Use 5pm or 10pm.' });
    }

    const result = await db.deleteWellness(dateResult.date, checkTime);
    if (result.changes === 0) {
      return res.status(404).json({ ok: false, error: 'Wellness entry not found' });
    }

    res.json({ ok: true, deleted: { date: dateResult.date, check_time: checkTime } });
  } catch (err) {
    console.error('[DELETE /api/wellness]', err);
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
app.post('/api/weight', async (req, res) => {
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

    const existing = await db.getWeightForDate(date);
    await db.logWeight(date, weight_kg, notes ?? null);
    res.json({ ok: true, weight_kg, date, replaced: !!existing });
  } catch (err) {
    console.error('[POST /api/weight]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/weight/today
 * Returns the requested day's weight entry or { ok, weight: null }.
 */
app.get('/api/weight/today', async (req, res) => {
  try {
    const dayResult = resolveRequestedDayKey({
      date: req.query.date,
      relative: req.query.relative,
    });
    if (!dayResult.ok) {
      return res.status(400).json({ ok: false, error: dayResult.error });
    }

    const date = dayResult.date;
    const entry = await db.getWeightForDate(date);
    res.json({ ok: true, date, weight: entry || null });
  } catch (err) {
    console.error('[GET /api/weight/today]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/weight/history?days=7
 * Returns last N weight entries ordered by date desc.
 */
app.get('/api/weight/history', async (req, res) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));
    let entries;

    if (req.query.throughDate) {
      const dateResult = validateLogDate(req.query.throughDate);
      if (!dateResult.ok) {
        return res.status(400).json({ ok: false, error: dateResult.error });
      }
      entries = await db.getWeightHistoryUpTo(dateResult.date, days);
    } else {
      entries = await db.getWeightHistory(days);
    }

    res.json({ ok: true, entries });
  } catch (err) {
    console.error('[GET /api/weight/history]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * DELETE /api/weight/:date
 * Remove a specific day weight entry.
 */
app.delete('/api/weight/:date', async (req, res) => {
  try {
    const dateResult = validateLogDate(req.params.date);
    if (!dateResult.ok) {
      return res.status(400).json({ ok: false, error: dateResult.error });
    }

    const result = await db.deleteWeight(dateResult.date);
    if (result.changes === 0) {
      return res.status(404).json({ ok: false, error: 'Weight entry not found' });
    }

    res.json({ ok: true, deleted: dateResult.date });
  } catch (err) {
    console.error('[DELETE /api/weight/:date]', err);
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
      if (action.fluid_type === 'poop' && action.subtype) {
        const subtypeLabel = formatPoopSubtype(action.subtype) || action.subtype;
        parts.push(`${label} (${subtypeLabel.toLowerCase()})${amount} (output)`);
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
    const missingAmount = parsed.actions.find((a) => {
      if (a.type === 'input') return !a.amount_ml;
      if (a.type === 'output') return !a.amount_ml;  // poop included — amount always required
      return false;
    });
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
        const entry = await db.logEntry({
          timestamp: now,
          day_key: dayKey,
          entry_type: action.type,
          fluid_type: action.fluid_type,
          amount_ml: action.amount_ml,
          subtype: action.subtype ?? null,
          source: 'chat',
        });
        entries.push({ kind: action.type, ...action, id: entry?.id });
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
        entries.push({ kind: 'wellness', ...action });
      } else if (action.type === 'gag') {
        await db.logGag(action.count, now);
        entries.push({ kind: 'gag', count: action.count });
      }
    }

    const summary = await db.getDaySummary(dayKey);
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
app.get('/api/settings', async (req, res) => {
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
app.post('/api/settings', async (req, res) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ ok: false, error: 'Invalid request body' });
    }
    for (const [key, value] of Object.entries(body)) {
      if (value !== undefined && value !== null) {
        await db.setSetting(key, value);
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

async function buildReport(dayKey) {
  const summary = await db.getDaySummary(dayKey);
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

db.ready.then(() => {
  app.listen(PORT, () => {
    console.log(`[server] Glide Patient Tracker running on port ${PORT}`);
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
    require('./scheduler').start();
  } catch (err) {
    console.warn('[server] Scheduler failed to start:', err.message);
  }
}).catch((err) => {
  console.error('[server] Database initialization failed:', err);
  process.exit(1);
});
