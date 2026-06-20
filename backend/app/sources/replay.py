"""Replay telemetry source — play a recorded NDJSON session back (Milestone G).

Reads a file produced by :class:`app.recording.Recorder` and re-emits its telemetry
packets with the original inter-frame timing (derived from each frame's monotonic
``t``). Selected via ``POST /api/source`` with ``source="replay"``; because it yields
the same ``TelemetryPacket`` models as the serial source, every tab and the MCP server
consume a replay exactly as if it were live.

    {"source": "replay", "file": "rec-20260620-101500.ndjson", "speed": 1.0, "loop": false}
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from pathlib import Path

from ..profiles import Profile
from ..telemetry.models import (
    FeatureFrame,
    RawAdcBlock,
    RawBlock,
    RawIQBlock,
    TelemetryPacket,
)
from .base import TelemetrySource

# wire "type" -> packet model (meta / hello / config_ack are skipped on replay)
_PACKET_BY_TYPE = {
    "feature": FeatureFrame,
    "raw": RawBlock,
    "raw_iq": RawIQBlock,
    "adc_raw": RawAdcBlock,
}


def read_meta(path: Path) -> dict:
    """Return the recording's first-line ``meta`` record (profile, schema_version)."""
    with path.open(encoding="utf-8") as fh:
        first = fh.readline().strip()
    if not first:
        return {}
    obj = json.loads(first)
    return obj if obj.get("type") == "meta" else {}


def _packet_from(msg: dict) -> TelemetryPacket | None:
    cls = _PACKET_BY_TYPE.get(msg.get("type", ""))
    return cls.model_validate(msg) if cls else None


class ReplaySource(TelemetrySource):
    def __init__(self, profile: Profile, path: Path, speed: float = 1.0, loop: bool = False) -> None:
        super().__init__(profile)
        self.path = path
        self.speed = speed if speed > 0 else 1.0
        self.loop = loop
        self._done = False

    async def stream(self) -> AsyncIterator[TelemetryPacket]:
        while True:
            prev_t: float | None = None
            with self.path.open(encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    msg = json.loads(line)
                    pkt = _packet_from(msg)
                    if pkt is None:
                        continue  # meta / hello / config_ack
                    t = msg.get("t")
                    if prev_t is not None and t is not None:
                        dt = (t - prev_t) / self.speed
                        if dt > 0:
                            await asyncio.sleep(min(dt, 5.0))  # clamp gaps/jumps
                    prev_t = t
                    yield pkt
            if not self.loop:
                self._done = True
                break

    def link_stats(self) -> dict:
        return {"replay": True, "file": self.path.name, "speed": self.speed,
                "loop": self.loop, "done": self._done}
