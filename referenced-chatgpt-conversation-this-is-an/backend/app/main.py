"""FastAPI application entrypoint."""

from __future__ import annotations

import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from uuid import uuid4

import structlog
from fastapi import FastAPI, HTTPException, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app.agent.dispatch import CredentialsMissingError, DispatchError, create_room_and_token
from app.config import Settings, get_settings
from app.dashboard import router as dashboard_router
from app.db import Appointment, CallRecord, Customer, init_db, new_session
from app.logging import configure_logging


class CallTokenRequest(BaseModel):
    room_name: str | None = None
    identity: str | None = None


class CallTokenResponse(BaseModel):
    url: str
    token: str
    room: str



@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    configure_logging(settings.log_level)
    structlog.get_logger(__name__).info("api_started", environment=settings.app_env)
    yield
    structlog.get_logger(__name__).info("api_stopped")


def create_app(settings: Settings | None = None) -> FastAPI:
    """Create the HTTP API without binding to external services."""
    runtime_settings = settings or get_settings()
    app = FastAPI(
        title="HVAC AI Voice Receptionist",
        version="0.1.0",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=runtime_settings.cors_origin_list,
        allow_origin_regex=r"https://.*\.vercel\.app",
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
    )
    app.include_router(dashboard_router)

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

    @app.get("/v1/calls", tags=["dashboard"])
    async def list_calls(limit: int = 50) -> list[dict[str, object]]:
        """Recent call records, newest first."""
        init_db()
        with new_session() as session:
            records = (
                session.query(CallRecord)
                .order_by(CallRecord.started_at.desc())
                .limit(min(limit, 200))
                .all()
            )
            return [
                {
                    "id": record.id,
                    "room_name": record.room_name,
                    "caller_phone": record.caller_phone,
                    "outcome": record.outcome,
                    "transcript_summary": record.transcript_summary,
                    "started_at": record.started_at.isoformat() if record.started_at else None,
                    "ended_at": record.ended_at.isoformat() if record.ended_at else None,
                }
                for record in records
            ]

    @app.get("/v1/appointments", tags=["dashboard"])
    async def list_appointments(limit: int = 50) -> list[dict[str, object]]:
        """Upcoming appointments, soonest first."""
        init_db()
        with new_session() as session:
            rows = (
                session.query(Appointment, Customer)
                .join(Customer, Appointment.customer_id == Customer.id)
                .order_by(Appointment.scheduled_for)
                .limit(min(limit, 200))
                .all()
            )
            return [
                {
                    "id": appointment.id,
                    "service": appointment.service,
                    "scheduled_for": appointment.scheduled_for.isoformat(),
                    "status": appointment.status,
                    "notes": appointment.notes,
                    "customer_name": customer.name,
                    "customer_phone": customer.phone_number,
                }
                for appointment, customer in rows
            ]

    @app.post(
        "/v1/calls/token",
        response_model=CallTokenResponse,
        tags=["live-call"],
    )
    async def create_call_token(
        payload: CallTokenRequest | None = None,
    ) -> CallTokenResponse:
        """Create a LiveKit room token and dispatch the voice receptionist agent."""
        room_name = payload.room_name if payload else None
        identity = payload.identity if payload else None

        if room_name:
            init_db()
            with new_session() as session:
                active_call = (
                    session.query(CallRecord)
                    .filter(CallRecord.room_name == room_name, CallRecord.ended_at.is_(None))
                    .first()
                )
                if active_call is not None:
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
