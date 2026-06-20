// REST helpers for backend control (profile/source/port selection).

import { HTTP_BASE } from "./config";

/** Cumulative serial link counters from the backend reader thread. */
export interface SerialStats {
  connected: boolean;
  bytes_in: number;
  lines_ok: number;
  lines_bad: number;
}

/** Cumulative schema-validation counters (frames checked against schema.json). */
export interface FrameStats {
  frames_ok: number;
  frames_bad: number;
  skipped: number;
  last_error: string;
}

export interface Health {
  status: string;
  source: string;
  profile: string;
  port: string | null;
  baud: number;
  clients: number;
  serial: SerialStats | null;
  frames?: FrameStats;
}

export interface PortInfo {
  device: string;
  description: string;
}

export type SourceRequest =
  | { source: "serial"; profile: string; port?: string | null; baud?: number }
  | { source: "replay"; file: string; profile?: string | null; speed?: number; loop?: boolean };

/** A telemetry session recording on disk. */
export interface Recording {
  name: string;
  bytes: number;
  mtime: number;
}

/** Live recorder state from the backend. */
export interface RecordStatus {
  recording: boolean;
  path?: string;
  frames?: number;
  bytes?: number;
  elapsed_s?: number;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${HTTP_BASE}${path}`);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

export const getHealth = () => getJson<Health>("/api/health");
export const getProfiles = () => getJson<{ active: string; available: string[] }>("/api/profiles");
export const getPorts = () => getJson<{ ports: PortInfo[] }>("/api/ports");

async function postJson(path: string, body: unknown): Promise<void> {
  const res = await fetch(`${HTTP_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const j = await res.json();
      detail = j.detail ?? detail;
    } catch {}
    throw new Error(detail);
  }
}

export const setSource = (body: SourceRequest) => postJson("/api/source", body);

export const getRecordings = () => getJson<{ recordings: Recording[] }>("/api/recordings");
export const getRecordStatus = () => getJson<RecordStatus>("/api/record");
export const startRecord = () => postJson("/api/record", { action: "start" });
export const stopRecord = () => postJson("/api/record", { action: "stop" });

export async function deleteRecording(name: string): Promise<void> {
  const res = await fetch(`${HTTP_BASE}/api/recordings/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const j = await res.json();
      detail = j.detail ?? detail;
    } catch {}
    throw new Error(detail);
  }
}
