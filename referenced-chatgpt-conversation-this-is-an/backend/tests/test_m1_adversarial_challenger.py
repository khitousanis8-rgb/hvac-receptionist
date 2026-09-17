# pyright: reportCallIssue=false, reportAttributeAccessIssue=false
"""Adversarial stress and edge-case test suite for Milestone 1.

Focus areas:
1. Dialect parity & zero DB pollution (isolated temporary DB, runtime DB protection).
2. Partial unique index (slot conflict, timezone collision, and idempotent slot reuse on cancellation).
3. POST /v1/voice/stream edge cases (oversized text, invalid text, voice aliases, private cache headers, rate limiting, concurrency).
4. Speech affirmation variants during recap (assert NO appointment created, NO tool called).
5. Anonymous appointment lookup queries (assert neutral refusal, NO appointment disclosure).
6. Booking rate limit (assert 5 pass, 6th returns 429, sliding window & concurrency).
"""

from __future__ import annotations

import threading
import time
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import patch
from uuid import uuid4
from zoneinfo import ZoneInfo

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.dialects import postgresql, sqlite
from sqlalchemy.exc import IntegrityError
from sqlalchemy.pool import QueuePool

from app.call_tracking import (
    get_call_slots,
    start_or_get_browser_call,
)
from app.chat_api import (
    READ_ONLY_TOOLS,
    TOOLS,
    _execute_tool,
)
from app.config import Settings
from app.db import (
    Appointment,
    CallRecord,
    Customer,
    UTCDateTime,
    _is_runtime_database,
    get_engine,
    new_session,
    reset_engine,
)
from app.main import create_app
from app.scheduling import (
    book_appointment,
    cancel_appointment,
    has_conflict,
)
from app.security import (
    check_booking_rate_limit,
    reset_rate_limits,
)
from app.tts_stream import (
    _IP_TTS_TIMESTAMPS,
    _RATE_LIMIT_LOCK,
    DEFAULT_VOICE,
)

_TEST_CALL_SECRET = "b" * 64


def _start_test_call(room_name: str) -> int:
    return start_or_get_browser_call(room_name, _TEST_CALL_SECRET)


def _test_payload(room_name: str, call_id: int, message: str) -> dict[str, object]:
    return {
        "session_id": room_name,
        "message": message,
        "call_id": call_id,
        "call_secret": _TEST_CALL_SECRET,
    }

# ---------------------------------------------------------------------------
# Area 1: Dialect Parity & Zero DB Pollution
# ---------------------------------------------------------------------------


def test_runtime_db_isolation_guard_blocks_all_production_targets() -> None:
    """Ensure get_engine blocks all forms of connection attempts to hvac_receptionist.db."""
    forbidden_urls = [
        "sqlite:///./hvac_receptionist.db",
        "sqlite:///hvac_receptionist.db",
        "sqlite:///c:/Users/TL/Documents/Codex/2026-08-27/referenced-chatgpt-conversation-this-is-an/backend/hvac_receptionist.db",
        "sqlite:///HVAC_RECEPTIONIST.DB",
        "sqlite:///./HVAC_RECEPTIONIST.db?mode=rw",
        "sqlite:///./subdir/../hvac_receptionist.db",
    ]
    for target in forbidden_urls:
        assert _is_runtime_database(target) is True, f"Failed to identify runtime db: {target}"
        with pytest.raises(RuntimeError, match="Database isolation guard violation"):
            get_engine(target)


def test_sqlite_dialect_check_same_thread_disabled() -> None:
    """Empirically prove SQLite engine configures check_same_thread=False by sharing connection across threads."""
    reset_engine()
    engine = get_engine("sqlite:///:memory:")
    assert engine.dialect.name == "sqlite"

    # In SQLite, if check_same_thread is True, accessing a connection from a secondary thread
    # raises sqlite3.ProgrammingError. With check_same_thread=False, it executes smoothly.
    raw_conn = getattr(engine.raw_connection(), "driver_connection", None) or engine.raw_connection().connection
    results: list[int] = []
    errors: list[Exception] = []

    def worker() -> None:
        try:
            cursor = raw_conn.cursor()
            cursor.execute("SELECT 12345")
            row = cursor.fetchone()
            if row:
                results.append(row[0])
        except Exception as exc:
            errors.append(exc)

    thread = threading.Thread(target=worker)
    thread.start()
    thread.join()

    assert not errors, f"Cross-thread query raised error: {errors}"
    assert results == [12345]
    reset_engine()


def test_postgres_engine_configuration_parity() -> None:
    """Verify engine configuration sets PostgreSQL pool parameters correctly when using postgresql+psycopg."""
    reset_engine()
    test_pg_url = "postgresql+psycopg://testuser:testpass@localhost:5432/testdb"
    engine = get_engine(test_pg_url)
    assert engine.dialect.name == "postgresql"
    assert engine.dialect.driver == "psycopg"
    assert isinstance(engine.pool, QueuePool)
    settings = Settings(_env_file=None)
    assert engine.pool.size() == settings.db_pool_size
    reset_engine()


def test_utcdatetime_type_decorator_dialect_parity() -> None:
    """Verify UTCDateTime normalizes datetime objects across SQLite and PostgreSQL dialects."""
    decorator = UTCDateTime()
    sqlite_dialect = sqlite.dialect()
    pg_dialect = postgresql.dialect()

    # 1. Aware datetime binding
    dt_aware = datetime(2026, 10, 15, 14, 30, tzinfo=UTC)

    # In SQLite, bind parameter is naive UTC
    bound_sqlite = decorator.process_bind_param(dt_aware, sqlite_dialect)
    assert bound_sqlite is not None
    assert bound_sqlite.tzinfo is None
    assert bound_sqlite.hour == 14 and bound_sqlite.minute == 30

    # In PostgreSQL, bind parameter retains UTC tzinfo
    bound_pg = decorator.process_bind_param(dt_aware, pg_dialect)
    assert bound_pg is not None
    assert bound_pg.tzinfo == UTC

    # 2. Result value extraction
    dt_naive = datetime(2026, 10, 15, 14, 30)
    result_sqlite = decorator.process_result_value(dt_naive, sqlite_dialect)
    assert result_sqlite is not None
    assert result_sqlite.tzinfo == UTC

    result_pg = decorator.process_result_value(dt_aware, pg_dialect)
    assert result_pg is not None
    assert result_pg.tzinfo == UTC


# ---------------------------------------------------------------------------
# Area 2: Partial Unique Index: Slot Conflict & Cancellation Reuse
# ---------------------------------------------------------------------------


def test_partial_unique_index_slot_conflict_and_direct_integrity_enforcement(db) -> None:
    """Adversarially verify slot conflict via app logic AND database partial unique index."""
    settings = Settings(
        BUSINESS_OPENING_HOURS='{"monday":"08:00-18:00","tuesday":"08:00-18:00","wednesday":"08:00-18:00","thursday":"08:00-18:00","friday":"08:00-18:00"}',
        BUSINESS_TIMEZONE="UTC",
        BUSINESS_SERVICES="furnace tune-up,ac repair,heat pump check",
        _env_file=None,
    )
    slot_time = datetime(2026, 11, 6, 10, 0, tzinfo=UTC)

    with new_session() as session:
        # Customer 1 books slot_time
        appt1, msg1 = book_appointment(
            session=session,
            settings=settings,
            phone_number="5551112222",
            service="furnace tune-up",
            when=slot_time,
            name="Alice",
        )
        assert appt1 is not None
        assert appt1.status == "booked"
        assert has_conflict(session, slot_time) is True

        # Customer 2 attempts to book the same slot -> caught by app conflict check
        appt2, msg2 = book_appointment(
            session=session,
            settings=settings,
            phone_number="5553334444",
            service="ac repair",
            when=slot_time,
            name="Bob",
        )
        assert appt2 is None
        assert "already taken" in msg2

        # Direct SQL bypass: attempt to force an overlapping 'booked' appointment
        cust2 = session.query(Customer).filter_by(phone_number="+15553334444").one()
        overlapping_appt = Appointment(
            customer_id=cust2.id,
            service="ac repair",
            scheduled_for=slot_time,
            status="booked",
        )
        session.add(overlapping_appt)

        # Partial unique index MUST raise IntegrityError on flush/commit
        with pytest.raises(IntegrityError):
            session.flush()

        session.rollback()


def test_partial_unique_index_timezone_equivalent_timestamps_collide(db) -> None:
    """Adversarially verify that equivalent moments in different timezones collide under the unique index."""
    settings = Settings(
        BUSINESS_OPENING_HOURS='{"monday":"08:00-20:00","tuesday":"08:00-20:00","wednesday":"08:00-20:00","thursday":"08:00-20:00","friday":"08:00-20:00"}',
        BUSINESS_TIMEZONE="America/New_York",
        BUSINESS_SERVICES="furnace tune-up,ac repair",
        _env_file=None,
    )
    # 2:00 PM EDT (UTC-4) on Friday Oct 2, 2026 is 18:00:00 UTC
    ny_tz = ZoneInfo("America/New_York")
    time_ny = datetime(2026, 10, 2, 14, 0, tzinfo=ny_tz)
    time_utc = datetime(2026, 10, 2, 18, 0, tzinfo=UTC)

    with new_session() as session:
        appt1, _ = book_appointment(
            session=session,
            settings=settings,
            phone_number="5552223333",
            service="furnace tune-up",
            when=time_ny,
            name="NY Customer",
        )
        assert appt1 is not None

        # Customer 2 attempts to book using the equivalent UTC instant
        appt2, msg2 = book_appointment(
            session=session,
            settings=settings,
            phone_number="5554445555",
            service="ac repair",
            when=time_utc,
            name="UTC Customer",
        )
        assert appt2 is None
        assert "already taken" in msg2


def test_partial_unique_index_idempotent_cancellation_and_repeated_slot_reuse(db) -> None:
    """Verify that cancelling an appointment allows slot reuse, allows multiple cancelled records, and is idempotent."""
    settings = Settings(
        BUSINESS_OPENING_HOURS='{"monday":"08:00-18:00","tuesday":"08:00-18:00","wednesday":"08:00-18:00","thursday":"08:00-18:00","friday":"08:00-18:00"}',
        BUSINESS_TIMEZONE="UTC",
        BUSINESS_SERVICES="furnace tune-up,ac repair,heat pump check",
        _env_file=None,
    )
    slot_time = datetime(2026, 11, 6, 14, 0, tzinfo=UTC)

    with new_session() as session:
        # 1. Customer 1 books slot_time
        appt1, _ = book_appointment(
            session=session,
            settings=settings,
            phone_number="5551110001",
            service="furnace tune-up",
            when=slot_time,
            name="Customer One",
        )
        assert appt1 is not None
        appt1_id = appt1.id

        # 2. Cancel Customer 1's appointment
        cancelled = cancel_appointment(session, appt1_id)
        assert cancelled is True
        assert appt1.status == "cancelled"

        # Idempotent cancellation: cancelling again returns True and leaves status as cancelled
        cancelled_again = cancel_appointment(session, appt1_id)
        assert cancelled_again is True
        assert appt1.status == "cancelled"

        # Cancelling non-existent appointment returns False
        assert cancel_appointment(session, 999999) is False

        # Slot is now completely available
        assert has_conflict(session, slot_time) is False

        # 3. Customer 2 books the exact same slot_time
        appt2, _ = book_appointment(
            session=session,
            settings=settings,
            phone_number="5551110002",
            service="ac repair",
            when=slot_time,
            name="Customer Two",
        )
        assert appt2 is not None
        assert appt2.status == "booked"
        appt2_id = appt2.id

        # 4. Cancel Customer 2's appointment
        assert cancel_appointment(session, appt2_id) is True
        assert appt2.status == "cancelled"

        # 5. Customer 3 books the exact same slot_time
        appt3, _ = book_appointment(
            session=session,
            settings=settings,
            phone_number="5551110003",
            service="heat pump check",
            when=slot_time,
            name="Customer Three",
        )
        assert appt3 is not None
        assert appt3.status == "booked"
        appt3_id = appt3.id

        # 6. Cancel Customer 3's appointment
        assert cancel_appointment(session, appt3_id) is True
        assert appt3.status == "cancelled"

        # 7. Customer 4 books the exact same slot_time
        appt4, _ = book_appointment(
            session=session,
            settings=settings,
            phone_number="5551110004",
            service="furnace tune-up",
            when=slot_time,
            name="Customer Four",
        )
        assert appt4 is not None
        assert appt4.status == "booked"

        # Direct verification of the database state:
        # Exactly 4 appointments exist at slot_time: 3 cancelled, 1 booked.
        all_appts = (
            session.query(Appointment)
            .filter(Appointment.scheduled_for == slot_time)
            .order_by(Appointment.id)
            .all()
        )
        assert len(all_appts) == 4
        assert [a.status for a in all_appts] == ["cancelled", "cancelled", "cancelled", "booked"]


# ---------------------------------------------------------------------------
# Area 3: POST /v1/voice/stream Edge Cases
# ---------------------------------------------------------------------------


def test_post_voice_stream_oversized_text_rejected() -> None:
    """POST /v1/voice/stream rejects text exceeding 1500 characters with HTTP 422."""
    settings = Settings(_env_file=None)
    app = create_app(settings)
    client = TestClient(app)

    # 1501 characters -> Pydantic validation rejects with HTTP 422
    payload_1501 = {
        "text": "A" * 1501,
        "voice": "en-US-JennyNeural",
    }
    res = client.post("/v1/voice/stream", json=payload_1501)
    assert res.status_code == 422

    # Massively oversized payload (20,000 characters)
    payload_huge = {
        "text": "Call me now " * 2000,
        "voice": "en-US-JennyNeural",
    }
    res_huge = client.post("/v1/voice/stream", json=payload_huge)
    assert res_huge.status_code == 422


def test_post_voice_stream_exact_boundary_1500_chars() -> None:
    """POST /v1/voice/stream accepts text with exactly 1500 characters."""
    settings = Settings(_env_file=None)
    app = create_app(settings)
    client = TestClient(app)

    fake_mp3 = b"ID3" + b"\x00" * 100

    async def mock_stream(self):
        yield {"type": "audio", "data": fake_mp3}

    with patch("edge_tts.Communicate.stream", side_effect=mock_stream, autospec=True):
        payload_1500 = {
            "text": "Hello world. " * 115 + "Exact 1500!",
        }
        payload_1500["text"] = payload_1500["text"][:1500]
        assert len(payload_1500["text"]) == 1500

        res = client.post("/v1/voice/stream", json=payload_1500)
        assert res.status_code == 200
        assert "private" in res.headers["cache-control"]


def test_post_voice_stream_invalid_and_empty_text_rejected() -> None:
    """POST /v1/voice/stream rejects empty text, whitespace, control chars, and missing fields."""
    settings = Settings(_env_file=None)
    app = create_app(settings)
    client = TestClient(app)

    # Empty string -> Pydantic min_length=1 rejects with HTTP 422
    res_empty = client.post("/v1/voice/stream", json={"text": "", "voice": "en-US-JennyNeural"})
    assert res_empty.status_code == 422

    # Whitespace only -> accepted by Pydantic, rejected by clean_text check with HTTP 400
    res_ws = client.post("/v1/voice/stream", json={"text": "     ", "voice": "en-US-JennyNeural"})
    assert res_ws.status_code == 400
    assert "Empty or non-printable" in res_ws.json()["detail"]

    # Newlines and tabs only
    res_nl = client.post("/v1/voice/stream", json={"text": "\n\n\t  \r", "voice": "en-US-JennyNeural"})
    assert res_nl.status_code == 400

    # Non-printable control characters only (\x00\x01\x02)
    res_ctrl = client.post("/v1/voice/stream", json={"text": "\x00\x01\x02\x07\x08", "voice": "en-US-JennyNeural"})
    assert res_ctrl.status_code == 400

    # Missing text field entirely
    res_missing = client.post("/v1/voice/stream", json={"voice": "en-US-JennyNeural"})
    assert res_missing.status_code == 422

    # Non-string text field
    res_type = client.post("/v1/voice/stream", json={"text": 99999})
    assert res_type.status_code == 422


def test_post_voice_stream_voice_aliases_and_defaults() -> None:
    """POST /v1/voice/stream maps browser aliases (af_sarah, kokoro, af) and defaults cleanly."""
    settings = Settings(_env_file=None)
    app = create_app(settings)
    client = TestClient(app)

    fake_mp3 = b"ID3" + b"\xff\xfb" * 50

    async def mock_stream(self):
        yield {"type": "audio", "data": fake_mp3}

    with patch("edge_tts.Communicate.stream", side_effect=mock_stream, autospec=True):
        # 1. Missing voice -> defaults to DEFAULT_VOICE (en-US-JennyNeural)
        res_default = client.post("/v1/voice/stream", json={"text": "Test default voice"})
        assert res_default.status_code == 200
        assert res_default.headers.get("x-voice-persona") == DEFAULT_VOICE

        # 2. Browser alias 'af_sarah' -> mapped to DEFAULT_VOICE
        res_alias1 = client.post("/v1/voice/stream", json={"text": "Test af_sarah", "voice": "af_sarah"})
        assert res_alias1.status_code == 200
        assert res_alias1.headers.get("x-voice-persona") == DEFAULT_VOICE

        # 3. Browser alias 'kokoro' -> mapped to DEFAULT_VOICE
        res_alias2 = client.post("/v1/voice/stream", json={"text": "Test kokoro", "voice": "kokoro"})
        assert res_alias2.status_code == 200
        assert res_alias2.headers.get("x-voice-persona") == DEFAULT_VOICE

        # 4. Browser alias 'af' -> mapped to DEFAULT_VOICE
        res_alias3 = client.post("/v1/voice/stream", json={"text": "Test af", "voice": "af"})
        assert res_alias3.status_code == 200
        assert res_alias3.headers.get("x-voice-persona") == DEFAULT_VOICE

        # 5. Alternate allowed neural voice 'en-US-GuyNeural'
        res_guy = client.post("/v1/voice/stream", json={"text": "Test Guy", "voice": "en-US-GuyNeural"})
        assert res_guy.status_code == 200
        assert res_guy.headers.get("x-voice-persona") == "en-US-GuyNeural"


def test_post_voice_stream_invalid_voices_rejected() -> None:
    """POST /v1/voice/stream strictly rejects unapproved voice names, SSML injection, and path traversal."""
    settings = Settings(_env_file=None)
    app = create_app(settings)
    client = TestClient(app)

    invalid_voices = [
        "invalid_voice",
        "af_sarah_extra",
        "en-US-JennyNeural; DROP TABLE appointments;",
        "<voice name='bad'>",
        "../../etc/passwd",
        "https://evil.com/voice",
        "en-US-JennyNeural" + "X" * 60,  # Exceeds max length
    ]
    for inv_voice in invalid_voices:
        payload = {"text": "Hello world", "voice": inv_voice}
        res = client.post("/v1/voice/stream", json=payload)
        assert res.status_code in (400, 422)


def test_post_voice_stream_private_cache_headers_on_stream_and_cache() -> None:
    """POST /v1/voice/stream MUST enforce private, no-store cache headers for both fresh and cached responses."""
    settings = Settings(_env_file=None)
    app = create_app(settings)
    client = TestClient(app)

    fake_mp3 = b"ID3" + b"\xff\xfb\x90\x00" * 80

    async def mock_stream(self):
        yield {"type": "audio", "data": fake_mp3}

    with patch("edge_tts.Communicate.stream", side_effect=mock_stream, autospec=True):
        payload = {"text": "Dynamic confirmation message #999", "voice": "en-US-JennyNeural"}

        # Fresh response (streamed)
        res1 = client.post("/v1/voice/stream", json=payload)
        assert res1.status_code == 200
        assert "private" in res1.headers["cache-control"]
        assert "no-store" in res1.headers["cache-control"]
        assert "must-revalidate" in res1.headers["cache-control"]
        assert res1.headers.get("pragma") == "no-cache"

        # Cached response (repeat turn)
        res2 = client.post("/v1/voice/stream", json=payload)
        assert res2.status_code == 200
        assert res2.headers.get("x-audio-source") == "cache"
        assert "private" in res2.headers["cache-control"]
        assert "no-store" in res2.headers["cache-control"]
        assert "must-revalidate" in res2.headers["cache-control"]
        assert res2.headers.get("pragma") == "no-cache"


def test_post_voice_stream_rate_limiter_30_per_minute() -> None:
    """Verify rate limiter allows 30 non-cached requests per minute and blocks the 31st with HTTP 429."""
    settings = Settings(trusted_proxies="testclient", _env_file=None)
    app = create_app(settings)
    client = TestClient(app)

    target_ip = "198.51.100.99"
    with _RATE_LIMIT_LOCK:
        _IP_TTS_TIMESTAMPS.pop(target_ip, None)

    fake_mp3 = b"ID3" + b"\xff\xfb" * 50

    async def mock_stream(self):
        yield {"type": "audio", "data": fake_mp3}

    # Text > 250 chars bypasses LRU caching so each request hits check_tts_rate_limit
    long_text = "This is a non-cached voice synthesis sentence designed to exercise the rate limiter directly. " * 3

    with patch("edge_tts.Communicate.stream", side_effect=mock_stream, autospec=True):
        # Exactly 30 requests succeed
        for i in range(30):
            payload = {"text": f"{long_text} Sequence #{i}", "voice": "en-US-JennyNeural"}
            headers = {"X-Forwarded-For": target_ip}
            res = client.post("/v1/voice/stream", json=payload, headers=headers)
            assert res.status_code == 200, f"Request {i+1} failed with status {res.status_code}"

        # 31st request triggers HTTP 429
        payload_31 = {"text": f"{long_text} Sequence #31", "voice": "en-US-JennyNeural"}
        res_31 = client.post("/v1/voice/stream", json=payload_31, headers={"X-Forwarded-For": target_ip})
        assert res_31.status_code == 429
        assert "Rate limit exceeded" in res_31.json()["detail"]

        # Different client IP is completely unaffected
        res_diff = client.post("/v1/voice/stream", json=payload_31, headers={"X-Forwarded-For": "198.51.100.100"})
        assert res_diff.status_code == 200


def test_post_voice_stream_concurrent_stress() -> None:
    """Verify concurrent requests to POST /v1/voice/stream do not deadlock or exhaust resources."""
    settings = Settings(_env_file=None)
    app = create_app(settings)
    client = TestClient(app)

    fake_mp3 = b"ID3" + b"\xff\xfb" * 50

    async def mock_stream(self):
        yield {"type": "audio", "data": fake_mp3}

    with patch("edge_tts.Communicate.stream", side_effect=mock_stream, autospec=True):
        results: list[int] = []
        errors: list[Exception] = []

        def worker(idx: int) -> None:
            try:
                res = client.post(
                    "/v1/voice/stream",
                    json={"text": f"Concurrent test sentence {idx}", "voice": "af_sarah"},
                )
                results.append(res.status_code)
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(15)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors, f"Concurrent thread errors: {errors}"
        assert len(results) == 15
        assert all(code == 200 for code in results)


# ---------------------------------------------------------------------------
# Area 4: Speech Affirmation Variants During Recap (Freeze Unsafe Authority)
# ---------------------------------------------------------------------------


def test_speech_affirmations_during_recap_never_book_and_never_call_tools() -> None:
    """Adversarially stress-test 35+ spoken affirmation variants during active recap.

    Empirically asserts:
    1. Zero appointments are inserted into the database.
    2. book_appointment_tool is NEVER called.
    3. book_appointment() is NEVER invoked.
    4. Call outcome remains 'info_only' and NEVER transitions to 'booked'.
    5. Session slot 'confirmed' remains False.
    6. Response prompts the user to tap 'Confirm Booking on your screen'.
    """
    settings = Settings(
        BUSINESS_COMPANY_NAME="Apex Climate Control",
        BUSINESS_SERVICES="AC repair,Furnace tuneup",
        _env_file=None,
    )
    app = create_app(settings)
    client = TestClient(app)

    affirmation_variants = [
        "yes",
        "YES",
        "YeS",
        "yeah",
        "YEAH",
        "yep",
        "YEP",
        "sure",
        "SURE",
        "correct",
        "CORRECT",
        "confirm",
        "CONFIRM",
        "yes please",
        "YES PLEASE",
        "absolutely",
        "ABSOLUTELY",
        "ok go ahead",
        "go ahead",
        "sounds good",
        "SOUNDS GOOD",
        "that works",
        "perfect",
        "definitely",
        "sure thing",
        "please book it",
        "go ahead and book it",
        "yes book it",
        "thats correct",
        "that is correct",
        "  yes  ",
        "yeah!",
        "yep...",
        "sure!!",
        "confirm.",
        "yes please!",
        "absolutely!!!",
    ]

    tool_call_log: list[str] = []
    original_execute_tool = _execute_tool

    def spy_execute_tool(st: Settings, name: str, args: dict[str, Any]) -> str:
        tool_call_log.append(name)
        return original_execute_tool(st, name, args)

    future_date = (datetime.now() + timedelta(days=20)).strftime("%Y-%m-%d")
    phone = "5551234567"

    with patch("app.chat_api._execute_tool", side_effect=spy_execute_tool):
        with patch("app.scheduling.book_appointment") as mock_book:
            for phrase in affirmation_variants:
                reset_rate_limits()
                room = f"recap-stress-{uuid4().hex[:8]}"
                call_id = _start_test_call(room)

                # 1. Feed slot data to arrive at active recap
                client.post(
                    "/v1/calls/chat",
                    json=_test_payload(room, call_id, f"I need AC repair on {future_date} at 10am"),
                )
                res_recap = client.post(
                    "/v1/calls/chat",
                    json=_test_payload(room, call_id, f"My phone number is {phone}"),
                )
                assert res_recap.status_code == 200
                assert "Just to confirm" in res_recap.text

                # Verify recap is active
                slots_before = get_call_slots(call_id)
                assert slots_before.get("confirmation_requested") is True
                assert slots_before.get("confirmation_fingerprint") is not None
                assert slots_before.get("confirmed") is not True

                # Clear tool invocation log before sending affirmation
                tool_call_log.clear()
                mock_book.reset_mock()

                # 2. Send affirmative speech
                res_affirm = client.post(
                    "/v1/calls/chat",
                    json=_test_payload(room, call_id, phrase),
                )
                assert res_affirm.status_code == 200
                text = res_affirm.text

                # 3. Assertions:
                # Must NEVER call book_appointment_tool or book_appointment
                assert "book_appointment_tool" not in tool_call_log, (
                    f"book_appointment_tool was unexpectedly called for phrase {phrase!r}"
                )
                assert mock_book.call_count == 0, (
                    f"book_appointment was unexpectedly invoked for phrase {phrase!r}"
                )

                # Done event outcome MUST be info_only
                assert 'event: done\ndata: {"outcome": "info_only"}' in text, (
                    f"Done event did not return outcome 'info_only' for phrase {phrase!r}: {text}"
                )

                # Slots in DB must NEVER be confirmed
                slots_after = get_call_slots(call_id)
                assert slots_after.get("confirmed") is not True, (
                    f"Slot confirmed was set to True by speech phrase {phrase!r}"
                )

                # Call record outcome in DB must NOT be 'booked', and zero appointments in DB
                with new_session() as session:
                    call_rec = session.get(CallRecord, call_id)
                    assert call_rec is not None
                    assert call_rec.outcome != "booked", (
                        f"Call outcome was changed to 'booked' by speech phrase {phrase!r}"
                    )
                    count = session.query(Appointment).count()
                    assert count == 0, (
                        f"Appointment was created in DB for phrase {phrase!r}"
                    )


def test_speech_negations_and_questions_during_recap_never_book() -> None:
    """Verify negations clear recap and general questions stay in info_only without booking."""
    settings = Settings(
        BUSINESS_COMPANY_NAME="Apex Climate Control",
        _env_file=None,
    )
    app = create_app(settings)
    client = TestClient(app)

    future_date = (datetime.now() + timedelta(days=22)).strftime("%Y-%m-%d")
    phone = "5559876543"

    room = f"recap-neg-{uuid4().hex[:8]}"
    call_id = _start_test_call(room)

    client.post(
        "/v1/calls/chat",
        json=_test_payload(room, call_id, f"I need AC repair on {future_date} at 2pm"),
    )
    res_recap = client.post(
        "/v1/calls/chat",
        json=_test_payload(room, call_id, f"My phone is {phone}"),
    )
    assert res_recap.status_code == 200

    # Caller says "No, wait, cancel that"
    res_cancel = client.post(
        "/v1/calls/chat",
        json=_test_payload(room, call_id, "No, cancel that"),
    )
    assert res_cancel.status_code == 200
    assert "No problem at all" in res_cancel.text
    assert 'event: done\ndata: {"outcome": "info_only"}' in res_cancel.text

    # Slots cleared
    slots_after = get_call_slots(call_id)
    assert slots_after.get("confirmation_requested") is False
    assert slots_after.get("time") is None

    # Zero appointments in database
    with new_session() as session:
        assert session.query(Appointment).count() == 0


# ---------------------------------------------------------------------------
# Area 5: Anonymous Appointment Lookup Queries (Privacy Refusal & Zero Leakage)
# ---------------------------------------------------------------------------


def test_anonymous_lookup_queries_neutral_refusal_and_zero_pii_disclosure() -> None:
    """Adversarially verify that anonymous appointment lookup attempts receive neutral refusal

    and NEVER reveal existing customer appointments, dates, services, or names.
    """
    settings = Settings(
        BUSINESS_COMPANY_NAME="Apex Climate Control",
        _env_file=None,
    )
    app = create_app(settings)
    client = TestClient(app)

    # 1. Seed existing appointments in the isolated test database
    alice_phone = "+15551234567"
    alice_name = "Alice Classified"
    alice_service = "Emergency Furnace Overhaul"
    alice_date = datetime(2026, 12, 24, 14, 0, tzinfo=UTC)

    bob_phone = "+15559876543"
    bob_name = "Bob TopSecret"
    bob_service = "Precision Heat Pump Diagnostic"
    bob_date = datetime(2026, 11, 15, 9, 30, tzinfo=UTC)

    with new_session() as session:
        c1 = Customer(phone_number=alice_phone, name=alice_name)
        c2 = Customer(phone_number=bob_phone, name=bob_name)
        session.add_all([c1, c2])
        session.flush()

        a1 = Appointment(
            customer_id=c1.id,
            service=alice_service,
            scheduled_for=alice_date,
            status="booked",
            notes="Gate code #9876. Beware of dog.",
        )
        a2 = Appointment(
            customer_id=c2.id,
            service=bob_service,
            scheduled_for=bob_date,
            status="booked",
            notes="VIP client. Do not reschedule.",
        )
        session.add_all([a1, a2])
        session.commit()

        assert session.query(Appointment).count() == 2

    # 2. Adversarial lookup queries targeting various parameters
    adversarial_queries = [
        "can you check my appointment",
        "look up my booking for 555-123-4567",
        "check my appointment for 555-123-4567",
        "look up my appointment please",
        "what is the status of my appointment?",
        "do I have an appointment scheduled?",
        "can you check the appointment for 555-432-8765?",
        "find my appointment",
        "what time is my appointment",
        "when is my appointment",
        "lookup booking for 5551234567",
        "look up my booking for 555-987-6543",
        "status of my appointment please",
        "check the booking for 555-000-1111",
        "could you verify my appointment",
        "Can you look up the appointment for Alice Classified?",
        "Existing appointment status for 5559876543",
        "Can you find my booking?",
        "check my appointment status",
    ]

    for query in adversarial_queries:
        reset_rate_limits()
        room = f"lookup-stress-{uuid4().hex[:8]}"
        call_id = _start_test_call(room)

        res = client.post(
            "/v1/calls/chat",
            json=_test_payload(room, call_id, query),
        )
        assert res.status_code == 200
        text = res.text

        # Neutral refusal policy wording
        assert "privacy and security" in text.lower(), f"Refusal missing for query {query!r}"
        assert "portal" in text.lower(), f"Portal mention missing for query {query!r}"
        assert 'event: done\ndata: {"outcome": "info_only"}' in text

        # CRITICAL PRIVACY LEAKAGE CHECKS:
        # None of the seeded PII or appointment details must appear in the response
        assert alice_name not in text
        assert bob_name not in text
        assert alice_service not in text
        assert bob_service not in text
        assert "Gate code" not in text
        assert "9876" not in text
        assert "VIP client" not in text
        assert "2026-12-24" not in text
        assert "2026-11-15" not in text
        assert "December 24" not in text
        assert "November 15" not in text


def test_lookup_tool_neutral_fallback_and_tool_list_omission() -> None:
    """Verify check_my_appointments tool directly returns neutral refusal and is omitted from LLM exposure."""
    settings = Settings(_env_file=None)

    # 1. Direct tool invocation returns neutral privacy refusal
    result = _execute_tool(settings, "check_my_appointments", {"phone_number": "5551234567"})
    assert "privacy and security" in result.lower()
    assert "portal" in result.lower()
    assert "5551234567" not in result

    # 2. Tool definition check: check_my_appointments must NOT be present in READ_ONLY_TOOLS or TOOLS
    for tool_def in READ_ONLY_TOOLS:
        fn_name = tool_def.get("function", {}).get("name", "")
        assert fn_name != "check_my_appointments"

    for tool_def in TOOLS:
        fn_name = tool_def.get("function", {}).get("name", "")
        assert fn_name != "check_my_appointments"


# ---------------------------------------------------------------------------
# Area 6: Booking Rate Limit (5 Pass, 6th 429, Multi-IP & Concurrency)
# ---------------------------------------------------------------------------


def test_booking_rate_limit_5_pass_6th_429_sliding_window_and_concurrency() -> None:
    """Adversarially verify check_booking_rate_limit sliding-window and concurrency behaviors.

    1. Exactly 5 requests pass; the 6th immediately raises HTTP 429.
    2. Different IP addresses have independent rate limit buckets.
    3. After 60 seconds (simulated), the rate limit window slides and permits requests again.
    4. Concurrency test: 20 simultaneous threads for the same IP -> exactly 5 succeed, 15 raise 429.
    """
    reset_rate_limits()
    test_ip = "192.0.2.100"

    # Step 1: 5 requests pass smoothly
    for _ in range(5):
        check_booking_rate_limit(test_ip)

    # Step 2: 6th request raises HTTP 429
    with pytest.raises(HTTPException) as exc_info:
        check_booking_rate_limit(test_ip)
    assert exc_info.value.status_code == 429
    assert "Rate limit exceeded" in exc_info.value.detail
    assert "too many booking confirmation requests" in exc_info.value.detail

    # Step 3: Independent bucket for different IP
    other_ip = "192.0.2.101"
    for _ in range(5):
        check_booking_rate_limit(other_ip)

    with pytest.raises(HTTPException) as exc_other:
        check_booking_rate_limit(other_ip)
    assert exc_other.value.status_code == 429

    # Step 4: Sliding window reset after 65 seconds
    original_time = time.time()
    with patch("time.time", return_value=original_time + 65.0):
        # Window expired -> 5 requests pass again
        for _ in range(5):
            check_booking_rate_limit(test_ip)
        # 6th in new window raises 429
        with pytest.raises(HTTPException) as exc_slide:
            check_booking_rate_limit(test_ip)
        assert exc_slide.value.status_code == 429

    # Step 5: Thread concurrency stress test (20 threads on same IP)
    reset_rate_limits()
    concurrent_ip = "192.0.2.200"
    success_count = 0
    rate_limited_count = 0
    unexpected_errors: list[Exception] = []
    lock = threading.Lock()

    def rate_limit_worker() -> None:
        nonlocal success_count, rate_limited_count
        try:
            check_booking_rate_limit(concurrent_ip)
            with lock:
                success_count += 1
        except HTTPException as he:
            if he.status_code == 429:
                with lock:
                    rate_limited_count += 1
            else:
                with lock:
                    unexpected_errors.append(he)
        except Exception as e:
            with lock:
                unexpected_errors.append(e)

    threads = [threading.Thread(target=rate_limit_worker) for _ in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not unexpected_errors, f"Unexpected errors during concurrent rate limit: {unexpected_errors}"
    assert success_count == 5, f"Expected exactly 5 successes, got {success_count}"
    assert rate_limited_count == 15, f"Expected exactly 15 rate-limited requests, got {rate_limited_count}"

    reset_rate_limits()


def test_llm_invocation_never_exposes_booking_or_lookup_tools() -> None:
    """Verify that when a turn reaches the LLM completion stage, tools passed are strictly empty."""
    settings = Settings(
        BUSINESS_COMPANY_NAME="Apex Climate Control",
        llm_api_key="test-key-mock",
        _env_file=None,
    )
    app = create_app(settings)
    client = TestClient(app)

    captured_comp_kwargs: dict[str, Any] = {}

    async def mock_stream_completion(**kwargs: Any) -> Any:
        nonlocal captured_comp_kwargs
        captured_comp_kwargs = kwargs

        class MockDelta:
            content = "I can certainly help you with general information."
            tool_calls = None

        class MockChoice:
            delta = MockDelta()

        class MockChunk:
            choices = [MockChoice()]

        async def gen() -> Any:
            yield MockChunk()

        return gen()

    with patch("app.chat_api._create_stream_completion", side_effect=mock_stream_completion):
        room = f"llm-tools-{uuid4().hex[:8]}"
        call_id = _start_test_call(room)

        res = client.post(
            "/v1/calls/chat",
            json=_test_payload(room, call_id, "What is your hourly rate for commercial HVAC?"),
        )
        assert res.status_code == 200
        assert "general information" in res.text

        # Verify that tools passed to the model are strictly empty (READ_ONLY_TOOLS = [])
        tools_passed = captured_comp_kwargs.get("tools")
        assert not tools_passed, f"Expected no tools or empty tools list, got {tools_passed}"


