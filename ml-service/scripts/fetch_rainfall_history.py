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

Usage:
    python scripts/fetch_rainfall_history.py [--output PATH]
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import UTC, date, datetime
from pathlib import Path

MODULE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MODULE_ROOT))

from app.data.rainfall import (  # noqa: E402
    SUPPORTED_DATASET_SCHEMA_VERSION,
    expected_day_count,
    load_rainfall_dataset,
)
from app.models.artifact import compute_checksum  # noqa: E402

DATASET_VERSION = "rainfall-history-v1"
DEFAULT_OUTPUT = MODULE_ROOT / "data" / f"{DATASET_VERSION}.json"
REGIONS_PATH = MODULE_ROOT / "data" / "regions.json"

# Thirty complete years. Long enough that a 300 mm day — rare almost everywhere
# — appears often enough to estimate, and ending on a year boundary so the
# time-based split in training falls on whole years.
START = date(1995, 1, 1)
END = date(2024, 12, 31)

ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
VARIABLE = "precipitation_sum"
REQUEST_TIMEOUT_SECONDS = 120

# Values are stored to the precision the source reports. Keeping more digits
# would be false precision and would bloat a committed file for nothing.
DECIMALS = 1


class FetchError(RuntimeError):
    """Raised when the source does not return a usable series."""


def load_regions() -> dict[str, dict]:
    document = json.loads(REGIONS_PATH.read_text(encoding="utf-8"))
    return document["regions"]


def fetch_region(key: str, latitude: float, longitude: float) -> list[float]:
    """
    Fetches one region's full series and validates it before accepting it.

    A short or gappy series is refused rather than patched: interpolating a
    missing day would invent rainfall the source never observed, and the model
    would then be trained on a value nobody measured.
    """
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
            body = json.load(response)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        raise FetchError(f"{key}: request failed: {error}") from error

    units = body.get("daily_units", {}).get(VARIABLE)
    if units != "mm":
        raise FetchError(f"{key}: expected millimetres, source reports {units!r}")

    values = body.get("daily", {}).get(VARIABLE)
    expected = expected_day_count(START, END)
    if not isinstance(values, list) or len(values) != expected:
        received = len(values) if isinstance(values, list) else "no"
        raise FetchError(f"{key}: expected {expected} daily values, got {received}")

    missing = [index for index, value in enumerate(values) if value is None]
    if missing:
        raise FetchError(
            f"{key}: {len(missing)} missing days (first at index {missing[0]}); "
            f"refusing to fabricate values for them"
        )

    negatives = [value for value in values if value < 0]
    if negatives:
        raise FetchError(f"{key}: {len(negatives)} negative precipitation values")

    return [round(float(value), DECIMALS) for value in values]


def build_payload(regions: dict[str, dict], series: dict[str, list[float]]) -> dict:
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
                "name": regions[key]["name"],
                "country": regions[key]["country"],
                "latitude": regions[key]["latitude"],
                "longitude": regions[key]["longitude"],
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


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()

    regions = load_regions()
    series: dict[str, list[float]] = {}
    for key, region in regions.items():
        print(f"Fetching {key:<14} ({region['latitude']}, {region['longitude']})...")
        series[key] = fetch_region(key, region["latitude"], region["longitude"])
        mean = sum(series[key]) / len(series[key])
        print(
            f"  {len(series[key])} days, mean {mean:.2f} mm/day, "
            f"max {max(series[key]):.1f} mm"
        )

    payload = _preserve_fetched_at(build_payload(regions, series), args.output)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(
            json.dumps(payload, indent=None, separators=(",", ":"), sort_keys=True)
        )
        handle.write("\n")

    # Read it back through the same loader training uses: the file on disk is
    # what counts, not the dict in memory.
    dataset = load_rainfall_dataset(args.output)
    size_kb = args.output.stat().st_size / 1024
    print(f"\nDataset:   {dataset.dataset_version}")
    print(f"Range:     {dataset.start} -> {dataset.end} ({dataset.days} days)")
    print(f"Regions:   {len(dataset.regions)}")
    print(f"Checksum:  {dataset.checksum}")
    print(f"Written:   {args.output} ({size_kb:.0f} KB)")


if __name__ == "__main__":
    main()
