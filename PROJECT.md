# Project: HVAC Voice AI Receptionist — Round 7 Engineering & Verification

## Architecture
- **Target Environments**: Windows (Chromium / Edge / Firefox) and iOS (Safari / WebKit mobile).
- **Core Components**:
  - **Backend** (`referenced-chatgpt-conversation-this-is-an/backend`):
    - FastAPI voice receptionist application with SSE streaming (`/v1/calls/chat`).
    - Deterministic booking state machine with atomic tool validation (`book_appointment`, `reschedule_appointment_tool`, `cancel_appointment_tool`).
    - Proactive conflict recovery via `find_nearest_available_slots` across all conflict, closed-day, and off-hour scenarios.
    - Consultative, empathetic HVAC sales-representative persona prompts and few-shot dialogues in `agent/prompts.py`.
    - Multi-tiered acoustic echo detection (`_is_echo_of_assistant`) with zero false-drop shields for objections, dates/times, phone digits, and voice confirmations.
    - Verified call finalization ensuring `outcome = "booked"` is committed to the database.
  - **Frontend** (`frontend/`):
    - React + Vite voice application with Kokoro TTS audio player (`NeuralAudioPlayer`).
    - WebAudio unlock lifecycle for iOS Safari with synchronous user-gesture activation and suspension/interruption recovery.
    - Hardware-isolated half-duplex gating (`MediaStreamTrack.enabled = false`) during speech playback with monotonic turn epoch tracking.
    - Real-time `AnalyserNode` loudspeaker silence decay verification (`minFloorMs = 450ms`, `targetDb = -55 dBFS`, 4 frames $< -60\text{ dBFS}$) for Windows WASAPI capture.
    - Text normalization preprocessor converting acronyms ("HVAC" -> "H-V-A-C"), dates, and times into natural spoken prose.
    - Dual utterance registration in EchoGuard ensuring token synchronization with physical acoustic output.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | R1.1 Backend Objection Apostrophe Fix | Fix `chat_api.py:258` apostrophe stripping so objection phrases like "I don't have a phone number" are preserved. | M1 | Survey Explorer 1 |
| 2 | R1.2 Backend Temporal Tokenization Fix | Fix `chat_api.py:301` whitespace split so "o clock", digits, and time indicators are preserved. | M1 | Survey Explorer 1 |
| 3 | R1.3 Frontend EchoGuard Objection Shield | Add caller objection phrase shield to `isAcousticEcho` in `speech-recognition.ts`. | M1 | Survey Explorer 1 |
| 4 | R1.4 Frontend Spoken Digit Word Counter | Add spoken digit word counter (`SPOKEN_DIGIT_WORDS`) to `speech-recognition.ts` so words like "five five five..." are never dropped. | M1 | Survey Explorer 1 |
| 5 | R1.5 Windows WASAPI Silence Decay & iOS Gating | Enforce `minFloorMs = 450ms`, `targetDb = -55 dBFS` on Windows and `minFloorMs = 250ms`, `targetDb = -50 dBFS` on iOS. | M1 | Survey Explorer 1 |
| 6 | R1.6 Confirmation Lexicon in Echo Shields | Add "lock it in" and affirmative variants to `affirmative_phrases` and `GENUINE_CONFIRMATIONS`. | M1 | Survey Explorer 1 |
| 7 | R3.1 Consultative Sales Prompt & Few-Shots | Update `agent/prompts.py` to remove anti-sales bans and establish a warm, consultative sales representative persona with few-shot dialogues. | M2 | Survey Explorer 3 |
| 8 | R3.2 Backend Deterministic Dialogue Humanization | Humanize canned prompts in `chat_api.py` (replace "quick yes or no" with consultative closing, humanize missing slot questions). | M2 | Survey Explorer 3 |
| 9 | R3.3 Backend Natural Spoken Slot & Hours Formatting | Update `scheduling.py` (`format_available_slot_for_speech`) and `intent.py` (`format_opening_hours_speech`) to format times as natural spoken prose. | M2 | Survey Explorer 3 |
| 10 | R3.4 Kokoro TTS Acronym Pronunciation ("H-V-A-C") | Normalize "HVAC" to letter-by-letter "H-V-A-C" and expand domain acronyms in `text-normalization.ts`. | M2 | Survey Explorer 3 |
| 11 | R3.5 Natural Spoken Times & Ordinal Dates | Format times ("six in the evening") and dates ("October twelfth") as natural spoken prose in `text-normalization.ts`. | M2 | Survey Explorer 3 |
| 12 | R3.6 Echo Guard Utterance Token Synchronization | Register both raw and normalized spoken text in `speechRecRef` in `kokoro-call-session.tsx` to eliminate echo token desynchronization. | M2 | Survey Explorer 3 |
| 13 | R2.1 100% Voice Autonomy ("Lock it in") | Expand `is_explicit_booking_confirmation` in `booking_policy.py` to accept "lock it in", "let's do it", and variants with zero screen interaction. | M3 | Survey Explorer 2 |
| 14 | R2.2 Atomic Tool Validation & Ticket Ledger Sync | In Case A voice booking, execute `book_appointment_tool`, atomically mark `ConfirmationTicket` as consumed, and emit `event: tool_call`. | M3 | Survey Explorer 2 |
| 15 | R2.3 Proactive Conflict & Off-Hours Slot Recovery | Proactively suggest nearest available slots when a requested slot is booked, outside hours, or on a closed day. | M3 | Survey Explorer 2 |
| 16 | R2.4 Voice Reschedule & Cancellation Flow | Route reschedule and cancellation voice requests cleanly to `reschedule_appointment_tool` and `cancel_appointment_tool`. | M3 | Survey Explorer 2 |
| 17 | R2.5 Verified Call Finalization | Verify database appointment commitment before finalizing call record with `outcome = "booked"`. | M3 | Survey Explorer 2 |
| 18 | R4.1 Frontend Test Suite Integration | Integrate adversarial challenger suites into `run-tests.mjs`, verifying 171+ frontend tests pass via `npm test`. | M4 | Survey All |
| 19 | R4.2 Backend Unit & Tone Test Suite | Add `test_tone_and_normalization.py` and scheduling unit tests verifying 100% backend test pass rate via `pytest`. | M4 | Survey All |
| 20 | R4.3 Production Verification Release Gate | Enforce 0 ruff errors, 0 strict mypy errors, 0 AST architecture violations, clean `npm run build`, and 100% database isolation. | M4 | Survey All |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Platform Audio Lifecycle & Acoustic Echo Isolation (R1) | Features 1-6 (Apostrophe fix, temporal split fix, objection shield, spoken digits shield, WASAPI/iOS decay parameters, confirmation echo shields) | none | IN_PROGRESS |
| 2 | Conversational Humanization, Sales Tone & Pronunciation (R3) | Features 7-12 (Consultative sales prompt, few-shots, dialogue humanization, H-V-A-C pronunciation, spoken times/dates, EchoGuard sync) | M1 | PLANNED |
| 3 | Voice Booking Lifecycle & Atomic Tool Validation (R2) | Features 13-17 (100% voice autonomy, ticket ledger sync, proactive conflict/off-hours recovery, voice reschedule/cancel, verified finalization) | M2 | PLANNED |
| 4 | Automated Challenger Test Suite & Release Verification (R4) | Features 18-20 (Frontend 171+ tests, backend pytest, ruff, mypy, architecture check, production build, zero DB contamination) | M3 | PLANNED |

## Interface Contracts
### 1. Booking Tool Execution SSE Frame (`event: tool_call`)
```json
{
  "name": "book_appointment_tool",
  "arguments": {
    "service": "AC Repair",
    "phone": "5551234567",
    "date": "2026-09-28",
    "time": "10:00 AM"
  },
  "result": "Appointment booked successfully for tomorrow at 10:00 AM."
}
```

### 2. Spoken Text Normalization Contract (`normalizeSpokenText`)
- Input: Raw text clause from LLM or template (e.g., `"Apex HVAC is open until 6:00 PM on October 12."`)
- Output: Normalized spoken prose (e.g., `"Apex H-V-A-C is open until six in the evening on October twelfth."`)
- Guarantee: Reversible token mapping; normalized string is simultaneously registered in `speechRecRef` for echo matching.

### 3. Voice Booking Confirmation Policy (`is_explicit_booking_confirmation`)
- Affirmative set includes: `"yes"`, `"yeah"`, `"yep"`, `"go ahead"`, `"please book it"`, `"sure"`, `"sounds good"`, `"lock it in"`, `"lock that in"`, `"lock it in please"`, `"let's do it"`, `"lets do it"`, `"schedule it"`, `"go for it"`.
- Strict rejection: Negations (`no`, `not`, `cancel`, `wait`), date/time indicators (`tomorrow`, `monday`, `at 10`), and raw digits.

## Code Layout
- Backend: `referenced-chatgpt-conversation-this-is-an/backend`
  - `app/agent/prompts.py`: Consultative sales persona guidelines and few-shot dialogues.
  - `app/agent/tools.py`: Tool definitions for scheduling and calendar operations.
  - `app/chat_api.py`: Voice chat endpoint, echo rejection shields, Case A tool execution, Case B slot handling.
  - `app/chat/booking_policy.py`: Explicit booking confirmation phrases, confirmation text templates.
  - `app/chat/intent.py`: Dialogue intent classification, opening hours speech formatting.
  - `app/scheduling.py`: Booking transactions, `find_nearest_available_slots`, `format_available_slot_for_speech`.
  - `app/call_tracking.py`: Verified call finalization in `end_browser_call`.
  - `tests/`: Isolated pytest test suites.
- Frontend: `frontend`
  - `src/lib/speech-recognition.ts`: Platform detection, half-duplex gating, EchoGuard shields, decay thresholds.
  - `src/lib/neural-audio-player.ts`: Web Audio unlock, WASAPI latency calibration, AnalyserNode silence decay.
  - `src/lib/text-normalization.ts`: Pronunciation normalization (H-V-A-C, numbers, dates, times).
  - `src/components/ui/kokoro-call-session.tsx`: Call session management, SSE event dispatch, EchoGuard dual registration.
  - `src/lib/run-tests.mjs`: Test runner executing all frontend test suites.
