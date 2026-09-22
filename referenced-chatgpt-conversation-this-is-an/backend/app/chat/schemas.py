"""Transport schemas extracted verbatim from app.chat_api.

Field names, optionality, patterns, bounds, and validators are unchanged.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.call_tracking import ClientTelemetry


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


class TranscribeRequest(BaseModel):
    audio_base64: str = Field(
        max_length=5_000_000, description="Base64-encoded audio bytes"
    )
    content_type: str = Field(default="audio/webm", max_length=64)
    filename: str = Field(default="audio.webm", max_length=64)


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
