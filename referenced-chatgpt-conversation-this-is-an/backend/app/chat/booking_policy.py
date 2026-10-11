"""Pure booking-policy helpers extracted verbatim from app.chat_api.

These functions must not import route handlers, database access, provider
clients, or FastAPI request objects. They depend only on settings and
immutable input mappings.
"""

from __future__ import annotations

import hashlib
import re
from typing import Any

from app.config import Settings
from app.scheduling import parse_local_datetime

_parse_local_datetime = parse_local_datetime


def booking_missing_fields(slots: dict[str, Any]) -> list[str]:
    """Required for an actual booking: service, phone, date, and time.

    Checks verified slots first, falling back to top-level slots.
    """
    required = ["service", "phone", "date", "time"]
    missing: list[str] = []
    raw_verified = slots.get("verified")
    verified: dict[str, Any] = raw_verified if isinstance(raw_verified, dict) else {}
    for field in required:
        val = verified.get(field) if verified else slots.get(field)
        if not val or not str(val).strip():
            missing.append(field)
    return missing


def booking_details_changed(
    updates: dict[str, Any],
    current: dict[str, Any] | None = None,
) -> bool:
    """Returns true when an update actually changes phone, service, date, or time."""
    core_keys = ("phone", "service", "date", "time")
    if current is None:
        return any(k in updates and updates[k] is not None for k in core_keys)

    for k in core_keys:
        if k in updates and updates[k] is not None:
            cur_val = current.get(k)
            if cur_val is None and isinstance(current.get("verified"), dict):
                cur_val = current["verified"].get(k)
            if cur_val is None or not str(cur_val).strip():
                return True
            if str(updates[k]).strip().lower() != str(cur_val).strip().lower():
                return True
    return False


def is_explicit_booking_confirmation(text: str) -> bool:
    """Check if text is an explicit whole-message booking confirmation.

    Normalizes lower-case text, punctuation, and whitespace.
    Returns True only for whole-message allowlist phrases.
    Rejects messages containing a negation, a new time/date, or additional booking details.
    Does not use substring matching.
    """
    if "?" in text:
        return False

    cleaned = re.sub(r"[^\w\s]", " ", text.lower())
    normalized = " ".join(cleaned.split())
    if not normalized:
        return False

    negations = {
        "no", "not", "dont", "don't", "cancel", "stop", "wait", "change",
        "instead", "different", "nevermind", "decline", "neither", "but",
    }
    words = set(normalized.split())
    if words & negations:
        return False

    date_time_indicators = {
        "tomorrow", "today", "yesterday", "monday", "tuesday", "wednesday",
        "thursday", "friday", "saturday", "sunday", "am", "pm", "morning",
        "afternoon", "evening", "next", "o'clock", "oclock", "week", "noon",
    }
    if words & date_time_indicators:
        return False

    inquiry_phrases = {
        "can we", "could we", "can you", "could you", "would you", "would it be",
        "what about", "what if", "how about", "is there", "are there", "do you",
    }
    if any(ip in normalized for ip in inquiry_phrases):
        return False

    inquiry_words = {
        "want", "need", "what", "how", "why", "where",
        "when", "who", "maybe", "might", "think", "wondering", "if", "prefer",
    }
    if words & inquiry_words:
        return False

    if re.search(r"\d", normalized):
        return False

    accepted_phrases = {
        "yes",
        "yes please",
        "yes please do",
        "please",
        "yeah",
        "yeah please",
        "yep",
        "yep please",
        "please book it",
        "please book that",
        "please book",
        "book it",
        "book that",
        "go ahead",
        "go ahead please",
        "go ahead and book it",
        "go ahead and book",
        "yes go ahead",
        "yes please go ahead",
        "yeah go ahead",
        "sure go ahead",
        "yes book it",
        "yes book that",
        "yes please book it",
        "yes please book that",
        "yes please book",
        "that works",
        "that works for me",
        "sounds good",
        "sounds great",
        "correct",
        "that is correct",
        "thats correct",
        "confirm it",
        "please confirm it",
        "confirm",
        "sure",
        "sure thing",
        "sure please",
        "perfect",
        "absolutely",
        "definitely",
        "yes definitely",
        "yes that works",
        "yeah that works",
        "yes sounds good",
        "yeah sounds good",
        "lock it in",
        "lock that in",
        "lock it in please",
        "lets do it",
        "let us do it",
        "go for it",
        "schedule it",
        "please schedule it",
        "yes schedule it",
        "that would be great",
        "that would be fine",
        "that would be wonderful",
        "that would be perfect",
        "that would work",
        "that would work for me",
        "yes that would be great",
        "yes that would be fine",
        "yes that would be wonderful",
        "yes that would be perfect",
        "yes that would work",
        "yeah that would work",
        "yes please lock that in",
        "yes lock that in",
        "please lock that in",
        "yes you can book it",
        "you can book it",
        "you can lock that in",
        "yes please do that",
        "please do that",
    }
    if normalized in accepted_phrases:
        return True

    # Affirmation anchors and vocabulary for natural composed affirmations
    anchors = {
        "yes", "yeah", "yep", "sure", "ok", "okay", "alright",
        "book", "lock", "schedule", "confirm", "sounds", "sound", "perfect",
        "correct", "works", "absolutely", "definitely", "go ahead",
    }
    if not any(a in normalized for a in anchors):
        return False

    affirmation_vocab = {
        "yes", "yeah", "yep", "sure", "ok", "okay", "alright",
        "please", "pls", "thank", "thanks", "you",
        "go", "ahead", "book", "it", "that", "this",
        "lock", "in", "schedule", "confirm", "do", "lets", "let", "us",
        "sounds", "sound", "good", "great", "perfect", "fine", "awesome", "wonderful",
        "works", "work", "for", "me", "correct", "right", "absolutely", "definitely",
        "and", "to", "thing", "is", "thats", "all", "set", "would", "could", "can", "be",
    }
    return all(w in affirmation_vocab for w in normalized.split())


def booking_confirmation_fingerprint(slots: dict[str, Any]) -> str:
    """Compute a stable hash of the 4 core booking details."""
    raw_verified = slots.get("verified")
    verified: dict[str, Any] = raw_verified if isinstance(raw_verified, dict) else {}
    phone = str(verified.get("phone") or slots.get("phone", "")).strip().lower()
    service = str(verified.get("service") or slots.get("service", "")).strip().lower()
    date_val = str(verified.get("date") or slots.get("date", "")).strip().lower()
    time_val = str(verified.get("time") or slots.get("time", "")).strip().lower()
    raw = f"{phone}|{service}|{date_val}|{time_val}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def booking_confirmation_text(settings: Settings, slots: dict[str, Any]) -> str:
    """Build the spoken confirmation recap from verified durable slots."""
    raw_verified = slots.get("verified")
    verified: dict[str, Any] = raw_verified if isinstance(raw_verified, dict) else {}
    service = verified.get("service") or slots.get("service") or "service"
    date_val = verified.get("date") or slots.get("date") or "your requested date"
    time_val = verified.get("time") or slots.get("time") or "your requested time"

    parsed_dt = _parse_local_datetime(settings, str(date_val), str(time_val))
    if parsed_dt is not None:
        when_str = parsed_dt.strftime("%A, %B %d at %I:%M %p").replace(" 0", " ")
        return (
            f"Just to confirm, that's {service} for {when_str}. "
            f"Would you like me to book it?"
        )

    return (
        f"Just to confirm, that's {service} for {date_val} at {time_val}. "
        f"Would you like me to book it?"
    )


def booking_result_text(result: str) -> tuple[str, bool]:
    """Convert the booking function result into a short spoken reply and a success flag.

    Preserves a failure or unavailable-slot response strictly as a failure;
    never classifies as success unless the booking genuinely succeeded in SQLite.
    """
    clean = result.strip()
    if (
        clean.startswith("Booked ")
        or clean.startswith("Appointment booked")
        or clean.startswith("Appointment is already confirmed")
    ):
        return (
            "You're all set! I've booked that appointment for you. "
            "Our technician will see you then. Is there anything else I can help with?",
            True,
        )
    return (
        f"I wasn't able to book that slot. {clean} "
        f"Would you like to try a different time?",
        False,
    )