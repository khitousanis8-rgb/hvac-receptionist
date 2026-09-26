"""LiveKit function tools that let the agent book and look up appointments."""

from __future__ import annotations

from typing import Any

import structlog
from livekit.agents import RunContext, function_tool

from app.config import Settings, get_settings
from app.db import init_db, new_session
from app.scheduling import (
    book_appointment,
    cancel_appointment_by_phone,
    parse_local_datetime,
    reschedule_appointment_by_phone,
)

logger = structlog.get_logger(__name__)

_parse_local_datetime = parse_local_datetime


@function_tool
async def check_my_appointments(
    context: RunContext[None],
    phone_number: str,
) -> str:
    """Neutral privacy fallback: appointment details cannot be disclosed anonymously."""
    return (
        "For privacy and security, appointment details cannot be looked up or disclosed "
        "over this channel with just a phone number. I can help arrange a new service visit, "
        "or you can manage existing appointments through our verified customer portal."
    )


@function_tool
async def book_appointment_tool(
    context: RunContext[None],
    phone_number: str,
    service: str,
    date: str,
    time: str,
    name: str | None = None,
    notes: str | None = None,
) -> str:
    """Book an HVAC service appointment during business hours.

    Args:
        phone_number: The caller's phone number, e.g. +15555550100.
        service: One of the approved services offered by the company.
        date: Appointment date in YYYY-MM-DD format.
        time: Appointment start time in HH:MM (24h) local business time.
        name: The caller's name, if they provided one.
        notes: Optional description of the issue.
        context: Injected run context.
    """
    settings = get_settings()
    # Validate service against approved services list when configured
    if settings.business_services:
        normalized_requested = service.strip().lower()
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

    when = _parse_local_datetime(settings, date, time)
    if when is None:
        return "I could not understand that date or time. Please repeat it."

    with new_session() as session:
        _appointment, message = book_appointment(
            session,
            settings,
            phone_number=phone_number,
            service=service,
            when=when,
            name=name,
            notes=notes,
        )
        return message


@function_tool
async def reschedule_appointment_tool(
    context: RunContext[None],
    phone_number: str,
    date: str,
    time: str,
) -> str:
    """Reschedule an existing appointment to a new date and time.

    Args:
        phone_number: The caller's callback phone number.
        date: New appointment date in YYYY-MM-DD or relative format.
        time: New appointment start time in HH:MM (24h) local business time.
        context: Injected run context.
    """
    settings = get_settings()
    when = _parse_local_datetime(settings, date, time)
    if when is None:
        return "I could not understand that date or time. Please repeat it."

    with new_session() as session:
        _appointment, message = reschedule_appointment_by_phone(
            session,
            settings,
            phone_number=phone_number,
            new_when=when,
        )
        return message


@function_tool
async def cancel_appointment_tool(
    context: RunContext[None],
    phone_number: str,
) -> str:
    """Cancel an existing upcoming appointment.

    Args:
        phone_number: The caller's callback phone number.
        context: Injected run context.
    """
    with new_session() as session:
        _appointment, message = cancel_appointment_by_phone(
            session,
            phone_number=phone_number,
        )
        return message


def build_receptionist_tools(settings: Settings) -> list[Any]:
    """Return the function tools registered on the receptionist agent."""
    init_db()
    return [book_appointment_tool, reschedule_appointment_tool, cancel_appointment_tool]