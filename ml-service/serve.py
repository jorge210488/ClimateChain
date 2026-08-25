"""
Development entrypoint for the ML service.

Stage 01 left a placeholder here; Stage 07 makes it run the real application.
Production serving is a Stage 12 concern (a container invoking uvicorn with its
own worker and bind configuration), so this stays a convenience for local runs
rather than growing process-management options it should not own.

Usage:
    python serve.py
"""

from __future__ import annotations

import uvicorn

from app.core.config import get_settings


def main() -> None:
    settings = get_settings()
    uvicorn.run(
        "app.main:app",
        host="127.0.0.1",
        port=settings.app_port,
        log_level=settings.log_level,
        # Reload only where a developer is editing; a deployed profile reaching
        # this path at all would be a mistake, and reload would compound it.
        reload=not settings.is_deployed_profile,
    )


if __name__ == "__main__":
    main()
