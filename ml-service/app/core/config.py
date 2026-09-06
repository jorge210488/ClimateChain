"""
Environment configuration, validated once at import time.

Follows the same rule the backend settled on: configuration is validated before
the process serves anything, and a deployed profile may not silently fall back
to development defaults. A service that boots on a bad value and fails on the
first request is harder to diagnose than one that refuses to boot.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Profiles where a real deployment is implied and defaults are not acceptable.
DEPLOYED_PROFILES = frozenset({"staging", "testnet", "production"})
RUNTIME_PROFILES = frozenset({"development", "test", *DEPLOYED_PROFILES})

MODULE_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    """Validated settings for the pricing service."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        # `model_` is a pydantic-reserved prefix; the fields below opt out
        # individually rather than renaming environment variables the rest of
        # the repository already documents.
        protected_namespaces=(),
    )

    app_env: str = Field(default="development", alias="APP_ENV")
    app_port: int = Field(default=8000, alias="APP_PORT", ge=1, le=65_535)
    log_level: str = Field(default="info", alias="LOG_LEVEL")

    model_provider: str = Field(default="baseline", alias="MODEL_PROVIDER")
    model_path: Path = Field(
        default=Path("app/models/artifacts/baseline-premium-v2.json"),
        alias="MODEL_PATH",
    )
    # The one exception to the deployed-profile rule that observed models only
    # may price. Named, defaulted off, and logged at startup when on, so using
    # the synthetic placeholder in an emergency is an act with a fingerprint
    # rather than a configuration nobody noticed.
    model_allow_transitional: bool = Field(
        default=False, alias="MODEL_ALLOW_TRANSITIONAL"
    )

    @field_validator("app_env")
    @classmethod
    def _known_profile(cls, value: str) -> str:
        if value not in RUNTIME_PROFILES:
            raise ValueError(
                f"APP_ENV must be one of {sorted(RUNTIME_PROFILES)}, got '{value}'"
            )
        return value

    @field_validator("log_level")
    @classmethod
    def _known_log_level(cls, value: str) -> str:
        allowed = {"debug", "info", "warning", "error", "critical"}
        normalized = value.lower()
        if normalized not in allowed:
            raise ValueError(
                f"LOG_LEVEL must be one of {sorted(allowed)}, got '{value}'"
            )
        return normalized

    @field_validator("model_provider")
    @classmethod
    def _known_provider(cls, value: str) -> str:
        # One provider exists today. Naming it explicitly means a new provider
        # is added here rather than discovered as a coupling at runtime.
        if value != "baseline":
            raise ValueError(f"MODEL_PROVIDER must be 'baseline', got '{value}'")
        return value

    @property
    def is_deployed_profile(self) -> bool:
        return self.app_env in DEPLOYED_PROFILES

    @property
    def requires_observed_model(self) -> bool:
        """Whether startup must refuse a model not fitted to observed data."""
        return self.is_deployed_profile and not self.model_allow_transitional

    @property
    def resolved_model_path(self) -> Path:
        """Model path anchored to the module root when given relatively."""
        path = self.model_path
        return path if path.is_absolute() else MODULE_ROOT / path


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """
    Returns the process-wide settings.

    Cached because configuration is immutable for the life of the process, and
    re-reading it per request would let the environment change underneath a
    running service. Tests clear the cache explicitly.
    """
    return Settings()
