# Glide Bedside Native App Readiness API Contract

Status: Milestone 1 inventory and target contract

Last updated: 2026-05-17

## Goal

Glide Bedside should be able to support native iOS and Android clients without
forking care logic into each client. The web dashboard, Alexa surface, Telegram
bot, and future native apps should all rely on one backend contract for care
state, rules, permissions, and reporting.

The target architecture is:

- Backend owns care-domain rules, persistence, auth, family/patient scope, and
  derived summaries.
- Clients own interaction state, local form state, device capabilities, and
  rendering.
- API responses are stable enough for independently released clients.
- New feature work moves toward service-backed API contracts instead of adding
  more route-local behavior to server.js.

## Current State

Glide Bedside already has useful separation:

- Express/Postgres backend with authenticated JSON routes.
- Clerk-backed web auth and API-key access for trusted programmatic use.
- Server-side family/patient scope resolution.
- Browser dashboard, history, settings, chat, kiosk, Telegram, and Alexa
  surfaces that all rely on backend state.
- Server-Sent Events for care-log refresh.

The main gap is not whether a backend exists. It does. The gap is that route
handling, validation, domain rules, Alexa presentation, formatting, and API
serialization still live together in server.js. For native app readiness, those
rules should move into explicit service modules and a documented client
contract.

## Current Route Inventory

### Public and App Shell

| Method | Route | Current use | Native relevance |
|---|---|---|---|
| GET | /health | Railway/container health check | Operational only |
| GET | /api/version | Deploy/version verification and update prompts | Useful for client compatibility checks |
| GET | /apple-touch-icon.png | PWA asset | Web/PWA only |
| GET | /manifest.json | PWA manifest | Web/PWA only |
| GET | /login | Web login page | Web only |
| POST | /login | Shared-password fallback login | Legacy/web only |
| GET | /logout | Web logout | Web only |
| GET | /onboarding | Clerk web onboarding page | Web only |
| GET | /settings | Settings HTML page | Web only |
| GET | /history | Trends/history HTML page | Web only |
| GET | /chat | Chat HTML page | Web only |
| GET | * | Dashboard fallback HTML | Web only |

### Auth, Account, and Family Scope

| Method | Route | Current use | Native contract posture |
|---|---|---|---|
| GET | /api/auth/status | Browser discovers Clerk/shared-password mode and publishable key | Replace or complement with native auth config endpoint |
| GET | /api/me | Returns resolved authenticated scope | Keep, but formalize response |
| POST | /api/onboarding | Creates family/patient for authenticated Clerk user | Keep concept, likely versioned |
| GET | /api/account/preferences | Account-scoped UI preferences | Keep for user preferences |
| POST | /api/account/preferences | Saves account preferences | Keep for user preferences |
| GET | /api/family/members | Settings page access list | Keep, with role-aware contract |
| POST | /api/family/invitations | Invite caregiver by email/role | Keep, admin/owner only |
| GET | /api/clerk-spike/status | Clerk spike diagnostics | Internal/dev only |
| GET | /api/clerk-spike/session | Clerk spike diagnostics | Internal/dev only |

### Care Data

| Method | Route | Current use | Native contract posture |
|---|---|---|---|
| GET | /api/today | Day dashboard alias | Keep compatibility, prefer /api/day |
| GET | /api/day?date=YYYY-MM-DD | Day dashboard data | Core native endpoint |
| GET | /api/report | Nurse handoff report for current fluid day | Core native endpoint, should accept date eventually |
| POST | /api/log | Create fluid, wellness, or gag entry | Core native endpoint, should be split or schema-discriminated |
| PATCH | /api/log/:id | Edit fluid input/output entry | Core native endpoint |
| PATCH | /api/gag/:id | Edit gag timestamp/day | Core native endpoint |
| DELETE | /api/log/:id | Delete fluid input/output entry | Core native endpoint |
| DELETE | /api/gag/:id | Delete gag event | Core native endpoint |
| DELETE | /api/wellness?date=&check_time= | Delete wellness entry | Core native endpoint, should move to path/body contract |
| POST | /api/weight | Create/replace daily weight | Core native endpoint |
| GET | /api/weight/today?date= | Requested day weight | Core native endpoint, should be renamed |
| GET | /api/weight/history?days=&throughDate= | Weight history | Core native endpoint |
| DELETE | /api/weight/:date | Delete daily weight | Core native endpoint |
| GET | /api/history?days= | Trends/history summaries | Core native endpoint |
| GET | /api/events | SSE refresh for care-log changes | Keep for web; native may use polling or push later |

### Natural Language, Voice, Alexa, Kiosk, and Backup

| Method | Route | Current use | Native contract posture |
|---|---|---|---|
| POST | /api/chat | Parse/log natural language text | Useful native feature endpoint |
| POST | /api/transcribe | Whisper transcription for recorded audio | Useful native feature endpoint, but native may use platform speech |
| POST | /api/alexa | Alexa skill webhook | Surface-specific, not general native API |
| GET | /display | Token-protected kiosk page | Web/kiosk only |
| GET | /api/display-data | Kiosk payload by display token | Surface-specific |
| GET | /api/backup | API-key JSON backup | Admin/operations only |

## Current Client Touchpoints

| Client/surface | Current API usage | Notes |
|---|---|---|
| Dashboard day view public/app.js | /api/me, /api/settings, /api/day, /api/weight/today, /api/weight/history, /api/events, /api/log, /api/gag/:id, /api/wellness, /api/weight, /api/version | Primary mobile web workflow; good source for native flow requirements |
| Trends view public/history.js | /api/settings, /api/history, /api/weight/history | Some trend derivation still happens client-side |
| Settings view public/settings.js | /api/settings, /api/account/preferences, /api/family/members, /api/family/invitations | Defines caregiver/admin management needs |
| Chat view public/chat.js | /api/settings, /api/chat, /api/transcribe | Natural-language logging surface |
| Kiosk display public/display.html | /api/display-data?token= | Separate token model; not user-auth native API |
| Auth helper public/auth-fetch.js | /api/auth/status; injects Clerk bearer token for writes | Native apps need explicit token flow instead of browser script injection |
| Alexa server.js | /api/alexa plus account link resolution | Shares care data, but includes surface-specific APL and speech behavior |
| Telegram bot.js | Direct parser/db path, not HTTP API | Should eventually use service layer, not necessarily HTTP |

## Domain Rules That Should Be Backend-Owned

These rules already exist, but not all are isolated from route/client code:

- Authenticated family/patient scope and caregiver role.
- Fluid-day calculation and date shifting.
- Timezone conversion from date + HH:MM into timestamp.
- Future-date rejection and time format validation.
- Fluid entry shape: input/output, fluid type, amount, subtype, notes, source.
- Wellness periods and latest-row aggregation by check time.
- Gag event count and timestamp behavior.
- Weight upsert by fluid-day date.
- Intake totals, output summaries, by-type totals, percent of daily limit.
- Trend summaries and chart-ready history payloads.
- Nurse handoff report text.
- Realtime change publication after create/update/delete.
- Account preferences and settings fallback/default behavior.
- Family invite and membership acceptance behavior.

Native clients should receive these outcomes from the backend rather than
reimplementing them locally.

## Target Mobile-Facing Contract

Use REST first. GraphQL is not needed unless native clients later need flexible
cross-resource queries that become awkward in REST. Version the mobile contract
before native clients depend on it, for example under /api/v1.

### Auth and Scope

GET /api/v1/me

Authorization: Bearer clerk-session-token

Returns the authenticated user, available families/patients, active scope, role,
and onboarding state.

Example response:

    {
      "ok": true,
      "user": {
        "clerkUserId": "user_...",
        "email": "caregiver@example.com",
        "displayName": "Caregiver"
      },
      "activeScope": {
        "familyId": "uuid",
        "familyName": "Touma Family",
        "patientId": "uuid",
        "patientName": "Elina",
        "role": "owner"
      },
      "availableScopes": []
    }

Expected errors:

- 401 unauthenticated
- 403 not_authorized_for_patient
- 409 onboarding_required

### Day Summary

GET /api/v1/days/{dayKey}

Authorization: Bearer token

Returns one canonical fluid-day payload. This should replace native dependence on
multiple day/weight calls where practical.

Example response:

    {
      "ok": true,
      "dayKey": "2026-05-17",
      "todayDayKey": "2026-05-17",
      "settings": {
        "timezone": "America/New_York",
        "dailyLimitMl": 1200,
        "units": "ml"
      },
      "summary": {
        "totalIntakeMl": 420,
        "totalOutputMl": 180,
        "dailyLimitPercent": 35,
        "gagCount": 0
      },
      "entries": {
        "inputs": [],
        "outputs": [],
        "gags": [],
        "wellness": [],
        "weight": null
      }
    }

### Care Entry Writes

POST /api/v1/care-entries

PATCH /api/v1/care-entries/{entryType}/{id}

DELETE /api/v1/care-entries/{entryType}/{id}

Use a discriminated request body for create operations:

    {
      "kind": "fluid",
      "entryType": "input",
      "fluidType": "water",
      "amountMl": 120,
      "date": "2026-05-17",
      "time": "14:30",
      "notes": null
    }

Other kinds:

- fluid: input/output amount entries
- wellness: appetite, energy, mood, cyanosis, check period
- gag: count/time
- weight: daily weight

Each successful write should return the updated day summary or enough metadata
for clients to refresh a specific day.

### Trends

GET /api/v1/trends?days=7

Returns chart-ready, backend-derived trend data for supported ranges. Native
clients may choose their own chart rendering, but should not recompute the core
care-domain summary rules.

### Reports

GET /api/v1/reports/handoff?date=2026-05-17

Returns nurse-ready text and structured source metrics used to produce it.

### Settings and Preferences

GET /api/v1/settings

PATCH /api/v1/settings

GET /api/v1/account/preferences

PATCH /api/v1/account/preferences

Settings should be patient/family scoped. Preferences should be account scoped.

### Family Access

GET /api/v1/family/members

POST /api/v1/family/invitations

Owner/admin operations must enforce role checks server-side.

### Realtime

Keep /api/events for the web app. For native apps, decide after the first native
shell choice:

- Poll GET /api/v1/days/{dayKey} on foreground/resume and after writes.
- Add push notifications only if there is a real caregiver need.
- Consider SSE only if the chosen native stack handles it cleanly.

## Service Extraction Targets

Milestone 2 should move toward these modules:

- services/authScopeService.js
- services/careLogService.js
- services/daySummaryService.js
- services/trendService.js
- services/reportService.js
- services/settingsService.js
- services/familyAccessService.js
- services/realtimeService.js

Route handlers should become thin:

1. Authenticate and resolve scope.
2. Validate request shape.
3. Call a service.
4. Return a documented response or documented error.

## Contract Test Targets

Milestone 5 should cover these before native client work depends on the API:

- Auth/scope: unauthenticated, unauthorized, onboarding required, valid owner.
- Day summary: today, explicit date, yesterday, future date rejection.
- Fluid writes: create, edit, delete input/output.
- Wellness: create/update/latest aggregation/delete.
- Gag: create/edit/delete.
- Weight: upsert/history/delete.
- Trends: 7/30/90 day range bounds and derived totals.
- Settings/preferences: scoped settings versus account preferences.
- Family invitations: role checks and invalid email handling.
- Report generation: stable enough text plus structured metrics.

## Implementation Guidance

Do not pause useful product work for a large refactor. The app is currently
stable, so native readiness should advance opportunistically:

- When a new feature touches a care-domain rule, extract that rule into a
  service instead of adding more route-local logic.
- When a new client-facing response shape is needed, update this contract first.
- Keep current routes compatible until replacement routes are proven.
- Prefer small, tested migrations over broad file moves.
- Treat /api/v1 as the eventual native-safe contract; keep existing routes as
  web compatibility until the web app also migrates.

## Open Questions

- Should the first native client be true native Swift/Kotlin, React Native, Expo,
  or a PWA wrapper? Defer until API contracts are stable.
- Should future apps support offline logging? If yes, write APIs need idempotency
  keys and conflict rules.
- Does native need multi-patient switching in v1, or just one active patient per
  family scope?
- Should handoff reports support arbitrary dates immediately?
- Which trend calculations should be returned as canonical backend summaries
  versus client-rendered-only data?
