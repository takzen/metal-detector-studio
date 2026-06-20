"""Unit tests for ReplaySource + read_meta."""

from __future__ import annotations

import asyncio
import json

from app.sources.replay import ReplaySource, read_meta


def _write(path, lines):
    path.write_text("\n".join(json.dumps(x) for x in lines) + "\n", encoding="utf-8")


def _collect(src) -> list:
    async def run():
        return [pkt async for pkt in src.stream()]

    return asyncio.run(run())


META = {"type": "meta", "started": 0, "schema_version": "1.0", "profile_id": "urd1"}
FEAT0 = {"type": "feature", "seq": 0, "t": 10.00,
         "harmonics": {"f1": {"mag": 1.0, "phase": 0.0, "i": 1.0, "q": 0.0}}}
IQ0 = {"type": "raw_iq", "seq": 0, "t": 10.02, "sample_rate_hz": 1000, "i": [1, 2], "q": [3, 4]}
FEAT1 = {"type": "feature", "seq": 1, "t": 10.05,
         "harmonics": {"f1": {"mag": 2.0, "phase": 0.1, "i": 2.0, "q": 0.2}}}


def test_read_meta(tmp_path):
    p = tmp_path / "rec.ndjson"
    _write(p, [META, FEAT0])
    meta = read_meta(p)
    assert meta["type"] == "meta"
    assert meta["profile_id"] == "urd1"


def test_read_meta_missing_returns_empty(tmp_path):
    p = tmp_path / "rec.ndjson"
    _write(p, [FEAT0])  # no meta first line
    assert read_meta(p) == {}


def test_replay_yields_only_telemetry_in_order(tmp_path):
    p = tmp_path / "rec.ndjson"
    # include hello + config_ack which must be skipped on replay
    _write(p, [META, {"type": "hello", "schema_version": "1.0", "profile": {}},
              FEAT0, IQ0, {"type": "config_ack", "key": "x", "ok": True}, FEAT1])
    src = ReplaySource(None, p, speed=100.0)
    got = _collect(src)
    assert [(pkt.type, pkt.seq) for pkt in got] == [
        ("feature", 0), ("raw_iq", 0), ("feature", 1),
    ]


def test_replay_reconstructs_models(tmp_path):
    p = tmp_path / "rec.ndjson"
    _write(p, [META, FEAT0, IQ0])
    got = _collect(ReplaySource(None, p, speed=100.0))
    feat = got[0]
    assert feat.harmonics["f1"].i == 1.0
    iq = got[1]
    assert iq.sample_rate_hz == 1000
    assert iq.i == [1, 2] and iq.q == [3, 4]


def test_replay_done_flag(tmp_path):
    p = tmp_path / "rec.ndjson"
    _write(p, [META, FEAT0])
    src = ReplaySource(None, p, speed=100.0, loop=False)
    _collect(src)
    assert src.link_stats()["done"] is True


def test_replay_speed_affects_duration(tmp_path):
    p = tmp_path / "rec.ndjson"
    # two features 0.20 s apart in recorded time
    _write(p, [META, {"type": "feature", "seq": 0, "t": 0.0,
                      "harmonics": {"f1": {"mag": 1, "phase": 0, "i": 1, "q": 0}}},
              {"type": "feature", "seq": 1, "t": 0.20,
               "harmonics": {"f1": {"mag": 1, "phase": 0, "i": 1, "q": 0}}}])

    async def timed(speed):
        src = ReplaySource(None, p, speed=speed)
        loop = asyncio.get_event_loop()
        t0 = loop.time()
        async for _ in src.stream():
            pass
        return loop.time() - t0

    fast = asyncio.run(timed(10.0))  # ~0.02 s
    assert fast < 0.15  # clearly faster than the 0.20 s real-time gap
