"""Authorization helpers for the private operations dashboard."""

from __future__ import annotations

import hmac

from fastapi import HTTPException, Request, status

from app.config import Settings, get_settings


def require_admin(request: Request) -> None:
    """Require the configured admin key for customer data and operations routes."""
    settings: Settings = getattr(request.app.state, "settings", None) or get_settings()
    if settings.admin_api_key is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="The private dashboard is not configured. Set ADMIN_API_KEY on the server.",
        )

    expected = settings.admin_api_key.get_secret_value()
    authorization = request.headers.get("authorization", "")
    bearer = authorization.removeprefix("Bearer ").strip() if authorization else ""
    presented = request.headers.get("x-admin-key", "").strip() or bearer
    if not presented or not hmac.compare_digest(presented, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Admin authentication is required for this resource.",
            headers={"WWW-Authenticate": "Bearer"},
        )
