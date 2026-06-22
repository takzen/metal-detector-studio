"""USB firmware flashing — host-side programmer.

The bootloader on the chip is firmware (taktyk-dsp, flashed once via Atmel-ICE) and is
explicitly NOT this package's concern; here we only implement the PC side: drop the
running app into the bootloader over the live CDC link, wait for the USB device to
re-enumerate, run an external programmer against the .hex, then reset back to the app.

`FlashBackend` is a swappable adapter so the DFU backend can later be replaced by a
custom CDC bootloader without touching the job state machine or the API.
"""

from .base import FlashBackend, FlashError
from .dfu import DfuProgrammer
from .job import FlashJob

__all__ = ["FlashBackend", "FlashError", "DfuProgrammer", "FlashJob"]
