"""Device profiles + schema loading and validation (Milestone A3).

A *profile* (``profiles/<id>.json``) is the concrete description of one detector:
its harmonics, phase-diff definitions, raw-ADC parameters, stream rates, allowed
config keys, and the synthetic-source model. The backend stays device-agnostic by
reading everything from the active profile rather than hardcoding device specifics.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, model_validator

from . import config


# --- profile model -----------------------------------------------------------


class Harmonic(BaseModel):
    id: str
    index: int
    freq_hz: float


class PhaseDiff(BaseModel):
    name: str
    # 'from' is a Python keyword, so accept it via alias and expose as from_id.
    from_id: str = Field(alias="from")
    to_id: str = Field(alias="to")
    description: str | None = None

    model_config = ConfigDict(populate_by_name=True)


class RawSpec(BaseModel):
    sample_rate_hz: int
    block_size: int
    dtype: str = "int16"
    adc_bits: int = 12
    adc_vref: float = 3.3
    fullscale_lsb: int = 2047


class StreamSpec(BaseModel):
    feature_hz: float
    raw_hz: float


class GroundVec(BaseModel):
    mag: float
    phase_deg: float


class TargetResp(BaseModel):
    amp: float
    phase_deg: float


class Target(BaseModel):
    name: str
    strength: float = 1.0
    response: dict[str, TargetResp]


class SynthSpec(BaseModel):
    sweep_period_s: float = 3.0
    target_dwell_s: float = 0.45
    noise_lsb: float = 10.0
    ground: dict[str, GroundVec]
    ground_drift_lsb: float = 0.0
    targets: list[Target]
    comment: str | None = None


class Profile(BaseModel):
    """A fully validated device profile."""

    id: str
    title: str
    device: dict
    harmonics: list[Harmonic]
    phase_diffs: list[PhaseDiff] = Field(default_factory=list)
    extras: list[str] = Field(default_factory=list)
    raw: RawSpec
    stream: StreamSpec
    config_keys: list[str] = Field(default_factory=list)
    synth: SynthSpec

    @model_validator(mode="after")
    def _check_references(self) -> "Profile":
        ids = {h.id for h in self.harmonics}
        if not ids:
            raise ValueError("profile must declare at least one harmonic")
        if len(ids) != len(self.harmonics):
            raise ValueError("duplicate harmonic ids")

        for pd in self.phase_diffs:
            missing = {pd.from_id, pd.to_id} - ids
            if missing:
                raise ValueError(
                    f"phase_diff {pd.name!r} references unknown harmonic(s): {sorted(missing)}"
                )

        missing_ground = ids - set(self.synth.ground)
        if missing_ground:
            raise ValueError(f"synth.ground missing harmonic(s): {sorted(missing_ground)}")

        for tgt in self.synth.targets:
            missing_resp = ids - set(tgt.response)
            if missing_resp:
                raise ValueError(
                    f"synth target {tgt.name!r} missing response for: {sorted(missing_resp)}"
                )
        return self

    @property
    def harmonic_ids(self) -> list[str]:
        return [h.id for h in self.harmonics]


# --- loading -----------------------------------------------------------------


@lru_cache(maxsize=1)
def load_schema() -> dict:
    """Return the device-agnostic packet grammar (schema.json)."""
    return json.loads(config.SCHEMA_PATH.read_text(encoding="utf-8"))


def list_profiles() -> list[str]:
    """Return available profile ids (filenames in profiles/)."""
    if not config.PROFILES_DIR.is_dir():
        return []
    return sorted(p.stem for p in config.PROFILES_DIR.glob("*.json"))


def _profile_path(profile_id: str) -> Path:
    return config.PROFILES_DIR / f"{profile_id}.json"


@lru_cache(maxsize=None)
def load_profile(profile_id: str | None = None) -> Profile:
    """Load and validate a profile by id (defaults to config.DEFAULT_PROFILE)."""
    pid = profile_id or config.DEFAULT_PROFILE
    path = _profile_path(pid)
    if not path.is_file():
        available = ", ".join(list_profiles()) or "<none>"
        raise FileNotFoundError(f"profile {pid!r} not found; available: {available}")
    data = json.loads(path.read_text(encoding="utf-8"))
    return Profile.model_validate(data)
