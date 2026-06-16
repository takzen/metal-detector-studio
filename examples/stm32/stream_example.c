/*
 * stream_example.c - minimal example: stream telemetry to Metal Detector Studio.
 *
 * Emits the line-based ASCII the bundled serial source parses
 * (backend/app/sources/serial.py). See ../../PROTOCOL.md for the full format.
 *
 * Transport: USB-CDC (virtual COM); the same lines work over USART.
 * Replace the DSP placeholders with your demodulator output.
 *
 * Illustrative, HAL-agnostic C - drop these functions into your firmware and
 * wire up mds_send(). Not a buildable project on its own.
 */

#include <stdint.h>
#include <stdio.h>
#include <string.h>

/* ---- transport: wire this to your USB-CDC or UART TX --------------------- *
 * STM32 USB-CDC:  #include "usbd_cdc_if.h"
 *                 CDC_Transmit_FS((uint8_t *)s, len);
 * STM32 USART:    HAL_UART_Transmit(&huart1, (uint8_t *)s, len, HAL_MAX_DELAY);
 */
extern void mds_send(const char *s, uint16_t len); /* implement for your board */

static void mds_send_line(const char *s) {
    mds_send(s, (uint16_t)strlen(s));
}

/* ---- your DSP produces these (demodulated I/Q) -------------------------- */
typedef struct {
    int32_t i, q;   /* raw demodulated I/Q (channels X/Y)            */
    int32_t di, dq; /* I/Q delta vs the zero reference (ENTER/zero)  */
    int16_t vdi;    /* target id, e.g. -95..+95 (optional)           */
} target_frame_t;

/* ---- 1) feature line ---------------------------------------------------- */

/* Minimum the studio needs: X and Y (raw demodulated I/Q). */
void send_feature_min(int32_t i, int32_t q) {
    char line[48];
    snprintf(line, sizeof line, "X:%ld Y:%ld\r\n", (long)i, (long)q);
    mds_send_line(line);
}

/* Fuller: add the zeroed delta (DX/DY drive the hodograph) + a VDI readout. */
void send_feature(const target_frame_t *f) {
    char line[96];
    snprintf(line, sizeof line, "X:%ld Y:%ld DX:%ld DY:%ld VDI:%d\r\n",
             (long)f->i, (long)f->q, (long)f->di, (long)f->dq, (int)f->vdi);
    mds_send_line(line);
}

/* ---- 2) raw I/Q block (optional: scope + baseband FFT) ------------------ */

/* A short burst of higher-rate I/Q, interleaved i q i q ...   */
void send_raw_iq(uint32_t fs, const int16_t *iq, uint16_t n) {
    char line[512];
    int off = snprintf(line, sizeof line, "RB:%lu %u", (unsigned long)fs, n);
    for (uint16_t k = 0; k < n && off < (int)sizeof line - 16; k++)
        off += snprintf(line + off, sizeof line - off, " %d %d", iq[2 * k], iq[2 * k + 1]);
    snprintf(line + off, sizeof line - off, "\r\n");
    mds_send_line(line);
}

/* ---- main loop sketch --------------------------------------------------- */

/* These are your code: fill the frame / block, and pace the loop. */
extern void dsp_get_target(target_frame_t *f);
extern void dsp_get_iq_block(int16_t *iq, uint16_t n);
extern void delay_ms(uint32_t ms);

void mds_stream_loop(void) {
    target_frame_t f;
    int16_t iq_block[2 * 20]; /* 20 I/Q pairs */

    for (;;) {
        dsp_get_target(&f);              /* run your demodulator */
        dsp_get_iq_block(iq_block, 20);

        send_feature(&f);                /* ~50 Hz feature frame */
        send_raw_iq(1000, iq_block, 20); /* optional 1 kHz I/Q burst */

        delay_ms(20);                    /* ~50 frames/s */
    }
}
