"""
The Stage 07 gate: one command that validates everything the stage claims.

Equivalent to `npm run stage4:check` and `npm run stage6:check` in the Node
modules, written in Python so it runs identically on Windows and Linux without
a shell or a make dependency.

Steps, in the order a failure is cheapest to diagnose:

1. Lint and format, so style failures do not hide behind test output.
2. Rebuild the model artifact and fail on drift, proving the committed file is
   the one the script produces — the same guarantee the contracts' ABI drift
   gate provides.
3. Tests, including the contract checks against the backend's published schema.
4. A real startup, because a service that imports cleanly and cannot boot has
   not been verified.

Usage:
    python scripts/stage7_check.py
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

MODULE_ROOT = Path(__file__).resolve().parents[1]
ARTIFACT = MODULE_ROOT / "app/models/artifacts/baseline-premium-v1.json"


def run(label: str, command: list[str]) -> None:
    print(f"\n=== {label} ===", flush=True)
    result = subprocess.run(command, cwd=MODULE_ROOT)
    if result.returncode != 0:
        raise SystemExit(f"stage7:check FAILED at: {label}")


def check_artifact_drift() -> None:
    print("\n=== artifact drift ===", flush=True)
    before = ARTIFACT.read_bytes() if ARTIFACT.is_file() else None

    result = subprocess.run(
        [sys.executable, "scripts/build_baseline_model.py"],
        cwd=MODULE_ROOT,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(result.stdout)
        print(result.stderr)
        raise SystemExit("stage7:check FAILED at: rebuilding the model artifact")

    after = ARTIFACT.read_bytes()
    if before is None:
        print(f"Artifact built at {ARTIFACT.relative_to(MODULE_ROOT)}")
        return

    if before != after:
        raise SystemExit(
            "stage7:check FAILED: the committed model artifact does not match "
            "what scripts/build_baseline_model.py produces. Commit the rebuilt "
            "artifact, or revert the change to the script."
        )
    print("Committed artifact matches its build script.")


def main() -> None:
    run("lint", [sys.executable, "-m", "ruff", "check", "."])
    run("format", [sys.executable, "-m", "ruff", "format", "--check", "."])
    check_artifact_drift()
    run("tests", [sys.executable, "-m", "pytest"])
    run("runtime startup", [sys.executable, "scripts/startup_check.py"])

    print("\nstage7:check OK")


if __name__ == "__main__":
    main()
