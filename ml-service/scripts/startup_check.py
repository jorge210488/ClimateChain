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

import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

MODULE_ROOT = Path(__file__).resolve().parents[1]
HOST = "127.0.0.1"
BOOT_TIMEOUT_SECONDS = 45
ARTIFACT_PATH = MODULE_ROOT / "app/models/artifacts/baseline-premium-v1.json"


def reserve_port() -> int:
    """
    Picks a port the operating system says is free.

    A fixed port made this check unsound: anything already listening on it —
    a leftover instance, an unrelated service — could answer the probes while
    the process under test failed to bind and died. The check would report
    success for a service it never started.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind((HOST, 0))
        return probe.getsockname()[1]


def _get(base_url: str, path: str, timeout: float = 5.0) -> tuple[int, str]:
    request = urllib.request.Request(f"{base_url}{path}", method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8")


def _post(
    base_url: str, path: str, body: bytes, timeout: float = 10.0
) -> tuple[int, str]:
    request = urllib.request.Request(
        f"{base_url}{path}",
        data=body,
        method="POST",
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8")


def _wait_for_liveness(process: subprocess.Popen, base_url: str) -> None:
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
            status, _ = _get(base_url, "/health", timeout=2.0)
            if status == 200:
                return
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            time.sleep(0.5)

    raise SystemExit(
        f"startup-check FAILED: no response on {base_url}/health within "
        f"{BOOT_TIMEOUT_SECONDS}s"
    )


def main() -> None:
    port = reserve_port()
    base_url = f"http://{HOST}:{port}"

    # The artifact is read here so the responses can be checked against the
    # model this run is supposed to be serving, rather than against any model.
    expected = json.loads(ARTIFACT_PATH.read_text(encoding="utf-8"))

    command = [
        sys.executable,
        "-m",
        "uvicorn",
        "app.main:app",
        "--host",
        HOST,
        "--port",
        str(port),
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
        _wait_for_liveness(process, base_url)
        print(f"startup-check OK: GET /health -> 200 on {base_url}")

        status, body = _get(base_url, "/health/ready")
        if status != 200:
            raise SystemExit(
                f"startup-check FAILED: GET /health/ready -> {status} {body}"
            )

        # Not merely "something answered". Readiness must name the artifact this
        # run built, which is what distinguishes the process under test from any
        # other service that happens to speak the same protocol on this host.
        reported = json.loads(body)["model"]
        if reported["checksum"] != expected["checksum"]:
            raise SystemExit(
                f"startup-check FAILED: the responder is serving checksum "
                f"{reported['checksum']}, not the {expected['checksum']} this "
                f"run built. Something other than the process under test "
                f"answered."
            )
        print(
            f"startup-check OK: GET /health/ready -> 200 "
            f"(model {reported['modelVersion']}, checksum verified)"
        )

        # The point of the whole service, exercised against a real socket.
        quote_request = (
            b'{"region":"Valencia","startDate":"2026-04-01",'
            b'"endDate":"2026-04-30","coverageEth":"1.0","rainfallThresholdMm":50}'
        )
        status, body = _post(base_url, "/predict", quote_request)
        if status != 200:
            raise SystemExit(f"startup-check FAILED: POST /predict -> {status} {body}")

        quote = json.loads(body)
        if quote["modelVersion"] != expected["modelVersion"]:
            raise SystemExit(
                f"startup-check FAILED: the quote came from model "
                f"{quote['modelVersion']}, expected {expected['modelVersion']}"
            )
        print(f"startup-check OK: POST /predict -> 200 {body}")

        # Last, because a process that answered three requests and then died was
        # not actually serving them — it would mean something else was.
        if process.poll() is not None:
            output = process.stdout.read() if process.stdout else ""
            raise SystemExit(
                f"startup-check FAILED: the service exited with code "
                f"{process.returncode} while it was supposedly serving\n"
                f"--- service output ---\n{output}"
            )
        print("startup-check OK: the process under test is still serving")
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()


if __name__ == "__main__":
    main()
