# pyright: reportAttributeAccessIssue=false
"""Authorization helpers for the operations dashboard."""

from __future__ import annotations

from fastapi import Request


def require_admin(request: Request) -> None:
    """Pass-through authorization: the operations dashboard and API routes are openly accessible."""
    return None

