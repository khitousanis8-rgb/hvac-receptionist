"""Database engine, session factory, and model definitions (SQLite)."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import DateTime, ForeignKey, Index, String, Text, create_engine, inspect, text
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker
from sqlalchemy.types import TypeDecorator

from app.config import get_settings


class Base(DeclarativeBase):
    """Declarative base for all ORM models."""


class UTCDateTime(TypeDecorator[datetime]):
    """Store SQLite timestamps as UTC and always return aware datetimes.

    SQLite has no timezone-aware datetime type.  Normalising on both sides of
    the database boundary prevents a UTC wall-clock value from being rendered
    as the browser's local time.
    """

    impl = DateTime
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect: Any) -> datetime | None:
        if value is None:
            return None
        normalized = value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)
        return normalized.replace(tzinfo=None) if dialect.name == "sqlite" else normalized

    def process_result_value(self, value: datetime | None, dialect: Any) -> datetime | None:
        if value is None:
            return None
        return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def _utcnow() -> datetime:
    return datetime.now(UTC)


class Customer(Base):
    """A caller known to the business."""

    __tablename__ = "customers"

    id: Mapped[int] = mapped_column(primary_key=True)
    phone_number: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    name: Mapped[str | None] = mapped_column(String(200), default=None)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=_utcnow)


class CallRecord(Base):
    """One receptionist session: who called, what happened, and the outcome."""

    __tablename__ = "call_records"

    id: Mapped[int] = mapped_column(primary_key=True)
    room_name: Mapped[str] = mapped_column(String(200), index=True)
    caller_phone: Mapped[str | None] = mapped_column(String(32), default=None)
    transcript_summary: Mapped[str | None] = mapped_column(Text, default=None)
    session_slots: Mapped[str | None] = mapped_column(Text, default=None)
    access_token_hash: Mapped[str | None] = mapped_column(String(64), index=True, default=None)
    outcome: Mapped[str] = mapped_column(String(40), default="in_progress", index=True)
    started_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=_utcnow)
    ended_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), default=None)


class Appointment(Base):
    """A booked service visit within business hours."""

    __tablename__ = "appointments"
    __table_args__ = (
        Index(
            "uq_appointments_booked_scheduled_for",
            "scheduled_for",
            unique=True,
            sqlite_where=text("status = 'booked'"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id"), index=True)
    service: Mapped[str] = mapped_column(String(200))
    scheduled_for: Mapped[datetime] = mapped_column(UTCDateTime(), index=True)
    status: Mapped[str] = mapped_column(String(20), default="booked", index=True)
    notes: Mapped[str | None] = mapped_column(Text, default=None)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=_utcnow)


_engine: Any = None
_SessionLocal: sessionmaker[Session] | None = None


def get_engine(database_url: str | None = None) -> Any:
    """Create (once) and return the SQLAlchemy engine from settings."""
    global _engine, _SessionLocal
    if _engine is None:
        _engine = create_engine(
            database_url or get_settings().database_url,
            connect_args={"check_same_thread": False},
        )
        _SessionLocal = sessionmaker(bind=_engine, autoflush=False, expire_on_commit=False)
    return _engine


def reset_engine() -> None:
    """Drop the cached engine (used by tests to swap databases)."""
    global _engine, _SessionLocal
    _engine = None
    _SessionLocal = None


def init_db(database_url: str | None = None) -> None:
    """Create tables and apply the small, backwards-compatible SQLite migrations."""
    engine = get_engine(database_url)
    Base.metadata.create_all(engine)

    # This project predates a migration framework. Keep the deployed SQLite
    # database usable while adding the fields required for secure call ownership
    # and durable session state. New installations receive these via create_all.
    if engine.dialect.name != "sqlite":
        return
    columns = {column["name"] for column in inspect(engine).get_columns("call_records")}
    with engine.begin() as connection:
        if "session_slots" not in columns:
            connection.execute(text("ALTER TABLE call_records ADD COLUMN session_slots TEXT"))
        if "access_token_hash" not in columns:
            connection.execute(
                text("ALTER TABLE call_records ADD COLUMN access_token_hash VARCHAR(64)")
            )
        connection.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_call_records_access_token_hash "
                "ON call_records (access_token_hash)"
            )
        )
        connection.execute(
            text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_appointments_booked_scheduled_for "
                "ON appointments (scheduled_for) WHERE status = 'booked'"
            )
        )


@contextmanager
def new_session() -> Iterator[Session]:
    """Provide a database session, committing on success and rolling back on error."""
    get_engine()
    assert _SessionLocal is not None
    session = _SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
