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

# Scale the pricing service multiplies the loaded rate by before converting to
# an integer. Declared here so loading can prove the multiplication stays finite
# rather than discovering it at quote time.
PREMIUM_RATE_SCALE = 10**12

# Features the baseline evaluator can compute. Declared here rather than in the
# evaluator so loading can reject an artifact the evaluator would choke on:
# discovering an unknown feature at quote time means readiness reported "ready"
# for a model that cannot price, which is exactly what fail-fast is for.
BASELINE_FEATURES = frozenset(
    {"intercept", "log_threshold_mm", "log_duration_days", "region_risk"}
)

# What a `training` block may say the model was fitted to. Anything else is a
# provenance claim the runtime cannot interpret, and so must not accept.
TRAINING_KINDS = frozenset({"observed", "synthetic"})

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
    # Provenance, surfaced by readiness. Optional because the artifact contract
    # predates it; a model that omits it is still loadable, it just cannot say
    # what it was trained on — and "cannot say" is recorded as None, never as
    # a reassuring default.
    dataset_version: str | None = None
    training_kind: str | None = None
    # True marks a model that must not be used to price real risk — the
    # Stage 07 synthetic fit. None means the artifact makes no claim either
    # way. A deployed profile refuses anything but an explicit False.
    transitional: bool | None = None
    # The grid the fit was measured on, when the artifact records it. A quote
    # outside it is an extrapolation of the model's functional form, not a
    # frequency anyone counted, and the response says so.
    trained_duration_days: tuple[int, int] | None = None
    trained_threshold_mm: tuple[int, int] | None = None

    @property
    def known_regions(self) -> tuple[str, ...]:
        return tuple(sorted(self.region_risk))

    def is_within_trained_domain(
        self, duration_days: int, rainfall_threshold_mm: int
    ) -> bool:
        """False outside the recorded grid, and false when no grid is recorded."""
        if self.trained_duration_days is None or self.trained_threshold_mm is None:
            return False
        low, high = self.trained_duration_days
        if not low <= duration_days <= high:
            return False
        low, high = self.trained_threshold_mm
        return low <= rainfall_threshold_mm <= high


def compute_checksum(payload: dict[str, Any]) -> str:
    """
    Checksum over every field except the checksum itself.

    Canonical JSON — sorted keys, fixed separators — so the digest depends on
    the content and not on how it happened to be written.
    """
    body = {key: value for key, value in payload.items() if key != "checksum"}
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _reject_non_standard_constant(name: str) -> object:
    """
    Refuses `NaN`, `Infinity`, and `-Infinity`.

    Python's parser accepts these as an extension; the JSON specification does
    not, and most other parsers reject them. Allowing them would produce an
    artifact that loads here and fails to parse anywhere else, with a checksum
    blessing values no conforming reader can represent.
    """
    raise ValueError(
        f"{name} is not valid JSON; the artifact must be readable by any "
        f"conforming parser"
    )


def _reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    """
    Builds a JSON object, refusing repeated members.

    `json.loads` keeps the last value for a repeated key and discards the rest
    silently. That defeats the checksum: the digest covers the parsed object, so
    a file can contain a `premiumLoading` that never participated in its own
    hash and is invisible to every check that follows.
    """
    seen: dict[str, object] = {}
    for key, value in pairs:
        if key in seen:
            raise ValueError(
                f"duplicate JSON member {key!r}; the checksum covers the parsed "
                f"object, so a repeated key hides a value from it"
            )
        seen[key] = value
    return seen


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

    try:
        number = float(value)
    except OverflowError as error:
        # A JSON integer with thousands of digits is valid JSON and has no float
        # to become. Left uncaught it escaped startup as an OverflowError,
        # losing the artifact path and the field name that make it diagnosable.
        raise ModelArtifactError(
            f"{label} is too large to represent as a number"
        ) from error

    if not math.isfinite(number):
        raise ModelArtifactError(f"{label} must be finite, got {number}")
    return number


def _require_non_negative_finite(value: object, label: str) -> float:
    """Requires a finite JSON number in the non-negative rainfall domain."""
    number = _require_finite(value, label)
    if number < 0:
        raise ModelArtifactError(f"{label} must not be negative, got {number}")
    return number


def _require_non_empty_string(value: object, label: str) -> str:
    """
    Requires a JSON string with content that UTF-8 can carry.

    Encodability belongs here rather than at the response boundary. JSON permits
    an unpaired surrogate, so a `modelVersion` holding one loaded cleanly and
    then broke every response that named it — readiness and `/predict` both
    returned 500 from a service that had started successfully. A value this
    process cannot serialise is not one it can operate on.
    """
    if not isinstance(value, str) or not value.strip():
        raise ModelArtifactError(f"{label} must be a non-empty string, got {value!r}")

    try:
        value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ModelArtifactError(
            f"{label} must be well-formed UTF-8 text; it contains a character "
            f"that cannot be encoded, such as an unpaired surrogate"
        ) from error

    return value


def _require_sha256_hex(value: object, label: str) -> str:
    """Requires the textual form of a SHA-256 digest, as the trainer writes it."""
    text = _require_non_empty_string(value, label)
    if len(text) != 64 or any(c not in "0123456789abcdef" for c in text):
        raise ModelArtifactError(
            f"{label} must be 64 hexadecimal characters, got {text!r}"
        )
    return text


def _grid_range(value: object, label: str) -> tuple[int, int]:
    """The extent of a training grid: a non-empty array of positive integers."""
    items = _require_list(value, label)
    if not items:
        raise ModelArtifactError(f"{label} must not be empty")
    for item in items:
        if isinstance(item, bool) or not isinstance(item, int) or item < 1:
            raise ModelArtifactError(
                f"{label} must hold positive integers, got {item!r}"
            )
    return (min(items), max(items))


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
            f"`python scripts/train_rainfall_model.py`, or point MODEL_PATH at "
            f"an existing artifact."
        )

    try:
        payload = json.loads(
            path.read_text(encoding="utf-8"),
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=_reject_non_standard_constant,
        )
    except (OSError, ValueError) as error:
        # ValueError rather than JSONDecodeError alone: the duplicate-member
        # hook raises a plain ValueError, and letting it escape would lose the
        # artifact path that makes the failure actionable.
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
    if not region_items:
        raise ModelArtifactError(
            f"Model artifact at {path} has no regionRisk entries. A baseline "
            "model must define at least one known region."
        )

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
        region_risk[normalized] = _require_non_negative_finite(
            value, f"regionRisk[{region}]"
        )

    # Provenance is optional but, when present, held to the same standard as
    # the rest. A block that claims observed training must carry what makes
    # the claim checkable — the dataset, its checksum, the configuration hash —
    # or a hand-edited file could announce itself as observed with nothing
    # behind it.
    training = payload.get("training")
    dataset_version: str | None = None
    training_kind: str | None = None
    transitional: bool | None = None
    trained_duration_days: tuple[int, int] | None = None
    trained_threshold_mm: tuple[int, int] | None = None
    if training is not None:
        if not isinstance(training, dict):
            raise ModelArtifactError(
                f"Model artifact at {path} has a training block that is not an object"
            )
        if "kind" not in training or "transitional" not in training:
            raise ModelArtifactError(
                f"Model artifact at {path} has a training block without both "
                f"kind and transitional; provenance that cannot say what the "
                f"model was trained on is not provenance"
            )
        training_kind = _require_non_empty_string(training["kind"], "training.kind")
        if training_kind not in TRAINING_KINDS:
            raise ModelArtifactError(
                f"Model artifact at {path}: training.kind must be one of "
                f"{sorted(TRAINING_KINDS)}, got {training_kind!r}"
            )
        if not isinstance(training["transitional"], bool):
            raise ModelArtifactError(
                f"Model artifact at {path} has a non-boolean training.transitional"
            )
        transitional = training["transitional"]
        if "datasetVersion" in training:
            dataset_version = _require_non_empty_string(
                training["datasetVersion"], "training.datasetVersion"
            )
        if training_kind == "observed":
            for field in ("datasetVersion", "datasetChecksum", "configHash"):
                if field not in training:
                    raise ModelArtifactError(
                        f"Model artifact at {path} claims observed training but "
                        f"has no training.{field}; an observed model must name "
                        f"the data and configuration it was fitted to"
                    )
            _require_sha256_hex(training["datasetChecksum"], "training.datasetChecksum")
            _require_sha256_hex(training["configHash"], "training.configHash")
        if "durationDaysGrid" in training:
            trained_duration_days = _grid_range(
                training["durationDaysGrid"], "training.durationDaysGrid"
            )
        if "thresholdMmGrid" in training:
            trained_threshold_mm = _grid_range(
                training["thresholdMmGrid"], "training.thresholdMmGrid"
            )

    return ModelArtifact(
        model_version=_require_non_empty_string(
            payload["modelVersion"], "modelVersion"
        ),
        provider=_require_non_empty_string(payload["provider"], "provider"),
        features=features,
        coefficients=coefficients,
        region_risk=region_risk,
        default_region_risk=_require_non_negative_finite(
            payload["defaultRegionRisk"], "defaultRegionRisk"
        ),
        premium_loading=premium_loading,
        source_path=path,
        checksum=_require_non_empty_string(payload["checksum"], "checksum"),
        dataset_version=dataset_version,
        training_kind=training_kind,
        transitional=transitional,
        trained_duration_days=trained_duration_days,
        trained_threshold_mm=trained_threshold_mm,
    )
