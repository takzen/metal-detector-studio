"""Serial-side helpers for the bootloader handoff.

The device is send-only telemetry, so we drop it into the bootloader by writing a magic
byte sequence straight to the CDC port (not via apply_config). After that the COM port
disappears (the app stops being a CDC device) and a DFU device enumerates; we detect the
handoff purely by the COM port going away and later coming back — no extra USB deps.

pyserial is blocking, so the public helpers are async wrappers that run the blocking bits
in the default executor.
"""

from __future__ import annotations

import asyncio
import time

import serial
from serial.tools import list_ports


def _port_present(port: str) -> bool:
    return any(p.device == port for p in list_ports.comports())


def _send_magic_blocking(port: str, baud: int, data: bytes) -> None:
    ser = serial.Serial(port, baud, timeout=1.0)
    try:
        ser.write(data)
        ser.flush()
    finally:
        ser.close()


async def send_magic(port: str, baud: int, data: bytes) -> None:
    """Write the magic reboot sequence to the live CDC port."""
    await asyncio.get_running_loop().run_in_executor(
        None, _send_magic_blocking, port, baud, data
    )


async def _wait_for(port: str, *, present: bool, timeout: float, poll: float = 0.25) -> bool:
    """Poll the COM list until ``port`` reaches the desired presence, or time out."""
    loop = asyncio.get_running_loop()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if await loop.run_in_executor(None, _port_present, port) == present:
            return True
        await asyncio.sleep(poll)
    return False


async def wait_port_gone(port: str, timeout: float) -> bool:
    """True once ``port`` disappears (device entered the bootloader)."""
    return await _wait_for(port, present=False, timeout=timeout)


async def wait_port_back(port: str, timeout: float) -> bool:
    """True once ``port`` reappears (device rebooted into the application)."""
    return await _wait_for(port, present=True, timeout=timeout)
