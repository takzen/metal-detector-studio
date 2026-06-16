"use client";

import { useEffect, useRef } from "react";
import { usePersistentState } from "@/lib/usePersistentState";

// Sandbox for I/Q axis auto-calibration (PhaseLab).
//
// A detector's physical channels X'/Y' are the TRUE I/Q rotated by an unknown axis angle θ
// (it drifts with frequency / temperature). With no metal the probe sits on the true X axis,
// so the physical probe vector reads at angle θ → measuring atan2(Y', X') of the no-metal
// reading recovers θ. Applying the inverse 2×2 rotation R(−θ) brings the signal back to the
// true X/Y frame; then the target phase = atan2(Y, X) drives discrimination.
//
// This is a self-contained model (sliders, no live data): set the hardware axis rotation θ
// and a target's true phase/amplitude, "measure" θ from the probe, and watch the corrected
// plot line up and the phase read correctly.

const D2R = Math.PI / 180;
const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

const C_TARGET = "#3b82f6"; // target vector
const C_AXIS = "#c99a52"; // ground / probe reference axis (the rotated coordinate)
const C_DISC = "#ef4444"; // discrimination boundary
const C_GRID = "#1b2330";
const C_AXES = "#2a3342";
const C_TXT = "#8b98a9";

type PlaneOpts = {
  title: string;
  axisDeg: number; // ground / probe reference axis direction
  vecDeg: number; // target vector angle
  vecAmp: number; // 0..1
  vecLabel: string;
  discDeg?: number; // optional discrimination boundary
};

function drawPlane(canvas: HTMLCanvasElement, o: PlaneOpts) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  if (w < 2 || h < 2) return;
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h / 2;
  const R = (Math.min(w, h) / 2) * 0.9;
  // math plane: angle CCW from +X, +Y up (screen y flipped)
  const pt = (deg: number, r: number) => ({ x: cx + r * Math.cos(deg * D2R), y: cy - r * Math.sin(deg * D2R) });

  // grid rings
  ctx.lineWidth = 1;
  ctx.strokeStyle = C_GRID;
  for (const f of [0.25, 0.5, 0.75, 1]) {
    ctx.beginPath();
    ctx.arc(cx, cy, R * f, 0, Math.PI * 2);
    ctx.stroke();
  }
  // X / Y axes
  ctx.strokeStyle = C_AXES;
  ctx.beginPath();
  ctx.moveTo(cx - R, cy);
  ctx.lineTo(cx + R, cy);
  ctx.moveTo(cx, cy - R);
  ctx.lineTo(cx, cy + R);
  ctx.stroke();
  ctx.fillStyle = C_TXT;
  ctx.font = "10px var(--font-geist-mono), monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("X", cx + R - 6, cy + 10);
  ctx.fillText("Y", cx + 10, cy - R + 6);

  // discrimination boundary (half-line at discDeg)
  if (o.discDeg != null) {
    const a = pt(o.discDeg, R);
    ctx.strokeStyle = C_DISC;
    ctx.globalAlpha = 0.55;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(a.x, a.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  // ground / probe reference axis (full diameter, dashed)
  {
    const a = pt(o.axisDeg, R);
    ctx.strokeStyle = C_AXIS;
    ctx.globalAlpha = 0.9;
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(2 * cx - a.x, 2 * cy - a.y);
    ctx.lineTo(a.x, a.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  // target vector
  {
    const t = pt(o.vecDeg, R * Math.max(0.02, o.vecAmp));
    ctx.strokeStyle = C_TARGET;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(t.x, t.y);
    ctx.stroke();
    ctx.fillStyle = C_TARGET;
    ctx.beginPath();
    ctx.arc(t.x, t.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = "11px var(--font-geist-mono), monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(o.vecLabel, t.x + 7, t.y);
  }

  // title
  ctx.fillStyle = C_TXT;
  ctx.font = "11px var(--font-geist-mono), monospace";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(o.title, 8, 8);

  ctx.restore();
}

function Slider({ label, value, min, max, step, unit, onChange, fmt }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (v: number) => void;
  fmt?: (v: number) => string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-28 accent-[#3b82f6]"
      />
      <span className="w-12 text-right font-mono text-xs tabular-nums text-foreground">
        {(fmt ? fmt(value) : value.toFixed(0)) + unit}
      </span>
    </div>
  );
}

function Read({ label, v, warn }: { label: string; v: string; warn?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</span>
      <span className={`tabular-nums ${warn ? "text-amber-400" : "text-foreground"}`}>{v}</span>
    </span>
  );
}

export function PhaseLab() {
  const [theta, setTheta] = usePersistentState("phaseTheta", 25); // hardware axis rotation θ (deg)
  const [phi, setPhi] = usePersistentState("phasePhi", 60); // target TRUE phase (deg)
  const [amp, setAmp] = usePersistentState("phaseAmp", 0.7); // 0..1
  const [thetaMeas, setThetaMeas] = usePersistentState("phaseThetaMeas", 0); // measured calibration angle
  const [disc, setDisc] = usePersistentState("phaseDisc", 0); // discrimination boundary (deg)

  const physRef = useRef<HTMLCanvasElement | null>(null);
  const corrRef = useRef<HTMLCanvasElement | null>(null);

  const physDeg = wrap180(phi + theta); // physical target angle (rotated by θ)
  const corrDeg = wrap180(phi + theta - thetaMeas); // corrected phase the detector computes
  const residual = wrap180(theta - thetaMeas); // leftover axis error after calibration
  const accepted = corrDeg >= disc; // simple discrimination: above the boundary → beep

  useEffect(() => {
    const pc = physRef.current;
    const cc = corrRef.current;
    if (!pc || !cc) return;
    const render = () => {
      drawPlane(pc, {
        title: "physical  X'/Y'  (rotated by θ)",
        axisDeg: theta, // probe/ground is on true +X → reads at θ here
        vecDeg: physDeg,
        vecAmp: amp,
        vecLabel: `${physDeg.toFixed(0)}°`,
      });
      drawPlane(cc, {
        title: "corrected  X/Y  (after R(−θ_meas))",
        axisDeg: residual, // probe/ground after correction (0 when calibrated)
        vecDeg: corrDeg,
        vecAmp: amp,
        vecLabel: `${corrDeg.toFixed(0)}°`,
        discDeg: disc,
      });
    };
    render();
    const ro = new ResizeObserver(render);
    ro.observe(pc);
    ro.observe(cc);
    return () => ro.disconnect();
  }, [theta, physDeg, corrDeg, residual, amp, disc]);

  const btn =
    "rounded border border-border px-2 py-0.5 text-xs text-muted transition-colors hover:text-foreground";

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs leading-snug text-muted">
        Sandbox: the physical I/Q channels are the true vector rotated by an unknown axis angle θ.
        Measure θ from the probe (no-metal) vector, apply the inverse 2×2 rotation, and the corrected
        phase reads the target correctly. No live data — this is the model.
      </p>

      {/* controls */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <Slider label="θ axis rot" value={theta} min={-90} max={90} step={1} unit="°" onChange={setTheta} />
        <Slider label="target φ" value={phi} min={-180} max={180} step={1} unit="°" onChange={setPhi} />
        <Slider label="amplitude" value={amp} min={0.05} max={1} step={0.05} unit="" onChange={setAmp} fmt={(v) => v.toFixed(2)} />
        <Slider label="disc level" value={disc} min={-90} max={90} step={1} unit="°" onChange={setDisc} />
        <div className="flex items-center gap-1.5">
          <button
            className={btn}
            onClick={() => setThetaMeas(theta)}
            title="air-balance: measure θ from the probe vector (atan2 of the no-metal reading)"
          >
            measure θ (air-balance)
          </button>
          <button className={btn} onClick={() => setThetaMeas(0)} title="clear calibration">
            reset cal
          </button>
        </div>
      </div>

      {/* dual hodograph: physical (rotated) vs corrected */}
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="aspect-square w-full rounded-md bg-black/20">
          <canvas ref={physRef} className="h-full w-full" />
        </div>
        <div className="aspect-square w-full rounded-md bg-black/20">
          <canvas ref={corrRef} className="h-full w-full" />
        </div>
      </div>

      {/* readouts */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 font-mono text-xs">
        <Read label="θ actual" v={`${theta.toFixed(0)}°`} />
        <Read label="θ measured" v={`${thetaMeas.toFixed(0)}°`} />
        <Read label="axis error" v={`${residual.toFixed(0)}°`} warn={Math.abs(residual) > 1} />
        <Read label="true φ" v={`${phi.toFixed(0)}°`} />
        <Read label="detector reads" v={`${corrDeg.toFixed(0)}°`} />
        <span
          className={`rounded px-2 py-0.5 text-xs font-semibold ${
            accepted ? "bg-emerald-500/20 text-emerald-400" : "bg-red-500/20 text-red-400"
          }`}
        >
          {accepted ? "BEEP" : "MUTE"}
        </span>
      </div>
    </div>
  );
}
