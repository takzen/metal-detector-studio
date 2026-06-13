"use client";

import { useEffect, useRef } from "react";
import uPlot from "uplot";
import type { RawBlock } from "@/lib/types";

function buildXs(n: number, sampleRateHz: number): number[] {
  const xs = new Array<number>(n);
  const msPerSample = 1000 / sampleRateHz;
  for (let i = 0; i < n; i++) xs[i] = i * msPerSample;
  return xs;
}

export function Scope({
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

    const durationMs = (blockSize / sampleRateHz) * 1000;
    let xs = buildXs(blockSize, sampleRateHz);
    const ys0 = new Array<number>(blockSize).fill(0);

    const rect = host.getBoundingClientRect();
    const opts: uPlot.Options = {
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
      scales: {
        x: { time: false, range: [0, durationMs] },
        y: { range: [-fullscaleLsb, fullscaleLsb] },
      },
      axes: [
        {
          stroke: "#8b98a9",
          grid: { stroke: "#1b2330", width: 1 },
          ticks: { stroke: "#1b2330", width: 1 },
          values: (_u, splits) => splits.map((v) => `${v.toFixed(1)}`),
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
        { label: "RX", stroke: "#3b82f6", width: 1, points: { show: false } },
      ],
      cursor: { y: false },
      legend: { show: false },
    };

    const u = new uPlot(opts, [xs, ys0], host);

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
      const n = raw.samples.length;
      if (xs.length !== n) xs = buildXs(n, raw.sample_rate_hz);
      u.setData([xs, raw.samples], false);
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
