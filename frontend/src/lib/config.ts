// Backend location. Override via NEXT_PUBLIC_BACKEND_HOST (e.g. "192.168.0.20:8000").

const HOST =
  process.env.NEXT_PUBLIC_BACKEND_HOST?.trim() || "127.0.0.1:8000";

export const HTTP_BASE = `http://${HOST}`;
export const WS_URL = `ws://${HOST}/ws/telemetry`;
