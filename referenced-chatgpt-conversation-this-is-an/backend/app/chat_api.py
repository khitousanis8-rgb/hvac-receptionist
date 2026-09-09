"""Chat and voice streaming API router for in-browser client sessions."""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from zoneinfo import ZoneInfo

import structlog
from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from openai import AsyncOpenAI
from pydantic import BaseModel, Field

from app.agent.prompts import receptionist_instructions
from app.call_tracking import (
    end_call,
    get_or_create_session_slots,
    start_call,
    update_call_phone,
    update_session_slots,
)
from app.config import Settings, get_settings
from app.db import new_session
from app.scheduling import book_appointment, list_upcoming

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/v1/calls", tags=["calls"])

_client: AsyncOpenAI | None = None


def _get_client(settings: Settings) -> AsyncOpenAI:
    global _client
    if _client is None:
        _client = AsyncOpenAI(
            api_key=settings.llm_api_key.get_secret_value(),
            base_url=str(settings.llm_base_url),
        )
    return _client


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ChatRequest(BaseModel):
    session_id: str = Field(max_length=64)
    message: str = Field(max_length=4000)
    history: list[ChatMessage] = Field(default_factory=list)


class EndCallRequest(BaseModel):
    session_id: str = Field(max_length=64)
    call_id: int | None = None
    outcome: str = Field(default="info_only", pattern="^(booked|info_only)$")
    summary: str | None = Field(default=None, max_length=2000)


def _extract_slots_from_text(text: str, current_slots: dict[str, Any]) -> dict[str, Any]:
    """Lightweight rule-based extractor to update known slots from user utterances."""
    updates: dict[str, Any] = {}
    lower = text.lower().strip()

    # 1. Name extraction
    name_patterns = [
        r"(?:my name is|i am|i'm|this is|call me|name's|name is)\s+([A-Za-z]+(?:\s+[A-Za-z]+)?)",
        r"^([A-Za-z]+(?:\s+[A-Za-z]+)?)\s+here",
    ]
    for pattern in name_patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            candidate = match.group(1).strip()
            if candidate.lower() not in {
                "sarah", "calling", "good", "okay", "yes", "no", "looking",
                "interested", "repair", "service", "ac", "heating", "cooling",
            }:
                updates["name"] = candidate
                break

    # 2. Phone extraction (handles spoken digit words: 'plus 1 2 3 0 ...' or '555-123-4567')
    digit_map = {
        "zero": "0", "one": "1", "two": "2", "three": "3", "four": "4",
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

    # 3. Service extraction
    if any(k in lower for k in ["ac", "air condition", "cooling", "cool", "heat pump", "cold"]):
        updates["service"] = "AC repair"
    elif any(k in lower for k in ["furnace", "heating", "heater", "boiler", "warm"]):
        updates["service"] = "Heating repair"
    elif any(k in lower for k in ["tuneup", "tune up", "tune-up", "maintenance", "inspection"]):
        updates["service"] = "HVAC tune-up"

    # 4. Date/Time extraction heuristics
    if any(k in lower for k in ["tomorrow", "today", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]):
        time_match = re.search(
            r"(tomorrow|today|next \w+|\w+day)?\s*(?:at)?\s*(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?|\b))",
            lower,
        )
        if time_match:
            updates["time"] = time_match.group(0).strip()
        elif "tomorrow" in lower:
            updates["date"] = "tomorrow"

    return updates


def _parse_local_datetime(settings: Settings, date_str: str, time_str: str) -> datetime | None:
    tz = ZoneInfo(settings.business_timezone)
    now = datetime.now(tz)

    clean_date = date_str.lower().strip()
    clean_time = time_str.strip()

    if clean_date == "tomorrow":
        target_date = (now + timedelta(days=1)).strftime("%Y-%m-%d")
    elif clean_date == "today":
        target_date = now.strftime("%Y-%m-%d")
    else:
        target_date = clean_date

    # Try direct ISO parsing first
    try:
        return datetime.fromisoformat(f"{target_date}T{clean_time}").replace(tzinfo=tz)
    except (ValueError, TypeError):
        pass

    # Try common formats like "%I:%M %p", "%I %p", "%H:%M"
    # Normalize clean_time (remove periods in a.m. / p.m.)
    norm_time = clean_time.replace(".", "").strip()
    for fmt in ("%I:%M %p", "%I:%M%p", "%I %p", "%I%p", "%H:%M", "%H:%M:%S"):
        try:
            parsed_t = datetime.strptime(norm_time, fmt).time()
            dt_base = datetime.strptime(target_date, "%Y-%m-%d")
            return datetime.combine(dt_base.date(), parsed_t, tzinfo=tz)
        except ValueError:
            continue

    return None


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
                f"{appt.scheduled_for.strftime('%B %d at %I:%M %p')}: {appt.service} ({appt.status})"
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
                if normalized_requested == clean_app or normalized_requested in clean_app or clean_app in normalized_requested:
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
            "description": "Book an HVAC service appointment during business hours once phone, service, date, and time are confirmed.",
            "parameters": {
                "type": "object",
                "properties": {
                    "phone_number": {"type": "string", "description": "The caller's phone number"},
                    "service": {"type": "string", "description": "One of the approved HVAC services"},
                    "date": {"type": "string", "description": "Appointment date in YYYY-MM-DD format"},
                    "time": {"type": "string", "description": "Appointment start time in HH:MM 24h format"},
                    "name": {"type": "string", "description": "Caller name if provided"},
                    "notes": {"type": "string", "description": "Optional notes or equipment issue description"},
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
                    "phone_number": {"type": "string", "description": "The caller's phone number"},
                },
                "required": ["phone_number"],
            },
        },
    },
]


def _is_closing_or_polite_remark(text: str) -> bool:
    """Check if caller is merely expressing gratitude, acknowledging, or saying goodbye."""
    cleaned = "".join(c for c in text.lower() if c.isalnum() or c.isspace()).strip()
    polite_exact = {
        "ok", "okay", "alright", "all right", "got it", "perfect", "great",
        "cool", "understood", "sounds good", "sounds great",
        "thank you", "thanks", "thank you so much", "thanks so much",
        "thank you very much", "thanks a lot", "many thanks",
        "bye", "goodbye", "bye bye", "have a good day", "have a great day",
        "no", "no that is all", "no thats all", "no thank you", "no thanks",
        "that is all", "thats all", "that is it", "thats it", "nope",
        "nothing else", "i am good", "im good", "all good",
        "perfect thank you", "great thank you", "ok thank you", "okay thank you",
        "ok thanks", "okay thanks",
        "sounds good thank you", "sounds great thank you", "take care",
    }
    if cleaned in polite_exact:
        return True
    if len(cleaned) < 30 and (
        cleaned.startswith("thank")
        or cleaned.startswith("bye")
        or cleaned.startswith("no thank")
        or cleaned.startswith("thats all")
        or cleaned.startswith("that is all")
        or cleaned in {"ok", "okay", "alright", "all right"}
    ):
        return True
    return False


async def _create_stream_completion(
    client: AsyncOpenAI,
    **kwargs: Any,
) -> Any:
    """Create streaming completion with reasoning_effort='none' for fast voice latency, falling back if unsupported."""
    try:
        return await client.chat.completions.create(
            **kwargs,
            extra_body={"reasoning_effort": "none"},
        )
    except Exception as e:
        logger.warning("completion_fallback_without_reasoning_effort", error=str(e))
        return await client.chat.completions.create(**kwargs)


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
        call_id = start_call(req.session_id)

        async def greeting_generator():
            yield f"event: call_started\ndata: {json.dumps({'call_id': call_id})}\n\n"
            yield f"event: delta\ndata: {json.dumps({'text': greeting_text})}\n\n"
            yield f"event: done\ndata: {json.dumps({'outcome': 'info_only', 'call_id': call_id})}\n\n"

        return StreamingResponse(
            greeting_generator(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    if not settings.llm_api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="LLM credentials are not configured on the server.",
        )

    client = _get_client(settings)

    # 1. Update and retrieve persistent session slots (immune to sliding window eviction)
    slots = get_or_create_session_slots(req.session_id)
    new_slots = _extract_slots_from_text(req.message, slots)
    if new_slots:
        slots = update_session_slots(req.session_id, new_slots)

    # 2. Dynamic prompt grounding with verified slots
    system_content = receptionist_instructions(settings, slots=slots)
    messages: list[dict[str, Any]] = [{"role": "system", "content": system_content}]

    # Cap history to the last 30 messages (~15 turns) to retain deep conversational nuances
    recent_history = req.history[-30:] if len(req.history) > 30 else req.history
    for msg in recent_history:
        messages.append({"role": msg.role, "content": msg.content})
    messages.append({"role": "user", "content": req.message})

    # 3. Tool Choice & Gating
    is_polite_closing = _is_closing_or_polite_remark(req.message)
    is_reschedule_or_check = any(
        kw in req.message.lower()
        for kw in ["change", "reschedule", "cancel", "check", "different time", "another time", "update"]
    )
    if is_polite_closing or (slots.get("confirmed") and not is_reschedule_or_check):
        tools_to_use = None
    else:
        tools_to_use = TOOLS

    # Check if caller is confirming booking details and all prerequisites are known
    cleaned_msg = "".join(c for c in req.message.lower() if c.isalnum() or c.isspace()).strip()
    is_affirmative = any(
        w in cleaned_msg.split()
        for w in ["yes", "yeah", "yep", "correct", "perfect", "sure", "book", "booked"]
    ) or any(
        phrase in cleaned_msg
        for phrase in ["sounds good", "sounds great", "please book", "go ahead", "that works"]
    )
    has_booking_prereqs = bool(
        slots.get("phone")
        and slots.get("service")
        and (slots.get("time") or slots.get("date"))
    )

    if tools_to_use and has_booking_prereqs and is_affirmative and not slots.get("confirmed"):
        tool_choice_to_use: Any = {"type": "function", "function": {"name": "book_appointment_tool"}}
    else:
        tool_choice_to_use = "auto" if tools_to_use else None

    async def sse_generator():
        outcome = "info_only"
        try:
            # First pass: request streaming chat completion with tools
            response = await _create_stream_completion(
                client=client,
                model=settings.llm_model,
                messages=messages,
                tools=tools_to_use,
                tool_choice=tool_choice_to_use,
                temperature=0.1,
                max_tokens=200,
                stop=["\nuser:", "\nUser:", "\ncaller:", "\nCaller:"],
                stream=True,
            )

            tool_calls_accumulator: dict[int, dict[str, Any]] = {}
            streamed_content = ""

            async for chunk in response:
                delta = chunk.choices[0].delta if chunk.choices else None
                if not delta:
                    continue

                if delta.tool_calls:
                    for tc in delta.tool_calls:
                        idx = tc.index
                        if idx not in tool_calls_accumulator:
                            tool_calls_accumulator[idx] = {
                                "id": tc.id or "",
                                "name": tc.function.name if tc.function and tc.function.name else "",
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

                    logger.info("executing_chat_tool", tool=name, args=args)
                    tool_result = _execute_tool(settings, name, args)
                    if name == "book_appointment_tool" and ("booked" in tool_result.lower() or "confirmed" in tool_result.lower()):
                        outcome = "booked"
                        update_session_slots(req.session_id, {"confirmed": True})
                        if args.get("phone_number"):
                            update_call_phone(req.session_id, str(args["phone_number"]))

                    yield f"event: tool_call\ndata: {json.dumps({'name': name, 'result': tool_result})}\n\n"

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

            yield f"event: done\ndata: {json.dumps({'outcome': outcome})}\n\n"

        except Exception as e:
            logger.error("chat_stream_error", error=str(e))
            yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(
        sse_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


class TranscribeRequest(BaseModel):
    audio_base64: str = Field(description="Base64-encoded audio bytes")
    content_type: str = Field(default="audio/webm")
    filename: str = Field(default="audio.webm")


@router.post("/transcribe")
async def transcribe_audio(req: TranscribeRequest) -> dict[str, str]:
    """Transcribe caller audio using Groq Whisper API (free tier, ~200ms turnaround)."""
    settings = get_settings()
    if not settings.llm_api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="LLM API key not configured.",
        )

    import base64

    try:
        audio_bytes = base64.b64decode(req.audio_base64)
    except Exception:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid base64 audio data")

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
        )


@router.post("/end")
async def end_call_record(req: EndCallRequest) -> dict[str, Any]:
    """Finalize call record in SQLite."""
    if req.call_id:
        end_call(req.call_id, req.outcome, req.summary)
    return {"status": "ok", "call_id": req.call_id, "outcome": req.outcome}
