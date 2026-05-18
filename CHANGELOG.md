# Changelog

All notable changes to the Glide Bedside web app and Alexa skill are documented here.

This project follows semantic versioning. Because the tracker is live and used daily, every deployed behavior change should link back to Mission Control context and include verification evidence.

## [1.2.3] - 2026-05-18

### Changed
- Added a package-level `npm test` smoke gate for syntax-checking the main server, database, bot, and operational scripts.
- Updated local setup documentation to require Node.js 20.9+, matching `package.json`.

### Fixed
- Made the Clerk credential verification script load local `.env` values and fail clearly when `CLERK_SECRET_KEY` is missing.
- Added a required destination confirmation guard to the destructive SQLite-to-Postgres migration script, plus a dry-run/count mode for safer inspection.

### Verification
- `npm test`
- `node scripts/migrate-sqlite-to-postgres.js --dry-run` against a temporary SQLite fixture and dummy Postgres URL

### Mission Control
- Resource: Glide Bedside live app.
- Clawpatch pilot report: `state/clawpatch-pilots/20260518T001459Z-glide-bedside/report.md`.

## [1.2.2] - 2026-05-17

### Changed
- Renamed the GitHub repository and package identity from Smart Patient Tracker to Glide Bedside (`sightingsstellar-beep/glide-bedside`).
- Adopted the updated official Glide tool-family names: Glide Bedside, Glide Hello, and Glide Guide.
- Updated web app/PWA labels, Alexa manifest metadata, Alexa invocation examples, runtime messages, invite emails, and publication docs from Patient Tracker / Handoff Videos / Community Guidebook naming to Glide Bedside / Glide Hello / Glide Guide.

### Verification
- `node --check server.js`
- `node --check db.js`
- Alexa manifest JSON/structure smoke check for skill name, endpoint, and policy URLs.

### Mission Control
- Resource: Glide Bedside live app.
- Initiative: GlideChart tool repos and release accountability.

## [1.2.0] - 2026-05-11

### Changed
- Migrated the production persistence layer from single-tenant SQLite to Postgres.
- Added the first multi-family schema foundation: families, patients, users, Alexa account links, and family/patient-scoped tracker tables.
- Replaced the SQLite-backed session store with a Postgres-backed session store.
- Changed `/api/backup` to export a Postgres JSON backup payload instead of downloading the old SQLite file.

### Migration
- Preserved the existing live family/patient data under default family and patient IDs.
- Migrated fluid logs, wellness checks, gag events, weight logs, settings, and sessions.

### Verification
- Production SQLite backup created before migration.
- Postgres migration count check matched source data: 1,802 fluid logs; 969 gag events; 28 wellness checks; 49 weight logs; 12 settings; 6 sessions.
- Local Postgres-backed smoke tests covered `/health`, `/api/today`, `/api/backup`, and Alexa `VersionIntent`.

### Mission Control
- Parent project: Glide tool family — Hour Glide.
- Cross-product initiative: Glide tool family packaging and release accountability.
- Task: Implement multi-family tenancy for Glide Bedside.

## [1.1.1] - 2026-05-11

### Added
- Version/accountability foundation for the live web app and Alexa skill.
- Public `/api/version` endpoint with release, environment, build, commit, and component version metadata.
- Web UI release footer that displays the deployed app version.
- Alexa `VersionIntent` so the skill can answer “what version are you running?” after the interaction model is deployed.
- README release/accountability guidance tied to the Glide tool family operating standard.

### Verification
- `node --check server.js`
- `node --check bot.js`
- `node --check db.js`
- `node -e "const { releaseInfo } = require('./app-version'); console.log(releaseInfo().version)"`

### Mission Control
- Parent project: Glide tool family — Hour Glide.
- Cross-product initiative: Glide tool family packaging and release accountability.
- Task: Add versioning to Glide Bedside web app and Alexa skill.

## [1.0.0] - historical baseline

### Added
- Live Glide Bedside web app.
- Telegram natural-language logging.
- SQLite-backed fluid intake/output, wellness, gag, weight, and settings data.
- Mobile-first dashboard and day/trends views.
- Alexa/APL skill endpoint for bedside Echo Show interaction.
