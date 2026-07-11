"use client";

// TX bench: enter the real coil (inductance + DC resistance) and supply, see the full
// H-bridge we drive it with, and the resulting coil current. Pure client sandbox (no
// telemetry) — a design/verification aid for the Spectral transmitter.
//
// Model: the bridge always switches the coil across ±Vbus. Single tone = plain square
// wave (triangular current). Multi-tone = a 1-bit pattern, sign of the summed target
// tones (SHE-like) — harmonic content comes from the switching pattern, not from
// dividing the bus between tones. The steady-state current is solved per harmonic
// through the series R–L(–C), so peak / pk-pk / RMS come from the actual waveform.

import { useMemo } from "react";
import { InfoPopover, CODE_CLS } from "@/components/InfoPopover";
import { usePersistentState } from "@/lib/usePersistentState";

type Harm = { id: string; freq_hz: number };

// Spectral-G4 SHE-PWM tones (7.8125 / 23.4375 / 39.0625 kHz) as the default set.
const DEFAULT_FREQS = [7812.5, 23437.5, 39062.5];

const TWO_PI = 2 * Math.PI;

const fmtOhm = (x: number) =>
  !isFinite(x) ? "—" : x >= 1000 ? `${(x / 1000).toFixed(2)} kΩ` : x >= 100 ? `${x.toFixed(0)} Ω` : `${x.toFixed(1)} Ω`;
const fmtA = (a: number) =>
  !isFinite(a) ? "—" : a >= 1 ? `${a.toFixed(2)} A` : `${(a * 1000).toFixed(0)} mA`;
const fmtNum = (x: number, d = 1) => (isFinite(x) ? x.toFixed(d) : "—");

function Field({
  label,
  value,
  onChange,
  unit,
  step = 1,
  min = 0,
  w = "w-20",
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  unit: string;
  step?: number;
  min?: number;
  w?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</span>
      <span className="flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1">
        <input
          type="number"
          value={value}
          min={min}
          step={step}
          onChange={(e) => onChange(Number(e.target.value))}
          className={`${w} bg-transparent font-mono text-sm tabular-nums text-foreground outline-none`}
        />
        <span className="shrink-0 text-xs text-muted">{unit}</span>
      </span>
    </label>
  );
}

/** One MOSFET symbol drawn inline (gate lead enters at local (0,45); the drain–source
 *  bus runs at local x = 48). `mirror` flips it for the right bridge leg. */
function Fet({ x, y, kind, mirror }: { x: number; y: number; kind: "P" | "N"; mirror?: boolean }) {
  // Source-lead arrow (simplified 3-terminal style, BJT-like): N — bottom stub (GND side)
  // pointing OUT toward the terminal; P — top stub (rail side) pointing IN toward the
  // channel. Drains meet at the coil node.
  const arrow = kind === "N" ? "M34,54 L34,62 L42,58 Z" : "M38,28 L38,36 L30,32 Z";
  return (
    <g transform={`translate(${x},${y})${mirror ? " scale(-1,1)" : ""}`}>
      {/* gate lead · gate plate · channel plate · drain stub up · source stub down */}
      <path className="ink" d="M0,45 H16 M16,26 V64 M24,24 V66 M24,32 H48 V6 M24,58 H48 V84" />
      <path className="fll" d={arrow} />
    </g>
  );
}

/** The full complementary H-bridge driving the coil; coil highlighted (accent) with its
 *  computed pk-pk current. */
function BridgeSvg({ vbus, iLabel }: { vbus: number; iLabel: string }) {
  return (
    <div className="coil-schem w-full">
      <style>{`
        .coil-schem svg{display:block;width:100%;height:auto}
        .coil-schem .ink{stroke:var(--muted);stroke-width:1.7;fill:none;stroke-linecap:round;stroke-linejoin:round}
        .coil-schem .acc{stroke:var(--accent);stroke-width:2.6;fill:none;stroke-linecap:round;stroke-linejoin:round}
        .coil-schem .fll{fill:var(--muted);stroke:none}
        .coil-schem .dot{fill:var(--muted);stroke:none}
        .coil-schem .dota{fill:var(--accent);stroke:none}
        .coil-schem .box{fill:var(--panel);stroke:var(--muted);stroke-width:1.7}
        .coil-schem text{font-family:var(--font-mono),ui-monospace,monospace;fill:var(--foreground);font-size:13px}
        .coil-schem .lbl{fill:var(--muted);font-size:12px}
        .coil-schem .ref{fill:var(--foreground);font-size:13px;font-weight:700}
        .coil-schem .rail{fill:var(--muted);font-size:11.5px}
        .coil-schem .cur{fill:var(--accent);font-size:15px;font-weight:700}
      `}</style>
      <svg viewBox="0 0 1010 620" role="img" aria-label="Full H-bridge driving the TX coil">
        {/* +V rail (starts at the driver's VDD drop so the two actually join) */}
        <path className="ink" d="M255,120 H830" />
        <path className="ink" d="M255,120 v-7 M251,113 h8" />
        <text className="rail" x="262" y="108">{`+${vbus}V`}</text>

        {/* bottom return rail */}
        <path className="ink" d="M460,480 H822 M641,480 V512" />

        {/* gate driver */}
        <rect className="box" x="190" y="232" width="120" height="150" rx="3" />
        <text className="ref" x="196" y="224">DRV</text>
        <text className="lbl" x="250" y="312" textAnchor="middle">UCC27524A</text>
        <text className="lbl" x="205" y="262">IN_A</text>
        <text className="lbl" x="205" y="352">IN_B</text>
        <text className="lbl" x="268" y="262" textAnchor="end">OUT_A</text>
        <text className="lbl" x="268" y="352" textAnchor="end">OUT_B</text>
        <text className="lbl" x="252" y="250">VDD</text>
        <text className="lbl" x="252" y="374">GND</text>

        <path className="ink" d="M190,258 H70" />
        <path className="ink" d="M190,348 H70" />
        <text className="lbl" x="30" y="255">TX_PWM_A</text>
        <text className="lbl" x="30" y="345">TX_PWM_B</text>

        {/* VDD to rail, GND to ground */}
        <path className="ink" d="M255,232 V120" />
        <circle className="dot" cx="255" cy="120" r="3" />
        <path className="ink" d="M255,382 V520 M243,520 h24 M247,525 h16 M251,530 h8" />
        <text className="rail" x="266" y="527">GND</text>

        {/* OUT_A -> Rg1 -> left gate */}
        <path className="ink" d="M310,258 H330" />
        <rect className="box" x="330" y="250" width="36" height="16" rx="2" />
        <path className="ink" d="M366,258 H412" />
        <text className="lbl" x="330" y="242">Rg1 4R7</text>
        <path className="ink" d="M412,165 V345" />
        <circle className="dot" cx="412" cy="258" r="3" />

        {/* OUT_B over the top -> Rg2 -> right gate (plain no-connect crossings) */}
        <path className="ink" d="M310,348 H390 V90 H690" />
        <rect className="box" x="690" y="82" width="36" height="16" rx="2" />
        <path className="ink" d="M726,90 H870 V165" />
        <text className="lbl" x="690" y="76">Rg2 4R7</text>
        <path className="ink" d="M870,165 V345" />

        {/* LEFT LEG: P on top, N below, drains meet at the coil node (x=460) */}
        <Fet x={412} y={120} kind="P" />
        <Fet x={412} y={300} kind="N" />
        <text className="ref" x="470" y="150">Q3</text>
        <text className="lbl" x="466" y="178">P</text>
        <text className="lbl" x="466" y="360">N</text>
        <path className="ink" d="M460,126 V120" />
        <path className="ink" d="M460,204 V306" />
        <path className="ink" d="M460,384 V480" />
        <circle className="dot" cx="460" cy="120" r="3" />
        <circle className="dot" cx="460" cy="480" r="3" />

        {/* RIGHT LEG (mirrored, coil node at x=822) */}
        <Fet x={870} y={120} kind="P" mirror />
        <Fet x={870} y={300} kind="N" mirror />
        <text className="ref" x="812" y="150" textAnchor="end">Q4</text>
        <text className="lbl" x="816" y="178" textAnchor="end">P</text>
        <text className="lbl" x="816" y="360" textAnchor="end">N</text>
        <path className="ink" d="M822,126 V120" />
        <path className="ink" d="M822,204 V306" />
        <path className="ink" d="M822,384 V480" />
        <circle className="dot" cx="822" cy="120" r="3" />
        <circle className="dot" cx="822" cy="480" r="3" />

        {/* COIL — device under test (accent) */}
        <path className="acc" d="M460,255 H560" />
        <path className="acc" d="M560,255 q10,-14 20,0 q10,-14 20,0 q10,-14 20,0 q10,-14 20,0 q10,-14 20,0" />
        <path className="acc" d="M660,255 H822" />
        <circle className="dota" cx="460" cy="255" r="3.5" />
        <circle className="dota" cx="822" cy="255" r="3.5" />
        <text className="ref" x="641" y="232" textAnchor="middle" style={{ fill: "var(--accent)" }}>L_TX</text>
        <text className="cur" x="641" y="300" textAnchor="middle">{iLabel}</text>
        <text className="lbl" x="468" y="247">TX_OUT_1</text>
        <text className="lbl" x="814" y="247" textAnchor="end">TX_OUT_2</text>

        {/* shunt */}
        <rect className="box" x="629" y="512" width="24" height="40" rx="2" />
        <path className="ink" d="M641,552 V568 M629,568 h24 M633,573 h16 M637,578 h8" />
        <text className="ref" x="659" y="528">Rsh</text>
        <text className="lbl" x="659" y="544">0.1R</text>
        <text className="rail" x="659" y="576">I_SENSE</text>
        <circle className="dot" cx="641" cy="480" r="3" />
      </svg>
    </div>
  );
}

export function CoilLab({ harmonics }: { harmonics?: Harm[] }) {
  const [luH, setLuH] = usePersistentState("coilL_uH", 500); // coil inductance [µH]
  const [rdc, setRdc] = usePersistentState("coilRdc", 2); // coil DC resistance [Ω]
  const [vbus, setVbus] = usePersistentState("coilVbus", 12); // bridge supply [V]
  const [seriesCuF, setSeriesCuF] = usePersistentState("coilSeriesC", 0); // series cap in the TX path [µF], 0 = none
  const [nTones, setNTones] = usePersistentState("coilTones", 3); // how many tones are driven (1–3)
  const [measOn, setMeasOn] = usePersistentState("coilMeasOn", false); // overlay measured tone currents
  const [measI, setMeasI] = usePersistentState<number[]>("coilMeasI", [0, 0, 0]); // measured tone amplitudes [mA]
  const [freqsStored, setFreqs] = usePersistentState<number[]>("coilFreqs", DEFAULT_FREQS);
  // Heal whatever got persisted (missing slots, 0, NaN) back to the Spectral defaults,
  // so the harmonic fields are never empty.
  const freqs = useMemo(
    () =>
      DEFAULT_FREQS.map((d, i) => {
        const v = freqsStored?.[i];
        return typeof v === "number" && isFinite(v) && v > 0 ? v : d;
      }),
    [freqsStored],
  );

  const L = luH * 1e-6; // H
  const seriesC = seriesCuF > 0 ? seriesCuF * 1e-6 : null; // F, null = no cap in the path
  const activeFreqs = useMemo(() => freqs.slice(0, nTones), [freqs, nTones]);

  // Steady-state coil current for the switched ±Vbus bridge waveform.
  //
  // The rail waveform v(t) = Vbus · sign(Σ sin(2πfᵢt)) over one period of the lowest
  // tone (tones are treated as harmonics of it — Spectral's 1:3:5 set is). Fourier
  // coefficients of v(t) drive the series R–L(–C) per harmonic (superposition is exact
  // for the periodic steady state); the current waveform is reassembled and measured.
  // For a single tone this reduces to the classic square-drive triangle.
  const sim = useMemo(() => {
    const fBase = Math.min(...activeFreqs);
    if (!isFinite(fBase) || fBase <= 0 || !(L > 0) || !(vbus > 0)) return null;
    const R = Math.max(rdc, 1e-3);
    const N = 1024; // samples per period
    const H = 128; // harmonics of fBase to carry (amplitudes fall ~1/n² into L)

    // 1-bit multitone rail waveform: sign of the summed tones (single tone = plain square)
    const v = new Float64Array(N);
    for (let k = 0; k < N; k++) {
      const t = k / N; // in periods of fBase
      let s = 0;
      for (const f of activeFreqs) s += Math.sin(TWO_PI * (f / fBase) * t);
      v[k] = s >= 0 ? vbus : -vbus;
    }

    // per-harmonic response through Z(ω) = R + j(ωL − 1/ωC)
    const cur = new Float64Array(N);
    const toneAmp = activeFreqs.map(() => 0);
    for (let h = 1; h <= H; h++) {
      let a = 0;
      let b = 0;
      for (let k = 0; k < N; k++) {
        const th = (TWO_PI * h * k) / N;
        a += v[k] * Math.cos(th);
        b += v[k] * Math.sin(th);
      }
      a *= 2 / N;
      b *= 2 / N;
      const vAmp = Math.hypot(a, b);
      if (vAmp < vbus * 1e-4) continue; // harmonic absent from the pattern
      const w = TWO_PI * h * fBase;
      const x = w * L - (seriesC ? 1 / (w * seriesC) : 0);
      const z = Math.hypot(R, x);
      const phZ = Math.atan2(x, R);
      const iAmp = vAmp / z;
      const ph0 = Math.atan2(a, b); // v_h(t) = vAmp · sin(θ + ph0)
      for (let k = 0; k < N; k++) {
        const th = (TWO_PI * h * k) / N;
        cur[k] += iAmp * Math.sin(th + ph0 - phZ);
      }
      activeFreqs.forEach((f, idx) => {
        if (Math.abs(f / fBase - h) < 0.01) toneAmp[idx] = iAmp;
      });
    }

    let mx = -Infinity;
    let mn = Infinity;
    let sq = 0;
    for (let k = 0; k < N; k++) {
      const c = cur[k];
      if (c > mx) mx = c;
      if (c < mn) mn = c;
      sq += c * c;
    }
    return {
      pp: mx - mn,
      peak: Math.max(Math.abs(mx), Math.abs(mn)),
      rms: Math.sqrt(sq / N),
      toneAmp,
    };
  }, [activeFreqs, L, rdc, vbus, seriesC]);

  const idc = vbus / rdc; // resistance-limited DC ceiling
  const pCoil = sim ? sim.rms * sim.rms * rdc : NaN; // true coil heating from waveform RMS
  const fRes = seriesC ? 1 / (TWO_PI * Math.sqrt(L * seriesC)) : null; // series-resonance frequency

  // Per-tone table data (impedance at each tone + its current from the simulated spectrum).
  const rows = activeFreqs.map((f, idx) => {
    const w = TWO_PI * f;
    const xl = w * L;
    const x = xl - (seriesC ? 1 / (w * seriesC) : 0);
    const z = Math.hypot(rdc, x);
    return { f, xl, z, q: xl / rdc, iAmp: sim?.toneAmp[idx] ?? NaN };
  });

  // Measured-vs-model rows: each active tone's modelled current, the measured amplitude the
  // user read off the scope FFT (in mA), and the boost = measured/model. That boost is, to
  // first order, how much the real firmware SHE pattern weights that tone vs the naïve one.
  const meas = activeFreqs.map((f, idx) => {
    const model = sim?.toneAmp[idx] ?? NaN;
    const measured = (measI[idx] ?? 0) / 1000; // A
    return { f, model, measured, boost: model > 0 && measured > 0 ? measured / model : NaN };
  });
  const setMeas = (i: number, mA: number) =>
    setMeasI(Array.from({ length: 3 }, (_, j) => (j === i ? mA : measI[j] ?? 0)));

  const setFreq = (i: number, hz: number) => setFreqs(freqs.map((v, j) => (j === i ? hz : v)));
  const loadProfileFreqs = () => {
    if (harmonics && harmonics.length) setFreqs(harmonics.slice(0, 3).map((h) => h.freq_hz));
  };

  return (
    <div className="space-y-4">
      {/* Inputs */}
      <div className="rounded-lg border border-border bg-panel p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium text-muted">Coil &amp; drive</h2>
          <InfoPopover title="TX bench — model">
            <p>
              The bridge always switches the coil across <code className={CODE_CLS}>±Vbus</code>. One tone =
              plain square wave (triangular current). Multiple tones = a 1-bit pattern, the sign of the
              summed tones — the lowest tone dominates the envelope, as on real multi-frequency scope
              captures.
            </p>
            <p>
              The steady-state current is solved per harmonic through the series R–L(–C) and the waveform
              reassembled, so <b>pk-pk / peak / RMS</b> are what the shunt shows. Per-tone currents are read
              from the simulated spectrum.
            </p>
            <p>
              Tones are treated as harmonics of the lowest one (Spectral&apos;s 7.8125 / 23.4375 / 39.0625 =
              1:3:5). RMS uses Parseval over all harmonics.
            </p>
            <p>
              <b>Series C</b> (0 = none) models a DC-block / partial-resonance cap in the coil path — it
              subtracts reactance, which is why an RLC-bridge L reads higher than the effective L seen on a
              scope slope.
            </p>
          </InfoPopover>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Inductance" value={luH} onChange={setLuH} unit="µH" step={10} />
          <Field label="DC resistance" value={rdc} onChange={setRdc} unit="Ω" step={0.1} />
          <Field label="Supply Vbus" value={vbus} onChange={setVbus} unit="V" step={0.5} />
          <Field label="Series C (0 = none)" value={seriesCuF} onChange={setSeriesCuF} unit="µF" step={0.1} />
          <div className="ml-2 flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">
              Harmonics [kHz]
            </span>
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-0.5 rounded-md bg-black/20 px-1.5 py-1">
                <span className="pr-1 text-[10px] font-semibold uppercase tracking-wider text-muted">tones</span>
                {[1, 2, 3].map((n) => (
                  <button
                    key={n}
                    onClick={() => setNTones(n)}
                    className={`rounded border px-1.5 py-0.5 text-xs tabular-nums transition-colors ${
                      nTones === n ? "border-accent text-foreground" : "border-border text-muted hover:text-foreground"
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </span>
              {freqs.slice(0, nTones).map((f, i) => (
                <input
                  key={i}
                  type="number"
                  value={+(f / 1000).toFixed(4)}
                  step={0.1}
                  min={0}
                  onChange={(e) => setFreq(i, Number(e.target.value) * 1000)}
                  className="w-24 rounded-md border border-border bg-background px-2 py-1 font-mono text-sm tabular-nums text-foreground outline-none"
                />
              ))}
              <button
                onClick={() => setFreqs(DEFAULT_FREQS)}
                title="reset to the Spectral SHE-PWM tones (7.8125 / 23.4375 / 39.0625 kHz)"
                className="rounded-md border border-border px-2 py-1 text-xs text-muted transition-colors hover:text-foreground"
              >
                defaults
              </button>
              <button
                onClick={loadProfileFreqs}
                disabled={!harmonics?.length}
                title="load the harmonic frequencies from the connected device profile"
                className="rounded-md border border-border px-2 py-1 text-xs text-muted transition-colors hover:text-foreground disabled:opacity-40"
              >
                from device
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Schematic */}
        <div className="rounded-lg border border-border bg-panel p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-sm font-medium text-muted">Full H-bridge (complementary)</h2>
            <span className="font-mono text-xs text-muted">UCC27524A · 2× Si4599</span>
          </div>
          <BridgeSvg vbus={vbus} iLabel={`I ≈ ${fmtA(sim?.pp ?? NaN)} pk-pk`} />
        </div>

        {/* Results */}
        <div className="rounded-lg border border-border bg-panel p-4">
          <h2 className="mb-3 text-sm font-medium text-muted">Coil current</h2>
          {/* The numbers that matter: what the shunt / scope actually shows. */}
          <div className="mb-4 grid grid-cols-3 gap-6">
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wide text-muted">pk-pk (scope)</span>
              <span className="font-mono text-3xl leading-none tabular-nums text-accent">{fmtA(sim?.pp ?? NaN)}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wide text-muted">peak</span>
              <span className="font-mono text-3xl leading-none tabular-nums text-foreground">{fmtA(sim?.peak ?? NaN)}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wide text-muted">RMS</span>
              <span className="font-mono text-3xl leading-none tabular-nums text-foreground">{fmtA(sim?.rms ?? NaN)}</span>
            </div>
          </div>
          {nTones > 1 && (
            <>
              <h3 className="mb-2 text-[10px] uppercase tracking-wide text-muted">per tone (from the pattern spectrum)</h3>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[420px] text-sm">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wide text-muted">
                      <th className="py-1 text-left font-semibold">Tone</th>
                      <th className="py-1 text-right font-semibold">X_L</th>
                      <th className="py-1 text-right font-semibold">|Z|</th>
                      <th className="py-1 text-right font-semibold">Q</th>
                      <th className="py-1 text-right font-semibold">I (amp)</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono tabular-nums">
                    {rows.map((r, i) => (
                      <tr key={i} className="border-t border-border">
                        <td className="py-1.5 text-left text-foreground">{(r.f / 1000).toFixed(3)} kHz</td>
                        <td className="py-1.5 text-right text-muted">{fmtOhm(r.xl)}</td>
                        <td className="py-1.5 text-right text-muted">{fmtOhm(r.z)}</td>
                        <td className="py-1.5 text-right text-muted">{fmtNum(r.q, 1)}</td>
                        <td className="py-1.5 text-right text-accent">{fmtA(r.iAmp)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* Measured-vs-model overlay — close the loop with a scope FFT of the shunt. */}
          <div className="mt-4 border-t border-border pt-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-[10px] uppercase tracking-wide text-muted">measured vs model (scope FFT)</h3>
              <button
                onClick={() => setMeasOn((v) => !v)}
                className="rounded-md border border-border px-2 py-0.5 text-xs text-muted transition-colors hover:text-foreground"
              >
                {measOn ? "hide" : "enter measured"}
              </button>
            </div>
            {measOn && (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[420px] text-sm">
                    <thead>
                      <tr className="text-[10px] uppercase tracking-wide text-muted">
                        <th className="py-1 text-left font-semibold">Tone</th>
                        <th className="py-1 text-right font-semibold">model I</th>
                        <th className="py-1 text-right font-semibold">measured [mA]</th>
                        <th className="py-1 text-right font-semibold">boost</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono tabular-nums">
                      {meas.map((m, i) => (
                        <tr key={i} className="border-t border-border">
                          <td className="py-1.5 text-left text-foreground">{(m.f / 1000).toFixed(3)} kHz</td>
                          <td className="py-1.5 text-right text-muted">{fmtA(m.model)}</td>
                          <td className="py-1.5 text-right">
                            <input
                              type="number"
                              value={measI[i] ?? 0}
                              min={0}
                              step={5}
                              onChange={(e) => setMeas(i, Number(e.target.value))}
                              className="w-20 rounded border border-border bg-background px-2 py-0.5 text-right font-mono text-sm tabular-nums text-foreground outline-none"
                            />
                          </td>
                          <td className={`py-1.5 text-right ${isFinite(m.boost) ? "text-accent" : "text-muted"}`}>
                            {isFinite(m.boost) ? `${m.boost.toFixed(2)}×` : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-2 text-xs text-muted">
                  Enter each tone&apos;s current amplitude from a scope FFT of the shunt (0.1 Ω → 100 mV/A;
                  Blackman window, long record). <b className="text-foreground">boost</b> = measured ÷ naïve
                  model — how much the real firmware SHE pattern weights that tone. All ≈ 1× → the drive is
                  the plain pattern; higher on the top tones → it boosts them (Equinox-style).
                </p>
              </>
            )}
          </div>

          <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-border pt-3">
            <Readout label="ceiling Vbus/R" value={fmtA(idc)} />
            <Readout label="coil heat I²R" value={isFinite(pCoil) ? `${pCoil.toFixed(2)} W` : "—"} />
            {fRes != null && (
              <Readout label="series resonance" value={`${(fRes / 1000).toFixed(2)} kHz`} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wide text-muted">{label}</span>
      <span className="font-mono text-sm tabular-nums text-foreground">{value}</span>
    </div>
  );
}
