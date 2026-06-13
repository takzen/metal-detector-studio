"use client";

import { useEffect, useRef } from "react";
import uPlot from "uplot";
import { amplitudeSpectrum, binFreqs, pow2Floor, toDbfs } from "@/lib/fft";
import type { RawBlock } from "@/lib/types";

const DB_FLOOR = -100;

export function Spectrum({
  rawRef,
  sampleRateHz,
  blockSize,
  fullscaleLsb,
}: {
  rawRef: React.RefObject<RawBlock | null>;
  sampleRateHz: number;
  blockSize: number;
  fullscaleLsb: number;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const n0 = pow2Floor(blockSize);
    let freqsKHz = Float64Array.from(binFreqs(sampleRateHz, n0), (f) => f / 1000);
    const nyquistKHz = sampleRateHz / 2 / 1000;
    const empty = new Float64Array(freqsKHz.length).fill(DB_FLOOR);

    const rect = host.getBoundingClientRect();
    const opts: uPlot.Options = {
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
      scales: {
        x: { time: false, range: [0, nyquistKHz] },
        y: { range: [DB_FLOOR, 0] },
      },
      axes: [
        {
          stroke: "#8b98a9",
          grid: { stroke: "#1b2330", width: 1 },
          ticks: { stroke: "#1b2330", width: 1 },
          values: (_u, splits) => splits.map((v) => `${v.toFixed(0)}`),
        },
        {
          stroke: "#8b98a9",
          grid: { stroke: "#1b2330", width: 1 },
          ticks: { stroke: "#1b2330", width: 1 },
          size: 52,
        },
      ],
      series: [
        {},
        {
          label: "|X| dBFS",
          stroke: "#10b981",
          width: 1,
          fill: "rgba(16,185,129,0.12)",
          points: { show: false },
        },
      ],
      cursor: { y: false },
      legend: { show: false },
    };

    const u = new uPlot(opts, [freqsKHz as unknown as number[], empty as unknown as number[]], host);

    const ro = new ResizeObserver(() => {
      const r = host.getBoundingClientRect();
      u.setSize({ width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) });
    });
    ro.observe(host);

    let af = 0;
    let lastSeq = -1;
    const tick = () => {
      af = requestAnimationFrame(tick);
      const raw = rawRef.current;
      if (!raw || raw.seq === lastSeq) return;
      lastSeq = raw.seq;

      const amp = amplitudeSpectrum(raw.samples);
      if (amp.length !== freqsKHz.length) {
        const n = pow2Floor(raw.samples.length);
        freqsKHz = Float64Array.from(binFreqs(raw.sample_rate_hz, n), (f) => f / 1000);
      }
      const db = new Float64Array(amp.length);
      for (let k = 0; k < amp.length; k++) db[k] = toDbfs(amp[k], fullscaleLsb);
      // resetScales=true (default) so uPlot commits the redraw; passing false skips commit().
      u.setData([freqsKHz as unknown as number[], db as unknown as number[]]);
    };
    af = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(af);
      ro.disconnect();
      u.destroy();
    };
  }, [rawRef, sampleRateHz, blockSize, fullscaleLsb]);

  return <div ref={hostRef} className="h-full w-full" />;
}
