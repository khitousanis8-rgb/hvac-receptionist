"""Serve a lightweight dashboard page for calls and appointments."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

router = APIRouter(tags=["dashboard"])

_DASHBOARD_HTML = Path(__file__).with_name("dashboard.html")


@router.get("/dashboard", response_class=HTMLResponse)
async def dashboard() -> HTMLResponse:
    """Render the calls + appointments dashboard."""
    return HTMLResponse(_DASHBOARD_HTML.read_text(encoding="utf-8"))