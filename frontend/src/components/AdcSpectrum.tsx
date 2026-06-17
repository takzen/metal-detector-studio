"use client";

import { useEffect, useRef, useState } from "react";
import uPlot from "uplot";
import { amplitudeSpectrum, binFreqs, pow2Floor, toDbfs, type WindowType } from "@/lib/fft";
import type { RawAdcBlock } from "@/lib/types";
import { InfoPopover } from "./InfoPopover";

// AD7691 is 18-bit: signed full-scale amplitude = 2^17 LSB.
const FULLSCALE_AMP = 131072; // 2^17
const LSB_UV = 4096000 / 262144; // 15.625 µV/LSB at VREF = 4.096 V (REF3240)
// Narrow analysis bands [Hz] for SNR — mirrors the "three narrow bands" idea:
// limiting the band raises SNR by 10·log10(BW_full / BW_band) for white noise.
const SNR_BANDS_HZ = [1000, 100];
const DB_FLOOR = -140;
const SPECTRUM_EMA = 0.35; // per-block smoothing of the displayed dB trace
const DRIFT_BINS = 2; // ignore the lowest bins (residual baseline drift) for the spur pick

/**
 * ADC converter-characterisation spectrum. Feeds on the raw single-channel ADC
 * dump (SERVICE3 full telemetry): full 18-bit, no demod/boxcar/truncation — so
 * the noise floor, spurs and effective bits are the converter's own, not the
 * processed signal's. Frequency axis is nominal (firmware-paced ~22 kSPS, ±~5%);
 * the noise/ENOB figures are sample-rate independent.
 */
export type AdcMetrics = {
  fs: number;
  n: number;
  rmsLsb: number;
  rmsUv: number; // RMS noise referred to input [µV] at VREF 4.096 V
  ppLsb: number;
  snrDb: number; // full-scale-sine SNR = 20·log10(FS_sine_rms / RMS_noise)
  enob: number; // (SNR − 1.76) / 6.02
  procGainDb: number; // FFT processing gain = 10·log10(N/2)
  bwHz: number; // analysed band = fs/2
  noiseFloorDb: number; // median bin level [dBFS]
  spurHz: number;
  spurDb: number;
  bands: { hz: number; snr: number; enob: number }[]; // SNR/ENOB in narrow bands
};

export function AdcSpectrum({
  adcRef,
  windowType = "blackman",
  onMetrics,
}: {
  adcRef: React.RefObject<RawAdcBlock | null>;
  windowType?: WindowType;
  onMetrics?: (m: AdcMetrics) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const onMetricsRef = useRef(onMetrics);
  const winRef = useRef(windowType);
  useEffect(() => {
    onMetricsRef.current = onMetrics;
    winRef.current = windowType;
  });

  const [m, setM] = useState<AdcMetrics | null>(null);
  const [copied, setCopied] = useState(false);

  const copyMetrics = (mm: AdcMetrics) => {
    const bandsTxt = mm.bands
      .map((b) => `SNR<${b.hz >= 1000 ? `${b.hz / 1000}k` : `${b.hz}Hz`}\t${b.snr.toFixed(1)} dB\t${b.enob.toFixed(2)} bit`)
      .join("\n");
    const txt =
      `ADC scope  ${new Date().toISOString()}\n` +
      `SNR\t${mm.snrDb.toFixed(1)} dB\n` +
      `ENOB\t${mm.enob.toFixed(2)} bit\n` +
      `RMS\t${mm.rmsLsb.toFixed(2)} LSB\t${mm.rmsUv.toFixed(1)} uV\n` +
      `p-p\t${mm.ppLsb.toFixed(0)} LSB\n` +
      `floor\t${mm.noiseFloorDb.toFixed(1)} dBFS/bin\n` +
      `FFT gain\t${mm.procGainDb.toFixed(1)} dB\n` +
      `${bandsTxt}\n` +
      `spur\t${(mm.spurHz / 1000).toFixed(2)} kHz\t${mm.spurDb.toFixed(1)} dB\n` +
      `BW\t${(mm.bwHz / 1000).toFixed(2)} kHz\tn=${mm.n}\tfs~${(mm.fs / 1000).toFixed(0)} kHz`;
    navigator.clipboard?.writeText(txt).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {},
    );
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const r0 = host.getBoundingClientRect();
    const opts: uPlot.Options = {
      width: Math.max(1, Math.round(r0.width)),
      height: Math.max(1, Math.round(r0.height)),
      scales: {
        x: { time: false },
        y: { range: [DB_FLOOR, 0] },
      },
      axes: [
        {
          stroke: "#8b98a9",
          grid: { stroke: "#1b2330", width: 1 },
          ticks: { stroke: "#1b2330", width: 1 },
          values: (_u, splits) => splits.map((v) => `${v.toFixed(1)}`),
        },
        {
          stroke: "#8b98a9",
          grid: { stroke: "#1b2330", width: 1 },
          ticks: { stroke: "#1b2330", width: 1 },
          size: 52,
        },
      ],
      series: [
        {},
        {
          label: "|ADC| dBFS",
          stroke: "#a78bfa",
          width: 1,
          fill: "rgba(167,139,250,0.10)",
          points: { show: false },
        },
      ],
      cursor: { y: false },
      legend: { show: false },
    };
    const u = new uPlot(opts, [[], []] as unknown as uPlot.AlignedData, host);

    const ro = new ResizeObserver(() => {
      const r = host.getBoundingClientRect();
      u.setSize({ width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) });
    });
    ro.observe(host);

    let af = 0;
    let lastSeq = -1;
    let ema: Float64Array | null = null;
    let freqsKHz: Float64Array | null = null;

    const tick = () => {
      af = requestAnimationFrame(tick);
      const blk = adcRef.current;
      if (!blk || blk.seq === lastSeq || blk.samples.length < 32) return;
      lastSeq = blk.seq;

      const fs = blk.sample_rate_hz || 22000;
      const n = pow2Floor(blk.samples.length);
      const s = blk.samples;

      // --- time-domain noise figures (mean removed) ---
      let mean = 0;
      for (let i = 0; i < n; i++) mean += s[i];
      mean /= n;
      let sumsq = 0;
      let mn = Infinity;
      let mx = -Infinity;
      for (let i = 0; i < n; i++) {
        const d = s[i] - mean;
        sumsq += d * d;
        if (s[i] < mn) mn = s[i];
        if (s[i] > mx) mx = s[i];
      }
      const rms = Math.sqrt(sumsq / n);
      const pp = mx - mn;
      // SNR of a full-scale sine vs the measured noise (input shorted):
      // FS sine RMS = (2^17)/√2. ENOB = (SNR − 1.76)/6.02. FFT processing gain
      // 10·log10(N/2) is how far the per-bin floor sits below this SNR.
      const fsSineRms = FULLSCALE_AMP / Math.SQRT2;
      const snrDb = rms > 0 ? 20 * Math.log10(fsSineRms / rms) : 0;
      const enob = (snrDb - 1.76) / 6.02;
      const procGainDb = 10 * Math.log10(n / 2);
      const bwHz = fs / 2;
      const rmsUv = rms * LSB_UV;

      // --- spectrum (DC removed + window) ---
      const amp = amplitudeSpectrum(s, winRef.current, true);
      const db = new Float64Array(amp.length);
      for (let k = 0; k < amp.length; k++) db[k] = toDbfs(amp[k], FULLSCALE_AMP);

      // SNR in narrow bands: integrate noise power only over [0, bandHz] (skip DC).
      // rms_band = rms · √(P_band / P_total); the FFT window scaling cancels in the
      // ratio, so this is robust and works for non-white floors too.
      let pTot = 0;
      const pBand = SNR_BANDS_HZ.map(() => 0);
      for (let k = 1; k < amp.length; k++) {
        const p = amp[k] * amp[k];
        pTot += p;
        const fHz = (k * fs) / n;
        for (let b = 0; b < SNR_BANDS_HZ.length; b++) if (fHz <= SNR_BANDS_HZ[b]) pBand[b] += p;
      }
      const bands = SNR_BANDS_HZ.map((hz, b) => {
        const rmsB = pTot > 0 ? rms * Math.sqrt(pBand[b] / pTot) : rms;
        const snrB = rmsB > 0 ? 20 * Math.log10(fsSineRms / rmsB) : 0;
        return { hz, snr: snrB, enob: (snrB - 1.76) / 6.02 };
      });

      if (!ema || ema.length !== db.length) {
        ema = Float64Array.from(db);
        freqsKHz = Float64Array.from(binFreqs(fs, n), (f) => f / 1000);
      } else {
        for (let k = 0; k < db.length; k++) ema[k] += (db[k] - ema[k]) * SPECTRUM_EMA;
      }

      // --- noise floor (median bin) + strongest spur (excl. DC/drift bins) ---
      const sorted = Float64Array.from(ema);
      sorted.sort();
      const noiseFloorDb = sorted[sorted.length >> 1];
      let pk = DRIFT_BINS;
      for (let k = DRIFT_BINS + 1; k < ema.length; k++) if (ema[k] > ema[pk]) pk = k;

      u.setData([freqsKHz as unknown as number[], ema as unknown as number[]]);

      const metrics: AdcMetrics = {
        fs,
        n,
        rmsLsb: rms,
        rmsUv,
        ppLsb: pp,
        snrDb,
        enob,
        procGainDb,
        bwHz,
        noiseFloorDb,
        spurHz: freqsKHz ? freqsKHz[pk] * 1000 : 0,
        spurDb: ema[pk],
        bands,
      };
      setM(metrics);
      onMetricsRef.current?.(metrics);
    };
    af = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(af);
      ro.disconnect();
      u.destroy();
    };
  }, [adcRef]);

  return (
    <div className="relative h-full w-full">
      <div ref={hostRef} className="h-full w-full" />
      {m && (
        <div className="absolute right-2 top-2 select-text rounded bg-black/70 px-2 py-1 font-mono text-[11px] leading-tight text-slate-200">
          <div className="mb-1 flex items-center justify-end gap-1">
            <button
              type="button"
              onClick={() => copyMetrics(m)}
              title="copy all metrics (tab-separated) to clipboard"
              className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:text-foreground"
            >
              {copied ? "copied ✓" : "copy"}
            </button>
            <InfoPopover title="ADC noise / ENOB — what the numbers mean">
              <p>
                Measured from the raw ADC dump (input shorted = converter noise; with the front-end =
                system noise). Mean removed before all figures.
              </p>
              <p>
                <b>SNR</b> = 20·log10(FS-sine RMS / noise RMS). Full-scale sine vs the measured noise.
              </p>
              <p>
                <b>ENOB</b> = (SNR − 1.76) / 6.02. Effective bits.
              </p>
              <p>
                <b>RMS</b> = noise [LSB] and [µV] (µV at VREF 4.096 V, 1 LSB = 15.6 µV). <b>p-p</b> =
                sample min…max span.
              </p>
              <p>
                <b>floor</b> = noise per FFT bin [dBFS]. It sits below the real SNR by the <b>FFT gain</b>
                = 10·log10(N/2) — the FFT spreads noise over the bins.
              </p>
              <p>
                <b>SNR&lt;1k / &lt;100</b> = SNR counting noise only in that band. Narrower band → higher
                SNR (10·log10 of the bandwidth ratio) — what the demod+boxcar exploits.
              </p>
              <p>
                <b>spur</b> = strongest bin (excl. DC) — interference/feedthrough candidate. <b>BW</b> =
                fs/2, <b>n</b> = FFT size, <b>fs</b> ≈ capture rate (nominal).
              </p>
            </InfoPopover>
          </div>
          <div>
            SNR <span className="text-violet-300">{m.snrDb.toFixed(1)} dB</span>
          </div>
          <div>
            ENOB <span className="text-violet-300">{m.enob.toFixed(1)} bit</span>
          </div>
          <div>RMS {m.rmsLsb.toFixed(1)} LSB · {m.rmsUv.toFixed(0)} µV</div>
          <div>p-p {m.ppLsb.toFixed(0)} LSB</div>
          <div>floor {m.noiseFloorDb.toFixed(0)} dBFS/bin</div>
          <div>FFT gain {m.procGainDb.toFixed(1)} dB</div>
          {m.bands.map((b) => (
            <div key={b.hz} className="text-emerald-300">
              SNR&lt;{b.hz >= 1000 ? `${b.hz / 1000}k` : b.hz} {b.snr.toFixed(1)} dB · {b.enob.toFixed(1)} bit
            </div>
          ))}
          <div>
            spur {(m.spurHz / 1000).toFixed(2)} kHz {m.spurDb.toFixed(0)} dB
          </div>
          <div className="text-slate-400">
            BW {(m.bwHz / 1000).toFixed(1)} kHz · n={m.n} · fs≈{(m.fs / 1000).toFixed(0)} k
          </div>
        </div>
      )}
    </div>
  );
}
