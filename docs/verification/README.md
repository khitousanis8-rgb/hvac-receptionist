# Verification Workflow

This project uses a deterministic local harness plus IDE-orchestrated review roles. The harness runs tests and preserves evidence; the IDE coordinates reasoning agents. CI runs deterministic checks only and never claims to have executed AI reviews.

## Local commands

From the repository root:

```sh
npm run verify:harness   # 20 standard-library tests for the harness itself
npm run verify:fast      # frontend suite, build, ruff, mypy, architecture boundaries
npm run verify           # full profile: backend, frontend, build, ruff, mypy, architecture boundaries
```

The runner writes evidence to `artifacts/verification/<run-id>/`:
- `manifest.json` — machine-readable gate results and review status
- `report.md` — readable summary with explicit scope limits
- `logs/<gate-id>.log` — redacted command output

Evidence directories are untracked. The runner redacts known credential patterns before persisting logs.

## IDE review roles

Run at most four read-only specialists concurrently over the same recorded baseline. Each receives scoped paths, the current manifest, and the exact output schema. No specialist edits shared files. After fixes, a fresh independent reviewer validates changed code and evidence rather than accepting the implementer's conclusions.

| Role | Scope |
| --- | --- |
| backend | chat/booking/scheduling/persistence correctness and test contracts |
| frontend | UI, request/stream consumption, audio/recognition lifecycle, accessibility, fallback behavior |
| architecture | import boundaries, state ownership, configuration/deployment consistency, defensive privacy review, extraction suitability |
| quality | test completeness, process/database isolation, reproducibility, E2E realism, gate integrity |
| independent | post-fix validation of changed code and evidence |

Structured findings use the `Finding` schema in `implementation_plan.md` ([Types] section). Candidate findings require evidence paths; validated findings require a successful post-change gate and independent review before being marked `verified`.

## Findings ledger

`tools/verification/findings.json` is the checked-in, cross-session record of every finding with its severity, status (`verified`, `fixed`, `deferred`, `rejected`), regression tests, and disposition. The runner renders it as a table in every `report.md`, so a passing run never hides an outstanding or deferred finding.

## Configuration added by the remediation work

| Setting | Default | Purpose |
| --- | --- | --- |
| `LLM_FALLBACK_MODELS` | previous hardcoded order | Comma-separated failover list tried on rate-limit errors |
| `LLM_MAX_TOKENS` | `128` (16-2048) | Token ceiling for chat completions |
| `RATE_LIMIT_BACKEND` | `memory` | `database` switches rate limiting to durable `rate_limit_events` rows for restart survival and multi-instance deployments |

## Booking authority

Bookings are created by two paths: the deterministic confirmation-ticket flow, and model-initiated `book_appointment_tool` calls. Both remain supported; a successful tool booking additionally records an already-consumed `ConfirmationTicket` as a provenance ledger entry, so the database always explains which path created each appointment. See `backend/tests/test_booking_authority.py`.

## CI semantics

`.github/workflows/verify.yml` runs the same deterministic gates as the local fast profile, plus a disposable PostgreSQL service job. CI does not execute IDE agents; agent review status remains `pending` in CI manifests. Reports distinguish deterministic CI status, agent review status, and manual device acceptance.

## Architecture boundaries

The `arch` gate (`tools/verification/check_architecture.py`) parses the backend import graph with the AST and fails on: forbidden dependencies for `app.chat.booking_policy` and `app.chat.schemas` (no FastAPI, database access, route handlers, provider clients, or `app.main`), and any import cycle among application modules. Extend `FORBIDDEN` as new boundaries are extracted.

## Not yet done

- `chat_api.py` is still a large orchestration module. The planned staged extraction (intent detectors, slot extraction, LLM client, deterministic handlers) has **not** been performed; it needs its own session with the full suite and `arch` gate after each step.
- Frontend extraction from `App.tsx` (transport types, data hook, formatting helpers, record views, pages) has **not** been performed.

## Recorded limitations

- **Real PostgreSQL integration**: the opt-in suite (`tests/test_postgres_integration.py`, marker `postgres`) is implemented and its skip/deselect behavior is verified locally, but no disposable local PostgreSQL was available during the initial campaign. The real run executes in CI against a disposable `postgres:16` service container. A local run requires setting `TEST_POSTGRES_URL` to a local disposable database.
- **Browser E2E**: Playwright installation and browser downloads were declined for this campaign. The existing frontend suites (normalization, lifecycle, telemetry, touch-target, audio audit/stress, recognition) remain the automated frontend coverage; real-browser journeys are a recorded manual checklist until Playwright is approved and installed.

## Manual device acceptance

Browser automation covers Chromium and WebKit emulation only. Physical-device acceptance (iOS Safari, Android Chrome, microphone grant/deny, audible start/stop, interruption, background/foreground) is a recorded manual checklist, not an automated pass.