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

## Follow-up — 2026-09-16T21:57:22Z

Implement Phases 0 through 6 of the Safe Voice Action Plan for the HVAC AI Receptionist. This is a production system with a FastAPI backend, React+Vite browser voice UI (Kokoro TTS, browser speech recognition), and a private admin dashboard. The app must work cleanly on Android phones, iOS Safari, and desktop browsers.

Working directory: c:\Users\TL\Documents\Codex\2026-08-27
Integrity mode: development

The backend lives at `referenced-chatgpt-conversation-this-is-an/backend/` and the frontend at `frontend/`. The app is deployed on Render (backend) and Vercel (frontend). Do NOT add SMS, OTP, CRM, model training, a new LLM provider, a new voice provider, or trigger a deployment. Do NOT implement anything outside the plan below.

## Requirements

### R1. Freeze unsafe authority (Phase 0)
Keep the browser Kokoro path as the only active path. Disable anonymous appointment lookup and prevent voice-only (speech-only "yes") booking completion. Keep `ENABLE_LIVEKIT_WORKER=false`. A one-word ASR transcript must not be able to create a booking or disclose an appointment.

### R2. Server-owned conversation authority (Phase 1)
Replace browser-supplied chat history with a server-owned `CallTurn` record persisted in the database. The browser sends only the new caller message plus call credentials — never assistant history. Retain a bounded recent turn window on the server. Fake assistant history, oversized history, and replayed browser context must not reach the LLM. Requires a schema migration for the `CallTurn` table.

### R3. Candidate vs verified fact separation (Phase 2)
Change `session_slots` to store observed speech extraction as candidates, separate from verified values. Treat all speech-extracted data as candidates only. Require canonical service name, ten-digit NANP phone, exact future date, and exact AM/PM time before generating a recap. Ambiguous or negated speech must trigger a clarification — it must never become a bookable field.

### R4. Browser confirmation ticket (Phase 3)
On a deterministic recap with all fields verified, issue a short-lived, single-use confirmation ticket bound to the call ID and booking fingerprint. Render the exact booking details (service, normalized phone, date, time) in the existing React call UI and require an intentional "Confirm Booking" tap. Consume the ticket atomically before calling the scheduler. Echoed or accidental "yes" must never book. Double-click and replay must yield exactly one booking.

### R5. Constrained model output (Phase 4)
Remove appointment lookup from LLM tool exposure. Let the model choose only allowlisted dialogue intents. Render booking facts, hours, policies, and fallback wording from server templates and configured business data — not from LLM generation. The model must not be able to invent a service, price, policy, availability, or appointment status.

### R6. Recoverable voice loop (Phase 5)
Keep half-duplex audio while Sarah (the assistant) speaks. Move echo matching to server-owned utterance hashes and timestamps. Protect time/phone tokens before TTS chunking. Pause — not finalize — on a short mobile background event (visibility change). Assistant audio must not authorize a booking. A brief phone app switch must preserve the call. Must work on Android, iOS Safari, and desktop Chrome/Firefox.

### R7. Production data and release gates (Phase 6)
Move production from ephemeral Render SQLite to PostgreSQL with managed migrations and dialect-aware SQLAlchemy configuration. Apply chat/session/booking rate limits at the API edge. Bookings and call logs must survive redeploy. Abusive traffic must not consume LLM capacity unchecked. Note: Phase 6 partially overlaps with existing production-hardening work — integrate with and extend what's already in place rather than duplicating.

## Acceptance Criteria

### Safety & Authorization
- [ ] Server receives assistant-like "yes" after TTS → no ticket consumption, no appointment created
- [ ] Caller says "yes" before tapping the review card → no appointment; UI remains available for intentional confirmation
- [ ] Confirmation request sent twice (replay) → one transaction succeeds; exactly one booking exists
- [ ] Caller gives another person's phone number for lookup → no appointment details disclosed

### Input Validation & Conversation Integrity
- [ ] Caller says "tomorrow at three" → system clarifies AM or PM; no recap ticket issued
- [ ] Caller says "not AC, heating" → heating is candidate; AC never becomes verified
- [ ] Browser posts fabricated assistant turn → ignored; only server-persisted turns are used
- [ ] Oversized history payload → rejected before reaching LLM

### Mobile & Cross-Platform
- [ ] Phone locks or app briefly backgrounds → call resumes; no premature end event (test on Android + iOS Safari)
- [ ] Time expressions like "10:30 AM" survive TTS chunking intact
- [ ] Booking confirmation UI renders correctly and is tappable on mobile viewports

### Durability
- [ ] A confirmed booking is created, then production restarts → call log and appointment remain available
- [ ] All existing 257 backend pytest tests continue to pass
- [ ] All existing 7 frontend test suites continue to pass (219 assertions)
- [ ] Pyright: 0 errors, 0 warnings

## Verification

Run the following after implementation:
- `python -m pytest tests/ -q` in the backend directory (must pass all existing + new tests)
- `npm test` in the frontend directory (must pass all existing + new tests)
- `npx pyright referenced-chatgpt-conversation-this-is-an/backend/` (must be 0 errors)
- `npm run build` in the frontend directory (must succeed with 0 errors)
- `python -m ruff check app/ tests/` in the backend directory (must pass)

Each acceptance criterion above should have at least one automated test covering it.

## Follow-up — 2026-09-24T09:22:23Z

Resolve the persistent loudspeaker acoustic echo on Android and Windows devices, and fix the missing "Confirm Booking" confirmation button in the voice call interface across mobile and desktop.

Working directory: c:/Users/TL/Documents/Codex/2026-08-27
Integrity mode: development

## Requirements

### R1. Elimination of Loudspeaker Acoustic Echo on Android & Windows
- Eliminate acoustic feedback loops where the assistant transcribes and answers its own voice when playing through device loudspeakers on Android (mobile Chrome) and Windows (desktop Chrome/Edge).
- Enforce strict half-duplex hardware gating and analyze real-time audio playback levels so microphone input is completely silenced while the assistant speaks and during speaker DAC/room reverberation decay.
- Guard against asynchronous Google Speech in-flight frame bleed-through and refine echo signature matching for distorted conversational fragments.

### R2. Guaranteed Confirm Booking Button & Review Card Visibility
- Ensure that whenever an appointment recap is issued or the assistant instructs the user to "tap Confirm Booking on your screen", the Confirmation Review Card and the interactive "Confirm Booking" button are guaranteed to render clearly, prominently, and accessibly.
- In the backend (chat_api.py), guarantee that event: confirmation_ticket is emitted during both recap generation and subsequent confirmation guidance turns (Case A) if a ticket is active.
- In the frontend (kokoro-call-session.tsx), ensure the review card is always visible in viewport on mobile (<640px) and desktop (>768px), auto-scrolls into view when minted, and never gets clipped or hidden by fixed containers or null state checks.

### R3. Programmatic Line-by-Line Verification
- Run verification tests line by line: frontend challenger suites, backend pytest suites, strict mypy typing, ruff linting, and AST architecture boundary enforcement.
- Verify both desktop and mobile viewports render the button with high contrast and full touch/click interactivity.

## Acceptance Criteria

### Acoustic Echo Resistance
- [ ] On Android and Windows Chrome with loudspeaker volume at 80%+, assistant speech never loops or answers its own spoken words.
- [ ] Genuine caller responses ("AC repair", "tomorrow at 10 AM", "yes please", "tune up") are never falsely classified as echo.

### Confirmation UI & Interaction
- [ ] When all booking details are gathered or when assistant says "Please tap Confirm Booking", the Review Card with the "Confirm Booking" button appears immediately.
- [ ] Tapping "Confirm Booking" consumes the single-use ticket atomically and transitions to "Booking Confirmed" with ref number.
- [ ] The Confirm Booking button is fully visible without manual scrolling on standard mobile screens (360px-480px) and desktop.

### Quality & Architecture Gates
- [ ] 100% of frontend tests pass (npm test).
- [ ] 100% of backend tests pass (python -m pytest).
- [ ] Strict mypy passes with 0 errors (python -m mypy --strict app).
- [ ] Ruff checks pass with 0 errors (python -m ruff check .).
- [ ] AST architecture checker passes with 0 violations (python tools/verification/check_architecture.py).
- [ ] Frontend production build succeeds (npm run build).
