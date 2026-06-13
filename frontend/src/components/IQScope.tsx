"use client";

import { useEffect, useRef } from "react";
import uPlot from "uplot";

export function IQScope({
  iRef,
  qRef,
  fsRef,
  windowMs,
}: {
  iRef: React.RefObject<number[]>;
  qRef: React.RefObject<number[]>;
  fsRef: React.RefObject<number>;
  windowMs: number;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const peakRef = useRef(1);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const rect = host.getBoundingClientRect();
    const opts: uPlot.Options = {
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
      scales: {
        x: { time: false, range: () => [0, windowMs] },
        y: { range: () => [-peakRef.current, peakRef.current] },
      },
      axes: [
        { stroke: "#8b98a9", grid: { stroke: "#1b2330", width: 1 }, ticks: { stroke: "#1b2330", width: 1 },
          values: (_u, s) => s.map((v) => v.toFixed(0)) },
        { stroke: "#8b98a9", grid: { stroke: "#1b2330", width: 1 }, ticks: { stroke: "#1b2330", width: 1 }, size: 52 },
      ],
      series: [
        {},
        { label: "I", stroke: "#3b82f6", width: 1, points: { show: false } },
        { label: "Q", stroke: "#f59e0b", width: 1, points: { show: false } },
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

    let af = 0;
    const tick = () => {
      af = requestAnimationFrame(tick);
      const ib = iRef.current;
      const qb = qRef.current;
      const fs = fsRef.current || 1000;
      const want = Math.max(2, Math.round((windowMs / 1000) * fs));
      const n = Math.min(ib.length, want);
      if (n < 2) return;
      const start = ib.length - n;
      const xs = new Array<number>(n);
      const iSeg = new Array<number>(n);
      const qSeg = new Array<number>(n);
      let peak = 1;
      for (let k = 0; k < n; k++) {
        xs[k] = (k / fs) * 1000; // 0 .. windowMs
        const a = ib[start + k];
        const b = qb[start + k];
        iSeg[k] = a;
        qSeg[k] = b;
        if (Math.abs(a) > peak) peak = Math.abs(a);
        if (Math.abs(b) > peak) peak = Math.abs(b);
      }
      peakRef.current = peakRef.current + 0.1 * (peak * 1.1 - peakRef.current);
      u.setData([xs, iSeg, qSeg], false);
    };
    af = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(af);
      ro.disconnect();
      u.destroy();
    };
  }, [iRef, qRef, fsRef, windowMs]);

  return <div ref={hostRef} className="h-full w-full" />;
}
