# pyright: reportCallIssue=false
# pydantic-settings accepts env-var kwargs dynamically; pyright cannot see them.

from datetime import UTC, datetime

from fastapi.testclient import TestClient

from app.call_tracking import end_call, start_call
from app.config import Settings
from app.db import init_db, reset_engine
from app.main import create_app
from app.scheduling import book_appointment


def _client(tmp_path) -> TestClient:
    reset_engine()
    init_db(f"sqlite:///{(tmp_path / 'test.db').as_posix()}")
    return TestClient(create_app(Settings(_env_file=None)))


def test_dashboard_page_serves_html(tmp_path) -> None:
    with _client(tmp_path) as client:
        response = client.get("/dashboard")

    assert response.status_code == 200
    assert "HVAC Receptionist" in response.text
    reset_engine()


def test_calls_endpoint_returns_records(tmp_path) -> None:
    client = _client(tmp_path)
    call_id = start_call("room-test")
    end_call(call_id, "booked", "AC is broken")

    with client:
        response = client.get("/v1/calls")

    assert response.status_code == 200
    calls = response.json()
    assert len(calls) == 1
    assert calls[0]["room_name"] == "room-test"
    assert calls[0]["outcome"] == "booked"
    assert calls[0]["transcript_summary"] == "AC is broken"
    reset_engine()


def test_appointments_endpoint_includes_customer(tmp_path) -> None:
    settings = Settings(
        BUSINESS_OPENING_HOURS='{"monday":"09:00-17:00"}',
        BUSINESS_TIMEZONE="UTC",
        _env_file=None,
    )
    client = _client(tmp_path)
    with client:
        from app.db import new_session

        with new_session() as session:
            book_appointment(
                session,
                settings,
                phone_number="+15550001",
                service="AC repair",
                when=datetime(2030, 6, 3, 10, 0, tzinfo=UTC),
                name="Alice",
            )
        response = client.get("/v1/appointments")

    assert response.status_code == 200
    appointments = response.json()
    assert len(appointments) == 1
    assert appointments[0]["service"] == "AC repair"
    assert appointments[0]["customer_name"] == "Alice"
    assert appointments[0]["customer_phone"] == "+15550001"
    reset_engine()