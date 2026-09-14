# pyright: reportCallIssue=false
# pydantic-settings accepts env-var kwargs dynamically; pyright cannot see them.

import json
from pathlib import Path

from fastapi.testclient import TestClient

from app.config import Settings
from app.db import CallRecord, new_session
from app.main import create_app


def test_health_check_returns_ok() -> None:
    with TestClient(create_app()) as client:
        response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_public_configuration_never_includes_credentials() -> None:
    settings = Settings(
        BUSINESS_COMPANY_NAME="Northstar Heating",
        BUSINESS_SERVICES="AC repair,Furnace repair",
        LLM_API_KEY="private",
        _env_file=None,
    )
    with TestClient(create_app(settings)) as client:
        response = client.get("/v1/config/public")

    assert response.status_code == 200
    assert response.json()["company_name"] == "Northstar Heating"
    assert "LLM_API_KEY" not in response.text
    assert "private" not in response.text


def test_endpoints_query_limit_validation() -> None:
    settings = Settings(ADMIN_API_KEY="test-admin-key", _env_file=None)
    headers = {"X-Admin-Key": "test-admin-key"}
    with TestClient(create_app(settings)) as client:
        res1 = client.get("/v1/calls?limit=0", headers=headers)
        assert res1.status_code == 422

        res2 = client.get("/v1/calls?limit=201", headers=headers)
        assert res2.status_code == 422

        res3 = client.get("/v1/appointments?limit=0", headers=headers)
        assert res3.status_code == 422

        res4 = client.get("/v1/appointments?limit=500", headers=headers)
        assert res4.status_code == 422


def test_private_routes_auth_contract() -> None:
    # 503 when admin key not set
    with TestClient(create_app(Settings(_env_file=None))) as client:
        res = client.get("/v1/calls")
        assert res.status_code == 503
        assert "not configured" in res.json()["detail"]

    # 401 when admin key set but missing or invalid
    settings = Settings(ADMIN_API_KEY="secret-123", _env_file=None)
    with TestClient(create_app(settings)) as client:
        res1 = client.get("/v1/calls")
        assert res1.status_code == 401

        res2 = client.get("/v1/calls", headers={"X-Admin-Key": "wrong-key"})
        assert res2.status_code == 401

        res3 = client.get("/v1/calls", headers={"Authorization": "Bearer secret-123"})
        assert res3.status_code == 200


def test_calls_pagination_and_iso_timestamp_z(tmp_path) -> None:
    from app.call_tracking import end_call, start_call
    from app.db import init_db, reset_engine

    db_url = f"sqlite:///{(tmp_path / 'test_calls.db').as_posix()}"
    reset_engine()
    init_db(db_url)
    try:
        settings = Settings(ADMIN_API_KEY="test-admin", DATABASE_URL=db_url, _env_file=None)
        headers = {"X-Admin-Key": "test-admin"}

        call1 = start_call("room-1")
        end_call(call1, "booked")

        call2 = start_call("room-2")
        end_call(call2, "info_only")

        with TestClient(create_app(settings)) as client:
            res = client.get("/v1/calls?limit=1&offset=0", headers=headers)
            assert res.status_code == 200
            data = res.json()
            assert data["total"] == 2
            assert len(data["items"]) == 1
            assert data["next_offset"] == 1
            assert data["outcome_counts"] == {"booked": 1, "info_only": 1}

            started = data["items"][0]["started_at"]
            assert started is not None and started.endswith("Z")
            ended = data["items"][0]["ended_at"]
            assert ended is not None and ended.endswith("Z")
    finally:
        reset_engine()


def test_sqlite_backward_compatibility_migration(tmp_path) -> None:
    from sqlalchemy import create_engine, inspect, text

    from app.db import init_db, reset_engine

    db_path = tmp_path / "legacy.db"
    legacy_engine = create_engine(f"sqlite:///{db_path.as_posix()}")
    with legacy_engine.begin() as conn:
        conn.execute(
            text(
                "CREATE TABLE call_records ("
                "id INTEGER PRIMARY KEY, "
                "room_name VARCHAR(200), "
                "caller_phone VARCHAR(32), "
                "transcript_summary TEXT, "
                "outcome VARCHAR(40), "
                "started_at DATETIME, "
                "ended_at DATETIME"
                ")"
            )
        )
        conn.execute(
            text(
                "CREATE TABLE appointments ("
                "id INTEGER PRIMARY KEY, "
                "customer_id INTEGER, "
                "service VARCHAR(200), "
                "scheduled_for DATETIME, "
                "status VARCHAR(20), "
                "notes TEXT, "
                "created_at DATETIME"
                ")"
            )
        )

    reset_engine()
    init_db(f"sqlite:///{db_path.as_posix()}")
    try:
        cols = {c["name"] for c in inspect(legacy_engine).get_columns("call_records")}
        assert "session_slots" in cols
        assert "access_token_hash" in cols
    finally:
        reset_engine()


def test_appointments_pagination_and_iso_timestamp_z(tmp_path) -> None:
    from datetime import UTC, datetime

    from app.db import Appointment, Customer, init_db, new_session, reset_engine

    db_url = f"sqlite:///{(tmp_path / 'test_appts.db').as_posix()}"
    reset_engine()
    init_db(db_url)
    try:
        settings = Settings(ADMIN_API_KEY="test-admin", DATABASE_URL=db_url, _env_file=None)
        headers = {"X-Admin-Key": "test-admin"}

        with new_session() as session:
            c = Customer(phone_number="+15551234567", name="Jane")
            session.add(c)
            session.flush()
            a1 = Appointment(
                customer_id=c.id,
                service="AC repair",
                scheduled_for=datetime(2030, 6, 3, 10, 0, tzinfo=UTC),
            )
            a2 = Appointment(
                customer_id=c.id,
                service="Heating repair",
                scheduled_for=datetime(2030, 6, 3, 14, 0, tzinfo=UTC),
            )
            session.add_all([a1, a2])

        with TestClient(create_app(settings)) as client:
            res = client.get("/v1/appointments?limit=1&offset=0", headers=headers)
            assert res.status_code == 200
            data = res.json()
            assert len(data) == 1
            assert data[0]["service"] == "AC repair"
            assert data[0]["scheduled_for"].endswith("Z")

            res_offset = client.get("/v1/appointments?limit=1&offset=1", headers=headers)
            assert res_offset.status_code == 200
            data_offset = res_offset.json()
            assert len(data_offset) == 1
            assert data_offset[0]["service"] == "Heating repair"
            assert data_offset[0]["scheduled_for"].endswith("Z")
    finally:
        reset_engine()


def test_require_admin_bearer_case_insensitive() -> None:
    settings = Settings(ADMIN_API_KEY="my-secret-key", _env_file=None)
    with TestClient(create_app(settings)) as client:
        res = client.get("/v1/calls", headers={"Authorization": "bearer my-secret-key"})
        assert res.status_code == 200


def test_require_admin_empty_key_fails_closed() -> None:
    settings = Settings(ADMIN_API_KEY="", _env_file=None)
    with TestClient(create_app(settings)) as client:
        res = client.get("/v1/calls", headers={"Authorization": "Bearer "})
        assert res.status_code == 503


def test_transcribe_rate_limiting() -> None:
    from unittest.mock import MagicMock, patch
    settings = Settings(LLM_API_KEY="mock-groq", _env_file=None)
    with TestClient(create_app(settings)) as client:
        with patch("app.chat_api._get_client") as mock_client:
            mock_ai = MagicMock()
            mock_client.return_value = mock_ai
            # 30 requests should succeed or process
            import base64
            dummy_b64 = base64.b64encode(b"RIFFdummywavdata").decode()
            for _ in range(30):
                res = client.post(
                    "/v1/calls/transcribe",
                    json={"audio_base64": dummy_b64},
                )
                assert res.status_code != 429

            # 31st request from same client exceeds limit -> 429
            res_limit = client.post(
                "/v1/calls/transcribe",
                json={"audio_base64": dummy_b64},
            )
            assert res_limit.status_code == 429


def test_calls_stale_reaper_finalizes_abandoned_sessions(tmp_path: Path) -> None:
    from datetime import UTC, datetime, timedelta

    from app.call_tracking import start_call
    from app.db import CallRecord, init_db, new_session, reset_engine

    db_url = f"sqlite:///{(tmp_path / 'test_stale_reaper.db').as_posix()}"
    reset_engine()
    init_db(db_url)
    try:
        settings = Settings(ADMIN_API_KEY="test-admin", DATABASE_URL=db_url, _env_file=None)
        headers = {"X-Admin-Key": "test-admin"}

        call_id = start_call("stale-room-1")
        # Backdate started_at to 30 minutes ago
        with new_session() as session:
            record = session.get(CallRecord, call_id)
            assert record is not None
            record.started_at = datetime.now(UTC) - timedelta(minutes=30)
            session.commit()

        with TestClient(create_app(settings)) as client:
            res = client.get("/v1/calls", headers=headers)
            assert res.status_code == 200
            data = res.json()
            assert data["total"] == 1
            item = data["items"][0]
            assert item["ended_at"] is not None
            assert item["outcome"] == "info_only"
            assert "automatically finalized" in item["transcript_summary"]
    finally:
        reset_engine()


def test_stale_call_reaper_decoupled_from_get_calls(tmp_path: Path) -> None:
    """The stale-call reaper automatically finalizes abandoned sessions on lifespan

    startup without requiring any query to GET /v1/calls.
    """
    from datetime import UTC, datetime, timedelta

    from app.call_tracking import start_call
    from app.db import CallRecord, init_db, new_session, reset_engine

    db_url = f"sqlite:///{(tmp_path / 'test_reaper_decoupled.db').as_posix()}"
    reset_engine()
    init_db(db_url)
    try:
        call_id = start_call("stale-decoupled-room")
        stale_start = datetime.now(UTC) - timedelta(minutes=30)
        with new_session() as session:
            record = session.get(CallRecord, call_id)
            assert record is not None
            record.started_at = stale_start
            session.commit()

        settings = Settings(
            DATABASE_URL=db_url,
            _env_file=None,
        )

        # Start application lifespan (which runs the initial reaper sweep)
        # Explicitly DO NOT query GET /v1/calls!
        with TestClient(create_app(settings)) as client:
            res = client.get("/health")
            assert res.status_code == 200

        # Verify directly in the database that the abandoned call was finalized
        with new_session() as session:
            record = session.get(CallRecord, call_id)
            assert record is not None
            assert record.ended_at is not None
            assert record.ended_at == stale_start + timedelta(minutes=3)
            assert record.outcome == "info_only"
            assert "automatically finalized" in (record.transcript_summary or "")
    finally:
        reset_engine()


def test_get_calls_is_pure_read_only_when_reaper_disabled(tmp_path: Path) -> None:
    """GET /v1/calls does not finalize stale calls when reaper background task is disabled,

    proving cleanup has been decoupled from dashboard page loads.
    """
    from datetime import UTC, datetime, timedelta

    from app.call_tracking import start_call
    from app.db import CallRecord, init_db, new_session, reset_engine

    db_url = f"sqlite:///{(tmp_path / 'test_readonly_dashboard.db').as_posix()}"
    reset_engine()
    init_db(db_url)
    try:
        call_id = start_call("stale-untouched-room")
        stale_start = datetime.now(UTC) - timedelta(minutes=30)
        with new_session() as session:
            record = session.get(CallRecord, call_id)
            assert record is not None
            record.started_at = stale_start
            session.commit()

        settings = Settings(
            ADMIN_API_KEY="test-admin",
            DATABASE_URL=db_url,
            _env_file=None,
        )

        app = create_app(settings)
        app.state.enable_stale_call_reaper = False

        with TestClient(app) as client:
            res = client.get("/v1/calls", headers={"X-Admin-Key": "test-admin"})
            assert res.status_code == 200
            data = res.json()
            assert data["total"] == 1
            item = data["items"][0]
            # Verify the endpoint returned the unmutated record
            assert item["ended_at"] is None
            assert item["outcome"] == "in_progress"

        # Direct DB inspection confirms the record remains unfinalized
        with new_session() as session:
            record = session.get(CallRecord, call_id)
            assert record is not None
            assert record.ended_at is None
            assert record.outcome == "in_progress"
            assert record.transcript_summary is None
    finally:
        reset_engine()


def test_get_calls_returns_telemetry_fields() -> None:
    """Verify that GET /v1/calls serializes platform_class, browser_engine, and input_path."""
    settings = Settings(ADMIN_API_KEY="test-admin-secret", _env_file=None)
    headers = {"X-Admin-Key": "test-admin-secret"}

    with new_session() as session:
        # Call 1: Desktop Chromium with full telemetry
        call1 = CallRecord(
            room_name="desktop-call-1",
            outcome="booked",
            transcript_summary="Booked AC tuneup",
            platform_class="desktop",
            browser_engine="chromium",
            input_path="native_web_speech",
            mic_permission="granted",
            end_reason="completed",
            client_metrics=json.dumps({"first_assistant_audio_ms": 1200, "echo_suppressions": 0}),
        )
        # Call 2: Mobile WebKit with fallback recorder
        call2 = CallRecord(
            room_name="mobile-call-2",
            outcome="info_only",
            transcript_summary="Asked hours",
            platform_class="mobile",
            browser_engine="webkit",
            input_path="media_recorder_transcription",
            mic_permission="denied",
            end_reason="error",
            client_metrics=json.dumps({"stt_errors": 2}),
        )
        # Call 3: Legacy record with null telemetry fields
        call3 = CallRecord(
            room_name="legacy-call-3",
            outcome="in_progress",
            platform_class=None,
            browser_engine=None,
            input_path=None,
            mic_permission=None,
            end_reason=None,
            client_metrics=None,
        )
        session.add_all([call1, call2, call3])
        session.commit()

    with TestClient(create_app(settings)) as client:
        res = client.get("/v1/calls?limit=10", headers=headers)
        assert res.status_code == 200
        data = res.json()
        assert data["total"] == 3
        items = {item["room_name"]: item for item in data["items"]}

        # Call 1 checks
        item1 = items["desktop-call-1"]
        assert item1["platform_class"] == "desktop"
        assert item1["browser_engine"] == "chromium"
        assert item1["input_path"] == "native_web_speech"
        assert item1["mic_permission"] == "granted"
        assert item1["end_reason"] == "completed"
        assert item1["client_metrics"] == {"first_assistant_audio_ms": 1200, "echo_suppressions": 0}

        # Call 2 checks
        item2 = items["mobile-call-2"]
        assert item2["platform_class"] == "mobile"
        assert item2["browser_engine"] == "webkit"
        assert item2["input_path"] == "media_recorder_transcription"
        assert item2["mic_permission"] == "denied"
        assert item2["end_reason"] == "error"
        assert item2["client_metrics"] == {"stt_errors": 2}

        # Call 3 checks (legacy rows return null without error)
        item3 = items["legacy-call-3"]
        assert item3["platform_class"] is None
        assert item3["browser_engine"] is None
        assert item3["input_path"] is None
        assert item3["mic_permission"] is None
        assert item3["end_reason"] is None
        assert item3["client_metrics"] is None


def test_sqlite_backward_compatibility_migration_preserves_records(tmp_path: Path) -> None:
    """Verify that init_db() migrates legacy tables, adds telemetry columns, and preserves data."""
    from sqlalchemy import create_engine, inspect, text

    from app.db import init_db, reset_engine

    db_path = tmp_path / "legacy_migration_test.db"
    db_url = f"sqlite:///{db_path.as_posix()}"
    legacy_engine = create_engine(db_url)

    # 1. Create legacy schema (pre-migration, missing session_slots, access_token_hash, & telemetry)
    with legacy_engine.begin() as conn:
        conn.execute(
            text(
                "CREATE TABLE call_records ("
                "id INTEGER PRIMARY KEY AUTOINCREMENT, "
                "room_name VARCHAR(200), "
                "caller_phone VARCHAR(32), "
                "transcript_summary TEXT, "
                "outcome VARCHAR(40), "
                "started_at DATETIME, "
                "ended_at DATETIME"
                ")"
            )
        )
        conn.execute(
            text(
                "CREATE TABLE appointments ("
                "id INTEGER PRIMARY KEY AUTOINCREMENT, "
                "customer_id INTEGER, "
                "service VARCHAR(200), "
                "scheduled_for DATETIME, "
                "status VARCHAR(20), "
                "notes TEXT, "
                "created_at DATETIME"
                ")"
            )
        )
        # Seed pre-existing records that must survive migration intact
        conn.execute(
            text(
                "INSERT INTO call_records (id, room_name, caller_phone, transcript_summary, outcome) "
                "VALUES (101, 'legacy-room-pre', '+15551234567', 'Legacy call before migration.', 'booked')"
            )
        )
        conn.execute(
            text(
                "INSERT INTO call_records (id, room_name, caller_phone, transcript_summary, outcome) "
                "VALUES (102, 'legacy-room-info', '+15557654321', 'Inquired about maintenance plan.', 'info_only')"
            )
        )

    # Cleanly release the setup connection pool on Windows
    legacy_engine.dispose()
    reset_engine()

    try:
        # 2. Run init_db() against the legacy database
        init_db(db_url)

        # 3. Column and index verification
        verify_engine = create_engine(db_url)
        try:
            columns = {c["name"] for c in inspect(verify_engine).get_columns("call_records")}
            required_new_cols = {
                "session_slots",
                "access_token_hash",
                "platform_class",
                "browser_engine",
                "input_path",
                "mic_permission",
                "end_reason",
                "client_metrics",
            }
            for col in required_new_cols:
                assert col in columns, f"Column '{col}' was not added by init_db() migration!"

            # Verify index creation
            indexes = {idx["name"] for idx in inspect(verify_engine).get_indexes("call_records")}
            assert "ix_call_records_platform_class" in indexes
        finally:
            verify_engine.dispose()

        # 4. Data preservation check via ORM session
        with new_session() as session:
            record1 = session.get(CallRecord, 101)
            assert record1 is not None
            assert record1.room_name == "legacy-room-pre"
            assert record1.caller_phone == "+15551234567"
            assert record1.transcript_summary == "Legacy call before migration."
            assert record1.outcome == "booked"
            assert record1.platform_class is None  # Defaults to NULL for old records
            assert record1.client_metrics is None

            record2 = session.get(CallRecord, 102)
            assert record2 is not None
            assert record2.room_name == "legacy-room-info"
            assert record2.outcome == "info_only"

            # 5. Write capability: update existing record with telemetry
            record1.platform_class = "desktop"
            record1.browser_engine = "chromium"
            record1.client_metrics = json.dumps({"echo_suppressions": 0})
            session.commit()

        # Verify update persisted
        with new_session() as session:
            updated = session.get(CallRecord, 101)
            assert updated is not None
            assert updated.platform_class == "desktop"
            assert updated.browser_engine == "chromium"
            assert json.loads(updated.client_metrics or "{}") == {"echo_suppressions": 0}

        # 6. Idempotency: re-running init_db() must not raise duplicate column error
        init_db(db_url)

    finally:
        reset_engine()



