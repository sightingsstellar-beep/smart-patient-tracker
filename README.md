# The Smart Patient Wellness Tracker 💙

A private, open-source fluid intake/output tracking platform for critically ill children in hospital care. Built with love for families navigating long-term medical journeys.

This tool helps caregivers and nurses accurately log and monitor:
- **Fluid intake** (water, juice, milk, PediaSure, yogurt drink, vitamin water)
- **Fluid outputs** (urine, poop, vomit)
- **Daily wellness checks** (appetite, energy, mood, cyanosis - all 1-10)
- **Gag episodes**
- **Automated nurse handoff reports** at configurable times

All logging is done via **natural language** through a Telegram bot (powered by OpenAI), with a beautiful **mobile-first dashboard** to view real-time totals.

> 💡 **Child name, daily limits, report times, and all other settings are configurable** from the built-in Settings page at `/settings`. Default settings maintain backward compatibility (name: Elina, limit: 1200ml, 7am day start).

---

## Versioning and accountability

This live app follows the Family Care Bundle App Versioning & Accountability Standard in `../docs/app-versioning-accountability-standard.md`.

Release/accountability surfaces:

- `package.json` owns the web app version.
- `ALEXA_SKILL_VERSION` may override the Alexa component version when the skill needs separate rollout tracking; otherwise it follows the app version.
- `CHANGELOG.md` records meaningful product changes.
- `/api/version` exposes release metadata for production verification.
- The dashboard/login UI displays the deployed app version.
- The Alexa skill includes a `VersionIntent` so it can answer version questions after the interaction model is deployed.

Before marking a tracker/Alexa change done, record the deployed version, verification evidence, and any regression/rollback notes in Mission Control.


## Features

- 📱 **Telegram bot** - log entries naturally: "120ml pediasure" or "pee 85ml"
- 🤖 **OpenAI NLP** - understands natural language, handles batches
- 📊 **Live dashboard** - color-coded intake bar, output log, wellness gauges
- 🔔 **Auto-reports** - sent to Telegram at configurable times daily
- 🗓️ **Fluid day logic** - day starts at configurable hour, resets automatically
- ⚙️ **Settings page** - configure child name, limits, report times, thresholds, timezone
- 🔒 **Authorization** - only approved Telegram users can log
- 🚀 **Railway-ready** - one-click deploy with persistent storage

---

## Quick Start (Local)

### Prerequisites
- Node.js 18+
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- An OpenAI API key

### Setup

```bash
# 1. Clone or download the project
git clone https://github.com/sightingsstellar-beep/smart-patient-tracker.git
cd smart-patient-tracker

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env with your credentials (see below)

# 4. Start the server
npm start
```

The dashboard will be available at **http://localhost:3000**

The Telegram bot starts automatically and polls for messages.

---

## Environment Variables

Edit `.env` with your values:

```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
OPENAI_API_KEY=your_openai_key_here
AUTHORIZED_USER_IDS=8573495743
DASHBOARD_PASSWORD=choose_a_strong_password
SESSION_SECRET=generate_a_long_random_secret
# Optional integrations / programmatic access
ALEXA_SKILL_ID=
API_KEY=
DISPLAY_TOKEN=
PORT=3000
TZ=America/New_York
# DATA_DIR=/data
```

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | From [@BotFather](https://t.me/BotFather) — the Telegram bot token |
| `OPENAI_API_KEY` | Yes | Used for natural-language parsing and audio transcription |
| `AUTHORIZED_USER_IDS` | Yes | Comma-separated Telegram user IDs allowed to use the bot |
| `DASHBOARD_PASSWORD` | Yes | Password for the browser dashboard login |
| `SESSION_SECRET` | Yes | Long random secret for signed browser sessions |
| `ALEXA_SKILL_ID` | Optional | Restricts `/api/alexa` to your Alexa skill |
| `API_KEY` | Optional | Programmatic access via `x-api-key`, including automated backups |
| `DISPLAY_TOKEN` | Optional | Token for the kiosk-style `/display` and `/api/display-data` routes |
| `PORT` | Usually no | HTTP server port (Railway sets this automatically) |
| `TZ` | Recommended | Default timezone for fluid-day calculation and time displays |
| `DATA_DIR` | Recommended on Railway | Directory for SQLite storage, for example `/data` with a mounted volume |

> **Note:** Most day-to-day configuration, like child name, daily limit, report times, thresholds, and timezone, is managed through the **Settings page** at `/settings` and stored in the database.

---

## Settings Page

Visit **`/settings`** in the web app to configure:

| Setting | Default | Description |
|---|---|---|
| Child's name | Elina | Shown in dashboard headers and reports |
| Daily fluid limit | 1200 ml | Triggers color-coded warnings |
| Day start hour | 7 AM | When the fluid tracking day resets |
| Units | ml | ml or oz |
| Yellow warning | 70% | Progress bar turns yellow at this % |
| Red warning | 90% | Progress bar turns red at this % |
| Handoff report time | 19:00 | First daily Telegram report |
| Bedtime report time | 22:00 | Second daily Telegram report |
| Afternoon wellness check | 17:00 | Reference time for 5pm check |
| Evening wellness check | 22:00 | Reference time for 10pm check |
| Timezone | America/New_York | Used for all time displays and cron jobs |

All settings persist across server restarts in SQLite.

---

## Using the Telegram Bot

### Just type naturally:

| Message | What it logs |
|---|---|
| `120ml pediasure` | 120ml PediaSure intake |
| `pee 85ml` | 85ml urine output |
| `vomit, roughly 60ml` | ~60ml vomit output |
| `pooped` | Poop output (no amount) |
| `gag x2` | 2 gag episodes |
| `she gagged once` | 1 gag episode |
| `wellness: appetite 7, energy 4, mood 8, cyan 3` | Wellness check |
| `120ml pediasure and 45ml water` | Two intake entries at once |

### Bot Commands:

| Command | Action |
|---|---|
| `/today` | Full summary of the current fluid day |
| `/status` | Quick intake total and percentage |
| `/report` | Full nurse handoff report |
| `/undo` | Remove the last logged entry |
| `/help` | Usage guide |

---

## Adding Authorized Users

1. Have the person message [@userinfobot](https://t.me/userinfobot) to find their Telegram ID
2. Add their ID to `AUTHORIZED_USER_IDS` in `.env`:
   ```
   AUTHORIZED_USER_IDS=8573495743,987654321
   ```
3. Restart the server

Anyone not in this list will receive a polite rejection message.

---

## Deploy to Railway

### Option 1: Railway Dashboard (Easiest)

1. Push your code to a GitHub repository (make sure `.env` is in `.gitignore`)
2. Go to [railway.app](https://railway.app) and create a new project
3. Click **"Deploy from GitHub repo"** and select your repository
4. Go to **Variables** and add the required app secrets:
   - `TELEGRAM_BOT_TOKEN`
   - `OPENAI_API_KEY`
   - `AUTHORIZED_USER_IDS`
   - `DASHBOARD_PASSWORD`
   - `SESSION_SECRET`
   - `TZ`
   - `DATA_DIR=/data` if you mounted a persistent volume

   Optional, depending on your setup:
   - `ALEXA_SKILL_ID`
   - `API_KEY`
   - `DISPLAY_TOKEN`
5. Railway will build and deploy automatically

### Option 2: Railway CLI

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

Then add variables in the Railway dashboard under **Variables**.

### Persistent Storage (Important!)

SQLite data is lost on redeployment unless you use a persistent volume:

1. In Railway, go to your project → **Add Volume**
2. Mount it at `/data`
3. Add `DATA_DIR=/data` to your Railway environment variables

This keeps patient data safe across deployments.

---

## Dashboard

The web dashboard is served at the root URL (`/`). It:

- Auto-refreshes every 30 seconds
- Includes a full-width **Today / Yesterday** switcher just below the main menu
- Treats that switcher as the page context, not just a logging mode:
  - intake totals and itemized intake cards update
  - outputs and gag lists update
  - daily weight updates
  - wellness / vitals update
- Lets caregivers backfill **yesterday** directly from the same screen, including quick logs, weight, and wellness entries
- Shows a color-coded intake progress bar:
  - 🟢 Green: 0–70% (safe, configurable)
  - 🟡 Yellow: 70–90% (approaching limit, configurable)
  - 🔴 Red: 90–100% (near limit, configurable)
  - 🚨 Flashing: over limit
- Displays outputs chronologically
- Has quick-log buttons for common entries
- Works great on mobile (bookmark it to your home screen!)

---

## File Structure

```
smart-patient-tracker/
├── server.js          # Express app, API routes, report builder
├── bot.js             # Telegram bot (polling, commands, NLP dispatch)
├── parser.js          # OpenAI gpt-4o-mini NLP parser
├── db.js              # SQLite schema, queries, and settings storage
├── scheduler.js       # Cron jobs (auto-reports at configured times)
├── ask-manifest.json  # Alexa skill manifest
├── alexa/             # Alexa interaction model and skill assets
├── public/
│   ├── index.html     # Mobile dashboard
│   ├── style.css      # Mobile-first styles
│   ├── app.js         # Dashboard JavaScript
│   ├── history.html   # 7-day history page
│   ├── history.css    # History styles
│   ├── history.js     # History JavaScript
│   ├── chat.html      # Voice + text chat page
│   ├── chat.css       # Chat styles
│   ├── chat.js        # Chat JavaScript
│   ├── settings.html  # Settings page
│   ├── settings.css   # Settings styles
│   ├── settings.js    # Settings JavaScript
│   └── display.html   # Token-authenticated kiosk display
├── .env.example       # Environment variable template
├── .env               # Your local credentials (not committed)
├── .gitignore
├── package.json
├── railway.json       # Railway deployment config
└── README.md
```

---

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/api/today` | Day-scoped dashboard data, supports `?relative=today|yesterday` or `?date=YYYY-MM-DD` |
| `GET` | `/api/report` | Formatted nurse handoff report for the current fluid day |
| `POST` | `/api/log` | Log a fluid entry, wellness check, or gag event |
| `GET` | `/api/history?days=7` | Last N fluid-day summaries |
| `DELETE` | `/api/log/:id` | Delete a specific fluid log entry |
| `DELETE` | `/api/gag/:id` | Delete a specific gag event |
| `POST` | `/api/weight` | Log or replace a daily weight entry |
| `GET` | `/api/weight/today` | Weight for a requested day, supports `?relative=` or `?date=` |
| `GET` | `/api/weight/history?days=7` | Recent weight history, optionally bounded with `throughDate=YYYY-MM-DD` |
| `POST` | `/api/chat` | Parse and log natural-language text through the same NLP pipeline as Telegram |
| `POST` | `/api/transcribe` | Transcribe uploaded audio before chat parsing |
| `GET` | `/api/settings` | Get all settings as a flat object |
| `POST` | `/api/settings` | Update one or more settings |
| `POST` | `/api/alexa` | Alexa webhook endpoint |
| `GET` | `/display` | Token-authenticated kiosk display |
| `GET` | `/api/display-data` | JSON payload for kiosk display |
| `GET` | `/api/backup` | Database backup download, requires `x-api-key` |

### POST /api/log examples

**Fluid intake:**
```json
{ "entry_type": "input", "fluid_type": "water", "amount_ml": 120 }
```

**Fluid output:**
```json
{ "entry_type": "output", "fluid_type": "urine", "amount_ml": 85 }
```

**Wellness check:**
```json
{ "type": "wellness", "check_time": "5pm", "appetite": 7, "energy": 4, "mood": 8, "cyanosis": 3 }
```

**Gag event:**
```json
{ "type": "gag", "count": 2 }
```

### POST /api/settings example

```json
{ "child_name": "Alex", "daily_limit_ml": "1500", "timezone": "America/Chicago" }
```

---

## Open Source

This project is open source under the MIT License. If you find it helpful for another child or family, please use it, improve it, and share it.

Pull requests welcome. Please be thoughtful - this is a medical tool.

---

*Built with love 💙*
