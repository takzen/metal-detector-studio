"use client";

import { useEffect, useRef } from "react";
import uPlot from "uplot";
import { amplitudeSpectrum, binFreqs, pow2Floor, type WindowType } from "@/lib/fft";

const DB_FLOOR = -100;
// NOTE: the peak-table feature below is unstable / of dubious value (frequencies
// still drift). Kept behind the `onPeaks` opt-in toggle, not recommended.
const PEAKS_MS = 500; // throttle for the peak-table callback (slow = readable)
const PEAK_FLOOR_DB = -90; // ignore peaks below this absolute level
const PEAK_SMOOTH = 0.1; // EMA for the peak-detection spectrum (stabilises frequencies)
const PEAK_PROM_DB = 6; // a peak must stand this far above its local surroundings
const PEAK_WIN = 4; // bins each side used for the local floor / min separation
const PEAK_FMIN_HZ = 2; // ignore the sub-2 Hz baseline-drift region when picking peaks

export type SpectralPeak = { f: number; db: number };

export function IQSpectrum({
  iRef,
  qRef,
  fsRef,
  spanHz,
  maxHold = false,
  avgN = 1,
  mainsHz = 0,
  windowType = "hann",
  dbFloor = DB_FLOOR,
  onPeaks,
}: {
  iRef: React.RefObject<number[]>;
  qRef: React.RefObject<number[]>;
  fsRef: React.RefObject<number>;
  spanHz: number | "full";
  maxHold?: boolean; // overlay per-bin running maximum (catches short interferers)
  avgN?: number; // exponential averaging length (1 = off); smooths the noise floor
  mainsHz?: number; // mains fundamental for reference lines (0 = off, e.g. 50)
  windowType?: WindowType; // FFT window (resolution vs spectral leakage)
  dbFloor?: number; // bottom of the dB scale (visible dynamic range)
  onPeaks?: (peaks: SpectralPeak[]) => void; // throttled top-N peaks (unstable — see note)
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const spanRef = useRef<number | "full">(spanHz);
  const peakRef = useRef<{ f: number; db: number } | null>(null);
  const maxHoldRef = useRef(maxHold);
  const avgNRef = useRef(avgN);
  const mainsRef = useRef(mainsHz);
  const windowRef = useRef(windowType);
  const dbFloorRef = useRef(dbFloor);
  const onPeaksRef = useRef(onPeaks);
  useEffect(() => {
    spanRef.current = spanHz;
    maxHoldRef.current = maxHold;
    avgNRef.current = avgN;
    mainsRef.current = mainsHz;
    windowRef.current = windowType;
    dbFloorRef.current = dbFloor;
    onPeaksRef.current = onPeaks;
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let af = 0;

    const toDb = (amp: Float64Array, ref: number) => {
      const out = new Float64Array(amp.length);
      for (let k = 0; k < amp.length; k++) out[k] = 20 * Math.log10(amp[k] / ref + 1e-9);
      return out;
    };

    const r0 = host.getBoundingClientRect();
    const opts: uPlot.Options = {
      width: Math.max(1, Math.round(r0.width)),
      height: Math.max(1, Math.round(r0.height)),
      scales: {
        x: { time: false, range: () => [0, spanRef.current === "full" ? (fsRef.current || 1000) / 2 : spanRef.current] },
        y: { range: () => [dbFloorRef.current, 0] },
      },
      axes: [
        { stroke: "#8b98a9", grid: { stroke: "#1b2330", width: 1 }, ticks: { stroke: "#1b2330", width: 1 },
          values: (_u, s) => s.map((v) => `${v.toFixed(0)}`) },
        { stroke: "#8b98a9", grid: { stroke: "#1b2330", width: 1 }, ticks: { stroke: "#1b2330", width: 1 }, size: 52 },
      ],
      series: [
        {},
        { label: "I", stroke: "#3b82f6", width: 1, points: { show: false } },
        { label: "Q", stroke: "#f59e0b", width: 1, points: { show: false }, fill: "rgba(245,158,11,0.08)" },
        { label: "max", stroke: "#cbd5e1", width: 1, points: { show: false }, dash: [3, 3] },
      ],
      cursor: { y: false },
      legend: { show: false },
      hooks: {
        draw: [
          (up) => {
            // Mains reference grid: harmonics of the fundamental (hum in baseband I/Q).
            const mains = mainsRef.current;
            if (mains > 0) {
              const ctx = up.ctx;
              const top = up.valToPos(0, "y", true);
              const bot = up.valToPos(dbFloorRef.current, "y", true);
              const fMax = spanRef.current === "full" ? (fsRef.current || 1000) / 2 : (spanRef.current as number);
              ctx.save();
              ctx.strokeStyle = "rgba(239,68,68,0.28)";
              ctx.fillStyle = "rgba(239,68,68,0.7)";
              ctx.font = "10px var(--font-geist-mono), monospace";
              ctx.textAlign = "left";
              for (let k = 1; k * mains <= fMax; k++) {
                const x = up.valToPos(k * mains, "x", true);
                ctx.beginPath();
                ctx.moveTo(x, top);
                ctx.lineTo(x, bot);
                ctx.stroke();
                if (k === 1) ctx.fillText(`${mains}Hz`, x + 3, bot - 4);
              }
              ctx.restore();
            }

            const pk = peakRef.current;
            if (!pk) return;
            const ctx = up.ctx;
            const x = up.valToPos(pk.f, "x", true);
            const top = up.valToPos(0, "y", true);
            const bot = up.valToPos(dbFloorRef.current, "y", true);
            ctx.save();
            ctx.strokeStyle = "#10b981";
            ctx.setLineDash([4, 3]);
            ctx.beginPath();
            ctx.moveTo(x, top);
            ctx.lineTo(x, bot);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = "#10b981";
            ctx.font = "11px var(--font-geist-mono), monospace";
            const right = x > up.bbox.left + up.bbox.width / 2;
            ctx.textAlign = right ? "right" : "left";
            ctx.fillText(`${pk.f.toFixed(0)} Hz  ${pk.db.toFixed(0)} dB`, x + (right ? -6 : 6), top + 12);
            ctx.restore();
          },
        ],
      },
    };
    const u = new uPlot(opts, [[], [], [], []] as unknown as uPlot.AlignedData, host);

    // Per-bin state carried across frames (reset when the FFT length changes).
    let emaI: Float64Array | null = null;
    let emaQ: Float64Array | null = null;
    let mh: Float64Array | null = null; // running per-bin maximum [dB]
    let nanRow: Float64Array | null = null; // shown when max-hold is off
    let pkAvg: Float64Array | null = null; // time-smoothed spectrum used only for peak finding
    let prevMaxHold = false;
    let lastPeaksAt = 0;

    const ro = new ResizeObserver(() => {
      const r = host.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width));
      const h = Math.max(1, Math.round(r.height));
      if (w > 1 && h > 1) u.setSize({ width: w, height: h });
    });
    ro.observe(host);

    const tick = (now: number) => {
      af = requestAnimationFrame(tick);
      const ib = iRef.current;
      const qb = qRef.current;
      const fs = fsRef.current || 1000;
      const n = pow2Floor(ib.length);
      if (n < 32) return;
      const win = windowRef.current;
      // removeDc=true: baseband I/Q carries a large standing offset; drop it so the
      // 0 Hz bin doesn't leak through the window and mask weak near-DC target motion.
      const ai = amplitudeSpectrum(ib.slice(ib.length - n), win, true);
      const aq = amplitudeSpectrum(qb.slice(qb.length - n), win, true);
      const freqs = binFreqs(fs, n);
      const ref = 32768;
      const dbI = toDb(ai, ref);
      const dbQ = toDb(aq, ref);
      const len = dbI.length;

      // (Re)allocate per-bin buffers when the FFT length changes.
      if (!emaI || emaI.length !== len) {
        emaI = Float64Array.from(dbI);
        emaQ = Float64Array.from(dbQ);
        mh = new Float64Array(len).fill(-Infinity);
        nanRow = new Float64Array(len).fill(NaN);
        pkAvg = Float64Array.from(dbI);
      }

      // Always-on smoothing for peak detection (unstable feature — see note).
      for (let k = 0; k < len; k++) pkAvg![k] += (dbI[k] - pkAvg![k]) * PEAK_SMOOTH;

      // Exponential averaging (avgN = 1 → off; keep EMA primed so enabling is seamless).
      const avgN = Math.max(1, avgNRef.current | 0);
      let dispI: Float64Array = dbI;
      let dispQ: Float64Array = dbQ;
      if (avgN > 1) {
        const a = 1 / avgN;
        for (let k = 0; k < len; k++) {
          emaI[k] += (dbI[k] - emaI[k]) * a;
          emaQ![k] += (dbQ[k] - emaQ![k]) * a;
        }
        dispI = emaI;
        dispQ = emaQ!;
      } else {
        emaI.set(dbI);
        emaQ!.set(dbQ);
      }

      // Max-hold over the displayed I trace; reset the moment it is switched on.
      const holding = maxHoldRef.current;
      if (holding && !prevMaxHold) mh!.fill(-Infinity);
      prevMaxHold = holding;
      let mhRow = nanRow!;
      if (holding) {
        for (let k = 0; k < len; k++) if (dispI[k] > mh![k]) mh![k] = dispI[k];
        mhRow = mh!;
      }

      // Single-peak marker off the smoothed spectrum (stable, doesn't twitch).
      // Start above the baseline-drift region so the marker tracks real peaks,
      // not the sub-Hz wander that dominates the lowest bins after DC removal.
      const kmin = Math.max(2, Math.ceil((PEAK_FMIN_HZ * n) / fs));
      let pi = kmin;
      for (let k = kmin + 1; k < len; k++) if (pkAvg![k] > pkAvg![pi]) pi = k;
      peakRef.current = { f: freqs[pi], db: pkAvg![pi] };
      // resetScales=true (default) so uPlot commits the redraw; passing false skips commit().
      u.setData([
        freqs as unknown as number[],
        dispI as unknown as number[],
        dispQ as unknown as number[],
        mhRow as unknown as number[],
      ]);

      // Top-N peaks for the side table (throttled). Detected on the smoothed
      // spectrum with a prominence gate + min separation so the listed
      // frequencies are stable, distinct, real interferers — not noise bumps.
      const cb = onPeaksRef.current;
      if (cb && now - lastPeaksAt >= PEAKS_MS) {
        lastPeaksAt = now;
        const pa = pkAvg!;
        const cand: { k: number; db: number }[] = [];
        for (let k = kmin; k < len - 1; k++) {
          if (pa[k] < PEAK_FLOOR_DB || pa[k] <= pa[k - 1] || pa[k] < pa[k + 1]) continue;
          // local floor = lowest point within ±PEAK_WIN bins; prominence above it
          let lo = Infinity;
          const a = Math.max(0, k - PEAK_WIN);
          const b = Math.min(len - 1, k + PEAK_WIN);
          for (let j = a; j <= b; j++) if (pa[j] < lo) lo = pa[j];
          if (pa[k] - lo >= PEAK_PROM_DB) cand.push({ k, db: pa[k] });
        }
        cand.sort((x, y) => y.db - x.db);
        // greedy pick: keep strongest, drop anything within PEAK_WIN bins of a kept one
        const kept: { k: number; db: number }[] = [];
        for (const c of cand) {
          if (kept.every((p) => Math.abs(p.k - c.k) > PEAK_WIN)) kept.push(c);
          if (kept.length >= 6) break;
        }
        cb(kept.map((c) => ({ f: freqs[c.k], db: c.db })));
      }
    };
    af = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(af);
      ro.disconnect();
      u.destroy();
    };
  }, [iRef, qRef, fsRef]);

  return <div ref={hostRef} className="h-full w-full" />;
}
