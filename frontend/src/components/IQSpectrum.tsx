"use client";

import { useEffect, useRef } from "react";
import uPlot from "uplot";
import { amplitudeSpectrum, binFreqs, pow2Floor } from "@/lib/fft";

const DB_FLOOR = -80;

export function IQSpectrum({
  iRef,
  qRef,
  fsRef,
}: {
  iRef: React.RefObject<number[]>;
  qRef: React.RefObject<number[]>;
  fsRef: React.RefObject<number>;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const rect = host.getBoundingClientRect();
    const opts: uPlot.Options = {
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
      scales: {
        x: { time: false, range: () => [0, (fsRef.current || 1000) / 2 / 1000] },
        y: { range: [DB_FLOOR, 0] },
      },
      axes: [
        { stroke: "#8b98a9", grid: { stroke: "#1b2330", width: 1 }, ticks: { stroke: "#1b2330", width: 1 },
          values: (_u, s) => s.map((v) => v.toFixed(2)) },
        { stroke: "#8b98a9", grid: { stroke: "#1b2330", width: 1 }, ticks: { stroke: "#1b2330", width: 1 }, size: 52 },
      ],
      series: [
        {},
        { label: "I", stroke: "#3b82f6", width: 1, points: { show: false } },
        { label: "Q", stroke: "#f59e0b", width: 1, points: { show: false }, fill: "rgba(245,158,11,0.08)" },
      ],
      cursor: { y: false },
      legend: { show: true },
    };
    const u = new uPlot(opts, [[], [], []] as unknown as uPlot.AlignedData, host);

    const ro = new ResizeObserver(() => {
      const r = host.getBoundingClientRect();
      u.setSize({ width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) });
    });
    ro.observe(host);

    const toDb = (amp: Float64Array, ref: number) => {
      const out = new Float64Array(amp.length);
      for (let k = 0; k < amp.length; k++) out[k] = 20 * Math.log10(amp[k] / ref + 1e-9);
      return out;
    };

    let af = 0;
    const tick = () => {
      af = requestAnimationFrame(tick);
      const ib = iRef.current;
      const qb = qRef.current;
      const fs = fsRef.current || 1000;
      const n = pow2Floor(ib.length);
      if (n < 32) return;
      const iSeg = ib.slice(ib.length - n);
      const qSeg = qb.slice(qb.length - n);
      const ai = amplitudeSpectrum(iSeg);
      const aq = amplitudeSpectrum(qSeg);
      const freqs = Float64Array.from(binFreqs(fs, n), (f) => f / 1000);
      // reference ~ full-scale of the downscaled int16 signal
      const ref = 32768;
      u.setData(
        [freqs as unknown as number[], toDb(ai, ref) as unknown as number[], toDb(aq, ref) as unknown as number[]],
        false,
      );
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
