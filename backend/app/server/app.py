"""FastAPI app wiring (Milestone B5 + runtime source switching).

REST: /api/health, /api/schema, /api/profiles, /api/profile, /api/ports, POST /api/source.
WebSocket: /ws/telemetry — sends `hello` on connect, streams telemetry frames, and
accepts inbound `config` commands (forwarded to the active source, ack returned).

A single background "pump" task drains the active source and broadcasts every frame
through the hub. The source/profile can be swapped at runtime via POST /api/source;
on swap, a fresh `hello` is broadcast so connected clients re-bind to the new profile.
"""

from __future__ import annotations

import asyncio
import contextlib
import csv
import io
import json
import logging
import time
from collections.abc import AsyncIterator
from typing import Literal

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, ValidationError

from .. import config
from ..frame_validation import FrameValidator
from ..profiles import list_profiles, load_profile, load_schema
from ..recording import Recorder
from ..sources.base import TelemetrySource
from ..sources.replay import ReplaySource, read_meta
from ..sources.serial import SerialSource
from ..telemetry.models import ConfigAck, ConfigCommand, Hello
from .hub import ClientHandle, Hub

log = logging.getLogger("metal_lab")


class SourceRequest(BaseModel):
    source: str  # "serial" (real hardware) | "replay" (recorded file)
    profile: str | None = None  # derived from the recording's meta for replay
    port: str | None = None
    baud: int = 115200
    file: str | None = None  # recording name (replay)
    speed: float = 1.0  # replay playback speed
    loop: bool = False  # replay loops at end


class RecordRequest(BaseModel):
    action: Literal["start", "stop"]


def _emit(app: FastAPI, text: str) -> None:
    """Broadcast a frame to all WS clients and, if recording, append it to the file."""
    app.state.hub.broadcast(text)
    rec: Recorder | None = getattr(app.state, "recorder", None)
    if rec is not None:
        rec.feed(text)


def _make_source(
    source_kind: str, profile, port: str, baud: int,
    *, file: str | None = None, speed: float = 1.0, loop: bool = False,
) -> TelemetrySource:
    if source_kind == "serial":
        return SerialSource(profile, port, baud)
    if source_kind == "replay":
        if not file:
            raise ValueError("replay source requires a file")
        return ReplaySource(profile, config.RECORDINGS_DIR / file, speed=speed, loop=loop)
    raise ValueError(f"unsupported source {source_kind!r}")


def _recording_feature_csv(path) -> tuple[str, int]:
    """Flatten a recording's `feature` frames into CSV text. Columns: seq, t, then
    per-harmonic i/q/mag/phase, then the union of all extras keys (sorted). Returns
    (csv_text, row_count). Non-feature frames (raw/raw_iq/meta) are skipped — the
    time-series of the discrimination vector is what's useful offline."""
    feats: list[dict] = []
    hids: list[str] = []
    extra_keys: set[str] = set()
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("type") != "feature":
                continue
            feats.append(obj)
            for hid in obj.get("harmonics", {}):
                if hid not in hids:
                    hids.append(hid)
            extra_keys.update(obj.get("extras", {}).keys())

    extra_cols = sorted(extra_keys)
    header = ["seq", "t"]
    for hid in hids:
        header += [f"{hid}_i", f"{hid}_q", f"{hid}_mag", f"{hid}_phase"]
    header += extra_cols

    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(header)
    for f in feats:
        row: list = [f.get("seq"), f.get("t")]
        harmonics = f.get("harmonics", {})
        for hid in hids:
            s = harmonics.get(hid)
            if s:
                row += [s.get("i"), s.get("q"), s.get("mag"), s.get("phase")]
            else:
                row += ["", "", "", ""]
        ex = f.get("extras", {})
        row += [ex.get(k, "") for k in extra_cols]
        w.writerow(row)
    return buf.getvalue(), len(feats)


async def _pump(app: FastAPI, source: TelemetrySource) -> None:
    """Drain the given source and broadcast every frame as NDJSON-ready text."""
    try:
        async for packet in source.stream():
            validator: FrameValidator | None = getattr(app.state, "frame_validator", None)
            if validator is not None:
                validator.check(packet.model_dump())
            _emit(app, packet.model_dump_json())
    except asyncio.CancelledError:
        raise
    except Exception:  # keep the server alive; log and stop this pump
        log.exception("telemetry pump crashed")


def _hello(app: FastAPI) -> Hello:
    return Hello(
        schema_version=load_schema()["schema_version"],
        profile=app.state.profile.model_dump(by_alias=True),
    )


async def _start_source(
    app: FastAPI, *, source_kind: str, profile_id: str, port: str, baud: int,
    file: str | None = None, speed: float = 1.0, loop: bool = False,
) -> None:
    """(Re)create the active source + pump, then broadcast a fresh hello."""
    async with app.state.switch_lock:
        old_pump = getattr(app.state, "pump", None)
        old_source = getattr(app.state, "source", None)
        if old_pump is not None:
            old_pump.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await old_pump
        if old_source is not None:
            await old_source.aclose()

        profile = load_profile(profile_id)
        source = _make_source(
            source_kind, profile, port, baud, file=file, speed=speed, loop=loop
        )
        app.state.profile = profile
        app.state.source = source
        app.state.source_kind = source_kind
        app.state.port = port
        app.state.baud = baud
        app.state.pump = asyncio.create_task(_pump(app, source))
        log.info("source=%s profile=%s port=%s", source_kind, profile.id, port)

        if app.state.hub.client_count:
            _emit(app, _hello(app).model_dump_json())


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    app.state.hub = Hub()
    app.state.switch_lock = asyncio.Lock()
    app.state.recorder = None
    app.state.frame_validator = FrameValidator(load_schema())
    await _start_source(
        app,
        source_kind=config.SOURCE,
        profile_id=config.DEFAULT_PROFILE,
        port=config.SERIAL_PORT,
        baud=config.SERIAL_BAUD,
    )
    try:
        yield
    finally:
        if app.state.recorder is not None:
            app.state.recorder.close()
            app.state.recorder = None
        app.state.pump.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await app.state.pump
        await app.state.source.aclose()


def create_app() -> FastAPI:
    app = FastAPI(title="Metal Detector Studio", version="0.10.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/api/health")
    async def health() -> dict:
        return {
            "status": "ok",
            "source": app.state.source_kind,
            "profile": app.state.profile.id,
            "port": app.state.port,
            "baud": app.state.baud,
            "clients": app.state.hub.client_count,
            "serial": app.state.source.link_stats(),
            "frames": app.state.frame_validator.stats(),
        }

    @app.get("/api/schema")
    async def schema() -> dict:
        return load_schema()

    @app.get("/api/profiles")
    async def profiles() -> dict:
        return {"active": app.state.profile.id, "available": list_profiles()}

    @app.get("/api/profile")
    async def profile() -> dict:
        return app.state.profile.model_dump(by_alias=True)

    @app.get("/api/ports")
    async def ports() -> dict:
        from serial.tools import list_ports

        return {
            "ports": [
                {"device": p.device, "description": p.description}
                for p in list_ports.comports()
            ]
        }

    @app.post("/api/source")
    async def set_source(req: SourceRequest) -> dict:
        if req.source not in ("serial", "replay"):
            raise HTTPException(400, f"unsupported source {req.source!r}; use 'serial' or 'replay'")

        if req.source == "replay":
            if not req.file:
                raise HTTPException(400, "replay source requires a file")
            path = config.RECORDINGS_DIR / req.file
            if not path.exists():
                raise HTTPException(404, f"recording not found: {req.file!r}")
            # Profile comes from the recording's meta so the hello matches the data.
            meta = read_meta(path)
            profile_id = req.profile or meta.get("profile_id")
            if profile_id not in list_profiles():
                raise HTTPException(400, f"recording profile {profile_id!r} not available")
            await _start_source(
                app, source_kind="replay", profile_id=profile_id,
                port=app.state.port, baud=req.baud,
                file=req.file, speed=req.speed, loop=req.loop,
            )
        else:  # serial
            if req.profile not in list_profiles():
                raise HTTPException(400, f"unknown profile {req.profile!r}")
            if not req.port:
                raise HTTPException(400, "serial source requires a port")
            await _start_source(
                app, source_kind="serial", profile_id=req.profile,
                port=req.port or app.state.port, baud=req.baud,
            )

        return {
            "ok": True,
            "source": app.state.source_kind,
            "profile": app.state.profile.id,
            "port": app.state.port,
        }

    @app.post("/api/record")
    async def record(req: RecordRequest) -> dict:
        rec: Recorder | None = getattr(app.state, "recorder", None)
        if req.action == "start":
            if rec is not None:
                raise HTTPException(409, "already recording")
            config.RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
            name = f"rec-{time.strftime('%Y%m%d-%H%M%S')}.ndjson"
            meta = {
                "schema_version": load_schema()["schema_version"],
                "profile_id": app.state.profile.id,
                "profile": app.state.profile.model_dump(by_alias=True),
            }
            app.state.recorder = Recorder(config.RECORDINGS_DIR / name, meta)
            log.info("recording started -> %s", name)
            return app.state.recorder.status()
        # stop
        if rec is None:
            raise HTTPException(409, "not recording")
        st = rec.close()
        app.state.recorder = None
        log.info("recording stopped -> %s (%d frames)", st["path"], st["frames"])
        return st

    @app.get("/api/record")
    async def record_status() -> dict:
        rec: Recorder | None = getattr(app.state, "recorder", None)
        return rec.status() if rec else {"recording": False}

    @app.get("/api/recordings")
    async def recordings() -> dict:
        config.RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
        items = [
            {"name": p.name, "bytes": p.stat().st_size, "mtime": p.stat().st_mtime}
            for p in sorted(config.RECORDINGS_DIR.glob("*.ndjson"), reverse=True)
        ]
        return {"recordings": items}

    @app.delete("/api/recordings/{name}")
    async def delete_recording(name: str) -> dict:
        if "/" in name or "\\" in name or not name.endswith(".ndjson"):
            raise HTTPException(400, "invalid recording name")
        path = config.RECORDINGS_DIR / name
        if not path.exists():
            raise HTTPException(404, f"recording not found: {name!r}")
        if getattr(app.state.source, "path", None) == path:
            raise HTTPException(409, "cannot delete the recording currently being replayed")
        path.unlink()
        log.info("recording deleted -> %s", name)
        return {"ok": True, "deleted": name}

    @app.get("/api/recordings/{name}/csv")
    async def recording_csv(name: str, save: bool = False):
        """Export a recording's feature time-series as CSV. Default: download the CSV
        body. ?save=1: write a sibling `.csv` on the backend and return JSON metadata
        (used by the MCP `export_recording_csv` tool)."""
        if "/" in name or "\\" in name or not name.endswith(".ndjson"):
            raise HTTPException(400, "invalid recording name")
        path = config.RECORDINGS_DIR / name
        if not path.exists():
            raise HTTPException(404, f"recording not found: {name!r}")
        text, rows = _recording_feature_csv(path)
        if save:
            out = path.with_suffix(".csv")
            out.write_text(text, encoding="utf-8")
            log.info("recording exported -> %s (%d rows)", out.name, rows)
            return {"ok": True, "file": out.name, "rows": rows, "bytes": out.stat().st_size}
        return PlainTextResponse(
            text,
            media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="{path.stem}.csv"'},
        )

    @app.websocket("/ws/telemetry")
    async def ws_telemetry(websocket: WebSocket) -> None:
        await websocket.accept()
        hub: Hub = app.state.hub
        await websocket.send_text(_hello(app).model_dump_json())

        handle: ClientHandle = hub.register()
        sender = asyncio.create_task(_send_loop(websocket, handle))
        try:
            while True:
                text = await websocket.receive_text()
                # route config to the *current* source (may have been swapped)
                await _handle_inbound(websocket, app.state.source, text)
        except WebSocketDisconnect:
            pass
        finally:
            sender.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await sender
            hub.unregister(handle)

    return app


async def _send_loop(websocket: WebSocket, handle: ClientHandle) -> None:
    while True:
        message = await handle.queue.get()
        await websocket.send_text(message)


async def _handle_inbound(websocket: WebSocket, source: TelemetrySource, text: str) -> None:
    try:
        cmd = ConfigCommand.model_validate_json(text)
    except ValidationError as exc:
        ack = ConfigAck(key="?", value=None, ok=False, detail=f"invalid config: {exc.error_count()} error(s)")
    else:
        ack = await source.apply_config(cmd)
    await websocket.send_text(ack.model_dump_json())


app = create_app()
