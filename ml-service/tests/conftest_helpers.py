"""Paths and fixtures shared across the test modules."""

from pathlib import Path

MODULE_ROOT = Path(__file__).resolve().parents[1]

# The artifact the Stage 07 gate builds before running tests. Referenced rather
# than rebuilt per module: the fit is deterministic, so a stale copy would be a
# build-order problem, not a flaky test.
ARTIFACT_PATH = MODULE_ROOT / "app/models/artifacts/baseline-premium-v1.json"
