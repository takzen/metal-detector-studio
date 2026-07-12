// Single source of truth for the transmitter tones. They are set in the TX bench (CoilLab)
// and consumed everywhere else (hodograph, phase lab, harmonic readouts) so the whole app
// reflects one tone set instead of hard-coding them per profile.
//
// The frequencies live in a persisted state OWNED by the page (usePersistentState key
// "coilFreqs_v2") and are passed down — CoilLab is a controlled editor, the other views are
// read-only consumers via harmonicsFromTones().

import type { Harmonic } from "@/lib/types";

// Default SHE-PWM tones 4.5 / 13.5 / 40.5 kHz = the lowest tone's odd harmonics 1:3:9.
export const DEFAULT_TONES = [4500, 13500, 40500];

// Overlay the TX-bench tones onto the device profile's harmonics: keep each harmonic's id
// (so live-telemetry lookups by id stay valid) but take its frequency from the TX bench and
// recompute the harmonic index from the ratio to the lowest active tone. Returns [] when the
// device profile has no harmonics (nothing to plot anyway).
export function harmonicsFromTones(profileHarms: Harmonic[] | undefined, tones: number[]): Harmonic[] {
  if (!profileHarms?.length) return [];
  const active = tones.filter((t) => Number.isFinite(t) && t > 0);
  const fMin = active.length ? Math.min(...active) : 0;
  return profileHarms.map((h, i) => {
    const f = tones[i];
    return Number.isFinite(f) && f > 0 && fMin > 0
      ? { ...h, freq_hz: f, index: Math.max(1, Math.round(f / fMin)) }
      : h;
  });
}
