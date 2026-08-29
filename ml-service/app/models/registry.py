"""
Model lifecycle: loaded once at startup, held for the life of the process.

Two properties this exists to guarantee.

**Fail fast.** The artifact is loaded during startup, not on the first request.
A service that boots without a model and fails at request time looks healthy to
every orchestrator that watches it, and the first person to learn is a caller.

**Readiness reflects reality.** The probe reports whether a model is genuinely
loaded, not whether the process is running. Those differ precisely when it
matters.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from app.models.artifact import ModelArtifact, ModelArtifactError, load_artifact
from app.models.baseline import assert_arithmetic_is_stable


@dataclass(frozen=True)
class ModelStatus:
    """What readiness needs to know about the model, without exposing it."""

    loaded: bool
    model_version: str | None
    provider: str | None
    source_path: str
    checksum: str | None
    reason: str | None = None


class ModelRegistry:
    """Holds the single loaded model and reports on its availability."""

    def __init__(self, path: Path, expected_provider: str) -> None:
        self._path = path
        self._expected_provider = expected_provider
        self._artifact: ModelArtifact | None = None
        self._failure: str | None = None

    def load(self) -> ModelArtifact:
        """
        Loads and validates the artifact.

        :raises ModelArtifactError: when the artifact cannot be used, including
            when it was produced by a provider this deployment is not configured
            for — a mismatch there means the service would price with a model
            the operator did not intend to run.
        """
        try:
            artifact = load_artifact(self._path)
        except ModelArtifactError as error:
            self._artifact = None
            self._failure = str(error)
            raise

        try:
            # Shape and integrity are not the whole contract: a structurally
            # valid model can still be unevaluable. This is the load path
            # startup uses, so proving the arithmetic here is what keeps
            # readiness from advertising a model that fails on first use.
            assert_arithmetic_is_stable(artifact)
        except ModelArtifactError as error:
            self._artifact = None
            self._failure = str(error)
            raise

        if artifact.provider != self._expected_provider:
            self._artifact = None
            self._failure = (
                f"Model artifact at {self._path} was produced by provider "
                f"'{artifact.provider}', but MODEL_PROVIDER is "
                f"'{self._expected_provider}'"
            )
            raise ModelArtifactError(self._failure)

        self._artifact = artifact
        self._failure = None
        return artifact

    @property
    def artifact(self) -> ModelArtifact:
        """
        The loaded model.

        :raises ModelArtifactError: when nothing is loaded. Reaching this means
            a request arrived on a process that failed startup, so it is a bug
            rather than a condition to recover from.
        """
        if self._artifact is None:
            raise ModelArtifactError(
                self._failure or "No model artifact is loaded in this process"
            )
        return self._artifact

    @property
    def is_loaded(self) -> bool:
        return self._artifact is not None

    def status(self) -> ModelStatus:
        """A serializable snapshot for the readiness probe."""
        if self._artifact is None:
            return ModelStatus(
                loaded=False,
                model_version=None,
                provider=None,
                source_path=str(self._path),
                checksum=None,
                reason=self._failure or "Model artifact has not been loaded",
            )

        return ModelStatus(
            loaded=True,
            model_version=self._artifact.model_version,
            provider=self._artifact.provider,
            source_path=str(self._artifact.source_path),
            checksum=self._artifact.checksum,
        )
