"""Unit tests for the serial line parsers (token-based, unknown tokens ignored)."""

from __future__ import annotations

from app.sources.serial import _parse_adc, _parse_feature, _parse_raw


def test_parse_feature_basic():
    f = _parse_feature("X:123 Y:-45 VDI:12 G:0 M:3")
    assert f["X"] == 123.0
    assert f["Y"] == -45.0
    assert f["VDI"] == 12.0
    assert f["M"] == 3.0


def test_parse_feature_ignores_unknown_and_malformed():
    f = _parse_feature("X:1 GARBAGE Z:notanumber Y:2 lonely")
    assert f == {"X": 1.0, "Y": 2.0}  # bad token + valueless tokens dropped


def test_parse_raw_block():
    parsed = _parse_raw("RB:1000 3 1 2 3 4 5 6")
    assert parsed is not None
    fs, i, q = parsed
    assert fs == 1000
    assert i == [1, 3, 5]
    assert q == [2, 4, 6]


def test_parse_raw_rejects_non_rb():
    assert _parse_raw("X:1 Y:2") is None


def test_parse_raw_rejects_mismatched_counts():
    # claims 3 pairs but only provides 2 → truncated to 2 pairs, still balanced;
    # use an odd count to force imbalance
    assert _parse_raw("RB:1000 2 1 2 3") is None


def test_parse_adc_block():
    parsed = _parse_adc("AB:2000 4 10 -20 30 -40")
    assert parsed is not None
    fs, samples = parsed
    assert fs == 2000
    assert samples == [10, -20, 30, -40]


def test_parse_adc_rejects_wrong_count():
    assert _parse_adc("AB:2000 4 10 20") is None  # declares 4, gives 2


def test_parse_adc_rejects_non_ab():
    assert _parse_adc("RB:1000 1 1 2") is None
