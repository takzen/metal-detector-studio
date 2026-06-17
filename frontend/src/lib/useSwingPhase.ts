"use client";

import { useEffect, useRef, useState } from "react";
import type { FeatureFrame } from "./types";

// SERVICE1-style swing-phase "automacik" reproduced in the studio.
//
// Per frame on the studio delta (raw − studio zero): track a rising/falling hump.
// When a hump peaks above ARM and then decays below 50 % of that peak, commit the
// peak as one "swing": its differential phase atan2(dy, |dx|) (±90°, X folded so
// ferrite sits at 0° regardless of dx sign). The reported phase is the MEDIAN of
// the last PASS_N swings — robust to a bad swing, holds between swings.
//
// Thresholds mirror firmware screen_diag (taktyk-dsp/src/main.c): DIAG_VDI_THR
// 2000, DIAG_PASS_ARM = 4×, DIAG_PH_DEADBAND 0.5°. Works on the raw ~2²¹ scale.
const PASS_N = 10; // median window (swings)
const ARM = 8000; // |dx|+|dy| peak to count a swing as a real target (4×DIAG_VDI_THR)
const DEADBAND_DEG = 0.5; // |phase| below this → 0 (ferrite at zero doesn't flicker ±)
const DISP_MS = 200; // readout refresh

export function useSwingPhase(
  trailRef: React.RefObject<FeatureFrame[]>,
  harmonicId: string | undefined,
  zero: { i: number; q: number } | undefined,
  enabled: boolean,
): { phase: number | null; count: number } {
  const [out, setOut] = useState<{ phase: number | null; count: number }>({ phase: null, count: 0 });
  const zx = zero?.i ?? 0;
  const zy = zero?.q ?? 0;

  useEffect(() => {
    if (!enabled || !harmonicId) {
      setOut({ phase: null, count: 0 });
      return;
    }
    // swing state machine (reset on enable / new zero — mirrors diag_pass_reset)
    let peakAmp = 0;
    let valley = 0;
    let armed = false;
    let b0x = 0;
    let b0y = 0;
    let peakDx = 0;
    let peakDy = 0;
    let total = 0;
    const ring: number[] = [];
    // start from the latest frame so old history isn't re-scanned with the new zero
    const t0 = trailRef.current;
    let lastSeq = t0.length ? t0[t0.length - 1].seq : -1;
    let af = 0;
    let lastDisp = 0;

    const tick = () => {
      af = requestAnimationFrame(tick);
      const trail = trailRef.current;
      for (let k = 0; k < trail.length; k++) {
        const f = trail[k];
        if (f.seq <= lastSeq) continue;
        lastSeq = f.seq;
        const s = f.harmonics[harmonicId];
        if (!s) continue;
        const dx = s.i - zx;
        const dy = s.q - zy;
        const amp = Math.abs(dx) + Math.abs(dy);
        if (amp < valley) valley = amp;
        if (amp > peakAmp) {
          peakAmp = amp;
          peakDx = dx;
          peakDy = dy;
          if (amp >= ARM && amp >= valley * 2) armed = true;
        }
        if (amp < peakAmp / 2) {
          if (armed) {
            const cdx = peakDx - b0x;
            const cdy = peakDy - b0y;
            let ph = (Math.atan2(cdy, Math.abs(cdx)) * 180) / Math.PI; // ±90
            if (Math.abs(ph) < DEADBAND_DEG) ph = 0;
            ring.push(ph);
            if (ring.length > PASS_N) ring.shift();
            total++;
            armed = false;
            valley = amp;
          }
          peakAmp = amp;
          b0x = dx;
          b0y = dy;
        }
      }
      const now = performance.now();
      if (now - lastDisp >= DISP_MS) {
        lastDisp = now;
        if (ring.length === 0) {
          setOut({ phase: null, count: total });
        } else {
          const sorted = [...ring].sort((a, b) => a - b);
          const m = sorted.length;
          const med = m % 2 ? sorted[(m - 1) / 2] : (sorted[m / 2 - 1] + sorted[m / 2]) / 2;
          setOut({ phase: med, count: total });
        }
      }
    };
    af = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(af);
  }, [trailRef, harmonicId, enabled, zx, zy]);

  return out;
}
