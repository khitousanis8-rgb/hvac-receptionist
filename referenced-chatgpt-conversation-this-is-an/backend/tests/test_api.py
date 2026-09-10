# pyright: reportCallIssue=false
# pydantic-settings accepts env-var kwargs dynamically; pyright cannot see them.

from fastapi.testclient import TestClient

from app.config import Settings
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
