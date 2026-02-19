# Elina Tracker 💙

A private, open-source fluid intake/output tracking platform for Elina — a critically ill child in hospital care. Built with love for her family.

This tool helps caregivers and nurses accurately log and monitor:
- **Fluid intake** (water, juice, milk, PediaSure, yogurt drink, vitamin water)
- **Fluid outputs** (urine, poop, vomit)
- **Daily wellness checks** (appetite, energy, mood, cyanosis — all 1–10)
- **Gag episodes**
- **Automated nurse handoff reports** at 7pm and 10pm

All logging is done via **natural language** through a Telegram bot (powered by OpenAI), with a beautiful **mobile-first dashboard** to view real-time totals.

---

## Features

- 📱 **Telegram bot** — log entries naturally: "120ml pediasure" or "pee 85ml"
- 🤖 **OpenAI NLP** — understands natural language, handles batches
- 📊 **Live dashboard** — color-coded intake bar, output log, wellness gauges
- 🔔 **Auto-reports** — sent to Telegram at 7pm and 10pm daily
- 🗓️ **Fluid day logic** — day starts at 7:00 AM, resets automatically
- 🔒 **Authorization** — only approved Telegram users can log
- 🚀 **Railway-ready** — one-click deploy with persistent storage

---

## Quick Start (Local)

### Prerequisites
- Node.js 18+
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- An OpenAI API key

### Setup

```bash
# 1. Clone or download the project
git clone https://github.com/your-username/elina-tracker.git
cd elina-tracker

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
PORT=3000
TZ=America/New_York
```

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | From [@BotFather](https://t.me/BotFather) — create a new bot |
| `OPENAI_API_KEY` | From [platform.openai.com](https://platform.openai.com) |
| `AUTHORIZED_USER_IDS` | Comma-separated Telegram user IDs |
| `PORT` | HTTP server port (Railway sets this automatically) |
| `TZ` | Timezone for day calculation (IANA format) |
| `DATA_DIR` | Optional path for SQLite DB (default: `./data/`) |

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
4. Go to **Variables** tab and add all your environment variables:
   - `TELEGRAM_BOT_TOKEN`
   - `OPENAI_API_KEY`
   - `AUTHORIZED_USER_IDS`
   - `TZ`
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

This keeps Elina's data safe across deployments.

---

## Dashboard

The web dashboard is served at the root URL (`/`). It:

- Auto-refreshes every 30 seconds
- Shows a color-coded intake progress bar:
  - 🟢 Green: 0–70% (safe)
  - 🟡 Yellow: 70–90% (approaching limit)
  - 🔴 Red: 90–100% (near limit)
  - 🚨 Flashing: over limit
- Displays outputs chronologically
- Shows wellness gauges (color-coded 1–10)
- Has quick-log buttons for common entries
- Works great on mobile (bookmark it to your home screen!)

---

## File Structure

```
elina-tracker/
├── server.js          # Express app, API routes, report builder
├── bot.js             # Telegram bot (polling, commands, NLP dispatch)
├── parser.js          # OpenAI gpt-4o-mini NLP parser
├── db.js              # SQLite schema and all database queries
├── scheduler.js       # Cron jobs (7pm + 10pm auto-reports)
├── public/
│   ├── index.html     # Mobile dashboard
│   ├── style.css      # Mobile-first styles
│   └── app.js         # Dashboard JavaScript
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
| `GET` | `/api/today` | All data for the current fluid day |
| `GET` | `/api/report` | Formatted nurse handoff report |
| `POST` | `/api/log` | Log a fluid entry, wellness check, or gag |
| `GET` | `/api/history?days=7` | Logs for the last N days |
| `DELETE` | `/api/log/:id` | Delete a specific log entry |

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

---

## Open Source

This project is open source under the MIT License. If you find it helpful for another child or family, please use it, improve it, and share it.

Pull requests welcome. Please be thoughtful — this is a medical tool.

---

*Built with love for Elina 💙*
