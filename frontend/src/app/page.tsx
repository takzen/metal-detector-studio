"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { FilterLab } from "@/components/FilterLab";
import { Hodograph } from "@/components/Hodograph";
import { PhaseLab } from "@/components/PhaseLab";
import { IQScope, type TrigMode, type TrigSrc } from "@/components/IQScope";
import { IQSpectrum, type SpectralPeak } from "@/components/IQSpectrum";
import {
  amplitudeSpectrum,
  binFreqs,
  binFreqsTwoSided,
  complexAmplitudeSpectrum,
  pow2Floor,
  type WindowType,
} from "@/lib/fft";
import { downloadCsv } from "@/lib/csv";
import { InfoPopover, CODE_CLS } from "@/components/InfoPopover";
import { IQWaterfall } from "@/components/IQWaterfall";
import { LinkPanel } from "@/components/LinkPanel";
import { Recorder, type RecChannel } from "@/components/Recorder";
import { Scope } from "@/components/Scope";
import { SourceControls } from "@/components/SourceControls";
import { RecordingControls } from "@/components/RecordingControls";
import { FirmwarePanel } from "@/components/FirmwarePanel";
import { CoilLab } from "@/components/CoilLab";
import { CoilDesigner } from "@/components/CoilDesigner";
import { Spectrum } from "@/components/Spectrum";
import { AdcSpectrum } from "@/components/AdcSpectrum";
import { useSwingPhase } from "@/lib/useSwingPhase";
import { colorFor } from "@/lib/palette";
import { usePersistentState } from "@/lib/usePersistentState";
import { useTelemetry, type ConnStatus } from "@/lib/useTelemetry";

const DEG = 180 / Math.PI;
const VERSION = "v0.12.0-beta";
const fmt = (n: number, d = 1) => n.toFixed(d);
const clamp180 = (d: number) => Math.max(-180, Math.min(180, d));
const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const VDI_COLOR = "#c99a52"; // matches the hodograph VDI sub-scale
const MODE_NAMES = ["DEEP", "DISC", "RELIC", "PIN", "PROS"]; // firmware M token (mode 0..4)
// Equivalent-noise-bandwidth factor per window (RBW = ENBW · fs/N).
const ENBW: Record<WindowType, number> = { rect: 1.0, hann: 1.5, hamming: 1.36, blackman: 1.73, flattop: 3.77 };
// TH is sent as THRESHOLD_AMP (DAC 0..1333) for the audio overlay; invert it back to the
// menu THRESHOLD value (0..200) for the readout. Mirrors firmware AUDIO_AMP_MAX/3 scale.
const THRESHOLD_DAC_FULL = 4000 / 3;
const thresholdMenu = (dac: number) => Math.round((dac * 200) / THRESHOLD_DAC_FULL);

type TabId = "hodograph" | "phase" | "scope" | "fft" | "adc" | "dsp" | "firmware" | "coil" | "design";
const TABS: { id: TabId; label: string }[] = [
  { id: "hodograph", label: "XY hodograph" },
  { id: "phase", label: "I/Q phase" },
  { id: "scope", label: "Oscilloscope" },
  { id: "fft", label: "Live FFT" },
  { id: "adc", label: "ADC scope" },
  { id: "dsp", label: "DSP" },
  { id: "firmware", label: "Firmware" },
  { id: "coil", label: "TX bench" },
  { id: "design", label: "Coil design" },
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

/**
 * Strongest spectral peaks as a fixed overlay (like the scope measurements):
 * always 6 rows + a Δ row, fixed-width columns + tabular-nums so values never
 * shift the layout. Missing peaks show "—".
 */
function PeaksTable({ peaks }: { peaks: SpectralPeak[] }) {
  const rows = Array.from({ length: 6 }, (_, i) => peaks[i]);
  const d = peaks.length >= 2 ? { df: Math.abs(peaks[0].f - peaks[1].f), ddb: peaks[0].db - peaks[1].db } : null;
  return (
    <div className="pointer-events-none absolute right-2 top-2 rounded border border-border bg-black/40 px-2 py-1 font-mono text-[11px] tabular-nums backdrop-blur-sm">
      <div className="grid grid-cols-[1rem_4rem_3rem] gap-x-2 gap-y-0.5">
        <span className="text-muted">#</span>
        <span className="text-right text-muted">Hz</span>
        <span className="text-right text-muted">dB</span>
        {rows.map((p, i) => (
          <Fragment key={i}>
            <span className="text-muted">{i + 1}</span>
            <span className={`text-right ${i === 0 ? "text-foreground" : "text-muted"}`}>{p ? p.f.toFixed(0) : "—"}</span>
            <span className={`text-right ${i === 0 ? "text-foreground" : "text-muted"}`}>{p ? p.db.toFixed(0) : "—"}</span>
          </Fragment>
        ))}
        <span className="text-accent">Δ</span>
        <span className="text-right text-accent">{d ? d.df.toFixed(0) : "—"}</span>
        <span className="text-right text-accent">{d ? d.ddb.toFixed(0) : "—"}</span>
      </div>
    </div>
  );
}

/**
 * A labeled control group rendered as a distinct boxed cluster: the label names
 * the parameter, the children are its value choices. Boxing + spacing keeps
 * groups from blending into one unreadable row of buttons.
 */
function Ctrl({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 rounded-md bg-black/20 px-2 py-1">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</span>
      <div className="flex items-center gap-0.5">{children}</div>
    </div>
  );
}

/** Toggles the browser Fullscreen API on the nearest `.card-max` ancestor. */
function MaxBtn() {
  return (
    <button
      onClick={(e) => {
        const card = (e.currentTarget as HTMLElement).closest(".card-max") as HTMLElement | null;
        if (!card) return;
        if (document.fullscreenElement) document.exitFullscreen();
        else card.requestFullscreen?.();
      }}
      title="maximize chart (Esc to exit)"
      className="rounded border border-border px-2 py-0.5 text-xs text-muted transition-colors hover:text-foreground"
    >
      ⛶
    </button>
  );
}

/**
 * Saves the first <canvas> inside the nearest `.card-max` ancestor as a PNG.
 * The chart canvases are transparent (the panel background is CSS, not painted
 * on the canvas), so we composite the capture onto an opaque panel-coloured
 * canvas first — otherwise the export looks empty on a transparent background.
 */
function PngBtn({ name }: { name: string }) {
  return (
    <button
      onClick={(e) => {
        const card = (e.currentTarget as HTMLElement).closest(".card-max");
        const src = card?.querySelector("canvas") as HTMLCanvasElement | null;
        if (!src) return;
        const out = document.createElement("canvas");
        out.width = src.width;
        out.height = src.height;
        const ctx = out.getContext("2d");
        if (!ctx) return;
        const panel = getComputedStyle(document.documentElement).getPropertyValue("--panel").trim();
        ctx.fillStyle = panel || "#11151c";
        ctx.fillRect(0, 0, out.width, out.height);
        ctx.drawImage(src, 0, 0);
        const a = document.createElement("a");
        a.download = `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
        a.href = out.toDataURL("image/png");
        a.click();
      }}
      title="save chart as PNG"
      className="rounded border border-border px-2 py-0.5 text-xs text-muted transition-colors hover:text-foreground"
    >
      PNG
    </button>
  );
}

/**
 * Saves chart data as CSV. `build` returns the rows (header + data) at click time,
 * or null when there's nothing to export (empty buffer / no channels).
 */
function CsvBtn({ name, build }: { name: string; build: () => (string | number)[][] | null }) {
  return (
    <button
      onClick={() => {
        const rows = build();
        if (rows && rows.length > 1) downloadCsv(name, rows);
      }}
      title="save data as CSV"
      className="rounded border border-border px-2 py-0.5 text-xs text-muted transition-colors hover:text-foreground"
    >
      CSV
    </button>
  );
}

/** A segmented choice / toggle button (active = accent-highlighted). */
function Seg({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`rounded border px-1.5 py-0.5 text-xs tabular-nums transition-colors ${
        active ? "border-accent text-foreground" : "border-border text-muted hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

/** Frequency tick strip under the waterfall (canvas has no left gutter: 0 = left edge). */
function FreqAxis({ maxFreq }: { maxFreq: number }) {
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * maxFreq));
  return (
    <div className="mt-1 flex justify-between font-mono text-[10px] tabular-nums text-muted">
      {ticks.map((hz, i) => (
        <span key={i}>{hz}</span>
      ))}
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
  const { profile, feature, raw, stats, link, featureRef } = t;
  // amber dot on the collapsed "link" header button when something's off
  const linkSawData = link.feature.recv > 0 || link.iq.samplesPerSec > 0;
  const linkWarn =
    link.feature.drops > 0 ||
    (link.serial?.badTotal ?? 0) > 0 ||
    (link.schema?.bad ?? 0) > 0 ||
    (t.status === "open" && linkSawData && link.ageMs > 1500);
  // Persisted UI prefs (localStorage) — survive reload. Transient run-state
  // (run/hold, pause, nonces) stays plain useState so it always starts fresh.
  const [tab, setTab] = usePersistentState<TabId>("tab", "hodograph");
  const [showLink, setShowLink] = usePersistentState("showLink", false); // link-quality panel
  const [zeroNonce, setZeroNonce] = useState(0);
  const [scopeMs, setScopeMs] = usePersistentState("scopeMs", 500); // oscilloscope timebase (window)
  const [scopeRun, setScopeRun] = useState(true); // run / hold
  const [scopeYAuto, setScopeYAuto] = usePersistentState("scopeYAuto", true);
  const [scopeYScale, setScopeYScale] = usePersistentState("scopeYScale", 8000); // manual vertical full-scale
  const [trigMode, setTrigMode] = usePersistentState<TrigMode>("trigMode", "off"); // off = free-running roll
  const [trigSrc, setTrigSrc] = usePersistentState<TrigSrc>("trigSrc", "mag"); // |IQ| rising = target approach
  const [trigEdge, setTrigEdge] = usePersistentState<"rising" | "falling">("trigEdge", "rising");
  const [trigLevel, setTrigLevel] = usePersistentState<number | "auto">("trigLevel", "auto"); // "auto" = above-noise; number = manual raw (draggable)
  const [scopeArmNonce, setScopeArmNonce] = useState(0); // bump to (re)arm single-shot
  const [fftSpan, setFftSpan] = usePersistentState<number | "full">("fftSpan", "full"); // FFT frequency span [Hz]
  const [fftView, setFftView] = usePersistentState<"line" | "waterfall" | "both">("fftView", "line"); // FFT display
  const [fftMaxHold, setFftMaxHold] = usePersistentState("fftMaxHold", false); // overlay per-bin max
  const [fftAvg, setFftAvg] = usePersistentState("fftAvg", 8); // EMA averaging length (1 = off); ≥8 = stable noise floor
  const [fftMains, setFftMains] = usePersistentState("fftMains", false); // 50 Hz mains reference lines
  const [fftPeaksOn, setFftPeaksOn] = usePersistentState("fftPeaksOn", false); // peak table
  const [fftPeaks, setFftPeaks] = useState<SpectralPeak[]>([]); // transient: live top-N peaks
  const [fftWindow, setFftWindow] = usePersistentState<WindowType>("fftWindow", "hann"); // FFT window
  const [fftDbFloor, setFftDbFloor] = usePersistentState("fftDbFloor", -100); // bottom of dB scale
  const [fftComplex, setFftComplex] = usePersistentState("fftComplex", false); // two-sided FFT of I+jQ (±f)
  const [recMs, setRecMs] = usePersistentState("recMs", 2000); // DSP recorder window
  const [recActiveArr, setRecActiveArr] = usePersistentState<string[]>("recActive", ["audio", "threshold"]);
  const recActive = useMemo(() => new Set(recActiveArr), [recActiveArr]);
  const [recScaleMode, setRecScaleMode] = usePersistentState<"auto" | "manual">("recScaleMode", "auto"); // recorder lane scaling
  const [recZoom, setRecZoom] = usePersistentState("recZoom", 1); // manual lane zoom factor
  const [recPaused, setRecPaused] = useState(false); // recorder freeze (play/stop)
  const [dspMode, setDspMode] = usePersistentState<"live" | "theory">("dspMode", "live");
  const [offsetDeg, setOffsetDeg] = usePersistentState("offsetDeg", 0); // demodulator phase offset (colour overlay)
  const [persistence, setPersistence] = usePersistentState("persistence", true); // hodograph phosphor trail
  const [ema, setEma] = usePersistentState("ema", 0.3); // hodograph live-vector smoothing factor
  // Plot-zero reference per harmonic, captured when the hodograph "zero" is pressed.
  // Lets the cards show the delta vector since that zero — exactly what the plot draws.
  // State (not a ref) so reading it in render is valid and a new zero re-renders the cards.
  const [zeroBase, setZeroBase] = useState<Record<string, { i: number; q: number }>>({});
  // Zero now: snapshot the current vector as the plot-zero reference (cards' Δ rows) and bump
  // the nonce the hodograph watches for its own zero. Done in the handler (not an effect) so it
  // reads the latest frame at click time — idiomatic, no cascading renders.
  const zeroNow = useCallback(() => {
    const fr = featureRef.current;
    if (fr) {
      const base: Record<string, { i: number; q: number }> = {};
      for (const id in fr.harmonics) base[id] = { i: fr.harmonics[id].i, q: fr.harmonics[id].q };
      setZeroBase(base);
    }
    setZeroNonce((n) => n + 1);
  }, [featureRef]);

  // SwingTune: phase mode for the hodograph readout — "live" (instantaneous delta phase)
  // or "swing" (SERVICE1-style: median phase of detected swing peaks, ±90°).
  const [hodoPhase, setHodoPhase] = usePersistentState<"live" | "swing">("hodoPhase", "live");
  const h0id = profile?.harmonics[0]?.id;
  const swing = useSwingPhase(t.trailRef, h0id, h0id ? zeroBase[h0id] : undefined, hodoPhase === "swing");
  // Factory ground-balance reference line on the hodograph (0..5°), nudged by buttons.
  const [groundDeg, setGroundDeg] = usePersistentState("hodoGroundDeg", 0);
  const nudgeGround = (d: number) => setGroundDeg((v) => Math.max(0, Math.min(5, Number((v + d).toFixed(1)))));

  const recChannels = useMemo<RecChannel[]>(
    () => [
      { key: "audio", label: "audio", color: "#10b981", lane: "aud", range: [0, 4000], get: (f) => { const a = f.extras.audio; return a == null ? undefined : Math.max(0, Math.min(4000, a)); } },
      { key: "threshold", label: "threshold", color: "#ef4444", lane: "aud", range: [0, 4000], get: (f) => { const a = f.extras.threshold; return a == null ? undefined : Math.max(0, Math.min(4000, a)); } },
      { key: "ground", label: "ground", color: "#a855f7", get: (f) => f.extras.ground },
      // I/Q = post-filter output of the active mode (FX/FY); falls back to raw hodograph I/Q on old firmware.
      // Separate lanes so each has its own axis + zero baseline (not a shared I/Q scale).
      { key: "I", label: "I (filt)", color: "#3b82f6", get: (f) => f.extras.fx ?? Object.values(f.harmonics)[0]?.i },
      { key: "Q", label: "Q (filt)", color: "#22d3ee", get: (f) => f.extras.fy ?? Object.values(f.harmonics)[0]?.q },
    ],
    [],
  );

  const toggleRec = (k: string) =>
    setRecActiveArr((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));

  // FFT resolution bandwidth (display only): RBW = ENBW(window) · fs/N.
  const fftN = pow2Floor(t.iqIRef.current?.length ?? 0);
  const fftFs = t.iqFsRef.current || 0;
  const fftRbw = fftN > 0 && fftFs > 0 ? (ENBW[fftWindow] * fftFs) / fftN : 0;

  // CSV builders (called at click time so they snapshot the current buffer/settings).
  // FFT: recompute the displayed spectrum from the I/Q buffer (mirrors IQSpectrum:
  // dBFS ref 32768, DC removed). Recorder: the trail's active channels over time.
  const buildFftCsv = (): (string | number)[][] | null => {
    const ib = t.iqIRef.current;
    const qb = t.iqQRef.current;
    const fs = t.iqFsRef.current || 1000;
    const n = pow2Floor(ib.length);
    if (n < 32) return null;
    const toDb = (a: number) => (20 * Math.log10(a / 32768 + 1e-9)).toFixed(2);
    if (fftComplex) {
      const amp = complexAmplitudeSpectrum(ib.slice(ib.length - n), qb.slice(qb.length - n), fftWindow, true);
      const freqs = binFreqsTwoSided(fs, n);
      const rows: (string | number)[][] = [["freq_hz", "db"]];
      for (let k = 0; k < amp.length; k++) rows.push([freqs[k].toFixed(3), toDb(amp[k])]);
      return rows;
    }
    const ai = amplitudeSpectrum(ib.slice(ib.length - n), fftWindow, true);
    const aq = amplitudeSpectrum(qb.slice(qb.length - n), fftWindow, true);
    const freqs = binFreqs(fs, n);
    const rows: (string | number)[][] = [["freq_hz", "I_db", "Q_db"]];
    for (let k = 0; k < ai.length; k++) rows.push([freqs[k].toFixed(3), toDb(ai[k]), toDb(aq[k])]);
    return rows;
  };
  const buildRecCsv = (): (string | number)[][] | null => {
    const trail = t.trailRef.current;
    if (!trail.length) return null;
    const cols = recChannels.filter((c) => recActive.has(c.key));
    if (!cols.length) return null;
    const t0 = trail[0].t;
    const rows: (string | number)[][] = [["t_s", "seq", ...cols.map((c) => c.label)]];
    for (const f of trail) {
      const row: (string | number)[] = [(f.t - t0).toFixed(4), f.seq];
      for (const c of cols) {
        const v = c.get(f);
        row.push(v == null ? "" : v);
      }
      rows.push(row);
    }
    return rows;
  };

  // Keyboard shortcuts (ignored while typing in a control):
  //  1..N — switch tabs · Enter/Z — zero the hodograph · Space — run/hold (scope) or play/stop (DSP)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && ["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(el.tagName)) return;
      const num = Number(e.key);
      if (Number.isInteger(num) && num >= 1 && num <= TABS.length) {
        setTab(TABS[num - 1].id);
        return;
      }
      if (e.key === "Enter" || e.key.toLowerCase() === "z") {
        zeroNow();
        return;
      }
      if (e.key === " " || e.code === "Space") {
        e.preventDefault(); // don't scroll the page
        if (tab === "scope") setScopeRun((v) => !v);
        else if (tab === "dsp" && dspMode === "live") setRecPaused((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab, dspMode, setTab, setScopeRun, setRecPaused, zeroNow]);

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
            <button
              onClick={() => setShowLink((v) => !v)}
              title="link quality: throughput, drops, jitter, real vs declared rate, serial parse errors"
              className="flex w-16 flex-col text-left"
            >
              <span className="text-[11px] uppercase tracking-wide text-muted">link</span>
              <span className="inline-flex items-center gap-1 font-mono text-sm">
                {linkWarn && <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" />}
                <span className={linkWarn ? "text-amber-400" : "text-muted"}>{showLink ? "hide" : "show"}</span>
              </span>
            </button>
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
          <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
            <SourceControls />
            <RecordingControls />
          </div>
        </div>
        {showLink && <LinkPanel link={link} profile={profile} status={t.status} />}
      </header>

      {/* Active view */}
      <section className="mt-6">
        {tab === "hodograph" && (
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="card-max flex flex-col">
              <div className="mb-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h2 className="text-sm font-medium text-muted">XY hodograph</h2>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2 text-xs">
                      {profile?.harmonics.map((h, i) => (
                        <span key={h.id} className="inline-flex items-center gap-1.5">
                          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: colorFor(i) }} />
                          <span className="font-mono">{h.id}</span>
                        </span>
                      ))}
                    </div>
                    <PngBtn name="hodograph" />
                    <InfoPopover title="Reading the hodograph">
                      <p>
                        Each vector is a harmonic&apos;s delta I/Q from the centre (the zero): length =
                        signal magnitude, direction = phase.
                      </p>
                      <p>
                        Rim protractor = phase <code className={CODE_CLS}>atan2(Q,I)</code>; 0° sits on the
                        LEFT (mirrored X, matching the device). Top arc 0…+180°, bottom −180…0°.
                      </p>
                      <p>
                        The gold <span className="text-foreground">VDI</span> sub-scale = phase − 90°.
                      </p>
                      <p>
                        <span className="text-foreground">offset</span> is a demodulator phase offset — a
                        colour overlay only; it does not move the grid or change any readout.{" "}
                        <span className="text-foreground">persist</span> = phosphor trail,{" "}
                        <span className="text-foreground">EMA</span> = live-vector smoothing.
                      </p>
                      <p>
                        <span className="text-foreground">zero</span> (Enter / Z) recenters the plot on the
                        current vector — display only.
                      </p>
                    </InfoPopover>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={zeroNow}
                    title="zero now: snap the centre to the current raw vector (keyboard: Enter or Z). Studio-side zero — the delta is computed here from raw."
                    className="rounded-md border border-accent/60 bg-accent/10 px-3 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent/20"
                  >
                    zero (Enter)
                  </button>
                  <Ctrl label="offset">
                    <span className="w-11 text-right font-mono text-xs tabular-nums text-foreground">
                      {offsetDeg >= 0 ? "+" : ""}
                      {offsetDeg.toFixed(1)}°
                    </span>
                    {[-0.3, 0.3].map((d) => (
                      <Seg
                        key={d}
                        active={false}
                        onClick={() => setOffsetDeg((v) => clamp180(Number((v + d).toFixed(1))))}
                        title="demodulator phase offset — colour overlay (the grid stays unchanged)"
                      >
                        {d > 0 ? `+${d}` : d}
                      </Seg>
                    ))}
                    <Seg active={false} onClick={() => setOffsetDeg(0)} title="reset offset to 0°">
                      0
                    </Seg>
                  </Ctrl>
                  <Ctrl label="trail">
                    <Seg
                      active={persistence}
                      onClick={() => setPersistence((v) => !v)}
                      title="persistence / phosphor: density trail of the raw I/Q samples"
                    >
                      persist
                    </Seg>
                  </Ctrl>
                  <Ctrl label="EMA">
                    <input
                      type="range"
                      min={0.01}
                      max={1}
                      step={0.01}
                      value={ema}
                      onChange={(e) => setEma(Number(e.target.value))}
                      title="live-vector smoothing: lower = smoother/slower, higher = faster"
                      className="w-24 accent-[#22d3ee]"
                    />
                    <span className="w-9 text-right font-mono text-xs tabular-nums text-foreground">
                      {ema.toFixed(2)}
                    </span>
                  </Ctrl>
                  <Ctrl label="SwingTune">
                    <Seg active={hodoPhase === "live"} onClick={() => setHodoPhase("live")}>
                      live
                    </Seg>
                    <Seg active={hodoPhase === "swing"} onClick={() => setHodoPhase("swing")}>
                      swing
                    </Seg>
                    <InfoPopover title="SwingTune — phase from coil swings">
                      <p>
                        <b>live</b> = instantaneous delta phase (±180°): the current vector vs the
                        studio zero, on every frame.
                      </p>
                      <p>
                        <b>swing</b> = SERVICE1-style automat. It watches the delta while you swing the
                        coil, captures each swing&apos;s <b>peak</b>, takes its phase{" "}
                        <code className={CODE_CLS}>atan2(dy, |dx|)</code> (±90°, ferrite at 0°), and
                        shows the <b>median</b> of the last 10 swings. Holds between swings; a new zero
                        clears the series.
                      </p>
                      <p>
                        A swing only counts if its peak <code className={CODE_CLS}>|dx|+|dy|</code>{" "}
                        clears the target threshold — noise doesn&apos;t register.{" "}
                        <span className="text-foreground">n</span> = swings counted.
                      </p>
                    </InfoPopover>
                  </Ctrl>
                  <Ctrl label="ground">
                    <span
                      className="w-10 text-right font-mono text-xs tabular-nums"
                      style={{ color: "#c2410c" }}
                    >
                      {groundDeg.toFixed(1)}°
                    </span>
                    {[-0.1, 0.1].map((d) => (
                      <Seg
                        key={d}
                        active={false}
                        onClick={() => nudgeGround(d)}
                        title="move the factory ground-balance line (0–5°)"
                      >
                        {d > 0 ? `+${d}` : d}
                      </Seg>
                    ))}
                    <Seg active={false} onClick={() => setGroundDeg(0)} title="reset ground line to 0°">
                      0
                    </Seg>
                  </Ctrl>
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
                    groundDeg={groundDeg}
                  />
                )}
                {/* large, readable phase-angle readout (smoothed) */}
                <div className="pointer-events-none absolute left-3 top-2 flex flex-col gap-0.5">
                  {hodoPhase === "swing" ? (
                    <>
                      <span
                        className="font-mono text-3xl leading-none tabular-nums"
                        style={{ color: colorFor(0) }}
                      >
                        {swing.phase === null ? "—" : swing.phase.toFixed(1)}°
                      </span>
                      <span className="font-mono text-xs text-muted">swing · n={swing.count}</span>
                    </>
                  ) : (
                    profile?.harmonics.map((h, i) => {
                      const s = feature?.harmonics[h.id];
                      const z = zeroBase[h.id];
                      const di = s ? s.i - (z?.i ?? 0) : null;
                      const dq = s ? s.q - (z?.q ?? 0) : null;
                      const deg = di != null && dq != null ? Math.atan2(dq, di) * DEG : null; // -180..+180
                      return (
                        <span
                          key={h.id}
                          className="font-mono text-3xl leading-none tabular-nums"
                          style={{ color: colorFor(i) }}
                        >
                          {deg === null ? "—" : deg.toFixed(1)}°
                        </span>
                      );
                    })
                  )}
                </div>
                {/* large VDI readout (mirror of the phase readout, top-right) */}
                <div className="pointer-events-none absolute right-3 top-2 flex flex-col items-end gap-0.5">
                  {hodoPhase === "swing" ? (
                    <span
                      className="font-mono text-3xl leading-none tabular-nums"
                      style={{ color: VDI_COLOR }}
                    >
                      {swing.phase === null ? "—" : wrap180(swing.phase - 90).toFixed(1)}
                    </span>
                  ) : (
                    profile?.harmonics.map((h) => {
                      const s = feature?.harmonics[h.id];
                      const z = zeroBase[h.id];
                      const di = s ? s.i - (z?.i ?? 0) : null;
                      const dq = s ? s.q - (z?.q ?? 0) : null;
                      const vdi = di != null && dq != null ? wrap180(Math.atan2(dq, di) * DEG - 90) : null;
                      return (
                        <span
                          key={h.id}
                          className="font-mono text-3xl leading-none tabular-nums"
                          style={{ color: VDI_COLOR }}
                        >
                          {vdi === null ? "—" : vdi.toFixed(1)}
                        </span>
                      );
                    })
                  )}
                </div>
              </div>
            </Card>

            <div className="flex flex-col gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                {profile?.harmonics.map((h, i) => {
                  const s = feature?.harmonics[h.id];
                  // delta vs the plot zero (matches the hodograph vector); no zero set → base 0
                  const z = zeroBase[h.id];
                  const dI = s ? s.i - (z?.i ?? 0) : null;
                  const dQ = s ? s.q - (z?.q ?? 0) : null;
                  const dMag = dI != null && dQ != null ? Math.hypot(dI, dQ) : null;
                  const dPhase = dI != null && dQ != null ? Math.atan2(dQ, dI) * DEG : null;
                  return (
                    <Card key={h.id}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-2 font-mono">
                          <span
                            className="h-2.5 w-2.5 rounded-full"
                            style={{ backgroundColor: colorFor(i) }}
                          />
                          {h.id}
                        </span>
                        <span className="inline-flex items-center gap-1.5">
                          <span className="text-xs text-muted">
                            h{h.index} · {(h.freq_hz / 1000).toFixed(4)} kHz
                          </span>
                          <InfoPopover title="Where these values come from">
                            <p>
                              <span className="font-mono text-foreground">I / Q</span> = raw{" "}
                              <code className={CODE_CLS}>X/Y</code> (SERVICE Xr/Yr) minus the studio zero —
                              the delta the hodograph draws. The device&apos;s own DX/DY is not used.
                            </p>
                            <p>
                              <span className="font-mono text-foreground">mag</span> = √(I²+Q²) ·{" "}
                              <span className="font-mono text-foreground">phase</span> = atan2(Q, I).
                            </p>
                            <p>
                              Press <span className="text-foreground">zero</span> (Enter / Z) to set the
                              reference; values are smoothed (EMA) for readability.
                            </p>
                          </InfoPopover>
                        </span>
                      </div>
                      <div className="mt-3">
                        <div className="mb-1 text-[10px] uppercase tracking-wide text-muted">raw (absolute, Xr/Yr)</div>
                        <div className="grid grid-cols-2 gap-y-2">
                          <Stat label="mag" value={s ? fmt(s.mag) : "—"} />
                          <Stat label="phase" value={s ? `${fmt(s.phase * DEG)}°` : "—"} />
                          <Stat label="I" value={s ? fmt(s.i) : "—"} />
                          <Stat label="Q" value={s ? fmt(s.q) : "—"} />
                        </div>
                      </div>
                      <div className="mt-2 border-t border-border pt-2">
                        <div className="mb-1 text-[10px] uppercase tracking-wide text-muted">delta (vs zero)</div>
                        <div className="grid grid-cols-2 gap-y-2">
                          <Stat label="mag" value={dMag != null ? fmt(dMag) : "—"} />
                          <Stat label="phase" value={dPhase != null ? `${fmt(dPhase)}°` : "—"} />
                          <Stat label="I" value={dI != null ? fmt(dI) : "—"} />
                          <Stat label="Q" value={dQ != null ? fmt(dQ) : "—"} />
                        </div>
                      </div>
                    </Card>
                  );
                })}
              </div>

              <Card>
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h2 className="text-sm font-medium text-muted">Phase diffs</h2>
                  <InfoPopover title="Phase diffs">
                    <p>
                      Differences between harmonics&apos; phases, in degrees — a multi-frequency
                      discrimination cue (a target&apos;s phase shifts differently per frequency).
                    </p>
                    <p>
                      Each diff is defined by the active profile (<code className={CODE_CLS}>from → to</code>).
                      Single-frequency profiles have none.
                    </p>
                  </InfoPopover>
                </div>
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
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h2 className="text-sm font-medium text-muted">Extras</h2>
                  <InfoPopover title="Extras (firmware fields)">
                    <p>Extra per-frame fields the firmware sends (only those present show up):</p>
                    <p>
                      <span className="text-foreground">audio / threshold</span> — audio output and its
                      self-adjusting threshold (DAC 0–4000; threshold shown rescaled to the menu 0–200).
                    </p>
                    <p>
                      <span className="text-foreground">ground / kgnd</span> — ground-balance tracking value
                      / coefficient · <span className="text-foreground">mode</span> — active program
                      (DEEP/DISC/RELIC/PIN/PROS).
                    </p>
                    <p>
                      <span className="text-foreground">fx / fy</span> — I/Q after the active mode&apos;s
                      filter (what the recorder plots) · <span className="text-foreground">px / py</span>,{" "}
                      <span className="text-foreground">x_raw / y_raw</span> — device PX/PY and raw pre-zero
                      X/Y · <span className="text-foreground">vdi</span> — device VDI.
                    </p>
                    <p>
                      Tokens on the wire: <code className={CODE_CLS}>A TH G K M FX FY PX PY X Y VDI</code>.
                    </p>
                  </InfoPopover>
                </div>
                {feature && Object.keys(feature.extras).length ? (
                  <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
                    {Object.entries(feature.extras).map(([k, v]) => (
                      <Stat
                        key={k}
                        label={k}
                        value={
                          k === "mode"
                            ? (MODE_NAMES[Math.round(v)] ?? String(Math.round(v)))
                            : k === "threshold"
                            ? String(thresholdMenu(v))
                            : fmt(v, 2)
                        }
                      />
                    ))}
                  </div>
                ) : (
                  <span className="text-sm text-muted">none</span>
                )}
              </Card>
            </div>
          </div>
        )}

        {tab === "phase" && (
          <Card className="card-max flex flex-col">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-sm font-medium text-muted">I/Q phase — axis auto-calibration (sandbox)</h2>
              <div className="flex items-center gap-1">
                <InfoPopover title="I/Q axis auto-calibration">
                  <p>
                    A model (sliders, no live data): the physical I/Q channels are the true vector rotated
                    by an unknown axis angle <span className="text-foreground">θ</span> (drifts with
                    frequency / temperature).
                  </p>
                  <p>
                    With no metal the probe sits on the true X axis, so{" "}
                    <code className={CODE_CLS}>atan2(Y′,X′)</code> of that reading recovers θ
                    (air-balance). Applying the inverse 2×2 rotation R(−θ) brings the signal back to the
                    true frame; then phase = <code className={CODE_CLS}>atan2(Y,X)</code> drives
                    discrimination.
                  </p>
                  <p>
                    Left plot = physical (rotated), right = corrected. After “measure θ” the corrected
                    plot lines up and “detector reads” the true phase.
                  </p>
                </InfoPopover>
                <MaxBtn />
              </div>
            </div>
            <PhaseLab featureRef={featureRef} harmonics={profile?.harmonics ?? []} />
          </Card>
        )}

        {tab === "scope" && (
          <Card className="card-max">
            <div className="mb-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h2 className="text-sm font-medium text-muted">Virtual oscilloscope — {t.hasIq ? "demod I/Q" : "raw RX"}</h2>
                <div className="flex items-center gap-1">
                  <InfoPopover title="Virtual oscilloscope">
                    <p>
                      Plots the rolling sample buffer over time: demod{" "}
                      <span className="text-foreground">I</span> (blue) /{" "}
                      <span className="text-foreground">Q</span> (amber) at the device sample rate (TAKTYK
                      ~1 kHz), or raw RX if the device streams raw ADC blocks.
                    </p>
                    <p>
                      x = time [ms], y = amplitude [LSB]. <span className="text-foreground">time</span> =
                      window length, <span className="text-foreground">volts</span> = vertical full-scale
                      (auto or manual zoom).
                    </p>
                    <p>
                      <span className="text-foreground">trig</span> (off/auto/normal/single) freezes a sweep
                      on an edge of I/Q/|IQ|; level is auto or draggable. Tap the coil to see a target&apos;s
                      I/Q transient.
                    </p>
                  </InfoPopover>
                  <PngBtn name="oscilloscope" />
                  <MaxBtn />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Ctrl label="time">
                  {[50, 100, 200, 500, 1000, 2000].map((ms) => (
                    <Seg key={ms} active={scopeMs === ms} onClick={() => setScopeMs(ms)}>
                      {ms < 1000 ? `${ms}m` : `${ms / 1000}s`}
                    </Seg>
                  ))}
                </Ctrl>
                <Ctrl label="volts">
                  <Seg active={scopeYAuto} onClick={() => setScopeYAuto((v) => !v)}>
                    auto
                  </Seg>
                  <Seg
                    active={false}
                    onClick={() => { setScopeYAuto(false); setScopeYScale((s) => Math.max(50, Math.round(s / 2))); }}
                    title="zoom in (smaller full-scale)"
                  >
                    +
                  </Seg>
                  <Seg
                    active={false}
                    onClick={() => { setScopeYAuto(false); setScopeYScale((s) => Math.min(2_000_000, s * 2)); }}
                    title="zoom out (larger full-scale)"
                  >
                    −
                  </Seg>
                  <span className="w-16 text-[11px] tabular-nums text-muted">
                    {scopeYAuto ? "auto" : `±${scopeYScale >= 1000 ? (scopeYScale / 1000).toFixed(1) + "k" : scopeYScale}`}
                  </span>
                </Ctrl>
                <button
                  onClick={() => setScopeRun((v) => !v)}
                  className={`w-20 shrink-0 rounded-md border px-3 py-1 text-center text-xs font-medium transition-colors ${
                    scopeRun
                      ? "border-border text-muted hover:text-foreground"
                      : "border-amber-500 bg-amber-500/10 text-amber-400"
                  }`}
                >
                  {scopeRun ? "⏸ hold" : "▶ run"}
                </button>
                <Ctrl label="trig">
                  {(["off", "auto", "normal", "single"] as const).map((m) => (
                    <Seg
                      key={m}
                      active={trigMode === m}
                      onClick={() => {
                        setTrigMode(m);
                        if (m === "single") setScopeArmNonce((n) => n + 1);
                      }}
                    >
                      {m === "normal" ? "norm" : m}
                    </Seg>
                  ))}
                </Ctrl>
                {trigMode !== "off" && (
                  <>
                    <Ctrl label="src">
                      {(["I", "Q", "mag"] as const).map((s) => (
                        <Seg key={s} active={trigSrc === s} onClick={() => setTrigSrc(s)}>
                          {s === "mag" ? "|IQ|" : s}
                        </Seg>
                      ))}
                    </Ctrl>
                    <Ctrl label="edge">
                      <Seg
                        active={false}
                        onClick={() => setTrigEdge((e) => (e === "rising" ? "falling" : "rising"))}
                        title="toggle trigger edge (rising / falling)"
                      >
                        {trigEdge === "rising" ? "↑ rise" : "↓ fall"}
                      </Seg>
                    </Ctrl>
                    <Ctrl label="lvl">
                      <Seg active={trigLevel === "auto"} onClick={() => setTrigLevel("auto")}>
                        auto
                      </Seg>
                      <span className="text-[11px] tabular-nums text-muted">
                        {trigLevel === "auto" ? "↕ drag line" : `man ${Math.round(trigLevel)}`}
                      </span>
                      {trigMode === "single" && (
                        <Seg
                          active={false}
                          onClick={() => setScopeArmNonce((n) => n + 1)}
                          title="re-arm single-shot capture"
                        >
                          ↻ arm
                        </Seg>
                      )}
                    </Ctrl>
                  </>
                )}
              </div>
            </div>
            <div className="chart-fill h-[28rem] w-full">
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
          <Card className="card-max">
            <div className="mb-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h2 className="text-sm font-medium text-muted">Live FFT — EMI scout</h2>
                <div className="flex items-center gap-1">
                  <InfoPopover title="Live FFT (EMI scout)">
                    <p>
                      FFT of the baseband I/Q buffer → spectrum in{" "}
                      <span className="text-foreground">dBFS</span>. The working frequencies are RF carriers
                      (not present in baseband), so only EMI / hum (e.g. 50 Hz mains) shows here.
                    </p>
                    <p>
                      <span className="text-foreground">window</span> trades resolution vs spectral leakage;{" "}
                      <span className="text-foreground">RBW</span> = ENBW(window)·fs/N (in the legend).
                    </p>
                    <p>
                      <span className="text-foreground">waterfall</span> = the same spectrum over time
                      (newest on top), colour = |X| dBFS. <span className="text-foreground">max-hold</span> /{" "}
                      <span className="text-foreground">avg</span> help catch or smooth interferers.
                    </p>
                  </InfoPopover>
                  {t.hasIq && <CsvBtn name="fft-spectrum" build={buildFftCsv} />}
                  <PngBtn name="fft" />
                  <MaxBtn />
                </div>
              </div>
              {t.hasIq && (
                <div className="flex flex-wrap items-center gap-2">
                  <Ctrl label="view">
                    {(["line", "waterfall", "both"] as const).map((v) => (
                      <Seg key={v} active={fftView === v} onClick={() => setFftView(v)}>
                        {v === "waterfall" ? "fall" : v}
                      </Seg>
                    ))}
                  </Ctrl>
                  <Ctrl label="span">
                    {([50, 100, 200, "full"] as const).map((s) => (
                      <Seg key={s} active={fftSpan === s} onClick={() => setFftSpan(s)}>
                        {s === "full" ? "full" : `${s}Hz`}
                      </Seg>
                    ))}
                  </Ctrl>
                  <Ctrl label="win">
                    {([
                      ["rect", "rect"],
                      ["hann", "hann"],
                      ["hamming", "hamm"],
                      ["blackman", "black"],
                      ["flattop", "flat"],
                    ] as [WindowType, string][]).map(([val, label]) => (
                      <Seg
                        key={val}
                        active={fftWindow === val}
                        onClick={() => setFftWindow(val)}
                        title="FFT window — resolution vs spectral leakage (flat-top = best amplitude accuracy)"
                      >
                        {label}
                      </Seg>
                    ))}
                  </Ctrl>
                  <Ctrl label="dB">
                    {[-60, -80, -100, -120].map((f) => (
                      <Seg
                        key={f}
                        active={fftDbFloor === f}
                        onClick={() => setFftDbFloor(f)}
                        title="bottom of the dB scale (visible dynamic range)"
                      >
                        {f}
                      </Seg>
                    ))}
                  </Ctrl>
                  {fftView !== "waterfall" && (
                    <>
                      <Ctrl label="mode">
                        <Seg
                          active={!fftComplex}
                          onClick={() => setFftComplex(false)}
                          title="separate real spectra of I and Q (each symmetric)"
                        >
                          I/Q
                        </Seg>
                        <Seg
                          active={fftComplex}
                          onClick={() => setFftComplex(true)}
                          title="two-sided FFT of I+jQ: keeps the side of the carrier (±f) and reveals quadrature imbalance"
                        >
                          ±f
                        </Seg>
                      </Ctrl>
                      <Ctrl label="avg">
                        {[1, 4, 8, 16].map((n) => (
                          <Seg
                            key={n}
                            active={fftAvg === n}
                            onClick={() => setFftAvg(n)}
                            title="exponential averaging — smooths the noise floor"
                          >
                            {n === 1 ? "off" : `×${n}`}
                          </Seg>
                        ))}
                      </Ctrl>
                      <Ctrl label="overlay">
                        <Seg
                          active={fftMaxHold}
                          onClick={() => setFftMaxHold((v) => !v)}
                          title="max-hold: running per-bin maximum (catches short interferers). Click again to clear."
                        >
                          max-hold
                        </Seg>
                        <Seg
                          active={fftMains}
                          onClick={() => setFftMains((v) => !v)}
                          title="reference lines at 50 Hz mains harmonics (spot hum in the baseband I/Q)"
                        >
                          mains
                        </Seg>
                        <Seg
                          active={fftPeaksOn}
                          onClick={() => setFftPeaksOn((v) => !v)}
                          title="list the strongest spectral peaks (unstable — experimental)"
                        >
                          peaks
                        </Seg>
                      </Ctrl>
                    </>
                  )}
                </div>
              )}
            </div>
            {t.hasIq ? (
              <>
                {(fftView === "line" || fftView === "both") && (
                  <div className={`chart-fill relative w-full ${fftView === "both" ? "h-[15rem]" : "h-[28rem]"}`}>
                    <IQSpectrum iRef={t.iqIRef} qRef={t.iqQRef} fsRef={t.iqFsRef} spanHz={fftSpan} maxHold={fftMaxHold} avgN={fftAvg} mainsHz={fftMains ? 50 : 0} windowType={fftWindow} dbFloor={fftDbFloor} complex={fftComplex} onPeaks={fftPeaksOn ? setFftPeaks : undefined} />
                    {fftPeaksOn && <PeaksTable peaks={fftPeaks} />}
                  </div>
                )}
                {(fftView === "waterfall" || fftView === "both") && (
                  <div className={`chart-fill ${fftView === "both" ? "mt-2 h-[13rem] w-full" : "h-[28rem] w-full"}`}>
                    <IQWaterfall iRef={t.iqIRef} fsRef={t.iqFsRef} spanHz={fftSpan} windowType={fftWindow} dbFloor={fftDbFloor} />
                    <FreqAxis maxFreq={fftSpan === "full" ? (t.iqFsRef.current || 1000) / 2 : fftSpan} />
                  </div>
                )}
              </>
            ) : (
              <div className="chart-fill h-[28rem] w-full">
                {profile && raw ? (
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
            )}
            <div className="mt-2 flex items-center gap-3 text-xs text-muted">
              {fftView === "waterfall" ? (
                <span>x: frequency [Hz] · y: time (newest on top) · colour: |X| [dBFS] {fftDbFloor}…0 · {fftWindow}</span>
              ) : (
                <>
                  {fftComplex ? (
                    <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: "#3b82f6" }} />I+jQ</span>
                  ) : (
                    <>
                      <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: "#3b82f6" }} />I</span>
                      <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: "#f59e0b" }} />Q</span>
                    </>
                  )}
                  {fftMaxHold && (
                    <span className="inline-flex items-center gap-1"><span className="h-0.5 w-3" style={{ background: "#cbd5e1" }} />max-hold</span>
                  )}
                  {fftAvg > 1 && <span>avg ×{fftAvg}</span>}
                  {fftRbw > 0 && <span>RBW {fftRbw < 10 ? fftRbw.toFixed(2) : fftRbw.toFixed(1)} Hz</span>}
                  <span>x: frequency [Hz]{fftComplex ? " (±f, 0 = zero-beat)" : ""} · y: |X| [dBFS] · {fftWindow} · green dash = peak</span>
                </>
              )}
            </div>
          </Card>
        )}

        {tab === "adc" && (
          <Card className="card-max flex flex-col">
            <div className="mb-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-medium text-muted">
                  ADC scope — raw converter (noise floor / spurs / ENOB)
                </h2>
                <div className="flex items-center gap-2">
                  <PngBtn name="adc" />
                  <MaxBtn />
                </div>
              </div>
              <p className="mt-1 text-xs text-muted">
                Full 18-bit single-channel dump — no demod, boxcar or truncation. Enable{" "}
                <span className="text-foreground">SERVICE3 → full telemetry</span> on the detector.
              </p>
            </div>
            {t.hasAdc ? (
              <div className="chart-fill relative h-[28rem] w-full">
                <AdcSpectrum adcRef={t.adcRef} />
              </div>
            ) : (
              <div className="flex h-[28rem] items-center justify-center text-center text-sm text-muted">
                Waiting for an ADC dump — turn on full telemetry in SERVICE3 on the detector.
              </div>
            )}
            <div className="mt-2 text-xs text-muted">
              x: frequency [kHz] · y: |ADC| [dBFS] · blackman · ENOB from RMS noise (sample-rate
              independent) · fs nominal ~22 kSPS
            </div>
          </Card>
        )}

        {tab === "dsp" && (
          <Card className="card-max">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Ctrl label="mode">
                <Seg active={dspMode === "live"} onClick={() => setDspMode("live")}>
                  recorder
                </Seg>
                <Seg active={dspMode === "theory"} onClick={() => setDspMode("theory")}>
                  filter lab
                </Seg>
              </Ctrl>
              {dspMode === "live" && (
                <>
                  <button
                    onClick={() => setRecPaused((p) => !p)}
                    className={`shrink-0 rounded-md border px-3 py-1 text-xs font-medium transition-colors ${
                      recPaused
                        ? "border-emerald-500 bg-emerald-500/10 text-emerald-400 hover:text-emerald-300"
                        : "border-red-500 bg-red-500/10 text-red-400 hover:text-red-300"
                    }`}
                    title={recPaused ? "Resume live recording" : "Freeze the recorder"}
                  >
                    {recPaused ? "▶ play" : "■ stop"}
                  </button>
                  <Ctrl label="channels">
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
                  </Ctrl>
                  <Ctrl label="win">
                    {[500, 1000, 2000, 5000, 10000].map((ms) => (
                      <Seg key={ms} active={recMs === ms} onClick={() => setRecMs(ms)}>
                        {ms / 1000}s
                      </Seg>
                    ))}
                  </Ctrl>
                  <Ctrl label="scale">
                    <Seg active={recScaleMode === "auto"} onClick={() => setRecScaleMode("auto")}>
                      auto
                    </Seg>
                    <Seg active={recScaleMode === "manual"} onClick={() => setRecScaleMode("manual")}>
                      lock
                    </Seg>
                    <Seg
                      active={false}
                      onClick={() => { setRecScaleMode("manual"); setRecZoom((z) => Math.min(20, +(z * 1.4).toFixed(2))); }}
                      title="zoom in"
                    >
                      +
                    </Seg>
                    <Seg
                      active={false}
                      onClick={() => { setRecScaleMode("manual"); setRecZoom((z) => Math.max(0.05, +(z / 1.4).toFixed(2))); }}
                      title="zoom out"
                    >
                      −
                    </Seg>
                    <span className="w-12 text-[11px] tabular-nums text-muted">
                      {recScaleMode === "auto" ? "auto" : `×${recZoom.toFixed(1)}`}
                    </span>
                  </Ctrl>
                </>
              )}
              <div className="ml-auto flex items-center gap-1">
                <InfoPopover title="DSP — recorder & filter lab">
                  <p>
                    <span className="text-foreground">recorder</span> — strip-chart of the selected channels,
                    each on its own lane / axis (0 = now). I/Q = the post-filter{" "}
                    <code className={CODE_CLS}>FX/FY</code> of the active mode. play/stop freezes the view for
                    analysis (tap the coil → see the filter response).
                  </p>
                  <p>
                    <span className="text-foreground">filter lab</span> — the firmware filter primitives:
                    impulse and frequency response with the actual coefficients (Q29 / alpha / shift), per
                    project (taktyk-dsp / MXT) and per mode.
                  </p>
                </InfoPopover>
                {dspMode === "live" && <CsvBtn name="recorder" build={buildRecCsv} />}
                <PngBtn name={dspMode === "live" ? "recorder" : "filter-lab"} />
                <MaxBtn />
              </div>
            </div>
            {dspMode === "live" ? (
              <>
                <div className="chart-fill h-[28rem] w-full">
                  {t.hasIq || feature ? (
                    <Recorder
                      trailRef={t.trailRef}
                      channels={recChannels}
                      active={recActive}
                      windowMs={recMs}
                      scaleMode={recScaleMode}
                      zoom={recZoom}
                      paused={recPaused}
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

        {tab === "firmware" && <FirmwarePanel />}

        {tab === "coil" && <CoilLab harmonics={profile?.harmonics} />}

        {tab === "design" && <CoilDesigner />}

      </section>
    </main>
  );
}
