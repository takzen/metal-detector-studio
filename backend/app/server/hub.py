"""Broadcast hub (Milestone B4).

Fans out telemetry text frames to every connected WebSocket client. Each client
gets its own bounded queue; a slow client drops its oldest frames instead of
stalling the producer (telemetry is realtime — stale frames are worthless).
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field


@dataclass(eq=False)  # identity hashing so handles can live in a set
class ClientHandle:
    queue: asyncio.Queue[str] = field(default_factory=lambda: asyncio.Queue(maxsize=256))


class Hub:
    def __init__(self) -> None:
        self._clients: set[ClientHandle] = set()

    def register(self) -> ClientHandle:
        handle = ClientHandle()
        self._clients.add(handle)
        return handle

    def unregister(self, handle: ClientHandle) -> None:
        self._clients.discard(handle)

    @property
    def client_count(self) -> int:
        return len(self._clients)

    def broadcast(self, message: str) -> None:
        """Enqueue a frame for every client, dropping the oldest if a queue is full."""
        for handle in self._clients:
            try:
                handle.queue.put_nowait(message)
            except asyncio.QueueFull:
                try:
                    handle.queue.get_nowait()  # drop oldest
                except asyncio.QueueEmpty:
                    pass
                try:
                    handle.queue.put_nowait(message)
                except asyncio.QueueFull:
                    pass
