"use client";

import { useCallback, useEffect, useState } from "react";
import { getHealth, getPorts, getProfiles, setSource, type PortInfo } from "@/lib/api";

const selectCls =
  "rounded-md border border-border bg-background px-2 py-1 text-sm";

export function SourceControls() {
  const [profiles, setProfiles] = useState<string[]>([]);
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [source, setSourceKind] = useState<"synthetic" | "serial">("synthetic");
  const [profile, setProfile] = useState("");
  const [port, setPort] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [h, p, pr] = await Promise.all([getHealth(), getProfiles(), getPorts()]);
      setProfiles(p.available);
      setPorts(pr.ports);
      setSourceKind(h.source === "serial" ? "serial" : "synthetic");
      setProfile(h.profile);
      setPort(h.port ?? pr.ports[0]?.device ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "backend offline");
    }
  }, []);

  useEffect(() => {
    // fetch-on-mount; state updates happen after awaits, not synchronously
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      await setSource({ source, profile, port: source === "serial" ? port : undefined });
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-end gap-2 text-sm">
      <label className="flex flex-col gap-0.5">
        <span className="text-[11px] uppercase tracking-wide text-muted">project</span>
        <select className={selectCls} value={profile} onChange={(e) => setProfile(e.target.value)}>
          {profiles.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-0.5">
        <span className="text-[11px] uppercase tracking-wide text-muted">source</span>
        <select
          className={selectCls}
          value={source}
          onChange={(e) => setSourceKind(e.target.value as "synthetic" | "serial")}
        >
          <option value="synthetic">synthetic</option>
          <option value="serial">serial</option>
        </select>
      </label>

      {source === "serial" && (
        <label className="flex flex-col gap-0.5">
          <span className="text-[11px] uppercase tracking-wide text-muted">port</span>
          <select className={selectCls} value={port} onChange={(e) => setPort(e.target.value)}>
            {ports.length === 0 && <option value="">no ports</option>}
            {ports.map((p) => (
              <option key={p.device} value={p.device}>
                {p.device}
              </option>
            ))}
          </select>
        </label>
      )}

      <button
        onClick={apply}
        disabled={busy || !profile || (source === "serial" && !port)}
        className="rounded-md border border-accent px-3 py-1 text-sm text-foreground transition-colors hover:bg-accent/10 disabled:opacity-40"
      >
        {busy ? "applying…" : "apply"}
      </button>
      <button
        onClick={refresh}
        className="rounded-md border border-border px-2 py-1 text-sm text-muted hover:text-foreground"
        title="refresh ports / state"
      >
        ↻
      </button>

      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}
