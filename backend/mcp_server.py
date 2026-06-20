"""MCP server exposing live detector telemetry as tools for AI agents (Milestone F).

This is a standalone stdio MCP server. It connects to the running studio backend as a
WebSocket client (same telemetry contract as everything else), keeps the latest frames,
and exposes them as tools. Point your MCP-capable assistant at:

    command: uv
    args:    ["run", "python", "mcp_server.py"]
    cwd:     <repo>/backend

Override the backend with METAL_LAB_WS (default ws://127.0.0.1:8000/ws/telemetry).
The backend must be running (uv run python main.py).
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import time
from collections import deque
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field

import httpx
import numpy as np
from mcp.server.fastmcp import Context, FastMCP
from websockets.asyncio.client import connect

from app import config

WS_URL = os.environ.get("METAL_LAB_WS", f"ws://{config.HOST}:{config.PORT}/ws/telemetry")
HTTP_BASE = os.environ.get("METAL_LAB_HTTP", f"http://{config.HOST}:{config.PORT}")


async def _http(method: str, path: str, json: dict | None = None) -> dict:
    """Call a backend REST endpoint; return parsed JSON or an {"error": ...} dict."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as c:
            r = await c.request(method, f"{HTTP_BASE}{path}", json=json)
    except httpx.HTTPError as exc:
        return {"error": f"backend unreachable: {exc}"}
    if r.status_code >= 400:
        detail = r.text
        try:
            detail = r.json().get("detail", detail)
        except Exception:
            pass
        return {"error": f"HTTP {r.status_code}: {detail}"}
    try:
        return r.json()
    except Exception:
        return {"ok": True}


def _wrap_deg(d: float) -> float:
    return (d + 180.0) % 360.0 - 180.0


# --- telemetry client (background WS consumer) -------------------------------


class TelemetryClient:
    def __init__(self, url: str) -> None:
        self.url = url
        self.connected = False
        self.profile: dict | None = None
        self.schema_version: str | None = None
        self.feature: dict | None = None
        self.raw: dict | None = None
        self._ws = None
        self._ack_waiters: deque[asyncio.Future] = deque()
        self._feat_times: deque[float] = deque(maxlen=60)
        self._raw_times: deque[float] = deque(maxlen=30)

    @staticmethod
    def _hz(times: deque[float]) -> float:
        if len(times) < 2:
            return 0.0
        span = times[-1] - times[0]
        return (len(times) - 1) / span if span > 0 else 0.0

    @property
    def feature_hz(self) -> float:
        return self._hz(self._feat_times)

    @property
    def raw_hz(self) -> float:
        return self._hz(self._raw_times)

    async def run(self) -> None:
        retry = 0
        while True:
            try:
                async with connect(self.url, max_size=None) as ws:
                    self._ws = ws
                    self.connected = True
                    retry = 0
                    async for message in ws:
                        self._on_message(message)
            except asyncio.CancelledError:
                raise
            except Exception:
                pass
            finally:
                self.connected = False
                self._ws = None
                # fail any pending config waiters
                while self._ack_waiters:
                    fut = self._ack_waiters.popleft()
                    if not fut.done():
                        fut.set_result({"ok": False, "detail": "connection lost"})
            retry = min(retry + 1, 6)
            await asyncio.sleep(min(0.25 * 2**retry, 5.0))

    def _on_message(self, message: str) -> None:
        try:
            msg = json.loads(message)
        except json.JSONDecodeError:
            return
        t = msg.get("type")
        if t == "hello":
            self.profile = msg.get("profile")
            self.schema_version = msg.get("schema_version")
        elif t == "feature":
            self.feature = msg
            self._feat_times.append(time.monotonic())
        elif t == "raw":
            self.raw = msg
            self._raw_times.append(time.monotonic())
        elif t == "config_ack":
            if self._ack_waiters:
                fut = self._ack_waiters.popleft()
                if not fut.done():
                    fut.set_result(msg)

    async def send_config(self, key: str, value, timeout: float = 2.0) -> dict:
        if not self._ws or not self.connected:
            return {"ok": False, "detail": "not connected to backend", "key": key, "value": value}
        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        self._ack_waiters.append(fut)
        await self._ws.send(json.dumps({"type": "config", "key": key, "value": value}))
        try:
            return await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            if fut in self._ack_waiters:
                self._ack_waiters.remove(fut)
            return {"ok": False, "detail": "ack timeout", "key": key, "value": value}


@dataclass
class AppState:
    client: TelemetryClient = field(default_factory=lambda: TelemetryClient(WS_URL))


@asynccontextmanager
async def lifespan(_server: FastMCP) -> AsyncIterator[AppState]:
    state = AppState()
    task = asyncio.create_task(state.client.run())
    try:
        yield state
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


mcp = FastMCP("metal-detector-studio", lifespan=lifespan)


def _state(ctx: Context) -> AppState:
    return ctx.request_context.lifespan_context


# --- tools -------------------------------------------------------------------


@mcp.tool()
def get_status(ctx: Context) -> dict:
    """Connection status, active profile id, and measured stream rates."""
    c = _state(ctx).client
    return {
        "connected": c.connected,
        "backend_ws": c.url,
        "schema_version": c.schema_version,
        "profile": c.profile.get("id") if c.profile else None,
        "feature_hz": round(c.feature_hz, 1),
        "raw_hz": round(c.raw_hz, 1),
        "has_feature": c.feature is not None,
        "has_raw": c.raw is not None,
    }


@mcp.tool()
def get_profile(ctx: Context) -> dict:
    """The active device profile: harmonics, phase-diff defs, raw spec, config keys."""
    c = _state(ctx).client
    if not c.profile:
        return {"error": "no profile yet; is the backend running?"}
    p = c.profile
    return {
        "id": p.get("id"),
        "title": p.get("title"),
        "harmonics": p.get("harmonics"),
        "phase_diffs": p.get("phase_diffs"),
        "extras": p.get("extras"),
        "raw": p.get("raw"),
        "stream": p.get("stream"),
        "config_keys": p.get("config_keys"),
        "targets": [t["name"] for t in p.get("synth", {}).get("targets", [])],
    }


@mcp.tool()
def get_latest_feature(ctx: Context) -> dict:
    """Latest per-harmonic feature frame: mag/phase(deg)/I/Q, phase diffs, extras."""
    c = _state(ctx).client
    f = c.feature
    if not f:
        return {"error": "no feature frame yet"}
    harmonics = {
        hid: {
            "mag": round(s["mag"], 2),
            "phase_deg": round(math.degrees(s["phase"]), 2),
            "i": round(s["i"], 2),
            "q": round(s["q"], 2),
        }
        for hid, s in f["harmonics"].items()
    }
    phase_diffs = {k: round(math.degrees(v), 2) for k, v in f.get("phase_diffs", {}).items()}
    return {
        "seq": f["seq"],
        "t": round(f["t"], 3),
        "harmonics": harmonics,
        "phase_diffs_deg": phase_diffs,
        "extras": {k: round(v, 3) for k, v in f.get("extras", {}).items()},
    }


@mcp.tool()
def analyze_phase(ctx: Context) -> dict:
    """Phase-diff discrimination: compare live phase diffs to each target archetype's
    expected phase diffs (from the profile) and rank the closest match.

    Note: meaningful at a target's peak; between targets the ground vector dominates.
    """
    c = _state(ctx).client
    if not c.feature or not c.profile:
        return {"error": "need both a feature frame and a profile"}
    pdefs = c.profile.get("phase_diffs", [])
    if not pdefs:
        return {"error": "profile has no phase diffs (single-frequency device)"}

    live = {k: math.degrees(v) for k, v in c.feature.get("phase_diffs", {}).items()}

    ranked = []
    for tgt in c.profile.get("synth", {}).get("targets", []):
        resp = tgt["response"]
        dist = 0.0
        expected = {}
        for pd in pdefs:
            ev = _wrap_deg(resp[pd["from"]]["phase_deg"] - resp[pd["to"]]["phase_deg"])
            expected[pd["name"]] = round(ev, 1)
            dist += abs(_wrap_deg(ev - live.get(pd["name"], 0.0)))
        ranked.append({"target": tgt["name"], "distance_deg": round(dist, 1), "expected": expected})

    ranked.sort(key=lambda r: r["distance_deg"])
    return {
        "live_phase_diffs_deg": {k: round(v, 1) for k, v in live.items()},
        "best_match": ranked[0]["target"] if ranked else None,
        "ranking": ranked,
    }


@mcp.tool()
def get_spectrum(ctx: Context, top_n: int = 6) -> dict:
    """FFT peaks of the latest raw RX block (Hann window): top peaks as {freq, dBFS}."""
    c = _state(ctx).client
    if not c.raw or not c.profile:
        return {"error": "no raw block yet"}
    fs = c.raw["sample_rate_hz"]
    fullscale = c.profile.get("raw", {}).get("fullscale_lsb", 2047)
    x = np.asarray(c.raw["samples"], dtype=float)
    n = len(x)
    w = np.hanning(n)
    amp = np.abs(np.fft.rfft(x * w)) * 2.0 / np.sum(w)
    db = 20.0 * np.log10(amp / fullscale + 1e-12)
    freqs = np.fft.rfftfreq(n, 1.0 / fs)

    # local maxima, then strongest top_n
    idx = [i for i in range(1, len(db) - 1) if db[i] > db[i - 1] and db[i] >= db[i + 1]]
    idx.sort(key=lambda i: db[i], reverse=True)
    peaks = [
        {"freq_hz": round(float(freqs[i]), 1), "freq_khz": round(float(freqs[i]) / 1000, 4),
         "db": round(float(db[i]), 1)}
        for i in idx[:top_n]
    ]
    return {"seq": c.raw["seq"], "sample_rate_hz": fs, "bins": int(len(db)), "peaks": peaks}


@mcp.tool()
async def set_config(ctx: Context, key: str, value) -> dict:
    """Send a config command to the active source (e.g. paused, noise, gain,
    sweep_period, target). Returns the device/source ack."""
    c = _state(ctx).client
    if c.profile and key not in c.profile.get("config_keys", []):
        return {"ok": False, "detail": f"key not in profile config_keys: {c.profile.get('config_keys')}"}
    return await c.send_config(key, value)


# --- recording / replay control (backend REST) ------------------------------


@mcp.tool()
async def list_recordings() -> dict:
    """List saved telemetry session recordings (name, size, mtime)."""
    return await _http("GET", "/api/recordings")


@mcp.tool()
async def recording_status() -> dict:
    """Whether a recording is in progress, plus its frame/byte counts and elapsed time."""
    return await _http("GET", "/api/record")


@mcp.tool()
async def start_recording() -> dict:
    """Start recording the live telemetry stream to a new NDJSON file."""
    return await _http("POST", "/api/record", {"action": "start"})


@mcp.tool()
async def stop_recording() -> dict:
    """Stop the current recording; returns the file name and final counts."""
    return await _http("POST", "/api/record", {"action": "stop"})


@mcp.tool()
async def replay(file: str, speed: float = 1.0, loop: bool = False) -> dict:
    """Switch the telemetry source to replay a recording (by file name). After this,
    every read tool (get_latest_feature, get_spectrum, ...) reflects the replayed data.
    Use go_live() to return to the hardware."""
    return await _http(
        "POST", "/api/source",
        {"source": "replay", "file": file, "speed": speed, "loop": loop},
    )


@mcp.tool()
async def go_live() -> dict:
    """Switch the telemetry source back to the live serial device (reuses the backend's
    current profile + port)."""
    health = await _http("GET", "/api/health")
    if "error" in health:
        return health
    profile, port = health.get("profile"), health.get("port")
    if not port:
        return {"error": "backend has no serial port configured"}
    return await _http("POST", "/api/source", {"source": "serial", "profile": profile, "port": port})


@mcp.tool()
async def delete_recording(name: str) -> dict:
    """Delete a saved recording by file name (cannot delete the one being replayed)."""
    return await _http("DELETE", f"/api/recordings/{name}")


if __name__ == "__main__":
    mcp.run()
