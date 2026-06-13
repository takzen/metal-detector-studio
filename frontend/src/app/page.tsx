"use client";

import { Hodograph } from "@/components/Hodograph";
import { Scope } from "@/components/Scope";
import { colorFor } from "@/lib/palette";
import { useTelemetry, type ConnStatus } from "@/lib/useTelemetry";

const DEG = 180 / Math.PI;
const fmt = (n: number, d = 1) => n.toFixed(d);

function StatusDot({ status }: { status: ConnStatus }) {
  const color =
    status === "open" ? "bg-emerald-500" : status === "connecting" ? "bg-amber-500" : "bg-red-500";
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <span className={`h-2.5 w-2.5 rounded-full ${color}`} />
      <span className="text-muted">{status}</span>
    </span>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[11px] uppercase tracking-wide text-muted">{label}</span>
      <span className="font-mono text-sm">{value}</span>
    </div>
  );
}

export default function Home() {
  const t = useTelemetry();
  const { profile, feature, raw, stats } = t;

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
    <main className="flex-1 p-6 max-w-7xl mx-auto w-full">
      {/* Header */}
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-4">
        <div>
          <h1 className="text-xl font-semibold">Metal Detector Studio</h1>
          <p className="text-sm text-muted">
            {profile ? `${profile.title}` : "waiting for device profile…"}
          </p>
        </div>
        <div className="flex items-center gap-6">
          <StatusDot status={t.status} />
          <Stat label="schema" value={t.schemaVersion ?? "—"} />
          <Stat label="feature" value={`${fmt(stats.featureHz)} Hz`} />
          <Stat label="raw" value={`${fmt(stats.rawHz)} Hz`} />
          <Stat label="seq" value={feature ? String(feature.seq) : "—"} />
        </div>
      </header>

      {/* Hodograph + harmonics */}
      <section className="mt-6 grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-border bg-panel p-4 flex flex-col">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-muted">XY hodograph (I/Q vector trail)</h2>
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
            {profile && (
              <Hodograph trailRef={t.trailRef} harmonics={profile.harmonics} />
            )}
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <h2 className="text-sm font-medium text-muted">Harmonics (I/Q feature frame)</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {profile?.harmonics.map((h, i) => {
              const s = feature?.harmonics[h.id];
              return (
                <div key={h.id} className="rounded-lg border border-border bg-panel p-4">
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
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Phase diffs + extras */}
      <section className="mt-6 grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-border bg-panel p-4">
          <h2 className="text-sm font-medium text-muted mb-3">Phase diffs</h2>
          <div className="flex flex-wrap gap-6">
            {profile?.phase_diffs.length ? (
              profile.phase_diffs.map((pd) => (
                <Stat
                  key={pd.name}
                  label={pd.name}
                  value={feature ? `${fmt((feature.phase_diffs[pd.name] ?? 0) * DEG)}°` : "—"}
                />
              ))
            ) : (
              <span className="text-sm text-muted">none (single-frequency profile)</span>
            )}
          </div>
        </div>

        <div className="rounded-lg border border-border bg-panel p-4">
          <h2 className="text-sm font-medium text-muted mb-3">Extras</h2>
          <div className="flex flex-wrap gap-6">
            {profile?.extras.length ? (
              profile.extras.map((k) => (
                <Stat key={k} label={k} value={feature ? fmt(feature.extras[k] ?? 0, 2) : "—"} />
              ))
            ) : (
              <span className="text-sm text-muted">none</span>
            )}
          </div>
        </div>
      </section>

      {/* Virtual oscilloscope (raw block) */}
      <section className="mt-6">
        <div className="rounded-lg border border-border bg-panel p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-muted">
              Virtual oscilloscope — raw RX block
            </h2>
            <div className="flex flex-wrap gap-6">
              <Stat label="seq" value={raw ? String(raw.seq) : "—"} />
              <Stat
                label="sample rate"
                value={raw ? `${(raw.sample_rate_hz / 1000).toFixed(0)} kHz` : "—"}
              />
              <Stat label="block" value={raw ? `${raw.samples.length} samp` : "—"} />
              <Stat label="min" value={rawStats ? String(rawStats.min) : "—"} />
              <Stat label="max" value={rawStats ? String(rawStats.max) : "—"} />
            </div>
          </div>
          <div className="h-64 w-full">
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
        </div>
      </section>

      <p className="mt-8 text-xs text-muted">
        Next: XY hodograph (E2), virtual scope (E3), live FFT (E4), config panel (E5).
      </p>
    </main>
  );
}
