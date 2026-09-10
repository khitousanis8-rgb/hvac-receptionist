"""Business-hours-aware scheduling with conflict-free slot booking."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from datetime import time as dt_time
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import Settings
from app.db import Appointment, Customer

SLOT_MINUTES = 60
BOOKABLE_STATUSES = ("booked",)


def _parse_hhmm(value: str) -> dt_time:
    hour, minute = value.split(":")
    return dt_time(int(hour), int(minute))


def is_within_business_hours(when: datetime, settings: Settings) -> bool:
    """Check a timezone-aware datetime against the configured opening hours."""
    local = when.astimezone(ZoneInfo(settings.business_timezone))
    day_name = local.strftime("%A").lower()
    window = settings.business_opening_hours.get(day_name, "closed")
    if not window or window.lower() == "closed":
        return False
    start_s, end_s = window.split("-")
    start = _parse_hhmm(start_s)
    end = _parse_hhmm(end_s)
    local_minutes = local.hour * 60 + local.minute
    start_minutes = start.hour * 60 + start.minute
    end_minutes = end.hour * 60 + end.minute
    if end_s == "24:00":
        end_minutes = 24 * 60
    return start_minutes <= local_minutes and local_minutes + SLOT_MINUTES <= end_minutes


def has_conflict(session: Session, when: datetime) -> bool:
    """True if an active appointment already overlaps the requested slot."""
    slot_end = when + timedelta(minutes=SLOT_MINUTES)
    earliest_overlap = when - timedelta(minutes=SLOT_MINUTES)
    existing = (
        session.query(Appointment)
        .filter(
            Appointment.status.in_(BOOKABLE_STATUSES),
            Appointment.scheduled_for < slot_end,
            Appointment.scheduled_for > earliest_overlap,
        )
        .first()
    )
    return existing is not None


def normalize_phone_number(raw: str) -> str:
    """Normalize phone number to digits or standard format (+1XXXXXXXXXX)."""
    if not raw:
        return ""
    digits = "".join(c for c in raw if c.isdigit())
    if len(digits) == 10:
        return f"+1{digits}"
    if len(digits) == 11 and digits.startswith("1"):
        return f"+{digits}"
    if raw.startswith("+"):
        return f"+{digits}"
    return digits or raw.strip()


def get_or_create_customer(
    session: Session,
    phone_number: str,
    name: str | None = None,
) -> Customer:
    """Find a customer by phone number, creating a record when unknown."""
    normalized = normalize_phone_number(phone_number)
    customer = (
        session.query(Customer)
        .filter(
            (Customer.phone_number == normalized)
            | (Customer.phone_number == phone_number)
        )
        .one_or_none()
    )
    safe_name = name[:100].strip() if name else None
    if customer is None:
        customer = Customer(phone_number=normalized or phone_number, name=safe_name)
        session.add(customer)
        session.flush()
    elif safe_name and not customer.name:
        customer.name = safe_name
    return customer


def book_appointment(
    session: Session,
    settings: Settings,
    phone_number: str,
    service: str,
    when: datetime,
    name: str | None = None,
    notes: str | None = None,
) -> tuple[Appointment | None, str]:
    """Book an appointment, enforcing business hours and conflicts.

    Returns (appointment, message). appointment is None when booking fails.
    """
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    if when < datetime.now(UTC):
        return None, "That time is in the past. Please choose a future time."
    if not is_within_business_hours(when, settings):
        return None, (
            "That time is outside business hours. Please choose a time during opening hours."
        )
    customer = get_or_create_customer(session, phone_number, name)

    slot_end = when + timedelta(minutes=SLOT_MINUTES)
    earliest_overlap = when - timedelta(minutes=SLOT_MINUTES)
    existing_same_customer = (
        session.query(Appointment)
        .filter(
            Appointment.customer_id == customer.id,
            Appointment.status.in_(BOOKABLE_STATUSES),
            Appointment.scheduled_for < slot_end,
            Appointment.scheduled_for > earliest_overlap,
        )
        .first()
    )
    if existing_same_customer is not None:
        local_time = when.astimezone(ZoneInfo(settings.business_timezone)).strftime("%I:%M %p").lstrip("0")
        return (
            existing_same_customer,
            f"Appointment is already confirmed for {existing_same_customer.service} at {local_time}."
        )

    existing_other = (
        session.query(Appointment)
        .filter(
            Appointment.customer_id != customer.id,
            Appointment.status.in_(BOOKABLE_STATUSES),
            Appointment.scheduled_for < slot_end,
            Appointment.scheduled_for > earliest_overlap,
        )
        .first()
    )
    if existing_other is not None:
        return None, "That slot is already taken. Please choose another time."

    safe_notes = notes[:500].strip() if notes else None
    appointment = Appointment(
        customer_id=customer.id,
        service=service[:100].strip(),
        scheduled_for=when,
        notes=safe_notes,
    )
    try:
        # The pre-check above makes the usual path friendly; the partial unique
        # index is the authoritative protection when two callers race to book.
        with session.begin_nested():
            session.add(appointment)
            session.flush()
    except IntegrityError:
        return None, "That slot was just taken. Please choose another time."
    return appointment, f"Booked {service} at {when.isoformat()}"


def list_upcoming(session: Session, phone_number: str) -> list[Appointment]:
    """Return future active appointments for a customer phone number."""
    now = datetime.now(UTC)
    normalized = normalize_phone_number(phone_number)
    return list(
        session.execute(
            select(Appointment)
            .join(Customer)
            .where(
                (Customer.phone_number == normalized) | (Customer.phone_number == phone_number),
                Appointment.scheduled_for >= now,
                Appointment.status == "booked",
            )
            .order_by(Appointment.scheduled_for)
        ).scalars()
    )
