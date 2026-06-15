"use client";

import { useEffect, useRef } from "react";
import { amplitudeSpectrum, pow2Floor, type WindowType } from "@/lib/fft";

const DB_FLOOR = -100; // bottom of the colour scale [dB]
const DB_TOP = 0; // top of the colour scale [dB]
const ROW_MIN_MS = 33; // throttle: at most ~30 new rows/s

// Magma-ish colormap control points (t, r, g, b). Linear-interpolated.
const STOPS: [number, number, number, number][] = [
  [0.0, 0, 0, 4],
  [0.25, 40, 11, 84],
  [0.5, 139, 41, 129],
  [0.75, 245, 125, 21],
  [1.0, 252, 253, 191],
];

function colormap(t: number): [number, number, number] {
  if (t <= 0) return [STOPS[0][1], STOPS[0][2], STOPS[0][3]];
  if (t >= 1) return [STOPS[4][1], STOPS[4][2], STOPS[4][3]];
  for (let i = 1; i < STOPS.length; i++) {
    if (t <= STOPS[i][0]) {
      const [t0, r0, g0, b0] = STOPS[i - 1];
      const [t1, r1, g1, b1] = STOPS[i];
      const f = (t - t0) / (t1 - t0);
      return [r0 + (r1 - r0) * f, g0 + (g1 - g0) * f, b0 + (b1 - b0) * f];
    }
  }
  return [STOPS[4][1], STOPS[4][2], STOPS[4][3]];
}

/**
 * Scrolling spectrogram (waterfall) of the demodulated I channel.
 * X = frequency (same span as the line FFT), Y = time (newest at top),
 * colour = magnitude [dBFS]. Rows scroll down via ImageData.copyWithin so the
 * frequency-axis strip (drawn in HTML below) never scrolls with the data.
 */
export function IQWaterfall({
  iRef,
  fsRef,
  spanHz,
  windowType = "hann",
  dbFloor = DB_FLOOR,
}: {
  iRef: React.RefObject<number[]>;
  fsRef: React.RefObject<number>;
  spanHz: number | "full";
  windowType?: WindowType;
  dbFloor?: number; // bottom of the colour scale [dB]
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const spanRef = useRef<number | "full">(spanHz);
  const windowRef = useRef(windowType);
  const dbFloorRef = useRef(dbFloor);
  useEffect(() => {
    spanRef.current = spanHz;
    windowRef.current = windowType;
    dbFloorRef.current = dbFloor;
  });

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let af = 0;
    let img: ImageData | null = null;
    let W = 0;
    let H = 0;
    let lastSpan: number | "full" | null = null;
    let lastRowAt = 0;

    const allocate = () => {
      const r = host.getBoundingClientRect();
      W = Math.max(1, Math.round(r.width));
      H = Math.max(1, Math.round(r.height));
      canvas.width = W;
      canvas.height = H;
      img = ctx.createImageData(W, H);
      // fill opaque black
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) d[i + 3] = 255;
      ctx.putImageData(img, 0, 0);
    };
    allocate();

    const ro = new ResizeObserver(allocate);
    ro.observe(host);

    const tick = (now: number) => {
      af = requestAnimationFrame(tick);
      if (!img) return;
      if (now - lastRowAt < ROW_MIN_MS) return;

      const ib = iRef.current;
      const fs = fsRef.current || 1000;
      const n = pow2Floor(ib.length);
      if (n < 32) return;

      const span = spanRef.current;
      const maxFreq = span === "full" ? fs / 2 : span;
      // Clear the history if the span changed (old rows would be mis-scaled).
      if (lastSpan !== null && lastSpan !== span) {
        const d0 = img.data;
        for (let i = 0; i < d0.length; i += 4) {
          d0[i] = 0;
          d0[i + 1] = 0;
          d0[i + 2] = 4;
        }
      }
      lastSpan = span;

      const amp = amplitudeSpectrum(ib.slice(ib.length - n), windowRef.current);
      const binHz = fs / n;
      const ref = 32768;
      const d = img.data;

      // Scroll everything down by one row, then paint the new spectrum at y=0.
      d.copyWithin(W * 4, 0, W * 4 * (H - 1));
      for (let x = 0; x < W; x++) {
        const freq = (x / W) * maxFreq;
        let bin = Math.round(freq / binHz);
        if (bin >= amp.length) bin = amp.length - 1;
        const db = 20 * Math.log10(amp[bin] / ref + 1e-9);
        const floor = dbFloorRef.current;
        const t = (db - floor) / (DB_TOP - floor);
        const [r, g, b] = colormap(t);
        const o = x * 4;
        d[o] = r;
        d[o + 1] = g;
        d[o + 2] = b;
        d[o + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      lastRowAt = now;
    };
    af = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(af);
      ro.disconnect();
    };
  }, [iRef, fsRef]);

  return <div ref={hostRef} className="relative h-full w-full overflow-hidden">
    <canvas ref={canvasRef} className="block h-full w-full" />
  </div>;
}
