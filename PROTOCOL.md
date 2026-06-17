# Serial protocol & telemetry packet format

How a detector talks to Metal Detector Studio, and how to stream from your own
firmware (e.g. STM32). A runnable example is in [`examples/stm32/`](examples/stm32/).

## Data flow (two layers)

```
  your detector MCU ──serial (USB-CDC / USART)──▶ backend ──JSON (NDJSON) over WebSocket──▶ frontend
                      [layer 1: wire format]      (app/sources/serial.py)   [layer 2: contract]
```

- **Layer 1 — serial wire format:** what your firmware physically sends over the COM
  port. The bundled source (`backend/app/sources/serial.py`) parses a **line-based,
  token ASCII** stream (the TAKTYK format below). This is the easiest way to stream
  today — emit these lines and it just works.
- **Layer 2 — telemetry contract:** the device-agnostic JSON grammar in
  `backend/schema.json` (`hello`, `feature`, `raw`, `raw_iq`, `config`, `config_ack`).
  The backend turns parsed serial lines into these packets and broadcasts them as
  **NDJSON over the WebSocket** to the UI. A *device profile*
  (`backend/profiles/*.json`, see [profiles/README](backend/profiles/README.md))
  gives the concrete field layout (harmonics, rates, config keys).

> The current serial source handles **one harmonic** (single-frequency) and the ASCII
> tokens below. For a different wire format or multi-frequency, add a small source
> class under `backend/app/sources/` that emits the same `FeatureFrame` / `RawIQBlock`
> models — the rest of the stack is unchanged.

---

## Layer 1 — serial wire format (what to send)

8-N-1, USB-CDC ignores baud (115200 is fine over USART). Two line types,
each `\r\n`-terminated. The parser is whitespace/token based and **ignores unknown
tokens**, so you can send a subset and grow later.

### Feature line (per-target vector, ~50 Hz)

A line that **starts with `X:`**, made of `KEY:VALUE` tokens separated by spaces.
Values are integers (parsed as float). **Minimum required: `X` and `Y`.**

```
X:<i> Y:<q> DX:<di> DY:<dq> VDI:<id> G:<gnd> A:<audio> TH:<thr> K:<kgnd> M:<mode> PX:<peakI> PY:<peakQ> FX:<fi> FY:<fq>\r\n
```

| Token | Meaning | Used for |
|-------|---------|----------|
| `X` `Y` | raw demodulated I / Q (**required**) | **hodograph** (studio computes the delta), scope |
| `DX` `DY` | I/Q delta vs the device's zero reference | parsed but unused (studio uses its own delta) |
| `OX` `OY` | ground-tracked delta | parsed but unused |
| `VDI` | target id / visual discrimination (e.g. -95..+95) | `extras.vdi` |
| `G` | ground-corrected response | `extras.ground` |
| `A` | audio / signal-strength level | `extras.audio` |
| `TH` | SAT threshold | `extras.threshold` |
| `K` | ground-balance value (kgnd) | `extras.kgnd` |
| `M` | mode index | `extras.mode` |
| `PX` `PY` | peak-hold \|I\| / \|Q\| | `extras.px/py` |
| `FX` `FY` | post-filter I/Q of the active mode | DSP recorder I/Q |

Hodograph vector = raw `X/Y`; the studio computes its own delta against a studio-side
zero (the `zero` button), so the device's `DX/DY`/`OX/OY` are no longer needed for the
plot. Everything except `X`/`Y` is optional — a minimal device can send just
`X:1234 Y:-560\r\n`.

### Raw I/Q block (for the scope + baseband FFT, optional)

A line that **starts with `RB:`** carrying a short burst of demodulated I/Q at a
higher rate (e.g. 1 kHz), interleaved `i q i q ...`:

```
RB:<sample_rate_hz> <n> <i0> <q0> <i1> <q1> ... <i(n-1)> <q(n-1)>\r\n
```

Example — 20 samples at 1 kHz: `RB:1000 20 12 -4 13 -5 ...`. The backend emits one
`raw_iq` packet per block (feeds the Oscilloscope and Live FFT).

### Raw ADC block (for the ADC scope / ENOB FFT, optional)

A line that **starts with `AB:`** carrying a contiguous block of **single-channel** raw
ADC samples (full converter resolution — no demod, boxcar or truncation), for converter
noise / SNR / ENOB characterization:

```
AB:<sample_rate_hz> <n> <s0> <s1> ... <s(n-1)>\r\n
```

Example — 256 samples at ~22 kSPS: `AB:22000 256 131070 -4 17 ...`. The backend emits one
`adc_raw` packet per block (feeds the **ADC scope** tab). On TAKTYK this is streamed only
while full telemetry is enabled (SERVICE3), as a short burst every ~1 s.

### Rates & robustness

- Send feature lines at your frame rate (TAKTYK ≈ 50 Hz); interleave `RB:` blocks if
  you have a high-rate I/Q stream.
- The reader is line-based and tolerant: partial/garbled lines are dropped, unknown
  tokens ignored, and it resyncs on the next clean line.

---

## Layer 2 — telemetry contract (`backend/schema.json`)

The JSON grammar the backend speaks to the frontend (NDJSON, one object per line).
Documented here so you can target it directly (e.g. a JSON-emitting firmware + a
small JSON serial source, or to understand what the UI consumes).

| Packet | Direction | Purpose |
|--------|-----------|---------|
| `hello` | device→pc | sent once; binds the PC to the active profile |
| `feature` | device→pc | per-harmonic `{mag, phase, i, q}` map + `phase_diffs` + `extras` |
| `raw` | device→pc | raw RX ADC block (`samples: int16[]`) — scope/FFT |
| `raw_iq` | device→pc | raw demodulated I/Q block (`i[]`, `q[]`) — scope/baseband FFT |
| `adc_raw` | device→pc | raw single-channel ADC block (`samples: int[]`, full 18-bit) — ADC scope / ENOB |
| `config` | pc→device | config command (`key`, `value`); allowed keys from the profile |
| `config_ack` | device→pc | ack of a config command |

`feature` carries harmonics and phase diffs as **keyed maps**, so single-freq (1
harmonic) and multi-freq (N harmonics) devices share one packet shape. Full field
list + types: `backend/schema.json`.

### How a serial feature line maps to a `feature` packet

```
X:1200 Y:-540 VDI:62 G:880 A:1500 TH:600        (wire, layer 1)
        │
        ▼  serial.py
feature {
  harmonics: { "f1": { i:1200, q:-540, mag:1317, phase:-0.42 } },   # mag/phase from i/q
  extras:    { vdi:62, ground:880, audio:1500, threshold:600 }
}
```

---

## Stream from your own detector — checklist

1. **Emit the wire format** above over USB-CDC (or USART). Start minimal: `X:<i> Y:<q>\r\n`
   at your frame rate. See [`examples/stm32/`](examples/stm32/) for a working example.
2. **Add a profile** describing your device:
   `backend/profiles/<id>.json` — copy `example_vlf.json`, edit, then
   `cd backend && uv run python -m app.validate_profile <id>`
   (see [profiles/README](backend/profiles/README.md)).
3. **Point the backend at your port:**
   `METAL_LAB_PROFILE=<id> METAL_LAB_SERIAL_PORT=COM5 uv run python main.py`.
4. **Different wire format / multi-frequency?** Add a source class under
   `backend/app/sources/` (subclass `TelemetrySource`, yield `FeatureFrame` /
   `RawIQBlock`). The current `SerialSource` is the reference; it handles one harmonic.

To inspect an unknown device's raw output first:
`cd backend && uv run python scripts/serial_sniff.py COM5 115200`.
