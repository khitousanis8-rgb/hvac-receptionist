"""Tests for the in-browser streaming chat API router."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app.chat_api import _execute_tool, _is_closing_or_polite_remark
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
    assert res.headers["cache-control"] == "no-cache"


def test_chat_requires_llm_credentials() -> None:
    app = create_app(Settings(_env_file=None))
    client = TestClient(app)

    res = client.post(
        "/v1/calls/chat",
        json={"session_id": "test-session-456", "message": "Can you help me?"},
    )

    assert res.status_code == 503
    assert res.json()["detail"] == "LLM credentials are not configured on the server."


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


def test_get_client_singleton() -> None:
    import app.chat_api as chat_api

    settings = Settings(LLM_API_KEY="test-key", _env_file=None)
    chat_api._client = None
    client1 = chat_api._get_client(settings)
    client2 = chat_api._get_client(settings)
    assert client1 is client2
    chat_api._client = None


def test_is_closing_or_polite_remark() -> None:
    positives = [
        "thank you",
        "thanks",
        "thank you so much",
        "thanks so much",
        "thank you very much",
        "thanks a lot",
        "many thanks",
        "bye",
        "goodbye",
        "bye bye",
        "have a good day",
        "have a great day",
        "no",
        "no that is all",
        "no thats all",
        "no thank you",
        "no thanks",
        "that is all",
        "thats all",
        "that is it",
        "thats it",
        "nope",
        "nothing else",
        "i am good",
        "im good",
        "all good",
        "perfect thank you",
        "great thank you",
        "ok thank you",
        "okay thank you",
        "sounds good thank you",
        "sounds great thank you",
        "take care",
        "Thank you!",
        "Thanks!",
        "Bye!",
        "Okay, thanks!",
        "No, thank you.",
        "That's all, thanks!",
        "thanks for your help",
    ]
    for text in positives:
        assert _is_closing_or_polite_remark(text) is True, f"Expected True for {text!r}"

    negatives = [
        "I need to book an appointment for AC repair",
        "Can you schedule a technician for tomorrow at 2pm?",
        "My phone number is 555-123-4567",
        "Furnace tune-up please",
        "Hello, is anyone there?",
        "Yes, 10:00 AM works for me",
    ]
    for text in negatives:
        assert _is_closing_or_polite_remark(text) is False, f"Expected False for {text!r}"


def test_chat_stream_disables_tools_on_polite_remark() -> None:
    settings = Settings(LLM_API_KEY="test-key", _env_file=None)
    app = create_app(settings)
    client = TestClient(app)

    async def fake_stream(*args, **kwargs):
        class Chunk:
            choices = [type("Choice", (), {"delta": type("Delta", (), {"content": "You're welcome!", "tool_calls": None})()})]
        yield Chunk()

    with patch("app.chat_api._get_client") as mock_get_client:
        mock_openai = AsyncMock()
        mock_openai.chat.completions.create = AsyncMock(side_effect=fake_stream)
        mock_get_client.return_value = mock_openai

        res = client.post(
            "/v1/calls/chat",
            json={"session_id": "polite-test", "message": "Thank you so much!"},
        )
        assert res.status_code == 200
        assert mock_openai.chat.completions.create.called
        call_kwargs = mock_openai.chat.completions.create.call_args.kwargs
        assert call_kwargs.get("tools") is None
        assert call_kwargs.get("tool_choice") is None

        # When it's not a polite remark, tools should be provided
        res2 = client.post(
            "/v1/calls/chat",
            json={"session_id": "polite-test", "message": "I want to schedule AC repair"},
        )
        assert res2.status_code == 200
        call_kwargs2 = mock_openai.chat.completions.create.call_args.kwargs
        assert call_kwargs2.get("tools") is not None
        assert call_kwargs2.get("tool_choice") == "auto"


def test_chat_stream_booking_outcome() -> None:
    settings = Settings(
        LLM_API_KEY="test-key",
        BUSINESS_SERVICES="AC repair",
        BUSINESS_OPENING_HOURS='{"monday":"08:00-18:00"}',
        _env_file=None,
    )
    app = create_app(settings)
    client = TestClient(app)

    class ToolCall:
        index = 0
        id = "call_123"
        function = type("Fn", (), {
            "name": "book_appointment_tool",
            "arguments": json.dumps({
                "phone_number": "+15559876543",
                "service": "AC repair",
                "date": "2030-01-07",
                "time": "10:00",
            }),
        })()

    async def fake_first_call(*args, **kwargs):
        class Chunk:
            choices = [type("Choice", (), {"delta": type("Delta", (), {"content": None, "tool_calls": [ToolCall()]})()})]
        yield Chunk()

    async def fake_second_call(*args, **kwargs):
        class Chunk:
            choices = [type("Choice", (), {"delta": type("Delta", (), {"content": "Your appointment is booked.", "tool_calls": None})()})]
        yield Chunk()

    with patch("app.chat_api._get_client") as mock_get_client:
        mock_openai = AsyncMock()
        mock_openai.chat.completions.create = AsyncMock(side_effect=[fake_first_call(), fake_second_call()])
        mock_get_client.return_value = mock_openai

        res = client.post(
            "/v1/calls/chat",
            json={"session_id": "booking-test", "message": "Book AC repair for next Monday 10am"},
        )
        assert res.status_code == 200
        text = res.text
        assert 'event: done\ndata: {"outcome": "booked"}' in text


def test_extract_slots_from_text() -> None:
    from app.chat_api import _extract_slots_from_text

    slots = {}

    # 1. Name extraction
    u1 = _extract_slots_from_text("yes my name is Anis", slots)
    assert u1.get("name") == "Anis"

    # 2. Spoken phone number extraction
    u2 = _extract_slots_from_text("yes it's plus 1 2 3 0 1 2 3 4 5 6 7", slots)
    assert u2.get("phone") == "+12301234567"

    # 3. Standard phone format
    u3 = _extract_slots_from_text("you can call me at 555-432-8765", slots)
    assert u3.get("phone") == "5554328765"

    # 4. Service extraction
    u4 = _extract_slots_from_text("my AC isn't cooling well", slots)
    assert u4.get("service") == "AC repair"

    # 5. Date/Time extraction
    u5 = _extract_slots_from_text("where to go for tomorrow at 9:00 a.m. Maybe", slots)
    assert "tomorrow at 9:00 a.m" in u5.get("time", "")


def test_parse_local_datetime_relative_and_formats() -> None:
    from app.chat_api import _parse_local_datetime

    settings = Settings(_env_file=None)

    dt1 = _parse_local_datetime(settings, "tomorrow", "9:00 a.m.")
    assert dt1 is not None
    assert dt1.hour == 9
    assert dt1.minute == 0

    dt2 = _parse_local_datetime(settings, "2030-05-15", "14:30")
    assert dt2 is not None
    assert dt2.year == 2030
    assert dt2.month == 5
    assert dt2.day == 15
    assert dt2.hour == 14
    assert dt2.minute == 30


def test_session_slots_and_caller_phone_sync() -> None:
    from app.call_tracking import (
        get_or_create_session_slots,
        start_call,
        update_call_phone,
        update_session_slots,
    )

    room = "test-room-slots-99"
    call_id = start_call(room)

    slots = get_or_create_session_slots(room)
    assert slots["name"] is None

    update_session_slots(room, {"name": "Anis", "phone": "+12301234567"})
    assert slots["name"] == "Anis"
    assert slots["phone"] == "+12301234567"

    with new_session() as session:
        record = session.get(CallRecord, call_id)
        assert record is not None
        assert record.caller_phone == "+12301234567"


def test_extract_slots_rejects_assistant_echo_and_names() -> None:
    from app.chat_api import _extract_slots_from_text

    # 1. Echo of assistant greeting must be rejected
    echo_text = "my name is Sarah how can I assist you with your heating or cooling today"
    slots = _extract_slots_from_text(echo_text, {})
    assert "name" not in slots
    assert "service" not in slots

    # 2. Candidate named "Sarah how" must not be extracted
    slots2 = _extract_slots_from_text("my name is Sarah how", {})
    assert "name" not in slots2

    # 3. Legitimate caller name must be extracted
    slots3 = _extract_slots_from_text("yes my name is Anis Khitous", {})
    assert slots3.get("name") == "Anis Khitous"


def test_end_call_preserves_booked_outcome() -> None:
    from app.call_tracking import end_call, start_call

    room = "test-preserve-booked-outcome"
    call_id = start_call(room)

    # First mark as booked
    end_call(call_id, "booked", "Customer booked appointment")
    with new_session() as session:
        record = session.get(CallRecord, call_id)
        assert record is not None
        assert record.outcome == "booked"

    # Subsequent hangup call with info_only must NOT overwrite booked
    end_call(call_id, "info_only", "Call ended")
    with new_session() as session:
        record = session.get(CallRecord, call_id)
        assert record is not None
        assert record.outcome == "booked"




