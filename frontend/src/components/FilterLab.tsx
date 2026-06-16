"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";

// Analysis of the real firmware DSP filters (taktyk-dsp src/dsp/*, src/modes/*).
// The per-sample mode steps run at ~1 kHz, so that is the design sample rate.
//   - one-pole EMA:        s += a*(x-s),  a = 1/2^shift          (filters.h ema_t)
//   - alpha EMA (SAT):     s += a*(x-s),  a = alphaQ15/2^15      (filters.h ema_a_t)
//   - 2-pole LP:           two cascaded EMA (DEEP/PIN/PROS lp -> lp2)
//   - band-pass pair:      s1=EMA(x); bp=2*(s1-s2_prev); s2=EMA(s1)  (filters.h bp_pair)
//   - DISC LP:             2nd-order biquad, Q29 coeffs            (biquad.h, mode_dynamic)
// Impulse response is simulated, the frequency response evaluated by DFT.

const M = 512; // impulse-response length (samples)
const Q29 = 2 ** 29;

// Real DISC low-pass biquad coefficients (Q29) from mode_dynamic.c BP_LPF[].
const DISC_BIQUAD = { b0: 977174, b1: 1954348, b2: 977174, a1: -1007033236, a2: 474071020 };

// Real SAT alpha tables (Q15), levels 1..20.
const PROS_SAT_ALPHA = [
  13, 16, 21, 27, 34, 44, 56, 72, 92, 118, 151, 193, 247, 316, 404, 517, 661, 846, 950, 999,
]; // mode_pros.c (VSAT — faster geometric scale)
const DEEP_SAT_ALPHA = [
  3, 4, 5, 7, 9, 12, 15, 20, 26, 34, 45, 59, 77, 101, 133, 174, 228, 298, 391, 512,
]; // mode_static.c (DEEP SAT high-pass tracker)

type Kind = "ema" | "lp2" | "bp" | "biquad" | "sat" | "box" | "discband";

function emaImpulse(a: number): number[] {
  const h = new Array<number>(M);
  let s = 0;
  for (let n = 0; n < M; n++) {
    s += a * ((n === 0 ? 1 : 0) - s);
    h[n] = s;
  }
  return h;
}

function lp2Impulse(a: number): number[] {
  const h = new Array<number>(M);
  let s1 = 0;
  let s2 = 0;
  for (let n = 0; n < M; n++) {
    s1 += a * ((n === 0 ? 1 : 0) - s1);
    s2 += a * (s1 - s2);
    h[n] = s2;
  }
  return h;
}

function bpImpulse(a1: number, a2: number): number[] {
  const h = new Array<number>(M);
  let s1 = 0;
  let s2 = 0;
  for (let n = 0; n < M; n++) {
    s1 += a1 * ((n === 0 ? 1 : 0) - s1);
    h[n] = 2 * (s1 - s2);
    s2 += a2 * (s1 - s2);
  }
  return h;
}

function biquadImpulse(b0: number, b1: number, b2: number, a1: number, a2: number): number[] {
  const h = new Array<number>(M);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let n = 0; n < M; n++) {
    const x = n === 0 ? 1 : 0;
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    h[n] = y;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
  }
  return h;
}

// N-tap moving average (boxcar FIR), DC gain 1. Used to represent the MXT SAT
// envelope window: the real tracker takes max-over-N (non-LTI, no |H(f)|), so the
// boxcar conveys the window length / smoothing as a genuine, plottable filter.
function boxImpulse(n: number): number[] {
  const h = new Array<number>(M).fill(0);
  for (let i = 0; i < n && i < M; i++) h[i] = 1 / n;
  return h;
}

// Effective DISC "motion band": biquad LPF 14 Hz cascaded with the motion
// high-pass (1 − EMA shift7) DISC applies on the amplitude envelope. LINEAR
// approximation — the real DISC path rectifies (|.|) between the two stages, so
// this shows the passband shape, not the exact non-linear envelope response.
function discBandImpulse(): number[] {
  const { b0, b1, b2, a1, a2 } = DISC_BIQUAD;
  const nb0 = b0 / Q29, nb1 = b1 / Q29, nb2 = b2 / Q29, na1 = a1 / Q29, na2 = a2 / Q29;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0; // biquad state
  let ema = 0; // motion-HP tracker
  const aHP = 1 / 2 ** 7; // DYN_MHP_SHIFT
  const h = new Array<number>(M);
  for (let n = 0; n < M; n++) {
    const x = n === 0 ? 1 : 0;
    const yb = nb0 * x + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = yb;
    h[n] = yb - ema; // high-pass = signal − EMA(signal)
    ema += aHP * (yb - ema);
  }
  return h;
}

function freqResponseDb(h: number[], fs: number, nf = 256): { f: number[]; db: number[] } {
  const f = new Array<number>(nf);
  const db = new Array<number>(nf);
  const mags = new Array<number>(nf);
  let maxMag = 1e-12;
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

/** Frequency band [lo, hi] where the (normalised) response stays >= thr dB.
 *  Low-pass → lo ≈ 0 (DC passes); band-pass → both edges are real cutoffs. */
function band(fr: { f: number[]; db: number[] }, thr: number): [number, number] {
  let lo = 0;
  let hi = 0;
  let found = false;
  for (let k = 0; k < fr.db.length; k++) {
    if (fr.db[k] >= thr) {
      if (!found) { lo = fr.f[k]; found = true; }
      hi = fr.f[k];
    }
  }
  return [lo, hi];
}

/** Step response = cumulative sum of the impulse response. */
function stepMetrics(h: number[], fs: number): { settlingMs: number | null; overshootPct: number | null } {
  const step = new Array<number>(h.length);
  let acc = 0;
  let peak = -Infinity;
  for (let n = 0; n < h.length; n++) {
    acc += h[n];
    step[n] = acc;
    if (acc > peak) peak = acc;
  }
  const final = step[step.length - 1];
  if (Math.abs(final) < 1e-6) return { settlingMs: null, overshootPct: null }; // band-pass: returns to 0
  const overshootPct = Math.max(0, ((peak - final) / Math.abs(final)) * 100);
  const band = 0.02 * Math.abs(final); // ±2% settling band
  let settleIdx = 0;
  for (let n = 0; n < step.length; n++) if (Math.abs(step[n] - final) > band) settleIdx = n;
  return { settlingMs: ((settleIdx + 1) / fs) * 1000, overshootPct };
}

function makePlot(
  host: HTMLDivElement,
  series: uPlot.Series[],
  xRange: () => [number, number],
  yRange: uPlot.Scale["range"],
  onCursor?: (u: uPlot) => void,
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
    cursor: { x: true, y: true, points: { show: true } },
    legend: { show: false },
    hooks: onCursor ? { setCursor: [onCursor] } : {},
  };
  return new uPlot(opts, [[]] as unknown as uPlot.AlignedData, host);
}

type SatTable = "pros" | "deep";

type Preset = {
  id: string;
  label: string;
  kind: Kind;
  shift1?: number;
  shift2?: number;
  sat?: number;
  satTable?: SatTable;
  win?: number;
  hp?: boolean; // firmware applies this tracker as `signal − EMA` = high-pass
  note: string;
};

// Real, instantiated firmware filters of THIS project (taktyk-dsp), pulled from
// ema_init / ema_a_init / biquad_set in src/modes/*. See docs/FILTRY-DSP.md.
const TAKTYK_PRESETS: Preset[] = [
  { id: "deeplp", label: "DEEP/PIN/PROS LP", kind: "lp2", shift1: 5, note: "DEEP/PROS/PIN: 2-pole EMA cascade, shift 5 — anti-noise low-pass ~3.2 Hz" },
  { id: "disc", label: "DISC LP", kind: "biquad", note: "DISC: 2nd-order Butterworth biquad (Q29 BP_LPF), −3 dB ≈ 14 Hz (anti-noise + 50 Hz reject)" },
  { id: "discband", label: "DISC motion band", kind: "discband", note: "DISC effective motion passband ≈ 1.2–14 Hz: biquad 14 Hz × motion HP (1−EMA shift7). Linear approx — real path rectifies |.| between the two stages." },
  { id: "discbase", label: "DISC baseline", kind: "ema", shift1: 10, note: "DISC ground baseline EMA shift10 (~0.16 Hz). Firmware applies it as l − EMA = high-pass → use the 'response: high-pass' toggle." },
  { id: "discmhp", label: "DISC motion-HP", kind: "ema", shift1: 7, note: "DISC motion tracker EMA shift7 (~1.2 Hz). Firmware applies it as A − EMA = motion high-pass → 'response: high-pass'." },
  { id: "ground", label: "ground track", kind: "ema", shift1: 9, note: "ground tracker EMA shift9 (~0.31 Hz). Applied as in − EMA = high-pass." },
  { id: "pinavg", label: "PIN average", kind: "ema", shift1: 8, note: "pinpoint baseline EMA shift8 (~0.62 Hz). Applied as raw − EMA = high-pass." },
  { id: "deepsat", label: "DEEP SAT", kind: "sat", satTable: "deep", sat: 10, note: "DEEP SAT noise/baseline tracker EMA_α (SAT_ALPHA); level sets α. Applied as static_mag − EMA_α = high-pass auto-zero." },
  { id: "prossat", label: "PROS VSAT", kind: "sat", satTable: "pros", sat: 10, note: "PROS VSAT tracker EMA_α (PROS_SAT_ALPHA); level sets α. Applied as lp − tracker = high-pass." },
];

// White's MXT reference (clean-room port, mxt/dsp/filters.c). Every MXT filter is a
// single-pole EMA with α=1/8 (shift 3), 24-bit, per ISR tick — the building blocks
// taktyk-dsp adapted. See docs/FILTRY-DSP.md §11.
const MXT_PRESETS: Preset[] = [
  { id: "mxtdelta", label: "MXT delta EMA", kind: "ema", shift1: 3, note: "delta EMA α=1/8 (extract_signal_deltas_via_baseline_ema) — shared front-end; Pinpoint resets this tracker" },
  { id: "mxt2pole", label: "MXT 2-pole", kind: "lp2", shift1: 3, note: "cascaded dual-EMA = 'two filters per channel', α=1/8 — shared by all programs" },
  { id: "mxtbp", label: "MXT band-pass", kind: "bp", shift1: 3, shift2: 3, note: "apply_phase_band_pass_filter_pair: LP=s2, BP=2·(s1−s2), α=1/8+1/8 — shared; pairB sign = iron-like flag → zip/boing" },
  { id: "mxtbase", label: "MXT baseline", kind: "ema", shift1: 1, note: "fast baseline tracker, α=0.5 / shift 1 (system_update_signal_baseline) — shared (all programs)" },
  { id: "mxtsat", label: "MXT SAT env", kind: "box", win: 5, note: "VSAT: max over 5 log-magnitude samples, gated by phase crossings (update_vsat_envelope_tracker) — Prospecting zip/boing + HyperSAT. Shown as 5-sample moving average; real max-filter is non-LTI." },
];

type ProjectId = "taktyk" | "mxt";
const PROJECTS: { id: ProjectId; label: string; presets: Preset[]; desc: string }[] = [
  {
    id: "taktyk",
    label: "taktyk-dsp",
    presets: TAKTYK_PRESETS,
    desc: "Per-mode pipelines — each preset is named by the mode that instantiates it (DEEP / DISC / PROS / PINPOINT). EMA trackers default to their real high-pass role.",
  },
  {
    id: "mxt",
    label: "MXT (ref)",
    presets: MXT_PRESETS,
    desc: "ONE shared pipeline for all programs (Coin&Jewelry / Relic / Prospecting + Pinpoint). Programs differ in audio + discrimination, NOT in these filters — so presets are pipeline stages, not modes.",
  },
];

export function FilterLab() {
  const [project, setProject] = useState<ProjectId>("taktyk");
  const [activePreset, setActivePreset] = useState<string | null>("deeplp");
  const [kind, setKind] = useState<Kind>("lp2");
  const [shift1, setShift1] = useState(5);
  const [shift2, setShift2] = useState(3);
  const [satLevel, setSatLevel] = useState(10); // 1..20
  const [satTable, setSatTable] = useState<SatTable>("pros");
  const [winN, setWinN] = useState(5); // boxcar window (MXT SAT env)
  const [resp, setResp] = useState<"lp" | "hp">("lp"); // show EMA as low-pass or its high-pass complement
  const [fs, setFs] = useState(1000);

  const projectMeta = PROJECTS.find((p) => p.id === project)!;
  const presets = projectMeta.presets;

  const applyPreset = (p: Preset) => {
    setKind(p.kind);
    if (p.shift1 != null) setShift1(p.shift1);
    if (p.shift2 != null) setShift2(p.shift2);
    if (p.sat != null) setSatLevel(p.sat);
    if (p.satTable != null) setSatTable(p.satTable);
    if (p.win != null) setWinN(p.win);
    setResp(p.hp ? "hp" : "lp");
    setActivePreset(p.id);
  };

  const selectProject = (id: ProjectId) => {
    setProject(id);
    applyPreset(PROJECTS.find((p) => p.id === id)!.presets[0]); // jump to that project's first filter
  };

  // Manual tweaks keep the picked preset highlighted (it marks the filter you
  // started from); the coeff/metrics line below always shows the live values.
  const onKind = (k: Kind) => setKind(k);
  const bumpShift1 = (d: number) => setShift1((s) => Math.min(12, Math.max(1, s + d)));
  const bumpShift2 = (d: number) => setShift2((s) => Math.min(12, Math.max(1, s + d)));
  const onSatTable = (t: SatTable) => setSatTable(t);
  const bumpSat = (d: number) => setSatLevel((s) => Math.min(20, Math.max(1, s + d)));
  const bumpWin = (d: number) => setWinN((s) => Math.min(32, Math.max(2, s + d)));
  const onResp = (r: "lp" | "hp") => setResp(r);

  const { impData, frData, band3Label, settlingMs, overshootPct, coeffText } = useMemo(() => {
    const a1 = 1 / 2 ** shift1;
    const a2 = 1 / 2 ** shift2;
    const satRaw = (satTable === "deep" ? DEEP_SAT_ALPHA : PROS_SAT_ALPHA)[satLevel - 1];
    const satAlpha = satRaw / 32768;
    let h: number[];
    let coeff: string;
    if (kind === "ema") {
      h = emaImpulse(a1);
      coeff = `α = 1/2^${shift1} = ${a1.toFixed(4)}`;
    } else if (kind === "lp2") {
      h = lp2Impulse(a1);
      coeff = `2× EMA, α = 1/2^${shift1} = ${a1.toFixed(4)}`;
    } else if (kind === "bp") {
      h = bpImpulse(a1, a2);
      coeff = `α1 = 1/2^${shift1}, α2 = 1/2^${shift2}`;
    } else if (kind === "sat") {
      h = emaImpulse(satAlpha);
      coeff = `${satTable === "deep" ? "DEEP SAT" : "PROS VSAT"} ${satLevel}: α = ${satRaw}/32768 = ${satAlpha.toFixed(4)}`;
    } else if (kind === "box") {
      h = boxImpulse(winN);
      coeff = `${winN}-tap moving average (boxcar), 1/${winN} each — MXT SAT env window (real = max-of-${winN})`;
    } else if (kind === "discband") {
      h = discBandImpulse();
      coeff = `DISC motion band ≈ biquad 14 Hz × HP(1−EMA shift7) — linear, ignores |.| rectifier`;
    } else {
      const { b0, b1, b2, a1: ba1, a2: ba2 } = DISC_BIQUAD;
      h = biquadImpulse(b0 / Q29, b1 / Q29, b2 / Q29, ba1 / Q29, ba2 / Q29);
      coeff = `b=[${b0}, ${b1}, ${b2}] a=[${ba1}, ${ba2}] (Q29)`;
    }
    // EMA-family trackers (ema / lp2 / sat) are applied in firmware as
    // `signal − tracker` = high-pass. The toggle plots that complement instead:
    // h_hp[n] = δ[n] − h_lp[n].
    const canHp = kind === "ema" || kind === "lp2" || kind === "sat";
    if (canHp && resp === "hp") {
      h = h.map((v, n) => (n === 0 ? 1 : 0) - v);
      coeff = `HP (1−EMA): ${coeff}`;
    }

    const xs = h.map((_, n) => (n / fs) * 1000); // ms
    const fr = freqResponseDb(h, fs);
    const { settlingMs, overshootPct } = stepMetrics(h, fs);

    // Name the −3 dB band by shape: low-pass → upper cutoff; high-pass → lower
    // cutoff; band-pass → both edges.
    const b3 = band(fr, -3);
    const dcPass = fr.db[0] >= -3;
    const nyqPass = fr.db[fr.db.length - 1] >= -3;
    let band3Label: string;
    if (dcPass && !nyqPass) band3Label = `−3 dB @ ${b3[1].toFixed(1)} Hz`;
    else if (!dcPass && nyqPass) band3Label = `−3 dB @ ${b3[0].toFixed(1)} Hz (HP)`;
    else if (!dcPass && !nyqPass) band3Label = `−3 dB ${b3[0].toFixed(1)}–${b3[1].toFixed(1)} Hz`;
    else band3Label = `−3 dB 0–${fr.f[fr.f.length - 1].toFixed(0)} Hz`;

    return {
      impData: [xs, h] as unknown as uPlot.AlignedData,
      frData: [fr.f, fr.db] as unknown as uPlot.AlignedData,
      band3Label,
      settlingMs,
      overshootPct,
      coeffText: coeff,
    };
  }, [kind, shift1, shift2, satLevel, satTable, winN, resp, fs]);

  const impHost = useRef<HTMLDivElement | null>(null);
  const frHost = useRef<HTMLDivElement | null>(null);
  const impRead = useRef<HTMLSpanElement | null>(null);
  const frRead = useRef<HTMLSpanElement | null>(null);
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

    if (!uImp.current) {
      uImp.current = makePlot(
        ih,
        [{ label: "h[n]", stroke: "#10b981", width: 1, points: { show: false } }],
        () => [0, (M / fsRef.current) * 1000],
        () => {
          const d = dataRef.current.impData[1] as number[];
          // A high-pass impulse is δ[0] − EMA, so h[0] ≈ 1 dwarfs the
          // α-dependent tail and would flatten it (level/shift changes become
          // invisible). If h[0] is a lone spike (≫ the rest), scale to the tail.
          let tail = 0;
          for (let i = 1; i < d.length; i++) {
            const a = Math.abs(d[i]);
            if (a > tail) tail = a;
          }
          const start = tail > 0 && Math.abs(d[0]) > 3 * tail ? 1 : 0;
          let lo = 0;
          let hi = 0;
          for (let i = start; i < d.length; i++) {
            const v = d[i];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
          const p = (hi - lo) * 0.1 || 0.1;
          return [lo - p, hi + p];
        },
        (u) => {
          const i = u.cursor.idx;
          if (!impRead.current) return;
          if (i == null) { impRead.current.textContent = ""; return; }
          const x = (u.data[0] as number[])[i];
          const y = (u.data[1] as number[])[i];
          impRead.current.textContent = `${x.toFixed(1)} ms · ${y.toFixed(4)}`;
        },
      );
      uImp.current.setData(dataRef.current.impData);
    }
    if (!uFr.current) {
      uFr.current = makePlot(
        fh,
        [{ label: "|H| dB", stroke: "#3b82f6", width: 1, points: { show: false } }],
        () => [0, fsRef.current / 2],
        [-60, 3],
        (u) => {
          const i = u.cursor.idx;
          if (!frRead.current) return;
          if (i == null) { frRead.current.textContent = ""; return; }
          const x = (u.data[0] as number[])[i];
          const y = (u.data[1] as number[])[i];
          frRead.current.textContent = `${x.toFixed(1)} Hz · ${y.toFixed(1)} dB`;
        },
      );
      uFr.current.setData(dataRef.current.frData);
    }

    const fit = () => {
      for (const [host, u] of [
        [ih, uImp.current],
        [fh, uFr.current],
      ] as const) {
        if (!u) continue;
        const r = host.getBoundingClientRect();
        const w = Math.max(1, Math.round(r.width));
        const h = Math.max(1, Math.round(r.height));
        if (w > 1 && h > 1) u.setSize({ width: w, height: h });
      }
    };
    fit();
    const ro = new ResizeObserver(fit);
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

  const btn = (active: boolean) =>
    `rounded border px-2 py-0.5 text-xs transition-colors ${
      active ? "border-accent text-foreground" : "border-border text-muted hover:text-foreground"
    }`;
  const lbl = "text-[10px] font-semibold uppercase tracking-wider text-muted";

  const showShift = kind === "ema" || kind === "lp2" || kind === "bp";

  return (
    <div className="flex flex-col gap-3">
      {/* Project switcher */}
      <div className="flex flex-wrap items-center gap-1.5 rounded-md bg-black/20 px-2 py-1">
        <span className={lbl}>project</span>
        {PROJECTS.map((pr) => (
          <button key={pr.id} onClick={() => selectProject(pr.id)} className={btn(project === pr.id)}>
            {pr.label}
          </button>
        ))}
      </div>

      {/* Filters instantiated in the selected project */}
      <div className="flex flex-wrap items-center gap-1.5 rounded-md bg-black/20 px-2 py-1">
        <span className={lbl}>filters</span>
        {presets.map((p) => (
          <button key={p.id} onClick={() => applyPreset(p)} className={btn(activePreset === p.id)} title={p.note}>
            {p.label}
          </button>
        ))}
      </div>
      <p className="-mt-2 px-1 text-[11px] leading-snug text-muted">{projectMeta.desc}</p>

      {/* Manual tweak */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          <span className={lbl}>type</span>
          {(["ema", "lp2", "bp", "biquad", "sat", "box", "discband"] as Kind[]).map((k) => (
            <button key={k} onClick={() => onKind(k)} className={btn(kind === k)}>
              {k === "lp2" ? "2-pole" : k === "bp" ? "band-pass" : k === "biquad" ? "biquad" : k === "box" ? "moving-avg" : k === "discband" ? "DISC-band" : k.toUpperCase()}
            </button>
          ))}
        </div>
        {(kind === "ema" || kind === "lp2" || kind === "sat") && (
          <div className="flex items-center gap-1">
            <span className={lbl}>response</span>
            <button onClick={() => onResp("lp")} className={btn(resp === "lp")}>low-pass</button>
            <button onClick={() => onResp("hp")} className={btn(resp === "hp")}>high-pass</button>
          </div>
        )}
        {showShift && (
          <div className="flex items-center gap-1">
            <span className={lbl}>shift</span>
            <button onClick={() => bumpShift1(-1)} className={btn(false)}>−</button>
            <span className="w-6 text-center font-mono text-xs tabular-nums">{shift1}</span>
            <button onClick={() => bumpShift1(1)} className={btn(false)}>+</button>
          </div>
        )}
        {kind === "bp" && (
          <div className="flex items-center gap-1">
            <span className={lbl}>shift2</span>
            <button onClick={() => bumpShift2(-1)} className={btn(false)}>−</button>
            <span className="w-6 text-center font-mono text-xs tabular-nums">{shift2}</span>
            <button onClick={() => bumpShift2(1)} className={btn(false)}>+</button>
          </div>
        )}
        {kind === "sat" && (
          <>
            <div className="flex items-center gap-1">
              <span className={lbl}>SAT table</span>
              <button onClick={() => onSatTable("deep")} className={btn(satTable === "deep")}>DEEP</button>
              <button onClick={() => onSatTable("pros")} className={btn(satTable === "pros")}>PROS</button>
            </div>
            <div className="flex items-center gap-1">
              <span className={lbl}>level</span>
              <button onClick={() => bumpSat(-1)} className={btn(false)}>−</button>
              <span className="w-6 text-center font-mono text-xs tabular-nums">{satLevel}</span>
              <button onClick={() => bumpSat(1)} className={btn(false)}>+</button>
            </div>
          </>
        )}
        {kind === "box" && (
          <div className="flex items-center gap-1">
            <span className={lbl}>window</span>
            <button onClick={() => bumpWin(-1)} className={btn(false)}>−</button>
            <span className="w-6 text-center font-mono text-xs tabular-nums">{winN}</span>
            <button onClick={() => bumpWin(1)} className={btn(false)}>+</button>
          </div>
        )}
        <div className="flex items-center gap-1">
          <span className={lbl}>Fs</span>
          {[125, 250, 1000].map((v) => (
            <button key={v} onClick={() => setFs(v)} className={btn(fs === v)}>{v}</button>
          ))}
        </div>
      </div>

      {/* Coefficients + metrics */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs text-muted">
        <span className="text-foreground">{coeffText}</span>
        <span>{band3Label}</span>
        <span>settling {settlingMs == null ? "—" : `${settlingMs.toFixed(0)} ms`}</span>
        <span>overshoot {overshootPct == null ? "—" : `${overshootPct.toFixed(1)} %`}</span>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div>
          <p className="mb-1 flex items-center justify-between text-xs text-muted">
            <span>impulse response h[n] · x: ms</span>
            <span ref={impRead} className="font-mono tabular-nums text-foreground" />
          </p>
          <div ref={impHost} className="h-64 w-full" />
        </div>
        <div>
          <p className="mb-1 flex items-center justify-between text-xs text-muted">
            <span>frequency response · x: Hz · y: dB</span>
            <span ref={frRead} className="font-mono tabular-nums text-foreground" />
          </p>
          <div ref={frHost} className="h-64 w-full" />
        </div>
      </div>
    </div>
  );
}
