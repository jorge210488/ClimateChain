"""
Loading and integrity verification of the rainfall history dataset.

The dataset is the input the pricing model is trained from, and it is committed
alongside the artifact for the same reason the artifact is: training has to be
reproducible without a network, and reproducible means the bytes it read are
the bytes in the repository. A checksum over the parsed content turns "we
believe this is the data" into something the gate can verify.

The runtime never reads this module. The trainer and the tests do, and the
fetch script uses it to validate what it is about to write.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from app.models.artifact import compute_checksum

SUPPORTED_DATASET_SCHEMA_VERSION = 1

REQUIRED_DATASET_FIELDS = (
    "schemaVersion",
    "datasetVersion",
    "source",
    "dateRange",
    "days",
    "regions",
    "checksum",
)


class RainfallDatasetError(RuntimeError):
    """Raised when the dataset is missing, malformed, or inconsistent."""


@dataclass(frozen=True)
class RegionSeries:
    """Daily precipitation for one region, in millimetres, one value per day."""

    key: str
    latitude: float
    longitude: float
    mm_per_day: tuple[float, ...]


@dataclass(frozen=True)
class RainfallDataset:
    """A verified rainfall history."""

    dataset_version: str
    source: dict[str, Any]
    start: date
    end: date
    days: int
    regions: dict[str, RegionSeries]
    checksum: str
    source_path: Path

    def series(self, region: str) -> RegionSeries:
        return self.regions[region.strip().lower()]


def _reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    seen: dict[str, object] = {}
    for key, value in pairs:
        if key in seen:
            raise ValueError(f"duplicate JSON member {key!r}")
        seen[key] = value
    return seen


def _reject_non_standard_constant(name: str) -> object:
    raise ValueError(f"{name} is not valid JSON")


def expected_day_count(start: date, end: date) -> int:
    """Inclusive number of calendar days between two dates."""
    return (end - start).days + 1


def load_rainfall_dataset(path: Path) -> RainfallDataset:
    """
    Reads, verifies, and returns the dataset at `path`.

    :raises RainfallDatasetError: on any missing, malformed, or inconsistent input.
    """
    if not path.is_file():
        raise RainfallDatasetError(
            f"No rainfall dataset at {path}. Fetch it with "
            f"`python scripts/fetch_rainfall_history.py`."
        )

    try:
        payload = json.loads(
            path.read_text(encoding="utf-8"),
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=_reject_non_standard_constant,
        )
    except (OSError, ValueError) as error:
        raise RainfallDatasetError(
            f"Rainfall dataset at {path} could not be read as JSON: {error}"
        ) from error

    if not isinstance(payload, dict):
        raise RainfallDatasetError(f"Rainfall dataset at {path} is not a JSON object")

    missing = [field for field in REQUIRED_DATASET_FIELDS if field not in payload]
    if missing:
        raise RainfallDatasetError(
            f"Rainfall dataset at {path} is missing required fields: "
            f"{', '.join(missing)}"
        )

    schema_version = payload["schemaVersion"]
    if isinstance(schema_version, bool) or schema_version != (
        SUPPORTED_DATASET_SCHEMA_VERSION
    ):
        raise RainfallDatasetError(
            f"Rainfall dataset at {path} declares schemaVersion={schema_version!r}, "
            f"but this loader reads version {SUPPORTED_DATASET_SCHEMA_VERSION}"
        )

    expected = compute_checksum(payload)
    if payload["checksum"] != expected:
        raise RainfallDatasetError(
            f"Rainfall dataset at {path} failed its integrity check: the file "
            f"records {payload['checksum']} but its contents hash to {expected}."
        )

    try:
        start = date.fromisoformat(payload["dateRange"]["start"])
        end = date.fromisoformat(payload["dateRange"]["end"])
    except (KeyError, TypeError, ValueError) as error:
        raise RainfallDatasetError(
            f"Rainfall dataset at {path} has an invalid dateRange: {error}"
        ) from error

    if end < start:
        raise RainfallDatasetError(
            f"Rainfall dataset at {path} ends ({end}) before it starts ({start})"
        )

    days = payload["days"]
    if isinstance(days, bool) or not isinstance(days, int):
        raise RainfallDatasetError(f"Rainfall dataset at {path} has a non-integer days")
    if days != expected_day_count(start, end):
        raise RainfallDatasetError(
            f"Rainfall dataset at {path} declares {days} days but {start}..{end} "
            f"spans {expected_day_count(start, end)}"
        )

    raw_regions = payload["regions"]
    if not isinstance(raw_regions, dict) or not raw_regions:
        raise RainfallDatasetError(
            f"Rainfall dataset at {path} must define at least one region"
        )

    regions: dict[str, RegionSeries] = {}
    for key, entry in raw_regions.items():
        normalized = str(key).strip().lower()
        if not normalized:
            raise RainfallDatasetError(f"Rainfall dataset at {path} has a blank region")
        if normalized in regions:
            raise RainfallDatasetError(
                f"Rainfall dataset at {path} defines region {normalized!r} twice"
            )
        if not isinstance(entry, dict):
            raise RainfallDatasetError(
                f"Rainfall dataset at {path}: region {key!r} is not an object"
            )

        values = entry.get("mmPerDay")
        if not isinstance(values, list):
            raise RainfallDatasetError(
                f"Rainfall dataset at {path}: region {key!r} has no mmPerDay array"
            )
        if len(values) != days:
            raise RainfallDatasetError(
                f"Rainfall dataset at {path}: region {key!r} has {len(values)} "
                f"values for {days} days"
            )

        series: list[float] = []
        for index, value in enumerate(values):
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise RainfallDatasetError(
                    f"Rainfall dataset at {path}: region {key!r} day {index} is not "
                    f"a number: {value!r}"
                )
            number = float(value)
            if not math.isfinite(number) or number < 0:
                # Rainfall cannot be negative or unbounded; either means the
                # source returned a sentinel that must not be trained on.
                raise RainfallDatasetError(
                    f"Rainfall dataset at {path}: region {key!r} day {index} is "
                    f"not a valid precipitation value: {number}"
                )
            series.append(number)

        try:
            latitude = float(entry["latitude"])
            longitude = float(entry["longitude"])
        except (KeyError, TypeError, ValueError) as error:
            raise RainfallDatasetError(
                f"Rainfall dataset at {path}: region {key!r} lacks coordinates"
            ) from error

        regions[normalized] = RegionSeries(
            key=normalized,
            latitude=latitude,
            longitude=longitude,
            mm_per_day=tuple(series),
        )

    return RainfallDataset(
        dataset_version=str(payload["datasetVersion"]),
        source=dict(payload["source"]),
        start=start,
        end=end,
        days=days,
        regions=regions,
        checksum=str(payload["checksum"]),
        source_path=path,
    )


def day_index(dataset: RainfallDataset, when: date) -> int:
    """Position of a calendar date inside every region's series."""
    if when < dataset.start or when > dataset.end:
        raise ValueError(f"{when} is outside {dataset.start}..{dataset.end}")
    return (when - dataset.start).days


def date_at(dataset: RainfallDataset, index: int) -> date:
    """Calendar date at a series position."""
    return dataset.start + timedelta(days=index)
