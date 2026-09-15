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
    if end_s == "24:00":
        end_minutes = 24 * 60
    else:
        end = _parse_hhmm(end_s)
        end_minutes = end.hour * 60 + end.minute
    local_minutes = local.hour * 60 + local.minute
    start_minutes = start.hour * 60 + start.minute
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


def normalize_nanp_phone(raw: str) -> str | None:
    """Normalize and strictly validate a 10-digit North American phone number.

    Accepts 10 digits or 11 digits starting with '1'.
    Validates that the area code starts with 2-9 (NANP standard).
    Rejects 7-digit local numbers, numbers with fewer than 10 digits, or invalid area codes.
    Returns the normalized E.164 string (+1XXXXXXXXXX) or None if invalid.
    """
    if not raw:
        return None
    digits = "".join(c for c in raw if c.isdigit())
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    if len(digits) != 10:
        return None
    # NANP validation: Area code (first digit) cannot be 0 or 1
    if digits[0] in "01":
        return None
    return f"+1{digits}"


def normalize_phone_number(raw: str) -> str:
    """Normalize phone number to standard NANP format (+1XXXXXXXXXX) if valid, or clean string."""
    if not raw:
        return ""
    nanp = normalize_nanp_phone(raw)
    if nanp is not None:
        return nanp
    digits = "".join(c for c in raw if c.isdigit())
    if raw.startswith("+"):
        return f"+{digits}"
    return digits or raw.strip()


def get_or_create_customer(
    session: Session, phone_number: str, name: str | None = None
) -> Customer:
    """Find a customer by either normalized or raw phone; create if missing."""
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
        session.flush()
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
    """Book a single slot atomically, enforcing business hours and uniqueness."""
    if settings.business_services:
        if isinstance(settings.business_services, str):
            approved_services = [s.strip().lower() for s in settings.business_services.split(",")]
        else:
            approved_services = [s.strip().lower() for s in settings.business_services]
        if service.strip().lower() not in approved_services:
            services_str = ", ".join(approved_services)
            return (
                None,
                f"'{service}' is not on our approved services list ({services_str}).",
            )
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    if when < datetime.now(UTC):
        return None, "That time is in the past. Please choose a future time."
    if not is_within_business_hours(when, settings):
        return None, (
            "That time is outside business hours. Please choose a time during opening hours."
        )
    nanp_phone = normalize_nanp_phone(phone_number)
    if nanp_phone is None:
        return (
            None,
            "A valid phone number is required to book an appointment (e.g. 555-555-0100).",
        )
    customer = get_or_create_customer(session, nanp_phone, name)

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
        tz = ZoneInfo(settings.business_timezone)
        local_time = when.astimezone(tz).strftime("%I:%M %p").lstrip("0")
        svc = existing_same_customer.service
        return (
            existing_same_customer,
            f"Appointment is already confirmed for {svc} at {local_time}."
        )

    # If another customer holds this slot, reject early with a friendly message.
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


def parse_local_datetime(settings: Settings, date_str: str, time_str: str) -> datetime | None:
    """Parse date and time strings into a business-timezone-aware datetime."""
    tz = ZoneInfo(settings.business_timezone)
    now = datetime.now(tz)

    clean_date = date_str.lower().strip()
    clean_time = time_str.strip()

    if clean_date == "tomorrow":
        target_date = (now + timedelta(days=1)).strftime("%Y-%m-%d")
    elif clean_date == "today":
        target_date = now.strftime("%Y-%m-%d")
    else:
        weekday_names = {
            "monday": 0,
            "tuesday": 1,
            "wednesday": 2,
            "thursday": 3,
            "friday": 4,
            "saturday": 5,
            "sunday": 6,
        }
        normalized_weekday = clean_date.removeprefix("next ")
        if normalized_weekday in weekday_names:
            days_ahead = (weekday_names[normalized_weekday] - now.weekday()) % 7
            if days_ahead == 0 or clean_date.startswith("next "):
                days_ahead += 7
            target_date = (now + timedelta(days=days_ahead)).strftime("%Y-%m-%d")
        else:
            target_date = clean_date

    # Try direct ISO parsing first
    try:
        return datetime.fromisoformat(f"{target_date}T{clean_time}").replace(tzinfo=tz)
    except (ValueError, TypeError):
        pass

    # Try common formats like "%I:%M %p", "%I %p", "%H:%M"
    norm_time = clean_time.replace(".", "").strip()
    for fmt in ("%I:%M %p", "%I:%M%p", "%I %p", "%I%p", "%H:%M", "%H:%M:%S"):
        try:
            parsed_t = datetime.strptime(norm_time, fmt).time()
            dt_base = datetime.strptime(target_date, "%Y-%m-%d")
            return datetime.combine(dt_base.date(), parsed_t, tzinfo=tz)
        except ValueError:
            continue

    return None


def cancel_appointment(session: Session, appointment_id: int) -> bool:
    """Cancel an appointment by ID, freeing the booked slot for reuse."""
    appointment = session.get(Appointment, appointment_id)
    if appointment is None:
        return False
    appointment.status = "cancelled"
    session.flush()
    return True
