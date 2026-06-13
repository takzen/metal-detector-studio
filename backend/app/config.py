"""Runtime configuration.

Paths and a handful of environment-overridable knobs. The telemetry contract itself
lives in ``schema.json`` + ``profiles/*.json`` (the single source of truth), not here.
"""

from __future__ import annotations

import os
from pathlib import Path

# backend/ root (this file is backend/app/config.py)
BACKEND_DIR: Path = Path(__file__).resolve().parent.parent

SCHEMA_PATH: Path = BACKEND_DIR / "schema.json"
PROFILES_DIR: Path = BACKEND_DIR / "profiles"

# Which device profile to stream. Override with METAL_LAB_PROFILE=urd1, etc.
DEFAULT_PROFILE: str = os.environ.get("METAL_LAB_PROFILE", "spectral_g4")

# Telemetry source: "synthetic" (no hardware) or "serial" (real USB-CDC, later).
SOURCE: str = os.environ.get("METAL_LAB_SOURCE", "synthetic")

# HTTP/WebSocket server bind.
HOST: str = os.environ.get("METAL_LAB_HOST", "127.0.0.1")
PORT: int = int(os.environ.get("METAL_LAB_PORT", "8000"))
