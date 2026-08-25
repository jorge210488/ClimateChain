"""
Boots the service the way a deployment does and asserts it can serve.

The test suite exercises startup through FastAPI's test client, which is not
the same claim: it never binds a socket, never runs uvicorn, and never proves
the packaged entrypoint works. This does, which is what makes the gate's
"runtime startup check" honest.

Mirrors `backend/scripts/startup-check.ts` in purpose and in what it accepts as
proof: a real process, a real port, and the probes answering.
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

MODULE_ROOT = Path(__file__).resolve().parents[1]
HOST = "127.0.0.1"
PORT = 8123  # Not the default, so a service already running locally is not hit.
BASE_URL = f"http://{HOST}:{PORT}"
BOOT_TIMEOUT_SECONDS = 45
ARTIFACT_PATH = MODULE_ROOT / "app/models/artifacts/baseline-premium-v1.json"


def _get(path: str, timeout: float = 5.0) -> tuple[int, str]:
    request = urllib.request.Request(f"{BASE_URL}{path}", method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8")


def _post(path: str, body: bytes, timeout: float = 10.0) -> tuple[int, str]:
    request = urllib.request.Request(
        f"{BASE_URL}{path}",
        data=body,
        method="POST",
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8")


def _wait_for_liveness(process: subprocess.Popen) -> None:
    deadline = time.monotonic() + BOOT_TIMEOUT_SECONDS

    while time.monotonic() < deadline:
        if process.poll() is not None:
            # Surface the child's own output. Without it the failure reads as a
            # bare exit code, and the actual reason — almost always a
            # configuration or artifact problem the service reported clearly —
            # is discarded exactly when it is needed.
            output = process.stdout.read() if process.stdout else ""
            raise SystemExit(
                f"startup-check FAILED: the service exited during boot with "
                f"code {process.returncode}\n"
                f"--- service output ---\n{output}"
            )
        try:
            status, _ = _get("/health", timeout=2.0)
            if status == 200:
                return
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            time.sleep(0.5)

    raise SystemExit(
        f"startup-check FAILED: no response on {BASE_URL}/health within "
        f"{BOOT_TIMEOUT_SECONDS}s"
    )


def main() -> None:
    command = [
        sys.executable,
        "-m",
        "uvicorn",
        "app.main:app",
        "--host",
        HOST,
        "--port",
        str(PORT),
        "--log-level",
        "warning",
    ]

    # Configuration is passed explicitly rather than inherited from a local
    # `.env`. A gate whose result depends on a developer's untracked file is not
    # a gate, and this is also how a deployment supplies configuration — so the
    # realism is preserved, not traded away.
    environment = {
        **os.environ,
        "APP_ENV": "test",
        "MODEL_PROVIDER": "baseline",
        "MODEL_PATH": str(ARTIFACT_PATH),
    }

    process = subprocess.Popen(
        command,
        cwd=MODULE_ROOT,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )

    try:
        _wait_for_liveness(process)
        print(f"startup-check OK: GET /health -> 200 on {BASE_URL}")

        status, body = _get("/health/ready")
        if status != 200:
            raise SystemExit(
                f"startup-check FAILED: GET /health/ready -> {status} {body}"
            )
        print("startup-check OK: GET /health/ready -> 200 (model loaded)")

        # The point of the whole service, exercised against a real socket.
        quote_request = (
            b'{"region":"Valencia","startDate":"2026-04-01",'
            b'"endDate":"2026-04-30","coverageEth":"1.0","rainfallThresholdMm":50}'
        )
        status, body = _post("/predict", quote_request)
        if status != 200:
            raise SystemExit(f"startup-check FAILED: POST /predict -> {status} {body}")
        print(f"startup-check OK: POST /predict -> 200 {body}")
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()


if __name__ == "__main__":
    main()
