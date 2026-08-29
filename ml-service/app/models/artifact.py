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
# Scale the pricing service multiplies the loaded rate by before converting to
# an integer. Declared here so loading can prove the multiplication stays
# finite rather than discovering it at quote time.
PREMIUM_RATE_SCALE = 10**12

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
    Requires a real, finite JSON number.

    Deliberately no coercion. `float("1.5")` succeeds, so a coefficient written
    as a string used to load and price — silently, from a file that had passed
    its checksum. An artifact whose shape does not match the contract is a
    broken artifact, not one to interpret generously.

    Booleans are excluded explicitly: `bool` is a subclass of `int` in Python,
    so `True` would otherwise pass as the number 1.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ModelArtifactError(
            f"{label} must be a JSON number, got {type(value).__name__}: {value!r}"
        )

    number = float(value)
    if not math.isfinite(number):
        raise ModelArtifactError(f"{label} must be finite, got {number}")
    return number


def _require_non_empty_string(value: object, label: str) -> str:
    """Requires a JSON string with at least one non-whitespace character."""
    if not isinstance(value, str) or not value.strip():
        raise ModelArtifactError(f"{label} must be a non-empty string, got {value!r}")
    return value


def _require_list(value: object, label: str) -> list:
    """
    Requires a JSON array.

    A string is iterable, so `features: "abcd"` would otherwise become four
    single-character features — a model that loads and evaluates something
    nobody wrote.
    """
    if not isinstance(value, list):
        raise ModelArtifactError(
            f"{label} must be a JSON array, got {type(value).__name__}: {value!r}"
        )
    return value


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
    # `True == 1` in Python, so a boolean would satisfy the equality below and
    # load as version 1.
    if isinstance(schema_version, bool) or not isinstance(schema_version, int):
        raise ModelArtifactError(
            f"Model artifact at {path} has a non-integer schemaVersion: "
            f"{schema_version!r}"
        )
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

    features = tuple(
        _require_non_empty_string(name, f"feature {index}")
        for index, name in enumerate(_require_list(payload["features"], "features"))
    )
    coefficients = tuple(
        _require_finite(value, f"coefficient {index}")
        for index, value in enumerate(
            _require_list(payload["coefficients"], "coefficients")
        )
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

    premium_loading = _require_finite(payload["premiumLoading"], "premiumLoading")
    if premium_loading < 0:
        # A negative loading charges less than the expected loss, which is not a
        # pricing choice but a broken model. It also hides: every quote falls to
        # the minimum floor and the service looks like it is working.
        raise ModelArtifactError(
            f"Model artifact at {path} has premiumLoading={premium_loading}. A "
            f"loading below zero would price coverage under its expected loss."
        )

    # Finite is not enough on its own. Pricing multiplies (1 + loading) by the
    # rate scale and rounds to an integer, and a merely finite value like 1e308
    # overflows there — loading fine, readiness green, and a 500 on the first
    # quote. Proving the worst case here is what keeps fail-fast honest.
    worst_case_rate = (1.0 + premium_loading) * PREMIUM_RATE_SCALE
    if not math.isfinite(worst_case_rate):
        raise ModelArtifactError(
            f"Model artifact at {path} has premiumLoading={premium_loading}, "
            f"which overflows when scaled for pricing. The model would load and "
            f"then fail on every quote."
        )

    try:
        region_items = list(payload["regionRisk"].items())
    except AttributeError as error:
        raise ModelArtifactError(
            f"Model artifact at {path} has a regionRisk that is not a mapping"
        ) from error

    region_risk: dict[str, float] = {}
    for region, value in region_items:
        normalized = (
            _require_non_empty_string(region, f"regionRisk key {region!r}")
            .strip()
            .lower()
        )
        if normalized in region_risk:
            # Two spellings of one region, silently resolved by JSON key order
            # before this check existed. The price would then depend on how the
            # file happened to be written.
            raise ModelArtifactError(
                f"Model artifact at {path} defines region {normalized!r} more "
                f"than once (last seen as {region!r}); lookups are "
                f"case-insensitive, so the risk would be ambiguous."
            )
        region_risk[normalized] = _require_finite(value, f"regionRisk[{region}]")

    return ModelArtifact(
        model_version=_require_non_empty_string(
            payload["modelVersion"], "modelVersion"
        ),
        provider=_require_non_empty_string(payload["provider"], "provider"),
        features=features,
        coefficients=coefficients,
        region_risk=region_risk,
        default_region_risk=_require_finite(
            payload["defaultRegionRisk"], "defaultRegionRisk"
        ),
        premium_loading=premium_loading,
        source_path=path,
        checksum=_require_non_empty_string(payload["checksum"], "checksum"),
    )
