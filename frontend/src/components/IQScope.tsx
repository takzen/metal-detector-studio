"use client";

import { useEffect, useRef, useState } from "react";
import uPlot from "uplot";

// ── Trigger config (lives in page.tsx state, passed down) ───────────────────
export type TrigMode = "off" | "auto" | "normal" | "single";
export type TrigSrc = "I" | "Q" | "mag";
export interface TrigConfig {
  mode: TrigMode;
  src: TrigSrc;
  edge: "rising" | "falling";
}

const I_COLOR = "#3b82f6";
const Q_COLOR = "#f59e0b";
const MAG_COLOR = "#10b981";
const TRIG_POS = 0.5; // trigger point sits at 50% of the window (pre-trigger room)
const AUTO_LEVEL_FRAC = 0.6; // auto level: 60% from mean toward the source peak (visible + catchable)
const AUTO_TIMEOUT_MS = 600; // auto mode free-runs if no trigger within this
const UI_MS = 150; // throttle for the React overlays (measurements + badge)

interface Chan { vpp: number; rms: number; mean: number; freq: number | null }
interface Meas { i: Chan; q: Chan }
interface Badge { label: string; color: string }
interface Line { y: number; color: string; label: string }
interface Frame { xs: number[]; i: number[]; q: number[]; line: Line | null; trigXMs: number | null }

const srcColor = (s: TrigSrc) => (s === "I" ? I_COLOR : s === "Q" ? Q_COLOR : MAG_COLOR);
const srcLabel = (s: TrigSrc) => (s === "mag" ? "|IQ|" : s);

const fmtV = (v: number) => {
  const a = Math.abs(v);
  if (a >= 10000) return (v / 1000).toFixed(1) + "k";
  if (a >= 100) return v.toFixed(0);
  return v.toFixed(1);
};
const fmtHz = (v: number | null) => (v == null ? "—" : v >= 100 ? `${v.toFixed(0)} Hz` : `${v.toFixed(1)} Hz`);

const srcAt = (s: TrigSrc, ib: number[], qb: number[], k: number) =>
  s === "I" ? ib[k] : s === "Q" ? qb[k] : Math.hypot(ib[k], qb[k]);

/** Measure one channel over the displayed window. Frequency via mean-crossings. */
function measureChan(seg: number[], fs: number): Chan {
  const n = seg.length;
  let sum = 0, sumsq = 0, mn = Infinity, mx = -Infinity;
  for (let k = 0; k < n; k++) {
    const v = seg[k];
    sum += v; sumsq += v * v;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  const mean = sum / n;
  const rms = Math.sqrt(sumsq / n);
  let prev = seg[0] - mean;
  let firstT = -1, lastT = -1, count = 0;
  for (let k = 1; k < n; k++) {
    const cur = seg[k] - mean;
    if (prev < 0 && cur >= 0) {
      const frac = cur === prev ? 0 : -prev / (cur - prev);
      const t = (k - 1 + frac) / fs;
      if (firstT < 0) firstT = t;
      lastT = t;
      count++;
    }
    prev = cur;
  }
  const freq = count >= 2 && lastT > firstT ? (count - 1) / (lastT - firstT) : null;
  return { vpp: mx - mn, rms, mean, freq };
}

export function IQScope({
  iRef,
  qRef,
  fsRef,
  countRef,
  windowMs,
  running,
  yScale,
  trig,
  level,
  onLevelChange,
  armNonce,
}: {
  iRef: React.RefObject<number[]>;
  qRef: React.RefObject<number[]>;
  fsRef: React.RefObject<number>;
  countRef: React.RefObject<number>;
  windowMs: number;
  running: boolean;
  yScale: number | "auto";
  trig: TrigConfig;
  /** Trigger level: "auto" tracks the signal envelope; a number is a manual raw level (draggable). */
  level: number | "auto";
  onLevelChange: (rawLevel: number) => void;
  armNonce: number;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const peakRef = useRef(1);
  const winRef = useRef(windowMs);
  const runRef = useRef(running);
  const yRef = useRef<number | "auto">(yScale);
  const trigRef = useRef<TrigConfig>(trig);
  const levelRef = useRef<number | "auto">(level);
  const onLevelRef = useRef(onLevelChange);

  // sweep / trigger run-state
  const holdFrameRef = useRef<Frame | null>(null); // last captured (held) sweep
  const lastTrigAbsRef = useRef(-1); // abs sample index of last trigger (holdoff)
  const lastTrigTimeRef = useRef(0); // perf time of last trigger (auto timeout)
  const triggeredRef = useRef(false); // single: captured & frozen
  const armCountRef = useRef(0); // single: arm point (abs sample index)
  const lastArmRef = useRef(armNonce);
  const thrSmoothRef = useRef<number | null>(null); // smoothed auto level

  // draw-hook inputs (updated each frame before setData)
  const lineRef = useRef<Line | null>(null);
  const trigXRef = useRef<number | null>(null);
  const thrValRef = useRef<number | null>(null); // current threshold raw (for drag/hover)

  // throttled overlays
  const lastUiRef = useRef(0);
  const [ui, setUi] = useState<{ meas: Meas | null; badge: Badge | null }>({ meas: null, badge: null });

  useEffect(() => {
    winRef.current = windowMs;
    runRef.current = running;
    yRef.current = yScale;
    trigRef.current = trig;
    levelRef.current = level;
    onLevelRef.current = onLevelChange;
    if (armNonce !== lastArmRef.current) {
      lastArmRef.current = armNonce;
      triggeredRef.current = false;
      armCountRef.current = countRef.current; // single waits for a crossing AFTER this point
    }
    if (trig.mode !== "single") triggeredRef.current = false;
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let af = 0;
    const dpr = () => Math.max(1, Math.round(window.devicePixelRatio || 1));

    const r0 = host.getBoundingClientRect();
    const opts: uPlot.Options = {
      width: Math.max(1, Math.round(r0.width)),
      height: Math.max(1, Math.round(r0.height)),
      scales: {
        x: { time: false, range: () => [0, winRef.current] },
        y: {
          range: () => {
            const ys = yRef.current;
            return ys === "auto" ? [-peakRef.current, peakRef.current] : [-ys, ys];
          },
        },
      },
      axes: [
        { stroke: "#8b98a9", grid: { stroke: "#1b2330", width: 1 }, ticks: { stroke: "#1b2330", width: 1 },
          values: (_u, s) => s.map((v) => v.toFixed(0)) },
        { stroke: "#8b98a9", grid: { stroke: "#1b2330", width: 1 }, ticks: { stroke: "#1b2330", width: 1 }, size: 52 },
      ],
      series: [
        {},
        { label: "I", stroke: I_COLOR, width: 1, points: { show: false } },
        { label: "Q", stroke: Q_COLOR, width: 1, points: { show: false } },
      ],
      cursor: { y: false },
      legend: { show: false },
      hooks: {
        draw: [
          (u) => {
            const ctx = u.ctx;
            const { left, top, width, height } = u.bbox;
            const w = dpr();
            ctx.save();
            ctx.beginPath();
            ctx.rect(left, top, width, height);
            ctx.clip();
            const line = lineRef.current;
            if (line) {
              const y = u.valToPos(line.y, "y", true);
              ctx.strokeStyle = line.color;
              ctx.globalAlpha = 0.95;
              ctx.lineWidth = Math.max(1, Math.round(1.5 * w));
              ctx.setLineDash([7, 4]);
              ctx.beginPath();
              ctx.moveTo(left, y);
              ctx.lineTo(left + width, y);
              ctx.stroke();
              ctx.setLineDash([]);
              ctx.globalAlpha = 1;
              // grab handle (right edge) + label
              ctx.fillStyle = line.color;
              ctx.fillRect(left + width - 7 * w, y - 4 * w, 7 * w, 8 * w);
              ctx.font = "11px var(--font-geist-mono), monospace";
              ctx.textAlign = "right";
              ctx.textBaseline = "bottom";
              ctx.fillText(line.label, left + width - 11 * w, y - 4 * w);
            }
            const tx = trigXRef.current;
            if (tx != null) {
              const x = u.valToPos(tx, "x", true);
              ctx.strokeStyle = "rgba(255,255,255,0.28)";
              ctx.lineWidth = w;
              ctx.beginPath();
              ctx.moveTo(x, top);
              ctx.lineTo(x, top + height);
              ctx.stroke();
              ctx.fillStyle = "rgba(255,255,255,0.55)";
              ctx.beginPath();
              ctx.moveTo(x - 4 * w, top);
              ctx.lineTo(x + 4 * w, top);
              ctx.lineTo(x, top + 7 * w);
              ctx.closePath();
              ctx.fill();
            }
            ctx.restore();
          },
        ],
      },
    };
    const u = new uPlot(opts, [[], [], []] as unknown as uPlot.AlignedData, host);

    const ro = new ResizeObserver(() => {
      const r = host.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width));
      const h = Math.max(1, Math.round(r.height));
      if (w > 1 && h > 1) u.setSize({ width: w, height: h });
    });
    ro.observe(host);

    // ── drag the trigger level line ──
    const over = u.over;
    let dragging = false;
    const nearLine = (offY: number) => {
      const thr = thrValRef.current;
      if (thr == null || trigRef.current.mode === "off") return false;
      return Math.abs(offY - u.valToPos(thr, "y")) <= 10;
    };
    const clampY = (raw: number) => {
      const lo = u.scales.y.min ?? raw;
      const hi = u.scales.y.max ?? raw;
      return Math.max(lo, Math.min(hi, raw));
    };
    const onDown = (e: MouseEvent) => {
      if (!nearLine(e.offsetY)) return;
      dragging = true;
      e.preventDefault();
      onLevelRef.current(clampY(u.posToVal(e.offsetY, "y")));
    };
    const onMove = (e: MouseEvent) => {
      if (!dragging) return;
      const rect = over.getBoundingClientRect();
      onLevelRef.current(clampY(u.posToVal(e.clientY - rect.top, "y")));
    };
    const onUp = () => { dragging = false; };
    const onHover = (e: MouseEvent) => {
      if (!dragging) over.style.cursor = nearLine(e.offsetY) ? "ns-resize" : "";
    };
    over.addEventListener("mousedown", onDown);
    over.addEventListener("mousemove", onHover);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);

    const applyAuto = (iSeg: number[], qSeg: number[]) => {
      if (yRef.current !== "auto") return;
      let peak = 1;
      for (let k = 0; k < iSeg.length; k++) {
        const a = Math.abs(iSeg[k]);
        const b = Math.abs(qSeg[k]);
        if (a > peak) peak = a;
        if (b > peak) peak = b;
      }
      peakRef.current += 0.1 * (peak * 1.1 - peakRef.current);
    };

    const pushUi = (badge: Badge | null, iSeg?: number[], qSeg?: number[], fs?: number) => {
      const now = performance.now();
      if (now - lastUiRef.current < UI_MS) return;
      lastUiRef.current = now;
      const m = iSeg && qSeg && fs ? { i: measureChan(iSeg, fs), q: measureChan(qSeg, fs) } : null;
      setUi((prev) => ({ meas: m ?? prev.meas, badge }));
    };

    // capture a `want`-wide window of the buffer anchored so index `k` lands at `pre`
    const capture = (ib: number[], qb: number[], k: number, pre: number, want: number, fs: number, line: Line | null): Frame => {
      const start = k - pre;
      const xs = new Array<number>(want);
      const iSeg = new Array<number>(want);
      const qSeg = new Array<number>(want);
      for (let j = 0; j < want; j++) {
        xs[j] = (j / fs) * 1000;
        iSeg[j] = ib[start + j];
        qSeg[j] = qb[start + j];
      }
      return { xs, i: iSeg, q: qSeg, line, trigXMs: (pre / fs) * 1000 };
    };

    const show = (frame: Frame, badge: Badge, fs: number) => {
      lineRef.current = frame.line;
      trigXRef.current = frame.trigXMs;
      applyAuto(frame.i, frame.q);
      u.setData([frame.xs, frame.i, frame.q]);
      pushUi(badge, frame.i, frame.q, fs);
    };

    const freeRun = (ib: number[], qb: number[], len: number, want: number, fs: number, line: Line | null, badge: Badge | null) => {
      const start = len - Math.min(len, want);
      const frame = capture(ib, qb, start + Math.round(TRIG_POS * Math.min(len, want)), Math.round(TRIG_POS * Math.min(len, want)), Math.min(len, want), fs, line);
      frame.trigXMs = null; // free-run: no trigger marker
      lineRef.current = line;
      trigXRef.current = null;
      applyAuto(frame.i, frame.q);
      u.setData([frame.xs, frame.i, frame.q]);
      pushUi(badge, frame.i, frame.q, fs);
    };

    const cross = (s: number[], k: number, thr: number, rising: boolean) =>
      rising ? s[k - 1] < thr && s[k] >= thr : s[k - 1] > thr && s[k] <= thr;

    const tick = () => {
      af = requestAnimationFrame(tick);
      if (!runRef.current) return;
      const tr = trigRef.current;
      const ib = iRef.current;
      const qb = qRef.current;
      const fs = fsRef.current || 1000;
      const len = Math.min(ib.length, qb.length);
      if (len < 2) return;
      const want = Math.max(2, Math.min(len, Math.round((winRef.current / 1000) * fs)));

      // ── OFF: plain roll, no trigger ──
      if (tr.mode === "off") {
        thrValRef.current = null;
        freeRun(ib, qb, len, want, fs, null, null);
        return;
      }

      // ── source series + baseline + threshold ──
      const s = new Array<number>(len);
      let sum = 0, pk = -Infinity, mnv = Infinity;
      for (let k = 0; k < len; k++) {
        const v = srcAt(tr.src, ib, qb, k);
        s[k] = v; sum += v;
        if (v > pk) pk = v;
        if (v < mnv) mnv = v;
      }
      const baseline = sum / len;
      const rising = tr.edge === "rising";
      let thr: number;
      if (levelRef.current === "auto") {
        const ext = rising ? pk : mnv;
        const raw = baseline + AUTO_LEVEL_FRAC * (ext - baseline);
        thrSmoothRef.current = thrSmoothRef.current == null ? raw : thrSmoothRef.current + 0.2 * (raw - thrSmoothRef.current);
        thr = thrSmoothRef.current;
      } else {
        thr = levelRef.current;
        thrSmoothRef.current = null;
      }
      thrValRef.current = thr;
      const line: Line = { y: thr, color: srcColor(tr.src), label: `${srcLabel(tr.src)}${levelRef.current === "auto" ? " auto" : ""}` };

      const pre = Math.round(TRIG_POS * want);
      const post = want - pre;

      // single already captured → hold frozen
      if (tr.mode === "single" && triggeredRef.current && holdFrameRef.current) {
        show(holdFrameRef.current, { label: "TRIG'D ⏸", color: MAG_COLOR }, fs);
        return;
      }

      if (len < want) { freeRun(ib, qb, len, want, fs, line, { label: "WAIT", color: "#8b98a9" }); return; }

      // ── single: FIRST crossing after arm, then freeze ──
      if (tr.mode === "single") {
        const base = countRef.current - len; // abs index of buffer[k] = base + k
        const kFloor = Math.max(pre + 1, armCountRef.current - base);
        let hit = -1;
        for (let k = kFloor; k <= len - post; k++) {
          if (cross(s, k, thr, rising)) { hit = k; break; }
        }
        if (hit >= 0) {
          holdFrameRef.current = capture(ib, qb, hit, pre, want, fs, line);
          triggeredRef.current = true;
          show(holdFrameRef.current, { label: "TRIG'D ⏸", color: MAG_COLOR }, fs);
        } else {
          freeRun(ib, qb, len, want, fs, line, { label: "ARMED", color: "#3b82f6" });
        }
        return;
      }

      // ── normal / auto: MOST-RECENT crossing, holdoff-gated re-capture, hold between ──
      let candK = -1;
      for (let k = len - post; k > pre; k--) {
        if (cross(s, k, thr, rising)) { candK = k; break; }
      }
      const base = countRef.current - len; // abs = base + k
      const now = performance.now();
      if (candK >= 0) {
        const candAbs = base + candK;
        if (candAbs >= lastTrigAbsRef.current + want) {
          holdFrameRef.current = capture(ib, qb, candK, pre, want, fs, line);
          lastTrigAbsRef.current = candAbs;
          lastTrigTimeRef.current = now;
        }
      }

      if (holdFrameRef.current && (tr.mode === "normal" || now - lastTrigTimeRef.current < AUTO_TIMEOUT_MS)) {
        // refresh held frame's level line so a dragged level shows immediately
        holdFrameRef.current.line = line;
        show(holdFrameRef.current, { label: "TRIG", color: MAG_COLOR }, fs);
      } else {
        freeRun(ib, qb, len, want, fs, line, { label: tr.mode === "auto" ? "AUTO" : "WAIT", color: tr.mode === "auto" ? "#8b98a9" : "#f59e0b" });
      }
    };
    af = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(af);
      ro.disconnect();
      over.removeEventListener("mousedown", onDown);
      over.removeEventListener("mousemove", onHover);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      u.destroy();
    };
  }, [iRef, qRef, fsRef, countRef]);

  const { meas, badge } = ui;
  return (
    <div className="relative h-full w-full">
      <div ref={hostRef} className="absolute inset-0" />
      {badge && (
        <div
          className="pointer-events-none absolute left-2 top-2 w-20 rounded border bg-black/40 px-2 py-0.5 text-center font-mono text-[11px] tabular-nums backdrop-blur-sm"
          style={{ borderColor: badge.color, color: badge.color }}
        >
          {badge.label}
        </div>
      )}
      {meas && (
        <div className="pointer-events-none absolute right-2 top-2 rounded border border-border bg-black/40 px-2 py-1 font-mono text-[11px] tabular-nums backdrop-blur-sm">
          <div className="grid grid-cols-[1.9rem_3.6rem_3.6rem] gap-x-3 gap-y-0.5">
            <span className="text-muted">meas</span>
            <span className="text-right" style={{ color: I_COLOR }}>I</span>
            <span className="text-right" style={{ color: Q_COLOR }}>Q</span>
            <span className="text-muted">Vpp</span>
            <span className="text-right">{fmtV(meas.i.vpp)}</span>
            <span className="text-right">{fmtV(meas.q.vpp)}</span>
            <span className="text-muted">RMS</span>
            <span className="text-right">{fmtV(meas.i.rms)}</span>
            <span className="text-right">{fmtV(meas.q.rms)}</span>
            <span className="text-muted">mean</span>
            <span className="text-right">{fmtV(meas.i.mean)}</span>
            <span className="text-right">{fmtV(meas.q.mean)}</span>
            <span className="text-muted">f</span>
            <span className="text-right">{fmtHz(meas.i.freq)}</span>
            <span className="text-right">{fmtHz(meas.q.freq)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
