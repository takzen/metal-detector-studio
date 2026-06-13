"use client";

import { useEffect, useRef } from "react";
import uPlot from "uplot";

const BUF_MAX = 2000;

export function IQScope({
  iRef,
  qRef,
  fsRef,
}: {
  iRef: React.RefObject<number[]>;
  qRef: React.RefObject<number[]>;
  fsRef: React.RefObject<number>;
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
        x: { time: false, range: () => [0, (BUF_MAX / (fsRef.current || 1000)) * 1000] },
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
      const n = ib.length;
      if (n < 2) return;
      const fs = fsRef.current || 1000;
      const xs = new Array<number>(n);
      let peak = 1;
      for (let k = 0; k < n; k++) {
        xs[k] = (k / fs) * 1000;
        const a = Math.abs(ib[k]);
        const b = Math.abs(qb[k]);
        if (a > peak) peak = a;
        if (b > peak) peak = b;
      }
      peakRef.current = peakRef.current + 0.1 * (peak * 1.1 - peakRef.current);
      u.setData([xs, ib.slice(), qb.slice()], false);
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
