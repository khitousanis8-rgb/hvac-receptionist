# pyright: reportCallIssue=false
# pydantic-settings accepts env-var kwargs dynamically; pyright cannot see them.

"""Comprehensive test suite for Phase 2: Privacy, Authorization & Abuse Controls.

Verifies:
1. Anonymous callers cannot query appointment details by phone number (privacy refusal).
2. check_my_appointments tool removed from agent tools and tool schemas.
3. Strict 10-digit NANP phone validation (rejects 7-digit numbers; accepts 10-digit NANP).
4. Chat history bounds at HTTP boundary (rejects >100 messages or >30,000 characters with HTTP 422).
5. Pre-LLM chat rate limiting (HTTP 429 when threshold exceeded).
6. Trusted proxy client IP resolution (X-Forwarded-For ignored unless connecting from trusted proxy).
7. POST /v1/voice/stream returns audio with Cache-Control: private, no-store, must-revalidate.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import cast
from unittest.mock import patch

import pytest
from fastapi import HTTPException, Request
from fastapi.testclient import TestClient

from app.agent.tools import build_receptionist_tools
from app.chat_api import BOOKING_TOOLS, READ_ONLY_TOOLS, _execute_tool
from app.config import Settings
from app.db import Appointment, Customer, new_session
from app.main import create_app
from app.scheduling import book_appointment, normalize_nanp_phone
from app.security import check_chat_rate_limit, get_client_ip, reset_rate_limits


def test_anonymous_cannot_check_my_appointments(db) -> None:
    """Anonymous callers cannot look up or inspect existing appointments."""
    settings = Settings(_env_file=None)
    phone = "+15554328765"

    with new_session() as session:
        cust = Customer(phone_number=phone, name="Private Customer")
        session.add(cust)
        session.flush()
        appt = Appointment(
            customer_id=cust.id,
            service="Furnace tune-up",
            scheduled_for=datetime(2030, 11, 10, 10, 0, tzinfo=UTC),
            status="booked",
        )
        session.add(appt)
        session.commit()

    # Tool invocation returns neutral privacy refusal, leaking no appointment details
    result = _execute_tool(settings, "check_my_appointments", {"phone_number": phone})
    assert "privacy and security" in result.lower()
    assert "portal" in result.lower()
    assert "furnace" not in result.lower()
    assert "november" not in result.lower()


def test_check_my_appointments_removed_from_all_tool_schemas() -> None:
    """Ensure check_my_appointments is completely excluded from LLM tools."""
    assert not any(t["function"]["name"] == "check_my_appointments" for t in READ_ONLY_TOOLS)
    assert not any(t["function"]["name"] == "check_my_appointments" for t in BOOKING_TOOLS)

    livekit_tools = build_receptionist_tools(Settings(_env_file=None))
    assert not any(getattr(fn, "__name__", "") == "check_my_appointments" for fn in livekit_tools)


def test_strict_nanp_validation_rejects_7_digit_numbers() -> None:
    """Verify 7-digit and malformed phone numbers are rejected by NANP normalization."""
    # 7-digit local numbers rejected
    assert normalize_nanp_phone("555-1234") is None
    assert normalize_nanp_phone("5551234") is None

    # Fewer than 10 digits rejected
    assert normalize_nanp_phone("+12345678") is None
    assert normalize_nanp_phone("123456789") is None

    # Invalid area code starting with 0 or 1 rejected
    assert normalize_nanp_phone("0123456789") is None
    assert normalize_nanp_phone("1123456789") is None

    # Valid 10-digit NANP accepted
    assert normalize_nanp_phone("5554328765") == "+15554328765"
    assert normalize_nanp_phone("+1 555 432 8765") == "+15554328765"
    assert normalize_nanp_phone("(555) 123-4567") == "+15551234567"


def test_booking_rejects_7_digit_phone(db) -> None:
    """Verify book_appointment fails closed if phone is not 10-digit NANP."""
    settings = Settings(
        BUSINESS_OPENING_HOURS='{"monday":"08:00-18:00"}',
        BUSINESS_TIMEZONE="UTC",
        _env_file=None,
    )
    when = datetime(2030, 6, 3, 10, 0, tzinfo=UTC)

    with new_session() as session:
        # 7-digit phone rejected
        appt, msg = book_appointment(session, settings, "555-1234", "AC repair", when)
        assert appt is None
        assert "valid phone number is required" in msg

        # 10-digit NANP phone succeeds
        appt2, msg2 = book_appointment(session, settings, "555-432-8765", "AC repair", when)
        assert appt2 is not None
        assert "booked" in msg2.lower()


def test_chat_history_bounds_http_422() -> None:
    """Chat history exceeding message count or character bounds raises HTTP 422."""
    settings = Settings(LLM_API_KEY="test-key", _env_file=None)
    app = create_app(settings)
    client = TestClient(app)

    # 1. More than 100 history messages rejected
    oversized_history = [{"role": "user", "content": f"msg {i}"} for i in range(101)]
    res1 = client.post(
        "/v1/calls/chat",
        json={
            "session_id": "test-bounds-01",
            "message": "hello",
            "call_secret": "a" * 64,
            "history": oversized_history,
        },
    )
    assert res1.status_code == 422

    # 2. Total history character count > 30,000 rejected
    huge_msg_history = [
        {"role": "user", "content": "x" * 3500} for _ in range(10)  # 35,000 chars total
    ]
    res2 = client.post(
        "/v1/calls/chat",
        json={
            "session_id": "test-bounds-02",
            "message": "hello",
            "call_secret": "a" * 64,
            "history": huge_msg_history,
        },
    )
    assert res2.status_code == 422
    assert "30,000" in res2.text

    # 3. Individual message > 4000 characters rejected
    res3 = client.post(
        "/v1/calls/chat",
        json={
            "session_id": "test-bounds-03",
            "message": "x" * 4001,
            "call_secret": "a" * 64,
        },
    )
    assert res3.status_code == 422


def test_chat_rate_limit_http_429() -> None:
    """Enforcing chat sliding window rate limit returns HTTP 429 after 30 requests."""
    reset_rate_limits()
    test_ip = "192.168.1.100"

    for _ in range(30):
        check_chat_rate_limit(test_ip)

    with pytest.raises(HTTPException) as exc_info:
        check_chat_rate_limit(test_ip)

    assert exc_info.value.status_code == 429
    assert "Rate limit exceeded" in exc_info.value.detail
    reset_rate_limits()


def test_trusted_proxy_client_ip_resolution() -> None:
    """X-Forwarded-For is only trusted when client IP is in trusted_proxies list."""
    from starlette.datastructures import Headers

    class DummyClient:
        def __init__(self, host: str) -> None:
            self.host = host

    class DummyRequest:
        def __init__(self, socket_ip: str, forwarded_for: str | None = None) -> None:
            self.client = DummyClient(socket_ip)
            raw_headers = []
            if forwarded_for:
                raw_headers.append((b"x-forwarded-for", forwarded_for.encode()))
            self.headers = Headers(raw=raw_headers)

    # Case A: Untrusted client attempts to spoof X-Forwarded-For
    untrusted_req = cast(Request, DummyRequest("203.0.113.5", forwarded_for="198.51.100.1"))
    settings_no_proxy = Settings(trusted_proxies="", _env_file=None)
    assert get_client_ip(untrusted_req, settings_no_proxy) == "203.0.113.5"

    # Case B: Connecting socket is a configured trusted proxy (e.g. Render / Cloudflare proxy)
    proxy_req = cast(Request, DummyRequest("10.0.0.1", forwarded_for="198.51.100.42, 10.0.0.1"))
    settings_with_proxy = Settings(trusted_proxies="10.0.0.1, 10.0.0.2", _env_file=None)
    assert get_client_ip(proxy_req, settings_with_proxy) == "198.51.100.42"


def test_post_voice_stream_with_private_cache_control() -> None:
    """POST /v1/voice/stream generates audio and sets Cache-Control: private, no-store."""
    settings = Settings(_env_file=None)
    app = create_app(settings)
    client = TestClient(app)

    fake_mp3 = b"ID3" + b"\xff\xfb\x90\x00" * 200

    async def mock_stream(self):
        yield {"type": "audio", "data": fake_mp3}

    with patch("edge_tts.Communicate.stream", side_effect=mock_stream, autospec=True):
        payload = {
            "text": "Your appointment is confirmed for tomorrow at 10 AM.",
            "voice": "en-US-JennyNeural",
        }
        res = client.post("/v1/voice/stream", json=payload)
        assert res.status_code == 200
        assert "audio/mpeg" in res.headers["content-type"]
        assert "private" in res.headers["cache-control"]
        assert "no-store" in res.headers["cache-control"]
        assert res.headers.get("pragma") == "no-cache"

        # Repeated request served from LRU cache must also carry private, no-store headers
        res_cached = client.post("/v1/voice/stream", json=payload)
        assert res_cached.status_code == 200
        assert res_cached.headers.get("x-audio-source") == "cache"
        assert "private" in res_cached.headers["cache-control"]
        assert "no-store" in res_cached.headers["cache-control"]
        assert res_cached.headers.get("pragma") == "no-cache"
