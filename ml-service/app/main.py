"""
Application factory and startup lifecycle.

The model is loaded during startup and a failure aborts the boot. That is the
Stage 07 acceptance criterion, and it is also the only arrangement in which
readiness means anything: a process that starts without a model would report
itself healthy right up until the first request.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.api.routes import router
from app.core.config import Settings, get_settings
from app.models.artifact import ModelArtifactError
from app.models.registry import ModelRegistry

logger = logging.getLogger("climatechain.ml")


def configure_logging(settings: Settings) -> None:
    logging.basicConfig(
        level=getattr(logging, settings.log_level.upper()),
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings: Settings = app.state.settings
    registry: ModelRegistry = app.state.model_registry

    try:
        artifact = registry.load()
    except ModelArtifactError as error:
        # Raised out of startup on purpose: uvicorn refuses to serve, and the
        # operator sees the reason immediately instead of discovering it through
        # failing requests.
        logger.error("Model artifact unavailable: %s", error)
        raise

    logger.info(
        "Model loaded: version=%s provider=%s regions=%d checksum=%s",
        artifact.model_version,
        artifact.provider,
        len(artifact.region_risk),
        artifact.checksum[:12],
    )
    logger.info(
        "ClimateChain ML service ready (profile=%s, port=%d)",
        settings.app_env,
        settings.app_port,
    )

    yield


def _serializable(value: object) -> object:
    """
    Renders a value that JSON can carry, whatever the client sent.

    Validation errors echo the offending input, which is normally the most
    useful part of the message — until the input is a string JSON accepts and
    UTF-8 cannot encode, such as an unpaired surrogate. The error response then
    fails to serialise and a rejected request becomes a 500. Replacing the
    unencodable parts keeps the diagnosis and the status code.
    """
    if isinstance(value, str):
        return value.encode("utf-8", errors="replace").decode("utf-8")
    if isinstance(value, dict):
        return {str(key): _serializable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_serializable(item) for item in value]
    if value is None or isinstance(value, (bool, int, float)):
        return value

    # Pydantic puts the original exception object in the error context, which
    # JSON cannot carry either. Rendering it keeps the reason without letting
    # the response fail for a second, unrelated cause.
    return _serializable(str(value))


async def validation_error_handler(
    _request: Request, error: RequestValidationError
) -> JSONResponse:
    """Returns 422 for an invalid request, including an unencodable one."""
    return JSONResponse(
        status_code=422,
        content={"detail": _serializable(error.errors())},
    )


def create_app(settings: Settings | None = None) -> FastAPI:
    """
    Builds the application.

    Settings are injectable so tests can exercise a missing or corrupt artifact
    without mutating the process environment.
    """
    resolved = settings or get_settings()
    configure_logging(resolved)

    app = FastAPI(
        title="ClimateChain ML Service",
        version="0.1.0",
        summary="Premium pricing inference for parametric rainfall policies",
        lifespan=lifespan,
        # Interactive docs follow the backend's rule: useful locally, opt-out
        # once deployed, because they describe every route and payload shape.
        docs_url=None if resolved.is_deployed_profile else "/docs",
        redoc_url=None,
        openapi_url=None if resolved.is_deployed_profile else "/openapi.json",
    )

    app.state.settings = resolved
    app.state.model_registry = ModelRegistry(
        path=resolved.resolved_model_path,
        expected_provider=resolved.model_provider,
    )
    # Registered before the router so a request that cannot even be decoded
    # is still answered with the status its content deserves.
    app.add_exception_handler(RequestValidationError, validation_error_handler)
    app.include_router(router)

    return app


app = create_app()
