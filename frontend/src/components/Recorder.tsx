"use client";

import { useEffect, useRef } from "react";
import uPlot from "uplot";
import type { FeatureFrame } from "@/lib/types";

export interface RecChannel {
  key: string;
  label: string;
  color: string;
  get: (f: FeatureFrame) => number | undefined;
  /** Channels sharing a `lane` are drawn together on one shared scale (default: own lane). */
  lane?: string;
}

const PAD = 0.06; // vertical gap between lanes (fraction of a lane height)

const fmtN = (v: number) => {
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return (v / 1e3).toFixed(1) + "k";
  if (a >= 1) return v.toFixed(0);
  if (a === 0) return "0";
  return v.toFixed(2);
};

interface LaneLayout {
  chans: { label: string; color: string }[];
  topVal: number;
  botVal: number;
  lo: number;
  hi: number;
}

// Multi-channel strip-chart recorder fed from the feature trail. Each channel (or group of
// channels sharing a `lane`) gets its own auto-scaled horizontal lane with a real value axis
// (left gutter), so disparate scales (ground vs I/Q) don't flatten each other.
export function Recorder({
  trailRef,
  channels,
  active,
  windowMs,
  scaleMode,
  zoom,
}: {
  trailRef: React.RefObject<FeatureFrame[]>;
  channels: RecChannel[];
  active: Set<string>;
  windowMs: number;
  /** "auto" tracks each lane's min/max; "manual" freezes the lane scales. */
  scaleMode: "auto" | "manual";
  /** Manual zoom factor applied around each lane's centre (>1 = zoom in). */
  zoom: number;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const winRef = useRef(windowMs);
  const activeRef = useRef(active);
  const scaleModeRef = useRef(scaleMode);
  const zoomRef = useRef(zoom);
  const scaleRef = useRef<Map<string, { lo: number; hi: number }>>(new Map());
  const layoutRef = useRef<LaneLayout[]>([]);
  useEffect(() => {
    winRef.current = windowMs;
    activeRef.current = active;
    scaleModeRef.current = scaleMode;
    zoomRef.current = zoom;
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
        x: { time: false, range: () => [-winRef.current, 0] },
        y: { range: () => [0, 1] }, // all channels normalised into per-lane bands
      },
      axes: [
        { stroke: "#8b98a9", grid: { stroke: "#1b2330", width: 1 }, ticks: { stroke: "#1b2330", width: 1 },
          values: (_u, s) => s.map((v) => v.toFixed(0)) },
        // y reserved as a left gutter (50px); per-lane real-value ticks drawn in the hook
        { scale: "y", side: 3, size: 50, stroke: "rgba(0,0,0,0)",
          grid: { show: false }, ticks: { show: false }, values: (_u, s) => s.map(() => "") },
      ],
      series: [
        {},
        ...channels.map((c) => ({ label: c.label, stroke: c.color, width: 1, points: { show: false } })),
      ],
      cursor: { y: false },
      legend: { show: false }, // channel toggle buttons act as the legend
      hooks: {
        draw: [
          (u) => {
            const { left, width } = u.bbox;
            const w = dpr();
            const lanes = layoutRef.current;
            if (!lanes.length) return;
            const ctx = u.ctx;
            const N = lanes.length;
            const laneH = 1 / N;
            ctx.save();
            ctx.font = "10px var(--font-geist-mono), monospace";
            for (let i = 0; i < N; i++) {
              const lane = lanes[i];
              const bandTop = lane.topVal - PAD * laneH;
              const bandBot = lane.botVal + PAD * laneH;
              // gridlines + real-value ticks (lo / mid / hi) in the left gutter
              ctx.textAlign = "right";
              ctx.textBaseline = "middle";
              const tspan = (lane.hi - lane.lo) || 1;
              const tickY = (val: number) =>
                u.valToPos(bandBot + ((val - lane.lo) / tspan) * (bandTop - bandBot), "y", true);
              // top + bottom edge labels
              for (const val of [lane.hi, lane.lo]) {
                const py = tickY(val);
                ctx.strokeStyle = "#161d28";
                ctx.lineWidth = w;
                ctx.beginPath();
                ctx.moveTo(left, py);
                ctx.lineTo(left + width, py);
                ctx.stroke();
                ctx.fillStyle = "#6b7888";
                ctx.fillText(fmtN(val), left - 4 * w, py);
              }
              // zero baseline (brighter) so signals are referenced to 0, not floating
              if (lane.lo < 0 && lane.hi > 0) {
                const py = tickY(0);
                ctx.strokeStyle = "#3a4658";
                ctx.lineWidth = w;
                ctx.beginPath();
                ctx.moveTo(left, py);
                ctx.lineTo(left + width, py);
                ctx.stroke();
                ctx.fillStyle = "#8b98a9";
                ctx.fillText("0", left - 4 * w, py);
              }
              // channel label(s) at lane top-left
              ctx.textAlign = "left";
              ctx.textBaseline = "top";
              let x = left + 5 * w;
              const ly = u.valToPos(bandTop, "y", true) + 2 * w;
              for (const ch of lane.chans) {
                ctx.fillStyle = ch.color;
                ctx.fillText(ch.label, x, ly);
                x += ctx.measureText(ch.label + "  ").width;
              }
              // lane separator
              if (i < N - 1) {
                const sy = u.valToPos(lane.botVal, "y", true);
                ctx.strokeStyle = "#222c3a";
                ctx.lineWidth = w;
                ctx.beginPath();
                ctx.moveTo(left, sy);
                ctx.lineTo(left + width, sy);
                ctx.stroke();
              }
            }
            ctx.restore();
          },
        ],
      },
    };
    const u = new uPlot(opts, [[], ...channels.map(() => [])] as unknown as uPlot.AlignedData, host);

    const ro = new ResizeObserver(() => {
      const r = host.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width));
      const h = Math.max(1, Math.round(r.height));
      if (w > 1 && h > 1) u.setSize({ width: w, height: h });
    });
    ro.observe(host);

    const valid = (v: number | undefined): v is number => v !== undefined && !Number.isNaN(v);
    const laneOf = (c: RecChannel) => c.lane ?? c.key;

    const tick = () => {
      af = requestAnimationFrame(tick);
      const trail = trailRef.current;
      if (trail.length < 2) return;
      const tNow = trail[trail.length - 1].t;
      const win = winRef.current / 1000;
      const t0 = tNow - win;

      let startIdx = trail.length - 1;
      while (startIdx > 0 && trail[startIdx - 1].t >= t0) startIdx--;
      if (startIdx > 0) startIdx--; // include one frame past the left edge so the line fills it (uPlot clips)
      const m = trail.length - startIdx;
      if (m < 2) return;

      const xs = new Array<number>(m);
      const act = activeRef.current;
      const activeChans = channels.filter((c) => act.has(c.key));

      // raw values + per-channel "has data" flag
      const raw = new Map<string, (number | null)[]>();
      const hasData = new Map<string, boolean>();
      for (const c of activeChans) { raw.set(c.key, new Array<number | null>(m)); hasData.set(c.key, false); }
      for (let k = 0; k < m; k++) {
        const f = trail[startIdx + k];
        xs[k] = (f.t - tNow) * 1000; // ms, newest = 0 at right
        for (const c of activeChans) {
          const v = c.get(f);
          if (valid(v)) { raw.get(c.key)![k] = v; hasData.set(c.key, true); }
          else raw.get(c.key)![k] = null;
        }
      }

      // ordered lanes (only those with at least one channel carrying data)
      const laneIds: string[] = [];
      const laneChans = new Map<string, RecChannel[]>();
      for (const c of activeChans) {
        if (!hasData.get(c.key)) continue;
        const id = laneOf(c);
        if (!laneChans.has(id)) { laneChans.set(id, []); laneIds.push(id); }
        laneChans.get(id)!.push(c);
      }
      const N = laneIds.length;
      const cols: (number | null)[][] = channels.map(() => new Array<number | null>(m).fill(null));
      const layout: LaneLayout[] = [];

      if (N === 0) {
        layoutRef.current = [];
        u.setData([xs, ...cols] as unknown as uPlot.AlignedData);
        return;
      }

      for (let li = 0; li < N; li++) {
        const id = laneIds[li];
        const lcs = laneChans.get(id)!;
        // raw min/max across the lane's channels
        let lo = Infinity, hi = -Infinity;
        for (const c of lcs) {
          const col = raw.get(c.key)!;
          for (let k = 0; k < m; k++) { const v = col[k]; if (v !== null) { if (v < lo) lo = v; if (v > hi) hi = v; } }
        }
        if (lo === Infinity) { lo = -1; hi = 1; }
        lo = Math.min(lo, 0); hi = Math.max(hi, 0); // anchor 0 so the baseline is always on-scale
        if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
        const rng = hi - lo;
        lo -= rng * 0.1; hi += rng * 0.1;
        // lane scale: EMA-track in auto, frozen in manual; manual zoom around the centre
        let baseSc = scaleRef.current.get(id);
        if (!baseSc) { baseSc = { lo, hi }; scaleRef.current.set(id, baseSc); }
        else if (scaleModeRef.current === "auto") { baseSc.lo += 0.15 * (lo - baseSc.lo); baseSc.hi += 0.15 * (hi - baseSc.hi); }
        const center = (baseSc.lo + baseSc.hi) / 2;
        const half = (((baseSc.hi - baseSc.lo) / 2) || 1) / (zoomRef.current || 1);
        const scLo = center - half, scHi = center + half;
        const span = scHi - scLo || 1;

        // lane vertical band in [0,1] (lane 0 at top)
        const laneH = 1 / N;
        const top = 1 - li * laneH;
        const bot = 1 - (li + 1) * laneH;
        const bandTop = top - PAD * laneH;
        const bandBot = bot + PAD * laneH;
        for (const c of lcs) {
          const col = raw.get(c.key)!;
          const out = cols[channels.indexOf(c)];
          for (let k = 0; k < m; k++) {
            const v = col[k];
            out[k] = v === null ? null : bandBot + ((v - scLo) / span) * (bandTop - bandBot);
          }
        }
        layout.push({ chans: lcs.map((c) => ({ label: c.label, color: c.color })), topVal: top, botVal: bot, lo: scLo, hi: scHi });
      }
      layoutRef.current = layout;

      // resetScales=true (default) so uPlot commits the redraw + re-runs hooks.
      u.setData([xs, ...cols] as unknown as uPlot.AlignedData);
    };
    af = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(af);
      ro.disconnect();
      u.destroy();
    };
  }, [trailRef, channels]);

  return <div ref={hostRef} className="h-full w-full" />;
}
