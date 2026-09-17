# pyright: reportCallIssue=false
"""Milestone 3 Automated Unit Tests: Confirmation Ticket Architecture & Atomic Consumption.

Covers:
1. R4.1 ConfirmationTicket Schema & DB persistence.
2. R4.2 Ticket Issuance on Recap (event: confirmation_ticket SSE frame).
3. R4.3 Atomic Ticket Consumption Endpoint (POST /v1/calls/confirm-booking and /confirm).
4. R4.4 Replay & Double-Tap Idempotency (already_confirmed without duplicate bookings).
5. Expiration, invalid fingerprint, and mismatched call_id protections.
6. Ticket supersession (updating slot cancels previous pending ticket).
7. Rate limiting on confirmation endpoint (5 requests per minute).
8. Unauthorized call rejection (HTTP 401).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

from fastapi.testclient import TestClient

from app.call_tracking import start_or_get_browser_call
from app.config import Settings
from app.db import (
    Appointment,
    CallRecord,
    ConfirmationTicket,
    create_confirmation_ticket,
    get_confirmation_ticket,
    new_session,
)
from app.main import create_app
from app.security import reset_rate_limits

_CALL_SECRET = "c" * 64


def _start_call(room: str) -> int:
    return start_or_get_browser_call(room, _CALL_SECRET)


def _chat_payload(room: str, call_id: int, message: str) -> dict[str, Any]:
    return {
        "session_id": room,
        "call_id": call_id,
        "call_secret": _CALL_SECRET,
        "message": message,
    }


def test_recap_mints_confirmation_ticket_and_emits_sse_event(db: Any) -> None:
    """R4.2: Verify deterministic recap emits confirmation_ticket SSE event and mints ticket."""
    settings = Settings(
        LLM_API_KEY="test-key-m3",
        BUSINESS_OPENING_HOURS=(
            '{"monday":"08:00-18:00","tuesday":"08:00-18:00","wednesday":"08:00-18:00",'
            '"thursday":"08:00-18:00","friday":"08:00-18:00","saturday":"08:00-18:00",'
            '"sunday":"08:00-18:00"}'
        ),
        _env_file=None,
    )
    app = create_app(settings)
    client = TestClient(app)

    room = f"m3-ticket-{uuid4().hex[:8]}"
    call_id = _start_call(room)
    future_date = (datetime.now() + timedelta(days=20)).strftime("%Y-%m-%d")
    phone = "5552345678"

    # Provide slots to trigger deterministic recap
    client.post(
        "/v1/calls/chat",
        json=_chat_payload(room, call_id, f"I need AC repair on {future_date} at 10 AM"),
    )
    res_recap = client.post(
        "/v1/calls/chat",
        json=_chat_payload(room, call_id, f"My phone is {phone}"),
    )
    assert res_recap.status_code == 200
    text = res_recap.text
    assert "event: confirmation_ticket" in text
    assert "event: delta" in text
    assert "Just to confirm" in text

    # Verify ticket exists in DB and matches SSE data
    with new_session() as session:
        ticket = (
            session.query(ConfirmationTicket)
            .filter(ConfirmationTicket.call_id == str(call_id))
            .first()
        )
        assert ticket is not None
        assert ticket.status == "pending"
        assert ticket.service == "AC repair"
        assert ticket.phone == phone
        assert ticket.ticket_id in text
        assert ticket.fingerprint in text


def test_confirm_booking_endpoint_success(db: Any) -> None:
    """R4.3: Verify POST /v1/calls/confirm-booking consumes ticket and creates appointment."""
    settings = Settings(
        LLM_API_KEY="test-key-m3",
        BUSINESS_OPENING_HOURS=(
            '{"monday":"08:00-18:00","tuesday":"08:00-18:00","wednesday":"08:00-18:00",'
            '"thursday":"08:00-18:00","friday":"08:00-18:00","saturday":"08:00-18:00",'
            '"sunday":"08:00-18:00"}'
        ),
        _env_file=None,
    )
    app = create_app(settings)
    client = TestClient(app)

    room = f"m3-confirm-{uuid4().hex[:8]}"
    call_id = _start_call(room)
    future_dt = datetime.now(UTC) + timedelta(days=5)
    future_dt = future_dt.replace(hour=14, minute=0, second=0, microsecond=0)
    fp = "testfp123456"

    with new_session() as session:
        ticket = create_confirmation_ticket(
            session,
            call_id=call_id,
            service="Heating repair",
            phone="5553456789",
            scheduled_for=future_dt,
            fingerprint=fp,
            ttl_seconds=300,
        )
        ticket_id = ticket.ticket_id

    # Call endpoint to confirm booking
    res = client.post(
        "/v1/calls/confirm-booking",
        json={
            "call_id": call_id,
            "call_secret": _CALL_SECRET,
            "ticket_id": ticket_id,
            "fingerprint": fp,
        },
    )
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "confirmed"
    assert data["service"] == "Heating repair"
    assert data["phone"] == "5553456789"
    assert "Heating repair" in data["confirmation_message"]
    assert "confirmed" in data["confirmation_message"].lower()

    # Verify DB state
    with new_session() as session:
        consumed_ticket = get_confirmation_ticket(session, ticket_id)
        assert consumed_ticket is not None
        assert consumed_ticket.status == "consumed"
        assert consumed_ticket.consumed_at is not None
        assert consumed_ticket.appointment_id is not None

        appt = session.get(Appointment, consumed_ticket.appointment_id)
        assert appt is not None
        assert appt.status == "booked"
        assert appt.service == "Heating repair"

        call = session.get(CallRecord, call_id)
        assert call is not None
        assert call.outcome == "booked"


def test_replay_idempotency_and_double_tap(db: Any) -> None:
    """R4.4: Verify replaying confirmation returns already_confirmed with exactly 1 booking."""
    settings = Settings(
        LLM_API_KEY="test-key-m3",
        BUSINESS_OPENING_HOURS=(
            '{"monday":"08:00-18:00","tuesday":"08:00-18:00","wednesday":"08:00-18:00",'
            '"thursday":"08:00-18:00","friday":"08:00-18:00","saturday":"08:00-18:00",'
            '"sunday":"08:00-18:00"}'
        ),
        _env_file=None,
    )
    app = create_app(settings)
    client = TestClient(app)

    room = f"m3-replay-{uuid4().hex[:8]}"
    call_id = _start_call(room)
    future_dt = datetime.now(UTC) + timedelta(days=6)
    future_dt = future_dt.replace(hour=15, minute=0, second=0, microsecond=0)
    fp = "replayfp987654"

    with new_session() as session:
        ticket = create_confirmation_ticket(
            session,
            call_id=call_id,
            service="AC repair",
            phone="5554567890",
            scheduled_for=future_dt,
            fingerprint=fp,
            ttl_seconds=300,
        )
        ticket_id = ticket.ticket_id

    payload = {
        "call_id": call_id,
        "call_secret": _CALL_SECRET,
        "ticket_id": ticket_id,
        "fingerprint": fp,
    }

    # First tap
    res1 = client.post("/v1/calls/confirm-booking", json=payload)
    assert res1.status_code == 200
    assert res1.json()["status"] == "confirmed"
    booking_id = res1.json()["booking_id"]

    # Second tap (replay / double click)
    res2 = client.post("/v1/calls/confirm-booking", json=payload)
    assert res2.status_code == 200
    assert res2.json()["status"] == "already_confirmed"
    assert res2.json()["booking_id"] == booking_id

    # Third tap on alias /v1/calls/confirm
    res3 = client.post("/v1/calls/confirm", json=payload)
    assert res3.status_code == 200
    assert res3.json()["status"] == "already_confirmed"
    assert res3.json()["booking_id"] == booking_id

    # Assert exactly one appointment exists in DB
    with new_session() as session:
        count = session.query(Appointment).count()
        assert count == 1


def test_expired_ticket_rejected_with_400(db: Any) -> None:
    """R4.1: Verify expired ticket raises HTTP 400 Bad Request."""
    settings = Settings(_env_file=None)
    app = create_app(settings)
    client = TestClient(app)

    room = f"m3-expired-{uuid4().hex[:8]}"
    call_id = _start_call(room)
    future_dt = datetime.now(UTC) + timedelta(days=7)
    future_dt = future_dt.replace(hour=10, minute=0, second=0, microsecond=0)
    fp = "expiredfp"

    with new_session() as session:
        ticket = create_confirmation_ticket(
            session,
            call_id=call_id,
            service="AC repair",
            phone="5555678901",
            scheduled_for=future_dt,
            fingerprint=fp,
            ttl_seconds=-10,  # Already expired in the past
        )
        ticket_id = ticket.ticket_id

    res = client.post(
        "/v1/calls/confirm-booking",
        json={
            "call_id": call_id,
            "call_secret": _CALL_SECRET,
            "ticket_id": ticket_id,
            "fingerprint": fp,
        },
    )
    assert res.status_code == 400
    assert "ticket expired or invalid" in res.text.lower()


def test_invalid_fingerprint_rejected_with_400(db: Any) -> None:
    """Verify mismatched fingerprint raises HTTP 400 Bad Request."""
    settings = Settings(_env_file=None)
    app = create_app(settings)
    client = TestClient(app)

    room = f"m3-tamper-{uuid4().hex[:8]}"
    call_id = _start_call(room)
    future_dt = datetime.now(UTC) + timedelta(days=8)
    future_dt = future_dt.replace(hour=10, minute=0, second=0, microsecond=0)

    with new_session() as session:
        ticket = create_confirmation_ticket(
            session,
            call_id=call_id,
            service="AC repair",
            phone="5556789012",
            scheduled_for=future_dt,
            fingerprint="original_fp",
            ttl_seconds=300,
        )
        ticket_id = ticket.ticket_id

    # Tampered fingerprint
    res = client.post(
        "/v1/calls/confirm-booking",
        json={
            "call_id": call_id,
            "call_secret": _CALL_SECRET,
            "ticket_id": ticket_id,
            "fingerprint": "forged_fp_tampered",
        },
    )
    assert res.status_code == 400
    assert "ticket expired or invalid" in res.text.lower()


def test_superseded_ticket_cancelled_when_new_ticket_minted(db: Any) -> None:
    """Verify modifying booking details cancels earlier pending tickets."""
    room = f"m3-supersede-{uuid4().hex[:8]}"
    call_id = _start_call(room)
    future_dt = datetime.now(UTC) + timedelta(days=9)
    future_dt = future_dt.replace(hour=10, minute=0, second=0, microsecond=0)

    with new_session() as session:
        ticket1 = create_confirmation_ticket(
            session,
            call_id=call_id,
            service="AC repair",
            phone="5557890123",
            scheduled_for=future_dt,
            fingerprint="fp1",
            ttl_seconds=300,
        )
        t1_id = ticket1.ticket_id

    # Caller changes time, minting ticket 2
    with new_session() as session:
        ticket2 = create_confirmation_ticket(
            session,
            call_id=call_id,
            service="AC repair",
            phone="5557890123",
            scheduled_for=future_dt + timedelta(hours=2),
            fingerprint="fp2",
            ttl_seconds=300,
        )
        t2_id = ticket2.ticket_id

    # Verify ticket 1 is cancelled and ticket 2 is pending
    with new_session() as session:
        t1 = get_confirmation_ticket(session, t1_id)
        t2 = get_confirmation_ticket(session, t2_id)
        assert t1 is not None and t1.status == "cancelled"
        assert t2 is not None and t2.status == "pending"


def test_unauthorized_call_rejected_with_401(db: Any) -> None:
    """Verify wrong call_secret or unauthorized call raises HTTP 401."""
    settings = Settings(_env_file=None)
    app = create_app(settings)
    client = TestClient(app)

    room = f"m3-unauth-{uuid4().hex[:8]}"
    call_id = _start_call(room)

    res = client.post(
        "/v1/calls/confirm-booking",
        json={
            "call_id": call_id,
            "call_secret": "wrong-secret-xyz",
            "ticket_id": "tkt_fake123",
            "fingerprint": "fpfake",
        },
    )
    assert res.status_code == 401


def test_booking_rate_limit_on_confirm_endpoint(db: Any) -> None:
    """Verify rate limit triggers HTTP 429 after 5 requests from same IP."""
    reset_rate_limits()
    settings = Settings(
        BUSINESS_OPENING_HOURS=(
            '{"monday":"08:00-18:00","tuesday":"08:00-18:00","wednesday":"08:00-18:00",'
            '"thursday":"08:00-18:00","friday":"08:00-18:00","saturday":"08:00-18:00",'
            '"sunday":"08:00-18:00"}'
        ),
        _env_file=None,
    )
    app = create_app(settings)
    client = TestClient(app)

    room = f"m3-ratelimit-{uuid4().hex[:8]}"
    call_id = _start_call(room)
    future_dt = datetime.now(UTC) + timedelta(days=10)
    future_dt = future_dt.replace(hour=14, minute=0, second=0, microsecond=0)

    with new_session() as session:
        ticket = create_confirmation_ticket(
            session,
            call_id=call_id,
            service="AC repair",
            phone="5558901234",
            scheduled_for=future_dt,
            fingerprint="fplimit",
            ttl_seconds=300,
        )
        ticket_id = ticket.ticket_id

    headers = {"X-Forwarded-For": "198.51.100.99"}
    payload = {
        "call_id": call_id,
        "call_secret": _CALL_SECRET,
        "ticket_id": ticket_id,
        "fingerprint": "fplimit",
    }

    # 1st request succeeds
    res1 = client.post("/v1/calls/confirm-booking", json=payload, headers=headers)
    assert res1.status_code == 200

    # 2nd through 5th return 200 (already_confirmed)
    for _ in range(4):
        res = client.post("/v1/calls/confirm-booking", json=payload, headers=headers)
        assert res.status_code == 200

    # 6th request is rate limited
    res6 = client.post("/v1/calls/confirm-booking", json=payload, headers=headers)
    assert res6.status_code == 429
    assert "rate limit exceeded" in res6.text.lower()
    reset_rate_limits()

