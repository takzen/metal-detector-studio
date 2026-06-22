"""Programmer adapter interface.

A `FlashBackend` knows how to push one .hex onto a device already sitting in its
bootloader. It streams progress as log lines (so the UI can show what's happening) and
raises `FlashError` on failure. The job state machine owns the surrounding choreography
(reboot, port re-enumeration, reset); the backend only programs.
"""

from __future__ import annotations

import abc
from collections.abc import Callable
from pathlib import Path

# Sink for human-readable progress/log lines (forwarded to the UI).
LogFn = Callable[[str], None]


class FlashError(RuntimeError):
    """Raised when programming fails. The message carries the programmer's output."""


class FlashBackend(abc.ABC):
    """Swappable host-side programmer (DFU today; custom CDC bootloader later)."""

    @abc.abstractmethod
    async def program(self, hex_path: Path, log: LogFn) -> None:
        """Flash + verify ``hex_path`` onto the device in bootloader mode.

        Stream progress through ``log``. Raise `FlashError` on any failure.
        """
        raise NotImplementedError

    async def reset(self, log: LogFn) -> None:
        """Reset the device back into the application after a successful flash.

        Optional — some programmers reset as part of `program`. Default: no-op.
        """
        return None

    def available(self) -> bool:
        """Whether this backend can run on the host (e.g. binary on PATH)."""
        return True
