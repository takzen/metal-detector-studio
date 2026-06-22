"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  browseHex,
  cancelFlash,
  getFlashConfig,
  getFlashStatus,
  startFlash,
  type BrowseResult,
  type FlashConfig,
  type FlashStatus,
} from "@/lib/api";

function fmtBytes(n?: number): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

const inputCls = "rounded-md border border-border bg-background px-2 py-1 font-mono text-sm";

// state -> badge colour
function stateColor(state: string): string {
  if (state === "done") return "text-emerald-400 border-emerald-500";
  if (state === "error") return "text-red-400 border-red-500";
  if (state === "idle") return "text-muted border-border";
  return "text-amber-400 border-amber-500"; // in-progress phases
}

export function FirmwarePanel() {
  const [cfg, setCfg] = useState<FlashConfig | null>(null);
  const [hexPath, setHexPath] = useState("");
  const [manual, setManual] = useState(true);
  const [status, setStatus] = useState<FlashStatus>({ state: "idle", running: false, log: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const logRef = useRef<HTMLPreElement | null>(null);

  // load config once (prefill the path + programmer readiness)
  useEffect(() => {
    void (async () => {
      try {
        const c = await getFlashConfig();
        setCfg(c);
        setHexPath((p) => p || c.hex_path);
      } catch {
        setError("backend offline");
      }
    })();
  }, []);

  const poll = useCallback(async () => {
    try {
      setStatus(await getFlashStatus());
    } catch {
      /* transient — backend may bounce during the source restart */
    }
  }, []);

  // poll status while a job is running (port re-enumeration can take seconds)
  useEffect(() => {
    void poll();
    if (!status.running) return;
    const id = setInterval(() => void poll(), 300);
    return () => clearInterval(id);
  }, [poll, status.running]);

  // keep the log scrolled to the bottom
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [status.log]);

  const flash = async () => {
    setBusy(true);
    setError(null);
    try {
      await startFlash({ hex_path: hexPath, manual });
      await poll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    try {
      await cancelFlash();
      await poll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    }
  };

  // Reset the panel after a finished/failed flash (clears the log + status locally;
  // polling is stopped once not running, so this stays cleared until the next flash).
  const clear = () => {
    setStatus({ state: "idle", running: false, log: [] });
    setError(null);
  };

  const running = status.running;
  const finished = !running && (status.state === "done" || status.state === "error");
  const pct = Math.round((status.progress ?? 0) * 100);
  const programmerMissing = cfg != null && !cfg.programmer_available;

  return (
    <div className="mx-auto max-w-3xl rounded-lg border border-border bg-background p-5">
      <h2 className="mb-1 text-base font-semibold text-foreground">Firmware flash (USB)</h2>
      <p className="mb-4 text-sm text-muted">
        Reboots the detector into its bootloader over USB, flashes the selected{" "}
        <code>.hex</code>, then returns to the app. Telemetry pauses during the update and
        resumes when it finishes.
      </p>

      {programmerMissing && (
        <p className="mb-3 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
          Programmer <code>{cfg?.programmer}</code> not found on PATH — install it or set its
          path before flashing.
        </p>
      )}

      <label className="mb-3 flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wide text-muted">.hex path</span>
        <div className="flex gap-2">
          <input
            className={`${inputCls} min-w-0 flex-1`}
            value={hexPath}
            onChange={(e) => setHexPath(e.target.value)}
            placeholder={cfg?.hex_path ?? "path to firmware.hex"}
            spellCheck={false}
            disabled={running}
          />
          <button
            onClick={() => setBrowsing(true)}
            disabled={running}
            className="shrink-0 rounded-md border border-border px-3 py-1 text-sm text-foreground transition-colors hover:bg-accent/10 disabled:opacity-40"
          >
            Browse…
          </button>
        </div>
      </label>

      <div className="mb-4 flex items-center gap-4">
        <label className="flex items-center gap-2 text-sm text-muted" title="skip the magic reboot — use when the device is already in the bootloader">
          <input
            type="checkbox"
            checked={manual}
            onChange={(e) => setManual(e.target.checked)}
            disabled={running}
          />
          device already in bootloader (manual)
        </label>

        {running ? (
          <button
            onClick={stop}
            className="ml-auto w-28 rounded-md border border-red-500 py-1.5 text-sm text-red-400 transition-colors hover:bg-red-500/10"
          >
            cancel
          </button>
        ) : (
          <div className="ml-auto flex items-center gap-2">
            {finished && (
              <button
                onClick={clear}
                className="w-20 rounded-md border border-border py-1.5 text-sm text-muted transition-colors hover:text-foreground"
              >
                Clear
              </button>
            )}
            <button
              onClick={flash}
              disabled={busy || !hexPath}
              className="w-28 rounded-md border border-accent py-1.5 text-sm text-foreground transition-colors hover:bg-accent/10 disabled:opacity-40"
            >
              {busy ? "starting…" : "Flash"}
            </button>
          </div>
        )}
      </div>

      {/* status row — fixed layout so values never shift the labels */}
      <div className="mb-2 flex items-center gap-3">
        <span
          className={`inline-flex w-40 items-center justify-center rounded-md border px-2 py-1 font-mono text-xs ${stateColor(status.state)}`}
        >
          {status.state}
        </span>
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-border/40">
          <div
            className={`h-full transition-all ${status.state === "error" ? "bg-red-500" : "bg-accent"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="w-12 text-right font-mono text-xs tabular-nums text-muted">{pct}%</span>
      </div>

      {status.error && <p className="mb-2 text-xs text-red-400">{status.error}</p>}
      {error && <p className="mb-2 text-xs text-red-400">{error}</p>}

      <pre
        ref={logRef}
        className="mt-3 h-48 overflow-auto rounded-md border border-border bg-black/30 p-3 font-mono text-xs leading-relaxed text-muted"
      >
        {status.log.length ? status.log.join("\n") : "— no output yet —"}
      </pre>

      {browsing && (
        <HexBrowser
          start={hexPath || cfg?.hex_path}
          onCancel={() => setBrowsing(false)}
          onPick={(p) => {
            setHexPath(p);
            setBrowsing(false);
          }}
        />
      )}
    </div>
  );
}

function HexBrowser({
  start,
  onCancel,
  onPick,
}: {
  start?: string;
  onCancel: () => void;
  onPick: (path: string) => void;
}) {
  const [data, setData] = useState<BrowseResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (dir?: string) => {
    setErr(null);
    try {
      setData(await browseHex(dir));
    } catch {
      // seed dir may not exist (e.g. relative default build path) — fall back to the
      // backend's default location (home / configured dir) instead of showing nothing
      if (dir) {
        try {
          setData(await browseHex(undefined));
          return;
        } catch {
          /* fall through to error */
        }
      }
      setErr("failed to list directory");
    }
  }, []);

  useEffect(() => {
    // seed from the directory of the current path (backend derives parent if it's a file)
    const seedDir = start ? start.replace(/[\\/][^\\/]*$/, "") : undefined;
    void load(seedDir || undefined);
  }, [load, start]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="flex h-[32rem] w-[40rem] flex-col rounded-lg border border-border bg-background p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-sm font-semibold text-foreground">Pick a .hex file</h2>
          <button
            onClick={onCancel}
            className="ml-auto rounded-md border border-border px-2 py-0.5 text-xs text-muted hover:text-foreground"
          >
            ✕
          </button>
        </div>

        {/* current dir — fixed row, truncates rather than reflowing the dialog */}
        <div className="mb-2 truncate font-mono text-xs text-muted" title={data?.dir}>
          {data?.dir ?? "…"}
        </div>

        {err && <p className="mb-2 text-xs text-red-400">{err}</p>}

        <div className="flex-1 overflow-auto rounded-md border border-border bg-black/20">
          {data?.parent && (
            <button
              onClick={() => void load(data.parent ?? undefined)}
              className="flex w-full items-center gap-2 border-b border-border/50 px-3 py-1.5 text-left text-sm text-muted hover:bg-accent/10"
            >
              <span>📁</span> ..
            </button>
          )}
          {data?.dirs.map((d) => (
            <button
              key={d.path}
              onClick={() => void load(d.path)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-foreground hover:bg-accent/10"
            >
              <span>📁</span> {d.name}
            </button>
          ))}
          {data?.hex_files.map((f) => (
            <button
              key={f.path}
              onClick={() => onPick(f.path)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-emerald-400 hover:bg-emerald-500/10"
            >
              <span>📄</span>
              <span className="flex-1 truncate">{f.name}</span>
              <span className="font-mono text-xs text-muted">{fmtBytes(f.bytes)}</span>
            </button>
          ))}
          {data && data.dirs.length === 0 && data.hex_files.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted">no subfolders or .hex files here</p>
          )}
        </div>

        <p className="mt-2 text-[11px] text-muted">
          Browsing the backend host&apos;s disk. Click a folder to open it, a .hex to select it.
        </p>
      </div>
    </div>
  );
}
