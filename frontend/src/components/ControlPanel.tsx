"use client";

import { useState } from "react";
import type { ConfigAck, Profile } from "@/lib/types";

function Slider({
  label,
  min,
  max,
  step,
  value,
  unit,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  unit?: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-center justify-between text-xs">
        <span className="uppercase tracking-wide text-muted">{label}</span>
        <span className="font-mono tabular-nums">
          {value.toFixed(2)}
          {unit ? ` ${unit}` : ""}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-blue-500"
      />
    </label>
  );
}

export function ControlPanel({
  profile,
  sendConfig,
  lastAck,
}: {
  profile: Profile;
  sendConfig: (key: string, value: unknown) => void;
  lastAck: ConfigAck | null;
}) {
  const keys = new Set(profile.config_keys);
  const targets = profile.synth?.targets?.map((t) => t.name) ?? [];

  const [paused, setPaused] = useState(false);
  const [noise, setNoise] = useState(1);
  const [gain, setGain] = useState(1);
  const [sweep, setSweep] = useState(profile.synth?.sweep_period_s ?? 3);
  const [target, setTarget] = useState("auto");

  const send = (key: string, value: unknown, setter?: (v: never) => void) => {
    setter?.(value as never);
    sendConfig(key, value);
  };

  const reset = () => {
    send("paused", false, setPaused);
    send("noise", 1, setNoise);
    send("gain", 1, setGain);
    send("sweep_period", profile.synth?.sweep_period_s ?? 3, setSweep);
    send("target", "auto", setTarget);
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="rounded-lg border border-border bg-panel p-4">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-medium text-muted">Source control (synthetic)</h2>
          <button
            onClick={reset}
            className="rounded border border-border px-2 py-1 text-xs text-muted hover:text-foreground"
          >
            reset
          </button>
        </div>

        <div className="flex flex-col gap-5">
          {keys.has("paused") && (
            <button
              onClick={() => send("paused", !paused, setPaused)}
              className={`w-full rounded-md border px-3 py-2 text-sm transition-colors ${
                paused
                  ? "border-amber-500 text-amber-400"
                  : "border-border text-foreground hover:border-accent"
              }`}
            >
              {paused ? "▶ Resume stream" : "⏸ Pause stream"}
            </button>
          )}

          {keys.has("noise") && (
            <Slider label="noise" min={0} max={3} step={0.05} value={noise} unit="×"
              onChange={(v) => send("noise", v, setNoise)} />
          )}
          {keys.has("gain") && (
            <Slider label="gain" min={0} max={2} step={0.05} value={gain} unit="×"
              onChange={(v) => send("gain", v, setGain)} />
          )}
          {keys.has("sweep_period") && (
            <Slider label="sweep period" min={0.5} max={6} step={0.1} value={sweep} unit="s"
              onChange={(v) => send("sweep_period", v, setSweep)} />
          )}

          {keys.has("target") && targets.length > 0 && (
            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-wide text-muted">forced target</span>
              <select
                value={target}
                onChange={(e) => send("target", e.target.value, setTarget)}
                className="rounded-md border border-border bg-background px-3 py-2 text-sm"
              >
                <option value="auto">auto (cycle on each sweep)</option>
                {targets.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-border bg-panel p-4">
        <h2 className="mb-3 text-sm font-medium text-muted">Last command ack</h2>
        {lastAck ? (
          <div className="space-y-1 font-mono text-sm">
            <div>
              <span className="text-muted">key </span>
              {lastAck.key}
            </div>
            <div>
              <span className="text-muted">value </span>
              {String(lastAck.value)}
            </div>
            <div>
              <span className="text-muted">ok </span>
              <span className={lastAck.ok ? "text-emerald-400" : "text-red-400"}>
                {lastAck.ok ? "✓" : "✗"}
              </span>
              {lastAck.detail ? <span className="text-muted"> — {lastAck.detail}</span> : null}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted">no command sent yet</p>
        )}
        <p className="mt-4 text-xs text-muted">
          Commands go to the active source over the WebSocket. On real hardware these map to
          MCU config (gain, mode, frequency); here they drive the synthetic generator.
        </p>
      </div>
    </div>
  );
}
