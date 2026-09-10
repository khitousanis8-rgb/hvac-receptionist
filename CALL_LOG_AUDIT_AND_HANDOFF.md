# Call Log Audit and Handoff

**Last updated:** 2026-09-10  
**Security-and-reliability implementation:** commit `d45b325` (`fix: secure and harden call logging`)

This document records the original audit findings, the changes now in the repository, and the items that still require owner or follow-up work.

## What was fixed

| Priority | Original issue | Fix delivered |
| --- | --- | --- |
| P0 | Anyone could read callers' phone numbers, call summaries, and appointments from the public API. | `GET /v1/calls`, `GET /v1/appointments`, and `/dashboard` now require `ADMIN_API_KEY`. The dashboard asks for the key and holds it in browser **session** storage only. |
| P0 | A caller could guess a numeric `call_id` and overwrite another call's outcome, transcript, or end time. | Every browser call gets a random 256-bit secret. Its SHA-256 hash is stored server-side. Chat and end-call requests must present the matching secret and room/call pair. Cross-call mutation is regression-tested. |
| P0 | The anti-hallucination booking repair sent `customer_name` and `preferred_datetime`, although the booking tool requires `name`, `date`, and `time`; it could report a booking that did not exist. | It now uses the exact booking-tool schema and only runs when durable canonical `date` and `time` slots exist. No booking is marked successful unless the booking call returns success. |
| P1 | Session slots were an in-memory global dictionary: lost on restart, unsafe across workers, retained until arbitrary eviction, and keyed by room rather than a precise call. | Slots now live in the `call_records.session_slots` JSON column and are accessed only by exact call ID. They are cleared when a call ends. |
| P1 | Greeting retries could create duplicate records and browser close could leave calls indefinitely open. | Greeting is idempotent for a call secret; browser unmount sends a `keepalive` finalization request, while the normal hang-up path is idempotent. |
| P1 | Tool logging included caller phone numbers and booking details. | Logs contain tool name and argument names only; automatic-booking logs contain populated slot names only. |
| P1 | Two callers could pass the availability check at once and double-book a visit. | A partial unique SQLite index now permits only one `booked` appointment at a given start time. The scheduling code handles a unique-constraint race cleanly. |
| P2 | SQLite could lose timezone information, causing browser-local time to be shown for UTC values. | `UTCDateTime` normalizes storage/retrieval to UTC and the call API serializes timestamps with `Z`. |
| P2 | The dashboard showed a 50-record subset as all-time call totals and conversion rate. | The call API now returns paginated `items`, `total`, and `outcome_counts`; the dashboard uses server totals for the main metrics. |

## Validation completed

- Backend test suite: **62 passed**.
- Frontend production build: **passed**.
- Regression coverage now includes private-route authentication and prevention of cross-call finalization.
- Changes are pushed to `main` in commit `d45b325`.

## Owner actions required before/after deployment

These items require access to credentials or third-party dashboards and cannot safely be completed from source code alone.

1. **Set `ADMIN_API_KEY` in Render.**
   - Create a long, random secret in Render's environment settings.
   - Do not put this value in a committed `.env` file, Vercel environment variable, or frontend build variable.
   - Redeploy the backend after saving it.
   - In the dashboard, select **Unlock records** and enter the secret for the current browser session.

2. **Rotate the LLM API key.**
   - An LLM credential was present in a local `.env` file during review. It is ignored by Git, but it should still be treated as exposed and replaced in Groq/your LLM provider and Render.
   - Update the Render `LLM_API_KEY` secret after rotating it.

3. **Confirm production deployment.**
   - Render is configured for automatic deployment, but verify the deploy actually completed and its health check is green.
   - Rebuild/redeploy the Vercel frontend so it contains the dashboard changes.
   - Perform a browser test: start a call, end it, unlock the dashboard, and confirm its call row appears with the correct time and outcome.

4. **Decide the real admin identity model.**
   - The current key is an intentionally simple single-operator safeguard.
   - For multiple staff members or a real production business, replace it with an identity provider/session system, roles, audit logs, key rotation, logout, and a secure secret-entry flow.

5. **Review existing data exposure.**
   - Since call transcripts and phone numbers were previously publicly readable, review hosting/access logs if available and follow your applicable privacy-notice, retention, and incident-response obligations.

6. **Plan backups and retention.**
   - SQLite on ephemeral/free hosting can be lost on redeploy or restart. Move production data to a managed database and set backups.
   - Define a retention and deletion policy for call transcripts, phone numbers, and appointment notes.

## Remaining code work

### Must do before calling the project fully production-ready

- **Use a managed relational database and migrations.**
  The compatibility migration in `app/db.py` is suitable for the current SQLite deployment but is not a replacement for Alembic/schema migrations and managed PostgreSQL.

- **Use real booking capacity rules.**
  The new index prevents overlapping start times for a single generic capacity. If the company has several technicians, regions, durations, or job types, model those resources explicitly and enforce capacity per resource/time interval.

- **Add abandoned-call server cleanup.**
  Browser unload finalization improves the common case, but a crashed client or network loss still needs a scheduled server job that closes old `in_progress` calls with an explicit `abandoned` outcome.

- **Add API pagination controls to the Calls UI.**
  The API supports `offset` and `limit`, but the UI currently loads the latest 200 calls. Add paging or cursor-based infinite loading for a large call history.

- **Move admin credential transport away from session storage.**
  `sessionStorage` is better than persistent local storage, but an XSS vulnerability could still read it. A short-lived, HttpOnly, Secure, SameSite session cookie is the recommended next stage.

### Static-quality backlog

The code is tested, but the configured static checks are not yet clean:

- **Ruff:** 83 findings.
  - Most are line length (`E501`), import ordering (`I001`), and unused imports (`F401`).
  - Several `B904` findings ask for explicit exception chaining.
  - Several `B023` findings in `app/chat_api.py` concern the `candidate_model` loop variable captured by nested failover functions. This deserves a real code correction, not just formatting.

- **Strict mypy:** 13 findings.
  - `app/chat_api.py` SSE generator functions need return annotations.
  - The type checker cannot retain the `call_id is not None` guarantee inside the nested SSE generator; bind it once to a local non-optional variable before creating the generator.
  - `app/agent/prompts.py` needs a parameterized dictionary type.

Recommended follow-up sequence:

1. Fix the `B023` failover closure and strict-mypy typing errors.
2. Run `ruff check --fix` for automatically safe fixes; manually resolve remaining exceptions/imports/line wrapping.
3. Make Ruff and mypy required in CI before merge.
4. Add API contract tests for pagination, timestamp `Z` serialization, migration of an existing SQLite database, and booking-capacity races.

## Files changed by the security repair

- `referenced-chatgpt-conversation-this-is-an/backend/app/auth.py`
- `referenced-chatgpt-conversation-this-is-an/backend/app/call_tracking.py`
- `referenced-chatgpt-conversation-this-is-an/backend/app/chat_api.py`
- `referenced-chatgpt-conversation-this-is-an/backend/app/db.py`
- `referenced-chatgpt-conversation-this-is-an/backend/app/main.py`
- `referenced-chatgpt-conversation-this-is-an/backend/app/scheduling.py`
- `frontend/src/App.tsx`
- `frontend/src/components/ui/kokoro-call-session.tsx`

## Quick release checklist

- [ ] Rotate LLM key.
- [ ] Set a strong `ADMIN_API_KEY` in Render.
- [ ] Deploy backend and frontend.
- [ ] Unlock dashboard with the key and test a full call.
- [ ] Check that phone numbers/transcripts return `401` without the key.
- [ ] Make a backup/retention decision before collecting real customer calls.
