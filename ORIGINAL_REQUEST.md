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


