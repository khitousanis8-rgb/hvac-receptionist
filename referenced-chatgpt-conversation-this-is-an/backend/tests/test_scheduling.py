# pyright: reportCallIssue=false
# pydantic-settings accepts env-var kwargs dynamically; pyright cannot see them.

from datetime import UTC, datetime

import pytest

from app.config import Settings
from app.db import Appointment, init_db, new_session, reset_engine
from app.scheduling import book_appointment, get_or_create_customer


@pytest.fixture()
def db(tmp_path):
    """Point the engine at a fresh temp database for each test."""
    reset_engine()
    init_db(f"sqlite:///{(tmp_path / 'test.db').as_posix()}")
    yield
    reset_engine()


@pytest.fixture()
def settings() -> Settings:
    return Settings(
        BUSINESS_OPENING_HOURS='{"monday":"09:00-17:00"}',
        BUSINESS_TIMEZONE="UTC",
        _env_file=None,
    )


def test_book_appointment_within_hours(db, settings) -> None:
    with new_session() as session:
        when = datetime(2030, 6, 3, 10, 0, tzinfo=UTC)  # a Monday
        appointment, message = book_appointment(
            session, settings, phone_number="+15550001001", service="AC repair", when=when
        )

    assert appointment is not None
    assert "Booked" in message


def test_book_appointment_rejects_closed_day(db, settings) -> None:
    with new_session() as session:
        when = datetime(2030, 6, 9, 10, 0, tzinfo=UTC)  # a Sunday
        appointment, message = book_appointment(
            session, settings, phone_number="+15550001001", service="AC repair", when=when
        )

    assert appointment is None
    assert "outside business hours" in message


def test_book_appointment_rejects_double_booking(db, settings) -> None:
    when = datetime(2030, 6, 10, 10, 0, tzinfo=UTC)  # a Monday
    with new_session() as session:
        book_appointment(session, settings, "+15550001001", "AC repair", when)
    with new_session() as session:
        appointment, message = book_appointment(
            session, settings, phone_number="+15550002002", service="Furnace repair", when=when
        )

    assert appointment is None
    assert "already taken" in message


def test_book_appointment_same_customer_idempotent(db, settings) -> None:
    when = datetime(2030, 6, 10, 10, 0, tzinfo=UTC)  # a Monday
    with new_session() as session:
        first_app, first_msg = book_appointment(
            session, settings, phone_number="+15550001001", service="AC repair", when=when
        )
        assert first_app is not None
        first_id = first_app.id

    with new_session() as session:
        second_app, second_msg = book_appointment(
            session, settings, phone_number="+15550001001", service="AC repair", when=when
        )
        assert second_app is not None
        assert second_app.id == first_id
        assert "already confirmed" in second_msg

        count = session.query(Appointment).count()
        assert count == 1


def test_customer_deduplicated_by_phone(db) -> None:
    with new_session() as session:
        first = get_or_create_customer(session, "+15550001", "Alice")
        second = get_or_create_customer(session, "+15550001")

    assert first.id == second.id


def test_phone_normalization_and_deduplication(db) -> None:
    from app.scheduling import normalize_phone_number

    assert normalize_phone_number("5551234567") == "+15551234567"
    assert normalize_phone_number("(555) 123-4567") == "+15551234567"
    assert normalize_phone_number("+1 (555) 123-4567") == "+15551234567"

    with new_session() as session:
        c1 = get_or_create_customer(session, "(555) 123-4567", "Bob")
        c2 = get_or_create_customer(session, "+15551234567")
        assert c1.id == c2.id
        assert c2.phone_number == "+15551234567"


def test_business_hours_24_00_window() -> None:
    from app.scheduling import is_within_business_hours
    settings_24 = Settings(
        BUSINESS_OPENING_HOURS='{"monday":"08:00-24:00"}',
        BUSINESS_TIMEZONE="UTC",
        _env_file=None,
    )
    # A Monday at 22:00 UTC (10 PM) should be within 08:00-24:00
    mon_night = datetime(2030, 6, 3, 22, 0, tzinfo=UTC)
    assert is_within_business_hours(mon_night, settings_24) is True

    # A Monday at 23:30 UTC: 23:30 + 60 min = 24:30 > 24:00 -> False
    mon_too_late = datetime(2030, 6, 3, 23, 30, tzinfo=UTC)
    assert is_within_business_hours(mon_too_late, settings_24) is False


def test_book_appointment_requires_valid_phone(db, settings) -> None:
    with new_session() as session:
        when = datetime(2030, 6, 3, 10, 0, tzinfo=UTC)
        appt, msg = book_appointment(
            session, settings, phone_number="", service="AC repair", when=when
        )
        assert appt is None
        assert "valid phone number is required" in msg

        appt_invalid, msg_invalid = book_appointment(
            session, settings, phone_number="no-digits-here", service="AC repair", when=when
        )
        assert appt_invalid is None
        assert "valid phone number is required" in msg_invalid


def test_parse_local_datetime() -> None:
    from app.scheduling import parse_local_datetime
    settings = Settings(BUSINESS_TIMEZONE="UTC", _env_file=None)

    dt1 = parse_local_datetime(settings, "tomorrow", "10:00 AM")
    assert dt1 is not None
    assert dt1.hour == 10
    assert dt1.minute == 0

    dt2 = parse_local_datetime(settings, "2030-06-03", "2:30 PM")
    assert dt2 is not None
    assert dt2.hour == 14
    assert dt2.minute == 30

    dt_invalid = parse_local_datetime(settings, "invalid-date", "invalid-time")
    assert dt_invalid is None