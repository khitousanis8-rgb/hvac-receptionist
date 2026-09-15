"""Rate limiting, client IP resolution, and network security policies."""

from __future__ import annotations

import threading
import time

from fastapi import HTTPException, Request, status

from app.config import Settings, get_settings

_RATE_LIMIT_LOCK = threading.Lock()
_IP_TOKEN_REQUEST_TIMESTAMPS: dict[str, list[float]] = {}
_IP_CHAT_REQUEST_TIMESTAMPS: dict[str, list[float]] = {}

_TOKEN_RATE_LIMIT_WINDOW_SECONDS = 60.0
_MAX_CALL_TOKENS_PER_WINDOW = 15

_CHAT_RATE_LIMIT_WINDOW_SECONDS = 60.0
_MAX_CHAT_REQUESTS_PER_WINDOW = 30


def get_client_ip(request: Request, settings: Settings | None = None) -> str:
    """Extract client IP safely from request headers or socket address.

    Only trusts X-Forwarded-For if the connecting socket client is in the configured
    trusted_proxy_list. Prevents spoofing of forwarded headers to bypass rate limits.
    """
    socket_ip = request.client.host if request.client and request.client.host else "127.0.0.1"
    resolved_settings = settings or get_settings()
    trusted = resolved_settings.trusted_proxy_list
    if trusted and socket_ip in trusted:
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            client_candidate = forwarded.split(",")[0].strip()
            if client_candidate:
                return client_candidate
    return socket_ip


def check_token_rate_limit(client_ip: str) -> None:
    """Enforce sliding-window rate limit on token generation to prevent abuse."""
    now = time.time()
    cutoff = now - _TOKEN_RATE_LIMIT_WINDOW_SECONDS
    with _RATE_LIMIT_LOCK:
        timestamps = _IP_TOKEN_REQUEST_TIMESTAMPS.get(client_ip, [])
        timestamps = [t for t in timestamps if t > cutoff]
        if len(timestamps) >= _MAX_CALL_TOKENS_PER_WINDOW:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=(
                    "Rate limit exceeded: too many call token requests. "
                    "Please wait a minute before trying again."
                ),
            )
        timestamps.append(now)
        _IP_TOKEN_REQUEST_TIMESTAMPS[client_ip] = timestamps


def check_chat_rate_limit(client_ip: str) -> None:
    """Enforce sliding-window rate limit on chat endpoint before LLM invocation."""
    now = time.time()
    cutoff = now - _CHAT_RATE_LIMIT_WINDOW_SECONDS
    with _RATE_LIMIT_LOCK:
        timestamps = _IP_CHAT_REQUEST_TIMESTAMPS.get(client_ip, [])
        timestamps = [t for t in timestamps if t > cutoff]
        if len(timestamps) >= _MAX_CHAT_REQUESTS_PER_WINDOW:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=(
                    "Rate limit exceeded: too many chat messages. "
                    "Please wait a moment before sending more."
                ),
            )
        timestamps.append(now)
        _IP_CHAT_REQUEST_TIMESTAMPS[client_ip] = timestamps


def reset_rate_limits() -> None:
    """Reset in-memory rate limiters (primarily for testing)."""
    with _RATE_LIMIT_LOCK:
        _IP_TOKEN_REQUEST_TIMESTAMPS.clear()
        _IP_CHAT_REQUEST_TIMESTAMPS.clear()
