# Project: HVAC Voice AI Receptionist — Round 8 Engineering & Verification

## Architecture
- **Target Environments**: Windows (Chromium / Edge / Firefox) and iOS (Safari / WebKit mobile).
- **Core Components**:
  - **Backend** (`referenced-chatgpt-conversation-this-is-an/backend`):
    - FastAPI voice receptionist application with SSE streaming (`/v1/calls/chat`).
    - Immediate clause-level streaming pipeline for low latency (<400ms TTFB).
    - Strict grammar-enforced OpenAI tool schemas (`strict: true`, `additionalProperties: false`, exhaustive `required` list with nullable types) for `book_appointment_tool`, `check_availability`, `reschedule_appointment_tool`, and `cancel_appointment_tool`.
    - Atomic ticket ledger synchronization in `_execute_tool` ensuring zero orphaned tickets.
    - Full-duplex interruption cancellation in `sse_generator` checking `request.is_disconnected()`.
  - **Frontend** (`frontend/`):
    - React + Vite voice application with Kokoro TTS audio player (`NeuralAudioPlayer`).
    - Delimiter-based clause splitting (`findClauseSplit`) on punctuation (`.`, `,`, `?`, `!`, `;`) without arbitrary length suppression, dispatching immediate audio prefetch and playback for short phrases ("Sure,", "Yes.", "Hi!").
    - Full-duplex speech recognition with acoustic echo discrimination (`isAcousticEcho`) triggering `onBargeIn()`.
    - Ultra-fast audio purge (<10ms) via anti-pop master gain ramping, active Web Audio source disconnection, and aborting in-flight prefetch controllers.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | R1.1 Clause Splitter Optimization | Remove `trimmed.length < 8` constraint in `findClauseSplit` (`text-normalization.ts`), allow immediate first-phrase dispatch on punctuation, retain cadence delimiters. | M1 | Survey Explorer 1 |
| 2 | R1.2 Granular Streaming of Deterministic Turns | Yield pre-scripted multi-clause responses (greeting, emergency, hours, recap) in clause increments in `chat_api.py` for steady TTS prefetching. | M1 | Survey Explorer 1 |
| 3 | R2.1 Strict OpenAI Tool Schemas | Update `BOOKING_TOOLS` in `chat_api.py` with `strict: True`, `additionalProperties: False`, all properties in `required`, and nullable types for optional fields. | M2 | Survey Explorer 2 |
| 4 | R2.2 Comprehensive Tool Registration & Availability | Add `check_availability` to `tools.py` and `BOOKING_TOOLS`; expose reschedule and cancel tools in `BOOKING_TOOLS`. | M2 | Survey Explorer 2 |
| 5 | R2.3 Atomic Ticket Ledger Synchronization | In `_execute_tool` (`chat_api.py`), atomically update existing `pending` ticket to `consumed` with `appointment_id` or link atomically to prevent orphaned tickets. | M2 | Survey Explorer 2 |
| 6 | R3.1 Full-Duplex Acoustic Barge-In Detection | Wire `this.onBargeIn?.()` in `speech-recognition.ts` when caller speech is recognized during playback, filtering speaker reflection via `isAcousticEcho`. | M3 | Survey Explorer 3 |
| 7 | R3.2 Backend Disconnect Polling & Turn Cancellation | In `chat_api.py:sse_generator`, poll `await request.is_disconnected()` to immediately abort token generation and tool execution on client barge-in. | M3 | Survey Explorer 3 |
| 8 | R3.3 Frontend Instant Audio Purge & State Reset | Verify `onBargeIn` triggers `NeuralAudioPlayer.stop()` (<10ms purge) and cleanly bumps speech epoch to resume listening without audio artifacts. | M3 | Survey Explorer 3 |
| 9 | R4.1 Automated Challenger Verification & Release Gate | Implement automated tests for TTFB <450ms, strict schema validation, ticket atomicity, and barge-in <100ms cancellation. Enforce 0 ruff errors, 0 mypy errors, 0 architecture violations, and 100% test pass. | M4 | Survey All |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Clause-Level Audio Streaming Pipeline (R1) | Features 1-2 (Clause splitter optimization in `text-normalization.ts`, granular streaming in `chat_api.py`) | none | DONE |
| 2 | Strict Grammar-Enforced Tool Schemas (R2) | Features 3-5 (Strict schema compliance in `BOOKING_TOOLS`, `check_availability` tool, atomic ledger sync in `_execute_tool`) | none | DONE |
| 3 | Full-Duplex Interruption & Cancellation (Barge-In) (R3) | Features 6-8 (`onBargeIn` trigger in `speech-recognition.ts`, backend disconnect polling in `chat_api.py`, <100ms audio purge) | M1 | DONE |
| 4 | Release Gate & Automated Challenger Verification (R4) | Feature 9 (Automated tests, verification harness runner, 100% backend & frontend tests pass, ruff, mypy, architecture check) | M1, M2, M3 | DONE |

## Interface Contracts
### 1. Clause Splitter Contract (`findClauseSplit`)
- Delimiters: `.` `,` `?` `!` `;` `\n` (excluding numbers like `10:30` or abbreviations like `Mr.`)
- Behavior: Immediate dispatch if `trimmed.length >= 2` for first phrases; retains delimiter for natural cadence in speech synthesis.
- Guarantee: First clause dispatched to `speakSentence` within <50ms of receipt.

### 2. Strict Tool Calling JSON Schema Contract
```json
{
  "type": "function",
  "function": {
    "name": "book_appointment_tool",
    "strict": true,
    "description": "Book an HVAC service appointment during business hours.",
    "parameters": {
      "type": "object",
      "properties": {
        "phone_number": { "type": "string", "description": "The caller's callback phone number." },
        "service": { "type": "string", "description": "The requested HVAC service." },
        "date": { "type": "string", "description": "Appointment date (YYYY-MM-DD)." },
        "time": { "type": "string", "description": "Appointment start time (HH:MM AM/PM)." },
        "name": { "type": ["string", "null"], "description": "The caller's name, if provided." },
        "notes": { "type": ["string", "null"], "description": "Optional details or symptoms." }
      },
      "required": ["phone_number", "service", "date", "time", "name", "notes"],
      "additionalProperties": false
    }
  }
}
```

### 3. Barge-In Interruption Contract
- Frontend: Caller speech detected during assistant playback -> validates `!isAcousticEcho(candidate)` -> invokes `onBargeIn()`:
  - Calls `abortController.abort()` to disconnect SSE fetch
  - Bumps `speechEpoch`
  - Calls `neuralVoice.stop()` (purges audio within <10ms via 8ms ramp down & buffer drop)
  - Resumes speech recognition immediately
- Backend: `sse_generator` checks `await request.is_disconnected()` -> breaks loop, terminates LLM generation, skips tool execution.

## Code Layout
- Backend: `referenced-chatgpt-conversation-this-is-an/backend`
  - `app/chat_api.py`: SSE generator, `BOOKING_TOOLS` strict schemas, `_execute_tool` ticket sync, disconnect checks.
  - `app/agent/tools.py`: Tool definitions with `@function_tool` strict schemas, `check_availability`.
  - `app/scheduling.py`: Booking validation, availability queries, slot propositions.
  - `tests/`: Isolated pytest test suites.
- Frontend: `frontend`
  - `src/lib/text-normalization.ts`: `findClauseSplit` clause boundary detection.
  - `src/lib/speech-recognition.ts`: Acoustic echo filtering, full-duplex speech recognition, `onBargeIn` trigger.
  - `src/lib/neural-audio-player.ts`: Web Audio scheduling, parallel prefetching, <10ms audio purge on stop.
  - `src/components/ui/kokoro-call-session.tsx`: Call session orchestration, SSE consumption, barge-in coordinator.
