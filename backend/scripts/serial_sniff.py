"""Serial sniffer — inspect what a device actually sends, before writing a parser.

    cd backend && uv run python scripts/serial_sniff.py COM5 115200 [seconds]

Opens the port, captures raw bytes for a few seconds, and reports:
- byte count + printable ratio (text vs binary heuristic),
- a hex dump of the first chunk,
- the first decoded ASCII lines (if line-delimited),
- newline framing detection.
Nothing is interpreted as telemetry yet — this is just reconnaissance.
"""

from __future__ import annotations

import sys
import time

import serial  # pyserial


def hexdump(data: bytes, limit: int = 256) -> str:
    out = []
    chunk = data[:limit]
    for off in range(0, len(chunk), 16):
        row = chunk[off : off + 16]
        hexs = " ".join(f"{b:02x}" for b in row)
        text = "".join(chr(b) if 32 <= b < 127 else "." for b in row)
        out.append(f"{off:04x}  {hexs:<47}  {text}")
    return "\n".join(out)


def main() -> None:
    port = sys.argv[1] if len(sys.argv) > 1 else "COM5"
    baud = int(sys.argv[2]) if len(sys.argv) > 2 else 115200
    seconds = float(sys.argv[3]) if len(sys.argv) > 3 else 3.0

    print(f"opening {port} @ {baud} for {seconds:.1f}s …")
    try:
        ser = serial.Serial(port, baud, timeout=0.2)
    except serial.SerialException as exc:
        print(f"ERROR: {exc}")
        sys.exit(1)

    buf = bytearray()
    deadline = time.monotonic() + seconds
    try:
        while time.monotonic() < deadline:
            data = ser.read(4096)
            if data:
                buf.extend(data)
    finally:
        ser.close()

    n = len(buf)
    print(f"\ncaptured {n} bytes ({n / seconds:.0f} B/s)")
    if n == 0:
        print("no data — wrong baud? device not streaming? try another baud (9600/230400).")
        return

    printable = sum(1 for b in buf if 9 <= b <= 13 or 32 <= b < 127)
    ratio = printable / n
    has_nl = b"\n" in buf
    print(f"printable ratio: {ratio:.2f}  ->  likely {'TEXT' if ratio > 0.85 else 'BINARY'}")
    print(f"newline-framed: {has_nl}")

    print("\n--- hex dump (first 256 B) ---")
    print(hexdump(buf))

    if has_nl:
        print("\n--- first decoded lines ---")
        text = buf.decode("ascii", errors="replace")
        for line in text.splitlines()[1:9]:  # skip a likely partial first line
            print(repr(line))


if __name__ == "__main__":
    main()
