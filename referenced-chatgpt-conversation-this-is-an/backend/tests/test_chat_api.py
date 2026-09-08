"""Tests for the in-browser streaming chat API router."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app.chat_api import _execute_tool
from app.config import Settings
from app.db import CallRecord, Customer, init_db, new_session
from app.main import create_app


@pytest.fixture(autouse=True)
def setup_db() -> None:
    init_db()


def test_initial_greeting_stream() -> None:
    settings = Settings(
        BUSINESS_COMPANY_NAME="Acme Cooling",
        _env_file=None,
    )
    app = create_app(settings)
    client = TestClient(app)

    res = client.post(
        "/v1/calls/chat",
        json={"session_id": "test-session-123", "message": "__GREETING__"},
    )
    assert res.status_code == 200
    assert "text/event-stream" in res.headers["content-type"]
    text = res.text
    assert "event: call_started" in text
    assert "event: delta" in text
    assert "Acme Cooling" in text
    assert "event: done" in text


def test_tool_execution_check_appointments() -> None:
    settings = Settings(_env_file=None)
    from uuid import uuid4
    phone = f"+1555{uuid4().hex[:7]}"
    with new_session() as session:
        session.add(Customer(phone_number=phone, name="Jane Unique"))
        session.commit()

    res = _execute_tool(settings, "check_my_appointments", {"phone_number": phone})
    assert "No upcoming appointments found" in res


def test_tool_execution_unapproved_service() -> None:
    settings = Settings(BUSINESS_SERVICES="AC repair,Furnace tuneup", _env_file=None)
    res = _execute_tool(
        settings,
        "book_appointment_tool",
        {
            "phone_number": "+15551234567",
            "service": "Spaceship repair",
            "date": "2030-05-01",
            "time": "10:00",
        },
    )
    assert "not on our approved services list" in res


def test_end_call_endpoint() -> None:
    settings = Settings(_env_file=None)
    app = create_app(settings)
    client = TestClient(app)

    with new_session() as session:
        call = CallRecord(room_name="test-call-end-99")
        session.add(call)
        session.commit()
        call_id = call.id

    res = client.post(
        "/v1/calls/end",
        json={
            "session_id": "test-call-end-99",
            "call_id": call_id,
            "outcome": "booked",
            "summary": "Customer booked AC repair.",
        },
    )
    assert res.status_code == 200
    assert res.json()["outcome"] == "booked"

    with new_session() as session:
        updated = session.get(CallRecord, call_id)
        assert updated is not None
        assert updated.outcome == "booked"
        assert updated.transcript_summary == "Customer booked AC repair."
