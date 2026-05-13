# Changelog

All notable changes to the Glide Patient Tracker web app and Alexa skill are documented here.

This project follows semantic versioning. Because the tracker is live and used daily, every deployed behavior change should link back to Mission Control context and include verification evidence.

## [Unreleased]

### Changed
- Adopted the official Glide tool-family names: Glide Patient Tracker, Glide Handoff Videos, and Glide Community Guidebook.
- Updated web app/PWA labels, Alexa manifest metadata, runtime messages, and publication docs from Smart/Patient Wellness naming to Glide Patient Tracker.

### Verification
- `node --check server.js`
- `node --check db.js`
- Alexa manifest JSON/structure smoke check for skill name, endpoint, and policy URLs.

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
- Task: Implement multi-family tenancy for Glide Patient Tracker.

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
- Task: Add versioning to Glide Patient Tracker web app and Alexa skill.

## [1.0.0] - historical baseline

### Added
- Live Glide Patient Tracker web app.
- Telegram natural-language logging.
- SQLite-backed fluid intake/output, wellness, gag, weight, and settings data.
- Mobile-first dashboard and day/trends views.
- Alexa/APL skill endpoint for bedside Echo Show interaction.
