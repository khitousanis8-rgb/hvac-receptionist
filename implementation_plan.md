# Implementation Plan

[Overview]

Build a repeatable, evidence-driven verification workflow using IDE subagents and local/CI tests, run an initial end-to-end audit campaign, and incrementally simplify the HVAC receptionist architecture without changing its supported behavior.

The user selected both an initial audit campaign and a reusable verification harness. The user explicitly selected IDE subagents rather than independent paid API/SDK agents. Consequently, the harness will execute deterministic checks and collect evidence; the IDE will orchestrate the reasoning agents. CI must not claim to have run AI reviews when it has only run tests. No model-provider SDK, autonomous repair service, production scanner, or new agent hosting platform is required.

The application consists of a React 19 / TypeScript / Vite frontend in `frontend/` and a Python 3.12+ / FastAPI / SQLAlchemy backend in `referenced-chatgpt-conversation-this-is-an/backend/`. The default browser call interface is `KokoroCallSession`; the repository also retains optional LiveKit dispatch and worker code. Browser calls combine recognition/transcription, streamed chat, speech output, server-managed call records, and confirmation-based booking. Private administrative routes supply call history and appointments. SQLAlchemy supports SQLite and PostgreSQL. Preserve the existing booking authority, privacy boundaries, timezone handling, telemetry, and optional legacy integrations.

Four read-only research subagents inspected backend conversations/scheduling, persistence/configuration, frontend/browser lifecycle, and deployment/test structure. This was planning research, not a completed audit campaign. Source reads confirm mixed responsibilities in `app/main.py`, extensive orchestration in `app/chat_api.py`, dashboard types/hooks/pages in `frontend/src/App.tsx`, and an explicit custom frontend test-suite list. No fresh test pass, coverage percentage, real-browser compatibility result, production readiness result, or clean working-tree result has been established. Some terminal checks failed or returned uncaptured output; do not treat those checks as successful evidence.

Concrete starting observations:
- `app/main.py:create_app` permits CORS methods GET, POST, and OPTIONS but declares DELETE `/v1/appointments/{appointment_id}`. Align allowed methods with the supported authenticated cancellation route and validate the cross-origin administrative journey.
- `frontend/src/lib/api.ts:API_BASE` falls back to a production Render host outside development. All test/browser configurations must explicitly select loopback and must reject accidental remote targets. Changing deployment URL policy requires an explicit compatibility decision rather than silently breaking existing deployments.
- `backend/tests/conftest.py` provides temporary SQLite isolation and runtime-database snapshots, but its per-test fixture takes effect after collection and app imports. The harness must establish a clean test environment and temporary working directory before starting Python.
- `frontend/src/lib/run-tests.mjs` runs normalization plus six explicitly named child suites. Keep these checks; add an explicit gate for browser E2E and require new unit suites to be registered. Existing source-inspection tests are not equivalent to real component or browser tests.
- Backend tooling already includes pytest, pytest-asyncio, Ruff, and strict mypy. Frontend `build` already runs TypeScript before Vite. Do not replace these tools or relax their checks merely to obtain green output.
- The nested README describes an earlier phase and states that a dashboard is not included, although dashboard routes and frontend pages exist. Update current runtime documentation while preserving historical audit reports as historical evidence.

The campaign uses four bounded specialist reviews followed by an independent verification review. Specialists initially read source and sanitized local evidence only. Security-related work is defensive source/configuration review and remediation, not exploit reproduction, intrusion, autonomous offensive testing, or probing external targets. Tests use synthetic customers and disposable databases. No production reads/writes, customer-data exports, real phone calls, provider charges, remote deployments, dependency upgrades, commits, or pushes occur without the relevant explicit approval.

“Clean architecture” means measurable boundaries, explicit ownership, fewer mixed responsibilities, no newly introduced import cycles, preserved contracts, and complete regression gates—not a rewrite or an arbitrary line-count target. Fix validated defects before extraction. Large database redesigns, distributed rate limiting, breaking authentication changes, migration frameworks, deleting LiveKit, or changing business rules require a separate approved design if the audit establishes a need.

[Types]

Introduce typed verification records and centralized application contracts while preserving existing public HTTP, SSE, and persistence formats.

Verification types belong in `tools/verification/models.py`, using standard-library dataclasses, enums, and explicit validation; the verification runner must not import application modules.

- `RoleId`: string enum with `backend`, `frontend`, `architecture`, `quality`, and `independent`.
- `GateStatus`: `passed`, `failed`, `blocked`, `skipped`, `timeout`, `cancelled`.
- `FindingStatus`: `candidate`, `validated`, `accepted`, `fixed`, `verified`, `deferred`, `rejected`.
- `Severity`: `critical`, `high`, `medium`, `low`, `informational`. Severity is not a confidence score.
- `EvidenceRef`: `path: str`, `kind: Literal["source", "test", "command", "manual"]`, `line_start: int | None`, `line_end: int | None`, `description: str`. Paths must be repository-relative source paths or run-relative artifact paths; reject traversal and unapproved absolute paths. Lines are positive, end is not before start, and both are supplied together when relevant. Descriptions must omit secrets and customer information.
- `Finding`: `id: str`, `role: RoleId`, `title: str`, `severity: Severity`, `status: FindingStatus`, `confidence: Literal["high", "medium", "low"]`, `category: Literal["correctness", "architecture", "testing", "configuration", "privacy", "documentation"]`, `affected_paths: list[str]`, `summary: str`, `expected_behavior: str`, `observed_behavior: str`, `evidence: list[EvidenceRef]`, `suggested_change: str`, `regression_tests: list[str]`, `owner: RoleId`, `duplicate_of: str | None`, `disposition_reason: str | None`. IDs match `F-[0-9]{4}` and are unique within a campaign. Validated findings require evidence; verified findings additionally require a successful post-change gate and independent review. Deferred/rejected findings require a reason. A hypothesis may remain a candidate and must not be described as a proven failure.
- `GateSpec`: `id: str`, `cwd: str`, `argv: list[str]`, `required: bool`, `timeout_seconds: int`, `depends_on: list[str]`, `profile: Literal["fast", "full", "postgres"]`. Use enumerated commands from checked-in configuration, not shell strings supplied by agents. Validate unique IDs, nonempty arguments, positive timeout bounded at 1800 seconds, repository/test-sandbox working directory, existing prerequisites, and an acyclic dependency graph.
- `GateResult`: `gate_id: str`, `status: GateStatus`, `exit_code: int | None`, `started_at: str`, `finished_at: str`, `duration_ms: int`, `log_path: str`, `reason: str | None`. UTC ISO-8601 timestamps; duration nonnegative. Passing requires completion and exit zero, not just a success-looking log. Missing runtime, unavailable required browser, missing evidence, or an unstarted prerequisite is blocked rather than passed.
- `RunManifest`: `schema_version: Literal[1]`, `run_id: str`, `started_at: str`, `finished_at: str | None`, `git_head: str | None`, `dirty_paths: list[str]`, `runtime_versions: dict[str, str]`, `profile: str`, `gates: list[GateResult]`, `findings: list[Finding]`, `agent_reviews: dict[str, Literal["pending", "completed", "blocked"]]`, `overall_status: GateStatus`. Run IDs combine a UTC timestamp and random suffix. Record unavailable metadata explicitly rather than inventing it.
- `RunContext`: `repository_root: Path`, `artifact_dir: Path`, `sandbox_dir: Path`, `python_executable: Path`, `environment: dict[str, str]`, `profile: str`. This is internal and must never serialize its complete environment.
- Configuration JSON has `schema_version`, `max_review_agents` (default 4; range 1–4), `gates`, and `profiles`. It must not contain secrets, arbitrary agent-provided commands, cloud credentials, or production URLs.

Application contracts:
- Move the existing `ClientMetricsData`, `CallRecord`, `Appointment`, and `PublicConfig` declarations from `frontend/src/App.tsx` unchanged to `frontend/src/types/api.ts`. Preserve every existing field, optionality, nullability, and timestamp representation; this is an extraction, not a new API schema.
- Move `ApiState<T>` with the existing fetch hook to `frontend/src/hooks/use-api.ts`. Preserve the initial loading/error semantics until behavior tests justify a change.
- Move `ChatMessage`, `ChatRequest`, `EndCallRequest`, `TranscribeRequest`, `ConfirmBookingRequest`, and `ConfirmBookingResponse` unchanged from `app/chat_api.py` to `app/chat/schemas.py`; re-export old public imports during migration. Preserve role literals, identifier patterns, size bounds, ticket semantics, and response status literals.
- Move `CallTokenRequest` and `CallTokenResponse` unchanged from `app/main.py` to `app/api/call_tokens.py` when extracting that router.
- Do not replace durable slot dictionaries, telemetry schemas, SQLAlchemy models, or SSE payloads with newly invented formats during this campaign. Capture their existing contracts in characterization tests first.
- Existing ORM classes `Customer`, `CallRecord`, `Appointment`, `CallTurn`, and `ConfirmationTicket`, together with `Base` and `UTCDateTime`, remain in `app/db.py`. No schema migration is scheduled merely for code organization.

[Files]

Add an isolated verification tool directory, reproducible browser tests, documented review roles, and narrowly scoped application extractions.

All paths below are complete repository-relative paths beneath `C:/Users/TL/Documents/Codex/2026-08-27`; no abbreviation changes the actual nested backend directory.

New verification and documentation files:
- `tools/verification/__init__.py`: package marker with no startup effects.
- `tools/verification/__main__.py`: module entry point for `python -m tools.verification`.
- `tools/verification/models.py`: record definitions and validators described above.
- `tools/verification/runner.py`: preflight, subprocess execution, lifecycle cleanup, gate ordering, and CLI implementation.
- `tools/verification/report.py`: redacted JSON/Markdown report writing and finding aggregation.
- `tools/verification/check_architecture.py`: Python AST and TypeScript compiler-based boundary-check coordination.
- `tools/verification/check_frontend_architecture.mjs`: TypeScript compiler API import graph inspection, using the frontend's existing TypeScript dependency.
- `tools/verification/config.json`: checked-in gate definitions and profiles.
- `tools/verification/tests/test_models.py`: standard-library unittest validation tests.
- `tools/verification/tests/test_runner.py`: subprocess, timeout, environment, paths, cleanup, and exit-code tests.
- `tools/verification/tests/test_report.py`: aggregation, redaction, artifact paths, and incomplete-evidence tests.
- `tools/verification/tests/test_architecture.py`: synthetic import graphs and boundary rules.
- `docs/verification/README.md`: repeatable IDE workflow, local commands, CI semantics, setup prerequisites, and manual-browser checklist.
- `docs/verification/roles.md`: prompts/scope for the five existing IDE review roles; these are reusable review instructions, not an independently executing agent framework.
- `docs/verification/architecture.md`: supported runtime, dependency direction, preserved contracts, and extraction decisions.
- `.github/workflows/verify.yml`: local-equivalent deterministic checks on PRs/pushes, plus a disposable PostgreSQL service job. If an existing equivalent workflow is found during baseline validation, extend it instead of duplicating it.

Generated, untracked artifacts:
- `artifacts/verification/<run-id>/manifest.json`: machine-readable complete result.
- `artifacts/verification/<run-id>/report.md`: evidence summary, gate status, review status, accepted/deferred findings.
- `artifacts/verification/<run-id>/logs/<gate-id>.log`: sanitized command output.
- `artifacts/verification/<run-id>/reviews/<role>.json`: structured agent findings.
- `artifacts/verification/<run-id>/browser/`: synthetic-data-only browser traces, screenshots, and test results.
- Store temporary databases and server working directories under a per-run OS temporary directory, not under a runtime application database path.

New test infrastructure:
- `frontend/playwright.config.ts`: loopback-only base URL, Chromium and WebKit projects, mobile viewport project, bounded timeouts, retained failure traces, no reuse of an unknown running server.
- `frontend/e2e/fixtures.ts`: page/media adapters, seeded synthetic-data identifiers, readiness checks, and private-admin context.
- `frontend/e2e/call-session.spec.ts`: greeting, typed interaction, lifecycle, local provider-failure fallback, and end-call assertions.
- `frontend/e2e/booking.spec.ts`: explicit confirmation, persisted appointment, restart visibility, and legitimate cancellation journey.
- `frontend/e2e/dashboard.spec.ts`: authenticated call list, pagination, appointments, loading/error states, and public configuration.
- `frontend/e2e/voice-lifecycle.spec.ts`: mocked recognition/output lifecycle, interruption, repeat start/stop, visibility changes, and cleanup.
- `frontend/e2e/api-origin.spec.ts`: test traffic remains local and separately originated admin cancellation works.
- `referenced-chatgpt-conversation-this-is-an/backend/tests/e2e_app.py`: test-only app factory using explicit settings and deterministic local provider replacements; never mounted or selected in production.
- `referenced-chatgpt-conversation-this-is-an/backend/tests/test_api_contracts.py`: route/schema/SSE characterization.
- `referenced-chatgpt-conversation-this-is-an/backend/tests/test_postgres_integration.py`: genuine opt-in disposable PostgreSQL persistence and transaction integration.
- `frontend/src/lib/api.test.ts`: API URL, request errors, and abort behavior where supported.
- `frontend/src/lib/architecture-contracts.test.ts`: frontend extraction and API contract checks, registered in the existing runner.

New application files for staged extraction:
- `referenced-chatgpt-conversation-this-is-an/backend/app/api/__init__.py`: router package marker.
- `referenced-chatgpt-conversation-this-is-an/backend/app/api/calls.py`: existing private call-list endpoint and serialization helpers.
- `referenced-chatgpt-conversation-this-is-an/backend/app/api/appointments.py`: existing list/cancel endpoints.
- `referenced-chatgpt-conversation-this-is-an/backend/app/api/call_tokens.py`: existing optional LiveKit token endpoint and request/response models.
- `referenced-chatgpt-conversation-this-is-an/backend/app/chat/__init__.py`: package marker.
- `referenced-chatgpt-conversation-this-is-an/backend/app/chat/schemas.py`: unchanged transport schemas.
- `referenced-chatgpt-conversation-this-is-an/backend/app/chat/booking_policy.py`: pure booking validation/confirmation helpers.
- `frontend/src/types/api.ts`: unchanged frontend transport types.
- `frontend/src/hooks/use-api.ts`: extracted data-loading hook and state type.
- `frontend/src/pages/dashboard-page.tsx`: existing DashboardPage and its page-local composition.
- `frontend/src/pages/calls-page.tsx`: existing CallsPage and page-local filters.
- `frontend/src/pages/appointments-page.tsx`: existing AppointmentsPage.
- `frontend/src/pages/settings-page.tsx`: existing SettingsPage.
- `frontend/src/components/dashboard/record-views.tsx`: shared call/appointment record views and badges.
- `frontend/src/components/dashboard/primitives.tsx`: shared dashboard-only display primitives.
- `frontend/src/lib/record-format.ts`: pure record formatting helpers.

Existing files to modify:
- `package.json`: add `verify`, `verify:fast`, and `verify:full` scripts delegating to the Python harness; retain existing build/dev commands.
- `.gitignore`: ignore verification artifacts, disposable browser outputs, and generated test data without ignoring source tests or plan/docs.
- `frontend/package.json`: add `@playwright/test` development dependency, `test:e2e`, `test:e2e:list`, and architecture check scripts; retain `test` and `build`.
- `frontend/package-lock.json`: update only for approved test dependency installation.
- `frontend/src/lib/run-tests.mjs`: register new suites and bound child executions; retain every existing suite and nonzero-exit behavior.
- `frontend/src/App.tsx`: import extracted types, hook, pages, shared record views, and helpers; retain top-level navigation/auth/data ownership initially.
- `frontend/src/lib/api.ts`: make tests able to select an explicit local base; fix only behavior supported by validated API tests; preserve existing deployed behavior unless an explicit change is approved.
- `frontend/src/components/ui/kokoro-call-session.tsx`, `frontend/src/lib/neural-audio-player.ts`, and `frontend/src/lib/speech-recognition.ts`: audit and regression-test first. Do not rewrite the voice state machine without a validated defect and a separate bounded patch.
- `referenced-chatgpt-conversation-this-is-an/backend/app/main.py`: correct CORS method coverage; move the three endpoint groups into routers while preserving paths, auth, limits, serialization, and thread offloading.
- `referenced-chatgpt-conversation-this-is-an/backend/app/chat_api.py`: import/re-export extracted schemas and policy helpers; retain endpoint orchestration and `_confirm_booking_sync` for this bounded cleanup.
- `referenced-chatgpt-conversation-this-is-an/backend/tests/test_api.py`: legitimate CORS/cancellation regression coverage.
- `referenced-chatgpt-conversation-this-is-an/backend/tests/test_chat_api.py`: extraction compatibility and unchanged dialogue contracts.
- `referenced-chatgpt-conversation-this-is-an/backend/tests/conftest.py`: only changes needed to support separate explicitly enabled PostgreSQL fixtures without weakening SQLite isolation; keep existing fixture aliases.
- `referenced-chatgpt-conversation-this-is-an/backend/pyproject.toml`: declare PostgreSQL/integration pytest markers and scope lint/type checks for new modules; retain strict mypy and Ruff rules.
- `referenced-chatgpt-conversation-this-is-an/README.md`, `referenced-chatgpt-conversation-this-is-an/DEPLOYMENT.md`, `PROJECT.md`, and `PROJECT_AND_BUSINESS_OVERVIEW.md`: reconcile current browser voice path, React version, dashboard status, and verification commands.
- `implementation_plan.md`: record approved deviations and completed milestones without overwriting the original requirements.

Files deleted or moved:
- No whole source files, deployment configs, legacy worker modules, historical audit reports, or existing tests are scheduled for deletion.
- Extractions remove duplicated definitions from their original modules only after imports and compatibility checks pass.
- No database migration or production deployment configuration change is implicitly authorized.

[Functions]

Add verification orchestration functions and extract existing pure/application functions without changing their contracts.

New functions in `tools/verification/runner.py`:
- `main(argv: list[str] | None = None) -> int`: CLI options `--profile fast|full|postgres`, `--python PATH`, `--review-results PATH`, and `--list`; return 0 only for all required selected gates passed, 1 for test/check failure, 2 for invalid configuration or blocked prerequisites, and 130 for cancellation.
- `load_config(path: Path) -> dict[str, object]`: parse checked-in configuration and reject invalid commands, paths, dependencies, and profiles.
- `preflight(repo_root: Path, python_executable: Path, profile: str) -> RunContext`: resolve versions, verify dependencies without installing them, capture Git metadata, and allocate isolated run directories.
- `build_test_environment(context: RunContext) -> dict[str, str]`: construct a minimal allowlisted environment, assign test settings and absolute disposable SQLite URL, disable legacy worker/reaper where appropriate, and exclude runtime secrets.
- `run_gate(spec: GateSpec, context: RunContext) -> GateResult`: run allowlisted argument vectors, capture output, enforce timeouts, preserve status, and write sanitized evidence.
- `run_profile(context: RunContext, specs: list[GateSpec]) -> list[GateResult]`: execute dependency-ordered gates, mark unsatisfied dependencies blocked, and do not conflate unrun gates with passes.
- `stop_process_tree(process: subprocess.Popen[str]) -> None`: terminate only process groups/trees created by the run; wait and escalate on timeout on Windows and Linux.
- `cleanup_run(context: RunContext) -> None`: stop owned services, dispose temporary resources, and retain report artifacts; execute on errors and cancellation.

New functions in `tools/verification/report.py`:
- `redact_output(text: str, sensitive_values: Sequence[str]) -> str`: remove known test credentials, auth headers, secret assignments, and database credentials before persistence; never print the raw environment.
- `load_review_results(directory: Path, run_id: str) -> list[Finding]`: require valid schema, run identity, role scope, and evidence paths.
- `merge_findings(findings: Sequence[Finding]) -> list[Finding]`: suggest deterministic duplicate grouping by normalized location/category/title; do not silently discard conflicting findings.
- `write_reports(manifest: RunManifest, destination: Path) -> None`: write schema-valid JSON and readable Markdown atomically with distinct test/review/manual-validation status.

New functions in `tools/verification/check_architecture.py`:
- `collect_python_imports(root: Path) -> dict[str, set[str]]`: use AST rather than regex to resolve local application imports.
- `check_boundaries(graph: dict[str, set[str]]) -> list[str]`: check new cycles and forbidden imports against documented rules.
- `main(argv: list[str] | None = None) -> int`: aggregate Python and frontend graph violations; fail on new violations without hiding a pre-existing baseline.

New frontend graph function:
- `collectFrontendImports(root: string): Map<string, Set<string>>` in `tools/verification/check_frontend_architecture.mjs`: resolve relative imports and configured aliases using TypeScript, including re-exports; exclude dependencies/build output.
- Graph direction: dashboard components/pages may depend on shared API types/hooks/helpers, not vice versa. Python booking-policy and schema modules may not import route handlers, database access, provider clients, or FastAPI request objects.

Modified/extracted backend functions:
- `app/main.py:create_app(settings: Settings | None = None) -> FastAPI`: remain the composition root; include routers, middleware, settings state, and lifespan.
- `app/main.py:create_app.list_calls` becomes module-level `list_calls` in `app/api/calls.py`, retaining `limit`, `offset`, return shape, `require_admin`, `_parse_client_metrics`, and thread offloading.
- `app/main.py:create_app.list_appointments` and `cancel_appointment_endpoint` become module-level names in `app/api/appointments.py`, preserving parameters, authentication, status codes, and `cancel_appointment` delegation.
- `app/main.py:create_app.create_call_token` becomes module-level `create_call_token` in `app/api/call_tokens.py`; resolve settings from `request.app.state.settings` instead of a lost closure; retain rate limit, active-call check, dispatch, telemetry, and error mapping.
- The router extraction must preserve test monkeypatch boundaries or migrate test patch targets without changing their assertions.
- Move `booking_missing_fields`, `booking_details_changed`, `is_explicit_booking_confirmation`, `booking_confirmation_fingerprint`, `booking_confirmation_text`, and `booking_result_text` from `app/chat_api.py` to `app/chat/booking_policy.py`. Preserve current signatures and behavior verbatim, retain re-exports, and pass immutable input mappings only if compatible with current tests.
- Keep `chat_stream`, `transcribe_audio`, `confirm_booking_endpoint`, `_confirm_booking_sync`, `end_call_record`, `_execute_tool`, and provider functions in their current modules during this campaign. Further decomposition is a separately gated follow-up, not part of a risky all-at-once rewrite.
- Keep `app/db.py:new_session`, `init_db`, `record_call_turn`, `get_recent_call_turns`, `create_confirmation_ticket`, and `get_confirmation_ticket` behavior unchanged unless the audit validates a defect.
- New `create_e2e_app() -> FastAPI` in `backend/tests/e2e_app.py`: create real routes against a disposable database with deterministic provider adapters and test-only settings. Fail startup if called with non-test configuration or nonlocal dependencies.

Modified/extracted frontend functions:
- Move `useApi<T>` from `frontend/src/App.tsx` to `frontend/src/hooks/use-api.ts`; retain its current signature and cancellation/polling behavior before making separate tested fixes.
- Keep `useHealth` and `useConfig` at their existing call sites initially; migrate only if their relationship to `useApi` permits a mechanical extraction.
- Move `DashboardPage`, `CallsPage`, `AppointmentsPage`, and `SettingsPage` to their named page files with unchanged props.
- Move `CallsTable`, `CallRow`, `MobileCallsList`, `AppointmentsTable`, `OutcomeBadge`, `StatusBadge`, `PlatformBadge`, and `InputPathBadge` to `components/dashboard/record-views.tsx`; preserve accessibility and responsive behavior.
- Move shared `StatCard`, `Card`, `SkeletonRows`, `Empty`, and `Spinner` to `components/dashboard/primitives.tsx` where needed by more than one extracted page.
- Move `fmt`, `duration`, and `getInitials` to `lib/record-format.ts` with unchanged return semantics.
- Leave default-exported `App` responsible for application composition. Do not change navigation, auth storage, request headers, or polling as an incidental consequence of moving JSX.
- `apiUrl(path: string): string` and `apiPost<T = unknown>(path: string, body?: unknown): Promise<T>` remain public compatibility APIs.

Removed functions:
- None are removed as capabilities. Old local definitions are removed after relocation, with compatibility exports where external tests/imports depend on them. Delete unused functions only with a validated finding, import-search evidence, and regression verification.

[Classes]

Add small verification record classes and relocate schema classes without introducing application service hierarchies.

New classes:
- The enums and dataclasses listed in [Types] are defined in `tools/verification/models.py`. Dataclass `__post_init__` checks local field invariants; explicit deserialization validates unknown JSON data. They do not inherit from application ORM classes or introduce network dependencies.
- Unit test classes in `tools/verification/tests/` inherit from `unittest.TestCase` and use temporary directories and mocked subprocesses.

Moved/modified classes:
- Pydantic chat request/response classes move unchanged to `app/chat/schemas.py`, retaining `BaseModel` inheritance and validation.
- `CallTokenRequest` and `CallTokenResponse` move unchanged to `app/api/call_tokens.py`.
- `Settings` in `app/config.py` remains the application settings authority. Test-only adapters must instantiate it explicitly without loading a developer's `.env`.
- `AudioLRUCache` in `app/tts_stream.py`, `HVACReceptionist` in `app/agent/worker.py`, and browser speech/audio controller classes remain intact unless a validated regression demands a targeted correction.

Removed classes:
- None. Do not introduce repository/service/controller class layers merely to make the architecture appear more elaborate.

[Dependencies]

Reuse the existing runtime and test stacks, adding only browser-testing development tooling after approval.

- Python verification harness: standard library only; Python 3.12 baseline, matching backend deployment. It must run its own unittest suite without importing FastAPI or installing a model SDK.
- Backend: use existing development dependencies from `backend/pyproject.toml`; pytest, pytest-asyncio, Ruff, mypy, and httpx remain. No broad version bump is planned.
- Frontend: add a single exact compatible stable version of `@playwright/test` to devDependencies and lock it in `frontend/package-lock.json`. The exact version is deliberately not invented: resolve it during approved installation against Node 22 and existing Vite/TypeScript, record the chosen version, and install matching Chromium/WebKit revisions. Do not use an unpinned `latest` in CI.
- Use Node 22 LTS with a version supporting `--experimental-strip-types` (at least 22.6); pin the actual verified CI patch version when setting up the workflow. Align `@types/node` only if the verified toolchain shows incompatibility, not as an unrelated upgrade.
- No Vitest/Jest migration, pytest-xdist, agent SDK, Redis, queue service, paid model runner, or new production package.
- PostgreSQL CI uses a disposable database compatible with the deployment's supported PostgreSQL version and the existing psycopg driver. It is never pointed at Render production. Record the tested database version.
- Dependency installation and browser downloads are network/approval steps. If unavailable, report the associated gates blocked; never replace them with fabricated passing results.
- CI receives no production LLM/TTS/LiveKit credentials. Existing provider imports may require installed packages, but normal test requests are deterministic and provider-network disabled.

[Testing]

Verify the workflow itself, preserve every existing regression suite, and add isolated real-browser and real-PostgreSQL coverage with honest capability limits.

Baseline before edits:
1. Capture `git status --short`, HEAD, changed paths, runtime versions, selected interpreter, and dependency availability. Preserve user modifications. If terminal output is unavailable, obtain a usable local log or explicit user-provided output; an empty output is not proof.
2. Start from an environment allowlist, explicit `APP_ENV=test`, `ENABLE_LIVEKIT_WORKER=false`, temporary absolute database URL, loopback API base, and no runtime `.env` loading.
3. Run backend tests serially: configured interpreter `-m pytest`, working directory `referenced-chatgpt-conversation-this-is-an/backend`, with output and exit status recorded. All existing test files remain included.
4. Run `npm --prefix frontend test` and `npm --prefix frontend run build`.
5. Run backend Ruff and strict mypy using the backend working directory/configuration. Record pre-existing failures rather than suppressing them.
6. Do not run tests against a live local server with an unknown database. Own the temporary processes/ports and stop only those processes.

Harness tests:
- Invalid configuration, dependency cycles, missing executables, missing browsers, wrong run ID, invalid findings, unsafe artifact paths, rejected command injection, and unknown profile.
- Nonzero child exit, zero exit with missing required output, timeout, interruption, subprocess launch failure, and required gate blocked by a failed dependency.
- Windows paths with spaces, UTF-8 logs, Python executable override, npm executable resolution, process-tree cleanup, and local port collision.
- Credential redaction, untrusted source treated as data rather than instructions, report escaping, valid JSON, atomic output, and agent review marked pending when not run.
- Verify allowlisted environment construction does not forward production endpoints or credentials and cleanup never deletes paths outside the owned temporary directory.

Backend/application regression coverage:
- Legitimate cross-origin authenticated appointment cancellation with an allowed origin and DELETE; preserve auth dependency and route error behavior.
- Public config, private call/appointment serializers, limits/offsets, cancellation, optional dispatch error mapping, and route/OpenAPI equivalence after extraction.
- Greeting, normal deterministic booking dialogue, explicit confirmation, legitimate confirmation retry idempotency, changed booking details, unavailable slot, timezone/business hours, server transcript persistence, and end-call finalization.
- Preserve existing privacy/authority tests; review their defensive intent without creating exploit workflows or testing third-party systems.
- SSE order and payload compatibility at existing endpoints, including chunked delivery and ordinary disconnect/error cleanup.
- PostgreSQL gate must create actual tables in a disposable database and exercise supported persistence, UTC round-trips, booking uniqueness/idempotency, cancellation, and commit/rollback. Dialect compilation or monkeypatching an engine does not count as a PostgreSQL integration pass.
- Separate PostgreSQL opt-in fixture must not be silently replaced by the autouse SQLite fixture. Explicit marker and environment required; refuse unsafe database targets.

Frontend and browser coverage:
- Keep normalization, lifecycle, telemetry, touch-target, audio audit/stress, and recognition suites listed by the existing `run-tests.mjs`.
- New tests exercise extracted pure functions and hooks without relying only on source-text matching.
- Run built frontend against an owned local backend for true UI-to-HTTP-to-database flows. Mock only external providers/media capabilities at explicit boundaries, not the application API for the booking/persistence E2E journey.
- Use a separate browser origin/backend port for the CORS case rather than letting Vite proxy conceal the method mismatch.
- Cover call greeting, typed fallback, progress/loading feedback, provider failure messaging, booking confirmation, call log outcome, authenticated appointment list/cancellation, pagination, end-call, repeat start/stop, and unmount cleanup.
- Assert no network requests reach production Render/Vercel/provider endpoints in the deterministic suite; configure CSP/request blocking or equivalent test controls for external assets/model downloads.
- Chromium and WebKit automation cover the supported automated subset. WebKit emulation is not physical iOS validation. Mocked speech recognition and synthetic audio do not prove real microphone, autoplay, audible quality, Bluetooth, or device lock-screen behavior.
- Manual acceptance checklist: desktop Chrome, desktop Safari where available, physical iOS Safari and Android Chrome; microphone grant/deny, audible start/stop, interruption, permission recovery, background/foreground, slow/offline recovery, and repeated sessions. Missing devices produce a recorded limitation, not a pass.
- No hard latency or coverage target is invented. Capture observed timing if meaningful, but never claim provider latency from mocks.

Review campaign:
- `backend`: chat/booking/scheduling/persistence correctness and test contracts.
- `frontend`: UI, request/stream consumption, audio/recognition lifecycle, accessibility and fallback behavior.
- `architecture`: import boundaries, state ownership, configuration/deployment consistency, defensive privacy review, and extraction suitability.
- `quality`: test completeness, process/database isolation, reproducibility, E2E realism, and gate integrity.
- Run at most four read-only specialists concurrently over the same recorded baseline. Each receives scoped paths, the current manifest, and exact output schema. No specialist edits shared files.
- Coordinator validates/deduplicates candidates and assigns one writer per approved fix. Shared modules `main.py`, `chat_api.py`, `App.tsx`, manifests, and fixtures are coordinator-owned; never concurrently edited by separate agents.
- After fixes, a fresh `independent` reviewer validates changed code and evidence rather than accepting the implementer's conclusions. Missing/truncated agent output is blocked until complete evidence is obtained.
- Limit a fix batch to three remediation/retest cycles before documenting the blocker for user review. Do not loop indefinitely.

Acceptance:
- Harness unittest, full existing frontend/backend suites, TypeScript build, Ruff, strict mypy, architecture checks, required browser suite, and disposable PostgreSQL gate all pass for the final candidate; otherwise clearly report incomplete status.
- Every accepted critical/high finding must be independently verified fixed before declaring completion. Medium/low deferrals have explicit reason and owner; a waiver is never reported as a clean pass.
- No newly introduced import cycle or forbidden dependency; moved capabilities retain contracts and tests.
- Runtime data unchanged; no production contacts, secrets in artifacts, lost user changes, or unexpected files.
- Reports distinguish deterministic CI status, agent review status, and manual device acceptance.
- Do not claim “bug-free,” “fully production verified,” or “100% end-to-end coverage.”

[Implementation Order]

Establish trustworthy evidence first, implement the reusable harness second, fix validated defects third, and perform behavior-preserving cleanup only behind passing regression gates.

1. **Obtain implementation authorization and verify the baseline.** Planning research is complete enough to execute this plan, but no coding is authorized by the plan's existence. Capture actual Git/runtime/test baselines and preserve dirty files. Do not commit or push unless separately requested.
2. **Define records, roles, and reporting contracts.** Create verification models/configuration, role instructions, artifact policy, architecture direction, and harness unit tests.
3. **Implement the local deterministic harness.** Add isolated environment construction, safe subprocess execution, lifecycle cleanup, full result capture, report generation, and root commands. Test failure paths before using it to judge application quality.
4. **Run the first audit campaign.** Capture baseline gates; orchestrate four scoped read-only IDE specialists; retain complete evidence, merge duplicates, and classify candidate versus validated findings. Do not begin unbounded automated repairs.
5. **Add reliable integration/browser gates.** Install approved browser tooling, add test-only local provider adapters and disposable database/server fixtures, register E2E scripts, and establish genuine PostgreSQL testing separately from SQLite.
6. **Fix validated behavior defects in small batches.** Start with CORS method coverage for the existing cancellation endpoint. For each defect, add a focused legitimate regression, make the minimum code change, run the relevant tests, then rerun full existing suites. Do not alter assertions to disguise a changed behavior.
7. **Extract backend boundaries.** Move call/appointment/token routers, then chat schemas and pure booking helpers. Preserve settings injection, auth/rate-limit behavior, public imports, patch targets, transactions, and SSE schemas. Retest after each extraction.
8. **Extract frontend boundaries.** Move transport types, `useApi`, pure formatting, shared record views/primitives, and individual pages. Leave voice orchestration intact unless a validated issue requires a separate patch. Retest TypeScript, existing frontend suites, and browser journeys after each group.
9. **Wire CI and reconcile documentation.** Use the same harness locally and in CI with pinned runtimes, least-privilege repository permissions, sanitized artifacts, bounded retention, and disposable PostgreSQL. AI review remains an IDE step; CI does not pretend to execute agents.
10. **Independently verify and deliver.** Run full gates on the final candidate, run a fresh independent review, document device/provider limitations and remaining findings, inspect the final diff/artifact inventory, and publish a concise completion report. Stop without committing or deploying unless explicitly authorized.

Implementation task handoff:

The available tool set in this conversation does not expose a callable `new_task` tool. Do not claim that a new task has been created when it has not. The self-contained context below can be submitted through a new-task interface if available, or used to continue this task after the user explicitly authorizes implementation and toggles to Act mode.

1. Current Work:
   - User requested both an initial multi-agent audit campaign and a reusable local/CI verification harness.
   - User selected IDE subagents, not an independent paid API/SDK.
   - Planning only; no application fixes or fresh test results are claimed.
   - Refer to @implementation_plan.md for a complete breakdown of the task requirements and steps. You should periodically read this file again.
   - Absolute plan path: `C:/Users/TL/Documents/Codex/2026-08-27/implementation_plan.md`.
   - Request that the user toggle to Act mode and explicitly approve implementation before editing application code.

2. Key Technical Concepts:
   - Python 3.12/FastAPI/SQLAlchemy, React 19/TypeScript/Vite, browser speech lifecycle, SSE, durable calls, explicit confirmation booking, optional legacy LiveKit.
   - IDE coordinates bounded read-only specialists; deterministic Python harness runs tests and preserves structured evidence.
   - No production traffic/data, autonomous offensive workflows, hidden provider dependency, broad rewrite, or unapproved commits/deployments.
   - Real browser-to-local-API-to-disposable-DB flows plus explicit external provider/media stubs; no claims of physical-device/provider verification from mocks.

3. Relevant Files and Code:
   - Exact files/functions are enumerated in [Files], [Functions], and [Classes].
   - Frontend existing suite entry: `frontend/src/lib/run-tests.mjs`; run with `npm --prefix frontend test`.
   - Frontend build: `npm --prefix frontend run build`.
   - Backend manifest: `referenced-chatgpt-conversation-this-is-an/backend/pyproject.toml`; run pytest/Ruff/mypy with this backend as subprocess working directory.
   - Existing isolation: `backend/tests/conftest.py` and `app/db.py`; establish safe environment before import/collection.
   - First bounded correction: CORS method coverage in `app/main.py:create_app` for the existing authenticated DELETE appointment route.

4. Problem Solving:
   - Four subagents performed read-only source research. Their shortened returned summaries are not full audit artifacts.
   - Shell behavior observed was PowerShell even though environment metadata named cmd.exe. The original `&&` command failed. Later terminal output was uncaptured; Git cleanliness and installed versions remain unverified.
   - Use portable subprocess argument vectors with explicit cwd in the harness, and record exit codes. Do not repeat broad research or assume success from missing terminal output.
   - Preserve current public contracts and existing assertions. Treat unverified issues as candidates.

5. Pending Tasks and Next Steps:
   - Execute steps 1–10 above after approval.
   - Keep the following checklist in the implementation task context and, if a new-task tool supports it, supply it separately as the task_progress parameter as well.

task_progress Items:
- [ ] Step 1: Approve implementation and capture safe Git/runtime/test baselines
- [ ] Step 2: Define verification schemas, review roles, configuration, and harness tests
- [ ] Step 3: Implement and verify isolated local execution and evidence reporting
- [ ] Step 4: Run four scoped audit agents and validate their findings
- [ ] Step 5: Add deterministic browser E2E and genuine disposable PostgreSQL gates
- [ ] Step 6: Fix validated defects with focused and full-suite regression checks
- [ ] Step 7: Extract backend routers, schemas, and pure booking policy
- [ ] Step 8: Extract frontend contracts, data hook, record views, and pages
- [ ] Step 9: Integrate CI and update current architecture/runtime documentation
- [ ] Step 10: Complete independent verification and report limitations without committing or deploying

Plan document navigation commands:

From the repository root in Git Bash or another shell with sed/cat, use the commands below. Unlike the original illustrative `head -n 1`, these return each complete section rather than only its heading.

```sh
# Overview
sed -n '/^\[Overview\]$/,/^\[Types\]$/{ /^\[Types\]$/d; p; }' implementation_plan.md | cat
# Types
sed -n '/^\[Types\]$/,/^\[Files\]$/{ /^\[Files\]$/d; p; }' implementation_plan.md | cat
# Files
sed -n '/^\[Files\]$/,/^\[Functions\]$/{ /^\[Functions\]$/d; p; }' implementation_plan.md | cat
# Functions
sed -n '/^\[Functions\]$/,/^\[Classes\]$/{ /^\[Classes\]$/d; p; }' implementation_plan.md | cat
# Classes
sed -n '/^\[Classes\]$/,/^\[Dependencies\]$/{ /^\[Dependencies\]$/d; p; }' implementation_plan.md | cat
# Dependencies
sed -n '/^\[Dependencies\]$/,/^\[Testing\]$/{ /^\[Testing\]$/d; p; }' implementation_plan.md | cat
# Testing
sed -n '/^\[Testing\]$/,/^\[Implementation Order\]$/{ /^\[Implementation Order\]$/d; p; }' implementation_plan.md | cat
# Implementation Order
sed -n '/^\[Implementation Order\]$/,$p' implementation_plan.md | cat
```

PowerShell alternative, because PowerShell's default `cat` alias reads files rather than acting as Unix cat:

```powershell
# Process-local pass-through cat; does not change a profile or system settings.
Remove-Item Alias:cat -ErrorAction SilentlyContinue
function cat { process { $_ } }
function Read-PlanSection([string]$Name) {
    $text = [IO.File]::ReadAllText((Join-Path (Get-Location) 'implementation_plan.md'))
    $pattern = '(?ms)^\[' + [regex]::Escape($Name) + '\]\r?\n.*?(?=^\[(?:Overview|Types|Files|Functions|Classes|Dependencies|Testing|Implementation Order)\]\r?$|\z)'
    [regex]::Match($text, $pattern).Value
}
Read-PlanSection 'Overview' | cat
Read-PlanSection 'Types' | cat
Read-PlanSection 'Files' | cat
Read-PlanSection 'Functions' | cat
Read-PlanSection 'Classes' | cat
Read-PlanSection 'Dependencies' | cat
Read-PlanSection 'Testing' | cat
Read-PlanSection 'Implementation Order' | cat
```

End of implementation task handoff.
