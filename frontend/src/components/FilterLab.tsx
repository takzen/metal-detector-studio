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
//   - DISC-IDX band:       2-stage Q15 biquad, Classic III clone  (biquad_idx, mode_dynamic_idx)
// Impulse response is simulated, the frequency response evaluated by DFT.

const M = 512; // impulse-response length (samples)
const Q29 = 2 ** 29;
const Q15 = 2 ** 15;

// mode_dynamic.c REACT_ALPHA[9] (Q15): the DISC band-pass stage-2 lower-edge alpha for
// REACT 1..9. Since 2026-07 the lower edge is set by this alpha table (ema_a) instead of
// an integer shift — half-octave steps (×~1.41), where the odd positions == the old
// shifts 10..6. react 3 (α=64 = 1/2^9, ~0.31 Hz) is the default.
const REACT_ALPHA = [32, 45, 64, 91, 128, 181, 256, 362, 512];
const REACT_DEFAULT = 3; // react 3 = α 64 = shift9

// DIDX (mode_dynamic_idx.c) — the "fast / pro" channel. The Classic III biquad cascade was
// REJECTED in firmware; DIDX now = input LPF Butterworth 35 Hz (Q29) → band-pass
// 2·(EMA αHi − EMA αLo) with BOTH edges set from REACT tables, then half-wave rectified.
// REACT 1..9 slides the band centre 5..12.5 Hz (XP-like); band = f0/2 .. 2·f0.
const BPX_LPF = { b0: 5600859, b1: 11201719, b2: 5600859, a1: -907846767, a2: 393379292 };
const DIDX_ALPHA_HI = [1996, 2229, 2489, 2778, 3099, 3454, 3848, 4283, 4763]; // upper edge, react 1..9
const DIDX_ALPHA_LO = [511, 572, 641, 718, 804, 900, 1008, 1128, 1262]; // lower edge, react 1..9

// Real DISC low-pass biquad coefficients (Q29) from mode_dynamic.c BP_LPF[]
// (Butterworth 2nd-order, lowered 14 Hz → 10 Hz).
const DISC_BIQUAD = { b0: 507178, b1: 1014355, b2: 507178, a1: -1026066113, a2: 491223911 };

// One Q15 biquad stage (Direct Form I): y = b0·x + b1·x1 + b2·x2 − a1·y1 − a2·y2.
type BiqStage = { b0: number; b1: number; b2: number; a1: number; a2: number };

// DISC-IDX test-channel filter (biquad_idx.c): 2-stage Q15 biquad cascade — a
// digital clone of White's Classic III analog motion filter. Peak 7.2 Hz, +42.7 dB.
const IDX_S1: BiqStage = { b0: 25992, b1: -15656, b2: -10320, a1: -62623, a2: 29920 };
const IDX_S2: BiqStage = { b0: -15150, b1: 0, b2: 15150, a1: -62629, a2: 29926 };

// filters_sandbox/*.c — hand-designed Q15 biquad cascades (preview only; the .ipynb
// notebooks are where they are actually synthesised). Transcribed 1:1 from the C.
const SBX_CLASSIC3_2: BiqStage[] = [IDX_S1, IDX_S2]; // biquad_1_2stage.c (= DIDX)
const SBX_CLASSIC3_3: BiqStage[] = [IDX_S1, IDX_S2, IDX_S2]; // biquad_1_3stage.c (3rd = 2nd)
const SBX_NEILA_7HZ_G60: BiqStage[] = [ // biquad_3_neila_7hz_gain60.c — +60 dB @ 7 Hz
  { b0: 4086, b1: 0, b2: -4086, a1: -64665, a2: 31955 },
  { b0: 4759, b1: 0, b2: -4759, a1: -64928, a2: 32257 },
  { b0: 3767, b1: 0, b2: -3767, a1: -65195, a2: 32462 },
];
const SBX_NEILA_7HZ_0DB: BiqStage[] = [ // biquad_3_nelia_7hz.c — ~0 dB net @ 7 Hz
  { b0: 409, b1: 0, b2: -409, a1: -64665, a2: 31955 },
  { b0: 476, b1: 0, b2: -476, a1: -64928, a2: 32257 },
  { b0: 377, b1: 0, b2: -377, a1: -65195, a2: 32462 },
];

// Real SAT alpha tables (Q15), levels 1..20.
const PROS_SAT_ALPHA = [
  13, 16, 21, 27, 34, 44, 56, 72, 92, 118, 151, 193, 247, 316, 404, 517, 661, 846, 950, 999,
]; // mode_pros.c (VSAT — faster geometric scale)
const DEEP_SAT_ALPHA = [
  3, 4, 5, 7, 9, 12, 15, 20, 26, 34, 45, 59, 77, 101, 133, 174, 228, 298, 391, 512,
]; // mode_static.c (DEEP SAT high-pass tracker)

type Kind = "ema" | "lp2" | "bp" | "bpa" | "biquad" | "biqN" | "sat" | "box" | "discband" | "didxband";

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

// Generic cascade of N Q15 biquad stages (biquad_idx.c / filters_sandbox). Coeffs
// are raw Q15 ints, normalised by 2^15. Direct-Form-I, same convention as
// biquadImpulse. Feeding [oneStage] gives that stage alone; the full list = cascade.
function biqNImpulse(stages: BiqStage[]): number[] {
  const cs = stages.map((s) => ({
    b0: s.b0 / Q15, b1: s.b1 / Q15, b2: s.b2 / Q15, a1: s.a1 / Q15, a2: s.a2 / Q15,
    x1: 0, x2: 0, y1: 0, y2: 0,
  }));
  const h = new Array<number>(M);
  for (let n = 0; n < M; n++) {
    let v = n === 0 ? 1 : 0;
    for (const c of cs) {
      const y = c.b0 * v + c.b1 * c.x1 + c.b2 * c.x2 - c.a1 * c.y1 - c.a2 * c.y2;
      c.x2 = c.x1; c.x1 = v; c.y2 = c.y1; c.y1 = y;
      v = y;
    }
    h[n] = v;
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

// Effective DISC "motion band": input biquad LPF 10 Hz cascaded with the MXT
// band-pass pair 2·(EMA shift4 − EMA shift9) DISC runs on the ground-combined
// signal (mode_dynamic.c DYN_BP_SHIFT1/2). LINEAR approximation — the real DISC
// path half-wave rectifies the band-pass output (one hump per target), so this
// shows the passband shape, not the exact non-linear motion response.
function discBandImpulse(aLo: number): number[] {
  const { b0, b1, b2, a1, a2 } = DISC_BIQUAD;
  const nb0 = b0 / Q29, nb1 = b1 / Q29, nb2 = b2 / Q29, na1 = a1 / Q29, na2 = a2 / Q29;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0; // input LPF biquad (10 Hz)
  let s1 = 0, s2 = 0; // band-pass EMA pair
  const aUp = 1 / 2 ** 4; // DYN_BP_SHIFT1 — upper edge ~10 Hz (aLo = REACT alpha, lower edge)
  const h = new Array<number>(M);
  for (let n = 0; n < M; n++) {
    const x = n === 0 ? 1 : 0;
    const yb = nb0 * x + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2; // LPF 10 Hz
    x2 = x1; x1 = x; y2 = y1; y1 = yb;
    s1 += aUp * (yb - s1); // band-pass pair on the LPF output
    h[n] = 2 * (s1 - s2);
    s2 += aLo * (s1 - s2);
  }
  return h;
}

// DIDX effective motion band (mode_dynamic_idx.c): input LPF Butterworth 35 Hz (BPX_LPF)
// cascaded with the band-pass pair 2·(EMA aHi − EMA aLo), BOTH edges from the REACT tables
// (DIDX_ALPHA_HI/LO). LINEAR approximation — the real path half-wave rectifies the output.
function didxBandImpulse(aHi: number, aLo: number): number[] {
  const { b0, b1, b2, a1, a2 } = BPX_LPF;
  const nb0 = b0 / Q29, nb1 = b1 / Q29, nb2 = b2 / Q29, na1 = a1 / Q29, na2 = a2 / Q29;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0; // input LPF biquad (35 Hz)
  let s1 = 0, s2 = 0; // band-pass EMA pair (aHi = upper edge, aLo = lower edge)
  const h = new Array<number>(M);
  for (let n = 0; n < M; n++) {
    const x = n === 0 ? 1 : 0;
    const yb = nb0 * x + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2; // LPF 35 Hz
    x2 = x1; x1 = x; y2 = y1; y1 = yb;
    s1 += aHi * (yb - s1);
    h[n] = 2 * (s1 - s2);
    s2 += aLo * (s1 - s2);
  }
  return h;
}

// Exact frequency response of a Q15 biquad cascade, evaluated from the transfer
// function H(e^jw) = Π (b0+b1e^-jw+b2e^-2jw)/(1+a1e^-jw+a2e^-2jw). Analytic (no
// impulse-response truncation), so high-Q resonators (e.g. the +60 dB build) stay
// ripple-free. Magnitude normalised to its peak, same shape as freqResponseDb.
function biqNFreqDb(stages: BiqStage[], fs: number, nf = 1024): { f: number[]; db: number[] } {
  const f = new Array<number>(nf);
  const db = new Array<number>(nf);
  for (let k = 0; k < nf; k++) {
    const freq = (k / (nf - 1)) * (fs / 2);
    f[k] = freq;
    const w = (2 * Math.PI * freq) / fs;
    const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    let re = 1, im = 0; // running product of per-stage responses
    for (const st of stages) {
      const b0 = st.b0 / Q15, b1 = st.b1 / Q15, b2 = st.b2 / Q15, a1 = st.a1 / Q15, a2 = st.a2 / Q15;
      const numRe = b0 + b1 * c1 + b2 * c2, numIm = -(b1 * s1 + b2 * s2);
      const denRe = 1 + a1 * c1 + a2 * c2, denIm = -(a1 * s1 + a2 * s2);
      const denMag = denRe * denRe + denIm * denIm;
      const hRe = (numRe * denRe + numIm * denIm) / denMag;
      const hIm = (numIm * denRe - numRe * denIm) / denMag;
      const pRe = re * hRe - im * hIm;
      im = re * hIm + im * hRe;
      re = pRe;
    }
    db[k] = 20 * Math.log10(Math.hypot(re, im) + 1e-9); // absolute gain (not peak-normalised)
  }
  return { f, db };
}

function freqResponseDb(h: number[], fs: number, nf = 256): { f: number[]; db: number[] } {
  const f = new Array<number>(nf);
  const db = new Array<number>(nf);
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
    db[k] = 20 * Math.log10(Math.hypot(re, im) + 1e-9); // absolute gain (not peak-normalised)
  }
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
  react?: number; // for kind "bpa" / "discband": DISC REACT 1..9 → REACT_ALPHA stage-2
  stages?: BiqStage[]; // for kind "biqN": the cascade's Q15 biquad stages
  hp?: boolean; // firmware applies this tracker as `signal − EMA` = high-pass
  note: string;
};

// Real, instantiated firmware filters of THIS project (taktyk-dsp), pulled from
// ema_init / ema_a_init / biquad_set in src/modes/*. See docs/FILTRY-DSP.md.
const TAKTYK_PRESETS: Preset[] = [
  { id: "deeplp", label: "DEEP/PIN/PROS LP", kind: "lp2", shift1: 5, note: "DEEP/PROS/PIN: 2-pole EMA cascade, shift 5 — anti-noise low-pass ~3.2 Hz" },
  { id: "disc", label: "DISC LP", kind: "biquad", note: "DISC: 2nd-order Butterworth biquad (Q29 BP_LPF), −3 dB ≈ 10 Hz (lowered from 14 Hz — anti-noise + 50 Hz reject)" },
  { id: "discband", label: "DISC motion band", kind: "discband", react: REACT_DEFAULT, note: "DISC effective motion band: biquad LP 10 Hz → band-pass 2·(EMA shift4 − EMA α_react). Linear approx — real path half-wave rectifies the band-pass output. Lower edge follows REACT (default react 3 ≈ 0.31 Hz)." },
  { id: "discbp", label: "DISC band-pass", kind: "bpa", shift1: 4, react: REACT_DEFAULT, note: "DISC motion band-pass pair 2·(EMA s1 − EMA s2): s1 shift4 (~10 Hz upper edge), s2 = REACT alpha (Q15). Since 2026-07 REACT is 1..9 (half-octave, ema_a) — react 3 = α64 ≈ 0.31 Hz (default), react 9 = α512 ≈ 2.5 Hz (separation); odd positions == old shifts 10..6. Real poles → does not ring." },
  { id: "discbase", label: "DISC baseline", kind: "ema", shift1: 11, note: "DISC ground baseline EMA shift11 (~0.08 Hz). Firmware applies it as l − EMA = high-pass → use the 'response: high-pass' toggle." },
  { id: "psstat", label: "PSEUDO LP", kind: "ema", shift1: 8, note: "PSEUDOSTATIC signal LP: 1-pole EMA shift8 (~0.62 Hz, ~128 ms). Its AUTO ground tracker is EMA shift11 (~1 s), applied as high-pass — same as DISC baseline." },
  { id: "didx", label: "DISC-IDX (DIDX)", kind: "didxband", react: REACT_DEFAULT, note: "DISC-IDX (DIDX) fast/pro channel: input LPF 35 Hz → band-pass 2·(EMA αHi − EMA αLo), BOTH edges from REACT tables (DIDX_ALPHA_HI/LO). REACT 1..9 slides the band centre 5..12.5 Hz (XP-like, ×1.12/step); band = f0/2..2·f0. Half-wave rectified (linear approx here). Replaced the REJECTED Classic III biquad cascade — see sandbox for that." },
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

// filters_sandbox/*.c — experimental cascades, PREVIEW ONLY (not wired into firmware).
const SANDBOX_PRESETS: Preset[] = [
  { id: "sbx2", label: "Classic III ×2", kind: "biqN", stages: SBX_CLASSIC3_2, note: "biquad_1_2stage.c — 2-stage Classic III motion clone, peak 7.2 Hz, +42.7 dB. Was the DIDX candidate; REJECTED in firmware (rings / group delay put the beep behind the coil) → DIDX now uses the REACT EMA band-pass." },
  { id: "sbx3", label: "Classic III ×3", kind: "biqN", stages: SBX_CLASSIC3_3, note: "biquad_1_3stage.c — 3-stage version (3rd stage = 2nd): steeper skirts, higher gain/Q than the ×2." },
  { id: "sbxg60", label: "Neila 7 Hz +60 dB", kind: "biqN", stages: SBX_NEILA_7HZ_G60, note: "biquad_3_neila_7hz_gain60.c — 3× resonant biquad centred 7 Hz, ≈+60 dB. Per-stage poles 0.975/0.984/0.991 (very high Q)." },
  { id: "sbx0", label: "Neila 7 Hz 0 dB", kind: "biqN", stages: SBX_NEILA_7HZ_0DB, note: "biquad_3_nelia_7hz.c — same 3-pole 7 Hz design scaled to ≈0 dB net gain (numerators /10 vs the +60 dB build)." },
];

type ProjectId = "taktyk" | "mxt" | "sandbox";
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
  {
    id: "sandbox",
    label: "sandbox",
    presets: SANDBOX_PRESETS,
    desc: "filters_sandbox/*.c — hand-designed Q15 biquad cascades, PREVIEW ONLY (not wired into firmware; the .ipynb notebooks synthesise them). Use the stage toggle to inspect each biquad and the full cascade.",
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
  const [react, setReact] = useState(REACT_DEFAULT); // DISC band-pass REACT 1..9 (stage-2 alpha)
  const [resp, setResp] = useState<"lp" | "hp">("lp"); // show EMA as low-pass or its high-pass complement
  const [stage, setStage] = useState<number>(0); // cascade filters: 0 = full cascade, k = stage k alone
  const [stages, setStages] = useState<BiqStage[]>(SBX_CLASSIC3_2); // active biqN cascade
  const [fs, setFs] = useState(1000);
  const [tZoom, setTZoom] = useState(1); // x-axis zoom (fraction of full range) — time-domain charts
  const [fZoom, setFZoom] = useState(1); // x-axis zoom — frequency chart
  const [yMag, setYMag] = useState(1); // response chart: vertical magnification (1 = auto-fit)
  const [fDbSpan, setFDbSpan] = useState(90); // frequency chart: visible dB window height

  const projectMeta = PROJECTS.find((p) => p.id === project)!;
  const presets = projectMeta.presets;

  const applyPreset = (p: Preset) => {
    setKind(p.kind);
    if (p.shift1 != null) setShift1(p.shift1);
    if (p.shift2 != null) setShift2(p.shift2);
    if (p.sat != null) setSatLevel(p.sat);
    if (p.satTable != null) setSatTable(p.satTable);
    if (p.win != null) setWinN(p.win);
    if (p.react != null) setReact(p.react);
    if (p.stages != null) setStages(p.stages);
    setResp(p.hp ? "hp" : "lp");
    setStage(0); // start each preset at the full cascade
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
  const bumpReact = (d: number) => setReact((r) => Math.min(9, Math.max(1, r + d)));
  const onResp = (r: "lp" | "hp") => setResp(r);

  const { impInData, impData, frData, band3Label, settlingMs, overshootPct, coeffText } = useMemo(() => {
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
      h = stage === 1 ? emaImpulse(a1) : lp2Impulse(a1);
      coeff = `${stage === 1 ? "stage 1 — 1× EMA" : "cascade — 2× EMA"}, α = 1/2^${shift1} = ${a1.toFixed(4)}`;
    } else if (kind === "bp" || kind === "bpa") {
      // MXT band-pass (bp): stage2 = integer shift2. DISC band-pass (bpa): stage2 = REACT
      // alpha from the Q15 table (ema_a, mode_dynamic.c) — the 2026-07 migration.
      const aLow = kind === "bpa" ? REACT_ALPHA[react - 1] / Q15 : a2;
      h = stage === 1 ? emaImpulse(a1) : bpImpulse(a1, aLow);
      const lowerHz = (aLow * fs) / (2 * Math.PI);
      coeff =
        stage === 1
          ? `stage 1 — EMA s1, α1 = 1/2^${shift1} = ${a1.toFixed(4)}`
          : kind === "bpa"
            ? `cascade — BP 2·(s1−s2), α1 = 1/2^${shift1}, react ${react} → α2 = ${REACT_ALPHA[react - 1]}/32768 (~${lowerHz.toFixed(2)} Hz)`
            : `cascade — BP 2·(s1−s2), α1 = 1/2^${shift1}, α2 = 1/2^${shift2}`;
    } else if (kind === "sat") {
      h = emaImpulse(satAlpha);
      coeff = `${satTable === "deep" ? "DEEP SAT" : "PROS VSAT"} ${satLevel}: α = ${satRaw}/32768 = ${satAlpha.toFixed(4)}`;
    } else if (kind === "box") {
      h = boxImpulse(winN);
      coeff = `${winN}-tap moving average (boxcar), 1/${winN} each — MXT SAT env window (real = max-of-${winN})`;
    } else if (kind === "discband") {
      const aLo = REACT_ALPHA[react - 1] / Q15;
      h = discBandImpulse(aLo);
      coeff = `DISC motion band: biquad LP 10 Hz → BP 2·(EMA s4 − EMA α_react ${REACT_ALPHA[react - 1]}/32768) — linear, ignores half-wave |.|`;
    } else if (kind === "didxband") {
      const aHi = DIDX_ALPHA_HI[react - 1] / Q15;
      const aLo = DIDX_ALPHA_LO[react - 1] / Q15;
      h = didxBandImpulse(aHi, aLo);
      const edge = (al: number) => (-1000 / (2 * Math.PI)) * Math.log(1 - al); // α/Q15 → f_c Hz
      coeff = `DIDX react ${react}: LPF 35 Hz → BP EMA(αHi ${DIDX_ALPHA_HI[react - 1]}) − EMA(αLo ${DIDX_ALPHA_LO[react - 1]}) ≈ ${edge(aLo).toFixed(1)}–${edge(aHi).toFixed(1)} Hz — linear, ignores half-wave |.|`;
    } else if (kind === "biqN") {
      const single = stage >= 1 && stage <= stages.length;
      h = biqNImpulse(single ? [stages[stage - 1]] : stages);
      const fmt = (s: BiqStage) => `[${s.b0},${s.b1},${s.b2}|${s.a1},${s.a2}]`;
      coeff = single
        ? `stage ${stage}/${stages.length} (Q15): ${fmt(stages[stage - 1])}`
        : `cascade ${stages.length}× (Q15): ${stages.map(fmt).join(" → ")}`;
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
    // biqN: exact analytic response (no truncation); others: DFT of the impulse.
    const frSel = kind === "biqN" ? (stage >= 1 && stage <= stages.length ? [stages[stage - 1]] : stages) : null;
    const fr = frSel ? biqNFreqDb(frSel, fs, 1024) : freqResponseDb(h, fs, 1024); // denser grid so x-zoom stays smooth
    const { settlingMs, overshootPct } = stepMetrics(h, fs);

    // Stimulus = finite, positive, triangular pulse (a target sweep), plus the
    // filter's LTI response to it = convolution(triangle, h). Replaces the trivial
    // δ input: shows a real input waveform and the shaped output it produces.
    const TW = 96; // triangle width (samples)
    const half = TW / 2;
    const xin = xs.map((_, n) => (n >= TW ? 0 : n <= half ? n / half : (TW - n) / half));
    const yout = new Array<number>(M).fill(0);
    for (let k = 0; k < M; k++) {
      let acc = 0;
      const jmax = Math.min(k, TW - 1);
      for (let j = 0; j <= jmax; j++) acc += xin[j] * h[k - j];
      yout[k] = acc;
    }

    // Name the −3 dB band by shape: low-pass → upper cutoff; high-pass → lower
    // cutoff; band-pass → both edges. Threshold is −3 dB BELOW the peak (response is
    // absolute dB now, so a +42 dB resonator's band is peak−3, not the 0 dB line).
    const peakDb = fr.db.reduce((m, v) => (v > m ? v : m), -Infinity);
    const thr3 = peakDb - 3;
    const b3 = band(fr, thr3);
    const dcPass = fr.db[0] >= thr3;
    const nyqPass = fr.db[fr.db.length - 1] >= thr3;
    let band3Label: string;
    if (dcPass && !nyqPass) band3Label = `−3 dB @ ${b3[1].toFixed(1)} Hz`;
    else if (!dcPass && nyqPass) band3Label = `−3 dB @ ${b3[0].toFixed(1)} Hz (HP)`;
    else if (!dcPass && !nyqPass) band3Label = `−3 dB ${b3[0].toFixed(1)}–${b3[1].toFixed(1)} Hz`;
    else band3Label = `−3 dB 0–${fr.f[fr.f.length - 1].toFixed(0)} Hz`;

    return {
      impInData: [xs, xin] as unknown as uPlot.AlignedData,
      impData: [xs, yout] as unknown as uPlot.AlignedData,
      frData: [fr.f, fr.db] as unknown as uPlot.AlignedData,
      band3Label,
      settlingMs,
      overshootPct,
      coeffText: coeff,
    };
  }, [kind, shift1, shift2, satLevel, satTable, winN, react, resp, stage, stages, fs]);

  const impInHost = useRef<HTMLDivElement | null>(null);
  const impHost = useRef<HTMLDivElement | null>(null);
  const frHost = useRef<HTMLDivElement | null>(null);
  const impInRead = useRef<HTMLSpanElement | null>(null);
  const impRead = useRef<HTMLSpanElement | null>(null);
  const frRead = useRef<HTMLSpanElement | null>(null);
  const uImpIn = useRef<uPlot | null>(null);
  const uImp = useRef<uPlot | null>(null);
  const uFr = useRef<uPlot | null>(null);
  const fsRef = useRef(fs);
  const tZoomRef = useRef(tZoom);
  const fZoomRef = useRef(fZoom);
  const yMagRef = useRef(yMag);
  const fDbSpanRef = useRef(fDbSpan);
  const dataRef = useRef({ impInData, impData, frData });
  useEffect(() => {
    fsRef.current = fs;
    tZoomRef.current = tZoom;
    fZoomRef.current = fZoom;
    yMagRef.current = yMag;
    fDbSpanRef.current = fDbSpan;
    dataRef.current = { impInData, impData, frData };
  });

  useEffect(() => {
    const iih = impInHost.current;
    const ih = impHost.current;
    const fh = frHost.current;
    if (!iih || !ih || !fh) return;

    if (!uImpIn.current) {
      uImpIn.current = makePlot(
        iih,
        [{ label: "x[n]", stroke: "#f59e0b", width: 1, points: { show: false } }],
        () => [0, (M / fsRef.current) * 1000 * tZoomRef.current],
        [-0.1, 1.1],
        (u) => {
          const i = u.cursor.idx;
          if (!impInRead.current) return;
          if (i == null) { impInRead.current.textContent = ""; return; }
          const x = (u.data[0] as number[])[i];
          const y = (u.data[1] as number[])[i];
          impInRead.current.textContent = `${x.toFixed(1)} ms · ${y.toFixed(2)}`;
        },
      );
      uImpIn.current.setData(dataRef.current.impInData);
    }
    if (!uImp.current) {
      uImp.current = makePlot(
        ih,
        [{ label: "h[n]", stroke: "#10b981", width: 1, points: { show: false } }],
        () => [0, (M / fsRef.current) * 1000 * tZoomRef.current],
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
          // Auto-fit [lo-p, hi+p], then apply vertical magnification around centre.
          const a = lo - p, b = hi + p;
          const c = (a + b) / 2, half = (b - a) / 2 / yMagRef.current;
          return [c - half, c + half];
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
        () => [0, (fsRef.current / 2) * fZoomRef.current],
        () => {
          // Absolute dB: anchor the window to the peak gain so filters with gain
          // (+42 dB DIDX, +60 dB Neila) show their real level; 80 dB span below.
          const d = dataRef.current.frData[1] as number[];
          let mx = -Infinity;
          for (let i = 0; i < d.length; i++) if (d[i] > mx) mx = d[i];
          if (!isFinite(mx)) mx = 0;
          const top = Math.max(3, mx + 3); // peak pinned near the top, always visible
          return [top - fDbSpanRef.current, top];
        },
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
        [iih, uImpIn.current],
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
    ro.observe(iih);
    ro.observe(ih);
    ro.observe(fh);
    return () => {
      ro.disconnect();
      uImpIn.current?.destroy();
      uImp.current?.destroy();
      uFr.current?.destroy();
      uImpIn.current = null;
      uImp.current = null;
      uFr.current = null;
    };
  }, []);

  useEffect(() => {
    uImpIn.current?.setData(impInData);
    uImp.current?.setData(impData);
    uFr.current?.setData(frData);
  }, [impInData, impData, frData, yMag, fDbSpan]);

  // X-axis zoom: time-domain charts share one window, frequency has its own.
  useEffect(() => {
    const tMax = (M / fs) * 1000 * tZoom;
    uImpIn.current?.setScale("x", { min: 0, max: tMax });
    uImp.current?.setScale("x", { min: 0, max: tMax });
  }, [tZoom, fs]);
  useEffect(() => {
    uFr.current?.setScale("x", { min: 0, max: (fs / 2) * fZoom });
  }, [fZoom, fs]);

  const btn = (active: boolean) =>
    `rounded border px-2 py-0.5 text-xs transition-colors ${
      active ? "border-accent text-foreground" : "border-border text-muted hover:text-foreground"
    }`;
  const lbl = "text-[10px] font-semibold uppercase tracking-wider text-muted";

  const showShift = kind === "ema" || kind === "lp2" || kind === "bp" || kind === "bpa";
  // Stage toggle: biqN has one button per biquad; lp2/bp/bpa expose only stage 1 vs cascade.
  const stageCount =
    kind === "biqN" ? stages.length : kind === "lp2" || kind === "bp" || kind === "bpa" ? 1 : 0;

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
          {(["ema", "lp2", "bp", "bpa", "biquad", "biqN", "sat", "box", "discband", "didxband"] as Kind[]).map((k) => (
            <button key={k} onClick={() => onKind(k)} className={btn(kind === k)}>
              {k === "lp2" ? "2-pole EMA" : k === "bp" ? "band-pass" : k === "bpa" ? "band-pass α" : k === "biquad" ? "biquad" : k === "biqN" ? "biquad×N" : k === "box" ? "moving-avg" : k === "discband" ? "DISC-band" : k === "didxband" ? "DIDX-band" : k.toUpperCase()}
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
        {stageCount >= 1 && (
          <div className="flex items-center gap-1">
            <span className={lbl}>stage</span>
            <button onClick={() => setStage(0)} className={btn(stage === 0)}>cascade</button>
            {Array.from({ length: stageCount }, (_, i) => i + 1).map((k) => (
              <button key={k} onClick={() => setStage(k)} className={btn(stage === k)}>{k}</button>
            ))}
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
        {(kind === "bpa" || kind === "discband" || kind === "didxband") && (
          <div className="flex items-center gap-1">
            <span className={lbl} title="DISC/DIDX REACT 1..9 → band-pass edge alpha(s)">react</span>
            <button onClick={() => bumpReact(-1)} className={btn(false)}>−</button>
            <span className="w-6 text-center font-mono text-xs tabular-nums">{react}</span>
            <button onClick={() => bumpReact(1)} className={btn(false)}>+</button>
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

      <div className="grid gap-3 lg:grid-cols-3">
        <div>
          <p className="mb-1 flex items-center justify-between text-xs text-muted">
            <span>input: triangle pulse x[n] · x: ms</span>
            <span ref={impInRead} className="font-mono tabular-nums text-foreground" />
          </p>
          <div ref={impInHost} className="h-64 w-full" />
        </div>
        <div>
          <p className="mb-1 flex items-center justify-between text-xs text-muted">
            <span>response y[n] = filter(x) · x: ms</span>
            <span ref={impRead} className="font-mono tabular-nums text-foreground" />
          </p>
          <div ref={impHost} className="h-64 w-full" />
          <div className="mt-1 flex items-center gap-2 text-[10px] text-muted">
            <span className="uppercase tracking-wider">x-zoom</span>
            <input
              type="range" min={2} max={100} step={1} value={Math.round(tZoom * 100)}
              onChange={(e) => setTZoom(Number(e.target.value) / 100)}
              className="flex-1 accent-[#10b981]"
            />
            <span className="w-20 text-right font-mono tabular-nums text-foreground">0–{((M / fs) * 1000 * tZoom).toFixed(0)} ms</span>
          </div>
          <div className="mt-1 flex items-center gap-2 text-[10px] text-muted">
            <span className="uppercase tracking-wider">y-zoom</span>
            <input
              type="range" min={0.2} max={6} step={0.1} value={yMag}
              onChange={(e) => setYMag(Number(e.target.value))}
              className="flex-1 accent-[#10b981]"
            />
            <span className="w-20 text-right font-mono tabular-nums text-foreground">×{yMag.toFixed(1)}</span>
          </div>
        </div>
        <div>
          <p className="mb-1 flex items-center justify-between text-xs text-muted">
            <span>frequency response · x: Hz · y: dB</span>
            <span ref={frRead} className="font-mono tabular-nums text-foreground" />
          </p>
          <div ref={frHost} className="h-64 w-full" />
          <div className="mt-1 flex items-center gap-2 text-[10px] text-muted">
            <span className="uppercase tracking-wider">x-zoom</span>
            <input
              type="range" min={2} max={100} step={1} value={Math.round(fZoom * 100)}
              onChange={(e) => setFZoom(Number(e.target.value) / 100)}
              className="flex-1 accent-[#3b82f6]"
            />
            <span className="w-20 text-right font-mono tabular-nums text-foreground">0–{((fs / 2) * fZoom).toFixed(0)} Hz</span>
          </div>
          <div className="mt-1 flex items-center gap-2 text-[10px] text-muted">
            <span className="uppercase tracking-wider">y-span</span>
            <input
              type="range" min={20} max={140} step={5} value={fDbSpan}
              onChange={(e) => setFDbSpan(Number(e.target.value))}
              className="flex-1 accent-[#3b82f6]"
            />
            <span className="w-20 text-right font-mono tabular-nums text-foreground">{fDbSpan} dB</span>
          </div>
        </div>
      </div>
    </div>
  );
}
