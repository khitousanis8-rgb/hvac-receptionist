# pyright: reportCallIssue=false
"""Characterization tests for the two booking-authority paths (Workstream B).

Path 1 (tool call): the LLM invokes book_appointment_tool and the booking is
created directly inside _execute_tool.
Path 2 (ticket): the deterministic state machine mints a pending
ConfirmationTicket; _confirm_booking_sync consumes it and books.

These tests lock the current contract before any unification change.
"""

from __future__ import annotations

from datetime import UTC, datetime

from app.chat_api import _execute_tool
from app.config import Settings
from app.db import Appointment, ConfirmationTicket, new_session

_OPEN_ALL_WEEK = (
    '{"monday":"08:00-18:00","tuesday":"08:00-18:00","wednesday":"08:00-18:00",'
    '"thursday":"08:00-18:00","friday":"08:00-18:00","saturday":"08:00-18:00",'
    '"sunday":"08:00-18:00"}'
)


def _settings() -> Settings:
    return Settings(
        business_services="AC repair,Heating repair",
        business_timezone="America/New_York",
        business_opening_hours=_OPEN_ALL_WEEK,
        _env_file=None,
    )


def test_tool_path_books_directly_without_ticket() -> None:
    """Current contract: tool bookings create an appointment immediately."""
    message = _execute_tool(
        _settings(),
        "book_appointment_tool",
        {
            "phone_number": "+15555550701",
            "service": "AC repair",
            "date": "2030-06-10",
            "time": "10:00 AM",
            "name": "Tool Caller",
        },
    )
    assert message.startswith("Booked ")

    with new_session() as session:
        appointments = session.query(Appointment).all()
        assert len(appointments) == 1
        assert appointments[0].status == "booked"
        assert appointments[0].service == "AC repair"
        tickets = session.query(ConfirmationTicket).all()
        assert tickets == [], "Tool path must not mint tickets in the current contract"


def test_tool_path_records_provenance_ledger_when_call_id_present() -> None:
    """Additive provenance: with a call_id, the tool path also records an
    already-consumed ticket pointing at the same appointment."""
    from app.call_tracking import start_or_get_browser_call

    call_id = start_or_get_browser_call("authority-ledger-room", "s" * 40)
    message = _execute_tool(
        _settings(),
        "book_appointment_tool",
        {
            "phone_number": "+15555550704",
            "service": "Heating repair",
            "date": "2030-06-12",
            "time": "09:00 AM",
        },
        call_id,
    )
    assert message.startswith("Booked ")

    with new_session() as session:
        appointment = session.query(Appointment).one()
        ledger = (
            session.query(ConfirmationTicket)
            .filter(ConfirmationTicket.call_id == str(call_id))
            .one()
        )
        assert ledger.status == "consumed"
        assert ledger.appointment_id == appointment.id
        assert ledger.ticket_id.startswith("tool_")
        assert ledger.consumed_at is not None


def test_tool_path_rejects_unapproved_service() -> None:
    message = _execute_tool(
        _settings(),
        "book_appointment_tool",
        {
            "phone_number": "+15555550702",
            "service": "Pool cleaning",
            "date": "2030-06-10",
            "time": "10:00 AM",
        },
    )
    assert "not on our approved services list" in message

    with new_session() as session:
        assert session.query(Appointment).count() == 0


def test_ticket_path_books_via_confirmation_flow() -> None:
    """Current contract: ticket consumption creates the appointment and marks
    the ticket consumed."""
    from app.call_tracking import start_or_get_browser_call, update_call_slots
    from app.chat.schemas import ConfirmBookingRequest
    from app.chat_api import _confirm_booking_sync
    from app.db import create_confirmation_ticket

    settings = _settings()
    call_id = start_or_get_browser_call("authority-ticket-room", "s" * 40)
    update_call_slots(
        call_id,
        {
            "service": "AC repair",
            "phone": "+15555550703",
            "date": "2030-06-11",
            "time": "11:00 AM",
        },
    )
    fingerprint = "0123456789abcdef"  # 16-hex fingerprint slot value

    with new_session() as session:
        ticket = create_confirmation_ticket(
            session,
            call_id=call_id,
            service="AC repair",
            phone="+15555550703",
            scheduled_for=datetime(2030, 6, 11, 15, 0, tzinfo=UTC),
            fingerprint=fingerprint,
            ttl_seconds=300,
        )
        ticket_id = ticket.ticket_id

    request = ConfirmBookingRequest(
        call_id=call_id,
        call_secret="s" * 40,
        ticket_id=ticket_id,
        fingerprint=fingerprint,
    )
    response = _confirm_booking_sync(settings, request)
    assert response.status == "confirmed"

    with new_session() as session:
        consumed = (
            session.query(ConfirmationTicket)
            .filter(ConfirmationTicket.ticket_id == ticket_id)
            .one()
        )
        assert consumed.status == "consumed"
        assert consumed.appointment_id is not None
        appointment = session.get(Appointment, consumed.appointment_id)
        assert appointment is not None
        assert appointment.status == "booked"