"use client";

import { useEffect, useRef } from "react";
import uPlot from "uplot";

export function IQScope({
  iRef,
  qRef,
  fsRef,
  windowMs,
  running,
  yScale,
}: {
  iRef: React.RefObject<number[]>;
  qRef: React.RefObject<number[]>;
  fsRef: React.RefObject<number>;
  windowMs: number;
  running: boolean;
  yScale: number | "auto";
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const peakRef = useRef(1);
  const winRef = useRef(windowMs);
  const runRef = useRef(running);
  const yRef = useRef<number | "auto">(yScale);
  useEffect(() => {
    winRef.current = windowMs;
    runRef.current = running;
    yRef.current = yScale;
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let af = 0;

    const r0 = host.getBoundingClientRect();
    const opts: uPlot.Options = {
      width: Math.max(1, Math.round(r0.width)),
      height: Math.max(1, Math.round(r0.height)),
      scales: {
        x: { time: false, range: () => [0, winRef.current] },
        y: {
          range: () => {
            const ys = yRef.current;
            return ys === "auto" ? [-peakRef.current, peakRef.current] : [-ys, ys];
          },
        },
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
      legend: { show: false },
    };
    const u = new uPlot(opts, [[], [], []] as unknown as uPlot.AlignedData, host);

    const ro = new ResizeObserver(() => {
      const r = host.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width));
      const h = Math.max(1, Math.round(r.height));
      if (w > 1 && h > 1) u.setSize({ width: w, height: h });
    });
    ro.observe(host);

    const tick = () => {
      af = requestAnimationFrame(tick);
      if (!runRef.current) return;
      const ib = iRef.current;
      const qb = qRef.current;
      const fs = fsRef.current || 1000;
      const want = Math.max(2, Math.round((winRef.current / 1000) * fs));
      const n = Math.min(ib.length, want);
      if (n < 2) return;
      const start = ib.length - n;
      const xs = new Array<number>(n);
      const iSeg = new Array<number>(n);
      const qSeg = new Array<number>(n);
      let peak = 1;
      for (let k = 0; k < n; k++) {
        xs[k] = (k / fs) * 1000;
        const a = ib[start + k];
        const b = qb[start + k];
        iSeg[k] = a;
        qSeg[k] = b;
        if (Math.abs(a) > peak) peak = Math.abs(a);
        if (Math.abs(b) > peak) peak = Math.abs(b);
      }
      if (yRef.current === "auto") peakRef.current += 0.1 * (peak * 1.1 - peakRef.current);
      // resetScales=true (default) so uPlot calls commit() → repaints AND re-evaluates
      // our x/y range fns each frame. setData(data, false) skips commit() = no redraw.
      u.setData([xs, iSeg, qSeg]);
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
