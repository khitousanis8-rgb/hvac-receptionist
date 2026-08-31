# HVAC AI Voice Receptionist

Foundation for a single-company HVAC voice receptionist, built with FastAPI and LiveKit Agents. This repository intentionally starts with the local browser-audio path; telephone/SIP connectivity, persistence, scheduling, and a dashboard are later phases.

## Phase 1 status

Included:

- FastAPI health and public configuration endpoints
- Validated environment-based company and runtime configuration
- JSON structured logs with request correlation IDs
- A LiveKit Agents worker configured for any OpenAI-compatible LLM API (Groq by default)
- Docker definitions and an environment template

## Phase 2 status

Included:

- SQLite persistence via SQLAlchemy (`app/db.py`): customers, call records, appointments
- Business-hours-aware scheduling engine with conflict-free booking (`app/scheduling.py`)
- LiveKit function tools the agent can call: `book_appointment_tool`, `check_my_appointments` (`app/agent/tools.py`)
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

4. With valid LiveKit and LLM credentials, run the local agent worker:

   ```powershell
   .\.venv\Scripts\python -m app.agent.worker dev
   ```

Open `http://localhost:8000/health` to check the API. The `GET /v1/config/public` endpoint deliberately exposes only non-sensitive business configuration.

The LLM defaults to **Groq** (free tier, open-weight models): get a free API key at
[console.groq.com](https://console.groq.com) and set `LLM_API_KEY`. Any OpenAI-compatible endpoint
works — for a fully local setup, run [Ollama](https://ollama.com) and point `LLM_BASE_URL` at
`http://localhost:11434/v1` (see `.env.example`).

## Docker

After creating `.env`, start the API and agent worker together:

```powershell
docker compose up --build
```

The agent will not connect successfully until its LiveKit and LLM credentials are replaced. That is expected and avoids silently starting with invalid production configuration.
