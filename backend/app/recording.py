"""Session recording — append the live broadcast stream to an NDJSON file (Milestone G).

A recording is a self-contained NDJSON file: the first line is a ``meta`` record
(schema version + the active profile, so replay can rebind without the device), then
every subsequent line is a verbatim broadcast frame (hello / feature / raw_* /
config_ack) exactly as sent to WS clients. ``ReplaySource`` reads it back and re-emits
with the original inter-frame timing, so every tab and the MCP server see a replay
exactly as if it were live.
"""

from __future__ import annotations

import json
import time
from pathlib import Path


class Recorder:
    """Appends broadcast frames to one NDJSON file until closed."""

    def __init__(self, path: Path, meta: dict) -> None:
        self.path = path
        self.started = time.time()
        self.frames = 0
        self.bytes = 0
        self._fh = path.open("w", encoding="utf-8")
        self._write(json.dumps({"type": "meta", "started": self.started, **meta}))

    def _write(self, text: str) -> None:
        line = text + "\n"
        self._fh.write(line)
        self.bytes += len(line)

    def feed(self, text: str) -> None:
        """Append one broadcast frame (verbatim JSON text)."""
        self._write(text)
        self.frames += 1

    def status(self) -> dict:
        return {
            "recording": True,
            "path": self.path.name,
            "frames": self.frames,
            "bytes": self.bytes,
            "elapsed_s": round(time.time() - self.started, 1),
        }

    def close(self) -> dict:
        st = self.status()
        st["recording"] = False
        self._fh.flush()
        self._fh.close()
        return st
