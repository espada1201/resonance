import { fft, nextPow2 } from './dsp';

// A simulated acoustic channel for tests and for generating fake-microphone WAV files.

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(r: () => number) {
  return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
}

const power = (x: Float32Array) => x.reduce((s, v) => s + v * v, 0) / x.length;

/** Adds white Gaussian noise at `snrDb` relative to the signal's average power. */
export function addNoise(x: Float32Array, snrDb: number, r: () => number): Float32Array {
  const sigma = Math.sqrt(power(x) / 10 ** (snrDb / 10));
  return x.map((v) => v + sigma * gaussian(r));
}

/** Plays `x` through a sample clock that runs `ratio` times faster (cubic interpolation). */
export function resample(x: Float32Array, ratio: number): Float32Array {
  const out = new Float32Array(Math.floor((x.length - 3) / ratio));
  for (let n = 0; n < out.length; n++) {
    const t = n * ratio;
    const i = Math.floor(t);
    const f = t - i;
    const y0 = x[i - 1] ?? 0, y1 = x[i], y2 = x[i + 1], y3 = x[i + 2];
    out[n] = y1 + 0.5 * f * (y2 - y0 + f * (2 * y0 - 5 * y1 + 4 * y2 - y3 + f * (3 * (y1 - y2) + y3 - y0)));
  }
  return out;
}

/** Convolves with a synthetic room: direct path plus an exponentially decaying diffuse tail. */
export function reverb(x: Float32Array, fs: number, rt60: number, drrDb: number, r: () => number): Float32Array {
  const len = Math.round(rt60 * fs);
  const h = new Float64Array(len);
  const pre = Math.round(0.002 * fs);
  let tail = 0;
  for (let i = pre; i < len; i++) {
    h[i] = gaussian(r) * Math.exp((-6.91 * i) / (rt60 * fs));
    tail += h[i] * h[i];
  }
  const g = Math.sqrt(10 ** (-drrDb / 10) / tail);
  for (let i = pre; i < len; i++) h[i] *= g;
  h[0] = 1;
  const n = nextPow2(x.length + len);
  const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
  ar.set(x);
  br.set(h);
  fft(ar, ai);
  fft(br, bi);
  for (let i = 0; i < n; i++) {
    const re = ar[i] * br[i] - ai[i] * bi[i];
    ai[i] = ar[i] * bi[i] + ai[i] * br[i];
    ar[i] = re;
  }
  fft(ar, ai, true);
  return Float32Array.from(ar.subarray(0, x.length + len));
}

/** Places signals at sample offsets inside a stream of quiet background noise. */
export function mix(totalLen: number, parts: Array<[number, Float32Array]>, noiseRms: number, r: () => number) {
  const out = new Float32Array(totalLen);
  for (let i = 0; i < totalLen; i++) out[i] = noiseRms * gaussian(r);
  for (const [off, sig] of parts) for (let i = 0; i < sig.length && off + i < totalLen; i++) out[off + i] += sig[i];
  return out;
}

/** 16-bit PCM mono WAV encoder (used to feed Chromium's fake microphone). */
export function wav(x: Float32Array, fs: number): Uint8Array {
  const buf = new ArrayBuffer(44 + x.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + x.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, fs, true);
  v.setUint32(28, fs * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, x.length * 2, true);
  x.forEach((s, i) => v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 32767, true));
  return new Uint8Array(buf);
}
