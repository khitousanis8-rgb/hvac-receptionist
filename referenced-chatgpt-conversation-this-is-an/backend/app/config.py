"""Validated runtime and single-business configuration."""

from __future__ import annotations

import json
from functools import lru_cache
from typing import Annotated

from pydantic import AnyHttpUrl, Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


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
    # Required to read customer records or use the private operations dashboard.
    # Keep this server-side only; never compile it into the public frontend.
    admin_api_key: SecretStr | None = None

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

    @field_validator("business_opening_hours", mode="before")
    @classmethod
    def parse_opening_hours(cls, value: object) -> object:
        if isinstance(value, str):
            parsed = json.loads(value)
            if isinstance(parsed, dict):
                return {str(key): str(item) for key, item in parsed.items()}
            return {}
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


@lru_cache
def get_settings() -> Settings:
    """Return a cached settings instance for application lifetime."""
    return Settings()
