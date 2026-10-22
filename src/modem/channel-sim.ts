import { fadeEdges, fft, nextPow2 } from './dsp';

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

export const power = (x: Float32Array) => x.reduce((s, v) => s + v * v, 0) / x.length;

/** Adds white Gaussian noise at `snrDb` relative to the signal's average power. */
export function addNoise(x: Float32Array, snrDb: number, r: () => number): Float32Array {
  const sigma = Math.sqrt(power(x) / 10 ** (snrDb / 10));
  return x.map((v) => v + sigma * gaussian(r));
}

/**
 * Plays `x` through a sample clock that runs `ratio` times faster, gliding linearly to `endRatio`
 * by the end (a sender that speeds up mid-frame). Cubic interpolation.
 */
export function resample(x: Float32Array, ratio: number, endRatio = ratio): Float32Array {
  const out = new Float32Array(Math.floor((x.length - 3) / Math.max(ratio, endRatio)));
  for (let n = 0; n < out.length; n++) {
    const t = n * ratio + ((endRatio - ratio) * n * n) / (2 * out.length);
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

/** Filters `x` through a zero-phase magnitude response, in dB at each frequency: a loudspeaker's colour. */
export function equalize(x: Float32Array, fs: number, gainDb: (hz: number) => number): Float32Array {
  const n = nextPow2(x.length);
  const re = new Float64Array(n), im = new Float64Array(n);
  re.set(x);
  fft(re, im);
  for (let i = 0; i < n; i++) {
    const g = 10 ** (gainDb((Math.min(i, n - i) * fs) / n) / 20);
    re[i] *= g;
    im[i] *= g;
  }
  fft(re, im, true);
  return Float32Array.from(re.subarray(0, x.length));
}

/** A microphone overdriven `driveDb` past full scale (relative to the loudest sample): hard clipping at ±1, or soft (tanh). */
export function clip(x: Float32Array, driveDb: number, soft = false): Float32Array {
  const g = 10 ** (driveDb / 20) / x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  return x.map((v) => (soft ? Math.tanh(g * v) : Math.max(-1, Math.min(1, g * v))));
}

/** Mains hum: `hz` (50 or 60) and every harmonic up to 6 kHz, each falling 6 dB per octave, as a charger or dimmer buzzes. */
export function hum(n: number, fs: number, hz: number, r: () => number): Float32Array {
  // One period, repeated: fs / hz is whole for 44.1 and 48 kHz at 50 and 60 Hz.
  const period = new Float32Array(Math.round(fs / hz));
  for (let k = 1; k * hz < 6000; k++) {
    const ph = 2 * Math.PI * r();
    for (let i = 0; i < period.length; i++) period[i] += Math.sin((2 * Math.PI * k * i) / period.length + ph) / k;
  }
  return Float32Array.from({ length: n }, (_, i) => period[i % period.length]);
}

/** Door slams and knocks: broadband cracks dying away over 10 to 30 ms, at random times about `everySec` apart. */
export function slams(n: number, fs: number, everySec: number, r: () => number): Float32Array {
  const out = new Float32Array(n);
  const gap = () => Math.ceil(-Math.log(1 - r()) * everySec * fs);
  for (let at = gap(); at < n; at += gap()) {
    const tau = (0.01 + 0.02 * r()) * fs;
    for (let i = 0; i < 5 * tau && at + i < n; i++) out[at + i] += gaussian(r) * Math.exp(-i / tau);
  }
  return out;
}

/** Formants F1-F3 (Hz) of seven vowels spoken by men (Peterson and Barney, 1952). */
const VOWELS = [[730, 1090, 2440], [270, 2290, 3010], [300, 870, 2240], [530, 1840, 2480], [570, 840, 2410], [660, 1720, 2410], [440, 1020, 2240]];

/** A two-pole resonator at `hz` with bandwidth `bw`, unity gain at DC (Klatt, 1980). */
function resonator(hz: number, bw: number, fs: number) {
  const c = -Math.exp((-2 * Math.PI * bw) / fs);
  const b = 2 * Math.exp((-Math.PI * bw) / fs) * Math.cos((2 * Math.PI * hz) / fs);
  let y1 = 0, y2 = 0;
  return (x: number) => {
    const y = (1 - b - c) * x + b * y1 + c * y2;
    y2 = y1;
    y1 = y;
    return y;
  };
}

/**
 * People talking nearby: `voices` talkers at once, each a train of glottal pulses through one
 * vowel's formants per syllable (Klatt's source-filter model), some syllables ending in a hiss.
 * Syllables last 120 to 220 ms, about four a second, in phrases of 3 to 8 with pauses between.
 */
export function babble(n: number, fs: number, voices: number, r: () => number): Float32Array {
  const out = new Float32Array(n);
  const add = (at: number, seg: Float32Array, rms: number, rampSec: number) => {
    const g = rms / Math.sqrt(power(seg) + 1e-20);
    for (let i = 0; i < seg.length && at + i < n; i++) out[at + i] += g * fadeEdges(i, seg.length, rampSec * fs) * seg[i];
  };
  for (let v = 0; v < voices; v++) {
    const f0 = 100 + 130 * r();
    // Women's and children's formants sit higher.
    const k = f0 > 160 ? 1.17 : 1;
    let at = Math.floor(r() * 0.5 * fs);
    while (at < n) {
      for (let s = 3 + Math.floor(r() * 6); s > 0 && at < n; s--) {
        // Klatt's glottal low-pass (a resonator at 0 Hz), then the vowel's formants.
        const formants = [0, ...VOWELS[Math.floor(r() * VOWELS.length)], 3500].map((hz, i) => resonator(hz * k, [100, 80, 100, 160, 250][i], fs));
        const seg = new Float32Array(Math.round((0.12 + 0.1 * r()) * fs));
        const glide = 0.2 * (r() - 0.5);
        let ph = 0, last = 0;
        for (let i = 0; i < seg.length; i++) {
          ph += (f0 * (1 + (glide * i) / seg.length)) / fs;
          const pulse = ph >= 1 ? 1 : 0;
          ph -= pulse;
          // The pulse's difference rises 6 dB per octave, as the lips radiate.
          seg[i] = formants.reduce((y, f) => f(y), pulse - last);
          last = pulse;
        }
        add(at, seg, 0.5 + r(), 0.025);
        at += seg.length;
        if (r() < 0.4) {
          const hiss = resonator(2500 + 4500 * r(), 2000, fs);
          const s = Float32Array.from({ length: Math.round((0.06 + 0.06 * r()) * fs) }, () => hiss(gaussian(r)));
          add(at, s, 0.15 + 0.15 * r(), 0.015);
          at += s.length;
        }
        at += Math.round((0.03 + 0.06 * r()) * fs);
      }
      at += Math.round((0.2 + 0.4 * r()) * fs);
    }
  }
  return out;
}

/** Places signals at sample offsets inside a stream of quiet background noise. */
export function mix(totalLen: number, parts: Array<[number, Float32Array]>, noiseRms: number, r: () => number) {
  const out = new Float32Array(totalLen);
  for (let i = 0; i < totalLen; i++) out[i] = noiseRms * gaussian(r);
  for (const [off, sig] of parts) for (let i = 0; i < sig.length && off + i < totalLen; i++) out[off + i] += sig[i];
  return out;
}

/** 16-bit PCM mono WAV encoder (sound-file exports, and the e2e suite's fake microphone). */
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
