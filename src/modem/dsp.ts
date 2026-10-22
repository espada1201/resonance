/** In-place iterative radix-2 complex FFT. `inverse` scales by 1/n. */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  if (n & (n - 1)) throw new Error('FFT size must be a power of two');
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

export const nextPow2 = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(1, n)));

/** Signal energy at frequency `hz` over x[start, start+n). Works for non-integer bins. */
export function goertzel(x: Float32Array, start: number, n: number, hz: number, fs: number): number {
  const coeff = 2 * Math.cos((2 * Math.PI * hz) / fs);
  let s1 = 0;
  let s2 = 0;
  const end = Math.min(x.length, start + n);
  for (let i = Math.max(0, start); i < end; i++) {
    const s0 = x[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

/** The Hann window and FFT buffers of the last size magnitudeSpectrum ran at (it runs 25 times a second). */
let spectrumScratch = { hann: new Float64Array(0), re: new Float64Array(0), im: new Float64Array(0) };

/** Magnitude spectrum (dBFS-ish) of the last `n` samples, Hann windowed. n must be a power of two. */
export function magnitudeSpectrum(x: Float32Array, n: number): Float32Array {
  if (spectrumScratch.hann.length !== n) {
    const hann = Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
    spectrumScratch = { hann, re: new Float64Array(n), im: new Float64Array(n) };
  }
  const { hann, re, im } = spectrumScratch;
  const off = x.length - n;
  for (let i = 0; i < n; i++) re[i] = (x[off + i] ?? 0) * hann[i];
  im.fill(0);
  fft(re, im);
  const out = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) out[i] = 10 * Math.log10((re[i] * re[i] + im[i] * im[i]) / (n * n) + 1e-14) + 6;
  return out;
}
