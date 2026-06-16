"use client";

import type { Profile } from "@/lib/types";
import type { ConnStatus, LinkStats } from "@/lib/useTelemetry";

/** One metric: label, big value, optional sub-line, amber when out of spec. */
function Cell({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wide text-muted">{label}</span>
      <span className={`font-mono text-sm tabular-nums ${warn ? "text-amber-400" : "text-foreground"}`}>{value}</span>
      <span className="min-h-[0.875rem] text-[10px] tabular-nums text-muted">{sub ?? ""}</span>
    </div>
  );
}

/**
 * Link-quality readout: WS throughput, frame drops (from seq gaps), inter-arrival
 * jitter, measured-vs-declared rates, frame age, and serial-wire counters
 * (bytes/s + parse errors) polled from the backend.
 */
export function LinkPanel({ link, profile, status }: { link: LinkStats; profile: Profile | null; status: ConnStatus }) {
  const declFeat = profile?.stream.feature_hz ?? 0;
  const featOff = declFeat > 0 && link.feature.hz > 0 && Math.abs(link.feature.hz - declFeat) / declFeat > 0.2;

  const declIq = link.iq.fsDeclared;
  const hasIq = link.iq.samplesPerSec > 0;
  const iqOff = hasIq && declIq > 0 && Math.abs(link.iq.samplesPerSec - declIq) / declIq > 0.2;

  const sawData = link.feature.recv > 0 || hasIq;
  const stale = status === "open" && sawData && link.ageMs > 1500;

  return (
    <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 rounded-md border border-border bg-black/20 p-3 sm:grid-cols-3 lg:grid-cols-6">
      <Cell label="WS throughput" value={`${link.wsKibPerSec.toFixed(1)} KiB/s`} />
      <Cell
        label="feature rate"
        value={`${link.feature.hz.toFixed(1)} Hz`}
        sub={declFeat ? `declared ${declFeat} Hz` : undefined}
        warn={featOff}
      />
      <Cell
        label="feature drops"
        value={String(link.feature.drops)}
        sub={`${link.feature.dropPct.toFixed(1)}% · n=${link.feature.recv}`}
        warn={link.feature.drops > 0}
      />
      <Cell label="jitter" value={`${link.feature.jitterMs.toFixed(1)} ms`} sub="inter-arrival σ" />
      <Cell
        label="I/Q rate"
        value={hasIq ? `${link.iq.samplesPerSec.toFixed(0)} S/s` : "—"}
        sub={hasIq ? `decl ${declIq} · drop ${link.iq.drops}` : "no raw I/Q"}
        warn={iqOff}
      />
      <Cell
        label="last frame"
        value={sawData ? `${(link.ageMs / 1000).toFixed(1)} s ago` : "—"}
        warn={stale}
      />

      {link.serial ? (
        <>
          <Cell
            label="serial port"
            value={link.serial.connected ? "connected" : "no port"}
            warn={!link.serial.connected}
          />
          <Cell label="serial in" value={`${(link.serial.bytesPerSec / 1024).toFixed(1)} KiB/s`} sub="on the wire" />
          <Cell
            label="parse errors"
            value={String(link.serial.badTotal)}
            sub={link.serial.badPerSec > 0 ? `${link.serial.badPerSec.toFixed(1)}/s` : "total"}
            warn={link.serial.badTotal > 0}
          />
        </>
      ) : (
        <Cell label="serial" value="—" sub="backend offline" />
      )}
    </div>
  );
}
