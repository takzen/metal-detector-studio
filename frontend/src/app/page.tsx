"use client";

import { useState } from "react";
import { ControlPanel } from "@/components/ControlPanel";
import { Hodograph } from "@/components/Hodograph";
import { Scope } from "@/components/Scope";
import { SourceControls } from "@/components/SourceControls";
import { Spectrum } from "@/components/Spectrum";
import { colorFor } from "@/lib/palette";
import { useTelemetry, type ConnStatus } from "@/lib/useTelemetry";

const DEG = 180 / Math.PI;
const fmt = (n: number, d = 1) => n.toFixed(d);

type TabId = "hodograph" | "scope" | "fft" | "control";
const TABS: { id: TabId; label: string }[] = [
  { id: "hodograph", label: "XY hodograph" },
  { id: "scope", label: "Oscilloscope" },
  { id: "fft", label: "Live FFT" },
  { id: "control", label: "Control" },
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

export default function Home() {
  const t = useTelemetry();
  const { profile, feature, raw, stats } = t;
  const [tab, setTab] = useState<TabId>("hodograph");

  const rawStats = raw
    ? (() => {
        let min = Infinity;
        let max = -Infinity;
        for (const s of raw.samples) {
          if (s < min) min = s;
          if (s > max) max = s;
        }
        return { min, max };
      })()
    : null;

  return (
    <main className="flex-1 w-full max-w-7xl mx-auto p-6">
      {/* Header (stable layout) */}
      <header className="border-b border-border pb-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold">Metal Detector Studio</h1>
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
        <div className="mt-3">
          <SourceControls />
        </div>
      </header>

      {/* Tabs */}
      <nav className="mt-4 flex gap-1 border-b border-border">
        {TABS.map((tabDef) => {
          const active = tab === tabDef.id;
          return (
            <button
              key={tabDef.id}
              onClick={() => setTab(tabDef.id)}
              className={`-mb-px border-b-2 px-4 py-2 text-sm transition-colors ${
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

      {/* Active view */}
      <section className="mt-6">
        {tab === "hodograph" && (
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="flex flex-col">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-medium text-muted">
                  XY hodograph — delta vs ground
                </h2>
                <div className="flex flex-wrap gap-3">
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
                {profile && <Hodograph trailRef={t.trailRef} harmonics={profile.harmonics} />}
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
            <div className="mb-3 flex items-center justify-between gap-4">
              <h2 className="text-sm font-medium text-muted">Virtual oscilloscope — raw RX</h2>
              <div className="flex flex-wrap gap-4">
                <Stat label="seq" value={raw ? String(raw.seq) : "—"} />
                <Stat
                  label="rate"
                  value={raw ? `${(raw.sample_rate_hz / 1000).toFixed(0)} kHz` : "—"}
                />
                <Stat label="min" value={rawStats ? String(rawStats.min) : "—"} />
                <Stat label="max" value={rawStats ? String(rawStats.max) : "—"} />
              </div>
            </div>
            <div className="h-[28rem] w-full">
              {profile && (
                <Scope
                  rawRef={t.rawRef}
                  sampleRateHz={profile.raw.sample_rate_hz}
                  blockSize={profile.raw.block_size}
                  fullscaleLsb={profile.raw.fullscale_lsb}
                />
              )}
            </div>
            <p className="mt-2 text-xs text-muted">x: time [ms] · y: ADC [lsb]</p>
          </Card>
        )}

        {tab === "fft" && (
          <Card>
            <h2 className="mb-3 text-sm font-medium text-muted">Live FFT — EMI scout</h2>
            <div className="h-[28rem] w-full">
              {profile && (
                <Spectrum
                  rawRef={t.rawRef}
                  sampleRateHz={profile.raw.sample_rate_hz}
                  blockSize={profile.raw.block_size}
                  fullscaleLsb={profile.raw.fullscale_lsb}
                />
              )}
            </div>
            <p className="mt-2 text-xs text-muted">
              x: frequency [kHz] · y: |X| [dBFS] · Hann window
            </p>
          </Card>
        )}

        {tab === "control" &&
          (profile ? (
            <ControlPanel profile={profile} sendConfig={t.sendConfig} lastAck={stats.lastAck} />
          ) : (
            <Card>
              <p className="text-sm text-muted">waiting for device profile…</p>
            </Card>
          ))}
      </section>
    </main>
  );
}
