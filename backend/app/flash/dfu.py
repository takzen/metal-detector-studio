"""dfu-programmer backend.

Runs the external `dfu-programmer` binary (open-source, supports atxmega256a3bu) against
a device in DFU bootloader mode. Command lines come from configurable templates so the
exact invocation — and later a different programmer entirely — can change without code
edits. atprogram / FLIP could drop in as sibling backends behind the same interface.
"""

from __future__ import annotations

import asyncio
import shutil
from pathlib import Path

from .base import FlashBackend, FlashError, LogFn


class DfuProgrammer(FlashBackend):
    def __init__(
        self,
        *,
        programmer: str,
        device: str,
        command_template: str,
        reset_template: str | None = None,
    ) -> None:
        self.programmer = programmer
        self.device = device
        self.command_template = command_template
        self.reset_template = reset_template

    def _render(self, template: str, hex_path: Path | None = None) -> list[str]:
        # Split the template into tokens FIRST, then substitute — so a Windows path
        # (with backslashes) in {hex}/{programmer} is never run through a parser that
        # would eat the backslashes. Templates are plain space-separated tokens.
        subst = {
            "programmer": self.programmer,
            "device": self.device,
            "hex": str(hex_path) if hex_path is not None else "",
        }
        return [tok.format(**subst) for tok in template.split()]

    async def _run(self, argv: list[str], log: LogFn) -> None:
        log(f"$ {' '.join(argv)}")
        try:
            proc = await asyncio.create_subprocess_exec(
                *argv,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
        except FileNotFoundError as exc:
            raise FlashError(f"programmer not found: {argv[0]!r}") from exc
        assert proc.stdout is not None
        async for raw in proc.stdout:
            line = raw.decode("utf-8", errors="replace").rstrip()
            if line:
                log(line)
        rc = await proc.wait()
        if rc != 0:
            raise FlashError(f"{argv[0]} exited with code {rc}")

    async def program(self, hex_path: Path, log: LogFn) -> None:
        await self._run(self._render(self.command_template, hex_path), log)

    async def reset(self, log: LogFn) -> None:
        if self.reset_template:
            await self._run(self._render(self.reset_template), log)

    def available(self) -> bool:
        return shutil.which(self.programmer) is not None
