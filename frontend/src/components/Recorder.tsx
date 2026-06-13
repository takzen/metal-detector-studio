"use client";

import { useEffect, useRef } from "react";
import uPlot from "uplot";
import type { FeatureFrame } from "@/lib/types";

export interface RecChannel {
  key: string;
  label: string;
  color: string;
  get: (f: FeatureFrame) => number | undefined;
}

// Multi-channel strip-chart recorder fed from the feature trail (extras + I/Q over time).
// Used to study SAT (audio vs threshold) and live filter/impulse behaviour (tap the coil).
export function Recorder({
  trailRef,
  channels,
  active,
  windowMs,
}: {
  trailRef: React.RefObject<FeatureFrame[]>;
  channels: RecChannel[];
  active: Set<string>;
  windowMs: number;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const winRef = useRef(windowMs);
  const activeRef = useRef(active);
  const loRef = useRef(-1);
  const hiRef = useRef(1);
  useEffect(() => {
    winRef.current = windowMs;
    activeRef.current = active;
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
        x: { time: false, range: () => [-winRef.current, 0] },
        y: { range: () => [loRef.current, hiRef.current] },
      },
      axes: [
        { stroke: "#8b98a9", grid: { stroke: "#1b2330", width: 1 }, ticks: { stroke: "#1b2330", width: 1 },
          values: (_u, s) => s.map((v) => v.toFixed(0)) },
        { stroke: "#8b98a9", grid: { stroke: "#1b2330", width: 1 }, ticks: { stroke: "#1b2330", width: 1 }, size: 56 },
      ],
      series: [
        {},
        ...channels.map((c) => ({ label: c.label, stroke: c.color, width: 1, points: { show: false } })),
      ],
      cursor: { y: false },
      legend: { show: false }, // channel toggle buttons act as the legend
    };
    const u = new uPlot(opts, [[], ...channels.map(() => [])] as unknown as uPlot.AlignedData, host);

    const ro = new ResizeObserver(() => {
      const r = host.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width));
      const h = Math.max(1, Math.round(r.height));
      if (w > 1 && h > 1) u.setSize({ width: w, height: h });
    });
    ro.observe(host);

    const tick = () => {
      af = requestAnimationFrame(tick);
      const trail = trailRef.current;
      if (trail.length < 2) return;
      const tNow = trail[trail.length - 1].t;
      const win = winRef.current / 1000;
      const t0 = tNow - win;

      // collect frames in the window
      let startIdx = trail.length - 1;
      while (startIdx > 0 && trail[startIdx - 1].t >= t0) startIdx--;
      const m = trail.length - startIdx;
      if (m < 2) return;

      const xs = new Array<number>(m);
      const cols: (number | null)[][] = channels.map(() => new Array<number | null>(m));
      let lo = Infinity;
      let hi = -Infinity;
      for (let k = 0; k < m; k++) {
        const f = trail[startIdx + k];
        xs[k] = (f.t - tNow) * 1000; // ms, newest = 0 at right
        for (let c = 0; c < channels.length; c++) {
          if (!activeRef.current.has(channels[c].key)) {
            cols[c][k] = null;
            continue;
          }
          const v = channels[c].get(f);
          if (v === undefined || Number.isNaN(v)) {
            cols[c][k] = null;
          } else {
            cols[c][k] = v;
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
      }
      if (lo === Infinity) {
        lo = -1;
        hi = 1;
      }
      if (hi - lo < 1e-6) {
        lo -= 1;
        hi += 1;
      }
      const pad = (hi - lo) * 0.1;
      loRef.current += 0.15 * (lo - pad - loRef.current);
      hiRef.current += 0.15 * (hi + pad - hiRef.current);

      // resetScales=true (default) so uPlot commits the redraw; passing false skips commit().
      u.setData([xs, ...cols] as unknown as uPlot.AlignedData);
    };
    af = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(af);
      ro.disconnect();
      u.destroy();
    };
  }, [trailRef, channels]);

  return <div ref={hostRef} className="h-full w-full" />;
}
