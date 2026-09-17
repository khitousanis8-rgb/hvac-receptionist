"""Chat and voice streaming API router for in-browser client sessions."""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import threading
import time
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from zoneinfo import ZoneInfo

import structlog
from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from openai import AsyncOpenAI
from pydantic import BaseModel, Field, field_validator

from app.agent.prompts import receptionist_instructions
from app.call_tracking import (
    ClientTelemetry,
    apply_client_telemetry,
    end_browser_call,
    get_call_slots,
    is_authorized_active_call,
    start_or_get_browser_call,
    update_call_outcome,
    update_call_phone,
    update_call_slots,
)
from app.config import Settings, get_settings
from app.db import (
    CallRecord,
    ConfirmationTicket,
    create_confirmation_ticket,
    get_recent_call_turns,
    new_session,
    record_call_turn,
)
from app.scheduling import (
    book_appointment,
    has_conflict,
    is_within_business_hours,
    normalize_nanp_phone,
    parse_local_datetime,
)
from app.security import check_booking_rate_limit, check_chat_rate_limit, get_client_ip

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/v1/calls", tags=["calls"])

_client: AsyncOpenAI | None = None


def _get_client(settings: Settings) -> AsyncOpenAI:
    global _client
    if _client is None:
        api_key = (
            settings.llm_api_key.get_secret_value()
            if settings.llm_api_key is not None
            else ""
        )
        _client = AsyncOpenAI(
            api_key=api_key,
            base_url=str(settings.llm_base_url),
        )
    return _client


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=4000)


class ChatRequest(BaseModel):
    session_id: str = Field(max_length=64, pattern=r"^[a-zA-Z0-9_-]+$")
    message: str = Field(max_length=4000)
    history: list[ChatMessage] = Field(default_factory=list, max_length=100)
    call_id: int | None = Field(default=None, ge=1)
    call_secret: str = Field(min_length=32, max_length=128)
    client_telemetry: ClientTelemetry | None = None

    @field_validator("history")
    @classmethod
    def validate_history_length(cls, history: list[ChatMessage]) -> list[ChatMessage]:
        total_chars = sum(len(msg.content) for msg in history)
        if total_chars > 30_000:
            raise ValueError(
                f"Total chat history characters ({total_chars}) exceeds limit of 30,000."
            )
        return history


class EndCallRequest(BaseModel):
    session_id: str = Field(max_length=64, pattern=r"^[a-zA-Z0-9_-]+$")
    call_id: int = Field(ge=1)
    call_secret: str = Field(min_length=32, max_length=128)
    outcome: str = Field(default="info_only", pattern="^(booked|info_only)$")
    summary: str | None = Field(default=None, max_length=50_000)
    client_telemetry: ClientTelemetry | None = None


def _is_assistant_echo(text: str, company_name: str | None = None) -> bool:
    """Detect if caller input is an echo of assistant speech picked up by mic.

    Only flags true if the message closely mirrors the opening greeting pattern
    and does NOT contain genuine caller booking/problem intent.
    """
    clean = text.lower().strip()
    has_intro = (
        "thank you for calling" in clean
        or "thanks for calling" in clean
        or "my name is sarah" in clean
        or "this is sarah" in clean
    )
    has_prompt = (
        "how can i assist" in clean
        or "how can i help" in clean
        or "heating or cooling today" in clean
    )
    if not (has_intro and has_prompt):
        return False

    stripped = clean
    phrases = [
        "thank you for calling",
        "thanks for calling",
        "example hvac",
        "apex hvac",
        "my name is sarah",
        "this is sarah",
        "how can i help with your heating or cooling today",
        "how can i assist you with your heating or cooling today",
        "with your heating or cooling today",
        "with your heating or cooling",
        "heating or cooling today",
        "how can i help with",
        "how can i assist you with",
        "how can i help you",
        "how can i assist you",
        "how can i help",
        "how can i assist",
    ]
    if company_name and company_name.strip():
        phrases.append(company_name.strip().lower())
    for phrase in sorted(phrases, key=len, reverse=True):
        stripped = stripped.replace(phrase, " ")

    stripped = re.sub(r"[^a-z0-9]", " ", stripped).strip()
    remaining_words = [w for w in stripped.split() if len(w) > 2]
    return len(remaining_words) <= 2




def _is_echo_of_assistant(
    message: str,
    history: list[ChatMessage] | None = None,
    call_id: int | str | None = None,
) -> bool:
    """Detect speaker-feedback echo: the mic re-captured the assistant's TTS.

    If the user utterance is an exact prefix, suffix, substring (>=2 words),
    or >=75% word overlap with a recent assistant utterance from server turns
    or session history, it is flagged as echo.
    """
    clean_msg = re.sub(r"\s+", " ", re.sub(r"[^a-z0-9\s]", " ", message.lower())).strip()
    if not clean_msg:
        return False

    msg_words = [w for w in clean_msg.split() if len(w) >= 2]
    if not msg_words:
        return False

    # Never treat genuine affirmative responses or time clarifications as echo
    if is_explicit_booking_confirmation(message):
        return False
    clarification_tokens = {"morning", "afternoon", "evening", "am", "pm"}
    if (
        len(msg_words) <= 4
        and any(p in clean_msg.split() for p in clarification_tokens)
        and not (
            clean_msg.startswith("just to confirm")
            or clean_msg.startswith("would you like me to book")
        )
    ):
        return False

    assistant_texts: list[str] = []
    if call_id is not None:
        try:
            turns = get_recent_call_turns(call_id, limit=6)
            for turn in turns:
                if turn.role == "assistant" and turn.content:
                    assistant_texts.append(turn.content)
        except Exception:
            pass

    if not assistant_texts and history:
        for msg in history[-6:]:
            if msg.role == "assistant" and msg.content:
                assistant_texts.append(msg.content)

    stop_words = {
        "a", "an", "the", "in", "on", "at", "to", "for", "with", "of",
        "and", "or", "is", "are", "i", "you", "we", "it", "do", "can",
        "my", "your", "what", "when", "how", "this", "that", "there",
    }
    content_words = [w for w in msg_words if w not in stop_words]

    for asst_text in assistant_texts:
        clean_asst = re.sub(r"\s+", " ", re.sub(r"[^a-z0-9\s]", " ", asst_text.lower())).strip()
        if not clean_asst:
            continue

        # 1. Exact prefix or suffix match for short echoed phrases (>= 2 words)
        if len(msg_words) >= 2:
            if clean_asst.startswith(clean_msg) or clean_asst.endswith(clean_msg):
                return True
            # Interior substring match if >= 3 words and >= 8 characters
            if len(msg_words) >= 3 and len(clean_msg) >= 8 and clean_msg in clean_asst:
                return True

        # 2. High word overlap for longer utterances using content words (>= 3 content words)
        if len(content_words) >= 3:
            asst_words = set(clean_asst.split())
            if asst_words:
                overlap = sum(1 for w in content_words if w in asst_words) / len(content_words)
                if overlap >= 0.8:
                    return True
    return False


def _extract_slots_from_text(text: str, current_slots: dict[str, Any]) -> dict[str, Any]:
    """Extract and separate candidate extractions from verified facts.

    Maintains candidates and verified slot models, strictly detects negated services,
    and flags ambiguous time expressions for AM/PM clarification without guessing.
    """
    updates: dict[str, Any] = {}
    lower = text.lower().strip()

    # Reject acoustic mic echoes of assistant greeting and system phrases
    if _is_assistant_echo(text):
        return updates

    # Initialize candidate, verified, and negation state
    existing_candidates = current_slots.get("candidates")
    candidates: dict[str, Any] = (
        dict(existing_candidates) if isinstance(existing_candidates, dict) else {}
    )
    existing_verified = current_slots.get("verified")
    verified: dict[str, Any] = (
        dict(existing_verified) if isinstance(existing_verified, dict) else {}
    )
    existing_negated = current_slots.get("negated_services")
    negated_services: list[str] = (
        list(existing_negated) if isinstance(existing_negated, list) else []
    )
    clarification_needed: str | None = current_slots.get("clarification_needed")

    # Seed from top-level slots if candidates/verified were empty
    for field in ("name", "phone", "service", "date", "time"):
        if field not in candidates and current_slots.get(field):
            candidates[field] = current_slots.get(field)
        if field not in verified and current_slots.get(field):
            verified[field] = current_slots.get(field)

    # 1. Name extraction
    name_patterns = [
        r"(?:my name is|i am|i'm|this is|call me|name's|name is)\s+([A-Za-z]+(?:\s+[A-Za-z]+)?)",
        r"^([A-Za-z]+(?:\s+[A-Za-z]+)?)\s+here",
    ]
    for pattern in name_patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            candidate = match.group(1).strip()
            first_word = candidate.lower().split()[0]
            if first_word not in {
                "sarah", "calling", "good", "okay", "yes", "no", "looking",
                "interested", "repair", "service", "ac", "heating", "cooling",
                "this", "here", "just", "how",
            } and candidate.lower() not in {"sarah how", "sarah here"}:
                candidates["name"] = candidate
                verified["name"] = candidate
                updates["name"] = candidate
                break

    # 2. Phone extraction (handles spoken digit words: 'plus 1 2 3 0 ...' or '555-123-4567')
    digit_map = {
        "zero": "0", "oh": "0", "one": "1", "two": "2", "three": "3", "four": "4",
        "five": "5", "six": "6", "seven": "7", "eight": "8", "nine": "9",
        "plus": "+",
    }
    normalized_for_phone = lower
    for word, digit in digit_map.items():
        normalized_for_phone = re.sub(rf"\b{word}\b", digit, normalized_for_phone)
    normalized_for_phone = re.sub(r"\b\d{4}-\d{2}-\d{2}\b", " ", normalized_for_phone)

    phone_match = re.search(r"(\+?\s*[\d\s\-\.\(\)]{6,}\d)", normalized_for_phone)
    if phone_match:
        matched_str = phone_match.group(1)
        raw_digits = re.sub(r"[^\d]", "", matched_str)
        candidates["phone"] = matched_str.strip()
        # Strict 10-digit NANP validation via normalize_nanp_phone
        nanp = normalize_nanp_phone(raw_digits)
        if nanp is not None:
            prefix = "+" if "+" in matched_str else ""
            phone_val = f"{prefix}{raw_digits}"
            verified["phone"] = phone_val
            updates["phone"] = phone_val
        else:
            # 7-digit, 8-digit, 9-digit, or invalid area code remains candidate only; not verified
            verified["phone"] = None

    # 3. Service extraction with Negation Detection
    ac_neg_pat = (
        r"\b(?:not|no|never|dont\s+need|don't\s+need|dont\s+want|don't\s+want|"
        r"instead\s+of|rather\s+than|other\s+than)\s+(?:an?\s+)?(?:a/?c|air\s*condition(?:ing)?)\b|"
        r"\b(?:a/?c|air\s*condition(?:ing)?)\s+(?:cancelled|is\s+not\s+what\s+i\s+need)\b"
    )
    heating_neg_pat = (
        r"\b(?:not|no|never|dont\s+need|don't\s+need|dont\s+want|don't\s+want|"
        r"instead\s+of|rather\s+than|other\s+than)\s+(?:an?\s+)?(?:furnace|heating|heater|boiler|heat\s*pump)\b|"
        r"\b(?:furnace|heating|heater|boiler|heat\s*pump)\s+(?:cancelled|is\s+not\s+what\s+i\s+need)\b"
    )
    tuneup_neg_pat = (
        r"\b(?:not|no|never|dont\s+need|don't\s+need|dont\s+want|don't\s+want|"
        r"instead\s+of|rather\s+than|other\s+than)\s+(?:an?\s+)?(?:tune-?up|tune\s*up|maintenance|inspection)\b|"
        r"\b(?:tune-?up|tune\s*up|maintenance|inspection)\s+(?:cancelled|is\s+not\s+what\s+i\s+need)\b"
    )

    this_turn_negated: list[str] = []
    if re.search(ac_neg_pat, lower):
        this_turn_negated.append("AC repair")
    if re.search(heating_neg_pat, lower):
        this_turn_negated.append("Heating repair")
    if re.search(tuneup_neg_pat, lower):
        this_turn_negated.append("HVAC tune-up")

    for neg_svc in this_turn_negated:
        if neg_svc not in negated_services:
            negated_services.append(neg_svc)
        if candidates.get("service") == neg_svc:
            candidates["service"] = None
        if verified.get("service") == neg_svc:
            verified["service"] = None

    aff_matches: list[str] = []
    if re.search(r"\b(a/?c|air\s*condition(?:ing)?|cooling|not\s+cooling)\b", lower):
        if "AC repair" not in this_turn_negated:
            aff_matches.append("AC repair")
    if re.search(r"\b(furnace|heating|heater|boiler|heat\s*pump)\b", lower):
        if "Heating repair" not in this_turn_negated:
            aff_matches.append("Heating repair")
    if re.search(r"\b(tune-?up|tune\s*up|maintenance|inspection)\b", lower):
        if "HVAC tune-up" not in this_turn_negated:
            aff_matches.append("HVAC tune-up")

    if aff_matches:
        chosen_service = aff_matches[0]
        candidates["service"] = chosen_service
        verified["service"] = chosen_service
        updates["service"] = chosen_service
        if chosen_service in negated_services:
            negated_services.remove(chosen_service)
    elif this_turn_negated:
        candidates["service"] = None
        verified["service"] = None
        updates["service"] = None

    # 4. Date extraction
    date_match = re.search(
        r"\b(\d{4}-\d{2}-\d{2}|today|tomorrow|next\s+"
        r"(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|"
        r"monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b",
        lower,
    )
    if date_match:
        extracted_date = date_match.group(1)
        candidates["date"] = extracted_date
        verified["date"] = extracted_date
        updates["date"] = extracted_date

    # 5. Time extraction with Ambiguity Resolution (no auto-guessing)
    word_to_hour = {
        "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
        "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
    }

    # If previously clarifying AM/PM, resolve if user now specified period
    if clarification_needed == "time_am_pm" and "time" not in updates:
        has_pm = bool(re.search(r"\b(?:p\.?m\.?|afternoon|evening|night)\b", lower))
        has_am = bool(re.search(r"\b(?:a\.?m\.?|morning)\b", lower))
        cand_time_str = str(candidates.get("time") or "03:00").split()[0]
        parts = cand_time_str.split(":")
        h = int(parts[0]) if parts[0].isdigit() else 3
        m = parts[1] if len(parts) > 1 and parts[1].isdigit() else "00"
        if has_pm and not has_am:
            time_val = f"{h:02d}:{m} PM"
            candidates["time"] = time_val
            verified["time"] = time_val
            clarification_needed = None
            updates["time"] = time_val
        elif has_am and not has_pm:
            time_val = f"{h:02d}:{m} AM"
            candidates["time"] = time_val
            verified["time"] = time_val
            clarification_needed = None
            updates["time"] = time_val

    # Explicit time with AM/PM: e.g. "9:00 a.m.", "3 PM", "3:30 AM", "3:00pm", "3am"
    time_match = re.search(
        r"\b(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?))\b",
        lower,
    )
    if time_match:
        matched_time = time_match.group(1)
        candidates["time"] = matched_time
        verified["time"] = matched_time
        clarification_needed = None
        updates["time"] = matched_time
    elif re.search(r"\bnoon\b|\bmidday\b", lower):
        time_val = "12:00 PM"
        candidates["time"] = time_val
        verified["time"] = time_val
        clarification_needed = None
        updates["time"] = time_val
    else:
        hour_candidate: int | None = None
        min_candidate = "00"

        oclock_digits = re.search(r"\b(\d{1,2})(?::(\d{2}))?\s*o'?clock\b", lower)
        at_digits = re.search(r"\b(?:at|around)\s+(\d{1,2})(?::(\d{2}))?\b", lower)
        num_words_pat = "|".join(word_to_hour.keys())
        oclock_words = re.search(rf"\b({num_words_pat})\s*o'?clock\b", lower)
        at_words = re.search(rf"\b(?:at|around)\s+({num_words_pat})\b", lower)

        if oclock_digits:
            hour_candidate = int(oclock_digits.group(1))
            if oclock_digits.group(2):
                min_candidate = oclock_digits.group(2)
        elif at_digits:
            hour_candidate = int(at_digits.group(1))
            if at_digits.group(2):
                min_candidate = at_digits.group(2)
        elif oclock_words:
            hour_candidate = word_to_hour[oclock_words.group(1)]
        elif at_words:
            hour_candidate = word_to_hour[at_words.group(1)]

        if hour_candidate is not None and 1 <= hour_candidate <= 23:
            if any(w in lower for w in ("afternoon", "evening", "night", "pm")):
                time_val = f"{hour_candidate:02d}:{min_candidate} PM"
                candidates["time"] = time_val
                verified["time"] = time_val
                clarification_needed = None
                updates["time"] = time_val
            elif any(w in lower for w in ("morning", "am")):
                time_val = f"{hour_candidate:02d}:{min_candidate} AM"
                candidates["time"] = time_val
                verified["time"] = time_val
                clarification_needed = None
                updates["time"] = time_val
            elif 1 <= hour_candidate <= 6:
                # AMBIGUOUS: 1..6 (e.g. "tomorrow at three" or "at 3") without AM/PM!
                # Do NOT auto-guess PM! Flag clarification_needed = "time_am_pm"
                # Keep candidate observation, but do NOT set verified.time or updates["time"]
                candidates["time"] = f"{hour_candidate:02d}:{min_candidate}"
                verified["time"] = None
                clarification_needed = "time_am_pm"
            else:
                # 7..12: standard business hours AM (or 12 PM)
                period = "AM" if hour_candidate < 12 else "PM"
                time_val = f"{hour_candidate:02d}:{min_candidate} {period}"
                candidates["time"] = time_val
                verified["time"] = time_val
                clarification_needed = None
                updates["time"] = time_val

        elif re.search(r"\bmorning\b", lower) and "time" not in updates:
            if candidates.get("time") and clarification_needed == "time_am_pm":
                cand_h = int(str(candidates["time"]).split(":")[0])
                time_val = f"{cand_h:02d}:00 AM"
            else:
                time_val = "09:00 AM"
            candidates["time"] = time_val
            verified["time"] = time_val
            clarification_needed = None
            updates["time"] = time_val
        elif re.search(r"\bafternoon\b", lower) and "time" not in updates:
            if candidates.get("time") and clarification_needed == "time_am_pm":
                cand_h = int(str(candidates["time"]).split(":")[0])
                time_val = f"{cand_h:02d}:00 PM"
            else:
                time_val = "02:00 PM"
            candidates["time"] = time_val
            verified["time"] = time_val
            clarification_needed = None
            updates["time"] = time_val
        elif re.search(r"\bevening\b", lower) and "time" not in updates:
            if candidates.get("time") and clarification_needed == "time_am_pm":
                cand_h = int(str(candidates["time"]).split(":")[0])
                time_val = f"{cand_h:02d}:00 PM"
            else:
                time_val = "05:00 PM"
            candidates["time"] = time_val
            verified["time"] = time_val
            clarification_needed = None
            updates["time"] = time_val

    # Only return updates if something changed or was extracted!
    has_changes = (
        bool(updates)
        or candidates != existing_candidates
        or verified != existing_verified
        or negated_services != existing_negated
        or clarification_needed != current_slots.get("clarification_needed")
    )

    if not has_changes:
        return {}

    updates["candidates"] = candidates
    updates["verified"] = verified
    updates["negated_services"] = negated_services
    updates["clarification_needed"] = clarification_needed

    return updates


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


def booking_details_changed(updates: dict[str, Any]) -> bool:
    """Returns true when an update contains phone, service, date, or time."""
    return any(
        k in updates and updates[k] is not None
        for k in ("phone", "service", "date", "time")
    )


def is_explicit_booking_confirmation(text: str) -> bool:
    """Check if text is an explicit whole-message booking confirmation.

    Normalizes lower-case text, punctuation, and whitespace.
    Returns True only for whole-message allowlist phrases.
    Rejects messages containing a negation, a new time/date, or additional booking details.
    Does not use substring matching.
    """
    cleaned = re.sub(r"[^\w\s]", " ", text.lower())
    normalized = " ".join(cleaned.split())
    if not normalized:
        return False

    negations = {
        "no", "not", "dont", "don't", "cancel", "stop", "wait", "change",
        "instead", "different", "nevermind", "decline", "neither",
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
    }
    return normalized in accepted_phrases


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


def _is_safety_emergency(text: str) -> bool:
    """Detect safety emergency keywords to give immediate life-safety guidance."""
    lower = text.lower().replace("fireplace", " ")
    emergency_kws = [
        "gas smell", "smell gas", "smelling gas", "smoke", "sparking",
        "sparks", "carbon monoxide", "dizzy", "burning smell", "gas leak",
    ]
    if any(kw in lower for kw in emergency_kws):
        return True
    if re.search(r"\bfire\b", lower):
        return True
    return False


def _is_lookup_query(text: str) -> bool:
    """Detect anonymous appointment lookup queries to enforce neutral privacy refusal."""
    lowered = text.lower()
    if any(
        phrase in lowered
        for phrase in (
            "existing appointment",
            "my appointment",
            "prior appointment",
            "past appointment",
            "check my appointment",
            "look up my appointment",
            "find my appointment",
            "status of my appointment",
            "when is my appointment",
            "what time is my appointment",
            "do i have an appointment",
            "existing booking",
            "my booking",
            "prior booking",
            "past booking",
            "check my booking",
            "look up my booking",
            "find my booking",
            "status of my booking",
            "when is my booking",
            "what time is my booking",
            "do i have a booking",
        )
    ):
        return True

    if re.search(
        r"\b(when is|what time is|status of|check|look\s*up|lookup|find|verify)\b"
        r".*\b(the|an|my)?\s*(existing\s+)?(appointment|booking)\b",
        lowered,
    ):
        return True
    if re.search(
        r"\b(appointment|booking)\b.*\b(check|look\s*up|lookup|status|(?:for|under|with)\s+\+?1?\d{3})\b",
        lowered,
    ):
        return True
    if re.search(
        r"\b(?:is there|do i have|can you (?:see|check)|any)\b"
        r".*\b(?:an?|my)?\s*(?:existing\s+)?(?:appointment|booking)\b",
        lowered,
    ):
        return True
    return False


def _is_hours_query(text: str) -> bool:
    """Detect if caller is asking about business or operating hours."""
    lowered = text.lower()
    return any(
        phrase in lowered
        for phrase in (
            "what are your hours",
            "what hours",
            "business hours",
            "opening hours",
            "when are you open",
            "are you open",
            "what time do you open",
            "what time do you close",
            "operating hours",
            "your hours",
        )
    )


def format_opening_hours_speech(settings: Settings) -> str:
    """Format opening hours into natural spoken English for voice synthesis."""
    hours = settings.business_opening_hours
    if not hours:
        return (
            f"At {settings.business_company_name}, we are open Monday through Friday from 8:00 AM "
            "to 6:00 PM, and Saturday from 8:00 AM to 6:00 PM. We are closed on Sunday."
        )

    day_names = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    if len(hours) == 7 and len(set(hours.values())) == 1:
        val = list(hours.values())[0]
        if val.lower() != "closed":
            return f"At {settings.business_company_name}, we are open seven days a week from {val}."

    mon_fri = ["monday", "tuesday", "wednesday", "thursday", "friday"]
    if all(d in hours for d in mon_fri) and len(set(hours[d] for d in mon_fri)) == 1:
        mf_val = hours["monday"]
        sat_val = hours.get("saturday", "closed")
        sun_val = hours.get("sunday", "closed")
        summary = f"Monday through Friday from {mf_val}"
        if sat_val == sun_val:
            if sat_val.lower() == "closed":
                summary += ", and closed on weekends"
            else:
                summary += f", and weekends from {sat_val}"
        else:
            if sat_val.lower() != "closed":
                summary += f", Saturday from {sat_val}"
            else:
                summary += ", closed Saturday"
            if sun_val.lower() != "closed":
                summary += f", and Sunday from {sun_val}"
            else:
                summary += ", and closed Sunday"
        return f"At {settings.business_company_name}, we are open {summary}."

    parts: list[str] = []
    for d in day_names:
        if d in hours:
            v = hours[d]
            if v.lower() == "closed":
                parts.append(f"closed on {d.title()}")
            else:
                parts.append(f"{d.title()} from {v}")
    return f"At {settings.business_company_name}, our hours are {', '.join(parts)}."



def _is_general_question(text: str) -> bool:
    """Detect if caller is asking a general question or objection rather than booking."""
    lower = text.lower().strip()
    if "?" in lower:
        return True
    question_starters = (
        "how much", "what are your", "do you", "can you", "where are", "who are",
        "what hours", "what brands", "what is", "whats", "how does", "pricing",
        "cost", "rates", "why", "why are", "why do", "why would", "what for",
        "who", "how", "explain", "tell me", "what is the reason", "why you",
        "i have no", "i don't have", "i dont have", "no number", "no phone",
    )
    return any(lower.startswith(q) or f" {q}" in lower for q in question_starters)


def _is_booking_flow_active(slots: dict[str, Any], text: str) -> bool:
    """Determine if the caller is in an active booking dialogue."""
    if slots.get("service") or slots.get("phone") or slots.get("date") or slots.get("time"):
        return True
    lower = text.lower()
    booking_intents = (
        "book", "schedule", "appointment", "technician", "come out",
        "repair", "service", "tune up", "tune-up",
    )
    return any(kw in lower for kw in booking_intents)


def _execute_tool(settings: Settings, name: str, args: dict[str, Any]) -> str:
    """Execute real business scheduling tools against SQLite."""
    if name == "check_my_appointments":
        return (
            "For privacy and security, appointment details cannot be looked up or disclosed "
            "over this channel with just a phone number. I can help arrange a new service visit, "
            "or you can manage existing appointments through our verified customer portal."
        )

    elif name == "book_appointment_tool":
        phone_number = str(args.get("phone_number", "")).strip()
        service = str(args.get("service", "")).strip()
        date_str = str(args.get("date", "")).strip()
        time_str = str(args.get("time", "")).strip()
        caller_name = args.get("name")
        notes = args.get("notes")

        if settings.business_services:
            normalized_requested = service.lower()
            matched_service: str | None = None
            for approved in settings.business_services:
                clean_app = approved.strip().lower()
                if (
                    normalized_requested == clean_app
                    or normalized_requested in clean_app
                    or clean_app in normalized_requested
                ):
                    matched_service = approved.strip()
                    break
            if not matched_service:
                return (
                    f"'{service}' is not on our approved services list. "
                    f"Approved services are: {', '.join(settings.business_services)}."
                )
            service = matched_service

        when = _parse_local_datetime(settings, date_str, time_str)
        if when is None:
            return "I could not understand that date or time. Please provide a clear date and time."

        with new_session() as session:
            _appointment, message = book_appointment(
                session,
                settings,
                phone_number=phone_number,
                service=service,
                when=when,
                name=caller_name,
                notes=notes,
            )
            return message

    return f"Unknown tool: {name}"


READ_ONLY_TOOLS: list[dict[str, Any]] = []

BOOKING_TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "book_appointment_tool",
            "description": (
                "Book an HVAC service appointment during business hours. "
                "Call this tool when the caller provides their phone number, "
                "service, date, and time."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "phone_number": {
                        "type": "string",
                        "description": "The caller's callback phone number, e.g. +15555550100",
                    },
                    "service": {
                        "type": "string",
                        "description": (
                            "The requested HVAC service (e.g. AC repair, Heating repair, "
                            "HVAC tune-up)"
                        ),
                    },
                    "date": {
                        "type": "string",
                        "description": "Appointment date (e.g. YYYY-MM-DD, tomorrow, Monday)",
                    },
                    "time": {
                        "type": "string",
                        "description": "Appointment start time (e.g. 09:00 AM, 02:00 PM)",
                    },
                    "name": {
                        "type": "string",
                        "description": "The caller's name, if provided",
                    },
                    "notes": {
                        "type": "string",
                        "description": "Optional details or symptoms about the HVAC problem",
                    },
                },
                "required": ["phone_number", "service", "date", "time"],
            },
        },
    },
]

TOOLS = READ_ONLY_TOOLS


def _is_closing_or_polite_remark(text: str) -> bool:
    """Check if caller is merely expressing gratitude or saying goodbye."""
    cleaned = "".join(c for c in text.lower() if c.isalnum() or c.isspace()).strip()
    polite_exact = {
        "thank you", "thanks", "thank you so much", "thanks so much",
        "thank you very much", "thanks a lot", "many thanks",
        "bye", "goodbye", "bye bye", "have a good day", "have a great day",
        "have a good one", "take care",
        "no", "no that is all", "no thats all", "no thank you", "no thanks",
        "that is all", "thats all", "that is it", "thats it", "nope",
        "nothing else", "i am good", "im good", "all good",
        "perfect thank you", "great thank you", "ok thank you", "okay thank you",
        "ok thanks", "okay thanks",
        "sounds good thank you", "sounds great thank you",
    }
    if cleaned in polite_exact:
        return True
    if len(cleaned) < 35 and (
        cleaned.startswith("thank")
        or cleaned.startswith("bye")
        or cleaned.startswith("goodbye")
        or cleaned.startswith("have a")
        or cleaned.startswith("no thank")
        or cleaned.startswith("no that")
        or cleaned.startswith("thats all")
        or cleaned.startswith("that is all")
        or cleaned.startswith("take care")
    ):
        return True
    return False


def _is_rate_limit_error(err_text: str) -> bool:
    """Detect Groq rate limit errors including HTTP 429, TPD, and TPM."""
    t = err_text.lower()
    return (
        "429" in t
        or "rate limit" in t
        or "rate_limit_exceeded" in t
        or "tokens per day" in t
        or "tokens per minute" in t
        or "requests per minute" in t
        or "tpd" in t
        or "tpm" in t
    )


def _get_candidate_models(primary_model: str) -> list[str]:
    """Return prioritized candidate models on Groq for transparent failover on quota limits."""
    supported = [
        "qwen/qwen3.8-27b",
        "openai/gpt-oss-20b",
        "qwen/qwen3.6-27b",
        "openai/gpt-oss-120b",
    ]
    candidates = [primary_model] if primary_model else []
    for m in supported:
        if m not in candidates:
            candidates.append(m)
    return candidates or ["qwen/qwen3.8-27b"]


async def _try_create_completion(
    client: AsyncOpenAI,
    candidate_model: str,
    call_kwargs: dict[str, Any],
) -> Any:
    try:
        return await client.chat.completions.create(
            **call_kwargs,
            extra_body={"reasoning_effort": "none"},
        )
    except Exception as e1:
        err1 = str(e1).lower()
        if "tool choice is none" in err1 or "model called a tool" in err1:
            logger.info(
                "tool_choice_none_fallback_auto_tools",
                error=str(e1),
                model=candidate_model,
            )
            fallback_kwargs = dict(call_kwargs)
            fallback_kwargs["tools"] = READ_ONLY_TOOLS
            fallback_kwargs["tool_choice"] = "auto"
            return await client.chat.completions.create(**fallback_kwargs)

        if _is_rate_limit_error(err1):
            raise

        logger.warning(
            "completion_fallback_reasoning_effort_none",
            error=str(e1),
            model=candidate_model,
        )
        try:
            return await client.chat.completions.create(
                **call_kwargs,
                extra_body={"reasoning_effort": "low"},
            )
        except Exception as e2:
            err2 = str(e2).lower()
            if "tool choice is none" in err2 or "model called a tool" in err2:
                logger.info(
                    "tool_choice_none_fallback_auto_tools",
                    error=str(e2),
                    model=candidate_model,
                )
                fallback_kwargs = dict(call_kwargs)
                fallback_kwargs["tools"] = READ_ONLY_TOOLS
                fallback_kwargs["tool_choice"] = "auto"
                return await client.chat.completions.create(**fallback_kwargs)

            if _is_rate_limit_error(err2):
                raise

            logger.warning(
                "completion_fallback_without_reasoning_effort",
                error=str(e2),
                model=candidate_model,
            )
            return await client.chat.completions.create(**call_kwargs)


async def _create_stream_completion(
    client: AsyncOpenAI,
    **kwargs: Any,
) -> Any:
    """Create streaming completion with lowest latency, tool repair, and model failover."""
    kwargs["max_tokens"] = kwargs.get("max_tokens", 128)
    primary_model = kwargs.get("model", "qwen/qwen3.8-27b")
    candidate_models = _get_candidate_models(primary_model)

    last_error: Exception | None = None

    for model_idx, candidate_model in enumerate(candidate_models):
        current_kwargs = dict(kwargs)
        current_kwargs["model"] = candidate_model

        try:
            return await _try_create_completion(client, candidate_model, current_kwargs)
        except Exception as model_err:
            last_error = model_err
            err_str = str(model_err).lower()
            if _is_rate_limit_error(err_str) and model_idx < len(candidate_models) - 1:
                next_model = candidate_models[model_idx + 1]
                logger.warning(
                    "model_rate_limit_failover",
                    rate_limited_model=candidate_model,
                    switching_to=next_model,
                    error=str(model_err),
                )
                continue

            if "tool choice is none" in err_str or "model called a tool" in err_str:
                repair_kwargs = dict(current_kwargs)
                repair_kwargs["tools"] = READ_ONLY_TOOLS
                repair_kwargs["tool_choice"] = "auto"
                try:
                    return await client.chat.completions.create(**repair_kwargs)
                except Exception as repair_err:
                    if (
                        _is_rate_limit_error(str(repair_err).lower())
                        and model_idx < len(candidate_models) - 1
                    ):
                        next_model = candidate_models[model_idx + 1]
                        logger.warning(
                            "model_rate_limit_failover_after_repair",
                            rate_limited_model=candidate_model,
                            switching_to=next_model,
                        )
                        continue
                    last_error = repair_err

            if not _is_rate_limit_error(err_str):
                raise model_err

    if last_error is not None:
        raise last_error


@router.post("/chat")
async def chat_stream(req: ChatRequest, request: Request) -> StreamingResponse:
    """Stream assistant response tokens via Server-Sent Events (SSE) with tool execution."""
    settings: Settings = getattr(request.app.state, "settings", None) or get_settings()

    # Enforce server-side sliding-window rate limit on chat endpoint before LLM invocation
    client_ip = get_client_ip(request, settings)
    check_chat_rate_limit(client_ip)

    # Initial instant greeting without LLM latency
    if req.message == "__GREETING__":
        greeting_text = (
            f"Thanks for calling {settings.business_company_name}! "
            f"This is Sarah — how can I help with your heating or cooling today?"
        )
        call_id = start_or_get_browser_call(
            req.session_id, req.call_secret, client_telemetry=req.client_telemetry
        )
        await asyncio.to_thread(record_call_turn, call_id, "assistant", greeting_text)

        async def greeting_generator() -> AsyncIterator[str]:
            yield f"event: call_started\ndata: {json.dumps({'call_id': call_id})}\n\n"
            yield f"event: delta\ndata: {json.dumps({'text': greeting_text})}\n\n"
            yield (
                f"event: done\ndata: "
                f"{json.dumps({'outcome': 'info_only', 'call_id': call_id})}\n\n"
            )

        return StreamingResponse(
            greeting_generator(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    if req.call_id is None or not await asyncio.to_thread(
        is_authorized_active_call, req.call_id, req.session_id, req.call_secret
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This call session is invalid or has already ended.",
        )
    active_call_id: int = req.call_id
    if req.client_telemetry is not None:
        await asyncio.to_thread(apply_client_telemetry, active_call_id, req.client_telemetry)

    # Detect acoustic echo of assistant speech picked up by the microphone:
    # either the greeting pattern or any fragment of recent assistant turns.
    # Returns a silent no-op (event: done only) to completely eliminate spoken feedback loops.
    if (
        _is_assistant_echo(req.message, settings.business_company_name)
        or _is_echo_of_assistant(req.message, req.history, active_call_id)
    ):
        async def echo_noop_generator() -> AsyncIterator[str]:
            yield f"event: done\ndata: {json.dumps({'outcome': 'info_only'})}\n\n"

        return StreamingResponse(
            echo_noop_generator(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # Persist authoritative caller turn in server database
    await asyncio.to_thread(record_call_turn, active_call_id, "caller", req.message)

    # Detect life-safety emergencies immediately
    if _is_safety_emergency(req.message):
        emergency_text = (
            "If you smell gas or smoke, or see fire or sparks, please leave the building "
            "immediately and call 911! Your safety is the top priority."
        )
        await asyncio.to_thread(record_call_turn, active_call_id, "assistant", emergency_text)

        async def emergency_generator() -> AsyncIterator[str]:
            yield f"event: delta\ndata: {json.dumps({'text': emergency_text})}\n\n"
            yield f"event: done\ndata: {json.dumps({'outcome': 'info_only'})}\n\n"

        return StreamingResponse(
            emergency_generator(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # Detect anonymous appointment lookup queries immediately and enforce privacy refusal
    if _is_lookup_query(req.message):
        policy_text = (
            "For privacy and security, appointment details cannot be looked up or disclosed "
            "over this channel with just a phone number. "
            "I can help arrange a new service visit, "
            "or you can manage existing appointments through our verified customer portal."
        )
        await asyncio.to_thread(record_call_turn, active_call_id, "assistant", policy_text)

        async def lookup_refusal_generator() -> AsyncIterator[str]:
            yield f"event: delta\ndata: {json.dumps({'text': policy_text})}\n\n"
            yield f"event: done\ndata: {json.dumps({'outcome': 'info_only'})}\n\n"

        return StreamingResponse(
            lookup_refusal_generator(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # 1. Update and retrieve durable session slots bound to this exact call.
    slots = await asyncio.to_thread(get_call_slots, active_call_id)
    new_slots = _extract_slots_from_text(req.message, slots)
    if new_slots:
        if booking_details_changed(new_slots):
            new_slots["confirmation_requested"] = False
            new_slots["confirmation_fingerprint"] = None
            new_slots["confirmed"] = False
        slots = await asyncio.to_thread(update_call_slots, active_call_id, new_slots)
        if phone := new_slots.get("phone"):
            await asyncio.to_thread(update_call_phone, active_call_id, str(phone))

    # 2. Idempotent check for calls already successfully booked
    if slots.get("confirmed"):
        if (
            _is_closing_or_polite_remark(req.message)
            or is_explicit_booking_confirmation(req.message)
        ):
            msg = (
                "You're already all set for your appointment! "
                "Our technician will see you then. Thanks for calling and have a great day!"
            )
            await asyncio.to_thread(record_call_turn, active_call_id, "assistant", msg)

            async def already_confirmed_generator() -> AsyncIterator[str]:
                yield f"event: delta\ndata: {json.dumps({'text': msg})}\n\n"
                yield f"event: done\ndata: {json.dumps({'outcome': 'booked'})}\n\n"

            return StreamingResponse(
                already_confirmed_generator(),
                media_type="text/event-stream",
                headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
            )

    # 3. Deterministic Booking State Machine Routing
    has_active_recap = bool(
        slots.get("confirmation_requested") and slots.get("confirmation_fingerprint")
    )

    # Detect inquiries about opening hours and respond deterministically from configuration
    if (
        _is_hours_query(req.message)
        and not has_active_recap
        and not _is_booking_flow_active(slots, req.message)
    ):
        hours_speech = (
            f"{format_opening_hours_speech(settings)} "
            "How can I help you with your heating or cooling today?"
        )
        await asyncio.to_thread(record_call_turn, active_call_id, "assistant", hours_speech)

        async def hours_generator() -> AsyncIterator[str]:
            yield f"event: delta\ndata: {json.dumps({'text': hours_speech})}\n\n"
            yield f"event: done\ndata: {json.dumps({'outcome': 'info_only'})}\n\n"

        return StreamingResponse(
            hours_generator(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # Case A: A server recap was previously requested and is awaiting confirmation
    if has_active_recap:
        expected_fp = str(slots.get("confirmation_fingerprint"))
        current_fp = booking_confirmation_fingerprint(slots)
        if expected_fp == current_fp:
            if is_explicit_booking_confirmation(req.message):
                guidance = (
                    "I have those details ready! "
                    "Please tap Confirm Booking on your screen to complete your appointment."
                )
                await asyncio.to_thread(record_call_turn, active_call_id, "assistant", guidance)

                async def tap_prompt_generator() -> AsyncIterator[str]:
                    yield f"event: delta\ndata: {json.dumps({'text': guidance})}\n\n"
                    yield f"event: done\ndata: {json.dumps({'outcome': 'info_only'})}\n\n"

                return StreamingResponse(
                    tap_prompt_generator(),
                    media_type="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
                )

            negations = {
                "no", "not", "cancel", "stop", "dont", "don't",
                "nevermind", "wait", "decline",
            }
            cleaned_words = set(re.sub(r"[^\w\s]", " ", req.message.lower()).split())
            if cleaned_words & negations:
                await asyncio.to_thread(
                    update_call_slots,
                    active_call_id,
                    {
                        "confirmation_requested": False,
                        "confirmation_fingerprint": None,
                        "time": None,
                        "date": None,
                    },
                )
                decline_msg = (
                    "No problem at all! Would you like to check a different day or time, "
                    "or is there something else I can help with?"
                )
                await asyncio.to_thread(record_call_turn, active_call_id, "assistant", decline_msg)

                async def decline_generator() -> AsyncIterator[str]:
                    yield f"event: delta\ndata: {json.dumps({'text': decline_msg})}\n\n"
                    yield f"event: done\ndata: {json.dumps({'outcome': 'info_only'})}\n\n"

                return StreamingResponse(
                    decline_generator(),
                    media_type="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
                )

            if not _is_general_question(req.message):
                clarif_msg = (
                    "I just need a quick yes or no. Would you like me to go ahead "
                    "and book that appointment for you?"
                )
                await asyncio.to_thread(record_call_turn, active_call_id, "assistant", clarif_msg)

                async def clarif_generator() -> AsyncIterator[str]:
                    yield f"event: delta\ndata: {json.dumps({'text': clarif_msg})}\n\n"
                    yield f"event: done\ndata: {json.dumps({'outcome': 'info_only'})}\n\n"

                return StreamingResponse(
                    clarif_generator(),
                    media_type="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
                )

    # Ambiguity check: If time needs AM/PM clarification, clarify without auto-guessing
    if slots.get("clarification_needed") == "time_am_pm" and not _is_general_question(req.message):
        candidate_time = (slots.get("candidates") or {}).get("time") or "3"
        time_display = str(candidate_time)
        if ":" in time_display:
            parts = time_display.split(":")
            try:
                h = int(parts[0])
                m = parts[1][:2]
                time_display = f"{h}:{m}" if m != "00" else f"{h}"
            except ValueError:
                pass
        q_text = f"Would you prefer {time_display} in the morning or in the afternoon?"
        await asyncio.to_thread(record_call_turn, active_call_id, "assistant", q_text)

        async def time_clarif_gen() -> AsyncIterator[str]:
            yield f"event: delta\ndata: {json.dumps({'text': q_text})}\n\n"
            yield f"event: done\ndata: {json.dumps({'outcome': 'info_only'})}\n\n"

        return StreamingResponse(
            time_clarif_gen(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # Case B: No active recap. Check missing booking fields.
    missing = booking_missing_fields(slots)
    if (
        not missing
        and not _is_general_question(req.message)
        and not has_active_recap
        and not slots.get("clarification_needed")
    ):
        parsed_dt = _parse_local_datetime(
            settings, str(slots.get("date")), str(slots.get("time"))
        )
        if parsed_dt is None:
            msg = (
                "I couldn't quite understand that date or time. "
                "Could you give me a specific day and time, like tomorrow at 10 AM?"
            )
            await asyncio.to_thread(record_call_turn, active_call_id, "assistant", msg)

            async def invalid_dt_gen() -> AsyncIterator[str]:
                yield f"event: delta\ndata: {json.dumps({'text': msg})}\n\n"
                yield f"event: done\ndata: {json.dumps({'outcome': 'info_only'})}\n\n"

            return StreamingResponse(
                invalid_dt_gen(),
                media_type="text/event-stream",
                headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
            )

        now_local = datetime.now(parsed_dt.tzinfo or UTC)
        if parsed_dt < now_local:
            msg = "That time has already passed. What future day and time works best for you?"
            await asyncio.to_thread(record_call_turn, active_call_id, "assistant", msg)

            async def past_dt_gen() -> AsyncIterator[str]:
                yield f"event: delta\ndata: {json.dumps({'text': msg})}\n\n"
                yield f"event: done\ndata: {json.dumps({'outcome': 'info_only'})}\n\n"

            return StreamingResponse(
                past_dt_gen(),
                media_type="text/event-stream",
                headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
            )

        # Check opening hours constraint (Phase 4: Constrained public facts & availability)
        if settings.business_opening_hours and not is_within_business_hours(parsed_dt, settings):
            day_name = parsed_dt.strftime("%A").lower()
            day_window = settings.business_opening_hours.get(day_name, "closed")
            if day_window == "closed" or not day_window:
                msg = (
                    f"We are closed on {day_name.title()}. "
                    f"What other day would work best for your appointment?"
                )
                await asyncio.to_thread(
                    update_call_slots,
                    active_call_id,
                    {"date": None, "time": None},
                )
            else:
                msg = (
                    f"That time is outside our business hours. We are open from {day_window} "
                    f"on {day_name.title()}. What time during our open hours works best for you?"
                )
                await asyncio.to_thread(
                    update_call_slots,
                    active_call_id,
                    {"time": None},
                )
            await asyncio.to_thread(record_call_turn, active_call_id, "assistant", msg)

            async def outside_hours_gen() -> AsyncIterator[str]:
                yield f"event: delta\ndata: {json.dumps({'text': msg})}\n\n"
                yield f"event: done\ndata: {json.dumps({'outcome': 'info_only'})}\n\n"

            return StreamingResponse(
                outside_hours_gen(),
                media_type="text/event-stream",
                headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
            )

        # Check existing appointment slot conflict (Phase 4: Never recap an already-booked slot)
        def _is_slot_conflicted() -> bool:
            with new_session() as s:
                return has_conflict(s, parsed_dt)

        if await asyncio.to_thread(_is_slot_conflicted):
            msg = (
                "That appointment time is already booked. "
                "Could you please choose another time that works for you?"
            )
            await asyncio.to_thread(
                update_call_slots,
                active_call_id,
                {"time": None},
            )
            await asyncio.to_thread(record_call_turn, active_call_id, "assistant", msg)

            async def conflict_gen() -> AsyncIterator[str]:
                yield f"event: delta\ndata: {json.dumps({'text': msg})}\n\n"
                yield f"event: done\ndata: {json.dumps({'outcome': 'info_only'})}\n\n"

            return StreamingResponse(
                conflict_gen(),
                media_type="text/event-stream",
                headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
            )

        fp = booking_confirmation_fingerprint(slots)
        verified_service = str(
            slots.get("service")
            or (slots.get("verified") or {}).get("service")
            or "HVAC Service"
        )
        verified_phone = str(
            slots.get("phone")
            or (slots.get("verified") or {}).get("phone")
            or ""
        )

        def _mint_ticket() -> ConfirmationTicket:
            with new_session() as s:
                return create_confirmation_ticket(
                    s,
                    call_id=active_call_id,
                    service=verified_service,
                    phone=verified_phone,
                    scheduled_for=parsed_dt,
                    fingerprint=fp,
                    ttl_seconds=300,
                )

        ticket = await asyncio.to_thread(_mint_ticket)

        await asyncio.to_thread(
            update_call_slots,
            active_call_id,
            {
                "confirmation_requested": True,
                "confirmation_fingerprint": fp,
                "active_ticket_id": ticket.ticket_id,
            },
        )
        recap_text = booking_confirmation_text(settings, slots)
        await asyncio.to_thread(record_call_turn, active_call_id, "assistant", recap_text)

        tz = ZoneInfo(settings.business_timezone)
        local_dt = parsed_dt.astimezone(tz)
        ticket_payload = {
            "ticket_id": ticket.ticket_id,
            "service": ticket.service,
            "phone": ticket.phone,
            "date": local_dt.strftime("%Y-%m-%d"),
            "time": local_dt.strftime("%I:%M %p"),
            "fingerprint": ticket.fingerprint,
            "expires_in_seconds": 300,
        }

        async def recap_gen() -> AsyncIterator[str]:
            yield f"event: delta\ndata: {json.dumps({'text': recap_text})}\n\n"
            yield f"event: confirmation_ticket\ndata: {json.dumps(ticket_payload)}\n\n"
            yield f"event: done\ndata: {json.dumps({'outcome': 'info_only'})}\n\n"

        return StreamingResponse(
            recap_gen(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    elif (
        missing
        and _is_booking_flow_active(slots, req.message)
        and not _is_general_question(req.message)
        and slots.get("last_prompted_slot") != missing[0]
        and not any(
            kw in req.message.lower()
            for kw in (
                "fuck", "shit", "damn", "already", "told you", "gave you",
                "just give", "listen", "no number", "no phone", "don't have",
            )
        )
    ):
        next_field = missing[0]
        if next_field == "service":
            q_text = "What service do you need help with: AC repair, heating repair, or a tune-up?"
        elif next_field == "phone":
            q_text = "What's the best callback phone number for the technician to reach you?"
        elif next_field == "date":
            q_text = "What day works best for your appointment?"
        else:
            q_text = "What time would you prefer?"

        await asyncio.to_thread(
            update_call_slots,
            active_call_id,
            {"last_prompted_slot": next_field},
        )
        await asyncio.to_thread(record_call_turn, active_call_id, "assistant", q_text)

        async def missing_slot_gen() -> AsyncIterator[str]:
            yield f"event: delta\ndata: {json.dumps({'text': q_text})}\n\n"
            yield f"event: done\ndata: {json.dumps({'outcome': 'info_only'})}\n\n"

        return StreamingResponse(
            missing_slot_gen(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # 4. Conversational LLM Flow for General Inquiries & Lookup
    if not settings.llm_api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="LLM credentials are not configured on the server.",
        )

    client = _get_client(settings)

    system_content = receptionist_instructions(settings, slots=slots)
    messages: list[dict[str, Any]] = [{"role": "system", "content": system_content}]

    # Server-owned conversation authority: assemble context exclusively from server
    # CallTurn records. Client-supplied history (including fabricated assistant turns) is ignored!
    recent_turns = await asyncio.to_thread(get_recent_call_turns, active_call_id, limit=12)
    has_current_turn = False
    for turn in recent_turns:
        role = (
            "user"
            if turn.role in ("caller", "user")
            else ("assistant" if turn.role == "assistant" else "system")
        )
        messages.append({"role": role, "content": turn.content})
        if turn.content == req.message and turn.role in ("caller", "user"):
            has_current_turn = True

    if not has_current_turn:
        messages.append({"role": "user", "content": req.message})

    is_polite_closing = _is_closing_or_polite_remark(req.message)
    tools_to_use = None if is_polite_closing else READ_ONLY_TOOLS
    tool_choice_to_use = "auto" if tools_to_use else None

    async def sse_generator() -> AsyncIterator[str]:
        outcome = "info_only"
        try:
            # First pass: request streaming chat completion with tools if applicable
            comp_kwargs: dict[str, Any] = {
                "client": client,
                "model": settings.llm_model,
                "messages": messages,
                "temperature": 0.1,
                "max_tokens": 128,
                "stop": ["\nuser:", "\nUser:", "\ncaller:", "\nCaller:"],
                "stream": True,
            }
            if tools_to_use:
                comp_kwargs["tools"] = tools_to_use
                if tool_choice_to_use:
                    comp_kwargs["tool_choice"] = tool_choice_to_use

            response = await _create_stream_completion(**comp_kwargs)

            tool_calls_accumulator: dict[int, dict[str, Any]] = {}
            streamed_content = ""

            async for chunk in response:
                delta = chunk.choices[0].delta if chunk.choices else None
                if not delta:
                    continue

                if delta.tool_calls:
                    for i, tc in enumerate(delta.tool_calls):
                        raw_idx = getattr(tc, "index", None)
                        idx = raw_idx if raw_idx is not None else i
                        if idx not in tool_calls_accumulator:
                            tool_calls_accumulator[idx] = {
                                "id": tc.id or "",
                                "name": (
                                    tc.function.name
                                    if tc.function and tc.function.name
                                    else ""
                                ),
                                "arguments": "",
                            }
                        if tc.id:
                            tool_calls_accumulator[idx]["id"] = tc.id
                        if tc.function:
                            if tc.function.name:
                                tool_calls_accumulator[idx]["name"] = tc.function.name
                            if tc.function.arguments:
                                tool_calls_accumulator[idx]["arguments"] += tc.function.arguments

                # Stream conversational text only when not accumulating a tool call
                elif delta.content and not tool_calls_accumulator:
                    streamed_content += delta.content
                    yield f"event: delta\ndata: {json.dumps({'text': delta.content})}\n\n"

            # If the model requested read-only lookup: execute and stream the final answer
            if tool_calls_accumulator:
                parsed_args: dict[int, dict[str, Any]] = {}
                sanitized_tool_calls: list[dict[str, Any]] = []
                for i, tc in tool_calls_accumulator.items():
                    raw_args = tc.get("arguments", "")
                    try:
                        args = json.loads(raw_args) if raw_args.strip() else {}
                    except Exception:
                        args = {}
                    parsed_args[i] = args
                    sanitized_tool_calls.append(
                        {
                            "id": tc["id"] or f"call_{i}",
                            "type": "function",
                            "function": {
                                "name": tc["name"],
                                "arguments": json.dumps(args),
                            },
                        }
                    )

                messages.append(
                    {
                        "role": "assistant",
                        "content": streamed_content or None,
                        "tool_calls": sanitized_tool_calls,
                    }
                )

                for i, tc in tool_calls_accumulator.items():
                    name = tc["name"]
                    args = parsed_args[i]

                    logger.info("executing_chat_tool", tool=name, argument_names=sorted(args))
                    tool_result = await asyncio.to_thread(_execute_tool, settings, name, args)

                    if name == "book_appointment_tool" and (
                        tool_result.startswith("Booked ")
                        or "already confirmed" in tool_result.lower()
                    ):
                        outcome = "booked"
                        if active_call_id is not None:
                            await asyncio.to_thread(update_call_outcome, active_call_id, "booked")
                            slot_updates: dict[str, Any] = {"confirmed": True}
                            if svc := args.get("service"):
                                slot_updates["service"] = str(svc)
                            if dt := args.get("date"):
                                slot_updates["date"] = str(dt)
                            if tm := args.get("time"):
                                slot_updates["time"] = str(tm)
                            if ph := args.get("phone_number"):
                                slot_updates["phone"] = str(ph)
                                await asyncio.to_thread(update_call_phone, active_call_id, str(ph))
                            await asyncio.to_thread(update_call_slots, active_call_id, slot_updates)

                    yield (
                        f"event: tool_call\ndata: "
                        f"{json.dumps({'name': name, 'result': tool_result})}\n\n"
                    )

                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": tc["id"] or f"call_{i}",
                            "content": tool_result,
                        }
                    )

                # Second stream: generate voice reply based on tool execution result
                second_response = await _create_stream_completion(
                    client=client,
                    model=settings.llm_model,
                    messages=messages,
                    temperature=0.1,
                    max_tokens=128,
                    stop=["\nuser:", "\nUser:", "\ncaller:", "\nCaller:"],
                    stream=True,
                )

                second_content = ""
                async for chunk in second_response:
                    delta = chunk.choices[0].delta if chunk.choices else None
                    if delta and delta.content:
                        second_content += delta.content
                        yield f"event: delta\ndata: {json.dumps({'text': delta.content})}\n\n"

                if second_content.strip():
                    await asyncio.to_thread(
                        record_call_turn, active_call_id, "assistant", second_content.strip()
                    )

            elif streamed_content.strip():
                await asyncio.to_thread(
                    record_call_turn, active_call_id, "assistant", streamed_content.strip()
                )

            yield f"event: done\ndata: {json.dumps({'outcome': outcome})}\n\n"

        except Exception as e:
            err_msg = str(e)
            logger.error("chat_stream_error", error=err_msg)
            if (
                "tool choice is none" in err_msg.lower()
                or "model called a tool" in err_msg.lower()
            ):
                recovery_text = (
                    "I apologize for the moment, let me help you with that. "
                    "Could you please repeat what you need?"
                )
                await asyncio.to_thread(
                    record_call_turn, active_call_id, "assistant", recovery_text
                )
                yield f"event: delta\ndata: {json.dumps({'text': recovery_text})}\n\n"
                yield f"event: done\ndata: {json.dumps({'outcome': outcome})}\n\n"
            elif _is_rate_limit_error(err_msg):
                recovery_text = (
                    "I apologize for the brief pause, our line had a small hiccup. "
                    "Could you please repeat that last part?"
                )
                await asyncio.to_thread(
                    record_call_turn, active_call_id, "assistant", recovery_text
                )
                yield f"event: delta\ndata: {json.dumps({'text': recovery_text})}\n\n"
                yield f"event: done\ndata: {json.dumps({'outcome': outcome})}\n\n"
            else:
                yield f"event: error\ndata: {json.dumps({'error': err_msg})}\n\n"

    return StreamingResponse(
        sse_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


_TRANSCRIBE_LOCK = threading.Lock()
_IP_TRANSCRIBE_TIMESTAMPS: dict[str, list[float]] = {}
_MAX_TRANSCRIBE_PER_WINDOW = 30
_TRANSCRIBE_WINDOW_SECONDS = 60.0


def check_transcribe_rate_limit(client_ip: str) -> None:
    """Sliding-window rate limiter for transcription to prevent quota abuse and DoS."""
    now = time.time()
    cutoff = now - _TRANSCRIBE_WINDOW_SECONDS
    with _TRANSCRIBE_LOCK:
        timestamps = _IP_TRANSCRIBE_TIMESTAMPS.get(client_ip, [])
        timestamps = [t for t in timestamps if t > cutoff]
        if len(timestamps) >= _MAX_TRANSCRIBE_PER_WINDOW:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Rate limit exceeded for transcription. Please wait before trying again.",
            )
        timestamps.append(now)
        _IP_TRANSCRIBE_TIMESTAMPS[client_ip] = timestamps
        if len(_IP_TRANSCRIBE_TIMESTAMPS) > 1000:
            for ip in list(_IP_TRANSCRIBE_TIMESTAMPS.keys()):
                _IP_TRANSCRIBE_TIMESTAMPS[ip] = [
                    t for t in _IP_TRANSCRIBE_TIMESTAMPS[ip] if t > cutoff
                ]
                if not _IP_TRANSCRIBE_TIMESTAMPS[ip]:
                    del _IP_TRANSCRIBE_TIMESTAMPS[ip]
            if len(_IP_TRANSCRIBE_TIMESTAMPS) > 1000:
                excess = len(_IP_TRANSCRIBE_TIMESTAMPS) - 1000
                for old_ip in list(_IP_TRANSCRIBE_TIMESTAMPS.keys())[:excess]:
                    del _IP_TRANSCRIBE_TIMESTAMPS[old_ip]


def _get_client_ip(request: Request | None) -> str:
    """Safely extract client IP from request headers."""
    if request is None:
        return "127.0.0.1"
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        client_ip = forwarded.split(",")[0].strip()
        if client_ip:
            return client_ip
    if request.client and request.client.host:
        return request.client.host
    return "127.0.0.1"


class TranscribeRequest(BaseModel):
    audio_base64: str = Field(
        max_length=5_000_000, description="Base64-encoded audio bytes"
    )
    content_type: str = Field(default="audio/webm", max_length=64)
    filename: str = Field(default="audio.webm", max_length=64)


@router.post("/transcribe")
async def transcribe_audio(req: TranscribeRequest, request: Request) -> dict[str, str]:
    """Transcribe caller audio using Groq Whisper API (free tier, ~200ms turnaround)."""
    client_ip = _get_client_ip(request)
    check_transcribe_rate_limit(client_ip)
    settings = get_settings()
    if not settings.llm_api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="LLM API key not configured.",
        )

    import base64

    try:
        audio_bytes = base64.b64decode(req.audio_base64)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid base64 audio data",
        ) from exc

    client = _get_client(settings)

    try:
        transcription = await client.audio.transcriptions.create(
            model="whisper-large-v3-turbo",
            file=(req.filename, audio_bytes, req.content_type),
            response_format="text",
        )
        return {"text": str(transcription).strip()}
    except Exception as e:
        logger.error("audio_transcription_failed", error=str(e))
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Transcription failed: {e}",
        ) from e


class ConfirmBookingRequest(BaseModel):
    call_id: str | int
    call_secret: str
    ticket_id: str
    fingerprint: str


class ConfirmBookingResponse(BaseModel):
    status: Literal["confirmed", "already_confirmed"]
    booking_id: int | str
    service: str
    phone: str
    date: str
    time: str
    confirmation_message: str


def _confirm_booking_sync(
    settings: Settings, req: ConfirmBookingRequest
) -> ConfirmBookingResponse:
    with new_session() as session:
        query = session.query(ConfirmationTicket).filter(
            ConfirmationTicket.ticket_id == req.ticket_id
        )
        if session.bind is not None and session.bind.dialect.name != "sqlite":
            query = query.with_for_update()
        ticket = query.one_or_none()

        if (
            ticket is None
            or ticket.call_id != str(req.call_id)
            or ticket.fingerprint != req.fingerprint
        ):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "Confirmation ticket expired or invalid. "
                    "Please confirm your details to generate a new ticket."
                ),
            )

        tz = ZoneInfo(settings.business_timezone)
        local_dt = ticket.scheduled_for.astimezone(tz)
        date_str = local_dt.strftime("%Y-%m-%d")
        time_str = local_dt.strftime("%I:%M %p").lstrip("0")
        now_local = datetime.now(tz)
        if local_dt.date() == (now_local.date() + timedelta(days=1)):
            date_display = "tomorrow"
        elif local_dt.date() == now_local.date():
            date_display = "today"
        else:
            date_display = local_dt.strftime("%A, %B %d")
        confirmation_msg = f"Your {ticket.service} is confirmed for {date_display} at {time_str}."

        if ticket.status == "consumed":
            booking_id = f"apt_{ticket.appointment_id}" if ticket.appointment_id else "apt_1"
            return ConfirmBookingResponse(
                status="already_confirmed",
                booking_id=booking_id,
                service=ticket.service,
                phone=ticket.phone,
                date=date_str,
                time=local_dt.strftime("%I:%M %p"),
                confirmation_message=confirmation_msg,
            )

        now = datetime.now(UTC)
        if ticket.status != "pending" or ticket.expires_at < now:
            if ticket.status == "pending":
                ticket.status = "expired"
                session.flush()
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "Confirmation ticket expired or invalid. "
                    "Please confirm your details to generate a new ticket."
                ),
            )

        appt, err = book_appointment(
            session=session,
            settings=settings,
            phone_number=ticket.phone,
            service=ticket.service,
            when=ticket.scheduled_for,
            notes=f"Confirmed via browser review card for call {ticket.call_id}",
        )

        if appt is None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    err
                    or "Selected appointment slot is no longer available. "
                    "Please choose another time."
                ),
            )

        ticket.status = "consumed"
        ticket.consumed_at = now
        ticket.appointment_id = appt.id

        cid = (
            req.call_id
            if isinstance(req.call_id, int)
            else (int(req.call_id) if str(req.call_id).isdigit() else 0)
        )
        call_record = session.get(CallRecord, cid)
        if call_record is not None and call_record.ended_at is None:
            call_record.outcome = "booked"
            try:
                raw_slots = (
                    json.loads(call_record.session_slots)
                    if call_record.session_slots
                    else {}
                )
            except Exception:
                raw_slots = {}
            raw_slots["confirmed"] = True
            raw_slots["booking_id"] = appt.id
            raw_slots["active_ticket_id"] = None
            raw_slots["confirmation_requested"] = False
            call_record.session_slots = json.dumps(
                raw_slots, separators=(",", ":"), ensure_ascii=False
            )

        record_call_turn(
            session,
            req.call_id,
            "assistant",
            confirmation_msg,
        )

        return ConfirmBookingResponse(
            status="confirmed",
            booking_id=f"apt_{appt.id}",
            service=ticket.service,
            phone=ticket.phone,
            date=date_str,
            time=local_dt.strftime("%I:%M %p"),
            confirmation_message=confirmation_msg,
        )


@router.post("/confirm-booking", response_model=ConfirmBookingResponse)
@router.post("/confirm", response_model=ConfirmBookingResponse)
async def confirm_booking_endpoint(
    req: ConfirmBookingRequest, request: Request
) -> ConfirmBookingResponse:
    """Consume a confirmation ticket atomically and schedule the appointment."""
    client_ip = get_client_ip(request)
    check_booking_rate_limit(client_ip)

    if not is_authorized_active_call(req.call_id, req.call_secret):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid call credentials or call has already ended.",
        )

    settings: Settings = getattr(request.app.state, "settings", None) or get_settings()
    return await asyncio.to_thread(_confirm_booking_sync, settings, req)


@router.post("/end")
async def end_call_record(req: EndCallRequest) -> dict[str, Any]:
    """Finalize only the caller's own active browser call."""
    safe_summary = req.summary[:4000] if req.summary else None
    finalized = await asyncio.to_thread(
        end_browser_call,
        req.call_id,
        req.session_id,
        req.call_secret,
        req.outcome,
        safe_summary,
        req.client_telemetry,
    )
    if not finalized:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="The active call was not found or cannot be finalized by this client.",
        )
    return {"status": "ok", "call_id": req.call_id, "outcome": req.outcome}
