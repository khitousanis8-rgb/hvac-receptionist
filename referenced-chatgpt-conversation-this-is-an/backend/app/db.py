"""Database engine, session factory, and model definitions (SQLite)."""

from __future__ import annotations

import os
import sys
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import (
    DateTime,
    Engine,
    ForeignKey,
    Index,
    String,
    Text,
    create_engine,
    inspect,
    text,
)
from sqlalchemy.engine import make_url
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
    platform_class: Mapped[str | None] = mapped_column(String(20), index=True, default=None)
    browser_engine: Mapped[str | None] = mapped_column(String(20), default=None)
    input_path: Mapped[str | None] = mapped_column(String(40), default=None)
    mic_permission: Mapped[str | None] = mapped_column(String(20), default=None)
    end_reason: Mapped[str | None] = mapped_column(String(40), default=None)
    client_metrics: Mapped[str | None] = mapped_column(Text, default=None)


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


_engine: Engine | None = None
_SessionLocal: sessionmaker[Session] | None = None
_engine_lock = threading.Lock()


def _is_test_environment() -> bool:
    """Return True if executing within a test runner or test environment."""
    return (
        os.getenv("APP_ENV") == "test"
        or "PYTEST_CURRENT_TEST" in os.environ
        or "PYTEST_VERSION" in os.environ
        or "pytest" in sys.modules
    )


def _is_runtime_database(database_url: str) -> bool:
    """Return True if the target URL resolves to the production SQLite database."""
    try:
        url = make_url(database_url)
        if url.get_backend_name() != "sqlite":
            return False
        db_path = url.database
        if not db_path or db_path == ":memory:":
            return False
        resolved = Path(db_path)
        if resolved.name.lower() == "hvac_receptionist.db":
            return True
        return resolved.resolve().name.lower() == "hvac_receptionist.db"
    except Exception:
        clean_url = database_url.split("?")[0].split("#")[0].replace("\\", "/")
        filename = clean_url.rstrip("/").split("/")[-1].lower()
        return filename == "hvac_receptionist.db"


def get_engine(database_url: str | None = None) -> Engine:
    """Create (once) and return the SQLAlchemy engine from settings."""
    global _engine, _SessionLocal
    target_url = database_url or (
        str(_engine.url) if _engine is not None else get_settings().database_url
    )

    if _is_test_environment() and _is_runtime_database(target_url):
        raise RuntimeError(
            "Database isolation guard violation: "
            "Test execution attempted to connect to runtime database 'hvac_receptionist.db'. "
            "All tests must run against isolated temporary databases."
        )

    if _engine is None or (database_url is not None and str(_engine.url) != database_url):
        with _engine_lock:
            if (
                _engine is not None
                and database_url is not None
                and str(_engine.url) != database_url
            ):
                _engine.dispose()
                _engine = None
                _SessionLocal = None

            if _engine is None:
                create_url = database_url or get_settings().database_url
                _engine = create_engine(
                    create_url,
                    connect_args={"check_same_thread": False},
                )
                _SessionLocal = sessionmaker(bind=_engine, autoflush=False, expire_on_commit=False)
    assert _engine is not None
    return _engine


def reset_engine() -> None:
    """Drop the cached engine and dispose open connection pools (releasing file handles)."""
    global _engine, _SessionLocal
    with _engine_lock:
        if _engine is not None:
            _engine.dispose()
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
        if "platform_class" not in columns:
            connection.execute(
                text("ALTER TABLE call_records ADD COLUMN platform_class VARCHAR(20)")
            )
        if "browser_engine" not in columns:
            connection.execute(
                text("ALTER TABLE call_records ADD COLUMN browser_engine VARCHAR(20)")
            )
        if "input_path" not in columns:
            connection.execute(
                text("ALTER TABLE call_records ADD COLUMN input_path VARCHAR(40)")
            )
        if "mic_permission" not in columns:
            connection.execute(
                text("ALTER TABLE call_records ADD COLUMN mic_permission VARCHAR(20)")
            )
        if "end_reason" not in columns:
            connection.execute(
                text("ALTER TABLE call_records ADD COLUMN end_reason VARCHAR(40)")
            )
        if "client_metrics" not in columns:
            connection.execute(
                text("ALTER TABLE call_records ADD COLUMN client_metrics TEXT")
            )
        connection.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_call_records_access_token_hash "
                "ON call_records (access_token_hash)"
            )
        )
        connection.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_call_records_platform_class "
                "ON call_records (platform_class)"
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
