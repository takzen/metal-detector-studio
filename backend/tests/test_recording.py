"""Unit tests for the NDJSON Recorder."""

from __future__ import annotations

import json

from app.recording import Recorder


def test_recorder_writes_meta_then_frames(tmp_path):
    path = tmp_path / "rec.ndjson"
    r = Recorder(path, {"schema_version": "1.0", "profile_id": "urd1", "profile": {"id": "urd1"}})
    r.feed(json.dumps({"type": "feature", "seq": 0, "t": 1.0}))
    r.feed(json.dumps({"type": "raw_iq", "seq": 0, "t": 1.01}))
    st = r.close()

    assert st["recording"] is False
    assert st["frames"] == 2  # meta is not counted as a frame
    assert st["bytes"] > 0

    lines = path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 3
    types = [json.loads(ln)["type"] for ln in lines]
    assert types == ["meta", "feature", "raw_iq"]


def test_recorder_meta_carries_profile(tmp_path):
    path = tmp_path / "rec.ndjson"
    Recorder(path, {"schema_version": "1.0", "profile_id": "urd1", "profile": {"id": "urd1"}}).close()
    meta = json.loads(path.read_text(encoding="utf-8").splitlines()[0])
    assert meta["type"] == "meta"
    assert meta["profile_id"] == "urd1"
    assert "started" in meta


def test_recorder_status_while_open(tmp_path):
    r = Recorder(tmp_path / "rec.ndjson", {"schema_version": "1.0", "profile_id": "x", "profile": {}})
    r.feed(json.dumps({"type": "feature"}))
    st = r.status()
    assert st["recording"] is True
    assert st["frames"] == 1
    r.close()
