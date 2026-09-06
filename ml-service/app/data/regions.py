"""
The region registry: which regions the model is trained for, and where.

One loader, used by the fetch script, the gate, and the tests, so every reader
applies the same rules. The registry decides which coordinates thirty years of
rainfall are read from and which keys the runtime resolves a request to; a
permissive reader here would let a typo become a region nobody meant to insure.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

from app.core.domain import MAX_REGION_CODE_BYTES

SUPPORTED_REGISTRY_SCHEMA_VERSION = 1


class RegionRegistryError(RuntimeError):
    """Raised when the registry is missing, malformed, or inconsistent."""


@dataclass(frozen=True)
class Region:
    """One registered region, keyed by the form the runtime looks up."""

    key: str
    name: str
    country: str
    latitude: float
    longitude: float


def _reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    seen: dict[str, object] = {}
    for key, value in pairs:
        if key in seen:
            raise ValueError(f"duplicate JSON member {key!r}")
        seen[key] = value
    return seen


def _reject_non_standard_constant(name: str) -> object:
    raise ValueError(f"{name} is not valid JSON")


def _text(value: object, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise RegionRegistryError(f"{label} must be a non-empty string, got {value!r}")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise RegionRegistryError(f"{label} is not well-formed UTF-8 text") from error
    return value


def _coordinate(value: object, label: str, limit: float) -> float:
    # `bool` is an `int`, so `true` would otherwise read as latitude 1.0.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RegionRegistryError(f"{label} must be a number, got {value!r}")
    number = float(value)
    if not math.isfinite(number) or abs(number) > limit:
        raise RegionRegistryError(
            f"{label} must be a finite number within ±{limit:g}, got {number}"
        )
    return number


def load_region_registry(path: Path) -> dict[str, Region]:
    """
    Reads and validates the registry at `path`.

    :raises RegionRegistryError: on any missing, malformed, or inconsistent input.
    """
    if not path.is_file():
        raise RegionRegistryError(f"No region registry at {path}")

    try:
        payload = json.loads(
            path.read_text(encoding="utf-8"),
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=_reject_non_standard_constant,
        )
    except (OSError, ValueError) as error:
        raise RegionRegistryError(
            f"Region registry at {path} could not be read as JSON: {error}"
        ) from error

    if not isinstance(payload, dict):
        raise RegionRegistryError(f"Region registry at {path} is not a JSON object")

    schema_version = payload.get("schemaVersion")
    if isinstance(schema_version, bool) or schema_version != (
        SUPPORTED_REGISTRY_SCHEMA_VERSION
    ):
        raise RegionRegistryError(
            f"Region registry at {path} declares schemaVersion={schema_version!r}, "
            f"but this loader reads version {SUPPORTED_REGISTRY_SCHEMA_VERSION}"
        )

    raw = payload.get("regions")
    if not isinstance(raw, dict) or not raw:
        raise RegionRegistryError(
            f"Region registry at {path} must define at least one region"
        )

    regions: dict[str, Region] = {}
    for key, entry in raw.items():
        _text(key, f"region key {key!r}")
        # The key is what a request resolves to after `strip().lower()`; a key
        # that is not already in that form could never be matched.
        if key != key.strip().lower():
            raise RegionRegistryError(
                f"Region registry at {path}: key {key!r} is not canonical; "
                f"use {key.strip().lower()!r}"
            )
        if len(key.encode("utf-8")) > MAX_REGION_CODE_BYTES:
            raise RegionRegistryError(
                f"Region registry at {path}: key {key!r} exceeds the on-chain "
                f"region budget of {MAX_REGION_CODE_BYTES} bytes"
            )
        if not isinstance(entry, dict):
            raise RegionRegistryError(
                f"Region registry at {path}: region {key!r} is not an object"
            )

        regions[key] = Region(
            key=key,
            name=_text(entry.get("name"), f"region {key!r} name"),
            country=_text(entry.get("country"), f"region {key!r} country"),
            latitude=_coordinate(entry.get("latitude"), f"region {key!r} latitude", 90),
            longitude=_coordinate(
                entry.get("longitude"), f"region {key!r} longitude", 180
            ),
        )

    return dict(sorted(regions.items()))
