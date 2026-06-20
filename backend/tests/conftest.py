"""Shared test fixtures.

The ``client`` fixture builds the real FastAPI app but points the serial source at a
non-existent COM port (so it harmlessly fails to open instead of fighting the real
device) and redirects recordings to a tmp dir, so tests never touch real hardware or
real recordings.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app import config
from app.server.app import create_app


@pytest.fixture
def rec_dir(tmp_path, monkeypatch):
    d = tmp_path / "recordings"
    monkeypatch.setattr(config, "RECORDINGS_DIR", d)
    return d


@pytest.fixture
def client(rec_dir, monkeypatch):
    monkeypatch.setattr(config, "SERIAL_PORT", "COM_TEST_NONEXISTENT")
    app = create_app()
    with TestClient(app) as c:  # enters lifespan (startup/shutdown)
        yield c


def write_recording(path, *, profile_id="urd1", frames=None):
    """Write a minimal valid recording file (meta + telemetry frames)."""
    if frames is None:
        frames = [
            {"type": "feature", "seq": 0, "t": 10.00,
             "harmonics": {"f1": {"mag": 1.0, "phase": 0.0, "i": 1.0, "q": 0.0}}},
            {"type": "raw_iq", "seq": 0, "t": 10.02, "sample_rate_hz": 1000,
             "i": [1, 2], "q": [3, 4]},
            {"type": "feature", "seq": 1, "t": 10.05,
             "harmonics": {"f1": {"mag": 2.0, "phase": 0.1, "i": 2.0, "q": 0.2}}},
        ]
    meta = {"type": "meta", "started": 0, "schema_version": "1.0", "profile_id": profile_id}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(x) for x in [meta, *frames]) + "\n", encoding="utf-8")
