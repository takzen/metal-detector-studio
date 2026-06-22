"""Flash job — the state machine around a single firmware update.

Orchestrates the full handoff so the UI just polls one status object:

    idle -> rebooting -> waiting_bootloader -> flashing -> resetting -> done | error

In manual mode the device is assumed to be already in the bootloader, so the reboot and
wait-for-port-gone steps are skipped. Either way the live serial source is stopped first
(to free the COM port) and restarted at the end (so telemetry resumes).

Every collaborator the job touches the outside world through — stopping/starting the
telemetry source, the programmer backend, and the serial-control functions — is injected,
so tests drive the whole flow with fakes (no hardware, no dfu-programmer).
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from pathlib import Path

from . import serial_control
from .base import FlashBackend, FlashError

# Progress is coarse; map each phase to a 0..1 marker for the UI bar.
_PHASE_PROGRESS = {
    "idle": 0.0,
    "rebooting": 0.1,
    "waiting_bootloader": 0.2,
    "flashing": 0.4,
    "resetting": 0.9,
    "done": 1.0,
    "error": 0.0,
}

SourceFn = Callable[[], Awaitable[None]]


class FlashJob:
    def __init__(
        self,
        *,
        backend: FlashBackend,
        hex_path: Path,
        port: str,
        baud: int,
        magic: bytes,
        manual: bool,
        stop_source: SourceFn,
        start_source: SourceFn,
        reboot_timeout: float,
        port_back_timeout: float,
        # injected serial-control hooks (defaults = real USB); overridden in tests
        send_magic=serial_control.send_magic,
        wait_port_gone=serial_control.wait_port_gone,
        wait_port_back=serial_control.wait_port_back,
    ) -> None:
        self.backend = backend
        self.hex_path = hex_path
        self.port = port
        self.baud = baud
        self.magic = magic
        self.manual = manual
        self._stop_source = stop_source
        self._start_source = start_source
        self._reboot_timeout = reboot_timeout
        self._port_back_timeout = port_back_timeout
        self._send_magic = send_magic
        self._wait_port_gone = wait_port_gone
        self._wait_port_back = wait_port_back

        self.state = "idle"
        self.log: list[str] = []
        self.error: str | None = None
        self.started = time.time()
        self._task: asyncio.Task | None = None

    # --- status -------------------------------------------------------------
    def _emit(self, line: str) -> None:
        self.log.append(line)

    def status(self) -> dict:
        return {
            "state": self.state,
            "progress": _PHASE_PROGRESS.get(self.state, 0.0),
            "log": self.log,
            "error": self.error,
            "started": self.started,
            "hex_path": str(self.hex_path),
            "manual": self.manual,
            "running": self.state not in ("done", "error"),
        }

    # --- lifecycle ----------------------------------------------------------
    def start(self) -> None:
        self._task = asyncio.create_task(self._run())

    async def join(self) -> None:
        if self._task is not None:
            await self._task

    def cancel(self) -> None:
        if self._task is not None and not self._task.done():
            self._task.cancel()

    async def _run(self) -> None:
        try:
            # Free the COM port so the programmer (and re-enumeration) can take over.
            self._emit("stopping telemetry source")
            await self._stop_source()

            if not self.manual:
                self.state = "rebooting"
                self._emit(f"sending magic reboot to {self.port}")
                await self._send_magic(self.port, self.baud, self.magic)
                self.state = "waiting_bootloader"
                gone = await self._wait_port_gone(self.port, self._reboot_timeout)
                if not gone:
                    raise FlashError(
                        f"{self.port} did not disappear after reboot — "
                        "is the bootloader present? (try manual mode)"
                    )
                self._emit("device entered bootloader")
            else:
                self._emit("manual mode: assuming device already in bootloader")

            self.state = "flashing"
            self._emit(f"flashing {self.hex_path.name}")
            await self.backend.program(self.hex_path, self._emit)

            self.state = "resetting"
            self._emit("resetting into application")
            await self.backend.reset(self._emit)
            back = await self._wait_port_back(self.port, self._port_back_timeout)
            if not back:
                self._emit(
                    f"warning: {self.port} did not reappear within timeout "
                    "(telemetry may take a moment)"
                )

            self.state = "done"
            self._emit("flash complete")
        except asyncio.CancelledError:
            self.state = "error"
            self.error = "cancelled"
            self._emit("cancelled")
        except FlashError as exc:
            self.state = "error"
            self.error = str(exc)
            self._emit(f"error: {exc}")
        except Exception as exc:  # noqa: BLE001 — surface any failure to the UI
            self.state = "error"
            self.error = f"{type(exc).__name__}: {exc}"
            self._emit(f"error: {self.error}")
        finally:
            # Always try to bring telemetry back, even on failure.
            try:
                await self._start_source()
                self._emit("telemetry source restarted")
            except Exception as exc:  # noqa: BLE001
                self._emit(f"warning: failed to restart source: {exc}")
