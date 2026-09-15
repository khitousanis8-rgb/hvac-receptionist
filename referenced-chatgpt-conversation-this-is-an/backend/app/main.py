"""FastAPI application entrypoint."""

from __future__ import annotations

import asyncio
import json
import threading
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Annotated, Any
from uuid import uuid4

import structlog
from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sqlalchemy import func

from app.agent.dispatch import CredentialsMissingError, DispatchError, create_room_and_token
from app.auth import require_admin
from app.call_tracking import (
    ClientTelemetry,
    apply_client_telemetry,
    reap_stale_calls,
)
from app.chat_api import router as chat_router
from app.config import Settings, get_settings
from app.dashboard import router as dashboard_router
from app.db import Appointment, CallRecord, Customer, init_db, new_session
from app.logging import configure_logging
from app.scheduling import cancel_appointment
from app.tts_stream import router as tts_router

_RATE_LIMIT_LOCK = threading.Lock()
_IP_REQUEST_TIMESTAMPS: dict[str, list[float]] = {}
_RATE_LIMIT_WINDOW_SECONDS = 60.0
_MAX_CALL_TOKENS_PER_WINDOW = 15


def get_client_ip(request: Request) -> str:
    """Extract client IP safely from request headers or socket address."""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    if request.client and request.client.host:
        return request.client.host
    return "127.0.0.1"


def check_token_rate_limit(client_ip: str) -> None:
    """Enforce sliding-window rate limit on token generation to prevent abuse."""
    now = time.time()
    cutoff = now - _RATE_LIMIT_WINDOW_SECONDS
    with _RATE_LIMIT_LOCK:
        timestamps = _IP_REQUEST_TIMESTAMPS.get(client_ip, [])
        timestamps = [t for t in timestamps if t > cutoff]
        if len(timestamps) >= _MAX_CALL_TOKENS_PER_WINDOW:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=(
                    "Rate limit exceeded for call token generation. "
                    "Please wait before trying again."
                ),
            )
        timestamps.append(now)
        _IP_REQUEST_TIMESTAMPS[client_ip] = timestamps
        if len(_IP_REQUEST_TIMESTAMPS) > 1000:
            for ip in list(_IP_REQUEST_TIMESTAMPS.keys()):
                _IP_REQUEST_TIMESTAMPS[ip] = [t for t in _IP_REQUEST_TIMESTAMPS[ip] if t > cutoff]
                if not _IP_REQUEST_TIMESTAMPS[ip]:
                    del _IP_REQUEST_TIMESTAMPS[ip]
            if len(_IP_REQUEST_TIMESTAMPS) > 1000:
                excess = len(_IP_REQUEST_TIMESTAMPS) - 1000
                for old_ip in list(_IP_REQUEST_TIMESTAMPS.keys())[:excess]:
                    del _IP_REQUEST_TIMESTAMPS[old_ip]


class CallTokenRequest(BaseModel):
    room_name: str | None = Field(
        default=None,
        max_length=64,
        pattern=r"^[a-zA-Z0-9_-]+$",
        description="Optional alphanumeric room identifier",
    )
    identity: str | None = Field(
        default=None,
        max_length=64,
        pattern=r"^[a-zA-Z0-9_-]+$",
        description="Optional alphanumeric caller identity identifier",
    )
    client_telemetry: ClientTelemetry | None = None


class CallTokenResponse(BaseModel):
    url: str
    token: str
    room: str



async def _stale_call_reaper_loop(interval_seconds: float = 60.0) -> None:
    """Independent background worker periodically finalizing abandoned calls."""
    logger = structlog.get_logger(__name__)
    logger.info("stale_call_reaper_started", interval_seconds=interval_seconds)
    try:
        # Perform an immediate initial sweep upon startup
        try:
            reaped = await asyncio.to_thread(reap_stale_calls)
            if reaped > 0:
                logger.info("stale_calls_reaped", count=reaped, phase="initial")
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.error("stale_call_reaper_error", error=str(exc), phase="initial")

        while True:
            await asyncio.sleep(interval_seconds)
            try:
                reaped = await asyncio.to_thread(reap_stale_calls)
                if reaped > 0:
                    logger.info("stale_calls_reaped", count=reaped, phase="periodic")
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.error("stale_call_reaper_error", error=str(exc), phase="periodic")
    except asyncio.CancelledError:
        logger.info("stale_call_reaper_stopped")
        raise


@asynccontextmanager
async def lifespan(application: FastAPI) -> AsyncIterator[None]:
    settings: Settings = application.state.settings
    configure_logging(settings.log_level)
    init_db(settings.database_url)
    structlog.get_logger(__name__).info("api_started", environment=settings.app_env)

    reaper_task: asyncio.Task[None] | None = None
    enable_reaper = getattr(settings, "enable_stale_call_reaper", True) and getattr(
        application.state, "enable_stale_call_reaper", True
    )
    if enable_reaper:
        reaper_task = asyncio.create_task(_stale_call_reaper_loop())

    try:
        yield
    finally:
        if reaper_task is not None:
            reaper_task.cancel()
            try:
                await reaper_task
            except asyncio.CancelledError:
                pass
        structlog.get_logger(__name__).info("api_stopped")


def create_app(settings: Settings | None = None) -> FastAPI:
    """Create the HTTP API without binding to external services."""
    runtime_settings = settings or get_settings()
    app = FastAPI(
        title="HVAC AI Voice Receptionist",
        version="0.1.0",
        lifespan=lifespan,
    )
    app.state.settings = runtime_settings
    app.add_middleware(
        CORSMiddleware,
        allow_origins=runtime_settings.cors_origin_list,
        allow_origin_regex=r"^https://hvac-receptionist(-[a-z0-9]+)?\.vercel\.app$",
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
        expose_headers=["X-Request-ID", "X-Audio-Source", "X-Voice-Persona"],
    )
    app.include_router(dashboard_router)
    app.include_router(chat_router)
    app.include_router(tts_router)

    @app.middleware("http")
    async def log_request(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        request_id = request.headers.get("X-Request-ID", str(uuid4()))
        start = time.perf_counter()
        with structlog.contextvars.bound_contextvars(request_id=request_id):
            response = await call_next(request)
            response.headers["X-Request-ID"] = request_id
            structlog.get_logger(__name__).info(
                "http_request",
                method=request.method,
                path=request.url.path,
                status_code=response.status_code,
                duration_ms=round((time.perf_counter() - start) * 1000, 2),
            )
            return response

    @app.get("/health", tags=["system"])
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/v1/config/public", tags=["system"])
    async def public_config() -> dict[str, object]:
        return {
            "company_name": runtime_settings.business_company_name,
            "phone": runtime_settings.business_phone,
            "address": runtime_settings.business_address,
            "timezone": runtime_settings.business_timezone,
            "emergency_phone": runtime_settings.business_emergency_phone,
            "opening_hours": runtime_settings.business_opening_hours,
            "services": runtime_settings.business_services,
        }

    @app.get("/v1/calls", tags=["dashboard"], dependencies=[Depends(require_admin)])
    async def list_calls(
        limit: Annotated[int, Query(ge=1, le=200)] = 50,
        offset: Annotated[int, Query(ge=0)] = 0,
    ) -> dict[str, object]:
        """Page through private call records, newest first, with accurate totals."""

        def _parse_client_metrics(metrics: str | None) -> dict[str, Any] | None:
            if not metrics:
                return None
            try:
                parsed = json.loads(metrics)
                return parsed if isinstance(parsed, dict) else None
            except Exception:
                return None

        def _query_calls() -> dict[str, object]:
            # Runs in a worker thread so the sync SQLAlchemy session never
            # blocks the event loop serving concurrent SSE/TTS streams.
            with new_session() as session:
                base_query = session.query(CallRecord)
                total = base_query.count()
                records = (
                    base_query
                    .order_by(CallRecord.started_at.desc())
                    .offset(offset)
                    .limit(limit)
                    .all()
                )
                outcome_counts: dict[str, int] = {}
                for outcome, count in (
                    session.query(CallRecord.outcome, func.count()).group_by(
                        CallRecord.outcome
                    )
                ):
                    outcome_counts[str(outcome)] = int(count)
                return {
                    "items": [
                        {
                            "id": record.id,
                            "room_name": record.room_name,
                            "caller_phone": record.caller_phone,
                            "outcome": record.outcome,
                            "transcript_summary": record.transcript_summary,
                            "started_at": record.started_at.isoformat().replace(
                                "+00:00", "Z"
                            )
                            if record.started_at
                            else None,
                            "ended_at": record.ended_at.isoformat().replace("+00:00", "Z")
                            if record.ended_at
                            else None,
                            "platform_class": record.platform_class,
                            "browser_engine": record.browser_engine,
                            "input_path": record.input_path,
                            "mic_permission": record.mic_permission,
                            "end_reason": record.end_reason,
                            "client_metrics": _parse_client_metrics(record.client_metrics),
                        }
                        for record in records
                    ],
                    "total": total,
                    "outcome_counts": outcome_counts,
                    "next_offset": (
                        offset + len(records) if offset + len(records) < total else None
                    ),
                }

        return await asyncio.to_thread(_query_calls)

    @app.get("/v1/appointments", tags=["dashboard"], dependencies=[Depends(require_admin)])
    async def list_appointments(
        limit: Annotated[int, Query(ge=1, le=200)] = 50,
        offset: Annotated[int, Query(ge=0)] = 0,
    ) -> list[dict[str, object]]:
        """Upcoming appointments, soonest first."""

        def _query_appointments() -> list[dict[str, object]]:
            # Offloaded to a worker thread to keep the event loop responsive.
            with new_session() as session:
                rows = (
                    session.query(Appointment, Customer)
                    .join(Customer, Appointment.customer_id == Customer.id)
                    .order_by(Appointment.scheduled_for)
                    .offset(offset)
                    .limit(limit)
                    .all()
                )
                return [
                    {
                        "id": appointment.id,
                        "service": appointment.service,
                        "scheduled_for": (
                            appointment.scheduled_for.isoformat().replace("+00:00", "Z")
                            if appointment.scheduled_for
                            else None
                        ),
                        "status": appointment.status,
                        "notes": appointment.notes,
                        "customer_name": customer.name,
                        "customer_phone": customer.phone_number,
                    }
                    for appointment, customer in rows
                ]

        return await asyncio.to_thread(_query_appointments)

    @app.delete(
        "/v1/appointments/{appointment_id}",
        tags=["dashboard"],
        dependencies=[Depends(require_admin)],
    )
    async def cancel_appointment_endpoint(
        appointment_id: int,
    ) -> dict[str, object]:
        """Cancel an appointment, freeing the slot for new bookings."""

        def _cancel() -> bool:
            with new_session() as session:
                return cancel_appointment(session, appointment_id)

        success = await asyncio.to_thread(_cancel)
        if not success:
            raise HTTPException(status_code=404, detail="Appointment not found")
        return {"status": "cancelled", "appointment_id": appointment_id}

    @app.post(
        "/v1/calls/token",
        response_model=CallTokenResponse,
        tags=["live-call"],
    )
    async def create_call_token(
        request: Request,
        payload: CallTokenRequest | None = None,
    ) -> CallTokenResponse:
        """Create a LiveKit room token and dispatch the voice receptionist agent."""
        client_ip = get_client_ip(request)
        check_token_rate_limit(client_ip)

        room_name = payload.room_name if payload else None
        identity = payload.identity if payload else None

        if room_name:

            def _find_active_call() -> bool:
                with new_session() as session:
                    return (
                        session.query(CallRecord)
                        .filter(
                            CallRecord.room_name == room_name,
                            CallRecord.ended_at.is_(None),
                        )
                        .first()
                        is not None
                    )

            if await asyncio.to_thread(_find_active_call):
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="A call is already in progress for this room.",
                )

        try:
            url, token, room = await create_room_and_token(
                settings=runtime_settings,
                room_name=room_name,
                identity=identity,
            )
            if payload and payload.client_telemetry:
                await asyncio.to_thread(apply_client_telemetry, room, payload.client_telemetry)
            return CallTokenResponse(url=url, token=token, room=room)
        except CredentialsMissingError as err:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=str(err),
            ) from err
        except DispatchError as err:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"Agent offline or dispatch rejected: {err}",
            ) from err

    return app


app = create_app()
