# Project: HVAC AI Receptionist Safe Voice Action Plan (Phases 0 through 6)

## Architecture
- **Target Platforms**: Android Mobile Browsers (Android Chrome 120+, Samsung Internet), iOS Safari, and Desktop Chrome/Firefox.
- **Backend Architecture**:
  - FastAPI application in `referenced-chatgpt-conversation-this-is-an/backend`.
  - Dialect-aware SQLAlchemy engine supporting PostgreSQL (production) and SQLite (test/dev) with connection pooling and fail-closed production checks.
  - Partial unique index `uq_appointments_booked_scheduled_for` on `Appointment` (`status = 'booked'`) for slot reuse parity.
  - Server-owned conversation authority via `CallTurn` ORM model; client-supplied history ignored.
  - Separation of observed speech extraction (`candidates`) from verified fields (`verified`). Deterministic validation requiring canonical service, 10-digit NANP phone, exact future date, exact AM/PM time before recap.
  - Single-use, short-lived (300s) `ConfirmationTicket` bound to `call_id` and `booking_fingerprint`. Atomic SQL consumption before booking execution. Voice-only ("yes") booking strictly disabled.
  - Constrained LLM dialogue intents; server-rendered templates for hours, services, policies, and emergency guidance.
  - Edge rate limiting: tokens (15/min), chat (30/min), TTS (30/min), transcribe (30/min), and booking confirmation (5/min).
  - Server-owned utterance hashes and timestamps (last 15s) for acoustic echo matching.
- **Frontend Architecture**:
  - React + Vite application in `frontend/`.
  - `KokoroCallSession`: Single voice path (Kokoro TTS + Web Speech / MediaRecorder fallback).
  - Browser Confirmation Review Card: Renders service, normalized phone, date, and time upon receiving `confirmation_ticket` event. Intentional "Confirm Booking" tap button (>=44x44px, min 48px) with double-click guard (`isConfirming`) and idempotent replay handling.
  - Voice loop: Half-duplex gating (`track.enabled = false` during TTS) with 1,100ms acoustic cooldown.
  - Mobile continuity: `visibilitychange: hidden` initiates 45s grace period; returning resumes `AudioContext` and speech recognition without terminating the call.
  - Text normalization: Spoken token protection before clause splitting prevents fragmentation of time expressions (`10:30 AM`), phone numbers, and currencies.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | R1.1 Freeze Voice-Only Booking | Remove speech-only confirmation (`book_appointment_tool` on "yes"); prompt caller to tap review card. | M1 | Survey Backend |
| 2 | R1.2 Disable Anonymous Lookup | Remove `check_my_appointments` from LLM tool exposure; return neutral spoken refusal policy. | M1 | Survey Backend |
| 3 | R1.3 Lock LiveKit Worker Flag | Keep `ENABLE_LIVEKIT_WORKER=false` so browser Kokoro remains the single active voice path. | M1 | Survey Backend |
| 4 | R7.1 TTS POST Stream Endpoint | Add `@router.post("/stream")` in `tts_stream.py` with `Cache-Control: private, no-store, must-revalidate` (fixing test failure and ruff/mypy errors). | M1 | Survey Durability |
| 5 | R7.2 Engine & Dialect Configuration | Dialect-aware engine configuration in `config.py` and `db.py` (fail-closed, SQLite check_same_thread, Postgres pool). | M1 | Survey Durability |
| 6 | R7.3 Partial Unique Index Parity | Ensure `uq_appointments_booked_scheduled_for` on `Appointment` functions across PostgreSQL and SQLite. | M1 | Survey Durability |
| 7 | R7.4 Booking Rate Limiter | Add `check_booking_rate_limit` (5 req/min per IP) in `security.py` to prevent booking abuse. | M1 | Survey Durability |
| 8 | R2.1 CallTurn Schema & Migration | Define `CallTurn` ORM model (`call_id`, `turn_index`, `role`, `content`, `created_at`) with idempotent table/index creation in `init_db()`. | M2 | Survey Backend |
| 9 | R2.2 Server-Owned History Context | Build prompt messages exclusively from server-persisted `CallTurn` records (bounded recent turn window). Ignore client assistant history. | M2 | Survey Backend |
| 10 | R2.3 Oversized History Rejection | Reject oversized history payloads at Pydantic request boundary with HTTP 422 before reaching LLM. | M2 | Survey Backend |
| 11 | R3.1 Candidate vs Verified Slot Separation | Split `session_slots` into `candidates` and `verified` fields. Treat all speech extractions as candidate only. | M2 | Survey Backend |
| 12 | R3.2 Strict Slot Validation | Require canonical service name, 10-digit NANP phone, exact future date, exact AM/PM time before recap. | M2 | Survey Backend |
| 13 | R3.3 Ambiguous Time Clarification | Do not auto-guess PM for "tomorrow at three"; flag `clarification_needed = "time_am_pm"`. | M2 | Survey Backend |
| 14 | R3.4 Negation Handling | Handle negated utterances ("not AC, heating") so negated services are excluded from verified slots. | M2 | Survey Backend |
| 15 | R4.1 ConfirmationTicket Schema | Define `ConfirmationTicket` ORM model in `db.py` with status (`pending`, `consumed`, `expired`, `cancelled`), 300s TTL, and fingerprint. | M3 | Survey Backend |
| 16 | R4.2 Ticket Issuance on Recap | Mint short-lived single-use ticket on deterministic recap and emit `event: confirmation_ticket` SSE frame. | M3 | Survey Backend |
| 17 | R4.3 Atomic Ticket Consumption Endpoint | Implement `POST /v1/calls/confirm-booking` (and alias `/v1/calls/confirm`) with atomic SQL consumption and scheduler execution. | M3 | Survey Backend |
| 18 | R4.4 Replay & Double-Tap Idempotency | Return existing booking details on duplicate confirmation request without creating duplicate bookings. | M3 | Survey Backend |
| 19 | R5.1 Restrict LLM Dialogue Intents | Remove booking and lookup tools from chat LLM exposure; constrain model to allowlisted dialogue intents. | M3 | Survey Backend |
| 20 | R5.2 Server-Rendered Fact Templates | Render hours, services, pricing, availability, and emergency guidance strictly from server templates and config data. | M3 | Survey Backend |
| 21 | R4.5 Frontend Review Card UI | Render Review Card in `kokoro-call-session.tsx` displaying service, normalized phone, date, and time upon receiving confirmation ticket. | M4 | Survey Frontend |
| 22 | R4.6 Intentional Confirm Button | Add "Confirm Booking" tap button with `min-h-[48px]`, >=44x44px touch target, and double-click guard (`isConfirming`). | M4 | Survey Frontend |
| 23 | R2.4 Client History Stripping | Strip `history` from client chat payload in `kokoro-call-session.tsx`; send only new caller message and credentials. | M4 | Survey Frontend |
| 24 | R6.1 Half-Duplex Audio & Cooldown | Maintain half-duplex audio during Kokoro TTS playback with physical track muting and 1,100ms acoustic cooldown. | M4 | Survey Frontend |
| 25 | R6.2 Spoken Token Protection | Ensure time expressions (`10:30 AM`), phone numbers, and abbreviations survive clause splitting intact. | M4 | Survey Frontend |
| 26 | R6.3 Mobile Background Continuity | Maintain 45s grace period on `visibilitychange: hidden`; re-arm speech recognition and resume AudioContext on `visible`. | M4 | Survey Frontend |
| 27 | R6.4 Server Utterance Echo Matching | Use server-owned assistant utterance hashes and timestamps (last 15s) for acoustic echo detection. | M4 | Survey Backend |
| 28 | Acceptance Test: Echoed Confirmation | Test: Server receives assistant-like "yes" after TTS -> no ticket consumption, no appointment. | M5 | Acceptance Criteria |
| 29 | Acceptance Test: Accidental Spoken Yes | Test: Caller says "yes" before tapping review card -> no appointment; UI remains available. | M5 | Acceptance Criteria |
| 30 | Acceptance Test: Confirmation Replay | Test: Confirmation request sent twice -> one transaction succeeds; exactly one booking exists. | M5 | Acceptance Criteria |
| 31 | Acceptance Test: Phone Lookup Refusal | Test: Caller gives another person's phone number for lookup -> no appointment details disclosed. | M5 | Acceptance Criteria |
| 32 | Acceptance Test: Ambiguous Time | Test: Caller says "tomorrow at three" -> clarify AM/PM; no recap ticket. | M5 | Acceptance Criteria |
| 33 | Acceptance Test: Negated Service | Test: Caller says "not AC, heating" -> heating is candidate; AC never becomes verified. | M5 | Acceptance Criteria |
| 34 | Acceptance Test: Forged History | Test: Browser posts fabricated assistant turn -> ignored; server turns used. | M5 | Acceptance Criteria |
| 35 | Acceptance Test: Oversized History | Test: Oversized history payload -> rejected with HTTP 422 before reaching LLM. | M5 | Acceptance Criteria |
| 36 | Acceptance Test: Mobile Interruption | Test: Phone locks or app briefly backgrounds -> call resumes; no premature end. | M5 | Acceptance Criteria |
| 37 | Acceptance Test: Time Token Intact | Test: Time expressions ("10:30 AM") survive TTS chunking intact. | M5 | Acceptance Criteria |
| 38 | Acceptance Test: Mobile Review Card | Test: Booking confirmation UI renders correctly and is tappable on mobile viewports. | M5 | Acceptance Criteria |
| 39 | Acceptance Test: Durability Restart | Test: Confirmed booking created, production restarts -> call log and appointment remain available. | M5 | Acceptance Criteria |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Baseline Hygiene, Authority Freeze & R7 Durability | Features 1-7 (Excise speech booking, disable lookup, lock LiveKit, POST /stream endpoint, engine/dialect config, partial unique index, booking rate limit) | none | DONE |
| 2 | Server-Owned Conversation Authority & Slot Separation | Features 8-14 (CallTurn schema & migration, server turn context, oversized payload rejection, candidate vs verified slots, strict validation, ambiguous time clarification, negation handling) | M1 | IN_PROGRESS |
| 3 | Confirmation Ticket Architecture & Constrained Model Output | Features 15-20 (ConfirmationTicket schema & migration, ticket issuance on recap, atomic consumption endpoint, replay idempotency, dialogue intent constraints, server templates) | M2 | PLANNED |
| 4 | Frontend Voice UI, Review Card Tap & Recoverable Loop | Features 21-27 (Review Card UI, Intentional confirm button, client history stripping, half-duplex TTS, spoken token protection, mobile lifecycle continuity, server utterance echo matching) | M3 | PLANNED |
| 5 | E2E Acceptance Verification, Regression Gates & Release Audit | Features 28-39 (All 12 acceptance test suites across pytest and frontend, 100% pass on 257+ backend tests, 7 frontend suites, pyright 0 errors, ruff check, npm run build) | M4 | PLANNED |

## Interface Contracts
### 1. Confirmation Ticket SSE Event (`event: confirmation_ticket`)
```json
{
  "ticket_id": "tkt_a1b2c3d4e5f6",
  "service": "Heating Repair",
  "phone": "5551234567",
  "date": "2026-09-18",
  "time": "02:00 PM",
  "fingerprint": "9f8e7d6c5b4a",
  "expires_in_seconds": 300
}
```

### 2. Confirm Booking Endpoint (`POST /v1/calls/confirm-booking` and alias `POST /v1/calls/confirm`)
**Request**:
```json
{
  "call_id": "call_123456",
  "call_secret": "sec_789abc",
  "ticket_id": "tkt_a1b2c3d4e5f6",
  "fingerprint": "9f8e7d6c5b4a"
}
```
**Response (Success)**:
```json
{
  "status": "confirmed",
  "booking_id": "apt_123",
  "service": "Heating Repair",
  "phone": "5551234567",
  "date": "2026-09-18",
  "time": "02:00 PM",
  "confirmation_message": "Your heating repair is confirmed for tomorrow at 2:00 PM."
}
```
**Response (Duplicate / Replay - Idempotent)**:
```json
{
  "status": "already_confirmed",
  "booking_id": "apt_123",
  "service": "Heating Repair",
  "phone": "5551234567",
  "date": "2026-09-18",
  "time": "02:00 PM",
  "confirmation_message": "Your heating repair is confirmed for tomorrow at 2:00 PM."
}
```
**Response (Expired or Invalid Ticket)**:
HTTP 400 Bad Request: `{"detail": "Confirmation ticket expired or invalid. Please confirm your details to generate a new ticket."}`

### 3. Server-Owned Chat Endpoint (`POST /v1/calls/chat`)
**Request**:
```json
{
  "session_id": "sess_123",
  "message": "I need help with my heater",
  "call_id": "call_123456",
  "call_secret": "sec_789abc",
  "client_telemetry": { ... }
}
```
*(Note: `history` field is deprecated and ignored by server).*

### 4. Spoken Voice Stream (`POST /v1/voice/stream`)
**Request**:
```json
{
  "text": "Hello, I can help you book a service visit.",
  "voice": "af_sarah"
}
```
**Response**:
`audio/mpeg` (or `audio/wav`), Header: `Cache-Control: private, no-store, must-revalidate`.

## Code Layout
- Backend: `c:\Users\TL\Documents\Codex\2026-08-27\referenced-chatgpt-conversation-this-is-an\backend`
  - `app/config.py`: Database URL normalization, production validation, proxy settings.
  - `app/db.py`: ORM models (`Customer`, `CallRecord`, `Appointment`, `CallTurn`, `ConfirmationTicket`), `get_engine()`, `init_db()`.
  - `app/security.py`: IP extraction, rate limiters (`check_token_rate_limit`, `check_chat_rate_limit`, `check_booking_rate_limit`).
  - `app/chat_api.py`: Chat endpoints, candidate/verified slots, recap ticket issuance, confirm-booking route, dialogue intents.
  - `app/tts_stream.py`: GET/POST `/v1/voice/stream` with private cache headers.
  - `app/scheduling.py`: Scheduling engine, slot validation, appointment creation.
  - `tests/`: 257+ pytest tests with runtime DB isolation.
- Frontend: `c:\Users\TL\Documents\Codex\2026-08-27\frontend`
  - `src/components/ui/kokoro-call-session.tsx`: Call session, Review Card UI, Confirm Booking button, half-duplex audio, mobile grace period.
  - `src/lib/speech-recognition.ts`: Speech recognition, track muting during TTS, acoustic cooldown.
  - `src/lib/neural-audio-player.ts`: Web Audio player, touch unlock, turn state callback.
  - `src/lib/text-normalization.ts`: Spoken token protection, clause splitting.
  - `src/lib/run-tests.mjs`: Test runner executing 7 test suites.
