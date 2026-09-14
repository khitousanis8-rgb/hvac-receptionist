# Project: HVAC Voice Receptionist Phases 1 & 2

## Architecture
- **Backend Architecture**: FastAPI application in `referenced-chatgpt-conversation-this-is-an/backend` using SQLAlchemy with SQLite, structured logging (`structlog`), and Pydantic v2 schemas.
- **Database Layer**: `app/db.py` managing SQLite engine, session factory (`new_session`), schema migrations in `init_db()`, and connection disposal in `reset_engine()`.
- **Call Tracking & Lifecycle**: `app/call_tracking.py` managing call session state, token verification, slot accumulation, and background stale-call cleanup.
- **API Endpoints**: `app/main.py` (lifespan background tasks, health check, token generation, calls query) and `app/chat_api.py` (SSE streaming chat, call termination, slot extraction).
- **Frontend Architecture**: React 19 + TypeScript + Vite application in `frontend/` featuring `KokoroCallSession`, `BrowserSpeechRecognition`, and the admin call dashboard in `App.tsx`.
- **Interface Contracts**: JSON telemetry payload schemas shared between frontend call session and backend endpoints.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | R1.1 Test Engine Teardown & Lock Prevention | Update `reset_engine()` in `app/db.py` to call `_engine.dispose()` to release Windows file locks. | M1 | Survey 1 / Plan §P0 |
| 2 | R1.2 Test DB Isolation Fixture | Root `tests/conftest.py` allocating isolated SQLite file per test in `tmp_path`, monkeypatching `DATABASE_URL`, and clearing settings cache. | M1 | Survey 1 / Plan §P0 |
| 3 | R1.3 Runtime DB Access Guard | Engine-level guard in `app/db.py` raising an exception if tests attempt to connect to runtime `hvac_receptionist.db`. | M1 | Survey 1 / Plan §P0 |
| 4 | R1.4 Fixture Cleanup | Remove leaky `setup_db` fixture from `tests/test_chat_api.py` that deleted appointments and polluted live database. | M1 | Survey 1 / Plan §P0 |
| 5 | R1.5 Zero Pollution Verification Suite | Automated test suite `tests/test_db_isolation.py` and session hooks verifying zero file modification and zero row count delta on runtime DB. | M1 | Survey 1 / Plan §P0 |
| 6 | R2.1 Decouple Stale Cleanup from GET /v1/calls | Remove inline stale record cleanup from `_query_calls()` in `app/main.py`. | M2 | Survey 2 / Plan §P1 |
| 7 | R2.2 Autonomous Stale-Call Reaper | Implement `call_tracking.reap_stale_calls()` sweeping calls > 20m without `ended_at`, setting `ended_at = started_at + 3m`, setting outcome ('booked' if slots confirmed, else 'info_only'), and summary. | M2 | Survey 2 / Plan §P1 |
| 8 | R2.3 Lifespan Background Reaper Task | Implement `_stale_call_reaper_loop()` in `app/main.py` lifespan running periodic sweeps via `asyncio.to_thread` with graceful shutdown. | M2 | Survey 2 / Plan §P1 |
| 9 | R2.4 Autonomous Reaper Automated Tests | Automated tests in `tests/test_call_tracking.py` and `tests/test_api.py` proving stale calls finalize without calling `GET /v1/calls`. | M2 | Survey 2 / Plan §P1 |
| 10 | R3.1 CallRecord Telemetry Schema Extension | Add `platform_class`, `browser_engine`, `input_path`, `mic_permission`, `end_reason`, and `client_metrics` columns to `CallRecord` in `app/db.py`. | M3 | Survey 2 / Plan §P0 |
| 11 | R3.2 SQLite Backward-Compatible Migration | Extend `init_db()` in `app/db.py` to introspect columns and execute `ALTER TABLE call_records ADD COLUMN` for missing fields without data loss. | M3 | Survey 2 / Plan §P0 |
| 12 | R3.3 Privacy-Safe ClientTelemetry Model | Define strict Pydantic `ClientTelemetry` in `app/call_tracking.py` with enums and `extra="ignore"` to drop raw UA, raw audio, and unredacted PII. | M3 | Survey 2 / Plan §P0 |
| 13 | R3.4 Telemetry Ingestion Endpoints | Update `ChatRequest`, `CallTokenRequest`, and `EndCallRequest` in `app/chat_api.py` and `app/main.py` to accept and persist client telemetry. | M3 | Survey 2 / Plan §P0 |
| 14 | R3.5 Backend Telemetry Automated Tests | Automated tests in `tests/test_chat_api.py` and `tests/test_api.py` verifying `/v1/calls/end` accepts and persists telemetry, and privacy stripping works. | M3 | Survey 2 / Plan §P0 |
| 15 | R4.1 Privacy-Safe Frontend Feature Detection | Pure feature detection module `frontend/src/lib/telemetry.ts` for platform class (`desktop` vs `mobile`), browser engine (`chromium`, `webkit`, `gecko`, `unknown`), and mic permission without raw UA. | M4 | Survey 3 / Plan §P0 |
| 16 | R4.2 Speech Recognition Telemetry Counters | Augment `BrowserSpeechRecognition` in `frontend/src/lib/speech-recognition.ts` with echo suppression count, STT error count, and active input path inspection. | M4 | Survey 3 / Plan §P0 |
| 17 | R4.3 Call Session Telemetry Dispatch | Augment `frontend/src/components/ui/kokoro-call-session.tsx` to collect event latencies, error counts, and dispatch telemetry on greeting turn and call end (`/v1/calls/end` + `pagehide`). | M4 | Survey 3 / Plan §P0 |
| 18 | R4.4 Dashboard Attribution UI | Update `CallRecord` and components in `frontend/src/App.tsx` (`CallsTable`, `CallRow`, `MobileCallsList`, telemetry details drawer) with platform and input path badges. | M4 | Survey 3 / Plan §P0 |
| 19 | R4.5 Live Call Ended State Attribution | Display platform and input path indicators in `EndedState` within `frontend/src/components/ui/live-call-page.tsx`. | M4 | Survey 3 / Plan §P0 |
| 20 | R5.1 Full Suite Regression Verification | Run full pytest suite across backend (100% pass) with 0 modifications or row count changes to runtime `hvac_receptionist.db`. | M5 | Acceptance Criteria |
| 21 | R5.2 Code Quality & Static Typing Gates | Run `ruff check .` and `mypy --strict app` in backend (0 errors). | M5 | Acceptance Criteria |
| 22 | R5.3 Frontend Production Build Gate | Run `npm run build` in `frontend/` (0 errors). | M5 | Acceptance Criteria |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Test DB Isolation & Zero Contamination | Features 1-5 (conftest, reset_engine dispose, engine guard, fixture cleanup, isolation test) | none | DONE |
| 2 | Independent Stale-Call Reaper | Features 6-9 (decouple GET /v1/calls, reap_stale_calls, lifespan background task, autonomous reaper test) | M1 | DONE |
| 3 | Telemetry Schema & Backend Endpoints | Features 10-14 (db schema, migration, ClientTelemetry model, endpoint ingestion, automated tests) | M1 | DONE |
| 4 | Frontend Telemetry & Dashboard Attribution | Features 15-19 (feature detection, speech recognition metrics, call session dispatch, dashboard badges) | M3 | DONE |
| 5 | E2E Integration & Verification Gates | Features 20-22 (Full pytest, DB zero-pollution check, ruff, mypy, npm run build) | M1, M2, M3, M4 | DONE |

## Interface Contracts
### Frontend ↔ Backend Telemetry Contract
`POST /v1/calls/chat` (initial greeting turn) and `POST /v1/calls/end`:
```json
{
  "client_telemetry": {
    "platform_class": "desktop" | "mobile",
    "browser_engine": "chromium" | "webkit" | "gecko" | "unknown",
    "input_path": "native_web_speech" | "media_recorder_transcription",
    "mic_permission": "granted" | "denied" | "dismissed" | "unknown",
    "first_assistant_audio_ms": 1240 | null,
    "first_caller_transcript_ms": 2850 | null,
    "echo_suppressions": 0,
    "stt_errors": 0,
    "tts_errors": 0,
    "end_reason": "completed" | "user_hangup" | "error" | "reaped" | "unload"
  }
}
```

### Backend DB Schema Contract
`call_records` table:
- `platform_class`: `VARCHAR(16) NULL`
- `browser_engine`: `VARCHAR(16) NULL`
- `input_path`: `VARCHAR(32) NULL`
- `mic_permission`: `VARCHAR(16) NULL`
- `end_reason`: `VARCHAR(32) NULL`
- `client_metrics`: `TEXT NULL` (JSON-encoded dictionary of event metrics)

## Code Layout
- Backend: `c:\Users\TL\Documents\Codex\2026-08-27\referenced-chatgpt-conversation-this-is-an\backend`
  - `app/db.py`: Database engine, models, session, migration, isolation guard
  - `app/call_tracking.py`: Call session management, reaper logic, telemetry validation
  - `app/main.py`: Application lifespan, reaper task loop, token & calls endpoints
  - `app/chat_api.py`: Chat requests, SSE streaming, call finalization
  - `tests/conftest.py`: Test isolation fixtures, tmp_path database setup, environment monkeypatching
  - `tests/test_db_isolation.py`: Dedicated test suite verifying zero runtime DB modification
  - `tests/test_api.py`: API endpoint and reaper tests
  - `tests/test_chat_api.py`: Chat flow and call finalization tests
  - `tests/test_call_tracking.py`: Call tracking and reaper unit tests
- Frontend: `c:\Users\TL\Documents\Codex\2026-08-27\frontend`
  - `src/lib/telemetry.ts`: Feature detection and telemetry types
  - `src/lib/speech-recognition.ts`: Speech recognition with telemetry counters
  - `src/components/ui/kokoro-call-session.tsx`: Call session telemetry lifecycle
  - `src/components/ui/live-call-page.tsx`: Live call page with telemetry indicator
  - `src/App.tsx`: Admin dashboard with platform & input path badges
