# STM32 streaming example

Minimal example: stream telemetry to **Metal Detector Studio** over USB-CDC (or
USART). It emits the line-based ASCII the bundled serial source parses — see
[`../../PROTOCOL.md`](../../PROTOCOL.md) for the full wire format and packet contract.

## What `stream_example.c` shows

- `send_feature_min()` — the minimum the studio needs: `X:<i> Y:<q>\r\n`.
- `send_feature()` — adds the zeroed delta (`DX`/`DY`, which drive the hodograph) + `VDI`.
- `send_raw_iq()` — optional high-rate I/Q burst (`RB:<fs> <n> i q i q ...`) for the
  Oscilloscope + baseband FFT.
- `mds_stream_loop()` — emit a feature line (and an optional raw block) ~50×/s.

## Adapt it to your board

1. **Implement `mds_send(const char *s, uint16_t len)`** for your transport:
   - USB-CDC: `CDC_Transmit_FS((uint8_t *)s, len);` (STM32 USB Device CDC middleware)
   - USART: `HAL_UART_Transmit(&huart1, (uint8_t *)s, len, HAL_MAX_DELAY);`
2. **Replace the placeholders** `dsp_get_target()`, `dsp_get_iq_block()`, `delay_ms()`
   with your demodulator output and timing.
3. **Add a device profile** (`backend/profiles/`, copy `example_vlf.json`) and run:
   ```
   METAL_LAB_PROFILE=<your_id> METAL_LAB_SERIAL_PORT=COM5 uv run python main.py
   ```

This is illustrative, HAL-agnostic C (not a buildable project) — drop the functions
into your firmware and wire up `mds_send`.
