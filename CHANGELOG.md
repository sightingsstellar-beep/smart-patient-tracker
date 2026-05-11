# Changelog

All notable changes to the Smart Patient Wellness Tracker web app and Alexa skill are documented here.

This project follows semantic versioning. Because the tracker is live and used daily, every deployed behavior change should link back to Mission Control context and include verification evidence.

## [1.1.1] - 2026-05-11

### Added
- Version/accountability foundation for the live web app and Alexa skill.
- Public `/api/version` endpoint with release, environment, build, commit, and component version metadata.
- Web UI release footer that displays the deployed app version.
- Alexa `VersionIntent` so the skill can answer “what version are you running?” after the interaction model is deployed.
- README release/accountability guidance tied to the Family Care Bundle operating standard.

### Verification
- `node --check server.js`
- `node --check bot.js`
- `node --check db.js`
- `node -e "const { releaseInfo } = require('./app-version'); console.log(releaseInfo().version)"`

### Mission Control
- Parent project: Family Care Bundle — Enounce AI.
- Cross-product initiative: Family Care Bundle packaging and release accountability.
- Task: Add versioning to Smart Patient Tracker web app and Alexa skill.

## [1.0.0] - historical baseline

### Added
- Live Smart Patient Wellness Tracker web app.
- Telegram natural-language logging.
- SQLite-backed fluid intake/output, wellness, gag, weight, and settings data.
- Mobile-first dashboard and day/trends views.
- Alexa/APL skill endpoint for bedside Echo Show interaction.
