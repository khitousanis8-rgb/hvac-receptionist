# pyright: reportCallIssue=false
# pydantic-settings accepts env-var kwargs dynamically; pyright cannot see them.

from datetime import UTC, datetime

import pytest

from app.config import Settings
from app.db import init_db, new_session, reset_engine
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
            session, settings, phone_number="+15550001", service="AC repair", when=when
        )

    assert appointment is not None
    assert "Booked" in message


def test_book_appointment_rejects_closed_day(db, settings) -> None:
    with new_session() as session:
        when = datetime(2030, 6, 9, 10, 0, tzinfo=UTC)  # a Sunday
        appointment, message = book_appointment(
            session, settings, phone_number="+15550001", service="AC repair", when=when
        )

    assert appointment is None
    assert "outside business hours" in message


def test_book_appointment_rejects_double_booking(db, settings) -> None:
    when = datetime(2030, 6, 10, 10, 0, tzinfo=UTC)  # a Monday
    with new_session() as session:
        book_appointment(session, settings, "+15550001", "AC repair", when)
    with new_session() as session:
        appointment, message = book_appointment(
            session, settings, phone_number="+15550002", service="Furnace repair", when=when
        )

    assert appointment is None
    assert "already taken" in message


def test_customer_deduplicated_by_phone(db) -> None:
    with new_session() as session:
        first = get_or_create_customer(session, "+15550001", "Alice")
        second = get_or_create_customer(session, "+15550001")

    assert first.id == second.id