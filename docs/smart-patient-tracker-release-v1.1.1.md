# Smart Patient Wellness Tracker v1.1.1 Release Receipt

## Summary

Baseline accountability release for the live Smart Patient Wellness Tracker web app and Alexa skill under the Family Care Bundle / Enounce AI product line.

This release adds explicit version surfaces without changing the core fluid-tracking workflow:

- public `/api/version` endpoint for deploy verification
- `/health` version metadata
- visible web app version in the dashboard and login screen
- Alexa `VersionIntent` and component version metadata
- changelog and release/accountability guidance

## Version

- Web app: `1.1.1`
- Alexa skill component: `1.1.1` by default, or `ALEXA_SKILL_VERSION` when intentionally rolled separately
- Package: `smart-patient-tracker@1.1.1`

## Mission Control lineage

- Parent project: `Family Care Bundle — Enounce AI` (`357341cf-c8a4-4887-9b62-c0054878890c`)
- Initiative: `Family Care Bundle packaging and release accountability` (`acb63755-d409-4504-a70f-dad35e1f30cd`)
- Task: `Add versioning to Smart Patient Tracker web app and Alexa skill` (`48f4972b-da19-4ec6-929e-cec4f558a77b`)

## Local verification

Run from `smart-patient-tracker/`:

```bash
node --check app-version.js
node --check server.js
node --check bot.js
node --check db.js
node -e "const { releaseInfo } = require('./app-version'); const info = releaseInfo(); if (info.version !== '1.1.1') throw new Error('unexpected version'); console.log(JSON.stringify(info, null, 2));"
python3 -m json.tool alexa/interaction-model.json >/dev/null
PORT=3091 NODE_ENV=test node server.js
curl http://127.0.0.1:3091/api/version
```

Observed `/api/version` shape:

```json
{
  "name": "smart-patient-tracker",
  "version": "1.1.1",
  "release": null,
  "environment": "test",
  "commit": null,
  "builtAt": null,
  "components": {
    "webApp": {
      "name": "smart-patient-tracker",
      "version": "1.1.1"
    },
    "alexaSkill": {
      "name": "Patient Wellness Tracker",
      "invocationName": "fluid tracking",
      "version": "1.1.1"
    }
  }
}
```

## Production deployment

- Railway project: `splendid-tenderness` (`9198afad-2420-489b-84f5-0c73587953d2`)
- Railway service: `elina-tracker` (`f5a61a90-646b-4187-a628-0a93595c9c1d`)
- Production URL: `https://elina-tracker-production.up.railway.app`
- Deployment ID: `013b9656-dc18-4eb9-b3a0-5d1c3771e0e8`
- Deployed from local source commit: `8c83223`
- Release variables set: `RELEASE_VERSION=v1.1.1`, `ALEXA_SKILL_VERSION=1.1.1`, `BUILD_TIMESTAMP=2026-05-11T15:11:59Z`

Production verification passed:

```bash
curl -fsS https://elina-tracker-production.up.railway.app/health
curl -fsS https://elina-tracker-production.up.railway.app/api/version
```

Observed production `/health`:

```json
{"ok":true,"version":"1.1.1"}
```

Observed production `/api/version`:

```json
{"name":"smart-patient-tracker","version":"1.1.1","release":"v1.1.1","environment":"development","commit":null,"builtAt":"2026-05-11T15:11:59Z","components":{"webApp":{"name":"smart-patient-tracker","version":"1.1.1"},"alexaSkill":{"name":"Patient Wellness Tracker","invocationName":"fluid tracking","version":"1.1.1"}}}
```

Alexa endpoint verification passed by POSTing a `VersionIntent` request with the configured skill ID to `/api/alexa`; response included:

```xml
<speak>Smart Patient Wellness Tracker is running version 1.1.1.</speak>
```

Remaining follow-up: deploy/rebuild the Alexa interaction model in the Alexa developer console/SMAPI so real-user utterances for `VersionIntent` are recognized. The production endpoint already handles the intent.

