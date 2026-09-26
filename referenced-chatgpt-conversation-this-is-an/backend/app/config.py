"""Validated runtime and single-business configuration."""

from __future__ import annotations

import json
from functools import lru_cache
from typing import Annotated

from pydantic import AnyHttpUrl, Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


def normalize_database_url(database_url: str) -> str:
    """Normalize database URL for SQLAlchemy 2.0 and installed drivers."""
    trimmed = database_url.strip() if database_url else ""
    if trimmed.startswith("postgres://"):
        return "postgresql+psycopg://" + trimmed[len("postgres://") :]
    if trimmed.startswith("postgresql://") and not trimmed.startswith("postgresql+"):
        return "postgresql+psycopg://" + trimmed[len("postgresql://") :]
    return trimmed


class Settings(BaseSettings):
    """Application settings loaded from environment variables and `.env`."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_env: Annotated[str, Field(pattern="^(development|test|production)$")] = "development"
    log_level: Annotated[str, Field(pattern="^(DEBUG|INFO|WARNING|ERROR|CRITICAL)$")] = "INFO"
    api_host: str = "0.0.0.0"
    api_port: Annotated[int, Field(ge=1, le=65535)] = 8000
    cors_origins: str = (
        "http://localhost:3000,http://localhost:5173,https://hvac-receptionist-umber.vercel.app"
    )
    database_url: str = "sqlite:///./hvac_receptionist.db"
    allow_sqlite_in_production: bool = False
    db_pool_size: Annotated[int, Field(ge=1, le=50)] = 5
    db_max_overflow: Annotated[int, Field(ge=0, le=50)] = 10
    db_pool_recycle: Annotated[int, Field(ge=60, le=86400)] = 1800
    db_pool_pre_ping: bool = True
    # Required to read customer records or use the private operations dashboard.
    # Keep this server-side only; never compile it into the public frontend.
    admin_api_key: SecretStr | None = None
    trusted_proxies: str = ""

    business_company_name: Annotated[str, Field(min_length=1)] = "Example HVAC"
    business_phone: Annotated[str, Field(min_length=1)] = "+15555550100"
    business_address: Annotated[str, Field(min_length=1)] = "123 Example Street"
    business_timezone: Annotated[str, Field(min_length=1)] = "America/New_York"
    business_emergency_phone: Annotated[str, Field(min_length=1)] = "+15555550199"
    business_opening_hours: Annotated[dict[str, str], NoDecode] = Field(default_factory=dict)
    business_services: Annotated[list[str], NoDecode] = Field(default_factory=list)

    livekit_url: str | None = None
    livekit_api_key: SecretStr | None = None
    livekit_api_secret: SecretStr | None = None
    # The browser uses Kokoro for speech. Keep the legacy worker opt-in so it
    # cannot consume the API service's memory unless explicitly requested.
    enable_livekit_worker: bool = False
    tts_voice: str = "694f9389-aac1-45b6-b726-9d9369183238"
    tts_volume: float = 0.75

    # Any OpenAI-compatible Chat Completions endpoint (Groq, Ollama, OpenRouter, ...).
    llm_api_key: SecretStr | None = None
    llm_base_url: AnyHttpUrl = AnyHttpUrl("https://api.groq.com/openai/v1")
    llm_model: Annotated[str, Field(min_length=1)] = "qwen/qwen3.8-27b"
    # Comma-separated failover candidates tried in order on rate-limit errors.
    # Default preserves the previously hardcoded failover order.
    llm_fallback_models: str = (
        "qwen/qwen3.8-27b,openai/gpt-oss-20b,qwen/qwen3.6-27b,openai/gpt-oss-120b"
    )
    llm_max_tokens: Annotated[int, Field(ge=16, le=2048)] = 128

    # Rate limiter backend: "memory" (per-process, original behavior) or
    # "database" (durable sliding windows backed by the rate_limit_events table).
    rate_limit_backend: Annotated[str, Field(pattern="^(memory|database)$")] = "memory"
    require_screen_tap_confirmation: bool = False

    @field_validator("database_url", mode="after")
    @classmethod
    def normalize_db_url(cls, value: str) -> str:
        return normalize_database_url(value)

    @model_validator(mode="after")
    def validate_production_database(self) -> Settings:
        if self.app_env == "production" and not self.allow_sqlite_in_production:
            raw_url = (self.database_url or "").strip()
            if not raw_url:
                raise ValueError(
                    "Production configuration error: DATABASE_URL must be configured "
                    "in production. Empty or missing DATABASE_URL is not allowed."
                )
            clean_url = raw_url.lower()
            if clean_url.startswith("sqlite:") or clean_url.startswith("sqlite:///"):
                raise ValueError(
                    f"Production configuration error: Ephemeral SQLite database "
                    f"'{self.database_url}' is not permitted in production. A durable "
                    f"managed database (e.g. PostgreSQL) must be configured via "
                    f"DATABASE_URL, or set allow_sqlite_in_production=True if explicitly permitted."
                )
        return self

    @field_validator("business_opening_hours", mode="before")
    @classmethod
    def parse_opening_hours(cls, value: object) -> object:
        if isinstance(value, str):
            parsed = json.loads(value)
            if isinstance(parsed, dict):
                return {str(key): str(item) for key, item in parsed.items()}
            return {}
        return value

    @field_validator("llm_fallback_models", mode="before")
    @classmethod
    def parse_llm_fallback_models(cls, value: object) -> object:
        if isinstance(value, list):
            return ",".join(str(item).strip() for item in value if str(item).strip())
        return value

    @field_validator("business_services", mode="before")
    @classmethod
    def parse_services(cls, value: object) -> list[str]:
        if isinstance(value, str):
            return [service.strip() for service in value.split(",") if service.strip()]
        if isinstance(value, list):
            return [str(service).strip() for service in value if str(service).strip()]
        return []

    @property
    def configured_for_agent(self) -> bool:
        """Whether the credentials needed to start an agent worker are present."""
        return all(
            [
                self.livekit_url,
                self.livekit_api_key,
                self.livekit_api_secret,
                self.llm_api_key,
            ]
        )

    @property
    def configured_for_livekit(self) -> bool:
        """Whether the credentials needed to mint tokens and dispatch are present."""
        return all(
            [
                self.livekit_url,
                self.livekit_api_key,
                self.livekit_api_secret,
            ]
        )

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def trusted_proxy_list(self) -> list[str]:
        return [proxy.strip() for proxy in self.trusted_proxies.split(",") if proxy.strip()]

    @property
    def llm_fallback_model_list(self) -> list[str]:
        return [model.strip() for model in self.llm_fallback_models.split(",") if model.strip()]


@lru_cache
def get_settings() -> Settings:
    """Return a cached settings instance for application lifetime."""
    return Settings()
