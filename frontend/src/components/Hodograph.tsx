"use client";

import { useEffect, useRef } from "react";
import { colorFor } from "@/lib/palette";
import type { FeatureFrame, Harmonic } from "@/lib/types";

const TRAIL_DRAW = 320; // recent frames rendered as the fading trail
const BASELINE_ALPHA = 0.02; // ground-tracking speed for auto-zero

export function Hodograph({
  trailRef,
  harmonics,
}: {
  trailRef: React.RefObject<FeatureFrame[]>;
  harmonics: Harmonic[];
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const extentRef = useRef(1000); // smoothed auto-range (lsb)
  const baselineRef = useRef<Map<string, { i: number; q: number }>>(new Map());
  const lastSeqRef = useRef(-1);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let af = 0;
    let w = 0;
    let h = 0;
    let dpr = 1;

    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const draw = () => {
      af = requestAnimationFrame(draw);
      const trail = trailRef.current;
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);

      const cx = w / 2;
      const cy = h / 2;
      const half = Math.min(w, h) / 2;
      const base = baselineRef.current;

      // --- update ground baseline (slow EMA), once per new frame (by seq) ---
      const latest = trail[trail.length - 1];
      if (latest && latest.seq !== lastSeqRef.current) {
        lastSeqRef.current = latest.seq;
        for (const harm of harmonics) {
          const s = latest.harmonics[harm.id];
          if (!s) continue;
          const b = base.get(harm.id) ?? { i: s.i, q: s.q };
          b.i += BASELINE_ALPHA * (s.i - b.i);
          b.q += BASELINE_ALPHA * (s.q - b.q);
          base.set(harm.id, b);
        }
      }
      // Always plot the DELTA vs the tracked ground (raw absolute angle is useless
      // for a detector; ground sits at the centre, targets loop out at their angle).
      const bx = (id: string) => base.get(id)?.i ?? 0;
      const by = (id: string) => base.get(id)?.q ?? 0;

      // --- auto-range from the visible trail (after baseline removal) ---
      const start = Math.max(0, trail.length - TRAIL_DRAW);
      let peak = 1;
      for (let k = start; k < trail.length; k++) {
        const hs = trail[k].harmonics;
        for (const harm of harmonics) {
          const s = hs[harm.id];
          if (!s) continue;
          const m = Math.max(Math.abs(s.i - bx(harm.id)), Math.abs(s.q - by(harm.id)));
          if (m > peak) peak = m;
        }
      }
      // smooth toward peak*1.15 so the view doesn't jitter
      const target = peak * 1.15;
      extentRef.current += (target - extentRef.current) * 0.08;
      const extent = extentRef.current;
      const scale = (half * 0.92) / extent;

      drawGrid(ctx, cx, cy, half, extent);

      // --- per-harmonic trail ---
      harmonics.forEach((harm, hi) => {
        const color = colorFor(hi);
        const obx = bx(harm.id);
        const oby = by(harm.id);
        const n = trail.length - start;
        for (let k = start; k < trail.length; k++) {
          const s = trail[k].harmonics[harm.id];
          if (!s) continue;
          const age = (k - start) / Math.max(1, n); // 0 old .. 1 new
          ctx.globalAlpha = 0.05 + 0.55 * age;
          ctx.fillStyle = color;
          const x = cx + (s.i - obx) * scale;
          const y = cy - (s.q - oby) * scale;
          const r = 0.6 + 1.4 * age;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
        }
        // latest point + vector from origin
        const last = trail[trail.length - 1]?.harmonics[harm.id];
        if (last) {
          const x = cx + (last.i - obx) * scale;
          const y = cy - (last.q - oby) * scale;
          ctx.globalAlpha = 0.35;
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(x, y);
          ctx.stroke();
          ctx.globalAlpha = 1;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(x, y, 3.5, 0, Math.PI * 2);
          ctx.fill();
        }
      });
      ctx.restore();
    };
    af = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(af);
      ro.disconnect();
    };
  }, [trailRef, harmonics]);

  return <canvas ref={canvasRef} className="h-full w-full" />;
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  half: number,
  extent: number,
) {
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1;
  // concentric range rings (quarter / half / full extent)
  ctx.strokeStyle = "#1b2330";
  for (const frac of [0.25, 0.5, 0.75, 1]) {
    ctx.beginPath();
    ctx.arc(cx, cy, half * 0.92 * frac, 0, Math.PI * 2);
    ctx.stroke();
  }
  // axes
  ctx.strokeStyle = "#2a3342";
  ctx.beginPath();
  ctx.moveTo(cx - half * 0.92, cy);
  ctx.lineTo(cx + half * 0.92, cy);
  ctx.moveTo(cx, cy - half * 0.92);
  ctx.lineTo(cx, cy + half * 0.92);
  ctx.stroke();
  // extent label
  ctx.fillStyle = "#8b98a9";
  ctx.font = "10px var(--font-geist-mono), monospace";
  ctx.fillText(`±${Math.round(extent)} lsb`, cx + 4, cy - half * 0.92 + 12);
  ctx.fillText("I →", cx + half * 0.92 - 22, cy - 4);
  ctx.fillText("Q ↑", cx + 4, cy - half * 0.92 + 24);
}
