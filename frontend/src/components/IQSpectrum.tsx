"use client";

import { useEffect, useRef } from "react";
import uPlot from "uplot";
import { amplitudeSpectrum, binFreqs, pow2Floor } from "@/lib/fft";

const DB_FLOOR = -100;

export function IQSpectrum({
  iRef,
  qRef,
  fsRef,
  spanHz,
}: {
  iRef: React.RefObject<number[]>;
  qRef: React.RefObject<number[]>;
  fsRef: React.RefObject<number>;
  spanHz: number | "full";
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const spanRef = useRef<number | "full">(spanHz);
  const peakRef = useRef<{ f: number; db: number } | null>(null);
  useEffect(() => {
    spanRef.current = spanHz;
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
        y: { range: [DB_FLOOR, 0] },
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
      ],
      cursor: { y: false },
      legend: { show: false },
      hooks: {
        draw: [
          (up) => {
            const pk = peakRef.current;
            if (!pk) return;
            const ctx = up.ctx;
            const x = up.valToPos(pk.f, "x", true);
            const top = up.valToPos(0, "y", true);
            const bot = up.valToPos(DB_FLOOR, "y", true);
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
      const ib = iRef.current;
      const qb = qRef.current;
      const fs = fsRef.current || 1000;
      const n = pow2Floor(ib.length);
      if (n < 32) return;
      const ai = amplitudeSpectrum(ib.slice(ib.length - n));
      const aq = amplitudeSpectrum(qb.slice(qb.length - n));
      const freqs = binFreqs(fs, n);
      const ref = 32768;
      const dbI = toDb(ai, ref);
      const dbQ = toDb(aq, ref);
      let pi = 1;
      for (let k = 2; k < dbI.length; k++) if (dbI[k] > dbI[pi]) pi = k;
      peakRef.current = { f: freqs[pi], db: dbI[pi] };
      // resetScales=true (default) so uPlot commits the redraw; passing false skips commit().
      u.setData([freqs as unknown as number[], dbI as unknown as number[], dbQ as unknown as number[]]);
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
