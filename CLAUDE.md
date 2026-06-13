# Metal Detector Studio — project context

PC-side **bench / lab suite** for developing custom VLF / Pulse-Induction metal
detectors: real-time telemetry visualization, signal analysis, and live tuning.
Connects to the detector MCU over **USB-CDC / USART**, streams signals, and (later)
sends config back. See `README.md` for the full feature vision.

## Companion to the detector firmware (why this exists)
This studio is the **lab where we validate detector DSP** — on the bench, with or
ahead of final hardware. Primary target:

- **Spectral-G4** — multi-frequency VLF detector (STM32G474 base + STM32G071 probe),
  simultaneous 3 harmonics via SHE-PWM (7.8125 / 23.4375 / 39.0625 kHz), AI
  "spectral fingerprint" discrimination. Repo: `spectral_g4_project/soft`.
- (earlier) **URD-1 / TAKTYK** — single-frequency VLF on ATxmega (USB-CDC telemetry).

The detector firmware already produces the data this studio is meant to show: a
per-harmonic feature frame `{mag, phase} × {f1, f2, f3} + phase diffs` plus raw I/Q
vectors (see Spectral-G4 `vlf_dsp` / `vlf_ground`). The studio renders those as an
**XY hodograph** (I/Q vector trail per harmonic — for ground-balance & discrimination
tuning), a **virtual scope** (raw RX), and **live FFT** (EMI scouting).

## Telemetry contract (initial intent)
- Transport: USB-VCP (CDC) from the MCU; Spectral-G4 milestone **M8** is the producer side.
- Packets: dynamic JSON-described framing (`schema.json`) so firmware changes don't
  force PC rewrites. Stream per-harmonic I/Q frames + optional raw ADC blocks.
- Bidirectional: config commands back to the MCU (gain, filter coeffs, frequency, mode).
- MCP server exposes the live telemetry as tools for AI coding agents.

## Current state (honest)
Scaffold only — do not assume the README features exist yet:
- `backend/` — `main.py` is a stub (`Hello from backend!`); `pyproject.toml` has no deps.
  Planned stack: Python ≥3.13 (uv), FastAPI, websockets, pyserial-asyncio, `mcp`.
- `frontend/` — empty; Next.js app to be scaffolded (React, Tailwind, shadcn/ui,
  uPlot / ECharts).

## Build / run (once implemented)
- Backend: `cd backend && uv run python main.py`
- Frontend: `cd frontend && npm install && npm run dev` → http://localhost:3000

## Language
The maintainer communicates in **Polish**; repo-facing docs (README) stay English.
