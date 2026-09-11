"""Chat and voice streaming API router for in-browser client sessions."""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import threading
import time
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Any, Literal

import structlog
from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from openai import AsyncOpenAI
from pydantic import BaseModel, Field

from app.agent.prompts import receptionist_instructions
from app.call_tracking import (
    end_browser_call,
    get_call_slots,
    is_authorized_active_call,
    start_or_get_browser_call,
    update_call_outcome,
    update_call_phone,
    update_call_slots,
)
from app.config import Settings, get_settings
from app.db import new_session
from app.scheduling import book_appointment, list_upcoming, parse_local_datetime

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
    content: str


class ChatRequest(BaseModel):
    session_id: str = Field(max_length=64, pattern=r"^[a-zA-Z0-9_-]+$")
    message: str = Field(max_length=4000)
    history: list[ChatMessage] = Field(default_factory=list)
    call_id: int | None = Field(default=None, ge=1)
    call_secret: str = Field(min_length=32, max_length=128)


class EndCallRequest(BaseModel):
    session_id: str = Field(max_length=64, pattern=r"^[a-zA-Z0-9_-]+$")
    call_id: int = Field(ge=1)
    call_secret: str = Field(min_length=32, max_length=128)
    outcome: str = Field(default="info_only", pattern="^(booked|info_only)$")
    summary: str | None = Field(default=None, max_length=2000)


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
        "how can i assist you with your heating or cooling today",
        "how can i assist you with",
        "how can i assist you",
        "how can i help you",
        "heating or cooling today",
        "with your heating or cooling today",
    ]
    if company_name and company_name.strip():
        phrases.append(company_name.strip().lower())
    for phrase in phrases:
        stripped = stripped.replace(phrase, " ")

    stripped = re.sub(r"[^a-z0-9]", " ", stripped).strip()
    remaining_words = [w for w in stripped.split() if len(w) > 2]
    return len(remaining_words) <= 2




def _is_echo_of_assistant(message: str, history: list[ChatMessage]) -> bool:
    """Detect speaker-feedback echo: the mic re-captured the assistant's TTS.

    If >=75% of the transcript's words appear in a recent assistant message
    from the caller's own session history, the "user" turn is almost certainly
    the caller's speakers being re-transcribed, not the caller speaking.
    """
    clean_msg = re.sub(r"\s+", " ", re.sub(r"[^a-z0-9\s]", " ", message.lower())).strip()
    if not clean_msg:
        return False
    msg_words = [w for w in clean_msg.split() if len(w) >= 2]
    # Acoustic echoes re-captured from speakers are full sentences/clauses.
    # Responses under 8 words (e.g. "Monday at 10 AM works for me", "Can you book that for me",
    # "That is for cooling") must NEVER be flagged as echo because callers mirror prompt words.
    if len(msg_words) < 8:
        return False

    # Never treat genuine affirmative caller responses as echo
    if is_explicit_booking_confirmation(message):
        return False

    for msg in history[-6:]:
        if msg.role != "assistant":
            continue
        clean_asst = re.sub(r"\s+", " ", re.sub(r"[^a-z0-9\s]", " ", msg.content.lower()))
        asst_words = set(clean_asst.split())
        if not asst_words:
            continue
        overlap = sum(1 for w in msg_words if w in asst_words) / len(msg_words)
        if overlap >= 0.75:
            return True
    return False


def _extract_slots_from_text(text: str, current_slots: dict[str, Any]) -> dict[str, Any]:
    """Lightweight rule-based extractor to update known slots from user utterances."""
    updates: dict[str, Any] = {}
    lower = text.lower().strip()

    # Reject acoustic mic echoes of assistant greeting and system phrases
    if _is_assistant_echo(text):
        return updates

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
    # Exclude ISO date patterns so calendar dates are not misclassified as phone numbers
    normalized_for_phone = re.sub(r"\b\d{4}-\d{2}-\d{2}\b", " ", normalized_for_phone)

    phone_match = re.search(r"(\+?\s*[\d\s\-\.\(\)]{8,}\d)", normalized_for_phone)
    if phone_match:
        matched_str = phone_match.group(1)
        raw_digits = re.sub(r"[^\d]", "", matched_str)
        if len(raw_digits) >= 10:
            prefix = "+" if "+" in matched_str else ""
            updates["phone"] = f"{prefix}{raw_digits}"

    # 3. Service extraction (use word boundaries to prevent matching 'actually', 'package', etc.)
    if re.search(r"\b(a/?c|air\s*condition(?:ing)?|cooling|not\s+cooling)\b", lower):
        updates["service"] = "AC repair"
    elif re.search(r"\b(furnace|heating|heater|boiler|heat\s*pump)\b", lower):
        updates["service"] = "Heating repair"
    elif re.search(r"\b(tune-?up|tune\s*up|maintenance|inspection)\b", lower):
        updates["service"] = "HVAC tune-up"

    # 4. Date/time extraction. Keep each field canonical so the safety repair
    # can pass the same schema used by the booking tool.
    date_match = re.search(
        r"\b(\d{4}-\d{2}-\d{2}|today|tomorrow|next\s+"
        r"(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|"
        r"monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b",
        lower,
    )
    if date_match:
        updates["date"] = date_match.group(1)
    time_match = re.search(
        r"\b(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?))\b",
        lower,
    )
    if time_match:
        updates["time"] = time_match.group(1)

    return updates


_parse_local_datetime = parse_local_datetime


def booking_missing_fields(slots: dict[str, Any]) -> list[str]:
    """Required for an actual booking: service, phone, date, and time."""
    required = ["service", "phone", "date", "time"]
    missing: list[str] = []
    for field in required:
        val = slots.get(field)
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
        "go ahead and book it",
        "go ahead and book",
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
        "perfect",
        "absolutely",
    }
    return normalized in accepted_phrases


def booking_confirmation_fingerprint(slots: dict[str, Any]) -> str:
    """Compute a stable hash of the 4 core booking details."""
    phone = str(slots.get("phone", "")).strip().lower()
    service = str(slots.get("service", "")).strip().lower()
    date_val = str(slots.get("date", "")).strip().lower()
    time_val = str(slots.get("time", "")).strip().lower()
    raw = f"{phone}|{service}|{date_val}|{time_val}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def booking_confirmation_text(settings: Settings, slots: dict[str, Any]) -> str:
    """Build the spoken confirmation recap from verified durable slots."""
    service = slots.get("service") or "service"
    date_val = slots.get("date") or "your requested date"
    time_val = slots.get("time") or "your requested time"

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


def _is_general_question(text: str) -> bool:
    """Detect if caller is asking a general question rather than supplying booking info."""
    lower = text.lower().strip()
    if "?" in lower:
        return True
    question_starters = (
        "how much", "what are your", "do you", "can you", "where are", "who are",
        "what hours", "what brands", "what is", "whats", "how does", "pricing",
        "cost", "rates",
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
        phone_number = str(args.get("phone_number", "")).strip()
        if not phone_number:
            return "Please provide a valid phone number to check appointments."
        with new_session() as session:
            appointments = list_upcoming(session, phone_number)
            if not appointments:
                return "No upcoming appointments found for that phone number."
            lines = [
                (
                    f"{appt.scheduled_for.strftime('%B %d at %I:%M %p')}: "
                    f"{appt.service} ({appt.status})"
                )
                for appt in appointments
            ]
            return "Upcoming appointments: " + "; ".join(lines)

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


READ_ONLY_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "check_my_appointments",
            "description": "Look up a caller's upcoming appointments by their phone number.",
            "parameters": {
                "type": "object",
                "properties": {
                    "phone_number": {
                        "type": "string",
                        "description": "The caller's phone number",
                    },
                },
                "required": ["phone_number"],
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

    # Initial instant greeting without LLM latency
    if req.message == "__GREETING__":
        greeting_text = (
            f"Thanks for calling {settings.business_company_name}! "
            f"This is Sarah — how can I help with your heating or cooling today?"
        )
        call_id = start_or_get_browser_call(req.session_id, req.call_secret)

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

    # Detect acoustic echo of assistant speech picked up by the microphone:
    # either the greeting pattern or any fragment of recent assistant turns.
    # Returns a silent no-op (event: done only) to completely eliminate spoken feedback loops.
    if _is_assistant_echo(req.message) or _is_echo_of_assistant(req.message, req.history):
        async def echo_noop_generator() -> AsyncIterator[str]:
            yield f"event: done\ndata: {json.dumps({'outcome': 'info_only'})}\n\n"

        return StreamingResponse(
            echo_noop_generator(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # Detect life-safety emergencies immediately
    if _is_safety_emergency(req.message):
        async def emergency_generator() -> AsyncIterator[str]:
            emergency_text = (
                "If you smell gas or smoke, or see fire or sparks, please leave the building "
                "immediately and call 911! Your safety is the top priority."
            )
            yield f"event: delta\ndata: {json.dumps({'text': emergency_text})}\n\n"
            yield f"event: done\ndata: {json.dumps({'outcome': 'info_only'})}\n\n"

        return StreamingResponse(
            emergency_generator(),
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
            async def already_confirmed_generator() -> AsyncIterator[str]:
                msg = (
                    "You're already all set for your appointment! "
                    "Our technician will see you then. Thanks for calling and have a great day!"
                )
                yield f"event: delta\ndata: {json.dumps({'text': msg})}\n\n"
                yield f"event: done\ndata: {json.dumps({'outcome': 'booked'})}\n\n"

            return StreamingResponse(
                already_confirmed_generator(),
                media_type="text/event-stream",
                headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
            )

    # 3. Deterministic Booking State Machine Routing
    # Case A: A server recap was previously requested and is awaiting confirmation
    has_active_recap = bool(
        slots.get("confirmation_requested") and slots.get("confirmation_fingerprint")
    )
    if has_active_recap:
        expected_fp = str(slots.get("confirmation_fingerprint"))
        current_fp = booking_confirmation_fingerprint(slots)
        if expected_fp == current_fp:
            if is_explicit_booking_confirmation(req.message):
                phone_arg = str(slots.get("phone", "")).strip()
                service_arg = str(slots.get("service", "")).strip()
                date_arg = str(slots.get("date", "")).strip()
                time_arg = str(slots.get("time", "")).strip()
                caller_name = slots.get("name")
                tool_args: dict[str, Any] = {
                    "phone_number": phone_arg,
                    "service": service_arg,
                    "date": date_arg,
                    "time": time_arg,
                }
                if caller_name:
                    tool_args["name"] = str(caller_name).strip()

                tool_result = await asyncio.to_thread(
                    _execute_tool, settings, "book_appointment_tool", tool_args
                )
                spoken_reply, success = booking_result_text(tool_result)
                if success:
                    await asyncio.to_thread(
                        update_call_slots,
                        active_call_id,
                        {
                            "confirmed": True,
                            "confirmation_requested": False,
                            "confirmation_fingerprint": None,
                        },
                    )
                    await asyncio.to_thread(update_call_outcome, active_call_id, "booked")
                else:
                    await asyncio.to_thread(
                        update_call_slots,
                        active_call_id,
                        {"confirmation_requested": False, "confirmation_fingerprint": None},
                    )

                async def execution_generator() -> AsyncIterator[str]:
                    outcome = "booked" if success else "info_only"
                    call_data = json.dumps(
                        {"name": "book_appointment_tool", "result": tool_result}
                    )
                    yield f"event: tool_call\ndata: {call_data}\n\n"
                    yield f"event: delta\ndata: {json.dumps({'text': spoken_reply})}\n\n"
                    yield f"event: done\ndata: {json.dumps({'outcome': outcome})}\n\n"

                return StreamingResponse(
                    execution_generator(),
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
                async def decline_generator() -> AsyncIterator[str]:
                    decline_msg = (
                        "No problem at all! Would you like to check a different day or time, "
                        "or is there something else I can help with?"
                    )
                    yield f"event: delta\ndata: {json.dumps({'text': decline_msg})}\n\n"
                    yield f"event: done\ndata: {json.dumps({'outcome': 'info_only'})}\n\n"

                return StreamingResponse(
                    decline_generator(),
                    media_type="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
                )

            if not _is_general_question(req.message):
                async def clarif_generator() -> AsyncIterator[str]:
                    clarif_msg = (
                        "I just need a quick yes or no. Would you like me to go ahead "
                        "and book that appointment for you?"
                    )
                    yield f"event: delta\ndata: {json.dumps({'text': clarif_msg})}\n\n"
                    yield f"event: done\ndata: {json.dumps({'outcome': 'info_only'})}\n\n"

                return StreamingResponse(
                    clarif_generator(),
                    media_type="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
                )

    # Case B: No active recap. Check missing booking fields.
    missing = booking_missing_fields(slots)
    if not missing and not _is_general_question(req.message) and not has_active_recap:
        parsed_dt = _parse_local_datetime(
            settings, str(slots.get("date")), str(slots.get("time"))
        )
        if parsed_dt is None:
            async def invalid_dt_gen() -> AsyncIterator[str]:
                msg = (
                    "I couldn't quite understand that date or time. "
                    "Could you give me a specific day and time, like tomorrow at 10 AM?"
                )
                yield f"event: delta\ndata: {json.dumps({'text': msg})}\n\n"
                yield f"event: done\ndata: {json.dumps({'outcome': 'info_only'})}\n\n"

            return StreamingResponse(
                invalid_dt_gen(),
                media_type="text/event-stream",
                headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
            )

        now_local = datetime.now(parsed_dt.tzinfo or UTC)
        if parsed_dt < now_local:
            async def past_dt_gen() -> AsyncIterator[str]:
                msg = "That time has already passed. What future day and time works best for you?"
                yield f"event: delta\ndata: {json.dumps({'text': msg})}\n\n"
                yield f"event: done\ndata: {json.dumps({'outcome': 'info_only'})}\n\n"

            return StreamingResponse(
                past_dt_gen(),
                media_type="text/event-stream",
                headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
            )

        fp = booking_confirmation_fingerprint(slots)
        await asyncio.to_thread(
            update_call_slots,
            active_call_id,
            {"confirmation_requested": True, "confirmation_fingerprint": fp},
        )
        recap_text = booking_confirmation_text(settings, slots)

        async def recap_gen() -> AsyncIterator[str]:
            yield f"event: delta\ndata: {json.dumps({'text': recap_text})}\n\n"
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

    # Cap history to the newest 12 messages (~6 turns)
    recent_history = req.history[-12:] if len(req.history) > 12 else req.history
    for msg in recent_history:
        if msg.role == "user" and (
            _is_assistant_echo(msg.content)
            or _is_echo_of_assistant(msg.content, req.history)
        ):
            continue
        messages.append({"role": msg.role, "content": msg.content})
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

                async for chunk in second_response:
                    delta = chunk.choices[0].delta if chunk.choices else None
                    if delta and delta.content:
                        yield f"event: delta\ndata: {json.dumps({'text': delta.content})}\n\n"

            yield f"event: done\ndata: {json.dumps({'outcome': outcome})}\n\n"

        except Exception as e:
            err_msg = str(e)
            logger.error("chat_stream_error", error=err_msg)
            if (
                "tool choice is none" in err_msg.lower()
                or "model called a tool" in err_msg.lower()
            ):
                recovery_text = (
                    "You are all set! Is there anything else I can assist you with today?"
                )
                yield f"event: delta\ndata: {json.dumps({'text': recovery_text})}\n\n"
                yield f"event: done\ndata: {json.dumps({'outcome': outcome})}\n\n"
            elif _is_rate_limit_error(err_msg):
                recovery_text = (
                    "I apologize for the brief pause, our line had a small hiccup. "
                    "Could you please repeat that last part?"
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


@router.post("/end")
async def end_call_record(req: EndCallRequest) -> dict[str, Any]:
    """Finalize only the caller's own active browser call."""
    finalized = await asyncio.to_thread(
        end_browser_call,
        req.call_id,
        req.session_id,
        req.call_secret,
        req.outcome,
        req.summary,
    )
    if not finalized:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="The active call was not found or cannot be finalized by this client.",
        )
    return {"status": "ok", "call_id": req.call_id, "outcome": req.outcome}
