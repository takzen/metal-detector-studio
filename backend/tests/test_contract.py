"""Tests for the telemetry contract: profiles, schema, models, validator."""

from __future__ import annotations

from app.profiles import Profile, list_profiles, load_profile, load_schema
from app.telemetry.models import FeatureFrame, HarmonicSample, RawIQBlock
from app.validate_profile import main as validate_main


def test_schema_has_version():
    schema = load_schema()
    assert "schema_version" in schema


def test_urd1_profile_loads():
    p = load_profile("urd1")
    assert isinstance(p, Profile)
    assert p.id == "urd1"
    assert p.harmonic_ids  # at least one harmonic


def test_list_profiles_includes_urd1():
    assert "urd1" in list_profiles()


def test_all_shipped_profiles_validate():
    # exit code 0 means every profiles/*.json passed pydantic validation
    assert validate_main(["validate_profile"]) == 0


def test_feature_frame_roundtrip():
    f = FeatureFrame(
        seq=7, t=1.5,
        harmonics={"f1": HarmonicSample(mag=1.0, phase=0.0, i=1.0, q=0.0)},
    )
    again = FeatureFrame.model_validate_json(f.model_dump_json())
    assert again.seq == 7
    assert again.type == "feature"
    assert again.harmonics["f1"].i == 1.0


def test_raw_iq_type_tag():
    b = RawIQBlock(seq=0, t=0.0, sample_rate_hz=1000, i=[1], q=[2])
    assert b.model_dump()["type"] == "raw_iq"


def test_profile_rejects_unknown_phase_diff_reference():
    bad = {
        "id": "bad", "title": "Bad", "device": {},
        "harmonics": [{"id": "f1", "index": 1, "freq_hz": 1000.0}],
        "phase_diffs": [{"name": "d", "from": "f1", "to": "f9"}],
        "raw": {"sample_rate_hz": 1000, "block_size": 16},
        "stream": {"feature_hz": 50, "raw_hz": 1000},
    }
    try:
        Profile.model_validate(bad)
    except Exception as exc:  # pydantic ValidationError
        assert "unknown harmonic" in str(exc)
    else:
        raise AssertionError("expected validation to fail on unknown phase-diff reference")
