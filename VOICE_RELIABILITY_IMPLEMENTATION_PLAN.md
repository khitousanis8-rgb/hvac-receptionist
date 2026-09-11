# Voice Reliability Implementation Plan

## Objective

Make the in-browser HVAC receptionist faster and prevent it from inventing a booking, availability, price, policy, or customer-record result.

This plan deliberately does **not** change any setup, deployment, dependency, provider, environment, database-schema, or frontend-build files. It works with the current model, SQLite database, text-to-speech pipeline, and existing authenticated call lifecycle.

The planned code scope is limited to:

- `referenced-chatgpt-conversation-this-is-an/backend/app/agent/prompts.py`
- `referenced-chatgpt-conversation-this-is-an/backend/app/chat_api.py`
- `referenced-chatgpt-conversation-this-is-an/backend/tests/test_chat_api.py`

## Design decision

Do not fine-tune or retrain the voice model for this problem. The browser voice is text-to-speech; factual reliability is controlled by the conversation and booking logic before speech is generated.

The model should handle empathy and ordinary information questions. The server must own every booking-stage response and every database action.

The resulting booking flow is:

1. Caller speaks.
2. Existing transcription sends text to `/v1/calls/chat`.
3. The server extracts and stores structured booking details.
4. While the conversation is booking-related, the server chooses the next response from fixed templates; it does not ask the model to decide whether a booking is real.
5. The caller hears a server-generated recap.
6. Only a short, explicit acceptance of that recap can execute the booking function.
7. The server speaks a success or failure message based only on the booking function’s result.

This is the critical change: the model will never be in the position of deciding whether an appointment is booked.

## Current weaknesses to remove

The current implementation in `chat_api.py` has three behaviors that make hallucinations and latency more likely:

- It treats a message as a confirmation whenever it contains broad words such as `yes`, `sure`, or `book`, even if no server-generated recap was asked.
- Its booking prerequisite currently accepts `date OR time`; a real booking needs both values.
- It exposes `book_appointment_tool` to the model and performs a fallback booking check after model text may already have been streamed to the caller. A streamed claim cannot be taken back safely.

It also sends up to 30 history messages and enforces a 500-token minimum completion budget, although a voice receptionist should normally use one or two sentences.

## Implementation steps

### 1. Establish the booking state from durable call slots

In `chat_api.py`, add small pure helpers near the existing slot/date helpers:

- `booking_missing_fields(slots) -> list[str]`
  - Required for an actual booking: `phone`, `service`, `date`, and `time`.
  - `name` remains useful and should be collected when natural, but it is not required because the current booking API accepts it as optional.

- `booking_details_changed(updates) -> bool`
  - Returns true when an update contains `phone`, `service`, `date`, or `time`.

- `is_explicit_booking_confirmation(text) -> bool`
  - Normalize lower-case text, punctuation, and whitespace.
  - Return true only for a whole-message allowlist such as: `yes`, `yes please`, `please book it`, `go ahead`, `that works`, `sounds good`, `correct`, and `confirm it`.
  - Do not use substring matching.
  - Reject messages containing a negation, a new time/date, or additional booking details. Those must revise the draft rather than confirm it.

- `booking_confirmation_text(settings, slots) -> str`
  - Build the spoken recap from the stored fields, never from model output.
  - Example: `Just to confirm, that’s AC repair for Tuesday, September 16 at 10 AM. Would you like me to book it?`

- `booking_result_text(result) -> tuple[str, bool]`
  - Convert the booking function result into a short spoken reply and a true/false success flag.
  - Preserve a tool failure or unavailable-slot response exactly as a failure; do not classify a sentence as success merely because it includes a word such as `confirmed`.

Store two extra values in the existing JSON slot data; this needs no schema change:

- `confirmation_requested: bool`
- `confirmation_fingerprint: str | None`

The fingerprint is a stable string composed of the normalized `phone`, `service`, `date`, and `time`. It proves that the caller is confirming the exact details that were read back.

### 2. Make date/time validation happen before asking for confirmation

After extracting slots, require all four booking fields before a recap can be sent.

When date and time are present:

1. Call the existing `_parse_local_datetime(settings, date, time)`.
2. If parsing fails, keep the valid fields and ask only for a clearer date/time.
3. If parsing succeeds but is already in the past, ask for a future date/time.
4. Do not claim availability yet. Availability may change until the caller approves the recap.

This ensures a phrase like `tomorrow at 10` is stored as separate `date=tomorrow` and `time=10 AM` values and is not passed through as an ambiguous free-text string.

### 3. Reset confirmation immediately when booking details change

When `booking_details_changed(new_slots)` is true:

1. Update the durable slots with the extracted field values.
2. Set `confirmation_requested` to false.
3. Clear `confirmation_fingerprint`.
4. Set `confirmed` to false only when the record has not already been successfully booked.

This prevents an old `yes` from applying after a caller changes from Tuesday at 10 AM to Wednesday at 2 PM.

### 4. Replace model-directed booking with a server-directed state machine

Insert the following routing before creating an LLM completion.

#### A. No booking flow is active

Use the model for ordinary questions, empathy, safety messages, and read-only appointment lookup. Keep the prompt concise and limit the history as described later.

#### B. Booking flow is active and a required field is missing

Return a fixed SSE `delta` response that briefly acknowledges the request and asks for exactly one field. Use this order:

1. Service
2. Callback phone number
3. Preferred date
4. Preferred time

If a name is missing, ask for it naturally before the phone number when appropriate, but never block booking if the caller declines or has already supplied the required fields.

Examples:

- `What service do you need help with: AC, heating, or a tune-up?`
- `What’s the best number for the technician to call you back?`
- `What day works best?`
- `What time would you prefer?`

#### C. All fields are present and no current recap was requested

1. Validate date/time as described in step 2.
2. Compute the fingerprint.
3. Save `confirmation_requested=true` and the fingerprint in slots.
4. Return only `booking_confirmation_text(...)` as an SSE response.
5. Do not call the LLM or the booking database function on this turn.

#### D. A recap was requested and the caller explicitly confirms

1. Recompute the fingerprint from the current durable slots.
2. Require it to equal `confirmation_fingerprint`.
3. Revalidate the date/time.
4. Call `_execute_tool(..., "book_appointment_tool", {...})` directly with exactly these keys:
   - `phone_number`
   - `service`
   - `date`
   - `time`
   - `name` when available
5. If the tool succeeds:
   - set `confirmed=true`;
   - set `confirmation_requested=false`;
   - update the exact call outcome to `booked`;
   - return a fixed success response based on the actual tool result.
6. If the tool fails:
   - set `confirmation_requested=false`;
   - keep the collected details so the caller can choose another time;
   - return a short failure response based on the tool result;
   - never use the word `booked` or `confirmed` unless the tool succeeded.

#### E. A recap was requested but the caller does not give an explicit confirmation

- If they provide a revised booking field, route through section C and read back the new details.
- If they say no, cancel, or decline, clear `confirmation_requested` and ask for another time or offer to keep helping.
- Otherwise say: `I just need a clear yes or no. Would you like me to book that appointment?`

### 5. Remove write tools from every model-visible tool list

Keep `book_appointment_tool` as a backend-only function. It must not remain in `TOOLS`, a completion fallback, or a tool-repair path passed to the model.

Create a `READ_ONLY_TOOLS` collection containing only `check_my_appointments`.

Use `READ_ONLY_TOOLS` consistently in:

- normal model completion requests;
- the fallback in `_try_create_completion`;
- the repair fallback in `_create_stream_completion`.

Do not leave one fallback that restores the booking tool. A hidden fallback would reintroduce the exact hallucination path this plan removes.

Delete the current post-stream `anti_hallucination_auto_booking` block. It is unsafe because text might already have told the caller that they are booked before the code evaluates the fallback.

### 6. Simplify the prompt

Replace the long, repetitive booking instructions in `agent/prompts.py` with a compact role prompt.

The prompt should state:

> You are Sarah, a warm HVAC receptionist. Keep replies to one or two short sentences. Use the verified caller details as facts, but never invent missing information. Do not state or imply that an appointment, availability, price, policy, or customer record is confirmed unless the server provides that result. Ask one question at a time. For urgent gas, fire, smoke, sparking, carbon-monoxide, or illness symptoms, tell the caller to leave the building and call emergency services.

Do **not** include instructions telling the model to invoke a booking tool. The server state machine owns booking now.

Keep the approved-service list and verified caller memory block. Remove style rules that repeat the same constraint in several forms. This reduces input tokens and makes higher-priority rules easier for the model to follow.

### 7. Reduce response latency without changing the model or provider

In `chat_api.py`:

1. Cap server-side history at the newest **12** messages, not 30. The server remains authoritative even if an older frontend sends a longer history.
2. Use `temperature=0.1` for ordinary model responses; do not change this for deterministic booking templates because they do not call the model.
3. Remove the unconditional `max_tokens` floor of 500 in `_create_stream_completion`.
4. Bound normal voice replies to 96–160 output tokens. Start at 128 and retain the existing stop sequences.
5. Do not request the second LLM completion after a booking action. A server-generated tool-result reply replaces it.

Expected result: booking collection, confirmation, success, and failure turns require zero model calls. Ordinary turns have smaller prompts and shorter permitted responses.

## Test plan

Add or update tests in `backend/tests/test_chat_api.py` before changing production logic. Every test must use the authenticated browser-call flow already present in the project.

### Required unit tests

- A booking draft with a date but no time has a missing `time` field and cannot create an appointment.
- A booking draft with a time but no date has a missing `date` field and cannot create an appointment.
- Each accepted confirmation phrase is accepted only as the complete normalized utterance.
- `I want to book`, `maybe`, `no`, `yes, but change it to Wednesday`, and `book next Tuesday` do not confirm an existing recap.
- Updating time, date, service, or phone clears the previous confirmation fingerprint.
- The direct booking call receives `phone_number`, `service`, `date`, `time`, and optional `name`; it never receives `customer_name` or `preferred_datetime`.
- A failure result does not set `confirmed` or call outcome `booked`.
- A success result sets both exactly once.

### Required endpoint/SSE tests

- Missing booking detail returns one fixed question and does not call the model or booking function.
- Complete details return a fixed recap and do not call the model or booking function.
- A valid confirmation after a recap calls the booking function once and returns a success SSE event.
- Repeating the confirmation after success does not create a second appointment.
- A revised time requires a new recap before confirmation can book.
- Read-only appointment lookup remains available to the model path.
- No completion request includes `book_appointment_tool` in its tool list, including retry and repair paths.

### Manual voice acceptance script

Run these in the browser after automated tests pass:

1. Say: `My AC stopped cooling.` Confirm that the assistant asks for one next detail.
2. Supply phone, date, and time in separate turns. Confirm that it reads the exact details back and does not say booked.
3. Say: `Yes, please.` Confirm that exactly one appointment appears and the spoken confirmation matches the real result.
4. Repeat `Yes, please.` Confirm that there is still only one appointment.
5. Change the time after the recap. Confirm the assistant recaps the new time before it can book.
6. Say `No, make it later.` Confirm no booking is created.
7. Ask a non-booking question such as business hours. Confirm the response remains warm and short.
8. Provide a dangerous emergency phrase. Confirm the emergency instruction takes priority over booking collection.

## Acceptance criteria

The change is complete only when all conditions below hold:

- The model has no write-capable booking tool in any request or fallback request.
- The system cannot book without `phone`, `service`, `date`, `time`, a server-generated recap, and a later explicit confirmation matching that recap.
- The system cannot tell the caller a booking is real before the database booking function reports success.
- Every booking-stage reply is server-generated and needs no LLM request.
- Ordinary voice responses use at most 12 retained history messages and a bounded output budget.
- Existing call-ownership, private-dashboard, scheduling, and full backend test coverage still pass.
- Ruff and mypy are run after the change; any new warning is fixed before commit.

## Rollout sequence

1. Implement pure helpers and tests first.
2. Implement deterministic booking routing behind the existing `/v1/calls/chat` endpoint.
3. Remove model-visible write tools and post-stream auto-booking.
4. Shorten the prompt and cap the history/token budget.
5. Run backend tests, frontend build, Ruff, and mypy.
6. Run the manual voice acceptance script.
7. Commit only after every acceptance criterion passes.

No `.env`, `render.yaml`, deployment configuration, dependency manifest, or provider setting changes are required by this plan.
