# Device profiles

A **profile** describes one detector to the studio: its harmonics, stream rates,
raw-ADC parameters, the config commands it accepts, and free-form metadata. The
backend is device-agnostic — it reads everything from the active profile instead of
hardcoding device specifics, so the lab works for any detector you describe here.

Profiles are plain JSON files in this folder (`backend/profiles/*.json`). The file
name (without `.json`) is the profile **id** you select at runtime.

## Files here

| File | What it is |
|------|------------|
| `example_vlf.json` | **Copy-me template** — minimal, valid, single-frequency. Start here. |
| `urd1.json` | TAKTYK / URD-1 — real single-frequency device (incl. legacy `synth`). |
| `spectral_g4.json` | Spectral-G4 — multi-frequency (3 harmonics + phase diffs) example. |

## Add your own detector

1. **Copy the template:** `example_vlf.json` → `mydetector.json`.
2. **Edit the fields** (see the reference below): set `id` (must equal the file name
   stem), `title`, `device` metadata, and your `harmonics[].freq_hz`.
3. **Validate it** (JSON has no comments, so check by running):
   ```
   cd backend
   uv run python -m app.validate_profile mydetector
   ```
   It prints `OK` or a readable list of problems with the exact field path.
4. **Run with it:**
   ```
   METAL_LAB_PROFILE=mydetector uv run python main.py
   ```
   (or switch at runtime via `POST /api/source`, or pick it in the UI).

## Field reference

| Field | Type | Req. | Meaning |
|-------|------|:----:|---------|
| `id` | string | ✓ | Unique id; **must match the file name** (`myrig.json` → `"myrig"`). |
| `title` | string | ✓ | Human-readable label shown in the UI. |
| `device` | object | ✓ | Free-form metadata (`target`, `mcu`, `transport`, `author`, `notes`, …). Not validated — put whatever helps. |
| `harmonics` | array | ✓ | One entry per transmit/analysis frequency. Each: `{ "id": "f1", "index": 1, "freq_hz": 14000.0 }`. `id` is referenced elsewhere; `index` = harmonic number; `freq_hz` = carrier in Hz. **At least one.** Single-frequency = one entry. |
| `phase_diffs` | array | – | Multi-frequency only. Each: `{ "name": "dphase31", "from": "f2", "to": "f1", "description": "…" }`. `from`/`to` must reference existing harmonic ids. |
| `extras` | array&lt;string&gt; | – | Names of the extra scalar fields your feature frame carries (e.g. `vdi`, `ground`, `audio`, `threshold`). Informational — the actual values come from the source parser (`app/sources/serial.py`). |
| `raw` | object | ✓ | Raw RX/ADC block spec for the scope + FFT: `sample_rate_hz`, `block_size`, `dtype` (`int16`), `adc_bits`, `adc_vref`, `fullscale_lsb`. |
| `stream` | object | ✓ | Nominal rates: `{ "feature_hz": 50, "raw_hz": 10 }`. |
| `config_keys` | array&lt;string&gt; | – | Which config commands the control panel offers (`gain`, `mode`, `noise`, `sweep_period`, `paused`, `target`, …). |
| `synth` | object | – | **Optional / legacy.** Synthetic-source parameters; the synthetic source was dropped, so this is unused at runtime. Real-device profiles omit it. (See `urd1.json` / `spectral_g4.json` if you want to keep it.) |

## What a profile does — and does not — do

- **Does:** drive the UI and metadata (which harmonics to show, config keys in the
  control panel, declared extras, titles, ADC scaling). This part is fully
  device-agnostic.
- **Does NOT:** define the serial wire format. To actually *stream* data, your
  firmware must emit the line-based ASCII the serial source parses
  (`app/sources/serial.py`: `X:.. Y:.. …` feature lines + `RB:..` raw I/Q blocks),
  **or** you add a new source class under `app/sources/`.
- The current serial source handles **one harmonic** (single-frequency). A
  multi-frequency detector (like `spectral_g4`) needs a matching custom source.

## Validate

```
cd backend
uv run python -m app.validate_profile            # all profiles in this folder
uv run python -m app.validate_profile mydetector # one by id
uv run python -m app.validate_profile path/to.json
```

Exit code is `0` when everything is valid, `1` otherwise (usable in CI / pre-commit).
