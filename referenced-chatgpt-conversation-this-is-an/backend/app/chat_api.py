"""Chat and voice streaming API router for in-browser client sessions."""

from __future__ import annotations

import json
import re
import threading
import time
from collections.abc import AsyncIterator
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


def _is_assistant_echo(text: str) -> bool:
    """Detect if caller input is an echo of assistant speech picked up by mic."""
    clean = text.lower().strip()
    echo_markers = [
        "how can i assist you",
        "how can i help you with your heating",
        "thank you for calling",
        "my name is sarah",
        "heating or cooling today",
        "example hvac",
        "how can i assist you with",
    ]
    return any(marker in clean for marker in echo_markers)


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

    phone_match = re.search(r"(\+?\s*[\d\s\-\.\(\)]{8,}\d)", normalized_for_phone)
    if phone_match:
        matched_str = phone_match.group(1)
        raw_digits = re.sub(r"[^\d]", "", matched_str)
        if len(raw_digits) >= 10:
            prefix = "+" if "+" in matched_str else ""
            updates["phone"] = f"{prefix}{raw_digits}"

    # 3. Service extraction (use word boundaries to prevent matching 'actually', 'package', etc.)
    if re.search(r"\b(a/?c|air\s*condition(?:ing)?|cooling|cool)\b", lower):
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


TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "book_appointment_tool",
            "description": (
                "Book an HVAC service appointment during business hours once "
                "phone, service, date, and time are confirmed."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "phone_number": {
                        "type": "string",
                        "description": "The caller's phone number",
                    },
                    "service": {
                        "type": "string",
                        "description": "One of the approved HVAC services",
                    },
                    "date": {
                        "type": "string",
                        "description": "Appointment date in YYYY-MM-DD format",
                    },
                    "time": {
                        "type": "string",
                        "description": "Appointment start time in HH:MM 24h format",
                    },
                    "name": {"type": "string", "description": "Caller name if provided"},
                    "notes": {
                        "type": "string",
                        "description": "Optional notes or equipment issue description",
                    },
                },
                "required": ["phone_number", "service", "date", "time"],
            },
        },
    },
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
            fallback_kwargs["tools"] = TOOLS
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
                fallback_kwargs["tools"] = TOOLS
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
    # Ensure sufficient token budget so internal reasoning never starves conversational tokens
    kwargs["max_tokens"] = max(kwargs.get("max_tokens", 200), 500)
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
                repair_kwargs["tools"] = TOOLS
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
            f"Thank you for calling {settings.business_company_name}! "
            f"My name is Sarah. How can I assist you with your heating or cooling today?"
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

    if req.call_id is None or not is_authorized_active_call(
        req.call_id, req.session_id, req.call_secret
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This call session is invalid or has already ended.",
        )
    active_call_id: int = req.call_id

    # Detect acoustic echo of assistant's greeting picked up by microphone
    if _is_assistant_echo(req.message):
        async def echo_recovery_generator() -> AsyncIterator[str]:
            recovery_text = (
                "I'm right here! How can I assist you with your heating or cooling today?"
            )
            yield f"event: delta\ndata: {json.dumps({'text': recovery_text})}\n\n"
            yield f"event: done\ndata: {json.dumps({'outcome': 'info_only'})}\n\n"

        return StreamingResponse(
            echo_recovery_generator(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    if not settings.llm_api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="LLM credentials are not configured on the server.",
        )

    client = _get_client(settings)

    # 1. Update and retrieve durable session slots bound to this exact call.
    slots = get_call_slots(active_call_id)
    new_slots = _extract_slots_from_text(req.message, slots)
    if new_slots:
        slots = update_call_slots(active_call_id, new_slots)
        if phone := new_slots.get("phone"):
            update_call_phone(active_call_id, str(phone))

    # 2. Dynamic prompt grounding with verified slots
    system_content = receptionist_instructions(settings, slots=slots)
    messages: list[dict[str, Any]] = [{"role": "system", "content": system_content}]

    # Cap history to the last 30 messages (~15 turns) to retain deep conversational nuances
    recent_history = req.history[-30:] if len(req.history) > 30 else req.history
    for msg in recent_history:
        if msg.role == "user" and _is_assistant_echo(msg.content):
            continue
        messages.append({"role": msg.role, "content": msg.content})
    messages.append({"role": "user", "content": req.message})

    # Check if caller is confirming booking details and all prerequisites are known
    cleaned_msg = "".join(c for c in req.message.lower() if c.isalnum() or c.isspace()).strip()
    is_affirmative = any(
        w in cleaned_msg.split()
        for w in ["yes", "yeah", "yep", "correct", "perfect", "sure", "book", "booked"]
    ) or any(
        phrase in cleaned_msg
        for phrase in [
            "sounds good",
            "sounds great",
            "please book",
            "go ahead",
            "that works",
            "thats fine",
            "that is fine",
        ]
    )
    has_booking_prereqs = bool(
        slots.get("phone")
        and slots.get("service")
        and (slots.get("time") or slots.get("date"))
    )
    is_confirming_now = has_booking_prereqs and is_affirmative and not slots.get("confirmed")

    # 3. Tool Choice & Gating
    is_polite_closing = False if is_confirming_now else _is_closing_or_polite_remark(req.message)
    is_reschedule_or_check = any(
        kw in req.message.lower()
        for kw in [
            "change",
            "reschedule",
            "cancel",
            "check",
            "different time",
            "another time",
            "update",
        ]
    )
    if is_polite_closing or (slots.get("confirmed") and not is_reschedule_or_check):
        tools_to_use = None
    else:
        tools_to_use = TOOLS

    if is_confirming_now:
        tool_choice_to_use: str | None = "required"
    else:
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
                "max_tokens": 200,
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

            # If the model requested tools: execute them and stream the final answer
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
                    tool_result = _execute_tool(settings, name, args)
                    if name == "book_appointment_tool" and (
                        "booked" in tool_result.lower() or "confirmed" in tool_result.lower()
                    ):
                        outcome = "booked"
                        update_call_slots(active_call_id, {"confirmed": True})
                        update_call_outcome(active_call_id, "booked")
                        if args.get("phone_number"):
                            update_call_phone(active_call_id, str(args["phone_number"]))

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
                    max_tokens=200,
                    stop=["\nuser:", "\nUser:", "\ncaller:", "\nCaller:"],
                    stream=True,
                )

                async for chunk in second_response:
                    delta = chunk.choices[0].delta if chunk.choices else None
                    if delta and delta.content:
                        yield f"event: delta\ndata: {json.dumps({'text': delta.content})}\n\n"

            else:
                # Deterministic Safety Interceptor:
                # If the LLM claimed the appointment is booked/confirmed in conversational text
                # without invoking book_appointment_tool, execute the booking deterministically
                # so the caller's booking is never a phantom hallucination!
                is_claiming_booked = any(
                    phrase in streamed_content.lower()
                    for phrase in [
                        "is confirmed", "has been confirmed", "have confirmed",
                        "is scheduled", "has been scheduled", "have scheduled",
                        "is all set", "all set for", "we look forward to helping you tomorrow",
                    ]
                )
                if is_claiming_booked and not slots.get("confirmed") and has_booking_prereqs:
                    logger.warning(
                        "anti_hallucination_auto_booking",
                        session_id=req.session_id,
                        present_slots=sorted(key for key, value in slots.items() if value),
                    )
                    cust_name = slots.get("name") or "Caller"
                    cust_phone = slots.get("phone") or ""
                    cust_service = slots.get("service") or "AC repair"
                    cust_date = slots.get("date")
                    cust_time = slots.get("time")
                    if cust_date and cust_time:
                        booking_result = _execute_tool(
                            settings,
                            "book_appointment_tool",
                            {
                                "name": cust_name,
                                "phone_number": cust_phone,
                                "service": cust_service,
                                "date": str(cust_date),
                                "time": str(cust_time),
                            },
                        )
                        if (
                            "booked" in booking_result.lower()
                            or "confirmed" in booking_result.lower()
                        ):
                            outcome = "booked"
                            update_call_slots(active_call_id, {"confirmed": True})
                            update_call_outcome(active_call_id, "booked")
                            if cust_phone:
                                update_call_phone(active_call_id, str(cust_phone))
                    else:
                        logger.warning("booking_claim_rejected_missing_canonical_datetime")

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
    finalized = end_browser_call(
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
