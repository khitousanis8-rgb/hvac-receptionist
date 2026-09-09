"""Chat and voice streaming API router for in-browser client sessions."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any, Literal
from zoneinfo import ZoneInfo

import structlog
from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from openai import AsyncOpenAI
from pydantic import BaseModel, Field

from app.agent.prompts import receptionist_instructions
from app.call_tracking import end_call, start_call
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


def _parse_local_datetime(settings: Settings, date_str: str, time_str: str) -> datetime | None:
    try:
        return datetime.fromisoformat(f"{date_str}T{time_str}").replace(
            tzinfo=ZoneInfo(settings.business_timezone)
        )
    except (ValueError, TypeError):
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
    ):
        return True
    return False


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

    system_content = receptionist_instructions(settings)
    messages: list[dict[str, Any]] = [{"role": "system", "content": system_content}]
    # Cap history to the last 10 messages (~5 turns) to keep Groq input
    # short and avoid free-tier rate limits (12K TPM, 30 RPM).
    recent_history = req.history[-10:] if len(req.history) > 10 else req.history
    for msg in recent_history:
        messages.append({"role": msg.role, "content": msg.content})
    messages.append({"role": "user", "content": req.message})

    is_polite_closing = _is_closing_or_polite_remark(req.message)
    tools_to_use = None if is_polite_closing else TOOLS

    async def sse_generator():
        outcome = "info_only"
        try:
            # First pass: request streaming chat completion with tools
            response = await client.chat.completions.create(
                model=settings.llm_model,
                messages=messages,
                tools=tools_to_use,
                tool_choice="auto" if tools_to_use else None,
                stream=True,
            )

            tool_calls_accumulator: dict[int, dict[str, Any]] = {}
            streamed_content = ""

            async for chunk in response:
                delta = chunk.choices[0].delta if chunk.choices else None
                if not delta:
                    continue

                if delta.content:
                    streamed_content += delta.content
                    yield f"event: delta\ndata: {json.dumps({'text': delta.content})}\n\n"

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

            # If the model requested tools: execute them and stream the final answer
            if tool_calls_accumulator:
                messages.append(
                    {
                        "role": "assistant",
                        "content": streamed_content or None,
                        "tool_calls": [
                            {
                                "id": tc["id"] or f"call_{i}",
                                "type": "function",
                                "function": {
                                    "name": tc["name"],
                                    "arguments": tc["arguments"],
                                },
                            }
                            for i, tc in tool_calls_accumulator.items()
                        ],
                    }
                )

                for i, tc in tool_calls_accumulator.items():
                    name = tc["name"]
                    try:
                        args = json.loads(tc["arguments"])
                    except Exception:
                        args = {}

                    logger.info("executing_chat_tool", tool=name, args=args)
                    tool_result = _execute_tool(settings, name, args)
                    if name == "book_appointment_tool" and ("booked" in tool_result.lower() or "confirmed" in tool_result.lower()):
                        outcome = "booked"

                    yield f"event: tool_call\ndata: {json.dumps({'name': name, 'result': tool_result})}\n\n"

                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": tc["id"] or f"call_{i}",
                            "content": tool_result,
                        }
                    )

                # Second stream: generate voice reply based on tool execution result
                second_response = await client.chat.completions.create(
                    model=settings.llm_model,
                    messages=messages,
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
