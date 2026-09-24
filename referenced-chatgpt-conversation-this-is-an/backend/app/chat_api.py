"""Chat and voice streaming API router for in-browser client sessions."""

from __future__ import annotations

import asyncio
import json
import re
import threading
import time
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4
from zoneinfo import ZoneInfo

import structlog
from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from openai import AsyncOpenAI

from app.agent.prompts import receptionist_instructions
from app.call_tracking import (
    ClientTelemetry,  # noqa: F401  (re-exported for existing imports)
    apply_client_telemetry,
    end_browser_call,
    get_call_slots,
    is_authorized_active_call,
    start_or_get_browser_call,
    update_call_outcome,
    update_call_phone,
    update_call_slots,
)
from app.chat.booking_policy import (
    booking_confirmation_fingerprint,
    booking_confirmation_text,
    booking_details_changed,
    booking_missing_fields,
    booking_result_text,  # noqa: F401  (re-exported for existing imports)
    is_explicit_booking_confirmation,
)
from app.chat.intent import (
    _is_assistant_echo,
    _is_booking_flow_active,
    _is_closing_or_polite_remark,
    _is_general_question,
    _is_hours_query,
    _is_lookup_query,
    _is_safety_emergency,
    format_opening_hours_speech,
)
from app.chat.schemas import (
    ChatMessage,
    ChatRequest,
    ConfirmBookingRequest,
    ConfirmBookingResponse,
    EndCallRequest,
    TranscribeRequest,
)
from app.chat.slot_extraction import _extract_slots_from_text
from app.config import Settings, get_settings
from app.db import (
    CallRecord,
    ConfirmationTicket,
    create_confirmation_ticket,
    get_confirmation_ticket,
    get_recent_call_turns,
    new_session,
    record_call_turn,
)
from app.scheduling import (
    book_appointment,
    has_conflict,
    is_within_business_hours,
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


def _levenshtein_distance(s1: str, s2: str) -> int:
    """Compute standard Levenshtein edit distance between two strings."""
    if s1 == s2:
        return 0
    if not s1:
        return len(s2)
    if not s2:
        return len(s1)
    prev_row = list(range(len(s2) + 1))
    for i, c1 in enumerate(s1):
        curr_row = [i + 1] * (len(s2) + 1)
        for j, c2 in enumerate(s2):
            cost = 0 if c1 == c2 else 1
            curr_row[j + 1] = min(
                curr_row[j] + 1,
                prev_row[j + 1] + 1,
                prev_row[j] + cost,
            )
        prev_row = curr_row
    return prev_row[len(s2)]


def _sliding_window_levenshtein_ratio(clean_msg: str, asst_tokens: list[str]) -> float:
    """Compute maximum Levenshtein similarity ratio over a sliding token window.

    Tests windows of length M +/- 2 tokens against the assistant utterance tokens.
    Prunes candidate windows whose character length difference alone precludes a ratio >= 0.80.
    """
    m_tokens = len(clean_msg.split())
    a_len = len(asst_tokens)
    msg_len = len(clean_msg)
    if msg_len == 0 or a_len == 0:
        return 0.0

    best_ratio = 0.0
    min_k = max(1, m_tokens - 2)
    max_k = min(a_len, m_tokens + 2)

    for k in range(min_k, max_k + 1):
        for i in range(a_len - k + 1):
            window = " ".join(asst_tokens[i : i + k])
            win_len = len(window)
            max_len = max(msg_len, win_len)
            if max_len == 0:
                continue
            if abs(msg_len - win_len) / max_len > 0.20:
                continue
            dist = _levenshtein_distance(clean_msg, window)
            ratio = 1.0 - (dist / max_len)
            if ratio > best_ratio:
                best_ratio = ratio
                if best_ratio >= 0.80:
                    return best_ratio

    return best_ratio


def _token_ngram_containment(msg_tokens: list[str], asst_tokens: list[str], n: int) -> float:
    """Compute the fraction of caller message n-grams contained in the assistant utterance."""
    if len(msg_tokens) < n or len(asst_tokens) < n:
        return 0.0
    msg_ngrams = [tuple(msg_tokens[i : i + n]) for i in range(len(msg_tokens) - n + 1)]
    asst_ngrams = set(tuple(asst_tokens[j : j + n]) for j in range(len(asst_tokens) - n + 1))
    if not msg_ngrams:
        return 0.0
    matches = sum(1 for ng in msg_ngrams if ng in asst_ngrams)
    return matches / len(msg_ngrams)


def _content_word_overlap(
    msg_tokens: list[str],
    asst_tokens: list[str],
    stop_words: set[str],
) -> tuple[int, float]:
    """Compute content word count and overlap ratio against assistant tokens."""
    content_words = [w for w in msg_tokens if w not in stop_words and len(w) >= 3]
    if not content_words:
        return (0, 0.0)
    asst_words = set(asst_tokens)
    overlap = sum(1 for w in content_words if w in asst_words) / len(content_words)
    return (len(content_words), overlap)


def _is_echo_of_assistant(
    message: str,
    history: list[ChatMessage] | None = None,
    call_id: int | str | None = None,
) -> bool:
    """Detect speaker-feedback echo: the mic re-captured the assistant's TTS.

    Implements a resilient 3-tier detection pipeline:
    - Tier 0: Caller Slot Preservation Shields (Guaranteed NOT echo -> return False):
        1. Callback phone numbers (raw numeric digits >= 7 or spoken digit words >= 7).
        2. Explicit booking confirmations & affirmations.
        3. Standalone / short services (<= 5 words matching canonical HVAC services
           without assistant question scaffolding).
        4. Standalone / short dates & times (<= 5 words containing temporal expressions
           without assistant question scaffolding).
        5. Caller name introductions (excluding Sarah/assistant).
    - Tier 1: Static Assistant Signatures & Scaffolding patterns.
    - Tier 2: Dynamic comparison against recent assistant utterances:
        2A: Exact substring / affix match.
        2B: Normalized Token N-Gram Containment (Cn >= 0.70 on bigrams for len >= 4 words,
            C3 >= 0.66 on trigrams for len >= 3 words).
        2C: Sliding-Window Levenshtein Similarity Ratio (Swin >= 0.80 on windows of
            length M +/- 2 tokens, len >= 12 chars).
        2D: Content-Word Overlap (>= 0.75 for >= 3 content words; or 2-word exact content
            subset without service/time).
    """
    clean_msg = re.sub(r"\s+", " ", re.sub(r"[^a-z0-9\s]", " ", message.lower())).strip()
    if not clean_msg:
        return False

    msg_tokens = clean_msg.split()
    msg_words = [w for w in msg_tokens if len(w) >= 2]
    if not msg_words:
        return False

    # -------------------------------------------------------------------------
    # Tier 0: Caller Slot Preservation Shields (Guaranteed NOT Echo -> return False)
    # -------------------------------------------------------------------------

    # Shield 1: Callback Phone Numbers (raw digits >= 7 or spoken digit words >= 7)
    raw_digits = re.sub(r"\D", "", message)
    spoken_digit_words = {
        "zero", "oh", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
    }
    num_spoken_digits = sum(1 for w in msg_tokens if w in spoken_digit_words)
    recap_lead_ins = (
        "just to confirm",
        "would you like me to book",
        "i have you down for",
        "to confirm that s",
        "to confirm that is",
    )
    is_recap_lead_in = any(clean_msg.startswith(lead) for lead in recap_lead_ins)
    if (len(raw_digits) >= 7 or num_spoken_digits >= 7) and not is_recap_lead_in:
        return False

    # Shield 2: Explicit Booking Confirmations & Affirmations
    if is_explicit_booking_confirmation(message):
        return False

    affirmative_phrases = {
        "yes", "yeah", "yep", "sure", "sounds good", "sounds great",
        "perfect", "okay", "alright", "please", "go ahead", "yes please",
        "yes thank you", "yes thanks", "that works", "that works for me",
        "that sounds good", "that sounds great", "please do", "confirm",
        "confirmed", "absolutely", "definitely", "correct",
    }
    if clean_msg in affirmative_phrases:
        return False

    # Combined assistant scaffolding check: if message contains assistant question/prompt
    # scaffolding, it must NOT be shielded by either the service or date/time shield.
    assistant_scaffolding = {
        "how can i help", "how can i assist", "what service do you need",
        "what service", "service do you need", "thanks for calling",
        "thank you for calling", "can i help with", "can i assist you with",
        "help you schedule", "need help with", "do you need", "would you like",
        "heating or cooling today", "with your heating or cooling",
        "help with your heating", "help with your cooling", "cooling today",
        "heating today", "heating or cooling",
        "i have", "we have", "available", "does that work", "works best for you",
        "what day and time", "what day", "what time", "technician to visit",
        "for our technician", "technician will see you", "openings",
        "would that work", "works for you",
    }
    has_scaffolding = any(scaffold in clean_msg for scaffold in assistant_scaffolding)

    # Shield 3: Standalone / Short Service Selections (<= 5 words without assistant scaffolding)
    canonical_services = {
        "ac repair", "air conditioning repair", "air conditioning", "ac maintenance",
        "cooling repair", "cooling service", "cooling maintenance",
        "heating repair", "furnace repair", "furnace tune up", "furnace tuneup",
        "tune up", "tuneup", "maintenance", "inspection", "heat pump",
        "thermostat replacement", "duct cleaning", "boiler repair",
        "emergency ac repair", "emergency heating repair", "emergency cooling repair", "ac service",
        "heating service", "furnace service", "hvac maintenance", "hvac tune up",
        "furnace maintenance",
    }
    if len(msg_tokens) <= 5 and not has_scaffolding:
        for cs in canonical_services:
            if cs in clean_msg:
                return False

    # Shield 4: Standalone / Short Date & Time Selections (<= 5 words without assistant scaffolding)
    temporal_expressions = {
        "today", "tomorrow", "yesterday", "monday", "tuesday", "wednesday",
        "thursday", "friday", "saturday", "sunday", "morning", "afternoon",
        "evening", "am", "pm", "noon", "o clock", "oclock", "asap", "earliest",
    }
    has_temporal_expr = any(te in clean_msg.split() for te in temporal_expressions)
    if len(msg_tokens) <= 5 and has_temporal_expr and not has_scaffolding:
        return False


    # Shield 5: Caller Name Introductions
    name_intro_match = re.match(
        r"^(?:my name is|i am|i'm|this is|call me|name's|name is)\s+([a-z]+(?:\s+[a-z]+)?)$",
        clean_msg,
    )
    if name_intro_match:
        introduced_name = name_intro_match.group(1).strip()
        if "sarah" not in introduced_name:
            return False
    name_here_match = re.match(r"^([a-z]+(?:\s+[a-z]+)?)\s+here$", clean_msg)
    if name_here_match:
        introduced_name = name_here_match.group(1).strip()
        if "sarah" not in introduced_name:
            return False

    # -------------------------------------------------------------------------
    # Tier 1: Static Assistant Signatures & Scaffolding Patterns
    # -------------------------------------------------------------------------
    signature_asst_patterns = [
        "thank you for calling",
        "thanks for calling",
        "my name is sarah",
        "this is sarah",
        "how can i assist",
        "how can i help",
        "heating or cooling today",
        "with your heating or cooling",
        "what service do you need help with",
        "what is the best callback phone number",
        "what s the best callback phone number",
        "best callback phone number",
        "technician to reach you",
        "technician to reach",
        "technician reach",
        "for our technician",
        "for the technician",
        "callback phone number",
        "best callback phone",
        "callback phone",
        "cooling today",
        "heating today",
        "heating or cooling",
        "how can i help with",
        "help with your heating",
        "tap confirm booking",
        "confirm booking on your screen",
        "would you like me to book it",
        "would you like me to book",
        "i just need a quick yes or no",
        "quick yes or no",
        "confirm your appointment",
        "book your appointment",
        "just to confirm",
        "you re all set",
        "you are all set",
        "our technician will see you then",
        "is there anything else i can help with",
        "is there anything else",
        "what day and time works best",
        "what day works best",
        "what time works best",
        "for our technician to visit",
        "technician to visit",
        "we have openings tomorrow",
        "we have openings",
    ]
    if any(sig in clean_msg for sig in signature_asst_patterns):
        return True

    # -------------------------------------------------------------------------
    # Tier 2: Dynamic Comparison Against Recent Assistant Utterances
    # -------------------------------------------------------------------------
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
        "be", "would", "could", "should", "me", "us", "so", "if",
    }

    for asst_text in assistant_texts:
        clean_asst = re.sub(r"\s+", " ", re.sub(r"[^a-z0-9\s]", " ", asst_text.lower())).strip()
        if not clean_asst:
            continue
        asst_tokens = clean_asst.split()
        if not asst_tokens:
            continue

        # 2A: Exact Substring / Affix Match
        if len(msg_tokens) >= 2:
            if clean_asst.startswith(clean_msg) or clean_asst.endswith(clean_msg):
                return True
        if len(msg_tokens) >= 3 and len(clean_msg) >= 8 and clean_msg in clean_asst:
            return True

        # 2B: Normalized Token N-Gram Containment
        # Cn >= 0.70 for bigrams (len >= 4 words), C3 >= 0.66 for trigrams (len >= 3 words)
        if len(msg_tokens) >= 4:
            c2 = _token_ngram_containment(msg_tokens, asst_tokens, n=2)
            if c2 >= 0.70:
                return True
        if len(msg_tokens) >= 3:
            c3 = _token_ngram_containment(msg_tokens, asst_tokens, n=3)
            if c3 >= 0.66:
                return True

        # 2C: Sliding-Window Levenshtein Similarity Ratio
        # Swin >= 0.80 on windows of length M +/- 2 tokens, len >= 12 chars
        if len(msg_tokens) >= 3 and len(clean_msg) >= 12:
            s_win = _sliding_window_levenshtein_ratio(clean_msg, asst_tokens)
            if s_win >= 0.80:
                return True

        # 2D: Content-Word Overlap (>= 0.75)
        num_content, overlap = _content_word_overlap(msg_tokens, asst_tokens, stop_words)
        if num_content >= 3 and overlap >= 0.75:
            return True

        # 2-word exact content subset: if caller message has exactly 2 content words
        # and both appear in assistant utterance
        if num_content == 2 and overlap == 1.0:
            service_or_time_pattern = re.compile(
                r"\b(ac|air|repair|heating|cooling|tune|tuneup|maintenance|heat|pump|furnace|leak|noise|pipe|duct|thermostat|filter|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|am|pm|morning|afternoon|evening|noon|\d+)\b",
                re.IGNORECASE,
            )
            if not service_or_time_pattern.search(clean_msg):
                return True

    return False





_parse_local_datetime = parse_local_datetime


def _execute_tool(
    settings: Settings,
    name: str,
    args: dict[str, Any],
    call_id: int | str | None = None,
) -> str:
    """Execute real business scheduling tools against SQLite.

    When call_id is provided, a successful tool booking also records an
    already-consumed ConfirmationTicket as a provenance ledger entry. This is
    additive persistence only: it does not change booking behavior or any
    endpoint response.
    """
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
            appointment, message = book_appointment(
                session,
                settings,
                phone_number=phone_number,
                service=service,
                when=when,
                name=caller_name,
                notes=notes,
            )
            if appointment is not None and call_id is not None:
                ledger_now = datetime.now(UTC)
                session.add(
                    ConfirmationTicket(
                        ticket_id=f"tool_{uuid4().hex[:16]}",
                        call_id=str(call_id),
                        service=service,
                        phone=phone_number,
                        scheduled_for=when,
                        fingerprint=booking_confirmation_fingerprint(
                            {
                                "phone": phone_number,
                                "service": service,
                                "date": date_str,
                                "time": time_str,
                            }
                        ),
                        status="consumed",
                        created_at=ledger_now,
                        expires_at=ledger_now,
                        consumed_at=ledger_now,
                        appointment_id=appointment.id,
                    )
                )
                session.flush()
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


def _get_candidate_models(
    primary_model: str, fallback_models: str | None = None
) -> list[str]:
    """Return prioritized candidate models for transparent failover on quota limits.

    When fallback_models is None, the built-in default order is used; otherwise
    it is a comma-separated override (typically Settings.llm_fallback_models).
    """
    supported = (
        [model.strip() for model in fallback_models.split(",") if model.strip()]
        if fallback_models is not None
        else [
            "qwen/qwen3.8-27b",
            "openai/gpt-oss-20b",
            "qwen/qwen3.6-27b",
            "openai/gpt-oss-120b",
        ]
    )
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
    settings: Settings | None = None,
    **kwargs: Any,
) -> Any:
    """Create streaming completion with lowest latency, tool repair, and model failover.

    When settings is provided, the failover list and default max_tokens come
    from configuration; otherwise the previous built-in defaults apply.
    """
    kwargs["max_tokens"] = kwargs.get(
        "max_tokens", settings.llm_max_tokens if settings is not None else 128
    )
    primary_model = kwargs.get("model", "qwen/qwen3.8-27b")
    fallback_models = settings.llm_fallback_models if settings is not None else None
    candidate_models = _get_candidate_models(primary_model, fallback_models)

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

                # Re-emit or mint the active ticket so the frontend renders the Confirm button
                active_ticket_id = slots.get("active_ticket_id")
                ticket_payload: dict[str, object] | None = None
                ticket = None
                if active_ticket_id:
                    def _load_ticket() -> ConfirmationTicket | None:
                        with new_session() as s:
                            t = get_confirmation_ticket(s, str(active_ticket_id))
                            if t and t.status == "pending" and t.expires_at > datetime.now(UTC):
                                return t
                            return None

                    ticket = await asyncio.to_thread(_load_ticket)

                if not ticket:
                    # Mint a fresh ticket if the prior one expired or was lost
                    d_val = slots.get("date")
                    t_val = slots.get("time")
                    parsed_dt = (
                        _parse_local_datetime(settings, str(d_val), str(t_val))
                        if d_val and t_val
                        else None
                    )
                    if parsed_dt is not None:
                        target_dt = parsed_dt
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
                        def _mint_fresh_ticket() -> ConfirmationTicket:
                            with new_session() as s:
                                return create_confirmation_ticket(
                                    s,
                                    call_id=active_call_id,
                                    service=verified_service,
                                    phone=verified_phone,
                                    scheduled_for=target_dt,
                                    fingerprint=current_fp,
                                    ttl_seconds=300,
                                )
                        ticket = await asyncio.to_thread(_mint_fresh_ticket)
                        await asyncio.to_thread(
                            update_call_slots,
                            active_call_id,
                            {"active_ticket_id": ticket.ticket_id},
                        )

                if ticket:
                    tz = ZoneInfo(settings.business_timezone)
                    local_dt = ticket.scheduled_for.astimezone(tz)
                    delta = ticket.expires_at - datetime.now(UTC)
                    remaining = max(0, int(delta.total_seconds()))
                    ticket_payload = {
                        "ticket_id": ticket.ticket_id,
                        "service": ticket.service,
                        "phone": ticket.phone,
                        "date": local_dt.strftime("%Y-%m-%d"),
                        "time": local_dt.strftime("%I:%M %p"),
                        "fingerprint": ticket.fingerprint,
                        "expires_in_seconds": remaining,
                    }

                async def tap_prompt_generator() -> AsyncIterator[str]:
                    yield f"event: delta\ndata: {json.dumps({'text': guidance})}\n\n"
                    if ticket_payload:
                        yield f"event: confirmation_ticket\ndata: {json.dumps(ticket_payload)}\n\n"
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
                "settings": settings,
                "model": settings.llm_model,
                "messages": messages,
                "temperature": 0.1,
                "max_tokens": settings.llm_max_tokens,
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
                    tool_result = await asyncio.to_thread(
                        _execute_tool, settings, name, args, active_call_id
                    )

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
                    settings=settings,
                    model=settings.llm_model,
                    messages=messages,
                    temperature=0.1,
                    max_tokens=settings.llm_max_tokens,
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
