"""Persist, authorize, and finalize one CallRecord for each call session."""

from __future__ import annotations

import hashlib
import hmac
import json
from datetime import UTC, datetime
from typing import Any

from app.db import CallRecord, new_session

_DEFAULT_SLOTS: dict[str, Any] = {
    "name": None,
    "phone": None,
    "service": None,
    "date": None,
    "time": None,
    "confirmed": False,
    "booking_result": None,
}


def _token_hash(access_token: str) -> str:
    return hashlib.sha256(access_token.encode("utf-8")).hexdigest()


def _decode_slots(raw_slots: str | None) -> dict[str, Any]:
    if not raw_slots:
        return dict(_DEFAULT_SLOTS)
    try:
        parsed = json.loads(raw_slots)
    except json.JSONDecodeError:
        return dict(_DEFAULT_SLOTS)
    if not isinstance(parsed, dict):
        return dict(_DEFAULT_SLOTS)
    return {**_DEFAULT_SLOTS, **parsed}


def _encode_slots(slots: dict[str, Any]) -> str:
    return json.dumps(slots, separators=(",", ":"), ensure_ascii=False)


def start_call(room_name: str) -> int:
    """Create a server-managed call record for the authenticated LiveKit worker."""
    with new_session() as session:
        record = CallRecord(room_name=room_name, session_slots=_encode_slots(_DEFAULT_SLOTS))
        session.add(record)
        session.flush()
        return int(record.id)


def start_or_get_browser_call(room_name: str, access_token: str) -> int:
    """Idempotently create a browser call bound to an unguessable access token."""
    token_hash = _token_hash(access_token)
    with new_session() as session:
        existing = (
            session.query(CallRecord)
            .filter(
                CallRecord.room_name == room_name,
                CallRecord.access_token_hash == token_hash,
                CallRecord.ended_at.is_(None),
            )
            .order_by(CallRecord.id.desc())
            .first()
        )
        if existing is not None:
            return int(existing.id)

        record = CallRecord(
            room_name=room_name,
            access_token_hash=token_hash,
            session_slots=_encode_slots(_DEFAULT_SLOTS),
        )
        session.add(record)
        session.flush()
        return int(record.id)


def is_authorized_active_call(call_id: int, room_name: str, access_token: str) -> bool:
    """Return whether the browser owns this still-active call record."""
    token_hash = _token_hash(access_token)
    with new_session() as session:
        record = session.get(CallRecord, call_id)
        return bool(
            record
            and record.ended_at is None
            and record.room_name == room_name
            and record.access_token_hash
            and hmac.compare_digest(record.access_token_hash, token_hash)
        )


def get_call_slots(call_id: int) -> dict[str, Any]:
    """Load the durable structured caller details for one active call."""
    with new_session() as session:
        record = session.get(CallRecord, call_id)
        if record is None or record.ended_at is not None:
            raise LookupError("Call record is not active")
        return _decode_slots(record.session_slots)


def update_call_slots(call_id: int, updates: dict[str, Any]) -> dict[str, Any]:
    """Atomically update non-empty slots and return the current slot set."""
    with new_session() as session:
        record = session.get(CallRecord, call_id)
        if record is None or record.ended_at is not None:
            raise LookupError("Call record is not active")
        slots = _decode_slots(record.session_slots)
        for key, value in updates.items():
            if value is None:
                slots[key] = None
            elif str(value).strip():
                slots[key] = value
        record.session_slots = _encode_slots(slots)
        return slots


def update_call_phone(call_id: int, phone: str) -> None:
    """Set the phone number for the exact active call record, once."""
    with new_session() as session:
        record = session.get(CallRecord, call_id)
        if record and record.ended_at is None and not record.caller_phone:
            record.caller_phone = str(phone).strip()[:32]


def update_call_outcome(call_id: int, outcome: str) -> None:
    """Update the exact active record without downgrading a confirmed booking."""
    with new_session() as session:
        record = session.get(CallRecord, call_id)
        if (
            record
            and record.ended_at is None
            and (record.outcome != "booked" or outcome == "booked")
        ):
            record.outcome = outcome


def end_call(call_id: int, outcome: str, transcript_summary: str | None = None) -> bool:
    """Finalize one record once. Return False for an unknown or closed record."""
    with new_session() as session:
        record = session.get(CallRecord, call_id)
        if record is None or record.ended_at is not None:
            return False
        if record.outcome != "booked" or outcome == "booked":
            record.outcome = outcome
        record.transcript_summary = transcript_summary
        record.ended_at = datetime.now(UTC)
        record.session_slots = None
        return True


def end_browser_call(
    call_id: int,
    room_name: str,
    access_token: str,
    outcome: str,
    transcript_summary: str | None = None,
) -> bool:
    """Finalize a browser call only when its owner presents the matching secret."""
    token_hash = _token_hash(access_token)
    with new_session() as session:
        record = session.get(CallRecord, call_id)
        if (
            record is None
            or record.ended_at is not None
            or record.room_name != room_name
            or not record.access_token_hash
            or not hmac.compare_digest(record.access_token_hash, token_hash)
        ):
            return False
        if record.outcome != "booked" or outcome == "booked":
            record.outcome = outcome
        record.transcript_summary = transcript_summary
        record.ended_at = datetime.now(UTC)
        record.session_slots = None
        return True


def _item_role(item: Any) -> str:
    role = getattr(item, "role", "")
    return str(getattr(role, "value", role)).lower()


def _item_text(item: Any) -> str:
    content = getattr(item, "content", None) or []
    return " ".join(str(part) for part in content).strip()


def summarize_session(history_items: list[Any]) -> tuple[str, str | None]:
    """Derive (outcome, transcript summary) from a session's chat history."""
    outcome = "info_only"
    user_lines: list[str] = []
    for item in history_items:
        name = getattr(item, "name", None)
        if name == "book_appointment_tool":
            outcome = "booked"
            continue
        if _item_role(item) == "user":
            item_text = _item_text(item)
            if item_text:
                user_lines.append(item_text)
    summary = " | ".join(user_lines)[:2000] or None
    return outcome, summary
