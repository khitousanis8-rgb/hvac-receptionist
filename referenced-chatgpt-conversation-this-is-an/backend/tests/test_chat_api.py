"""Tests for the in-browser streaming chat API router."""

from __future__ import annotations

from datetime import datetime, timedelta
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app.call_tracking import start_or_get_browser_call
from app.chat_api import _execute_tool, _is_closing_or_polite_remark
from app.config import Settings
from app.db import Appointment, CallRecord, Customer, init_db, new_session
from app.main import create_app


@pytest.fixture(autouse=True)
def setup_db() -> None:
    init_db()
    with new_session() as session:
        session.query(Appointment).delete()
        session.commit()


_CALL_SECRET = "a" * 64


def _start_browser_call(room_name: str) -> int:
    return start_or_get_browser_call(room_name, _CALL_SECRET)


def _browser_payload(room_name: str, call_id: int, message: str) -> dict[str, object]:
    return {
        "session_id": room_name,
        "message": message,
        "call_id": call_id,
        "call_secret": _CALL_SECRET,
    }


def test_initial_greeting_stream() -> None:
    settings = Settings(
        BUSINESS_COMPANY_NAME="Acme Cooling",
        _env_file=None,
    )
    app = create_app(settings)
    client = TestClient(app)

    res = client.post(
        "/v1/calls/chat",
        json={
            "session_id": "test-session-123",
            "message": "__GREETING__",
            "call_secret": _CALL_SECRET,
        },
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

    call_id = _start_browser_call("test-session-456")
    payload = _browser_payload("test-session-456", call_id, "Can you help me?")
    res = client.post("/v1/calls/chat", json=payload)

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

    call_id = _start_browser_call("test-call-end-99")

    res = client.post(
        "/v1/calls/end",
        json={
            "session_id": "test-call-end-99",
            "call_id": call_id,
            "call_secret": _CALL_SECRET,
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


def test_end_call_cannot_modify_another_browser_call() -> None:
    client = TestClient(create_app(Settings(_env_file=None)))
    owner_call_id = start_or_get_browser_call("owner-room", _CALL_SECRET)
    other_secret = "b" * 64
    target_call_id = start_or_get_browser_call("target-room", other_secret)

    response = client.post(
        "/v1/calls/end",
        json={
            "session_id": "target-room",
            "call_id": target_call_id,
            "call_secret": _CALL_SECRET,
            "outcome": "booked",
            "summary": "tampered",
        },
    )

    assert owner_call_id != target_call_id
    assert response.status_code == 404
    with new_session() as session:
        target = session.get(CallRecord, target_call_id)
        assert target is not None
        assert target.ended_at is None
        assert target.outcome == "in_progress"


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
        delta = type("Delta", (), {"content": "You're welcome!", "tool_calls": None})()
        class Chunk:
            choices = [type("Choice", (), {"delta": delta})()]
        yield Chunk()

    with patch("app.chat_api._get_client") as mock_get_client:
        mock_openai = AsyncMock()
        mock_openai.chat.completions.create = AsyncMock(side_effect=fake_stream)
        mock_get_client.return_value = mock_openai

        res = client.post(
            "/v1/calls/chat",
            json=_browser_payload(
                "thanks-test",
                _start_browser_call("thanks-test"),
                "Thank you so much!",
            ),
        )
        assert res.status_code == 200

        call_args = mock_openai.chat.completions.create.call_args[1]
        assert "tools" not in call_args or call_args["tools"] is None
        assert "tool_choice" not in call_args or call_args["tool_choice"] is None


def test_chat_stream_executes_tool_and_updates_slots() -> None:
    settings = Settings(
        LLM_API_KEY="test-key",
        BUSINESS_OPENING_HOURS='{"monday":"08:00-18:00","tuesday":"08:00-18:00","wednesday":"08:00-18:00","thursday":"08:00-18:00","friday":"08:00-18:00","saturday":"08:00-18:00","sunday":"08:00-18:00"}',
        _env_file=None,
    )
    app = create_app(settings)
    client = TestClient(app)
    from uuid import uuid4

    room = f"booking-test-{uuid4().hex[:8]}"
    call_id = _start_browser_call(room)
    future_date = (datetime.now() + timedelta(days=30)).strftime("%Y-%m-%d")

    # Turn 1: Caller asks to book, but phone number is missing
    res1 = client.post(
        "/v1/calls/chat",
        json=_browser_payload(
            room,
            call_id,
            f"Book AC repair for {future_date} 10am",
        ),
    )
    assert res1.status_code == 200
    assert "best callback phone number" in res1.text
    assert 'event: done\ndata: {"outcome": "info_only"}' in res1.text

    # Turn 2: Caller provides phone number -> Server produces deterministic recap
    phone = f"555{1000000 + (abs(hash(room)) % 8999999)}"
    res2 = client.post(
        "/v1/calls/chat",
        json=_browser_payload(
            room,
            call_id,
            f"My phone number is {phone}",
        ),
    )
    assert res2.status_code == 200
    assert "Just to confirm" in res2.text
    assert "Would you like me to book it?" in res2.text
    assert 'event: done\ndata: {"outcome": "info_only"}' in res2.text

    # Turn 3: Caller gives explicit confirmation -> Server directly executes book_appointment_tool
    res3 = client.post(
        "/v1/calls/chat",
        json=_browser_payload(
            room,
            call_id,
            "Yes please",
        ),
    )
    assert res3.status_code == 200
    assert 'event: tool_call\ndata: {"name": "book_appointment_tool"' in res3.text
    assert "You're all set! I've booked that appointment" in res3.text
    assert 'event: done\ndata: {"outcome": "booked"}' in res3.text


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
    assert u5["date"] == "tomorrow"
    assert u5["time"] == "9:00 a.m"


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
        get_call_slots,
        start_call,
        update_call_phone,
        update_call_slots,
    )

    room = "test-room-slots-99"
    call_id = start_call(room)

    slots = get_call_slots(call_id)
    assert slots["name"] is None

    slots = update_call_slots(call_id, {"name": "Anis", "phone": "+12301234567"})
    update_call_phone(call_id, "+12301234567")
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


def test_end_call_by_session_endpoint() -> None:
    from app.call_tracking import update_call_outcome

    settings = Settings(_env_file=None)
    app = create_app(settings)
    client = TestClient(app)
    room = "test-session-end-endpoint"
    call_id = _start_browser_call(room)
    update_call_outcome(call_id, "booked")

    # The browser can finalize only its own record and cannot downgrade booked.
    res = client.post(
        "/v1/calls/end",
        json={
            "session_id": room,
            "call_id": call_id,
            "call_secret": _CALL_SECRET,
            "outcome": "info_only",
            "summary": "Caller hung up",
        },
    )
    assert res.status_code == 200

    # Verify that 'booked' was preserved
    with new_session() as session:
        record = (
            session.query(CallRecord)
            .filter(CallRecord.room_name == room)
            .order_by(CallRecord.id.desc())
            .first()
        )
        assert record is not None
        assert record.outcome == "booked"
        assert record.ended_at is not None


def test_assistant_echo_detection_and_recovery_stream() -> None:
    from app.chat_api import _is_assistant_echo

    echo_text = "Thank you for calling Example HVAC! My name is Sarah. How can I assist you with your heating or cooling today?"
    assert _is_assistant_echo(echo_text) is True
    assert _is_assistant_echo("My name is Sarah how can I assist you with your heating or cooling today") is True
    assert _is_assistant_echo("My AC is not cooling well") is False

    settings = Settings(_env_file=None)
    app = create_app(settings)
    client = TestClient(app)
    res = client.post(
        "/v1/calls/chat",
            json=_browser_payload(
                "echo-test-session",
                _start_browser_call("echo-test-session"),
                echo_text,
            ),
    )
    assert res.status_code == 200
    assert "event: delta" not in res.text
    assert 'event: done\ndata: {"outcome": "info_only"}' in res.text


def test_is_echo_of_assistant_multi_turn() -> None:
    from app.chat_api import ChatMessage, _is_echo_of_assistant

    history = [
        ChatMessage(role="user", content="I need some help with my system"),
        ChatMessage(
            role="assistant",
            content="Just to confirm, that's AC repair for Monday, October 19 at 11:00 AM. Would you like me to book it?",
        ),
    ]

    # Re-captured full assistant speech with booking keywords must be recognized as echo
    asst_echo = "Just to confirm that's AC repair for Monday October 19 at 11:00 AM would you like me to book it"
    assert _is_echo_of_assistant(asst_echo, history) is True

    # Short genuine caller responses must NEVER be treated as echo
    assert _is_echo_of_assistant("yes please", history) is False
    assert _is_echo_of_assistant("AC repair", history) is False
    assert _is_echo_of_assistant("tomorrow morning", history) is False
    assert _is_echo_of_assistant("please book it", history) is False


def test_closing_remark_vs_confirmation_delineation() -> None:
    from app.chat_api import _is_closing_or_polite_remark

    # True closing remarks
    assert _is_closing_or_polite_remark("thank you so much") is True
    assert _is_closing_or_polite_remark("thanks bye") is True
    assert _is_closing_or_polite_remark("goodbye have a great day") is True
    assert _is_closing_or_polite_remark("no that is all thank you") is True

    # Booking affirmations must NOT be treated as closing remarks
    assert _is_closing_or_polite_remark("sounds good") is False
    assert _is_closing_or_polite_remark("sounds great") is False
    assert _is_closing_or_polite_remark("perfect") is False
    assert _is_closing_or_polite_remark("okay") is False
    assert _is_closing_or_polite_remark("alright") is False
    assert _is_closing_or_polite_remark("yes") is False


def test_phone_extraction_spoken_oh() -> None:
    from app.chat_api import _extract_slots_from_text

    slots = _extract_slots_from_text("My phone is five one two eight oh oh zero zero one one", {})
    assert slots.get("phone") == "5128000011"


def test_rate_limit_detection_and_candidate_models() -> None:
    from app.chat_api import _get_candidate_models, _is_rate_limit_error

    # Should detect 429 and common rate limit patterns
    assert _is_rate_limit_error("Error code: 429 - Rate limit reached for model openai/gpt-oss-120b") is True
    assert _is_rate_limit_error("Rate limit reached on tokens per day (TPD)") is True
    assert _is_rate_limit_error("rate_limit_exceeded") is True
    assert _is_rate_limit_error("TPM exceeded") is True
    assert _is_rate_limit_error("Internal server error 500") is False

    # Should provide prioritized failover list with primary model first
    candidates = _get_candidate_models("openai/gpt-oss-120b")
    assert candidates[0] == "openai/gpt-oss-120b"
    assert "qwen/qwen3.8-27b" in candidates
    assert "openai/gpt-oss-20b" in candidates


def test_create_stream_completion_rate_limit_failover() -> None:
    from app.chat_api import _create_stream_completion

    attempted_models = []

    async def fake_create(**kwargs):
        model = kwargs.get("model")
        attempted_models.append(model)
        if model == "openai/gpt-oss-120b":
            raise Exception("Error code: 429 - Rate limit reached on tokens per day (TPD)")
        class Chunk:
            choices = [type("Choice", (), {"delta": type("Delta", (), {"content": "Fallback success", "tool_calls": None})()})]
        async def gen():
            yield Chunk()
        return gen()

    mock_client = AsyncMock()
    mock_client.chat.completions.create = AsyncMock(side_effect=fake_create)

    import asyncio
    stream = asyncio.run(
        _create_stream_completion(
            client=mock_client,
            model="openai/gpt-oss-120b",
            messages=[{"role": "user", "content": "hi"}],
        )
    )
    assert stream is not None
    # Verify that it tried the exhausted 120b model first, then failed over to a backup model
    assert attempted_models[0] == "openai/gpt-oss-120b"
    assert len(attempted_models) >= 2
    assert attempted_models[1] in ["qwen/qwen3.8-27b", "openai/gpt-oss-20b"]


def test_booking_missing_fields_validation() -> None:
    from app.chat_api import booking_missing_fields

    # Date present, but time missing
    draft1 = {"service": "AC repair", "phone": "555-123-4567", "date": "2030-05-01"}
    missing1 = booking_missing_fields(draft1)
    assert "time" in missing1
    assert "date" not in missing1

    # Time present, but date missing
    draft2 = {"service": "AC repair", "phone": "555-123-4567", "time": "10:00"}
    missing2 = booking_missing_fields(draft2)
    assert "date" in missing2
    assert "time" not in missing2

    # All 4 required fields present
    draft3 = {
        "service": "AC repair",
        "phone": "555-123-4567",
        "date": "2030-05-01",
        "time": "10:00",
    }
    missing3 = booking_missing_fields(draft3)
    assert len(missing3) == 0


def test_is_explicit_booking_confirmation_allowlist_and_rejections() -> None:
    from app.chat_api import is_explicit_booking_confirmation

    # Allowlist: exact whole phrases
    positives = [
        "yes",
        "yes please",
        "yes please do",
        "please book it",
        "go ahead",
        "that works",
        "sounds good",
        "sounds great",
        "correct",
        "confirm it",
        "sure thing",
        "perfect",
        "yep",
        "yeah",
    ]
    for phrase in positives:
        assert is_explicit_booking_confirmation(phrase) is True, f"Failed for {phrase!r}"

    # Rejections: negations, substring matches, new dates/times, ambiguities
    negatives = [
        "I want to book",
        "maybe",
        "no",
        "yes, but change it to Wednesday",
        "book next Tuesday",
        "sure tomorrow at 2",
        "not now",
        "wait a second",
        "can you do 3pm instead",
        "yes wait",
        "cancel",
    ]
    for phrase in negatives:
        assert is_explicit_booking_confirmation(phrase) is False, f"Failed for {phrase!r}"


def test_booking_details_changed_and_fingerprint_invalidation() -> None:
    from app.chat_api import (
        booking_confirmation_fingerprint,
        booking_details_changed,
    )

    # Details changed detector
    assert booking_details_changed({"phone": "5551234567"}) is True
    assert booking_details_changed({"service": "AC repair"}) is True
    assert booking_details_changed({"date": "2030-05-01"}) is True
    assert booking_details_changed({"time": "10:00"}) is True
    assert booking_details_changed({"name": "Alice"}) is False
    assert booking_details_changed({"notes": "dog in yard"}) is False

    # Fingerprint stability and invalidation
    slots_a = {
        "phone": "5551234567",
        "service": "AC repair",
        "date": "2030-05-01",
        "time": "10:00",
    }
    fp_a1 = booking_confirmation_fingerprint(slots_a)
    fp_a2 = booking_confirmation_fingerprint(slots_a)
    assert fp_a1 == fp_a2

    slots_b = dict(slots_a)
    slots_b["time"] = "14:00"
    fp_b = booking_confirmation_fingerprint(slots_b)
    assert fp_a1 != fp_b


def test_booking_result_text_classification() -> None:
    from app.chat_api import booking_result_text

    # Genuine success
    reply, success = booking_result_text("Booked AC repair at 2030-05-01T10:00:00-04:00")
    assert success is True
    assert "You're all set" in reply

    # Slot unavailable failure
    reply_fail, success_fail = booking_result_text(
        "That slot is already booked. Available nearby slots: 11:00 AM, 02:00 PM"
    )
    assert success_fail is False
    assert "wasn't able to book" in reply_fail
    assert "confirmed" not in reply_fail.lower()


def test_sse_repeating_confirmation_does_not_create_second_appointment() -> None:
    from uuid import uuid4

    settings = Settings(
        LLM_API_KEY="test-key",
        BUSINESS_OPENING_HOURS='{"monday":"08:00-18:00","tuesday":"08:00-18:00","wednesday":"08:00-18:00","thursday":"08:00-18:00","friday":"08:00-18:00","saturday":"08:00-18:00","sunday":"08:00-18:00"}',
        _env_file=None,
    )
    app = create_app(settings)
    client = TestClient(app)

    room = f"repeat-test-{uuid4().hex[:8]}"
    call_id = _start_browser_call(room)
    future_date = (datetime.now() + timedelta(days=25)).strftime("%Y-%m-%d")
    phone = f"555{2000000 + (abs(hash(room)) % 7999999)}"

    # Turn 1: Provide all slots
    client.post(
        "/v1/calls/chat",
        json=_browser_payload(room, call_id, f"Book AC repair for {future_date} 10am"),
    )
    res_recap = client.post(
        "/v1/calls/chat",
        json=_browser_payload(room, call_id, f"My phone is {phone}"),
    )
    assert "Just to confirm" in res_recap.text

    # Turn 2: Confirm once
    res_book = client.post(
        "/v1/calls/chat",
        json=_browser_payload(room, call_id, "Yes please"),
    )
    assert 'event: done\ndata: {"outcome": "booked"}' in res_book.text

    # Verify 1 appointment in DB
    with new_session() as session:
        count = session.query(Appointment).count()
        assert count == 1

    # Turn 3: Repeat confirmation
    res_repeat = client.post(
        "/v1/calls/chat",
        json=_browser_payload(room, call_id, "Yes please"),
    )
    assert res_repeat.status_code == 200
    assert "already all set" in res_repeat.text
    assert 'event: done\ndata: {"outcome": "booked"}' in res_repeat.text

    # Verify STILL only 1 appointment in DB
    with new_session() as session:
        count_after = session.query(Appointment).count()
        assert count_after == 1


def test_sse_revised_time_requires_new_recap() -> None:
    from uuid import uuid4

    settings = Settings(
        LLM_API_KEY="test-key",
        BUSINESS_OPENING_HOURS='{"monday":"08:00-18:00","tuesday":"08:00-18:00","wednesday":"08:00-18:00","thursday":"08:00-18:00","friday":"08:00-18:00","saturday":"08:00-18:00","sunday":"08:00-18:00"}',
        _env_file=None,
    )
    app = create_app(settings)
    client = TestClient(app)

    room = f"recap-revise-{uuid4().hex[:8]}"
    call_id = _start_browser_call(room)
    future_date = (datetime.now() + timedelta(days=26)).strftime("%Y-%m-%d")
    phone = f"555{3000000 + (abs(hash(room)) % 6999999)}"

    # Provide initial details
    client.post(
        "/v1/calls/chat",
        json=_browser_payload(room, call_id, f"Book AC repair for {future_date} 10am"),
    )
    res_recap1 = client.post(
        "/v1/calls/chat",
        json=_browser_payload(room, call_id, f"My phone is {phone}"),
    )
    assert "10:00 AM" in res_recap1.text

    # Revise time to 2pm
    res_recap2 = client.post(
        "/v1/calls/chat",
        json=_browser_payload(room, call_id, "Actually can we make it 2:00 PM"),
    )
    assert res_recap2.status_code == 200
    assert "02:00 PM" in res_recap2.text or "2:00 PM" in res_recap2.text
    assert "Would you like me to book it?" in res_recap2.text

    # Now confirm
    res_confirm = client.post(
        "/v1/calls/chat",
        json=_browser_payload(room, call_id, "Yes please"),
    )
    assert 'event: done\ndata: {"outcome": "booked"}' in res_confirm.text

    # Check appointment time in DB is 14:00
    with new_session() as session:
        appt = session.query(Appointment).first()
        assert appt is not None
        assert appt.scheduled_for.hour in (14, 18)


def test_read_only_tools_vs_booking_tools() -> None:
    from app.chat_api import BOOKING_TOOLS, READ_ONLY_TOOLS, TOOLS

    read_only_names = [t["function"]["name"] for t in READ_ONLY_TOOLS]
    assert "book_appointment_tool" not in read_only_names
    assert "check_my_appointments" in read_only_names

    booking_names = [t["function"]["name"] for t in BOOKING_TOOLS]
    assert "book_appointment_tool" in booking_names
    assert "check_my_appointments" in booking_names

    legacy_names = [t["function"]["name"] for t in TOOLS]
    assert "book_appointment_tool" in legacy_names


def test_safety_emergency_instruction_takes_priority() -> None:
    from uuid import uuid4

    settings = Settings(_env_file=None)
    app = create_app(settings)
    client = TestClient(app)

    room = f"emergency-{uuid4().hex[:8]}"
    call_id = _start_browser_call(room)

    res = client.post(
        "/v1/calls/chat",
        json=_browser_payload(
            room,
            call_id,
            "I smell gas in my basement and the furnace is clicking!",
        ),
    )
    assert res.status_code == 200
    assert "leave the building immediately" in res.text
    assert "911" in res.text
    assert 'event: done\ndata: {"outcome": "info_only"}' in res.text


def test_safety_emergency_keywords_and_exclusions() -> None:
    from app.chat_api import _is_safety_emergency

    # Fireplace must not trigger safety emergency
    assert _is_safety_emergency("I have a gas fireplace in my living room") is False
    assert _is_safety_emergency("We want to service our fireplace") is False

    # Actual fire and safety hazards must trigger
    assert _is_safety_emergency("My furnace caught on fire!") is True
    assert _is_safety_emergency("There is smoke coming from the vents") is True
    assert _is_safety_emergency("I smell gas near the meter") is True
    assert _is_safety_emergency("The unit is sparking") is True


def test_slang_cool_not_extracted_as_ac_repair() -> None:
    from app.chat_api import _extract_slots_from_text

    # Slang expressions with cool must NOT trigger AC repair
    assert "service" not in _extract_slots_from_text("That's cool, thanks!", {})
    assert "service" not in _extract_slots_from_text("Cool, sounds like a plan", {})

    # Legitimate cooling requests must trigger AC repair
    assert _extract_slots_from_text("My AC is not cooling", {}).get("service") == "AC repair"
    assert _extract_slots_from_text("We need cooling repair", {}).get("service") == "AC repair"
    assert _extract_slots_from_text("Air conditioning is down", {}).get("service") == "AC repair"


def test_phone_extraction_international_and_short_digits() -> None:
    from app.chat_api import _extract_slots_from_text

    slots: dict[str, object] = {}
    # 8-digit international
    assert _extract_slots_from_text("It's +12345678", slots).get("phone") == "+12345678"
    # 9-digit
    assert _extract_slots_from_text("123456789", slots).get("phone") == "123456789"
    # 9-digit with prefix
    assert _extract_slots_from_text("If you're my number it's +123456789", slots).get("phone") == "+123456789"
    # 7-digit local
    assert _extract_slots_from_text("My number is 555-1234", slots).get("phone") == "5551234"


def test_anti_repetition_and_objection_reaches_llm() -> None:
    from uuid import uuid4

    from fastapi.testclient import TestClient

    from app.main import create_app

    settings = Settings(
        LLM_API_KEY="test-key",
        BUSINESS_SERVICES='["AC repair", "Heating repair"]',
        _env_file=None,
    )
    app = create_app(settings)
    client = TestClient(app)

    room = f"anti-loop-test-{uuid4().hex[:8]}"
    call_id = _start_browser_call(room)

    async def fake_stream(*args: object, **kwargs: object) -> object:
        delta = type(
            "Delta",
            (),
            {
                "content": "Our technician calls 15 minutes before arriving so you know we're on the way!",
                "tool_calls": None,
            },
        )()

        class Chunk:
            choices = [type("Choice", (), {"delta": delta})()]

        yield Chunk()

    with patch("app.chat_api._get_client") as mock_get_client:
        mock_openai = AsyncMock()
        mock_openai.chat.completions.create = AsyncMock(side_effect=fake_stream)
        mock_get_client.return_value = mock_openai

        # Turn 1: Service is AC repair -> triggers phone elicitation
        res1 = client.post(
            "/v1/calls/chat",
            json=_browser_payload(room, call_id, "My AC isn't cooling well"),
        )
        assert res1.status_code == 200
        assert "best callback phone number" in res1.text

        # Turn 2: User asks "Why are you asking for my number" -> MUST reach LLM, NOT repeat static question
        res2 = client.post(
            "/v1/calls/chat",
            json=_browser_payload(room, call_id, "Why are you asking for my number"),
        )
        assert res2.status_code == 200
        assert "calls 15 minutes before arriving" in res2.text

        # Turn 3: User says "I have no number" -> MUST reach LLM, NOT repeat static question
        res3 = client.post(
            "/v1/calls/chat",
            json=_browser_payload(room, call_id, "I have no number"),
        )
        assert res3.status_code == 200
        # Verified that LLM was called rather than static question repeating
        assert mock_openai.chat.completions.create.call_count >= 2


def test_echo_detection_prefix_suffix_and_substring() -> None:
    from app.chat_api import ChatMessage, _is_echo_of_assistant

    history = [
        ChatMessage(
            role="assistant",
            content="Thanks for calling Example HVAC! This is Sarah — how can I help with your heating or cooling today?",
        ),
        ChatMessage(
            role="user",
            content="My AC is blowing warm air.",
        ),
        ChatMessage(
            role="assistant",
            content="Got it, AC repair. What's the best callback phone number for the technician to reach you?",
        ),
        ChatMessage(
            role="user",
            content="555-123-4567",
        ),
        ChatMessage(
            role="assistant",
            content="I have an opening tomorrow at 9:00 AM. Would you like me to book it?",
        ),
    ]

    # Prefix echoes
    assert _is_echo_of_assistant("Thanks for calling Example HVAC", history) is True
    assert _is_echo_of_assistant("Got it", history) is True

    # Suffix echoes
    assert _is_echo_of_assistant("heating or cooling today", history) is True
    assert _is_echo_of_assistant("Would you like me to book it", history) is True

    # Substring echo
    assert _is_echo_of_assistant("best callback phone number", history) is True

    # Genuine caller response must NOT be treated as echo
    assert _is_echo_of_assistant("ac repair", history) is False
    assert _is_echo_of_assistant("yes go ahead", history) is False
    assert _is_echo_of_assistant("tomorrow morning", history) is False


def test_explicit_booking_confirmation_variations() -> None:
    from app.chat_api import is_explicit_booking_confirmation

    confirmations = [
        "yes",
        "yes please",
        "yes go ahead",
        "yes please go ahead",
        "go ahead please",
        "yeah go ahead",
        "sure go ahead",
        "yes book it",
        "yes book that",
        "yes please book that",
        "definitely",
        "yes definitely",
        "yes that works",
        "yeah that works",
        "yes sounds good",
        "yeah sounds good",
        "that works for me",
        "sounds good",
        "confirm it",
    ]
    for phrase in confirmations:
        assert is_explicit_booking_confirmation(phrase) is True, f"Failed for: {phrase}"

    non_confirmations = [
        "why are you asking",
        "no",
        "tomorrow at 10 am",
        "what time works",
        "hello",
    ]
    for phrase in non_confirmations:
        assert is_explicit_booking_confirmation(phrase) is False, f"Expected False for: {phrase}"


def test_chat_endpoint_echo_returns_silent_noop() -> None:
    from uuid import uuid4

    from fastapi.testclient import TestClient

    from app.main import create_app

    settings = Settings(
        LLM_API_KEY="test-key",
        BUSINESS_SERVICES='["AC repair", "Heating repair"]',
        _env_file=None,
    )
    app = create_app(settings)
    client = TestClient(app)

    room = f"echo-noop-test-{uuid4().hex[:8]}"
    call_id = _start_browser_call(room)

    history = [
        {
            "role": "assistant",
            "content": "Got it, AC repair. What's the best callback phone number for the technician to reach you?",
        }
    ]

    payload = _browser_payload(room, call_id, "Got it")
    payload["history"] = history

    res = client.post("/v1/calls/chat", json=payload)
    assert res.status_code == 200
    # Must contain ONLY event: done and NO event: delta
    assert "event: done" in res.text
    assert "event: delta" not in res.text
    assert '{"outcome": "info_only"}' in res.text


def test_end_call_long_summary_does_not_422() -> None:
    settings = Settings(ADMIN_API_KEY="test-key", _env_file=None)
    app = create_app(settings)
    client = TestClient(app)

    room = "test-long-summary-room"
    call_id = _start_browser_call(room)

    # 6000 character summary from multi-turn transcript
    long_summary = "Turn: User asked about AC repair. Sarah answered.\n" * 120
    assert len(long_summary) > 5000

    res = client.post(
        "/v1/calls/end",
        json={
            "session_id": room,
            "call_id": call_id,
            "call_secret": _CALL_SECRET,
            "outcome": "info_only",
            "summary": long_summary,
        },
    )
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "ok"
    assert data["call_id"] == call_id

    # Verify call record was actually closed and summary persisted
    with new_session() as session:
        record = session.get(CallRecord, call_id)
        assert record is not None
        assert record.ended_at is not None
        assert record.transcript_summary is not None
        assert len(record.transcript_summary) <= 4000


def test_natural_time_extraction() -> None:
    from app.chat_api import _extract_slots_from_text

    slots = _extract_slots_from_text("Can you come tomorrow morning for AC repair?", {})
    assert slots.get("service") == "AC repair"
    assert slots.get("date") == "tomorrow"
    assert slots.get("time") == "09:00 AM"

    slots2 = _extract_slots_from_text("Let's do tomorrow afternoon", {})
    assert slots2.get("date") == "tomorrow"
    assert slots2.get("time") == "02:00 PM"

    slots3 = _extract_slots_from_text("How about tomorrow at 10?", {})
    assert slots3.get("date") == "tomorrow"
    assert slots3.get("time") == "10:00 AM"

    slots4 = _extract_slots_from_text("Tomorrow at 3 in the afternoon", {})
    assert slots4.get("date") == "tomorrow"
    assert slots4.get("time") == "03:00 PM"

    slots5 = _extract_slots_from_text("Tomorrow around 10 o'clock", {})
    assert slots5.get("date") == "tomorrow"
    assert slots5.get("time") == "10:00 AM"

    slots6 = _extract_slots_from_text("Tomorrow at noon", {})
    assert slots6.get("date") == "tomorrow"
    assert slots6.get("time") == "12:00 PM"


def test_booking_tools_available() -> None:
    from app.chat_api import BOOKING_TOOLS

    tool_names = [t["function"]["name"] for t in BOOKING_TOOLS]
    assert "book_appointment_tool" in tool_names
    assert "check_my_appointments" in tool_names




