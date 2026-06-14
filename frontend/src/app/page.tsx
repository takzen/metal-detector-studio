"use client";

import { useEffect, useMemo, useState } from "react";
import { FilterLab } from "@/components/FilterLab";
import { Hodograph } from "@/components/Hodograph";
import { IQScope, type TrigMode, type TrigSrc } from "@/components/IQScope";
import { IQSpectrum } from "@/components/IQSpectrum";
import { Recorder, type RecChannel } from "@/components/Recorder";
import { Scope } from "@/components/Scope";
import { SourceControls } from "@/components/SourceControls";
import { Spectrum } from "@/components/Spectrum";
import { colorFor } from "@/lib/palette";
import { useTelemetry, type ConnStatus } from "@/lib/useTelemetry";

const DEG = 180 / Math.PI;
const VERSION = "v0.2.0-beta";
const fmt = (n: number, d = 1) => n.toFixed(d);
const clamp180 = (d: number) => Math.max(-180, Math.min(180, d));
const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const VDI_COLOR = "#c99a52"; // matches the hodograph VDI sub-scale

type TabId = "hodograph" | "scope" | "fft" | "dsp";
const TABS: { id: TabId; label: string }[] = [
  { id: "hodograph", label: "XY hodograph" },
  { id: "scope", label: "Oscilloscope" },
  { id: "fft", label: "Live FFT" },
  { id: "dsp", label: "DSP" },
];

function StatusDot({ status }: { status: ConnStatus }) {
  const color =
    status === "open" ? "bg-emerald-500" : status === "connecting" ? "bg-amber-500" : "bg-red-500";
  return (
    <span className="inline-flex w-28 items-center gap-2 text-sm">
      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${color}`} />
      <span className="text-muted">{status}</span>
    </span>
  );
}

/** Fixed-width header metric so values don't shift layout as they change. */
function Metric({ label, value, w = "w-20" }: { label: string; value: string; w?: string }) {
  return (
    <div className={`flex flex-col ${w}`}>
      <span className="text-[11px] uppercase tracking-wide text-muted">{label}</span>
      <span className="truncate font-mono text-sm tabular-nums">{value}</span>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[11px] uppercase tracking-wide text-muted">{label}</span>
      <span className="font-mono text-sm tabular-nums">{value}</span>
    </div>
  );
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-border bg-panel p-4 ${className}`}>{children}</div>
  );
}

function RawUnavailable() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-center">
      <p className="text-sm text-muted">No raw ADC stream from this source.</p>
      <p className="max-w-md text-xs text-muted">
        This device (e.g. TAKTYK / URD-1) sends only the processed I/Q feature vector — no raw
        samples — so the oscilloscope and FFT have nothing to plot. They need a device that
        streams raw blocks (e.g. Spectral-G4).
      </p>
    </div>
  );
}

export default function Home() {
  const t = useTelemetry();
  const { profile, feature, raw, stats } = t;
  const [tab, setTab] = useState<TabId>("hodograph");
  const [zeroNonce, setZeroNonce] = useState(0);
  const [scopeMs, setScopeMs] = useState(500); // oscilloscope timebase (window)
  const [scopeRun, setScopeRun] = useState(true); // run / hold
  const [scopeYAuto, setScopeYAuto] = useState(true);
  const [scopeYScale, setScopeYScale] = useState(8000); // manual vertical full-scale
  const [trigMode, setTrigMode] = useState<TrigMode>("off"); // off = free-running roll
  const [trigSrc, setTrigSrc] = useState<TrigSrc>("mag"); // |IQ| rising = target approach
  const [trigEdge, setTrigEdge] = useState<"rising" | "falling">("rising");
  const [trigLevel, setTrigLevel] = useState<number | "auto">("auto"); // "auto" = above-noise; number = manual raw (draggable)
  const [scopeArmNonce, setScopeArmNonce] = useState(0); // bump to (re)arm single-shot
  const [fftSpan, setFftSpan] = useState<number | "full">("full"); // FFT frequency span [Hz]
  const [recMs, setRecMs] = useState(2000); // DSP recorder window
  const [recActive, setRecActive] = useState<Set<string>>(new Set(["audio", "threshold"]));
  const [recScaleMode, setRecScaleMode] = useState<"auto" | "manual">("auto"); // recorder lane scaling
  const [recZoom, setRecZoom] = useState(1); // manual lane zoom factor
  const [dspMode, setDspMode] = useState<"live" | "theory">("live");
  const [offsetDeg, setOffsetDeg] = useState(0); // demodulator phase offset (colour overlay)
  const [persistence, setPersistence] = useState(true); // hodograph phosphor trail
  const [ema, setEma] = useState(0.3); // hodograph live-vector smoothing factor

  const recChannels = useMemo<RecChannel[]>(
    () => [
      { key: "audio", label: "audio", color: "#10b981", lane: "aud", range: [0, 4000], get: (f) => { const a = f.extras.audio; return a == null ? undefined : Math.max(0, Math.min(4000, a)); } },
      { key: "threshold", label: "threshold", color: "#ef4444", lane: "aud", range: [0, 4000], get: (f) => { const a = f.extras.threshold; return a == null ? undefined : Math.max(0, Math.min(4000, a)); } },
      { key: "ground", label: "ground", color: "#a855f7", get: (f) => f.extras.ground },
      { key: "I", label: "I", color: "#3b82f6", lane: "iq", get: (f) => Object.values(f.harmonics)[0]?.i },
      { key: "Q", label: "Q", color: "#22d3ee", lane: "iq", get: (f) => Object.values(f.harmonics)[0]?.q },
    ],
    [],
  );

  const toggleRec = (k: string) =>
    setRecActive((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  // Keyboard zero: Enter or Z (mirrors the detector's ENTER=zero), unless typing in a control.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && ["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(el.tagName)) return;
      if (e.key === "Enter" || e.key.toLowerCase() === "z") {
        setZeroNonce((n) => n + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <main className="flex-1 w-full max-w-7xl mx-auto p-6">
      {/* Header (stable layout): title + metrics, then tabs alongside source controls */}
      <header className="border-b border-border pb-3">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <h1 className="text-xl font-semibold">Metal Detector Studio</h1>
              <span className="font-mono text-xs text-muted">{VERSION}</span>
            </div>
            <p className="truncate text-sm text-muted">
              {profile ? profile.title : "waiting for device profile…"}
            </p>
          </div>
          <div className="flex items-center gap-4">
            <StatusDot status={t.status} />
            <Metric label="schema" value={t.schemaVersion ?? "—"} w="w-16" />
            <Metric label="feature" value={`${fmt(stats.featureHz)} Hz`} />
            <Metric label="raw" value={`${fmt(stats.rawHz)} Hz`} />
            <Metric label="seq" value={feature ? String(feature.seq) : "—"} w="w-24" />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <nav className="flex flex-wrap gap-1">
            {TABS.map((tabDef) => {
              const active = tab === tabDef.id;
              return (
                <button
                  key={tabDef.id}
                  onClick={() => setTab(tabDef.id)}
                  className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                    active
                      ? "border-accent text-foreground"
                      : "border-transparent text-muted hover:text-foreground"
                  }`}
                >
                  {tabDef.label}
                </button>
              );
            })}
          </nav>
          <SourceControls />
        </div>
      </header>

      {/* Active view */}
      <section className="mt-6">
        {tab === "hodograph" && (
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="flex flex-col">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-medium text-muted">XY hodograph</h2>
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    onClick={() => setZeroNonce((n) => n + 1)}
                    title="zero now: snap the centre to the current vector (keyboard: Enter or Z)"
                    className="rounded border border-border px-2 py-0.5 text-xs text-muted hover:text-foreground"
                  >
                    zero (Enter)
                  </button>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] uppercase tracking-wide text-muted">offset</span>
                    <span className="w-12 text-right font-mono text-xs tabular-nums text-foreground">
                      {offsetDeg >= 0 ? "+" : ""}
                      {offsetDeg.toFixed(1)}°
                    </span>
                    {[-0.3, 0.3].map((d) => (
                      <button
                        key={d}
                        onClick={() => setOffsetDeg((v) => clamp180(Number((v + d).toFixed(1))))}
                        title="demodulator phase offset — colour overlay (the grid stays unchanged)"
                        className="rounded border border-border px-1.5 py-0.5 text-xs tabular-nums text-muted hover:text-foreground"
                      >
                        {d > 0 ? `+${d}` : d}
                      </button>
                    ))}
                    <button
                      onClick={() => setOffsetDeg(0)}
                      title="reset offset to 0°"
                      className="rounded border border-border px-1.5 py-0.5 text-xs text-muted hover:text-foreground"
                    >
                      0
                    </button>
                  </div>
                  <button
                    onClick={() => setPersistence((v) => !v)}
                    title="persistence / phosphor: density trail of the raw I/Q samples"
                    className={`rounded border px-2 py-0.5 text-xs transition-colors ${
                      persistence
                        ? "border-accent text-foreground"
                        : "border-border text-muted hover:text-foreground"
                    }`}
                  >
                    persist
                  </button>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] uppercase tracking-wide text-muted">EMA</span>
                    <input
                      type="range"
                      min={0.05}
                      max={1}
                      step={0.05}
                      value={ema}
                      onChange={(e) => setEma(Number(e.target.value))}
                      title="live-vector smoothing: lower = smoother/slower, higher = faster"
                      className="w-24 accent-[#22d3ee]"
                    />
                    <span className="w-9 text-right font-mono text-xs tabular-nums text-foreground">
                      {ema.toFixed(2)}
                    </span>
                  </div>
                  {profile?.harmonics.map((h, i) => (
                    <span key={h.id} className="inline-flex items-center gap-1.5 text-xs">
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: colorFor(i) }}
                      />
                      <span className="font-mono">{h.id}</span>
                    </span>
                  ))}
                </div>
              </div>
              <div className="relative aspect-square w-full">
                {profile && (
                  <Hodograph
                    trailRef={t.trailRef}
                    harmonics={profile.harmonics}
                    zeroSignal={zeroNonce}
                    offsetDeg={offsetDeg}
                    ema={ema}
                    persistence={persistence}
                  />
                )}
                {/* large, readable phase-angle readout (smoothed) */}
                <div className="pointer-events-none absolute left-3 top-2 flex flex-col gap-0.5">
                  {profile?.harmonics.map((h, i) => {
                    const s = feature?.harmonics[h.id];
                    const deg = s ? Math.atan2(s.q, s.i) * DEG : null; // -180..+180
                    return (
                      <span
                        key={h.id}
                        className="font-mono text-3xl leading-none tabular-nums"
                        style={{ color: colorFor(i) }}
                      >
                        {deg === null ? "—" : deg.toFixed(1)}°
                      </span>
                    );
                  })}
                </div>
                {/* large VDI readout (mirror of the phase readout, top-right) */}
                <div className="pointer-events-none absolute right-3 top-2 flex flex-col items-end gap-0.5">
                  {profile?.harmonics.map((h) => {
                    const s = feature?.harmonics[h.id];
                    const vdi = s ? wrap180(Math.atan2(s.q, s.i) * DEG - 90) : null;
                    return (
                      <span
                        key={h.id}
                        className="font-mono text-3xl leading-none tabular-nums"
                        style={{ color: VDI_COLOR }}
                      >
                        {vdi === null ? "—" : vdi.toFixed(1)}
                      </span>
                    );
                  })}
                </div>
              </div>
            </Card>

            <div className="flex flex-col gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                {profile?.harmonics.map((h, i) => {
                  const s = feature?.harmonics[h.id];
                  return (
                    <Card key={h.id}>
                      <div className="flex items-baseline justify-between">
                        <span className="inline-flex items-center gap-2 font-mono">
                          <span
                            className="h-2.5 w-2.5 rounded-full"
                            style={{ backgroundColor: colorFor(i) }}
                          />
                          {h.id}
                        </span>
                        <span className="text-xs text-muted">
                          h{h.index} · {(h.freq_hz / 1000).toFixed(4)} kHz
                        </span>
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-y-2">
                        <Stat label="mag" value={s ? fmt(s.mag) : "—"} />
                        <Stat label="phase" value={s ? `${fmt(s.phase * DEG)}°` : "—"} />
                        <Stat label="I" value={s ? fmt(s.i) : "—"} />
                        <Stat label="Q" value={s ? fmt(s.q) : "—"} />
                      </div>
                    </Card>
                  );
                })}
              </div>

              <Card>
                <h2 className="mb-3 text-sm font-medium text-muted">Phase diffs</h2>
                {profile?.phase_diffs.length ? (
                  <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
                    {profile.phase_diffs.map((pd) => (
                      <Stat
                        key={pd.name}
                        label={pd.name}
                        value={feature ? `${fmt((feature.phase_diffs[pd.name] ?? 0) * DEG)}°` : "—"}
                      />
                    ))}
                  </div>
                ) : (
                  <span className="text-sm text-muted">none (single-frequency profile)</span>
                )}
              </Card>

              <Card>
                <h2 className="mb-3 text-sm font-medium text-muted">Extras</h2>
                {feature && Object.keys(feature.extras).length ? (
                  <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
                    {Object.entries(feature.extras).map(([k, v]) => (
                      <Stat key={k} label={k} value={fmt(v, 2)} />
                    ))}
                  </div>
                ) : (
                  <span className="text-sm text-muted">none</span>
                )}
              </Card>
            </div>
          </div>
        )}

        {tab === "scope" && (
          <Card>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-medium text-muted">Virtual oscilloscope — {t.hasIq ? "demod I/Q" : "raw RX"}</h2>
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-1">
                  <span className="text-[11px] uppercase tracking-wide text-muted">time</span>
                  {[50, 100, 200, 500, 1000, 2000].map((ms) => (
                    <button
                      key={ms}
                      onClick={() => setScopeMs(ms)}
                      className={`rounded border px-1.5 py-0.5 text-xs tabular-nums transition-colors ${
                        scopeMs === ms ? "border-accent text-foreground" : "border-border text-muted hover:text-foreground"
                      }`}
                    >
                      {ms < 1000 ? `${ms}m` : `${ms / 1000}s`}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-[11px] uppercase tracking-wide text-muted">V</span>
                  <button
                    onClick={() => setScopeYAuto((v) => !v)}
                    className={`rounded border px-1.5 py-0.5 text-xs transition-colors ${
                      scopeYAuto ? "border-accent text-foreground" : "border-border text-muted hover:text-foreground"
                    }`}
                  >
                    auto
                  </button>
                  <button
                    onClick={() => { setScopeYAuto(false); setScopeYScale((s) => Math.max(50, Math.round(s / 2))); }}
                    className="rounded border border-border px-1.5 py-0.5 text-xs text-muted hover:text-foreground"
                  >
                    +
                  </button>
                  <button
                    onClick={() => { setScopeYAuto(false); setScopeYScale((s) => Math.min(2_000_000, s * 2)); }}
                    className="rounded border border-border px-1.5 py-0.5 text-xs text-muted hover:text-foreground"
                  >
                    −
                  </button>
                  <span className="w-16 text-[11px] tabular-nums text-muted">
                    {scopeYAuto ? "auto" : `±${scopeYScale >= 1000 ? (scopeYScale / 1000).toFixed(1) + "k" : scopeYScale}`}
                  </span>
                </div>
                <button
                  onClick={() => setScopeRun((v) => !v)}
                  className={`w-20 shrink-0 rounded border px-2 py-0.5 text-center text-xs transition-colors ${
                    scopeRun ? "border-border text-muted hover:text-foreground" : "border-amber-500 text-amber-400"
                  }`}
                >
                  {scopeRun ? "⏸ hold" : "▶ run"}
                </button>
              </div>
            </div>
            <div className="mb-3 flex flex-wrap items-center gap-3 border-t border-border pt-3">
              <div className="flex items-center gap-1">
                <span className="text-[11px] uppercase tracking-wide text-muted">trig</span>
                {(["off", "auto", "normal", "single"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => {
                      setTrigMode(m);
                      if (m === "single") setScopeArmNonce((n) => n + 1);
                    }}
                    className={`rounded border px-1.5 py-0.5 text-xs transition-colors ${
                      trigMode === m ? "border-accent text-foreground" : "border-border text-muted hover:text-foreground"
                    }`}
                  >
                    {m === "normal" ? "norm" : m}
                  </button>
                ))}
              </div>
              {trigMode !== "off" && (
                <>
                  <div className="flex items-center gap-1">
                    <span className="text-[11px] uppercase tracking-wide text-muted">src</span>
                    {(["I", "Q", "mag"] as const).map((s) => (
                      <button
                        key={s}
                        onClick={() => setTrigSrc(s)}
                        className={`rounded border px-1.5 py-0.5 text-xs transition-colors ${
                          trigSrc === s ? "border-accent text-foreground" : "border-border text-muted hover:text-foreground"
                        }`}
                      >
                        {s === "mag" ? "|IQ|" : s}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-[11px] uppercase tracking-wide text-muted">edge</span>
                    <button
                      onClick={() => setTrigEdge((e) => (e === "rising" ? "falling" : "rising"))}
                      className="rounded border border-border px-2 py-0.5 text-xs text-muted hover:text-foreground"
                      title="toggle trigger edge (rising / falling)"
                    >
                      {trigEdge === "rising" ? "↑ rise" : "↓ fall"}
                    </button>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-[11px] uppercase tracking-wide text-muted">lvl</span>
                    <button
                      onClick={() => setTrigLevel("auto")}
                      className={`rounded border px-1.5 py-0.5 text-xs transition-colors ${
                        trigLevel === "auto" ? "border-accent text-foreground" : "border-border text-muted hover:text-foreground"
                      }`}
                    >
                      auto
                    </button>
                    <span className="text-[11px] tabular-nums text-muted">
                      {trigLevel === "auto" ? "↕ drag line" : `man ${Math.round(trigLevel)}`}
                    </span>
                  </div>
                  {trigMode === "single" && (
                    <button
                      onClick={() => setScopeArmNonce((n) => n + 1)}
                      className="rounded border border-blue-500 px-2 py-0.5 text-xs text-blue-400 hover:text-blue-300"
                      title="re-arm single-shot capture"
                    >
                      ↻ arm
                    </button>
                  )}
                </>
              )}
            </div>
            <div className="h-[28rem] w-full">
              {t.hasIq ? (
                <IQScope
                  iRef={t.iqIRef}
                  qRef={t.iqQRef}
                  fsRef={t.iqFsRef}
                  countRef={t.iqCountRef}
                  windowMs={scopeMs}
                  running={scopeRun}
                  yScale={scopeYAuto ? "auto" : scopeYScale}
                  trig={{ mode: trigMode, src: trigSrc, edge: trigEdge }}
                  level={trigLevel}
                  onLevelChange={(raw) => setTrigLevel(raw)}
                  armNonce={scopeArmNonce}
                />
              ) : profile && raw ? (
                <Scope
                  rawRef={t.rawRef}
                  sampleRateHz={profile.raw.sample_rate_hz}
                  blockSize={profile.raw.block_size}
                  fullscaleLsb={profile.raw.fullscale_lsb}
                />
              ) : (
                <RawUnavailable />
              )}
            </div>
            <div className="mt-2 flex items-center gap-3 text-xs text-muted">
              <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: "#3b82f6" }} />I</span>
              <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: "#f59e0b" }} />Q</span>
              <span>x: time [ms] · y: demod I/Q</span>
            </div>
          </Card>
        )}

        {tab === "fft" && (
          <Card>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-medium text-muted">Live FFT — EMI scout</h2>
              <div className="flex items-center gap-1">
                <span className="text-[11px] uppercase tracking-wide text-muted">span</span>
                {([50, 100, 200, "full"] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setFftSpan(s)}
                    className={`rounded border px-1.5 py-0.5 text-xs tabular-nums transition-colors ${
                      fftSpan === s ? "border-accent text-foreground" : "border-border text-muted hover:text-foreground"
                    }`}
                  >
                    {s === "full" ? "full" : `${s}Hz`}
                  </button>
                ))}
              </div>
            </div>
            <div className="h-[28rem] w-full">
              {t.hasIq ? (
                <IQSpectrum iRef={t.iqIRef} qRef={t.iqQRef} fsRef={t.iqFsRef} spanHz={fftSpan} />
              ) : profile && raw ? (
                <Spectrum
                  rawRef={t.rawRef}
                  sampleRateHz={profile.raw.sample_rate_hz}
                  blockSize={profile.raw.block_size}
                  fullscaleLsb={profile.raw.fullscale_lsb}
                />
              ) : (
                <RawUnavailable />
              )}
            </div>
            <div className="mt-2 flex items-center gap-3 text-xs text-muted">
              <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: "#3b82f6" }} />I</span>
              <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: "#f59e0b" }} />Q</span>
              <span>x: frequency [Hz] · y: |X| [dBFS] · Hann · dashed = peak</span>
            </div>
          </Card>
        )}

        {tab === "dsp" && (
          <Card>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setDspMode("live")}
                  className={`rounded border px-2 py-0.5 text-xs transition-colors ${
                    dspMode === "live" ? "border-accent text-foreground" : "border-border text-muted hover:text-foreground"
                  }`}
                >
                  live recorder
                </button>
                <button
                  onClick={() => setDspMode("theory")}
                  className={`rounded border px-2 py-0.5 text-xs transition-colors ${
                    dspMode === "theory" ? "border-accent text-foreground" : "border-border text-muted hover:text-foreground"
                  }`}
                >
                  filter analysis
                </button>
              </div>
              {dspMode === "live" && (
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex flex-wrap items-center gap-1">
                    {recChannels.map((c) => (
                      <button
                        key={c.key}
                        onClick={() => toggleRec(c.key)}
                        className={`rounded border px-1.5 py-0.5 text-xs transition-colors ${
                          recActive.has(c.key) ? "text-foreground" : "border-border text-muted hover:text-foreground"
                        }`}
                        style={recActive.has(c.key) ? { borderColor: c.color, color: c.color } : undefined}
                      >
                        {c.label}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-[11px] uppercase tracking-wide text-muted">win</span>
                    {[500, 1000, 2000, 5000, 10000].map((ms) => (
                      <button
                        key={ms}
                        onClick={() => setRecMs(ms)}
                        className={`rounded border px-1.5 py-0.5 text-xs tabular-nums transition-colors ${
                          recMs === ms ? "border-accent text-foreground" : "border-border text-muted hover:text-foreground"
                        }`}
                      >
                        {ms / 1000}s
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-[11px] uppercase tracking-wide text-muted">scale</span>
                    <button
                      onClick={() => setRecScaleMode("auto")}
                      className={`rounded border px-1.5 py-0.5 text-xs transition-colors ${
                        recScaleMode === "auto" ? "border-accent text-foreground" : "border-border text-muted hover:text-foreground"
                      }`}
                    >
                      auto
                    </button>
                    <button
                      onClick={() => setRecScaleMode("manual")}
                      className={`rounded border px-1.5 py-0.5 text-xs transition-colors ${
                        recScaleMode === "manual" ? "border-accent text-foreground" : "border-border text-muted hover:text-foreground"
                      }`}
                    >
                      lock
                    </button>
                    <button
                      onClick={() => { setRecScaleMode("manual"); setRecZoom((z) => Math.min(20, +(z * 1.4).toFixed(2))); }}
                      className="rounded border border-border px-1.5 py-0.5 text-xs text-muted hover:text-foreground"
                    >
                      +
                    </button>
                    <button
                      onClick={() => { setRecScaleMode("manual"); setRecZoom((z) => Math.max(0.05, +(z / 1.4).toFixed(2))); }}
                      className="rounded border border-border px-1.5 py-0.5 text-xs text-muted hover:text-foreground"
                    >
                      −
                    </button>
                    <span className="w-12 text-[11px] tabular-nums text-muted">
                      {recScaleMode === "auto" ? "auto" : `×${recZoom.toFixed(1)}`}
                    </span>
                  </div>
                </div>
              )}
            </div>
            {dspMode === "live" ? (
              <>
                <div className="h-[28rem] w-full">
                  {t.hasIq || feature ? (
                    <Recorder
                      trailRef={t.trailRef}
                      channels={recChannels}
                      active={recActive}
                      windowMs={recMs}
                      scaleMode={recScaleMode}
                      zoom={recZoom}
                    />
                  ) : (
                    <RawUnavailable />
                  )}
                </div>
                <p className="mt-2 text-xs text-muted">
                  x: time [ms] (0 = now) · each channel on its own axis (scale in the left gutter) ·
                  tap the coil = impulse to see the filter response
                </p>
              </>
            ) : (
              <FilterLab />
            )}
          </Card>
        )}

      </section>
    </main>
  );
}
