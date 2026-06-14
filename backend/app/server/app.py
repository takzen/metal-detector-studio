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
import logging
from collections.abc import AsyncIterator

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ValidationError

from .. import config
from ..profiles import list_profiles, load_profile, load_schema
from ..sources.base import TelemetrySource
from ..sources.serial import SerialSource
from ..telemetry.models import ConfigAck, ConfigCommand, Hello
from .hub import ClientHandle, Hub

log = logging.getLogger("metal_lab")


class SourceRequest(BaseModel):
    source: str  # "serial" (only real hardware is supported)
    profile: str
    port: str | None = None
    baud: int = 115200


def _make_source(source_kind: str, profile, port: str, baud: int) -> TelemetrySource:
    if source_kind == "serial":
        return SerialSource(profile, port, baud)
    raise ValueError(f"unsupported source {source_kind!r}")


async def _pump(app: FastAPI, source: TelemetrySource) -> None:
    """Drain the given source and broadcast every frame as NDJSON-ready text."""
    hub: Hub = app.state.hub
    try:
        async for packet in source.stream():
            hub.broadcast(packet.model_dump_json())
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
    app: FastAPI, *, source_kind: str, profile_id: str, port: str, baud: int
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
        source = _make_source(source_kind, profile, port, baud)
        app.state.profile = profile
        app.state.source = source
        app.state.source_kind = source_kind
        app.state.port = port
        app.state.baud = baud
        app.state.pump = asyncio.create_task(_pump(app, source))
        log.info("source=%s profile=%s port=%s", source_kind, profile.id, port)

        if app.state.hub.client_count:
            app.state.hub.broadcast(_hello(app).model_dump_json())


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    app.state.hub = Hub()
    app.state.switch_lock = asyncio.Lock()
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
        app.state.pump.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await app.state.pump
        await app.state.source.aclose()


def create_app() -> FastAPI:
    app = FastAPI(title="Metal Detector Studio", version="0.1.0", lifespan=lifespan)
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
        if req.source != "serial":
            raise HTTPException(400, f"unsupported source {req.source!r}; only 'serial' is available")
        if req.profile not in list_profiles():
            raise HTTPException(400, f"unknown profile {req.profile!r}")
        if req.source == "serial" and not req.port:
            raise HTTPException(400, "serial source requires a port")
        await _start_source(
            app,
            source_kind=req.source,
            profile_id=req.profile,
            port=req.port or app.state.port,
            baud=req.baud,
        )
        return {
            "ok": True,
            "source": app.state.source_kind,
            "profile": app.state.profile.id,
            "port": app.state.port,
        }

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
