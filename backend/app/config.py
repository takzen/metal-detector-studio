"""Runtime configuration.

Paths and a handful of environment-overridable knobs. The telemetry contract itself
lives in ``schema.json`` + ``profiles/*.json`` (the single source of truth), not here.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

# backend/ root (this file is backend/app/config.py)
BACKEND_DIR: Path = Path(__file__).resolve().parent.parent

SCHEMA_PATH: Path = BACKEND_DIR / "schema.json"
PROFILES_DIR: Path = BACKEND_DIR / "profiles"
RECORDINGS_DIR: Path = BACKEND_DIR / "recordings"

# Which device profile to stream. Override with METAL_LAB_PROFILE=spectral_g4, etc.
# Default = urd1 (TAKTYK, the real connected device); spectral_g4 has no live source yet.
DEFAULT_PROFILE: str = os.environ.get("METAL_LAB_PROFILE", "urd1")

# Telemetry source. Only "serial" (real USB-CDC) is supported; synthetic data was dropped.
SOURCE: str = os.environ.get("METAL_LAB_SOURCE", "serial")

# Serial transport (used when SOURCE == "serial"). USB-CDC ignores baud, but we set it.
SERIAL_PORT: str = os.environ.get("METAL_LAB_SERIAL_PORT", "COM5")
SERIAL_BAUD: int = int(os.environ.get("METAL_LAB_SERIAL_BAUD", "115200"))

# HTTP/WebSocket server bind.
HOST: str = os.environ.get("METAL_LAB_HOST", "127.0.0.1")
PORT: int = int(os.environ.get("METAL_LAB_PORT", "8000"))

# --- USB firmware flashing (PC-side programmer) ------------------------------
# The bootloader itself lives on the chip (taktyk-dsp, flashed once via Atmel-ICE);
# the studio is only the host-side programmer. These are CONTRACT PLACEHOLDERS — the
# firmware side fixes the real values; every one is overridable per request body too.
#
# Target chip as dfu-programmer knows it, and the programmer binary on PATH.
FLASH_DEVICE: str = os.environ.get("METAL_LAB_FLASH_DEVICE", "atxmega256a3bu")


def _resolve_programmer() -> str:
    """Find dfu-programmer even if it isn't on the backend process's PATH (e.g. it was
    installed after the server started). Env override wins; then PATH; then the common
    Windows scoop shim location; finally the bare name as a last resort."""
    env = os.environ.get("METAL_LAB_FLASH_PROGRAMMER")
    if env:
        return env
    found = shutil.which("dfu-programmer")
    if found:
        return found
    for cand in (Path.home() / "scoop" / "shims" / "dfu-programmer.exe",):
        if cand.is_file():
            return str(cand)
    return "dfu-programmer"


FLASH_PROGRAMMER: str = _resolve_programmer()
# Command templates: {device} and {hex} are substituted. flash + reset back to the app.
FLASH_COMMAND_TEMPLATE: str = os.environ.get(
    "METAL_LAB_FLASH_COMMAND", "{programmer} {device} flash --force {hex}"
)
FLASH_RESET_TEMPLATE: str = os.environ.get(
    "METAL_LAB_FLASH_RESET", "{programmer} {device} launch"
)
# Magic bytes written over the live CDC link to drop the running app into the
# bootloader. PLACEHOLDER — the firmware defines the real reboot command. Decoded
# as latin-1 so any byte value can be expressed; default is harmless/unused.
FLASH_MAGIC_REBOOT: str = os.environ.get("METAL_LAB_FLASH_MAGIC", "BOOT\n")
# Bootloader USB ids — metadata for now (port-gone is the detection signal); kept so a
# pyusb-based detector can use them later. atmel DFU default VID = 0x03EB.
FLASH_BOOTLOADER_VID: int = int(os.environ.get("METAL_LAB_FLASH_VID", "0x03EB"), 0)
FLASH_BOOTLOADER_PID: int = int(os.environ.get("METAL_LAB_FLASH_PID", "0x2FE2"), 0)
# Default .hex path (taktyk-dsp build output). Just a prefill — the user picks the path.
FLASH_HEX_DEFAULT: str = os.environ.get(
    "METAL_LAB_FLASH_HEX", ".pio/build/atxmega256a3bu/firmware.hex"
)
# Timeouts (seconds) for the USB re-enumeration around the bootloader handoff.
FLASH_REBOOT_TIMEOUT: float = float(os.environ.get("METAL_LAB_FLASH_REBOOT_TIMEOUT", "10"))
FLASH_PORT_BACK_TIMEOUT: float = float(os.environ.get("METAL_LAB_FLASH_BACK_TIMEOUT", "20"))
