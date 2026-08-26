"""
Loading and integrity verification of the pricing model artifact.

The artifact is JSON holding fitted coefficients, not a pickle. That is a
deliberate trade: unpickling executes arbitrary code, so a pickle is a remote
code execution primitive wearing a model's clothes, and the file here is loaded
at every boot from a path an operator controls. JSON also lets a reviewer read
what the service is actually pricing with.

The file carries a checksum over its own contents. Without one, a truncated
write or a partially copied file loads as a valid-looking model with wrong
numbers, and the service prices confidently from nonsense.
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# Bumped when the artifact's shape changes in a way this loader cannot read.
SUPPORTED_SCHEMA_VERSION = 1

# Features the baseline evaluator can compute. Declared here rather than in the
# evaluator so loading can reject an artifact the evaluator would choke on:
# discovering an unknown feature at quote time means readiness reported "ready"
# for a model that cannot price, which is exactly what fail-fast is for.
BASELINE_FEATURES = frozenset(
    {"intercept", "log_threshold_mm", "log_duration_days", "region_risk"}
)

# Fields that must be present for the artifact to be usable at all.
REQUIRED_FIELDS = (
    "schemaVersion",
    "modelVersion",
    "provider",
    "features",
    "coefficients",
    "regionRisk",
    "defaultRegionRisk",
    "premiumLoading",
    "checksum",
)


class ModelArtifactError(RuntimeError):
    """Raised when the artifact is missing, unreadable, or inconsistent."""


@dataclass(frozen=True)
class ModelArtifact:
    """A verified, immutable pricing model."""

    model_version: str
    provider: str
    features: tuple[str, ...]
    coefficients: tuple[float, ...]
    region_risk: dict[str, float]
    default_region_risk: float
    premium_loading: float
    source_path: Path
    checksum: str

    @property
    def known_regions(self) -> tuple[str, ...]:
        return tuple(sorted(self.region_risk))


def compute_checksum(payload: dict[str, Any]) -> str:
    """
    Checksum over every field except the checksum itself.

    Canonical JSON — sorted keys, fixed separators — so the digest depends on
    the content and not on how it happened to be written.
    """
    body = {key: value for key, value in payload.items() if key != "checksum"}
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _require_finite(value: object, label: str) -> float:
    """
    Coerces to a real, finite float or fails the load.

    NaN and infinity survive JSON round-trips through most writers and then
    poison arithmetic quietly: a NaN coefficient yields a NaN premium, and an
    infinite loading overflows. Neither is detectable once it reaches money.
    """
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError) as error:
        raise ModelArtifactError(f"{label} is not a number: {value!r}") from error

    if not math.isfinite(number):
        raise ModelArtifactError(f"{label} must be finite, got {number}")
    return number


def load_artifact(path: Path) -> ModelArtifact:
    """
    Reads, verifies, and returns the model at `path`.

    Every failure is fatal by design: this runs at startup, and a service that
    cannot price is not a service that should accept traffic.

    :raises ModelArtifactError: on any missing, malformed, or inconsistent input.
    """
    if not path.is_file():
        raise ModelArtifactError(
            f"No model artifact at {path}. Build it with "
            f"`python scripts/build_baseline_model.py`, or point MODEL_PATH at "
            f"an existing artifact."
        )

    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ModelArtifactError(
            f"Model artifact at {path} could not be read as JSON: {error}"
        ) from error

    if not isinstance(payload, dict):
        raise ModelArtifactError(f"Model artifact at {path} is not a JSON object")

    missing = [field for field in REQUIRED_FIELDS if field not in payload]
    if missing:
        raise ModelArtifactError(
            f"Model artifact at {path} is missing required fields: {', '.join(missing)}"
        )

    schema_version = payload["schemaVersion"]
    if schema_version != SUPPORTED_SCHEMA_VERSION:
        raise ModelArtifactError(
            f"Model artifact at {path} declares schemaVersion={schema_version}, "
            f"but this service reads version {SUPPORTED_SCHEMA_VERSION}"
        )

    expected = compute_checksum(payload)
    if payload["checksum"] != expected:
        raise ModelArtifactError(
            f"Model artifact at {path} failed its integrity check: the file "
            f"records {payload['checksum']} but its contents hash to {expected}. "
            f"It was modified or truncated after being written."
        )

    features = tuple(str(name) for name in payload["features"])
    coefficients = tuple(
        _require_finite(value, f"coefficient {index}")
        for index, value in enumerate(payload["coefficients"])
    )

    if len(features) != len(coefficients):
        raise ModelArtifactError(
            f"Model artifact at {path} has {len(features)} features and "
            f"{len(coefficients)} coefficients; they must correspond"
        )

    if len(set(features)) != len(features):
        raise ModelArtifactError(
            f"Model artifact at {path} repeats a feature: {features}. Each "
            f"feature contributes once, so a duplicate silently doubles it."
        )

    # Exactly the supported set, in any order. Order is free because features
    # and coefficients travel together; membership is not, because a missing
    # feature changes the model without looking like an error, and an unknown
    # one cannot be computed at all.
    if set(features) != BASELINE_FEATURES:
        unknown = sorted(set(features) - BASELINE_FEATURES)
        missing = sorted(BASELINE_FEATURES - set(features))
        raise ModelArtifactError(
            f"Model artifact at {path} does not match the features this service "
            f"evaluates. Unknown: {unknown or 'none'}. Missing: "
            f"{missing or 'none'}."
        )

    try:
        region_items = list(payload["regionRisk"].items())
    except AttributeError as error:
        raise ModelArtifactError(
            f"Model artifact at {path} has a regionRisk that is not a mapping"
        ) from error

    region_risk = {
        str(region).strip().lower(): _require_finite(value, f"regionRisk[{region}]")
        for region, value in region_items
    }

    return ModelArtifact(
        model_version=str(payload["modelVersion"]),
        provider=str(payload["provider"]),
        features=features,
        coefficients=coefficients,
        region_risk=region_risk,
        default_region_risk=_require_finite(
            payload["defaultRegionRisk"], "defaultRegionRisk"
        ),
        premium_loading=_require_finite(payload["premiumLoading"], "premiumLoading"),
        source_path=path,
        checksum=str(payload["checksum"]),
    )
