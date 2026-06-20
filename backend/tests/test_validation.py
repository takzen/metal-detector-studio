"""Frame validation (schema.json -> jsonschema) + CSV export of recordings."""

from __future__ import annotations

from conftest import write_recording

from app.frame_validation import FrameValidator
from app.profiles import load_schema


def _validator() -> FrameValidator:
    return FrameValidator(load_schema())


def test_valid_feature_frame_passes():
    fv = _validator()
    ok = fv.check({
        "type": "feature", "seq": 1, "t": 0.1,
        "harmonics": {"f1": {"mag": 1.0, "phase": 0.0, "i": 1.0, "q": 0.0}},
        "phase_diffs": {}, "extras": {"vdi": 5.0},
    })
    assert ok
    assert fv.frames_ok == 1 and fv.frames_bad == 0


def test_wrong_type_frame_fails_with_message():
    fv = _validator()
    ok = fv.check({
        "type": "feature", "seq": "NOPE", "t": 0.1,
        "harmonics": {}, "phase_diffs": {}, "extras": {},
    })
    assert not ok
    assert fv.frames_bad == 1
    assert "seq" in fv.last_error


def test_adc_raw_is_covered_by_schema():
    # adc_raw is a real packet (RawAdcBlock); it must validate, not be skipped.
    fv = _validator()
    ok = fv.check({"type": "adc_raw", "seq": 0, "t": 0.0, "sample_rate_hz": 22000, "samples": [1, -2, 3]})
    assert ok
    assert fv.skipped == 0


def test_unknown_type_is_skipped_not_failed():
    fv = _validator()
    assert fv.check({"type": "totally_unknown", "x": 1})
    assert fv.skipped == 1 and fv.frames_bad == 0


def test_health_exposes_frame_stats(client):
    h = client.get("/api/health").json()
    assert "frames" in h
    assert set(h["frames"]) >= {"frames_ok", "frames_bad", "skipped", "last_error"}


def test_recording_csv_download(client, rec_dir):
    write_recording(rec_dir / "rec-csv.ndjson")
    r = client.get("/api/recordings/rec-csv.ndjson/csv")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/csv")
    lines = r.text.strip().splitlines()
    assert lines[0].startswith("seq,t,")
    assert len(lines) == 3  # header + 2 feature frames (raw_iq skipped)


def test_recording_csv_save_writes_sibling(client, rec_dir):
    write_recording(rec_dir / "rec-save.ndjson")
    r = client.get("/api/recordings/rec-save.ndjson/csv", params={"save": 1})
    assert r.status_code == 200
    body = r.json()
    assert body["rows"] == 2
    assert body["file"] == "rec-save.csv"
    assert (rec_dir / "rec-save.csv").exists()


def test_recording_csv_bad_name_and_missing(client, rec_dir):
    assert client.get("/api/recordings/evil.txt/csv").status_code == 400
    assert client.get("/api/recordings/nope.ndjson/csv").status_code == 404
