# Deployment Guide — Free Demo Hosting

## Option 1 — Render.com (no card required) ⭐ recommended for demos

Render's free tier runs a Docker web service without a credit card — the API
and agent worker share one container via `backend/start.sh`.
Caveat: the service **sleeps after 15 min without HTTP traffic** and wakes in
~30s on the next request (keep it awake with a free UptimeRobot ping).

### Backend + agent worker on Render

1. Sign up at [dashboard.render.com](https://dashboard.render.com) with GitHub
2. **New → Web Service** → connect the repo `khitousanis8-rgb/hvac-receptionist`
3. Render auto-detects `render.yaml` (Dockerfile `backend/Dockerfile`, health
   check `/health`, free plan). Confirm and continue.
4. Add **environment variables** (from your `.env`):
   - `APP_ENV=production`
   - `BUSINESS_*` values (company name, phone, address, timezone, hours JSON, services)
   - `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
   - `LLM_API_KEY`, `LLM_BASE_URL=https://api.groq.com/openai/v1`, `LLM_MODEL`
   - `CORS_ORIGINS=https://<your-vercel-app>.vercel.app` (add after Vercel deploy)
5. Deploy → your API URL: `https://hvac-receptionist.onrender.com`
6. Verify: open `https://<your-render-url>/health` → `{"status": "ok"}`

> Note: SQLite resets on each redeploy (fine for demos).

### Optional: keep the demo awake 24/7

Create a free monitor at [uptimerobot.com](https://uptimerobot.com) pinging
`https://<your-render-url>/health` every 5 minutes.

### Dashboard on Vercel

1. [vercel.com](https://vercel.com) → Add New → Project → import the GitHub repo
2. **Root Directory:** `frontend` · **Framework:** Vite (auto)
3. Environment variable: `VITE_API_BASE` = `https://<your-render-url>` (e.g. `https://hvac-receptionist.onrender.com`)
4. Deploy → share your `https://<app>.vercel.app` demo link

### After both are live
- Set `CORS_ORIGINS` on Render to your Vercel URL and redeploy the service
- Test: make a call from the LiveKit Playground → watch it appear on the dashboard

---

## Option 2 — Fly.io (requires a card on file, free allowance)


Host the dashboard on **Vercel** (free) and the API + agent worker on **Fly.io**
(free allowance), using LiveKit Cloud and Groq free tiers. Total cost: **$0**
for a demo. No domain needed — you get public HTTPS URLs from both platforms.

```
Visitor → https://<app>.vercel.app        (React dashboard)
               │ fetch /v1/*, /health
               ▼
         https://<app>.fly.dev            (FastAPI + SQLite)
               │
         agent worker ──► LiveKit Cloud ──► Groq LLM
```

## Prerequisites

- GitHub account (both platforms deploy from Git)
- [Node.js](https://nodejs.org) installed locally
- [Fly.io CLI](https://fly.io/docs/flyctl/install/) installed locally
- Your `.env` values ready (LiveKit + Groq credentials, business info)

---

## Step 1 — Push the project to GitHub

```powershell
cd referenced-chatgpt-conversation-this-is-an
git init
git add .
git commit -m "HVAC receptionist demo"
# Create a repo on github.com, then:
git remote add origin https://github.com/<you>/hvac-receptionist.git
git push -u origin main
```

> ⚠️ `.env` is git-ignored — credentials are set as platform secrets below.

## Step 2 — API + agent worker on Fly.io

```powershell
cd referenced-chatgpt-conversation-this-is-an
fly auth login

# First deploy (creates the app from fly.toml):
fly launch --no-deploy --copy-config

# Set secrets (from your .env):
fly secrets set `
  APP_ENV=production `
  CORS_ORIGINS=https://<your-vercel-app>.vercel.app `
  BUSINESS_COMPANY_NAME="Example HVAC" `
  BUSINESS_PHONE="+15555550100" `
  BUSINESS_ADDRESS="123 Example Street" `
  BUSINESS_TIMEZONE="America/New_York" `
  BUSINESS_EMERGENCY_PHONE="+15555550199" `
  BUSINESS_OPENING_HOURS='{"monday":"09:00-17:00",...}' `
  BUSINESS_SERVICES="AC repair,AC installation" `
  LIVEKIT_URL=wss://your-project.livekit.cloud `
  LIVEKIT_API_KEY=xxx `
  LIVEKIT_API_SECRET=xxx `
  LLM_API_KEY=your_groq_key `
  LLM_BASE_URL=https://api.groq.com/openai/v1 `
  LLM_MODEL=llama-3.3-70b-versatile

# Deploy (builds the backend Docker image, starts api + worker):
fly deploy

# Verify:
fly status              # both machines running
curl https://hvac-receptionist.fly.dev/health
fly logs                 # watch the agent worker connect to LiveKit
```

Your API URL: `https://hvac-receptionist.fly.dev`

### Optional: persist the SQLite database

```powershell
fly volumes create hvac_data --size 1 --region cdg
```
Then uncomment the `[mounts]` block in `fly.toml` and set:
```powershell
fly secrets set DATABASE_URL=sqlite:////data/hvac_receptionist.db
fly deploy
```
Without a volume, the demo database resets on each deploy (fine for demos).

## Step 3 — Dashboard on Vercel

1. Go to [vercel.com](https://vercel.com) → **Add New → Project** → import your GitHub repo
2. Configure:
   - **Root Directory:** `frontend`
   - **Framework Preset:** Vite (auto-detected)
   - **Environment variable:** `VITE_API_BASE` = `https://hvac-receptionist.fly.dev`
3. Click **Deploy**

Your dashboard URL: `https://<project>.vercel.app`

> The frontend reads `VITE_API_BASE` at **build time** — if you change it,
> redeploy from Vercel's dashboard (Deployments → ⋯ → Redeploy).

## Step 4 — Test the demo

1. Open `https://<project>.vercel.app` — the dashboard should show
   "API online" (green dot) and your business config in Settings
2. Make a test call from the [LiveKit Playground](https://cloud.livekit.io)
   (Agents → your agent → Playground)
3. Watch the call appear on the dashboard within ~10 seconds

## Updating the demo

| Change | How |
|---|---|
| Frontend | Push to GitHub → Vercel auto-redeploys |
| Backend/agent | `git push` + `fly deploy` |
| Secrets | `fly secrets set KEY=value` (auto-restarts) |

## Costs

| Service | Demo cost |
|---|---|
| Vercel (Hobby) | $0 |
| Fly.io (free allowance) | $0 – a few $ if machines run 24/7 after trial |
| LiveKit Cloud | $0 (free tier) |
| Groq | $0 (free tier) |

## When you land a client

Migrate to a single VPS (Hetzner ~€4.50/mo) with Docker Compose + Caddy for
one domain, persistent SQLite, and full control — see the docker-compose.yml
already in this repo. Buy a domain (~$10/yr) and point it at the VPS.

## Troubleshooting

- **Dashboard shows "API offline":** check `VITE_API_BASE` was set at build
  time and `CORS_ORIGINS` on Fly includes your exact Vercel URL (https, no
  trailing slash)
- **Agent not joining calls:** `fly logs` — verify LiveKit credentials and
  that the worker process is running (`fly status`)
- **502 on fly.dev:** `fly logs` — the API may have crashed on boot; usually
  a malformed secret (e.g. `BUSINESS_OPENING_HOURS` JSON quoting)