"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { WS_URL } from "./config";
import type {
  ConfigAck,
  FeatureFrame,
  Hello,
  Profile,
  RawBlock,
  ServerMessage,
} from "./types";

export type ConnStatus = "connecting" | "open" | "closed";

const TRAIL_MAX = 2048; // recent feature frames kept for the hodograph trail

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

  const wsRef = useRef<WebSocket | null>(null);
  const featureRef = useRef<FeatureFrame | null>(null);
  const rawRef = useRef<RawBlock | null>(null);
  const trailRef = useRef<FeatureFrame[]>([]);

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
            break;
          }
          case "feature": {
            featureRef.current = msg;
            const trail = trailRef.current;
            trail.push(msg);
            if (trail.length > TRAIL_MAX) trail.splice(0, trail.length - TRAIL_MAX);
            featTimes.current.push(performance.now());
            break;
          }
          case "raw": {
            rawRef.current = msg as RawBlock;
            rawTimes.current.push(performance.now());
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
    let af = 0;
    let lastRate = performance.now();
    const tick = () => {
      setFeature(featureRef.current);
      setRaw(rawRef.current);

      const now = performance.now();
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
    stats,
    sendConfig,
  };
}
