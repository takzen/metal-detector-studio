"""Synthetic telemetry source — the ``vlf_sim`` equivalent (Milestone C1).

Generates physically-plausible bench data with no hardware, driven entirely by the
active profile's ``synth`` block:

- a (slowly drifting) ground vector per harmonic,
- targets that pass under the coil on a periodic sweep, each with a characteristic
  per-harmonic phase signature and a Gaussian amplitude envelope,
- additive noise,

from which we derive the feature frame (mag/phase/i/q + phase diffs) and reconstruct
a raw RX ADC block for the scope/FFT. Several knobs are live-tunable via config
commands (paused, noise, sweep_period, target, gain).
"""

from __future__ import annotations

import asyncio
import math
import time
from collections.abc import AsyncIterator

import numpy as np

from ..profiles import Profile
from ..telemetry.models import (
    ConfigAck,
    ConfigCommand,
    FeatureFrame,
    HarmonicSample,
    RawBlock,
    TelemetryPacket,
)
from .base import TelemetrySource


def _wrap(angle: float) -> float:
    """Wrap an angle to (-pi, pi]."""
    return (angle + math.pi) % (2.0 * math.pi) - math.pi


class SyntheticSource(TelemetrySource):
    def __init__(self, profile: Profile) -> None:
        super().__init__(profile)
        s = profile.synth
        self._hids = profile.harmonic_ids

        # Ground vector per harmonic as a complex phasor (lsb).
        self._ground: dict[str, complex] = {
            hid: g.mag * np.exp(1j * math.radians(g.phase_deg))
            for hid, g in s.ground.items()
        }
        # Targets: name -> (strength, {hid: complex response phasor}).
        self._targets: list[tuple[str, float, dict[str, complex]]] = [
            (
                t.name,
                t.strength,
                {hid: r.amp * np.exp(1j * math.radians(r.phase_deg)) for hid, r in t.response.items()},
            )
            for t in s.targets
        ]

        # Live-tunable state (config commands mutate these).
        self._paused = False
        self._noise_scale = 1.0
        self._gain = 1.0
        self._sweep_period = float(s.sweep_period_s)
        self._forced_target: int | None = None  # index into self._targets, or None=auto

        self._rng = np.random.default_rng()
        self._t0 = time.monotonic()

    # --- public API ----------------------------------------------------------

    async def stream(self) -> AsyncIterator[TelemetryPacket]:
        st = self.profile.stream
        feature_dt = 1.0 / st.feature_hz
        raw_every = max(1, round(st.feature_hz / st.raw_hz))

        seq_feature = 0
        seq_raw = 0
        while True:
            if not self._paused:
                t = time.monotonic() - self._t0
                z = self._field(t)  # {hid: complex}
                yield self._feature_frame(seq_feature, t, z)
                seq_feature += 1

                if seq_feature % raw_every == 0:
                    yield self._raw_block(seq_raw, t, z)
                    seq_raw += 1

            await asyncio.sleep(feature_dt)

    async def apply_config(self, cmd: ConfigCommand) -> ConfigAck:
        if cmd.key not in self.profile.config_keys:
            return ConfigAck(key=cmd.key, value=cmd.value, ok=False, detail="unknown key for profile")
        try:
            return self._set(cmd.key, cmd.value)
        except (ValueError, TypeError) as exc:
            return ConfigAck(key=cmd.key, value=cmd.value, ok=False, detail=str(exc))

    # --- synthesis -----------------------------------------------------------

    def _field(self, t: float) -> dict[str, complex]:
        """Complex RX phasor per harmonic at time ``t``."""
        s = self.profile.synth
        # Which target is passing, and its envelope, for the current sweep.
        sweep_idx = int(t // self._sweep_period)
        local = t - sweep_idx * self._sweep_period
        center = self._sweep_period / 2.0
        sigma = max(s.target_dwell_s, 1e-3) / 2.355  # dwell ~= FWHM
        env = math.exp(-0.5 * ((local - center) / sigma) ** 2)

        if self._forced_target is not None:
            tgt = self._targets[self._forced_target]
        else:
            tgt = self._targets[sweep_idx % len(self._targets)] if self._targets else None

        noise_std = s.noise_lsb * self._noise_scale
        out: dict[str, complex] = {}
        for k, hid in enumerate(self._hids):
            # Ground + slow drift (two slow sines, offset per harmonic).
            drift = s.ground_drift_lsb * (
                math.sin(2 * math.pi * 0.05 * t + 0.7 * k)
                + 1j * math.sin(2 * math.pi * 0.037 * t + 1.3 * k)
            )
            z = self._ground[hid] + drift
            # Passing target.
            if tgt is not None:
                z += tgt[1] * env * tgt[2][hid]
            # Noise.
            z += self._rng.normal(0.0, noise_std) + 1j * self._rng.normal(0.0, noise_std)
            out[hid] = self._gain * z
        return out

    def _feature_frame(self, seq: int, t: float, z: dict[str, complex]) -> FeatureFrame:
        harmonics = {
            hid: HarmonicSample(
                mag=abs(v), phase=math.atan2(v.imag, v.real), i=v.real, q=v.imag
            )
            for hid, v in z.items()
        }
        phase = {hid: harmonics[hid].phase for hid in z}
        phase_diffs = {
            pd.name: _wrap(phase[pd.from_id] - phase[pd.to_id])
            for pd in self.profile.phase_diffs
        }
        extras = self._extras(z)
        return FeatureFrame(
            seq=seq, t=t, harmonics=harmonics, phase_diffs=phase_diffs, extras=extras
        )

    def _extras(self, z: dict[str, complex]) -> dict[str, float]:
        out: dict[str, float] = {}
        first = self._hids[0]
        if "gb_residual" in self.profile.extras:
            out["gb_residual"] = abs(z[first] - self._ground[first])
        if "temp_c" in self.profile.extras:
            out["temp_c"] = 25.0 + 2.0 * math.sin(2 * math.pi * 0.01 * (time.monotonic() - self._t0))
        return out

    def _raw_block(self, seq: int, t: float, z: dict[str, complex]) -> RawBlock:
        """Reconstruct an RX time-domain block from the current phasors."""
        raw = self.profile.raw
        n = raw.block_size
        fs = raw.sample_rate_hz
        ts = np.arange(n) / fs

        sig = np.zeros(n, dtype=np.float64)
        for h in self.profile.harmonics:
            v = z[h.id]
            amp = abs(v)
            ph = math.atan2(v.imag, v.real)
            sig += amp * np.cos(2 * math.pi * h.freq_hz * ts + ph)

        # A small near-band EMI interferer + white noise for realistic FFT/scope.
        emi_f = self.profile.harmonics[0].freq_hz * 1.27
        sig += 0.08 * abs(z[self._hids[0]]) * np.cos(2 * math.pi * emi_f * ts)
        sig += self._rng.normal(0.0, self.profile.synth.noise_lsb * self._noise_scale, n)

        # Scale to fit the ADC full scale, then quantize to int.
        fs_lsb = raw.fullscale_lsb
        peak = float(np.max(np.abs(sig))) or 1.0
        scale = min(1.0, 0.9 * fs_lsb / peak)
        samples = np.clip(np.round(sig * scale), -fs_lsb, fs_lsb).astype(np.int16)

        return RawBlock(seq=seq, t=t, sample_rate_hz=fs, samples=samples.tolist())

    # --- config --------------------------------------------------------------

    def _set(self, key: str, value) -> ConfigAck:
        ok = ConfigAck(key=key, value=value, ok=True)
        match key:
            case "paused":
                self._paused = bool(value)
            case "noise":
                self._noise_scale = max(0.0, float(value))
            case "gain":
                self._gain = max(0.0, float(value))
            case "sweep_period":
                self._sweep_period = max(0.1, float(value))
            case "target":
                self._forced_target = self._resolve_target(value)
            case "freq" | "mode":
                # Accepted but inert in the synthetic source.
                ok.detail = "accepted (no-op in synthetic source)"
            case _:
                return ConfigAck(key=key, value=value, ok=False, detail="unhandled key")
        return ok

    def _resolve_target(self, value) -> int | None:
        if value in (None, "auto", ""):
            return None
        names = [t[0] for t in self._targets]
        if isinstance(value, int) and 0 <= value < len(names):
            return value
        if isinstance(value, str) and value in names:
            return names.index(value)
        raise ValueError(f"unknown target {value!r}; available: {names}")
