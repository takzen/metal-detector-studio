"""WebSocket smoke-test client (Milestone C3).

Connects to the running backend, reads the hello packet, samples the telemetry
stream for a few seconds, sends one config command, and prints a summary.

    cd backend && uv run python scripts/ws_client.py
"""

from __future__ import annotations

import asyncio
import json
import time

from websockets.asyncio.client import connect

URL = "ws://127.0.0.1:8000/ws/telemetry"
DURATION_S = 2.0


async def main() -> None:
    async with connect(URL) as ws:
        hello = json.loads(await ws.recv())
        assert hello["type"] == "hello", hello
        prof = hello["profile"]
        print(f"hello: schema={hello['schema_version']} profile={prof['id']} "
              f"harmonics={[h['id'] for h in prof['harmonics']]}")

        counts = {"feature": 0, "raw": 0}
        last_feature = None
        deadline = time.monotonic() + DURATION_S
        while time.monotonic() < deadline:
            try:
                msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=1.0))
            except asyncio.TimeoutError:
                break
            t = msg.get("type")
            if t in counts:
                counts[t] += 1
            if t == "feature":
                last_feature = msg

        print(f"received over {DURATION_S}s: {counts}")
        if last_feature:
            h0 = next(iter(last_feature["harmonics"].values()))
            print(f"  last feature seq={last_feature['seq']} "
                  f"h0(mag={h0['mag']:.1f}, phase={h0['phase']:.3f}) "
                  f"phase_diffs={last_feature['phase_diffs']}")

        # Exercise bidirectional config. Telemetry frames keep arriving, so read
        # until the matching config_ack shows up.
        await ws.send(json.dumps({"type": "config", "key": "noise", "value": 0.0}))
        for _ in range(500):
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=2.0))
            if msg.get("type") == "config_ack":
                print(f"config ack: key={msg['key']} ok={msg['ok']} detail={msg['detail']!r}")
                break

    print("OK")


if __name__ == "__main__":
    asyncio.run(main())
