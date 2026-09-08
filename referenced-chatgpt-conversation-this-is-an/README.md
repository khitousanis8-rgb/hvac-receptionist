# HVAC AI Voice Receptionist

Foundation for a single-company HVAC voice receptionist. Kokoro synthesizes
speech in the caller's browser; FastAPI provides the LLM chat, scheduling, and
call-record APIs.

## Phase 1 status

Included:

- FastAPI health and public configuration endpoints
- Validated environment-based company and runtime configuration
- JSON structured logs with request correlation IDs
- An in-browser Kokoro voice flow backed by an OpenAI-compatible LLM API (Groq by default)
- Docker definitions and an environment template

## Phase 2 status

Included:

- SQLite persistence via SQLAlchemy (`app/db.py`): customers, call records, appointments
- Business-hours-aware scheduling engine with conflict-free booking (`app/scheduling.py`)
- Chat tools for booking and appointment lookups
- `DATABASE_URL` setting (defaults to `sqlite:///./hvac_receptionist.db`)

- Call transcript persistence (`app/call_tracking.py`): every agent session creates a
  `CallRecord` with a transcript summary and derived outcome (`booked` / `info_only`)

Not included yet: dashboard, SIP/telephony.

## Local setup

1. Copy `.env.example` to `.env` and replace the placeholder credentials.
2. Create a virtual environment and install the backend with its development extras:

   ```powershell
   python -m venv .venv
   .\.venv\Scripts\python -m pip install -e ".\backend[dev]"
   ```

3. Run the API:

   ```powershell
   .\.venv\Scripts\python -m uvicorn app.main:app --app-dir backend --reload
   ```

Open `http://localhost:8000/health` to check the API. The `GET /v1/config/public` endpoint deliberately exposes only non-sensitive business configuration.

The LLM defaults to **Groq** (free tier, open-weight models): get a free API key at
[console.groq.com](https://console.groq.com) and set `LLM_API_KEY`. Any OpenAI-compatible endpoint
works — for a fully local setup, run [Ollama](https://ollama.com) and point `LLM_BASE_URL` at
`http://localhost:11434/v1` (see `.env.example`).

## Docker

After creating `.env`, start the API:

```powershell
docker compose up --build
```

The chat endpoint requires a valid LLM credential. `ENABLE_LIVEKIT_WORKER` remains
available only for the legacy LiveKit path and defaults to `false`.
