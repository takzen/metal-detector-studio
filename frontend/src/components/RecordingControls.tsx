"use client";

import { useCallback, useEffect, useState } from "react";
import {
  deleteRecording,
  getHealth,
  getRecordings,
  getRecordStatus,
  setSource,
  startRecord,
  stopRecord,
  type Recording,
  type RecordStatus,
} from "@/lib/api";

const selectCls = "rounded-md border border-border bg-background px-2 py-1 text-sm";
const SPEEDS = [0.5, 1, 2, 4] as const;

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

export function RecordingControls() {
  const [rec, setRec] = useState<RecordStatus>({ recording: false });
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [file, setFile] = useState("");
  const [speed, setSpeed] = useState(1);
  const [loop, setLoop] = useState(false);
  // current backend source + how to get back to live
  const [source, setSourceKind] = useState("serial");
  const [live, setLive] = useState<{ profile: string; port: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [h, r, rs] = await Promise.all([getHealth(), getRecordings(), getRecordStatus()]);
      setSourceKind(h.source);
      if (h.source === "serial") setLive({ profile: h.profile, port: h.port });
      setRecordings(r.recordings);
      setRec(rs);
      setFile((f) => f || r.recordings[0]?.name || "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "backend offline");
    }
  }, []);

  useEffect(() => {
    // poll on mount + every 1.5s for live recorder/source state
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const id = setInterval(() => void refresh(), 1500);
    return () => clearInterval(id);
  }, [refresh]);

  const toggleRecord = async () => {
    setBusy(true);
    setError(null);
    try {
      if (rec.recording) await stopRecord();
      else await startRecord();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  };

  const replay = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await setSource({ source: "replay", file, speed, loop });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!file) return;
    if (!window.confirm(`Delete recording ${file}?`)) return;
    setBusy(true);
    setError(null);
    try {
      await deleteRecording(file);
      setFile("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  };

  const backToLive = async () => {
    if (!live?.profile || !live.port) return;
    setBusy(true);
    setError(null);
    try {
      await setSource({ source: "serial", profile: live.profile, port: live.port });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  };

  const replaying = source === "replay";

  return (
    <div className="flex flex-wrap items-end gap-2 text-sm">
      {/* record toggle — fixed width so rec/stop don't reflow neighbours */}
      <button
        onClick={toggleRecord}
        disabled={busy}
        title={rec.recording ? "stop recording the live stream" : "record the live telemetry stream to a file"}
        className={`flex w-20 items-center justify-center gap-1.5 rounded-md border py-1.5 text-sm transition-colors disabled:opacity-40 ${
          rec.recording
            ? "border-red-500 text-red-400 hover:bg-red-500/10"
            : "border-border text-foreground hover:bg-accent/10"
        }`}
      >
        <span className={`h-2 w-2 rounded-full ${rec.recording ? "animate-pulse bg-red-500" : "bg-red-500/70"}`} />
        {rec.recording ? "stop" : "rec"}
      </button>

      {/* recorder readout — always present, fixed width (empty when idle) */}
      <span className="w-24 py-1.5 font-mono text-xs tabular-nums text-red-400">
        {rec.recording ? `${rec.elapsed_s?.toFixed(0)}s · ${rec.frames} fr` : ""}
      </span>

      {/* replay picker */}
      <label className="flex flex-col gap-0.5">
        <span className="text-[11px] uppercase tracking-wide text-muted">replay</span>
        <select
          className={`${selectCls} w-44`}
          value={file}
          onChange={(e) => setFile(e.target.value)}
        >
          {recordings.length === 0 && <option value="">no recordings</option>}
          {recordings.map((r) => (
            <option key={r.name} value={r.name}>
              {r.name.replace(/^rec-|\.ndjson$/g, "")} ({fmtBytes(r.bytes)})
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-0.5">
        <span className="text-[11px] uppercase tracking-wide text-muted">speed</span>
        <select
          className={`${selectCls} w-16`}
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value))}
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-1 py-1.5 text-xs text-muted" title="loop the recording">
        <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} />
        loop
      </label>

      {/* play ↔ stop toggle: starts replay, then stops it (back to live source) */}
      <button
        onClick={replaying ? backToLive : replay}
        disabled={busy || (replaying ? !live?.port : !file)}
        title={replaying ? "stop replay and return to the live source" : "replay the selected recording"}
        className={`w-16 rounded-md border py-1.5 text-sm transition-colors disabled:opacity-40 ${
          replaying
            ? "border-green-500 text-green-400 hover:bg-green-500/10"
            : "border-accent text-foreground hover:bg-accent/10"
        }`}
      >
        {replaying ? "stop" : "play"}
      </button>

      {/* delete the selected recording */}
      <button
        onClick={remove}
        disabled={busy || !file || replaying}
        title="delete the selected recording"
        className="w-9 rounded-md border border-border py-1.5 text-sm text-muted transition-colors hover:border-red-500 hover:text-red-400 disabled:opacity-40"
      >
        🗑
      </button>

      {/* active source — fixed width, right-aligned */}
      <span
        className={`w-20 py-1.5 text-right font-mono text-xs ${replaying ? "text-amber-400" : "text-muted"}`}
        title="active telemetry source"
      >
        {replaying ? "▶ replay" : "● live"}
      </span>

      {error && <span className="py-1.5 text-xs text-red-400">{error}</span>}
    </div>
  );
}
