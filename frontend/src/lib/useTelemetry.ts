"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getHealth, type FrameStats, type SerialStats } from "./api";
import { WS_URL } from "./config";
import type {
  ConfigAck,
  FeatureFrame,
  Hello,
  Profile,
  RawAdcBlock,
  RawBlock,
  RawIQBlock,
  ServerMessage,
} from "./types";

export type ConnStatus = "connecting" | "open" | "closed";

/** Live link-quality metrics (drops, jitter, throughput, real-vs-declared rates). */
export interface LinkStats {
  /** WebSocket throughput to the browser. */
  wsKibPerSec: number;
  /** Age of the most recent telemetry frame (stall detector). */
  ageMs: number;
  feature: { hz: number; recv: number; drops: number; dropPct: number; jitterMs: number };
  /** Raw I/Q stream: measured samples/s vs the firmware-declared sample rate. */
  iq: { samplesPerSec: number; fsDeclared: number; drops: number; dropPct: number };
  /** Serial-wire counters (null when the active source has no physical link). */
  serial: { connected: boolean; bytesPerSec: number; badPerSec: number; badTotal: number } | null;
  /** Schema-validation counters (frames checked against schema.json on the backend). */
  schema: { ok: number; bad: number; lastError: string } | null;
}

function emptyLink(): LinkStats {
  return {
    wsKibPerSec: 0,
    ageMs: 0,
    feature: { hz: 0, recv: 0, drops: 0, dropPct: 0, jitterMs: 0 },
    iq: { samplesPerSec: 0, fsDeclared: 0, drops: 0, dropPct: 0 },
    serial: null,
    schema: null,
  };
}

const TRAIL_MAX = 2048; // recent feature frames kept for the hodograph trail
const IQ_MAX = 4096; // rolling 1 kHz I/Q buffer (~4 s) — scope/FFT + trigger pre/post room

export interface Telemetry {
  status: ConnStatus;
  profile: Profile | null;
  schemaVersion: string | null;
  /** Throttled (rAF) latest frames — safe for text UI. */
  feature: FeatureFrame | null;
  raw: RawBlock | null;
  /** Live refs — read directly from canvas render loops (no React churn). */
  featureRef: React.RefObject<FeatureFrame | null>;
  rawRef: React.RefObject<RawBlock | null>;
  trailRef: React.RefObject<FeatureFrame[]>;
  /** Rolling 1 kHz I/Q buffers (serial scope/FFT). */
  iqIRef: React.RefObject<number[]>;
  iqQRef: React.RefObject<number[]>;
  iqFsRef: React.RefObject<number>;
  /** Total I/Q samples ever received — absolute index for the scope trigger. */
  iqCountRef: React.RefObject<number>;
  hasIq: boolean;
  /** Latest raw single-channel ADC dump (SERVICE3 full telemetry) for the ENOB/FFT view. */
  adcRef: React.RefObject<RawAdcBlock | null>;
  hasAdc: boolean;
  stats: { featureHz: number; rawHz: number; lastAck: ConfigAck | null };
  link: LinkStats;
  sendConfig: (key: string, value: unknown) => void;
}

export function useTelemetry(): Telemetry {
  const [status, setStatus] = useState<ConnStatus>("connecting");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [schemaVersion, setSchemaVersion] = useState<string | null>(null);
  const [feature, setFeature] = useState<FeatureFrame | null>(null);
  const [raw, setRaw] = useState<RawBlock | null>(null);
  const [stats, setStats] = useState<Telemetry["stats"]>({
    featureHz: 0,
    rawHz: 0,
    lastAck: null,
  });

  const [hasIq, setHasIq] = useState(false);
  const [hasAdc, setHasAdc] = useState(false);
  const [link, setLink] = useState<LinkStats>(emptyLink);

  const wsRef = useRef<WebSocket | null>(null);
  const featureRef = useRef<FeatureFrame | null>(null);
  const rawRef = useRef<RawBlock | null>(null);
  const trailRef = useRef<FeatureFrame[]>([]);
  const iqIRef = useRef<number[]>([]);
  const iqQRef = useRef<number[]>([]);
  const iqFsRef = useRef<number>(1000);
  const iqCountRef = useRef<number>(0);
  const adcRef = useRef<RawAdcBlock | null>(null);
  // EMA-smoothed values for the (slow, readable) numeric readouts
  const featSmoothRef = useRef<{
    i: Record<string, number>;
    q: Record<string, number>;
    extras: Record<string, number>;
  } | null>(null);

  // arrival timestamps for rate measurement (sliding window; data can arrive bursty)
  const featTimes = useRef<number[]>([]);
  const rawTimes = useRef<number[]>([]);

  // link-quality tracking. Drops are inferred from gaps in the per-stream `seq`
  // counter (a frame dropped at the hub or on the WS leaves a hole). recv/drops
  // are cumulative for the session so the headline drop% reflects the whole run.
  const featSeqRef = useRef(-1);
  const featDropRef = useRef(0);
  const featRecvRef = useRef(0);
  const iqSeqRef = useRef(-1);
  const iqDropRef = useRef(0);
  const iqRecvRef = useRef(0);
  const wsBytesRef = useRef(0); // chars received since the last rate tick
  const lastMsgRef = useRef(0); // perf.now() of the last telemetry frame
  const serialStatRef = useRef<SerialStats | null>(null); // latest /api/health snapshot
  const serialRateRef = useRef<{ bytesPerSec: number; badPerSec: number } | null>(null);
  const frameStatRef = useRef<FrameStats | null>(null); // schema-validation counters
  // hardware-zero detection: last seen firmware ENTER reference (ref = X - DX) + flash timer

  const sendConfig = useCallback((key: string, value: unknown) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "config", key, value }));
    }
  }, []);

  // --- WebSocket lifecycle with reconnect backoff ---
  useEffect(() => {
    let closedByUnmount = false;
    let retry = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      setStatus("connecting");
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        retry = 0;
        setStatus("open");
      };

      ws.onmessage = (ev) => {
        const dataStr = ev.data as string;
        wsBytesRef.current += dataStr.length;
        let msg: ServerMessage;
        try {
          msg = JSON.parse(dataStr);
        } catch {
          return;
        }
        switch (msg.type) {
          case "hello": {
            const h = msg as Hello;
            setProfile(h.profile);
            setSchemaVersion(h.schema_version);
            trailRef.current = [];
            iqIRef.current = [];
            iqQRef.current = [];
            iqCountRef.current = 0;
            featSmoothRef.current = null;
            // a hello marks a (re)bind to a source — its seq counters restart at 0
            featSeqRef.current = -1;
            iqSeqRef.current = -1;
            setHasIq(false);
            break;
          }
          case "feature": {
            const f = msg as FeatureFrame;
            // Re-stamp with the client arrival clock (monotonic, seconds). The backend `t` is
            // assigned when the queue is drained, so bursty serial/WS delivery clumps it and the
            // strip-chart scroll jerks. A client clock gives the recorder a smooth time base.
            f.t = performance.now() / 1000;
            featureRef.current = f;
            const trail = trailRef.current;
            trail.push(f);
            if (trail.length > TRAIL_MAX) trail.splice(0, trail.length - TRAIL_MAX);
            const now = performance.now();
            featTimes.current.push(now);
            lastMsgRef.current = now;
            // drop detection: a forward jump in seq means frames went missing
            if (featSeqRef.current >= 0 && f.seq > featSeqRef.current + 1) {
              featDropRef.current += f.seq - featSeqRef.current - 1;
            }
            featSeqRef.current = f.seq;
            featRecvRef.current += 1;
            // EMA smoothing for the readable numeric readouts
            const A = 0.15;
            const sm = featSmoothRef.current ?? { i: {}, q: {}, extras: {} };
            for (const id in f.harmonics) {
              const hs = f.harmonics[id];
              sm.i[id] = sm.i[id] === undefined ? hs.i : sm.i[id] + A * (hs.i - sm.i[id]);
              sm.q[id] = sm.q[id] === undefined ? hs.q : sm.q[id] + A * (hs.q - sm.q[id]);
            }
            for (const k in f.extras) {
              const v = f.extras[k];
              sm.extras[k] = sm.extras[k] === undefined ? v : sm.extras[k] + A * (v - sm.extras[k]);
            }
            featSmoothRef.current = sm;
            break;
          }
          case "raw": {
            rawRef.current = msg as RawBlock;
            rawTimes.current.push(performance.now());
            lastMsgRef.current = performance.now();
            break;
          }
          case "raw_iq": {
            const b = msg as RawIQBlock;
            iqFsRef.current = b.sample_rate_hz || 1000;
            const bi = iqIRef.current;
            const bq = iqQRef.current;
            for (let k = 0; k < b.i.length; k++) {
              bi.push(b.i[k]);
              bq.push(b.q[k]);
            }
            if (bi.length > IQ_MAX) bi.splice(0, bi.length - IQ_MAX);
            if (bq.length > IQ_MAX) bq.splice(0, bq.length - IQ_MAX);
            iqCountRef.current += b.i.length;
            const nowIq = performance.now();
            rawTimes.current.push(nowIq);
            lastMsgRef.current = nowIq;
            if (iqSeqRef.current >= 0 && b.seq > iqSeqRef.current + 1) {
              iqDropRef.current += b.seq - iqSeqRef.current - 1;
            }
            iqSeqRef.current = b.seq;
            iqRecvRef.current += 1;
            setHasIq(true); // no-op once already true
            break;
          }
          case "adc_raw": {
            adcRef.current = msg as RawAdcBlock;
            lastMsgRef.current = performance.now();
            setHasAdc(true); // no-op once already true
            break;
          }
          case "config_ack": {
            setStats((s) => ({ ...s, lastAck: msg as ConfigAck }));
            break;
          }
        }
      };

      ws.onclose = () => {
        if (closedByUnmount) return;
        setStatus("closed");
        retry = Math.min(retry + 1, 6);
        const delay = Math.min(250 * 2 ** retry, 5000);
        reconnectTimer = setTimeout(connect, delay);
      };

      ws.onerror = () => ws.close();
    };

    connect();

    return () => {
      closedByUnmount = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, []);

  // --- poll /api/health for serial-wire counters; delta them into rates ---
  useEffect(() => {
    let alive = true;
    let prev: { bytes: number; bad: number; t: number } | null = null;
    const poll = async () => {
      try {
        const h = await getHealth();
        if (!alive) return;
        serialStatRef.current = h.serial;
        frameStatRef.current = h.frames ?? null;
        if (h.serial) {
          const now = performance.now();
          if (prev) {
            const dt = (now - prev.t) / 1000;
            if (dt > 0) {
              serialRateRef.current = {
                bytesPerSec: Math.max(0, (h.serial.bytes_in - prev.bytes) / dt),
                badPerSec: Math.max(0, (h.serial.lines_bad - prev.bad) / dt),
              };
            }
          }
          prev = { bytes: h.serial.bytes_in, bad: h.serial.lines_bad, t: now };
        } else {
          serialRateRef.current = null;
          prev = null;
        }
      } catch {
        if (!alive) return;
        serialStatRef.current = null;
        serialRateRef.current = null;
        frameStatRef.current = null;
        prev = null;
      }
    };
    void poll();
    const id = setInterval(() => void poll(), 1500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // --- rAF: flush throttled state + compute rates over a sliding window ---
  useEffect(() => {
    const RATE_WINDOW_MS = 2000; // average over 2 s so bursty arrival reads smoothly
    const DISP_MS = 250; // refresh numeric readouts ~4x/s so they're readable
    let af = 0;
    let lastRate = performance.now();
    let lastDisp = performance.now();
    let prevIqCount = iqCountRef.current;
    let prevIqTime = performance.now();
    const tick = () => {
      const now = performance.now();
      if (now - lastDisp >= DISP_MS) {
        lastDisp = now;
        const fr = featureRef.current;
        const sm = featSmoothRef.current;
        if (fr && sm) {
          const harmonics: FeatureFrame["harmonics"] = {};
          for (const id in fr.harmonics) {
            const i = sm.i[id] ?? fr.harmonics[id].i;
            const q = sm.q[id] ?? fr.harmonics[id].q;
            harmonics[id] = { i, q, mag: Math.hypot(i, q), phase: Math.atan2(q, i) };
          }
          setFeature({ ...fr, harmonics, extras: { ...sm.extras } });
        } else {
          setFeature(fr);
        }
        setRaw(rawRef.current);
      }

      if (now - lastRate >= 300) {
        const dt = now - lastRate;
        lastRate = now;
        const cut = now - RATE_WINDOW_MS;
        const ft = featTimes.current;
        const rt = rawTimes.current;
        while (ft.length && ft[0] < cut) ft.shift();
        while (rt.length && rt[0] < cut) rt.shift();
        const win = RATE_WINDOW_MS / 1000;
        const featureHz = ft.length / win;
        const rawHz = rt.length / win;
        setStats((s) => ({ ...s, featureHz, rawHz }));

        // --- link quality (computed on the same cadence) ---
        const wsBytes = wsBytesRef.current;
        wsBytesRef.current = 0;
        const wsBytesPerSec = dt > 0 ? (wsBytes * 1000) / dt : 0;

        // feature inter-arrival jitter = stddev of consecutive gaps over the window
        let jitterMs = 0;
        if (ft.length > 2) {
          let mean = 0;
          for (let k = 1; k < ft.length; k++) mean += ft[k] - ft[k - 1];
          mean /= ft.length - 1;
          let v = 0;
          for (let k = 1; k < ft.length; k++) {
            const d = ft[k] - ft[k - 1] - mean;
            v += d * d;
          }
          jitterMs = Math.sqrt(v / (ft.length - 1));
        }

        // measured I/Q sample rate vs the firmware-declared fs
        const ic = iqCountRef.current;
        const iqDt = (now - prevIqTime) / 1000;
        const iqSps = iqDt > 0 ? Math.max(0, (ic - prevIqCount) / iqDt) : 0;
        prevIqCount = ic;
        prevIqTime = now;

        const ageMs = lastMsgRef.current ? now - lastMsgRef.current : 0;
        const fRecv = featRecvRef.current;
        const fDrop = featDropRef.current;
        const iRecv = iqRecvRef.current;
        const iDrop = iqDropRef.current;
        const ss = serialStatRef.current;
        const sr = serialRateRef.current;

        setLink({
          wsKibPerSec: wsBytesPerSec / 1024,
          ageMs,
          feature: {
            hz: featureHz,
            recv: fRecv,
            drops: fDrop,
            dropPct: fRecv + fDrop > 0 ? (100 * fDrop) / (fRecv + fDrop) : 0,
            jitterMs,
          },
          iq: {
            samplesPerSec: iqSps,
            fsDeclared: iqFsRef.current || 0,
            drops: iDrop,
            dropPct: iRecv + iDrop > 0 ? (100 * iDrop) / (iRecv + iDrop) : 0,
          },
          serial: ss
            ? {
                connected: ss.connected,
                bytesPerSec: sr?.bytesPerSec ?? 0,
                badPerSec: sr?.badPerSec ?? 0,
                badTotal: ss.lines_bad,
              }
            : null,
          schema: frameStatRef.current
            ? {
                ok: frameStatRef.current.frames_ok,
                bad: frameStatRef.current.frames_bad,
                lastError: frameStatRef.current.last_error,
              }
            : null,
        });
      }
      af = requestAnimationFrame(tick);
    };
    af = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(af);
  }, []);

  return {
    status,
    profile,
    schemaVersion,
    feature,
    raw,
    featureRef,
    rawRef,
    trailRef,
    iqIRef,
    iqQRef,
    iqFsRef,
    iqCountRef,
    hasIq,
    adcRef,
    hasAdc,
    stats,
    link,
    sendConfig,
  };
}
