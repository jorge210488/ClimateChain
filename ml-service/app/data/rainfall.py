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
import re
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from app.models.artifact import compute_checksum

SUPPORTED_DATASET_SCHEMA_VERSION = 1

# The most rain ever recorded in 24 hours is 1,825 mm (Foc-Foc, La Réunion,
# 7-8 January 1966, the WMO world record). A daily sum above this bound is not
# an extreme event, it is a sentinel or a unit error, and training on it would
# move every region's risk. Kept generous rather than tuned to any dataset so
# the bound has a physical meaning, not a statistical one.
MAX_PLAUSIBLE_DAILY_MM = 2000.0

# The freshness policy. A dataset whose last complete year is older than this
# many years behind the current one no longer describes the climate a deployed
# model prices into, and the gate says so rather than letting the evidence age
# silently. Two, not one, so the refresh is a planned act each year and not a
# CI failure on every first of January.
MAX_DATASET_AGE_YEARS = 2

# Dates are written and read in one spelling. `date.fromisoformat` also accepts
# `19950101` on recent Pythons; the producer never writes that, so a reader
# that accepted it would be lying about the contract.
CALENDAR_DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")

# What a dataset must say about where it came from. Provenance is part of the
# data, and a source that cannot be named is a source that cannot be audited.
REQUIRED_SOURCE_FIELDS = (
    "provider",
    "product",
    "url",
    "variable",
    "units",
    "timezone",
    "licence",
)

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


def _calendar_date(value: object) -> date:
    """Parses exactly the `YYYY-MM-DD` spelling the producer writes."""
    if not isinstance(value, str) or not CALENDAR_DATE.fullmatch(value):
        raise ValueError(f"{value!r} is not a YYYY-MM-DD calendar date")
    return date.fromisoformat(value)


def _coordinate(value: object, label: str, limit: float) -> float:
    # `bool` is an `int`, so `true` would otherwise read as latitude 1.0; and
    # `float("12")` would accept a string the fetcher never writes.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RainfallDatasetError(f"Rainfall dataset at {label} must be a number")
    try:
        number = float(value)
    except OverflowError as error:
        raise RainfallDatasetError(
            f"Rainfall dataset at {label} is too large to represent as a number"
        ) from error
    if not math.isfinite(number) or abs(number) > limit:
        raise RainfallDatasetError(
            f"Rainfall dataset at {label} must be finite and within ±{limit:g}"
        )
    return number


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
    # An integer, exactly: `1.0 == 1` and `True == 1` in Python, and neither is
    # a schema version anyone wrote.
    if (
        isinstance(schema_version, bool)
        or not isinstance(schema_version, int)
        or schema_version != SUPPORTED_DATASET_SCHEMA_VERSION
    ):
        raise RainfallDatasetError(
            f"Rainfall dataset at {path} declares schemaVersion={schema_version!r}, "
            f"but this loader reads integer version {SUPPORTED_DATASET_SCHEMA_VERSION}"
        )

    expected = compute_checksum(payload)
    if payload["checksum"] != expected:
        raise RainfallDatasetError(
            f"Rainfall dataset at {path} failed its integrity check: the file "
            f"records {payload['checksum']} but its contents hash to {expected}."
        )

    for field in ("datasetVersion", "checksum"):
        if not isinstance(payload[field], str) or not payload[field].strip():
            raise RainfallDatasetError(
                f"Rainfall dataset at {path} has a {field} that is not a non-empty "
                f"string"
            )

    source = payload["source"]
    if not isinstance(source, dict):
        raise RainfallDatasetError(
            f"Rainfall dataset at {path} has a source that is not an object"
        )
    for field in REQUIRED_SOURCE_FIELDS:
        value = source.get(field)
        if not isinstance(value, str) or not value.strip():
            raise RainfallDatasetError(
                f"Rainfall dataset at {path} has no source.{field}; provenance "
                f"must name the provider, product, variable, units, and licence"
            )

    try:
        start = _calendar_date(payload["dateRange"]["start"])
        end = _calendar_date(payload["dateRange"]["end"])
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
            try:
                number = float(value)
            except OverflowError as error:
                # A JSON integer with hundreds of digits is valid JSON and has
                # no float to become.
                raise RainfallDatasetError(
                    f"Rainfall dataset at {path}: region {key!r} day {index} is "
                    f"too large to represent as a number"
                ) from error
            if not math.isfinite(number) or number < 0:
                # Rainfall cannot be negative or unbounded; either means the
                # source returned a sentinel that must not be trained on.
                raise RainfallDatasetError(
                    f"Rainfall dataset at {path}: region {key!r} day {index} is "
                    f"not a valid precipitation value: {number}"
                )
            if number > MAX_PLAUSIBLE_DAILY_MM:
                raise RainfallDatasetError(
                    f"Rainfall dataset at {path}: region {key!r} day {index} reports "
                    f"{number} mm, above the physically plausible daily maximum of "
                    f"{MAX_PLAUSIBLE_DAILY_MM:g} mm"
                )
            series.append(number)

        latitude = _coordinate(
            entry.get("latitude"), f"{path}: region {key!r} latitude", 90
        )
        longitude = _coordinate(
            entry.get("longitude"), f"{path}: region {key!r} longitude", 180
        )

        regions[normalized] = RegionSeries(
            key=normalized,
            latitude=latitude,
            longitude=longitude,
            mm_per_day=tuple(series),
        )

    return RainfallDataset(
        dataset_version=payload["datasetVersion"],
        source=dict(source),
        start=start,
        end=end,
        days=days,
        regions=regions,
        checksum=payload["checksum"],
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


def dataset_age_years(dataset: RainfallDataset, today: date) -> int:
    """
    How many complete years the dataset is behind the last complete one.

    Zero means it ends at the most recent complete calendar year; the gate
    refuses anything above `MAX_DATASET_AGE_YEARS`.
    """
    return (today.year - 1) - dataset.end.year
