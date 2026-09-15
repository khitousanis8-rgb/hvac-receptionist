# Original User Request

## Initial Request — 2026-09-13T22:56:20Z

Implement Phase 1 (Test Database Isolation & Independent Stale-Call Reaper) and Phase 2 (Privacy-Safe Client Platform & Audio Telemetry) from the HVAC Voice Receptionist refinement plan.

Working directory: c:/Users/TL/Documents/Codex/2026-08-27
Integrity mode: development

## Reference Specification
- Plan document: `CALL_LOG_PLATFORM_PROMPT_FIX_PLAN.md` (Phases 1 & 2)
- Backend directory: `referenced-chatgpt-conversation-this-is-an/backend`
- Frontend directory: `frontend`

## Requirements

### R1. Phase 1 — Test Database Isolation & Zero Runtime DB Pollution
- Audit and isolate all backend test suites in `referenced-chatgpt-conversation-this-is-an/backend/tests/` (including `test_chat_api.py`, `test_call_tracking.py`, `test_api.py`, etc.).
- Ensure tests run exclusively against isolated temporary SQLite databases (`tmp_path`) with `reset_engine()` teardown.
- Tests must never create, read, or persist rows in the repository's runtime `hvac_receptionist.db`.
- Add an automated test or fixture verification ensuring that running `pytest` produces zero row count change or file modification to the runtime database.

### R2. Phase 1 — Independent Stale-Call Finalization Reaper
- Decouple the stale call cleanup from `GET /v1/calls` dashboard page loads.
- Implement an independent background/scheduled periodic reaper task that sweeps calls older than 20 minutes with `ended_at is None`, finalizes them with calculated `ended_at = started_at + timedelta(minutes=3)`, assigns the proper outcome (`booked` if slots were confirmed, else `info_only`), and writes a clear finalization summary.
- Ensure the background reaper is resilient, thread-safe, and gracefully shuts down with the FastAPI application.

### R3. Phase 2 — Privacy-Safe Client Platform & Audio Telemetry Schema
- Extend the `CallRecord` model in `backend/app/db.py` (with backwards-compatible SQLite migration in `init_db`) to store structured, privacy-safe telemetry:
  - `platform_class`: `desktop` or `mobile`
  - `browser_engine`: `chromium`, `webkit`, `gecko`, or `unknown`
  - `input_path`: `native_web_speech` or `media_recorder_transcription`
  - `mic_permission`: `granted`, `denied`, `dismissed`, or `unknown`
  - Client event metrics: first assistant audio timestamp, first caller transcript timestamp, echo suppression count, STT error count, TTS error count, end reason.
- Do NOT record raw user-agent strings, raw audio, or unredacted conversational PII in the telemetry object.
- Update `ChatRequest`, `CallTokenRequest`, and `EndCallRequest` endpoints to accept and persist client telemetry.

### R4. Phase 2 — Frontend Telemetry Collection & Dashboard Attribution
- In `frontend/src/lib/speech-recognition.ts` and `frontend/src/components/ui/kokoro-call-session.tsx`:
  - Detect platform class (`mobile` vs `desktop`) and browser engine (`webkit`, `chromium`, `gecko`) via standard feature detection (e.g. `navigator.userAgentData`, touch/media queries, vendor prefix) without logging raw UA strings.
  - Track microphone permission state, active input path (`native_web_speech` vs `media_recorder_transcription`), and audio event counts.
  - Dispatch telemetry upon call start and call end (`/v1/calls/end`).
- In `frontend/src/components/ui/live-call-page.tsx` and admin dashboard endpoints:
  - Display desktop vs. mobile attribution and input path indicators for call records.

## Acceptance Criteria

### Automated Testing & Verification
- [ ] `python -m pytest` passes 100% of test suites in `referenced-chatgpt-conversation-this-is-an/backend` with zero test contamination in runtime `hvac_receptionist.db`.
- [ ] A dedicated test confirms that running tests does not modify the runtime database file or alter its row counts.
- [ ] An automated test proves the stale-call reaper automatically finalizes abandoned calls without requiring `GET /v1/calls` to be queried.
- [ ] Automated tests verify that `/v1/calls/end` accepts and persists `client_telemetry` fields (`platform_class`, `browser_engine`, `input_path`, `mic_permission`).
- [ ] `python -m ruff check .` and `python -m mypy --strict app` pass with 0 errors.
- [ ] `npm run build` in `frontend/` succeeds with 0 errors.

## Follow-up — 2026-09-14T18:43:23Z

Audit, optimize, and thoroughly verify that the HVAC Voice Receptionist web application operates smoothly, healthily, and robustly on Android mobile phones (Android Chrome, Samsung Internet, and mobile Chromium browsers).

Working directory: c:/Users/TL/Documents/Codex/2026-08-27
Integrity mode: development

## Requirements

### R1. Android Audio Pipeline & Web Audio Unlock
- Verify and harden the touch-gesture Web Audio Context unlock on Android Chrome and mobile browsers to ensure speech synthesis audio plays immediately without autoplay policy blocks.
- Verify that Android microphone permission handling works smoothly during the call-start user gesture with echo cancellation, noise suppression, and automatic gain control enabled.
- Verify seamless operation of both native `webkitSpeechRecognition` (Google Speech on Android Chrome) and the high-fidelity `MediaRecorder` (`audio/webm;codecs=opus`) fallback.
- Ensure the hardware track gating, 1,100ms acoustic cooldown, and prefix/suffix echo guard completely eliminate loudspeaker acoustic feedback on Android devices.

### R2. Mobile Viewport, Responsive UX & Touch Targets
- Audit and optimize the responsive UI across standard Android screen widths (360px, 390px, 412px, 480px), ensuring dynamic viewport sizing (`dvh`) prevents clipping when the mobile address bar expands or collapses.
- Ensure all interactive buttons (Start Call, Mute, Interrupt, End Call, Tab Navigation) have touch targets of at least 44x44px with touch feedback and no double-tap zoom interference.
- Verify that live call state, transcript drawer, and booking confirmations render cleanly without horizontal overflow or clipped text on mobile viewports.

### R3. Android Lifecycle, App Switching & Graceful Finalization
- Verify that switching apps, locking the screen, or closing the tab on Android triggers the `pagehide` beacon / keepalive request to finalize the active call record cleanly with `end_reason = "page_unload"`.
- Ensure network latency spikes or transient audio dropouts on mobile connections recover gracefully without freezing the session or leaving orphaned audio streams.

### R4. Automated Testing & Verification
- Execute programmatic verification including TypeScript compiles, Vite builds, and test suites.
- Verify that client platform detection on Android identifies `platform_class: "mobile"` and `browser_engine: "chromium"` (or `gecko`) correctly.
- Ensure 100% backend test pass rate (all 244 tests isolated), 0 strict mypy errors, and 0 ruff errors.

## Acceptance Criteria

### Android Audio & Speech Pipeline
- [ ] Direct touch gesture unlocks Web Audio and microphone permission without playback stutter or autoplay blocks on Android mobile.
- [ ] Speech recognition on Android transcribes user speech cleanly with zero stuck states.
- [ ] Loudspeaker playback does not re-trigger speech recognition as acoustic echo.
- [ ] `MediaRecorder` fallback encodes valid WebM Opus chunks that successfully transcribe via the Whisper API.

### Responsive Mobile UI
- [ ] UI renders cleanly on mobile screen widths (360px to 480px) with zero horizontal scrollbar or element overflow.
- [ ] All action buttons meet the 44px touch target standard for comfortable one-handed thumb interaction.
- [ ] Admin dashboard call logs, badges, and diagnostics are fully legible and responsive on Android screens.

### Automated Test & Production Integrity
- [ ] `npm test` passes 100% of spoken-text normalization tests (20/20) in `frontend/`.
- [ ] `npm run build` succeeds with 0 errors and 0 warnings in `frontend/`.
- [ ] `python -m pytest` passes 100% of tests (244 passed) in `referenced-chatgpt-conversation-this-is-an/backend`.
- [ ] Strict type-checking (`python -m mypy --strict app`) and linting (`python -m ruff check .`) pass with 0 errors.
- [ ] Live Render production endpoints (`https://hvac-receptionist.onrender.com/health`) remain healthy.

## Follow-up — 2026-09-15T12:59:00Z

Implement Phases 1 through 4 of the production-hardening plan for this HVAC receptionist. Start from the current clean main branch and create small, reviewable commits. Do not modify the voice-provider setup, add a third-party identity provider, or deploy until the implementation and tests are complete.

Working directory: c:/Users/TL/Documents/Codex/2026-08-27
Integrity mode: development

## Requirements

### R1. Phase 1 — Durable Booking & Call-Log Storage (PostgreSQL & Migrations)
- Replace ephemeral production SQLite with managed PostgreSQL and repeatable migrations; make engine configuration dialect-aware (pass `check_same_thread: False` only to SQLite, handle connection pool settings for Postgres).
- Require `DATABASE_URL` in production; fail closed without silent fallback to ephemeral in-container SQLite (allow SQLite only in development/test or if explicitly configured).
- Preserve the booked-slot partial unique index (`uq_appointments_booked_scheduled_for` where `status = 'booked'`) across both PostgreSQL and SQLite.
- Ensure cancellation allows time slots to be reused cleanly and idempotently.

### R2. Phase 2 — Privacy, Authorization & Abuse Controls
- Remove `check_my_appointments` from anonymous browser voice turns and LiveKit tool exposure. Provide a neutral spoken fallback stating that the receptionist can help arrange a new visit, while checking or modifying existing appointments requires a verified channel.
- Centralize strict 10-digit NANP phone normalization and validation across all entrypoints (slots, API request models, scheduling, and phone updates). Reject 7-digit or malformed numbers from booking.
- Enforce maximum chat history count and character limits at the request boundary (Pydantic models) before parsing, prompt assembly, or LLM invocation (reject oversized history payloads with HTTP 422).
- Enforce server-side rate limits on session creation and chat messages before calling the LLM.
- Trust forwarded IP headers (`X-Forwarded-For`) only when arriving from an explicitly configured trusted proxy list/CIDR.
- Move TTS text to a POST request body endpoint (or support POST for `/v1/voice/stream`) and set `Cache-Control: private, no-store` on user-specific synthesized speech responses.

### R3. Phase 3 — Voice Correctness & Mobile Continuity
- Tokenize and protect spoken expressions (times like `10:30 AM`, `5:05 PM`, phone numbers, contractions, and abbreviations) before sentence splitting so that clauses never split in the middle of time or number expressions.
- Treat document visibility changes (`visibilitychange: hidden`) on mobile as suspended with a grace period (e.g. 30-60s) rather than an immediate terminal unload.
- Ensure terminal finalization occurs only upon explicit hangup, actual page unload (`pagehide`), or grace period expiration.

### R4. Phase 4 — Executable Regression Tests & Safe Alternate Paths
- Ensure all voice challenger suites (normalization, audio, speech, lifecycle, touch targets) are integrated and executable from the standard frontend test runner (`npm test`).
- Enforce the server-side deterministic booking state machine as the sole authority for creating bookings across all routes, ensuring any LiveKit or alternate voice paths cannot bypass server validation or recap/confirmation.

## Acceptance Criteria

### Data Durability & Migrations
- [ ] Database engine connects to PostgreSQL and SQLite cleanly with dialect-appropriate options.
- [ ] Missing `DATABASE_URL` in production fails closed with a clear configuration error.
- [ ] Booked-slot partial unique index functions identically on PostgreSQL and SQLite, allowing slot reuse upon cancellation.
- [ ] Migration scripts apply cleanly from scratch and idempotently on existing databases.

### Privacy & Abuse Controls
- [ ] Anonymous voice callers cannot access or query existing appointment details by phone number alone.
- [ ] Oversized chat history (> limit) is rejected with HTTP 422 at request validation before LLM invocation.
- [ ] Rate limits return HTTP 429 before invoking the model when thresholds are exceeded.
- [ ] Client IP extraction ignores untrusted `X-Forwarded-For` headers unless configured.
- [ ] Seven-digit phone numbers are rejected from booking; only valid 10-digit NANP numbers succeed.
- [ ] Synthesized voice responses for dynamic text use POST and include `Cache-Control: private, no-store`.

### Voice Chunking & Mobile Continuity
- [ ] Spoken-text normalizer and sentence chunker protect times (`10:30 AM`), phone numbers, and contractions from mid-expression fragmentation.
- [ ] Short background/foreground switching on mobile does not terminate the call session.
- [ ] Explicit call end cleanly finalizes the call once.

### Automated Test & Production Integrity
- [ ] `npm test` in `frontend/` runs all test suites with 100% pass rate.
- [ ] `npm run build` in `frontend/` succeeds with 0 errors.
- [ ] `python -m pytest` passes 100% in `referenced-chatgpt-conversation-this-is-an/backend`.
- [ ] `python -m ruff check .` and `python -m mypy --strict app` pass with 0 errors.
