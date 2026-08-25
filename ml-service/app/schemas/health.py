"""Health and readiness payloads."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class HealthResponse(BaseModel):
    """Liveness verdict."""

    status: str = Field(examples=["ok"])


class ModelStatusResponse(BaseModel):
    """
    What readiness reports about the loaded model.

    The checksum and path are included because the question an operator asks
    during an incident is not "is a model loaded" but "which one" — an instance
    still serving a superseded artifact looks identical otherwise.
    """

    model_config = ConfigDict(populate_by_name=True, protected_namespaces=())

    loaded: bool
    model_version: str | None = Field(default=None, alias="modelVersion")
    provider: str | None = None
    source_path: str = Field(alias="sourcePath")
    checksum: str | None = None
    reason: str | None = Field(
        default=None,
        description="Why the model is unavailable; absent when it is loaded.",
    )


class ReadinessResponse(BaseModel):
    """Readiness verdict plus the evidence behind it."""

    status: str = Field(examples=["ready", "not_ready"])
    model: ModelStatusResponse

    model_config = ConfigDict(protected_namespaces=())
