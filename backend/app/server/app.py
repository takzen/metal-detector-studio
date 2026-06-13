"""FastAPI app wiring (Milestone B5).

REST: /api/health, /api/schema, /api/profiles, /api/profile.
WebSocket: /ws/telemetry — sends `hello` on connect, streams telemetry frames,
and accepts inbound `config` commands (forwarded to the source, ack returned).

A single background "pump" task drains the active source and broadcasts every
frame through the hub to all connected clients.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from .. import config
from ..profiles import load_profile, load_schema, list_profiles
from ..sources.base import TelemetrySource
from ..sources.serial import SerialSource
from ..sources.synthetic import SyntheticSource
from ..telemetry.models import ConfigAck, ConfigCommand, Hello
from .hub import ClientHandle, Hub

log = logging.getLogger("metal_lab")


def _make_source() -> TelemetrySource:
    profile = load_profile()
    if config.SOURCE == "synthetic":
        return SyntheticSource(profile)
    if config.SOURCE == "serial":
        return SerialSource(profile, config.SERIAL_PORT, config.SERIAL_BAUD)
    raise ValueError(f"unsupported METAL_LAB_SOURCE={config.SOURCE!r}")


async def _pump(app: FastAPI) -> None:
    """Drain the source and broadcast every frame as NDJSON-ready text."""
    source: TelemetrySource = app.state.source
    hub: Hub = app.state.hub
    try:
        async for packet in source.stream():
            hub.broadcast(packet.model_dump_json())
    except asyncio.CancelledError:
        raise
    except Exception:  # keep the server alive; log and stop the pump
        log.exception("telemetry pump crashed")


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    app.state.profile = load_profile()
    app.state.source = _make_source()
    app.state.hub = Hub()
    app.state.pump = asyncio.create_task(_pump(app))
    log.info("source=%s profile=%s", config.SOURCE, app.state.profile.id)
    try:
        yield
    finally:
        app.state.pump.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await app.state.pump
        await app.state.source.aclose()


def create_app() -> FastAPI:
    app = FastAPI(title="Metal Detector Studio", version="0.1.0", lifespan=lifespan)

    @app.get("/api/health")
    async def health() -> dict:
        hub: Hub = app.state.hub
        return {
            "status": "ok",
            "source": config.SOURCE,
            "profile": app.state.profile.id,
            "clients": hub.client_count,
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

    @app.websocket("/ws/telemetry")
    async def ws_telemetry(websocket: WebSocket) -> None:
        await websocket.accept()
        source: TelemetrySource = app.state.source
        hub: Hub = app.state.hub

        hello = Hello(
            schema_version=load_schema()["schema_version"],
            profile=app.state.profile.model_dump(by_alias=True),
        )
        await websocket.send_text(hello.model_dump_json())

        handle: ClientHandle = hub.register()
        sender = asyncio.create_task(_send_loop(websocket, handle))
        try:
            while True:
                text = await websocket.receive_text()
                await _handle_inbound(websocket, source, text)
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
