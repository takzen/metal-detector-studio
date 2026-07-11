"use client";

// Coil / probe designer: pick the geometry (DD / concentric / mono) and design BOTH
// windings (TX drive coil + RX pickup coil), each with its own turns and wire gauge. Gives
// L, R and Q per coil — the TX L/R you feed into the bench, the RX L/R for the receive tune.
// A design starting point (loop-inductance formula, ±10–20 %); the wound coil is measured.

import { useMemo, useState } from "react";
import { InfoPopover, CODE_CLS } from "@/components/InfoPopover";
import { usePersistentState } from "@/lib/usePersistentState";

const MU0 = 4 * Math.PI * 1e-7; // H/m
const RHO_CU = 1.68e-8; // Ω·m, copper @20 °C
const DENS_CU = 8960; // kg/m³
const TWO_PI = 2 * Math.PI;

// AWG → conductor diameter [m]. d = 0.127 mm · 92^((36−awg)/39).
const awgDiam = (awg: number) => 0.127e-3 * Math.pow(92, (36 - awg) / 39);

type CoilType = "dd" | "concentric" | "mono";
const TYPE_LABEL: Record<CoilType, string> = { dd: "DD", concentric: "Concentric", mono: "Mono loop" };

const fmtOhm = (x: number) => (!isFinite(x) ? "—" : x >= 1 ? `${x.toFixed(2)} Ω` : `${(x * 1000).toFixed(0)} mΩ`);
const fmtH = (h: number) => (!isFinite(h) ? "—" : h >= 1e-3 ? `${(h * 1e3).toFixed(2)} mH` : `${(h * 1e6).toFixed(0)} µH`);
const fmtF = (f: number) => (!isFinite(f) || f <= 0 ? "—" : f >= 1e-9 ? `${(f * 1e9).toFixed(1)} nF` : `${(f * 1e12).toFixed(0)} pF`);
const fmtHz = (hz: number) => (!isFinite(hz) || hz <= 0 ? "—" : hz >= 1e3 ? `${(hz / 1e3).toFixed(2)} kHz` : `${hz.toFixed(0)} Hz`);

// Inductance of an N-turn circular loop of a round conductor bundle (Wheeler):
// L = μ0·N²·r·[ln(8r/a) − 2], a = bundle radius. Weakly (log) sensitive to a.
function loopInductance(dCoil: number, N: number, dWire: number): number {
  const r = dCoil / 2;
  const aBundle = (dWire / 2) * Math.sqrt(N / 0.75); // N turns packed at ~75 %
  const a = Math.min(Math.max(aBundle, dWire / 2), r * 0.8);
  const ln = Math.log((8 * r) / a);
  if (!(ln > 2) || N <= 0 || !(r > 0)) return NaN;
  return MU0 * N * N * r * (ln - 2);
}

// Full electrical result for one winding. `isD` = D-shaped (DD legs) vs a round loop.
// A D loop has no simple closed-form inductance, so L uses the EQUAL-ENCLOSED-AREA circle:
// a D (half-disk, area πr²/2, wound to the probe radius r = d/2) ≈ a circle of radius r/√2,
// i.e. effective diameter d/√2. Resistance/length use the TRUE D perimeter (arc + flat).
// Approximate (~±20 %) — the wound coil is measured.
function coilCalc(dia: number, turns: number, awg: number, isD: boolean, w: number) {
  const dWire = awgDiam(awg);
  const area = Math.PI * (dWire / 2) ** 2;
  const rPerM = RHO_CU / area;
  const dEff = isD ? dia / Math.SQRT2 : dia; // equal-area equivalent circle for a D
  const turnLen = isD ? dia * (1 + Math.PI / 2) : Math.PI * dia; // D: arc πr + flat 2r = d(1+π/2)
  const L = loopInductance(dEff, turns, dWire);
  const wireLen = turns * turnLen;
  const R = rPerM * wireLen;
  const massG = wireLen * area * DENS_CU * 1000;
  return { L, R, Q: (w * L) / R, wireLen, massG, dWire, rPerM };
}

function Field({
  label, value, onChange, unit, step = 1, min = 0, w = "w-20",
}: {
  label: string; value: number; onChange: (v: number) => void; unit: string; step?: number; min?: number; w?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</span>
      <span className="flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1">
        <input type="number" value={value} min={min} step={step}
          onChange={(e) => onChange(Number(e.target.value))}
          className={`${w} bg-transparent font-mono text-sm tabular-nums text-foreground outline-none`} />
        <span className="shrink-0 text-xs text-muted">{unit}</span>
      </span>
    </label>
  );
}

function AwgField({ awg, onChange }: { awg: number; onChange: (v: number) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">Wire (AWG)</span>
      <span className="flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1">
        <input type="number" value={awg} min={10} max={40} step={1}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-14 bg-transparent font-mono text-sm tabular-nums text-foreground outline-none" />
        <span className="shrink-0 text-xs text-muted">= {(awgDiam(awg) * 1000).toFixed(2)} mm</span>
      </span>
    </div>
  );
}

function CoilSvg({ type }: { type: CoilType }) {
  const R = 96;
  const cx = 150;
  const cy = 125;
  return (
    <div className="coil-draw w-full">
      <style>{`
        .coil-draw svg{display:block;width:100%;max-width:340px;height:auto;margin:0 auto}
        .coil-draw .wire{stroke:var(--accent);stroke-width:3;fill:none;stroke-linecap:round;stroke-linejoin:round}
        .coil-draw .wire2{stroke:var(--muted);stroke-width:2.5;fill:none;stroke-linecap:round;stroke-linejoin:round}
        .coil-draw .dim{stroke:var(--muted);stroke-width:1;fill:none}
        .coil-draw text{font-family:var(--font-mono),monospace;fill:var(--muted);font-size:12px}
        .coil-draw .lead{stroke:var(--accent);stroke-width:2;fill:none}
        .coil-draw .lead2{stroke:var(--muted);stroke-width:2;fill:none}
      `}</style>
      <svg viewBox="0 0 300 270" role="img" aria-label={`${type} coil layout`}>
        {type === "mono" && (
          <>
            <circle className="wire" cx={cx} cy={cy} r={R} />
            <circle className="wire2" cx={cx} cy={cy} r={R - 6} />
            <path className="lead" d={`M${cx},${cy + R} V${cy + R + 30}`} />
          </>
        )}
        {type === "concentric" && (
          <>
            <circle className="wire" cx={cx} cy={cy} r={R} />
            <circle className="wire2" cx={cx} cy={cy} r={R * 0.55} />
            <text x={cx} y={cy - R + 18} textAnchor="middle">TX</text>
            <text x={cx} y={cy - R * 0.55 + 16} textAnchor="middle">RX</text>
            <path className="lead" d={`M${cx - 10},${cy + R} V${cy + R + 30}`} />
            <path className="lead2" d={`M${cx + 10},${cy + R * 0.55} V${cy + R + 30}`} />
          </>
        )}
        {type === "dd" && (
          <>
            {/* two D coils sharing the central flat edge (the overlap axis): TX bulges
                left, RX bulges right — the classic DD split. */}
            <path className="wire" d={`M${cx},${cy - R} A ${R},${R} 0 0 0 ${cx},${cy + R} Z`} />
            <path className="wire2" d={`M${cx},${cy - R} A ${R},${R} 0 0 1 ${cx},${cy + R} Z`} />
            <text x={cx - R * 0.5} y={cy + 4} textAnchor="middle">TX</text>
            <text x={cx + R * 0.5} y={cy + 4} textAnchor="middle">RX</text>
            <path className="lead" d={`M${cx - 30},${cy + R * 0.86} V${cy + R + 30}`} />
            <path className="lead2" d={`M${cx + 30},${cy + R * 0.86} V${cy + R + 30}`} />
          </>
        )}
        {/* diameter dimension */}
        <path className="dim" d={`M${cx - R},${cy + R + 44} H${cx + R} M${cx - R},${cy + R + 39} v10 M${cx + R},${cy + R + 39} v10`} />
        <text x={cx} y={cy + R + 60} textAnchor="middle">Ø</text>
      </svg>
    </div>
  );
}

function CoilResult({
  title, accent, c, w, cParF, extra,
}: {
  title: string; accent: boolean; c: ReturnType<typeof coilCalc>; w: number; cParF: number; extra?: React.ReactNode;
}) {
  void w; // frequency not used for self-resonance (kept for signature symmetry)
  const fSelf = cParF > 0 && c.L > 0 ? 1 / (TWO_PI * Math.sqrt(c.L * cParF)) : NaN; // self-resonance with C_self
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">{title}</h3>
        {extra}
      </div>
      <div className="grid grid-cols-3 gap-4">
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wide text-muted">inductance</span>
          <span className={`font-mono text-2xl leading-none tabular-nums ${accent ? "text-accent" : "text-foreground"}`}>{fmtH(c.L)}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wide text-muted">DC resistance</span>
          <span className="font-mono text-2xl leading-none tabular-nums text-foreground">{fmtOhm(c.R)}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wide text-muted">Q</span>
          <span className="font-mono text-2xl leading-none tabular-nums text-foreground">{isFinite(c.Q) ? c.Q.toFixed(0) : "—"}</span>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 font-mono text-xs text-muted">
        <span>wire {isFinite(c.wireLen) ? `${c.wireLen.toFixed(1)} m` : "—"}</span>
        <span>Cu {isFinite(c.massG) ? `${c.massG.toFixed(0)} g` : "—"}</span>
        <span>{(c.dWire * 1000).toFixed(2)} mm · {c.rPerM.toFixed(3)} Ω/m</span>
        <span>f_self = <span className={cParF > 0 ? "text-accent" : "text-foreground"}>{cParF > 0 ? fmtHz(fSelf) : "— (set C_self)"}</span></span>
      </div>
    </div>
  );
}

export function CoilDesigner() {
  const [type, setType] = usePersistentState<CoilType>("cd_type", "dd");
  const [diaCm, setDiaCm] = usePersistentState("cd_dia_cm", 25); // outer / TX diameter [cm]
  const [rxDiaCm, setRxDiaCm] = usePersistentState("cd_rxdia_cm", 12); // inner RX diameter (concentric) [cm]
  const [fkHz, setFkHz] = usePersistentState("cd_fkHz", 7.8125); // frequency for Q [kHz]
  const [txTurns, setTxTurns] = usePersistentState("cd_tx_turns", 30);
  const [txAwg, setTxAwg] = usePersistentState("cd_tx_awg", 26);
  const [rxTurns, setRxTurns] = usePersistentState("cd_rx_turns", 60);
  const [rxAwg, setRxAwg] = usePersistentState("cd_rx_awg", 30);
  const [selfCpF, setSelfCpF] = usePersistentState("cd_selfc_pf", 0); // measured/estimated self-capacitance [pF]
  const [sent, setSent] = useState(false);

  const hasRx = type !== "mono";
  const isD = type === "dd";
  const w = TWO_PI * fkHz * 1000;
  const dTx = diaCm / 100;
  const dRx = (type === "concentric" ? rxDiaCm : diaCm) / 100; // DD RX = same D size; concentric = inner

  const tx = useMemo(() => coilCalc(dTx, txTurns, txAwg, isD, w), [dTx, txTurns, txAwg, isD, w]);
  const rx = useMemo(() => coilCalc(dRx, rxTurns, rxAwg, isD, w), [dRx, rxTurns, rxAwg, isD, w]);

  // Wire trade-off for the TX (drive) coil — same geometry, a few gauges.
  const tradeoff = [22, 24, 26, 28, 30, 32].map((g) => ({ g, ...coilCalc(dTx, txTurns, g, isD, w) }));

  const sendToBench = () => {
    if (!isFinite(tx.L) || !isFinite(tx.R)) return;
    try {
      window.localStorage.setItem("mds:coilL_uH", JSON.stringify(Math.round(tx.L * 1e6)));
      window.localStorage.setItem("mds:coilRdc", JSON.stringify(Number(tx.R.toFixed(2))));
      setSent(true);
      setTimeout(() => setSent(false), 2500);
    } catch {
      /* private mode — ignore */
    }
  };

  return (
    <div className="space-y-4">
      {/* Inputs */}
      <div className="rounded-lg border border-border bg-panel p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium text-muted">Coil geometry &amp; windings</h2>
          <InfoPopover title="Coil designer — model">
            <p>
              A coil assembly has <b>two windings</b>: the <b>TX</b> drive coil and the <b>RX</b> pickup coil —
              each with its own turns and wire gauge, so each is designed separately here.
            </p>
            <p>
              <b>Self C</b> is the winding&apos;s self-capacitance (measured / estimated — there is no reliable
              formula for it): with it, <code className={CODE_CLS}>f_self = 1/(2π√(L·C))</code> is the
              self-resonant frequency. Leave 0 if unknown.
            </p>
            <p>
              Inductance = N-turn loop formula{" "}
              <code className={CODE_CLS}>L = μ0·N²·r·(ln(8r/a) − 2)</code>; resistance ={" "}
              <code className={CODE_CLS}>ρ_Cu · length / area</code> from the AWG.
            </p>
            <p>
              A <b>D</b> loop has no simple closed form, so L uses the{" "}
              <b>equal-enclosed-area circle</b> (a half-disk D ≈ a circle of radius r/√2), while resistance
              uses the true D perimeter (arc + flat). Concentric RX is the inner ring.
            </p>
            <p>
              The <b>TX</b> L/R feed the bench (drive current). The <b>RX</b> L/R size the receive tuned
              circuit (resonating cap). A <b>design starting point</b> (±10–20 %) — wind it, measure, trust
              the measurement.
            </p>
          </InfoPopover>
        </div>
        <div className="flex flex-wrap items-end gap-x-3 gap-y-3">
          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">Type</span>
            <div className="flex items-center gap-0.5 rounded-md bg-black/20 px-1 py-1">
              {(Object.keys(TYPE_LABEL) as CoilType[]).map((t) => (
                <button key={t} onClick={() => setType(t)}
                  className={`rounded border px-2 py-0.5 text-xs transition-colors ${
                    type === t ? "border-accent text-foreground" : "border-border text-muted hover:text-foreground"
                  }`}>
                  {TYPE_LABEL[t]}
                </button>
              ))}
            </div>
          </div>
          <Field label="Outer Ø" value={diaCm} onChange={setDiaCm} unit="cm" step={1} />
          <Field label="Frequency" value={fkHz} onChange={setFkHz} unit="kHz" step={0.1} />
          <Field label="Self C" value={selfCpF} onChange={setSelfCpF} unit="pF" step={5} w="w-16" />

          {/* TX winding */}
          <div className="flex items-end gap-3 rounded-md border border-accent/40 bg-accent/5 px-3 py-2">
            <span className="pb-1 text-[10px] font-semibold uppercase tracking-wider text-accent">TX winding</span>
            <Field label="Turns" value={txTurns} onChange={setTxTurns} unit="t" step={1} w="w-14" />
            <AwgField awg={txAwg} onChange={setTxAwg} />
          </div>

          {/* RX winding */}
          {hasRx && (
            <div className="flex items-end gap-3 rounded-md border border-border bg-black/20 px-3 py-2">
              <span className="pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted">RX winding</span>
              <Field label="Turns" value={rxTurns} onChange={setRxTurns} unit="t" step={1} w="w-14" />
              <AwgField awg={rxAwg} onChange={setRxAwg} />
              {type === "concentric" && <Field label="Inner Ø" value={rxDiaCm} onChange={setRxDiaCm} unit="cm" step={1} />}
            </div>
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Drawing */}
        <div className="rounded-lg border border-border bg-panel p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-sm font-medium text-muted">{TYPE_LABEL[type]} coil</h2>
            <span className="font-mono text-xs text-muted">Ø {diaCm} cm{hasRx ? ` · TX ${txTurns}t / RX ${rxTurns}t` : ` · ${txTurns}t`}</span>
          </div>
          <CoilSvg type={type} />
        </div>

        {/* Results */}
        <div className="rounded-lg border border-border bg-panel p-4">
          <h2 className="mb-3 text-sm font-medium text-muted">Design result</h2>
          <CoilResult
            title="TX coil (drive)"
            accent
            c={tx}
            w={w}
            cParF={selfCpF * 1e-12}
            extra={
              <div className="flex items-center gap-2">
                {sent && <span className="font-mono text-[11px] text-accent">sent — open TX bench</span>}
                <button onClick={sendToBench} disabled={!isFinite(tx.L) || !isFinite(tx.R)}
                  className="rounded-md border border-accent/60 bg-accent/10 px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent/20 disabled:opacity-40">
                  → TX bench
                </button>
              </div>
            }
          />
          {hasRx && (
            <div className="mt-4 border-t border-border pt-4">
              <CoilResult title="RX coil (pickup)" accent={false} c={rx} w={w} cParF={selfCpF * 1e-12} />
            </div>
          )}
        </div>
      </div>

      {/* Wire trade-off (TX) */}
      <div className="rounded-lg border border-border bg-panel p-4">
        <h2 className="mb-3 text-sm font-medium text-muted">TX wire choice (same geometry)</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[440px] text-sm">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-muted">
                <th className="py-1 text-left font-semibold">AWG</th>
                <th className="py-1 text-right font-semibold">Ø wire</th>
                <th className="py-1 text-right font-semibold">R (TX)</th>
                <th className="py-1 text-right font-semibold">Q</th>
              </tr>
            </thead>
            <tbody className="font-mono tabular-nums">
              {tradeoff.map((t) => (
                <tr key={t.g} className={`border-t border-border ${t.g === txAwg ? "text-foreground" : "text-muted"}`}>
                  <td className="py-1.5 text-left">
                    AWG {t.g}
                    {t.g === txAwg && <span className="ml-2 text-accent">◄</span>}
                  </td>
                  <td className="py-1.5 text-right">{(t.dWire * 1000).toFixed(2)} mm</td>
                  <td className="py-1.5 text-right">{fmtOhm(t.R)}</td>
                  <td className="py-1.5 text-right">{isFinite(t.Q) ? t.Q.toFixed(0) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-muted">
          Thicker wire (lower AWG) → lower R, higher Q, more current &amp; less heat, but heavier and bulkier;
          thinner → more turns fit but R climbs. RX usually goes thinner / more turns (higher voltage, low
          current); TX goes thicker (carries the drive current).
        </p>
      </div>
    </div>
  );
}
