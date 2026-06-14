"""Telemetry source interface (Milestone B3).

A source produces telemetry packets for a given device profile. The serial source
(real USB-CDC hardware) implements this contract; the server is source-agnostic.
"""

from __future__ import annotations

import abc
from collections.abc import AsyncIterator

from ..profiles import Profile
from ..telemetry.models import ConfigAck, ConfigCommand, TelemetryPacket


class TelemetrySource(abc.ABC):
    """Abstract async producer of telemetry packets."""

    def __init__(self, profile: Profile) -> None:
        self.profile = profile

    @abc.abstractmethod
    def stream(self) -> AsyncIterator[TelemetryPacket]:
        """Yield telemetry packets until cancelled or closed.

        Implemented as an async generator. Cancellation (task cancel) is the
        normal way to stop a source; implementations should clean up on exit.
        """
        raise NotImplementedError

    async def apply_config(self, cmd: ConfigCommand) -> ConfigAck:
        """Handle a config command. Override in sources that support it."""
        return ConfigAck(
            key=cmd.key,
            value=cmd.value,
            ok=False,
            detail="config not supported by this source",
        )

    async def aclose(self) -> None:
        """Release resources (serial ports, tasks). Default: no-op."""
        return None
