# pyright: reportAttributeAccessIssue=false
"""Security utilities: rate limiting, IP resolution, and abuse prevention.

Rate limiting supports two backends selected by ``RATE_LIMIT_BACKEND``:
``memory`` (default; identical to the original per-process sliding windows)
and ``database`` (durable sliding windows backed by the ``rate_limit_events``
table, suitable for restarts and multi-instance deployments).
"""

from __future__ import annotations

import threading
import time
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException, Request, status

from app.config import Settings, get_settings

_RATE_LIMIT_LOCK = threading.Lock()
_IP_TOKEN_REQUEST_TIMESTAMPS: dict[str, list[float]] = {}
_IP_CHAT_REQUEST_TIMESTAMPS: dict[str, list[float]] = {}
_IP_BOOKING_REQUEST_TIMESTAMPS: dict[str, list[float]] = {}

_TOKEN_RATE_LIMIT_WINDOW_SECONDS = 60.0
_MAX_CALL_TOKENS_PER_WINDOW = 15

_CHAT_RATE_LIMIT_WINDOW_SECONDS = 60.0
_MAX_CHAT_REQUESTS_PER_WINDOW = 30

_BOOKING_RATE_LIMIT_WINDOW_SECONDS = 60.0
_MAX_BOOKING_REQUESTS_PER_WINDOW = 5


def get_client_ip(request: Request | None, settings: Settings | None = None) -> str:
    """Extract client IP safely from request headers or socket address.

    Only trusts X-Forwarded-For if the connecting socket client is in the configured
    trusted_proxy_list. Prevents spoofing of forwarded headers to bypass rate limits.
    """
    if request is None:
        return "127.0.0.1"
    socket_ip = request.client.host if request.client and request.client.host else "127.0.0.1"
    resolved_settings = settings
    if resolved_settings is None:
        if (
            hasattr(request, "app")
            and hasattr(request.app, "state")
            and hasattr(request.app.state, "settings")
        ):
            resolved_settings = request.app.state.settings
        else:
            resolved_settings = get_settings()
    trusted = resolved_settings.trusted_proxy_list
    if trusted and socket_ip in trusted:
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            client_candidate = forwarded.split(",")[0].strip()
            if client_candidate:
                return client_candidate
    return socket_ip


def _memory_allow(
    store: dict[str, list[float]],
    key: str,
    max_requests: int,
    window_seconds: float,
) -> bool:
    """Sliding-window gate against an in-process store; True when allowed."""
    now = time.time()
    cutoff = now - window_seconds
    with _RATE_LIMIT_LOCK:
        timestamps = [t for t in store.get(key, []) if t > cutoff]
        if len(timestamps) >= max_requests:
            store[key] = timestamps
            return False
        timestamps.append(now)
        store[key] = timestamps
        return True


def _database_allow(key: str, max_requests: int, window_seconds: float) -> bool:
    """Sliding-window gate against the durable rate_limit_events table."""
    from app.db import RateLimitEvent, new_session

    now = datetime.now(UTC)
    cutoff = now - timedelta(seconds=window_seconds)
    with new_session() as session:
        # Bounded cleanup: drop events older than the window for this key.
        session.query(RateLimitEvent).filter(
            RateLimitEvent.created_at <= cutoff
        ).delete(synchronize_session=False)
        count = (
            session.query(RateLimitEvent)
            .filter(RateLimitEvent.key == key, RateLimitEvent.created_at > cutoff)
            .count()
        )
        if count >= max_requests:
            session.commit()
            return False
        session.add(RateLimitEvent(key=key[:200], created_at=now))
        session.commit()
        return True


def _allow_request(
    store: dict[str, list[float]],
    key: str,
    max_requests: int,
    window_seconds: float,
) -> bool:
    """Route the sliding-window gate to the configured backend."""
    if get_settings().rate_limit_backend == "database":
        return _database_allow(key, max_requests, window_seconds)
    return _memory_allow(store, key, max_requests, window_seconds)


def check_token_rate_limit(client_ip: str) -> None:
    """Enforce sliding-window rate limit on token generation to prevent abuse."""
    if not _allow_request(
        _IP_TOKEN_REQUEST_TIMESTAMPS,
        client_ip,
        _MAX_CALL_TOKENS_PER_WINDOW,
        _TOKEN_RATE_LIMIT_WINDOW_SECONDS,
    ):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=(
                "Rate limit exceeded: too many call token requests. "
                "Please wait a minute before trying again."
            ),
        )


def check_chat_rate_limit(client_ip: str) -> None:
    """Enforce sliding-window rate limit on chat endpoint before LLM invocation."""
    if not _allow_request(
        _IP_CHAT_REQUEST_TIMESTAMPS,
        client_ip,
        _MAX_CHAT_REQUESTS_PER_WINDOW,
        _CHAT_RATE_LIMIT_WINDOW_SECONDS,
    ):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=(
                "Rate limit exceeded: too many chat messages. "
                "Please wait a moment before sending more."
            ),
        )


def check_booking_rate_limit(client_ip: str) -> None:
    """Enforce sliding-window rate limit on booking confirmations to prevent abuse."""
    if not _allow_request(
        _IP_BOOKING_REQUEST_TIMESTAMPS,
        client_ip,
        _MAX_BOOKING_REQUESTS_PER_WINDOW,
        _BOOKING_RATE_LIMIT_WINDOW_SECONDS,
    ):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=(
                "Rate limit exceeded: too many booking confirmation requests. "
                "Please wait a minute before trying again."
            ),
        )


def reset_rate_limits() -> None:
    """Reset in-memory rate limiters (primarily for testing)."""
    with _RATE_LIMIT_LOCK:
        _IP_TOKEN_REQUEST_TIMESTAMPS.clear()
        _IP_CHAT_REQUEST_TIMESTAMPS.clear()
        _IP_BOOKING_REQUEST_TIMESTAMPS.clear()