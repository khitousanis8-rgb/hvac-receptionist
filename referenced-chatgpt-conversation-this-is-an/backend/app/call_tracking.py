"""Persist, authorize, and finalize one CallRecord for each call session."""

from __future__ import annotations

import hashlib
import hmac
import json
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

import structlog
from pydantic import AliasChoices, BaseModel, ConfigDict, Field

from app.db import CallRecord, new_session
from app.scheduling import normalize_nanp_phone

PlatformClass = Literal["desktop", "mobile"]
BrowserEngine = Literal["chromium", "webkit", "gecko", "unknown"]
InputPath = Literal["native_web_speech", "media_recorder_transcription"]
MicPermission = Literal["granted", "denied", "dismissed", "unknown"]


class ClientTelemetry(BaseModel):
    """Derived, privacy-safe telemetry captured on the client side.

    Strictly forbids raw User-Agent headers, IP addresses, audio streams, or PII.
    Unexpected/extraneous fields are automatically dropped via extra="ignore".
    """

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    platform_class: PlatformClass | None = None
    browser_engine: BrowserEngine | None = None
    input_path: InputPath | None = None
    mic_permission: MicPermission | None = None
    first_assistant_audio_ms: int | float | None = Field(
        default=None,
        ge=0.0,
        validation_alias=AliasChoices(
            "first_assistant_audio_ms", "first_assistant_audio_ts"
        ),
    )
    first_caller_transcript_ms: int | float | None = Field(
        default=None,
        ge=0.0,
        validation_alias=AliasChoices(
            "first_caller_transcript_ms", "first_caller_transcript_ts"
        ),
    )
    echo_suppressions: int = Field(
        default=0,
        ge=0,
        validation_alias=AliasChoices(
            "echo_suppressions", "echo_suppression_count"
        ),
    )
    stt_errors: int = Field(
        default=0,
        ge=0,
        validation_alias=AliasChoices("stt_errors", "stt_error_count"),
    )
    tts_errors: int = Field(
        default=0,
        ge=0,
        validation_alias=AliasChoices("tts_errors", "tts_error_count"),
    )
    end_reason: str | None = Field(
        default=None,
        max_length=40,
        pattern=r"^[a-zA-Z0-9_-]+$",
        description="Categorical reason code for call termination",
    )


def _merge_client_metrics(existing_json: str | None, telemetry: ClientTelemetry) -> str:
    """Merge new client telemetry into existing client_metrics JSON text."""
    current: dict[str, Any] = {}
    if existing_json:
        try:
            parsed = json.loads(existing_json)
            if isinstance(parsed, dict):
                current = parsed
        except Exception:
            current = {}

    if telemetry.first_assistant_audio_ms is not None:
        current["first_assistant_audio_ms"] = telemetry.first_assistant_audio_ms
    if telemetry.first_caller_transcript_ms is not None:
        current["first_caller_transcript_ms"] = telemetry.first_caller_transcript_ms

    for cnt in ("echo_suppressions", "stt_errors", "tts_errors"):
        val = getattr(telemetry, cnt, None)
        if val is not None and isinstance(val, int) and val > 0:
            current[cnt] = max(int(current.get(cnt, 0)), val)
        elif cnt not in current and val is not None:
            current[cnt] = val

    if telemetry.end_reason is not None:
        current["end_reason"] = telemetry.end_reason

    return json.dumps(current, separators=(",", ":"), ensure_ascii=False)


def _apply_telemetry_to_record(record: CallRecord, telemetry: ClientTelemetry | None) -> None:
    """Apply validated client telemetry fields to a CallRecord instance."""
    if telemetry is None:
        return
    if telemetry.platform_class is not None:
        record.platform_class = telemetry.platform_class
    if telemetry.browser_engine is not None:
        record.browser_engine = telemetry.browser_engine
    if telemetry.input_path is not None:
        record.input_path = telemetry.input_path
    if telemetry.mic_permission is not None:
        record.mic_permission = telemetry.mic_permission
    if telemetry.end_reason is not None:
        record.end_reason = telemetry.end_reason

    record.client_metrics = _merge_client_metrics(record.client_metrics, telemetry)


def apply_client_telemetry(call_id: int | str, telemetry: ClientTelemetry) -> bool:
    """Merge client telemetry into an existing active call record.

    Accepts either numeric call_id (int or string digit) or room_name string.
    Returns True if an active record was found and updated, False otherwise.
    """
    with new_session() as session:
        record: CallRecord | None = None
        if isinstance(call_id, int):
            record = session.get(CallRecord, call_id)
        elif isinstance(call_id, str):
            if call_id.isdigit():
                record = session.get(CallRecord, int(call_id))
            if record is None:
                record = (
                    session.query(CallRecord)
                    .filter(CallRecord.room_name == call_id, CallRecord.ended_at.is_(None))
                    .order_by(CallRecord.id.desc())
                    .first()
                )
        if record is None or record.ended_at is not None:
            return False
        _apply_telemetry_to_record(record, telemetry)
        return True

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


def start_or_get_browser_call(
    room_name: str,
    access_token: str,
    client_telemetry: ClientTelemetry | None = None,
) -> int:
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
            if client_telemetry is not None:
                _apply_telemetry_to_record(existing, client_telemetry)
            return int(existing.id)

        record = CallRecord(
            room_name=room_name,
            access_token_hash=token_hash,
            session_slots=_encode_slots(_DEFAULT_SLOTS),
        )
        session.add(record)
        if client_telemetry is not None:
            _apply_telemetry_to_record(record, client_telemetry)
        session.flush()
        return int(record.id)


def is_authorized_active_call(
    call_id: int | str,
    room_name: str | None = None,
    access_token: str | None = None,
) -> bool:
    """Return whether the browser owns this still-active call record.

    Can be called as:
      is_authorized_active_call(call_id, room_name, access_token)
      or
      is_authorized_active_call(call_id, access_token)
    """
    if access_token is None and room_name is not None:
        actual_token = room_name
        actual_room = None
    else:
        actual_token = access_token or ""
        actual_room = room_name

    token_hash = _token_hash(actual_token)
    cid = (
        call_id
        if isinstance(call_id, int)
        else (int(call_id) if isinstance(call_id, str) and call_id.isdigit() else None)
    )
    if cid is None:
        return False
    with new_session() as session:
        record = session.get(CallRecord, cid)
        if not record or record.ended_at is not None:
            return False
        if actual_room is not None and record.room_name != actual_room:
            return False
        return bool(
            record.access_token_hash
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
    """Set or update the phone number for the active call record (allows caller corrections)."""
    clean_phone = str(phone).strip()[:32]
    if not clean_phone:
        return
    nanp = normalize_nanp_phone(clean_phone)
    target_phone = nanp if nanp is not None else clean_phone
    with new_session() as session:
        record = session.get(CallRecord, call_id)
        if record and record.ended_at is None:
            record.caller_phone = target_phone


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


def end_call(
    call_id: int,
    outcome: str,
    transcript_summary: str | None = None,
    client_telemetry: ClientTelemetry | None = None,
) -> bool:
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
        if client_telemetry is not None:
            _apply_telemetry_to_record(record, client_telemetry)
        return True


def end_browser_call(
    call_id: int,
    room_name: str,
    access_token: str,
    outcome: str,
    transcript_summary: str | None = None,
    client_telemetry: ClientTelemetry | None = None,
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
        if client_telemetry is not None:
            _apply_telemetry_to_record(record, client_telemetry)
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


def reap_stale_calls(cutoff_minutes: int = 20, duration_minutes: int = 3) -> int:
    """Sweep and finalize abandoned call records older than cutoff_minutes.

    Parameters:
        cutoff_minutes: Inactivity threshold in minutes before an unended call
                        is considered abandoned (default: 20).
        duration_minutes: Assumed call duration added to started_at to compute
                          ended_at (default: 3).

    Returns:
        int: Total number of stale calls finalized during this sweep.
    """
    if cutoff_minutes <= 0 or duration_minutes <= 0:
        raise ValueError("cutoff_minutes and duration_minutes must be positive")

    logger = structlog.get_logger(__name__)
    cutoff_time = datetime.now(UTC) - timedelta(minutes=cutoff_minutes)

    try:
        with new_session() as session:
            stale_records = (
                session.query(CallRecord)
                .filter(
                    CallRecord.ended_at.is_(None),
                    CallRecord.started_at < cutoff_time,
                )
                .order_by(CallRecord.started_at.asc())
                .all()
            )
            if not stale_records:
                return 0

            for stale in stale_records:
                if stale.started_at:
                    stale.ended_at = stale.started_at + timedelta(minutes=duration_minutes)
                else:
                    stale.ended_at = datetime.now(UTC)

                if stale.outcome == "in_progress":
                    slots = _decode_slots(stale.session_slots)
                    is_confirmed = bool(
                        slots.get("confirmed") is True
                        or (
                            stale.session_slots
                            and '"confirmed": true' in stale.session_slots.lower()
                        )
                    )
                    stale.outcome = "booked" if is_confirmed else "info_only"

                if not stale.transcript_summary:
                    stale.transcript_summary = (
                        "Call completed (session automatically finalized by stale-call reaper)."
                    )

            session.commit()
            count = len(stale_records)

        logger.info(
            "stale_calls_reaped",
            count=count,
            cutoff_minutes=cutoff_minutes,
            duration_minutes=duration_minutes,
        )
        return count
    except Exception as exc:
        logger.error(
            "reap_stale_calls_failed",
            cutoff_minutes=cutoff_minutes,
            duration_minutes=duration_minutes,
            error=str(exc),
            exc_info=True,
        )
        raise

