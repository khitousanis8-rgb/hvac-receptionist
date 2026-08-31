"""Persist one CallRecord per agent session and derive its outcome."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from app.db import CallRecord, new_session


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
