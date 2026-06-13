"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";

// Theoretical analysis of the firmware DSP filters (dsp/filters.h):
//  - one-pole EMA:      s += a*(x-s),         a = 1/2^shift
//  - band-pass pair:    s1=EMA(x,a1); bp = 2*(s1 - s2_prev); s2=EMA(s1,a2)
// We simulate the impulse response and evaluate the frequency response by DFT.

const M = 512; // impulse-response length (samples)

function emaImpulse(a: number): number[] {
  const h = new Array<number>(M);
  let s = 0;
  for (let n = 0; n < M; n++) {
    const x = n === 0 ? 1 : 0;
    s += a * (x - s);
    h[n] = s;
  }
  return h;
}

function bpImpulse(a1: number, a2: number): number[] {
  const h = new Array<number>(M);
  let s1 = 0;
  let s2 = 0;
  for (let n = 0; n < M; n++) {
    const x = n === 0 ? 1 : 0;
    s1 += a1 * (x - s1);
    const s2old = s2;
    h[n] = 2 * (s1 - s2old);
    s2 += a2 * (s1 - s2);
  }
  return h;
}

function freqResponseDb(h: number[], fs: number, nf = 256): { f: number[]; db: number[] } {
  const f = new Array<number>(nf);
  const db = new Array<number>(nf);
  let maxMag = 1e-12;
  const mags = new Array<number>(nf);
  for (let k = 0; k < nf; k++) {
    const freq = (k / (nf - 1)) * (fs / 2);
    f[k] = freq;
    let re = 0;
    let im = 0;
    const w = (2 * Math.PI * freq) / fs;
    for (let n = 0; n < h.length; n++) {
      re += h[n] * Math.cos(w * n);
      im -= h[n] * Math.sin(w * n);
    }
    mags[k] = Math.hypot(re, im);
    if (mags[k] > maxMag) maxMag = mags[k];
  }
  for (let k = 0; k < nf; k++) db[k] = 20 * Math.log10(mags[k] / maxMag + 1e-9);
  return { f, db };
}

function makePlot(
  host: HTMLDivElement,
  series: uPlot.Series[],
  xRange: () => [number, number],
  yRange: uPlot.Scale["range"],
): uPlot {
  const opts: uPlot.Options = {
    width: 100,
    height: 100,
    scales: { x: { time: false, range: xRange }, y: { range: yRange } },
    axes: [
      { stroke: "#8b98a9", grid: { stroke: "#1b2330", width: 1 }, ticks: { stroke: "#1b2330", width: 1 },
        values: (_u, s) => s.map((v) => v.toFixed(0)) },
      { stroke: "#8b98a9", grid: { stroke: "#1b2330", width: 1 }, ticks: { stroke: "#1b2330", width: 1 }, size: 52 },
    ],
    series: [{}, ...series],
    cursor: {},
    legend: { show: false },
  };
  return new uPlot(opts, [[]] as unknown as uPlot.AlignedData, host);
}

export function FilterLab() {
  const [type, setType] = useState<"ema" | "bp">("ema");
  const [shift1, setShift1] = useState(5);
  const [shift2, setShift2] = useState(7);
  const [fs, setFs] = useState(1000);

  const { impData, frData, fc } = useMemo(() => {
    const a1 = 1 / 2 ** shift1;
    const a2 = 1 / 2 ** shift2;
    const h = type === "ema" ? emaImpulse(a1) : bpImpulse(a1, a2);
    const xs = h.map((_, n) => (n / fs) * 1000); // ms
    const fr = freqResponseDb(h, fs);
    // -3 dB cutoff estimate from the response
    let fcEst = 0;
    for (let k = 0; k < fr.db.length; k++) {
      if (fr.db[k] >= -3) fcEst = fr.f[k];
    }
    return {
      impData: [xs, h] as unknown as uPlot.AlignedData,
      frData: [fr.f, fr.db] as unknown as uPlot.AlignedData,
      fc: fcEst,
    };
  }, [type, shift1, shift2, fs]);

  const impHost = useRef<HTMLDivElement | null>(null);
  const frHost = useRef<HTMLDivElement | null>(null);
  const uImp = useRef<uPlot | null>(null);
  const uFr = useRef<uPlot | null>(null);
  const fsRef = useRef(fs);
  const dataRef = useRef({ impData, frData });
  useEffect(() => {
    fsRef.current = fs;
    dataRef.current = { impData, frData };
  });

  useEffect(() => {
    const ih = impHost.current;
    const fh = frHost.current;
    if (!ih || !fh) return;
    const ro = new ResizeObserver(() => {
      for (const [host, uref, kind] of [
        [ih, uImp, "imp"],
        [fh, uFr, "fr"],
      ] as const) {
        const r = host.getBoundingClientRect();
        const w = Math.max(1, Math.round(r.width));
        const h = Math.max(1, Math.round(r.height));
        if (w <= 1 || h <= 1) continue;
        if (!uref.current) {
          if (kind === "imp") {
            uref.current = makePlot(
              host,
              [{ label: "h[n]", stroke: "#10b981", width: 1, points: { show: false } }],
              () => [0, (M / fsRef.current) * 1000],
              () => {
                const d = dataRef.current.impData[1] as number[];
                let lo = 0;
                let hi = 0;
                for (const v of d) {
                  if (v < lo) lo = v;
                  if (v > hi) hi = v;
                }
                const p = (hi - lo) * 0.1 || 0.1;
                return [lo - p, hi + p];
              },
            );
            uref.current.setData(dataRef.current.impData);
          } else {
            uref.current = makePlot(
              host,
              [{ label: "|H| dB", stroke: "#3b82f6", width: 1, points: { show: false } }],
              () => [0, fsRef.current / 2],
              [-60, 3],
            );
            uref.current.setData(dataRef.current.frData);
          }
        }
        uref.current.setSize({ width: w, height: h });
      }
    });
    ro.observe(ih);
    ro.observe(fh);
    return () => {
      ro.disconnect();
      uImp.current?.destroy();
      uFr.current?.destroy();
      uImp.current = null;
      uFr.current = null;
    };
  }, []);

  useEffect(() => {
    uImp.current?.setData(impData);
    uFr.current?.setData(frData);
  }, [impData, frData]);

  const btn = (activeCond: boolean) =>
    `rounded border px-2 py-0.5 text-xs transition-colors ${
      activeCond ? "border-accent text-foreground" : "border-border text-muted hover:text-foreground"
    }`;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-1">
          <span className="text-[11px] uppercase tracking-wide text-muted">filter</span>
          <button onClick={() => setType("ema")} className={btn(type === "ema")}>EMA</button>
          <button onClick={() => setType("bp")} className={btn(type === "bp")}>band-pass</button>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[11px] uppercase tracking-wide text-muted">shift</span>
          <button onClick={() => setShift1((s) => Math.max(1, s - 1))} className={btn(false)}>−</button>
          <span className="w-6 text-center font-mono text-xs tabular-nums">{shift1}</span>
          <button onClick={() => setShift1((s) => Math.min(12, s + 1))} className={btn(false)}>+</button>
        </div>
        {type === "bp" && (
          <div className="flex items-center gap-1">
            <span className="text-[11px] uppercase tracking-wide text-muted">shift2</span>
            <button onClick={() => setShift2((s) => Math.max(1, s - 1))} className={btn(false)}>−</button>
            <span className="w-6 text-center font-mono text-xs tabular-nums">{shift2}</span>
            <button onClick={() => setShift2((s) => Math.min(12, s + 1))} className={btn(false)}>+</button>
          </div>
        )}
        <div className="flex items-center gap-1">
          <span className="text-[11px] uppercase tracking-wide text-muted">Fs</span>
          {[125, 250, 1000].map((v) => (
            <button key={v} onClick={() => setFs(v)} className={btn(fs === v)}>{v}</button>
          ))}
        </div>
        <span className="font-mono text-xs text-muted">≈ −3 dB @ {fc.toFixed(1)} Hz</span>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <div>
          <p className="mb-1 text-xs text-muted">impulse response h[n] · x: ms</p>
          <div ref={impHost} className="h-64 w-full" />
        </div>
        <div>
          <p className="mb-1 text-xs text-muted">frequency response · x: Hz · y: dB</p>
          <div ref={frHost} className="h-64 w-full" />
        </div>
      </div>
    </div>
  );
}
