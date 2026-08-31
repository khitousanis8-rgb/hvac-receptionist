"""Database engine, session factory, and model definitions (SQLite)."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import DateTime, ForeignKey, String, Text, create_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

from app.config import get_settings


class Base(DeclarativeBase):
    """Declarative base for all ORM models."""


def _utcnow() -> datetime:
    return datetime.now(UTC)


class Customer(Base):
    """A caller known to the business."""

    __tablename__ = "customers"

    id: Mapped[int] = mapped_column(primary_key=True)
    phone_number: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    name: Mapped[str | None] = mapped_column(String(200), default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class CallRecord(Base):
    """One receptionist session: who called, what happened, and the outcome."""

    __tablename__ = "call_records"

    id: Mapped[int] = mapped_column(primary_key=True)
    room_name: Mapped[str] = mapped_column(String(200), index=True)
    caller_phone: Mapped[str | None] = mapped_column(String(32), default=None)
    transcript_summary: Mapped[str | None] = mapped_column(Text, default=None)
    outcome: Mapped[str] = mapped_column(String(40), default="in_progress", index=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)


class Appointment(Base):
    """A booked service visit within business hours."""

    __tablename__ = "appointments"

    id: Mapped[int] = mapped_column(primary_key=True)
    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id"), index=True)
    service: Mapped[str] = mapped_column(String(200))
    scheduled_for: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    status: Mapped[str] = mapped_column(String(20), default="booked", index=True)
    notes: Mapped[str | None] = mapped_column(Text, default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


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
    """Create all tables if they do not exist."""
    Base.metadata.create_all(get_engine(database_url))


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
