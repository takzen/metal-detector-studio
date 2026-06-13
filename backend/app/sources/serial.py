"""Serial telemetry source — real USB-CDC hardware (Milestone D).

First target: TAKTYK / URD-1 firmware (ATxmega), which streams ~50 Hz token-based
ASCII telemetry over a virtual COM port, e.g.:

    X:77792 Y:507584 VDI:127 G:-5639 A:0 K:-4 M:3 PX:107840 PY:53846\r\n

Parsing is token-based (key:value, unknown tokens ignored) and resynchronizes on the
"X:" record marker, so it tolerates the dropped \r\n / truncated frames that occur when
the device's CDC buffer overruns. X/Y are the I/Q vector of the single harmonic; the
rest are carried as extras. The device is send-only here, so apply_config is unsupported.

Map this source to the single-harmonic profile, e.g.:
    METAL_LAB_SOURCE=serial METAL_LAB_PROFILE=urd1 uv run python main.py
"""

from __future__ import annotations

import asyncio
import math
import re
import time
from collections.abc import AsyncIterator

import serial_asyncio

from ..profiles import Profile
from ..telemetry.models import FeatureFrame, HarmonicSample, TelemetryPacket
from .base import TelemetrySource

# Record starts at a standalone "X:" — not the "X:" inside "PX:".
_RECORD_MARK = re.compile(r"(?<![A-Za-z])X:")

# Map firmware token -> feature extra key.
_EXTRA_KEYS = {
    "VDI": "vdi",
    "G": "ground",
    "A": "audio",
    "K": "kgnd",
    "M": "mode",
    "PX": "px",
    "PY": "py",
}


def _parse_record(rec: str) -> dict[str, float]:
    out: dict[str, float] = {}
    for tok in rec.split():
        key, sep, val = tok.partition(":")
        if not sep:
            continue
        try:
            out[key] = float(val)
        except ValueError:
            pass
    return out


def _extract(buf: str) -> tuple[list[str], str]:
    """Split the buffer into complete records, keeping the trailing partial one."""
    idxs = [m.start() for m in _RECORD_MARK.finditer(buf)]
    if len(idxs) < 2:
        return [], buf
    records = [buf[idxs[k] : idxs[k + 1]] for k in range(len(idxs) - 1)]
    return records, buf[idxs[-1] :]


class SerialSource(TelemetrySource):
    def __init__(self, profile: Profile, port: str, baud: int) -> None:
        super().__init__(profile)
        self.port = port
        self.baud = baud
        self._hid = profile.harmonic_ids[0]  # single-harmonic device
        self._writer: asyncio.StreamWriter | None = None

    async def stream(self) -> AsyncIterator[TelemetryPacket]:
        seq = 0
        retry = 0
        while True:
            try:
                reader, writer = await serial_asyncio.open_serial_connection(
                    url=self.port, baudrate=self.baud
                )
                self._writer = writer
                retry = 0
            except Exception:
                retry = min(retry + 1, 6)
                await asyncio.sleep(min(0.25 * 2**retry, 5.0))
                continue

            buf = ""
            try:
                while True:
                    data = await reader.read(4096)
                    if not data:
                        break  # port closed / unplugged
                    buf += data.decode("ascii", errors="ignore")
                    records, buf = _extract(buf)
                    if len(buf) > 8192:
                        buf = buf[-1024:]  # runaway guard
                    for rec in records:
                        f = _parse_record(rec)
                        if "X" in f and "Y" in f:
                            yield self._feature(seq, f)
                            seq += 1
            except asyncio.CancelledError:
                raise
            except Exception:
                pass
            finally:
                self._writer = None
                writer.close()
            await asyncio.sleep(0.5)

    def _feature(self, seq: int, f: dict[str, float]) -> FeatureFrame:
        i = f["X"]
        q = f["Y"]
        harmonics = {
            self._hid: HarmonicSample(mag=math.hypot(i, q), phase=math.atan2(q, i), i=i, q=q)
        }
        extras = {dst: f[src] for src, dst in _EXTRA_KEYS.items() if src in f}
        return FeatureFrame(
            seq=seq, t=time.monotonic(), harmonics=harmonics, phase_diffs={}, extras=extras
        )
