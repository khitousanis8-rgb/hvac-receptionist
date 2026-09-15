# pyright: reportCallIssue=false
"""Milestone 5 Challenger 2 Empirical Verification Test Suite.

Rigorously verifies:
1. End-to-end call lifecycle with telemetry:
   - Call token initiation -> greeting turn carrying telemetry -> chat messages -> end call.
   - Serialized telemetry fields in GET /v1/calls (platform_class, browser_engine, input_path, mic_permission, end_reason, client_metrics).
   - Strict absence of extraneous fields (raw UA, raw audio, PII).
2. Autonomous stale-call reaper:
   - Abandoned calls (>20 min) finalized as 'info_only' (or 'booked' if confirmed slots exist).
   - Execution without requiring GET /v1/calls.
   - GET /v1/calls remains strictly read-only when reaper is disabled.
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app.call_tracking import start_call
from app.config import Settings
from app.db import CallRecord, new_session
from app.main import create_app

_TEST_SECRET = "b" * 64
_ADMIN_KEY = "challenger2-admin-secret"


@pytest.fixture
def test_settings() -> Settings:
    return Settings(
        ADMIN_API_KEY=_ADMIN_KEY,
        BUSINESS_COMPANY_NAME="Apex HVAC Pros",
        LIVEKIT_URL="wss://livekit.test.example",
        LIVEKIT_API_KEY="test_lk_key",
        LIVEKIT_API_SECRET="test_lk_secret_which_is_long_enough_for_jwt",
        LLM_API_KEY="test-llm-key",
        BUSINESS_OPENING_HOURS='{"monday":"08:00-18:00"}',
        _env_file=None,
    )


def test_e2e_telemetry_lifecycle_desktop_chromium(test_settings: Settings) -> None:
    """Empirically verify end-to-end call lifecycle with telemetry for desktop chromium.

    Lifecycle:
    1. Initiate call token (/v1/calls/token)
    2. Start call with greeting turn (/v1/calls/chat) carrying initial telemetry + canaries
    3. Send message (/v1/calls/chat) carrying updated telemetry + canaries
    4. End call (/v1/calls/end) carrying complete final telemetry + canaries
    5. Query GET /v1/calls and assert complete serialized telemetry fields
    6. Verify all canaries and extraneous fields are strictly absent
    """
    app = create_app(test_settings)
    room_name = "challenger-e2e-desktop-01"

    with patch("app.agent.dispatch.LiveKitAPI") as mock_livekit:
        mock_instance = AsyncMock()
        mock_livekit.return_value.__aenter__.return_value = mock_instance

        with TestClient(app) as client:
            # 1. Initiate call token
            token_res = client.post(
                "/v1/calls/token",
                json={
                    "room_name": room_name,
                    "identity": "caller-john-doe",
                    "client_telemetry": {
                        "platform_class": "desktop",
                        "browser_engine": "chromium",
                        # Adversarial / extraneous injections
                        "raw_user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) CANARY_UA_TOKEN",
                        "user_ssn": "000-12-CANARY-SSN",
                    },
                },
            )
            assert token_res.status_code == 200, token_res.text
            token_data = token_res.json()
            assert token_data["room"] == room_name
            assert "token" in token_data

            # 2. Start call with greeting turn carrying telemetry
            greeting_res = client.post(
                "/v1/calls/chat",
                json={
                    "session_id": room_name,
                    "message": "__GREETING__",
                    "call_secret": _TEST_SECRET,
                    "client_telemetry": {
                        "platform_class": "desktop",
                        "browser_engine": "chromium",
                        "input_path": "native_web_speech",
                        "mic_permission": "granted",
                        # Canary injections
                        "raw_audio": "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAACANARY_AUDIO_BUFFER",
                        "credit_card": "4111-2222-3333-CANARY-CC",
                    },
                },
            )
            assert greeting_res.status_code == 200
            assert "event: call_started" in greeting_res.text

            call_id: int | None = None
            for line in greeting_res.text.splitlines():
                if line.startswith("data: ") and "call_id" in line:
                    data = json.loads(line[len("data: ") :])
                    if "call_id" in data:
                        call_id = int(data["call_id"])
                        break
            assert call_id is not None

            # 3. Send intermediate message carrying turn telemetry
            msg_res = client.post(
                "/v1/calls/chat",
                json={
                    "session_id": room_name,
                    "call_id": call_id,
                    "call_secret": _TEST_SECRET,
                    "message": "Hello, I need help with my AC.",
                    "client_telemetry": {
                        "first_assistant_audio_ms": 1120.5,
                        "first_caller_transcript_ms": 2340.0,
                        "echo_suppressions": 2,
                        # Canary injections
                        "pii_leak": "SECRET_PASSCODE_CANARY",
                    },
                },
            )
            assert msg_res.status_code in (200, 503)

            # 4. End call carrying complete client telemetry
            end_res = client.post(
                "/v1/calls/end",
                json={
                    "session_id": room_name,
                    "call_id": call_id,
                    "call_secret": _TEST_SECRET,
                    "outcome": "booked",
                    "summary": "Customer confirmed maintenance appointment.",
                    "client_telemetry": {
                        "stt_errors": 1,
                        "tts_errors": 0,
                        "end_reason": "completed",
                        # Adversarial / extraneous injections
                        "raw_user_agent_header": "Mozilla/5.0 CANARY_HEADER_IN_END",
                        "audio_stream_dump": "BASE64_CANARY_AUDIO_END_DUMP",
                    },
                },
            )
            assert end_res.status_code == 200
            assert end_res.json() == {"status": "ok", "call_id": call_id, "outcome": "booked"}

            # 5. Query GET /v1/calls and assert serialized telemetry fields
            admin_res = client.get("/v1/calls", headers={"X-Admin-Key": _ADMIN_KEY})
            assert admin_res.status_code == 200
            calls_list = admin_res.json()
            assert calls_list["total"] >= 1

            matched = [c for c in calls_list["items"] if c["id"] == call_id]
            assert len(matched) == 1
            call_record = matched[0]

            # Assert all serialized telemetry fields
            assert call_record["platform_class"] == "desktop"
            assert call_record["browser_engine"] == "chromium"
            assert call_record["input_path"] == "native_web_speech"
            assert call_record["mic_permission"] == "granted"
            assert call_record["end_reason"] == "completed"
            assert call_record["outcome"] == "booked"

            client_metrics = call_record["client_metrics"]
            assert isinstance(client_metrics, dict)
            assert client_metrics["first_assistant_audio_ms"] == 1120.5
            assert client_metrics["first_caller_transcript_ms"] == 2340.0
            assert client_metrics["echo_suppressions"] == 2
            assert client_metrics["stt_errors"] == 1
            assert client_metrics["tts_errors"] == 0
            assert client_metrics["end_reason"] == "completed"

            # 6. Verify extraneous fields and canaries are strictly absent
            raw_response_text = admin_res.text
            canaries = [
                "CANARY_UA_TOKEN",
                "CANARY-SSN",
                "CANARY_AUDIO_BUFFER",
                "CANARY-CC",
                "SECRET_PASSCODE_CANARY",
                "CANARY_HEADER_IN_END",
                "BASE64_CANARY_AUDIO_END_DUMP",
            ]
            for canary in canaries:
                assert canary not in raw_response_text, f"Canary '{canary}' leaked in GET /v1/calls!"

            # Assert no extraneous keys in item or client_metrics
            allowed_record_keys = {
                "id",
                "room_name",
                "caller_phone",
                "outcome",
                "transcript_summary",
                "started_at",
                "ended_at",
                "platform_class",
                "browser_engine",
                "input_path",
                "mic_permission",
                "end_reason",
                "client_metrics",
            }
            assert set(call_record.keys()) == allowed_record_keys

            allowed_metric_keys = {
                "first_assistant_audio_ms",
                "first_caller_transcript_ms",
                "echo_suppressions",
                "stt_errors",
                "tts_errors",
                "end_reason",
            }
            assert set(client_metrics.keys()).issubset(allowed_metric_keys)


def test_e2e_telemetry_lifecycle_mobile_webkit(test_settings: Settings) -> None:
    """Empirically verify mobile webkit fallback path with denied mic permission."""
    app = create_app(test_settings)
    room_name = "challenger-e2e-mobile-02"

    with TestClient(app) as client:
        # Start greeting turn
        greeting_res = client.post(
            "/v1/calls/chat",
            json={
                "session_id": room_name,
                "message": "__GREETING__",
                "call_secret": _TEST_SECRET,
                "client_telemetry": {
                    "platform_class": "mobile",
                    "browser_engine": "webkit",
                    "input_path": "media_recorder_transcription",
                    "mic_permission": "denied",
                },
            },
        )
        assert greeting_res.status_code == 200
        call_id = None
        for line in greeting_res.text.splitlines():
            if line.startswith("data: ") and "call_id" in line:
                call_id = int(json.loads(line[len("data: ") :])["call_id"])
                break
        assert call_id is not None

        # End call due to user hangup
        end_res = client.post(
            "/v1/calls/end",
            json={
                "session_id": room_name,
                "call_id": call_id,
                "call_secret": _TEST_SECRET,
                "outcome": "info_only",
                "summary": "Caller hung up due to mic permission denied.",
                "client_telemetry": {
                    "end_reason": "user_hangup",
                    "stt_errors": 3,
                },
            },
        )
        assert end_res.status_code == 200

        # Query GET /v1/calls
        admin_res = client.get("/v1/calls", headers={"X-Admin-Key": _ADMIN_KEY})
        assert admin_res.status_code == 200
        items = admin_res.json()["items"]
        rec = next(c for c in items if c["id"] == call_id)

        assert rec["platform_class"] == "mobile"
        assert rec["browser_engine"] == "webkit"
        assert rec["input_path"] == "media_recorder_transcription"
        assert rec["mic_permission"] == "denied"
        assert rec["end_reason"] == "user_hangup"
        assert rec["outcome"] == "info_only"
        assert rec["client_metrics"] == {
            "end_reason": "user_hangup",
            "stt_errors": 3,
            "echo_suppressions": 0,
            "tts_errors": 0,
        }


def test_reaper_autonomous_finalization_unconfirmed_slots(test_settings: Settings) -> None:
    """Verify abandoned call (>20 min) without confirmed slots is reaped as 'info_only'

    WITHOUT calling GET /v1/calls.
    """
    call_id = start_call("reaper-abandoned-info-only")
    stale_time = datetime.now(UTC) - timedelta(minutes=26)

    with new_session() as session:
        rec = session.get(CallRecord, call_id)
        assert rec is not None
        rec.started_at = stale_time
        rec.session_slots = json.dumps({"service": "AC Inspection", "confirmed": False})
        rec.outcome = "in_progress"
        session.commit()

    app = create_app(test_settings)
    # Start lifespan context manager (triggers reaper sweep)
    # Explicitly DO NOT call GET /v1/calls!
    with TestClient(app) as client:
        health_res = client.get("/health")
        assert health_res.status_code == 200

    # Inspect directly in the database
    with new_session() as session:
        finalized = session.get(CallRecord, call_id)
        assert finalized is not None
        assert finalized.ended_at is not None
        assert finalized.ended_at == stale_time + timedelta(minutes=3)
        assert finalized.outcome == "info_only"
        assert "automatically finalized by stale-call reaper" in (finalized.transcript_summary or "")


def test_reaper_autonomous_finalization_confirmed_slots(test_settings: Settings) -> None:
    """Verify abandoned call (>20 min) WITH confirmed slots is reaped as 'booked'

    WITHOUT calling GET /v1/calls.
    """
    call_id = start_call("reaper-abandoned-booked")
    stale_time = datetime.now(UTC) - timedelta(minutes=45)

    with new_session() as session:
        rec = session.get(CallRecord, call_id)
        assert rec is not None
        rec.started_at = stale_time
        rec.session_slots = json.dumps(
            {
                "service": "Emergency Heating Repair",
                "phone": "+15559876543",
                "date": "2026-10-15",
                "time": "14:00",
                "confirmed": True,
            }
        )
        rec.outcome = "in_progress"
        session.commit()

    app = create_app(test_settings)
    # Explicitly DO NOT call GET /v1/calls!
    with TestClient(app) as client:
        health_res = client.get("/health")
        assert health_res.status_code == 200

    # Verify directly in SQLite
    with new_session() as session:
        finalized = session.get(CallRecord, call_id)
        assert finalized is not None
        assert finalized.ended_at is not None
        assert finalized.ended_at == stale_time + timedelta(minutes=3)
        assert finalized.outcome == "booked"
        assert "automatically finalized by stale-call reaper" in (finalized.transcript_summary or "")


def test_reaper_ignores_active_and_already_ended_calls(test_settings: Settings) -> None:
    """Verify reaper ignores calls < 20 min and preserves already ended calls."""
    active_id = start_call("reaper-recent-active")
    active_time = datetime.now(UTC) - timedelta(minutes=8)

    ended_id = start_call("reaper-already-ended")
    ended_start = datetime.now(UTC) - timedelta(minutes=40)
    ended_finish = ended_start + timedelta(minutes=5)

    with new_session() as session:
        active_rec = session.get(CallRecord, active_id)
        assert active_rec is not None
        active_rec.started_at = active_time
        active_rec.outcome = "in_progress"

        ended_rec = session.get(CallRecord, ended_id)
        assert ended_rec is not None
        ended_rec.started_at = ended_start
        ended_rec.ended_at = ended_finish
        ended_rec.outcome = "booked"
        ended_rec.transcript_summary = "Original customer booked."
        session.commit()

    app = create_app(test_settings)
    with TestClient(app) as client:
        res = client.get("/health")
        assert res.status_code == 200

    with new_session() as session:
        # Active call was not touched
        active_check = session.get(CallRecord, active_id)
        assert active_check is not None
        assert active_check.ended_at is None
        assert active_check.outcome == "in_progress"

        # Ended call was not overwritten
        ended_check = session.get(CallRecord, ended_id)
        assert ended_check is not None
        assert ended_check.ended_at == ended_finish
        assert ended_check.outcome == "booked"
        assert ended_check.transcript_summary == "Original customer booked."


def test_get_calls_strictly_read_only_when_reaper_disabled(test_settings: Settings) -> None:
    """Verify GET /v1/calls does not finalize abandoned calls when reaper is disabled."""
    call_id = start_call("reaper-disabled-read-only")
    stale_time = datetime.now(UTC) - timedelta(minutes=35)

    with new_session() as session:
        rec = session.get(CallRecord, call_id)
        assert rec is not None
        rec.started_at = stale_time
        rec.outcome = "in_progress"
        session.commit()

    app = create_app(test_settings)
    app.state.enable_stale_call_reaper = False

    with TestClient(app) as client:
        res = client.get("/v1/calls", headers={"X-Admin-Key": _ADMIN_KEY})
        assert res.status_code == 200
        items = res.json()["items"]
        item = next(c for c in items if c["id"] == call_id)
        assert item["ended_at"] is None
        assert item["outcome"] == "in_progress"

    # Confirm in database that no mutation occurred
    with new_session() as session:
        unchanged = session.get(CallRecord, call_id)
        assert unchanged is not None
        assert unchanged.ended_at is None
        assert unchanged.outcome == "in_progress"
        assert unchanged.transcript_summary is None


def test_reaper_background_loop_graceful_shutdown() -> None:
    """Verify the reaper background task in lifespan shuts down cleanly on exit."""
    from app.main import _stale_call_reaper_loop

    # Fast cancellation check
    async def _test_loop():
        task = asyncio.create_task(_stale_call_reaper_loop(interval_seconds=0.1))
        await asyncio.sleep(0.05)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    asyncio.run(_test_loop())


def test_telemetry_counter_monotonic_max_and_merging(test_settings: Settings) -> None:
    """Verify that successive turns monotonically increase counters and preserve first latencies."""
    app = create_app(test_settings)
    room_name = "challenger-monotonic-telemetry"

    with TestClient(app) as client:
        # 1. Greeting sets initial platform
        res1 = client.post(
            "/v1/calls/chat",
            json={
                "session_id": room_name,
                "message": "__GREETING__",
                "call_secret": _TEST_SECRET,
                "client_telemetry": {
                    "platform_class": "desktop",
                    "browser_engine": "gecko",
                    "input_path": "native_web_speech",
                    "mic_permission": "granted",
                    "first_assistant_audio_ms": 900,
                },
            },
        )
        assert res1.status_code == 200
        call_id = int(
            [json.loads(line[6:])["call_id"] for line in res1.text.splitlines() if "call_id" in line][0]
        )

        # 2. Turn 1 reports echo_suppressions = 3
        res2 = client.post(
            "/v1/calls/chat",
            json={
                "session_id": room_name,
                "call_id": call_id,
                "call_secret": _TEST_SECRET,
                "message": "First message",
                "client_telemetry": {
                    "first_caller_transcript_ms": 1800,
                    "echo_suppressions": 3,
                    "stt_errors": 1,
                },
            },
        )
        assert res2.status_code in (200, 503)

        # 3. Turn 2 reports lower echo_suppressions = 1 (should NOT downgrade from 3)
        res3 = client.post(
            "/v1/calls/chat",
            json={
                "session_id": room_name,
                "call_id": call_id,
                "call_secret": _TEST_SECRET,
                "message": "Second message",
                "client_telemetry": {
                    "echo_suppressions": 1,
                    "stt_errors": 4,  # STT errors increased
                },
            },
        )
        assert res3.status_code in (200, 503)

        # 4. End call
        res4 = client.post(
            "/v1/calls/end",
            json={
                "session_id": room_name,
                "call_id": call_id,
                "call_secret": _TEST_SECRET,
                "outcome": "info_only",
                "client_telemetry": {
                    "tts_errors": 2,
                    "end_reason": "completed",
                },
            },
        )
        assert res4.status_code == 200

        # Verify final record via GET /v1/calls
        admin_res = client.get("/v1/calls", headers={"X-Admin-Key": _ADMIN_KEY})
        assert admin_res.status_code == 200
        rec = next(c for c in admin_res.json()["items"] if c["id"] == call_id)

        assert rec["platform_class"] == "desktop"
        assert rec["browser_engine"] == "gecko"
        assert rec["end_reason"] == "completed"

        metrics = rec["client_metrics"]
        assert metrics["first_assistant_audio_ms"] == 900
        assert metrics["first_caller_transcript_ms"] == 1800
        assert metrics["echo_suppressions"] == 3  # Preserved max
        assert metrics["stt_errors"] == 4          # Preserved max
        assert metrics["tts_errors"] == 2
        assert metrics["end_reason"] == "completed"


def test_reaper_massive_batch_and_boundary_precision() -> None:
    """Stress test reaper with a mixed batch of 60 calls, corrupted slots, and boundary checks."""
    from app.call_tracking import reap_stale_calls

    now = datetime.now(UTC)
    boundary_recent = now - timedelta(minutes=19, seconds=50)  # Should NOT be reaped
    boundary_stale = now - timedelta(minutes=20, seconds=10)   # MUST be reaped
    very_stale = now - timedelta(minutes=50)

    with new_session() as session:
        # 1. Boundary recent (19m 50s)
        recent_call = CallRecord(
            room_name="boundary-recent",
            started_at=boundary_recent,
            outcome="in_progress",
        )
        # 2. Boundary stale (20m 10s)
        stale_call = CallRecord(
            room_name="boundary-stale",
            started_at=boundary_stale,
            outcome="in_progress",
        )
        # 3. Stale with corrupt session_slots JSON string
        corrupt_slots_call = CallRecord(
            room_name="corrupt-slots",
            started_at=very_stale,
            outcome="in_progress",
            session_slots="{not-valid-json-slots!!",
        )
        # 4. Stale with string fallback confirmed
        regex_confirmed_call = CallRecord(
            room_name="regex-confirmed",
            started_at=very_stale,
            outcome="in_progress",
            session_slots='{"appointment": "booked", "confirmed": true}',
        )
        # 5. Batch of 20 unconfirmed stale
        batch_unconfirmed = [
            CallRecord(
                room_name=f"batch-unconf-{i}",
                started_at=very_stale - timedelta(minutes=i),
                outcome="in_progress",
            )
            for i in range(20)
        ]
        # 6. Batch of 20 confirmed stale
        batch_confirmed = [
            CallRecord(
                room_name=f"batch-conf-{i}",
                started_at=very_stale - timedelta(minutes=i),
                outcome="in_progress",
                session_slots=json.dumps({"confirmed": True, "date": "2026-12-01"}),
            )
            for i in range(20)
        ]

        session.add_all(
            [recent_call, stale_call, corrupt_slots_call, regex_confirmed_call]
            + batch_unconfirmed
            + batch_confirmed
        )
        session.commit()

        recent_id = recent_call.id
        stale_id = stale_call.id
        corrupt_id = corrupt_slots_call.id
        regex_id = regex_confirmed_call.id
        batch_unconf_ids = [c.id for c in batch_unconfirmed]
        batch_conf_ids = [c.id for c in batch_confirmed]

    # Run reaper directly without GET /v1/calls
    # Total stale: 1 (boundary) + 1 (corrupt) + 1 (regex) + 20 (unconf) + 20 (conf) = 43
    reaped_count = reap_stale_calls(cutoff_minutes=20, duration_minutes=3)
    assert reaped_count == 43

    # Verify second sweep is idempotent
    assert reap_stale_calls(cutoff_minutes=20, duration_minutes=3) == 0

    with new_session() as session:
        # Boundary recent: untouched
        r = session.get(CallRecord, recent_id)
        assert r is not None and r.ended_at is None and r.outcome == "in_progress"

        # Boundary stale: finalized
        s = session.get(CallRecord, stale_id)
        assert s is not None and s.ended_at is not None and s.outcome == "info_only"
        assert s.ended_at == boundary_stale + timedelta(minutes=3)

        # Corrupt slots: handled safely without crash, finalized as info_only
        c = session.get(CallRecord, corrupt_id)
        assert c is not None and c.ended_at is not None and c.outcome == "info_only"

        # Regex confirmed: finalized as booked
        reg = session.get(CallRecord, regex_id)
        assert reg is not None and reg.ended_at is not None and reg.outcome == "booked"

        # Batch unconfirmed: all info_only
        for uid in batch_unconf_ids:
            rec = session.get(CallRecord, uid)
            assert rec is not None and rec.outcome == "info_only" and rec.ended_at is not None

        # Batch confirmed: all booked
        for cid in batch_conf_ids:
            rec = session.get(CallRecord, cid)
            assert rec is not None and rec.outcome == "booked" and rec.ended_at is not None


def test_unauthorized_client_cannot_finalize_or_tamper_telemetry(test_settings: Settings) -> None:
    """Verify that an unauthorized client with invalid secret cannot finalize or alter telemetry."""
    from app.call_tracking import start_or_get_browser_call

    real_secret = "real_secret_token_12345678901234567890123456789012"
    call_id = start_or_get_browser_call("secure-room-01", real_secret)
    with new_session() as session:
        rec = session.get(CallRecord, call_id)
        assert rec is not None
        rec.platform_class = "desktop"
        rec.browser_engine = "chromium"
        rec.input_path = "native_web_speech"
        session.commit()

    app = create_app(test_settings)
    with TestClient(app) as client:
        # Attempt to finalize with wrong secret
        res = client.post(
            "/v1/calls/end",
            json={
                "session_id": "secure-room-01",
                "call_id": call_id,
                "call_secret": "wrong_secret_" + "x" * 50,
                "outcome": "booked",
                "client_telemetry": {
                    "platform_class": "mobile",
                    "browser_engine": "webkit",
                    "end_reason": "hacked",
                },
            },
        )
        assert res.status_code == 404

    # Verify record in DB is uncorrupted
    with new_session() as session:
        record = session.get(CallRecord, call_id)
        assert record is not None
        assert record.ended_at is None
        assert record.platform_class == "desktop"
        assert record.browser_engine == "chromium"
        assert record.end_reason is None

