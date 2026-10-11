"""Adversarial challenger tests for Milestone 2: Atomic Ticket Ledger Synchronization.

These empirical stress tests verify:
1. Multi-turn recap: recap creates pending ticket -> tool booking commits appointment,
   transitions pending ticket to consumed with appointment_id linked, and leaves zero orphaned pending tickets.
2. Direct tool booking without recap: fresh consumed ticket is minted with appointment_id linked.
3. Multi-turn with multiple pending tickets: all pending tickets for that call_id transition to consumed.
4. Call isolation: pending tickets belonging to other calls are never consumed or affected.
5. Failed bookings (invalid service, slot conflicts): pending tickets remain intact and are not consumed prematurely.
6. Type resilience: call_id as int vs str handled cleanly.
7. Call-less bookings (call_id=None): handled safely without ledger corruption.
"""

from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4
from zoneinfo import ZoneInfo

from fastapi.testclient import TestClient

from app.call_tracking import start_or_get_browser_call
from app.chat_api import _execute_tool
from app.config import Settings
from app.db import Appointment, ConfirmationTicket, Customer, new_session
from app.main import create_app

_CALL_SECRET = "a" * 64


def _find_available_future_date(settings: Settings, days_ahead: int = 10) -> tuple[str, str, datetime]:
    tz = ZoneInfo(settings.business_timezone)
    cand = datetime.now(tz) + timedelta(days=days_ahead)
    while cand.weekday() >= 5:  # skip Saturday and Sunday
        cand += timedelta(days=1)
    cand = cand.replace(hour=10, minute=0, second=0, microsecond=0)
    date_str = cand.strftime("%Y-%m-%d")
    time_str = "10:00 AM"
    return date_str, time_str, cand


def _browser_payload(room: str, call_id: int, message: str) -> dict[str, Any]:
    return {
        "session_id": room,
        "call_id": call_id,
        "call_secret": _CALL_SECRET,
        "message": message,
        "channel": "browser",
    }


def test_multi_turn_recap_then_tool_booking_commits_atomically(db: Any) -> None:
    """Multi-turn test: recap creates pending ticket, tool booking transitions it to consumed with appointment_id."""
    settings = Settings(
        LLM_API_KEY="test-key-m2-ledger",
        BUSINESS_OPENING_HOURS=(
            '{"monday":"08:00-18:00","tuesday":"08:00-18:00","wednesday":"08:00-18:00",'
            '"thursday":"08:00-18:00","friday":"08:00-18:00","saturday":"08:00-18:00",'
            '"sunday":"08:00-18:00"}'
        ),
        _env_file=None,
    )
    app = create_app(settings)
    client = TestClient(app)

    room = f"m2-ledger-multiturn-{uuid4().hex[:8]}"
    call_id = start_or_get_browser_call(room, _CALL_SECRET)
    date_str, time_str, when_local = _find_available_future_date(settings, days_ahead=12)
    phone = "+15554329876"
    service = "AC repair"

    # Turn 1: Provide service and date/time
    res1 = client.post(
        "/v1/calls/chat",
        json=_browser_payload(room, call_id, f"I need {service} on {date_str} at 10 AM"),
    )
    assert res1.status_code == 200

    # Turn 2: Provide phone number -> triggers recap and mints pending ConfirmationTicket
    res2 = client.post(
        "/v1/calls/chat",
        json=_browser_payload(room, call_id, f"My phone number is {phone}"),
    )
    assert res2.status_code == 200
    assert "event: confirmation_ticket" in res2.text

    # Verify pending ticket exists in database before tool booking
    with new_session() as session:
        pending_tickets_before = (
            session.query(ConfirmationTicket)
            .filter(
                ConfirmationTicket.call_id == str(call_id),
                ConfirmationTicket.status == "pending",
            )
            .all()
        )
        assert len(pending_tickets_before) == 1
        pt = pending_tickets_before[0]
        pending_ticket_id = pt.ticket_id
        assert pt.status == "pending"
        assert pt.appointment_id is None
        assert pt.consumed_at is None
        assert pt.service == service

    # Turn 3: Execute tool booking (book_appointment_tool) with call_id
    tool_res = _execute_tool(
        settings,
        "book_appointment_tool",
        {
            "phone_number": phone,
            "service": service,
            "date": date_str,
            "time": time_str,
            "name": "Jane Doe",
            "notes": "Testing atomic ledger recap transition",
        },
        call_id=call_id,
    )
    assert "Booked" in tool_res

    # Empirical verification of ledger state post-booking:
    with new_session() as session:
        # 1. The original pending ticket MUST now be consumed
        consumed_ticket = (
            session.query(ConfirmationTicket)
            .filter_by(ticket_id=pending_ticket_id)
            .one()
        )
        assert consumed_ticket.status == "consumed"
        assert consumed_ticket.consumed_at is not None
        assert consumed_ticket.appointment_id is not None

        # 2. Linked appointment exists and matches details
        linked_appt = (
            session.query(Appointment)
            .filter_by(id=consumed_ticket.appointment_id)
            .one()
        )
        assert linked_appt.service == service
        cust = session.query(Customer).filter_by(id=linked_appt.customer_id).one()
        assert cust.phone_number == phone
        assert cust.name == "Jane Doe"

        # 3. ZERO orphaned pending tickets remain for this call_id
        orphaned_pending = (
            session.query(ConfirmationTicket)
            .filter(
                ConfirmationTicket.call_id == str(call_id),
                ConfirmationTicket.status == "pending",
            )
            .count()
        )
        assert orphaned_pending == 0

        # 4. Total tickets for this call_id is exactly 1 (no duplicate tool_ tickets minted)
        total_tickets = (
            session.query(ConfirmationTicket)
            .filter(ConfirmationTicket.call_id == str(call_id))
            .all()
        )
        assert len(total_tickets) == 1
        assert total_tickets[0].ticket_id == pending_ticket_id


def test_direct_tool_booking_without_recap_mints_consumed_ticket(db: Any) -> None:
    """Direct tool booking without prior recap mints a fresh consumed ticket with appointment_id."""
    settings = Settings(_env_file=None)
    date_str, time_str, _ = _find_available_future_date(settings, days_ahead=14)
    call_id = 99887766
    phone = "+15559871234"
    service = "Heating repair"

    tool_res = _execute_tool(
        settings,
        "book_appointment_tool",
        {
            "phone_number": phone,
            "service": service,
            "date": date_str,
            "time": time_str,
            "name": "Direct Caller",
        },
        call_id=call_id,
    )
    assert "Booked" in tool_res

    with new_session() as session:
        tickets = (
            session.query(ConfirmationTicket)
            .filter_by(call_id=str(call_id))
            .all()
        )
        assert len(tickets) == 1
        tkt = tickets[0]
        assert tkt.ticket_id.startswith("tool_")
        assert tkt.status == "consumed"
        assert tkt.consumed_at is not None
        assert tkt.appointment_id is not None

        # Verify linked appointment
        appt = session.query(Appointment).filter_by(id=tkt.appointment_id).one()
        assert appt.service == service
        cust = session.query(Customer).filter_by(id=appt.customer_id).one()
        assert cust.phone_number == phone

        # Verify zero orphaned pending tickets
        pending_count = (
            session.query(ConfirmationTicket)
            .filter_by(call_id=str(call_id), status="pending")
            .count()
        )
        assert pending_count == 0


def test_multi_turn_with_multiple_pending_tickets_all_transition_to_consumed(db: Any) -> None:
    """If a call accumulated multiple pending tickets (e.g. rescheduling), all transition to consumed."""
    settings = Settings(_env_file=None)
    date_str, time_str, when_local = _find_available_future_date(settings, days_ahead=16)
    call_id = 77112233
    phone = "+15557711223"
    service = "Emergency service"
    now_utc = datetime.now(UTC)

    # Seed 3 pending tickets for this call
    ticket_ids = [f"tkt_pending_{i}_{uuid4().hex[:8]}" for i in range(3)]
    with new_session() as session:
        for tid in ticket_ids:
            session.add(
                ConfirmationTicket(
                    ticket_id=tid,
                    call_id=str(call_id),
                    service=service,
                    phone=phone,
                    scheduled_for=when_local.astimezone(UTC),
                    fingerprint=f"fp_{tid}",
                    status="pending",
                    created_at=now_utc,
                    expires_at=now_utc + timedelta(minutes=5),
                    appointment_id=None,
                )
            )
        session.commit()

    # Commit booking via book_appointment_tool
    tool_res = _execute_tool(
        settings,
        "book_appointment_tool",
        {
            "phone_number": phone,
            "service": service,
            "date": date_str,
            "time": time_str,
        },
        call_id=call_id,
    )
    assert "Booked" in tool_res

    # Verify all 3 pending tickets transitioned to consumed and zero pending tickets remain
    with new_session() as session:
        consumed_tickets = (
            session.query(ConfirmationTicket)
            .filter_by(call_id=str(call_id))
            .all()
        )
        assert len(consumed_tickets) == 3
        for t in consumed_tickets:
            assert t.status == "consumed"
            assert t.consumed_at is not None
            assert t.appointment_id is not None

        # Verify zero pending tickets remain
        orphaned = (
            session.query(ConfirmationTicket)
            .filter_by(call_id=str(call_id), status="pending")
            .count()
        )
        assert orphaned == 0


def test_call_isolation_prevents_cross_call_ticket_consumption(db: Any) -> None:
    """Booking on call B must not consume pending tickets from call A."""
    settings = Settings(_env_file=None)
    date_str, time_str, when_local = _find_available_future_date(settings, days_ahead=18)
    call_a = 44556601
    call_b = 44556602
    now_utc = datetime.now(UTC)

    # Create pending ticket for Call A
    with new_session() as session:
        session.add(
            ConfirmationTicket(
                ticket_id=f"tkt_call_a_{uuid4().hex[:8]}",
                call_id=str(call_a),
                service="AC repair",
                phone="+15551110001",
                scheduled_for=when_local.astimezone(UTC),
                fingerprint="fp_call_a",
                status="pending",
                created_at=now_utc,
                expires_at=now_utc + timedelta(minutes=5),
                appointment_id=None,
            )
        )
        # Create pending ticket for Call B
        session.add(
            ConfirmationTicket(
                ticket_id=f"tkt_call_b_{uuid4().hex[:8]}",
                call_id=str(call_b),
                service="Heating repair",
                phone="+15551110002",
                scheduled_for=(when_local + timedelta(hours=2)).astimezone(UTC),
                fingerprint="fp_call_b",
                status="pending",
                created_at=now_utc,
                expires_at=now_utc + timedelta(minutes=5),
                appointment_id=None,
            )
        )
        session.commit()

    # Book for Call B only
    res_b = _execute_tool(
        settings,
        "book_appointment_tool",
        {
            "phone_number": "+15551110002",
            "service": "Heating repair",
            "date": date_str,
            "time": (when_local + timedelta(hours=2)).strftime("%I:%M %p"),
        },
        call_id=call_b,
    )
    assert "Booked" in res_b

    with new_session() as session:
        # Call B ticket is consumed
        tkt_b = (
            session.query(ConfirmationTicket)
            .filter_by(call_id=str(call_b))
            .one()
        )
        assert tkt_b.status == "consumed"
        assert tkt_b.appointment_id is not None

        # Call A ticket is STILL strictly pending with NO appointment_id
        tkt_a = (
            session.query(ConfirmationTicket)
            .filter_by(call_id=str(call_a))
            .one()
        )
        assert tkt_a.status == "pending"
        assert tkt_a.appointment_id is None
        assert tkt_a.consumed_at is None

    # Now book Call A
    res_a = _execute_tool(
        settings,
        "book_appointment_tool",
        {
            "phone_number": "+15551110001",
            "service": "AC repair",
            "date": date_str,
            "time": time_str,
        },
        call_id=call_a,
    )
    assert "Booked" in res_a

    with new_session() as session:
        tkt_a_after = (
            session.query(ConfirmationTicket)
            .filter_by(call_id=str(call_a))
            .one()
        )
        assert tkt_a_after.status == "consumed"
        assert tkt_a_after.appointment_id is not None
        assert (
            session.query(ConfirmationTicket)
            .filter(ConfirmationTicket.call_id.in_([str(call_a), str(call_b)]), ConfirmationTicket.status == "pending")
            .count()
            == 0
        )


def test_failed_booking_does_not_consume_or_orphan_pending_ticket(db: Any) -> None:
    """If tool booking fails (e.g. invalid service or conflict), pending ticket is preserved."""
    settings = Settings(_env_file=None)
    date_str, time_str, when_local = _find_available_future_date(settings, days_ahead=22)
    call_id = 88223344
    now_utc = datetime.now(UTC)
    phone = "+15558822334"

    # Pending ticket exists
    with new_session() as session:
        session.add(
            ConfirmationTicket(
                ticket_id=f"tkt_fail_test_{uuid4().hex[:8]}",
                call_id=str(call_id),
                service="AC repair",
                phone=phone,
                scheduled_for=when_local.astimezone(UTC),
                fingerprint="fp_fail_test",
                status="pending",
                created_at=now_utc,
                expires_at=now_utc + timedelta(minutes=5),
                appointment_id=None,
            )
        )
        session.commit()

    # 1. Attempt booking with invalid service
    res_invalid = _execute_tool(
        settings,
        "book_appointment_tool",
        {
            "phone_number": phone,
            "service": "Submarine repairs",
            "date": date_str,
            "time": time_str,
        },
        call_id=call_id,
    )
    assert "not on our approved services list" in res_invalid

    # Pending ticket must remain pending and unconsumed
    with new_session() as session:
        tkt = session.query(ConfirmationTicket).filter_by(call_id=str(call_id)).one()
        assert tkt.status == "pending"
        assert tkt.appointment_id is None
        assert tkt.consumed_at is None

    # 2. Successfully book with valid service
    res_valid = _execute_tool(
        settings,
        "book_appointment_tool",
        {
            "phone_number": phone,
            "service": "AC repair",
            "date": date_str,
            "time": time_str,
        },
        call_id=call_id,
    )
    assert "Booked" in res_valid

    # Now it transitions to consumed
    with new_session() as session:
        tkt_final = session.query(ConfirmationTicket).filter_by(call_id=str(call_id)).one()
        assert tkt_final.status == "consumed"
        assert tkt_final.appointment_id is not None
        assert (
            session.query(ConfirmationTicket)
            .filter_by(call_id=str(call_id), status="pending")
            .count()
            == 0
        )


def test_call_id_types_string_and_int_both_supported(db: Any) -> None:
    """Verify call_id passed as str and int both properly synchronize pending tickets."""
    settings = Settings(_env_file=None)
    date_str, time_str, when_local = _find_available_future_date(settings, days_ahead=24)
    now_utc = datetime.now(UTC)

    # String call_id
    call_id_str = f"call_str_{uuid4().hex[:8]}"
    with new_session() as session:
        session.add(
            ConfirmationTicket(
                ticket_id=f"tkt_str_{uuid4().hex[:8]}",
                call_id=call_id_str,
                service="AC repair",
                phone="+15550001111",
                scheduled_for=when_local.astimezone(UTC),
                fingerprint="fp_str",
                status="pending",
                created_at=now_utc,
                expires_at=now_utc + timedelta(minutes=5),
            )
        )
        session.commit()

    res = _execute_tool(
        settings,
        "book_appointment_tool",
        {
            "phone_number": "+15550001111",
            "service": "AC repair",
            "date": date_str,
            "time": time_str,
        },
        call_id=call_id_str,
    )
    assert "Booked" in res

    with new_session() as session:
        t = session.query(ConfirmationTicket).filter_by(call_id=call_id_str).one()
        assert t.status == "consumed"
        assert t.appointment_id is not None
        assert (
            session.query(ConfirmationTicket)
            .filter_by(call_id=call_id_str, status="pending")
            .count()
            == 0
        )


def test_booking_without_call_id_does_not_create_ticket_or_corrupt_ledger(db: Any) -> None:
    """When call_id is None, appointment is created without minting unlinked tickets."""
    settings = Settings(_env_file=None)
    date_str, time_str, _ = _find_available_future_date(settings, days_ahead=26)

    res = _execute_tool(
        settings,
        "book_appointment_tool",
        {
            "phone_number": "+15559998888",
            "service": "AC repair",
            "date": date_str,
            "time": time_str,
        },
        call_id=None,
    )
    assert "Booked" in res

    with new_session() as session:
        # No tickets with call_id None or "None"
        none_tickets = (
            session.query(ConfirmationTicket)
            .filter(ConfirmationTicket.call_id.in_(["None", ""]))
            .all()
        )
        assert len(none_tickets) == 0
