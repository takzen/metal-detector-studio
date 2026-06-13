"""Pydantic mirror of the telemetry grammar (schema.json), Milestone B2.

These models are device-agnostic: ``FeatureFrame`` carries harmonics and phase
diffs as keyed maps, so single-freq and multi-freq devices share one shape. The
concrete keys come from the active profile.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class HarmonicSample(BaseModel):
    """One harmonic's vector in both polar and cartesian form."""

    mag: float
    phase: float  # rad
    i: float  # in-phase = mag*cos(phase)
    q: float  # quadrature = mag*sin(phase)


class FeatureFrame(BaseModel):
    """Fast per-harmonic feature frame (drives the XY hodograph + discrimination)."""

    type: Literal["feature"] = "feature"
    seq: int
    t: float  # device timestamp, s
    harmonics: dict[str, HarmonicSample]
    phase_diffs: dict[str, float] = Field(default_factory=dict)  # rad
    extras: dict[str, float] = Field(default_factory=dict)


class RawBlock(BaseModel):
    """Raw RX ADC block for the virtual scope and live FFT."""

    type: Literal["raw"] = "raw"
    seq: int
    t: float
    sample_rate_hz: int
    samples: list[int]  # int16-range


class Hello(BaseModel):
    """Handshake sent once on connect; binds the PC to the active profile."""

    type: Literal["hello"] = "hello"
    schema_version: str
    profile: dict[str, Any]


class ConfigCommand(BaseModel):
    """Configuration command from the PC to the device / synthetic source."""

    type: Literal["config"] = "config"
    key: str
    value: Any = None


class ConfigAck(BaseModel):
    """Acknowledgement of a config command."""

    type: Literal["config_ack"] = "config_ack"
    key: str
    value: Any = None
    ok: bool = True
    detail: str = ""


# Anything a source may emit downstream to clients.
TelemetryPacket = FeatureFrame | RawBlock
