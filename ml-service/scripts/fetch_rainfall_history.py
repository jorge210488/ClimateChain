"""
Fetches observed daily rainfall for every region and writes the dataset.

This is the only step in the pipeline that touches the network, and it is run
deliberately rather than as part of any gate: the dataset it produces is
committed, checksummed, and read back by training and by the tests, so the
rest of the pipeline is reproducible from the repository alone. Re-running this
script is how the dataset is *refreshed*, and a refresh that changes nothing
leaves the file byte-identical.

Source: the Open-Meteo Historical Weather API, which serves ERA5 reanalysis —
observations assimilated into a global model at ~10 km — as daily precipitation
sums. It requires no key and no account, which is why the credentials reserved
for a weather provider stay empty. The model is therefore trained on real
climate rather than the synthetic history Stage 07 was fitted to.

The committed dataset is never overwritten with something that has not passed
the loader: the new file is written beside it, verified as the trainer would
read it, and only then moved into place.

Usage:
    python scripts/fetch_rainfall_history.py [--output PATH]
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

MODULE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MODULE_ROOT))

from app.data.rainfall import (  # noqa: E402
    MAX_PLAUSIBLE_DAILY_MM,
    SUPPORTED_DATASET_SCHEMA_VERSION,
    RainfallDatasetError,
    expected_day_count,
    load_rainfall_dataset,
)
from app.data.regions import Region, load_region_registry  # noqa: E402
from app.models.artifact import compute_checksum  # noqa: E402

DEFAULT_OUTPUT = MODULE_ROOT / "data" / "rainfall-history.json"
REGIONS_PATH = MODULE_ROOT / "data" / "regions.json"

# Thirty complete years, ending at the most recent complete calendar year at
# the time of the fetch. Long enough that a 300 mm day — rare almost everywhere
# — appears often enough to estimate; whole years so the time-based split in
# training falls on year boundaries; and rolling, so a refresh actually
# refreshes the evidence instead of re-downloading the same decades. The
# dataset names its own range in `datasetVersion`, and the gate fails when the
# range is older than the freshness policy allows (see app/data/rainfall.py).
YEARS = 30


def last_complete_year(today: date) -> int:
    return today.year - 1


def window_for(today: date) -> tuple[date, date]:
    end_year = last_complete_year(today)
    return date(end_year - YEARS + 1, 1, 1), date(end_year, 12, 31)


START, END = window_for(datetime.now(UTC).date())
DATASET_VERSION = f"rainfall-history-{START.year}-{END.year}"

ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
VARIABLE = "precipitation_sum"
REQUEST_TIMEOUT_SECONDS = 120

# Values are stored to the precision the source reports. Keeping more digits
# would be false precision and would bloat a committed file for nothing.
DECIMALS = 1


class FetchError(RuntimeError):
    """Raised when the source does not return a usable series."""


def load_regions() -> dict[str, Region]:
    return load_region_registry(REGIONS_PATH)


def expected_dates(start: date = START, end: date = END) -> list[str]:
    """Every calendar day the source is asked for, in the order it must answer."""
    return [
        (start + timedelta(days=offset)).isoformat()
        for offset in range(expected_day_count(start, end))
    ]


def download(latitude: float, longitude: float) -> dict:
    """One archive request. The only function here that reaches the network."""
    query = urllib.parse.urlencode(
        {
            "latitude": latitude,
            "longitude": longitude,
            "start_date": START.isoformat(),
            "end_date": END.isoformat(),
            "daily": VARIABLE,
            "timezone": "UTC",
        }
    )
    url = f"{ARCHIVE_URL}?{query}"
    try:
        with urllib.request.urlopen(url, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            return json.load(response)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        raise FetchError(f"request failed: {error}") from error


def parse_series(
    key: str, body: object, start: date = START, end: date = END
) -> list[float]:
    """
    Turns one response into a validated series, or refuses it.

    Every value is checked before anything is built from it. A short or gappy
    series is refused rather than patched — interpolating a missing day would
    invent rainfall the source never observed — and so is anything that is not
    a finite, non-negative number: a boolean would read as 1 mm, a string would
    coerce, and a NaN would pass every `<` comparison and poison the fit.
    """
    if not isinstance(body, dict):
        raise FetchError(f"{key}: response is not a JSON object")

    units_block = body.get("daily_units")
    units = units_block.get(VARIABLE) if isinstance(units_block, dict) else None
    if units != "mm":
        raise FetchError(f"{key}: expected millimetres, source reports {units!r}")

    daily = body.get("daily")
    if not isinstance(daily, dict):
        raise FetchError(f"{key}: response has no daily block")

    # The calendar is checked, not assumed: a series of the right length that
    # starts a day late would silently shift every window the model measures.
    dates = expected_dates(start, end)
    if daily.get("time") != dates:
        received = daily.get("time")
        summary = (
            f"{len(received)} entries, {received[0]!r}..{received[-1]!r}"
            if isinstance(received, list) and received
            else repr(received)
        )
        raise FetchError(
            f"{key}: daily.time does not cover exactly {dates[0]}..{dates[-1]} "
            f"({len(dates)} days); got {summary}"
        )

    values = daily.get(VARIABLE)
    if not isinstance(values, list) or len(values) != len(dates):
        received = len(values) if isinstance(values, list) else "no"
        raise FetchError(f"{key}: expected {len(dates)} daily values, got {received}")

    missing = [index for index, value in enumerate(values) if value is None]
    if missing:
        raise FetchError(
            f"{key}: {len(missing)} missing days (first {dates[missing[0]]}); "
            f"refusing to fabricate values for them"
        )

    series: list[float] = []
    for index, value in enumerate(values):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise FetchError(
                f"{key}: value for {dates[index]} is not a number: {value!r}"
            )
        try:
            number = float(value)
        except OverflowError as error:
            raise FetchError(
                f"{key}: value for {dates[index]} is too large to represent"
            ) from error
        if not math.isfinite(number) or number < 0:
            raise FetchError(
                f"{key}: value for {dates[index]} is not a valid precipitation "
                f"amount: {number}"
            )
        if number > MAX_PLAUSIBLE_DAILY_MM:
            # A finite number can still be impossible. The bound is the WMO
            # 24-hour world record with headroom; see app/data/rainfall.py.
            raise FetchError(
                f"{key}: value for {dates[index]} is {number} mm, above the "
                f"physically plausible daily maximum of {MAX_PLAUSIBLE_DAILY_MM:g} mm"
            )
        series.append(round(number, DECIMALS))
    return series


def fetch_region(region: Region) -> list[float]:
    try:
        body = download(region.latitude, region.longitude)
    except FetchError as error:
        raise FetchError(f"{region.key}: {error}") from error
    return parse_series(region.key, body)


def build_payload(regions: dict[str, Region], series: dict[str, list[float]]) -> dict:
    payload = {
        "schemaVersion": SUPPORTED_DATASET_SCHEMA_VERSION,
        "datasetVersion": DATASET_VERSION,
        "source": {
            "provider": "Open-Meteo Historical Weather API",
            "product": "ERA5 reanalysis, daily precipitation sum",
            "url": ARCHIVE_URL,
            "variable": VARIABLE,
            "units": "mm",
            "timezone": "UTC",
            "licence": "CC BY 4.0 (Open-Meteo); ERA5 via Copernicus C3S",
        },
        "dateRange": {"start": START.isoformat(), "end": END.isoformat()},
        "days": expected_day_count(START, END),
        "decimals": DECIMALS,
        "fetchedAt": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "regions": {
            key: {
                "name": regions[key].name,
                "country": regions[key].country,
                "latitude": regions[key].latitude,
                "longitude": regions[key].longitude,
                "mmPerDay": series[key],
            }
            for key in sorted(series)
        },
    }
    payload["checksum"] = compute_checksum(payload)
    return payload


def _preserve_fetched_at(payload: dict, output: Path) -> dict:
    """
    Keeps the existing timestamp when the data did not change.

    A refresh that returns identical observations should leave the file
    byte-identical, so `git status` reports a real change in the source and
    never a mere re-run.
    """
    if not output.is_file():
        return payload
    try:
        existing = json.loads(output.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return payload

    ignored = ("fetchedAt", "checksum")
    if {k: v for k, v in payload.items() if k not in ignored} != {
        k: v for k, v in existing.items() if k not in ignored
    }:
        return payload
    if "fetchedAt" not in existing:
        return payload

    payload["fetchedAt"] = existing["fetchedAt"]
    payload["checksum"] = compute_checksum(payload)
    return payload


def write_dataset(payload: dict, output: Path) -> None:
    """
    Writes the dataset without ever leaving a bad file at `output`.

    The payload goes to a sibling temporary file, is flushed to disk, and is
    read back through the same loader the trainer uses. Only a file that
    passed replaces the previous one, atomically, so a refresh that produced
    something unloadable cannot destroy the dataset the gate depends on.
    """
    output.parent.mkdir(parents=True, exist_ok=True)
    # Named per process so two refreshes started together cannot write into,
    # verify, and move the same staging file out from under each other.
    temporary = output.with_name(f"{output.name}.{os.getpid()}.tmp")
    try:
        with temporary.open("w", encoding="utf-8", newline="\n") as handle:
            handle.write(
                json.dumps(payload, indent=None, separators=(",", ":"), sort_keys=True)
            )
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        try:
            load_rainfall_dataset(temporary)
        except RainfallDatasetError as error:
            raise FetchError(
                f"refusing to replace {output.name}: the fetched dataset does not "
                f"load: {error}"
            ) from error
        os.replace(temporary, output)
    finally:
        if temporary.exists():
            temporary.unlink()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()

    regions = load_regions()
    series: dict[str, list[float]] = {}
    for key, region in regions.items():
        print(f"Fetching {key:<14} ({region.latitude}, {region.longitude})...")
        series[key] = fetch_region(region)
        mean = sum(series[key]) / len(series[key])
        print(
            f"  {len(series[key])} days, mean {mean:.2f} mm/day, "
            f"max {max(series[key]):.1f} mm"
        )

    payload = _preserve_fetched_at(build_payload(regions, series), args.output)
    write_dataset(payload, args.output)

    # Report from the file on disk, which is what counts, not the dict.
    dataset = load_rainfall_dataset(args.output)
    size_kb = args.output.stat().st_size / 1024
    print(f"\nDataset:   {dataset.dataset_version}")
    print(f"Range:     {dataset.start} -> {dataset.end} ({dataset.days} days)")
    print(f"Regions:   {len(dataset.regions)}")
    print(f"Checksum:  {dataset.checksum}")
    print(f"Written:   {args.output} ({size_kb:.0f} KB)")


if __name__ == "__main__":
    try:
        main()
    except FetchError as error:
        raise SystemExit(f"fetch failed: {error}") from error
