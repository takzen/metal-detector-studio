"use client";

import { useEffect, useRef } from "react";
import { colorFor } from "@/lib/palette";
import type { FeatureFrame, Harmonic } from "@/lib/types";

// Mirrors the device SERVICE2 screen: a single DELTA vector vs the tracked ground
// (ground at centre), auto-scaled to a slowly-decaying peak with a floor so it never
// zooms into noise when idle. One vector per harmonic — no point cloud.
const BASELINE_ALPHA = 0.02; // ground-tracking speed (per new frame)
const PEAK_DECAY = 1 / 64; // slow peak decay per new frame (like SERVICE2 peak>>6)
const FLOOR_FRAC = 0.02; // peak floor as a fraction of the ground magnitude
const ABS_FLOOR = 1e-6;

export function Hodograph({
  trailRef,
  harmonics,
}: {
  trailRef: React.RefObject<FeatureFrame[]>;
  harmonics: Harmonic[];
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const peakRef = useRef(1);
  const baselineRef = useRef<Map<string, { i: number; q: number }>>(new Map());
  const dispRef = useRef<Map<string, { i: number; q: number }>>(new Map());
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
      const radius = half * 0.92;
      const base = baselineRef.current;

      const latest = trail[trail.length - 1];

      // --- once per new frame: track ground + update decaying peak ---
      if (latest && latest.seq !== lastSeqRef.current) {
        lastSeqRef.current = latest.seq;
        let frameMag = 0;
        let groundMag = 0;
        for (const harm of harmonics) {
          const s = latest.harmonics[harm.id];
          if (!s) continue;
          const b = base.get(harm.id) ?? { i: s.i, q: s.q };
          b.i += BASELINE_ALPHA * (s.i - b.i);
          b.q += BASELINE_ALPHA * (s.q - b.q);
          base.set(harm.id, b);
          frameMag = Math.max(frameMag, Math.hypot(s.i - b.i, s.q - b.q));
          groundMag = Math.max(groundMag, Math.hypot(b.i, b.q));
        }
        let peak = peakRef.current * (1 - PEAK_DECAY);
        if (frameMag > peak) peak = frameMag;
        const floor = Math.max(ABS_FLOOR, FLOOR_FRAC * groundMag);
        if (peak < floor) peak = floor;
        peakRef.current = peak;
      }

      const peak = peakRef.current;
      const scale = radius / peak;
      const bx = (id: string) => base.get(id)?.i ?? 0;
      const by = (id: string) => base.get(id)?.q ?? 0;

      drawGrid(ctx, cx, cy, radius, peak);

      // one live vector per harmonic, from centre to tip (the SERVICE2 view)
      harmonics.forEach((harm, hi) => {
        const s = latest?.harmonics[harm.id];
        if (!s) return;
        const color = colorFor(hi);
        const ti = s.i - bx(harm.id);
        const tq = s.q - by(harm.id);
        // ease the displayed tip toward the target for smooth motion
        const d = dispRef.current.get(harm.id) ?? { i: ti, q: tq };
        d.i += 0.3 * (ti - d.i);
        d.q += 0.3 * (tq - d.q);
        dispRef.current.set(harm.id, d);
        const di = d.i;
        const dq = d.q;
        // X axis mirrored: ferrite / 0° sits on the LEFT (matches the device).
        const x = cx - di * scale;
        const y = cy - dq * scale;
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();
        // true I/Q demod phase of the delta, in degrees, on the tip
        const deg = (Math.atan2(dq, di) * 180) / Math.PI;
        ctx.font = "11px var(--font-geist-mono), monospace";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(`${harm.id} ${deg.toFixed(1)}°`, x + 7, y);
        ctx.textAlign = "start";
        ctx.textBaseline = "alphabetic";
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
  radius: number,
  peak: number,
) {
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1;
  ctx.strokeStyle = "#1b2330";
  for (const frac of [0.25, 0.5, 0.75, 1]) {
    ctx.beginPath();
    ctx.arc(cx, cy, radius * frac, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.strokeStyle = "#2a3342";
  ctx.beginPath();
  ctx.moveTo(cx - radius, cy);
  ctx.lineTo(cx + radius, cy);
  ctx.moveTo(cx, cy - radius);
  ctx.lineTo(cx, cy + radius);
  ctx.stroke();

  // --- degree protractor: I/Q demod phase atan2(Q,I); mirrored X (0° = ferrite, left) ---
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let d = 0; d < 360; d += 15) {
    const a = (d * Math.PI) / 180;
    // screen direction for phase d (matches the mirrored-X tip mapping)
    const dirx = -Math.cos(a);
    const diry = -Math.sin(a);
    const major = d % 30 === 0;

    if (major) {
      // faint radial spoke across the whole plot
      ctx.strokeStyle = "#141b24";
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + dirx * radius, cy + diry * radius);
      ctx.stroke();
    }
    // rim tick
    ctx.strokeStyle = "#2a3342";
    ctx.beginPath();
    ctx.moveTo(cx + dirx * radius * (major ? 0.92 : 0.96), cy + diry * radius * (major ? 0.92 : 0.96));
    ctx.lineTo(cx + dirx * radius, cy + diry * radius);
    ctx.stroke();

    if (major) {
      ctx.fillStyle = "#8b98a9";
      ctx.font = "10px var(--font-geist-mono), monospace";
      ctx.fillText(`${d}°`, cx + dirx * radius * 0.83, cy + diry * radius * 0.83);
    }
  }
  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";

  ctx.fillStyle = "#8b98a9";
  ctx.font = "10px var(--font-geist-mono), monospace";
  ctx.fillText(`full-scale ${Math.round(peak)}`, cx + 4, cy - radius + 12);
}
