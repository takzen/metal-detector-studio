# Metal Detector Studio — user manual

A short guide to the dashboard: what each tab does and how to use it. For the system
overview and the telemetry contract see [`README.md`](README.md); for the wire
protocol and a firmware example see [`PROTOCOL.md`](PROTOCOL.md).

## Running

**Backend** (data source):

```bash
cd backend
uv sync                 # first time only
uv run python main.py   # connects to the detector (serial; port via METAL_LAB_SERIAL_PORT, default COM5)
```

**Frontend** (dashboard):

```bash
cd frontend
pnpm install            # first time only
pnpm dev
```

Open the URL printed in the console (default http://localhost:3000; if the port is
busy, Next picks 3001, etc.).

## Profile & port selection

Data comes **only from a real detector** (serial / USB-CDC) — the synthetic mode was
removed. Switch profile and port **live from the header bar**, no backend restart:

- **project** — device profile (`urd1` = 1 harmonic, `spectral_g4` = 3 harmonics,
  `example_vlf` = generic starter). The dashboard adapts the number of harmonics,
  phase-diffs and controls automatically.
- **port** — list of detected COM ports (e.g. `COM5`).
- **apply** — commits the change (`POST /api/source`; the backend switches the port
  and broadcasts a fresh `hello`). **↻** refreshes the port list and status.

The same settings can be passed at startup:

```bash
METAL_LAB_PROFILE=urd1 METAL_LAB_SERIAL_PORT=COM5 uv run python main.py
```

To add your own detector, see [`backend/profiles/README.md`](backend/profiles/README.md).

## Header

Fixed positions (they don't jump as values change):

- **status** — `open` (connected), `connecting` (connecting/reconnecting), `closed`
  (no backend).
- **schema** — telemetry contract version.
- **feature** — measured feature-frame rate [Hz].
- **raw** — raw I/Q or ADC block rate [Hz] (0 if the source sends none).
- **seq** — last frame counter (increasing = stream alive).

The version number sits next to the title; tabs and the profile/port bar are below the
metrics.

## Controls & settings

- **Grouping** — each tab's controls are grouped into `LABEL: choices` tiles. The label
  (muted, uppercase, no border) names a parameter; bordered items are clickable choices
  (active = highlighted). Actions (`zero`, `run/hold`, `play/stop`) have a colored fill.
- **Persistence (localStorage)** — UI settings survive a page reload: active tab,
  scope timebase/scale, trigger, FFT span/window/dB/avg/view, recorder window and
  channels, DSP mode, hodograph offset/EMA/persist. Transient state (run/hold, pause)
  always starts fresh.

## Tabs

### 1. XY hodograph — I/Q vector (the key view)

The tip of the signal vector **I (X axis) / Q (Y axis)** per harmonic — mirrors the
detector's SERVICE2 screen. The main tool for watching signal phase and
**discrimination**.

- **Vector relative to zero** — what's drawn is the difference from the zero point
  (see "Signal zero"), not the absolute vector. Center = the zero point.
- **Phase scale (signed, ±180°)** — `0°` is on the **left**. The upper arc rises
  `0 → +90 (top) → +180 (right)`; the lower arc descends `−180 (right) → −90 (bottom)
  → 0` back to the left. Rings are quarter / half / full of the auto-scale.
- **VDI sub-scale (upper half)** — inner scale on the upper arc: phase `0 / 90 / 180°`
  maps to VDI `−90 / 0 / +90` (i.e. VDI = phase − 90°).
- **Large phase readout** — top-left, in the harmonic's color: `atan2(Q, I)` in
  −180…+180° (smoothed to stay readable).
- **Large VDI readout** — top-right, in the VDI sub-scale color (amber): `VDI = phase − 90°`.
- **Signal zero** — the `zero (Enter)` button or **Enter** / **Z** sets the studio's zero
  to the current raw vector; the delta (plot + cards) is measured from here. **Not** ground
  balance, and the detector's own ENTER does not move the studio plot — zero here.
- **persist (persistence / phosphor)** — phosphor trail: stays where the tip was and
  fades over time; spots the tip dwells on stay brighter. On a target pass the loop
  "shoots out" and returns; angle/shape depend on the metal.
- **EMA** — live-vector smoothing slider: left = smoother/slower, right = faster
  (`0.01…1.00`, default `0.30`).
- **offset** — colored overlay showing a demodulator offset: an axis at a set angle +
  a rotation mark. Buttons `−0.3 / +0.3 / 0`. **Visual only** — it does not change the
  measured phase or vectors.
- **SwingTune (live / swing)** — phase readout mode. `live` = instantaneous delta phase
  (±180°). `swing` = SERVICE1-style automat: it watches the delta as you swing the coil,
  captures each swing's **peak**, takes its phase `atan2(dy, |dx|)` (±90°, ferrite at 0°),
  and shows the **median of the last 10 swings** + a swing count `n`. The repeatable
  reading for tuning; holds between swings; `zero` clears the series.
- **ground** — overlays a **factory ground-balance reference line** (dashed, 0–5°) on the
  dial. Buttons `−0.1 / +0.1 / 0` nudge the angle.

Beside the hodograph:
- **Harmonic cards** — two groups, each `mag` / `phase` / `I` / `Q`: **raw (absolute,
  Xr/Yr)** = the raw vector from the device (same scale as SERVICE), and **delta (vs zero)**
  = raw minus the studio zero (what the plot draws). The studio computes the delta itself —
  the detector's ENTER no longer moves the studio plot; use the `zero` button here.
- **Phase diffs** — phase differences between harmonics (e.g. `dphase31`, `dphase51`);
  key for multi-frequency discrimination. Single-frequency profiles show "none".
- **Extras** — extra fields from the source (TAKTYK: `vdi`, `ground`, `audio`,
  `threshold`, `kgnd`, `mode`, `px`, `py`).

### 2. I/Q phase — axis calibration (PhaseLab)

A sandbox for **I/Q axis auto-calibration**: the physical channels (X'/Y') are the true
vector rotated by an unknown axis angle **θ** (it drifts with frequency / temperature). Two
plots side by side — **physical** (raw, rotated) and **corrected** (after `R(−θ)`) — both on
the same signed degree protractor as the hodograph (0° at left).

- **source** — `manual` or `live`.
  - **manual** — sliders **θ axis rot** / **target φ** / **amplitude** synthesise the probe
    vector (proves the math, no hardware). `measure θ (air-balance)` / `reset cal` set or clear
    the calibration; readouts: θ actual / measured / axis error / true φ / detector reads.
  - **live** — the left plot is the **real probe I/Q** (feature f1), smoothed by the **ema**
    slider (like the hodograph). **air-balance (zero)** captures θ from the current no-metal
    vector (`atan2`), `R(−θ)` brings the corrected plot to 0; `reset cal` clears it. A large
    top-right overlay shows **corrected φ** plus raw φ / θ / I / Q.
- **How it works** — with no metal the probe sits on the true X axis, so the rest vector reads
  at θ; measuring it and rotating it out makes the corrected phase read relative to that zero
  (exactly ground balance). Whatever the probe's offset, air-balancing cancels it; leftover
  drift shows as `axis error`.

> ⚠️ On **analog-demod** detectors (TAKTYK) the I/Q is already balanced (θ≈0), so this is mainly
> a viewer. The real value is for **digital demodulation** (Spectral-G4), where θ is unknown and
> frequency-dependent.

### 3. Oscilloscope — virtual scope

Time-domain waveform (x = ms). What you see depends on the source:

- **TAKTYK / URD-1 (serial)** — the demodulated **I/Q** channels (baseband, ~1 kHz).
  The device sends no raw RX, so this is *not* the carrier but the post-demod signal
  (you see the target response, operator breathing, coil wobble).
- **Spectral-G4 (when it sends raw RX)** — the raw **RX ADC** block (sum of harmonics
  + EMI + noise).

Basic controls (live):
- **time** — timebase / window width: `50m … 2s`.
- **V** — vertical scale: `auto` (tracks the peak) or manual `+` / `−` (zoom).
- **⏸ hold / ▶ run** — stop / resume drawing.

**Trigger** (second row, when ≠ `off`) — a "sweep + hold" model: on trigger it captures
the whole window and holds it until the next trigger.
- **trig** — `off` (free scroll), `auto` (triggers; free-runs without one), `norm`
  (draws only on trigger, holds the last image between), `single` (captures one and
  freezes; `↻ arm` re-arms).
- **src** — trigger source: `I`, `Q` or `|IQ|` (magnitude — good for catching a target pass).
- **edge** — `↑ rise` / `↓ fall`.
- **lvl** — `auto` (line 60% from mean to peak — always visible/reachable) or **drag the
  dashed line** by the handle on the right (`↕`). The `auto` button returns to auto.
- On the chart: dashed line = threshold; ▼ marker = trigger point (50% of the window).
  Badge (top-left): `AUTO` / `WAIT` / `ARMED` / `TRIG` / `TRIG'D ⏸`.

**Measurements** (top-right, fixed): **Vpp**, **RMS**, **mean**, **f** (frequency) —
separately for I and Q, over the visible window.

> ⚠️ The trigger is new and **needs verification on real hardware**. For an unusual
> signal (I/Q demod drift/noise) tune the level (drag the line) or use `single` with
> `src |IQ|`.

### 4. Live FFT — spectrum analyzer (EMI scouting)

Spectrum of **|X| in dBFS vs frequency [Hz]**, with a peak marker (dashed line + Hz/dB
readout).

- **TAKTYK / URD-1** — spectrum of the demodulated I/Q (baseband content: target
  modulation, drift, 50 Hz mains, etc.).
- **Spectral-G4 (when it sends raw RX)** — spectrum of the raw RX: working-harmonic
  lines and ambient EMI → **picking clean working bands**.

Controls (for the I/Q source):
- **view** — `line` (line plot), `fall` (**waterfall / spectrogram**: time vertical,
  newest on top, color = dBFS, magma map), `both` (both, shared span).
- **mode** — `I/Q` (separate real spectra of I and Q) or `±f` (**complex two-sided** FFT of
  `I + jQ`: keeps the side of the carrier — a tone above zero-beat at +f, below at −f — and
  exposes quadrature imbalance as a mirror image; 0 Hz = zero-beat, in the middle).
- **span** — frequency range: `50 / 100 / 200 Hz` or `full` (to Nyquist).
- **win** — **FFT window**: `rect / hann / hamm / black / flat`. Resolution vs leakage
  trade-off (rect = narrowest bin but high leakage; flat = best amplitude accuracy).
  The legend shows the window and **RBW** (= ENBW(window)·Fs/N).
- **dB** — scale floor (dynamic range): `−60 / −80 / −100 / −120`. Shared by the line
  view and the waterfall (color scale).
- **avg** — EMA averaging: `off / ×4 / ×16`. Smooths the noise floor.
- **overlay**:
  - **max-hold** — overlays the per-bin maximum (dashed); catches short interferers.
    Click again to clear.
  - **mains** — vertical lines at 50 Hz harmonics (50/100/150…); spot mains hum fast.
  - **peaks** — *experimental, unstable* — strongest-bins list; frequencies drift,
    not very useful. Off by default.

### 5. ADC scope — raw converter (noise / SNR / ENOB)

FFT of the **raw single-channel ADC dump** — full 18-bit, before demodulation, the boxcar
average or any truncation — for characterizing the converter and the analog front end.

Updates only while **full telemetry is enabled on the detector** (TAKTYK: SERVICE3 → ON);
the firmware then streams a short ADC burst (~22 kSPS, 256 samples) about once a second.
With no such source the tab shows a "waiting…" message.

Live metrics (top-right; **copy** button + **?** help):
- **SNR** = 20·log10(full-scale-sine RMS / noise RMS); **ENOB** = (SNR − 1.76)/6.02.
- **RMS** noise in LSB and µV (1 LSB ≈ 15.6 µV at a 4.096 V ref); **p-p** sample span.
- **floor** — noise per FFT bin [dBFS]; sits below the SNR by the **FFT gain** = 10·log10(N/2).
- **SNR<1k / <100** — SNR counting noise only in that band (narrower band = higher SNR).
- **spur** — strongest bin (excl. DC); a feedthrough / interference candidate.

To isolate the converter's own noise, short its input (differential 0) → ENOB jumps to the
datasheet figure; with the live front end connected you measure the whole chain. The
frequency axis is nominal (~22 kSPS, ±5 %); the ENOB / RMS figures are sample-rate
independent.

### 6. DSP — signal-chain recorder + filter analysis

Two modes (switch at the top):

- **live recorder** — a multi-channel strip-chart on the feature-frame timeline. Each
  channel has **its own lane and axis** (scale in the left gutter, with a 0 line).
  Channels: `audio` (signal-strength indicator = `out.audio_signal`, same number as the
  LCD bar) with the `threshold` floor overlaid on the same `0..4000` scale; `ground`
  (post-ground-correction signal); `I`, `Q`. Lane scale: `auto` / `lock` / `+`/`−`
  (zoom); audio+threshold use a **fixed `0..4000` scale**. Window: `0.5 … 10 s`. *Tap
  the coil* to inject an impulse and watch the filters respond.
- **filter analysis** (theory) — preview the **real firmware filters** across three projects
  via a **project switcher**: **taktyk-dsp** (the ~1 kHz chain), the **MXT** reference, and a
  **sandbox** of experimental Q15 biquad cascades (`filters_sandbox`). Presets are the
  actually-instantiated filters: `DEEP/PIN/PROS LP` (2-pole EMA, shift 5), `DISC LP`
  (biquad, real Q29, ~10 Hz), `DISC band-pass` (EMA pair, shift 4/9), `DISC motion band`
  (composite), `DISC-IDX` (Classic-III biquad cascade), `DISC baseline` (shift 11),
  `ground track` (shift 9), `PIN average` (shift 8), `DEEP SAT` / `PROS VSAT` tables.
  Three charts: a **triangle test pulse → filter response `y[n]` → frequency response** in
  **absolute dB** (filters with gain show their real level). Controls: **type / shift / SAT /
  Fs**, a **stage** toggle for cascades (each biquad alone, or the full chain), **x-zoom**
  (time + frequency) and **y-zoom / y-span** sliders, and a **response: low-pass / high-pass**
  toggle for EMA trackers. Shows live **coefficients** and **metrics** (shape-aware `−3 dB`,
  settling time ±2%, overshoot); biquad cascades use an exact analytic transfer-function
  response. Theory mode — no source data needed.

## Keyboard shortcuts

(Inactive while the cursor is in a form field.)

- **1 … 6** — switch tab (hodograph / I/Q phase / oscilloscope / FFT / ADC scope / DSP).
- **Enter** / **Z** — zero the hodograph (studio zero = current raw vector).
- **Space** — run/hold (oscilloscope) or play/stop (DSP recorder), per the active tab.

## Chart maximize

The **⛶** button (top-right of the oscilloscope / FFT / DSP card) expands the chart to
fullscreen (native browser fullscreen). **Esc** exits. The chart resizes itself.

## PNG export

The **PNG** button on a card (hodograph / oscilloscope / FFT / DSP) saves the current
chart as a PNG (canvas snapshot). The file is named with the current date/time.

## Hardware integration (stream from your own detector)

The studio is device-agnostic — a JSON **device profile** describes your detector and a
serial source feeds it data. To connect your own firmware:

- **Wire format & packet contract:** [`PROTOCOL.md`](PROTOCOL.md) — the serial line
  format the backend parses and the telemetry packet grammar.
- **Firmware example:** [`examples/stm32/`](examples/stm32/) — a minimal STM32 example
  that streams the format over USB-CDC.
- **Your device profile:** [`backend/profiles/README.md`](backend/profiles/README.md) —
  copy `example_vlf.json`, edit, validate with
  `cd backend && uv run python -m app.validate_profile <id>`.

## AI integration (MCP)

The backend ships an MCP server (`backend/mcp_server.py`) that exposes live telemetry as
tools for AI assistants (read frames, analyze phase/spectrum, push config). Setup and
the tool list are in [`README.md`](README.md) (AI Integration section).

## Troubleshooting

- **Port 8000 busy** (`error while attempting to bind`) — another backend is running.
  Close it, or `METAL_LAB_PORT=8001 uv run python main.py`.
- **Frontend on a port other than 3000** — 3000 was busy, Next picked the next one
  (check the console).
- **Status `closed` / `connecting`** — backend not running or wrong address. The
  frontend connects to `ws://127.0.0.1:8000`; change via `NEXT_PUBLIC_BACKEND_HOST`.
- **No COM port in the list** — device not plugged in or held by another program (a
  terminal/IDE holding the port). Inspect raw output:
  `cd backend && uv run python scripts/serial_sniff.py COM5 115200`.
- **Oscilloscope/FFT show I/Q, not the carrier (TAKTYK)** — intentional: the device
  sends only demodulated I/Q (no raw RX). Raw RX appears on a device that sends it
  (e.g. Spectral-G4).
- **No `threshold` channel in DSP** — needs firmware sending the `TH` (SAT threshold)
  field in the telemetry frame.
