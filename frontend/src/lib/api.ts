// REST helpers for backend control (profile/source/port selection).

import { HTTP_BASE } from "./config";

export interface Health {
  status: string;
  source: string;
  profile: string;
  port: string | null;
  baud: number;
  clients: number;
}

export interface PortInfo {
  device: string;
  description: string;
}

export interface SourceRequest {
  source: "synthetic" | "serial";
  profile: string;
  port?: string | null;
  baud?: number;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${HTTP_BASE}${path}`);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

export const getHealth = () => getJson<Health>("/api/health");
export const getProfiles = () => getJson<{ active: string; available: string[] }>("/api/profiles");
export const getPorts = () => getJson<{ ports: PortInfo[] }>("/api/ports");

export async function setSource(body: SourceRequest): Promise<void> {
  const res = await fetch(`${HTTP_BASE}/api/source`, {
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
