# pyright: reportCallIssue=false
"""Tests for the pluggable rate-limit backend (Workstream C)."""

from __future__ import annotations

from app import security
from app.config import Settings


def test_default_backend_is_memory() -> None:
    settings = Settings(_env_file=None)
    assert settings.rate_limit_backend == "memory"


def test_invalid_backend_is_rejected() -> None:
    import pytest
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        Settings(rate_limit_backend="redis", _env_file=None)


def test_memory_backend_allows_then_blocks(monkeypatch) -> None:
    settings = Settings(rate_limit_backend="memory", _env_file=None)
    monkeypatch.setattr(security, "get_settings", lambda: settings)
    store: dict[str, list[float]] = {}
    assert security._memory_allow(store, "ip-a", 2, 60.0) is True
    assert security._memory_allow(store, "ip-a", 2, 60.0) is True
    assert security._memory_allow(store, "ip-a", 2, 60.0) is False
    assert security._memory_allow(store, "ip-b", 2, 60.0) is True


def test_check_booking_limit_raises_after_max(monkeypatch) -> None:
    settings = Settings(rate_limit_backend="memory", _env_file=None)
    monkeypatch.setattr(security, "get_settings", lambda: settings)
    security.reset_rate_limits()
    for _ in range(5):
        security.check_booking_rate_limit("limited-ip")
    import pytest
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as excinfo:
        security.check_booking_rate_limit("limited-ip")
    assert excinfo.value.status_code == 429
    security.reset_rate_limits()


def test_database_backend_persists_and_blocks(monkeypatch, db) -> None:
    settings = Settings(rate_limit_backend="database", _env_file=None)
    monkeypatch.setattr(security, "get_settings", lambda: settings)
    key = "db-limited-ip"
    # Five booking events within the window; the sixth must be blocked.
    for _ in range(5):
        assert security._database_allow(key, 5, 60.0) is True
    assert security._database_allow(key, 5, 60.0) is False
    # A different key is unaffected.
    assert security._database_allow("other-ip", 5, 60.0) is True


def test_database_backend_cleanup_removes_expired_events(monkeypatch, db) -> None:
    from datetime import UTC, datetime, timedelta

    from app.db import RateLimitEvent, new_session

    settings = Settings(rate_limit_backend="database", _env_file=None)
    monkeypatch.setattr(security, "get_settings", lambda: settings)
    key = "cleanup-ip"
    # Seed a stale event older than any window.
    with new_session() as session:
        session.add(
            RateLimitEvent(
                key=key,
                created_at=datetime.now(UTC) - timedelta(hours=2),
            )
        )
    # The stale event must be deleted and not counted.
    assert security._database_allow(key, 5, 60.0) is True
    with new_session() as session:
        stale = (
            session.query(RateLimitEvent)
            .filter(
                RateLimitEvent.key == key,
                RateLimitEvent.created_at < datetime.now(UTC) - timedelta(minutes=1),
            )
            .count()
        )
    assert stale == 0