# Project: HVAC Voice Receptionist Android Mobile Compatibility & Optimization

## Architecture
- **Target Platforms**: Android Mobile Browsers (Android Chrome 120+, Samsung Internet 23+, Android WebView / Mobile Chromium).
- **Audio Pipeline Architecture**:
  - `frontend/src/lib/neural-audio-player.ts`: Web Audio Context instantiation, synchronous touch-gesture unlock via 1-sample silent buffer, DAC pre-warming, and streaming TTS playback.
  - `frontend/src/lib/speech-recognition.ts`: Browser Speech Recognition with automatic fallback. Configured with native `webkitSpeechRecognition` (Google Speech on Android), 150ms backoff restart guard on `onend`, 1,100ms acoustic cooldown, physical track gating (`MediaStreamTrack.enabled = false`), acoustic echo suppression whitelist, and high-fidelity `MediaRecorder` (`audio/webm;codecs=opus`) fallback via Groq Whisper (`/v1/calls/transcribe`).
- **Responsive Viewport & Mobile Layout**:
  - `frontend/index.html`: Optimized viewport meta tag (`viewport-fit=cover, interactive-widget=resizes-content`).
  - `frontend/src/index.css`: Dynamic viewport height baseline (`100dvh`), `touch-action: manipulation` (zero 300ms double-tap delay), and `.touch-target-44` accessibility utilities.
  - `frontend/src/App.tsx`: Dynamic viewport shell (`min-h-[100dvh] h-[100dvh]`), compact 360px-480px scrollable filter pills, and mobile thumb-friendly action buttons.
  - `frontend/src/components/ui/kokoro-call-session.tsx`: Call session management, 64px primary call controls, >=44px "Tap to Interrupt" pill button, and dual lifecycle listeners (`pagehide` + `visibilitychange`).
  - `frontend/src/components/ui/hover-reveal-cards.tsx`: Mobile touch optimization (removing sticky simulated hover blur).
  - `frontend/src/components/ui/mobile-agenda-view.tsx`: Responsive agenda with >=44px touch targets.
- **Android Lifecycle & Call Finalization**:
  - Dual `pagehide` and `visibilitychange` (`document.visibilityState === "hidden"`) hooks.
  - Fire-and-forget call finalization via `fetch(apiUrl("/v1/calls/end"), { keepalive: true })` with JSON payload and fallback to `navigator.sendBeacon`.
  - Stale-call reaper in backend lifespan sweeping abandoned calls after 20 minutes.
- **Backend Architecture**:
  - FastAPI application in `referenced-chatgpt-conversation-this-is-an/backend` with isolated test database, privacy-safe telemetry ingestion (`platform_class`, `browser_engine`, `input_path`, `end_reason`), and Whisper transcription.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | R1.1 Synchronous AudioContext Resume Await | Await `ctx.resume()` in `neural-audio-player.ts` (`scheduleAudioBuffer`) to prevent audio clock drift after interruption or suspension. | M1 | Survey (Audio Explorer §Gap 1) |
| 2 | R1.2 Audio Context Visibility Re-wake | Re-wake suspended AudioContext on `visibilitychange` (`visible`) and `focus` in `kokoro-call-session.tsx` / `neural-audio-player.ts`. | M1 | Survey (Audio Explorer §Gap 2) |
| 3 | R1.3 Android STT onend Backoff Restart | Introduce 150ms backoff restart in `speech-recognition.ts:onend` to prevent premature `InvalidStateError` during Android HAL unbinding. | M1 | Survey (Spec Miner §9, Audio Explorer §Gap 3) |
| 4 | R1.4 Shared AudioContext for Fallback VAD | Share or synchronously prime `AudioContext` for `MediaRecorder` fallback VAD to prevent suspended context on mobile Chromium. | M1 | Survey (Audio Explorer §Gap 4) |
| 5 | R1.5 Echo Suppression Greeting Whitelist | Add conversational greetings ("hello", "hi", "hey", "hi there", "hello there", "good morning") to `GENUINE_CONFIRMATIONS` in `speech-recognition.ts`. | M1 | Survey (Audio Explorer §Gap 5) |
| 6 | R1.6 Explicit Mono getUserMedia Constraint | Add `channelCount: 1` alongside `echoCancellation: true, noiseSuppression: true, autoGainControl: true` in `live-call-page.tsx` and `speech-recognition.ts`. | M1 | Survey (Audio Explorer §Gap 6) |
| 7 | R2.1 Enhanced Viewport Meta Tag | Update `frontend/index.html` viewport meta tag to include `viewport-fit=cover, interactive-widget=resizes-content`. | M2 | Survey (UI Explorer §Rec 1) |
| 8 | R2.2 Dynamic Viewport Height (dvh) Shell | Update `index.css` (`html, body, #root`) and `App.tsx` (`app-shell`) to use `min-h-[100dvh] h-[100dvh]` to prevent address bar clipping. | M2 | Survey (UI Explorer §Rec 2, 3) |
| 9 | R2.3 Double-Tap Delay Elimination | Set `touch-action: manipulation` on interactive elements in `index.css` to eliminate 300ms mobile tap delay. | M2 | Survey (UI Explorer §Rec 2) |
| 10 | R2.4 Compact Filter Bar Overflow Fix | Add `overflow-x-auto no-scrollbar flex-nowrap shrink-0` to Calls Page filter bar in `App.tsx:918` for 360px screen compatibility. | M2 | Survey (UI Explorer §Rec 3) |
| 11 | R2.5 Minimum 44x44px Touch Targets | Enlarge interactive elements across `kokoro-call-session.tsx` ("Tap to Interrupt"), `App.tsx` (top bar, card actions), and `mobile-agenda-view.tsx`. | M2 | Survey (UI Explorer §Rec 3, 4, 6) |
| 12 | R2.6 Mobile Hover Blur Fix | Remove `group-hover:blur-[2px]` and related classes from `hover-reveal-cards.tsx` to eliminate sticky simulated hover blur on mobile touchscreens. | M2 | Survey (UI Explorer §Rec 5) |
| 13 | R3.1 Dual Android Lifecycle Finalization | Bind call finalization to both `window.pagehide` and `document.visibilitychange` (`hidden`) in `kokoro-call-session.tsx`. | M2 | Survey (Spec Miner §15, UI Explorer §Rec 4) |
| 14 | R3.2 Primary Keepalive Fetch Dispatch | Prioritize `fetch(apiUrl("/v1/calls/end"), { method: "POST", keepalive: true })` over `sendBeacon` to prevent CORS preflight drops during unload. | M2 | Survey (Spec Miner §18, UI Explorer §Rec 4) |
| 15 | R3.3 Safe Summary & Telemetry Persistence | Ensure `end_reason = "page_unload"`, `platform_class = "mobile"`, and `browser_engine = "chromium"` are cleanly dispatched and stored. | M2 | Survey (UI Explorer §Rec 4) |
| 16 | R4.1 Frontend Normalization Test Suite | Run `npm test` verifying 20/20 spoken-text normalization tests pass. | M3 | Acceptance Criteria |
| 17 | R4.2 Frontend Production Build Gate | Run `npm run build` verifying 0 TypeScript errors and 0 Vite warnings. | M3 | Acceptance Criteria |
| 18 | R4.3 Backend Test Suite Isolation Gate | Run `python -m pytest` verifying 244/244 tests pass with zero runtime DB pollution. | M3 | Acceptance Criteria |
| 19 | R4.4 Backend Code Quality & Typing Gate | Run `python -m ruff check .` and `python -m mypy --strict app` with 0 errors. | M3 | Acceptance Criteria |
| 20 | R4.5 Production Health Verification | Verify `https://hvac-receptionist.onrender.com/health` returns HTTP 200 `{"status":"ok"}`. | M3 | Acceptance Criteria |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Android Audio Pipeline & Web Audio Hardening | Features 1-6 (AudioContext await, visibility re-wake, STT onend backoff, shared fallback VAD ctx, greeting whitelist, mono mic constraint) | none | DONE |
| 2 | Mobile Viewport, Responsive UX, Touch Targets & Lifecycle | Features 7-15 (meta viewport, dvh shell, touch-action, filter overflow, 44px touch targets, mobile hover fix, dual lifecycle listeners, keepalive fetch) | M1 | PLANNED |
| 3 | Comprehensive Verification, Regression Gates & Production Health | Features 16-20 (npm test 20/20, Vite build, pytest 244/244 isolated, ruff, strict mypy, Render production health) | M1, M2 | PLANNED |

## Interface Contracts
### End Call Telemetry Contract (`POST /v1/calls/end`)
```json
{
  "session_id": "string",
  "call_id": "string",
  "call_secret": "string",
  "outcome": "booked" | "info_only" | "in_progress",
  "summary": "string (max 3000 chars)",
  "client_telemetry": {
    "platform_class": "mobile" | "desktop",
    "browser_engine": "chromium" | "webkit" | "gecko" | "unknown",
    "input_path": "native_web_speech" | "media_recorder_transcription",
    "mic_permission": "granted" | "denied" | "dismissed" | "unknown",
    "end_reason": "page_unload" | "user_hangup" | "completed" | "error" | "reaped",
    "first_assistant_audio_ms": 1240,
    "first_caller_transcript_ms": 2850,
    "echo_suppressions": 0,
    "stt_errors": 0,
    "tts_errors": 0
  }
}
```

## Code Layout
- Frontend: `c:\Users\TL\Documents\Codex\2026-08-27\frontend`
  - `index.html`: Viewport meta tag
  - `src/index.css`: Viewport sizing (`dvh`), `touch-action`, touch target utilities
  - `src/App.tsx`: App shell layout, compact filter bar, dashboard touch targets
  - `src/lib/neural-audio-player.ts`: AudioContext management, silent buffer unlock, await resume
  - `src/lib/speech-recognition.ts`: Speech recognition, onend backoff, echo whitelist, MediaRecorder fallback
  - `src/components/ui/kokoro-call-session.tsx`: Call session, touch targets, dual pagehide/visibilitychange lifecycle
  - `src/components/ui/live-call-page.tsx`: Start call touch gesture, mono mic constraints
  - `src/components/ui/hover-reveal-cards.tsx`: Mobile hover blur elimination
  - `src/components/ui/mobile-agenda-view.tsx`: Mobile agenda touch targets
- Backend: `c:\Users\TL\Documents\Codex\2026-08-27\referenced-chatgpt-conversation-this-is-an\backend`
  - `app/db.py`: Database models & test isolation guards
  - `app/call_tracking.py`: Telemetry models & reaper
  - `app/chat_api.py`: Chat & Whisper endpoints
  - `app/main.py`: Lifespan background reaper & health check
  - `tests/`: 244 isolated tests with runtime DB isolation
