"""Serial telemetry source — real USB-CDC hardware (Milestone D).

Target: TAKTYK / URD-1 firmware (ATxmega), streaming line-delimited ASCII over a
virtual COM port:

    feature (~50 Hz):
      X:.. Y:.. OX:.. OY:.. VDI:.. G:.. A:.. K:.. M:.. PX:.. PY:..\r\n
    raw I/Q block (1 kHz, ~20 samples per feature):
      RB:1000 20 i0 q0 i1 q1 ...\r\n

Parsing is line-based and token-based (unknown tokens ignored). OX/OY (the device's
ground-tracked delta vector) drive the hodograph so it matches the device and stays in
sync with zeroing; X/Y (raw) are kept as extras. The RB block feeds the scope/FFT.
The device is send-only, so apply_config is unsupported.

    METAL_LAB_SOURCE=serial METAL_LAB_PROFILE=urd1 uv run python main.py
"""

from __future__ import annotations

import asyncio
import math
import threading
import time
from collections import deque
from collections.abc import AsyncIterator

import serial  # pyserial (blocking, read in a thread — robust on Windows)

from ..profiles import Profile
from ..telemetry.models import FeatureFrame, HarmonicSample, RawIQBlock, TelemetryPacket
from .base import TelemetrySource

# firmware token -> feature extra key
_EXTRA_KEYS = {
    "VDI": "vdi",
    "G": "ground",
    "A": "audio",       # out.audio_signal = LCD signal-strength indicator (clamp 0..4000 on display)
    "TH": "threshold",
    "K": "kgnd",
    "M": "mode",
    "PX": "px",
    "PY": "py",
    "X": "x_raw",
    "Y": "y_raw",
}

# queue item: ("f", feature_dict) | ("iq", (sample_rate, i_list, q_list))
_Item = tuple[str, object]


def _parse_feature(line: str) -> dict[str, float]:
    out: dict[str, float] = {}
    for tok in line.split():
        key, sep, val = tok.partition(":")
        if not sep:
            continue
        try:
            out[key] = float(val)
        except ValueError:
            pass
    return out


def _parse_raw(line: str) -> tuple[int, list[int], list[int]] | None:
    """Parse 'RB:<fs> <n> i0 q0 i1 q1 ...' -> (fs, i_list, q_list)."""
    parts = line.split()
    if not parts or not parts[0].startswith("RB:"):
        return None
    try:
        fs = int(parts[0][3:])
        n = int(parts[1])
        nums = [int(x) for x in parts[2 : 2 + 2 * n]]
    except (ValueError, IndexError):
        return None
    i_list = nums[0::2]
    q_list = nums[1::2]
    if not i_list or len(i_list) != len(q_list):
        return None
    return fs, i_list, q_list


class SerialSource(TelemetrySource):
    def __init__(self, profile: Profile, port: str, baud: int) -> None:
        super().__init__(profile)
        self.port = port
        self.baud = baud
        self._hid = profile.harmonic_ids[0]  # single-harmonic device

    def _reader_loop(self, q: deque[_Item], stop: threading.Event) -> None:
        """Blocking serial read in a background thread (continuous on Windows)."""
        while not stop.is_set():
            try:
                ser = serial.Serial(self.port, self.baud, timeout=0.02)
            except serial.SerialException:
                time.sleep(1.0)
                continue
            buf = ""
            try:
                while not stop.is_set():
                    data = ser.read(256)
                    if not data:
                        continue
                    buf += data.decode("ascii", errors="ignore")
                    *lines, buf = buf.split("\n")
                    if len(buf) > 8192:
                        buf = buf[-1024:]  # runaway guard on a never-terminated line
                    for raw_line in lines:
                        line = raw_line.strip()
                        if not line:
                            continue
                        if line.startswith("RB:"):
                            parsed = _parse_raw(line)
                            if parsed:
                                q.append(("iq", parsed))
                        elif line.startswith("X:"):
                            f = _parse_feature(line)
                            if "X" in f and "Y" in f:
                                q.append(("f", f))
                        if len(q) > 1000:
                            q.popleft()
            except serial.SerialException:
                pass
            finally:
                ser.close()
            time.sleep(0.5)

    async def stream(self) -> AsyncIterator[TelemetryPacket]:
        q: deque[_Item] = deque()
        stop = threading.Event()
        thread = threading.Thread(target=self._reader_loop, args=(q, stop), daemon=True)
        thread.start()
        fseq = 0
        rseq = 0
        try:
            while True:
                if q:
                    kind, payload = q.popleft()
                    if kind == "f":
                        yield self._feature(fseq, payload)  # type: ignore[arg-type]
                        fseq += 1
                    else:
                        fs, i_list, q_list = payload  # type: ignore[misc]
                        yield RawIQBlock(
                            seq=rseq, t=time.monotonic(),
                            sample_rate_hz=fs, i=i_list, q=q_list,
                        )
                        rseq += 1
                else:
                    await asyncio.sleep(0.003)
        finally:
            stop.set()

    def _feature(self, seq: int, f: dict[str, float]) -> FeatureFrame:
        # Prefer the device's ENTER-zeroed delta (DX/DY) for the hodograph so it zeroes
        # together with the device; fall back to OX/OY, then raw X/Y.
        i = f.get("DX", f.get("OX", f["X"]))
        q = f.get("DY", f.get("OY", f["Y"]))
        harmonics = {
            self._hid: HarmonicSample(mag=math.hypot(i, q), phase=math.atan2(q, i), i=i, q=q)
        }
        extras = {dst: f[src] for src, dst in _EXTRA_KEYS.items() if src in f}
        return FeatureFrame(
            seq=seq, t=time.monotonic(), harmonics=harmonics, phase_diffs={}, extras=extras
        )
