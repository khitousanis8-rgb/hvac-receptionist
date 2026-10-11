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
    check_slot_availability,
    format_available_slot_for_speech,
    parse_local_datetime,
    reschedule_appointment_by_phone,
    resolve_canonical_service,
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
        matched_service = resolve_canonical_service(service, settings.business_services)
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


@function_tool
async def check_availability(
    context: RunContext[None],
    date: str,
    time: str | None = None,
    service: str | None = None,
) -> str:
    """Check if a date and time slot is available for service, or find available openings.

    Args:
        date: Appointment date in YYYY-MM-DD or spoken format (e.g. tomorrow, Monday).
        time: Optional start time in HH:MM or 12h format (e.g. 10:00 AM, 02:00 PM).
        service: Optional requested HVAC service.
        context: Injected run context.
    """
    settings = get_settings()
    with new_session() as session:
        is_avail, message, alternatives = check_slot_availability(
            session,
            settings,
            date_str=date,
            time_str=time,
            service=service,
        )
        if is_avail:
            if alternatives:
                alt_strs = [
                    format_available_slot_for_speech(sl, settings) for sl in alternatives
                ]
                return f"{message} Available times include: {', '.join(alt_strs)}."
            return message
        if alternatives:
            alt_strs = [
                format_available_slot_for_speech(sl, settings) for sl in alternatives[:2]
            ]
            if len(alt_strs) == 1:
                return f"{message} Nearest available opening is {alt_strs[0]}."
            return f"{message} Nearest available openings are {alt_strs[0]} and {alt_strs[1]}."
        return message


def build_receptionist_tools(settings: Settings) -> list[Any]:
    """Return the function tools registered on the receptionist agent."""
    init_db()
    return [
        check_availability,
        book_appointment_tool,
        reschedule_appointment_tool,
        cancel_appointment_tool,
    ]