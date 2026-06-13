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

const hannCache = new Map<number, { win: Float64Array; sum: number }>();

function hann(n: number): { win: Float64Array; sum: number } {
  const cached = hannCache.get(n);
  if (cached) return cached;
  const win = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    sum += win[i];
  }
  const entry = { win, sum };
  hannCache.set(n, entry);
  return entry;
}

/**
 * One-sided amplitude spectrum (linear, in input units) using a Hann window.
 * Returns bins 0..N/2 (length N/2 + 1).
 */
export function amplitudeSpectrum(samples: ArrayLike<number>): Float64Array {
  const n = pow2Floor(samples.length);
  const { win, sum } = hann(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = samples[i] * win[i];

  fftInPlace(re, im);

  const half = n >> 1;
  const out = new Float64Array(half + 1);
  const scale = 2 / sum; // window-corrected, single-sided amplitude
  for (let k = 0; k <= half; k++) {
    out[k] = Math.hypot(re[k], im[k]) * scale;
  }
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
