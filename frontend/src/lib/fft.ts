// Minimal radix-2 FFT + amplitude spectrum for the live spectrum analyzer.
// Block sizes are powers of two (profile raw.block_size = 1024), but we defensively
// process the largest power-of-two prefix of whatever we're given.

export function pow2Floor(n: number): number {
  let p = 1;
  while (p * 2 <= n) p *= 2;
  return p;
}

// In-place iterative complex FFT (decimation-in-time). re/im length must be pow2.
function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;

  // bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const vr = re[b] * cr - im[b] * ci;
        const vi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - vr;
        im[b] = im[a] - vi;
        re[a] += vr;
        im[a] += vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

export type WindowType = "rect" | "hann" | "hamming" | "blackman" | "flattop";

const winCache = new Map<string, { win: Float64Array; sum: number }>();

/** Window coefficient at sample i of N (cosine-sum windows). */
function windowCoeff(type: WindowType, i: number, n: number): number {
  const x = (2 * Math.PI * i) / (n - 1);
  switch (type) {
    case "rect":
      return 1;
    case "hann":
      return 0.5 - 0.5 * Math.cos(x);
    case "hamming":
      return 0.54 - 0.46 * Math.cos(x);
    case "blackman":
      return 0.42 - 0.5 * Math.cos(x) + 0.08 * Math.cos(2 * x);
    case "flattop":
      return (
        0.21557895 -
        0.41663158 * Math.cos(x) +
        0.277263158 * Math.cos(2 * x) -
        0.083578947 * Math.cos(3 * x) +
        0.006947368 * Math.cos(4 * x)
      );
  }
}

function getWindow(type: WindowType, n: number): { win: Float64Array; sum: number } {
  const key = `${type}:${n}`;
  const cached = winCache.get(key);
  if (cached) return cached;
  const win = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    win[i] = windowCoeff(type, i, n);
    sum += win[i];
  }
  const entry = { win, sum };
  winCache.set(key, entry);
  return entry;
}

/**
 * One-sided amplitude spectrum (linear, in input units) using the given window
 * (default Hann). Returns bins 0..N/2 (length N/2 + 1).
 *
 * removeDc: subtract the segment mean before windowing. For baseband I/Q the
 * standing offset is huge; left in, its 0 Hz bin leaks through the window into the
 * lowest few bins and buries weak near-DC content (slow target motion). Default
 * off so other callers (raw scope FFT) keep their previous behaviour.
 */
export function amplitudeSpectrum(
  samples: ArrayLike<number>,
  window: WindowType = "hann",
  removeDc = false,
): Float64Array {
  const n = pow2Floor(samples.length);
  const { win, sum } = getWindow(window, n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  let mean = 0;
  if (removeDc) {
    for (let i = 0; i < n; i++) mean += samples[i];
    mean /= n;
  }
  for (let i = 0; i < n; i++) re[i] = (samples[i] - mean) * win[i];

  fftInPlace(re, im);

  const half = n >> 1;
  const out = new Float64Array(half + 1);
  const scale = 2 / sum; // window-corrected, single-sided amplitude
  for (let k = 0; k <= half; k++) {
    out[k] = Math.hypot(re[k], im[k]) * scale;
  }
  return out;
}

/**
 * Two-sided amplitude spectrum of the COMPLEX baseband signal s = I + jQ, fftshifted
 * so the output runs from −Fs/2 .. +Fs/2 (length N). Unlike running I and Q as two
 * real spectra (each symmetric, sign lost), this keeps the side of the carrier: a
 * tone above zero-beat lands at +f, below at −f, and quadrature imbalance shows as a
 * mirror image. Amplitude = |X|/Σwin (one bin per complex tone, no ×2).
 */
export function complexAmplitudeSpectrum(
  iSamples: ArrayLike<number>,
  qSamples: ArrayLike<number>,
  window: WindowType = "hann",
  removeDc = false,
): Float64Array {
  const n = pow2Floor(Math.min(iSamples.length, qSamples.length));
  const { win, sum } = getWindow(window, n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  let mr = 0;
  let mi = 0;
  if (removeDc) {
    for (let i = 0; i < n; i++) {
      mr += iSamples[i];
      mi += qSamples[i];
    }
    mr /= n;
    mi /= n;
  }
  for (let i = 0; i < n; i++) {
    re[i] = (iSamples[i] - mr) * win[i];
    im[i] = (qSamples[i] - mi) * win[i];
  }

  fftInPlace(re, im);

  const out = new Float64Array(n);
  const scale = 1 / sum;
  const half = n >> 1;
  for (let i = 0; i < n; i++) {
    const k = (i + half) % n; // fftshift: −Fs/2 first, DC at i=N/2
    out[i] = Math.hypot(re[k], im[k]) * scale;
  }
  return out;
}

/** Two-sided bin frequencies in Hz (−Fs/2 .. +Fs/2) for complexAmplitudeSpectrum. */
export function binFreqsTwoSided(sampleRateHz: number, n: number): Float64Array {
  const out = new Float64Array(n);
  const half = n >> 1;
  for (let i = 0; i < n; i++) out[i] = ((i - half) * sampleRateHz) / n;
  return out;
}

/** Bin center frequencies in Hz for amplitudeSpectrum output. */
export function binFreqs(sampleRateHz: number, processedN: number): Float64Array {
  const half = processedN >> 1;
  const freqs = new Float64Array(half + 1);
  for (let k = 0; k <= half; k++) freqs[k] = (k * sampleRateHz) / processedN;
  return freqs;
}

/** Convert a linear amplitude to dBFS given a full-scale reference. */
export function toDbfs(amplitude: number, fullscale: number): number {
  return 20 * Math.log10(amplitude / fullscale + 1e-12);
}
