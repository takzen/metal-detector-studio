"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { WS_URL } from "./config";
import type {
  ConfigAck,
  FeatureFrame,
  Hello,
  Profile,
  RawBlock,
  RawIQBlock,
  ServerMessage,
} from "./types";

export type ConnStatus = "connecting" | "open" | "closed";

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
  stats: { featureHz: number; rawHz: number; lastAck: ConfigAck | null };
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

  const wsRef = useRef<WebSocket | null>(null);
  const featureRef = useRef<FeatureFrame | null>(null);
  const rawRef = useRef<RawBlock | null>(null);
  const trailRef = useRef<FeatureFrame[]>([]);
  const iqIRef = useRef<number[]>([]);
  const iqQRef = useRef<number[]>([]);
  const iqFsRef = useRef<number>(1000);
  const iqCountRef = useRef<number>(0);
  // EMA-smoothed values for the (slow, readable) numeric readouts
  const featSmoothRef = useRef<{
    i: Record<string, number>;
    q: Record<string, number>;
    extras: Record<string, number>;
  } | null>(null);

  // arrival timestamps for rate measurement (sliding window; data can arrive bursty)
  const featTimes = useRef<number[]>([]);
  const rawTimes = useRef<number[]>([]);

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
        let msg: ServerMessage;
        try {
          msg = JSON.parse(ev.data as string);
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
            featTimes.current.push(performance.now());
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
            rawTimes.current.push(performance.now());
            setHasIq(true); // no-op once already true
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

  // --- rAF: flush throttled state + compute rates over a sliding window ---
  useEffect(() => {
    const RATE_WINDOW_MS = 2000; // average over 2 s so bursty arrival reads smoothly
    const DISP_MS = 250; // refresh numeric readouts ~4x/s so they're readable
    let af = 0;
    let lastRate = performance.now();
    let lastDisp = performance.now();
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
        lastRate = now;
        const cut = now - RATE_WINDOW_MS;
        const ft = featTimes.current;
        const rt = rawTimes.current;
        while (ft.length && ft[0] < cut) ft.shift();
        while (rt.length && rt[0] < cut) rt.shift();
        const win = RATE_WINDOW_MS / 1000;
        setStats((s) => ({ ...s, featureHz: ft.length / win, rawHz: rt.length / win }));
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
    stats,
    sendConfig,
  };
}
