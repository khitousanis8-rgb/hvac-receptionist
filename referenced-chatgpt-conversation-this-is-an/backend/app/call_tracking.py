"""Persist one CallRecord per agent session and derive its outcome."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from app.db import CallRecord, new_session


_session_slots: dict[str, dict[str, Any]] = {}


def get_or_create_session_slots(session_id: str) -> dict[str, Any]:
    """Return active session slots, initializing if needed."""
    if session_id not in _session_slots:
        _session_slots[session_id] = {
            "name": None,
            "phone": None,
            "service": None,
            "date": None,
            "time": None,
            "confirmed": False,
            "booking_result": None,
        }
    return _session_slots[session_id]


def update_session_slots(session_id: str, updates: dict[str, Any]) -> dict[str, Any]:
    """Update session slots and sync caller phone to CallRecord."""
    slots = get_or_create_session_slots(session_id)
    for k, v in updates.items():
        if v is not None and str(v).strip():
            slots[k] = v

    phone = slots.get("phone")
    if phone:
        update_call_phone(session_id, phone)

    return slots


def update_call_phone(room_name: str, phone: str) -> None:
    """Update caller_phone on the active CallRecord for this session, creating one if not present."""
    with new_session() as session:
        record = (
            session.query(CallRecord)
            .filter(CallRecord.room_name == room_name)
            .order_by(CallRecord.id.desc())
            .first()
        )
        if not record:
            record = CallRecord(room_name=room_name, caller_phone=str(phone).strip()[:32])
            session.add(record)
            session.flush()
        elif not record.caller_phone:
            record.caller_phone = str(phone).strip()[:32]


def update_call_outcome(room_name: str, outcome: str) -> None:
    """Update outcome on the active CallRecord for this session."""
    with new_session() as session:
        record = (
            session.query(CallRecord)
            .filter(CallRecord.room_name == room_name)
            .order_by(CallRecord.id.desc())
            .first()
        )
        if record:
            record.outcome = outcome


def start_call(room_name: str) -> int:
    """Create an in-progress CallRecord and return its id."""
    with new_session() as session:
        record = CallRecord(room_name=room_name)
        session.add(record)
        session.flush()
        return int(record.id)


def end_call(call_id: int, outcome: str, transcript_summary: str | None = None) -> None:
    """Finalize a CallRecord with its outcome and transcript summary."""
    with new_session() as session:
        record = session.get(CallRecord, call_id)
        if record is None:
            return
        record.outcome = outcome
        record.transcript_summary = transcript_summary
        record.ended_at = datetime.now(UTC)


def _item_role(item: Any) -> str:
    role = getattr(item, "role", "")
    return str(getattr(role, "value", role)).lower()


def _item_text(item: Any) -> str:
    content = getattr(item, "content", None) or []
    return " ".join(str(part) for part in content).strip()


def summarize_session(history_items: list[Any]) -> tuple[str, str | None]:
    """Derive (outcome, transcript summary) from a session's chat history.

    Outcome is "booked" when the booking tool was invoked, "info_only" otherwise.
    """
    outcome = "info_only"
    user_lines: list[str] = []
    for item in history_items:
        name = getattr(item, "name", None)
        if name == "book_appointment_tool":
            outcome = "booked"
            continue
        role = _item_role(item)
        if role == "user":
            text = _item_text(item)
            if text:
                user_lines.append(text)
    summary = " | ".join(user_lines)[:2000] or None
    return outcome, summary
