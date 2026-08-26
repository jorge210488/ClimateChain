"""
HTTP surface: liveness, readiness, and prediction.

Liveness and readiness are split for the same reason the backend splits them.
Liveness answers "is this process alive", and a failing liveness probe means
restart me. Readiness answers "can this process do its job", and a failing
readiness probe means stop sending traffic. Collapsing them either restarts a
healthy process or routes traffic to one that cannot serve.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import JSONResponse

from app.models.artifact import ModelArtifactError
from app.models.registry import ModelRegistry
from app.schemas.health import HealthResponse, ModelStatusResponse, ReadinessResponse
from app.schemas.pricing import QuoteRequest, QuoteResponse
from app.services.pricing import UnquotableCoverageError, quote_premium

router = APIRouter()


def _registry(request: Request) -> ModelRegistry:
    return request.app.state.model_registry


@router.get(
    "/health",
    response_model=HealthResponse,
    summary="Liveness probe",
    description=(
        "Reports that the process is running. Deliberately independent of model "
        "availability: a service whose model failed to load should be taken out "
        "of rotation, not restarted in a loop."
    ),
    tags=["health"],
)
def health() -> HealthResponse:
    return HealthResponse(status="ok")


@router.get(
    "/health/ready",
    response_model=ReadinessResponse,
    summary="Readiness probe",
    description=(
        "Reports whether this instance can price. Returns 503 when no model "
        "artifact is loaded, so an orchestrator withholds traffic instead of "
        "sending requests that cannot be served."
    ),
    tags=["health"],
    responses={503: {"model": ReadinessResponse}},
)
def readiness(request: Request) -> JSONResponse:
    model_status = _registry(request).status()
    payload = ReadinessResponse(
        status="ready" if model_status.loaded else "not_ready",
        model=ModelStatusResponse(
            loaded=model_status.loaded,
            modelVersion=model_status.model_version,
            provider=model_status.provider,
            sourcePath=model_status.source_path,
            checksum=model_status.checksum,
            reason=model_status.reason,
        ),
    )

    return JSONResponse(
        status_code=(
            status.HTTP_200_OK
            if model_status.loaded
            else status.HTTP_503_SERVICE_UNAVAILABLE
        ),
        content=payload.model_dump(mode="json", by_alias=True),
    )


@router.post(
    "/predict",
    response_model=QuoteResponse,
    response_model_by_alias=True,
    summary="Price a parametric rainfall policy",
    description=(
        "Returns the premium for the requested coverage. The amount is never "
        "below the provider's minimum premium ratio, so a quote can always be "
        "taken straight to policy creation."
    ),
    tags=["pricing"],
)
def predict(payload: QuoteRequest, request: Request) -> QuoteResponse:
    registry = _registry(request)

    try:
        artifact = registry.artifact
    except ModelArtifactError as error:
        # Unreachable when startup succeeded, since boot aborts without a model.
        # Reported as 503 rather than 500 because it is an availability
        # condition an operator resolves, not a defect in the request.
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(error),
        ) from error

    try:
        quote = quote_premium(
            artifact=artifact,
            region=payload.region,
            coverage_eth=payload.coverage_eth,
            rainfall_threshold_mm=payload.rainfall_threshold_mm,
            start_date=payload.start_date,
            end_date=payload.end_date,
        )
    except UnquotableCoverageError as error:
        # 422, not 500: the request is well-formed and the service is healthy,
        # but this particular coverage has no premium the chain could carry.
        # Returning it anyway would hand the caller a number that reverts.
        # The literal, not the named constant: Starlette is mid-rename from
        # HTTP_422_UNPROCESSABLE_ENTITY to HTTP_422_UNPROCESSABLE_CONTENT, and
        # either name couples this to a version window. The number is stable.
        raise HTTPException(status_code=422, detail=str(error)) from error

    return QuoteResponse(
        region=payload.region,
        premium_eth=quote.premium_eth,
        # As a string: wei for a large coverage exceeds what JSON consumers
        # parse losslessly as a number, and the backend's DTO types it as a
        # string for the same reason.
        premium_wei=str(quote.premium_wei),
        start_date=payload.start_date,
        end_date=payload.end_date,
        model_version=quote.model_version,
        trigger_probability=quote.trigger_probability,
        duration_days=quote.duration_days,
        region_known=quote.region_known,
        floored_to_minimum=quote.floored_to_minimum,
    )
